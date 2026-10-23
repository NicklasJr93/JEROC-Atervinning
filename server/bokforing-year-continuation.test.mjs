import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, appendEntry, createEmptyState, transact } from '../public/bokforing/suite/core.js';
import { createCustomer, createInvoice, issueInvoice, receivePayment } from '../public/bokforing/suite/sales.js';
import { bookBill, createBill, payBill, postManualEntry } from '../public/bokforing/suite/operations.js';
import { closeYear, createAsset, createEmployee, createPayrollRun, depreciateAsset, fileVatPeriod, getReports, lockPeriod, payPayroll, postPayroll, settlePayrollTaxes, updateCompany } from '../public/bokforing/suite/finance.js';
import { createAccrual, postAccrualMonth } from '../public/bokforing/suite/periodization.js';
import { createStockItem, postStockValuation, recordStockMovement } from '../public/bokforing/suite/inventory.js';
import { annualReportDraft, closeReviewedYear, exportYearReview, getYearReports, openNextYear, prepareCorporateTax, saveYearWorkpaper, validateFiscalYears, validateYearWorkpapers } from '../public/bokforing/suite/financial-years.js';
import { assertFiscalHistoryPreserved, currentYearIsClosed, fiscalPeriodForDate } from '../public/bokforing/suite/fiscal-periods.js';
import { getDownload, renderWorkspace } from '../public/bokforing/suite/year-workspace.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const debit = (account, amount) => ({ account, debitCents: amount, creditCents: 0 });
const credit = (account, amount) => ({ account, debitCents: 0, creditCents: amount });
function opened() {
  let state = transact(createEmptyState(), draft => appendEntry(draft, { date: '2026-01-01', description: 'Ingående balanser', sourceType: 'opening', sourceId: 'opening-2026', rows: [debit('1930', 10_000_000), credit('2081', 2_500_000), credit('2091', 7_500_000)] }));
  return updateCompany(state, { vatPeriod: 'year' });
}
function close(state) {
  state = fileVatPeriod(state, { from: state.company.fiscalYearStart, to: state.company.fiscalYearEnd, date: state.company.fiscalYearEnd });
  const year = state.company.fiscalYearStart.slice(0, 4);
  for (let month = 1; month <= 12; month++) state = lockPeriod(state, `${year}-${String(month).padStart(2, '0')}`);
  return closeYear(state, { date: state.company.fiscalYearEnd, confirmed: true });
}
function documents() {
  let state = createCustomer(opened(), { name: 'Testkunden' });
  state = createInvoice(state, { customerId: state.customers[0].id, date: '2026-12-01', dueDate: '2027-01-15', lines: [{ description: 'Utfört arbete', kind: 'labor', quantity: 1, unitCents: 200_000, vatRate: 25 }] });
  state = issueInvoice(state, state.invoices[0].id);
  state = createBill(state, { supplier: 'Testleverantör', number: 'LEV-1', date: '2026-12-01', dueDate: '2027-01-15', account: '4010', netCents: 100_000, vatRate: 25 });
  state = bookBill(state, state.bills[0].id);
  return state;
}

test('next year retains unpaid invoices and cumulative balance without duplicate opening entries', () => {
  const before = close(documents());
  validateSuiteState(before);
  const oldEntries = structuredClone(before.entries); const bank = accountBalance(before, '1930'); const debt = accountBalance(before, '2440'); const due = accountBalance(before, '1510');
  let state = openNextYear(before, { confirmed: true });
  assert.equal(state.company.fiscalYearStart, '2027-01-01'); assert.equal(state.company.fiscalYearEnd, '2027-12-31');
  assert.deepEqual(state.entries.slice(0, oldEntries.length), oldEntries);
  assert.equal(state.entries.filter(entry => entry.sourceType === 'opening').length, 1);
  assert.equal(accountBalance(state, '1930'), bank); assert.equal(accountBalance(state, '1510'), due); assert.equal(accountBalance(state, '2440'), debt);
  assert.equal(accountBalance(state, '2099'), 0); assert.equal(accountBalance(state, '2098'), -100_000);
  assert.equal(getReports(state).resultCents, 0); assert.equal(getYearReports(state, { start: '2026-01-01', end: '2026-12-31' }).resultCents, 100_000);
  assert.equal(getReports(state).accounts.find(account => account.number === '3000').balanceCents, 0);
  assert.equal(getReports(state).accounts.find(account => account.number === '3000').openingCents, 0);
  validateSuiteState(state); validateFiscalYears(state);
  state = receivePayment(state, state.invoices[0].id, { date: '2027-01-15', amountCents: 250_000 });
  state = payBill(state, state.bills[0].id, { date: '2027-01-15', amountCents: 125_000 });
  assert.equal(accountBalance(state, '1510'), 0); assert.equal(accountBalance(state, '2440'), 0);
  assert.equal(getReports(state).resultCents, 0); validateSuiteState(state);
  assert.equal(state.fiscalYears[0].snapshot.invoices[0].payments.length, 0, 'archived invoice must retain its state at year-end');
  assert.equal(state.invoices[0].payments.length, 1, 'live receivable continues into new year');
});

test('old periods stay closed, rollover rejects gaps and repeat opens without mutating input', () => {
  const unclosed = opened(); assert.throws(() => openNextYear(unclosed, { confirmed: true }), /Avsluta/);
  const before = close(opened()); const saved = JSON.stringify(before);
  assert.throws(() => openNextYear(before, { confirmed: false }), /Bekräfta/);
  assert.throws(() => openNextYear(before, { start: '2027-01-02', end: '2027-12-31', confirmed: true }), /dagen efter/);
  assert.equal(JSON.stringify(before), saved);
  const state = openNextYear(before, { confirmed: true });
  assert.throws(() => openNextYear(state, { confirmed: true }), /Avsluta/);
  assert.throws(() => postManualEntry(state, { date: '2026-12-31', description: 'Ändra gammalt år', rows: [debit('6540', 100), credit('1930', 100)] }), /utanför|avslutat/);
  assert.equal(currentYearIsClosed(state), false); assert.equal(fiscalPeriodForDate(state, '2026-06-01').status, 'closed');
});

test('year-end archive and reviewed workpaper histories cannot be edited through transactions', () => {
  let state = saveYearWorkpaper(opened(), { title: 'Bankavstämning', category: 'bank', account: '1930', preparedBy: 'Åke', reviewedBy: 'Jenny', status: 'reviewed', evidence: 'Kontoutdrag december', note: 'Avstämt.' });
  const paper = state.yearWorkpapers[0]; validateYearWorkpapers(state);
  const changed = structuredClone(state); changed.yearWorkpapers[0].revisions[0].note = 'Omskrivet';
  assert.throws(() => assertFiscalHistoryPreserved(state, changed), /tidigare versioner/);
  state = openNextYear(close(state), { confirmed: true });
  const archive = structuredClone(state); archive.fiscalYears[0].snapshot.company.name = 'Omskrivet';
  assert.throws(() => validateFiscalYears(archive), /frysta/);
  assert.throws(() => transact(state, draft => { draft.fiscalYears[0].snapshot.company.name = 'Omskrivet'; }), /Arkiverade/);
  assert.throws(() => transact(state, draft => { draft.yearWorkpapers[0].note = 'Omskrivet'; }), /avslutade/);
  assert.equal(state.yearWorkpapers[0].id, paper.id);
});

test('assets and prepaid expense schedules continue into following year without reclassifying again', () => {
  let state = opened();
  state = postManualEntry(state, { date: '2026-12-01', description: 'Verktyg', rows: [debit('5410', 120_000), credit('1930', 120_000)] });
  state = createAsset(state, { name: 'Kompressor', date: '2026-12-01', costCents: 120_000, lifeMonths: 24 });
  const assetId = state.assets[0].id; state = depreciateAsset(state, assetId, { date: '2026-12-31' });
  state = postManualEntry(state, { date: '2026-12-01', description: 'IT-avtal', rows: [debit('6540', 12_000), credit('1930', 12_000)] });
  state = createAccrual(state, { name: 'IT tre månader', date: '2026-12-01', amountCents: 12_000, expenseAccount: '6540', months: 3, startMonth: '2026-12' });
  const accrualId = state.accruals[0].id; state = postAccrualMonth(state, accrualId, { date: '2026-12-31' });
  state = openNextYear(close(state), { confirmed: true });
  state = depreciateAsset(state, assetId, { date: '2027-01-31' });
  state = postAccrualMonth(state, accrualId, { date: '2027-01-31' });
  assert.equal(accountBalance(state, '1220'), 120_000); assert.equal(accountBalance(state, '1229'), -10_000); assert.equal(accountBalance(state, '1790'), 4_000);
  assert.equal(getReports(state).expenseCents, 9_000); validateSuiteState(state);
});

test('closing a second fiscal year preserves both years and opens a third year', () => {
  let state = openNextYear(close(opened()), { confirmed: true });
  state = postManualEntry(state, { date: '2027-02-01', description: 'IT-kostnad', rows: [debit('6540', 10_000), credit('1930', 10_000)] });
  state = close(state); validateSuiteState(state);
  state = openNextYear(state, { confirmed: true }); validateSuiteState(state);
  assert.equal(state.fiscalYears.length, 3); assert.equal(state.yearClosures.length, 2);
  assert.equal(state.company.fiscalYearStart, '2028-01-01'); assert.equal(getReports(state).resultCents, 0);
  assert.equal(getYearReports(state, { start: '2027-01-01', end: '2027-12-31' }).resultCents, -10_000);
});

test('posted December wages and tax liabilities can be settled in January', () => {
  let state = createEmployee(opened(), { name: 'Åke', payType: 'monthly', baseCents: 100_000, withholdingCents: 20_000, employerRateBps: 3142 });
  state = createPayrollRun(state, { month: '2026-12', date: '2026-12-25' });
  const id = state.payrollRuns[0].id; state = postPayroll(state, id);
  state = openNextYear(close(state), { confirmed: true });
  state = payPayroll(state, id, { date: '2027-01-02' });
  state = settlePayrollTaxes(state, id, { date: '2027-01-12' });
  assert.equal(accountBalance(state, '2910'), 0); assert.equal(accountBalance(state, '2710'), 0); assert.equal(accountBalance(state, '2731'), 0);
  assert.equal(getReports(state).expenseCents, 0); validateSuiteState(state);
});

test('inventory history survives year change and next-year withdrawal changes only next-year result', () => {
  let state = documents();
  state = createStockItem(state, { name: 'Material', unit: 'st', unitCostCents: 10_000 });
  const id = state.inventoryItems[0].id;
  state = recordStockMovement(state, id, { date: '2026-12-02', kind: 'in', quantity: 10, reason: 'Inköpt material' });
  state = postStockValuation(state, { date: '2026-12-31' });
  state = openNextYear(close(state), { confirmed: true });
  state = recordStockMovement(state, id, { date: '2027-01-05', kind: 'out', quantity: 1, reason: 'Förbrukat i projekt' });
  state = postStockValuation(state, { date: '2027-01-31' });
  assert.equal(accountBalance(state, '1460'), 90_000); assert.equal(getReports(state).expenseCents, 10_000);
  assert.equal(getYearReports(state, { start: '2026-01-01', end: '2026-12-31' }).resultCents, 200_000); validateSuiteState(state);
});

test('workpaper review requires separate named reviewer and stale balances prevent closure', () => {
  const state = opened();
  assert.throws(() => saveYearWorkpaper(state, { title: 'Bank', category: 'bank', status: 'reviewed', preparedBy: 'Åke', reviewedBy: 'Åke', evidence: 'Bank' }), /olika/);
  let reviewed = saveYearWorkpaper(state, { title: 'Bank', category: 'bank', account: '1930', status: 'reviewed', preparedBy: 'Åke', reviewedBy: 'Jenny', evidence: 'Bank' });
  reviewed = postManualEntry(reviewed, { date: '2026-02-01', description: 'Ny kostnad', rows: [debit('6540', 100), credit('1930', 100)] });
  assert.throws(() => closeReviewedYear(reviewed, { confirmed: true }), /kontosaldo har ändrats/);
  validateYearWorkpapers(reviewed);
});

test('corporate tax preparation exposes adjustments and annual draft never claims filing readiness', () => {
  let state = opened();
  state = postManualEntry(state, { date: '2026-02-01', description: 'Intäkt utan moms i test', rows: [debit('1930', 1_000_000), credit('3000', 1_000_000)] });
  const tax = prepareCorporateTax(state, { additionsCents: 100_000, deductionsCents: 50_000, priorLossCents: 250_000, assessmentNote: 'Granskas separat' });
  assert.equal(tax.taxableCents, 800_000); assert.equal(tax.estimatedTaxCents, 164_800); assert.equal(tax.rateBps, 2060);
  const annual = annualReportDraft(state); assert.equal(annual.submissionReady, false); assert.ok(annual.missingBeforeAnnualReport.length);
  const download = getDownload(state, 'calculate-tax', { additions: '1000', deductions: '500', priorLoss: '2500' }); assert.equal(download.value.estimatedTaxCents, 164_800);
  const ui = renderWorkspace(state); assert.match(ui, /data-feature-form="year-end"/); assert.match(ui, /Öppna|Avsluta/);
  const review = exportYearReview(state); assert.equal(review.submissionReady, false);
  assert.throws(() => prepareCorporateTax(state, { additionsCents: -1 }), /Belopp/);
});
