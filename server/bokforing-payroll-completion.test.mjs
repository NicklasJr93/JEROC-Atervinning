import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, transact, appendEntry, accountBalance } from '../public/bokforing/suite/core.js';
import { createEmployee, createPayrollRun, postPayroll, payPayroll } from '../public/bokforing/suite/finance.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { savePayrollProfile, createPayrollBatch, postPayrollBatch, payPayrollBatch, settlePayrollBatchTaxes,
  createVacationYear, getVacationBalance, createPayrollRecovery, receivePayrollRecovery, receivePayrollRecoveryTaxCredit,
  getPayrollDeclarationPeople, validatePayrollBatches, reversePayrollBatch } from '../public/bokforing/suite/payroll-engine.js';

function fixture({ hourly = false } = {}) {
  let state = transact(createEmptyState(), draft => appendEntry(draft, { date: '2026-01-01', description: 'Ingående kapital', sourceType: 'opening', sourceId: 'opening', rows: [{ account: '1930', debitCents: 20000000, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 20000000 }] }));
  state = createEmployee(state, { name: 'Testperson', payType: hourly ? 'hourly' : 'monthly', baseCents: hourly ? 20000 : 3200000 });
  state = savePayrollProfile(state, { employeeId: state.employees[0].id, date: '2026-10-01', birthYear: 1985, taxMode: 'table', table: 32, column: 1, weeklyHoursHundredths: 4000, deductionHourlyCents: 20000, vacationMethod: hourly ? 'percentage' : 'same-pay', vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25, agreementNote: 'Granskade svenska standardvillkor', reviewed: true, domesticOrdinary: true });
  return state;
}
const vacation = (state, extra = {}) => createVacationYear(state, { employeeId: state.employees[0].id, date: '2026-10-01', earningStart: '2025-04-01', earningEnd: '2026-03-31', employmentStart: '2025-04-01', employmentEnd: '2026-03-31', entitlementDays: 25, nonQualifyingDays: 0, eligibleEarningsCents: 24000000, percentBps: 1200, reference: 'Semesterunderlag 2025/2026', reviewed: true, qualifyingAbsenceReviewed: true, ...extra });
function payroll(state, extra = {}, date = '2026-10-25') {
  state = createPayrollBatch(state, { date, people: [{ employeeId: state.employees[0].id, scheduledHoursHundredths: 16000, ...extra }] });
  return postPayrollBatch(state, state.payrollBatches.at(-1).id, { reviewed: true });
}
const paid = state => { const next = payroll(state); return payPayrollBatch(next, next.payrollBatches.at(-1).id, { date: '2026-10-25' }); };
const recovery = (state, extra = {}) => createPayrollRecovery(state, { batchId: state.payrollBatches[0].id, employeeId: state.employees[0].id, date: '2026-10-28', grossCents: 100000, component: 'salary', taxClass: 'periodic', reason: 'För mycket ordinarie lön utbetald', reference: 'Krav 1', reviewed: true, agiCorrectionConfirmed: true, ...extra });

test('vacation earning uses actual employment days, qualifying absence and upward rounding', () => {
  let state = vacation(fixture(), { employmentStart: '2025-10-01', nonQualifyingDays: 7 });
  const year = state.payrollVacationYears[0];
  assert.equal(year.employedDays, 182); assert.equal(year.qualifyingDays, 175); assert.equal(year.earnedDays, 12);
  assert.equal(year.leaveStart, '2026-04-01'); assert.equal(year.leaveEnd, '2027-03-31');
  assert.throws(() => vacation(state), /finns redan/);
  assert.throws(() => vacation(fixture(), { qualifyingAbsenceReviewed: false }), /Bekräfta/);
  assert.throws(() => vacation(fixture(), { nonQualifyingDays: 400 }), /kalenderdagar/);
  assert.throws(() => vacation(fixture(), { carriedDays: 2, carriedFromYear: 2019 }), /Ursprungsår/);
  validateSuiteState(state);
});

test('same-pay days consume earned balance without treating ordinary monthly salary as extra vacation money', () => {
  let state = vacation(fixture()); const year = state.payrollVacationYears[0];
  state = payroll(state, { vacationYearId: year.id, vacationDays: 2 });
  const person = state.payrollBatches[0].people[0];
  assert.equal(person.salaryCents, 3200000); assert.equal(person.vacationPayCents, 27520);
  assert.equal(getVacationBalance(state, year.id).remainingDays, 23);
  assert.throws(() => payroll(state, { vacationYearId: year.id, vacationDays: 24 }, '2026-11-25'), /intjänade/);
  validateSuiteState(state);
});

test('percentage vacation allocates exact money and deducts scheduled vacation hours from hourly salary', () => {
  let state = vacation(fixture({ hourly: true })); const year = state.payrollVacationYears[0];
  assert.equal(year.earnedMoneyCents, 2880000);
  state = payroll(state, { vacationYearId: year.id, vacationDays: 5, vacationHoursHundredths: 4000 });
  const person = state.payrollBatches[0].people[0];
  assert.equal(person.salaryCents, 2400000); assert.equal(person.vacationPayCents, 576000);
  assert.equal(getVacationBalance(state, year.id).remainingMoneyCents, 2304000);
  assert.throws(() => payroll(vacation(fixture({ hourly: true })), { vacationYearId: year.id, vacationDays: 1 }), /semestertimmarna|saknas|passar/);
  validateSuiteState(state);
});

test('final vacation compensation empties the percentage balance using one-off withholding', () => {
  let state = vacation(fixture({ hourly: true })); const year = state.payrollVacationYears[0];
  state = payroll(state, { kind: 'vacation-final', vacationYearId: year.id, vacationDays: 25, finalCompensationReviewed: true, annualSalaryCents: 40000000, annualSalaryReviewed: true });
  const row = state.payrollBatches[0].people[0];
  assert.equal(row.salaryCents, 0); assert.equal(row.vacationPayCents, 2880000); assert.equal(row.oneOffCents, 2880000);
  assert.equal(getVacationBalance(state, year.id).remainingMoneyCents, 0); assert.equal(getVacationBalance(state, year.id).remainingDays, 0);
  assert.equal(row.tax.oneOff.ratePercent, 26); validateSuiteState(state);
});

test('gross recovery preserves paid journal and withheld tax while restoring a separate employee receivable', () => {
  let state = paid(fixture()); const entries = JSON.stringify(state.entries); const originalTax = getPayrollDeclarationPeople(state, '2026-10')[0].withholdingCents;
  state = recovery(state); const item = state.payrollRecoveries[0];
  assert.equal(item.employerReductionCents, 31420); assert.equal(item.contributionHandling, 'reduce-unpaid');
  assert.equal(JSON.stringify(state.entries.slice(0, -1)), entries); assert.equal(accountBalance(state, '1680'), 100000);
  assert.equal(accountBalance(state, '7010'), 3100000); assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3100000);
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].withholdingCents, originalTax);
  state = receivePayrollRecovery(state, item.id, { date: '2026-10-29', amountCents: 40000, reference: 'Delbetalning 1' });
  state = receivePayrollRecovery(state, item.id, { date: '2026-10-30', amountCents: 60000, reference: 'Slutbetalning' });
  assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, state.payrollBatches[0].id, { date: '2026-11-12' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('already-settled employer contribution is credited separately on the tax account', () => {
  let state = paid(fixture()); state = settlePayrollBatchTaxes(state, state.payrollBatches[0].id, { date: '2026-10-26' });
  state = recovery(state); const item = state.payrollRecoveries[0];
  assert.equal(item.contributionHandling, 'tax-credit'); assert.equal(accountBalance(state, '2731'), 31420);
  state = receivePayrollRecoveryTaxCredit(state, item.id, { date: '2026-11-12', reference: 'SKV rättelse' });
  assert.equal(accountBalance(state, '2731'), 0); assert.throws(() => receivePayrollRecoveryTaxCredit(state, item.id, { date: '2026-11-13', reference: 'igen' }), /oreglerad/);
  validateSuiteState(state);
});

test('recovery rejects overclaim, duplicate references, false approval and overpayment atomically', () => {
  const base = paid(fixture()), snapshot = JSON.stringify(base);
  assert.throws(() => recovery(base, { grossCents: 3200001 }), /överstiger/);
  assert.throws(() => recovery(base, { reviewed: false }), /Granska/);
  assert.equal(JSON.stringify(base), snapshot);
  const state = recovery(base); const id = state.payrollRecoveries[0].id;
  assert.throws(() => recovery(state), /referens/);
  assert.throws(() => receivePayrollRecovery(state, id, { date: '2026-10-29', amountCents: 100001, reference: 'extra' }), /överstiger/);
  const bad = structuredClone(state); bad.payrollRecoveries[0].grossCents++;
  assert.throws(() => validatePayrollBatches(bad), /ändrats/);
});

test('later supplementary salary uses the corrected tax base while keeping the earlier withholding', () => {
  let state = recovery(paid(fixture()));
  state = payroll(state, { kind: 'supplement', additionalGrossCents: 50000 }, '2026-10-30');
  const row = state.payrollBatches[1].people[0]; assert.equal(row.context.previousTaxableCents, 3100000);
  assert.deepEqual(row.context.priorRecoveryIds, [state.payrollRecoveries[0].id]); assert.equal(row.employerCents, 15710);
  validateSuiteState(state);
});

test('unpaid and reversed payroll do not appear as salary actually paid in AGI data', () => {
  let state = payroll(fixture());
  assert.deepEqual(getPayrollDeclarationPeople(state, '2026-10'), []);
  state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-10-26', reason: 'Ersätt obetalt löneunderlag' });
  assert.deepEqual(getPayrollDeclarationPeople(state, '2026-10'), []);
  validateSuiteState(state);
});

test('final same-pay compensation requires reviewed daily entitlement and historical vacation years survive a profile change', () => {
  let state = vacation(fixture()); const year = state.payrollVacationYears[0];
  const input = { kind: 'vacation-final', vacationYearId: year.id, vacationDays: 25, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true };
  assert.throws(() => payroll(state, input), /per dag/);
  state = payroll(state, { ...input, finalDailyCents: 150000 });
  assert.equal(state.payrollBatches[0].people[0].grossCents, 3750000);
  assert.equal(getVacationBalance(state, year.id).remainingDays, 0);
  const current = state.payrollProfiles[0];
  state = savePayrollProfile(state, { ...current, date: '2026-10-26', vacationMethod: 'percentage' });
  validateSuiteState(state);
});

test('vacation money remains exact across uneven installments and reserves draft days', () => {
  let state = vacation(fixture({ hourly: true }), { eligibleEarningsCents: 24000001 });
  const id = state.payrollVacationYears[0].id;
  for (const [index, days] of [7, 8, 10].entries()) {
    state = payroll(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: days, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, `2026-${10 + index}-25`);
  }
  assert.equal(state.payrollBatches.reduce((n, batch) => n + batch.people[0].vacationPayCents, 0), state.payrollVacationYears[0].availableMoneyCents);
  assert.equal(getVacationBalance(state, id).remainingMoneyCents, 0);
  validateSuiteState(state);
});

test('recovery receipt cannot disappear and a claim cannot precede a later paid salary included in its base', () => {
  let state = recovery(paid(fixture())); const id = state.payrollRecoveries[0].id;
  state = receivePayrollRecovery(state, id, { date: '2026-10-29', amountCents: 50000, reference: 'Betalning X' });
  const bad = structuredClone(state);
  bad.bankTransactions = bad.bankTransactions.filter(row => row.matchedEntryId !== bad.payrollRecoveries[0].payments[0].entryId);
  assert.throws(() => validatePayrollBatches(bad), /bankinbetalning/);
  state = payroll(state, { kind: 'supplement', additionalGrossCents: 50000 }, '2026-10-30');
  state = payPayrollBatch(state, state.payrollBatches.at(-1).id, { date: '2026-10-30' });
  assert.throws(() => recovery(state, { date: '2026-10-29', reference: 'Bakdaterat krav' }), /utbetalningar/);
  validateSuiteState(state);
});

function olderPosted(state = fixture()) {
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' });
  return postPayroll(state, state.payrollRuns[0].id);
}
const modernDraft = (state, date, extra = {}) => createPayrollBatch(state, { date, people: [{ employeeId: state.employees[0].id, scheduledHoursHundredths: 16000, ...extra }] });

test('shifted legacy payment blocks modern payroll in both affected months without changing source values', () => {
  let state = olderPosted();
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-11-03' });
  const original = JSON.stringify(state);
  assert.throws(() => modernDraft(state, '2026-11-25'), /flyttad utbetalningsmånad.*moderna lönemotorn/);
  assert.throws(() => modernDraft(state, '2026-10-28', { kind: 'supplement', additionalGrossCents: 100000 }), /flyttad utbetalningsmånad/);
  assert.equal(JSON.stringify(state), original);
  validateSuiteState(state);
});

test('legacy payment cannot move into a month with modern draft, posted or paid payroll', () => {
  const base = olderPosted(), legacyId = base.payrollRuns[0].id;
  let state = modernDraft(base, '2026-11-25');
  const modernId = state.payrollBatches[0].id;
  for (const status of ['draft', 'posted', 'paid']) {
    if (status === 'posted') state = postPayrollBatch(state, modernId, { reviewed: true });
    if (status === 'paid') state = payPayrollBatch(state, modernId, { date: '2026-11-25' });
    const original = JSON.stringify(state);
    assert.throws(() => payPayroll(state, legacyId, { date: '2026-11-26' }), /flyttad utbetalningsmånad/);
    assert.equal(JSON.stringify(state), original);
    validateSuiteState(state);
  }
  const compatible = payPayroll(state, legacyId, { date: '2026-10-25' });
  validateSuiteState(compatible);
});

test('legacy payment cannot move after modern calculation already used its original month', () => {
  let state = olderPosted(), legacyId = state.payrollRuns[0].id;
  state = modernDraft(state, '2026-10-28', { kind: 'supplement', additionalGrossCents: 100000 });
  assert.throws(() => payPayroll(state, legacyId, { date: '2026-11-03' }), /flyttad utbetalningsmånad/);
  const sameMonth = payPayroll(state, legacyId, { date: '2026-10-25' });
  validateSuiteState(sameMonth);
});

test('restored data cannot combine a shifted legacy payment with a modern payroll calculation', () => {
  const base = olderPosted(), modern = modernDraft(base, '2026-11-25');
  const corrupted = payPayroll(base, base.payrollRuns[0].id, { date: '2026-11-03' });
  corrupted.payrollBatches = structuredClone(modern.payrollBatches);
  assert.throws(() => validatePayrollBatches(corrupted), /flyttad utbetalningsmånad/);
  assert.throws(() => getPayrollDeclarationPeople(corrupted, '2026-11'), /flyttad utbetalningsmånad/);
});
