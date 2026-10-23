import assert from 'node:assert/strict';
import test from 'node:test';
import { accountBalance, createEmptyState } from '../public/bokforing/suite/core.js';
import { normalizeInvoiceDetails, validateInvoiceDetails } from '../public/bokforing/suite/invoice-data.js';
import { calculateLineAmounts, calculateRot } from '../public/bokforing/suite/rot.js';
import { copyInvoice, createCustomer, createInvoice, creditInvoice, getInvoiceTotals, invoiceBookingSnapshot, issueInvoice, receivePayment, updateInvoiceDraft } from '../public/bokforing/suite/sales.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const base = () => createCustomer(createEmptyState(), { name: 'Testkund', email: 'kund@example.test', address: 'Kundgatan 1', postalCode:'12345',city:'Teststad',country:'SE',vatNumber:'SE559999998301' });
const line = overrides => ({ description: 'Arbete', kind: 'labor', quantity: 1, unitCents: 10000, vatRate: 25, ...overrides });
function draft(payload = {}, state = base()) {
  return createInvoice(state, { customerId: state.customers[0].id, date: '2026-10-23', dueDate: '2026-11-22', lines: [line()], ...payload, details:{...payload.details,performance:payload.details?.performance??{mode:'invoice-date',confirmed:true}} });
}
const last = state => state.invoices.at(-1);
const issue = state => issueInvoice(state, last(state).id);
const rot = () => ({ paymentYear: 2026, property: 'DEMOFASTIGHET 1:1', personId: 'DEMO-KUND', eligibleConfirmed: true, availableCents: 5000000 });

test('billing, delivery and document details persist on invoice and freeze at issue', () => {
  const data = { paymentTermsDays: 30, ourReference: 'Anna', customerReference: 'Karin', customerOrderNumber: 'ORDER-12', costCenter: 'Bygg', invoiceText: 'Tack för uppdraget!',
    customer: { name: 'Specifik mottagare', address: 'Fakturagatan 2', address2: 'Plan 3', postalCode: '12345', city: 'Teststad', country: 'SE', phone: '010000000', email: 'faktura@example.test', reminderEmail: 'paminnelse@example.test', orgNumber: 'DEMO' },
    delivery: { name: 'Arbetsplats', address: 'Leveransgatan 3', postalCode: '23456', city: 'Annanstad', country: 'SE', date: '2026-10-25', method: 'Egen transport', terms: 'Avtalat' } };
  let state = draft({ details: data });
  state.company.name = 'Bolaget vid utfärdande';
  state = issue(state);
  const invoice = last(state);
  assert.equal(invoice.details.seller.name, 'Bolaget vid utfärdande');
  assert.equal(invoice.details.customer.name, 'Specifik mottagare');
  assert.equal(invoice.details.customer.reminderEmail, 'paminnelse@example.test');
  assert.equal(invoice.details.delivery.date, '2026-10-25');
  assert.equal(invoice.details.ourReference, 'Anna');
  const snapshot = invoice.bookingSnapshot;
  state.company.name = 'Senare bolagsnamn'; state.customers[0].name = 'Senare kundnamn'; state.customers[0].address = 'Ny adress';
  assert.equal(invoice.details.seller.name, 'Bolaget vid utfärdande');
  assert.equal(invoice.details.customer.address, 'Fakturagatan 2');
  assert.equal(invoiceBookingSnapshot(invoice), snapshot);
  validateSuiteState(state);
  const tampered = structuredClone(state); last(tampered).details.invoiceText = 'Ändrad efter bokföring';
  assert.throws(() => validateSuiteState(tampered), /uppgifter har ändrats/);
});

test('legacy issued snapshots stay byte-identical and remain usable after loading', () => {
  let state = issue(draft());
  const invoice = last(state);
  delete invoice.details; delete invoice.invoiceDiscountBps;
  invoice.bookingSnapshot = JSON.stringify({ id: invoice.id, number: invoice.number, kind: invoice.kind, originalInvoiceId: null,
    customerId: invoice.customerId, projectId: invoice.projectId ?? null, date: invoice.date, dueDate: invoice.dueDate,
    vatMode: invoice.vatMode, buyerConstructionConfirmed: invoice.buyerConstructionConfirmed,
    lines: invoice.lines.map(({ description, kind, quantity, unitCents, vatRate }) => ({ description, kind, quantity, unitCents, vatRate })), reason: null, rot: null });
  const before = invoice.bookingSnapshot;
  state = JSON.parse(JSON.stringify(state));
  validateSuiteState(state);
  assert.equal(invoiceBookingSnapshot(last(state)), before);
  state = receivePayment(state, invoice.id, { date: '2026-10-24', amountCents: 12500 });
  assert.equal(last(state).bookingSnapshot, before);
  assert.equal(last(state).details, undefined);
  validateSuiteState(state);
});

test('normalizer supplies safe fields and validates emails, dates, country and terms', () => {
  const state = base(), customerId = state.customers[0].id;
  const details = normalizeInvoiceDetails(state, { customerId, date: '2026-10-23', dueDate: '2026-10-30' });
  assert.equal(details.paymentTermsDays, 7);
  assert.equal(details.customer.email, 'kund@example.test');
  assert.equal(details.customer.country, 'SE');
  assert.equal(details.seller.name, state.company.name);
  validateInvoiceDetails(details);
  for (const bad of [{ customer: { email: 'invalid' } }, { delivery: { date: '2026-02-29' } }, { customer: { country: 'US' } }, { language: 'en' }, { paymentTermsDays: -1 }]) {
    assert.throws(() => normalizeInvoiceDetails(state, { customerId, details: bad }));
  }
});

test('line and invoice discounts use sequential integer rounding and inclusive VAT', () => {
  const result = calculateLineAmounts(line({ quantity: 2, unitCents: 12500, unitPriceIncludesVat: true, discountBps: 2000 }), 'standard', 1000);
  assert.deepEqual(result, { netCents: 14400, vatCents: 3600, grossCents: 18000 });
  assert.deepEqual(calculateLineAmounts(line({ unitCents: 1, unitPriceIncludesVat: true })), { netCents: 1, vatCents: 0, grossCents: 1 });
  assert.deepEqual(calculateLineAmounts(line({ unitCents: 3, unitPriceIncludesVat: true })), { netCents: 2, vatCents: 1, grossCents: 3 });
});

test('one invoice price basis is inferred, checked and preserved on restoration', () => {
  const state = issue(draft({ lines: [line({ unitPriceIncludesVat: true, unitCents: 12500 })] }));
  assert.equal(last(state).details.pricesIncludeVat, true);
  assert.equal(getInvoiceTotals(last(state)).grossCents, 12500);
  validateSuiteState(state);
  assert.throws(() => draft({ details: { pricesIncludeVat: false }, lines: [line({ unitPriceIncludesVat: true })] }), /momsinställning/);
  assert.throws(() => draft({ lines: [line({ unitPriceIncludesVat: true }), line({ kind: 'material' })] }), /samma prisinställning/);
  assert.throws(() => draft({ lines: [line({ kind: 'material', rotEligible: true })] }), /Endast arbetsrader/);
});

test('mixed VAT discounts and untaxed discount exclusion for fees post correct journals', () => {
  const lines = [[25,12500],[12,11200],[6,10600],[0,10000]].map(([vatRate,unitCents]) => line({ vatRate, unitCents, discountBps: 1000, unitPriceIncludesVat: true, ...(vatRate===0?{vatExemption:{code:'healthcare',legalBasis:'Granskat vårdfall enligt 10 kap. ML',confirmed:true}}:{}) }));
  lines.push(line({ description: 'Frakt', kind: 'other', unitCents: 1250, unitPriceIncludesVat: true, chargeType: 'freight', rotEligible: false }));
  const state = issue(draft({ lines, invoiceDiscountBps: 1000 }));
  assert.deepEqual(getInvoiceTotals(last(state)), { netCents: 33400, vatCents: 3733, grossCents: 37133, rotCents: 0, customerCents: 37133 });
  assert.equal(accountBalance(state, '1510'), 37133);
  assert.equal(accountBalance(state, '3000'), -33400);
  assert.equal(accountBalance(state, '2611'), -2275);
  assert.equal(accountBalance(state, '2621'), -972);
  assert.equal(accountBalance(state, '2631'), -486);
  validateSuiteState(state);
});

test('ROT uses discounted eligible work only and excludes fees and ineligible work', () => {
  const state = issue(draft({ invoiceDiscountBps: 1000, rot: rot(), lines: [
    line({ quantity: 32, unitCents: 55000, articleNumber: 'ARB-1', unit: 'tim', rotEligible: true }),
    line({ description: 'Ej ROT-arbete', unitCents: 10000, rotEligible: false }),
    line({ description: 'Material', kind: 'material', unitCents: 800000, rotEligible: false }),
    line({ description: 'Fakturaavgift', kind: 'other', unitCents: 5000, chargeType: 'invoice-fee', rotEligible: false }),
  ] }));
  assert.equal(calculateRot(last(state)).laborGrossCents, 1980000);
  assert.equal(getInvoiceTotals(last(state)).rotCents, 594000);
  validateSuiteState(state);
  assert.throws(() => draft({ rot: rot(), lines: [line({ rotEligible: false })] }), /ROT kräver/);
});

test('invalid discount and charge inputs are rejected atomically', () => {
  for (const changes of [{ discountBps: -1 }, { discountBps: 10001 }, { discountBps: 1.5 }, { unitPriceIncludesVat: 'yes' }, { chargeType: 'other' }, { chargeType: 'freight' }]) {
    assert.throws(() => draft({ lines: [line(changes)] }));
  }
  const freight = line({ kind: 'other', chargeType: 'freight' });
  assert.throws(() => draft({ lines: [freight, freight] }), /en gång/);
  assert.throws(() => draft({ invoiceDiscountBps: Infinity }));
  const state = draft(); const before = structuredClone(state);
  assert.throws(() => updateInvoiceDraft(state, last(state).id, { lines: [line({ discountBps: -1 })] }));
  assert.deepEqual(state, before);
});

test('100 percent discounted rows are allowed but wholly zero invoices cannot issue', () => {
  const state = issue(draft({ lines: [line({ discountBps: 10000 }), line({ description: 'Betald rad', unitCents: 20000 })] }));
  assert.equal(getInvoiceTotals(last(state)).grossCents, 25000);
  assert.ok(state.entries[0].rows.every(row => row.debitCents || row.creditCents));
  validateSuiteState(state);
  const zero = draft({ invoiceDiscountBps: 10000 });
  assert.equal(getInvoiceTotals(last(zero)).grossCents, 0);
  assert.throws(() => issue(zero), /större än noll/);
  assert.equal(zero.entries.length, 0);
});

test('copying paid ROT creates independent draft without booking, claims or payments', () => {
  let state = issue(draft({ rot: rot(), details: { invoiceText: 'Originaltext' }, lines: [line({ articleNumber: 'A1', unit: 'tim', rotEligible: true })] }));
  const originalId = last(state).id;
  state = receivePayment(state, originalId, { date: '2026-10-24', amountCents: getInvoiceTotals(last(state)).customerCents });
  const before = structuredClone(state.invoices[0]); const entries = state.entries.length;
  state = copyInvoice(state, originalId, { date: '2026-10-25', dueDate: '2026-11-24' });
  const copied = last(state);
  assert.equal(copied.status, 'draft'); assert.equal(copied.number, '');
  assert.equal(copied.copiedFromId, originalId); assert.equal(copied.payments.length, 0);
  assert.equal(copied.entryId, undefined); assert.equal(copied.rot.reservedCents, undefined);
  assert.equal(copied.details.invoiceText, 'Originaltext');
  assert.equal(state.entries.length, entries); assert.deepEqual(state.invoices[0], before);
  validateSuiteState(state);
});

test('credit preserves extended fields while reversing the exact original journal', () => {
  let state = issue(draft({ invoiceDiscountBps: 1200, details: { customerOrderNumber: 'ORDER-123' }, lines: [line({ unit: 'tim', articleNumber: 'ARBETE', discountBps: 500 })] }));
  const id = last(state).id;
  state = creditInvoice(state, id, { date: '2026-10-24', reason: 'Demo-rättelse' });
  assert.equal(last(state).details.customerOrderNumber, 'ORDER-123');
  assert.equal(last(state).invoiceDiscountBps, 1200);
  assert.equal(accountBalance(state, '1510'), 0);
  assert.equal(accountBalance(state, '3000'), 0);
  validateSuiteState(state);
});
