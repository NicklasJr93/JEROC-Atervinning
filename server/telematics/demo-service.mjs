import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeCodec8EFrame, encodeRecordAck } from './codec8e.mjs';

export const DEMO_TELEMATICS_HTTP_DEFAULTS = Object.freeze({
  host: '127.0.0.1', port: 0, maxFrameBytes: 65536, maxJsonBytes: 2048,
  bodyTimeoutMs: 10000, requestTimeoutMs: 15000, maxConnections: 64,
  maxConcurrentRequests: 32, requestBurst: 200, requestPeriodMs: 1000,
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fault = (status, code) => Object.assign(new Error(code), { status, code });
const responseHeaders = {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function rejectBody(req, code, status) {
  req.resume();
  throw Object.assign(fault(status, code), { closeConnection: true });
}
function readBytes(req, maxBytes, timeoutMs) {
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    rejectBody(req, 'demo_content_type_invalid', 415);
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    rejectBody(req, 'demo_body_too_large', 413);
  return new Promise((resolve, reject) => {
    let settled = false, size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', aborted); req.removeListener('aborted', aborted);
      if (error) {
        // An aborted oversized/timed-out body may emit a later stream error
        // while the uncached error response closes its connection.
        req.once('error', () => {}); req.resume(); reject(error);
      } else resolve(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > maxBytes) finish(Object.assign(fault(413, 'demo_body_too_large'), { closeConnection: true }));
      else chunks.push(chunk);
    };
    const end = () => finish(null, Buffer.concat(chunks, size));
    const aborted = () => finish(fault(400, 'demo_request_aborted'));
    const timer = setTimeout(() => finish(Object.assign(fault(408, 'demo_body_timeout'), { closeConnection: true })), timeoutMs);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
  });
}
function numberIo(io, id, bytes, { required = false, signed = false } = {}) {
  const raw = io[id];
  if (raw === undefined && !required) return undefined;
  if (typeof raw !== 'string' || !new RegExp(`^[a-f0-9]{${bytes * 2}}$`, 'i').test(raw))
    throw fault(422, 'demo_signal_invalid');
  const value = Number.parseInt(raw, 16);
  return signed && value >= 2 ** (bytes * 8 - 1) ? value - 2 ** (bytes * 8) : value;
}
function booleanIo(io, id, required = false) {
  const value = numberIo(io, id, 1, { required });
  if (value === undefined) return undefined;
  if (value !== 0 && value !== 1) throw fault(422, 'demo_signal_invalid');
  return value === 1;
}

/** This internal authenticated producer registers fictional UUID streams, never
 * real device identities. The wire format alone cannot prove synthetic origin.
 * Preserve only this explicit FMC003 whitelist; no raw frame or unknown I/O. */
export function normalizeSyntheticFmc003Frame(frame, { maxFrameBytes = 65536 } = {}) {
  let decoded;
  try { decoded = decodeCodec8EFrame(frame, { maxFrameBytes }); }
  catch { throw fault(422, 'demo_frame_invalid'); }
  return decoded.records.map(record => {
    const { io, gps } = record;
    const result = {
      id: createHash('sha256').update(JSON.stringify(record)).digest('hex'), at: record.at,
      lat: gps.latitude, lng: gps.longitude, speedKmh: gps.speedKmh,
      ignition: booleanIo(io, 239, true), movement: booleanIo(io, 240, true),
      tripActive: booleanIo(io, 250, true), odometerMeters: numberIo(io, 16, 4, { required: true }),
    };
    const values = { rpm: numberIo(io, 36, 2, { required: true }), fuelPercent: numberIo(io, 48, 1, { required: true }),
      coolantC: numberIo(io, 32, 1, { required: true, signed: true }), batteryVolts: numberIo(io, 66, 2, { required: true }) };
    if (values.fuelPercent !== undefined && values.fuelPercent > 100) throw fault(422, 'demo_signal_invalid');
    for (const [key, value] of Object.entries(values)) if (value !== undefined)
      result[key] = key === 'batteryVolts' ? value / 1000 : value;
    return result;
  });
}

/** Independent synthetic-only HTTP receiver. Callers own the separate store's
 * lifecycle. Never give this process CRM credentials or a browser-facing route. */
export async function createDemoTelematicsService(options = {}) {
  const config = { ...DEMO_TELEMATICS_HTTP_DEFAULTS, ...options };
  const { store, token, host, port, maxFrameBytes, maxJsonBytes, bodyTimeoutMs, requestTimeoutMs,
    maxConnections, maxConcurrentRequests, requestBurst, requestPeriodMs } = config;
  if (!store || !['registerStream', 'ingest', 'summary', 'ready'].every(method => typeof store[method] === 'function')
    || typeof token !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(token)
    || typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535
    || ![maxFrameBytes, maxJsonBytes, bodyTimeoutMs, requestTimeoutMs, maxConnections, maxConcurrentRequests,
      requestBurst, requestPeriodMs].every(value => Number.isSafeInteger(value) && value > 0)
    || maxFrameBytes > 65536 || maxFrameBytes < 64 || maxJsonBytes > 2048
    || requestTimeoutMs < bodyTimeoutMs) throw fault(500, 'demo_configuration_invalid');
  const expectedToken = Buffer.from(token);
  let stopping = false, inFlight = 0, available = requestBurst, updated = performance.now(), closing;
  let healthAvailable = requestBurst, healthUpdated = updated;
  const authorized = req => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const actual = Buffer.from(header.slice(7));
    return actual.length === expectedToken.length && timingSafeEqual(actual, expectedToken);
  };
  const storage = async operation => {
    try { return await operation(); }
    catch (error) {
      if ([400, 404, 409, 413, 422, 429, 503].includes(error?.status) && /^demo_[a-z0-9_]+$/.test(error.code ?? '')) throw error;
      throw fault(503, 'demo_storage_unavailable');
    }
  };
  const handle = async (req, res) => {
    let counted = false;
    try {
      const url = new URL(req.url, 'http://localhost');
      // Infrastructure probes cannot send the private producer token. This
      // response contains no stream/storage information and never touches SQL.
      if (req.method === 'GET' && url.pathname === '/healthz' && !url.search && !url.hash) {
        const time = performance.now();
        healthAvailable = Math.min(requestBurst, healthAvailable + (time - healthUpdated) * requestBurst / requestPeriodMs);
        healthUpdated = time;
        if (healthAvailable < 1) throw fault(429, 'demo_rate_limited');
        healthAvailable--;
        if (stopping) throw fault(503, 'demo_not_ready');
        json(res, 200, { status: 'ok' }); return;
      }
      if (!authorized(req)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="synthetic-telematics"');
        throw fault(401, 'demo_auth_required');
      }
      if (stopping) throw fault(503, 'demo_not_ready');
      const time = performance.now();
      available = Math.min(requestBurst, available + (time - updated) * requestBurst / requestPeriodMs); updated = time;
      if (available < 1) throw fault(429, 'demo_rate_limited');
      available--;
      if (inFlight >= maxConcurrentRequests) throw fault(503, 'demo_busy');
      inFlight++; counted = true;
      if (url.search || url.hash) throw fault(400, 'demo_input_invalid');
      if (['/healthz', '/readyz'].includes(url.pathname)) {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw fault(405, 'demo_method_not_allowed'); }
        if (url.pathname === '/readyz' && !await storage(() => store.ready())) throw fault(503, 'demo_not_ready');
        json(res, 200, { simulated: true, status: 'ok' }); return;
      }
      if (url.pathname === '/v1/demo/streams') {
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fault(405, 'demo_method_not_allowed'); }
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fault(415, 'demo_content_type_invalid');
        const bytes = await readBytes(req, maxJsonBytes, bodyTimeoutMs);
        let input;
        try { input = JSON.parse(bytes.toString('utf8')); } catch { throw fault(400, 'demo_json_invalid'); }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || !Object.hasOwn(input, 'streamId') || typeof input.streamId !== 'string' || !uuid.test(input.streamId))
          throw fault(422, 'demo_input_invalid');
        const streamId = input.streamId.toLowerCase();
        await storage(() => store.registerStream(streamId));
        json(res, 200, { simulated: true, streamId, storage: store.kind }); return;
      }
      const match = /^\/v1\/demo\/streams\/([^/]+)(\/frames)?$/.exec(url.pathname);
      if (!match) throw fault(404, 'demo_not_found');
      if (!uuid.test(match[1])) throw fault(422, 'demo_input_invalid');
      const streamId = match[1].toLowerCase(), frames = Boolean(match[2]);
      const method = frames ? 'POST' : 'GET';
      if (req.method !== method) { res.setHeader('Allow', method); throw fault(405, 'demo_method_not_allowed'); }
      if (!frames) { json(res, 200, await storage(() => store.summary(streamId))); return; }
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fault(415, 'demo_content_type_invalid');
      const bytes = await readBytes(req, maxFrameBytes, bodyTimeoutMs);
      const records = normalizeSyntheticFmc003Frame(bytes, { maxFrameBytes });
      const receipt = await storage(() => store.ingest(streamId, records));
      if (receipt?.accepted !== records.length) throw fault(503, 'demo_storage_unavailable');
      if (!res.destroyed) {
        res.writeHead(200, { ...responseHeaders, 'Content-Type': 'application/octet-stream', 'Content-Length': '4' });
        res.end(encodeRecordAck(receipt.accepted));
      }
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      const status = [400, 401, 404, 405, 408, 409, 413, 415, 422, 429, 503].includes(error?.status) ? error.status : 500;
      if (status === 429 || status === 503) res.setHeader('Retry-After', '1');
      if (error?.closeConnection) res.setHeader('Connection', 'close');
      req.resume();
      const code = status === 500 ? 'demo_internal_error' : error.code;
      json(res, status, { error: code, code });
    } finally { if (counted) inFlight--; }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: requestTimeoutMs,
    headersTimeout: Math.min(bodyTimeoutMs, requestTimeoutMs), keepAliveTimeout: 5000,
    connectionsCheckingInterval: 1000 }, (req, res) => { void handle(req, res); });
  server.maxConnections = maxConnections;
  server.maxRequestsPerSocket = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  // Later listener failures never reveal bindings, payloads or credentials.
  server.on('error', () => {});
  return { address: server.address(), close() {
    if (!closing) {
      stopping = true;
      closing = new Promise((resolve, reject) => {
        const force = setTimeout(() => server.closeAllConnections(), requestTimeoutMs); force.unref();
        server.close(error => { clearTimeout(force); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      });
    }
    return closing;
  } };
}
