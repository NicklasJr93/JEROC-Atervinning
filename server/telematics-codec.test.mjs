import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16Ibm, decodeCodec8EFrame, encodeRecordAck } from './telematics/codec8e.mjs';

// Official Codec 8 Extended TCP example, including its original checksum.
// https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended
const officialFrame = Buffer.from(
  '000000000000004A8E010000016B412CEE000100000000000000000000000000000000010005000100010100010011001D00010010015E2C880002000B000000003544C87A000E000000001DD7E06A00000100002994',
  'hex',
);

function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32BE(value); return buffer; }
function frame(records, { codec = 0x8E, count = records.length, repeatedCount = count } = {}) {
  const data = Buffer.concat([Buffer.from([codec, count]), ...records, Buffer.from([repeatedCount])]);
  return Buffer.concat([Buffer.alloc(4), u32(data.length), data, u32(crc16Ibm(data))]);
}
function record({ timestamp = 1792144800000n, priority = 0, longitude = 180000000, latitude = 590000000, altitude = -15, angle = 359, fixed = {}, variable = [] } = {}) {
  const head = Buffer.alloc(24);
  head.writeBigUInt64BE(timestamp, 0);
  head[8] = priority;
  head.writeInt32BE(longitude, 9);
  head.writeInt32BE(latitude, 13);
  head.writeInt16BE(altitude, 17);
  head.writeUInt16BE(angle, 19);
  head[21] = 8;
  head.writeUInt16BE(70, 22);
  const entries = [1, 2, 4, 8].map(width => fixed[width] ?? []);
  const groups = entries.map(group => Buffer.concat([u16(group.length), ...group.flatMap(([id, hex]) => [u16(id), Buffer.from(hex, 'hex')])]));
  groups.push(Buffer.concat([u16(variable.length), ...variable.flatMap(([id, hex]) => [u16(id), u16(hex.length / 2), Buffer.from(hex, 'hex')])]));
  return Buffer.concat([head, u16(239), u16(entries.reduce((sum, group) => sum + group.length, variable.length)), ...groups]);
}
function rejected(input, reason, options) {
  assert.throws(() => decodeCodec8EFrame(input, options), error => error.code === 'TELEMATICS_CODEC_INVALID' && (!reason || error.message.includes(reason)));
}
function changeRecord(offset, bytes) {
  const changed = Buffer.from(officialFrame.subarray(10, -5));
  Buffer.from(bytes).copy(changed, offset);
  return frame([changed]);
}

test('official TCP fixture decodes every IO width and its independent CRC', () => {
  assert.equal(crc16Ibm(Buffer.from('123456789')), 0xBB3D);
  assert.equal(crc16Ibm(officialFrame.subarray(8, -4)), 0x2994);
  assert.deepEqual(decodeCodec8EFrame(officialFrame), { records: [{
    at: '2019-06-10T11:36:32.000Z', priority: 1,
    gps: { longitude: 0, latitude: 0, altitude: 0, angle: 0, satellites: 0, speedKmh: 0 },
    eventIoId: 1, io: { 1: '01', 17: '001d', 16: '015e2c88', 11: '000000003544c87a', 14: '000000001dd7e06a' },
  }] });
  assert.equal(encodeRecordAck(1).toString('hex'), '00000001');
  assert.equal(encodeRecordAck(0).toString('hex'), '00000000');
  assert.equal(encodeRecordAck(255).toString('hex'), '000000ff');
  for (const count of [-1, 256, 0.5, NaN]) assert.throws(() => encodeRecordAck(count), RangeError);
});

test('multiple records retain unknown/variable IO and uint64 identifiers losslessly', () => {
  const input = frame([
    record({ fixed: { 1: [[239, '01'], [391, '00']], 8: [[78, 'fedcba9876543210']] }, variable: [[65000, '0001ffeedd']] }),
    record({ longitude: -1800000000, latitude: -900000000, altitude: -300, angle: 360, fixed: { 4: [[16, '000003e8']] } }),
  ]);
  const result = decodeCodec8EFrame(input);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0].io, { 239: '01', 391: '00', 78: 'fedcba9876543210', 65000: '0001ffeedd' });
  assert.equal(result.records[1].gps.longitude, -180);
  assert.equal(result.records[1].gps.latitude, -90);
  assert.equal(result.records[1].gps.altitude, -300);
  assert.equal(result.records[1].io[16], '000003e8');
  assert.deepEqual(decodeCodec8EFrame(input, { maxFrameBytes: input.length, maxRecords: 2 }), result);
  rejected(input, 'frame byte limit', { maxFrameBytes: input.length - 1 });
  rejected(input, 'record count', { maxRecords: 1 });
});

test('supports the full one-byte record count and verifies declared totals', () => {
  const input = frame(Array.from({ length: 255 }, () => record()));
  assert.equal(decodeCodec8EFrame(input).records.length, 255);
  const mismatch = record({ fixed: { 8: [[78, 'fedcba9876543210']] } });
  mismatch.writeUInt16BE(2, 26);
  rejected(frame([mismatch]), 'IO total');
});

test('rejects checksum, lengths, codec, preamble, counts, trailing bytes and all truncations', () => {
  for (let length = 0; length < officialFrame.length; length += 1) rejected(officialFrame.subarray(0, length));
  rejected(Buffer.concat([officialFrame, Buffer.from([0])]), 'data length');
  const badPreamble = Buffer.from(officialFrame); badPreamble[0] = 1; rejected(badPreamble, 'preamble');
  const badCrc = Buffer.from(officialFrame); badCrc[badCrc.length - 1] ^= 1; rejected(badCrc, 'checksum');
  const badCrcHigh = Buffer.from(officialFrame); badCrcHigh[badCrcHigh.length - 4] = 1; rejected(badCrcHigh, 'checksum');
  rejected(frame([record()], { codec: 8 }), 'unsupported codec');
  rejected(frame([record()], { repeatedCount: 2 }), 'record counts differ');
  rejected(frame([]), 'record count');
  rejected(frame([record()], { count: 2 }), 'truncated');
  const extra = Buffer.concat([record(), Buffer.from([0])]); rejected(frame([extra]), 'unconsumed');
});

test('rejects corrupt IO counts, duplicate IDs, impossible variable lengths and malformed GPS/time', () => {
  // Relative offsets: timestamp8+priority1+GPS15+event2 = IO total at26.
  rejected(changeRecord(26, [0xFF, 0xFF]), 'IO count');
  rejected(changeRecord(28, [0xFF, 0xFF]), 'IO group count');
  rejected(frame([record({ fixed: { 1: [[239, '01']], 8: [[239, '0000000000000001']] } })]), 'duplicate IO ID');
  const corruptVariable = record({ variable: [[65000, 'aa']] }); corruptVariable.writeUInt16BE(65535, corruptVariable.length - 3);
  rejected(frame([corruptVariable]), 'truncated');
  rejected(frame([record({ variable: [[65000, '']] })]), 'empty variable');
  rejected(frame([record({ longitude: 1800000001 })]), 'GPS');
  rejected(frame([record({ latitude: -900000001 })]), 'GPS');
  rejected(frame([record({ angle: 361 })]), 'GPS');
  rejected(frame([record({ priority: 3 })]), 'priority');
  rejected(frame([record({ timestamp: 8640000000000001n })]), 'timestamp');
  rejected(frame([record({ timestamp: 0xFFFFFFFFFFFFFFFFn })]), 'timestamp');
});

test('decoder input and configured resource limits cannot silently disable checks', () => {
  assert.throws(() => decodeCodec8EFrame(new Uint8Array(officialFrame)), TypeError);
  assert.throws(() => crc16Ibm('123456789'), TypeError);
  for (const maxFrameBytes of [0, 14, 1.5, NaN, Infinity]) assert.throws(() => decodeCodec8EFrame(officialFrame, { maxFrameBytes }), RangeError);
  for (const maxRecords of [0, 256, 1.5, NaN]) assert.throws(() => decodeCodec8EFrame(officialFrame, { maxRecords }), RangeError);
});
