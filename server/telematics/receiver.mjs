import net from 'node:net';
import tls from 'node:tls';
import { timingSafeEqual } from 'node:crypto';
import { decodeCodec8EFrame, encodeRecordAck } from './codec8e.mjs';
import { normalizeFtc134Records } from './normalize.mjs';

const loopbacks = new Set(['127.0.0.1', '::1']);
const sameFingerprint = (expected, presented) => {
  const actual = presented?.replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || !/^[a-f0-9]{64}$/.test(actual ?? '')) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
};

/** Real TCP pilot ingress, separate from HTTP/Render. Plain TCP is restricted
 * to loopback. A public listener additionally requires verified client TLS
 * certificates AND a pinned fingerprint for the specific registered IMEI.
 * FTC134 mutual-TLS provisioning has not been verified on physical hardware;
 * these server guards are not a claim of tracker interoperability. */
export async function createTelematicsReceiver({ store, host = '127.0.0.1', port = 0, tlsOptions,
  maxConnections = 32, maxFrameBytes = 65536, idleTimeoutMs = 120000, handshakeTimeoutMs = 10000,
  onError = () => {} } = {}) {
  if (!store || !Number.isInteger(port) || port < 0 || port > 65535
    || !Number.isInteger(maxConnections) || maxConnections < 1
    || !Number.isInteger(maxFrameBytes) || maxFrameBytes < 64 || maxFrameBytes > 1048576
    || !Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 10
    || !Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 10)
    throw new Error('telematics_receiver_configuration_invalid');
  if (tlsOptions && (!tlsOptions.key || !tlsOptions.cert || !tlsOptions.ca))
    throw new Error('telematics_tls_configuration_invalid');
  if (!loopbacks.has(host) && !tlsOptions) throw new Error('telematics_public_tls_required');
  const sockets = new Set(), devices = new Set(), pending = new Set();
  let stopping = false;
  const report = code => { try { onError({ code }); } catch { /* Observability cannot interrupt ingress cleanup. */ } };
  const connect = socket => {
    if (stopping || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    let buffer = Buffer.alloc(0), binding, pumping = false;
    const loginTimer = setTimeout(() => socket.destroy(), handshakeTimeoutMs); loginTimer.unref();
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => report('telematics_socket_error'));
    socket.once('close', () => {
      sockets.delete(socket); clearTimeout(loginTimer);
      // A closing connection may still be committing its last batch. Keep
      // the device reservation until that operation settles.
      if (!pumping && binding) devices.delete(binding.id);
    });
    async function pump() {
      if (pumping || socket.destroyed) return;
      pumping = true;
      try {
        while (!socket.destroyed && !stopping) {
          if (!binding) {
            if (buffer.length < 2) break;
            if (buffer.readUInt16BE(0) !== 15) throw new Error('telematics_imei_invalid');
            if (buffer.length < 17) break;
            const imei = buffer.subarray(2, 17).toString('ascii');
            // High-bit bytes must not be coerced into valid ASCII digits.
            if (!/^\d{15}$/.test(imei) || !buffer.subarray(2, 17).equals(Buffer.from(imei, 'ascii')))
              throw new Error('telematics_imei_invalid');
            buffer = buffer.subarray(17);
            const found = await store.lookupDevice(imei);
            if (!found?.active || devices.has(found.id)
              || tlsOptions && (!socket.authorized || !sameFingerprint(found.certificateFingerprint, socket.getPeerCertificate()?.fingerprint256))) {
              if (!socket.destroyed) socket.end(Buffer.from([0]));
              break;
            }
            if (socket.destroyed || stopping) break;
            binding = Object.freeze({ ...found }); devices.add(binding.id);
            clearTimeout(loginTimer); socket.write(Buffer.from([1]));
          }
          if (buffer.length < 8) break;
          if (buffer.readUInt32BE(0) !== 0) throw new Error('telematics_preamble_invalid');
          const frameBytes = buffer.readUInt32BE(4) + 12;
          if (frameBytes > maxFrameBytes || frameBytes < 15) throw new Error('telematics_frame_length_invalid');
          if (buffer.length < frameBytes) break;
          const frame = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);
          const decoded = decodeCodec8EFrame(frame, { maxFrameBytes });
          const records = normalizeFtc134Records(decoded.records);
          socket.pause();
          // Successful decode is insufficient. ACK only after the durable
          // transaction. Retransmitted records count as accepted, not inserted.
          const receipt = await store.ingest(binding, records);
          if (receipt.accepted !== records.length) throw new Error('telematics_commit_count_invalid');
          if (!socket.destroyed && !stopping) { socket.write(encodeRecordAck(receipt.accepted)); socket.resume(); }
        }
      } catch {
        // No payload, coordinates, IMEI or RFID in logs/error callbacks.
        report('telematics_batch_not_acknowledged'); socket.destroy();
      } finally {
        pumping = false;
        if (socket.destroyed && binding) devices.delete(binding.id);
      }
    }
    socket.on('data', chunk => {
      // TCP is a stream: split headers/records and coalesced packets are normal.
      // Bound queued data even if an untrusted peer keeps writing during commit.
      if (chunk.length + buffer.length > maxFrameBytes * 2 + 17) {
        report('telematics_buffer_limit'); socket.destroy(); return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const task = pump(); pending.add(task); void task.finally(() => pending.delete(task));
    });
  };
  const server = tlsOptions
    ? tls.createServer({ ...tlsOptions, minVersion: 'TLSv1.2', handshakeTimeout: handshakeTimeoutMs,
      requestCert: true, rejectUnauthorized: true }, connect)
    : net.createServer(connect);
  // Count TCP connections even before TLS authentication reaches `connect`.
  server.maxConnections = maxConnections;
  server.on('tlsClientError', () => report('telematics_tls_rejected'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', () => report('telematics_listener_error'));
  return {
    address: server.address(),
    async close() {
      stopping = true;
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await stopped; await Promise.allSettled([...pending]);
    },
  };
}
