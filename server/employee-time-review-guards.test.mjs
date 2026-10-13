import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureEmployeeTime,
  enrollEmployeeTime,
  employeeTimeCommand,
  employeeTimeLifecycle,
  employeeTimeRequirementCommand,
  employeeTimeProjection,
  employeeTimeBootstrapProjection,
  employeeClockCommand,
  employeeClockProjection,
  assertEmployeeTimeEditable,
  assertEmployeeTimeRangeEditable,
} from './employee-time.mjs';

const now = '2026-10-13T16:00:00Z';
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }];
const admin = { user: { id: 'admin', level: 'Systemadmin', permissions: [] }, actor: { id: 'admin' } };

function fixture({ source = 'workorder', enabled = false, enrollmentAt = '2026-09-01T05:00:00Z' } = {}) {
  const person = {
    id: 'person-kalle', userId: 'kalle', name: 'Kalle Nilsson', kind: 'employee', active: true,
    role: 'Chaufför', team: 'Transport', siteIds: ['norrtalje'], driverId: 'driver-kalle',
    employeeNumber: 'P-12', phone: '0700000000', email: 'kalle@example.invalid',
  };
  const other = { ...person, id: 'person-lina', userId: 'lina', name: 'Lina Eriksson', driverId: 'driver-lina' };
  const state = {
    personnel: {
      revision: 0, people: [person, other],
      employment: [person, other].map(value => ({
        personId: value.id, startDate: '2024-01-01', percentage: 100, hoursPerWeek: 40,
      })),
      schedules: [person, other].map(value => ({
        id: `schedule-${value.id}`, personId: value.id, weekdays: [1, 2, 3, 4, 5],
        startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780,
        effectiveFrom: '2024-01-01', revision: 1,
      })),
      absences: [], staffingTasks: [],
    },
    transport: { orders: [{
      id: 'AO-1', customerName: 'Verkstad Nord', action: 'pickup', driverId: person.driverId,
      siteId: 'norrtalje', status: 'booked', date: '2026-09-30', startMinute: 480, durationMinutes: 60,
    }] },
    logistics: { details: {}, sites },
  };
  ensureEmployeeTime(state);
  enrollEmployeeTime(state, person, { now: enrollmentAt, enabled });
  if (source === 'clock') employeeTimeRequirementCommand(state, admin, {
    personId: person.id, requirement: { enabled, mode: 'schedule', timeSource: source, revision: 1 },
  }, [], { now: enrollmentAt });
  const audits = [];
  let sequence = 0;
  const context = at => ({ now: at, siteCatalog: sites, actualUserId: person.userId, effectiveUserId: person.userId });
  return {
    state, person, other, audits, context,
    stamp: (action, at, extra = {}) => employeeClockCommand(state, person, {
      action, requestId: `review-guard-${++sequence}`,
      revision: employeeClockProjection(state, person, context(at)).revision,
      ...extra,
    }, audits, context(at)),
  };
}

function lock(value, month = '2026-09', status = 'submitted', personId = value.person.id) {
  value.state.employeeTime.reviews ??= [];
  value.state.employeeTime.reviews.push({
    id: `review-${personId}-${month}`, personId, month, status, revision: 1,
  });
}

function rejectedWithoutChanges(value, operation) {
  const before = structuredClone(value.state), auditBefore = structuredClone(value.audits);
  assert.throws(operation, error => error.status === 423, 'a locked month must report HTTP 423');
  assert.deepEqual(value.state, before, 'rejection must leave persisted source data and revisions unchanged');
  assert.deepEqual(value.audits, auditBefore, 'rejection must not append a transaction event');
}

function manual(date, extra = {}) {
  return {
    date, startMinute: 420, endMinute: 480, breakMinutes: 0,
    activity: 'Gårdsarbete', siteId: 'norrtalje', note: 'Verklig sorteringstid.', ...extra,
  };
}

function saveManual(value, entry) {
  return employeeTimeCommand(value.state, value.person, { action: 'time.save', entry }, value.audits, value.context(now));
}

function correctedPass(date, extra = {}) {
  return {
    startedAt: `${date}T07:00:00+02:00`, endedAt: `${date}T08:00:00+02:00`,
    breaks: [], reason: 'Verkliga tider kontrollerade.', ...extra,
  };
}

test('date and range guards lock only the same employee and submitted or approved months', () => {
  for (const status of ['submitted', 'approved']) {
    const value = fixture();
    lock(value, '2026-09', status);
    rejectedWithoutChanges(value, () => assertEmployeeTimeEditable(value.state, value.person, ['2026-10-12', '2026-09-30']));
    rejectedWithoutChanges(value, () => assertEmployeeTimeRangeEditable(value.state, value.person.id, '2026-08-31', '2026-10-01'));
    assert.doesNotThrow(() => assertEmployeeTimeEditable(value.state, value.person.id, ['2026-10-12']));
    assert.doesNotThrow(() => assertEmployeeTimeRangeEditable(value.state, value.other, '2026-09-01', '2026-09-30'));
  }
  for (const status of ['draft', 'returned', 'reopened']) {
    const value = fixture();
    lock(value, '2026-09', status);
    assert.doesNotThrow(() => assertEmployeeTimeEditable(value.state, value.person, ['2026-09-30']));
    assert.doesNotThrow(() => assertEmployeeTimeRangeEditable(value.state, value.person, '2026-08-31', '2026-10-01'));
  }
});

test('manual creation and deletion cannot change locked month totals or history', () => {
  for (const status of ['submitted', 'approved']) {
    const value = fixture();
    const { entry } = saveManual(value, manual('2026-09-30'));
    lock(value, '2026-09', status);
    rejectedWithoutChanges(value, () => saveManual(value, manual('2026-09-29')));
    rejectedWithoutChanges(value, () => employeeTimeCommand(value.state, value.person, {
      action: 'time.remove', id: entry.id, revision: entry.revision,
    }, value.audits, value.context(now)));
    assert.equal(value.state.employeeTime.entries[0].deletedAt, undefined);
  }
});

test('manual moves check both the former date and destination date', () => {
  for (const status of ['submitted', 'approved']) for (const [oldDate, newDate] of [
    ['2026-09-30', '2026-10-12'], ['2026-10-12', '2026-09-30'],
  ]) {
    const value = fixture();
    const { entry } = saveManual(value, manual(oldDate));
    lock(value, '2026-09', status);
    rejectedWithoutChanges(value, () => saveManual(value, manual(newDate, { id: entry.id, revision: entry.revision })));
  }
});

test('returned and reopened months allow durable manual corrections again', () => {
  for (const status of ['returned', 'reopened']) {
    const value = fixture();
    const { entry } = saveManual(value, manual('2026-09-30'));
    lock(value, '2026-09', status);
    const changed = saveManual(value, manual('2026-09-30', { id: entry.id, revision: entry.revision, endMinute: 540 }));
    assert.equal(changed.entry.revision, entry.revision + 1);
    assert.equal(employeeTimeProjection(value.state, value.person, {
      ...value.context(now), month: '2026-09', date: '2026-09-30',
    }).selectedDay.recordedMinutes, 120);
  }
});

test('new clock corrections and moved passes check locked old and new dates', () => {
  for (const status of ['submitted', 'approved']) {
    const empty = fixture({ source: 'clock' });
    lock(empty, '2026-09', status);
    rejectedWithoutChanges(empty, () => empty.stamp('clock.correct', now, correctedPass('2026-09-30')));
    for (const [oldDate, newDate] of [
      ['2026-09-30', '2026-10-12'], ['2026-10-12', '2026-09-30'],
    ]) {
      const value = fixture({ source: 'clock' });
      const saved = value.stamp('clock.correct', now, correctedPass(oldDate));
      lock(value, '2026-09', status);
      rejectedWithoutChanges(value, () => value.stamp('clock.correct', now, correctedPass(newDate, { sessionId: saved.session.id })));
    }
  }
});

test('clock correction checks every touched month of old and replacement overnight passes', () => {
  for (const [oldPass, newPass] of [
    [correctedPass('2026-09-29'), { startedAt: '2026-09-30T23:00:00+02:00', endedAt: '2026-10-01T01:00:00+02:00' }],
    [{ startedAt: '2026-09-30T23:00:00+02:00', endedAt: '2026-10-01T01:00:00+02:00' }, correctedPass('2026-09-29')],
  ]) {
    const value = fixture({ source: 'clock' });
    const saved = value.stamp('clock.correct', now, { ...correctedPass('2026-09-29'), ...oldPass });
    lock(value, '2026-10', 'approved');
    rejectedWithoutChanges(value, () => value.stamp('clock.correct', now, {
      ...correctedPass('2026-09-29'), ...newPass, sessionId: saved.session.id,
    }));
  }
});

test('runtime clock out and order stop cannot append attendance across a locked month', () => {
  for (const status of ['submitted', 'approved']) for (const month of ['2026-09', '2026-10']) {
    const clockValue = fixture({ source: 'clock' });
    clockValue.stamp('clock.in', '2026-09-30T23:00:00+02:00');
    lock(clockValue, month, status);
    rejectedWithoutChanges(clockValue, () => clockValue.stamp('clock.out', '2026-10-01T01:00:00+02:00'));
    const orderValue = fixture();
    employeeTimeLifecycle(orderValue.state, orderValue.person, 'AO-1', 'start', orderValue.audits,
      orderValue.context('2026-09-30T23:00:00+02:00'));
    lock(orderValue, month, status);
    rejectedWithoutChanges(orderValue, () => employeeTimeLifecycle(orderValue.state, orderValue.person, 'AO-1', 'stop',
      orderValue.audits, orderValue.context('2026-10-01T01:00:00+02:00')));
  }
});

test('a previous locked month does not prevent normal current-day clock or manual work', () => {
  const value = fixture({ source: 'clock' });
  lock(value, '2026-09', 'approved');
  const started = value.stamp('clock.in', '2026-10-13T05:00:00Z');
  assert.equal(started.clock.status, 'working');
  value.stamp('clock.pause', '2026-10-13T06:00:00Z');
  value.stamp('clock.resume', '2026-10-13T06:15:00Z');
  const stopped = value.stamp('clock.out', '2026-10-13T07:00:00Z');
  assert.equal(stopped.session.workSeconds, 105 * 60);
  const saved = saveManual(value, manual('2026-10-13'));
  assert.equal(saved.entry.date, '2026-10-13');
});

test('an exact Stockholm midnight end excludes the following locked month', () => {
  const corrected = fixture({ source: 'clock' });
  lock(corrected, '2026-10', 'approved');
  assert.equal(corrected.stamp('clock.correct', now, {
    ...correctedPass('2026-09-30'), startedAt: '2026-09-30T23:00:00+02:00', endedAt: '2026-10-01T00:00:00+02:00',
  }).session.workSeconds, 60 * 60);

  const runtime = fixture({ source: 'clock' });
  runtime.stamp('clock.in', '2026-09-30T23:00:00+02:00');
  lock(runtime, '2026-10', 'submitted');
  assert.equal(runtime.stamp('clock.out', '2026-10-01T00:00:00+02:00').session.workSeconds, 60 * 60);

  const order = fixture();
  employeeTimeLifecycle(order.state, order.person, 'AO-1', 'start', order.audits, order.context('2026-09-30T23:00:00+02:00'));
  lock(order, '2026-10', 'approved');
  const stopped = employeeTimeLifecycle(order.state, order.person, 'AO-1', 'stop', order.audits, order.context('2026-10-01T00:00:00+02:00'));
  assert.equal(stopped.session.endedAt, '2026-09-30T22:00:00.000Z');
});

test('an exact actor-bound clock retry succeeds after locking without another mutation', () => {
  const value = fixture({ source: 'clock' });
  value.stamp('clock.in', '2026-09-30T05:00:00Z');
  const command = { action: 'clock.out', requestId: 'closed-before-lock', revision: 1 };
  const saved = employeeClockCommand(value.state, value.person, command, value.audits, value.context('2026-09-30T06:00:00Z'));
  lock(value, '2026-09', 'approved');
  const before = structuredClone(value.state), auditBefore = structuredClone(value.audits);
  const retry = employeeClockCommand(value.state, value.person, command, value.audits, value.context(now));
  assert.equal(retry.session.id, saved.session.id);
  assert.deepEqual(value.state, before);
  assert.deepEqual(value.audits, auditBefore);
  assert.throws(() => employeeClockCommand(value.state, value.person, command, value.audits,
    { ...value.context(now), actualUserId: 'another-admin' }), error => error.status === 409);
});

test('a stop retry for an already closed order succeeds after locking without changing source hours', () => {
  const value = fixture();
  employeeTimeLifecycle(value.state, value.person, 'AO-1', 'start', value.audits, value.context('2026-09-30T05:00:00Z'));
  const saved = employeeTimeLifecycle(value.state, value.person, 'AO-1', 'stop', value.audits, value.context('2026-09-30T06:00:00Z'));
  lock(value, '2026-09', 'submitted');
  const before = structuredClone(value.state), auditBefore = structuredClone(value.audits);
  const retry = employeeTimeLifecycle(value.state, value.person, 'AO-1', 'stop', value.audits, value.context(now));
  assert.deepEqual(retry.session, saved.session);
  assert.deepEqual(value.state, before);
  assert.deepEqual(value.audits, auditBefore);
});

test('bootstrap reads today only while retaining current clock, requirement and previous-day gate', () => {
  const value = fixture({ source: 'clock', enabled: true, enrollmentAt: '2026-10-12T05:00:00Z' });
  value.stamp('clock.in', '2026-10-13T05:00:00Z');
  value.stamp('clock.pause', '2026-10-13T06:00:00Z');
  employeeTimeCommand(value.state, value.person, { action: 'leave.request', request: {
    kind: 'leave', fromDate: '2026-10-14', toDate: '2026-10-14', allDay: true,
  } }, value.audits, value.context(now));
  const full = employeeTimeProjection(value.state, value.person, value.context(now));
  const before = structuredClone(value.state);
  const bootstrap = employeeTimeBootstrapProjection(value.state, value.person, value.context(now));
  assert.equal(bootstrap.today, '2026-10-13');
  assert.equal(bootstrap.month, '2026-10');
  assert.equal(bootstrap.date, bootstrap.today);
  assert.equal(bootstrap.monthLoaded, false);
  assert.deepEqual(bootstrap.days, [full.days.find(day => day.date === bootstrap.today)]);
  assert.deepEqual(bootstrap.clock, full.clock);
  assert.deepEqual(bootstrap.requirement, full.requirement);
  assert.deepEqual(bootstrap.configuredRequirement, full.configuredRequirement);
  assert.deepEqual(bootstrap.gate, full.gate);
  assert.equal(bootstrap.gate.date, '2026-10-12');
  assert.equal(bootstrap.gate.missingMinutes, 480);
  assert.equal(bootstrap.selectedDay.date, bootstrap.today);
  assert.equal(bootstrap.selectedDay.recordedMinutes, 60);
  assert.deepEqual(bootstrap.selectedDay.clockSessions, full.selectedDay.clockSessions);
  assert.deepEqual(bootstrap.clockHistory, []);
  assert.deepEqual(bootstrap.leaveRequests, []);
  assert.ok(full.clockHistory.length > 0);
  assert.equal(full.leaveRequests.length, 1);
  assert.deepEqual(value.state, before, 'light projection must not persist derived hours or clear the gate');
});

test('bootstrap follows the new Stockholm day after reload and ignores another employee history', () => {
  const value = fixture({ source: 'clock' });
  value.stamp('clock.in', '2026-10-12T21:00:00Z');
  value.state.employeeTime.clockSessions.push({
    id: 'foreign-session', personId: value.other.id, startedAt: '2026-10-12T05:00:00Z',
    endedAt: null, breaks: [], revision: 1,
  });
  lock(value, '2026-09', 'submitted', value.other.id);
  const restored = JSON.parse(JSON.stringify(value.state));
  const context = value.context('2026-10-12T22:30:00Z');
  const full = employeeTimeProjection(restored, value.person, context);
  const before = structuredClone(restored);
  const bootstrap = employeeTimeBootstrapProjection(restored, value.person.id, context);
  assert.equal(bootstrap.today, '2026-10-13');
  assert.equal(bootstrap.date, bootstrap.today);
  assert.equal(bootstrap.days.length, 1);
  assert.deepEqual(bootstrap.clock, full.clock);
  assert.equal(bootstrap.selectedDay.recordedMinutes, 30);
  assert.equal(bootstrap.selectedDay.clockSessions.length, 1);
  assert.notEqual(bootstrap.clock.activeSession.id, 'foreign-session');
  assert.deepEqual(bootstrap.gate, full.gate);
  assert.deepEqual(restored, before);
});
