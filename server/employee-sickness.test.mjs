import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureEmployeeSickness, employeeSicknessCommand, employeeSicknessProjection,
  sicknessManagementCommand, sicknessManagementProjection, sicknessPayUnderlay, refreshSicknessAbsences,
  calculateSicknessLedger, assertSicknessWorkAllowed, recordSicknessPayUnderlay } from './employee-sickness.mjs';
import { ensureEmployeeTime, employeeClockCommand, employeeTimeCommand, employeeTimeGate, enrollEmployeeTime } from './employee-time.mjs';

const personId = 'person-niklas', userId = 'niklas';
const adminUser = { id: 'admin', name: 'Admin', level: 'Systemadmin', permissions: [], active: true };
const admin = { actor: adminUser, user: adminUser };
let requestSequence = 0;
const requestId = () => `req-sick-${++requestSequence}`;
const ctx = (day = '2026-10-12', time = '04:30:00') => ({ now: `${day}T${time}Z`, effectiveUserId: userId, actualUserId: userId, activeSiteId: 'norrtalje', siteCatalog: [{ id: 'norrtalje', name: 'Norrtälje', active: true }] });
const profile = { personId, revision: 0, effectiveFrom: '2026-01-01', hourlyBase: 100, averageWeeklyHours: 40, sickPayRate: 0.8, confirmed: true, source: 'Anställningsavtal och fastställd sjuklöneregel' };
function fixture(ready = true) {
  const person = { id: personId, userId, name: 'Niklas', active: true, kind: 'employee', siteIds: ['norrtalje'], driverId: 'driver-niklas' };
  const state = { personnel: { version: 1, revision: 0, people: [person, { ...person, id: 'other', userId: 'other', name: 'Other', siteIds: ['rimbo'] }],
    employment: [{ personId, form: 'permanent', startDate: '2024-01-01', hoursPerWeek: 40, percentage: 100 }],
    schedules: [{ id: 'schedule', personId, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: '2024-01-01', revision: 1 }], absences: [], audit: [] },
    transport: { orders: [] }, logistics: { details: {} } };
  ensureEmployeeTime(state); ensureEmployeeSickness(state, ctx());
  if (ready) {
    state.employeeSickness.policy = { ...state.employeeSickness.policy, effectiveFrom: '2026-01-01', agreement: 'statutory', calculationConfirmed: true };
    state.employeeSickness.profiles.push({ ...profile, revision: 1 });
  }
  return { state, person };
}
const report = (state, day, value = {}, time) => employeeSicknessCommand(state, personId, { action: 'sickness.report', requestId: requestId(),
  fromDate: day, extent: 100, forecast: { kind: 'unknown' }, declared: true, ...value }, [], ctx(day, time));
const recover = (state, day, last = day, minute) => {
  const item = state.employeeSickness.cases.find(c => c.status === 'open');
  return employeeSicknessCommand(state, personId, { action: 'sickness.recover', requestId: requestId(), id: item.id, revision: item.revision,
    lastSickDate: last, ...(minute === undefined ? {} : { recoveryMinute: minute }) }, [], ctx(day, '17:00:00'));
};
const management = (state, value, day = '2026-10-12') => sicknessManagementCommand(state, admin, { requestId: requestId(), ...value }, [], { now: `${day}T18:00:00Z` });

test('karens is 20% of average weekly sick pay, partial first-day deduction is carried and capped', () => {
  const ledger = calculateSicknessLedger({ profile, days: [{ lostMinutes: 120, employerDay: 1 }, { lostMinutes: 480, employerDay: 2 }, { lostMinutes: 480, employerDay: 3 }] });
  assert.equal(ledger.target, 640);
  assert.deepEqual(ledger.rows.map(r => [r.grossSickPay, r.karensDeduction, r.payableSickPay]), [[160, 160, 0], [640, 480, 160], [640, 0, 640]]);
  assert.equal(ledger.remaining, 0);
  assert.ok(ledger.rows.every(r => r.payableSickPay >= 0));
});
test('no payroll inputs means nullable amounts, never guessed wages', () => {
  const { state } = fixture(false); report(state, '2026-10-12');
  const underlay = sicknessPayUnderlay(state, personId, ctx());
  assert.equal(underlay.calculationStatus, 'missing_basis'); assert.equal(underlay.totalDeduction, null);
  assert.equal(underlay.rows[0].lostMinutes, 480); assert.equal(underlay.rows[0].grossSickPay, null);
  assert.throws(() => calculateSicknessLedger({ profile: { ...profile, hourlyBase: -100 }, days: [] }));
});
test('relapse five calendar days after last illness joins same cycle, six days starts a new cycle', () => {
  const { state } = fixture(); report(state, '2026-10-05'); recover(state, '2026-10-05');
  const first = state.employeeSickness.cases[0], cycle = first.cycleId;
  report(state, '2026-10-10'); assert.equal(state.employeeSickness.cases.at(-1).relapse, true); assert.equal(state.employeeSickness.cases.at(-1).cycleId, cycle);
  recover(state, '2026-10-10'); report(state, '2026-10-16');
  assert.equal(state.employeeSickness.cases.at(-1).relapse, false); assert.notEqual(state.employeeSickness.cases.at(-1).cycleId, cycle);
  assert.equal(state.employeeSickness.cycles.length, 2);
});
test('daily confirmations/forecast are same case and do not end absence or create new karens', () => {
  const { state } = fixture(); report(state, '2026-10-12', { forecast: { kind: 'date', date: '2026-10-13' } });
  const item = state.employeeSickness.cases[0];
  employeeSicknessCommand(state, personId, { action: 'sickness.confirm', requestId: requestId(), id: item.id, revision: item.revision, extent: 100 }, [], ctx('2026-10-13'));
  refreshSicknessAbsences(state, ctx('2026-10-14'));
  assert.equal(state.employeeSickness.cases.length, 1); assert.equal(state.employeeSickness.cycles.length, 1);
  assert.equal(state.employeeSickness.cases[0].status, 'open'); assert.equal(state.personnel.absences.at(-1).toDate, '2026-10-14');
  const summary = employeeSicknessProjection(state, personId, ctx('2026-10-14', '12:00:00'));
  assert.equal(summary.activeCase.followup.contactOverdue, true);
});
test('request IDs safely replay and reject changed payload/CAS/other person', () => {
  const { state } = fixture(); const command = { action: 'sickness.report', requestId: requestId(), fromDate: '2026-10-12', extent: 100, forecast: { kind: 'unknown' }, declared: true };
  employeeSicknessCommand(state, personId, command, [], ctx()); employeeSicknessCommand(state, personId, command, [], ctx());
  assert.equal(state.employeeSickness.cases.length, 1);
  assert.throws(() => employeeSicknessCommand(state, personId, { ...command, extent: 50 }, [], ctx()), /redan använts/);
  assert.throws(() => employeeSicknessProjection(state, 'other', ctx()), /egen/);
  const item = state.employeeSickness.cases[0];
  assert.throws(() => employeeSicknessCommand(state, personId, { action: 'sickness.forecast', requestId: requestId(), id: item.id, revision: 0, forecast: { kind: 'unknown' } }, [], ctx()), /annan session/);
});
test('mid-shift report stops clock atomically, keeps actual work, and records only remaining absence', () => {
  const { state, person } = fixture();
  enrollEmployeeTime(state, person, ctx());
  const setting = state.employeeTime.settings[0]; setting.timeSource = 'clock'; state.employeeTime.requirementHistory[0].timeSource = 'clock';
  employeeClockCommand(state, person, { action: 'clock.in', requestId: requestId(), revision: 0 }, [], ctx('2026-10-12', '05:00:00'));
  report(state, '2026-10-12', { clockOut: true }, '08:00:00');
  assert.equal(state.employeeTime.clockSessions[0].endedAt, '2026-10-12T08:00:00.000Z');
  const item = state.employeeSickness.cases[0];
  assert.equal(item.startMinute, 600); assert.equal(item.days[0].lostMinutes, 300);
  assert.equal(item.timeIssue, false); assert.equal(state.personnel.absences[0].startMinute, 600);
  assert.throws(() => assertSicknessWorkAllowed(state, person, ctx('2026-10-12', '09:00:00')), /sjukanmäld/);
});
test('locked old months do not block receiving sickness or recovery and are never rewritten', () => {
  const { state } = fixture(); state.employeeTime.reviews = [{ personId, month: '2026-09', status: 'approved' }];
  report(state, '2026-10-01', { fromDate: '2026-09-30' });
  assert.equal(state.employeeSickness.cases[0].timeIssue, true); assert.ok(state.personnel.absences.every(a => a.fromDate >= '2026-10-01'));
  const item = state.employeeSickness.cases[0];
  employeeSicknessCommand(state, personId, { action: 'sickness.recover', requestId: requestId(), id: item.id, revision: item.revision, lastSickDate: '2026-09-30' }, [], ctx('2026-10-01'));
  assert.equal(item.status, 'recovered'); assert.equal(state.personnel.absences.length, 0);
  assert.throws(() => management(state, { action: 'sickness.correct', personId, id: item.id, revision: item.revision, fromDate: '2026-09-30', extent: 50, reason: 'Korrigerar faktisk frånvaro' }, '2026-10-01'), /attesterad/);
});
test('full sickness cannot release an unrelated earlier missing-time gate', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, ctx('2026-10-09'));
  report(state, '2026-10-12');
  assert.equal(employeeTimeGate(state, person, ctx('2026-10-13')).date, '2026-10-09');
});
test('the eleventh actual deduction occasion in rolling 12 months is exempt, contacts do not count', () => {
  const { state } = fixture();
  const days = ['2026-01-05','2026-01-19','2026-02-02','2026-02-16','2026-03-02','2026-03-16','2026-03-30','2026-04-13','2026-04-27','2026-05-11'];
  for (const day of days) { report(state, day); recover(state, day); }
  assert.equal(state.employeeSickness.cycles.filter(c => c.deductionOccasionDate).length, 10);
  report(state, '2026-05-25');
  const underlay = sicknessPayUnderlay(state, personId, ctx('2026-05-25'));
  assert.equal(underlay.cycles.at(-1).deductionExemption, 'general_high_risk'); assert.equal(underlay.cycles.at(-1).deductionTarget, 0);
  assert.equal(underlay.rows.at(-1).payableSickPay, 640);
});
test('special frequent-illness decision exempts karens, long-illness reimbursement decision alone does not', () => {
  for (const kind of ['frequent', 'long']) {
    const { state } = fixture();
    management(state, { action: 'highrisk.save', decision: { id: 'decision', personId, fromDate: '2026-01-01', toDate: '2026-12-31', kind, reference: 'FK daterat beslut HR-123', revision: 0 } });
    report(state, '2026-10-12');
    const underlay = sicknessPayUnderlay(state, personId, ctx());
    assert.equal(underlay.cycles[0].deductionExemption, kind === 'frequent' ? 'special_high_risk' : 'none');
    assert.equal(underlay.cycles[0].deductionTarget, kind === 'frequent' ? 0 : 640);
  }
});
test('employer 14-day period starts first lost workday, not Saturday notification, and includes weekends after start', () => {
  const { state } = fixture(); report(state, '2026-10-10'); refreshSicknessAbsences(state, ctx('2026-10-27'));
  const item = state.employeeSickness.cases[0];
  management(state, { action: 'certificate.save', personId, id: item.id, revision: item.revision,
    certificate: { received: true, fromDate: '2026-10-17', toDate: '2026-10-30', reference: 'Privat HR-arkiv INTYG-1' } }, '2026-10-27');
  const underlay = sicknessPayUnderlay(state, personId, ctx('2026-10-27'));
  assert.equal(underlay.rows.find(r => r.date === '2026-10-10').employerDay, 0);
  assert.equal(underlay.rows.find(r => r.date === '2026-10-12').employerDay, 1);
  assert.equal(underlay.rows.find(r => r.date === '2026-10-25').employerDay, 14);
  assert.equal(underlay.rows.find(r => r.date === '2026-10-26').status, 'outside_employer_period');
  assert.equal(underlay.rows.find(r => r.date === '2026-10-26').payableSickPay, 0);
});
test('actual partial sickness uses percentage without inventing an unavailable shift interval and retains worked hours', () => {
  const { state, person } = fixture(); enrollEmployeeTime(state, person, ctx());
  employeeTimeCommand(state, person, { action: 'time.save', entry: { date: '2026-10-12', startMinute: 420, endMinute: 900, breakMinutes: 60,
    activity: 'Gårdsarbete', siteId: 'norrtalje', note: '' } }, [], ctx('2026-10-12', '15:00:00'));
  report(state, '2026-10-12', { extent: 25 }, '15:00:00');
  assert.equal(state.personnel.absences[0].sicknessExtent, 25);
  assert.equal(state.personnel.absences[0].startMinute, 0); assert.equal(state.personnel.absences[0].endMinute, 1440);
  assert.equal(state.employeeTime.entries.length, 1); assert.equal(state.employeeSickness.cases[0].days[0].lostMinutes, 60);
});
test('both actual/effective rights and all facilities guard medical/pay data, not only one overlap', () => {
  const { state, person } = fixture(); report(state, '2026-10-12'); person.siteIds.push('rimbo');
  const restricted = { ...adminUser, id: 'restricted', siteIds: ['norrtalje'] };
  assert.throws(() => sicknessManagementProjection(state, { actor: restricted, user: adminUser }, { personId }, ctx()), /utanför/);
  const noSalary = { ...adminUser, id: 'hr', level: 'Medarbetare', permissions: ['absenceRead', 'absenceWrite'], siteIds: ['norrtalje', 'rimbo'] };
  const read = sicknessManagementProjection(state, { actor: noSalary, user: noSalary }, { personId }, ctx());
  assert.equal(read.underlay, undefined); assert.deepEqual(read.profiles, []);
  assert.throws(() => sicknessManagementCommand(state, { actor: noSalary, user: adminUser }, { action: 'payprofile.save', requestId: requestId(), profile }, [], ctx()), /saknar/);
});
test('day eight certificate and documented first-day demand block unverified pay; written declaration is required', () => {
  const { state } = fixture(); report(state, '2026-10-12', { declared: false });
  let underlay = sicknessPayUnderlay(state, personId, ctx()); assert.equal(underlay.rows[0].status, 'review_required');
  const item = state.employeeSickness.cases[0];
  employeeSicknessCommand(state, personId, { action: 'sickness.declare', requestId: requestId(), id: item.id, revision: item.revision, declared: true }, [], ctx());
  management(state, { action: 'certificate.save', personId, id: item.id, revision: item.revision,
    certificate: { received: false, reference: '', firstDayRequired: true, firstDayReason: 'Skriftligt förstadagsintygbeslut enligt särskilda skäl' } });
  underlay = sicknessPayUnderlay(state, personId, ctx()); assert.equal(underlay.rows[0].status, 'review_required'); assert.match(underlay.rows[0].messages.join(' '), /intyg/);
});
test('same-day late notice is held for a documented lawful exception, not silently paid', () => {
  const { state } = fixture(); report(state, '2026-10-12', {}, '11:00:00');
  let underlay = sicknessPayUnderlay(state, personId, ctx('2026-10-12', '11:00:00')); assert.equal(underlay.rows[0].status, 'review_required');
  const item = state.employeeSickness.cases[0];
  management(state, { action: 'case.review', personId, id: item.id, revision: item.revision, kind: 'report_delay_exception', reason: 'Medarbetaren var förhindrad och anmälde sig direkt efter att hindret upphörde' });
  underlay = sicknessPayUnderlay(state, personId, ctx()); assert.equal(underlay.rows[0].status, 'calculated');
});
test('future actual timestamps and overlapping reopened cases are rejected', () => {
  const { state } = fixture(); assert.throws(() => report(state, '2026-10-12', { startMinute: 1000 }), /framtida/);
  report(state, '2026-10-12', { startMinute: 360 });
  const first = state.employeeSickness.cases[0];
  assert.throws(() => employeeSicknessCommand(state, personId, { action: 'sickness.recover', requestId: requestId(), id: first.id, revision: first.revision, lastSickDate: '2026-10-12', recoveryMinute: 300 }, [], ctx()), /efter/);
  recover(state, '2026-10-12'); report(state, '2026-10-19');
  assert.throws(() => management(state, { action: 'sickness.correct', personId, id: first.id, revision: first.revision, fromDate: first.fromDate, extent: 100, reason: 'Öppna ett gammalt ärende' }, '2026-10-19'), /öppet/);
});

test('later worked-time correction reduces unlocked sickness loss while frozen exports retain their sources', () => {
  const { state, person } = fixture(); report(state, '2026-10-12');
  const exported = recordSicknessPayUnderlay(state, admin, personId, {}, [], ctx());
  assert.equal(exported.rows[0].lostMinutes, 480);
  employeeTimeCommand(state, person, { action: 'time.save', entry: { date: '2026-10-12', startMinute: 420, endMinute: 660,
    breakMinutes: 0, activity: 'Faktisk arbetad tid', siteId: 'norrtalje', note: '' } }, [], ctx('2026-10-12', '16:00:00'));
  const revised = recordSicknessPayUnderlay(state, admin, personId, {}, [], ctx('2026-10-12', '16:00:00'));
  assert.equal(revised.rows[0].lostMinutes, 240); assert.equal(revised.ledgerRevision, 2);
  assert.equal(state.employeeSickness.ledgerSnapshots[0].underlay.rows[0].lostMinutes, 480);
  assert.notEqual(revised.contentHash, exported.contentHash);
  const same = recordSicknessPayUnderlay(state, admin, personId, {}, [], ctx('2026-10-12', '17:00:00'));
  assert.equal(same.ledgerId, revised.ledgerId); assert.equal(state.employeeSickness.ledgerSnapshots.length, 2);
});
test('explicit historical karens imports re-evaluate an existing unfinished cycle and preserve export receipts', () => {
  const { state } = fixture(); report(state, '2026-10-12');
  const old = recordSicknessPayUnderlay(state, admin, personId, {}, [], ctx());
  assert.equal(old.cycles[0].deductionTarget, 640);
  for (const date of ['2026-01-05','2026-01-19','2026-02-02','2026-02-16','2026-03-02','2026-03-16','2026-03-30','2026-04-13','2026-04-27','2026-05-11'])
    management(state, { action: 'deduction.import', personId, date, source: 'Verifierat löneunderlag från tidigare lönesystem' });
  const now = sicknessPayUnderlay(state, personId, ctx());
  assert.equal(now.cycles[0].deductionExemption, 'general_high_risk'); assert.equal(now.cycles[0].deductionTarget, 0);
  assert.equal(state.employeeSickness.ledgerSnapshots[0].underlay.cycles[0].deductionTarget, 640);
});
test('new salaries never overwrite an already confirmed cycle basis and month export retains full-cycle carry', () => {
  const { state } = fixture(); report(state, '2026-09-30'); refreshSicknessAbsences(state, ctx('2026-10-02'));
  management(state, { action: 'payprofile.save', profile: { ...profile, revision: 1, effectiveFrom: '2026-10-01', hourlyBase: 200 } }, '2026-10-02');
  const month = sicknessManagementProjection(state, admin, { personId, month: '2026-10' }, ctx('2026-10-02')).underlay;
  assert.ok(month.rows.every(row => row.date.startsWith('2026-10'))); assert.equal(month.cycles[0].basis.hourlyBase, 100);
  assert.equal(month.rows[0].karensDeduction, 0); assert.equal(month.rows[0].payableSickPay, 640);
});
test('exhausted employer period needs verified return to actual work before a fresh period', () => {
  const { state } = fixture(); report(state, '2026-09-28'); refreshSicknessAbsences(state, ctx('2026-10-11'));
  let item = state.employeeSickness.cases[0];
  management(state, { action: 'certificate.save', personId, id: item.id, revision: item.revision,
    certificate: { received: true, fromDate: '2026-10-05', toDate: '2026-10-11', reference: 'Skyddat HR-arkiv INTYG-2' } }, '2026-10-11');
  recover(state, '2026-10-11'); report(state, '2026-10-19');
  let underlay = sicknessPayUnderlay(state, personId, ctx('2026-10-19'));
  assert.match(underlay.rows.at(-1).messages.join(' '), /minst en arbetad dag/);
  item = state.employeeSickness.cases.at(-1);
  management(state, { action: 'case.review', personId, id: item.id, revision: item.revision, kind: 'return_work_verified', reason: 'Tidrapport i tidigare system verifierar full återgång och arbete 12 oktober' }, '2026-10-19');
  underlay = sicknessPayUnderlay(state, personId, ctx('2026-10-19')); assert.equal(underlay.rows.at(-1).status, 'calculated');
});
test('qualified hourly employment has an explicit accountable approval path; one-site HR cannot alter company policy', () => {
  const { state } = fixture(); state.personnel.employment[0].form = 'hourly'; report(state, '2026-10-12');
  assert.equal(sicknessPayUnderlay(state, personId, ctx()).rows[0].status, 'review_required');
  const item = state.employeeSickness.cases[0];
  management(state, { action: 'case.review', personId, id: item.id, revision: item.revision, kind: 'employment_eligibility_verified', reason: 'Avtalade pass samt tidigare obruten anställning verifierade i löneunderlaget' });
  assert.equal(sicknessPayUnderlay(state, personId, ctx()).rows[0].status, 'calculated');
  const scoped = { ...adminUser, siteIds: ['norrtalje'] };
  const allSitesContext = { ...ctx(), siteCatalog: [{ id: 'norrtalje', active: true }, { id: 'rimbo', active: true }] };
  assert.throws(() => sicknessManagementCommand(state, { actor: scoped, user: scoped }, { action: 'policy.save', requestId: requestId(), policy: state.employeeSickness.policy }, [], allSitesContext), /samtliga/);
  const projected = sicknessManagementProjection(state, { actor: scoped, user: scoped }, {}, allSitesContext);
  assert.ok(!projected.capabilities.includes('policyWrite'));
});
