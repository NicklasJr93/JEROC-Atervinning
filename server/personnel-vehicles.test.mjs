import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationRepository } from './application-storage.mjs';
import { createPricingStore, resolvePricingPrincipal } from './pricing.mjs';
import { applyTransportChange, transportSchema, seedTransport } from '../dist-server/domain-models.mjs';
import { normalizeVehicleRegistration, vehicleRegistryCapabilities, vehicleRegistryCommand, vehicleRegistryProjection,
  handlePersonnelVehiclesApi, assertVehiclePlanningChange } from './personnel-vehicles.mjs';

const principal = (state, actor = 'admin', user = actor) => resolvePricingPrincipal(state.pricing.users, actor, user);
const initialApplicationState = () => ({ metadata: { version: 1 }, pricing: createPricingStore().exportState(), transport: seedTransport('2026-10-08') });
const command = (extra = {}) => ({ action: 'vehicle.save', requestId: 'vehicle-create-test',
  vehicle: { registration: 'abc-12a', name: 'Lastväxlare för test', active: true, types: ['container', 'battery'], category: 'truck', capacityKg: 22000, ...extra } });

test('vehicle references are normalized, duplicates include inactive fleet and invalid payloads are atomic', () => {
  const state = initialApplicationState(), p = principal(state), initialOrders = structuredClone(state.transport.orders), audit = [];
  const result = vehicleRegistryCommand(state, p, command(), audit), saved = result.vehicles.find(vehicle => vehicle.id === result.savedVehicleId);
  assert.equal(saved.registration, 'ABC12A'); assert.equal(saved.revision, 1); assert.equal(saved.capacityKg, 22000);
  assert.deepEqual(saved.types, ['battery', 'container']); assert.deepEqual(state.transport.orders, initialOrders);
  assert.equal(audit[0].action, 'vehicle.created'); assert.equal(audit[0].actualUserId, 'admin');
  const deactivated = vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { ...command().vehicle, id: saved.id, revision: 1, active: false } });
  assert.equal(deactivated.vehicles.find(vehicle => vehicle.id === saved.id).active, false);
  const frozen = structuredClone(state);
  assert.throws(() => vehicleRegistryCommand(state, p, { ...command({ registration: 'ABC 12A' }), requestId: 'other-request' }), /används redan/);
  for (const vehicle of [command({ registration: 'ABC/123' }).vehicle, command({ capacityKg: -1 }).vehicle, command({ types: [] }).vehicle,
    { ...command().vehicle, requiredCompetencies: ['license:CE'] }, { ...command().vehicle, companyId: 'another-tenant' }])
    assert.throws(() => vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle }));
  assert.deepEqual(state, frozen);
  assert.equal(normalizeVehicleRegistration(' ab c-123 '), 'ABC123');
});

test('ordinary defaults, historical bookings and pending plans survive retirement without accepting a new booking', () => {
  const state = initialApplicationState(), p = principal(state), vehicle = state.transport.vehicles.find(value => value.id === 'vehicle-kalle');
  state.personnel = { people: [{ id: 'person-test', canDrive: true, driverId: 'kalle', vehicleId: vehicle.id }] };
  const oldOrders = structuredClone(state.transport.orders), oldDrivers = structuredClone(state.transport.drivers);
  vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { ...vehicle, active: false, revision: 0 } });
  assert.deepEqual(state.transport.orders, oldOrders); assert.deepEqual(state.transport.drivers, oldDrivers);
  assert.equal(state.personnel.people[0].vehicleId, vehicle.id); assert.equal(transportSchema.safeParse(state.transport).success, true);
  const actor = { canPlan: true, actor: 'Admin', actualUserId: 'admin', effectiveUserId: 'admin' };
  const plan = { date: '2026-10-15', startMinute: 900, durationMinutes: 60, driverId: 'kalle', vehicleId: vehicle.id };
  assert.throws(() => applyTransportChange(state.transport, { type: 'book', id: 'AO-1043', plan }, actor), /inaktiverat/);
  const old = state.transport.orders.find(order => order.id === 'AO-1042');
  assert.throws(() => applyTransportChange(state.transport, { type: 'edit', id: old.id, patch: { date: '2026-10-15' } }, actor), /inaktiverat/);
  const metadataOnly = applyTransportChange(state.transport, { type: 'edit', id: old.id, patch: { notes: 'Historisk instruktion uppdaterad' } }, actor);
  assert.equal(metadataOnly.orders.find(order => order.id === old.id).vehicleId, vehicle.id);
  const { id: _id, audit: _audit, updatedAt: _at, bookingVersion: _version, confirmation: _confirmation, ...draft } = state.transport.orders.find(order => order.id === 'AO-1043');
  assert.throws(() => applyTransportChange(state.transport, { type: 'create', draft: { ...draft, ...plan, status: 'booked' } }, actor), /inaktiverat/);
});

test('registration/capacity changes keep old booking snapshots while new plans use current capabilities', () => {
  const state = initialApplicationState(), p = principal(state), old = state.transport.vehicles.find(vehicle => vehicle.id === 'vehicle-kalle');
  const orders = structuredClone(state.transport.orders);
  vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { id: old.id, revision: 0, name: old.name, registration: old.registration,
    active: true, types: ['bin'], category: 'van', capacityKg: 1000 } });
  assert.deepEqual(state.transport.orders, orders); assert.equal(transportSchema.safeParse(state.transport).success, true);
  assert.throws(() => applyTransportChange(state.transport, { type: 'book', id: 'AO-1043', plan: {
    date: '2026-10-15', startMinute: 900, durationMinutes: 60, driverId: 'kalle', vehicleId: old.id,
  } }, { canPlan: true, actor: 'Admin', actualUserId: 'admin', effectiveUserId: 'admin' }), /kärltyp/);
});

test('both actual and effective read/write rights apply, and site-scoped users cannot mutate the shared fleet', () => {
  const state = initialApplicationState(), worker = state.pricing.users.find(user => user.id === 'kajsa');
  worker.level = 'Medarbetare'; worker.permissions = ['personnelRead', 'personnelWrite']; delete worker.siteIds;
  assert.deepEqual(vehicleRegistryCapabilities(principal(state, 'admin', 'kajsa')), { vehicleRead: true, vehicleWrite: true });
  worker.siteIds = ['norrtalje']; assert.equal(vehicleRegistryProjection(state, principal(state, 'admin', 'kajsa')).capabilities.vehicleWrite, false);
  assert.throws(() => vehicleRegistryCommand(state, principal(state, 'admin', 'kajsa'), command()), /alla anläggningar/);
  delete worker.siteIds; worker.permissions = ['personnelRead'];
  assert.equal(vehicleRegistryCapabilities(principal(state, 'admin', 'kajsa')).vehicleWrite, false);
  assert.throws(() => vehicleRegistryCommand(state, principal(state, 'admin', 'kajsa'), command()), /Behörighet/);
  worker.permissions = [];
  assert.throws(() => vehicleRegistryProjection(state, principal(state, 'admin', 'kajsa')), /läsa fordon/);
  const low = { actor: { id: 'weak-actor', level: 'Medarbetare', permissions: [], active: true }, user: state.pricing.users.find(user => user.id === 'admin') };
  assert.equal(vehicleRegistryCapabilities(low).vehicleWrite, false);
  assert.throws(() => vehicleRegistryCommand(state, low, command()), /Behörighet/);
});

test('optimistic revisions and stable command IDs prevent duplicate creation, stale edits and changed retries', () => {
  const state = initialApplicationState(), p = principal(state), first = vehicleRegistryCommand(state, p, command());
  const saved = first.vehicles.find(vehicle => vehicle.id === first.savedVehicleId), eventCount = state.metadata.vehicleEvents.length;
  const replay = vehicleRegistryCommand(state, p, command());
  assert.equal(replay.savedVehicleId, saved.id); assert.equal(state.metadata.vehicleEvents.length, eventCount);
  assert.throws(() => vehicleRegistryCommand(state, p, command({ name: 'Bytt innehåll' })), /annan fordonsändring/);
  assert.throws(() => vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { ...command().vehicle, id: saved.id, revision: 0 } }), /har ändrats/);
  assert.throws(() => vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { ...command().vehicle, id: 'vehicle-does-not-exist', revision: 0 } }), /finns inte längre/);
  const count = state.transport.revision;
  vehicleRegistryCommand(state, p, { action: 'vehicle.save', vehicle: { ...command().vehicle, id: saved.id, revision: 1 } });
  assert.equal(state.transport.revision, count);
});

test('full transport snapshots cannot bypass registry permissions or use an inactive resource for a new plan', () => {
  const state = initialApplicationState(), base = state.transport, next = structuredClone(base);
  next.vehicles.find(vehicle => vehicle.id === 'vehicle-kalle').active = false;
  assert.throws(() => assertVehiclePlanningChange(base, next), /fordonsregistret/);
  const inactive = structuredClone(next), newlyBooked = structuredClone(inactive);
  Object.assign(newlyBooked.orders.find(order => order.id === 'AO-1043'), {
    status: 'booked', date: '2026-10-15', startMinute: 900, driverId: 'kalle', vehicleId: 'vehicle-kalle',
  });
  assert.throws(() => assertVehiclePlanningChange(inactive, newlyBooked), /inaktiverat/);
  const oldProgress = structuredClone(inactive); oldProgress.orders.find(order => order.id === 'AO-1042').status = 'on_way';
  assert.doesNotThrow(() => assertVehiclePlanningChange(inactive, oldProgress));
  const preliminary = structuredClone(inactive); preliminary.preliminary['AO-1043'] = {
    date: '2026-10-15', startMinute: 900, durationMinutes: 60, driverId: 'kalle', vehicleId: 'vehicle-kalle',
  };
  assert.throws(() => assertVehiclePlanningChange(inactive, preliminary), /inaktiverat/);
});

test('a whole booked series can move into its previous next occurrence without an intermediate false collision', () => {
  const state = initialApplicationState(), actor = { canPlan: true, actor: 'Admin', actualUserId: 'admin', effectiveUserId: 'admin' };
  const { id: _id, audit: _audit, updatedAt: _at, bookingVersion: _version, confirmation: _confirmation, ...draft } = state.transport.orders.find(order => order.id === 'AO-1043');
  const series = applyTransportChange(state.transport, { type: 'create', repeat: 'weekly', draft: {
    ...draft, status: 'booked', date: '2026-11-01', startMinute: 900, driverId: 'kalle', vehicleId: 'vehicle-kalle',
  } }, actor);
  const first = series.orders.find(order => order.seriesId);
  const moved = applyTransportChange(series, { type: 'edit', id: first.id, scope: 'series', patch: { date: '2026-11-08' } }, actor);
  assert.deepEqual(moved.orders.filter(order => order.seriesId === first.seriesId).map(order => order.date), ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
});

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-vehicle-registry-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') }, repositories = [], servers = [];
  const instance = async () => {
    const repository = await createApplicationRepository({ env, initial: initialApplicationState }); repositories.push(repository);
    const server = createServer((req, res) => void handlePersonnelVehiclesApi(req, res, new URL(req.url, 'http://localhost'), repository)); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (payload, { actor = 'admin', user = actor, path = '/api/personnel/vehicles', headers = {}, method } = {}) => {
      const response = await fetch(base + path, { method: method ?? (payload === undefined ? 'GET' : 'POST'), signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': user } : {}), ...headers },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      return { status: response.status, ...await response.json() };
    };
    return { repository, request };
  };
  try { await run({ ...await instance(), instance }); }
  finally { for (const server of servers) await new Promise(resolve => server.close(resolve)); for (const repository of repositories) await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('HTTP fleet persists across instances, safe retries and concurrent revisions use the same transactional registry', async () => fixture(async ({ request, instance }) => {
  const first = await request(command()); assert.equal(first.status, 200, first.error);
  const second = await instance(), restored = await second.request();
  assert.equal(restored.status, 200, restored.error); assert.deepEqual(restored.vehicles, first.vehicles);
  assert.equal((await second.request(command())).savedVehicleId, first.savedVehicleId);
  const saved = first.vehicles.find(vehicle => vehicle.id === first.savedVehicleId);
  const edits = await Promise.all([request({ action: 'vehicle.save', vehicle: { ...command().vehicle, id: saved.id, revision: 1, name: 'Första ändring' } }),
    second.request({ action: 'vehicle.save', vehicle: { ...command().vehicle, id: saved.id, revision: 1, name: 'Andra ändring' } })]);
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]);
  const final = await second.request(); assert.equal(final.vehicles.find(vehicle => vehicle.id === saved.id).revision, 2);
}));

test('HTTP fresh permission revocation, tenant selection injection and untrusted origins cannot mutate the fleet', async () => fixture(async ({ request, repository }) => {
  await repository.transact(state => Object.assign(state.pricing.users.find(user => user.id === 'kajsa'), { permissions: ['personnelRead', 'personnelWrite'], siteIds: undefined }));
  assert.equal((await request(undefined, { actor: 'admin', user: 'kajsa' })).status, 200);
  await repository.transact(state => { state.pricing.users.find(user => user.id === 'kajsa').permissions = []; });
  assert.equal((await request(undefined, { actor: 'admin', user: 'kajsa' })).status, 403);
  assert.equal((await request(command(), { actor: 'admin', user: 'kajsa' })).status, 403);
  assert.equal((await request(command(), { headers: { origin: 'https://another-tenant.example' } })).status, 403);
  assert.equal((await request(undefined, { path: '/api/personnel/vehicles?companyId=another-tenant' })).status, 422);
  assert.equal((await request(command(), { actor: null })).status, 401);
  assert.equal((await request(undefined, { method: 'DELETE' })).status, 405);
  const stored = await repository.read(state => state.metadata.vehicleEvents ?? []); assert.deepEqual(stored, []);
}));
