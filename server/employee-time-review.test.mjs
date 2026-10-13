import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeTimeReviewOwn, employeeTimeReviewDetail, employeeTimeReviewList,
  employeeTimeReviewEmployeeCommand, employeeTimeReviewStaffCommand, employeeTimeReviewApproved,
  employeeTimeReviewSourceStamp, assertEmployeeTimeReviewSourceStamp } from './employee-time-review.mjs';
import { ensureEmployeeTime, enrollEmployeeTime, employeeTimeCommand, employeeTimeGate,
  employeeTimeRequirementCommand, employeeClockCommand, refreshEmployeeTimeNorms } from './employee-time.mjs';

const month = '2026-09';
const now = '2026-10-01T16:00:00Z';
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const boss = { id: 'boss', name: 'Ansvarig', level: 'VD', active: true, permissions: ['personnelRead', 'personnelTimeReviewRead', 'personnelTimeApprove'], siteIds: ['norrtalje'] };
const principal = { actor: boss, user: boss };
const admin = { id: 'admin', level: 'Systemadmin', active: true };
function fixture() {
  const person = { id: 'p-1', userId: 'u-1', name: 'Anställd', active: true, kind: 'employee', siteIds: ['norrtalje'], team: 'Gården', employeeNumber: 'P-1' };
  const other = { ...person, id: 'p-2', userId: 'u-2', name: 'Annan' };
  const state = { pricing: { revision: 1, users: [{ id: person.userId, active: true, level: 'Medarbetare', permissions: ['view'] }, boss, admin] },
    personnel: { revision: 1, people: [person, other], employment: [person, other].map(p => ({ personId: p.id, startDate: '2024-01-01', hoursPerWeek: 40 })),
      schedules: [person, other].map(p => ({ id: `sch-${p.id}`, personId: p.id, revision: 1, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2024-01-01' })), absences: [] }, logistics: { sites, details: {} }, transport: { orders: [] } };
  ensureEmployeeTime(state); enrollEmployeeTime(state, person, { now: '2026-09-01T05:00:00Z' });
  employeeTimeCommand(state, person, { action: 'time.save', entry: { date: '2026-09-01', startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'Gårdsarbete', note: 'SECRET-TIME-NOTE', siteId: 'norrtalje' } }, [], { now });
  const context = { now, month, siteCatalog: sites, actualUserId: person.userId, effectiveUserId: person.userId, allowedSiteIds: person.siteIds };
  let sequence = 0;
  const own = () => employeeTimeReviewOwn(state, person, context);
  const send = (action, extra = {}, ctx = context) => employeeTimeReviewEmployeeCommand(state, person, { action, month, requestId: `own-${++sequence}`, revision: employeeTimeReviewOwn(state, person, ctx).review.revision, ...extra }, [], ctx);
  const act = (action, extra = {}, p = principal) => employeeTimeReviewStaffCommand(state, p, { action, personId: person.id, month,
    requestId: `staff-${++sequence}`, revision: employeeTimeReviewDetail(state, p, person, context).review.revision, ...extra }, [], context);
  return { state, person, other, context, own, send, act };
}

test('ended-period submit freezes a private-safe canonical snapshot, exact retries do not create versions and withdraw unlocks edits', () => {
  const { state, person, context, own, send } = fixture();
  const draft = own(), before = JSON.stringify(state);
  assert.equal(draft.review.status, 'draft');
  assert.equal(draft.review.revision, 0);
  assert.equal(draft.capabilities.canSubmit, true);
  assert.equal(draft.period.summary.recordedMinutes, 480);
  assert.ok(draft.period.issues.some(issue => issue.code === 'missing_time'));
  assert.equal(JSON.stringify(state), before, 'GET never creates review records');
  const cmd = { action: 'review.submit', month, revision: 0, requestId: 'stable-submit' };
  const sent = employeeTimeReviewEmployeeCommand(state, person, cmd, [], context);
  assert.equal(sent.review.status, 'submitted');
  assert.equal(sent.review.version, 1);
  assert.equal(sent.period.source, 'submitted');
  assert.equal(sent.review.stale, false);
  assert.equal(sent.capabilities.canWithdraw, true);
  const retry = employeeTimeReviewEmployeeCommand(state, person, cmd, [], { ...context, now: '2026-10-02T16:00:00Z' });
  assert.equal(retry.review.version, 1);
  assert.equal(state.employeeTime.reviewEvents.length, 1);
  assert.equal(JSON.stringify(sent).includes('SECRET-TIME-NOTE'), false);
  assert.equal(sent.period.sourceSiteIds, undefined);
  assert.throws(() => employeeTimeCommand(state, person, { action: 'time.remove', id: state.employeeTime.entries[0].id, revision: 1 }, [], context), error => error.status === 423);
  const withdrawn = send('review.withdraw');
  assert.equal(withdrawn.review.status, 'draft');
  assert.equal(withdrawn.versions.length, 1, 'withdraw never deletes the prior submission');
  employeeTimeCommand(state, person, { action: 'time.remove', id: state.employeeTime.entries[0].id, revision: 1 }, [], context);
  assert.equal(send('review.submit').review.version, 2);
});

test('approval needs a reason for accepted real-hours deviations, freezes export and releases only the approved-month gate', () => {
  const { state, person, context, send, act } = fixture();
  send('review.submit');
  assert.equal(employeeTimeGate(state, person, context).blocked, true);
  assert.throws(() => act('review.approve'), /anledning/);
  const approved = act('review.approve', { reason: 'Verkligt arbetade timmar och avvikelsen granskade.' });
  assert.equal(approved.review.status, 'approved');
  assert.ok(approved.period.summary.missingMinutes > 0);
  assert.equal(approved.period.summary.recordedMinutes, 480);
  assert.equal(employeeTimeGate(state, person, context).blocked, false, 'acceptance releases gate without inventing hours');
  const originalHash = approved.period.sourceHash;
  const exported = employeeTimeReviewApproved(state, principal, { month, now, personIds: [person.id] });
  assert.equal(exported.reports[0].period.sourceHash, originalHash);
  assert.equal(exported.reports[0].review.approvedBy, boss.id);
  assert.equal(exported.reports[0].review.approvedActualUserId, boss.id);
  state.employeeTime.entries[0].endMinute = 900; // Simulated out-of-band legacy change, never a valid edit API.
  state.personnel.people[0].name = 'Nytt namn';
  const preserved = employeeTimeReviewDetail(state, principal, person, context);
  assert.equal(preserved.period.sourceHash, originalHash);
  assert.equal(preserved.period.summary.recordedMinutes, 480);
  assert.equal(employeeTimeReviewApproved(state, principal, { month, now }).reports[0].person.name, 'Anställd');
  assert.throws(() => act('review.reopen'), /anledning/);
  const reopened = act('review.reopen', { reason: 'Rätta verklig sluttid efter kontroll.' });
  assert.equal(reopened.review.status, 'reopened');
  assert.equal(reopened.versions[0].approvedAt, approved.review.approvedAt);
  assert.equal(reopened.capabilities.canExport, false);
  assert.equal(reopened.capabilities.canExportHistory, true);
  assert.equal(employeeTimeGate(state, person, context).blocked, true);
  assert.throws(() => employeeTimeReviewApproved(state, principal, { month, now, personIds: [person.id] }), error => error.status === 409);
  const history = employeeTimeReviewApproved(state, principal, { month, now, personIds: [person.id], version: 1 });
  assert.equal(history.reports[0].historical, true);
  assert.equal(history.reports[0].latestStatus, 'reopened');
  assert.equal(history.reports[0].review.version, 1);
  assert.equal(history.reports[0].review.approvedAt, approved.review.approvedAt);
  assert.equal(history.reports[0].period.summary.recordedMinutes, 480);
  const resubmitted = send('review.submit');
  assert.equal(resubmitted.review.version, 2);
  assert.equal(resubmitted.period.summary.recordedMinutes, 420);
  assert.notEqual(resubmitted.period.sourceHash, originalHash);
  assert.equal(act('review.approve', { reason: 'Rättade faktiska timmar granskade.' }).review.version, 2);
});

test('submitted-source mismatch fails closed, return retains old snapshot and resubmission calculates a new version', () => {
  const { state, send, act } = fixture();
  const submitted = send('review.submit');
  state.employeeTime.entries[0].revision += 1;
  state.employeeTime.entries[0].endMinute = 900;
  const read = employeeTimeReviewDetail(state, principal, 'p-1', { now, month });
  assert.equal(read.review.stale, true);
  assert.equal(read.period.summary.recordedMinutes, 480, 'staff sees exactly what was submitted');
  assert.equal(read.capabilities.canApprove, false);
  assert.throws(() => act('review.approve', { reason: 'Granskad.' }), error => error.status === 409);
  const returned = act('review.return', { reason: 'Kontrollera korrigerad sluttid.' });
  assert.equal(returned.review.status, 'returned');
  assert.equal(returned.period.source, 'live');
  assert.equal(returned.period.summary.recordedMinutes, 420);
  assert.equal(returned.versions[0].sourceHash, submitted.period.sourceHash);
  const next = send('review.submit');
  assert.equal(next.review.version, 2);
  assert.notEqual(next.period.sourceHash, submitted.period.sourceHash);
});

test('explicit dual rights, full current and historical site scopes, and every ownership identity protect payroll approval', () => {
  const { state, person, context, send, act } = fixture();
  send('review.submit');
  assert.throws(() => employeeTimeReviewList(state, { actor: boss, user: { ...boss, permissions: ['personnelRead'] } }, context), error => error.status === 403);
  assert.throws(() => employeeTimeReviewStaffCommand(state, { actor: boss, user: { ...boss, permissions: ['personnelRead', 'personnelTimeReviewRead'] } }, { action: 'review.approve', personId: person.id, month, revision: 1, requestId: 'forbidden', reason: 'Granskat.' }, [], context), error => error.status === 403);
  const employeeAdmin = { ...admin, id: person.userId };
  assert.throws(() => act('review.approve', { reason: 'Egen kontroll.' }, { actor: employeeAdmin, user: employeeAdmin }), /egen tidrapport/);
  assert.throws(() => act('review.approve', { reason: 'Egen kontroll.' }, { actor: employeeAdmin, user: boss }), /egen tidrapport/);
  person.userId = 'new-account';
  assert.throws(() => act('review.approve', { reason: 'Omkopplat konto.' }, { actor: employeeAdmin, user: boss }), /egen tidrapport/);
  const currentOwner = { ...admin, id: person.userId };
  assert.throws(() => act('review.approve', { reason: 'Egen kontroll.' }, { actor: currentOwner, user: boss }), /egen tidrapport/);
  person.siteIds = ['norrtalje', 'rimbo'];
  assert.throws(() => employeeTimeReviewDetail(state, principal, person, context), error => error.status === 403);
  person.siteIds = ['norrtalje'];
  state.employeeTime.reviews[0].snapshots[0].period.sourceSiteIds.push('rimbo');
  assert.equal(employeeTimeReviewDetail(state, principal, person, context).capabilities.canApprove, false);
  assert.throws(() => act('review.approve', { reason: 'Granskat.' }), error => error.status === 403);
  const legacy = fixture(); delete legacy.person.userId;
  employeeTimeReviewEmployeeCommand(legacy.state, legacy.person, { action: 'review.submit', month, revision: 0, requestId: 'legacy-submit' }, [], {
    ...legacy.context, actualUserId: legacy.person.id, effectiveUserId: legacy.person.id,
  });
  legacy.person.userId = 'relinked-person';
  assert.throws(() => employeeTimeReviewStaffCommand(legacy.state, { actor: { ...admin, id: legacy.person.id }, user: boss }, {
    action: 'review.approve', personId: legacy.person.id, month, revision: 1, requestId: 'legacy-self-approve', reason: 'Egen kontroll.',
  }, [], legacy.context), /egen tidrapport/);
});

test('current/future months are preview-only; actual open intersecting order/clock or correction blocks ended submission', () => {
  const { state, person, context, send } = fixture();
  for (const target of ['2026-10', '2026-11']) {
    const view = employeeTimeReviewOwn(state, person, { ...context, month: target });
    assert.equal(view.capabilities.canSubmit, false);
    assert.equal(view.period.issues[0].code, 'period_not_closed');
    assert.throws(() => send('review.submit', { month: target, revision: 0 }), /avslutad/);
  }
  state.employeeTime.orderSessions.push({ id: 'ongoing', personId: person.id, orderId: 'AO', startedAt: '2026-08-31T20:00:00Z', revision: 1 });
  assert.throws(() => send('review.submit'), /pågående pass/);
  state.employeeTime.orderSessions[0].endedAt = '2026-09-01T00:00:00Z';
  state.employeeTime.clockSessions.push({ id: 'open-clock', personId: person.id, startedAt: '2026-09-30T20:00:00Z', endedAt: null, breaks: [], revision: 1 });
  assert.throws(() => send('review.submit'), /pågående pass/);
  state.employeeTime.clockSessions[0].endedAt = '2026-10-01T00:00:00Z';
  state.employeeTime.clockSessions[0].requiresCorrection = true;
  assert.throws(() => send('review.submit'), /rätta stämplingar/);
  state.employeeTime.clockSessions[0].requiresCorrection = false;
  assert.equal(send('review.submit').review.status, 'submitted');
});

test('source hashes ignore global revisions and cosmetics but preserve attendance, allocation, historical requirements and normative versions', () => {
  const { state, person, context, own, send } = fixture();
  const before = own().period.sourceHash;
  state.employeeTime.revision += 50; state.pricing.revision += 20;
  person.name = 'Ny kontaktetikett'; person.team = 'Annat'; person.siteIds = ['norrtalje', 'rimbo'];
  state.pricing.users[0].permissions.push('transportRead');
  state.employeeTime.entries[0].note = 'Ändrad privat kommentar';
  assert.equal(own().period.sourceHash, before);
  state.employeeTime.entries[0].endMinute = 900;
  assert.notEqual(own().period.sourceHash, before);
  state.employeeTime.entries[0].endMinute = 960;
  send('review.submit');
  const stamp = employeeTimeReviewSourceStamp(state, [person.id], context);
  state.personnel.people[0].name = 'Kosmetisk ändring';
  state.personnel.people[0].siteIds = ['norrtalje'];
  assert.doesNotThrow(() => assertEmployeeTimeReviewSourceStamp(state, stamp, context));
  state.personnel.absences.push({ id: 'absence', personId: person.id, revision: 1, status: 'registered', kind: 'sick', note: 'SECRET-MEDICAL', fromDate: '2026-09-02', toDate: '2026-09-02', allDay: true });
  assert.throws(() => assertEmployeeTimeReviewSourceStamp(state, stamp, context), error => error.status === 409);
  const legacy = fixture();
  legacy.state.transport.orders.push({ id: 'legacy-order', siteId: 'norrtalje', customerName: 'Cosmetic name' });
  legacy.state.employeeTime.orderSessions.push({ id: 'legacy-session', personId: legacy.person.id, orderId: 'legacy-order', revision: 1,
    startedAt: '2026-09-03T05:00:00Z', endedAt: '2026-09-03T06:00:00Z' });
  legacy.send('review.submit');
  const legacyStamp = employeeTimeReviewSourceStamp(legacy.state, [legacy.person.id], legacy.context);
  legacy.state.transport.orders[0].customerName = 'Another cosmetic name';
  assert.doesNotThrow(() => assertEmployeeTimeReviewSourceStamp(legacy.state, legacyStamp, legacy.context));
  legacy.state.transport.orders[0].siteId = 'rimbo';
  assert.equal(legacy.own().review.stale, true, 'changed legacy site provenance invalidates a submission even with unchanged worked minutes');
  assert.throws(() => assertEmployeeTimeReviewSourceStamp(legacy.state, legacyStamp, legacy.context), error => error.status === 409);
});

test('canonical before/after guard allows future norms and unrelated writes even if saved submission was already stale', () => {
  const { state, person, context, send } = fixture();
  send('review.submit');
  state.employeeTime.entries[0].endMinute = 900; // An existing upstream mismatch is not a blanket write lock.
  let stamp = employeeTimeReviewSourceStamp(state, [person.id], context);
  state.personnel.employment[0].hoursPerWeek = 20;
  refreshEmployeeTimeNorms(state, context);
  assert.doesNotThrow(() => assertEmployeeTimeReviewSourceStamp(state, stamp, context), 'September keeps its prior normative version');
  stamp = employeeTimeReviewSourceStamp(state, [person.id], context);
  state.employeeTime.requirementHistory[0].timeSource = 'clock';
  assert.throws(() => assertEmployeeTimeReviewSourceStamp(state, stamp, context), error => error.status === 409);
  const fallback = fixture(); fallback.send('review.submit');
  fallback.state.employeeTime.normativeHistory = [];
  const fallbackStamp = employeeTimeReviewSourceStamp(fallback.state, [fallback.person.id], fallback.context);
  fallback.state.personnel.schedules[0].endMinute = 900;
  assert.throws(() => assertEmployeeTimeReviewSourceStamp(fallback.state, fallbackStamp, fallback.context), error => error.status === 409);
});

test('exact review retries bind action and both principals and cannot reapply an old approval after reopen', () => {
  const { state, person, context, send, act } = fixture();
  send('review.submit');
  const command = { action: 'review.approve', personId: person.id, month, revision: 1, requestId: 'approval-id', reason: 'Verkliga timmar granskade.' };
  employeeTimeReviewStaffCommand(state, principal, command, [], context);
  const eventCount = state.employeeTime.reviewEvents.length;
  employeeTimeReviewStaffCommand(state, principal, command, [], context);
  assert.equal(state.employeeTime.reviewEvents.length, eventCount);
  assert.throws(() => employeeTimeReviewStaffCommand(state, principal, { ...command, reason: 'Annan text.' }, [], context), error => error.status === 409);
  assert.throws(() => employeeTimeReviewStaffCommand(state, { actor: admin, user: boss }, command, [], context), error => error.status === 409);
  act('review.reopen', { reason: 'Ny kontroll behövs.' });
  const retryAfterReopen = employeeTimeReviewStaffCommand(state, principal, command, [], context);
  assert.equal(retryAfterReopen.review.status, 'reopened');
  assert.equal(state.employeeTime.reviewEvents.length, eventCount + 1);
});

test('clock attendance is never added to allocations; protected detail has no causes, notes or linked customer activity', () => {
  const { state, person, context } = fixture();
  state.employeeTime.entries = [];
  employeeTimeRequirementCommand(state, { actor: admin, user: admin }, { personId: person.id,
    requirement: { enabled: true, mode: 'schedule', timeSource: 'clock', revision: 1 } }, [], { now: '2026-09-01T05:00:00Z' });
  employeeClockCommand(state, person, { action: 'clock.correct', requestId: 'real-clock', revision: 0, startedAt: '2026-09-01T05:00:00Z', endedAt: '2026-09-01T14:00:00Z',
    breaks: [{ startedAt: '2026-09-01T10:00:00Z', endedAt: '2026-09-01T11:00:00Z' }], reason: 'SECRET-CORRECTION-REASON' }, [], context);
  state.employeeTime.entries.push({ id: 'allocation', personId: person.id, date: '2026-09-01', revision: 1, startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'SECRET-CUSTOMER-ACTIVITY', orderId: 'AO', siteId: 'norrtalje', note: 'SECRET-NOTE' });
  state.personnel.absences.push({ id: 'absence', personId: person.id, revision: 1, status: 'registered', kind: 'sick', note: 'SECRET-MEDICAL', fromDate: '2026-09-02', toDate: '2026-09-02', allDay: true });
  const view = employeeTimeReviewDetail(state, principal, person, context);
  assert.equal(view.period.summary.recordedMinutes, 480);
  assert.ok(view.period.summary.allocatedMinutes <= 480);
  assert.equal(view.period.days[0].entries[0].activity, 'Uppdrag');
  assert.equal(view.period.days[0].entries[0].orderId, undefined);
  for (const value of ['SECRET-NOTE', 'SECRET-MEDICAL', 'SECRET-CUSTOMER-ACTIVITY', 'SECRET-CORRECTION-REASON', 'sick']) assert.equal(JSON.stringify(view).includes(value), false);
});

test('archived employees keep approved originals available, and historic exports preserve selected approval metadata', () => {
  const { state, person, context, send, act } = fixture();
  send('review.submit'); const first = act('review.approve', { reason: 'Avvikelse kontrollerad.' });
  act('review.reopen', { reason: 'Ny version begärd.' });
  send('review.submit'); act('review.approve', { reason: 'Ny version granskad.' });
  person.active = false;
  const list = employeeTimeReviewList(state, principal, context);
  assert.ok(list.people.some(value => value.personId === person.id));
  assert.equal(list.people.some(value => value.personId === 'p-2'), true);
  assert.equal(employeeTimeReviewDetail(state, principal, person, context).review.status, 'approved');
  const previous = employeeTimeReviewApproved(state, principal, { now: '2026-10-02T16:00:00Z', month, version: 1, personIds: [person.id] }).reports[0];
  assert.equal(previous.review.version, 1);
  assert.equal(previous.review.approvedAt, first.review.approvedAt);
  assert.equal(previous.review.reason, 'Avvikelse kontrollerad.');
  assert.equal(previous.period.sourceHash, first.period.sourceHash);
  assert.equal(previous.historical, true);
  assert.equal(previous.review.approvedActualUserId, boss.id);
  state.employeeTime.reviews[0].snapshots[0].person.siteIds.push('rimbo');
  const scopedHistory = employeeTimeReviewApproved(state, principal, { now, month, version: 1, personIds: [person.id] }).reports[0];
  assert.deepEqual(scopedHistory.person.siteIds, ['norrtalje'], 'historical unused membership is not revealed outside the current reviewer scope');
  assert.throws(() => employeeTimeReviewApproved(state, principal, { now, month, version: 1 }), error => error.status === 422);
});
