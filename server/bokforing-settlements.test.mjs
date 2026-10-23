import { createCustomer, createEmptyState, createInvoice } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, validateState } from '../public/bokforing/suite/core.js';
import { issueInvoice, receivePayment, getInvoiceOutstanding, getInvoiceTotals, creditInvoice } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill, payBill, getBillOutstanding, creditBill } from '../public/bokforing/suite/operations.js';
import { createCreditNote, refundCredit, offsetCredit, getDocumentSettlementSummary, validateSettlements, getCreditSourceLines } from '../public/bokforing/suite/settlements.js';
import { handleAction, renderWorkspace } from '../public/bokforing/suite/credit-workspace.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';
import { createRevenueSchedule } from '../public/bokforing/suite/commercial.js';
import { createRotPlan } from '../public/bokforing/suite/rot-extended.js';
import { closeYear } from '../public/bokforing/suite/finance.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';

const line = (netCents = 10000, vatRate = 25) => ({ description: 'Arbete', kind: 'labor', quantity: 1, unitCents: netCents, vatRate });
function customerInvoice(state = createEmptyState(), options = {}) {
  if (!state.customers.length) state = createCustomer(state, { name: 'Exempelkund', email: 'test@example.test' });
  state = createInvoice(state, { customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31', lines: [line()], ...options });
  const id = state.invoices.at(-1).id;
  return { state: issueInvoice(state, id), id };
}
function supplierBill(options = {}, state = createEmptyState()) {
  state = createBill(state, { supplier: 'Exempelleverantör AB', number: `LEV-${state.bills.length + 1}`, date: '2026-10-01', dueDate: '2026-10-31', netCents: 10000, vatRate: 25, account: '4010', ...options });
  const id = state.bills.at(-1).id;
  return { state: bookBill(state, id), id };
}
const credit = (state, side, documentId, netCents, reference = 'KREDIT-1', date = '2026-10-10', index = 0) => createCreditNote(state, { side, documentId, date, reason: 'Prisjustering', reference, lines: [{ index, netCents }] });
const verify = state => { validateState(state); validateSettlements(state); validateSuiteState(state); return state; };

test('partial customer credit after full payment creates a refundable balance and exact reversal', () => {
  let { state, id } = customerInvoice();
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 12500, reference: 'PAY-1' });
  const original = structuredClone(state.invoices[0]);
  const journals = structuredClone(state.entries);
  state = verify(credit(state, 'customer', id, 4000));
  assert.equal(getInvoiceOutstanding(state.invoices[0]), 0);
  assert.deepEqual(getDocumentSettlementSummary('customer', state.invoices[0]), { balanceCents: -5000, outstandingCents: 0, refundableCents: 5000, creditCents: 5000, refundCents: 0 });
  assert.equal(accountBalance(state, '1510'), -5000);
  assert.equal(accountBalance(state, '3000'), -6000);
  assert.equal(accountBalance(state, '2611'), -1500);
  assert.equal(state.invoices[0].bookingSnapshot, original.bookingSnapshot);
  assert.deepEqual(state.entries.slice(0, journals.length), journals);
  assert.equal(state.invoices[0].status, 'issued');
  state = verify(refundCredit(state, { side: 'customer', documentId: id, date: '2026-10-11', amountCents: 5000, reference: 'REFUND-1' }));
  assert.equal(accountBalance(state, '1510'), 0);
  assert.equal(accountBalance(state, '1930'), 7500);
  assert.equal(getDocumentSettlementSummary('customer', state.invoices[0]).refundableCents, 0);
  assert.equal(state.bankTransactions.at(-1).amountCents, -5000);
});

test('unpaid partial credit lowers amount due and payment cannot exceed adjusted balance', () => {
  let { state, id } = customerInvoice();
  state = credit(state, 'customer', id, 4000);
  assert.equal(getInvoiceOutstanding(state.invoices[0]), 7500);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-11', amountCents: 7501 }), /överstiger/);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-09', amountCents: 7500 }), /senaste kredit/);
  state = verify(receivePayment(state, id, { date: '2026-10-11', amountCents: 7500 }));
  assert.equal(accountBalance(state, '1510'), 0);
  assert.throws(() => refundCredit(state, { side: 'customer', documentId: id, date: '2026-10-12', amountCents: 1, reference: 'NO-CREDIT' }), /tillgodobelopp/);
});

test('several small credits allocate VAT cumulatively and the full remaining credit leaves no öre', () => {
  let { state, id } = customerInvoice(undefined, { lines: [line(3, 25), line(5, 12), line(11, 6)] });
  state = credit(state, 'customer', id, 1, 'A');
  state = credit(state, 'customer', id, 1, 'B');
  state = credit(state, 'customer', id, 1, 'C');
  state = credit(state, 'customer', id, 5, 'D', '2026-10-10', 1);
  state = verify(credit(state, 'customer', id, 11, 'E', '2026-10-10', 2));
  for (const account of ['1510', '3000', '2611', '2621', '2631']) assert.equal(accountBalance(state, account), 0, account);
  assert.throws(() => credit(state, 'customer', id, 1, 'F'), /överstiger/);
});

test('VAT-inclusive prices and invoice discounts credit from frozen net and VAT amounts', () => {
  let { state, id } = customerInvoice(undefined, { lines: [{ ...line(12500), unitPriceIncludesVat: true, discountBps: 1000 }], details: { pricesIncludeVat: true }, invoiceDiscountBps: 1000 });
  const totals = getInvoiceTotals(state.invoices[0]);
  state = verify(credit(state, 'customer', id, totals.netCents));
  assert.equal(state.settlements[0].amountCents, totals.grossCents);
  assert.equal(accountBalance(state, '1510'), 0);
  assert.equal(accountBalance(state, '2611'), 0);
});

test('customer refund can consume one matching bank event and rejects direction/date/duplicate mismatch', () => {
  let { state, id } = customerInvoice();
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 12500 });
  state = credit(state, 'customer', id, 10000);
  state.bankTransactions.push({ id: 'bank-refund', date: '2026-10-11', description: 'Utbetalning till kund', account: '1930', amountCents: -12500, matchedEntryId: null });
  const payload = { side: 'customer', documentId: id, date: '2026-10-11', amountCents: 12500, reference: 'REF', bankEventId: 'bank-refund' };
  assert.throws(() => refundCredit(state, { ...payload, date: '2026-10-12' }), /bankhändelse/);
  const count = state.bankTransactions.length;
  state = verify(refundCredit(state, payload));
  assert.equal(state.bankTransactions.length, count);
  assert.equal(state.bankTransactions.at(-1).matchedEntryId, state.settlements.at(-1).entryId);
  assert.throws(() => refundCredit(state, payload), /redan bokförd/);
});

test('supplier partial credit after payment produces a receivable which supplier can refund', () => {
  let { state, id } = supplierBill();
  state = payBill(state, id, { date: '2026-10-02', amountCents: 12500 });
  state = verify(credit(state, 'supplier', id, 2000));
  assert.equal(accountBalance(state, '2440'), 2500);
  assert.equal(getBillOutstanding(state.bills[0]), 0);
  assert.equal(getDocumentSettlementSummary('supplier', state.bills[0]).refundableCents, 2500);
  state = verify(refundCredit(state, { side: 'supplier', documentId: id, date: '2026-10-11', amountCents: 2500, reference: 'SUPPLIER-REF' }));
  assert.equal(accountBalance(state, '2440'), 0);
  assert.equal(accountBalance(state, '1930'), -10000);
  assert.equal(accountBalance(state, '2641'), 2000);
});

test('unpaid supplier partial credit lowers the permitted next payment', () => {
  let { state, id } = supplierBill();
  state = credit(state, 'supplier', id, 4000);
  assert.equal(getBillOutstanding(state.bills[0]), 7500);
  assert.throws(() => payBill(state, id, { date: '2026-10-11', amountCents: 7501 }), /överstiger/);
  state = verify(payBill(state, id, { date: '2026-10-11', amountCents: 7500 }));
  assert.equal(accountBalance(state, '2440'), 0);
});

test('mixed supplier credit respects non-deductible VAT and reverse construction VAT', () => {
  let { state, id } = supplierBill({ lines: [
    { description: 'Material', netCents: 10000, account: '4010', vatMode: 'standard', vatRate: 25, deductibleBps: 5000 },
    { description: 'Byggtjänst', netCents: 20000, account: '4425', vatMode: 'reverse-construction', vatRate: 25, deductibleBps: 10000, reverseConfirmed: true },
  ] });
  state = credit(state, 'supplier', id, 10000, 'MATERIAL', '2026-10-10', 0);
  assert.equal(accountBalance(state, '4010'), 0);
  assert.equal(accountBalance(state, '2641'), 0);
  state = verify(credit(state, 'supplier', id, 20000, 'BYGG', '2026-10-10', 1));
  for (const account of ['4425', '2647', '2614', '2440']) assert.equal(accountBalance(state, account), 0, account);
});

test('offset transfers available credit only between two documents of the same customer', () => {
  let { state, id } = customerInvoice();
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 12500 });
  state = credit(state, 'customer', id, 10000);
  const next = customerInvoice(state); state = next.state;
  const bankBefore = accountBalance(state, '1930');
  state = verify(offsetCredit(state, { side: 'customer', documentId: id, targetDocumentId: next.id, date: '2026-10-11', amountCents: 5000, reference: 'OFFSET-1' }));
  assert.equal(getDocumentSettlementSummary('customer', state.invoices[0]).refundableCents, 7500);
  assert.equal(getInvoiceOutstanding(state.invoices[1]), 7500);
  assert.equal(accountBalance(state, '1930'), bankBefore);
  assert.equal(accountBalance(state, '1510'), 0);
  assert.throws(() => offsetCredit(state, { side: 'customer', documentId: id, targetDocumentId: next.id, date: '2026-10-12', amountCents: 7501, reference: 'OFFSET-2' }), /överstiger/);
  assert.throws(() => offsetCredit(state, { side: 'customer', documentId: id, targetDocumentId: id, date: '2026-10-12', amountCents: 1, reference: 'SELF' }), /två olika/);
});

test('another customer cannot consume the first customer credit', () => {
  let { state, id } = customerInvoice();
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 12500 });
  state = credit(state, 'customer', id, 10000);
  state = createCustomer(state, { name: 'Annan kund' });
  const next = customerInvoice(state, { customerId: state.customers[1].id });
  assert.throws(() => offsetCredit(next.state, { side: 'customer', documentId: id, targetDocumentId: next.id, date: '2026-10-11', amountCents: 100, reference: 'OTHER' }), /samma kund/);
});

test('closed dates, duplicate references, excess credit and ROT fail without changing originals', () => {
  const original = customerInvoice();
  const before = structuredClone(original.state);
  assert.throws(() => credit(original.state, 'customer', original.id, 10001), /överstiger/);
  assert.deepEqual(original.state, before);
  const locked = structuredClone(original.state); locked.lockedPeriods.push('2026-10');
  assert.throws(() => credit(locked, 'customer', original.id, 100), /låst/);
  let state = credit(original.state, 'customer', original.id, 100);
  assert.throws(() => credit(state, 'customer', original.id, 100), /redan bokförd/);
  assert.throws(() => creditInvoice(state, original.id, { date: '2026-10-11', reason: 'Legacy' }), /kredit- och återbetalningsflödet/);
  const supplier = supplierBill();
  state = credit(supplier.state, 'supplier', supplier.id, 100);
  assert.throws(() => creditBill(state, supplier.id, { date: '2026-10-11', reason: 'Legacy' }), /kredit|kvitt/);
  const rot = customerInvoice(undefined, { rot: { paymentYear: 2026, property: 'TEST 1:2', personId: 'DEMO-1', availableCents: 5000000, eligibleConfirmed: true } });
  assert.throws(() => credit(rot.state, 'customer', rot.id, 100), /ROT/);
});

test('validator rejects mirror manipulation, changed original, altered credit records and false journal', () => {
  let { state, id } = customerInvoice(); state = credit(state, 'customer', id, 1000);
  const badMirror = structuredClone(state); badMirror.invoices[0].settlementCreditCents += 1;
  assert.throws(() => validateSettlements(badMirror), /saldo/);
  const badRecord = structuredClone(state); badRecord.settlements[0].amountCents += 1;
  assert.throws(() => validateSettlements(badRecord), /har ändrats/);
  const badSource = structuredClone(state); badSource.invoices[0].lines[0].unitCents += 1;
  assert.throws(() => validateSettlements(badSource), /frysta/);
  const badJournal = structuredClone(state); badJournal.entries.at(-1).rows[0].debitCents += 1;
  assert.throws(() => validateSettlements(badJournal), /bokföring/);
  const stripped = structuredClone(state); delete stripped.settlements;
  assert.throws(() => validateSettlements(stripped), /saldo/);
});

test('new credit numbers share customer credit series with older full-credit flow', () => {
  let { state, id } = customerInvoice(); state = credit(state, 'customer', id, 1000);
  assert.equal(state.settlements[0].number, 'K-0001');
  const next = customerInvoice(state); state = creditInvoice(next.state, next.id, { date: '2026-10-11', reason: 'Full kredit' });
  assert.equal(state.invoices.at(-1).number, 'K-0002');
  const third = customerInvoice(state); state = credit(third.state, 'customer', third.id, 1000, 'THIRD', '2026-10-12');
  assert.equal(state.settlements.at(-1).number, 'K-0003');
  verify(state);
});

test('workspace form executes a selected partial line credit and escapes names', () => {
  let { state, id } = customerInvoice(undefined, { lines: [{ ...line(), description: '<script>alert(1)</script>' }] });
  state = handleAction(state, 'credit', { side: 'customer', documentId: id, date: '2026-10-10', reference: 'FORM', reason: 'Avtalad rabatt', 'line-0': '25,00' });
  const html = renderWorkspace(state);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /K-0001/);
  assert.equal(state.settlements[0].amountCents, 3125);
  assert.equal(getCreditSourceLines(state, 'customer', id)[0].remainingNetCents, 7500);
});

test('credit allocations reconcile mixed supplier deductible VAT and reverse-tax bases', () => {
  let { state, id } = supplierBill({ lines: [
    { description: 'Material', netCents: 10000, account: '4010', vatMode: 'standard', vatRate: 25, deductibleBps: 5000 },
    { description: 'Byggtjänst', netCents: 20000, account: '4425', vatMode: 'reverse-construction', vatRate: 25, deductibleBps: 10000, reverseConfirmed: true },
  ] });
  state = credit(state, 'supplier', id, 4000, 'MATERIAL', '2026-10-10', 0);
  state = credit(state, 'supplier', id, 10000, 'BYGG', '2026-10-10', 1);
  verify(state);
  const report = getTaxDeclarationReport(state);
  assert.equal(report.boxes['24'], 10000);
  assert.equal(report.boxes['30'], 2500);
  assert.equal(report.boxes['48'], 3250);
  assert.equal(report.boxes['49'], -750);
  assert.equal(report.reconciled, true);
  assert.equal(report.warnings.length, 0);
});

test('partial customer credits reduce their exact VAT-rate tax declaration fields', () => {
  let { state, id } = customerInvoice(undefined, { lines: [line(10000, 25), line(10000, 12), line(10000, 6)] });
  state = credit(state, 'customer', id, 1000, 'C25', '2026-10-10', 0);
  state = credit(state, 'customer', id, 2000, 'C12', '2026-10-10', 1);
  state = credit(state, 'customer', id, 3000, 'C6', '2026-10-10', 2);
  const report = getTaxDeclarationReport(verify(state));
  assert.equal(report.boxes['05'], 24000);
  assert.equal(report.boxes['10'], 2250);
  assert.equal(report.boxes['11'], 960);
  assert.equal(report.boxes['12'], 420);
  assert.equal(report.reconciled, true);
});

test('revenue schedules and credits mutually block unsupported reversal combinations', () => {
  const base = customerInvoice();
  const schedule = { invoiceId: base.id, date: '2026-10-05', amountCents: 5000, startMonth: '2026-11', months: 2, name: 'Framtida arbete' };
  const deferred = createRevenueSchedule(base.state, schedule);
  assert.throws(() => credit(deferred, 'customer', base.id, 100), /intäktsperiodisering/);
  assert.throws(() => creditInvoice(deferred, base.id, { date: '2026-10-10', reason: 'Helt bort' }), /intäktsperiodisering/);
  const credited = credit(base.state, 'customer', base.id, 100);
  assert.throws(() => createRevenueSchedule(credited, schedule), /krediterad faktura/);
});

test('multi-person ROT plan also blocks legacy full credit before any customer payment', () => {
  let { state, id } = customerInvoice(undefined, { lines: [line(100000)], rot: { paymentYear: 2026, property: 'TEST 1:2', personId: 'DEMO-1', availableCents: 5000000, eligibleConfirmed: true } });
  const total = getInvoiceTotals(state.invoices[0]).rotCents;
  state = createRotPlan(state, id, { date: '2026-10-02', participants: [{ personId: 'DEMO-1', name: 'Testperson', allocationCents: total, availableCents: 5000000, eligibleConfirmed: true }] });
  assert.throws(() => credit(state, 'customer', id, 100), /ROT/);
  assert.throws(() => creditInvoice(state, id, { date: '2026-10-10', reason: 'Felaktig faktura' }), /ROT-fördelningen/);
});

test('prior-year credit remains immutable and can be refunded in the next open year', () => {
  let { state, id } = customerInvoice();
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 12500 });
  state = credit(state, 'customer', id, 10000);
  const originalCredit = JSON.stringify(state.settlements[0]);
  state.lockedPeriods = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  state = closeYear(state, { date: '2026-12-31', confirmed: true });
  state = openNextYear(state, { confirmed: true });
  verify(state);
  state = refundCredit(state, { side: 'customer', documentId: id, date: '2027-01-10', amountCents: 12500, reference: 'NEXT-YEAR' });
  verify(state);
  assert.equal(JSON.stringify(state.settlements[0]), originalCredit);
  assert.equal(accountBalance(state, '1510'), 0);
  assert.equal(state.settlements.at(-1).date, '2027-01-10');
  assert.throws(() => credit(state, 'customer', id, 1, 'OLD-YEAR', '2026-12-31'), /utanför|avslutat|stängt/);
});
