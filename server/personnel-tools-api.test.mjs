import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';

const equipment = '/api/application/equipment';
const settings = '/api/application/personnel-time';
const personId = 'person-mobile-demo';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** A real SQLite aggregate and two independently opened application instances
 * exercise HTTP authentication, projection boundaries and durable transactions. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-personnel-tools-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  const apps = [], servers = [], repositories = [];
  const instance = async () => {
    const app = createApplicationService({ env }); apps.push(app);
    const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost'))); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (path, data, { actor = 'admin', effective = actor, cookie, headers = {} } = {}) => {
      const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': effective } : {}),
          ...(cookie ? { cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
    };
  };
  const repository = async () => {
    const value = await createApplicationRepository({ env, initial: initialApplicationState }); repositories.push(value); return value;
  };
  try { await run({ request: await instance(), instance, repository }); }
  finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const app of apps) await app.close();
    for (const value of repositories) await value.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const assertOk = value => { assert.equal(value.status, 200, value.error); return value; };
const register = async (request, extra = {}) => assertOk(await request(equipment, { action: 'item.save', item: {
  inventoryNumber: 'API-001', name: 'Telefon för API-test', category: 'phone', siteId: 'norrtalje', serialNumber: 'PRIVATE-SERIAL-API-001', ...extra,
} })).data.items.find(item => item.inventoryNumber === (extra.inventoryNumber ?? 'API-001'));
const login = async request => assertOk(await request('/api/employee/login', { username: 'niklas', password: 'Demo123!' }, { actor: null }));
const ownRequest = (request, cookie) => (path, data, headers = {}) => request(`/api/employee/${path}`, data, { actor: null, cookie, headers });

test('equipment HTTP workflow persists across instances and rejects competing issue and return', async () => fixture(async ({ request, instance, repository }) => {
  const first = assertOk(await request(equipment)); assert.deepEqual(first.data.items, []);
  const item = await register(request);
  const issueCommand = { action: 'item.issue', id: item.id, revision: 1, personId, note: 'Privat lånenot API-001', requestId: 'api-loan-1' };
  const issued = assertOk(await request(equipment, issueCommand));
  assert.equal(issued.data.items[0].status, 'issued'); assert.equal(issued.data.assignments.length, 1);
  const second = await instance(), reopened = assertOk(await second(equipment));
  assert.deepEqual(reopened.data, issued.data);
  assert.deepEqual(assertOk(await second(equipment, issueCommand)).data, issued.data);
  assert.equal((await second(equipment, { action: 'item.issue', id: item.id, revision: 1, personId: 'person-anna' })).status, 409);
  const returned = assertOk(await second(equipment, { action: 'item.return', id: item.id, revision: 2, condition: 'maintenance', note: 'Skadad laddkontakt' }));
  assert.equal(returned.data.items[0].status, 'maintenance');
  assert.equal(returned.data.assignments[0].returnNote, 'Skadad laddkontakt');
  assert.equal(returned.data.assignments[0].issuedActualUserId, 'admin');
  assert.ok(returned.data.assignments[0].returnedAt);
  assert.equal((await request(equipment, { action: 'item.return', id: item.id, revision: 3 })).status, 409);
  const persisted = await (await repository()).read(state => structuredClone(state.equipment));
  assert.equal(persisted.assignments.length, 1); assert.equal(persisted.items[0].revision, 3);
  assert.equal(persisted.events.length, 3);
}));

test('employee cookie reads only own equipment and own historical loans, with no forged person selection or demo fallback', async () => fixture(async ({ request }) => {
  const employee = await login(request), own = ownRequest(request, employee.cookie);
  const item = await register(request), otherItem = await register(request, { inventoryNumber: 'API-002', serialNumber: 'OTHER-PERSON-PRIVATE-SERIAL' });
  assertOk(await request(equipment, { action: 'item.issue', id: item.id, revision: 1, personId, note: 'Min laddare' }));
  assertOk(await request(equipment, { action: 'item.issue', id: otherItem.id, revision: 1, personId: 'person-anna', note: 'Andras privata not' }));
  const view = assertOk(await own('equipment'));
  assert.deepEqual(view.items.map(value => value.id), [item.id]);
  assert.ok(view.assignments.every(value => value.personId === personId));
  assert.equal(JSON.stringify(view).includes('OTHER-PERSON-PRIVATE-SERIAL'), false);
  assert.equal(JSON.stringify(view).includes('Andras privata not'), false);
  assert.equal((await own('equipment?personId=person-anna')).status, 422);
  assert.equal((await own('equipment', undefined, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/employee/equipment', undefined, { cookie: 'jeroc_employee=invalid' })).status, 401);
  assert.equal((await request('/api/employee/equipment')).status, 401);
  assertOk(await request(equipment, { action: 'item.return', id: item.id, revision: 2 }));
  assertOk(await request(equipment, { action: 'item.issue', id: item.id, revision: 3, personId: 'person-anna', note: 'Ny mottagares privata not' }));
  const history = assertOk(await own('equipment'));
  assert.deepEqual(history.items, []); assert.equal(history.assignments.length, 1); assert.equal(history.events.length, 2);
  assert.equal(history.assignments[0].issuedBy, undefined);
  assert.equal(JSON.stringify(history).includes('Ny mottagares privata not'), false);
  assert.equal(JSON.stringify(history).includes('person-anna'), false);
}));

test('general office, mobile and personnel planning projections never include equipment notes, serials or loan domain', async () => fixture(async ({ request }) => {
  const employee = await login(request), item = await register(request);
  assertOk(await request(equipment, { action: 'item.issue', id: item.id, revision: 1, personId, note: 'PRIVATE-EQUIPMENT-LOAN-NOTE' }));
  for (const path of ['/api/application/office', '/api/application/mobile', '/api/application/personnel', '/api/application/personnel?view=planning', '/api/employee/session']) {
    const projection = assertOk(await request(path, undefined, path.startsWith('/api/employee/') ? { actor: null, cookie: employee.cookie } : {}));
    assert.equal(projection.equipment, undefined, path); assert.equal(projection.data?.equipment, undefined, path);
    assert.equal(JSON.stringify(projection).includes('PRIVATE-SERIAL-API-001'), false, path);
    assert.equal(JSON.stringify(projection).includes('PRIVATE-EQUIPMENT-LOAN-NOTE'), false, path);
  }
}));

test('equipment endpoints reload dual permissions and site scopes after access revocation', async () => fixture(async ({ request, repository }) => {
  const item = await register(request), repo = await repository();
  await repo.transact(state => {
    const user = state.pricing.users.find(value => value.id === 'kajsa');
    Object.assign(user, { permissions: ['view', 'equipmentRead', 'equipmentWrite'], siteIds: ['norrtalje'] });
  });
  assert.equal(assertOk(await request(equipment, undefined, { actor: 'kajsa' })).data.items.length, 1);
  await repo.transact(state => { state.pricing.users.find(value => value.id === 'kajsa').permissions = ['view']; });
  assert.equal((await request(equipment, undefined, { actor: 'admin', effective: 'kajsa' })).status, 403);
  assert.equal((await request(equipment, undefined, { actor: 'kajsa', effective: 'admin' })).status, 403);
  assert.equal((await request(equipment, { action: 'item.issue', id: item.id, revision: 1, personId }, { actor: 'kajsa' })).status, 403);
  await repo.transact(state => Object.assign(state.pricing.users.find(value => value.id === 'kajsa'), {
    permissions: ['view', 'equipmentRead', 'equipmentWrite'], siteIds: ['rimbo'],
  }));
  assert.deepEqual(assertOk(await request(equipment, undefined, { actor: 'admin', effective: 'kajsa' })).data.items, []);
  assert.equal((await request(equipment + '?siteId=norrtalje', undefined, { actor: 'kajsa' })).status, 403);
  const employee = await login(request), own = ownRequest(request, employee.cookie);
  assertOk(await request(equipment, { action: 'item.issue', id: item.id, revision: 1, personId }));
  assert.equal(assertOk(await own('equipment')).items.length, 1);
  await repo.transact(state => { state.pricing.users.find(value => value.id === 'mobile-demo').siteIds = ['rimbo']; });
  assert.deepEqual(assertOk(await own('equipment')).items, []);
  assert.deepEqual(assertOk(await own('equipment')).assignments, []);
}));

test('office time settings use explicit employment rights, full person site scope and optimistic revisions', async () => fixture(async ({ request, repository }) => {
  const repo = await repository();
  await request('/api/application/personnel');
  await repo.transact(state => { Object.assign(state.pricing.users.find(value => value.id === 'kajsa'), { permissions: ['view'], siteIds: ['norrtalje'] }); });
  const path = `${settings}?personId=${personId}`;
  assert.equal((await request(path, undefined, { actor: 'kajsa' })).status, 403);
  await repo.transact(state => { state.pricing.users.find(value => value.id === 'kajsa').permissions.push('employmentRead'); });
  const current = assertOk(await request(path, undefined, { actor: 'kajsa' }));
  assert.equal(current.capabilities.manageTimeSettings, false);
  const payload = { action: 'requirement.save', personId, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 360,
    weekdays: [1, 2, 3, 4, 5], effectiveFrom: today(), timeSource: 'clock', revision: current.requirement.revision } };
  assert.equal((await request(path, payload, { actor: 'kajsa' })).status, 403);
  const saved = assertOk(await request(path, payload));
  assert.equal(saved.requirement.timeSource, 'clock'); assert.equal(saved.requirement.dailyMinutes, 360);
  assert.equal(saved.clock.enabled, true);
  await repo.transact(state => {
    const person = state.personnel.people.find(value => value.id === personId);
    person.driverId = 'kalle'; person.canDrive = true;
    const order = state.transport.orders.find(value => value.id === 'AO-1201');
    order.customerName = 'PRIVATE-CUSTOMER-TIME'; order.notes = 'PRIVATE-WORK-INSTRUCTIONS';
    state.employeeTime.orderSessions.push({ id: 'private-order-time', personId, orderId: order.id, siteId: 'norrtalje',
      startedAt: new Date(Date.now() - 120000).toISOString(), endedAt: new Date(Date.now() - 60000).toISOString(), revision: 1, breakMinutes: 0 });
    state.personnel.absences.push({ id: 'medical-absence', personId, kind: 'sick', fromDate: today(), toDate: today(),
      allDay: true, status: 'registered', createdBy: 'PRIVATE-MEDICAL-ACTOR', revision: 1 });
    state.employeeTime.leaveRequests.push({ id: 'private-request', personId, kind: 'vab', fromDate: today(), toDate: today(),
      allDay: true, status: 'pending', note: 'PRIVATE-LEAVE-NOTE', revision: 1 });
  });
  const hr = assertOk(await request(path, undefined, { actor: 'kajsa' }));
  assert.deepEqual(hr.orders, []); assert.deepEqual(hr.selectedDay.orders, []); assert.deepEqual(hr.leaveRequests, []);
  assert.equal(hr.activeWork, null);
  assert.ok(hr.selectedDay.absences.some(value => value.id === 'medical-absence'));
  assert.ok(hr.selectedDay.absences.every(value => value.kind === undefined && value.createdBy === undefined));
  assert.ok(hr.selectedDay.entries.every(value => value.orderId === undefined && value.orderName === undefined));
  for (const secret of ['PRIVATE-CUSTOMER-TIME', 'PRIVATE-WORK-INSTRUCTIONS', 'PRIVATE-MEDICAL-ACTOR', 'PRIVATE-LEAVE-NOTE'])
    assert.equal(JSON.stringify(hr).includes(secret), false);
  assert.equal((await request(path, payload)).status, 409);
  assert.equal((await request(path, { ...payload, personId: 'person-anna' })).status, 409);
  await repo.transact(state => { state.personnel.people.find(value => value.id === personId).siteIds.push('rimbo'); });
  assert.equal((await request(path, undefined, { actor: 'kajsa' })).status, 403);
  assert.equal((await request(`${settings}?personId=person-oskar`)).status, 404);
}));

test('employee clock lifecycle and identical retries produce one durable session and one break', async () => fixture(async ({ request, instance, repository }) => {
  const employee = await login(request), own = ownRequest(request, employee.cookie);
  assert.equal(employee.clock.enabled, false);
  assert.equal((await own('clock', { action: 'clock.in', revision: 0, requestId: 'clock-disabled' })).status, 409);
  const current = assertOk(await request(`${settings}?personId=${personId}`));
  assertOk(await request(settings, { action: 'requirement.save', personId, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: current.requirement.revision } }));
  const fresh = assertOk(await own('session'));
  const clockIn = { action: 'clock.in', revision: fresh.clock.revision, requestId: 'clock-in-api-1' };
  const working = assertOk(await own('clock', clockIn)); assert.equal(working.clock.status, 'working');
  const retry = assertOk(await own('clock', clockIn)); assert.equal(retry.clock.activeSession.id, working.clock.activeSession.id);
  assert.equal((await own('clock', { ...clockIn, requestId: 'clock-in-api-2' })).status, 409);
  assert.equal((await own('clock', { ...clockIn, personId: 'person-anna' })).status, 422);
  const paused = assertOk(await own('clock', { action: 'clock.pause', revision: working.clock.revision, sessionId: working.clock.activeSession.id, requestId: 'clock-pause-api-1' }));
  assert.equal(paused.clock.status, 'break');
  const resumed = assertOk(await own('clock', { action: 'clock.resume', revision: paused.clock.revision, sessionId: paused.clock.activeSession.id, requestId: 'clock-resume-api-1' }));
  assert.equal(resumed.clock.status, 'working');
  const out = { action: 'clock.out', revision: resumed.clock.revision, sessionId: resumed.clock.activeSession.id, requestId: 'clock-out-api-1' };
  const stopped = assertOk(await own('clock', out)); assert.equal(stopped.clock.activeSession, null);
  assertOk(await own('clock', out));
  const otherInstance = await instance(), onOtherInstance = assertOk(await otherInstance('/api/employee/session', undefined, { actor: null, cookie: employee.cookie }));
  assert.equal(onOtherInstance.clock.activeSession, null); assert.equal(onOtherInstance.clock.revision, stopped.clock.revision);
  const stored = await (await repository()).read(state => structuredClone(state.employeeTime));
  assert.equal(stored.clockSessions.filter(value => value.personId === personId).length, 1);
  const session = stored.clockSessions.find(value => value.personId === personId);
  assert.equal(session.breaks.length, 1); assert.ok(session.breaks[0].endedAt); assert.ok(session.endedAt);
}));
