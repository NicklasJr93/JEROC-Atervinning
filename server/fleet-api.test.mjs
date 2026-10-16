import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationRepository } from './application-storage.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { employeeRequestPrincipal } from './mobile-employee-api.mjs';
import { ensureFleet } from './fleet.mjs';
import { applyFleetDeviceAssignment, ingestFleetTelemetry } from './fleet-telematics.mjs';
import { createFleetApi } from './fleet-api.mjs';

const org = 'fleet-http-company';
const hash = value => createHash('sha256').update(value).digest('hex');
const sites = [{ id: 'north', name: 'Norra', active: true }, { id: 'south', name: 'Södra', active: true }];
const user = (id, patch = {}) => ({ id, name: id, level: 'Medarbetare', active: true,
  permissions: ['fleetRead', 'fleetWrite', 'fleetExport'], maxAttest: 0, ownAttest: false, ...patch });
const trip = (id, patch = {}) => ({ id, vehicleId: 'vehicle-north', personId: 'person-one', driverSource: 'default',
  startAt: '2026-10-15T08:00:00.000Z', endAt: '2026-10-15T09:00:00.000Z', distanceKm: 10,
  startOdometerKm: 100, endOdometerKm: 110, source: 'simulator', quality: 'good', revision: 1, ...patch });
function seed() {
  const data = { metadata: { organisation: { id: org, name: 'Fleet HTTP Test AB' }, facilityAccess: { siteIds: ['north', 'south'] } },
    pricing: { users: [user('admin', { level: 'Systemadmin' }), user('north', { siteIds: ['north'] }),
      user('read-only', { permissions: ['fleetRead'] }), user('denied', { permissions: [] }),
      user('employee-one', { permissions: [], siteIds: ['north'] }), user('employee-two', { permissions: [], siteIds: ['south'] })] },
    personnel: { people: [{ id: 'person-one', userId: 'employee-one', driverId: 'driver-one', vehicleId: 'vehicle-north',
      name: 'Förare Ett', active: true, kind: 'employee', siteIds: ['north'], salary: 'PRIVATE-SALARY', phone: 'PRIVATE-PHONE' },
    { id: 'person-two', userId: 'employee-two', driverId: 'driver-two', vehicleId: 'vehicle-south',
      name: 'Förare Två', active: true, kind: 'employee', siteIds: ['south'], nationalId: 'PRIVATE-NATIONAL-ID' }] },
    personnelAuth: { accounts: ['one', 'two'].map(name => ({ personId: `person-${name}`, active: true, username: `driver-${name}` })),
      sessions: ['one', 'two'].map(name => ({ kind: 'employee', personId: `person-${name}`, tokenHash: hash(`cookie-${name}`),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() })), attempts: [] },
    transport: { revision: 0, vehicles: [{ id: 'vehicle-north', name: '=HYPERLINK("bad")', registration: 'ABC123', types: ['container'], active: true },
      { id: 'vehicle-south', name: 'Södra bilen', registration: 'DEF456', types: ['container'], active: true },
      { id: 'vehicle-unscoped', name: 'Okänd plats', registration: 'GHI789', types: ['bin'], active: true }],
    drivers: [], orders: [{ id: 'AO-own', customerName: 'Tillåtet uppdrag', driverId: 'driver-one', vehicleId: 'vehicle-north', siteId: 'north' },
      { id: 'AO-other', customerName: 'PRIVATE-OTHER-CUSTOMER', driverId: 'driver-two', vehicleId: 'vehicle-south', siteId: 'south' }] },
    office: { privateField: 'PRIVATE-BANK-CARD-PAYMENT' } };
  ensureFleet(data);
  data.fleet.profiles = { 'vehicle-north': { siteId: 'north', defaultDriverId: 'person-one', revision: 0 },
    'vehicle-south': { siteId: 'south', defaultDriverId: 'person-two', revision: 0 } };
  data.fleet.trips.push(trip('business', { classification: 'business', purpose: 'Leverans av material', fromLabel: 'Tillåten start', toLabel: 'Tillåtet mål', workOrderId: 'AO-own' }),
    trip('private', { classification: 'private', startAt: '2026-10-15T10:00:00.000Z', endAt: '2026-10-15T11:00:00.000Z',
      fromLabel: 'PRIVATE-ROUTE-HOME', toLabel: 'PRIVATE-ROUTE-DOCTOR', positions: [{ at: '2026-10-15T10:30:00.000Z', lat: 61.123, lng: 19.456 }], purpose: 'PRIVATE-PURPOSE' }),
    trip('pending', { startAt: '2026-10-14T08:00:00.000Z', endAt: '2026-10-14T09:00:00.000Z' }),
    trip('south', { vehicleId: 'vehicle-south', personId: 'person-two', classification: 'private', fromLabel: 'PRIVATE-FOREIGN-ROUTE' }));
  return data;
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-fleet-api-'));
  const repository = await createApplicationRepository({ filename: join(directory, 'application.sqlite'), seed });
  const officePrincipal = (state, req) => {
    if (req.headers['x-throw-private']) throw new Error('PRIVATE-INTERNAL-CREDENTIAL');
    const match = /(?:^|;\s*)office=([a-z-]+)(?:\|([a-z-]+))?(?:;|$)/.exec(req.headers.cookie ?? '');
    if (!match) return undefined;
    return resolvePricingPrincipal(state.pricing.users, match[1], match[2] ?? match[1]);
  };
  const api = createFleetApi({ getRepository: async () => repository, officePrincipal,
    ownPrincipal: employeeRequestPrincipal, siteProvider: async () => sites, env: { SCRAPPILOT_ORGANISATION_ID: org } });
  const server = createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end('outer-route'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { value, raw, method = value === undefined && raw === undefined ? 'GET' : 'POST', headers = {}, cookie = 'office=admin' } = {}) => {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(value !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(value !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(value) } : {}) });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString('utf8');
    return { response, status: response.status, bytes, text, body: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : undefined };
  };
  try { await run({ repository, request, origin }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('fleet HTTP reads enforce both principals and site scope, are immutable, and return only privacy-safe domain projections', async () => fixture(async ({ request, repository }) => {
  const before = await repository.read((state, revision) => ({ state, revision }));
  const result = await request('/api/fleet', { cookie: 'office=admin|north' });
  assert.equal(result.status, 200); assert.deepEqual(result.body.vehicles.map(value => value.id), ['vehicle-north']);
  assert.deepEqual(result.body.sites.map(value => value.id), ['north']); assert.equal(result.body.trips.some(value => value.id === 'south'), false);
  for (const value of ['PRIVATE-SALARY', 'PRIVATE-PHONE', 'PRIVATE-NATIONAL-ID', 'PRIVATE-BANK-CARD-PAYMENT',
    'PRIVATE-ROUTE-HOME', 'PRIVATE-ROUTE-DOCTOR', 'PRIVATE-PURPOSE', 'PRIVATE-OTHER-CUSTOMER', '61.123']) assert.equal(result.text.includes(value), false);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.body.telematics.devices.length, 0); assert.equal(typeof result.body.serverNow, 'string');
  assert.deepEqual(await repository.read((state, revision) => ({ state, revision })), before);
  assert.equal((await request('/api/fleet', { cookie: 'office=denied|admin' })).status, 403);
  assert.equal((await request('/api/fleet', { cookie: '', headers: { 'X-Demo-Actor': 'admin' } })).status, 401);
  const head = await request('/api/fleet', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
}));

test('employee fleet requires a real active employee cookie and binds expected person/company without any demo fallback', async () => fixture(async ({ request, repository }) => {
  const path = '/api/employee/fleet';
  assert.equal((await request(path, { cookie: 'office=admin', headers: { 'X-Demo-Actor': 'employee-one' } })).status, 401);
  assert.equal((await request(path, { cookie: 'jeroc_employee=expired', headers: { 'X-Demo-Actor': 'admin' } })).status, 401);
  const own = await request(path, { cookie: 'jeroc_employee=cookie-one', headers: { 'X-Employee-Person': 'person-one', 'X-Employee-Company': org } });
  assert.equal(own.status, 200); assert.equal(own.body.personId, 'person-one');
  assert.deepEqual(own.body.trips.map(value => value.id).sort(), ['business', 'pending', 'private']);
  assert.equal(own.text.includes('PRIVATE-ROUTE-HOME'), true); assert.equal(own.text.includes('PRIVATE-FOREIGN-ROUTE'), false);
  assert.equal(own.body.gate.count, 1); assert.equal(own.body.capabilities.export, false); assert.deepEqual(own.body.sites.map(value => value.id), ['north']);
  for (const headers of [{ 'X-Employee-Person': 'person-two' }, { 'X-Employee-Company': 'different-company' }])
    assert.equal((await request(path, { cookie: 'jeroc_employee=cookie-one', headers })).status, 409);
  for (const query of ['personId=person-two', 'vehicleId=vehicle-south', 'organisationId=foreign'])
    assert.equal((await request(`${path}?${query}`, { cookie: 'jeroc_employee=cookie-one' })).status, 422);
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'employee-one').active = false; });
  assert.equal((await request(path, { cookie: 'jeroc_employee=cookie-one' })).status, 401);
}));

test('fleet filters validate real dates/enums/pagination and apply before pagination without private search side channels', async () => fixture(async ({ request }) => {
  const result = await request('/api/fleet?from=2026-10-14&to=2026-10-15&vehicleId=vehicle-north&personId=person-one&classification=private&status=complete&offset=0&limit=1');
  assert.equal(result.status, 200); assert.equal(result.body.tripCount, 1); assert.equal(result.body.trips[0].id, 'private');
  assert.equal((await request('/api/fleet?search=PRIVATE-ROUTE-HOME')).body.tripCount, 0);
  assert.equal((await request('/api/employee/fleet?search=PRIVATE-ROUTE-HOME', { cookie: 'jeroc_employee=cookie-one' })).body.tripCount, 1);
  for (const query of ['from=2026-02-31', 'from=bad', 'from=2026-10-16&to=2026-10-15', 'limit=0', 'limit=1001',
    'offset=-1', 'offset=1e2', 'offset=1000001', 'classification=pretend', 'status=deleted', 'tenantId=foreign',
    'from=2026-10-15&from=2026-10-15', 'search=' + 'x'.repeat(201)])
    assert.equal((await request('/api/fleet?' + query)).status, 422, query);
}));

test('same-origin/method/content guards run before any mutation and the separate files API is not intercepted', async () => fixture(async ({ request, repository }) => {
  const before = await repository.read((state, revision) => ({ state, revision }));
  const value = { action: 'profile.save', vehicleId: 'vehicle-north', profile: { notes: 'Should not persist' }, expectedRevision: 0, requestId: randomUUID() };
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'not-an-origin' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await request('/api/fleet/actions', { value, headers })).status, 403);
  assert.equal((await request('/api/fleet/actions', { method: 'GET' })).status, 405);
  assert.equal((await request('/api/fleet', { method: 'POST', value })).status, 405);
  assert.equal((await request('/api/fleet/actions', { value, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('/api/fleet/actions', { value, headers: { 'Content-Type': 'application/jsonp' } })).status, 415);
  assert.equal((await request('/api/fleet/actions', { raw: '{' })).status, 422);
  assert.equal((await request('/api/fleet/actions', { raw: '[]' })).status, 422);
  assert.equal((await request('/api/fleet/actions', { raw: 'x'.repeat(128 * 1024 + 1) })).status, 413);
  assert.equal((await request('/api/fleet/actions?vehicleId=vehicle-north', { value })).status, 422);
  assert.equal((await request('/api/fleet/files')).text, 'outer-route');
  assert.equal((await request('/api/employee/fleet/files')).text, 'outer-route');
  assert.deepEqual(await repository.read((state, revision) => ({ state, revision })), before);
}));

test('office and employee mutations return fresh full snapshots with CAS/idempotency and own-only driver/trip actions', async () => fixture(async ({ request, repository }) => {
  const profile = { action: 'profile.save', vehicleId: 'vehicle-north', profile: { siteId: 'north', defaultDriverId: 'person-one', notes: 'New safe instructions' }, expectedRevision: 0, requestId: 'profile-save' };
  const saved = await request('/api/fleet/actions', { value: profile }); assert.equal(saved.status, 200);
  assert.equal(saved.body.profiles['vehicle-north'].notes, 'New safe instructions'); assert.ok(saved.body.telematics); assert.equal(saved.body.vehicles.length, 3);
  assert.equal((await request('/api/fleet/actions', { value: profile })).body.replayed, true);
  const before = await repository.read(state => structuredClone(state));
  assert.equal((await request('/api/fleet/actions', { value: { ...profile, requestId: 'stale', profile: { notes: 'Stale' } } })).status, 409);
  assert.equal((await request('/api/fleet/actions', { value: { ...profile, organisationId: 'foreign' } })).status, 422);
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  const view = (await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-one' })).body;
  const complete = { action: 'trip.complete', requestId: 'complete-own', expectedRevision: view.revision,
    tripId: 'pending', expectedTripRevision: 1, classification: 'private' };
  const own = await request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=cookie-one', value: complete, headers: { 'X-Employee-Person': 'person-one' } });
  assert.equal(own.status, 200); assert.equal(own.body.gate.count, 0); assert.equal(own.body.trips.find(value => value.id === 'pending').classification, 'private');
  assert.ok(own.body.telematics); assert.equal(own.body.trips.some(value => value.id === 'south'), false);
  assert.equal((await request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=cookie-one', value: complete })).body.replayed, true);
  for (const value of [{ action: 'driver.select', vehicleId: 'vehicle-north', personId: 'person-two' },
    { action: 'profile.save', vehicleId: 'vehicle-north', profile: { siteId: 'south' } },
    { action: 'trip.complete', tripId: 'south', expectedTripRevision: 1, classification: 'private' }]) {
    const current = (await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-one' })).body;
    assert.equal((await request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=cookie-one',
      value: { ...value, requestId: randomUUID(), expectedRevision: current.revision } })).status, 403);
  }
}));

test('device commands use the same tenant transaction and return merged safe telematics instead of raw telemetry or foreign devices', async () => fixture(async ({ request, repository }) => {
  const now = Date.now(), assignedAt = new Date(now - 2 * 60_000).toISOString(), offAt = new Date(now - 60_000).toISOString();
  await repository.transact(state => {
    applyFleetDeviceAssignment(state, { id: 'assigned-one', name: 'Testpuck', organisationId: org, source: 'simulator', active: true }, { organisationId: org, now: assignedAt });
    ingestFleetTelemetry(state, { deviceId: 'assigned-one', source: 'simulator', records: [{ id: 'off', at: offAt, ignition: false, odometerMeters: 99999999 }] }, { organisationId: org, now: offAt });
  });
  const before = (await request('/api/fleet')).body, device = before.telematics.devices[0];
  const value = { action: 'device.link', deviceId: device.id, vehicleId: 'vehicle-north', expectedRevision: device.revision, requestId: 'link-via-http' };
  const result = await request('/api/fleet/actions', { value });
  assert.equal(result.status, 200); assert.equal(result.body.savedDeviceId, device.id); assert.equal(result.body.telematics.devices[0].vehicleId, 'vehicle-north');
  assert.equal(result.body.vehicles.length, 3); assert.equal(result.text.includes('99999999'), false); assert.equal(result.text.includes('telemetryEvents'), false);
  const replay = await request('/api/fleet/actions', { value }); assert.equal(replay.status, 200); assert.equal(replay.body.telematics.bindings.length, 1);
  const employee = await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-one' });
  assert.equal(employee.body.telematics.devices[0].id, device.id); assert.equal(employee.body.telematics.bindings, undefined);
  const other = await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-two' }); assert.deepEqual(other.body.telematics.devices, []);
}));

test('CSV/PDF exports require separate export rights, preserve private-route masking and export matching full selection rather than a UI page', async () => fixture(async ({ request }) => {
  assert.equal((await request('/api/fleet/export?format=csv', { cookie: 'office=read-only' })).status, 403);
  const csv = await request('/api/fleet/export?format=csv&vehicleId=vehicle-north&limit=1&offset=1');
  assert.equal(csv.status, 200); assert.match(csv.response.headers.get('content-type'), /text\/csv/); assert.match(csv.response.headers.get('content-disposition'), /korjournal.csv/);
  assert.equal(csv.response.headers.get('cache-control'), 'private, no-store'); assert.ok(csv.text.includes("'=HYPERLINK"));
  for (const secret of ['PRIVATE-ROUTE-HOME', 'PRIVATE-ROUTE-DOCTOR', 'PRIVATE-PURPOSE', 'PRIVATE-FOREIGN-ROUTE', 'PRIVATE-NATIONAL-ID']) assert.equal(csv.text.includes(secret), false);
  assert.ok(csv.text.includes('"Antal resor";"3"')); // Pagination never silently limits an export to one UI row.
  assert.equal(csv.text.includes('Tillåten start'), true); assert.equal(csv.text.includes('Utkast'), true); assert.equal(csv.text.includes('Simulerad'), true);
  const scoped = await request('/api/fleet/export?format=csv', { cookie: 'office=admin|north' }); assert.equal(scoped.status, 200); assert.equal(scoped.text.includes('DEF456'), false);
  const filtered = await request('/api/fleet/export?format=csv&classification=unclassified&status=incomplete'); assert.equal(filtered.status, 200); assert.equal(filtered.text.includes('Tillåten start'), false);
  const pdf = await request('/api/fleet/export?format=pdf&vehicleId=vehicle-north&from=2026-10-15&to=2026-10-15');
  assert.equal(pdf.status, 200); assert.match(pdf.response.headers.get('content-type'), /application\/pdf/); assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await request('/api/fleet/export?format=html')).status, 422);
}));

test('export refuses a truncated selection, and unexpected internal failures expose neither credentials nor raw exception fields', async () => fixture(async ({ request, repository }) => {
  await repository.transact(state => { state.fleet.trips = Array.from({ length: 1001 }, (_, index) => trip(`trip-${index}`, { classification: 'private' })); });
  const rejected = await request('/api/fleet/export?format=csv'); assert.equal(rejected.status, 422); assert.equal(rejected.body.code, 'fleet_export_limit');
  const unexpected = await request('/api/fleet', { headers: { 'X-Throw-Private': 'yes' } });
  assert.equal(unexpected.status, 503); assert.equal(unexpected.body.code, 'fleet_unavailable'); assert.equal(unexpected.text.includes('PRIVATE-INTERNAL-CREDENTIAL'), false);
}));

test('own active-trip and completion denials return only that employees canonical fleet gate', async () => fixture(async ({ request, repository }) => {
  let overview = (await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-one' })).body;
  const choose = revision => ({ action: 'driver.select', vehicleId: 'vehicle-north', personId: 'person-one',
    expectedRevision: revision, requestId: randomUUID() });
  const pending = await request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=cookie-one', value: choose(overview.revision) });
  assert.equal(pending.status, 423); assert.equal(pending.body.code, 'fleet_trip_completion_required');
  assert.equal(pending.body.fleetGate.count, 1); assert.equal(pending.text.includes('PRIVATE-FOREIGN-ROUTE'), false);
  await repository.transact(state => { state.fleet.trips.push(trip('own-active', { endAt: undefined })); });
  overview = (await request('/api/employee/fleet', { cookie: 'jeroc_employee=cookie-one' })).body;
  const active = await request('/api/employee/fleet/actions', { cookie: 'jeroc_employee=cookie-one', value: choose(overview.revision) });
  assert.equal(active.status, 409); assert.equal(active.body.code, 'fleet_trip_active'); assert.equal(active.body.fleetGate.safeToInteract, false);
}));

test('protected file references require vehicle write scope before receipt lookup and cannot cross vehicle boundaries', async () => fixture(async ({ request, repository }) => {
  const fileId = randomUUID();
  await repository.transact(state => { state.fleet.fileReceipts = [{ fileId, vehicleId: 'vehicle-north', kind: 'photo' }]; });
  const input = { action: 'profile.save', vehicleId: 'vehicle-north', profile: { photoUrl: `/api/fleet/files/${fileId}` }, expectedRevision: 0, requestId: randomUUID() };
  for (const photoUrl of [`/api/fleet/files/${fileId}`, `/api/fleet/files/${randomUUID()}`])
    assert.equal((await request('/api/fleet/actions', { cookie: 'office=read-only', value: { ...input, profile: { photoUrl } } })).status, 403);
  assert.equal((await request('/api/fleet/actions', { cookie: 'office=admin|north', value: { ...input, vehicleId: 'vehicle-south' } })).status, 403);
  const before = await repository.read(state => structuredClone(state));
  assert.equal((await request('/api/fleet/actions', { value: { ...input, vehicleId: 'vehicle-south' } })).status, 404);
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  assert.equal((await request('/api/fleet/actions', { value: input })).status, 200);
  assert.equal((await repository.read(state => state.fleet.profiles['vehicle-north'].photoUrl)), `/api/fleet/files/${fileId}`);
}));
