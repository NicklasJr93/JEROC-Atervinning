import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createMobileEmployeeApi, ensureMobileEmployeeAccounts } from './mobile-employee-api.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }];
const ownPersonId = 'person-mobile-demo';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-mobile-startup-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  const repository = await createApplicationRepository({ env, initial: initialApplicationState });
  let now = new Date('2026-10-12T16:00:00Z');
  await repository.transact(state => ensureMobileEmployeeAccounts(state));
  const api = createMobileEmployeeApi({ getRepository: async () => repository, env, now: () => now,
    siteProvider: async () => sites,
    readBody: async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    json: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); },
  });
  const server = createServer((req, res) => void api(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data, cookie, headers = {}) => {
    const response = await fetch(`${base}/api/employee/${path}`, { signal: AbortSignal.timeout(10000),
      method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], value: await response.json() };
  };
  const login = async () => {
    const result = await request('login?view=bootstrap', { username: 'niklas', password: 'Demo123!' });
    assert.equal(result.status, 200, result.value.error); return result;
  };
  try { await run({ repository, request, login, clock: value => { now = new Date(value); } }); }
  finally { await new Promise(done => server.close(done)); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('lean login/session keeps the own current day, clock and presence while older detail loads only on demand', async () => fixture(async ({ login, request, repository }) => {
  const loggedIn = await login();
  assert.equal(loggedIn.value.monthLoaded, false); assert.equal(loggedIn.value.days.length, 1);
  assert.equal(loggedIn.value.person.id, ownPersonId); assert.ok(loggedIn.value.clock); assert.ok(loggedIn.value.presence);
  await repository.transact(state => {
    state.employeeTime.entries.push(
      { id: 'past-own', personId: ownPersonId, date: '2026-10-09', startMinute: 420, endMinute: 480, breakMinutes: 0, activity: 'PAST-DETAIL-NOT-FOR-STARTUP', note: '', revision: 1 },
      { id: 'current-own', personId: ownPersonId, date: '2026-10-12', startMinute: 420, endMinute: 480, breakMinutes: 0, activity: 'Dagens arbete', note: '', revision: 1 },
      { id: 'foreign-private', personId: 'person-anna', date: '2026-10-12', startMinute: 420, endMinute: 480, breakMinutes: 0, activity: 'FOREIGN-PERSON-PRIVATE', note: '', revision: 1 });
    for (let i = 0; i < 60; i++) state.employeeTime.audit.push({ id: `past-clock-${i}`, personId: ownPersonId, action: 'clock.correct', at: '2026-10-09T12:00:00Z', reason: 'PAST-CLOCK-HISTORY-NOT-FOR-STARTUP' });
    state.employeeTime.leaveRequests.push({ id: 'past-leave', personId: ownPersonId, fromDate: '2026-10-08', toDate: '2026-10-08', kind: 'leave', status: 'rejected', note: 'PAST-LEAVE-NOT-FOR-STARTUP' });
  });
  const before = await repository.read((state, revision) => ({ state: structuredClone(state), revision }));
  const lean = await request('session?view=bootstrap&personId=person-anna', undefined, loggedIn.cookie);
  assert.equal(lean.status, 200); assert.equal(lean.value.monthLoaded, false);
  assert.equal(lean.value.person.id, ownPersonId); assert.deepEqual(lean.value.days.map(day => day.date), ['2026-10-12']);
  assert.equal(lean.value.selectedDay.recordedMinutes, 60); assert.deepEqual(lean.value.clockHistory, []); assert.deepEqual(lean.value.leaveRequests, []);
  for (const marker of ['PAST-DETAIL-', 'PAST-CLOCK-HISTORY-', 'PAST-LEAVE-', 'FOREIGN-PERSON-PRIVATE']) assert.equal(JSON.stringify(lean.value).includes(marker), false);
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before, 'GET never persists a bootstrap flag, audit event or cached total');
  const full = await request('overview?month=2026-10&date=2026-10-09', undefined, loggedIn.cookie);
  assert.equal(full.status, 200); assert.equal(full.value.monthLoaded, true); assert.equal(full.value.days.length, 31);
  assert.equal(full.value.selectedDay.entries[0].activity, 'PAST-DETAIL-NOT-FOR-STARTUP');
  assert.equal(full.value.clockHistory.length, 50); assert.equal(full.value.leaveRequests.length, 1);
  assert.equal(JSON.stringify(full.value).includes('FOREIGN-PERSON-PRIVATE'), false);
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before);
}));

test('lean startup preserves the historical time gate and does not grant work actions while it is blocked', async () => fixture(async ({ login, request, repository, clock }) => {
  await login(); clock('2026-10-13T06:00:00Z');
  const loggedIn = await login();
  const lean = await request('session?view=bootstrap', undefined, loggedIn.cookie);
  const full = await request('overview', undefined, loggedIn.cookie);
  assert.equal(lean.status, 200); assert.equal(full.status, 200);
  assert.equal(lean.value.monthLoaded, false); assert.equal(lean.value.gate.blocked, true); assert.equal(lean.value.gate.date, '2026-10-12');
  assert.deepEqual(lean.value.gate, full.value.gate);
  assert.deepEqual(lean.value.requirement, full.value.requirement); assert.deepEqual(lean.value.capabilities, full.value.capabilities);
  const before = await repository.read((state, revision) => ({ state: structuredClone(state), revision }));
  const denied = await request('clock?view=bootstrap', { action: 'clock.in', requestId: 'cannot-bypass-gate', revision: 0 }, loggedIn.cookie);
  assert.equal(denied.status, 423); assert.equal(denied.value.code, 'EMPLOYEE_TIME_REQUIRED'); assert.equal(denied.value.gate.date, '2026-10-12');
  assert.deepEqual(await repository.read((state, revision) => ({ state: structuredClone(state), revision })), before, 'failed clock command rolls back');
}));

test('bootstrap still requires a fresh own cookie and rechecks disabled accounts', async () => fixture(async ({ request, login, repository }) => {
  assert.equal((await request('session?view=bootstrap')).status, 401);
  assert.equal((await request('session?view=bootstrap', undefined, 'jeroc_employee=invalid', { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' })).status, 401);
  const loggedIn = await login();
  await repository.transact(state => { state.pricing.users.find(user => user.id === 'mobile-demo').active = false; });
  assert.equal((await request('session?view=bootstrap', undefined, loggedIn.cookie)).status, 401);
  assert.equal((await request('overview?view=bootstrap', undefined, loggedIn.cookie)).status, 401);
}));
