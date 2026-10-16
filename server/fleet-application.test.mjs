import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationService } from './application.mjs';
import { ingestFleetTrip } from './fleet.mjs';

const username = 'fleet-integration-employee', password = 'Fleet-Integration-2026!', userId = 'user-fleet-integration', personId = 'person-fleet-integration', driverId = 'driver-fleet-integration';
const orderId = 'AO-fleet-integration';
const officeUserId = 'fleet-integration-office';
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-fleet-application-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_FLEET_FILES_DB_PATH: join(directory, 'fleet-files.sqlite'), JEROC_SICKNESS_FILES_DB_PATH: join(directory, 'sickness.sqlite') };
  let app, server;
  async function start() {
    app = createApplicationService({ env, siteProvider: async () => structuredClone(sites) });
    await app.getRepository();
    server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); }
  await start();
  const repository = () => app.getRepository();
  const vehicleId = await (await repository()).transact(state => {
    const vehicleId = state.transport.vehicles[0].id, salt = randomBytes(24).toString('hex');
    state.pricing.users.push({ id: officeUserId, name: 'Fleet integration office', level: 'Systemadmin', active: true, permissions: [], maxAttest: 1000000, ownAttest: true });
    state.pricing.users.push({ id: userId, name: 'Fleet integration employee', level: 'Medarbetare', active: true, permissions: ['view', 'prepare', 'customers'], siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false });
    state.personnel.people.push({ id: personId, userId, driverId, name: 'Fleet integration employee', active: true, kind: 'employee', role: 'Chaufför', team: 'Transport', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: true, revision: 0 });
    state.personnel.employment.push({ personId, form: 'permanent', startDate: '2026-01-01', percentage: 100, hoursPerWeek: 40, revision: 0 });
    state.personnel.schedules.push({ id: 'schedule-fleet-integration', personId, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2026-01-01', revision: 0 });
    state.personnelAuth.accounts.push({ personId, username, active: true, password: { salt, digest: scryptSync(password, salt, 64).toString('hex') }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    state.transport.drivers.push({ id: driverId, personId, name: 'Fleet integration employee', vehicleId, color: '#336699' });
    const template = structuredClone(state.transport.orders[0]);
    state.transport.orders.push({ ...template, id: orderId, driverId, vehicleId, siteId: 'norrtalje', status: 'booked', date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
      startMinute: 600, durationMinutes: 60, requiredCompetencies: [], audit: [], bookingVersion: 1, updatedAt: new Date().toISOString() });
    return vehicleId;
  });
  async function request(path, { data, cookie, actor, headers = {} } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(actor ? { 'X-Demo-Actor': actor, 'X-Demo-User': actor } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(5000) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
  }
  const office = (path, data) => request(path, { actor: officeUserId, data });
  async function login() { const response = await request('/api/employee/login', { data: { username, password } }); assert.equal(response.status, 200, response.error); assert.ok(response.cookie?.startsWith('jeroc_employee=')); return response; }
  async function assignVehicle() {
    const state = await office('/api/fleet');
    const saved = await office('/api/fleet/actions', { action: 'profile.save', requestId: randomUUID(), expectedRevision: state.revision, vehicleId, profile: { siteId: 'norrtalje', defaultDriverId: personId, notes: 'Explicit integration assignment' } });
    assert.equal(saved.status, 200, saved.error); return saved;
  }
  try { await run({ request, office, login, repository, vehicleId, assignVehicle, restart: async () => { await stop(); await start(); } }); }
  finally { await stop(); await rm(directory, { recursive: true, force: true }); }
}

test('application wiring exposes fleet before generic routes, uses existing canonical IDs and starts an employee without invented fleet data', async () => fixture(async f => {
  const fleet = await f.office('/api/fleet'); assert.equal(fleet.status, 200, fleet.error); assert.equal(fleet.capabilities.write, true); assert.ok(fleet.telematics);
  assert.deepEqual(fleet.trips, []); assert.deepEqual(fleet.services, []); assert.deepEqual(fleet.issues, []); assert.deepEqual(fleet.telematics.devices, []);
  const transport = await f.office('/api/application/transport'), personnel = await f.office('/api/application/personnel?view=planning'), registry = await f.office('/api/personnel/vehicles');
  for (const response of [transport, personnel, registry]) assert.equal(response.status, 200, response.error);
  const ids = fleet.vehicles.map(vehicle => vehicle.id).sort(); assert.deepEqual(transport.data.vehicles.map(vehicle => vehicle.id).sort(), ids); assert.deepEqual(registry.vehicles.map(vehicle => vehicle.id).sort(), ids); assert.deepEqual(personnel.transport.vehicles.map(vehicle => vehicle.id).sort(), ids);
  const links = personnel.transport.drivers.map(driver => [driver.id, driver.personId, driver.vehicleId]);
  assert.ok(links.some(([id, person, vehicle]) => id === driverId && person === personId && vehicle === f.vehicleId));
  const employee = await f.login(), empty = await f.request('/api/employee/fleet', { cookie: employee.cookie });
  assert.equal(empty.status, 200, empty.error); assert.equal(empty.personId, personId); assert.deepEqual(empty.vehicles, []); assert.deepEqual(empty.trips, []); assert.deepEqual(empty.pendingTrips, []); assert.equal(empty.gate.blocked, false);
  const assigned = await f.assignVehicle(); assert.equal(assigned.saved.profile.defaultDriverId, personId);
  const own = await f.request('/api/employee/fleet', { cookie: employee.cookie }); assert.deepEqual(own.vehicles.map(vehicle => vehicle.id), [f.vehicleId]);
  assert.deepEqual((await f.office('/api/application/personnel?view=planning')).transport.drivers.map(driver => [driver.id, driver.personId, driver.vehicleId]), links);
  assert.deepEqual((await f.office('/api/application/transport')).data.vehicles.map(vehicle => vehicle.id).sort(), ids);
}));

test('old own incomplete trips block ordinary application work while time, stop, logout and idempotent private completion remain usable', async () => fixture(async f => {
  let employee = await f.login(); await f.assignVehicle();
  const requirement = await f.office('/api/application/personnel-time', { action: 'requirement.save', personId,
    requirement: { enabled: true, mode: 'fixed', dailyMinutes: 0, weekdays: [1, 2, 3, 4, 5, 6, 7], timeSource: 'clock', revision: employee.configuredRequirement.revision } });
  assert.equal(requirement.status, 200, requirement.error);
  let session = await f.request('/api/employee/session', { cookie: employee.cookie });
  const clockIn = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.in', requestId: randomUUID(), revision: session.clock.revision } }); assert.equal(clockIn.status, 200, clockIn.error);
  const start = await f.request('/api/employee/time', { cookie: employee.cookie, data: { action: 'order.start', orderId } }); assert.equal(start.status, 200, start.error);
  await (await f.repository()).transact((state, _, audit) => ingestFleetTrip(state, { id: 'old-ended-own-trip', vehicleId: f.vehicleId, personId, driverSource: 'panel', source: 'simulator', quality: 'good',
    startAt: '2020-01-01T07:00:00Z', endAt: '2020-01-01T07:30:00Z', distanceKm: 12, fromLabel: 'Old departure', toLabel: 'Old destination' }, audit));
  let own = await f.request('/api/employee/fleet?from=2026-01-01', { cookie: employee.cookie });
  assert.equal(own.tripCount, 0); assert.equal(own.gate.count, 1); assert.equal(own.pendingTrips[0].id, 'old-ended-own-trip'); assert.equal(own.gate.safeToInteract, true);
  const mobile = await f.request('/api/application/mobile', { cookie: employee.cookie }); assert.equal(mobile.status, 200, mobile.error);
  for (const [path, data] of [['/api/employee/time', { action: 'order.start', orderId }], [`/api/employee/orders/${orderId}/start`, {}], ['/api/application/mobile', { base: mobile.data, next: mobile.data }]]) {
    const blocked = await f.request(path, { cookie: employee.cookie, data }); assert.equal(blocked.status, 423, `${path}: ${blocked.error}`); assert.equal(blocked.code, 'FLEET_TRIPS_REQUIRED');
  }
  const stop = await f.request(`/api/employee/orders/${orderId}/stop`, { cookie: employee.cookie, data: {} }); assert.equal(stop.status, 200, stop.error);
  const out = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.out', requestId: randomUUID(), revision: stop.clock.revision } }); assert.equal(out.status, 200, out.error);
  const blockedClock = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.in', requestId: randomUUID(), revision: out.clock.revision } }); assert.equal(blockedClock.status, 423); assert.equal(blockedClock.code, 'FLEET_TRIPS_REQUIRED');
  const yesterday = new Date(`${employee.today}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const time = await f.request('/api/employee/time/save', { cookie: employee.cookie, data: { date: yesterday.toISOString().slice(0, 10), startMinute: 420, endMinute: 425, breakMinutes: 0, activity: 'Gårdsarbete', note: 'Actual past test work', siteId: 'norrtalje' } }); assert.equal(time.status, 200, time.error);
  assert.equal((await f.request('/api/employee/fleet', { cookie: employee.cookie })).gate.count, 1);
  const logout = await f.request('/api/employee/logout', { cookie: employee.cookie, data: {} }); assert.equal(logout.status, 200); assert.equal(logout.ok, true);
  assert.equal((await f.request('/api/employee/fleet', { cookie: employee.cookie })).status, 401);
  employee = await f.login(); own = await f.request('/api/employee/fleet', { cookie: employee.cookie });
  const input = { action: 'trip.complete', requestId: randomUUID(), expectedRevision: own.revision, tripId: own.pendingTrips[0].id, expectedTripRevision: own.pendingTrips[0].revision,
    classification: 'private', purpose: 'Must be cleared for private travel', workOrderId: orderId };
  const completed = await f.request('/api/employee/fleet/actions', { cookie: employee.cookie, data: input }); assert.equal(completed.status, 200, completed.error); assert.equal(completed.gate.blocked, false); assert.equal(completed.saved.trip.purpose, undefined); assert.equal(completed.saved.trip.workOrderId, undefined);
  const replay = await f.request('/api/employee/fleet/actions', { cookie: employee.cookie, data: input }); assert.equal(replay.status, 200, replay.error); assert.equal(replay.replayed, true); assert.equal(replay.saved.trip.revision, completed.saved.trip.revision);
  const reopenedMobile = await f.request('/api/application/mobile', { cookie: employee.cookie, data: { base: mobile.data, next: mobile.data } }); assert.equal(reopenedMobile.status, 200, reopenedMobile.error);
  session = await f.request('/api/employee/session', { cookie: employee.cookie });
  const newClock = await f.request('/api/employee/clock', { cookie: employee.cookie, data: { action: 'clock.in', requestId: randomUUID(), revision: session.clock.revision } }); assert.equal(newClock.status, 200, newClock.error);
  await (await f.repository()).read(state => { const trip = state.fleet.trips.find(trip => trip.id === input.tripId); assert.equal(trip.classification, 'private'); assert.equal(trip.purpose, undefined); assert.equal(trip.workOrderId, undefined); assert.equal(state.fleet.events.filter(event => event.action === 'trip.complete' && event.tripId === input.tripId).length, 1); });
}));

test('real application restart retains canonical vehicle links and fleet profiles; invalid employee cookies never use office-header fallback', async () => fixture(async f => {
  const employee = await f.login(), before = await f.office('/api/fleet'); await f.assignVehicle();
  const links = await (await f.repository()).read(state => structuredClone(state.transport.drivers));
  const denied = await f.request('/api/employee/fleet', { cookie: 'jeroc_employee=invalid', actor: 'admin' }); assert.equal(denied.status, 401);
  const actionDenied = await f.request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=invalid', actor: 'admin', data: { action: 'trip.complete', requestId: randomUUID(), expectedRevision: 0, tripId: 'guessed', expectedTripRevision: 1, classification: 'private' } }); assert.equal(actionDenied.status, 401);
  await f.restart();
  const restored = await f.office('/api/fleet'); assert.equal(restored.status, 200, restored.error); assert.deepEqual(restored.vehicles.map(vehicle => vehicle.id).sort(), before.vehicles.map(vehicle => vehicle.id).sort()); assert.equal(restored.profiles[f.vehicleId].defaultDriverId, personId);
  assert.deepEqual(await (await f.repository()).read(state => state.transport.drivers), links);
  const own = await f.request('/api/employee/fleet', { cookie: employee.cookie }); assert.equal(own.status, 200, own.error); assert.equal(own.personId, personId); assert.deepEqual(own.vehicles.map(vehicle => vehicle.id), [f.vehicleId]); assert.deepEqual(own.trips, []);
}));
