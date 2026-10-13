import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureEmployeeTime, enrollEmployeeTime, employeeTimeToday, employeeTimeProjection,
  employeeTimeGate, employeeTimeCommand, employeeTimeLifecycle,
  employeeTimeRequirementCommand, employeeLeaveDecision,
  refreshEmployeeTimeNorms, employeeClockCommand, employeeClockProjection,
} from './employee-time.mjs';

const monday = { now: '2026-10-12T16:00:00Z' };
const tuesday = { now: '2026-10-13T16:00:00Z' };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const context = value => ({ ...value, siteCatalog: sites });
function fixture() {
  const person = { id: 'person-kalle', userId: 'kalle', name: 'Kalle Nilsson', kind: 'employee', active: true, role: 'Chaufför', team: 'Transport', siteIds: ['norrtalje'], driverId: 'driver-kalle', employeeNumber: 'P-12', phone: '0700000000', email: 'kalle@example.invalid' };
  const other = { ...person, id: 'person-lina', userId: 'lina', driverId: 'driver-lina', name: 'Lina' };
  const state = {
    personnel: { revision: 0, people: [person, other], employment: [{ personId: person.id, startDate: '2024-01-01', percentage: 100, hoursPerWeek: 40 }, { personId: other.id, startDate: '2024-01-01', percentage: 100, hoursPerWeek: 40 }], schedules: [person, other].map(p => ({ id: `schedule-${p.id}`, personId: p.id, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2024-01-01', revision: 1 })), absences: [], staffingTasks: [] },
    transport: { orders: [{ id: 'AO-1', customerName: 'Verkstad Nord', action: 'pickup', driverId: person.driverId, siteId: 'norrtalje', status: 'booked', date: '2026-10-12', startMinute: 480, durationMinutes: 60 }, { id: 'AO-2', customerName: 'Andras uppdrag', driverId: other.driverId, status: 'booked', date: '2026-10-12', startMinute: 600, durationMinutes: 60 }] },
    logistics: { details: {}, sites },
  };
  ensureEmployeeTime(state);
  return { state, person, other, audits: [] };
}
const fullDay = { date: '2026-10-12', startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'Gårdsarbete', siteId: 'norrtalje', note: 'Sortering och städning.' };
const admin = { user: { id: 'admin', level: 'Systemadmin', permissions: [] }, actor: { id: 'admin' } };

test('person/day read indexes exclude foreign history and never retain stale corrected hours', () => {
  const { state, person, other, audits } = fixture();
  enrollEmployeeTime(state, person, monday);
  const saved = employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, audits, context(tuesday));
  const baseline = employeeTimeProjection(state, person, context(tuesday));
  for (let i = 0; i < 10000; i++) state.employeeTime.entries.push({ ...saved.entry, id: `foreign-${i}`, personId: other.id });
  const before = JSON.stringify(state);
  assert.deepEqual(employeeTimeProjection(state, person, context(tuesday)), baseline);
  assert.equal(JSON.stringify(state), before);
  employeeTimeCommand(state, person, { action: 'time.remove', id: saved.entry.id, revision: saved.entry.revision }, audits, context(tuesday));
  const changed = employeeTimeProjection(state, person, context(tuesday));
  assert.equal(changed.gate.blocked, true);
  assert.equal(changed.selectedDay.recordedMinutes, 0);
});

test('first successful enrollment starts today; old employment never retroactively locks', () => {
  const { state, person } = fixture();
  assert.equal(employeeTimeGate(state, person, monday).blocked, false);
  assert.equal(employeeTimeProjection(state, person, monday).summary.missingMinutes, 0);
  const requirement = enrollEmployeeTime(state, person, monday);
  assert.equal(requirement.enforcementFrom, '2026-10-12');
  assert.equal(employeeTimeGate(state, person, monday).blocked, false);
  assert.deepEqual(employeeTimeGate(state, person, tuesday), { blocked: true, date: '2026-10-12', expectedMinutes: 480, recordedMinutes: 0, missingMinutes: 480 });
  enrollEmployeeTime(state, person, tuesday);
  assert.equal(state.employeeTime.settings.length, 1);
  assert.equal(state.employeeTime.settings[0].enforcementFrom, '2026-10-12');
});

test('durably saved manual gap hours release gate; stale changes and deletion recalculate it', () => {
  const { state, person, audits } = fixture(); enrollEmployeeTime(state, person, monday);
  const saved = employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, audits, context(tuesday));
  assert.equal(saved.gate.blocked, false);
  assert.equal(audits.at(-1).domain, 'employeeTime');
  // Existing aggregate JSON persistence retains all new fields without a whitelist.
  const recovered = JSON.parse(JSON.stringify(state));
  assert.equal(employeeTimeGate(recovered, person, tuesday).blocked, false);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, id: saved.entry.id, revision: 0 } }, audits, context(tuesday)), /annan session/);
  const removed = employeeTimeCommand(state, person, { action: 'time.remove', id: saved.entry.id, revision: saved.entry.revision }, audits, tuesday);
  assert.equal(removed.gate.blocked, true);
  assert.ok(state.employeeTime.entries[0].deletedAt);
  assert.equal(state.employeeTime.entries[0].revision, 2);
});

test('normal weekend skipped and earliest unresolved workday remains after later login', () => {
  const { state, person } = fixture();
  enrollEmployeeTime(state, person, { now: '2026-10-09T16:00:00Z' });
  const result = employeeTimeGate(state, person, { now: '2026-10-12T05:00:00Z' });
  assert.equal(result.date, '2026-10-09');
  employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, date: '2026-10-09' } }, [], context(monday));
  assert.equal(employeeTimeGate(state, person, monday).blocked, false);
  assert.equal(employeeTimeGate(state, person, { now: '2026-10-15T05:00:00Z' }).date, '2026-10-12');
});

test('registered full and partial absence reduce target but never become worked hours', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, monday);
  state.personnel.absences.push({ id: 'vab', personId: person.id, kind: 'vab', fromDate: '2026-10-12', toDate: '2026-10-12', allDay: false, startMinute: 780, endMinute: 900, status: 'registered' });
  let result = employeeTimeProjection(state, person, context({ ...tuesday, date: '2026-10-12' }));
  assert.equal(result.selectedDay.expectedMinutes, 360);
  assert.equal(result.selectedDay.absenceMinutes, 120);
  assert.equal(result.selectedDay.recordedMinutes, 0);
  // Overlapping absences are subtracted once; scheduled unpaid lunch not twice.
  state.personnel.absences.push({ id: 'sick', personId: person.id, kind: 'sick', fromDate: '2026-10-12', toDate: '2026-10-12', allDay: false, startMinute: 720, endMinute: 840, status: 'registered' });
  result = employeeTimeProjection(state, person, context({ ...tuesday, date: '2026-10-12' }));
  assert.equal(result.selectedDay.expectedMinutes, 360);
  state.personnel.absences[0].allDay = true;
  assert.equal(employeeTimeGate(state, person, tuesday).blocked, false);
  assert.equal(employeeTimeProjection(state, person, context({ ...tuesday, date: '2026-10-12' })).selectedDay.recordedMinutes, 0);
});

test('contracted part-time hours are not multiplied by employment percentage again', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, monday);
  Object.assign(state.personnel.employment[0], { percentage: 50, hoursPerWeek: 20 });
  refreshEmployeeTimeNorms(state, monday);
  assert.equal(employeeTimeGate(state, person, tuesday).expectedMinutes, 240);
  Object.assign(state.personnel.schedules[0], { endMinute: 660, lunchStart: undefined, lunchEnd: undefined });
  refreshEmployeeTimeNorms(state, monday);
  assert.equal(employeeTimeGate(state, person, tuesday).expectedMinutes, 240);
  state.personnel.employment[0].endDate = '2026-10-11';
  refreshEmployeeTimeNorms(state, monday);
  assert.equal(employeeTimeGate(state, person, tuesday).blocked, false);
});

test('contract and recurring schedule changes retain yesterday normative requirements', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, monday);
  Object.assign(state.personnel.employment[0], { percentage: 50, hoursPerWeek: 20 });
  Object.assign(state.personnel.schedules[0], { endMinute: 660, lunchStart: undefined, lunchEnd: undefined });
  refreshEmployeeTimeNorms(state, tuesday);
  const previous = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' }).selectedDay;
  const today = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-13' }).selectedDay;
  assert.equal(previous.expectedMinutes, 480);
  assert.equal(previous.schedules[0].endMinute, 960);
  assert.equal(today.expectedMinutes, 240);
  assert.equal(today.schedules[0].endMinute, 660);
  assert.equal(employeeTimeGate(state, person, tuesday).expectedMinutes, 480);
});

test('partial absence follows proportional contract cap when shared schedule is still full-time', () => {
  const { state, person } = fixture();
  state.personnel.employment[0].hoursPerWeek = 20;
  enrollEmployeeTime(state, person, monday);
  state.personnel.absences.push({ id: 'partial', personId: person.id, kind: 'sick', fromDate: '2026-10-12', toDate: '2026-10-12', allDay: false, startMinute: 420, endMinute: 660, status: 'registered' });
  const day = employeeTimeProjection(state, person, { ...monday, date: '2026-10-12' }).selectedDay;
  assert.equal(day.expectedMinutes, 120);
  assert.equal(day.absenceMinutes, 120);
});

test('entire unpaid shift has zero target with finite day and month totals', () => {
  const { state, person } = fixture();
  Object.assign(state.personnel.schedules[0], { lunchStart: 420, lunchEnd: 960 });
  enrollEmployeeTime(state, person, monday);
  const view = employeeTimeProjection(state, person, { ...monday, date: '2026-10-12' });
  assert.equal(view.selectedDay.expectedMinutes, 0);
  assert.equal(view.selectedDay.absenceMinutes, 0);
  assert.equal(Number.isFinite(view.summary.expectedMinutes), true);
});

test('fixed daily target is manager-controlled with effective version history', () => {
  const { state, person, audits } = fixture(); enrollEmployeeTime(state, person, monday);
  const input = { personId: person.id, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 360, revision: 1 } };
  assert.throws(() => employeeTimeRequirementCommand(state, { user: { id: 'kalle', level: 'Medarbetare', permissions: [] }, actor: { id: 'kalle' } }, input, audits, tuesday), /saknar behörighet/);
  assert.throws(() => employeeTimeRequirementCommand(state, { ...admin, actor: { id: 'other' } }, input, audits, tuesday), /saknar behörighet/);
  employeeTimeRequirementCommand(state, admin, input, audits, tuesday);
  // Monday retains 8h and Tuesday's policy becomes 6h.
  assert.equal(employeeTimeGate(state, person, tuesday).expectedMinutes, 480);
  assert.equal(employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-13' }).selectedDay.expectedMinutes, 360);
  assert.equal(state.employeeTime.requirementHistory.length, 2);
  assert.throws(() => employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 1, revision: 2, effectiveFrom: '2026-10-12' } }, [], tuesday), /tidigast från idag/);
});

test('manual time rejects wrong owner, foreign order/site, future time and overlaps', () => {
  const { state, person, other } = fixture();
  const saved = employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, [], context(monday));
  assert.throws(() => employeeTimeCommand(state, other, { action: 'time.remove', id: saved.entry.id, revision: 1 }, [], monday), /egen tid/);
  assert.throws(() => employeeTimeCommand(state, other, { action: 'time.save', entry: { ...fullDay, id: saved.entry.id, revision: 1 } }, [], context(monday)), /egen tid/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, orderId: 'AO-2' } }, [], context(monday)), /inte tilldelad dig/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, siteId: 'rimbo' } }, [], context(monday)), /anläggning/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, date: '2026-10-13' } }, [], context(monday)), /redan har arbetats/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, endMinute: 1200 } }, [], context(monday)), /redan har arbetats/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, startMinute: 720, endMinute: 780, breakMinutes: 0 } }, [], context(monday)), /överlappar/);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, startMinute: 960, endMinute: 1020, breakMinutes: 0, personId: other.id } }, [], context(monday)), /personId/);
});

test('only actual start/stop contributes order time; planned done status does not', () => {
  const { state, person } = fixture();
  enrollEmployeeTime(state, person, monday);
  state.transport.orders[0].status = 'done';
  assert.equal(employeeTimeProjection(state, person, context({ ...monday, date: '2026-10-12' })).selectedDay.recordedMinutes, 0);
  state.transport.orders[0].status = 'booked';
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-12T06:00:00Z' });
  assert.equal(employeeTimeProjection(state, person, context({ ...monday, date: '2026-10-12' })).selectedDay.recordedMinutes, 0);
  const completed = employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-12T07:15:00Z' });
  assert.equal(completed.session.personId, person.id);
  const day = employeeTimeProjection(state, person, context({ ...monday, date: '2026-10-12' })).selectedDay;
  assert.equal(day.recordedMinutes, 75);
  assert.equal(day.automaticMinutes, 75);
  assert.equal(day.entries[0].source, 'order');
  assert.equal(day.entries[0].orderName, 'Verkstad Nord');
  const count = state.employeeTime.orderSessions.length;
  employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], monday);
  assert.equal(state.employeeTime.orderSessions.length, count);
});

test('stored performer can stop after order reassignment; replacement gets no historic hours', () => {
  const { state, person, other } = fixture();
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-12T06:00:00Z' });
  state.transport.orders[0].driverId = other.driverId;
  assert.throws(() => employeeTimeLifecycle(state, other, 'AO-1', 'stop', [], { now: '2026-10-12T07:00:00Z' }), /ingen startad tid/);
  employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-12T07:00:00Z' });
  assert.equal(employeeTimeProjection(state, person, { ...monday, date: '2026-10-12' }).selectedDay.recordedMinutes, 60);
  assert.equal(employeeTimeProjection(state, other, { ...monday, date: '2026-10-12' }).selectedDay.recordedMinutes, 0);
});

test('automatic and manual time do not double-count and ongoing session blocks manual overlap', () => {
  const { state, person } = fixture();
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-12T06:00:00Z' });
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, startMinute: 480, endMinute: 540, breakMinutes: 0 } }, [], context(monday)), /pågående uppdragstiden/);
  employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-12T07:00:00Z' });
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, startMinute: 480, endMinute: 540, breakMinutes: 0 } }, [], context(monday)), /överlappar/);
  employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, startMinute: 540, endMinute: 960, breakMinutes: 60 } }, [], context(monday));
  const day = employeeTimeProjection(state, person, { ...monday, date: '2026-10-12' }).selectedDay;
  assert.equal(day.recordedMinutes, 420);
  assert.equal(day.automaticMinutes, 60);
  assert.equal(day.manualMinutes, 360);
  // Defensive projection union also handles a legacy imported overlapping row.
  state.employeeTime.entries.push({ ...fullDay, id: 'legacy', personId: person.id, revision: 1, startMinute: 480, endMinute: 540, breakMinutes: 0 });
  assert.equal(employeeTimeProjection(state, person, { ...monday, date: '2026-10-12' }).selectedDay.recordedMinutes, 420);
});

test('actual overnight sessions split across Stockholm dates, preserving DST elapsed hours', () => {
  const { state, person } = fixture();
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-24T21:00:00Z' }); // 23:00 Saturday
  employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-25T03:00:00Z' }); // 04:00 Sunday after fold
  const first = employeeTimeProjection(state, person, { now: '2026-10-26T12:00:00Z', date: '2026-10-24' }).selectedDay;
  const second = employeeTimeProjection(state, person, { now: '2026-10-26T12:00:00Z', date: '2026-10-25' }).selectedDay;
  assert.equal(first.recordedMinutes, 60);
  assert.equal(second.recordedMinutes, 300);
  assert.equal(first.entries[0].endMinute, 1440);
  assert.equal(second.entries[0].startMinute, 0);
  assert.equal(first.recordedMinutes + second.recordedMinutes, 360);
  assert.equal(employeeTimeToday({ now: '2026-10-12T22:30:00Z' }), '2026-10-13');
});

test('overnight break cannot be silently allocated to the wrong daily requirement', () => {
  const { state, person } = fixture();
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-12T20:00:00Z' });
  assert.throws(() => employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-13T00:00:00Z', breakMinutes: 60 }), /pass över midnatt/);
  assert.equal(state.employeeTime.orderSessions[0].endedAt, undefined);
});

test('nonexistent local spring clock is rejected for manual entry', () => {
  const { state, person } = fixture();
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, date: '2026-03-29', startMinute: 150, endMinute: 210, breakMinutes: 0 } }, [], context(monday)), /finns inte/);
});

test('ambiguous winter clock cannot create artificially longer manual work time', () => {
  const { state, person } = fixture();
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.save', entry: { ...fullDay, date: '2026-10-25', startMinute: 135, endMinute: 150, breakMinutes: 0 } }, [], context({ now: '2026-10-26T12:00:00Z' })), /förekommer två gånger/);
  assert.equal(state.employeeTime.entries.length, 0);
});

test('ordinary personnel managers cannot reduce their own requirement or approve own leave', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, monday);
  const manager = { user: { id: person.userId, level: 'Medarbetare', permissions: ['employmentWrite', 'absenceWrite'] }, actor: { id: person.userId } };
  assert.throws(() => employeeTimeRequirementCommand(state, manager, { personId: person.id, requirement: { enabled: false, mode: 'schedule', revision: 1 } }, [], monday), /eget timkrav/);
  const { request } = employeeTimeCommand(state, person, { action: 'leave.request', request: { kind: 'holiday', fromDate: '2026-10-14', toDate: '2026-10-14', allDay: true } }, [], monday);
  assert.throws(() => employeeLeaveDecision(state, manager, { id: request.id, revision: 1, decision: 'approve' }, [], monday), /egen ledighetsansökan/);
});

test('own projection exposes assigned jobs and real monthly totals without salaries or other employee data', () => {
  const { state, person, other } = fixture();
  state.personnel.salaries = [{ personId: person.id, amount: 99999 }];
  employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, [], context(monday));
  employeeTimeCommand(state, other, { action: 'time.save', entry: fullDay }, [], context(monday));
  const result = employeeTimeProjection(state, person, context({ ...monday, date: '2026-10-12', month: '2026-10' }));
  assert.equal(result.days.length, 31);
  assert.equal(result.summary.recordedMinutes, 480);
  assert.equal(result.orders.length, 1);
  assert.equal(result.selectedDay.entries.length, 1);
  assert.equal(result.selectedDay.entries[0].intervals, undefined);
  assert.equal(result.person.salary, undefined);
  assert.equal(JSON.stringify(result).includes('99999'), false);
  assert.deepEqual(result.sites, [{ id: 'norrtalje', name: 'Norrtälje' }]);
  assert.deepEqual(result.balances, { available: false });
});

test('leave requests stay pending and do not exempt worked-hours gate before manager approval', () => {
  const { state, person, other, audits } = fixture(); enrollEmployeeTime(state, person, monday);
  const { request } = employeeTimeCommand(state, person, { action: 'leave.request', request: { kind: 'holiday', fromDate: '2026-10-12', toDate: '2026-10-12', allDay: true, note: 'Ledig.' } }, audits, monday);
  assert.equal(request.status, 'pending');
  assert.equal(state.personnel.absences.length, 0);
  assert.equal(employeeTimeGate(state, person, tuesday).blocked, true);
  assert.throws(() => employeeTimeCommand(state, other, { action: 'leave.cancel', id: request.id, revision: 1 }, audits, monday), /egen ansökan/);
  const manager = { user: { id: 'boss', level: 'Medarbetare', permissions: ['absenceWrite'], siteIds: ['norrtalje'] }, actor: { id: 'boss' } };
  employeeLeaveDecision(state, manager, { id: request.id, revision: 1, decision: 'approve' }, audits, monday);
  assert.equal(state.personnel.absences.length, 1);
  assert.equal(state.personnel.absences[0].kind, 'holiday');
  assert.equal(employeeTimeGate(state, person, tuesday).blocked, false);
  assert.equal(employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' }).selectedDay.recordedMinutes, 0);
  assert.throws(() => employeeLeaveDecision(state, manager, { id: request.id, revision: 1, decision: 'approve' }, audits, monday), /redan behandlats/);
});

test('employees cannot approve leave or report another person/external profile', () => {
  const { state, person, other } = fixture();
  other.kind = 'external';
  assert.throws(() => enrollEmployeeTime(state, other, monday), /aktiv anställd/);
  const { request } = employeeTimeCommand(state, person, { action: 'leave.request', request: { kind: 'leave', fromDate: '2026-10-14', toDate: '2026-10-14', allDay: true } }, [], monday);
  const own = { user: { id: person.userId, level: 'Medarbetare', permissions: [] }, actor: { id: person.userId } };
  assert.throws(() => employeeLeaveDecision(state, own, { id: request.id, revision: 1, decision: 'approve' }, [], monday), /saknar behörighet/);
  employeeTimeCommand(state, person, { action: 'leave.cancel', id: request.id, revision: 1 }, [], monday);
  assert.equal(state.employeeTime.leaveRequests[0].status, 'cancelled');
  assert.equal(state.personnel.absences.length, 0);
});

function clockFixture(now = '2026-10-12T05:00:00Z') {
  const value = fixture();
  enrollEmployeeTime(value.state, value.person, { now });
  employeeTimeRequirementCommand(value.state, admin, { personId: value.person.id,
    requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: 1 } }, [], { now });
  let sequence = 0;
  value.stamp = (action, at, extra = {}) => employeeClockCommand(value.state, value.person, {
    action, requestId: `clock-test-${++sequence}`, revision: employeeClockProjection(value.state, value.person, { now: at }).revision,
    ...extra,
  }, value.audits, { now: at, actualUserId: value.person.userId, effectiveUserId: value.person.userId });
  return value;
}

const realMonday = {
  startedAt: '2026-10-12T05:00:00Z', endedAt: '2026-10-12T14:00:00Z',
  breaks: [{ startedAt: '2026-10-12T10:00:00Z', endedAt: '2026-10-12T11:00:00Z' }],
  reason: 'Glömde stämpla, verkliga arbetstider kontrollerade.',
};

test('server clock survives closed app and reload, with multiple actual breaks and daily passes', () => {
  const { state, person, stamp, audits } = clockFixture();
  const started = stamp('clock.in', '2026-10-12T05:00:00Z');
  assert.equal(started.clock.status, 'working');
  assert.equal(started.clock.activeSession.startedAt, '2026-10-12T05:00:00.000Z');
  assert.equal(employeeClockProjection(JSON.parse(JSON.stringify(state)), person, { now: '2026-10-12T06:30:00Z' }).workSeconds, 90 * 60);
  assert.equal(stamp('clock.pause', '2026-10-12T10:00:00Z').clock.status, 'break');
  stamp('clock.resume', '2026-10-12T10:30:00Z');
  stamp('clock.pause', '2026-10-12T12:00:00Z');
  stamp('clock.resume', '2026-10-12T12:15:00Z');
  const stopped = stamp('clock.out', '2026-10-12T14:00:00Z');
  assert.equal(stopped.session.workSeconds, 495 * 60);
  assert.equal(stopped.session.breakSeconds, 45 * 60);
  assert.equal(stopped.session.provisional, false);
  assert.equal(stopped.clock.activeSession, null);
  stamp('clock.in', '2026-10-12T15:00:00Z');
  stamp('clock.out', '2026-10-12T16:00:00Z');
  const recovered = JSON.parse(JSON.stringify(state));
  const before = JSON.stringify(recovered);
  const view = employeeTimeProjection(recovered, person, { ...tuesday, date: '2026-10-12' });
  assert.equal(JSON.stringify(recovered), before, 'read projection must not persist derived clock time');
  assert.equal(view.clock.revision, 8);
  assert.equal(view.selectedDay.clockSessions.length, 2);
  assert.equal(view.selectedDay.recordedMinutes, 555);
  assert.equal(view.selectedDay.breakMinutes, 45);
  assert.equal(view.selectedDay.unallocatedMinutes, 555);
  assert.equal(view.gate.blocked, false);
  assert.equal(view.clockHistory.length, 8);
  assert.equal(audits.length, 8);
});

test('clock double-click retries bind payload and both principals; stale concurrent actions never append extra passes', () => {
  const { state, person, audits } = clockFixture();
  const cmd = { action: 'clock.in', requestId: 'same-in', revision: 0 };
  const scoped = { now: '2026-10-12T05:00:00Z', actualUserId: person.userId, effectiveUserId: person.userId };
  const first = employeeClockCommand(state, person, cmd, audits, scoped);
  const retry = employeeClockCommand(state, person, cmd, audits, { ...scoped, now: '2026-10-12T06:00:00Z' });
  assert.equal(retry.session.id, first.session.id);
  assert.equal(retry.clock.workSeconds, 60 * 60);
  assert.equal(state.employeeTime.clockSessions.length, 1);
  assert.equal(audits.length, 1);
  assert.throws(() => employeeClockCommand(state, person, { ...cmd, action: 'clock.pause' }, audits, scoped), /andra uppgifter/);
  assert.throws(() => employeeClockCommand(state, person, { ...cmd, requestId: 'parallel-in' }, audits, scoped), /annan session/);
  assert.throws(() => employeeClockCommand(state, person, cmd, audits, { ...scoped, actualUserId: 'other-admin' }), /annan användare/);
  assert.throws(() => employeeClockCommand(state, person, { action: 'clock.pause', requestId: 'fake-time', revision: 1, startedAt: '2026-10-12T04:00:00Z' }, audits, scoped), /serverns klocka/);
  assert.throws(() => employeeClockCommand(state, person, { action: 'clock.out', requestId: 'wrong-person', revision: 1 }, audits, { ...scoped, effectiveUserId: 'other', management: true }), /egen tid/);
  assert.equal(employeeClockProjection(state, person, scoped).revision, 1);
});

test('clock attendance is the sole hour source and only real corrected past time releases its gate', () => {
  const { state, person, stamp } = clockFixture();
  employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, [], context(tuesday));
  assert.equal(employeeTimeGate(state, person, tuesday).missingMinutes, 480, 'activity alone cannot invent attendance');
  assert.equal(employeeTimeGate(state, person, tuesday).timeSource, 'clock');
  const saved = stamp('clock.correct', tuesday.now, realMonday);
  assert.equal(saved.gate.blocked, false);
  const view = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' });
  assert.equal(view.selectedDay.timeSource, 'clock');
  assert.equal(view.selectedDay.recordedMinutes, 480);
  assert.equal(view.summary.recordedMinutes, 480, 'manual allocation is not another payable 480 minutes');
  assert.equal(view.clock.activeSession, null);
  const shorter = stamp('clock.correct', tuesday.now, { ...realMonday, sessionId: saved.session.id, endedAt: '2026-10-12T13:00:00Z' });
  assert.equal(shorter.gate.recordedMinutes, 420);
  assert.equal(shorter.gate.missingMinutes, 60);
  assert.equal(state.employeeTime.audit.at(-1).before.endedAt, '2026-10-12T14:00:00.000Z');
  assert.equal(state.employeeTime.audit.at(-1).after.endedAt, '2026-10-12T13:00:00.000Z');
});

test('clock corrections reject malformed, future, oversized, overlapping and foreign sessions without changing revision', () => {
  const { state, person, other, stamp } = clockFixture();
  for (const payload of [
    { ...realMonday, startedAt: 'bad-time' },
    { ...realMonday, startedAt: '2000-01-01T00:00:00Z' },
    { ...realMonday, endedAt: '2026-10-14T14:00:00Z' },
    { ...realMonday, reason: '   ' },
    { ...realMonday, breaks: [{ startedAt: '2026-10-12T04:00:00Z', endedAt: '2026-10-12T05:30:00Z' }] },
    { ...realMonday, breaks: [{ startedAt: '2026-10-12T11:00:00Z', endedAt: '2026-10-12T12:00:00Z' }, { startedAt: '2026-10-12T10:00:00Z', endedAt: '2026-10-12T11:30:00Z' }] },
  ]) assert.throws(() => stamp('clock.correct', tuesday.now, payload), error => error.status === 422 && !(error instanceof RangeError));
  assert.equal(employeeClockProjection(state, person, tuesday).revision, 0);
  const saved = stamp('clock.correct', tuesday.now, realMonday);
  assert.throws(() => stamp('clock.correct', tuesday.now, { ...realMonday, startedAt: '2026-10-12T13:30:00Z', endedAt: '2026-10-12T15:00:00Z', breaks: [] }), /överlappar/);
  assert.throws(() => employeeClockCommand(state, other, { action: 'clock.correct', requestId: 'foreign-session', revision: 0, ...realMonday, sessionId: saved.session.id }, [], { ...tuesday, effectiveUserId: other.userId }), /valda personens tid/);
  assert.throws(() => stamp('clock.correct', tuesday.now, { ...realMonday, startedAt: '2026-10-11T05:00:00Z', endedAt: '2026-10-11T14:00:00Z', breaks: [] }), /tidskälla/);
  assert.equal(employeeClockProjection(state, person, tuesday).revision, 1);
  assert.equal(state.employeeTime.clockSessions.length, 1);
});

test('clock allocation intersects attendance and actual lunch, never double-counting order or imported manual intervals', () => {
  const { state, person, stamp } = clockFixture();
  stamp('clock.correct', tuesday.now, realMonday);
  employeeTimeLifecycle(state, person, 'AO-1', 'start', [], { now: '2026-10-12T09:00:00Z' });
  employeeTimeLifecycle(state, person, 'AO-1', 'stop', [], { now: '2026-10-12T12:00:00Z' });
  state.employeeTime.entries.push({ ...fullDay, id: 'legacy-allocation', personId: person.id, revision: 1, startMinute: 600, endMinute: 960, breakMinutes: 0 });
  const day = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' }).selectedDay;
  assert.equal(day.recordedMinutes, 480);
  assert.equal(day.automaticMinutes, 120, 'actual lunch is subtracted from the 3h order');
  assert.equal(day.allocatedMinutes, 300, 'overlapping activity allocation is united once');
  assert.equal(day.manualMinutes, 180);
  assert.equal(day.unallocatedMinutes, 180);
  assert.equal(day.automaticMinutes + day.manualMinutes + day.unallocatedMinutes, day.recordedMinutes);
});

test('historically dated source changes preserve workorder hours and future replacement never resurrects cancelled plans', () => {
  const { state, person } = fixture();
  enrollEmployeeTime(state, person, monday);
  employeeTimeCommand(state, person, { action: 'time.save', entry: fullDay }, [], context(monday));
  const change = employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: 1 } }, [], monday);
  assert.equal(change.requirement.effectiveFrom, '2026-10-13');
  assert.equal(employeeTimeProjection(state, person, monday).clock.enabled, false);
  assert.equal(employeeTimeProjection(state, person, monday).configuredRequirement.timeSource, 'clock');
  assert.equal(employeeTimeProjection(state, person, monday).timeSourceChange.earliestEffectiveFrom, '2026-10-13');
  assert.throws(() => employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', effectiveFrom: '2026-10-12', revision: 2 } }, [], monday), /tidigast imorgon/);
  const pendingEdit = employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'fixed', dailyMinutes: 360, revision: 2 } }, [], monday);
  assert.equal(pendingEdit.requirement.timeSource, 'clock', 'legacy save without timeSource preserves the configured choice');
  assert.equal(pendingEdit.requirement.effectiveFrom, '2026-10-13', 'pending source must not silently become active today');
  const tomorrow = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' });
  assert.equal(tomorrow.clock.enabled, true);
  assert.equal(tomorrow.selectedDay.timeSource, 'workorder');
  assert.equal(tomorrow.selectedDay.recordedMinutes, 480);
  assert.equal(tomorrow.gate.blocked, false);
  employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'workorder', effectiveFrom: '2026-10-14', revision: 3 } }, [], monday);
  const cancelledPlan = employeeTimeProjection(JSON.parse(JSON.stringify(state)), person, tuesday);
  assert.equal(cancelledPlan.clock.source, 'workorder', 'superseded Oct13 clock plan cannot resurface before new Oct14 plan');
  assert.equal(cancelledPlan.selectedDay.recordedMinutes, 0);
  assert.equal(cancelledPlan.days.find(day => day.date === '2026-10-12').recordedMinutes, 480);
});

test('active order or clock prevents same-day source replacement and active clock requires out before scheduling a switch', () => {
  const f = fixture(); enrollEmployeeTime(f.state, f.person, monday);
  employeeTimeLifecycle(f.state, f.person, 'AO-1', 'start', [], { now: '2026-10-12T06:00:00Z' });
  assert.throws(() => employeeTimeRequirementCommand(f.state, admin, { personId: f.person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', effectiveFrom: '2026-10-12', revision: 1 } }, [], monday), /tidigast imorgon/);
  const { state, person, stamp } = clockFixture(); stamp('clock.in', '2026-10-12T05:00:00Z');
  assert.throws(() => employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'workorder', revision: 2 } }, [], monday), /Stämpla ut/);
});

test('scheduled source change at midnight cannot trap an active overnight pass or duplicate attendance', () => {
  const { state, person, stamp } = clockFixture();
  employeeTimeRequirementCommand(state, admin, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'workorder', effectiveFrom: '2026-10-13', revision: 2 } }, [], { now: '2026-10-12T06:00:00Z' });
  stamp('clock.in', '2026-10-12T21:00:00Z');
  const overnight = employeeClockProjection(state, person, { now: '2026-10-13T00:00:00Z' });
  assert.equal(overnight.source, 'workorder');
  assert.equal(overnight.enabled, true, 'active overnight controls remain available');
  stamp('clock.pause', '2026-10-13T00:00:00Z');
  stamp('clock.resume', '2026-10-13T00:15:00Z');
  const out = stamp('clock.out', '2026-10-13T01:00:00Z');
  assert.equal(out.clock.enabled, false);
  assert.equal(out.session.workSeconds, 225 * 60);
  const corrected = stamp('clock.correct', tuesday.now, { sessionId: out.session.id, startedAt: '2026-10-12T21:00:00Z', endedAt: '2026-10-13T01:00:00Z', breaks: [{ startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:15:00Z' }], reason: 'Kontrollerat nattpass.' });
  assert.equal(corrected.session.workSeconds, 225 * 60);
  assert.equal(employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' }).selectedDay.recordedMinutes, 60);
  assert.equal(employeeTimeProjection(state, person, tuesday).selectedDay.recordedMinutes, 0, 'workorder day ignores separate attendance source');
  assert.throws(() => stamp('clock.in', tuesday.now), /inte vald/);
});

test('unfinished previous-day clock never clears gate; overlong out remains possible but requires actual correction', () => {
  const { state, person, stamp } = clockFixture();
  const first = stamp('clock.in', '2026-10-12T05:00:00Z');
  const yesterday = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' });
  assert.equal(yesterday.selectedDay.recordedMinutes, 0);
  assert.equal(yesterday.selectedDay.clockSessions[0].provisional, true);
  assert.equal(yesterday.gate.missingMinutes, 480);
  assert.equal(yesterday.clock.activeSession.id, first.session.id);
  assert.equal(employeeTimeProjection(state, person, { now: '2026-10-14T06:00:00Z' }).clock.requiresCorrection, true);
  const stopped = stamp('clock.out', '2026-10-14T06:00:00Z');
  assert.equal(stopped.clock.activeSession, null);
  assert.equal(stopped.session.requiresCorrection, true);
  assert.equal(employeeTimeGate(state, person, { now: '2026-10-14T06:00:00Z' }).recordedMinutes, 0);
  stamp('clock.correct', '2026-10-14T06:00:00Z', { ...realMonday, sessionId: first.session.id });
  const fixed = employeeTimeProjection(state, person, { now: '2026-10-14T06:00:00Z', date: '2026-10-12' });
  assert.equal(fixed.selectedDay.recordedMinutes, 480);
  assert.equal(fixed.selectedDay.clockSessions[0].requiresCorrection, false);
  assert.equal(fixed.gate.date, '2026-10-13');
});

test('actual midnight breaks and Stockholm DST folds/gaps split the correct real elapsed minutes', () => {
  for (const [start, end, firstDate, nextDate, expectedFirst, expectedNext] of [
    ['2026-10-24T21:00:00Z', '2026-10-25T03:00:00Z', '2026-10-24', '2026-10-25', 60, 300],
    ['2026-03-28T22:00:00Z', '2026-03-29T02:00:00Z', '2026-03-28', '2026-03-29', 60, 180],
  ]) {
    const { state, person, stamp } = clockFixture(start);
    stamp('clock.in', start); stamp('clock.out', end);
    const first = employeeTimeProjection(state, person, { now: end, date: firstDate, month: firstDate.slice(0, 7) }).selectedDay;
    const second = employeeTimeProjection(state, person, { now: end, date: nextDate }).selectedDay;
    assert.equal(first.recordedMinutes, expectedFirst);
    assert.equal(second.recordedMinutes, expectedNext);
  }
  const { state, person, stamp } = clockFixture('2026-10-12T20:00:00Z');
  stamp('clock.in', '2026-10-12T20:00:00Z');
  stamp('clock.pause', '2026-10-12T21:30:00Z');
  stamp('clock.resume', '2026-10-12T22:30:00Z');
  stamp('clock.out', '2026-10-13T00:00:00Z');
  const first = employeeTimeProjection(state, person, { ...tuesday, date: '2026-10-12' }).selectedDay;
  const second = employeeTimeProjection(state, person, tuesday).selectedDay;
  assert.equal(first.recordedMinutes, 90);
  assert.equal(second.recordedMinutes, 90);
  assert.equal(first.breakMinutes, 30);
  assert.equal(second.breakMinutes, 30);
});

test('authorised dual-principal managers have complete target-site checks and corrections retain actual/effective attribution', () => {
  const { state, person, stamp } = clockFixture();
  const manager = { user: { id: 'boss', level: 'VD', permissions: ['employmentWrite'], siteIds: ['norrtalje'] }, actor: { id: 'systemadmin', level: 'Systemadmin', siteIds: ['norrtalje'] } };
  employeeTimeRequirementCommand(state, manager, { personId: person.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: 2 } }, [], monday);
  assert.equal(state.employeeTime.audit.at(-1).actualUserId, 'systemadmin');
  assert.equal(state.employeeTime.audit.at(-1).effectiveUserId, 'boss');
  const command = { action: 'clock.correct', requestId: 'manager-fix', revision: 0, ...realMonday };
  const trusted = { ...tuesday, management: true, actualUserId: 'systemadmin', effectiveUserId: 'boss', allowedSiteIds: ['norrtalje'] };
  const corrected = employeeClockCommand(state, person, command, [], trusted);
  const event = state.employeeTime.audit.at(-1);
  assert.equal(event.actorId, 'boss');
  assert.equal(event.actualUserId, 'systemadmin');
  assert.equal(event.effectiveUserId, 'boss');
  assert.equal(event.personId, person.id);
  assert.equal(corrected.gate.blocked, false);
  assert.throws(() => employeeClockCommand(state, person, command, [], { ...trusted, actualUserId: 'different-systemadmin' }), /annan användare/);
  const otherPerson = state.personnel.people[1];
  otherPerson.siteIds = ['norrtalje', 'rimbo'];
  assert.throws(() => employeeTimeRequirementCommand(state, manager, { personId: otherPerson.id, requirement: { enabled: true, mode: 'schedule', timeSource: 'clock' } }, [], monday), /anläggning/);
  assert.throws(() => employeeTimeRequirementCommand(state, { ...manager, user: { ...manager.user, permissions: [] } }, { personId: person.id, requirement: { enabled: true, mode: 'schedule', revision: 3 } }, [], monday), /saknar behörighet/);
  const regular = { user: { id: person.userId, level: 'VD', permissions: ['employmentWrite'], siteIds: ['norrtalje'] }, actor: manager.actor };
  assert.throws(() => employeeTimeRequirementCommand(state, regular, { personId: person.id, requirement: { enabled: false, mode: 'schedule', revision: 3 } }, [], monday), /eget timkrav/);
  stamp('clock.correct', tuesday.now, { sessionId: corrected.session.id, ...realMonday });
});
