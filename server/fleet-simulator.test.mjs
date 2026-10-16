import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createTestCarApi } from './telematics/testcar-api.mjs';
import { createDemoTelematicsStore } from './telematics/demo-store.mjs';
import { createDemoTelematicsService } from './telematics/demo-service.mjs';
import { createDemoTelematicsClient, createServiceTestCar } from './telematics/demo-client.mjs';
import { encodeSyntheticFmc003Frame } from './telematics/virtual-fmc003.mjs';
import { decodeCodec8EFrame, encodeRecordAck } from './telematics/codec8e.mjs';
import { applyFleetDeviceAssignment, fleetTelematicsCommand } from './fleet-telematics.mjs';
import { normalizeSimulatorFrame } from './fleet-simulator.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let count = 0; count < 200; count++) { if (await check()) return; await sleep(10); }
  throw new Error('Expected asynchronous receiver state');
}
const sample = (patch = {}) => ({ simulated: true, at: new Date().toISOString(), lat: 59.76, lng: 18.7, angle: 30,
  speedKmh: 30, rpm: 1800, coolantC: -5, fuelPercent: 68, fuelRateLh: 4, batteryVolts: 14.2,
  engineOn: true, tripActive: true, odometerMeters: 124583000, ...patch });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'fleet-simulator-'));
  const env = Object.fromEntries(['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM'].map(key =>
    [`JEROC_${key}_DB_PATH`, join(directory, `${key.toLowerCase()}.sqlite`)]));
  Object.assign(env, { JEROC_TENANT_DATA_DIR: directory, SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Private-Simulator-Fixture-2026!' });
  let server, gateway, receiver, api, store;
  try {
    store = await createDemoTelematicsStore({ filename: join(directory, 'demo.sqlite') });
    const token = 'fixture-only-synthetic-receiver-token-2026';
    receiver = await createDemoTelematicsService({ store, token });
    const endpoint = async () => ({ url: `http://127.0.0.1:${receiver.address.port}`, token });
    api = createTestCarApi({ autoTick: false, factory: callbacks => createServiceTestCar({
      createClient: () => createDemoTelematicsClient({ endpoint }), ...callbacks }) });
    gateway = await createTenantGateway({ env, testCarApi: api });
    server = createServer((req, res) => { void (async () => {
      const url = new URL(req.url, 'http://localhost');
      if (await api(req, res, url) || await gateway(req, res, url)) return;
      res.writeHead(404); res.end();
    })().catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function browser(initial = []) {
      const cookies = new Map(initial); let platform, lab;
      const request = async (path, payload, extra = {}) => {
        const headers = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(platform && { 'x-platform-csrf': platform.csrfToken, 'x-platform-generation': platform.generation,
            'x-platform-organisation-id': platform.organisationId }),
          ...(lab && { 'x-testcar-csrf': lab.csrfToken }),
          ...(payload !== undefined && { 'Content-Type': 'application/json' }), ...extra };
        for (const key of Object.keys(headers)) if (headers[key] === null || headers[key] === undefined) delete headers[key];
        const response = await fetch(`${base}${path}`, { method: payload === undefined ? 'GET' : 'POST',
          headers, ...(payload !== undefined && { body: JSON.stringify(payload) }) });
        for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0].split('='); if (value) cookies.set(key, value); else cookies.delete(key); }
        const body = await response.json();
        if (body.authenticated) platform = body;
        if (body.csrfToken && body.car) lab = body;
        return { status: response.status, body };
      };
      return { cookies, request, get session() { return platform; },
        serverSession() { return api.fleetSession({ headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; ') } }); } };
    }
    const own = browser();
    async function login(client = own) {
      let result = await client.request('/api/platform/login', { username: 'admin', password: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      result = await client.request('/api/platform/change-password', { currentPassword: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD, newPassword: 'Changed-Simulator-Fixture-2026!' });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const company = await gateway.auth.getCompany('jeroc-demo');
    const repository = await (await gateway.bundle(company)).applicationApi.getRepository();
    await repository.transact(state => {
      for (const source of ['simulator', 'device']) applyFleetDeviceAssignment(state, { id: `${source}-one`, name: source,
        organisationId: company.id, source, active: true }, { organisationId: company.id });
      state.fleet.devices.push({ id: 'foreign', name: 'Foreign secret', organisationId: 'another-company', source: 'simulator', active: true });
    });
    await run({ own, browser, login, repository, company, api, gateway });
  } finally {
    api?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await receiver?.close(); await store?.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('real HTTP gateway requires independent platform/lab CSRF, all-site rights and assigned simulator source', () => fixture(async f => {
  const publicOnly = await f.own.request('/api/testcar/session'); assert.equal(publicOnly.status, 200);
  assert.equal((await f.own.request('/api/testcar/fleet')).status, 401);
  assert.equal((await f.own.request('/api/testcar/fleet', undefined, { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' })).status, 401);
  await f.login();
  const get = await f.own.request('/api/testcar/fleet'); assert.equal(get.status, 200, JSON.stringify(get.body));
  assert.deepEqual(get.body.devices.map(row => row.id), ['simulator-one']);
  assert.equal(get.body.devices[0].vehicleId, null); assert.equal(get.body.link, undefined);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' }, { 'x-testcar-csrf': null })).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' }, { 'x-platform-csrf': null })).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' }, { origin: 'https://foreign.test' })).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'device-one' })).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'foreign' })).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one', records: [] })).status, 422);
  await f.repository.transact(state => { state.pricing.users.find(row => row.id === '__platform-admin').siteIds = []; });
  assert.equal((await f.own.request('/api/testcar/fleet')).status, 403);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' })).status, 403);
  const state = await f.repository.read(state => state);
  assert.equal(state.fleet.telemetryEvents.length, 0); assert.equal(state.fleet.simulatorClaims, undefined);
}));

test('trusted motor-off prime enables first vehicle link; acknowledged frames commit once, leases exclude another browser and reset requires disconnect', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  const connected = await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  assert.equal(connected.status, 200, JSON.stringify(connected.body)); assert.equal(connected.body.link.status, 'connected');
  let state = await f.repository.read(state => structuredClone(state));
  const device = state.fleet.devices.find(row => row.id === 'simulator-one');
  assert.equal(device.ignition, false); assert.equal(device.tripState, 'idle'); assert.equal(state.fleet.telemetryEvents.length, 1);
  assert.match(state.fleet.simulatorClaims[device.id].ownerHash, /^[a-f0-9]{64}$/);
  const second = f.browser(f.own.cookies); await second.request('/api/testcar/session', undefined, { cookie: `jeroc_platform=${f.own.cookies.get('jeroc_platform')}` });
  await second.request('/api/platform/session');
  assert.equal((await second.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' })).status, 409);
  await f.repository.transact(state => {
    const admin = state.pricing.users.find(row => row.id === '__platform-admin');
    fleetTelematicsCommand(state, { actor: admin, user: admin }, { action: 'device.link', deviceId: 'simulator-one',
      vehicleId: state.transport.vehicles[0].id, expectedRevision: device.revision, requestId: randomUUID() }, [], { organisationId: f.company.id });
  });
  assert.equal((await f.own.request('/api/testcar/command', { action: 'reset' })).status, 409);
  const session = f.own.serverSession();
  const bytes = encodeSyntheticFmc003Frame([sample({ at: '2031-01-01T00:00:00Z' }), sample({ at: '2031-01-01T00:00:15Z', engineOn: false, tripActive: false, speedKmh: 0, rpm: 0, odometerMeters: 124584000 })]);
  await session.fleetSink.receive(bytes);
  state = await f.repository.read(state => structuredClone(state));
  assert.equal(state.fleet.telemetryEvents.length, 3);
  const events = state.fleet.telemetryEvents.slice(-2);
  assert.ok(Date.parse(events[0].at) < Date.parse(events[1].at));
  assert.ok(Date.parse(events[1].at) <= Date.now()); assert.ok(!events.some(row => row.quarantined));
  await session.fleetSink.receive(bytes);
  assert.equal(await f.repository.read(state => state.fleet.telemetryEvents.length), 3);
  await f.own.request('/api/testcar/command', { action: 'start' });
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'disconnect' })).status, 409);
  await f.own.request('/api/testcar/command', { action: 'stop' });
  await until(() => !session.car.snapshot().device.sending);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'disconnect' })).status, 200);
  assert.equal((await f.own.request('/api/testcar/command', { action: 'reset' })).status, 200);
  assert.equal(await f.repository.read(state => state.fleet.simulatorClaims['simulator-one']), undefined);
}));

test('logout and stale generation revoke the captured sink before any later business write', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  const connected = await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  assert.equal(connected.body.link.status, 'connected');
  const session = f.own.serverSession(), sink = session.fleetSink;
  const before = await f.repository.read(state => structuredClone(state.fleet));
  assert.equal((await f.own.request('/api/platform/logout', {})).status, 200);
  await assert.rejects(sink.receive(encodeSyntheticFmc003Frame([sample()])));
  assert.deepEqual(await f.repository.read(state => structuredClone(state.fleet)), before);
  assert.equal(sink.status, 'error');
}));

test('separate receiver ACK cannot discard a frame when the company transaction fails', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  const session = f.own.serverSession(), before = await f.repository.read(state => structuredClone(state.fleet));
  const transact = f.repository.transact;
  f.repository.transact = async () => { throw new Error('injected company commit failure'); };
  try {
    session.car.command({ action: 'start' });
    await until(() => !session.car.snapshot().device.sending);
    assert.equal(session.car.snapshot().device.pendingRecords, 1);
    assert.ok(session.car.snapshot().receiver.recordsStored >= 2, 'the independent receiver already committed and ACKed');
    assert.deepEqual(await f.repository.read(state => structuredClone(state.fleet)), before);
  } finally { f.repository.transact = transact; }
  session.car.command({ action: 'network', online: true });
  await until(() => session.car.snapshot().device.pendingRecords === 0);
  assert.equal(await f.repository.read(state => state.fleet.telemetryEvents.length), 2);
}));

test('explicit same-company reconnect after logout delivers the pending stop before disconnect and reset', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  const session = f.own.serverSession();
  session.car.command({ action: 'start' }); await until(() => session.car.snapshot().device.pendingRecords === 0);
  session.car.command({ action: 'network', online: false }); session.car.command({ action: 'stop' });
  assert.equal(session.car.snapshot().device.pendingRecords, 1);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'disconnect' })).status, 409);
  await f.own.request('/api/platform/logout', {});
  const login = await f.own.request('/api/platform/login', { username: 'admin', password: 'Changed-Simulator-Fixture-2026!' });
  assert.equal(login.status, 200);
  const before = await f.repository.read(state => structuredClone(state.fleet));
  const get = await f.own.request('/api/testcar/fleet'); assert.equal(get.body.link.status, 'error');
  assert.deepEqual(await f.repository.read(state => structuredClone(state.fleet)), before, 'GET must not renew stale authorization');
  session.car.command({ action: 'network', online: true });
  await until(() => !session.car.snapshot().device.sending);
  assert.equal(session.car.snapshot().device.pendingRecords, 1, 'ordinary retry cannot adopt the new login');
  const reconnect = await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  assert.equal(reconnect.status, 200, JSON.stringify(reconnect.body));
  await until(() => session.car.snapshot().device.pendingRecords === 0);
  assert.equal(await f.repository.read(state => state.fleet.devices.find(row => row.id === 'simulator-one').ignition), false);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'disconnect' })).status, 200);
  assert.equal((await f.own.request('/api/testcar/command', { action: 'reset' })).status, 200);
}));

test('company switch isolates projections and revokes the original captured writer until explicit return/reconnect', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' });
  const session = f.own.serverSession();
  const created = await f.own.request('/api/platform/companies', { requestId: randomUUID(), name: 'Synthetic Other Company',
    organisationNumber: '5560000167', vdName: 'Synthetic Director', vdEmail: 'synthetic-director@example.test' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const otherId = created.body.company.id;
  assert.equal((await f.own.request('/api/platform/switch', { organisationId: otherId })).status, 200);
  const before = await f.repository.read(state => structuredClone(state.fleet));
  const get = await f.own.request('/api/testcar/fleet');
  assert.equal(get.status, 200); assert.deepEqual(get.body.devices, []); assert.equal(get.body.link, undefined);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' })).status, 409);
  await assert.rejects(session.fleetSink.receive(encodeSyntheticFmc003Frame([sample()])));
  assert.deepEqual(await f.repository.read(state => structuredClone(state.fleet)), before);
  await f.own.request('/api/platform/switch', { organisationId: f.company.id });
  assert.equal((await f.own.request('/api/testcar/fleet')).body.link.status, 'error');
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' })).status, 200);
  assert.equal((await f.own.request('/api/testcar/fleet', { action: 'disconnect' })).status, 200);
}));

test('an expired foreign lease cannot be seized while a previous trip is active or unknown', () => fixture(async f => {
  await f.login(); await f.own.request('/api/testcar/session');
  for (const ignition of [true, null]) {
    await f.repository.transact(state => {
      const row = state.fleet.devices.find(row => row.id === 'simulator-one');
      Object.assign(row, { ignition, tripState: ignition ? 'active' : 'unknown', lastContactAt: new Date().toISOString() });
      state.fleet.simulatorClaims = { 'simulator-one': { ownerHash: 'b'.repeat(64), expiresAt: '2000-01-01T00:00:00Z' } };
    });
    assert.equal((await f.own.request('/api/testcar/fleet', { action: 'connect', deviceId: 'simulator-one' })).status, 409);
    assert.equal(await f.repository.read(state => state.fleet.telemetryEvents.length), 0);
  }
}));

test('company commit failure retains byte-identical puck packet, and no sink runs before an exact ACK', async () => {
  const packets = [], delivered = []; let commit = false, ackValid = true;
  const car = createServiceTestCar({ createClient: () => ({ initialize: async () => {}, snapshot: () => ({}), close() {},
    async send(bytes) { packets.push(Buffer.from(bytes)); return encodeRecordAck(ackValid ? decodeCodec8EFrame(bytes).records.length : 0); } }),
    onAcknowledgedFrame: async bytes => { delivered.push(Buffer.from(bytes)); if (!commit) throw new Error('injected rollback'); } });
  car.command({ action: 'start' }); await until(() => !car.snapshot().device.sending);
  assert.equal(car.snapshot().device.pendingRecords, 1); assert.equal(delivered.length, 1);
  ackValid = false; car.command({ action: 'network', online: true }); await until(() => !car.snapshot().device.sending);
  assert.equal(delivered.length, 1, 'wrong record count must not reach the company sink');
  ackValid = true; commit = true; car.command({ action: 'network', online: true }); await until(() => !car.snapshot().device.sending);
  assert.equal(car.snapshot().device.pendingRecords, 0); assert.equal(delivered.length, 2);
  assert.deepEqual(packets[0], packets[1]); assert.deepEqual(packets[1], packets[2]); car.close();
});

test('FMC003 normalization uses signed/scaled real AVL fields and stable frame identity', () => {
  const bytes = encodeSyntheticFmc003Frame([sample()]);
  const options = { ownerHash: 'a'.repeat(64), mappedAt: Date.now() };
  const [record] = normalizeSimulatorFrame(bytes, options);
  assert.equal(record.rpm, 1800); assert.equal(record.coolantC, -5); assert.equal(record.batteryVolts, 14.2);
  assert.equal(record.fuelPercent, 68); assert.equal(record.ignition, true); assert.equal(record.odometerMeters, 124583000);
  assert.deepEqual(normalizeSimulatorFrame(bytes, options), [record]);
  assert.ok(!Object.hasOwn(record, 'companyId')); assert.ok(!Object.hasOwn(record, 'tripActive'));
});
