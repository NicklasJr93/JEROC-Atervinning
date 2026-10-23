import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, appendEntry, createEmptyState, transact, validateState } from '../public/bokforing/suite/core.js';
import { createEmployee, createPayrollRun, postPayroll } from '../public/bokforing/suite/finance.js';
import { TAX_TABLES_2026 } from '../public/bokforing/suite/payroll-tax-tables-2026.js';
import { calculateEmployerContributions, calculateOneOffTax, calculatePayrollPerson, createPayrollBatch, discardPayrollDraft, getPayrollBatchTotals, lookupPayrollTax, payPayrollBatch, payrollReviewCsv, postPayrollBatch, reversePayrollBatch, savePayrollProfile, settlePayrollBatchTaxes, validatePayrollBatches } from '../public/bokforing/suite/payroll-engine.js';
import { handleAction, renderWorkspace } from '../public/bokforing/suite/payroll-workspace.js';

const debit = (account, debitCents) => ({ account, debitCents, creditCents: 0 });
const credit = (account, creditCents) => ({ account, debitCents: 0, creditCents });
function fixture({ payType = 'monthly', baseCents = 3_200_000, birthYear = 1985 } = {}) {
  let state = transact(createEmptyState(), draft => appendEntry(draft, { date: '2026-01-01', description: 'Ingående balans', sourceType: 'opening', sourceId: 'opening', rows: [debit('1930', 10_000_000), credit('2081', 10_000_000)] }));
  state = createEmployee(state, { name: 'Testpersonen', payType, baseCents });
  return savePayrollProfile(state, profile(state.employees[0].id, { birthYear, vacationMethod: payType === 'monthly' ? 'same-pay' : 'percentage' }));
}
function profile(employeeId, extra = {}) { return { employeeId, date: '2026-10-01', birthYear: 1985, taxMode: 'table', table: 32, column: 1, weeklyHoursHundredths: 4000, deductionHourlyCents: 20_000, vacationMethod: 'same-pay', vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25, agreementNote: 'Granskat testavtal', reviewed: true, domesticOrdinary: true, ...extra }; }
const person = (state, extra = {}) => ({ employeeId: state.employees[0].id, scheduledHoursHundredths: 16_000,
  ...(extra.sickHoursHundredths ? { sickScheduledHoursHundredths: extra.sickHoursHundredths, sickScheduleConfirmed: true } : {}), ...extra });
const create = (state, extra = {}, date = '2026-10-25') => createPayrollBatch(state, { date, people: [person(state, extra)] });
function posted(state, extra = {}, date = '2026-10-25') { const next = create(state, extra, date); return postPayrollBatch(next, next.payrollBatches.at(-1).id, { reviewed: true }); }

test('all official 2026 table extracts have a contiguous 1–80000 range and traceable source', () => {
  assert.equal(Object.keys(TAX_TABLES_2026).length, 14);
  for (const [table, source] of Object.entries(TAX_TABLES_2026)) {
    assert.match(source.url, new RegExp(`skatteverket.se/.+tabell-${table}\\.pdf$`)); assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(source) && Object.isFrozen(source.rows) && Object.isFrozen(source.rows[0]));
    assert.equal(source.rows[0][0], 1); assert.equal(source.rows.at(-1)[1], 80000);
    source.rows.forEach((row, index) => { assert.equal(row.length, 8); assert.ok(row.every(Number.isSafeInteger)); if (index) assert.equal(row[0], source.rows[index - 1][1] + 1); });
  }
});

test('tax table 32 uses actual SKVFS2025:20 amounts and whole kronor boundaries', () => {
  assert.equal(lookupPayrollTax({ table: 32, column: 1, taxableCents: 3_200_000 }).taxCents, 619_000);
  assert.equal(lookupPayrollTax({ table: 32, column: 1, taxableCents: 3_200_099 }).taxCents, 619_000);
  assert.deepEqual(lookupPayrollTax({ table: 32, column: 1, taxableCents: 3_200_100 }).band, [32001, 32200]);
  assert.equal(lookupPayrollTax({ table: 32, column: 1, taxableCents: 200_000 }).taxCents, 0);
  assert.equal(lookupPayrollTax({ table: 32, column: 1, taxableCents: 210_000 }).taxCents, 15_000);
  assert.equal(lookupPayrollTax({ table: 32, column: 3, taxableCents: 840_000 }).taxCents, 63_800);
  assert.throws(() => lookupPayrollTax({ table: 32, column: 1, year: 2027, taxableCents: 100 }), /2026/);
  assert.throws(() => lookupPayrollTax({ table: 32, column: 1, taxableCents: 8_000_001 }), /80 000/);
  assert.throws(() => lookupPayrollTax({ table: 32, column: 2, taxableCents: 100 }), /kolumn/);
});

test('domestic employer rates use birth year and the youth reduction start date', () => {
  const value = (birthYear, paymentDate, taxableCents, previousTaxableCents = 0) => calculateEmployerContributions({ birthYear, paymentDate, taxableCents, previousTaxableCents }).contributionCents;
  assert.equal(value(1985, '2026-10-25', 3_000_000), 942_600);
  assert.equal(value(1958, '2026-10-25', 3_000_000), 306_300);
  assert.equal(value(1937, '2026-10-25', 3_000_000), 0);
  assert.equal(value(2003, '2026-03-31', 3_000_000), 942_600);
  assert.equal(value(2003, '2026-04-01', 3_000_000), 677_350);
  assert.equal(value(2007, '2026-10-25', 1_000_000, 2_000_000), 261_150);
  assert.throws(() => value(2003, '2027-01-01', 3_000_000), /2026/);
});

test('profile requires individual review and a reference for manual tax', () => {
  const state = fixture(); const id = state.employees[0].id;
  assert.throws(() => savePayrollProfile(state, profile(id, { reviewed: false })), /Bekräfta/);
  assert.throws(() => savePayrollProfile(state, profile(id, { domesticOrdinary: false })), /Bekräfta/);
  assert.throws(() => savePayrollProfile(state, profile(id, { taxMode: 'decision' })), /referens/);
});

test('salary table tax, benefits and reimbursement remain distinct through payment and tax settlement', () => {
  let state = posted(fixture(), { benefitCents: 100_000, reimbursementCents: 30_000 });
  const batch = state.payrollBatches[0], p = batch.people[0];
  assert.equal(p.grossCents, 3_200_000); assert.equal(p.taxableCents, 3_300_000);
  assert.equal(p.withholdingCents, lookupPayrollTax({ table: 32, column: 1, taxableCents: 3_300_000 }).taxCents);
  assert.equal(p.employerCents, 1_036_860); assert.equal(p.netCents, p.grossCents - p.withholdingCents + 30_000);
  assert.equal(accountBalance(state, '7331'), 30_000); assert.equal(accountBalance(state, '2910'), -p.netCents);
  state = payPayrollBatch(state, batch.id, { date: '2026-10-25' }); assert.equal(accountBalance(state, '2910'), 0);
  state = settlePayrollBatchTaxes(state, batch.id, { date: '2026-11-12' }); assert.equal(accountBalance(state, '2710'), 0); assert.equal(accountBalance(state, '2731'), 0);
  assert.equal(validatePayrollBatches(state).entryIds.size, 3); validateState(state);
  assert.match(payrollReviewCsv(state, batch.id), /inte AGI/);
});

test('individually different sick and vacation values are never copied across staff', () => {
  let state = fixture(); state = createEmployee(state, { name: 'En annan person', payType: 'monthly', baseCents: 3_200_000 });
  const second = state.employees[1].id; state = savePayrollProfile(state, profile(second));
  state = createPayrollBatch(state, { date: '2026-10-25', people: [person(state, { sickHoursHundredths: 1600, sickStart: '2026-10-20', sickEnd: '2026-10-21' }), { employeeId: second, vacationDays: 2 }] });
  const [first, other] = state.payrollBatches[0].people;
  assert.equal(first.absenceDeductionCents, 320_000); assert.equal(first.sickPayCents, 256_000); assert.equal(first.karensCents, 128_000); assert.equal(first.grossCents, 3_008_000);
  assert.equal(other.sickPayCents, 0); assert.equal(other.vacationPayCents, 27_520); assert.equal(other.grossCents, 3_227_520);
  validatePayrollBatches(state);
});

test('hourly wages and percentage vacation use explicit eligible base', () => {
  const state = fixture({ payType: 'hourly', baseCents: 20_000 });
  const p = calculatePayrollPerson(state, person(state, { scheduledHoursHundredths: 12_050, vacationBaseCents: 1_000_000 }), { paymentDate: '2026-10-25', month: '2026-10' });
  assert.equal(p.salaryCents, 2_410_000); assert.equal(p.vacationPayCents, 120_000); assert.equal(p.grossCents, 2_530_000);
});

test('sick pay blocks unsupported periods and caps karens on a short sick day', () => {
  const state = fixture(); const options = { paymentDate: '2026-10-25', month: '2026-10' };
  const p = calculatePayrollPerson(state, person(state, { sickHoursHundredths: 400, sickStart: '2026-10-24', sickEnd: '2026-10-24' }), options);
  assert.equal(p.sickPayCents, 64_000); assert.equal(p.karensCents, 64_000);
  assert.throws(() => calculatePayrollPerson(state, person(state, { sickHoursHundredths: 1600, sickStart: '2026-10-01', sickEnd: '2026-10-20' }), options), /14 kalenderdagar/);
  assert.throws(() => calculatePayrollPerson(state, person(state, { unpaidHoursHundredths: 16001 }), options), /Frånvaron/);
  assert.throws(() => calculatePayrollPerson(state, person(state, { vacationDays: 26 }), options), /Semesterdagarna/);
});

test('karens already applied in the same episode is not applied again next month', () => {
  let state = posted(fixture(), { sickHoursHundredths: 800, sickStart: '2026-10-30', sickEnd: '2026-10-30' }, '2026-10-31');
  state = create(state, { sickHoursHundredths: 800, sickStart: '2026-10-30', sickEnd: '2026-11-01' }, '2026-11-25');
  assert.equal(state.payrollBatches[0].people[0].karensCents, 128_000);
  assert.equal(state.payrollBatches[1].people[0].karensCents, 0);
});

test('review, duplicate monthly payroll, period lock and pay-date safeguards are enforced', () => {
  let state = create(fixture()); const id = state.payrollBatches[0].id;
  assert.throws(() => postPayrollBatch(state, id), /granskat/);
  assert.throws(() => create(state), /löneutkast/);
  state = postPayrollBatch(state, id, { reviewed: true });
  assert.throws(() => create(state), /Ordinarie/);
  assert.throws(() => payPayrollBatch(state, id, { date: '2026-10-26' }), /skatteberäkningsdatum/);
  const locked = structuredClone(state); locked.lockedPeriods.push('2026-10');
  assert.throws(() => payPayrollBatch(locked, id, { date: '2026-10-25' }), /låst/);
  const old = createPayrollRun(fixture(), { date: '2026-10-25', month: '2026-10' });
  assert.throws(() => create(old), /Ordinarie/);
});

test('unpaid posted payroll can be corrected without altering original journal; paid payroll cannot be erased', () => {
  let state = posted(fixture()); const id = state.payrollBatches[0].id; const original = JSON.stringify(state.entries);
  state = reversePayrollBatch(state, id, { date: '2026-10-26', reason: 'Felaktigt underlag' });
  assert.equal(JSON.stringify(state.entries.slice(0, -1)), original); assert.equal(accountBalance(state, '2910'), 0); validatePayrollBatches(state);
  state = create(state); assert.equal(state.payrollBatches.length, 2);
  let paid = posted(fixture()); paid = payPayrollBatch(paid, paid.payrollBatches[0].id, { date: '2026-10-25' });
  assert.throws(() => reversePayrollBatch(paid, paid.payrollBatches[0].id, { date: '2026-10-26', reason: 'test' }), /Utbetald lön/);
});

test('supplemental salary reuses the monthly tax and employer thresholds', () => {
  let state = posted(fixture({ birthYear: 2003 }));
  const first = state.payrollBatches[0].people[0];
  state = create(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-28');
  const next = state.payrollBatches[1].people[0];
  assert.equal(next.salaryCents, 50_000); assert.equal(next.employerCents, 15_710);
  assert.equal(first.withholdingCents + next.withholdingCents, lookupPayrollTax({ table: 32, column: 1, taxableCents: 3_250_000 }).taxCents);
  state = postPayrollBatch(state, state.payrollBatches[1].id, { reviewed: true }); validatePayrollBatches(state);
});

test('edited posted amounts, source journals, and source-less payroll entries are rejected', () => {
  const state = posted(fixture());
  const changed = structuredClone(state); changed.payrollBatches[0].people[0].grossCents += 1;
  assert.throws(() => validatePayrollBatches(changed), /beräkningen/);
  const changedEntry = structuredClone(state); changedEntry.entries.at(-1).rows[0].debitCents += 1;
  assert.throws(() => validatePayrollBatches(changedEntry), /verifikation/);
  const stray = structuredClone(state); stray.payrollBatches = [];
  assert.throws(() => validatePayrollBatches(stray), /saknar/);
});

test('draft deletion is explicit, preserves activity, and permits a replacement draft', () => {
  const state = create(fixture()), id = state.payrollBatches[0].id;
  const next = discardPayrollDraft(state, id); assert.equal(next.payrollBatches.length, 0); assert.ok(next.activity.length > state.activity.length);
  assert.equal(create(next).payrollBatches.length, 1);
});

test('workspace renders source links, individual fields and no false AGI claim', () => {
  const state = fixture(); const html = renderWorkspace(state);
  assert.match(html, /data-feature-form="payroll-v2"/); assert.match(html, /include:/); assert.match(html, /skatteverket\.se/);
  assert.match(html, /ingen myndighetsfil/); assert.match(html, /negativa rättelser/);
  assert.throws(() => handleAction(state, 'unknown', {}), /Okänd/);
});

test('supplementing legacy payroll preserves prior tax base and never treats a draft as paid salary', () => {
  let state = createPayrollRun(fixture({ birthYear: 2003 }), { month: '2026-10', date: '2026-10-25' });
  assert.throws(() => create(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-28'), /Bokför ordinarie/);
  state = postPayroll(state, state.payrollRuns[0].id);
  assert.throws(() => create(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-20'), /före redan/);
  state = create(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-28');
  const next = state.payrollBatches[0].people[0];
  assert.equal(next.context.previousTaxableCents, 3_200_000); assert.equal(next.employerCents, 15_710);
  assert.deepEqual(next.context.priorLegacyRunIds, [state.payrollRuns[0].id]);
  validatePayrollBatches(state);
});

test('a dependency chain can be reversed in order without losing original tax provenance', () => {
  let state = posted(fixture()); const first = state.payrollBatches[0].id;
  state = posted(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-28'); const second = state.payrollBatches[1].id;
  assert.throws(() => reversePayrollBatch(state, first, { date: '2026-10-30', reason: 'Test' }), /kompletteringslön/);
  state = reversePayrollBatch(state, second, { date: '2026-10-30', reason: 'Rätta extra lön' });
  state = reversePayrollBatch(state, first, { date: '2026-10-30', reason: 'Rätta grundlön' });
  assert.equal(accountBalance(state, '2910'), 0); validatePayrollBatches(state);
});

test('payment source and prior-tax references cannot silently disappear', () => {
  let state = posted(fixture()); const first = state.payrollBatches[0].id;
  state = payPayrollBatch(state, first, { date: '2026-10-25' });
  const noBank = structuredClone(state); noBank.bankTransactions = [];
  assert.throws(() => validatePayrollBatches(noBank), /kontohändelse/);
  state = create(state, { kind: 'supplement', additionalGrossCents: 50_000 }, '2026-10-28');
  const altered = structuredClone(state); altered.payrollBatches[1].people[0].context.previousTaxableCents = 0;
  assert.throws(() => validatePayrollBatches(altered), /historiken/);
});

test('official one-off table uses annual salary, column and whole-krona tax', () => {
  assert.equal(calculateOneOffTax({column:1,annualSalaryCents:38900000,amountCents:500000}).taxCents,130000);
  assert.equal(calculateOneOffTax({column:1,annualSalaryCents:8280000,amountCents:100000}).ratePercent,10);
  assert.equal(calculateOneOffTax({column:1,annualSalaryCents:8280100,amountCents:100000}).ratePercent,21);
  assert.equal(calculateOneOffTax({column:3,annualSalaryCents:33120000,amountCents:100000}).ratePercent,10);
  assert.equal(calculateOneOffTax({column:3,annualSalaryCents:33120100,amountCents:100000}).ratePercent,26);
  assert.equal(calculateOneOffTax({column:1,annualSalaryCents:38900000,amountCents:500099}).taxCents,130000);
  assert.throws(()=>calculateOneOffTax({year:2027,column:1,annualSalaryCents:38900000,amountCents:500000}),/2026/);
});

test('regular salary and bonus use separate monthly and one-off tax calculations', () => {
  const state=posted(fixture(),{additionalGrossCents:500000,extraTaxMode:'one-off',annualSalaryCents:38900000,annualSalaryReviewed:true});
  const p=state.payrollBatches[0].people[0];
  assert.equal(p.grossCents,3700000);assert.equal(p.periodicTaxableCents,3200000);assert.equal(p.oneOffCents,500000);
  assert.equal(p.tax.periodicTaxCents,619000);assert.equal(p.tax.oneOff.taxCents,130000);assert.equal(p.withholdingCents,749000);
  assert.equal(accountBalance(state,'2710'),-749000);validatePayrollBatches(state);
});

test('later periodic supplement excludes earlier bonus from monthly tax bands', () => {
  let state=posted(fixture());
  state=posted(state,{kind:'supplement',additionalGrossCents:500000,extraTaxMode:'one-off',annualSalaryCents:38900000,annualSalaryReviewed:true},'2026-10-27');
  state=create(state,{kind:'supplement',additionalGrossCents:50000,extraTaxMode:'periodic'},'2026-10-28');
  const p=state.payrollBatches[2].people[0];
  assert.equal(p.context.previousTaxableCents,3700000);assert.equal(p.context.previousPeriodicTaxableCents,3200000);
  assert.equal(p.withholdingCents,14700);assert.equal(p.tax.oneOff,undefined);validatePayrollBatches(state);
});

test('one-off compensation requires reviewed annual income and supports vacation compensation', () => {
  const state=fixture();
  assert.throws(()=>create(state,{additionalGrossCents:500000,extraTaxMode:'one-off'}),/granskad beräknad årslön/);
  assert.throws(()=>create(state,{additionalGrossCents:500000,extraTaxMode:'one-off',annualSalaryCents:100000,annualSalaryReviewed:true}),/granskad beräknad årslön/);
  const hourly=fixture({payType:'hourly',baseCents:20000});
  const next=create(hourly,{scheduledHoursHundredths:12000,vacationBaseCents:1000000,vacationTaxMode:'one-off',annualSalaryCents:30000000,annualSalaryReviewed:true});
  assert.equal(next.payrollBatches[0].people[0].oneOffCents,120000);assert.equal(next.payrollBatches[0].people[0].tax.oneOff.taxCents,31200);
});

test('sick hours cannot exceed physical days or the separately reviewed schedule', () => {
  const state=fixture(),options={paymentDate:'2026-10-25',month:'2026-10'};
  assert.throws(()=>calculatePayrollPerson(state,person(state,{sickHoursHundredths:10000,sickStart:'2026-10-24',sickEnd:'2026-10-24'}),options),/kalenderdagar/);
  assert.throws(()=>calculatePayrollPerson(state,person(state,{sickHoursHundredths:800,sickScheduledHoursHundredths:400,sickStart:'2026-10-24',sickEnd:'2026-10-24'}),options),/granskat schema/);
  assert.throws(()=>calculatePayrollPerson(state,person(state,{sickHoursHundredths:800,sickScheduleConfirmed:false,sickStart:'2026-10-24',sickEnd:'2026-10-24'}),options),/Bekräfta granskat arbetsschema/);
});

test('truthy text does not count as explicit payroll review', () => {
  const state=create(fixture());assert.throws(()=>postPayrollBatch(state,state.payrollBatches[0].id,{reviewed:'false'}),/Bekräfta/);
});
