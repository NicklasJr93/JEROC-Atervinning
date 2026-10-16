import { crc16Ibm } from './codec8e.mjs';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

/** A bounded stream reader for simulator replies, which TCP can fragment too. */
export async function connectSimulatedTracker(port, { timeoutMs = 3000, tlsOptions } = {}) {
  const socket = tlsOptions ? tls.connect({ ...tlsOptions, port, host: '127.0.0.1' }) : net.connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0), waiter, failure;
  function flush() {
    if (!waiter) return;
    if (failure) { waiter.reject(failure); waiter = undefined; return; }
    if (buffer.length >= waiter.size) {
      const reply = buffer.subarray(0, waiter.size); buffer = buffer.subarray(waiter.size);
      waiter.resolve(reply); waiter = undefined;
    }
  }
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 4096) { socket.destroy(new Error('Simulated reply limit')); return; }
    flush();
  });
  socket.on('error', error => { failure = error; flush(); });
  socket.on('close', () => { failure ??= new Error('Simulated tracker disconnected'); flush(); });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Simulated tracker timed out')));
  try { await once(socket, tlsOptions ? 'secureConnect' : 'connect'); }
  catch (error) { socket.destroy(); throw error; }
  return { socket, readBytes(size) {
    if (!Number.isInteger(size) || size < 1 || size > 4096 || waiter) return Promise.reject(new Error('Invalid simulated read'));
    return new Promise((resolve, reject) => { waiter = { size, resolve, reject }; flush(); });
  } };
}

/** Synthetic packets for local integration exercises. Never a claim that a
 * physical FTC134 has connected. Only the pilot's supported signals are sent. */
export function simulatedImeiHandshake(imei) {
  if (!/^\d{15}$/.test(imei)) throw new TypeError('A simulated IMEI needs 15 digits');
  return Buffer.concat([Buffer.from([0, 15]), Buffer.from(imei)]);
}
export function simulatedFtc134Frame(records) {
  if (!Array.isArray(records) || !records.length || records.length > 255) throw new TypeError('Invalid simulated records');
  const u16 = value => { const result = Buffer.alloc(2); result.writeUInt16BE(value); return result; };
  const parts = [Buffer.from([0x8e, records.length])];
  for (const record of records) {
    const head = Buffer.alloc(28);
    head.writeBigUInt64BE(BigInt(new Date(record.at).getTime()));
    head[8] = 1;
    head.writeInt32BE(Math.round((record.longitude ?? 0) * 1e7), 9);
    head.writeInt32BE(Math.round((record.latitude ?? 0) * 1e7), 13);
    head[21] = 7; // Satellites; no actual GNSS fix is claimed.
    const flags = [];
    for (const [field, id] of [['ignition', 239], ['movement', 240]]) if (record[field] !== undefined)
      flags.push(Buffer.concat([u16(id), Buffer.from([Number(record[field])])]));
    const odo = [];
    if (record.odometerMeters !== undefined) {
      const value = Buffer.alloc(4); value.writeUInt32BE(record.odometerMeters);
      odo.push(Buffer.concat([u16(16), value]));
    }
    // GPS ends at byte24. Event ID and total I/O count occupy the last4bytes.
    head.writeUInt16BE(239, 24); head.writeUInt16BE(flags.length + odo.length, 26);
    parts.push(head, u16(flags.length), ...flags, u16(0), u16(odo.length), ...odo, u16(0), u16(0));
  }
  parts.push(Buffer.from([records.length]));
  const data = Buffer.concat(parts), header = Buffer.alloc(8), crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 4); crc.writeUInt32BE(crc16Ibm(data));
  return Buffer.concat([header, data, crc]);
}
