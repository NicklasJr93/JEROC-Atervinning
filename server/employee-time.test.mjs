import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureEmployeeTime, enrollEmployeeTime, employeeTimeToday, employeeTimeProjection,
  employeeTimeGate, employeeTimeCommand, employeeTimeLifecycle,
  employeeTimeRequirementCommand, employeeLeaveDecision,
  refreshEmployeeTimeNorms,
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
