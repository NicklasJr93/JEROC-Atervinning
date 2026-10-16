import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService } from './application.mjs';
import { employeeTimeRequirementCommand } from './employee-time.mjs';
import { ingestFleetTrip } from './fleet.mjs';

const personId = 'person-legacy-fleet-gate', driverId = 'driver-legacy-fleet-gate';
const userId = 'user-legacy-fleet-gate', orderId = 'AO-legacy-fleet-gate';
const username = 'legacy.fleet.gate', password = 'Legacy-Fleet-Gate-2026!';

async function fixture(run, { external = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-personnel-fleet-gate-'));
  const app = createApplicationService({ env: { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') },
    siteProvider: async () => [{ id: 'norrtalje', name: 'Norrtälje', active: true }] });
  let server;
  try {
    const repository = await app.getRepository();
    const vehicleId = await repository.transact(state => {
      const vehicleId = state.transport.vehicles[0].id, salt = randomBytes(24).toString('hex');
      if (!external) state.pricing.users.push({ id: userId, name: 'Legacy fleet driver', level: 'Medarbetare', active: true, permissions: ['view'], siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false });
      state.personnel.people.push({ id: personId, ...(!external ? { userId } : { companyId: 'carrier-roslagen' }), driverId,
        name: 'Legacy fleet driver', active: true, kind: external ? 'external' : 'employee', role: 'Chaufför', team: 'Transport', siteIds: ['norrtalje'], canDrive: true, phone: '', email: '', address: '', revision: 0 });
      state.personnel.employment.push({ personId, form: 'permanent', startDate: '2026-01-01', percentage: 100, hoursPerWeek: 40, revision: 0 });
      state.personnel.schedules.push({ id: 'schedule-legacy-fleet-gate', personId, weekdays: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440, effectiveFrom: '2026-01-01', revision: 0 });
      state.personnelAuth.accounts.push({ personId, username, active: true, ...(external ? { siteIds: ['norrtalje'] } : {}),
        password: { salt, digest: scryptSync(password, salt, 64).toString('hex') }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      state.transport.drivers.push({ id: driverId, personId, ...(external ? { companyId: 'carrier-roslagen' } : {}), name: 'Legacy fleet driver', vehicleId, color: '#336699' });
      state.transport.orders.push({ ...structuredClone(state.transport.orders[0]), id: orderId, driverId, vehicleId, siteId: 'norrtalje', status: 'booked',
        date: '2026-10-09', startMinute: 600, durationMinutes: 60, requiredCompetencies: [], audit: [], bookingVersion: 1, updatedAt: new Date().toISOString() });
      return vehicleId;
    });
    server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    async function request(path, { data, cookie } = {}) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
    }
    async function login(portal = 'driver') {
      const result = await request(`/api/${portal}/login`, { data: { username, password } });
      assert.equal(result.status, 200, result.error); assert.ok(result.cookie?.startsWith(`jeroc_${portal}=`)); return result;
    }
    async function addTrip(id = 'old-ended-own-trip', overrides = {}) {
      return repository.transact((state, _, audit) => ingestFleetTrip(state, { id, vehicleId, personId, driverSource: 'panel', source: 'simulator', quality: 'good',
        startAt: '2020-01-01T07:00:00Z', endAt: '2020-01-01T07:30:00Z', distanceKm: 12, fromLabel: 'Old departure', toLabel: 'Old destination', ...overrides }, audit));
    }
    await run({ repository, request, login, addTrip });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await app.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('legacy driver status and logistics cannot bypass completion of an own ended trip', async () => fixture(async f => {
  const driver = await f.login(); await f.addTrip();
  for (const [suffix, data] of [['status', { status: 'on_way' }], ['logistics', { action: 'travel.empty', expectedVersion: 1 }]]) {
    const result = await f.request(`/api/driver/orders/${orderId}/${suffix}`, { cookie: driver.cookie, data });
    assert.equal(result.status, 423); assert.equal(result.code, 'FLEET_TRIPS_REQUIRED'); assert.equal(result.fleetGate.blocked, true);
    assert.equal(result.fleetGate.safeToInteract, true); assert.deepEqual(result.fleetGate.pendingTrips.map(trip => trip.id), ['old-ended-own-trip']);
  }
  await f.repository.read(state => { assert.equal(state.transport.orders.find(order => order.id === orderId).status, 'booked'); assert.equal(state.employeeTime?.orderSessions?.some(session => session.personId === personId), false); });
}));

test('a pending trip never prevents legacy work completion, employee stop or clock out', async () => fixture(async f => {
  const driver = await f.login(), employee = await f.login('employee');
  await f.repository.transact(state => {
    const admin = state.pricing.users.find(user => user.id === 'admin');
    employeeTimeRequirementCommand(state, { actor: admin, user: admin }, { personId, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 0,
      weekdays: [1, 2, 3, 4, 5, 6, 7], timeSource: 'clock', revision: employee.configuredRequirement.revision } });
  });
  const clockIn = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.in', requestId: randomUUID(), revision: employee.clock.revision } });
  assert.equal(clockIn.status, 200, clockIn.error);
  const started = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'on_way' } }); assert.equal(started.status, 200, started.error);
  await f.addTrip();
  const stopped = await f.request(`/api/employee/orders/${orderId}/stop`, { cookie: employee.cookie, data: {} }); assert.equal(stopped.status, 200, stopped.error);
  const done = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'done' } }); assert.equal(done.status, 200, done.error); assert.equal(done.order.status, 'done');
  const out = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.out', requestId: randomUUID(), revision: stopped.clock.revision } }); assert.equal(out.status, 200, out.error);
  const denied = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.in', requestId: randomUUID(), revision: out.clock.revision } }); assert.equal(denied.status, 423); assert.equal(denied.code, 'FLEET_TRIPS_REQUIRED');
  await f.repository.read(state => { const own = state.employeeTime.orderSessions.filter(session => session.personId === personId); assert.equal(own.length, 1); assert.ok(own[0].endedAt); });
}));

test('legacy completion through managed logistics stays available with an incomplete trip', async () => fixture(async f => {
  const driver = await f.login();
  const started = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'on_way' } }); assert.equal(started.status, 200, started.error);
  await f.repository.transact(state => {
    state.logistics.details[orderId] = { orderId, version: 1, siteId: 'norrtalje', operator: 'own', assignedDriverId: driverId,
      materialRows: [], execution: { stage: 'departed', officeCleared: true }, from: {}, to: {}, updatedAt: new Date().toISOString() };
  });
  await f.addTrip();
  const done = await f.request(`/api/driver/orders/${orderId}/logistics`, { cookie: driver.cookie, data: { action: 'deliver', expectedVersion: 1 } });
  assert.equal(done.status, 200, done.error); assert.equal(done.order.status, 'done');
  await f.repository.read(state => assert.ok(state.employeeTime.orderSessions.find(session => session.personId === personId).endedAt));
}));

test('legacy driver gate ignores others trips and defers completion prompts while an own trip is active', async () => fixture(async f => {
  const driver = await f.login();
  await f.addTrip('other-drivers-trip', { personId: 'person-kalle' });
  const started = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'on_way' } }); assert.equal(started.status, 200, started.error);
  await f.addTrip(); await f.addTrip('active-own-trip', { startAt: '2020-01-02T07:00:00Z', endAt: undefined });
  const active = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'on_way' } }); assert.equal(active.status, 200, active.error);
}));

test('external drivers remain exempt from employee trip-completion gating', async () => fixture(async f => {
  const driver = await f.login(); await f.addTrip();
  const result = await f.request(`/api/driver/orders/${orderId}/status`, { cookie: driver.cookie, data: { status: 'on_way' } }); assert.equal(result.status, 200, result.error);
}, { external: true }));
