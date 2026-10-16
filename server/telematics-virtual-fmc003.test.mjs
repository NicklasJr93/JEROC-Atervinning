import test from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualFmc003 } from './telematics/virtual-fmc003.mjs';
import { decodeCodec8EFrame, encodeRecordAck } from './telematics/codec8e.mjs';

const BASE = Date.parse('2026-10-16T08:00:00.000Z');
const telemetry = () => ({
  lat: 59.76035, lng: 18.70412, angle: 180, engineOn: true, tripActive: true,
  speedKmh: 45, rpm: 1800, coolantC: 85, fuelPercent: 68,
  fuelRateLh: 7.25, batteryVolts: 14.2, odometerMeters: 124583456,
});

test('car input is sampled every15s, then encoded/decoded and acknowledged every30s', () => {
  const packets = [];
  const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
    const decoded = decodeCodec8EFrame(packet);
    packets.push(decoded.records);
    return encodeRecordAck(decoded.records.length);
  } });
  device.advanceTo(BASE + 14999, telemetry);
  assert.equal(device.snapshot().samplesCreated, 0);
  device.advanceTo(BASE + 15000, telemetry);
  assert.equal(device.snapshot().pendingRecords, 1);
  assert.equal(packets.length, 0);
  device.advanceTo(BASE + 30000, telemetry);
  const state = device.snapshot();
  assert.equal(packets.length, 1);
  assert.equal(packets[0].length, 2);
  assert.equal(packets[0][0].at, new Date(BASE + 15000).toISOString());
  assert.equal(packets[0][1].at, new Date(BASE + 30000).toISOString());
  assert.equal(parseInt(packets[0][0].io[36], 16), 1800);
  assert.equal(parseInt(packets[0][0].io[60], 16) / 100, 7.25);
  assert.equal(state.simulated, true);
  assert.equal(state.transport, 'in_process');
  assert.equal(state.recordsAcknowledged, 2);
  assert.equal(state.pendingRecords, 0);
  assert.equal(state.lastPacket.status, 'acknowledged');
  assert.equal(state.lastPacket.ackCount, 2);
});

test('ignition priority sends immediately, offline buffers and reconnection flushes', () => {
  const packets = [];
  const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
    const { records } = decodeCodec8EFrame(packet); packets.push(records);
    return encodeRecordAck(records.length);
  } });
  device.capture(telemetry(), { at: BASE, eventIoId: 239, immediate: true });
  assert.equal(packets.length, 1);
  assert.equal(packets[0][0].priority, 1);
  assert.equal(packets[0][0].eventIoId, 239);
  device.setOnline(false);
  device.advanceTo(BASE + 60000, telemetry);
  assert.equal(device.snapshot().status, 'offline');
  assert.equal(device.snapshot().pendingRecords, 4);
  assert.equal(packets.length, 1);
  device.setOnline(true, BASE + 60000);
  assert.equal(packets.length, 2);
  assert.equal(packets[1].length, 4);
  assert.equal(device.snapshot().pendingRecords, 0);
});

test('a lost ACK retains byte-identical packet, while the receiver deduplicates retries', () => {
  const seen = new Set();
  const packets = [];
  const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
    packets.push(Buffer.from(packet));
    const { records } = decodeCodec8EFrame(packet);
    for (const record of records) seen.add(JSON.stringify(record));
    return packets.length === 1 ? undefined : encodeRecordAck(records.length);
  } });
  device.capture(telemetry(), { at: BASE, eventIoId: 239, immediate: true });
  let state = device.snapshot();
  assert.equal(state.pendingRecords, 1);
  assert.equal(state.recordsAcknowledged, 0);
  assert.equal(state.status, 'retry_pending');
  assert.equal(seen.size, 1);
  device.flush(BASE + 1000);
  state = device.snapshot();
  assert.deepEqual(packets[1], packets[0]);
  assert.equal(seen.size, 1);
  assert.equal(state.pendingRecords, 0);
  assert.equal(state.recordsAcknowledged, 1);
  assert.equal(state.lastPacket.attempts, 2);
  assert.equal(state.lastError, null);
});

test('bad ACK length/count and receiver exception never discard pending data', () => {
  for (const reply of [Buffer.from([1]), encodeRecordAck(0), new Error('Receiver unavailable')]) {
    let attempts = 0;
    const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
      attempts += 1;
      if (attempts === 1) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
      return encodeRecordAck(decodeCodec8EFrame(packet).records.length);
    } });
    device.capture(telemetry(), { at: BASE, immediate: true });
    assert.equal(device.snapshot().pendingRecords, 1);
    assert.equal(device.snapshot().recordsAcknowledged, 0);
    assert.equal(device.snapshot().status, 'retry_pending');
    device.advanceTo(BASE + 30000, telemetry);
    assert.equal(device.snapshot().pendingRecords, 0);
    assert.equal(device.snapshot().recordsAcknowledged, 3);
  }
});

test('bounded memory never evicts the frozen unacknowledged packet', () => {
  const packets = [];
  let acknowledge = false;
  const device = createVirtualFmc003({ initialAt: BASE, maxBufferedRecords: 3, receivePacket(packet) {
    packets.push(Buffer.from(packet));
    const { records } = decodeCodec8EFrame(packet);
    return acknowledge ? encodeRecordAck(records.length) : undefined;
  } });
  device.setOnline(false);
  device.advanceTo(BASE + 45000, telemetry);
  assert.equal(device.snapshot().pendingRecords, 3);
  device.setOnline(true, BASE + 45000);
  assert.equal(device.snapshot().status, 'retry_pending');
  device.capture({ ...telemetry(), odometerMeters: 124583999 }, { at: BASE + 46000 });
  assert.equal(device.snapshot().pendingRecords, 3);
  assert.equal(device.snapshot().droppedRecords, 1);
  acknowledge = true;
  device.flush(BASE + 47000);
  assert.deepEqual(packets[1], packets[0]);
  assert.equal(device.snapshot().pendingRecords, 0);
  assert.equal(device.snapshot().recordsAcknowledged, 3);
});

test('offline overflow keeps newest samples; factories and public snapshots are isolated', () => {
  const received = [];
  const device = createVirtualFmc003({ initialAt: BASE, maxBufferedRecords: 2, receivePacket(packet) {
    const { records } = decodeCodec8EFrame(packet); received.push(...records);
    return encodeRecordAck(records.length);
  } });
  device.setOnline(false);
  device.advanceTo(BASE + 60000, telemetry);
  assert.equal(device.snapshot().droppedRecords, 2);
  const copy = device.snapshot(); copy.config.recordIntervalSeconds = 1;
  assert.equal(device.snapshot().config.recordIntervalSeconds, 15);
  device.setOnline(true);
  assert.deepEqual(received.map(record => record.at), [BASE + 45000, BASE + 60000].map(at => new Date(at).toISOString()));
  const other = createVirtualFmc003({ initialAt: BASE, receivePacket: () => encodeRecordAck(1) });
  assert.equal(other.snapshot().samplesCreated, 0);
  assert.equal(other.snapshot().lastPacket, null);
});
