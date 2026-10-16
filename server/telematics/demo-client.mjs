import { randomUUID } from 'node:crypto';
import { createTestCar } from './testcar-model.mjs';
import { decodeCodec8EFrame } from './codec8e.mjs';
import { encodeSyntheticFmc003Frame } from './virtual-fmc003.mjs';

const unavailable = () => Object.assign(new Error('telematics_demo_unavailable'), { code: 'telematics_demo_unavailable' });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function record(value) {
  return value && typeof value === 'object' && date(value.at)
    && ['lat', 'lng', 'speedKmh', 'rpm', 'fuelPercent', 'coolantC', 'batteryVolts', 'odometerMeters'].every(key => Number.isFinite(value[key]))
    && Math.abs(value.lat) <= 90 && Math.abs(value.lng) <= 180
    && typeof value.ignition === 'boolean' && typeof value.movement === 'boolean';
}
function summary(value, streamId) {
  if (!value || value.simulated !== true || value.streamId !== streamId
    || !['sqlite', 'postgres'].includes(value.storage) || !integer(value.recordsStored)
    || !integer(value.packetsReceived) || !integer(value.trips) || !Number.isFinite(value.distanceKm) || value.distanceKm < 0
    || !(value.lastReceivedAt === null || date(value.lastReceivedAt))
    || !(value.lastRecord === null || record(value.lastRecord))
    || !Array.isArray(value.recentRecords) || value.recentRecords.length > 10 || !value.recentRecords.every(record)) throw unavailable();
  // Copy only our synthetic DTO, never response headers, credentials or URLs.
  const project = row => row && Object.fromEntries(['at', 'lat', 'lng', 'speedKmh', 'rpm', 'fuelPercent', 'coolantC', 'batteryVolts', 'odometerMeters', 'ignition', 'movement'].map(key => [key, row[key]]));
  return { storage: value.storage, recordsStored: value.recordsStored, recordsReceived: value.recordsStored,
    packetsReceived: value.packetsReceived, distanceKm: value.distanceKm, trips: value.trips,
    lastReceivedAt: value.lastReceivedAt, lastRecord: project(value.lastRecord), recentRecords: value.recentRecords.map(project) };
}

export function validateDemoEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
    throw new Error('telematics_demo_endpoint_invalid');
  }
  return url.origin;
}

/** Server-to-server synthetic transport. Never exposed to the browser. An
 * uncertain POST is retried by the puck using identical Codec bytes; database
 * uniqueness makes this safe. A summary-read failure never retracts a valid ACK.
 */
export function createDemoTelematicsClient({ endpoint, streamId = randomUUID(), fetchImpl = fetch,
  now = Date.now, timeoutMs = 4000 } = {}) {
  if (typeof endpoint !== 'function' || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10)
    throw new Error('telematics_demo_client_configuration_invalid');
  let closed = false, registered = false, initializing = null, busy = false, failures = 0, retryAt = 0;
  let status = 'unknown', lastError = null;
  let stored = { storage: null, recordsStored: 0, recordsReceived: 0, packetsReceived: 0, distanceKm: 0, trips: 0,
    lastReceivedAt: null, lastRecord: null, recentRecords: [] };
  const controllers = new Set();
  async function request(path, { method = 'GET', body, contentType, binary = false } = {}) {
    if (closed) throw unavailable();
    const connection = await endpoint();
    if (closed || typeof connection?.token !== 'string' || Buffer.byteLength(connection.token) < 32) throw unavailable();
    const base = validateDemoEndpoint(connection.url);
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
    try {
      const response = await fetchImpl(`${base}${path}`, { method, body, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${connection.token}`, ...(contentType && { 'Content-Type': contentType }) } });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const reader = response.body?.getReader();
      if (!reader) throw unavailable();
      const chunks = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > (binary ? 4 : 32768)) { await reader.cancel(); throw unavailable(); }
        chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks);
      if (closed) throw unavailable();
      return binary ? bytes : JSON.parse(bytes.toString('utf8'));
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function failed() {
    if (closed) return;
    status = 'unavailable'; lastError = 'telematics_demo_unavailable';
    failures = Math.min(6, failures + 1); retryAt = now() + Math.min(30000, 1000 * 2 ** (failures - 1));
  }
  async function register() {
    if (registered) return;
    const value = await request('/v1/demo/streams', { method: 'POST', contentType: 'application/json', body: JSON.stringify({ streamId }) });
    if (value?.simulated !== true || value.streamId !== streamId || !['sqlite', 'postgres'].includes(value.storage)) throw unavailable();
    registered = true;
  }
  async function readSummary() {
    const value = await request(`/v1/demo/streams/${streamId}`);
    const next = summary(value, streamId);
    if (!closed) { stored = next; status = 'ready'; lastError = null; failures = 0; retryAt = 0; }
  }
  async function initialize() {
    if (closed || now() < retryAt) throw unavailable();
    if (!initializing) {
      initializing = (async () => { try { await register(); await readSummary(); } catch { failed(); throw unavailable(); } })();
      // Handlers are installed immediately, including when the caller discards
      // initialization. No unhandled rejection can take down the web process.
      void initializing.catch(() => {});
      void initializing.finally(() => { initializing = null; }).catch(() => {});
    }
    return initializing;
  }
  async function send(bytes) {
    if (closed || busy || now() < retryAt || !Buffer.isBuffer(bytes) || bytes.length > 65536) throw unavailable();
    busy = true;
    try {
      if (initializing) await initializing;
      await register();
      const ack = await request(`/v1/demo/streams/${streamId}/frames`, { method: 'POST',
        body: bytes, contentType: 'application/octet-stream', binary: true });
      if (ack.length !== 4) throw unavailable();
      // Correct accepted count is verified in the virtual puck, before removal.
      try { await readSummary(); } catch { failed(); }
      return ack;
    } catch { failed(); throw unavailable(); }
    finally { busy = false; }
  }
  return { initialize, send,
    snapshot: () => structuredClone({ ...stored, status, durable: stored.storage !== null, transport: 'http', lastError }),
    close() { closed = true; for (const controller of controllers) controller.abort(); controllers.clear(); },
  };
}

export function createServiceTestCar({ createClient, now, random, onAcknowledgedFrame } = {}) {
  if (typeof createClient !== 'function') throw new Error('telematics_demo_client_factory_required');
  let client = createClient(), closed = false, generation = 0, primeFrame = null, primeFlight = null;
  void client.initialize().catch(() => {});
  async function send(bytes) {
    const epoch = generation, current = client;
    const { records } = decodeCodec8EFrame(bytes);
    const ack = await current.send(bytes);
    if (closed || epoch !== generation || !Buffer.isBuffer(ack) || ack.length !== 4 || ack.readUInt32BE() !== records.length) throw unavailable();
    // A company sink must commit before the puck removes its frozen packet.
    // A failed sink leaves that identical packet queued for a safe retry.
    await onAcknowledgedFrame?.(Buffer.from(bytes));
    if (closed || epoch !== generation) throw unavailable();
    return ack;
  }
  const car = createTestCar({ ...(now && { now }), ...(random && { random }),
    receivePacket: send, receiverSnapshot: () => client.snapshot() });
  return {
    snapshot: car.snapshot, tick: car.tick,
    prime() {
      if (primeFlight) return primeFlight;
      const state = car.snapshot();
      if (closed || state.engineOn || state.device.pendingRecords || state.device.sending || !state.networkOnline) throw unavailable();
      if (!primeFrame) primeFrame = encodeSyntheticFmc003Frame([{ simulated: true,
        at: new Date(now ? now() : Date.now()).toISOString(), event: true, eventIoId: 239,
        ...state.currentPlace, ...state.telemetry, angle: 0, engineOn: false, tripActive: false,
        odometerMeters: Math.round(state.telemetry.odometerKm * 1000), fuelRateLh: 0 }]);
      primeFlight = send(primeFrame).then(() => { primeFrame = null; }).finally(() => { primeFlight = null; });
      return primeFlight;
    },
    command(value) {
      if (closed) throw unavailable();
      // Model validation happens before disposal. Invalid commands cannot reset
      // the transport or abandon its unacknowledged frame.
      const result = car.command(value);
      if (value.action !== 'reset') return result;
      generation++; primeFrame = null;
      client.close(); client = createClient(); void client.initialize().catch(() => {});
      return car.snapshot();
    },
    close() { if (!closed) { closed = true; generation++; car.close?.(); client.close(); } },
  };
}
