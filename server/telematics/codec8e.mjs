// FTC134's AVL reference links to this wire protocol:
// https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended
// This decodes one complete TCP AVL frame, not the IMEI or UDP envelopes.

function invalid(reason) {
  const error = new Error(`Invalid Codec 8E frame: ${reason}`);
  error.code = 'TELEMATICS_CODEC_INVALID';
  throw error;
}

export function crc16Ibm(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('CRC input must be a Buffer');
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
  }
  return crc;
}

export function encodeRecordAck(count) {
  if (!Number.isInteger(count) || count < 0 || count > 255) throw new RangeError('Record count must be an integer from 0 to 255');
  const ack = Buffer.alloc(4);
  ack.writeUInt32BE(count);
  return ack;
}

export function decodeCodec8EFrame(buffer, { maxFrameBytes = 65536, maxRecords = 255 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Frame must be a Buffer');
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 15) throw new RangeError('Invalid frame byte limit');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 255) throw new RangeError('Invalid record limit');
  if (buffer.length > maxFrameBytes) invalid('frame byte limit exceeded');
  if (buffer.length < 15) invalid('truncated header or checksum');
  if (buffer.readUInt32BE(0) !== 0) invalid('preamble');
  const dataLength = buffer.readUInt32BE(4);
  if (dataLength < 3 || dataLength + 12 !== buffer.length) invalid('data length');
  const dataEnd = 8 + dataLength;
  if (buffer[8] !== 0x8E) invalid('unsupported codec');
  const count = buffer[9];
  if (count < 1 || count > maxRecords) invalid('record count');
  if (buffer[dataEnd - 1] !== count) invalid('record counts differ');
  if (buffer.readUInt32BE(dataEnd) !== crc16Ibm(buffer.subarray(8, dataEnd))) invalid('checksum');

  let offset = 10;
  const limit = dataEnd - 1; // Preserve the repeated record count.
  function take(length) {
    if (length > limit - offset) invalid('truncated record or IO');
    const start = offset;
    offset += length;
    return start;
  }
  function u8() { return buffer[take(1)]; }
  function u16() { return buffer.readUInt16BE(take(2)); }
  const records = [];
  for (let recordIndex = 0; recordIndex < count; recordIndex += 1) {
    const timestamp = buffer.readBigUInt64BE(take(8));
    // Date's full supported range is smaller than Number.MAX_SAFE_INTEGER.
    if (timestamp > 8640000000000000n) invalid('timestamp outside supported range');
    const at = new Date(Number(timestamp)).toISOString();
    const priority = u8();
    if (priority > 2) invalid('priority');
    const longitude = buffer.readInt32BE(take(4)) / 10000000;
    const latitude = buffer.readInt32BE(take(4)) / 10000000;
    const altitude = buffer.readInt16BE(take(2));
    const angle = u16();
    const satellites = u8();
    const speedKmh = u16();
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90 || angle > 360) invalid('GPS coordinates or angle');
    const eventIoId = u16();
    const totalIo = u16();
    // Each fixed entry requires at least its two-byte ID and one-byte value;
    // all five group counters must also fit, even for an empty IO record.
    if (totalIo > Math.floor((limit - offset - 10) / 3)) invalid('IO count exceeds available bytes');
    const io = {};
    let seenIo = 0;
    function readGroup(width) {
      const groupCount = u16();
      if (groupCount > totalIo - seenIo) invalid('IO group count exceeds total');
      const minimumEntryBytes = width === null ? 4 : width + 2;
      if (groupCount > Math.floor((limit - offset) / minimumEntryBytes)) invalid('IO group exceeds available bytes');
      for (let ioIndex = 0; ioIndex < groupCount; ioIndex += 1) {
        const id = u16();
        if (Object.hasOwn(io, id)) invalid('duplicate IO ID');
        const length = width === null ? u16() : width;
        if (length === 0) invalid('empty variable IO value');
        const start = take(length);
        // Values remain lossless and keep leading zeroes, including uint64 IDs.
        io[id] = buffer.toString('hex', start, start + length);
      }
      seenIo += groupCount;
    }
    for (const width of [1, 2, 4, 8, null]) readGroup(width);
    if (seenIo !== totalIo) invalid('IO total does not match groups');
    records.push({ at, priority, gps: { longitude, latitude, altitude, angle, satellites, speedKmh }, eventIoId, io });
  }
  if (offset !== limit) invalid('unconsumed record bytes');
  return { records };
}
