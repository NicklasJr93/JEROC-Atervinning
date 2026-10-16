import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformApi } from './platform-api.mjs';
import { createPlatformFleet } from './platform-fleet.mjs';
import { applyFleetDeviceAssignment } from './fleet-telematics.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-platform-fleet-'));
  const env = { JEROC_PLATFORM_DB_PATH: join(directory, 'registry.sqlite') };
  const password = 'Private-Platform-Fleet-2026!', passwordHash = await platformPasswordHash(password);
  let repository = await createPlatformStorage({ env }), auth, fleet, api, failCopy = false, failAck = false, ackArmed = false, copies = 0;
  const companyIds = [randomUUID(), randomUUID()];
  const businesses = new Map(['jeroc-demo', ...companyIds].map(companyId => [companyId, [
    { id: '__platform-admin', name: 'Plattform', level: 'Systemadmin', active: true, permissions: [] },
    { id: 'vd', name: 'VD', level: 'VD', active: true, permissions: [] },
  ]]));
  const tenants = new Map(companyIds.map(id => [id, { fleet: { devices: [{ id: 'old-device', name: 'Befintlig tracker', organisationId: id, source: 'device', active: true }], bindings: [{ id: 'keep-binding', deviceId: 'old-device', vehicleId: 'van1', endAt: null }] } }]));
  function setup() {
    auth = createPlatformAuth({ repository, bootstrapLegacy: async () => ({ id: 'admin', username: 'admin', name: 'Systemadmin', password: passwordHash, active: true }),
      resolveCompanyUser: async (company, id) => businesses.get(company)?.find(user => user.id === id), companyUsers: async company => businesses.get(company) ?? [] });
    const store = { read: (...args) => repository.read(...args), transact: operation => {
      if (ackArmed) { ackArmed = false; throw new Error('private acknowledgement database fault'); }
      return repository.transact(operation);
    } };
    fleet = createPlatformFleet({ auth, repository: store, applyAssignment: async (company, device) => {
      copies++; if (failCopy) throw new Error('private tenant password do-not-expose');
      applyFleetDeviceAssignment(tenants.get(company.id), device, { organisationId: company.id });
      if (failAck) { failAck = false; ackArmed = true; }
    } });
    api = createPlatformApi({ auth, fleet, env });
  }
  setup(); await auth.initialize();
  await repository.transact(state => {
    state.companies.push(...companyIds.map(id => ({ id, name: `Bolag ${id.slice(0, 6)}`, status: 'active', storageSchema: 'private_unused', ownerUserId: 'vd' })));
    state.users.push({ id: 'vd', businessId: 'vd', username: 'vd', name: 'VD', password: passwordHash, active: true, platformAdmin: false });
    state.memberships.push({ userId: 'vd', organisationId: companyIds[0], businessUserId: 'vd', active: true });
  });
  const server = createServer((req, res) => void api(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = 'telematics', payload, session, headers = {}) {
    const response = await fetch(`${base}/api/platform/${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: {
      origin: base, 'content-type': 'application/json', ...(session && { cookie: session.cookie, 'x-platform-csrf': session.body.csrfToken, 'x-platform-generation': session.body.generation }), ...headers,
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const cookie = response.headers.getSetCookie().filter(value => value.startsWith('jeroc_platform=') || value.startsWith('jeroc_tenant=')).map(value => value.split(';')[0]).join('; ');
    return { status: response.status, body: await response.json(), cookie: cookie || session?.cookie };
  }
  async function login(username = 'admin') { const result = await request('login', { username, password }); assert.equal(result.status, 200, result.body.error); return result; }
  const current = async session => (await request('telematics', undefined, session)).body;
  const command = async (session, values) => ({ requestId: randomUUID(), revision: (await current(session)).revision, ...values });
  try { await run({ request, login, current, command, companyIds, tenants, repository: () => repository,
    failCopy: value => { failCopy = value; }, failAck: () => { failAck = true; }, copies: () => copies, fleet: () => fleet,
    reopen: async () => { await fleet.close(); await repository.close(); repository = await createPlatformStorage({ env }); setup(); },
  }); } finally { await new Promise(resolve => server.close(resolve)); await fleet.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}
const registration = extra => ({ action: 'device.register', name: 'Fysisk tracker', model: 'Teltonika FMC920', source: 'device', imei: '490154203237518', profile: 'teltonika-codec8e', ...extra });

test('only the real platform administrator outside support can read or write inventory', async () => fixture(async ({ login, request, command, companyIds }) => {
  assert.equal((await request()).status, 401);
  const admin = await login(), vd = await login('vd');
  assert.equal((await request('telematics', undefined, vd, { 'x-demo-actor': 'admin' })).status, 403);
  assert.equal((await request('telematics', registration(), vd)).status, 403);
  const payload = await command(admin, registration());
  assert.equal((await request('telematics', payload, admin, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await request('telematics', payload, admin, { 'x-platform-generation': 'stale' })).status, 409);
  assert.equal((await request('telematics', payload, admin, { origin: 'https://foreign.invalid' })).status, 403);
  const support = await request('switch', { organisationId: companyIds[0], effectiveUserId: 'vd' }, admin);
  assert.equal(support.status, 200); assert.equal((await request('telematics', undefined, support)).status, 403);
}));
test('registration is idempotent, validates IMEI, rejects secrets and never pretends to be connected', async () => fixture(async ({ login, request, command, current }) => {
  const admin = await login(), payload = await command(admin, registration());
  const attempts = await Promise.all([request('telematics', payload, admin), request('telematics', payload, admin)]);
  assert.ok(attempts.every(value => value.status === 200)); assert.equal(attempts[0].body.result.deviceId, attempts[1].body.result.deviceId);
  const data = await current(admin); assert.equal(data.devices.length, 1);
  assert.equal(data.devices[0].provisioningStatus, 'prepared'); assert.equal(data.devices[0].connectionStatus, 'never_connected'); assert.equal(data.devices[0].organisationId, undefined);
  assert.equal((await request('telematics', { ...payload, name: 'Ändrad' }, admin)).status, 409);
  assert.equal((await request('telematics', await command(admin, registration()), admin)).status, 409);
  assert.equal((await request('telematics', await command(admin, registration({ imei: '490154203237519' })), admin)).status, 422);
  assert.equal((await request('telematics', await command(admin, registration({ token: 'secret' })), admin)).status, 422);
  assert.equal((await request('telematics', await command(admin, registration({ sim: { password: 'secret' } })), admin)).status, 422);
}));
test('tenant assignment commits a separate copy without moving existing bindings or leaking into another company', async () => fixture(async ({ login, request, command, current, companyIds, tenants }) => {
  const admin = await login(), created = await request('telematics', await command(admin, registration()), admin), deviceId = created.body.result.deviceId;
  const original = structuredClone(tenants.get(companyIds[0]).fleet.bindings);
  const saved = await request('telematics', await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[0] }), admin);
  assert.equal(saved.status, 200, saved.body.error); assert.equal(saved.body.result.status, 'completed');
  assert.deepEqual(tenants.get(companyIds[0]).fleet.bindings, original); assert.equal(tenants.get(companyIds[0]).fleet.devices.length, 2);
  assert.equal(tenants.get(companyIds[1]).fleet.devices.length, 1);
  assert.equal((await current(admin)).devices[0].organisationId, companyIds[0]);
  assert.equal((await request('telematics', await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[1] }), admin)).status, 409);
}));
test('failed tenant copy remains durable and reserved; the same request recovers after restart', async () => fixture(async ({ login, request, command, current, companyIds, tenants, failCopy, reopen }) => {
  const admin = await login(), created = await request('telematics', await command(admin, registration()), admin), deviceId = created.body.result.deviceId;
  const payload = await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[0] }); failCopy(true);
  const failed = await request('telematics', payload, admin); assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.body).includes('private tenant'));
  const waiting = await current(admin); assert.equal(waiting.devices[0].organisationId, undefined); assert.equal(waiting.requests[0].command.requestId, payload.requestId);
  assert.equal((await request('telematics', await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[1] }), admin)).status, 409);
  await reopen(); failCopy(false);
  const saved = await request('telematics', payload, admin); assert.equal(saved.status, 200, saved.body.error);
  assert.equal(tenants.get(companyIds[0]).fleet.devices.filter(value => value.id === deviceId).length, 1);
  assert.equal(saved.body.requests.length, 0);
}));
test('a crash after tenant commit is reconciled idempotently before assignment is acknowledged', async () => fixture(async ({ login, request, command, current, companyIds, tenants, failAck, reopen, fleet }) => {
  const admin = await login(), created = await request('telematics', await command(admin, registration()), admin), deviceId = created.body.result.deviceId;
  failAck(); const payload = await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[0] });
  assert.equal((await request('telematics', payload, admin)).status, 500);
  assert.equal((await current(admin)).devices[0].organisationId, undefined);
  const revision = tenants.get(companyIds[0]).fleet.revision;
  await reopen(); await fleet().reconcile();
  assert.equal(tenants.get(companyIds[0]).fleet.revision, revision);
  assert.equal((await request('telematics', payload, admin)).status, 200);
  assert.equal((await current(admin)).devices[0].organisationId, companyIds[0]);
}));
test('retirement inactivates the tenant copy and preserves historical identity and company', async () => fixture(async ({ login, request, command, current, companyIds, tenants }) => {
  const admin = await login(), created = await request('telematics', await command(admin, registration()), admin), deviceId = created.body.result.deviceId;
  await request('telematics', await command(admin, { action: 'device.assign', deviceId, organisationId: companyIds[0] }), admin);
  const retired = await request('telematics', await command(admin, { action: 'device.retire', deviceId }), admin);
  assert.equal(retired.status, 200, retired.body.error); assert.equal(retired.body.devices[0].provisioningStatus, 'retired');
  assert.equal(retired.body.devices[0].organisationId, companyIds[0]); assert.equal(tenants.get(companyIds[0]).fleet.devices.find(value => value.id === deviceId).active, false);
  assert.equal((await request('telematics', await command(admin, registration()), admin)).status, 409);
  assert.equal((await current(admin)).devices.length, 1);
}));
