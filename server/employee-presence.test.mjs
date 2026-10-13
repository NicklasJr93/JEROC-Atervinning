import test from 'node:test';
import assert from 'node:assert/strict';
import { employeePresenceProjection, employeePresenceForPerson } from './employee-presence.mjs';
import { ensureEmployeeTime, enrollEmployeeTime, employeeTimeRequirementCommand,
  employeeClockCommand, employeeClockProjection, employeeTimeProjection, employeeTimeLifecycle } from './employee-time.mjs';

const now = '2026-10-13T08:00:00Z';
const admin = { user: { id: 'admin', level: 'Systemadmin', active: true }, actor: { id: 'admin' } };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
function fixture() {
  const state = {
    pricing: { revision: 3, users: [admin.user] }, personnel: { revision: 4, people: [], employment: [], schedules: [], absences: [] },
    logistics: { revision: 2, details: {}, sites }, transport: { revision: 1, orders: [] },
  };
  ensureEmployeeTime(state);
  function add(id, source = 'clock', siteIds = ['norrtalje'], at = '2026-10-13T05:00:00Z') {
    const person = { id, userId: `user-${id}`, name: id.toUpperCase(), team: 'Gården', kind: 'employee', active: true, siteIds, driverId: `driver-${id}`, email: 'private@example.invalid' };
    state.personnel.people.push(person);
    state.pricing.users.push({ id: person.userId, name: person.name, active: true, permissions: ['view'], level: 'Medarbetare', siteIds });
    state.personnel.employment.push({ personId: id, startDate: '2024-01-01', hoursPerWeek: 40, salary: 'SECRET-SALARY' });
    state.personnel.schedules.push({ id: `schedule-${id}`, personId: id, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2024-01-01', revision: 1 });
    enrollEmployeeTime(state, person, { now: at });
    employeeTimeRequirementCommand(state, admin, { personId: id, requirement: { enabled: false, mode: 'schedule', timeSource: source, revision: 1 } }, [], { now: at });
    return person;
  }
  let sequence = 0;
  function stamp(person, action, at, extra = {}, context = {}) {
    return employeeClockCommand(state, person, { action, requestId: `presence-${++sequence}`,
      revision: employeeClockProjection(state, person, { now: at }).revision, ...extra }, [], {
      now: at, actualUserId: person.userId, effectiveUserId: person.userId, activeSiteId: person.siteIds[0], siteCatalog: sites, ...context,
    });
  }
  const read = (principal = admin, context = {}) => employeePresenceProjection(state, principal, { now, siteCatalog: sites, ...context });
  function startOrder(person, id = `AO-${person.id}`, siteId = person.siteIds[0]) {
    state.transport.orders.push({ id, driverId: person.driverId, siteId, customerName: 'SECRET-CUSTOMER', notes: 'SECRET-JOB-NOTE', status: 'booked', date: '2026-10-13' });
    employeeTimeLifecycle(state, person, id, 'start', [], { now: '2026-10-13T07:00:00Z' });
    return id;
  }
  return { state, add, stamp, read, startOrder };
}

const manager = (id, siteIds, permissions = ['personnelPresenceRead']) => ({ id, level: 'VD', active: true, siteIds, permissions });

test('overview preserves observed clock states; break remains clocked in, no fake out for workorder source', () => {
  const { add, stamp, read, state } = fixture();
  const a = add('a'), b = add('b'), c = add('c'), d = add('d', 'workorder');
  stamp(a, 'clock.in', '2026-10-13T05:00:00Z');
  stamp(b, 'clock.in', '2026-10-13T06:00:00Z'); stamp(b, 'clock.pause', '2026-10-13T07:30:00Z');
  const ext = { ...d, id: 'external', userId: undefined, kind: 'external' };
  state.personnel.people.push(ext, { ...d, id: 'inactive', active: false });
  const before = JSON.stringify(state), view = read();
  assert.equal(JSON.stringify(state), before, 'derived status must not write duplicate booleans');
  assert.equal(view.serverNow, '2026-10-13T08:00:00.000Z');
  assert.equal(view.people.length, 4);
  const person = id => view.people.find(value => value.personId === id);
  assert.equal(person('a').clockStatus, 'working');
  assert.equal(person('a').workSeconds, 180 * 60);
  assert.equal(person('a').clockSiteId, 'norrtalje');
  assert.equal(person('a').isWorkingNow, true);
  assert.equal(person('a').isAvailableNow, true);
  assert.equal(person('b').clockStatus, 'break');
  assert.equal(person('b').isClockedIn, true);
  assert.equal(person('b').isOnBreak, true);
  assert.equal(person('b').workSeconds, 90 * 60);
  assert.equal(person('b').breakSeconds, 30 * 60);
  assert.equal(person('b').breakStartedAt, '2026-10-13T07:30:00.000Z');
  assert.equal(person('b').availabilityStatus, 'on_break');
  assert.equal(person('c').clockStatus, 'out');
  assert.equal(person('c').availabilityStatus, 'not_clocked_in');
  assert.equal(person('d').clockStatus, 'disabled');
  assert.equal(person('d').availabilityStatus, 'unknown');
  assert.equal(person('d').isAvailableNow, null);
  assert.equal(person('d').workStateSource, 'unknown');
  assert.equal(person('d').workSeconds, 0);
  assert.equal(view.summary.clockedIn, view.summary.working + view.summary.onBreak);
  assert.deepEqual(view.summary, { total: 4, clockedIn: 2, working: 1, onBreak: 1, clockedOut: 1, clockDisabled: 1, needsReview: 0, available: 1 });
  assert.equal(JSON.stringify(view).includes('private@example.invalid'), false);
  assert.equal(JSON.stringify(view).includes('SECRET-SALARY'), false);
});

test('explicit dual permission and whole-person facility scope apply before filtering and counting', () => {
  const { add, read } = fixture();
  add('nord'); add('rimbo', 'clock', ['rimbo']); add('both', 'clock', ['norrtalje', 'rimbo']);
  assert.throws(() => read({ user: manager('boss', undefined, ['personnelRead', 'employmentRead']), actor: { id: 'boss' } }), error => error.status === 403);
  assert.throws(() => read({ user: manager('boss', undefined), actor: manager('other', undefined) }), error => error.status === 403);
  const actor = { id: 'real-admin', level: 'Systemadmin', active: true, siteIds: ['norrtalje', 'rimbo'] };
  const p = { actor, user: manager('boss', ['norrtalje']) };
  assert.deepEqual(read(p).people.map(person => person.personId), ['nord']);
  assert.deepEqual(read(p).sites, [sites[0]].map(({ id, name }) => ({ id, name })));
  assert.equal(read(p).summary.total, 1);
  assert.equal(read({ actor, user: manager('none', []) }).summary.total, 0);
  assert.deepEqual(read(admin, { siteId: 'rimbo' }).people.map(person => person.personId), ['both', 'rimbo']);
  assert.throws(() => read(p, { siteId: 'rimbo' }), error => error.status === 403);
  assert.throws(() => read({ actor: { ...actor, active: false }, user: manager('boss', undefined) }), error => error.status === 403);
});

test('registered partial absence uses Stockholm interval boundaries without medical data, pending leave is not absence', () => {
  const { state, add, stamp, read } = fixture();
  const person = add('a'); stamp(person, 'clock.in', '2026-10-13T05:00:00Z');
  state.personnel.absences.push({ personId: person.id, status: 'registered', kind: 'sick', fromDate: '2026-10-13', toDate: '2026-10-13', allDay: false,
    startMinute: 600, endMinute: 660, note: 'SECRET-DIAGNOSIS', managerId: 'SECRET-MANAGER' });
  state.employeeTime.leaveRequests.push({ personId: person.id, status: 'pending', allDay: true, fromDate: '2026-10-13', toDate: '2026-10-13', kind: 'vab', note: 'SECRET-LEAVE' });
  assert.equal(read(admin, { now: '2026-10-13T07:59:59Z' }).people[0].isAbsentNow, false);
  let view = read();
  assert.equal(view.people[0].isAbsentNow, true);
  assert.equal(view.people[0].availabilityStatus, 'absent');
  assert.equal(view.people[0].isAvailableNow, false);
  assert.equal(view.people[0].isClockedIn, true, 'absence does not falsify clock evidence');
  assert.equal(read(admin, { now: '2026-10-13T09:00:00Z' }).people[0].isAbsentNow, false, 'end is exclusive');
  state.personnel.absences[0].status = 'cancelled';
  view = read();
  assert.equal(view.people[0].availabilityStatus, 'available');
  for (const secret of ['SECRET-DIAGNOSIS', 'SECRET-MANAGER', 'SECRET-LEAVE', 'sick', 'vab']) assert.equal(JSON.stringify(view).includes(secret), false);
});

test('availability observes actual order sessions, hides IDs without dual transport scope, and does not turn planned jobs into work', () => {
  const { state, add, stamp, read, startOrder } = fixture();
  const workorder = add('order-only', 'workorder'), clock = add('clock'), planned = add('planned', 'workorder');
  startOrder(workorder); startOrder(clock);
  stamp(clock, 'clock.in', '2026-10-13T05:00:00Z');
  state.transport.orders.push({ id: 'planned-booking', driverId: planned.driverId, siteId: 'norrtalje', status: 'booked', customerName: 'SECRET-CUSTOMER' });
  state.employeeTime.clockSessions.push({ id: 'old-clock', personId: planned.id, startedAt: '2026-10-12T05:00:00Z', endedAt: '2026-10-12T06:00:00Z', breaks: [], revision: 1 });
  const p = { actor: { id: 'admin', level: 'Systemadmin' }, user: manager('boss', ['norrtalje']) };
  let view = read(p);
  const byId = id => view.people.find(person => person.personId === id);
  assert.equal(byId('order-only').workStateSource, 'order');
  assert.equal(byId('order-only').isWorkingNow, true);
  assert.equal(byId('order-only').availabilityStatus, 'busy');
  assert.equal(byId('order-only').statusSince, '2026-10-13T07:00:00.000Z');
  assert.equal(byId('order-only').clockStatus, 'disabled');
  assert.equal(byId('order-only').activeOrderId, undefined);
  assert.equal(byId('clock').availabilityStatus, 'busy');
  assert.equal(byId('planned').hasActiveOrder, false);
  assert.equal(byId('planned').availabilityStatus, 'unknown');
  assert.equal(byId('planned').statusSince, null, 'disabled clock never reuses a stale historical out timestamp');
  view = read({ ...p, user: manager('boss', ['norrtalje'], ['personnelPresenceRead', 'transportRead']) });
  assert.equal(byId('order-only').activeOrderId, 'AO-order-only');
  state.employeeTime.orderSessions.find(value => value.personId === clock.id).siteId = 'rimbo';
  view = read({ ...p, user: manager('boss', ['norrtalje'], ['personnelPresenceRead', 'transportRead']) });
  assert.equal(byId('clock').activeOrderId, undefined, 'transport permission never grants another facility');
  stamp(clock, 'clock.pause', '2026-10-13T07:30:00Z');
  view = read();
  assert.equal(byId('clock').availabilityStatus, 'on_break', 'open order is not current work during actual break');
  stamp(clock, 'clock.out', now);
  view = read();
  assert.equal(byId('clock').availabilityStatus, 'not_clocked_in', 'an old activity start cannot override actual clock out');
  assert.equal(JSON.stringify(view).includes('SECRET-CUSTOMER'), false);
  assert.equal(JSON.stringify(view).includes('SECRET-JOB-NOTE'), false);
});

test('disabled or missing linked account and stale clock require review while raw clock-in evidence is retained', () => {
  const { state, add, stamp, read } = fixture();
  const disabled = add('disabled'), missing = add('missing'), stale = add('stale', 'clock', ['norrtalje'], '2026-10-10T05:00:00Z');
  stamp(disabled, 'clock.in', '2026-10-13T05:00:00Z'); stamp(missing, 'clock.in', '2026-10-13T05:00:00Z');
  stamp(stale, 'clock.in', '2026-10-10T05:00:00Z');
  state.pricing.users.find(user => user.id === disabled.userId).active = false;
  state.pricing.users = state.pricing.users.filter(user => user.id !== missing.userId);
  const view = read();
  for (const person of view.people) {
    assert.equal(person.isClockedIn, true);
    assert.equal(person.clockStatus, 'working');
    assert.equal(person.availabilityStatus, 'needs_review');
    assert.equal(person.isAvailableNow, false);
  }
  assert.equal(view.people.find(person => person.personId === stale.id).requiresCorrection, true);
  assert.equal(view.people.find(person => person.personId === disabled.id).requiresCorrection, false, 'account block is not a forged time correction');
  assert.equal(view.summary.needsReview, 3);
  assert.equal(view.summary.available, 0);
});

test('dated source plans and schedule observations cannot fabricate presence or activate future clock early', () => {
  const { state, add, stamp, read } = fixture();
  const person = add('a', 'workorder');
  employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: false, mode: 'schedule', timeSource: 'clock', revision: 2, effectiveFrom: '2026-10-14' } }, [], { now });
  const today = read().people[0];
  assert.equal(today.clockEnabled, false);
  assert.equal(today.isScheduledNow, true);
  assert.equal(today.availabilityStatus, 'unknown');
  assert.equal(today.isAvailableNow, null);
  assert.equal(read(admin, { now: '2026-10-13T10:30:00Z' }).people[0].isScheduledNow, false, 'Stockholm scheduled lunch is excluded');
  const tomorrow = read(admin, { now: '2026-10-14T08:00:00Z' }).people[0];
  assert.equal(tomorrow.clockEnabled, true);
  assert.equal(tomorrow.clockStatus, 'out');
  assert.equal(tomorrow.availabilityStatus, 'not_clocked_in');
  const weekend = read(admin, { now: '2026-10-17T08:00:00Z' }).people[0];
  assert.equal(weekend.clockStatus, 'off');
  assert.equal(weekend.isScheduledNow, false);
  const active = stamp(person, 'clock.in', '2026-10-17T08:00:00Z');
  assert.equal(active.clock.status, 'working');
  assert.equal(read(admin, { now: '2026-10-17T09:00:00Z' }).people[0].availabilityStatus, 'available', 'actually worked attendance is not erased by off-day schedule');
  assert.equal(state.employeeTime.settings[0].enabled, false, 'clock source and required-hour enforcement remain distinct');
});

test('trusted clock-in facility is immutable across preferences and corrections; historical foreign facility stays private', () => {
  const { state, add, stamp } = fixture();
  const person = add('a', 'clock', ['norrtalje', 'rimbo']);
  const started = stamp(person, 'clock.in', '2026-10-13T05:00:00Z', {}, { activeSiteId: 'norrtalje' });
  assert.equal(started.session.siteId, 'norrtalje');
  const paused = stamp(person, 'clock.pause', '2026-10-13T06:00:00Z', {}, { activeSiteId: 'rimbo' });
  assert.equal(paused.session.siteId, 'norrtalje');
  stamp(person, 'clock.resume', '2026-10-13T06:30:00Z', {}, { activeSiteId: 'rimbo' });
  stamp(person, 'clock.out', now, {}, { activeSiteId: 'rimbo' });
  const fixed = stamp(person, 'clock.correct', '2026-10-13T09:00:00Z', { sessionId: started.session.id, startedAt: '2026-10-13T05:00:00Z', endedAt: now,
    breaks: [{ startedAt: '2026-10-13T06:00:00Z', endedAt: '2026-10-13T06:30:00Z' }], reason: 'Kontrollerat pass.' }, { activeSiteId: 'rimbo' });
  assert.equal(fixed.session.siteId, 'norrtalje');
  assert.equal(state.employeeTime.clockSessions[0].siteId, 'norrtalje');
  person.siteIds = ['rimbo'];
  const view = employeeTimeProjection(state, person, { now, allowedSiteIds: ['rimbo'] });
  assert.equal(view.selectedDay.clockSessions[0].siteId, undefined);
  assert.equal(view.clockHistory[0].before.siteId, undefined);
  assert.equal(view.clockHistory[0].after.siteId, undefined);
  assert.equal(state.employeeTime.clockSessions[0].siteId, 'norrtalje', 'private projection never rewrites the historical snapshot');
  assert.equal(view.selectedDay.recordedMinutes, 150, 'personal historical time remains correct after site change');
  assert.throws(() => stamp(person, 'clock.in', '2026-10-13T10:00:00Z', { siteId: 'rimbo' }), error => error.status === 422);
  assert.throws(() => stamp(person, 'clock.in', '2026-10-13T10:00:00Z', {}, { activeSiteId: 'norrtalje' }), error => error.status === 403);
});

test('own presence does not require personnel-read and cannot select a different effective employee or invent legacy site', () => {
  const { state, add, stamp } = fixture();
  const person = add('a'); add('b');
  stamp(person, 'clock.in', '2026-10-13T05:00:00Z', {}, { activeSiteId: undefined });
  const view = employeePresenceForPerson(state, person, { now, effectiveUserId: person.userId, actualUserId: person.userId, allowedSiteIds: person.siteIds });
  assert.equal(view.personId, person.id);
  assert.equal(view.clockSiteId, undefined);
  assert.equal(view.activeOrderId, undefined);
  assert.equal(view.isClockedIn, true);
  assert.equal(view.availabilityStatus, 'available');
  assert.throws(() => employeePresenceForPerson(state, 'b', { now, effectiveUserId: person.userId }), error => error.status === 403);
});

test('overview ignores large foreign time histories without evaluating or leaking their session timestamps', () => {
  const { state, add, stamp, read } = fixture();
  const person = add('a'); stamp(person, 'clock.in', '2026-10-13T05:00:00Z');
  for (let i = 0; i < 10000; i++) state.employeeTime.clockSessions.push({ id: `foreign-${i}`, personId: `missing-person-${i}`,
    get startedAt() { throw new Error('Foreign session timestamp must never be evaluated for another person'); }, endedAt: null });
  const view = read();
  assert.equal(view.summary.total, 1);
  assert.equal(view.people[0].workSeconds, 180 * 60);
});
