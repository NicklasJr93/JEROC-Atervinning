import { createCustomer, createEmptyState, createInvoice, invoiceFromQuote } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEntry, transact } from '../public/bokforing/suite/core.js';
import { createProject, recordProjectItem, createQuote, acceptQuote, issueInvoice, creditInvoice, receivePayment, requestRot, decideRot } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill, creditBill, payBill, createBankEvent, bookBankEvent, postManualEntry, correctEntry } from '../public/bokforing/suite/operations.js';
import { createEmployee, createPayrollRun, postPayroll, payPayroll, settlePayrollTaxes, createAsset, depreciateAsset, disposeAsset, fileVatPeriod, settleVat, lockPeriod, closeYear } from '../public/bokforing/suite/finance.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { createAccrual, postAccrualMonth } from '../public/bokforing/suite/periodization.js';
import { createStockItem, recordStockMovement, postStockValuation } from '../public/bokforing/suite/inventory.js';

const checked = state => { assert.equal(validateSuiteState(state), state); return state; };
function initial() {
  return checked(transact(createEmptyState(), draft => appendEntry(draft, {
    date: '2026-01-01', description: 'Ingående kapital', sourceType: 'opening', sourceId: 'opening-2026',
    rows: [{ account: '1930', debitCents: 50_000_000, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 50_000_000 }],
  })));
}
const lines = [{ description: 'Arbete', kind: 'labor', quantity: 10, unitCents: 50_000, vatRate: 25 }, { description: 'Material', kind: 'material', quantity: 1, unitCents: 200_000, vatRate: 25 }];
function withInvoice({ rot = false } = {}) {
  let state = checked(createCustomer(initial(), { name: 'Demokund', email: 'kund@example.invalid' }));
  state = checked(createInvoice(state, { customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31', lines,
    ...(rot ? { rot: { paymentYear: 2026, property: 'Demofastighet 1:2', personId: 'DEMO-01', eligibleConfirmed: true, availableCents: 5_000_000 } } : {}) }));
  return checked(issueInvoice(state, state.invoices[0].id));
}
function withBill() {
  let state = checked(createBill(initial(), { supplier: 'Leverantör Demo AB', number: 'D-100', date: '2026-10-01', dueDate: '2026-10-31', netCents: 3_000_000, vatRate: 25, vatMode: 'standard', account: '5410' }));
  return checked(bookBill(state, state.bills[0].id));
}

test('restored project, quotation and invoice transitions all validate', () => {
  let state = checked(createCustomer(initial(), { name: 'Kund' }));
  state = checked(createProject(state, { name: 'Renovering', customerId: state.customers[0].id, budgetCents: 100_000 }));
  state = checked(recordProjectItem(state, { projectId: state.projects[0].id, ...lines[0] }));
  state = checked(createQuote(state, { customerId: state.customers[0].id, projectId: state.projects[0].id, date: '2026-10-01', validUntil: '2026-10-31', lines }));
  state = checked(acceptQuote(state, state.quotes[0].id));
  state = checked(invoiceFromQuote(state, state.quotes[0].id, { date: '2026-10-02', dueDate: '2026-11-01' }));
  state = checked(issueInvoice(state, state.invoices[0].id));
  state = checked(receivePayment(state, state.invoices[0].id, { date: '2026-10-10', amountCents: 400_000 }));
  assert.equal(state.invoices[0].payments.length, 1);
});

test('restored full credit preserves original and inverse journal links', () => {
  const state = withInvoice();
  checked(creditInvoice(state, state.invoices[0].id, { date: '2026-10-02', reason: 'Felaktigt uppdrag' }));
  const billState = withBill();
  checked(creditBill(billState, billState.bills[0].id, { date: '2026-10-02', reason: 'Returnerat inköp' }));
});

test('restored partial customer and supplier payments reconcile to their exact bank events', () => {
  let state = withInvoice();
  state = checked(receivePayment(state, state.invoices[0].id, { date: '2026-10-03', amountCents: 250_000 }));
  state = checked(receivePayment(state, state.invoices[0].id, { date: '2026-10-04', amountCents: 625_000 }));
  let bills = withBill();
  bills = checked(payBill(bills, bills.bills[0].id, { date: '2026-10-04', amountCents: 1_000_000 }));
  checked(payBill(bills, bills.bills[0].id, { date: '2026-10-05', amountCents: 2_750_000 }));
});

test('restored ROT request, reduced decision and both payer payments remain consistent', () => {
  let state = withInvoice({ rot: true }); const id = state.invoices[0].id;
  // Labor gross625000, ROT187500, full invoice875000, initial customer687500.
  state = checked(receivePayment(state, id, { date: '2026-10-03', amountCents: 687_500 }));
  state = checked(requestRot(state, id, { date: '2026-10-04', workCompletedConfirmed: true, electronicPaymentConfirmed: true }));
  state = checked(decideRot(state, id, { date: '2026-10-05', approvedCents: 100_000, reason: 'Begränsat uppgivet utrymme i exemplet' }));
  state = checked(receivePayment(state, id, { date: '2026-10-06', amountCents: 100_000, payer: 'tax' }));
  state = checked(receivePayment(state, id, { date: '2026-10-07', amountCents: 87_500 }));
  assert.equal(state.invoices[0].rot.status, 'settled');
});

test('restored payroll drafts, postings and payments match per-employee calculations', () => {
  let state = checked(createEmployee(initial(), { name: 'Åke', payType: 'monthly', baseCents: 3_200_000, withholdingCents: 750_000, employerRateBps: 3142 }));
  state = checked(createPayrollRun(state, { month: '2026-10', date: '2026-10-25', vacationPayCents: 20_000, benefitCents: 50_000, reimbursementCents: 10_000 }));
  state = checked(postPayroll(state, state.payrollRuns[0].id));
  state = checked(payPayroll(state, state.payrollRuns[0].id, { date: '2026-10-26' }));
  checked(settlePayrollTaxes(state, state.payrollRuns[0].id, { date: '2026-11-12' }));
});

test('restored asset acquisition, sequential depreciation and disposal match journals', () => {
  let state = withBill();
  state = checked(createAsset(state, { name: 'Maskin', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60, residualCents: 0 }));
  state = checked(depreciateAsset(state, state.assets[0].id, { date: '2026-10-31' }));
  state = checked(depreciateAsset(state, state.assets[0].id, { date: '2026-11-30' }));
  checked(disposeAsset(state, state.assets[0].id, { date: '2026-12-01', proceedsCents: 500_000 }));
});

test('restored VAT filing and positive or negative settlements match their evidence', () => {
  for (const makeState of [withInvoice, withBill]) {
    let state = makeState();
    state = checked(fileVatPeriod(state, { from: '2026-10-01', to: '2026-12-31', date: '2026-12-31' }));
    checked(settleVat(state, state.vatReturns[0].id, { date: '2026-12-31' }));
  }
});

test('restored manual correction, bank booking and completed year are supported', () => {
  let state = checked(postManualEntry(initial(), { date: '2026-10-01', description: 'Hyra', rows: [{ account: '5010', debitCents: 50_000, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 50_000 }] }));
  state = checked(correctEntry(state, state.entries.at(-1).id, { date: '2026-10-02', reason: 'Rättning' }));
  state = checked(createBankEvent(state, { date: '2026-10-03', description: 'Avgift', amountCents: -15_000 }));
  state = checked(bookBankEvent(state, state.bankTransactions[0].id, { kind: 'fee' }));
  for (let month = 1; month <= 12; month++) state = checked(lockPeriod(state, `2026-${String(month).padStart(2, '0')}`));
  checked(closeYear(state, { date: '2026-12-31', confirmed: true }));
});

test('malformed or edited invoices, postings, payment histories and unknown journal sources fail restoration', () => {
  const base = withInvoice();
  const mutations = [
    state => { state.invoices[0].lines = null; },
    state => { state.invoices[0].lines[0].description = 'Oauktoriserad ändring'; },
    state => { state.invoices[0].entryId = state.entries[0].id; },
    state => { state.invoices[0].customerId = 'missing'; },
    state => { state.invoices[0].status = 'draft'; },
    state => { state.invoices = []; },
    state => { state.entries[1].rows[0].debitCents += 100; state.entries[1].rows[1].creditCents += 100; },
  ];
  for (const mutate of mutations) { const state = structuredClone(base); mutate(state); assert.throws(() => validateSuiteState(state)); }
  const unknown = transact(initial(), draft => appendEntry(draft, { date: '2026-10-01', description: 'Okänd källa', sourceType: 'not-supported', sourceId: 'unknown', rows: [{ account: '1930', debitCents: 100, creditCents: 0 }, { account: '3000', debitCents: 0, creditCents: 100 }] }));
  assert.throws(() => validateSuiteState(unknown), /saknar ett giltigt underlag/);
});

test('tampering with payroll and bill amounts fails even when balanced journals are retained', () => {
  let payroll = checked(createEmployee(initial(), { name: 'Åke', payType: 'monthly', baseCents: 3_200_000, withholdingCents: 750_000 }));
  payroll = checked(createPayrollRun(payroll, { month: '2026-10', date: '2026-10-25' }));
  payroll = checked(postPayroll(payroll, payroll.payrollRuns[0].id));
  payroll.payrollRuns[0].lines[0].netCents += 1;
  assert.throws(() => validateSuiteState(payroll), /Löneradens nettolön|Löneberäkningen/);
  const bills = withBill(); bills.bills[0].account = '4010';
  assert.throws(() => validateSuiteState(bills), /ändrats/);
});

test('manual journals cannot bypass an existing asset register', () => {
  let state = withBill();
  state = checked(createAsset(state, { name: 'Maskin', date: '2026-10-01', costCents: 3_000_000, lifeMonths: 60, residualCents: 0 }));
  const forged = transact(state, draft => appendEntry(draft, { date: '2026-10-02', description: 'Otillåten omklassificering', sourceType: 'manual', sourceId: 'forged-manual', rows: [
    { account: '6991', debitCents: 3_000_000, creditCents: 0 }, { account: '1220', debitCents: 0, creditCents: 3_000_000 },
  ] }));
  assert.throws(() => validateSuiteState(forged), /inte kringgå/);
});

test('VAT restore validates configured full periods and payroll tax state requires matching evidence', () => {
  let state = withInvoice();
  state.company.vatPeriod = 'month';
  state = checked(fileVatPeriod(state, { from: '2026-10-01', to: '2026-10-31', date: '2026-10-31' }));
  state.company.vatPeriod = 'quarter';
  assert.throws(() => validateSuiteState(state), /momsperiod/);

  let payroll = checked(createEmployee(initial(), { name: 'Åke', payType: 'monthly', baseCents: 3_200_000, withholdingCents: 750_000 }));
  payroll = checked(createPayrollRun(payroll, { month: '2026-10', date: '2026-10-25' }));
  payroll = checked(postPayroll(payroll, payroll.payrollRuns[0].id));
  payroll.payrollRuns[0].taxesSettled = true;
  payroll.payrollRuns[0].taxSettledDate = '2026-11-12';
  payroll.payrollRuns[0].taxSettlementEntryIds = [];
  assert.throws(() => validateSuiteState(payroll), /reglering saknar/);
});

test('restored prepaid schedules reconcile the original expense and each allocated month', () => {
  let state = checked(postManualEntry(initial(), { date: '2026-10-01', description: 'Förutbetald lokalhyra', rows: [
    { account: '5010', debitCents: 10_001, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 10_001 },
  ] }));
  state = checked(createAccrual(state, { name: 'Hyra tre månader', type: 'prepaid', date: '2026-10-01', amountCents: 10_001, expenseAccount: '5010', months: 3, startMonth: '2026-10' }));
  state = checked(postAccrualMonth(state, state.accruals[0].id, { date: '2026-10-31' }));
  state = checked(postAccrualMonth(state, state.accruals[0].id, { date: '2026-11-30' }));
  state = checked(postAccrualMonth(state, state.accruals[0].id, { date: '2026-12-31' }));
  assert.equal(state.accruals[0].status, 'completed');
  state.accruals[0].postings[0].amountCents++;
  assert.throws(() => validateSuiteState(state), /månadsbelopp/);
});

test('restored stock quantities and successive ledger valuations remain linked', () => {
  let state = checked(postManualEntry(initial(), { date: '2026-10-01', description: 'Materialinköp', rows: [
    { account: '4010', debitCents: 50_000, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 50_000 },
  ] }));
  state = checked(createStockItem(state, { name: 'Material', unit: 'st', unitCostCents: 10_000 }));
  state = checked(recordStockMovement(state, state.inventoryItems[0].id, { date: '2026-10-02', kind: 'in', quantity: 5, reason: 'Inköp' }));
  state = checked(postStockValuation(state, { date: '2026-10-03' }));
  state = checked(recordStockMovement(state, state.inventoryItems[0].id, { date: '2026-10-04', kind: 'out', quantity: 2, reason: 'Förbrukning' }));
  state = checked(postStockValuation(state, { date: '2026-10-05' }));
  assert.equal(state.inventoryValuations[1].deltaCents, -20_000);
  state.inventoryItems[0].quantity = 10;
  assert.throws(() => validateSuiteState(state), /Lagersaldot/);
});

test('source credits cannot leave an unfunded prepaid schedule behind', () => {
  let state = checked(createBill(initial(), { supplier: 'Hyresvärd', number: 'H-1', date: '2026-10-01', dueDate: '2026-10-31', netCents: 12_000, vatRate: 0, account: '5010' }));
  state = checked(bookBill(state, state.bills[0].id));
  state = checked(createAccrual(state, { name: 'Hyra', date: '2026-10-01', amountCents: 12_000, expenseAccount: '5010', months: 3, startMonth: '2026-10' }));
  const forged = transact(state, draft => {
    const bill = draft.bills[0]; const original = draft.entries.find(entry => entry.id === bill.entryId);
    const correction = appendEntry(draft, { date: '2026-10-02', description: 'Kredit', sourceType: 'bill-credit', sourceId: bill.id, correctsEntryId: original.id,
      rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })) });
    bill.status = 'credited'; bill.creditReason = 'Kredit'; bill.creditEntryId = correction.id;
  });
  assert.throws(() => validateSuiteState(forged), /periodiserad kostnad saknar täckning/);
});
