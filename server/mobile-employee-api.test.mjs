import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createMobileEmployeeApi, ensureMobileEmployeeAccounts, employeeRequestPrincipal, hasEmployeeSession } from './mobile-employee-api.mjs';

const password = value => { const salt = randomBytes(24).toString('hex'); return { salt, digest: scryptSync(value, salt, 64).toString('hex') }; };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-employee-api-'));
  let env = { JEROC_APPLICATION_DB_PATH: join(directory, 'business.sqlite') }, pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `jeroc_employee_api_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.JEROC_TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    env = { DATABASE_URL: connection.toString() };
  }
  const repositories = [];
  const openRepository = async () => {
    const value = await createApplicationRepository({ env, initial: initialApplicationState });
    repositories.push(value); return value;
  };
  const repository = await openRepository();
  const siteCatalog = structuredClone(sites);
  let now = new Date('2026-10-12T06:00:00Z');
  await repository.transact(state => {
    ensureMobileEmployeeAccounts(state);
    for (const name of ['alice', 'bob']) {
      const userId = `test-${name}`, personId = `person-test-${name}`;
      state.pricing.users.push({ id: userId, name, level: 'Medarbetare', permissions: ['view', 'prepare', 'customers'], siteIds: ['norrtalje'], active: true, maxAttest: 0, ownAttest: false });
      state.personnel.people.push({ id: personId, userId, name, kind: 'employee', active: true, role: 'Invägare', team: 'Gårdsplan', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: false, revision: 0 });
      state.personnel.employment.push({ personId, form: 'permanent', startDate: '2026-01-01', percentage: 100, hoursPerWeek: 40, revision: 0 });
      state.personnel.schedules.push({ id: `schedule-${personId}`, personId, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2026-01-01', revision: 0 });
      state.personnelAuth.accounts.push({ personId, username: name, active: true, createdAt: now.toISOString(), updatedAt: now.toISOString(), password: password('Test-Password-2026!') });
    }
  });
  const api = createMobileEmployeeApi({ getRepository: async () => repository, now: () => now, siteProvider: async () => siteCatalog, env,
    readBody: async req => { const chunks = []; for await (const value of req) chunks.push(value); return JSON.parse(Buffer.concat(chunks).toString()); },
    json: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data, cookie, headers = {}) => {
    const response = await fetch(`${base}/api/employee/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers, ...await response.json() };
  };
  const login = async (username = 'alice', secret = 'Test-Password-2026!') => { const value = await request('login', { username, password: secret }); assert.equal(value.status, 200, value.error); return value; };
  try { await run({ repository, openRepository, request, login, now: () => now, clock: value => { now = new Date(value); }, base, env, siteCatalog }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    for (const value of repositories) await value.close();
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('employee authentication supports a non-driver, protects origin and has no demo-header downgrade', async () => fixture(async ({ request, login, repository, base, now }) => {
  const result = await login(); assert.equal(result.person.id, 'person-test-alice'); assert.equal(result.capabilities.yardWork, true);
  assert.equal(result.capabilities.assignedOrders, false); assert.ok(result.headers.get('set-cookie').includes('HttpOnly; Path=/api; SameSite=Strict'));
  assert.equal((await request('session')).status, 401);
  assert.equal((await request('session', undefined, 'jeroc_employee=invalid', { 'x-demo-mobile': 'niklas', 'x-demo-actor': 'admin' })).status, 401);
  assert.equal((await request('profile', { phone: '123', email: '' }, result.cookie, { origin: 'https://other.example' })).status, 403);
  const updated = await request('profile', { phone: '0722002220', email: '' }, result.cookie, { origin: base });
  assert.equal(updated.status, 200); assert.equal(updated.person.phone, '+46722002220');
  assert.equal((await request('profile', { phone: '123', email: '' }, result.cookie, { origin: base })).status, 422);
  assert.equal(hasEmployeeSession({ headers: { cookie: result.cookie } }), true);
  await repository.read(state => { assert.equal(employeeRequestPrincipal(state, { headers: { cookie: result.cookie } }, { now }).user.id, 'test-alice');
    assert.throws(() => employeeRequestPrincipal(state, { headers: { cookie: 'jeroc_employee=invalid', 'x-demo-actor': 'admin' } }, { now }), error => error.status === 401); });
}));

test('payment-profile capability follows current employee permission and does not follow customer editing alone', async () => fixture(async ({ request, login, repository }) => {
  const employee = await login();
  assert.equal(employee.capabilities.paymentDetails, false);
  await repository.transact(state => state.pricing.users.find(user => user.id === 'test-alice').permissions.push('paymentDetails'));
  assert.equal((await request('session', undefined, employee.cookie)).capabilities.paymentDetails, true);
  await repository.transact(state => { state.pricing.users.find(user => user.id === 'test-alice').permissions = ['view', 'prepare', 'customers']; });
  assert.equal((await request('session', undefined, employee.cookie)).capabilities.paymentDetails, false);
}));

test('active facility persists per tenant and person, rejects forged choices and remains available through the time gate', async () => fixture(async ({ request, login, repository, openRepository, clock, base, env }) => {
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'test-alice'); person.siteIds = ['norrtalje', 'rimbo'];
    state.pricing.users.find(value => value.id === person.userId).siteIds = [...person.siteIds];
  });
  const alice = await login(); assert.equal(alice.activeSiteId, 'norrtalje');
  assert.equal((await request('active-site', { siteId: 'rimbo' })).status, 401);
  assert.equal((await request('active-site', { siteId: 'rimbo' }, 'jeroc_employee=invalid')).status, 401);
  assert.equal((await request('active-site', { siteId: 'rimbo' }, alice.cookie, { origin: 'https://other.example' })).status, 403);
  assert.equal((await request('active-site', { siteId: 'rimbo', personId: 'person-test-bob' }, alice.cookie)).status, 422);
  const changed = await request('active-site', { siteId: 'rimbo' }, alice.cookie, { origin: base });
  assert.equal(changed.status, 200); assert.equal(changed.activeSiteId, 'rimbo'); assert.equal(changed.person.id, alice.person.id); assert.ok(changed.gate);
  const reopened = await openRepository();
  await reopened.read(state => assert.deepEqual(state.metadata.mobileEmployeeActiveSites, [{ companyId: 'jeroc-demo', personId: alice.person.id, siteId: 'rimbo' }]));
  assert.equal((await login()).activeSiteId, 'rimbo');
  const bob = await login('bob'); assert.equal(bob.activeSiteId, 'norrtalje');
  assert.equal((await request('active-site', { siteId: 'rimbo' }, bob.cookie)).status, 403);
  env.SCRAPPILOT_ORGANISATION_ID = 'other-company';
  assert.equal((await request('session', undefined, alice.cookie)).activeSiteId, 'norrtalje');
  env.SCRAPPILOT_ORGANISATION_ID = 'jeroc-demo';
  assert.equal((await request('session', undefined, alice.cookie)).activeSiteId, 'rimbo');
  clock('2026-10-13T06:00:00Z');
  const blocked = await request('session', undefined, alice.cookie);
  // Refresh a real session after advancing to the next working day.
  const nextVisit = await login(); assert.equal(nextVisit.gate.blocked, true);
  const whileBlocked = await request('active-site', { siteId: 'norrtalje' }, nextVisit.cookie);
  assert.equal(whileBlocked.status, 200); assert.equal(whileBlocked.gate.blocked, true); assert.equal(whileBlocked.activeSiteId, 'norrtalje');
  assert.equal(blocked.status, 401);
}));

test('facility choices intersect registered active sites and revoked account scopes without writing GET snapshots', async () => fixture(async ({ request, login, repository, siteCatalog }) => {
  siteCatalog.push({ id: 'inactive', name: 'Inaktiv', active: false }, { id: 'account-only', name: 'Kontobehörighet', active: true });
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'test-alice'); person.siteIds = ['rimbo', 'norrtalje', 'inactive', 'unknown'];
    state.pricing.users.find(value => value.id === person.userId).siteIds = ['rimbo', 'norrtalje', 'inactive', 'account-only'];
  });
  const alice = await login(); assert.deepEqual(alice.sites.map(value => value.id), ['norrtalje', 'rimbo']);
  assert.equal((await request('active-site', { siteId: 'rimbo' }, alice.cookie)).status, 200);
  for (const siteId of ['inactive', 'unknown', 'account-only']) assert.equal((await request('active-site', { siteId }, alice.cookie)).status, 403);
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'test-alice').siteIds = ['norrtalje']; });
  const before = await repository.read((state, revision) => ({ revision, metadata: structuredClone(state.metadata) }));
  const revoked = await request('session', undefined, alice.cookie);
  assert.equal(revoked.status, 200); assert.deepEqual(revoked.sites.map(value => value.id), ['norrtalje']); assert.equal(revoked.activeSiteId, 'norrtalje');
  assert.deepEqual(await repository.read((state, revision) => ({ revision, metadata: structuredClone(state.metadata) })), before);
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'test-alice').siteIds = ['rimbo']; });
  siteCatalog.find(value => value.id === 'rimbo').active = false;
  const empty = await request('session', undefined, alice.cookie);
  assert.equal(empty.status, 200); assert.deepEqual(empty.sites, []); assert.equal(empty.activeSiteId, undefined);
  assert.equal((await request('active-site', { siteId: 'norrtalje' }, alice.cookie)).status, 403);
}));

test('legacy mismatched scopes migrate to the effective account scope without granting foreign-site time or orders', async () => fixture(async ({ request, login, repository }) => {
  const forbiddenId = 'AO-scope-rimbo', allowedId = 'AO-scope-norrtalje';
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'test-alice');
    Object.assign(person, { siteIds: ['norrtalje', 'rimbo'], canDrive: true, driverId: 'scope-alice' });
    state.transport.drivers.push({ ...structuredClone(state.transport.drivers[0]), id: person.driverId, personId: person.id });
    const template = structuredClone(state.transport.orders[0]);
    for (const [id, siteId] of [[forbiddenId, 'rimbo'], [allowedId, 'norrtalje']])
      state.transport.orders.push({ ...structuredClone(template), id, siteId, driverId: person.driverId, status: 'booked', date: '2026-10-12', customerName: id });
  });
  const alice = await login(); assert.equal(alice.status, 200); assert.deepEqual(alice.person.siteIds, ['norrtalje']);
  for (const path of ['session', 'overview', 'calendar?date=2026-10-12', 'orders']) {
    const result = await request(path, undefined, alice.cookie); assert.equal(result.status, 200);
    assert.deepEqual(result.orders.map(value => value.id), [allowedId]);
    assert.deepEqual(result.selectedDay.orders.map(value => value.id), [allowedId]);
    assert.equal(result.selectedDay.jobsCount, 1); assert.ok(!JSON.stringify(result).includes(forbiddenId));
  }
  const entry = { date: '2026-10-12', startMinute: 420, endMinute: 450, breakMinutes: 0, activity: 'Gårdsarbete', note: '' };
  assert.equal((await request('time/save', { ...entry, siteId: 'rimbo' }, alice.cookie)).status, 403);
  assert.equal((await request('time/save', { ...entry, siteId: 'norrtalje', orderId: forbiddenId }, alice.cookie)).status, 403);
  assert.equal((await request('time', { action: 'order.start', orderId: forbiddenId }, alice.cookie)).status, 403);
  for (const [action, payload] of [['start', {}], ['status', { status: 'on_way' }], ['logistics', { action: 'travel.empty', expectedVersion: 1 }]])
    assert.equal((await request(`orders/${forbiddenId}/${action}`, payload, alice.cookie)).status, 403);
  await repository.read(state => {
    assert.deepEqual(state.personnel.people.find(value => value.id === alice.person.id).siteIds, ['norrtalje']);
    assert.equal(state.employeeTime.entries.length, 0); assert.equal(state.employeeTime.orderSessions.length, 0);
    assert.equal(state.transport.orders.find(value => value.id === forbiddenId).status, 'booked');
  });
  const profile = await request('profile', { phone: '0722002220', email: 'scoped@example.test' }, alice.cookie);
  assert.equal(profile.status, 200); assert.equal(profile.person.phone, '+46722002220');
  await repository.read(state => assert.equal(state.personnel.people.find(value => value.id === alice.person.id).email, 'scoped@example.test'));
  const allowed = await request('orders/AO-scope-norrtalje/start', {}, alice.cookie);
  assert.equal(allowed.status, 200, allowed.error); assert.equal(allowed.activeWork.orderId, allowedId);
  await repository.transact(state => {
    state.employeeTime.orderSessions = [{ id: 'restricted-session', personId: alice.person.id, orderId: forbiddenId, siteId: 'rimbo', startedAt: '2026-10-12T05:00:00Z', revision: 1 }];
  });
  const restricted = await request('session', undefined, alice.cookie); assert.equal(restricted.activeWork, undefined);
  assert.equal((await request(`orders/${forbiddenId}/stop`, {}, alice.cookie)).status, 403);
  assert.equal((await request('time', { action: 'order.stop', orderId: forbiddenId }, alice.cookie)).status, 403);
  await repository.read(state => assert.equal(state.employeeTime.orderSessions[0].endedAt, undefined));
}));

test('revoked facilities redact historical order details while preserving worked hours, and manager lists keep effective scope', async () => fixture(async ({ request, login, repository, clock }) => {
  clock('2026-10-12T15:00:00Z');
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'test-alice'); person.siteIds = ['norrtalje', 'rimbo'];
    const user = state.pricing.users.find(value => value.id === person.userId); user.siteIds = ['norrtalje', 'rimbo']; user.permissions.push('employmentWrite');
    state.personnel.people.find(value => value.userId === 'test-bob').managerId = person.id;
    state.personnel.people.push({ ...structuredClone(person), id: 'person-scope-foreign', userId: undefined, siteIds: ['rimbo'], managerId: person.id });
  });
  const initial = await login();
  const saved = await request('time/save', { date: '2026-10-12', startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'Gårdsarbete', note: '', siteId: 'rimbo' }, initial.cookie);
  assert.equal(saved.status, 200, saved.error); assert.equal(saved.selectedDay.recordedMinutes, 480);
  const oldEntry = saved.selectedDay.entries[0];
  await repository.transact(state => {
    state.pricing.users.find(value => value.id === 'test-alice').siteIds = ['norrtalje'];
    state.transport.orders.push({ ...structuredClone(state.transport.orders[0]), id: 'AO-restricted-history', siteId: 'rimbo', customerName: 'Restricted historic customer' });
    state.employeeTime.orderSessions.push({ id: 'scope-historic-session', personId: initial.person.id, orderId: 'AO-restricted-history', siteId: 'rimbo',
      startedAt: '2026-10-12T05:00:00Z', endedAt: '2026-10-12T14:00:00Z', breakMinutes: 60, revision: 1 });
  });
  clock('2026-10-13T06:00:00Z');
  const nextVisit = await login(); assert.equal(nextVisit.gate.blocked, false);
  const historical = await request('calendar?date=2026-10-12', undefined, nextVisit.cookie);
  assert.equal(historical.selectedDay.recordedMinutes, 480); assert.equal(historical.selectedDay.entries[0].siteId, undefined);
  assert.equal(historical.selectedDay.entries[0].siteName, undefined);
  assert.ok(!JSON.stringify(historical).includes('Restricted historic customer'));
  assert.ok(!JSON.stringify(historical).includes('AO-restricted-history'));
  assert.equal((await request('time/save', { id: oldEntry.id, revision: oldEntry.revision, date: oldEntry.date, startMinute: oldEntry.startMinute, endMinute: oldEntry.endMinute,
    breakMinutes: oldEntry.breakMinutes, activity: 'Ändra historik', note: '', siteId: 'norrtalje' }, nextVisit.cookie)).status, 403);
  assert.equal((await request('time/remove', { id: oldEntry.id, revision: oldEntry.revision }, nextVisit.cookie)).status, 403);
  const managed = await request('requirements', undefined, nextVisit.cookie);
  assert.equal(managed.status, 200); assert.deepEqual(managed.people.map(value => value.id), ['person-test-bob']);
  assert.equal((await request('requirements', { personId: 'person-scope-foreign', requirement: { enabled: false, mode: 'schedule' } }, nextVisit.cookie)).status, 403);
}));

test('demo login shortcuts expose only availability and stop advertising changed or disabled fixture accounts', async () => fixture(async ({ request, login, repository, env }) => {
  const first = await request('demo-config');
  assert.equal(first.status, 200); assert.equal(first.enabled, true);
  assert.deepEqual(first.accounts, { niklas: true, admin: true });
  assert.equal(first.headers.get('cache-control'), 'no-store');
  for (const secret of ['Demo123!', 'JerocDemo2026!', 'digest', 'salt', 'tokenHash']) assert.ok(!JSON.stringify(first.accounts).includes(secret));
  const niklas = await login('niklas', 'Demo123!');
  assert.equal((await request('password', { currentPassword: 'Demo123!', password: 'Changed-Demo-Password-2026!' }, niklas.cookie)).status, 200);
  assert.deepEqual((await request('demo-config')).accounts, { niklas: false, admin: true });
  await repository.transact(state => { state.personnelAuth.accounts.find(account => account.username === 'admin').active = false; });
  assert.deepEqual((await request('demo-config')).accounts, { niklas: false, admin: false });
  env.JEROC_DEMO_AUTO_SESSION = 'false';
  const disabled = await request('demo-config'); assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.accounts, { niklas: false, admin: false });
}));

test('selected-company metadata is server-owned and staff email usernames can be saved and used for mobile login', async () => fixture(async ({ request, login, repository, env }) => {
  env.SCRAPPILOT_ORGANISATION_ID = 'tenant-test-company'; env.JEROC_DEMO_AUTO_SESSION = 'false';
  await repository.transact(state => { state.metadata.organisation = { id: 'tenant-test-company', name: 'Testföretag Mobile' }; });
  const config = await request('demo-config');
  assert.equal(config.companyId, 'tenant-test-company'); assert.equal(config.companyName, 'Testföretag Mobile');
  assert.equal(config.enabled, false);
  const admin = await login('admin', 'JerocDemo2026!');
  assert.equal(admin.companyId, config.companyId);
  const email = 'test.employee+login@example.test';
  const saved = await request('accounts/save', { personId: 'person-test-alice', username: email.toUpperCase(), active: true }, admin.cookie);
  assert.equal(saved.status, 200, saved.error);
  assert.equal(saved.people.find(person => person.id === 'person-test-alice').account.username, email);
  const employee = await login(email.toUpperCase());
  assert.equal(employee.companyId, 'tenant-test-company'); assert.equal(employee.companyName, 'Testföretag Mobile');
  assert.equal(employee.person.username, email);
  assert.equal((await request('session', undefined, employee.cookie, { 'x-demo-company': 'another-company' })).companyId, 'tenant-test-company');
}));

test('employee GET views use read snapshots without revising data or pruning persisted auth', async () => fixture(async ({ request, login, repository }) => {
  const admin = await login('admin', 'JerocDemo2026!');
  await repository.transact(state => {
    state.personnelAuth.sessions.push({ kind: 'employee', tokenHash: 'expired-example', personId: admin.person.id, expiresAt: '2026-10-01T00:00:00.000Z' });
    state.personnelAuth.attempts.push({ kind: 'employee', address: 'expired-address', at: '2026-10-01T00:00:00.000Z' });
  });
  const before = await repository.read((state, revision) => ({ revision, auth: structuredClone(state.personnelAuth) }));
  let writes = 0;
  const original = repository.transact;
  repository.transact = (...args) => { writes += 1; return original(...args); };
  for (const path of ['session', 'overview', 'calendar?month=2026-10', 'requirements', 'accounts', 'orders']) {
    const response = await request(path, undefined, admin.cookie); assert.equal(response.status, 200, `${path}: ${response.error}`);
  }
  const after = await repository.read((state, revision) => ({ revision, auth: structuredClone(state.personnelAuth) }));
  assert.equal(writes, 0); assert.deepEqual(after, before);
}));

test('only own time is returned and forged identity, foreign records and unassigned jobs are rejected', async () => fixture(async ({ request, login }) => {
  const alice = await login(), bob = await login('bob');
  const entry = { date: '2026-10-12', startMinute: 420, endMinute: 480, breakMinutes: 0, activity: 'Gårdsarbete', note: '', siteId: 'norrtalje' };
  const saved = await request('time/save', entry, alice.cookie); assert.equal(saved.status, 200, saved.error); assert.equal(saved.selectedDay.entries.length, 1);
  const other = await request('overview', undefined, bob.cookie); assert.deepEqual(other.selectedDay.entries, []);
  assert.equal((await request('time/save', { ...entry, personId: 'person-test-bob' }, alice.cookie)).status, 422);
  const id = saved.selectedDay.entries[0].id, revision = saved.selectedDay.entries[0].revision;
  assert.equal((await request('time/remove', { id, revision }, bob.cookie)).status, 403);
  assert.equal((await request('time/save', { ...entry, orderId: 'AO-1201' }, alice.cookie)).status, 403);
  assert.deepEqual((await request('orders', undefined, alice.cookie)).orders, []);
  const snapshot = JSON.stringify(saved); for (const hidden of ['34500', 'digest', 'tokenHash', 'person-test-bob', 'salaries']) assert.ok(!snapshot.includes(hidden), hidden);
}));

test('missing previous-day time blocks work on the server while manual registration immediately clears the gate', async () => fixture(async ({ request, login, repository, clock }) => {
  await login(); clock('2026-10-13T06:00:00Z');
  const session = await login(); assert.equal(session.gate.blocked, true); assert.equal(session.gate.date, '2026-10-12'); assert.equal(session.gate.missingMinutes, 480);
  await repository.read(state => assert.throws(() => employeeRequestPrincipal(state, { headers: { cookie: session.cookie } }, { enforceGate: true, now: () => new Date('2026-10-13T06:00:00Z') }), error => error.status === 423 && error.code === 'EMPLOYEE_TIME_REQUIRED'));
  assert.equal((await request('orders/AO-1201/start', {}, session.cookie)).status, 423);
  const saved = await request('time/save', { date: '2026-10-12', startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'Gårdsarbete', note: '', siteId: 'norrtalje' }, session.cookie);
  assert.equal(saved.status, 200, saved.error); assert.equal(saved.gate.blocked, false);
  await repository.read(state => assert.equal(employeeRequestPrincipal(state, { headers: { cookie: session.cookie } }, { enforceGate: true, now: () => new Date('2026-10-13T06:00:00Z') }).user.id, 'test-alice'));
}));

test('changed password revokes other sessions and disabled linked users cannot re-enter', async () => fixture(async ({ request, login, repository }) => {
  const first = await login(), second = await login();
  assert.equal((await request('password', { currentPassword: 'wrong', password: 'Changed-Password-2026!' }, second.cookie)).status, 403);
  assert.equal((await request('password', { currentPassword: 'Test-Password-2026!', password: 'Changed-Password-2026!' }, second.cookie)).status, 200);
  assert.equal((await request('session', undefined, first.cookie)).status, 401); assert.equal((await request('session', undefined, second.cookie)).status, 200);
  assert.equal((await request('login', { username: 'alice', password: 'Test-Password-2026!' })).status, 401);
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'test-alice').active = false; });
  assert.equal((await request('session', undefined, second.cookie)).status, 401);
  assert.equal((await request('login', { username: 'alice', password: 'Changed-Password-2026!' })).status, 401);
}));

test('known demo credentials are migrated once, admin can configure time and provision actual linked employees', async () => fixture(async ({ request, login, repository }) => {
  await repository.read(state => {
    assert.deepEqual(state.metadata.mobileEmployeeBootstrapUsers, [state.pricing.users.find(value => value.id === 'mobile-demo')]);
    assert.ok(!state.metadata.mobileEmployeeBootstrapUsers.some(value => value.id === 'admin' || value.id === 'test-alice'));
  });
  const admin = await login('admin', 'JerocDemo2026!'); assert.equal(admin.capabilities.manageTimeRequirements, true);
  assert.equal((await request('requirements', undefined, (await login()).cookie)).status, 403);
  const people = await request('requirements', undefined, admin.cookie), alice = people.people.find(value => value.id === 'person-test-alice');
  assert.ok(alice.canEdit);
  const saved = await request('requirements', { personId: alice.id, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 360, weekdays: [1, 2, 3, 4, 5], revision: alice.requirement.revision } }, admin.cookie);
  assert.equal(saved.status, 200, saved.error); assert.equal(saved.people.find(value => value.id === alice.id).requirement.dailyMinutes, 360);
  assert.equal((await request('accounts/save', { personId: alice.id, username: 'alice.updated', active: true, password: 'Provisioned-Password-2026!' }, admin.cookie)).status, 200);
  assert.equal((await request('login', { username: 'alice', password: 'Test-Password-2026!' })).status, 401);
  const authenticated = await login('alice.updated', 'Provisioned-Password-2026!'); assert.equal(authenticated.person.id, alice.id);
  const unlinked = (await request('accounts', undefined, admin.cookie)).people.find(value => value.id === 'person-kalle'); assert.ok(unlinked);
  assert.equal((await request('accounts/save', { personId: unlinked.id, siteIds: ['norrtalje'], username: 'kalle.mobile', active: true, password: 'Kalle-Provisioned-2026!' }, admin.cookie)).status, 200);
  const driver = await login('kalle.mobile', 'Kalle-Provisioned-2026!'); assert.equal(driver.person.id, unlinked.id); assert.equal(driver.person.driverId, 'kalle');
  assert.equal(driver.capabilities.assignedOrders, true); assert.equal(driver.capabilities.yardWork, false);
  await repository.read(state => { const user = state.pricing.users.find(value => value.id === driver.person.userId); assert.deepEqual(user.permissions, ['view']); });
  await repository.read(state => assert.equal(state.metadata.mobileEmployeeBootstrapUsers.length, 1));
  const niklas = await login('niklas', 'Demo123!');
  await request('password', { currentPassword: 'Demo123!', password: 'Niklas-Changed-Password!' }, niklas.cookie);
  await repository.transact(state => { ensureMobileEmployeeAccounts(state); ensureMobileEmployeeAccounts(state); });
  assert.equal((await request('login', { username: 'niklas', password: 'Demo123!' })).status, 401);
  const account = await repository.read(state => structuredClone(state.personnelAuth.accounts.find(value => value.username === 'niklas')));
  assert.ok(account.password.digest); assert.ok(!JSON.stringify(account).includes('Niklas-Changed-Password!'));
}));

test('bootstrap trust is never granted to a pre-existing custom user with the fictional ID', () => {
  const state = initialApplicationState();
  const custom = { id: 'mobile-demo', name: 'Real employee', level: 'Medarbetare', permissions: ['view'], siteIds: ['rimbo'], maxAttest: 0, ownAttest: false, active: true };
  state.pricing.users.push(custom); ensureMobileEmployeeAccounts(state);
  assert.deepEqual(state.pricing.users.find(value => value.id === custom.id), custom);
  assert.equal(state.metadata.mobileEmployeeBootstrapUsers, undefined);
  assert.ok(!state.personnelAuth.accounts.some(value => value.username === 'niklas'));
});

test('employee login rate limits failed attempts without storing plaintext credentials', async () => fixture(async ({ request, repository }) => {
  for (let index = 0; index < 12; index++) assert.equal((await request('login', { username: 'alice', password: 'wrong' })).status, 401);
  assert.equal((await request('login', { username: 'alice', password: 'Test-Password-2026!' })).status, 429);
  await repository.read(state => { assert.ok(!JSON.stringify(state.personnelAuth).includes('Test-Password-2026!')); assert.equal(state.personnelAuth.attempts.filter(value => value.kind === 'employee').length, 12); });
}));

test('actual job intervals persist for the performer and stop remains available after reassignment', async () => fixture(async ({ request, login, repository, openRepository, clock }) => {
  await repository.transact(state => {
    state.personnelAuth.accounts.push({ personId: 'person-kalle', username: 'kalle.actual', active: true, password: password('Test-Password-2026!') });
    const order = state.transport.orders.find(value => value.id === 'AO-1201');
    Object.assign(order, { date: '2026-10-12', startMinute: 420, status: 'booked' });
  });
  clock('2026-10-12T05:00:00Z'); const kalle = await login('kalle.actual');
  assert.equal(kalle.capabilities.assignedOrders, true);
  const begun = await request('orders/AO-1201/start', {}, kalle.cookie);
  assert.equal(begun.status, 200, begun.error); assert.equal(begun.activeWork.orderId, 'AO-1201');
  assert.equal((await request('orders/AO-1201/start', {}, kalle.cookie)).activeWork.id, begun.activeWork.id);
  const alice = await login(); assert.equal((await request('orders/AO-1201/stop', {}, alice.cookie)).status, 409);
  await repository.transact(state => { state.transport.orders.find(value => value.id === 'AO-1201').driverId = 'lina'; if (state.logistics.details['AO-1201']) state.logistics.details['AO-1201'].assignedDriverId = 'lina'; });
  clock('2026-10-12T07:30:00Z');
  const stopped = await request('orders/AO-1201/stop', { breakMinutes: 15 }, kalle.cookie);
  assert.equal(stopped.status, 200, stopped.error); assert.equal(stopped.activeWork, undefined);
  assert.equal(stopped.selectedDay.automaticMinutes, 135);
  assert.equal((await request('orders/AO-1201/stop', {}, kalle.cookie)).selectedDay.automaticMinutes, 135);
  await repository.read(state => {
    const sessions = state.employeeTime.orderSessions.filter(value => value.orderId === 'AO-1201');
    assert.equal(sessions.length, 1); assert.equal(sessions[0].personId, 'person-kalle');
    assert.equal(state.transport.orders.find(value => value.id === 'AO-1201').status, 'booked');
  });
  // A separate repository/connection reads committed auth and time, rather than
  // relying on the API process's original in-memory objects.
  const reopened = await openRepository();
  await reopened.read(state => {
    const interval = state.employeeTime.orderSessions.find(value => value.id === begun.activeWork.id);
    assert.equal(interval.personId, 'person-kalle'); assert.equal(interval.endedAt, '2026-10-12T07:30:00.000Z');
    assert.equal(employeeRequestPrincipal(state, { headers: { cookie: kalle.cookie } }, { now: () => new Date('2026-10-12T07:30:00Z') }).user.id, 'person-kalle');
    assert.equal(state.personnelAuth.accounts.find(value => value.username === 'kalle.actual').personId, interval.personId);
  });
}));

test('legacy job completion without a recorded start does not invent worked hours or fail delivery', async () => fixture(async ({ request, login, repository }) => {
  await repository.transact(state => {
    state.personnelAuth.accounts.push({ personId: 'person-kalle', username: 'kalle.legacy', active: true, password: password('Test-Password-2026!') });
    const order = state.transport.orders.find(value => value.id === 'AO-1201'); Object.assign(order, { date: '2026-10-12', status: 'on_way' });
  });
  const kalle = await login('kalle.legacy'), done = await request('orders/AO-1201/status', { status: 'done' }, kalle.cookie);
  assert.equal(done.status, 200, done.error); assert.equal(done.order.status, 'done'); assert.equal(done.selectedDay.automaticMinutes, 0);
  await repository.read(state => assert.equal(state.employeeTime.orderSessions.filter(value => value.orderId === 'AO-1201').length, 0));
}));
