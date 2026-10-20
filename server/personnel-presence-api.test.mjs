import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';

const presence = '/api/application/personnel-presence';
const timeSettings = '/api/application/personnel-time';
const ownPersonId = 'person-mobile-demo';
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ok = response => { assert.equal(response.status, 200, response.error); return response; };

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-presence-http-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') }, apps = [], servers = [], repositories = [];
  async function instance() {
    const app = createApplicationService({ env }); apps.push(app);
    const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost'))); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return async (path, data, { actor = 'admin', effective = actor, cookie, method = data === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
      const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': effective } : {}),
          ...(cookie ? { cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], ...await response.json() };
    };
  }
  async function repository() {
    const repo = await createApplicationRepository({ env, initial: initialApplicationState }); repositories.push(repo); return repo;
  }
  try {
    const request = await instance();
    // Persist the existing startup migration before comparing read snapshots.
    ok(await request('/api/application/personnel'));
    await run({ request, instance, repository });
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const app of apps) await app.close();
    for (const repo of repositories) await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function employee(id, siteIds = ['norrtalje']) {
  return { id: `presence-${id}`, userId: `presence-user-${id}`, name: `Närvaro ${id}`, kind: 'employee', active: true,
    role: 'Gårdsarbetare', team: 'Närvarotest', siteIds, phone: '+46705559991', email: 'private-presence@example.invalid',
    address: 'PRIVATE-PRESENCE-HOME', canDrive: false, revision: 1 };
}
function addEmployee(state, person, source = 'clock') {
  state.personnel.people.push(person);
  state.pricing.users.push({ id: person.userId, name: person.name, level: 'Medarbetare', permissions: ['view'], siteIds: person.siteIds,
    active: true, maxAttest: 0, ownAttest: false });
  const requirement = { personId: person.id, enabled: true, mode: 'fixed', dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5, 6, 7],
    timeSource: source, effectiveFrom: today(), enforcementFrom: today(), revision: 1 };
  state.employeeTime.settings.push(requirement); state.employeeTime.requirementHistory.push(structuredClone(requirement));
  state.personnel.schedules.push({ id: `schedule-${person.id}`, personId: person.id, weekdays: [1, 2, 3, 4, 5, 6, 7],
    startMinute: 0, endMinute: 1440, effectiveFrom: today(), revision: 1 });
  return person;
}
function clockSession(person, extra = {}) {
  return { id: `session-${person.id}`, personId: person.id, siteId: person.siteIds[0],
    startedAt: new Date(Date.now() - 3600000).toISOString(), endedAt: null, breaks: [], revision: 1, ...extra };
}

test('presence HTTP snapshot reports current working, break, out and disabled facts without projecting private history or contacts', async () => fixture(async ({ request, repository }) => {
  const repo = await repository(), baseline = ok(await request(presence));
  const people = Object.fromEntries(['working', 'break', 'out', 'disabled'].map(id => [id, employee(id)]));
  await repo.transact(state => {
    for (const [id, person] of Object.entries(people)) addEmployee(state, person, id === 'disabled' ? 'workorder' : 'clock');
    state.employeeTime.clockSessions.push(clockSession(people.working), clockSession(people.break, {
      breaks: [{ startedAt: new Date(Date.now() - 120000).toISOString(), endedAt: null }],
    }));
    state.employeeTime.audit.push({ id: 'private-clock-audit', personId: people.working.id, action: 'clock.correct', at: new Date().toISOString(),
      reason: 'PRIVATE-CLOCK-MEDICAL-HISTORY', before: { salary: 123456789 }, after: { privateContact: 'SECRET-AUDIT-CONTACT' } });
    state.personnel.absences.push({ id: 'presence-private-absence', personId: people.disabled.id, kind: 'sick', fromDate: today(),
      toDate: today(), allDay: true, status: 'registered', createdBy: 'PRIVATE-MEDICAL-ACTOR', revision: 1 });
  });
  const before = await repo.read((state, revision) => ({ state: structuredClone(state), revision }));
  const result = ok(await request(presence)), rows = Object.fromEntries(result.people.map(person => [person.personId, person]));
  assert.equal(rows[people.working.id].clockStatus, 'working'); assert.equal(rows[people.working.id].isWorkingNow, true);
  assert.equal(rows[people.working.id].isClockedIn, true); assert.equal(rows[people.working.id].clockSiteId, 'norrtalje');
  assert.equal(rows[people.break.id].clockStatus, 'break'); assert.equal(rows[people.break.id].isOnBreak, true);
  assert.equal(rows[people.break.id].isWorkingNow, false); assert.ok(rows[people.break.id].breakSeconds >= 120);
  assert.equal(rows[people.out.id].clockStatus, 'out'); assert.equal(rows[people.out.id].isClockedIn, false);
  assert.equal(rows[people.disabled.id].clockStatus, 'disabled'); assert.equal(rows[people.disabled.id].clockEnabled, false);
  assert.equal(rows[people.disabled.id].isAbsentNow, true);
  assert.equal(result.summary.total, baseline.summary.total + 4);
  assert.equal(result.summary.working, baseline.summary.working + 1); assert.equal(result.summary.onBreak, baseline.summary.onBreak + 1);
  assert.equal(result.summary.clockedOut, baseline.summary.clockedOut + 1); assert.equal(result.summary.clockDisabled, baseline.summary.clockDisabled + 1);
  assert.ok(result.people.every(person => !['phone', 'email', 'address', 'salary', 'clockSessions', 'clockHistory', 'absences', 'medicalReason'].some(key => key in person)));
  for (const secret of ['+46705559991', 'private-presence@example.invalid', 'PRIVATE-PRESENCE-HOME', 'PRIVATE-CLOCK-MEDICAL-HISTORY',
    'SECRET-AUDIT-CONTACT', 'PRIVATE-MEDICAL-ACTOR', '123456789']) assert.equal(JSON.stringify(result).includes(secret), false);
  const repeated = ok(await request(presence)); assert.equal(repeated.revision, result.revision);
  const after = await repo.read((state, revision) => ({ state: structuredClone(state), revision }));
  assert.deepEqual(after, before, 'Presence GET must not mutate data, audit or committed revision');
}));

test('presence HTTP access requires explicit permissions on both principals and validates current site filters and scopes', async () => fixture(async ({ request, repository }) => {
  const repo = await repository();
  await repo.transact(state => {
    Object.assign(state.pricing.users.find(user => user.id === 'kajsa'), {
      permissions: ['view', 'personnelRead', 'employmentRead', 'transportRead'], siteIds: ['norrtalje'],
    });
    addEmployee(state, employee('outside', ['rimbo']));
    addEmployee(state, employee('mixed', ['norrtalje', 'rimbo']));
  });
  assert.equal((await request(presence, undefined, { actor: 'kajsa' })).status, 403);
  assert.equal((await request(presence, undefined, { actor: 'admin', effective: 'kajsa' })).status, 403);
  assert.equal((await request(presence, undefined, { actor: 'kajsa', effective: 'admin' })).status, 403);
  await repo.transact(state => state.pricing.users.find(user => user.id === 'kajsa').permissions.push('personnelPresenceRead'));
  const scoped = ok(await request(presence, undefined, { actor: 'admin', effective: 'kajsa' }));
  assert.ok(scoped.people.length > 0); assert.ok(scoped.people.every(person => person.siteIds.every(id => id === 'norrtalje')));
  assert.equal(scoped.people.some(person => ['presence-outside', 'presence-mixed'].includes(person.personId)), false);
  assert.deepEqual(scoped.sites.map(site => site.id), ['norrtalje']);
  assert.equal((await request(`${presence}?siteId=rimbo`, undefined, { actor: 'kajsa' })).status, 403);
  assert.equal((await request(`${presence}?siteId=unknown`)).status, 403, 'Scoped principals cannot probe facility existence.');
  await repo.transact(state => {
    const principal = structuredClone(state.pricing.users.find(user => user.id === 'admin'));
    delete principal.siteIds;
    state.pricing.users.push({ ...principal, id: 'presence-all-facilities', name: 'Presence test administrator' });
  });
  assert.equal((await request(`${presence}?siteId=unknown`, undefined, { actor: 'presence-all-facilities' })).status, 404);
  assert.equal((await request(`${presence}?siteId=../norrtalje`)).status, 422);
  assert.equal((await request(`${presence}?personId=presence-outside`)).status, 422);
  assert.equal((await request(presence, {}, { method: 'POST' })).status, 405);
  const rimbo = ok(await request(`${presence}?siteId=rimbo`));
  assert.ok(rimbo.people.every(person => person.siteIds.includes('rimbo')));
  await repo.transact(state => state.pricing.users.find(user => user.id === 'kajsa').permissions = ['view']);
  assert.equal((await request(presence, undefined, { actor: 'kajsa' })).status, 403);
}));

test('own mobile presence uses its authenticated employee without cross-person presence permission or forged person selection', async () => fixture(async ({ request, repository }) => {
  const repo = await repository();
  await repo.transact(state => {
    const other = addEmployee(state, employee('other-cookie'));
    state.employeeTime.clockSessions.push(clockSession(other));
  });
  const login = ok(await request('/api/employee/login', { username: 'niklas', password: 'Demo123!' }, { actor: null }));
  const options = { actor: null, cookie: login.cookie };
  const own = ok(await request('/api/employee/overview', undefined, options));
  assert.equal(own.presence.personId, ownPersonId); assert.equal(own.presence.clockStatus, 'disabled');
  assert.equal(own.presence.name, 'Niklas'); assert.equal(own.presence.people, undefined);
  assert.equal(JSON.stringify(own.presence).includes('presence-other-cookie'), false);
  const selected = ok(await request('/api/employee/overview?personId=presence-other-cookie', undefined, options));
  assert.equal(selected.presence.personId, ownPersonId);
  assert.equal((await request(presence, undefined, options)).status, 401, 'An employee cookie does not authenticate the office realm');
  assert.equal((await request(presence, undefined, { actor: 'mobile-demo' })).status, 403, 'The same user also lacks the explicit office presence permission');
  assert.equal((await request('/api/employee/overview', undefined, { cookie: 'jeroc_employee=invalid' })).status, 401);
}));

test('trusted clock-in records the allowed selected site and a later preference or correction cannot rewrite that attendance site', async () => fixture(async ({ request, repository }) => {
  const repo = await repository();
  await repo.transact(state => {
    state.personnel.people.find(person => person.id === ownPersonId).siteIds = ['norrtalje', 'rimbo'];
    state.pricing.users.find(user => user.id === 'mobile-demo').siteIds = ['norrtalje', 'rimbo'];
  });
  const current = ok(await request(`${timeSettings}?personId=${ownPersonId}`));
  ok(await request(timeSettings, { action: 'requirement.save', personId: ownPersonId,
    requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: current.configuredRequirement.revision } }));
  const login = ok(await request('/api/employee/login', { username: 'niklas', password: 'Demo123!' }, { actor: null }));
  const options = { actor: null, cookie: login.cookie };
  const chosen = ok(await request('/api/employee/active-site', { siteId: 'rimbo' }, options)); assert.equal(chosen.activeSiteId, 'rimbo');
  const working = ok(await request('/api/employee/clock', { action: 'clock.in', revision: chosen.clock.revision, requestId: 'presence-site-clock-in' }, options));
  assert.equal(working.clock.activeSession.siteId, 'rimbo'); assert.equal(working.presence.clockSiteId, 'rimbo');
  const moved = ok(await request('/api/employee/active-site', { siteId: 'norrtalje' }, options));
  assert.equal(moved.activeSiteId, 'norrtalje'); assert.equal(moved.presence.clockSiteId, 'rimbo');
  const stopped = ok(await request('/api/employee/clock', { action: 'clock.out', revision: moved.clock.revision,
    sessionId: moved.clock.activeSession.id, requestId: 'presence-site-clock-out' }, options));
  const session = await repo.read(state => structuredClone(state.employeeTime.clockSessions.find(value => value.id === working.clock.activeSession.id)));
  const corrected = ok(await request('/api/employee/clock', { action: 'clock.correct', revision: stopped.clock.revision,
    sessionId: session.id, startedAt: session.startedAt, endedAt: session.endedAt, breaks: [], reason: 'Kontrollerade stämplingarna',
    requestId: 'presence-site-clock-correct' }, options));
  assert.equal(corrected.presence.isClockedIn, false);
  const persisted = await repo.read(state => structuredClone(state.employeeTime.clockSessions.find(value => value.id === session.id)));
  assert.equal(persisted.siteId, 'rimbo'); assert.equal(persisted.correctionReason, 'Kontrollerade stämplingarna');
  assert.equal((await request('/api/employee/active-site', { siteId: 'unknown' }, options)).status, 403);
  assert.equal((await request('/api/employee/clock', { action: 'clock.in', revision: corrected.clock.revision,
    siteId: 'unknown', requestId: 'presence-forged-site' }, options)).status, 422);
}));
