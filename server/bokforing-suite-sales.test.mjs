import { createCustomer, createEmptyState, createInvoice, invoiceFromQuote } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateState, accountBalance } from '../public/bokforing/suite/core.js';
import { calculateRot, calculateLineAmounts } from '../public/bokforing/suite/rot.js';
import { createProject, recordProjectItem, createQuote, acceptQuote, updateInvoiceDraft, issueInvoice, creditInvoice, receivePayment, recordReminder, requestRot, decideRot, getInvoiceTotals, getInvoiceOutstanding } from '../public/bokforing/suite/sales.js';

const line = (kind = 'labor', unitCents = 100_000, quantity = 1, vatRate = 25) => ({ description: kind, kind, quantity, unitCents, vatRate });
const base = () => createCustomer(createEmptyState(), { name: 'Fiktiv kund', email: 'demo@example.test' });
function invoice(options = {}, state = base()) {
  state = createInvoice(state, { customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31', lines: [line()], ...options });
  return state;
}
const last = state => state.invoices.at(-1);
const issued = (options = {}, state = base()) => {
  const draft = invoice(options, state);
  return issueInvoice(draft, last(draft).id);
};
const rotFields = (availableCents = 5_000_000) => ({ paymentYear: 2026, property: 'DEMO Solsidan 1:23', personId: 'DEMO-ROT-001', eligibleConfirmed: true, availableCents });
const withRot = (options = {}, state) => issued({ lines: [line('labor', 2_000_000), line('material', 1_000_000), line('other', 100_000)], rot: rotFields(), ...options }, state);
function paidRot() {
  let state = withRot();
  state = receivePayment(state, last(state).id, { date: '2026-10-10', amountCents: getInvoiceTotals(last(state)).customerCents });
  return state;
}
const request = state => requestRot(state, last(state).id, { date: '2026-10-12', workCompletedConfirmed: true, electronicPaymentConfirmed: true });

test('invoice rows round per line in cents and preserve exact accounting balance', () => {
  const state = issued({ lines: [line('labor', 111, 1.25, 25), line('material', 222, 3.33, 12), line('other', 99, 1, 6)] });
  const inv = last(state);
  assert.deepEqual(calculateLineAmounts(inv.lines[0]), { netCents: 139, vatCents: 35, grossCents: 174 });
  const totals = getInvoiceTotals(inv);
  assert.equal(accountBalance(state, '1510'), totals.grossCents);
  assert.equal(accountBalance(state, '3000'), -totals.netCents);
  assert.equal(state.entries.at(-1).rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0), 0);
  validateState(state);
});

test('sales transitions leave their input intact and issue only once', () => {
  const original = invoice();
  const snapshot = structuredClone(original);
  const result = issueInvoice(original, last(original).id);
  assert.deepEqual(original, snapshot);
  assert.equal(result.invoices[0].status, 'issued');
  assert.throws(() => issueInvoice(result, result.invoices[0].id), /redan/);
  assert.throws(() => updateInvoiceDraft(result, result.invoices[0].id, { lines: [line('labor', 1)] }), /skrivas om/);
});

test('draft edit preserves reference and recomputes price before issuing', () => {
  let state = invoice();
  const id = last(state).id;
  state = updateInvoiceDraft(state, id, { lines: [line('labor', 200_000)] });
  assert.equal(last(state).id, id);
  assert.equal(getInvoiceTotals(last(state)).grossCents, 250_000);
  assert.equal(state.entries.length, 0);
});

test('locked periods and impossible calendar dates stop issuance', () => {
  let state = invoice();
  state.lockedPeriods.push('2026-10');
  assert.throws(() => issueInvoice(state, last(state).id), /låst/);
  assert.throws(() => invoice({ date: '2026-02-29' }), /giltigt datum/);
  assert.throws(() => invoice({ dueDate: '2026-09-30' }), /före/);
});

test('unknown customer, wrong-project customer and malformed line are rejected', () => {
  assert.throws(() => invoice({ customerId: 'missing' }), /Kunden/);
  assert.throws(() => invoice({ lines: [line('labor', 100, 1.001)] }), /två decimaler/);
  assert.throws(() => invoice({ lines: [line('labor', -100)] }), /positiva/);
  assert.throws(() => invoice({ lines: [line('labor', 100, 1, 24)] }), /momssats/);
  let state = base();
  state = createProject(state, { name: 'Projekt', customerId: state.customers[0].id });
  state = createCustomer(state, { name: 'Annan kund' });
  assert.throws(() => invoice({ customerId: state.customers[1].id, projectId: state.projects[0].id }, state), /annan kund/);
});

test('accepted quote creates one linked invoice and project keeps recorded time/material', () => {
  let state = base();
  state = createProject(state, { name: 'Solsidan', customerId: state.customers[0].id, budgetCents: 500_000 });
  state = recordProjectItem(state, { projectId: state.projects[0].id, ...line('labor', 55_000, 2) });
  state = createQuote(state, { customerId: state.customers[0].id, projectId: state.projects[0].id, date: '2026-10-01', validUntil: '2026-10-30', lines: state.projects[0].items });
  const qid = state.quotes[0].id;
  assert.throws(() => invoiceFromQuote(state, qid, { date: '2026-10-02', dueDate: '2026-11-01' }), /Godkänn/);
  state = acceptQuote(state, qid);
  state = invoiceFromQuote(state, qid, { date: '2026-10-02', dueDate: '2026-11-01' });
  assert.equal(last(state).sourceQuoteId, qid);
  assert.equal(state.quotes[0].status, 'invoiced');
  assert.equal(state.projects[0].items.length, 1);
  assert.throws(() => invoiceFromQuote(state, qid, { date: '2026-10-02', dueDate: '2026-11-01' }), /en gång/);
});

test('reverse construction VAT requires buyer review and credits correct sales account', () => {
  const draft = invoice({ vatMode: 'reverse-construction' });
  assert.throws(() => issueInvoice(draft, last(draft).id), /Bekräfta köparens/);
  const state = issued({ vatMode: 'reverse-construction', buyerConstructionConfirmed: true });
  assert.equal(getInvoiceTotals(last(state)).vatCents, 0);
  assert.equal(accountBalance(state, '3231'), -100_000);
  assert.equal(accountBalance(state, '2611'), 0);
  assert.throws(() => invoice({ vatMode: 'reverse-construction', rot: rotFields() }), /ROT/);
});

test('credit keeps original journal and appends complete linked reversal', () => {
  const original = issued();
  const originalEntry = structuredClone(original.entries[0]);
  const id = last(original).id;
  const credited = creditInvoice(original, id, { date: '2026-10-03', reason: 'Fel beställning' });
  assert.deepEqual(credited.entries[0], originalEntry);
  assert.equal(credited.entries.length, 2);
  assert.equal(credited.entries[1].correctsEntryId, originalEntry.id);
  assert.equal(credited.invoices[0].status, 'credited');
  assert.equal(last(credited).originalInvoiceId, id);
  assert.equal(accountBalance(credited, '1510'), 0);
  assert.equal(accountBalance(credited, '3000'), 0);
  assert.equal(getInvoiceOutstanding(credited.invoices[0]), 0);
  assert.throws(() => creditInvoice(credited, id, { date: '2026-10-04', reason: 'Igen' }), /utfärdad/);
});

test('partial payments reduce receivables, create bank events and stop duplicates/overpayment', () => {
  let state = issued();
  const id = last(state).id;
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000 });
  assert.equal(getInvoiceOutstanding(last(state)), 75_000);
  assert.equal(accountBalance(state, '1510'), 75_000);
  assert.equal(accountBalance(state, '1930'), 50_000);
  assert.equal(state.bankTransactions[0].matchedEntryId, state.entries.at(-1).id);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000 }), /redan registrerad/);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-03', amountCents: 75_001 }), /överstiger/);
  assert.throws(() => creditInvoice(state, id, { date: '2026-10-03', reason: 'Ångrad' }), /obetalda/);
  state = receivePayment(state, id, { date: '2026-10-03', amountCents: 75_000 });
  assert.equal(getInvoiceOutstanding(last(state)), 0);
  assert.throws(() => recordReminder(state, id), /slutbetald/);
});

test('equal same-day distinct payments require different explicit references', () => {
  let state = issued();
  const id = last(state).id;
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, reference: 'DEMO-001' });
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, reference: 'DEMO-002' });
  assert.equal(getInvoiceOutstanding(last(state)), 25_000);
});

test('customer payment consumes selected bank event instead of creating a duplicate', () => {
  let state = issued();
  const id = last(state).id;
  state.bankTransactions.push({ id: 'bank-existing', date: '2026-10-02', description: 'Bankens kundinbetalning', account: '1930', amountCents: 50_000, matchedEntryId: null });
  state = receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, bankEventId: 'bank-existing' });
  assert.equal(state.bankTransactions.length, 1);
  assert.equal(state.bankTransactions[0].matchedEntryId, last(state).payments[0].entryId);
  assert.equal(last(state).payments[0].bankEventId, 'bank-existing');
  assert.throws(() => receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, bankEventId: 'bank-existing', reference: 'different' }), /redan matchad/);
});

test('bank event amount, date, account and existence are checked before customer payment', () => {
  const state = issued();
  const id = last(state).id;
  state.bankTransactions.push({ id: 'bank-existing', date: '2026-10-02', description: 'Betalning', account: '1930', amountCents: 50_000, matchedEntryId: null });
  assert.throws(() => receivePayment(state, id, { date: '2026-10-03', amountCents: 50_000, bankEventId: 'bank-existing' }), /konto, datum och belopp/);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-02', amountCents: 49_000, bankEventId: 'bank-existing' }), /konto, datum och belopp/);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, bankEventId: 'missing' }), /saknas/);
  state.bankTransactions[0].account = '1630';
  assert.throws(() => receivePayment(state, id, { date: '2026-10-02', amountCents: 50_000, bankEventId: 'bank-existing' }), /konto, datum och belopp/);
  assert.equal(state.entries.length, 1);
});

test('issued invoice immutable snapshot detects non-financial customer and line edits', () => {
  const state = issued();
  const id = last(state).id;
  state.invoices[0].lines[0].description = 'Ändrad efter utfärdande';
  assert.throws(() => receivePayment(state, id, { date: '2026-10-03', amountCents: 10_000 }), /uppgifter har ändrats/);
  assert.throws(() => creditInvoice(state, id, { date: '2026-10-03', reason: 'Rättelse' }), /uppgifter har ändrats/);
});

test('reminder is an audited preparation only and does not post a fee', () => {
  const initial = issued();
  const next = recordReminder(initial, last(initial).id);
  assert.equal(next.entries.length, initial.entries.length);
  assert.match(last(next).reminders[0].note, /inget har skickats/);
});

test('ROT uses 30 percent of labor including VAT, excluding material and other', () => {
  const state = withRot();
  const totals = getInvoiceTotals(last(state));
  assert.equal(totals.netCents, 3_100_000);
  assert.equal(totals.vatCents, 775_000);
  assert.equal(totals.grossCents, 3_875_000);
  assert.equal(totals.rotCents, 750_000);
  assert.equal(totals.customerCents, 3_125_000);
  assert.equal(calculateRot(last(state)).laborGrossCents, 2_500_000);
  assert.equal(accountBalance(state, '1510'), totals.grossCents);
});

test('ROT cap and declared available room constrain the deduction', () => {
  let state = withRot({ lines: [line('labor', 20_000_000)] });
  assert.equal(getInvoiceTotals(last(state)).rotCents, 5_000_000);
  state = withRot({ rot: rotFields(123_400) });
  assert.equal(getInvoiceTotals(last(state)).rotCents, 123_400);
  assert.throws(() => withRot({ rot: rotFields(0) }), /utrymme/);
});

test('ROT invoice and request share whole-krona truncation without stranded ören', () => {
  const state = withRot({ lines: [line('labor', 10_001)] });
  const totals = getInvoiceTotals(last(state));
  assert.equal(totals.grossCents, 12_501);
  assert.equal(totals.rotCents, 3_700);
  assert.equal(totals.customerCents, 8_801);
});

test('same-person ROT reservations cannot spend annual declared room twice', () => {
  let state = withRot({ rot: rotFields(1_000_000) });
  assert.equal(getInvoiceTotals(last(state)).rotCents, 750_000);
  state = withRot({ rot: rotFields(1_000_000) }, state);
  assert.equal(getInvoiceTotals(last(state)).rotCents, 250_000);
  assert.throws(() => withRot({ rot: rotFields(1_000_000) }, state), /utrymme/);
  const person2 = { ...rotFields(1_000_000), personId: 'DEMO-ROT-002' };
  state = withRot({ rot: person2 }, state);
  assert.equal(getInvoiceTotals(last(state)).rotCents, 750_000);
});

test('ROT invalid year, no labor, unconfirmed eligibility are rejected', () => {
  assert.throws(() => withRot({ rot: { ...rotFields(), paymentYear: 2025 } }), /2026/);
  assert.throws(() => withRot({ rot: { ...rotFields(), eligibleConfirmed: false } }), /Bekräfta/);
  assert.throws(() => withRot({ lines: [line('material')], rot: rotFields() }), /arbetskostnad/);
  assert.throws(() => withRot({ lines: [line('labor', 100_000, 1, 12)], rot: rotFields() }), /25 procent/);
});

test('ROT request requires paid customer share, performed work and electronic payment', () => {
  const unpaid = withRot();
  assert.throws(() => request(unpaid), /hela del/);
  let state = paidRot();
  const id = last(state).id;
  assert.throws(() => requestRot(state, id, { date: '2026-10-12', electronicPaymentConfirmed: true }), /arbetet är utfört/);
  assert.throws(() => requestRot(state, id, { date: '2026-10-12', workCompletedConfirmed: true }), /elektroniskt/);
  assert.throws(() => requestRot(state, id, { date: '2027-02-01', workCompletedConfirmed: true, electronicPaymentConfirmed: true }), /31 januari/);
  state = request(state);
  assert.equal(state.rotClaims[0].status, 'prepared');
  assert.equal(last(state).rot.status, 'requested');
  assert.throws(() => request(state), /redan registrerad/);
});

test('ROT tax payout needs simulated decision and cannot exceed approved amount', () => {
  let state = paidRot();
  const id = last(state).id;
  assert.throws(() => receivePayment(state, id, { date: '2026-10-20', amountCents: 750_000, payer: 'tax' }), /godkänt beslut/);
  state = request(state);
  assert.throws(() => decideRot(state, id, { date: '2026-10-20', approvedCents: 750_100 }), /överstiga/);
  state = decideRot(state, id, { date: '2026-10-20', approvedCents: 750_000 });
  assert.throws(() => receivePayment(state, id, { date: '2026-10-19', amountCents: 750_000, payer: 'tax' }), /före ROT-beslutet/);
  state = receivePayment(state, id, { date: '2026-10-21', amountCents: 750_000, payer: 'tax' });
  assert.equal(getInvoiceOutstanding(last(state)), 0);
  assert.equal(accountBalance(state, '1510'), 0);
  assert.equal(last(state).rot.status, 'settled');
});

test('partial ROT decision leaves rejected amount receivable from customer', () => {
  let state = request(paidRot());
  const id = last(state).id;
  const before = accountBalance(state, '1510');
  state = decideRot(state, id, { date: '2026-10-20', approvedCents: 500_000, reason: 'Delvis utrymme i demobeslutet' });
  assert.equal(accountBalance(state, '1510'), before);
  assert.equal(getInvoiceTotals(last(state)).customerCents, 3_375_000);
  state = receivePayment(state, id, { date: '2026-10-21', amountCents: 500_000, payer: 'tax' });
  assert.equal(getInvoiceOutstanding(last(state)), 250_000);
  state = receivePayment(state, id, { date: '2026-10-22', amountCents: 250_000 });
  assert.equal(getInvoiceOutstanding(last(state)), 0);
});

test('full ROT denial releases reservation and customer pays the original price', () => {
  let state = request(paidRot());
  const id = last(state).id;
  state = decideRot(state, id, { date: '2026-10-20', approvedCents: 0, reason: 'Fiktivt avslag' });
  assert.equal(getInvoiceTotals(last(state)).rotCents, 0);
  assert.equal(getInvoiceOutstanding(last(state)), 750_000);
  assert.throws(() => receivePayment(state, id, { date: '2026-10-21', amountCents: 1, payer: 'tax' }), /godkänt beslut/);
  state = receivePayment(state, id, { date: '2026-10-21', amountCents: 750_000 });
  assert.equal(getInvoiceOutstanding(last(state)), 0);
});
