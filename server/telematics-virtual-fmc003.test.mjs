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
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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

test('asynchronous ACK keeps one request active while sampling continues, then drains queued records', async () => {
  const first = deferred();
  const packets = [];
  let activeRequests = 0;
  let maximumActive = 0;
  const device = createVirtualFmc003({ initialAt: BASE, transport: 'http', receivePacket(packet) {
    packets.push(decodeCodec8EFrame(packet).records);
    activeRequests += 1;
    maximumActive = Math.max(maximumActive, activeRequests);
    if (packets.length === 1) return first.promise.finally(() => { activeRequests -= 1; });
    activeRequests -= 1;
    return encodeRecordAck(packets.at(-1).length);
  } });
  const sending = device.capture(telemetry(), { at: BASE, immediate: true });
  assert.equal(device.snapshot().status, 'sending');
  assert.equal(device.snapshot().recordsAcknowledged, 0);
  device.advanceTo(BASE + 60000, telemetry);
  device.capture(telemetry(), { at: BASE + 60001, immediate: true });
  assert.equal(packets.length, 1);
  assert.equal(device.snapshot().pendingRecords, 6);
  first.resolve(encodeRecordAck(1));
  await sending;
  assert.equal(maximumActive, 1);
  assert.deepEqual(packets.map(records => records.length), [1, 5]);
  assert.equal(device.snapshot().pendingRecords, 0);
  assert.equal(device.snapshot().recordsAcknowledged, 6);
  assert.equal(device.snapshot().transport, 'http');
});

test('asynchronous lost/bad ACK stops retries until a later flush and preserves bytes with newer queued samples', async () => {
  for (const outcome of ['bad', 'lost']) {
    const attempt = deferred();
    const packets = [];
    const unique = new Set();
    const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
      packets.push(Buffer.from(packet));
      const { records } = decodeCodec8EFrame(packet);
      for (const record of records) unique.add(JSON.stringify(record));
      return packets.length === 1 ? attempt.promise : Promise.resolve(encodeRecordAck(records.length));
    } });
    const firstSend = device.capture(telemetry(), { at: BASE, immediate: true });
    device.advanceTo(BASE + 15000, telemetry);
    if (outcome === 'bad') attempt.resolve(encodeRecordAck(0));
    else attempt.reject(new Error('ACK disappeared after commit'));
    await firstSend;
    assert.equal(packets.length, 1, 'No automatic tight retry on an async failure');
    assert.equal(device.snapshot().pendingRecords, 2);
    assert.equal(device.snapshot().status, 'retry_pending');
    await device.flush(BASE + 16000);
    assert.deepEqual(packets[1], packets[0], 'The retry must not absorb newly queued samples');
    assert.equal(packets.length, 3);
    assert.equal(unique.size, 2);
    assert.equal(device.snapshot().recordsAcknowledged, 2);
    assert.equal(device.snapshot().pendingRecords, 0);
  }
});

test('offline transition invalidates a late ACK and does not overlap its request on reconnect', async () => {
  const first = deferred();
  const packets = [];
  const device = createVirtualFmc003({ initialAt: BASE, receivePacket(packet) {
    packets.push(Buffer.from(packet));
    return packets.length === 1 ? first.promise : encodeRecordAck(decodeCodec8EFrame(packet).records.length);
  } });
  const pending = device.capture(telemetry(), { at: BASE, immediate: true });
  device.setOnline(false);
  device.setOnline(true);
  assert.equal(packets.length, 1);
  first.resolve(encodeRecordAck(1));
  await pending;
  assert.equal(device.snapshot().recordsAcknowledged, 0);
  assert.equal(device.snapshot().pendingRecords, 1);
  await device.flush(BASE + 1000);
  assert.equal(device.snapshot().recordsAcknowledged, 1);
  assert.deepEqual(packets[1], packets[0]);
});

test('closing an obsolete device generation prevents late callbacks changing its state or a new device', async () => {
  const first = deferred();
  let changes = 0;
  const oldDevice = createVirtualFmc003({ initialAt: BASE, receivePacket: () => first.promise, onChange: () => { changes += 1; } });
  const pending = oldDevice.capture(telemetry(), { at: BASE, immediate: true });
  oldDevice.close();
  const freshDevice = createVirtualFmc003({ initialAt: BASE, receivePacket: () => encodeRecordAck(1) });
  first.resolve(encodeRecordAck(1));
  await pending;
  assert.equal(oldDevice.snapshot().recordsAcknowledged, 0);
  assert.equal(oldDevice.snapshot().pendingRecords, 1);
  assert.equal(oldDevice.snapshot().closed, true);
  assert.equal(changes, 0);
  assert.equal(freshDevice.snapshot().samplesCreated, 0);
  oldDevice.capture(telemetry(), { at: BASE + 1000, immediate: true });
  assert.equal(oldDevice.snapshot().samplesCreated, 1);
});
