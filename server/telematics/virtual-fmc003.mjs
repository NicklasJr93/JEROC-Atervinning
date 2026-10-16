import { crc16Ibm } from './codec8e.mjs';

const RECORD_INTERVAL_MS = 15000;
const SEND_INTERVAL_MS = 30000;
const MAX_RECORDS_PER_PACKET = 100;

// AVL values are already converted by the tracker: 36=integer rpm,
// 32=signed°C,48=0..100%,60=0.01L/h,16=virtual meters. Raw OBD PID
// conversion factors must not be applied to these AVL fields a second time.
// https://wiki.teltonika-gps.com/view/FMC003_Teltonika_Data_Sending_Parameters_ID
export function encodeSyntheticFmc003Frame(samples) {
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > MAX_RECORDS_PER_PACKET || samples.some(sample => sample.simulated !== true)) {
    throw new TypeError('Only bounded synthetic FMC003 samples can be encoded');
  }
  const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
  const u32 = value => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const records = samples.map(sample => {
    const head = Buffer.alloc(28);
    head.writeBigUInt64BE(BigInt(Date.parse(sample.at)), 0);
    head[8] = sample.event ? 1 : 0;
    head.writeInt32BE(Math.round(sample.lng * 1e7), 9);
    head.writeInt32BE(Math.round(sample.lat * 1e7), 13);
    head.writeInt16BE(22, 17);
    head.writeUInt16BE(Math.round(sample.angle) % 360, 19);
    head[21] = 10; // Synthetic satellites, never evidence of a real GNSS fix.
    head.writeUInt16BE(Math.round(sample.speedKmh), 22);
    head.writeUInt16BE(sample.eventIoId ?? 0, 24);
    head.writeUInt16BE(9, 26);
    const coolant = Buffer.alloc(1); coolant.writeInt8(Math.round(sample.coolantC));
    return Buffer.concat([
      head, u16(5),
      u16(239), Buffer.from([Number(sample.engineOn)]),
      u16(240), Buffer.from([Number(sample.speedKmh > 0)]),
      u16(250), Buffer.from([Number(sample.tripActive)]),
      u16(32), coolant, u16(48), Buffer.from([Math.round(sample.fuelPercent)]),
      u16(3), u16(36), u16(Math.round(sample.rpm)),
      u16(60), u16(Math.round(sample.fuelRateLh * 100)),
      u16(66), u16(Math.round(sample.batteryVolts * 1000)),
      u16(1), u16(16), u32(Math.round(sample.odometerMeters)), u16(0), u16(0),
    ]);
  });
  const data = Buffer.concat([Buffer.from([0x8E, samples.length]), ...records, Buffer.from([samples.length])]);
  return Buffer.concat([Buffer.alloc(4), u32(data.length), data, u32(crc16Ibm(data))]);
}

function timestamp(value) {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError('A virtual FMC003 needs a valid timestamp');
  return milliseconds;
}

/**
 * Synthetic device only: car input -> timed samples -> memory -> Codec 8E ->
 * in-process receiver -> exact four-byte ACK -> buffer removal. No sockets,
 * enrollment, external data, real hardware or durable storage are claimed.
 * The 15/30-second profile is our configurable-device demo choice, not a
 * manufacturer's mandatory interval. See FMC003_Data_acquisition_settings.
 */
export function createVirtualFmc003({ initialAt = new Date(), receivePacket, onSample = () => {}, maxBufferedRecords = 1000 } = {}) {
  if (typeof receivePacket !== 'function' || typeof onSample !== 'function') throw new TypeError('A virtual FMC003 needs a receiver and sample callback');
  if (!Number.isInteger(maxBufferedRecords) || maxBufferedRecords < 1 || maxBufferedRecords > 1000) throw new RangeError('Invalid virtual FMC003 buffer limit');
  let clockMs = timestamp(initialAt);
  let nextRecordMs = clockMs + RECORD_INTERVAL_MS;
  let nextSendMs = clockMs + SEND_INTERVAL_MS;
  let online = true;
  let pending = [];
  let inFlight = null;
  let samplesCreated = 0;
  let recordsAcknowledged = 0;
  let packetsSent = 0;
  let droppedRecords = 0;
  let lastSampleMs = null;
  let lastSentAt = null;
  let lastAckAt = null;
  let lastPacket = null;
  let lastError = null;

  function flush(at = clockMs) {
    const sentAt = new Date(timestamp(at)).toISOString();
    if (!online) return;
    while (pending.length) {
      if (!inFlight) {
        const samples = pending.slice(0, MAX_RECORDS_PER_PACKET);
        inFlight = { samples, bytes: encodeSyntheticFmc003Frame(samples), attempts: 0 };
      }
      inFlight.attempts += 1;
      packetsSent += 1;
      lastSentAt = sentAt;
      lastPacket = {
        at: sentAt, codec: '8E', records: inFlight.samples.length, bytes: inFlight.bytes.length,
        crcHex: inFlight.bytes.subarray(-4).toString('hex'), attempts: inFlight.attempts,
        status: 'retry_pending', ackCount: null,
      };
      let ack;
      try { ack = receivePacket(Buffer.from(inFlight.bytes)); }
      catch {
        lastError = { code: 'VIRTUAL_FMC003_RECEIVER_UNAVAILABLE', message: 'Den syntetiska mottagaren svarade inte. Samma paket väntar på nytt försök.' };
        return;
      }
      if (!Buffer.isBuffer(ack) || ack.length !== 4 || ack.readUInt32BE() !== inFlight.samples.length) {
        lastError = { code: 'VIRTUAL_FMC003_ACK_INVALID', message: 'Mottagarens kvittens saknas eller har fel antal. Samma paket väntar på nytt försök.' };
        return;
      }
      const accepted = new Set(inFlight.samples);
      pending = pending.filter(sample => !accepted.has(sample));
      recordsAcknowledged += inFlight.samples.length;
      lastPacket.status = 'acknowledged';
      lastPacket.ackCount = ack.readUInt32BE();
      lastAckAt = sentAt;
      lastError = null;
      inFlight = null;
    }
  }
  function capture(telemetry, { at = clockMs, eventIoId = 0, immediate = false } = {}) {
    const sampleMs = Math.max(timestamp(at), lastSampleMs === null ? -Infinity : lastSampleMs + 1);
    const sample = {
      ...telemetry, simulated: true, at: new Date(sampleMs).toISOString(), event: immediate, eventIoId,
    };
    // Validate before accepting the sample, even while offline. The serializer
    // and strict receiving decoder retain responsibility for their wire format.
    encodeSyntheticFmc003Frame([sample]);
    lastSampleMs = sampleMs;
    samplesCreated += 1;
    if (pending.length === maxBufferedRecords) {
      // Never remove a record from an unacknowledged frozen packet. If that
      // packet occupies the entire configured buffer, drop the new sample.
      const index = inFlight?.samples.length ?? 0;
      droppedRecords += 1;
      if (index >= pending.length) { onSample({ ...sample }); return; }
      pending.splice(index, 1);
    }
    pending.push(sample);
    onSample({ ...sample });
    if (immediate) flush(at);
  }
  function advanceTo(at, readTelemetry) {
    const targetMs = timestamp(at);
    if (targetMs < clockMs || typeof readTelemetry !== 'function') throw new TypeError('Virtual FMC003 time must advance with a telemetry source');
    while (Math.min(nextRecordMs, nextSendMs) <= targetMs) {
      const dueMs = Math.min(nextRecordMs, nextSendMs);
      clockMs = dueMs;
      if (nextRecordMs === dueMs) {
        capture(readTelemetry(), { at: dueMs });
        nextRecordMs += RECORD_INTERVAL_MS;
      }
      if (nextSendMs === dueMs) {
        flush(dueMs);
        nextSendMs += SEND_INTERVAL_MS;
      }
    }
    clockMs = targetMs;
  }
  function setOnline(value, at = clockMs) {
    if (typeof value !== 'boolean') throw new TypeError('Virtual FMC003 network state must be boolean');
    online = value;
    if (online) flush(at);
  }
  function snapshot() {
    return {
      simulated: true, model: 'FMC003', transport: 'in_process', online,
      status: !online ? 'offline' : lastError ? 'retry_pending' : pending.length ? 'buffering' : 'ready',
      config: { codec: '8E', recordIntervalSeconds: 15, sendIntervalSeconds: 30, minSavedRecords: 1, maxBufferedRecords },
      pendingRecords: pending.length, samplesCreated, recordsAcknowledged, packetsSent, droppedRecords,
      lastSampleAt: lastSampleMs === null ? null : new Date(lastSampleMs).toISOString(),
      lastSentAt, lastAckAt, lastPacket: lastPacket ? { ...lastPacket } : null,
      lastError: lastError ? { ...lastError } : null,
    };
  }
  return { capture, advanceTo, setOnline, flush, snapshot, nextEventAt: () => Math.min(nextRecordMs, nextSendMs) };
}
