import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';

const officeReview = '/api/application/personnel-time-review';
const ownPersonId = 'person-mobile-demo';
const currentDate = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ok = result => { assert.equal(result.status, 200, result.error); return result; };
function closedMonth() {
  const date = new Date(`${currentDate().slice(0, 7)}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() - 1);
  const month = date.toISOString().slice(0, 7), days = [];
  while (date.toISOString().startsWith(month)) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return { month, days };
}
/** Convert a valid test wall-clock time without assuming a Swedish UTC offset. */
function stockholmInstant(date, hour) {
  const target = `${date}T${String(hour).padStart(2, '0')}:00:00`, nominal = Date.parse(`${target}Z`);
  const format = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let shift = -180; shift <= 180; shift += 30) {
    const instant = nominal + shift * 60000;
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` === target) return new Date(instant).toISOString();
  }
  throw new Error('Could not create a real Stockholm fixture instant');
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-time-review-http-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') }, apps = [], servers = [], repositories = [];
  async function instance() {
    const app = createApplicationService({ env }); apps.push(app);
    const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost'))); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return async (path, data, { actor = 'admin', effective = actor, cookie, headers = {} } = {}) => {
      const response = await fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': effective } : {}),
          ...(cookie ? { cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const contentType = response.headers.get('content-type') ?? '';
      const result = contentType.includes('application/json') ? await response.json() : { csv: await response.text() };
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0],
        contentType, disposition: response.headers.get('content-disposition'), ...result };
    };
  }
  async function repository() {
    const repo = await createApplicationRepository({ env, initial: initialApplicationState }); repositories.push(repo); return repo;
  }
  try {
    const request = await instance(); ok(await request('/api/application/personnel'));
    await run({ request, instance, repo: await repository(), ...closedMonth() });
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const app of apps) await app.close();
    for (const repo of repositories) await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function historicalHours(repo, { month, days, personId = ownPersonId, source = 'workorder', absentDay, normHistory = true }) {
  await repo.transact(state => {
    const first = `${month}-01`, requirement = { personId, enabled: true, mode: 'schedule', timeSource: source,
      effectiveFrom: first, enforcementFrom: first, revision: 1 };
    state.employeeTime.settings = state.employeeTime.settings.filter(value => value.personId !== personId).concat(requirement);
    state.employeeTime.requirementHistory = state.employeeTime.requirementHistory.filter(value => value.personId !== personId).concat(structuredClone(requirement));
    const employment = { personId, form: 'permanent', startDate: first, percentage: 100, hoursPerWeek: 5, revision: 1 };
    const schedule = { id: `review-schedule-${personId}`, personId, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 480,
      effectiveFrom: first, revision: 1 };
    state.personnel.employment = state.personnel.employment.filter(value => value.personId !== personId).concat(employment);
    state.personnel.schedules = state.personnel.schedules.filter(value => value.personId !== personId).concat(schedule);
    state.employeeTime.normativeHistory = state.employeeTime.normativeHistory.filter(value => value.personId !== personId);
    if (normHistory) state.employeeTime.normativeHistory.push({ personId, effectiveFrom: first, revision: 1,
      employment: structuredClone(employment), schedules: [structuredClone(schedule)] });
    for (const date of days) {
      if (date === absentDay) continue;
      if (source === 'clock') state.employeeTime.clockSessions.push({ id: `review-clock-${personId}-${date}`, personId, siteId: 'norrtalje',
        startedAt: stockholmInstant(date, 7), endedAt: stockholmInstant(date, 8), breaks: [], revision: 1 });
      state.employeeTime.entries.push({ id: `review-entry-${personId}-${date}`, personId, date, siteId: 'norrtalje',
        startMinute: 420, endMinute: source === 'clock' ? 450 : 480, breakMinutes: 0, activity: 'Sortering', note: '', revision: 1,
        createdAt: stockholmInstant(date, 8), updatedAt: stockholmInstant(date, 8) });
    }
    if (absentDay) state.personnel.absences.push({ id: 'review-existing-absence', personId, kind: 'sick', fromDate: absentDay,
      toDate: absentDay, allDay: true, status: 'registered', createdAt: stockholmInstant(absentDay, 7), createdBy: 'admin', revision: 1 });
  });
}
async function employee(request, username = 'niklas', password = 'Demo123!') {
  const login = ok(await request('/api/employee/login?view=bootstrap', { username, password }, { actor: null }));
  return { login, own: (path, data) => request(`/api/employee/${path}`, data, { actor: null, cookie: login.cookie }) };
}
const ownDetail = (own, month) => own(`time-review?month=${month}`).then(ok);
const staffDetail = (request, month, personId = ownPersonId, principal) => request(`${officeReview}?month=${month}&personId=${personId}`, undefined, principal).then(ok);
const ownCommand = (own, action, detail, extra = {}) => own('time-review', {
  action, month: detail.period.month, revision: detail.review.revision, requestId: randomUUID(), ...extra,
});
const staffCommand = (request, action, detail, { personId = ownPersonId, principal, ...extra } = {}) => request(officeReview, {
  action, personId, month: detail.period.month, revision: detail.review.revision, requestId: randomUUID(), ...extra,
}, principal);
const manualEdit = (entry, extra = {}) => ({ id: entry.id, revision: entry.revision, date: entry.date, startMinute: entry.startMinute,
  endMinute: entry.endMinute, breakMinutes: entry.breakMinutes, activity: entry.activity, note: entry.note, siteId: entry.siteId, ...extra });

test('light employee bootstrap and closed-month preview retain authoritative totals without writing the read snapshot', async () => fixture(async ({ request, repo, month, days }) => {
  await historicalHours(repo, { month, days });
  const { login, own } = await employee(request);
  assert.equal(login.monthLoaded, false); assert.equal(login.days.length, 1);
  assert.deepEqual(login.clockHistory, []); assert.deepEqual(login.leaveRequests, []);
  const before = await repo.read((state, revision) => ({ state: structuredClone(state), revision }));
  const detail = await ownDetail(own, month);
  assert.equal(detail.period.isClosed, true); assert.equal(detail.period.source, 'live');
  assert.equal(detail.period.summary.recordedMinutes, days.length * 60);
  assert.equal(detail.period.summary.expectedMinutes, days.length * 60); assert.equal(detail.period.summary.missingMinutes, 0);
  const after = await repo.read((state, revision) => ({ state: structuredClone(state), revision })); assert.deepEqual(after, before);
  const current = await ownDetail(own, currentDate().slice(0, 7)); assert.equal(current.period.isClosed, false);
  assert.equal((await ownCommand(own, 'review.submit', current)).status, 409);
  const forged = await own(`time-review?month=${month}&personId=person-anna`);
  assert.equal(forged.status, 422);
}));

test('submission locks manual edits until withdrawal; approval and reasoned reopening persist every version without double approval', async () => fixture(async ({ request, repo, instance, month, days }) => {
  await historicalHours(repo, { month, days }); const { own } = await employee(request);
  const initial = await ownDetail(own, month), submitted = ok(await ownCommand(own, 'review.submit', initial));
  assert.equal(submitted.review.status, 'submitted'); assert.equal(submitted.period.source, 'submitted');
  let entry = await repo.read(state => structuredClone(state.employeeTime.entries.find(value => value.personId === ownPersonId)));
  assert.equal((await own('time/save', manualEdit(entry, { endMinute: 510 }))).status, 423);
  assert.equal((await own('time/remove', { id: entry.id, revision: entry.revision })).status, 423);
  const draft = ok(await ownCommand(own, 'review.withdraw', submitted)); assert.equal(draft.review.status, 'draft');
  ok(await own('time/save', manualEdit(entry, { endMinute: 510 })));
  const changed = await ownDetail(own, month), secondSubmission = ok(await ownCommand(own, 'review.submit', changed));
  assert.equal(secondSubmission.period.summary.recordedMinutes, days.length * 60 + 30);
  const approvalCommand = { action: 'review.approve', personId: ownPersonId, month, revision: secondSubmission.review.revision, requestId: randomUUID() };
  const approved = ok(await request(officeReview, approvalCommand)); assert.equal(approved.review.status, 'approved');
  assert.equal(approved.period.source, 'approved');
  const retry = ok(await request(officeReview, approvalCommand)); assert.equal(retry.review.revision, approved.review.revision);
  const reopenedInstance = await instance(), persisted = await staffDetail(reopenedInstance, month);
  assert.equal(persisted.review.status, 'approved'); assert.equal(persisted.period.summary.recordedMinutes, days.length * 60 + 30);
  entry = await repo.read(state => structuredClone(state.employeeTime.entries.find(value => value.id === entry.id)));
  assert.equal((await own('time/save', manualEdit(entry, { date: currentDate(), startMinute: 0, endMinute: 1 }))).status, 423);
  assert.equal((await staffCommand(request, 'review.reopen', approved, { reason: '' })).status, 422);
  const reopened = ok(await staffCommand(request, 'review.reopen', approved, { reason: 'Komplettering efter kontroll' }));
  assert.equal(reopened.review.status, 'reopened'); assert.ok(reopened.versions.length >= 2);
  ok(await own('time/save', manualEdit(entry, { endMinute: 540 })));
  assert.equal((await ownDetail(own, month)).period.summary.recordedMinutes, days.length * 60 + 60);
}));

test('approval detects stale canonical inputs and CAS while exact retries still require current permissions', async () => fixture(async ({ request, repo, month, days }) => {
  await historicalHours(repo, { month, days }); const { own } = await employee(request);
  const submitted = ok(await ownCommand(own, 'review.submit', await ownDetail(own, month)));
  // Simulate an old/importing writer outside the guarded HTTP paths. Approval
  // must independently recalculate and reject its now-outdated snapshot.
  await repo.transact(state => { state.employeeTime.entries.find(value => value.personId === ownPersonId).endMinute += 30; });
  assert.equal((await staffCommand(request, 'review.approve', submitted)).status, 409);
  const stale = await staffDetail(request, month); assert.equal(stale.review.stale, true);
  const withdrawn = ok(await ownCommand(own, 'review.withdraw', submitted));
  const resubmitted = ok(await ownCommand(own, 'review.submit', withdrawn));
  assert.equal((await staffCommand(request, 'review.approve', submitted)).status, 409);
  await repo.transact(state => Object.assign(state.pricing.users.find(value => value.id === 'kajsa'), {
    permissions: ['view', 'personnelRead', 'personnelTimeReviewRead', 'personnelTimeApprove'], siteIds: ['norrtalje'],
  }));
  const command = { action: 'review.approve', personId: ownPersonId, month, revision: resubmitted.review.revision, requestId: randomUUID() };
  ok(await request(officeReview, command, { actor: 'kajsa' }));
  await repo.transact(state => { state.pricing.users.find(value => value.id === 'kajsa').permissions = ['view', 'personnelRead', 'personnelTimeReviewRead']; });
  assert.equal((await request(officeReview, command, { actor: 'kajsa' })).status, 403);
}));

test('review and approval require separate dual rights, full facility scope and forbid self approval even after account relinking', async () => fixture(async ({ request, repo, month, days }) => {
  await historicalHours(repo, { month, days }); const { own } = await employee(request);
  const submitted = ok(await ownCommand(own, 'review.submit', await ownDetail(own, month)));
  await repo.transact(state => Object.assign(state.pricing.users.find(value => value.id === 'kajsa'), { permissions: ['view', 'personnelRead'], siteIds: ['norrtalje'] }));
  assert.equal((await request(`${officeReview}?month=${month}`, undefined, { actor: 'kajsa' })).status, 403);
  await repo.transact(state => state.pricing.users.find(value => value.id === 'kajsa').permissions.push('personnelTimeReviewRead'));
  assert.equal((await staffDetail(request, month, ownPersonId, { actor: 'kajsa' })).review.status, 'submitted');
  assert.equal((await staffCommand(request, 'review.approve', submitted, { principal: { actor: 'admin', effective: 'kajsa' } })).status, 403);
  await repo.transact(state => { const user = state.pricing.users.find(value => value.id === 'kajsa'); user.permissions.push('personnelTimeApprove'); user.siteIds = ['rimbo']; });
  assert.equal((await request(`${officeReview}?month=${month}&personId=${ownPersonId}`, undefined, { actor: 'kajsa' })).status, 403);
  assert.equal((await staffCommand(request, 'review.approve', submitted, { principal: { actor: 'kajsa' } })).status, 403);

  const adminPersonId = 'person-mobile-admin';
  await historicalHours(repo, { month, days, personId: adminPersonId });
  const administrator = await employee(request, 'admin', 'JerocDemo2026!');
  const ownSubmitted = ok(await ownCommand(administrator.own, 'review.submit', await ownDetail(administrator.own, month)));
  assert.equal((await staffCommand(request, 'review.approve', ownSubmitted, { personId: adminPersonId })).status, 403);
  await repo.transact(state => { state.personnel.people.find(value => value.id === adminPersonId).userId = 'anna'; });
  assert.equal((await staffCommand(request, 'review.approve', ownSubmitted, { personId: adminPersonId })).status, 403,
    'The submitted owner binding must prevent self approval after a profile account switch');
}));

test('approved months block retrospective absence and fallback contract changes with full transaction rollback, while later norms remain editable', async () => fixture(async ({ request, repo, month, days }) => {
  await historicalHours(repo, { month, days, absentDay: days[0] }); const { own } = await employee(request);
  const submitted = ok(await ownCommand(own, 'review.submit', await ownDetail(own, month))), approved = ok(await staffCommand(request, 'review.approve', submitted));
  assert.equal(approved.period.summary.absenceMinutes, 60);
  const before = await repo.read(state => structuredClone(state));
  assert.equal((await request('/api/application/personnel', { action: 'absence.cancel', absenceId: 'review-existing-absence', revision: 1 })).status, 409);
  assert.equal((await request('/api/application/personnel', { action: 'absence.save', absence: { id: 'new-review-absence', personId: ownPersonId,
    kind: 'leave', fromDate: days[1], toDate: days[1], allDay: true, revision: 0 } })).status, 409);
  assert.deepEqual(await repo.read(state => structuredClone(state)), before);
  const schedule = before.personnel.schedules.find(value => value.personId === ownPersonId);
  ok(await request('/api/application/personnel', { action: 'schedule.save', schedule: { ...schedule, endMinute: 540 } }));
  assert.equal((await staffDetail(request, month)).review.stale, false);
  assert.equal((await staffDetail(request, month)).period.summary.expectedMinutes, (days.length - 1) * 60);
  // A pre-history period uses current norms. Its own approval needs a guard
  // even when the new schedule version is recorded with today's date.
  const fallbackId = 'person-anna';
  await historicalHours(repo, { month, days, personId: fallbackId, normHistory: false });
  // Provision this existing employee through the ordinary personnel endpoint.
  ok(await request('/api/application/personnel', { action: 'employeeAccount.save', personId: fallbackId,
    username: 'anna.review', password: 'Review-Fixture-2026!', active: true }));
  const fallbackEmployee = await employee(request, 'anna.review', 'Review-Fixture-2026!');
  await repo.transact(state => { state.employeeTime.normativeHistory = state.employeeTime.normativeHistory.filter(value => value.personId !== fallbackId); });
  const fallbackSubmitted = ok(await ownCommand(fallbackEmployee.own, 'review.submit', await ownDetail(fallbackEmployee.own, month)));
  ok(await staffCommand(request, 'review.approve', fallbackSubmitted, { personId: fallbackId }));
  const fallbackEmployment = await repo.read(state => structuredClone(state.personnel.employment.find(value => value.personId === fallbackId)));
  assert.equal((await request('/api/application/personnel', { action: 'employment.save', employment: { ...fallbackEmployment, hoursPerWeek: 2.5 } })).status, 409);
}));

test('clock-month attendance remains separate from allocations and locked passes cannot move into or out of approved months', async () => fixture(async ({ request, repo, month, days }) => {
  await historicalHours(repo, { month, days, source: 'clock' }); const { own } = await employee(request);
  const detail = await ownDetail(own, month);
  assert.equal(detail.period.summary.recordedMinutes, days.length * 60);
  assert.equal(detail.period.summary.clockMinutes, days.length * 60);
  assert.equal(detail.period.summary.allocatedMinutes, days.length * 30);
  const submitted = ok(await ownCommand(own, 'review.submit', detail));
  ok(await staffCommand(request, 'review.approve', submitted, { reason: 'Ofördelad verklig tid hanteras separat' }));
  const session = await repo.read(state => structuredClone(state.employeeTime.clockSessions.find(value => value.personId === ownPersonId)));
  const overview = ok(await own(`overview?month=${month}&date=${days[0]}`));
  assert.equal((await own('clock', { action: 'clock.correct', sessionId: session.id, revision: overview.clock.revision, requestId: randomUUID(),
    startedAt: session.startedAt, endedAt: new Date(Date.parse(session.endedAt) + 1800000).toISOString(), breaks: [], reason: 'Kontroll av gammalt pass' })).status, 423);
  const currentSession = { ...session, id: 'review-open-month-session', startedAt: new Date(Date.now() - 3600000).toISOString(),
    endedAt: new Date(Date.now() - 1800000).toISOString() };
  await repo.transact(state => state.employeeTime.clockSessions.push(currentSession));
  assert.equal((await own('clock', { action: 'clock.correct', sessionId: currentSession.id, revision: overview.clock.revision, requestId: randomUUID(),
    startedAt: session.startedAt, endedAt: session.endedAt, breaks: [], reason: 'Pass flyttat till gammal månad' })).status, 423);
}));

test('authorized CSV exports only approved frozen versions, protects formula names and retains historical version one after reopening', async () => fixture(async ({ request, repo, month, days }) => {
  const formulaName = '=SUM(1;2)\n"Kontroll"';
  await repo.transact(state => { state.personnel.people.find(value => value.id === ownPersonId).name = formulaName; });
  await historicalHours(repo, { month, days });
  const { own } = await employee(request), submitted = ok(await ownCommand(own, 'review.submit', await ownDetail(own, month)));
  const approved = ok(await staffCommand(request, 'review.approve', submitted));
  assert.equal(approved.review.version, 1);
  const csvPath = `${officeReview}?month=${month}&personId=${ownPersonId}&format=csv`;
  const exported = ok(await request(csvPath));
  assert.match(exported.contentType, /^text\/csv; charset=utf-8$/);
  assert.match(exported.disposition, new RegExp(`tidrapporter-${month}\\.csv`));
  assert.ok(exported.csv.includes('"Period";"Person"'));
  assert.ok(exported.csv.includes('"\'=SUM(1;2)\n""Kontroll"""'), 'Formula prefix, semicolon, quote and newline must remain one neutralized CSV field');
  assert.ok(exported.csv.includes(approved.review.snapshotHash));
  assert.ok(exported.csv.includes(`"${days[0]}";"Arbetsorder och manuell tid";"60";"1,0000"`));
  await repo.transact(state => { state.pricing.users.find(value => value.id === 'kajsa').permissions = ['view', 'personnelRead']; });
  assert.equal((await request(csvPath, undefined, { actor: 'kajsa' })).status, 403);
  ok(await staffCommand(request, 'review.reopen', approved, { reason: 'Uppgifter kompletteras efter månadsstängning' }));
  const entry = await repo.read(state => structuredClone(state.employeeTime.entries.find(value => value.personId === ownPersonId)));
  ok(await own('time/save', manualEdit(entry, { endMinute: 540 })));
  const person = await repo.read(state => structuredClone(state.personnel.people.find(value => value.id === ownPersonId)));
  ok(await request('/api/application/personnel', { action: 'person.save', person: { ...person, name: 'Uppdaterat namn efter attest' } }));
  assert.equal((await request(csvPath)).status, 409, 'Reopened periods cannot masquerade as current approved exports');
  const historical = ok(await request(`${csvPath}&version=1`));
  assert.equal(historical.csv, exported.csv, 'The already-approved version must retain its names, source hash and actual hours');
  assert.match(historical.disposition, new RegExp(`tidrapporter-${month}-v1\\.csv`));
  assert.equal(historical.csv.includes('Uppdaterat namn efter attest'), false);
  assert.equal(historical.csv.includes('"120";"2,0000"'), false);
}));
