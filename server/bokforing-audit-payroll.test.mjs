import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance } from '../public/bokforing/suite/core.js';
import { createEmployee, createPayrollRun, postPayroll, payPayroll } from '../public/bokforing/suite/finance.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { savePayrollProfile, createPayrollBatch, postPayrollBatch, payPayrollBatch, settlePayrollBatchTaxes,
  createVacationYear, getVacationBalance, createPayrollRecovery, receivePayrollRecovery,
  receivePayrollRecoveryTaxCredit, getPayrollDeclarationPeople, reversePayrollBatch, discardPayrollDraft }
  from '../public/bokforing/suite/payroll-engine.js';

/* Independent compliance audit, checked 2026-10-23.
 * Monthly fixtures below were extracted from newly downloaded official PDFs,
 * not from TAX_TABLES_2026 or any production calculation. SKVFS 2025:20,
 * monthly columns 1/3, tables 29–42. Exact PDF URL/SHA-256 accompanies each case.
 * One-off thresholds: SKVFS 2025:21, income year 2026, columns 1/3:
 * https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skatteavdrag/engangsbelopp.4.361dc8c15312eff6fd3225e.html
 * Employer rates: 2026 ordinary 31.42%, born 1938–1958 10.21%, <=1937 0%;
 * born 2003–2007, from 2026-04-01, 20.81% on first SEK 25,000/month.
 * https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html
 * Vacation: Semesterlag (1977:480), sections 7, 16a, 16b; 25 days, upward
 * day rounding, 0.43% supplement/12% reviewed earnings for the covered cases.
 * https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/semesterlag-1977480_sfs-1977-480/
 * Sickness: Sjuklönelag (1991:1047), sections 6/7; 80%, 20% of weekly sick pay,
 * first 14 calendar days. Here reviewed uniform schedules are explicit.
 * https://www.forsakringskassan.se/arbetsgivare/sjukdom-och-skada/sjuklon
 * Gross recovery: original cash pay decreases, withholding is preserved:
 * https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/rattaenarbetsgivardeklaration.4.2cf1b5cd163796a5c8b6698.html
 * Scope is deliberately bounded: not certification; annual SEK 1,000 employer
 * threshold, international/social-security exemptions, collective agreements,
 * nonuniform/recurrent sickness, protected absence assessment, saved-vacation
 * valuation and official AGI submission are NOT independently certified here.
 * The accounting engine's cent-level employer accrual is checked; declaration
 * rounding/aggregation must additionally be checked at the AGI layer.
 */

function fixture({ base = 3200000, payType = 'monthly', birthYear = 1985, table = 32, column = 1,
  method = payType === 'hourly' ? 'percentage' : 'same-pay', taxMode = 'table', withholding = 0, employerRate = 3142 } = {}) {
  let state = createEmployee(createEmptyState(), { name: 'Audit person', payType, baseCents: base, withholdingCents: withholding, employerRateBps: employerRate });
  return savePayrollProfile(state, { employeeId: state.employees[0].id, date: '2026-01-01', birthYear, table, column, taxMode,
    taxDecisionReference: taxMode === 'decision' ? 'Individuellt granskat beslut AUDIT' : '',
    weeklyHoursHundredths: 4000, deductionHourlyCents: 20000, vacationMethod: method,
    vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25,
    agreementNote: 'Granskat schema 40 timmar/vecka, timavdrag 200 kr och lagens semesterprocent', reviewed: true, domesticOrdinary: true });
}
function batch(state, input = {}, date = '2026-10-25', phase = 'posted') {
  state = createPayrollBatch(state, { date, people: [{ employeeId: state.employees[0].id, scheduledHoursHundredths: 16000, ...input }] });
  if (phase !== 'draft') state = postPayrollBatch(state, state.payrollBatches.at(-1).id, { reviewed: true });
  if (phase === 'paid') state = payPayrollBatch(state, state.payrollBatches.at(-1).id, { date });
  return state;
}
const person = state => state.payrollBatches.at(-1).people[0];
function year(state, extra = {}) {
  return createVacationYear(state, { employeeId: state.employees[0].id, date: '2026-04-01', earningStart: '2025-04-01', earningEnd: '2026-03-31',
    employmentStart: '2025-04-01', employmentEnd: '2026-03-31', entitlementDays: 25, nonQualifyingDays: 0,
    eligibleEarningsCents: 24000000, percentBps: 1200, reference: 'Granskat semesterunderlag AUDIT', reviewed: true, qualifyingAbsenceReviewed: true, ...extra });
}
function recovery(state, extra = {}) {
  return createPayrollRecovery(state, { batchId: state.payrollBatches[0].id, employeeId: state.employees[0].id,
    date: '2026-10-27', grossCents: 100000, component: 'salary', taxClass: 'periodic', reason: 'Felaktigt utbetald kontant lön',
    reference: 'AUDIT återkrav 1', reviewed: true, agiCorrectionConfirmed: true, ...extra });
}
function rejectsUnchanged(state, action, pattern) {
  const original = JSON.stringify(state); assert.throws(() => action(state), pattern); assert.equal(JSON.stringify(state), original); validateSuiteState(state);
}
function checkMonthly(c) {
  const state = batch(fixture({ base: c.income, table: c.table, column: c.column, birthYear: c.column === 3 ? 1958 : 1985 }), {}, '2026-10-25', c.phase);
  const p = person(state); assert.equal(p.tax.taxCents, c.tax); assert.deepEqual(p.tax.band, c.band);
  assert.equal(p.tax.sourceUrl, c.url); assert.equal(p.tax.sourceSha256, c.sha256);
  assert.equal(p.withholdingCents, Math.min(c.income, c.tax)); assert.equal(p.netCents, c.income - Math.min(c.income, c.tax));
  if (c.phase !== 'draft') assert.equal(accountBalance(state, '2710'), -Math.min(c.income, c.tax));
  if (c.phase === 'paid') assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].withholdingCents, Math.min(c.income, c.tax));
  validateSuiteState(state);
}
function checkOneOff(c) {
  const state = batch(fixture({ base: 10000, column: c.column, birthYear: c.column === 3 ? 1958 : 1985 }),
    { additionalGrossCents: c.amount, extraTaxMode: 'one-off', annualSalaryCents: c.annual, annualSalaryReviewed: true }, '2026-10-25', 'paid');
  const p = person(state); assert.equal(p.oneOffCents, c.amount); assert.equal(p.tax.oneOff.ratePercent, c.rate);
  assert.equal(p.tax.oneOff.taxCents, c.tax); assert.equal(p.periodicTaxableCents, 10000);
  assert.equal(p.withholdingCents, c.tax); assert.equal(p.netCents, 10000 + c.amount - c.tax); validateSuiteState(state);
}
function checkContribution(c) {
  let state = fixture({ base: c.previous || c.amount, birthYear: c.birth, taxMode: 'decision' });
  // Tiny rounding cases already exceed the annual SEK 1,000 liability threshold.
  if (c.amount + c.previous < 100000) state = batch(state, { additionalGrossCents: 100000 }, '2026-02-25', 'paid');
  state = batch(state, {}, c.date, 'paid');
  if (c.previous) state = batch(state, { kind: 'supplement', additionalGrossCents: c.amount }, c.date, 'paid');
  assert.equal(person(state).employerCents, c.expected); assert.equal(person(state).employer.previousTaxableCents, c.previous);
  assert.equal(person(state).employer.classification, c.classification); validateSuiteState(state);
}
function checkBenefit(c) {
  const state = batch(fixture({ base: c.base }), { benefitCents: c.benefit, reimbursementCents: c.reimbursement,
    ...(c.cashless ? { unpaidHoursHundredths: 16000 } : {}) }, '2026-10-25', 'paid');
  const p = person(state); assert.equal(p.grossCents, c.cashless ? 0 : c.base); assert.equal(p.taxableCents, c.taxable);
  assert.equal(p.withholdingCents, c.withheld); assert.equal(p.unwithheldTaxCents, c.unwithheld);
  assert.equal(p.netCents, c.net); assert.equal(p.employerCents, c.employer);
  const report = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(report.benefitCents, c.benefit); assert.equal(report.grossCents, c.cashless ? 0 : c.base);
  validateSuiteState(state);
}
function checkAbsence(c) {
  const state = batch(fixture(), c.input, '2026-10-25', 'paid'), p = person(state);
  assert.equal(p.absenceDeductionCents, c.deduction); assert.equal(p.sickPayCents, c.sickPay); assert.equal(p.karensCents, c.karens);
  assert.equal(p.salaryCents, c.salary); assert.equal(accountBalance(state, '7010'), c.salary); validateSuiteState(state);
}

test('AUDIT-PAYROLL-001 SKVFS 2025:20 tabell 29 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":29,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-002 SKVFS 2025:20 tabell 29 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":29,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-003 SKVFS 2025:20 tabell 29 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":29,"column":1,"income":3200000,"tax":561900,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-004 SKVFS 2025:20 tabell 29 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":29,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-005 SKVFS 2025:20 tabell 29 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":29,"column":3,"income":3200099,"tax":256000,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-006 SKVFS 2025:20 tabell 29 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":29,"column":3,"income":8000000,"tax":2055400,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba618/1765290402351/allmanna-tabeller-manad-tabell-29.pdf","sha256":"a84b25aea56af115d5ae57f83be16515b4144d2c1ab802a22a44922df876e400"});
});

test('AUDIT-PAYROLL-007 SKVFS 2025:20 tabell 30 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":30,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-008 SKVFS 2025:20 tabell 30 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":30,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-009 SKVFS 2025:20 tabell 30 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":30,"column":1,"income":3200000,"tax":581000,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-010 SKVFS 2025:20 tabell 30 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":30,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-011 SKVFS 2025:20 tabell 30 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":30,"column":3,"income":3200099,"tax":256600,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-012 SKVFS 2025:20 tabell 30 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":30,"column":3,"income":8000000,"tax":2125600,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba619/1765290422021/allmanna-tabeller-manad-tabell-30.pdf","sha256":"24fd7bb3c772cd544a0fd61d58c08c89cdbc4f716f4a3b69f80358325e62483a"});
});

test('AUDIT-PAYROLL-013 SKVFS 2025:20 tabell 31 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":31,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-014 SKVFS 2025:20 tabell 31 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":31,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-015 SKVFS 2025:20 tabell 31 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":31,"column":1,"income":3200000,"tax":600000,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-016 SKVFS 2025:20 tabell 31 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":31,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-017 SKVFS 2025:20 tabell 31 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":31,"column":3,"income":3200099,"tax":275600,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-018 SKVFS 2025:20 tabell 31 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":31,"column":3,"income":8000000,"tax":2195800,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61a/1765290436723/allmanna-tabeller-manad-tabell-31.pdf","sha256":"6b74bc925c0e4e15f691672ca974f9726c3ff889b79c5b864d9dfd07f03573e1"});
});

test('AUDIT-PAYROLL-019 SKVFS 2025:20 tabell 32 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":32,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-020 SKVFS 2025:20 tabell 32 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":32,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-021 SKVFS 2025:20 tabell 32 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":32,"column":1,"income":3200000,"tax":619000,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-022 SKVFS 2025:20 tabell 32 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":32,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-023 SKVFS 2025:20 tabell 32 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":32,"column":3,"income":3200099,"tax":294600,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-024 SKVFS 2025:20 tabell 32 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":32,"column":3,"income":8000000,"tax":2266000,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61b/1765290451072/allmanna-tabeller-manad-tabell-32.pdf","sha256":"a1b6728c870f8d3073379c9bc66fb779e768375655a9f25418e7cfd52de4c24a"});
});

test('AUDIT-PAYROLL-025 SKVFS 2025:20 tabell 33 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":33,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-026 SKVFS 2025:20 tabell 33 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":33,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-027 SKVFS 2025:20 tabell 33 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":33,"column":1,"income":3200000,"tax":638100,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-028 SKVFS 2025:20 tabell 33 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":33,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-029 SKVFS 2025:20 tabell 33 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":33,"column":3,"income":3200099,"tax":313500,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-030 SKVFS 2025:20 tabell 33 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":33,"column":3,"income":8000000,"tax":2336200,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61c/1765290465443/allmanna-tabeller-manad-tabell-33.pdf","sha256":"69d903717fb5ce7c0130ad2324094c370aa9ba9f41d4b8cefc56cef152a798b2"});
});

test('AUDIT-PAYROLL-031 SKVFS 2025:20 tabell 34 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":34,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-032 SKVFS 2025:20 tabell 34 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":34,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-033 SKVFS 2025:20 tabell 34 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":34,"column":1,"income":3200000,"tax":657100,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-034 SKVFS 2025:20 tabell 34 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":34,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-035 SKVFS 2025:20 tabell 34 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":34,"column":3,"income":3200099,"tax":332500,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-036 SKVFS 2025:20 tabell 34 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":34,"column":3,"income":8000000,"tax":2406500,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61d/1765290478710/allmanna-tabeller-manad-tabell-34.pdf","sha256":"5416d2f16fe04ba7ffa694a44348f5a3ccabeb808467c621bd41cf4b5413549a"});
});

test('AUDIT-PAYROLL-037 SKVFS 2025:20 tabell 35 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":35,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-038 SKVFS 2025:20 tabell 35 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":35,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-039 SKVFS 2025:20 tabell 35 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":35,"column":1,"income":3200000,"tax":676100,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-040 SKVFS 2025:20 tabell 35 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":35,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-041 SKVFS 2025:20 tabell 35 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":35,"column":3,"income":3200099,"tax":351500,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-042 SKVFS 2025:20 tabell 35 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":35,"column":3,"income":8000000,"tax":2476700,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61e/1765290492845/allmanna-tabeller-manad-tabell-35.pdf","sha256":"73a19e45928d2cee2622f046bbb237001b6bf2b6aad6551346c03b9655710035"});
});

test('AUDIT-PAYROLL-043 SKVFS 2025:20 tabell 36 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":36,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-044 SKVFS 2025:20 tabell 36 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":36,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-045 SKVFS 2025:20 tabell 36 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":36,"column":1,"income":3200000,"tax":695200,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-046 SKVFS 2025:20 tabell 36 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":36,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-047 SKVFS 2025:20 tabell 36 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":36,"column":3,"income":3200099,"tax":370400,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-048 SKVFS 2025:20 tabell 36 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":36,"column":3,"income":8000000,"tax":2546900,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba61f/1765290503313/allmanna-tabeller-manad-tabell-36.pdf","sha256":"09060ff5c1621a1c7d6fe6ae88e5c27f32d3962c0fb3792095b8cc59ce798b34"});
});

test('AUDIT-PAYROLL-049 SKVFS 2025:20 tabell 37 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":37,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-050 SKVFS 2025:20 tabell 37 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":37,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-051 SKVFS 2025:20 tabell 37 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":37,"column":1,"income":3200000,"tax":714200,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-052 SKVFS 2025:20 tabell 37 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":37,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-053 SKVFS 2025:20 tabell 37 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":37,"column":3,"income":3200099,"tax":389400,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-054 SKVFS 2025:20 tabell 37 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":37,"column":3,"income":8000000,"tax":2617100,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba624/1765290517552/allmanna-tabeller-manad-tabell-37.pdf","sha256":"bdb362ebc5b7a1fd07ea8bd2bea6291991e41686d3b82cedba7344ebc46f030c"});
});

test('AUDIT-PAYROLL-055 SKVFS 2025:20 tabell 38 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":38,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-056 SKVFS 2025:20 tabell 38 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":38,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-057 SKVFS 2025:20 tabell 38 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":38,"column":1,"income":3200000,"tax":733200,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-058 SKVFS 2025:20 tabell 38 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":38,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-059 SKVFS 2025:20 tabell 38 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":38,"column":3,"income":3200099,"tax":408400,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-060 SKVFS 2025:20 tabell 38 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":38,"column":3,"income":8000000,"tax":2687300,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba625/1765290530129/allmanna-tabeller-manad-tabell-38.pdf","sha256":"b87b007237ac22a56a2ad7cdd2959520e7ee98ff5110346ab468817760c4356a"});
});

test('AUDIT-PAYROLL-061 SKVFS 2025:20 tabell 39 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":39,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-062 SKVFS 2025:20 tabell 39 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":39,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-063 SKVFS 2025:20 tabell 39 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":39,"column":1,"income":3200000,"tax":752300,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-064 SKVFS 2025:20 tabell 39 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":39,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-065 SKVFS 2025:20 tabell 39 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":39,"column":3,"income":3200099,"tax":427300,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-066 SKVFS 2025:20 tabell 39 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":39,"column":3,"income":8000000,"tax":2757500,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba626/1765290546606/allmanna-tabeller-manad-tabell-39.pdf","sha256":"5736a57f129fef11f7615b23d4c8cdb4512eaa611367757d593e2660bec2ca49"});
});

test('AUDIT-PAYROLL-067 SKVFS 2025:20 tabell 40 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":40,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-068 SKVFS 2025:20 tabell 40 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":40,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-069 SKVFS 2025:20 tabell 40 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":40,"column":1,"income":3200000,"tax":771300,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-070 SKVFS 2025:20 tabell 40 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":40,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-071 SKVFS 2025:20 tabell 40 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":40,"column":3,"income":3200099,"tax":446300,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-072 SKVFS 2025:20 tabell 40 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":40,"column":3,"income":8000000,"tax":2827700,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba627/1765290562409/allmanna-tabeller-manad-tabell-40.pdf","sha256":"de2998c2ab4ae9093fe71a44951dc12cba51858eefd30b74035958e2be25ddba"});
});

test('AUDIT-PAYROLL-073 SKVFS 2025:20 tabell 41 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":41,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-074 SKVFS 2025:20 tabell 41 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":41,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-075 SKVFS 2025:20 tabell 41 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":41,"column":1,"income":3200000,"tax":790400,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-076 SKVFS 2025:20 tabell 41 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":41,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-077 SKVFS 2025:20 tabell 41 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":41,"column":3,"income":3200099,"tax":465300,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-078 SKVFS 2025:20 tabell 41 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":41,"column":3,"income":8000000,"tax":2897900,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba628/1765290580161/allmanna-tabeller-manad-tabell-41.pdf","sha256":"bd57aaa3b12bdb2aa581009fd32efa98cd5d440c2d992cfa3d0cb6787b051d61"});
});

test('AUDIT-PAYROLL-079 SKVFS 2025:20 tabell 42 kolumn 1 inkomst 200099 öre', () => {
  checkMonthly({"table":42,"column":1,"income":200099,"tax":0,"band":[1,2000],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-080 SKVFS 2025:20 tabell 42 kolumn 1 inkomst 200100 öre', () => {
  checkMonthly({"table":42,"column":1,"income":200100,"tax":15000,"band":[2001,2100],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-081 SKVFS 2025:20 tabell 42 kolumn 1 inkomst 3200000 öre', () => {
  checkMonthly({"table":42,"column":1,"income":3200000,"tax":809400,"band":[31801,32000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-082 SKVFS 2025:20 tabell 42 kolumn 3 inkomst 840000 öre', () => {
  checkMonthly({"table":42,"column":3,"income":840000,"tax":63800,"band":[8301,8400],"phase":"draft","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-083 SKVFS 2025:20 tabell 42 kolumn 3 inkomst 3200099 öre', () => {
  checkMonthly({"table":42,"column":3,"income":3200099,"tax":484200,"band":[31801,32000],"phase":"posted","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-084 SKVFS 2025:20 tabell 42 kolumn 3 inkomst 8000000 öre', () => {
  checkMonthly({"table":42,"column":3,"income":8000000,"tax":2968100,"band":[79801,80000],"phase":"paid","url":"https://www.skatteverket.se/download/18.1522bf3f19aea8075ba62a/1765290595185/allmanna-tabeller-manad-tabell-42.pdf","sha256":"ceb8f79e6ff7957a94c40887ab61f138469823b5895c36a6e2e9a7e0761bf108"});
});

test('AUDIT-PAYROLL-085 engångstabell kolumn 1 årsinkomst 2504100 öre gräns 25041', () => {
  checkOneOff({"column":1,"annual":2504100,"amount":12399,"rate":0,"tax":0});
});

test('AUDIT-PAYROLL-086 engångstabell kolumn 1 årsinkomst 2504199 öre gräns 25041', () => {
  checkOneOff({"column":1,"annual":2504199,"amount":12345,"rate":0,"tax":0});
});

test('AUDIT-PAYROLL-087 engångstabell kolumn 1 årsinkomst 2504200 öre gräns 25041', () => {
  checkOneOff({"column":1,"annual":2504200,"amount":12399,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-088 engångstabell kolumn 1 årsinkomst 2504299 öre gräns 25041', () => {
  checkOneOff({"column":1,"annual":2504299,"amount":12345,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-089 engångstabell kolumn 1 årsinkomst 8280000 öre gräns 82800', () => {
  checkOneOff({"column":1,"annual":8280000,"amount":12399,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-090 engångstabell kolumn 1 årsinkomst 8280099 öre gräns 82800', () => {
  checkOneOff({"column":1,"annual":8280099,"amount":12345,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-091 engångstabell kolumn 1 årsinkomst 8280100 öre gräns 82800', () => {
  checkOneOff({"column":1,"annual":8280100,"amount":12399,"rate":21,"tax":2600});
});

test('AUDIT-PAYROLL-092 engångstabell kolumn 1 årsinkomst 8280199 öre gräns 82800', () => {
  checkOneOff({"column":1,"annual":8280199,"amount":12345,"rate":21,"tax":2500});
});

test('AUDIT-PAYROLL-093 engångstabell kolumn 1 årsinkomst 19200000 öre gräns 192000', () => {
  checkOneOff({"column":1,"annual":19200000,"amount":12399,"rate":21,"tax":2600});
});

test('AUDIT-PAYROLL-094 engångstabell kolumn 1 årsinkomst 19200099 öre gräns 192000', () => {
  checkOneOff({"column":1,"annual":19200099,"amount":12345,"rate":21,"tax":2500});
});

test('AUDIT-PAYROLL-095 engångstabell kolumn 1 årsinkomst 19200100 öre gräns 192000', () => {
  checkOneOff({"column":1,"annual":19200100,"amount":12399,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-096 engångstabell kolumn 1 årsinkomst 19200199 öre gräns 192000', () => {
  checkOneOff({"column":1,"annual":19200199,"amount":12345,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-097 engångstabell kolumn 1 årsinkomst 47760000 öre gräns 477600', () => {
  checkOneOff({"column":1,"annual":47760000,"amount":12399,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-098 engångstabell kolumn 1 årsinkomst 47760099 öre gräns 477600', () => {
  checkOneOff({"column":1,"annual":47760099,"amount":12345,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-099 engångstabell kolumn 1 årsinkomst 47760100 öre gräns 477600', () => {
  checkOneOff({"column":1,"annual":47760100,"amount":12399,"rate":34,"tax":4200});
});

test('AUDIT-PAYROLL-100 engångstabell kolumn 1 årsinkomst 47760199 öre gräns 477600', () => {
  checkOneOff({"column":1,"annual":47760199,"amount":12345,"rate":34,"tax":4100});
});

test('AUDIT-PAYROLL-101 engångstabell kolumn 1 årsinkomst 66000000 öre gräns 660000', () => {
  checkOneOff({"column":1,"annual":66000000,"amount":12399,"rate":34,"tax":4200});
});

test('AUDIT-PAYROLL-102 engångstabell kolumn 1 årsinkomst 66000099 öre gräns 660000', () => {
  checkOneOff({"column":1,"annual":66000099,"amount":12345,"rate":34,"tax":4100});
});

test('AUDIT-PAYROLL-103 engångstabell kolumn 1 årsinkomst 66000100 öre gräns 660000', () => {
  checkOneOff({"column":1,"annual":66000100,"amount":12399,"rate":54,"tax":6600});
});

test('AUDIT-PAYROLL-104 engångstabell kolumn 1 årsinkomst 66000199 öre gräns 660000', () => {
  checkOneOff({"column":1,"annual":66000199,"amount":12345,"rate":54,"tax":6600});
});

test('AUDIT-PAYROLL-105 engångstabell kolumn 3 årsinkomst 2504100 öre gräns 25041', () => {
  checkOneOff({"column":3,"annual":2504100,"amount":12399,"rate":0,"tax":0});
});

test('AUDIT-PAYROLL-106 engångstabell kolumn 3 årsinkomst 2504199 öre gräns 25041', () => {
  checkOneOff({"column":3,"annual":2504199,"amount":12345,"rate":0,"tax":0});
});

test('AUDIT-PAYROLL-107 engångstabell kolumn 3 årsinkomst 2504200 öre gräns 25041', () => {
  checkOneOff({"column":3,"annual":2504200,"amount":12399,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-108 engångstabell kolumn 3 årsinkomst 2504299 öre gräns 25041', () => {
  checkOneOff({"column":3,"annual":2504299,"amount":12345,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-109 engångstabell kolumn 3 årsinkomst 33120000 öre gräns 331200', () => {
  checkOneOff({"column":3,"annual":33120000,"amount":12399,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-110 engångstabell kolumn 3 årsinkomst 33120099 öre gräns 331200', () => {
  checkOneOff({"column":3,"annual":33120099,"amount":12345,"rate":10,"tax":1200});
});

test('AUDIT-PAYROLL-111 engångstabell kolumn 3 årsinkomst 33120100 öre gräns 331200', () => {
  checkOneOff({"column":3,"annual":33120100,"amount":12399,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-112 engångstabell kolumn 3 årsinkomst 33120199 öre gräns 331200', () => {
  checkOneOff({"column":3,"annual":33120199,"amount":12345,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-113 engångstabell kolumn 3 årsinkomst 47760000 öre gräns 477600', () => {
  checkOneOff({"column":3,"annual":47760000,"amount":12399,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-114 engångstabell kolumn 3 årsinkomst 47760099 öre gräns 477600', () => {
  checkOneOff({"column":3,"annual":47760099,"amount":12345,"rate":26,"tax":3200});
});

test('AUDIT-PAYROLL-115 engångstabell kolumn 3 årsinkomst 47760100 öre gräns 477600', () => {
  checkOneOff({"column":3,"annual":47760100,"amount":12399,"rate":34,"tax":4200});
});

test('AUDIT-PAYROLL-116 engångstabell kolumn 3 årsinkomst 47760199 öre gräns 477600', () => {
  checkOneOff({"column":3,"annual":47760199,"amount":12345,"rate":34,"tax":4100});
});

test('AUDIT-PAYROLL-117 engångstabell kolumn 3 årsinkomst 66000000 öre gräns 660000', () => {
  checkOneOff({"column":3,"annual":66000000,"amount":12399,"rate":34,"tax":4200});
});

test('AUDIT-PAYROLL-118 engångstabell kolumn 3 årsinkomst 66000099 öre gräns 660000', () => {
  checkOneOff({"column":3,"annual":66000099,"amount":12345,"rate":34,"tax":4100});
});

test('AUDIT-PAYROLL-119 engångstabell kolumn 3 årsinkomst 66000100 öre gräns 660000', () => {
  checkOneOff({"column":3,"annual":66000100,"amount":12399,"rate":55,"tax":6800});
});

test('AUDIT-PAYROLL-120 engångstabell kolumn 3 årsinkomst 66000199 öre gräns 660000', () => {
  checkOneOff({"column":3,"annual":66000199,"amount":12345,"rate":55,"tax":6700});
});

test('AUDIT-PAYROLL-121 arbetsgivaravgift född 1937 datum 2026-01-01 underlag 100001', () => {
  checkContribution({"birth":1937,"date":"2026-01-01","amount":100001,"previous":0,"expected":0,"classification":"born-before-1938"});
});

test('AUDIT-PAYROLL-122 arbetsgivaravgift född 1938 datum 2026-01-01 underlag 100001', () => {
  checkContribution({"birth":1938,"date":"2026-01-01","amount":100001,"previous":0,"expected":10210,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-123 arbetsgivaravgift född 1958 datum 2026-12-31 underlag 3200099', () => {
  checkContribution({"birth":1958,"date":"2026-12-31","amount":3200099,"previous":0,"expected":326730,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-124 arbetsgivaravgift född 1959 datum 2026-12-31 underlag 3200099', () => {
  checkContribution({"birth":1959,"date":"2026-12-31","amount":3200099,"previous":0,"expected":1005471,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-125 arbetsgivaravgift född 2002 datum 2026-04-01 underlag 2500000', () => {
  checkContribution({"birth":2002,"date":"2026-04-01","amount":2500000,"previous":0,"expected":785500,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-126 arbetsgivaravgift född 2003 datum 2026-03-31 underlag 2500000', () => {
  checkContribution({"birth":2003,"date":"2026-03-31","amount":2500000,"previous":0,"expected":785500,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-127 arbetsgivaravgift född 2003 datum 2026-04-01 underlag 2500000', () => {
  checkContribution({"birth":2003,"date":"2026-04-01","amount":2500000,"previous":0,"expected":520250,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-128 arbetsgivaravgift född 2007 datum 2026-03-31 underlag 2500001', () => {
  checkContribution({"birth":2007,"date":"2026-03-31","amount":2500001,"previous":0,"expected":785500,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-129 arbetsgivaravgift född 2007 datum 2026-04-01 underlag 2500001', () => {
  checkContribution({"birth":2007,"date":"2026-04-01","amount":2500001,"previous":0,"expected":520250,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-130 arbetsgivaravgift född 2008 datum 2026-04-01 underlag 2500000', () => {
  checkContribution({"birth":2008,"date":"2026-04-01","amount":2500000,"previous":0,"expected":785500,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-131 arbetsgivaravgift född 2004 datum 2026-06-01 underlag 2499999', () => {
  checkContribution({"birth":2004,"date":"2026-06-01","amount":2499999,"previous":0,"expected":520250,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-132 arbetsgivaravgift född 2004 datum 2026-06-30 underlag 2500100', () => {
  checkContribution({"birth":2004,"date":"2026-06-30","amount":2500100,"previous":0,"expected":520281,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-133 arbetsgivaravgift född 2005 datum 2026-10-25 underlag 100000', () => {
  checkContribution({"birth":2005,"date":"2026-10-25","amount":100000,"previous":0,"expected":20810,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-134 arbetsgivaravgift född 2005 datum 2026-10-25 underlag 8000000', () => {
  checkContribution({"birth":2005,"date":"2026-10-25","amount":8000000,"previous":0,"expected":2248350,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-135 arbetsgivaravgift född 2006 datum 2026-12-31 underlag 2600000', () => {
  checkContribution({"birth":2006,"date":"2026-12-31","amount":2600000,"previous":0,"expected":551670,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-136 arbetsgivaravgift född 1985 datum 2026-04-01 underlag 1', () => {
  checkContribution({"birth":1985,"date":"2026-04-01","amount":1,"previous":0,"expected":0,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-137 arbetsgivaravgift född 1938 datum 2026-04-01 underlag 5', () => {
  checkContribution({"birth":1938,"date":"2026-04-01","amount":5,"previous":0,"expected":1,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-138 arbetsgivaravgift född 1959 datum 2026-04-01 underlag 5', () => {
  checkContribution({"birth":1959,"date":"2026-04-01","amount":5,"previous":0,"expected":2,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-139 arbetsgivaravgift född 1937 datum 2026-10-25 underlag 8000000', () => {
  checkContribution({"birth":1937,"date":"2026-10-25","amount":8000000,"previous":0,"expected":0,"classification":"born-before-1938"});
});

test('AUDIT-PAYROLL-140 arbetsgivaravgift född 2010 datum 2026-10-25 underlag 100000', () => {
  checkContribution({"birth":2010,"date":"2026-10-25","amount":100000,"previous":0,"expected":31420,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-141 månadsackumulerad avgift född 2003 2026-04-01 från 2400000 plus 200000', () => {
  checkContribution({"birth":2003,"date":"2026-04-01","amount":200000,"previous":2400000,"expected":52230,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-142 månadsackumulerad avgift född 2007 2026-04-30 från 2499999 plus 2', () => {
  checkContribution({"birth":2007,"date":"2026-04-30","amount":2,"previous":2499999,"expected":0,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-143 månadsackumulerad avgift född 2004 2026-05-25 från 2500000 plus 100001', () => {
  checkContribution({"birth":2004,"date":"2026-05-25","amount":100001,"previous":2500000,"expected":31420,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-144 månadsackumulerad avgift född 2005 2026-06-25 från 2500001 plus 99999', () => {
  checkContribution({"birth":2005,"date":"2026-06-25","amount":99999,"previous":2500001,"expected":31420,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-145 månadsackumulerad avgift född 2006 2026-12-31 från 1000000 plus 1000000', () => {
  checkContribution({"birth":2006,"date":"2026-12-31","amount":1000000,"previous":1000000,"expected":208100,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-146 månadsackumulerad avgift född 2003 2026-03-31 från 2400000 plus 200000', () => {
  checkContribution({"birth":2003,"date":"2026-03-31","amount":200000,"previous":2400000,"expected":62840,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-147 månadsackumulerad avgift född 2007 2026-03-31 från 2499999 plus 2', () => {
  checkContribution({"birth":2007,"date":"2026-03-31","amount":2,"previous":2499999,"expected":0,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-148 månadsackumulerad avgift född 2002 2026-04-25 från 2499999 plus 2', () => {
  checkContribution({"birth":2002,"date":"2026-04-25","amount":2,"previous":2499999,"expected":0,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-149 månadsackumulerad avgift född 2008 2026-04-25 från 2500000 plus 100', () => {
  checkContribution({"birth":2008,"date":"2026-04-25","amount":100,"previous":2500000,"expected":31,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-150 månadsackumulerad avgift född 1958 2026-04-25 från 2500000 plus 100', () => {
  checkContribution({"birth":1958,"date":"2026-04-25","amount":100,"previous":2500000,"expected":10,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-151 månadsackumulerad avgift född 1937 2026-10-25 från 2500000 plus 100', () => {
  checkContribution({"birth":1937,"date":"2026-10-25","amount":100,"previous":2500000,"expected":0,"classification":"born-before-1938"});
});

test('AUDIT-PAYROLL-152 månadsackumulerad avgift född 1938 2026-10-25 från 100001 plus 100003', () => {
  checkContribution({"birth":1938,"date":"2026-10-25","amount":100003,"previous":100001,"expected":10210,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-153 månadsackumulerad avgift född 1959 2026-10-25 från 100001 plus 100003', () => {
  checkContribution({"birth":1959,"date":"2026-10-25","amount":100003,"previous":100001,"expected":31421,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-154 månadsackumulerad avgift född 1985 2026-10-25 från 5 plus 5', () => {
  checkContribution({"birth":1985,"date":"2026-10-25","amount":5,"previous":5,"expected":1,"classification":"ordinary"});
});

test('AUDIT-PAYROLL-155 månadsackumulerad avgift född 2004 2026-10-25 från 5 plus 5', () => {
  checkContribution({"birth":2004,"date":"2026-10-25","amount":5,"previous":5,"expected":1,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-156 månadsackumulerad avgift född 2005 2026-10-25 från 2499998 plus 1', () => {
  checkContribution({"birth":2005,"date":"2026-10-25","amount":1,"previous":2499998,"expected":0,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-157 månadsackumulerad avgift född 2006 2026-10-25 från 2499998 plus 3', () => {
  checkContribution({"birth":2006,"date":"2026-10-25","amount":3,"previous":2499998,"expected":0,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-158 månadsackumulerad avgift född 2007 2026-10-25 från 2500001 plus 1', () => {
  checkContribution({"birth":2007,"date":"2026-10-25","amount":1,"previous":2500001,"expected":1,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-159 månadsackumulerad avgift född 2003 2026-10-25 från 1 plus 1', () => {
  checkContribution({"birth":2003,"date":"2026-10-25","amount":1,"previous":1,"expected":0,"classification":"youth-monthly-cap"});
});

test('AUDIT-PAYROLL-160 månadsackumulerad avgift född 1958 2026-10-25 från 5 plus 5', () => {
  checkContribution({"birth":1958,"date":"2026-10-25","amount":5,"previous":5,"expected":0,"classification":"pension-contribution"});
});

test('AUDIT-PAYROLL-161 kontant 3200000 förmån 0 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":0,"reimbursement":0,"cashless":false,"taxable":3200000,"withheld":619000,"unwithheld":0,"net":2581000,"employer":1005440});
});

test('AUDIT-PAYROLL-162 kontant 3200000 förmån 1 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":1,"reimbursement":0,"cashless":false,"taxable":3200001,"withheld":619000,"unwithheld":0,"net":2581000,"employer":1005440});
});

test('AUDIT-PAYROLL-163 kontant 3200000 förmån 99 utlägg 1 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":99,"reimbursement":1,"cashless":false,"taxable":3200099,"withheld":619000,"unwithheld":0,"net":2581001,"employer":1005471});
});

test('AUDIT-PAYROLL-164 kontant 3200000 förmån 100 utlägg 9999 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":100,"reimbursement":9999,"cashless":false,"taxable":3200100,"withheld":623900,"unwithheld":0,"net":2586099,"employer":1005471});
});

test('AUDIT-PAYROLL-165 kontant 3200000 förmån 10001 utlägg 10000 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":10001,"reimbursement":10000,"cashless":false,"taxable":3210001,"withheld":623900,"unwithheld":0,"net":2586100,"employer":1008582});
});

test('AUDIT-PAYROLL-166 kontant 3200000 förmån 250000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":250000,"reimbursement":0,"cashless":false,"taxable":3450000,"withheld":682400,"unwithheld":0,"net":2517600,"employer":1083990});
});

test('AUDIT-PAYROLL-167 kontant 3200000 förmån 500000 utlägg 12345 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":500000,"reimbursement":12345,"cashless":false,"taxable":3700000,"withheld":740900,"unwithheld":0,"net":2471445,"employer":1162540});
});

test('AUDIT-PAYROLL-168 kontant 3200000 förmån 800000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":800000,"reimbursement":0,"cashless":false,"taxable":4000000,"withheld":815100,"unwithheld":0,"net":2384900,"employer":1256800});
});

test('AUDIT-PAYROLL-169 kontant 3200000 förmån 2000000 utlägg 99999 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":2000000,"reimbursement":99999,"cashless":false,"taxable":5200000,"withheld":1199100,"unwithheld":0,"net":2100899,"employer":1633840});
});

test('AUDIT-PAYROLL-170 kontant 3200000 förmån 2800000 utlägg 1 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":2800000,"reimbursement":1,"cashless":false,"taxable":6000000,"withheld":1554400,"unwithheld":0,"net":1645601,"employer":1885200});
});

test('AUDIT-PAYROLL-171 kontant 100 förmån 3000000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":100,"benefit":3000000,"reimbursement":0,"cashless":false,"taxable":3000100,"withheld":100,"unwithheld":575000,"net":0,"employer":942631});
});

test('AUDIT-PAYROLL-172 kontant 10000 förmån 3000000 utlägg 12345 hålls skilda', () => {
  checkBenefit({"base":10000,"benefit":3000000,"reimbursement":12345,"cashless":false,"taxable":3010000,"withheld":10000,"unwithheld":565100,"net":12345,"employer":945742});
});

test('AUDIT-PAYROLL-173 kontant 100000 förmån 6000000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":100000,"benefit":6000000,"reimbursement":0,"cashless":false,"taxable":6100000,"withheld":100000,"unwithheld":1506400,"net":0,"employer":1916620});
});

test('AUDIT-PAYROLL-174 kontant 200000 förmån 1000000 utlägg 50000 hålls skilda', () => {
  checkBenefit({"base":200000,"benefit":1000000,"reimbursement":50000,"cashless":false,"taxable":1200000,"withheld":156300,"unwithheld":0,"net":93700,"employer":377040});
});

test('AUDIT-PAYROLL-175 kontant 1 förmån 1000000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":1,"benefit":1000000,"reimbursement":0,"cashless":false,"taxable":1000001,"withheld":1,"unwithheld":116299,"net":0,"employer":314200});
});

test('AUDIT-PAYROLL-176 kontant 2000000 förmån 1 utlägg 76543 hålls skilda', () => {
  checkBenefit({"base":2000000,"benefit":1,"reimbursement":76543,"cashless":false,"taxable":2000001,"withheld":329000,"unwithheld":0,"net":1747543,"employer":628400});
});

test('AUDIT-PAYROLL-177 kontant 0 förmån 3200000 utlägg 0 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":3200000,"reimbursement":0,"cashless":true,"taxable":3200000,"withheld":0,"unwithheld":619000,"net":0,"employer":1005440});
});

test('AUDIT-PAYROLL-178 kontant 0 förmån 3200000 utlägg 10000 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":3200000,"reimbursement":10000,"cashless":true,"taxable":3200000,"withheld":0,"unwithheld":619000,"net":10000,"employer":1005440});
});

test('AUDIT-PAYROLL-179 kontant 0 förmån 200000 utlägg 99999 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":200000,"reimbursement":99999,"cashless":true,"taxable":200000,"withheld":0,"unwithheld":0,"net":99999,"employer":62840});
});

test('AUDIT-PAYROLL-180 kontant 0 förmån 8000000 utlägg 1 hålls skilda', () => {
  checkBenefit({"base":3200000,"benefit":8000000,"reimbursement":1,"cashless":true,"taxable":8000000,"withheld":0,"unwithheld":2594400,"net":1,"employer":2513600});
});

test('AUDIT-PAYROLL-181 obetald frånvaro 1 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":1},"deduction":200,"sickPay":0,"karens":0,"salary":3199800});
});

test('AUDIT-PAYROLL-182 obetald frånvaro 99 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":99},"deduction":19800,"sickPay":0,"karens":0,"salary":3180200});
});

test('AUDIT-PAYROLL-183 obetald frånvaro 100 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":100},"deduction":20000,"sickPay":0,"karens":0,"salary":3180000});
});

test('AUDIT-PAYROLL-184 obetald frånvaro 400 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":400},"deduction":80000,"sickPay":0,"karens":0,"salary":3120000});
});

test('AUDIT-PAYROLL-185 obetald frånvaro 800 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":800},"deduction":160000,"sickPay":0,"karens":0,"salary":3040000});
});

test('AUDIT-PAYROLL-186 obetald frånvaro 1234 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":1234},"deduction":246800,"sickPay":0,"karens":0,"salary":2953200});
});

test('AUDIT-PAYROLL-187 obetald frånvaro 8000 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":8000},"deduction":1600000,"sickPay":0,"karens":0,"salary":1600000});
});

test('AUDIT-PAYROLL-188 obetald frånvaro 16000 hundradels timmar', () => {
  checkAbsence({"input":{"unpaidHoursHundredths":16000,"reimbursementCents":1},"deduction":3200000,"sickPay":0,"karens":0,"salary":0});
});

test('AUDIT-PAYROLL-189 sjuklön 2026-10-20–2026-10-20 1 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":1,"sickScheduledHoursHundredths":1,"sickScheduleConfirmed":true,"sickStart":"2026-10-20","sickEnd":"2026-10-20"},"deduction":200,"sickPay":160,"karens":160,"salary":3199800});
});

test('AUDIT-PAYROLL-190 sjuklön 2026-10-20–2026-10-20 100 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":100,"sickScheduledHoursHundredths":100,"sickScheduleConfirmed":true,"sickStart":"2026-10-20","sickEnd":"2026-10-20"},"deduction":20000,"sickPay":16000,"karens":16000,"salary":3180000});
});

test('AUDIT-PAYROLL-191 sjuklön 2026-10-20–2026-10-20 400 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":400,"sickScheduledHoursHundredths":400,"sickScheduleConfirmed":true,"sickStart":"2026-10-20","sickEnd":"2026-10-20"},"deduction":80000,"sickPay":64000,"karens":64000,"salary":3120000});
});

test('AUDIT-PAYROLL-192 sjuklön 2026-10-20–2026-10-20 800 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":800,"sickScheduledHoursHundredths":800,"sickScheduleConfirmed":true,"sickStart":"2026-10-20","sickEnd":"2026-10-20"},"deduction":160000,"sickPay":128000,"karens":128000,"salary":3040000});
});

test('AUDIT-PAYROLL-193 sjuklön 2026-10-19–2026-10-20 1200 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":1200,"sickScheduledHoursHundredths":1200,"sickScheduleConfirmed":true,"sickStart":"2026-10-19","sickEnd":"2026-10-20"},"deduction":240000,"sickPay":192000,"karens":128000,"salary":3024000});
});

test('AUDIT-PAYROLL-194 sjuklön 2026-10-19–2026-10-21 2400 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":2400,"sickScheduledHoursHundredths":2400,"sickScheduleConfirmed":true,"sickStart":"2026-10-19","sickEnd":"2026-10-21"},"deduction":480000,"sickPay":384000,"karens":128000,"salary":2976000});
});

test('AUDIT-PAYROLL-195 sjuklön 2026-10-12–2026-10-25 5600 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":5600,"sickScheduledHoursHundredths":5600,"sickScheduleConfirmed":true,"sickStart":"2026-10-12","sickEnd":"2026-10-25"},"deduction":1120000,"sickPay":896000,"karens":128000,"salary":2848000});
});

test('AUDIT-PAYROLL-196 sjuklön 2026-10-12–2026-10-25 8000 hundradels timmar', () => {
  checkAbsence({"input":{"sickHoursHundredths":8000,"sickScheduledHoursHundredths":8000,"sickScheduleConfirmed":true,"sickStart":"2026-10-12","sickEnd":"2026-10-25"},"deduction":1600000,"sickPay":1280000,"karens":128000,"salary":2752000});
});

test('AUDIT-PAYROLL-197 15 kalenderdagar kräver separat granskning', () => {
  rejectsUnchanged(fixture(), state => batch(state, {"sickHoursHundredths":800,"sickScheduledHoursHundredths":800,"sickScheduleConfirmed":true,"sickStart":"2026-10-01","sickEnd":"2026-10-15"}), /14 kalenderdagar/);
});

test('AUDIT-PAYROLL-198 sjukfrånvaro utan bekräftat schema', () => {
  rejectsUnchanged(fixture(), state => batch(state, {"sickHoursHundredths":800,"sickStart":"2026-10-20","sickEnd":"2026-10-20"}), /granskat arbetsschema/);
});

test('AUDIT-PAYROLL-199 frånvaro större än schema', () => {
  rejectsUnchanged(fixture(), state => batch(state, {"unpaidHoursHundredths":16001}), /överstiger schemalagd/);
});

test('AUDIT-PAYROLL-200 sjukdatum utan timmar', () => {
  rejectsUnchanged(fixture(), state => batch(state, {"sickStart":"2026-10-20","sickEnd":"2026-10-20"}), /Sjukdatum/);
});

test('AUDIT-PAYROLL-201 semesterintjänande 2025-04-01–2026-03-31 frånvaro 0 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2025-04-01","employmentEnd":"2026-03-31","nonQualifyingDays":0,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 365); assert.equal(y.qualifyingDays, 365); assert.equal(y.earnedDays, 25);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-202 semesterintjänande 2025-04-01–2026-03-31 frånvaro 1 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2025-04-01","employmentEnd":"2026-03-31","nonQualifyingDays":1,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 365); assert.equal(y.qualifyingDays, 364); assert.equal(y.earnedDays, 25);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-203 semesterintjänande 2025-10-01–2026-03-31 frånvaro 7 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2025-10-01","employmentEnd":"2026-03-31","nonQualifyingDays":7,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 182); assert.equal(y.qualifyingDays, 175); assert.equal(y.earnedDays, 12);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-204 semesterintjänande 2026-03-31–2026-03-31 frånvaro 0 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2026-03-31","employmentEnd":"2026-03-31","nonQualifyingDays":0,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 1); assert.equal(y.qualifyingDays, 1); assert.equal(y.earnedDays, 1);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-205 semesterintjänande 2024-01-01–2025-03-31 frånvaro 0 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2024-01-01","employmentEnd":"2025-03-31","nonQualifyingDays":0,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 0); assert.equal(y.qualifyingDays, 0); assert.equal(y.earnedDays, 0);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-206 semesterintjänande 2024-01-01–2027-01-01 frånvaro 180 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2024-01-01","employmentEnd":"2027-01-01","nonQualifyingDays":180,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 365); assert.equal(y.qualifyingDays, 185); assert.equal(y.earnedDays, 13);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-207 semesterintjänande 2023-04-01–2024-03-31 frånvaro 0 år 366 dagar', () => {
  const state = year(fixture(), {"earningStart":"2023-04-01","earningEnd":"2024-03-31","employmentStart":"2023-04-01","employmentEnd":"2024-03-31","nonQualifyingDays":0,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 366); assert.equal(y.employedDays, 366); assert.equal(y.qualifyingDays, 366); assert.equal(y.earnedDays, 25);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-208 semesterintjänande 2024-02-29–2024-03-31 frånvaro 0 år 366 dagar', () => {
  const state = year(fixture(), {"earningStart":"2023-04-01","earningEnd":"2024-03-31","employmentStart":"2024-02-29","employmentEnd":"2024-03-31","nonQualifyingDays":0,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 366); assert.equal(y.employedDays, 32); assert.equal(y.qualifyingDays, 32); assert.equal(y.earnedDays, 3);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-209 semesterintjänande 2023-04-01–2024-03-31 frånvaro 366 år 366 dagar', () => {
  const state = year(fixture(), {"earningStart":"2023-04-01","earningEnd":"2024-03-31","employmentStart":"2023-04-01","employmentEnd":"2024-03-31","nonQualifyingDays":366,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 366); assert.equal(y.employedDays, 366); assert.equal(y.qualifyingDays, 0); assert.equal(y.earnedDays, 0);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-210 semesterintjänande 2026-01-01–2026-03-31 frånvaro 5 år 365 dagar', () => {
  const state = year(fixture(), {"earningStart":"2025-04-01","earningEnd":"2026-03-31","employmentStart":"2026-01-01","employmentEnd":"2026-03-31","nonQualifyingDays":5,"date":"2026-04-01"}), y = state.payrollVacationYears[0];
  assert.equal(y.yearDays, 365); assert.equal(y.employedDays, 90); assert.equal(y.qualifyingDays, 85); assert.equal(y.earnedDays, 6);
  validateSuiteState(state);
});

test('AUDIT-PAYROLL-211 procentsemester underlag 24000001 sparade dagar 0 uttag [1, 24]', () => {
  let state = year(fixture({ payType: 'hourly', base: 20000 }), {"eligibleEarningsCents":24000001,"carriedDays":0,"carriedMoneyCents":0});
  const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 1, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25', 'paid');
  assert.equal(person(state).vacationPayCents, 115200);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 24, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-06-25', 'paid');
  assert.equal(person(state).vacationPayCents, 2764800);
  assert.equal(getVacationBalance(state, id).remainingDays, 0); assert.equal(getVacationBalance(state, id).remainingMoneyCents, 0);
  assert.equal(state.payrollBatches.reduce((n, b) => n + b.people[0].vacationPayCents, 0), 2880000); validateSuiteState(state);
});

test('AUDIT-PAYROLL-212 procentsemester underlag 24000007 sparade dagar 0 uttag [7, 8, 10]', () => {
  let state = year(fixture({ payType: 'hourly', base: 20000 }), {"eligibleEarningsCents":24000007,"carriedDays":0,"carriedMoneyCents":0});
  const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 7, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25', 'paid');
  assert.equal(person(state).vacationPayCents, 806400);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 8, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-06-25', 'paid');
  assert.equal(person(state).vacationPayCents, 921601);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 10, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-07-25', 'paid');
  assert.equal(person(state).vacationPayCents, 1152000);
  assert.equal(getVacationBalance(state, id).remainingDays, 0); assert.equal(getVacationBalance(state, id).remainingMoneyCents, 0);
  assert.equal(state.payrollBatches.reduce((n, b) => n + b.people[0].vacationPayCents, 0), 2880001); validateSuiteState(state);
});

test('AUDIT-PAYROLL-213 procentsemester underlag 31000019 sparade dagar 0 uttag [3, 3, 3, 16]', () => {
  let state = year(fixture({ payType: 'hourly', base: 20000 }), {"eligibleEarningsCents":31000019,"carriedDays":0,"carriedMoneyCents":0});
  const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 3, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25', 'paid');
  assert.equal(person(state).vacationPayCents, 446400);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 3, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-06-25', 'paid');
  assert.equal(person(state).vacationPayCents, 446400);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 3, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-07-25', 'paid');
  assert.equal(person(state).vacationPayCents, 446401);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 16, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-08-25', 'paid');
  assert.equal(person(state).vacationPayCents, 2380801);
  assert.equal(getVacationBalance(state, id).remainingDays, 0); assert.equal(getVacationBalance(state, id).remainingMoneyCents, 0);
  assert.equal(state.payrollBatches.reduce((n, b) => n + b.people[0].vacationPayCents, 0), 3720002); validateSuiteState(state);
});

test('AUDIT-PAYROLL-214 procentsemester underlag 24000001 sparade dagar 5 uttag [10, 10, 10]', () => {
  let state = year(fixture({ payType: 'hourly', base: 20000 }), {"eligibleEarningsCents":24000001,"carriedDays":5,"carriedMoneyCents":500123,"carriedFromYear":2025});
  const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 10, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25', 'paid');
  assert.equal(person(state).vacationPayCents, 1126708);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 10, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-06-25', 'paid');
  assert.equal(person(state).vacationPayCents, 1126707);
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 10, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-07-25', 'paid');
  assert.equal(person(state).vacationPayCents, 1126708);
  assert.equal(getVacationBalance(state, id).remainingDays, 0); assert.equal(getVacationBalance(state, id).remainingMoneyCents, 0);
  assert.equal(state.payrollBatches.reduce((n, b) => n + b.people[0].vacationPayCents, 0), 3380123); validateSuiteState(state);
});

test('AUDIT-PAYROLL-215 semesteråterföring same-pay later-month bevarar tidsordnade original', () => {
  let state = year(fixture()); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-06-25');
  assert.equal(getVacationBalance(state, id).usedDays, 6);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-06-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-06-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-06-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-216 semesteråterföring same-pay same-day bevarar tidsordnade original', () => {
  let state = year(fixture()); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-05-25');
  assert.equal(getVacationBalance(state, id).usedDays, 6);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-05-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-05-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-05-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-217 semesteråterföring same-pay replacement bevarar tidsordnade original', () => {
  let state = year(fixture()); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  const discarded = state.payrollBatches[0].id; state = reversePayrollBatch(state, discarded, { date: '2026-05-25', reason: 'Ersätt felaktigt uttag samma dag' });
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 3 }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-06-25');
  assert.equal(getVacationBalance(state, id).usedDays, 7);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-06-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-06-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-06-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-218 semesteråterföring percentage later-month bevarar tidsordnade original', () => {
  let state = year(fixture({ method: 'percentage', payType: 'hourly', base: 20000 })); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-06-25');
  assert.equal(getVacationBalance(state, id).usedDays, 6);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-06-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-06-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-06-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-219 semesteråterföring percentage same-day bevarar tidsordnade original', () => {
  let state = year(fixture({ method: 'percentage', payType: 'hourly', base: 20000 })); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-05-25');
  assert.equal(getVacationBalance(state, id).usedDays, 6);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-05-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-05-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-05-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-220 semesteråterföring percentage replacement bevarar tidsordnade original', () => {
  let state = year(fixture({ method: 'percentage', payType: 'hourly', base: 20000 })); const id = state.payrollVacationYears[0].id;
  state = batch(state, { kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-05-25');
  const discarded = state.payrollBatches[0].id; state = reversePayrollBatch(state, discarded, { date: '2026-05-25', reason: 'Ersätt felaktigt uttag samma dag' });
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 3 }, '2026-05-25');
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 4 }, '2026-06-25');
  assert.equal(getVacationBalance(state, id).usedDays, 7);
  const older = state.payrollBatches.at(-2).id, newer = state.payrollBatches.at(-1).id;
  const originals = state.payrollBatches.slice(-2).map(b => b.snapshot);
  rejectsUnchanged(state, s => reversePayrollBatch(s, older, { date: '2026-06-25', reason: 'Fel ordning' }), /senare|Senare/);
  state = reversePayrollBatch(state, newer, { date: '2026-06-25', reason: 'Rätta senare semesteruttag' });
  state = reversePayrollBatch(state, older, { date: '2026-06-25', reason: 'Rätta tidigare semesteruttag' });
  assert.deepEqual(state.payrollBatches.slice(-2).map(b => b.snapshot), originals);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
  state = batch(state, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 25 }, '2026-07-25');
  assert.equal(person(state).context.vacationYearUsedDays, 0); assert.equal(getVacationBalance(state, id).remainingDays, 0);
  rejectsUnchanged(state, s => batch(s, { ...{ kind: 'vacation-final', vacationYearId: id, vacationDays: 2, finalDailyCents: 100000, finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true }, vacationDays: 1 }, '2026-08-25'), /intjänade/); validateSuiteState(state);
});

test('AUDIT-PAYROLL-221 bruttoåterkrav född 1985 från 3200000 belopp 100000 reglerad False', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 1985 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = recovery(state, { grossCents: 100000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 31420); assert.equal(claim.contributionHandling, 'reduce-unpaid');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 100000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 3100000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 33333, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 66667, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-30' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-222 bruttoåterkrav född 1985 från 3200000 belopp 110003 reglerad True', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 1985 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-26' });
  state = recovery(state, { grossCents: 110003 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 34563); assert.equal(claim.contributionHandling, 'tax-credit');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 110003);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 3089997); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 36667, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 73336, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = receivePayrollRecoveryTaxCredit(state, claim.id, { date: '2026-10-30', reference: 'SKV omprövningsbeslut' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-223 bruttoåterkrav född 1958 från 3200000 belopp 100000 reglerad False', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 1958 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = recovery(state, { grossCents: 100000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 10210); assert.equal(claim.contributionHandling, 'reduce-unpaid');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 100000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 3100000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 33333, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 66667, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-30' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-224 bruttoåterkrav född 1958 från 3200000 belopp 150003 reglerad True', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 1958 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-26' });
  state = recovery(state, { grossCents: 150003 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 15315); assert.equal(claim.contributionHandling, 'tax-credit');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 150003);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 3049997); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 50001, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 100002, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = receivePayrollRecoveryTaxCredit(state, claim.id, { date: '2026-10-30', reference: 'SKV omprövningsbeslut' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-225 bruttoåterkrav född 1937 från 3200000 belopp 100000 reglerad False', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 1937 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = recovery(state, { grossCents: 100000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 0); assert.equal(claim.contributionHandling, 'reduce-unpaid');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 100000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 3100000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 33333, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 66667, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-30' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-226 bruttoåterkrav född 2003 från 2400000 belopp 100000 reglerad False', () => {
  let state = batch(fixture({ base: 2400000, birthYear: 2003 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = recovery(state, { grossCents: 100000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 20810); assert.equal(claim.contributionHandling, 'reduce-unpaid');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 100000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 2300000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 33333, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 66667, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-30' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-227 bruttoåterkrav född 2007 från 2600000 belopp 200000 reglerad False', () => {
  let state = batch(fixture({ base: 2600000, birthYear: 2007 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = recovery(state, { grossCents: 200000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 52230); assert.equal(claim.contributionHandling, 'reduce-unpaid');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 200000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 2400000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 66666, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 133334, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-30' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-228 bruttoåterkrav född 2003 från 3200000 belopp 900000 reglerad True', () => {
  let state = batch(fixture({ base: 3200000, birthYear: 2003 }), {}, '2026-10-25', 'paid');
  const batchId = state.payrollBatches[0].id, originalSnapshot = state.payrollBatches[0].snapshot, originalTax = person(state).withholdingCents;
  state = settlePayrollBatchTaxes(state, batchId, { date: '2026-10-26' });
  state = recovery(state, { grossCents: 900000 }); const claim = state.payrollRecoveries[0];
  assert.equal(claim.employerReductionCents, 261560); assert.equal(claim.contributionHandling, 'tax-credit');
  assert.equal(state.payrollBatches[0].snapshot, originalSnapshot); assert.equal(accountBalance(state, '1680'), 900000);
  const declared = getPayrollDeclarationPeople(state, '2026-10')[0]; assert.equal(declared.grossCents, 2300000); assert.equal(declared.withholdingCents, originalTax);
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-28', amountCents: 300000, reference: 'Del 1' });
  state = receivePayrollRecovery(state, claim.id, { date: '2026-10-29', amountCents: 600000, reference: 'Del 2' }); assert.equal(accountBalance(state, '1680'), 0);
  state = receivePayrollRecoveryTaxCredit(state, claim.id, { date: '2026-10-30', reference: 'SKV omprövningsbeslut' });
  assert.equal(accountBalance(state, '2731'), 0); assert.equal(accountBalance(state, '2710'), 0); validateSuiteState(state);
});

test('AUDIT-PAYROLL-229 legacyunderlag och modernt tillägg född 1985 tillägg 50000', () => {
  let state = fixture({ birthYear: 1985, employerRate: 3142, withholding: 619000 });
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-10-25' });
  state = batch(state, { kind: 'supplement', additionalGrossCents: 50000 }, '2026-10-28', 'paid');
  assert.equal(person(state).context.previousTaxableCents, 3200000); assert.equal(person(state).context.previousWithheldCents, 619000);
  assert.equal(person(state).employerCents, 15710); assert.deepEqual(person(state).context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3250000); validateSuiteState(state);
});

test('AUDIT-PAYROLL-230 legacyunderlag och modernt tillägg född 1958 tillägg 100000', () => {
  let state = fixture({ birthYear: 1958, employerRate: 1021, withholding: 294300 });
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-10-25' });
  state = batch(state, { kind: 'supplement', additionalGrossCents: 100000 }, '2026-10-28', 'paid');
  assert.equal(person(state).context.previousTaxableCents, 3200000); assert.equal(person(state).context.previousWithheldCents, 294300);
  assert.equal(person(state).employerCents, 10210); assert.deepEqual(person(state).context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3300000); validateSuiteState(state);
});

test('AUDIT-PAYROLL-231 legacyunderlag och modernt tillägg född 2003 tillägg 10000', () => {
  let state = fixture({ birthYear: 2003, employerRate: 3142, withholding: 619000 });
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-10-25' });
  state = batch(state, { kind: 'supplement', additionalGrossCents: 10000 }, '2026-10-28', 'paid');
  assert.equal(person(state).context.previousTaxableCents, 3200000); assert.equal(person(state).context.previousWithheldCents, 619000);
  assert.equal(person(state).employerCents, 3142); assert.deepEqual(person(state).context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3210000); validateSuiteState(state);
});

test('AUDIT-PAYROLL-232 legacyunderlag och modernt tillägg född 2007 tillägg 90000', () => {
  let state = fixture({ birthYear: 2007, employerRate: 3142, withholding: 619000 });
  state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-10-25' });
  state = batch(state, { kind: 'supplement', additionalGrossCents: 90000 }, '2026-10-28', 'paid');
  assert.equal(person(state).context.previousTaxableCents, 3200000); assert.equal(person(state).context.previousWithheldCents, 619000);
  assert.equal(person(state).employerCents, 28278); assert.deepEqual(person(state).context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3290000); validateSuiteState(state);
});

test('AUDIT-PAYROLL-233 återkrav överkrav stoppas atomärt', () => {
  const state = batch(fixture(), {}, '2026-10-25', 'paid');
  rejectsUnchanged(state, s => recovery(s, {"grossCents":3200001}), /överstiger/);
});

test('AUDIT-PAYROLL-234 återkrav utan granskning stoppas atomärt', () => {
  const state = batch(fixture(), {}, '2026-10-25', 'paid');
  rejectsUnchanged(state, s => recovery(s, {"reviewed":false}), /Granska/);
});

test('AUDIT-PAYROLL-235 återkrav utan AGI-rättelse stoppas atomärt', () => {
  const state = batch(fixture(), {}, '2026-10-25', 'paid');
  rejectsUnchanged(state, s => recovery(s, {"agiCorrectionConfirmed":false}), /bekräfta/);
});

test('AUDIT-PAYROLL-236 återkrav före faktisk löneutbetalning stoppas atomärt', () => {
  const state = batch(fixture(), {}, '2026-10-25', 'paid');
  rejectsUnchanged(state, s => recovery(s, {"date":"2026-10-24"}), /före löneutbetalningen/);
});

test('AUDIT-PAYROLL-237 flyttad legacybetalning deklareras i faktisk november', () => {
  let state = fixture(); state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-11-03' });
  assert.deepEqual(getPayrollDeclarationPeople(state, '2026-10'), []); assert.equal(getPayrollDeclarationPeople(state, '2026-11')[0].grossCents, 3200000);
  rejectsUnchanged(state, s => batch(s, {}, '2026-11-25'), /flyttad utbetalningsmånad/);
});

test('AUDIT-PAYROLL-238 modernt utkast blockerar senare flyttning av äldre utbetalning', () => {
  let state = fixture(); state = createPayrollRun(state, { date: '2026-10-25', month: '2026-10' }); state = postPayroll(state, state.payrollRuns[0].id);
  state = batch(state, {}, '2026-11-25', 'draft');
  rejectsUnchanged(state, s => payPayroll(s, s.payrollRuns[0].id, { date: '2026-11-03' }), /flyttad utbetalningsmånad/);
  state = discardPayrollDraft(state, state.payrollBatches[0].id); state = payPayroll(state, state.payrollRuns[0].id, { date: '2026-11-03' }); validateSuiteState(state);
});

test('AUDIT-PAYROLL-239 återkravets bankinbetalning måste finnas vid återläsning', () => {
  let state = recovery(batch(fixture(), {}, '2026-10-25', 'paid'));
  state = receivePayrollRecovery(state, state.payrollRecoveries[0].id, { date: '2026-10-28', amountCents: 50000, reference: 'Bank 1' });
  validateSuiteState(state); const bad = structuredClone(state); bad.bankTransactions = bad.bankTransactions.filter(b => b.matchedEntryId !== bad.payrollRecoveries[0].payments[0].entryId);
  assert.throws(() => validateSuiteState(bad), /bankinbetalning|saknas/);
});

test('AUDIT-PAYROLL-240 återkrav kan inte minska engångsbelopp med periodisk skatteklass', () => {
  let state = batch(fixture(), { additionalGrossCents: 500000, extraTaxMode: 'one-off', annualSalaryCents: 50000000, annualSalaryReviewed: true }, '2026-10-25', 'paid');
  rejectsUnchanged(state, s => recovery(s, { grossCents: 3200001, taxClass: 'periodic' }), /överstiger/);
  state = recovery(state, { grossCents: 500000, taxClass: 'one-off' });
  assert.equal(getPayrollDeclarationPeople(state, '2026-10')[0].grossCents, 3200000); assert.equal(person(state).oneOffWithholdingCents, 170000); validateSuiteState(state);
});

// PAY-02: no new calculation may borrow days from a later-dated reversal.
test('AUDIT-PAYROLL-241 same-pay framtida återföring kan inte finansiera bakdaterat uttag', () => {
    let state = year(fixture());
    const id = state.payrollVacationYears[0].id;
    const input = { kind: 'vacation-final', vacationYearId: id, vacationDays: 25, finalDailyCents: 100000,
      finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true };
    state = batch(state, input, '2026-05-25');
    const snapshot = state.payrollBatches[0].snapshot;
    state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-07-01', reason: 'Felaktigt uttag återförs i juli' });
    rejectsUnchanged(state, s => batch(s, input, '2026-06-25'), /före.*återföring/);
    state = batch(state, input, '2026-07-01');
    assert.equal(state.payrollBatches[0].snapshot, snapshot);
    assert.equal(getVacationBalance(state, id).remainingDays, 0);
    validateSuiteState(state);
});

test('AUDIT-PAYROLL-242 percentage framtida återföring kan inte finansiera bakdaterat uttag', () => {
    let state = year(fixture({ method: 'percentage', payType: 'hourly', base: 20000 }));
    const id = state.payrollVacationYears[0].id;
    const input = { kind: 'vacation-final', vacationYearId: id, vacationDays: 25, finalDailyCents: 100000,
      finalCompensationReviewed: true, annualSalaryCents: 50000000, annualSalaryReviewed: true };
    state = batch(state, input, '2026-05-25');
    const snapshot = state.payrollBatches[0].snapshot;
    state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-07-01', reason: 'Felaktigt uttag återförs i juli' });
    rejectsUnchanged(state, s => batch(s, input, '2026-06-25'), /före.*återföring/);
    state = batch(state, input, '2026-07-01');
    assert.equal(state.payrollBatches[0].snapshot, snapshot);
    assert.equal(getVacationBalance(state, id).remainingDays, 0);
    validateSuiteState(state);
});

test('AUDIT-PAYROLL-243 återföring i annat semesterår spärrar inte det valda årets uttag', () => {
  let state = year(fixture());
  const firstId = state.payrollVacationYears[0].id;
  state = year(state, { earningStart: '2025-01-01', earningEnd: '2025-12-31', employmentStart: '2025-01-01', employmentEnd: '2025-12-31', reference: 'Annat avtalsenligt semesterår' });
  const secondId = state.payrollVacationYears[1].id;
  state = batch(state, { vacationYearId: firstId, vacationDays: 1 }, '2026-05-25');
  state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-07-01', reason: 'Rättelse av första året' });
  state = batch(state, { vacationYearId: secondId, vacationDays: 1 }, '2026-06-25');
  assert.equal(getVacationBalance(state, firstId).remainingDays, 25);
  assert.equal(getVacationBalance(state, secondId).remainingDays, 24); validateSuiteState(state);
});

test('AUDIT-PAYROLL-244 historiskt semestersaldo ändras inte av senare daterad återföring', () => {
  let state = year(fixture()); const id = state.payrollVacationYears[0].id;
  state = batch(state, { vacationYearId: id, vacationDays: 2 }, '2026-05-25');
  state = batch(state, { vacationYearId: id, vacationDays: 3 }, '2026-06-25');
  const originalContext = structuredClone(person(state).context);
  assert.equal(originalContext.vacationYearUsedDays, 2);
  state = reversePayrollBatch(state, state.payrollBatches[1].id, { date: '2026-07-01', reason: 'Rätta juni först' });
  state = reversePayrollBatch(state, state.payrollBatches[0].id, { date: '2026-08-01', reason: 'Rätta maj därefter' });
  assert.deepEqual(state.payrollBatches[1].people[0].context, originalContext);
  assert.equal(getVacationBalance(state, id).remainingDays, 25); validateSuiteState(state);
});
