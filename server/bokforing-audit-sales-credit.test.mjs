import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance } from '../public/bokforing/suite/core.js';
import { createCustomer, createInvoice, issueInvoice, getInvoiceTotals, getInvoiceOutstanding, receivePayment, creditInvoice, copyInvoice } from '../public/bokforing/suite/sales.js';
import { createBill, bookBill, payBill, getBillOutstanding } from '../public/bokforing/suite/operations.js';
import { createCreditNote, refundCredit, offsetCredit, getDocumentSettlementSummary, getCreditSourceLines, previewCreditNote } from '../public/bokforing/suite/settlements.js';
import { createRevenueSchedule, recognizeRevenueMonth, getRevenueDueMonths } from '../public/bokforing/suite/commercial.js';
import { fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';
import { invoiceDocumentHTML } from '../public/bokforing/suite/invoice-page.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

// Each registration is an independent top-level scenario, with its own state.
// Oracle arithmetic uses integer fractions; it never calls production calculators.
let number = 0;
const audit = (description, fn) => test(`AUDIT-SALES-${String(++number).padStart(3, '0')} ${description}`, fn);
const round = (numerator, denominator) => Number((2n * BigInt(numerator) + BigInt(denominator)) / (2n * BigInt(denominator)));
const ratio = (value, numerator, denominator) => round(BigInt(value) * BigInt(numerator), denominator);
const line = (unitCents = 10003, vatRate = 25, extra = {}) => ({ description: 'Avtalad tjänst', kind: 'other', quantity: 1, unitCents, vatRate, ...extra });
const base = () => createCustomer(createEmptyState(), { name: 'Svensk avtalspart AB', email: 'faktura@example.test', address: 'Testgatan 1' });
const originalDate = '2026-01-01';
function customer(options = {}, state = base()) {
  state = createInvoice(state, { customerId: state.customers[0].id, date: originalDate, dueDate: '2026-01-31', lines: [line()], ...options });
  const id = state.invoices.at(-1).id;
  return { state: issueInvoice(state, id), id };
}
function supplier(options = {}, state = createEmptyState()) {
  state = createBill(state, { supplier: 'Svensk avtalspart AB', number: `LEV-${state.bills.length + 1}`, date: originalDate, dueDate: '2026-01-31', netCents: 10003, vatRate: 25, account: '4010', ...options });
  const id = state.bills.at(-1).id;
  return { state: bookBill(state, id), id };
}
const document = (state, side, id) => state[side === 'customer' ? 'invoices' : 'bills'].find(item => item.id === id);
const checked = state => { validateSuiteState(state); return state; };
function unchanged(state, operation) {
  const before = structuredClone(state);
  const result = operation();
  assert.deepEqual(state, before, 'The input state must remain unchanged');
  return checked(result);
}
function rejected(state, operation, pattern) {
  const before = structuredClone(state);
  assert.throws(operation, pattern);
  assert.deepEqual(state, before, 'Rejected operations must be atomic');
  checked(state);
}
function credit(state, side, id, selections, reference = 'CREDIT-1', options = {}) {
  return createCreditNote(state, { side, documentId: id, date: '2026-01-20', reason: 'Dokumenterad prisnedsättning', reference, lines: selections, ...options });
}
function priceOracle(row, discount) {
  const baseCents = ratio(row.unitCents, Math.round(row.quantity * 100), 100);
  const rowPrice = baseCents - ratio(baseCents, row.discountBps ?? 0, 10000);
  const price = rowPrice - ratio(rowPrice, row.chargeType ? 0 : discount, 10000);
  const net = row.unitPriceIncludesVat ? ratio(price, 100, 100 + row.vatRate) : price;
  const vat = row.unitPriceIncludesVat ? price - net : ratio(net, row.vatRate, 100);
  return { net, vat, gross: net + vat };
}
const taxAccounts = { 25: '2611', 12: '2621', 6: '2631' };

// 64 invoice pricing scenarios: four rates, inclusive/exclusive prices, four
// independently rounded rebate policies, and whole/fractional quantities.
for (const rate of [0, 6, 12, 25]) for (const included of [false, true]) for (const rebate of [0, 1, 3333, 9999]) for (const quantity of [1, 1.37]) {
  audit(`invoice rate=${rate}, inclusive=${included}, discount=${rebate}, quantity=${quantity}`, () => {
    const lines = [line(10003, rate, { quantity, discountBps: rebate, unitPriceIncludesVat: included }),
      line(701, [25, 12, 6, 0][[0, 6, 12, 25].indexOf(rate)], { quantity: 0.29, discountBps: 1750, unitPriceIncludesVat: included }),
      line(113, rate, { description: 'Avtalad frakt', chargeType: 'freight', unitPriceIncludesVat: included })];
    const expected = lines.map(item => priceOracle(item, 1250));
    const { state } = customer({ lines, invoiceDiscountBps: 1250 });
    checked(state);
    const sum = key => expected.reduce((n, row) => n + row[key], 0);
    assert.deepEqual(getInvoiceTotals(state.invoices[0]), { netCents: sum('net'), vatCents: sum('vat'), grossCents: sum('gross'), rotCents: 0, customerCents: sum('gross') });
    assert.equal(accountBalance(state, '1510'), sum('gross'));
    assert.equal(accountBalance(state, '3000'), 0 - sum('net'));
    for (const [vatRate, account] of Object.entries(taxAccounts)) assert.equal(accountBalance(state, account), 0 - expected.reduce((n, row, index) => n + (lines[index].vatRate === +vatRate ? row.vat : 0), 0));
    const copied = unchanged(state, () => copyInvoice(state, state.invoices[0].id, { date: '2026-01-02', dueDate: '2026-02-01' }));
    assert.equal(copied.invoices.at(-1).status, 'draft');
    assert.equal(copied.entries.length, state.entries.length);
    assert.deepEqual(copied.invoices.at(-1).lines, state.invoices[0].lines);
  });
}

// 32 customer credit sequences include VAT exactly at tiny-ore boundaries.
for (const rate of [0, 6, 12, 25]) for (const net of [2, 3, 5, 7, 11, 17, 101, 10003]) {
  audit(`cumulative customer credit net=${net}, rate=${rate}`, () => {
    let { state, id } = customer({ lines: [line(net, rate), line(13, 25)] });
    const originalEntry = structuredClone(state.entries[0]);
    const originalSnapshot = state.invoices[0].bookingSnapshot;
    const vat = ratio(net, rate, 100), first = Math.floor(net / 2);
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: first }], 'PART-1'));
    assert.equal(state.settlements[0].amountCents, first + ratio(vat, first, net));
    assert.equal(getCreditSourceLines(state, 'customer', id)[0].remainingNetCents, net - first);
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: net - first }, { index: 1, netCents: 13 }], 'PART-2'));
    assert.equal(getInvoiceOutstanding(document(state, 'customer', id)), 0);
    for (const account of ['1510', '3000', '2611', '2621', '2631']) assert.equal(accountBalance(state, account), 0);
    assert.equal(state.invoices[0].bookingSnapshot, originalSnapshot);
    assert.deepEqual(state.entries[0], originalEntry);
    rejected(state, () => credit(state, 'customer', id, [{ index: 0, netCents: 1 }], 'EXCESS'), /överstiger/);
  });
}

// 32 supplier scenarios preserve both deductible and non-deductible tax rows,
// including buyer-accounted construction VAT, under sequential partial credits.
for (const mode of ['standard', 'reverse-construction']) for (const net of [2, 7, 101, 10003]) for (const deductible of [0, 3333, 5000, 10000]) {
  audit(`supplier cumulative credit net=${net}, mode=${mode}, deductible=${deductible}`, () => {
    const rate = mode === 'reverse-construction' ? 25 : [6, 12, 25, 25][[2, 7, 101, 10003].indexOf(net)];
    const expense = mode === 'reverse-construction' ? '4425' : '4010';
    const vat = ratio(net, rate, 100), deduction = ratio(vat, deductible, 10000), cost = net + vat - deduction;
    let { state, id } = supplier({ lines: [{ description: 'Avtalad leverans', netCents: net, account: expense, vatRate: rate, vatMode: mode, deductibleBps: deductible, reverseConfirmed: true }] });
    assert.equal(accountBalance(state, expense), cost);
    assert.equal(accountBalance(state, mode === 'standard' ? '2641' : '2647'), deduction);
    const first = Math.floor(net / 2), journals = structuredClone(state.entries);
    state = unchanged(state, () => credit(state, 'supplier', id, [{ index: 0, netCents: first }], 'FIRST'));
    assert.equal(accountBalance(state, expense), cost - ratio(cost, first, net));
    assert.equal(accountBalance(state, mode === 'standard' ? '2641' : '2647'), deduction - ratio(deduction, first, net));
    if (mode === 'reverse-construction') assert.equal(accountBalance(state, '2614'), -vat + ratio(vat, first, net));
    state = unchanged(state, () => credit(state, 'supplier', id, [{ index: 0, netCents: net - first }], 'FINAL'));
    for (const account of ['2440', expense, '2641', '2647', '2614']) assert.equal(accountBalance(state, account), 0);
    assert.equal(getBillOutstanding(state.bills[0]), 0);
    assert.deepEqual(state.entries.slice(0, journals.length), journals);
  });
}

// 24 independently exercised refund/offset histories, with paid originals.
for (const side of ['customer', 'supplier']) for (const creditedNet of [3, 7, 4001, 10003]) for (const action of ['refund-all', 'refund-two-parts', 'offset']) {
  audit(`${side} ${action}, credited net=${creditedNet}`, () => {
    let { state, id } = (side === 'customer' ? customer : supplier)();
    const pay = side === 'customer' ? receivePayment : payBill;
    const originalGross = 12504, creditGross = creditedNet + ratio(2501, creditedNet, 10003);
    state = unchanged(state, () => pay(state, id, { date: '2026-01-02', amountCents: originalGross, reference: 'PAID' }));
    state = unchanged(state, () => credit(state, side, id, [{ index: 0, netCents: creditedNet }]));
    assert.equal(getDocumentSettlementSummary(side, document(state, side, id)).refundableCents, creditGross);
    const bankBefore = accountBalance(state, '1930');
    const journals = structuredClone(state.entries);
    if (action === 'offset') {
      const next = (side === 'customer' ? customer : supplier)({}, state); state = next.state;
      state = unchanged(state, () => offsetCredit(state, { side, documentId: id, targetDocumentId: next.id, date: '2026-01-21', amountCents: creditGross, reference: 'OFFSET' }));
      const balance = getDocumentSettlementSummary(side, document(state, side, next.id));
      assert.equal(balance.outstandingCents, originalGross - creditGross);
      assert.equal(accountBalance(state, '1930'), bankBefore);
    } else {
      const amounts = action === 'refund-all' ? [creditGross] : [Math.floor(creditGross / 2), creditGross - Math.floor(creditGross / 2)];
      for (const [index, amount] of amounts.entries()) state = unchanged(state, () => refundCredit(state, { side, documentId: id, date: `2026-01-${21 + index}`, amountCents: amount, reference: `REFUND-${index}` }));
      assert.equal(accountBalance(state, '1930'), bankBefore + (side === 'customer' ? -creditGross : creditGross));
      assert.equal(accountBalance(state, side === 'customer' ? '1510' : '2440'), 0);
    }
    assert.equal(getDocumentSettlementSummary(side, document(state, side, id)).balanceCents, 0);
    assert.deepEqual(state.entries.slice(0, journals.length), journals);
  });
}

// 36 revenue-credit histories cover tiny plans, rounded intermediate targets,
// fully/partly credited contracts, and continuations after existing recognition.
for (const net of [3, 101, 10003]) for (const months of [2, 3, 6]) for (const recognizedCount of [0, 1]) for (const fullCredit of [false, true]) {
  audit(`revenue credit net=${net}, months=${months}, recognized=${recognizedCount}, full=${fullCredit}`, () => {
    let { state, id } = customer({ lines: [line(net)] });
    state = unchanged(state, () => createRevenueSchedule(state, { invoiceId: id, date: originalDate, amountCents: net, startMonth: '2026-01', months, name: 'Tjänst under avtalsperioden' }));
    const planId = state.revenueSchedules[0].id;
    if (recognizedCount) state = unchanged(state, () => recognizeRevenueMonth(state, planId, { date: '2026-01-15' }));
    const journals = structuredClone(state.entries), creditNet = fullCredit ? net : Math.floor(net / 2), remaining = net - creditNet;
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: creditNet }], 'REVENUE-CREDIT', { specialReviewed: true }));
    const recognizedBefore = ratio(net, recognizedCount, months), recognizedAfter = ratio(remaining, recognizedCount, months);
    assert.deepEqual(state.settlements[0].revenueAdjustments, [{ planId, amountCents: creditNet, recognizedCents: recognizedBefore - recognizedAfter, deferredCents: creditNet - recognizedBefore + recognizedAfter }]);
    assert.equal(accountBalance(state, '2990'), 0 - (remaining - recognizedAfter));
    assert.equal(accountBalance(state, '3000'), 0 - recognizedAfter);
    assert.deepEqual(state.entries.slice(0, journals.length), journals);
    if (remaining) {
      for (let month = recognizedCount + 1; month <= months; month++) {
        const date = `2026-${String(month).padStart(2, '0')}-${month === 1 ? '21' : '15'}`;
        state = unchanged(state, () => recognizeRevenueMonth(state, planId, { date }));
        assert.equal(state.revenueSchedules[0].postings.at(-1).amountCents, ratio(remaining, month, months) - ratio(remaining, month - 1, months));
      }
      assert.equal(state.revenueSchedules[0].status, 'completed');
    } else assert.equal(state.revenueSchedules[0].status, 'cancelled');
    assert.equal(accountBalance(state, '2990'), 0);
    assert.equal(accountBalance(state, '3000'), 0 - remaining);
    assert.deepEqual(getRevenueDueMonths(state), []);
  });
}

function allocationOracle(total, weights, denominator) {
  const ideal = weights.map(weight => ({ floor: Math.floor(total * weight / denominator), remainder: BigInt(total) * BigInt(weight) % BigInt(denominator) }));
  const output = ideal.map(item => item.floor);
  const indexes = ideal.map((_, i) => i).sort((a, b) => ideal[a].remainder === ideal[b].remainder ? a - b : ideal[a].remainder > ideal[b].remainder ? -1 : 1);
  const leftover = total - output.reduce((a, b) => a + b, 0);
  for (const index of indexes.slice(0, leftover)) output[index]++;
  return output;
}
for (const net of [7, 101, 10003]) for (const distribution of [0, 1, 2, 3]) {
  audit(`multiple revenue plans net=${net}, allocation pattern=${distribution}`, () => {
    let { state, id } = customer({ lines: [line(net)] });
    const weights = distribution === 0 ? [1, 1] : distribution === 1 ? [Math.floor(net / 2), net - Math.floor(net / 2)] : distribution === 2 ? [1, net - 2] : [Math.floor(net / 3), Math.floor(net / 3)];
    for (const [index, amountCents] of weights.entries()) state = checked(createRevenueSchedule(state, { invoiceId: id, date: originalDate, amountCents, startMonth: '2026-02', months: index + 2, name: `Tjänstedel ${index}` }));
    const originalPlans = structuredClone(state.revenueSchedules);
    const creditNet = Math.floor(net / 2), allocation = allocationOracle(creditNet, [...weights, net - weights[0] - weights[1]], net);
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: creditNet }], 'MULTIPLAN-1', { specialReviewed: true }));
    assert.deepEqual(state.settlements[0].revenueAdjustments, weights.flatMap((_, index) => allocation[index] ? [{ planId: originalPlans[index].id, amountCents: allocation[index], recognizedCents: 0, deferredCents: allocation[index] }] : []));
    assert.equal(accountBalance(state, '2990'), -(weights[0] + weights[1] - allocation[0] - allocation[1]));
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: net - creditNet }], 'MULTIPLAN-2', { specialReviewed: true }));
    for (const account of ['1510', '3000', '2611', '2990']) assert.equal(accountBalance(state, account), 0);
    assert.ok(state.revenueSchedules.every(item => item.status === 'cancelled'));
  });
}

const invalidInvoiceCases = [
  ['negative unit cents', { lines: [line(-1)] }], ['zero unit cents', { lines: [line(0)] }], ['fractional unit cents', { lines: [line(1.5)] }],
  ['unsafe unit cents', { lines: [line(Number.MAX_SAFE_INTEGER + 1)] }], ['NaN unit cents', { lines: [line(NaN)] }], ['infinite quantity', { lines: [line(100, 25, { quantity: Infinity })] }],
  ['zero quantity', { lines: [line(100, 25, { quantity: 0 })] }], ['negative quantity', { lines: [line(100, 25, { quantity: -1 })] }],
  ['three decimal quantity', { lines: [line(100, 25, { quantity: 1.001 })] }], ['unsupported VAT rate', { lines: [line(100, 24)] }],
  ['negative row rebate', { lines: [line(100, 25, { discountBps: -1 })] }], ['excessive row rebate', { lines: [line(100, 25, { discountBps: 10001 })] }],
  ['fractional invoice rebate', { invoiceDiscountBps: 1.5 }], ['negative invoice rebate', { invoiceDiscountBps: -1 }],
  ['mixed inclusive modes', { lines: [line(100, 25, { unitPriceIncludesVat: true }), line(100)] }],
  ['nonboolean inclusive flag', { lines: [line(100, 25, { unitPriceIncludesVat: 'false' })] }],
  ['freight with rebate', { lines: [line(100, 25, { chargeType: 'freight', discountBps: 1 })] }],
  ['freight with fractional quantity', { lines: [line(100, 25, { chargeType: 'freight', quantity: 0.5 })] }],
  ['duplicate freight', { lines: [line(100, 25, { chargeType: 'freight' }), line(200, 25, { chargeType: 'freight' })] }],
  ['unsupported charge', { lines: [line(100, 25, { chargeType: 'late-fee' })] }],
];
for (const [name, options] of invalidInvoiceCases) audit(`reject ${name}`, () => {
  const state = base(); rejected(state, () => createInvoice(state, { customerId: state.customers[0].id, date: originalDate, dueDate: '2026-01-31', lines: [line()], ...options }));
});

const creditErrors = [
  ['no selected rows', { lines: [] }], ['duplicate row selections', { lines: [{ index: 0, netCents: 1 }, { index: 0, netCents: 2 }] }],
  ['unknown row', { lines: [{ index: 1, netCents: 1 }] }], ['negative row index', { lines: [{ index: -1, netCents: 1 }] }],
  ['fractional row index', { lines: [{ index: 0.5, netCents: 1 }] }], ['zero credit', { lines: [{ index: 0, netCents: 0 }] }],
  ['negative credit', { lines: [{ index: 0, netCents: -1 }] }], ['fractional credit', { lines: [{ index: 0, netCents: 1.5 }] }],
  ['excess credit', { lines: [{ index: 0, netCents: 10004 }] }], ['empty reason', { reason: ' ' }], ['empty reference', { reference: '' }],
  ['control-character reference', { reference: 'C\n1' }], ['before invoice', { date: '2025-12-31' }], ['invalid calendar date', { date: '2026-02-29' }],
  ['unsupported side', { side: 'external' }], ['missing document', { documentId: 'missing' }],
];
for (const [name, changes] of creditErrors) audit(`reject credit: ${name}`, () => {
  const { state, id } = customer(); rejected(state, () => createCreditNote(state, { side: 'customer', documentId: id, date: '2026-01-20', reason: 'Prisjustering', reference: 'C-1', lines: [{ index: 0, netCents: 1 }], ...changes }));
});

for (const side of ['customer', 'supplier']) for (const action of ['overpayment', 'credit-before-payment', 'refund-without-credit', 'closed-credit']) audit(`${side} rejects ${action}`, () => {
  let { state, id } = (side === 'customer' ? customer : supplier)();
  const pay = side === 'customer' ? receivePayment : payBill;
  if (action === 'overpayment') rejected(state, () => pay(state, id, { date: '2026-01-02', amountCents: 12505 }), /överstiger/);
  if (action === 'credit-before-payment') {
    state = checked(pay(state, id, { date: '2026-01-21', amountCents: 1 }));
    rejected(state, () => credit(state, side, id, [{ index: 0, netCents: 1 }]), /före/);
  }
  if (action === 'refund-without-credit') rejected(state, () => refundCredit(state, { side, documentId: id, date: '2026-01-20', amountCents: 1, reference: 'NO-CREDIT' }), /tillgodobelopp/);
  if (action === 'closed-credit') { state.lockedPeriods.push('2026-01'); rejected(state, () => credit(state, side, id, [{ index: 0, netCents: 1 }]), /låst/); }
});

// Restoration must inspect both originals and append-only settlement evidence.
const mutations = [
  ['original description', s => { s.invoices[0].lines[0].description = 'Bytt'; }],
  ['original VAT rate', s => { s.invoices[0].lines[0].vatRate = 12; }],
  ['original quantity', s => { s.invoices[0].lines[0].quantity = 2; }],
  ['original unit price', s => { s.invoices[0].lines[0].unitCents += 1; }],
  ['original customer name', s => { s.invoices[0].details.customer.name = 'Bytt'; }],
  ['original seller name', s => { s.invoices[0].details.seller.name = 'Bytt'; }],
  ['original invoice date', s => { s.invoices[0].date = '2026-01-02'; }],
  ['original due date', s => { s.invoices[0].dueDate = '2026-02-01'; }],
  ['credit amount', s => { s.settlements[0].amountCents += 1; }],
  ['credit reason', s => { s.settlements[0].reason = 'Bytt'; }],
  ['credit source', s => { s.settlements[0].sourceEntryId = 'missing'; }],
  ['credit row', s => { s.settlements[0].lines[0].netCents += 1; }],
  ['credit mirror', s => { s.invoices[0].settlementCreditCents += 1; }],
  ['credit journal', s => { s.entries.at(-1).rows[0].debitCents += 1; }],
  ['credit deletion', s => { s.settlements = []; }],
  ['credit journal deletion', s => { s.entries.pop(); }],
];
for (const [name, mutation] of mutations) audit(`restore rejects altered ${name}`, () => {
  let { state, id } = customer(); state = checked(credit(state, 'customer', id, [{ index: 0, netCents: 1000 }]));
  const bad = structuredClone(state); mutation(bad); assert.throws(() => validateSuiteState(bad)); checked(state);
});

// ML (2023:200) 17:22 requires an unambiguous reference on the correction itself.
// These assertions inspect the actual exported HTML sent to the print window.
for (const [name, options] of [
  ['ordinary correction', {}],
  ['discounted mixed-VAT correction', { invoiceDiscountBps: 1750, lines: [line(103, 25), line(201, 12)] }],
  ['reverse-construction correction', { vatMode: 'reverse-construction', buyerConstructionConfirmed: true }],
  ['VAT-inclusive correction', { lines: [line(12501, 25, { unitPriceIncludesVat: true })] }],
]) audit(`printed ${name} identifies the original document and correction reason`, () => {
  let { state, id } = customer(options);
  const originalNumber = state.invoices[0].number;
  const reason = 'Felbeställning <del A> & prisändring';
  state = unchanged(state, () => creditInvoice(state, id, { date: '2026-01-20', reason }));
  const html = invoiceDocumentHTML(state, state.invoices.at(-1));
  assert.ok(html.includes(originalNumber), 'The printed credit needs the original invoice number');
  assert.match(html, /Avser faktura/);
  assert.match(html, /Felbeställning &lt;del A&gt; &amp; prisändring/);
  assert.doesNotMatch(html, /Felbeställning <del A>/);
});

for (const net of [1, 2, 10003]) audit(`restore rejects revenue chronology rewritten after credit, net=${net}`, () => {
  let { state, id } = customer({ lines: [line(net)] });
  state = createRevenueSchedule(state, { invoiceId: id, date: originalDate, amountCents: net, startMonth: '2026-01', months: 5, name: 'Periodavtal' });
  const planId = state.revenueSchedules[0].id;
  state = recognizeRevenueMonth(state, planId, { date: '2026-01-15' });
  state = checked(credit(state, 'customer', id, [{ index: 0, netCents: 1 }], 'CORRECT-DATE', { specialReviewed: true }));
  const altered = structuredClone(state), posting = altered.revenueSchedules[0].postings[0];
  posting.date = '2026-01-25';
  if (posting.entryId) altered.entries.find(entry => entry.id === posting.entryId).date = posting.date;
  assert.throws(() => validateSuiteState(altered), /före.*intäktsföring/);
  checked(state);
});

for (const net of [2, 7, 10003]) audit(`later legitimate revenue recognition remains valid after earlier credit, net=${net}`, () => {
  let { state, id } = customer({ lines: [line(net)] });
  state = createRevenueSchedule(state, { invoiceId: id, date: originalDate, amountCents: net, startMonth: '2026-01', months: 5, name: 'Periodavtal' });
  const planId = state.revenueSchedules[0].id;
  state = recognizeRevenueMonth(state, planId, { date: '2026-01-15' });
  state = checked(credit(state, 'customer', id, [{ index: 0, netCents: 1 }], 'FIRST', { specialReviewed: true }));
  state = unchanged(state, () => recognizeRevenueMonth(state, planId, { date: '2026-02-15' }));
  state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: net - 1 }], 'FINAL', { date: '2026-02-20', specialReviewed: true }));
  assert.equal(accountBalance(state, '2990'), 0);
  assert.equal(accountBalance(state, '3000'), 0);
});

const expectedNetUnitPrice = new Map([[0, '125,01 kr'], [6, '≈ 117,933962 kr'], [12, '≈ 111,616071 kr'], [25, '100,008 kr']]);
for (const rate of [0, 6, 12, 25]) for (const rebate of [0, 1, 1750, 9999]) audit(`printed inclusive price exposes ex-VAT unit price: rate=${rate}, rebate=${rebate}`, () => {
  const { state } = customer({ lines: [line(12501, rate, { unitPriceIncludesVat: true, discountBps: rebate, quantity: 1.37 }), line(113, 25, { unitPriceIncludesVat: true, chargeType: 'invoice-fee' })], invoiceDiscountBps: 1250 });
  const before = structuredClone(state), totals = getInvoiceTotals(state.invoices[0]);
  const html = invoiceDocumentHTML(state, state.invoices[0]);
  assert.match(html, /À-pris exkl\. moms/);
  assert.ok(html.includes(expectedNetUnitPrice.get(rate)), expectedNetUnitPrice.get(rate));
  assert.match(html, /före rabatter/);
  assert.equal(html.includes('À-pris inkl. moms'), false);
  assert.deepEqual(state, before);
  assert.deepEqual(getInvoiceTotals(state.invoices[0]), totals);
  checked(state);
});

for (const net of [1, 2, 3, 12501]) audit(`inclusive credit print preserves reference and precision for price=${net}`, () => {
  let { state, id } = customer({ lines: [line(net, 25, { unitPriceIncludesVat: true })] });
  state = creditInvoice(state, id, { date: '2026-01-20', reason: 'Rättelse av pris inklusive moms' });
  const html = invoiceDocumentHTML(state, state.invoices.at(-1));
  const displayed = new Map([[1, '0,008 kr'], [2, '0,016 kr'], [3, '0,024 kr'], [12501, '100,008 kr']]);
  assert.ok(html.includes(displayed.get(net)));
  assert.match(html, /Avser faktura/);
  assert.match(html, /F-0001/);
  assert.equal(accountBalance(state, '1510'), 0);
  checked(state);
});

const freezeJanuary = state => { const monthly = structuredClone(state); monthly.company.vatPeriod = 'month'; return checked(fileVatPeriod(monthly, { from: '2026-01-01', to: '2026-01-31', date: '2026-01-31' })); };
const januaryBoxes = state => getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-01-31' }).boxes;
for (const mode of ['standard', 'reverse-construction']) {
  const options = { vatMode: mode, buyerConstructionConfirmed: true, lines: [line(101, mode === 'standard' ? 0 : 25)] };
  audit(`finalized VAT period rejects new ${mode} invoice even without VAT journal rows`, () => {
    let state = freezeJanuary(base());
    state = createInvoice(state, { customerId: state.customers[0].id, date: originalDate, dueDate: '2026-01-31', ...options });
    const before = januaryBoxes(state);
    rejected(state, () => issueInvoice(state, state.invoices[0].id), /Momsperioden.*fastställd/);
    assert.deepEqual(januaryBoxes(state), before);
  });
  for (const kind of ['partial', 'legacy-full', 'preview']) audit(`finalized VAT period rejects ${mode} ${kind} credit`, () => {
    let { state, id } = customer(options); state = freezeJanuary(state);
    const before = januaryBoxes(state);
    if (kind === 'legacy-full') rejected(state, () => creditInvoice(state, id, { date: '2026-01-20', reason: 'Rättelse' }), /Momsperioden.*fastställd/);
    else if (kind === 'partial') rejected(state, () => credit(state, 'customer', id, [{ index: 0, netCents: 1 }]), /Momsperioden.*fastställd/);
    else rejected(state, () => previewCreditNote(state, { side: 'customer', documentId: id, date: '2026-01-20', reason: 'Rättelse', reference: 'PREVIEW', lines: [{ index: 0, netCents: 1 }] }), /Momsperioden.*fastställd/);
    assert.deepEqual(januaryBoxes(state), before);
  });
  audit(`open-period ${mode} credit leaves finalized January declaration unchanged`, () => {
    let { state, id } = customer(options); state = freezeJanuary(state);
    const before = januaryBoxes(state);
    state = unchanged(state, () => credit(state, 'customer', id, [{ index: 0, netCents: 1 }], 'FEB-CREDIT', { date: '2026-02-01' }));
    assert.deepEqual(januaryBoxes(state), before);
    assert.equal(getTaxDeclarationReport(state, { from: '2026-02-01', to: '2026-02-28' }).boxes[mode === 'standard' ? '05' : '41'], -1);
  });
  audit(`payment on ${mode} invoice remains allowed in finalized VAT period`, () => {
    let { state, id } = customer(options); state = freezeJanuary(state);
    const before = januaryBoxes(state);
    state = unchanged(state, () => receivePayment(state, id, { date: '2026-01-20', amountCents: 1, reference: 'PAYMENT' }));
    assert.deepEqual(januaryBoxes(state), before);
    assert.equal(accountBalance(state, '1930'), 1);
  });
  audit(`refund on ${mode} credit remains allowed in finalized VAT period`, () => {
    let { state, id } = customer(options);
    state = receivePayment(state, id, { date: '2026-01-02', amountCents: 101, reference: 'PAYMENT' });
    state = credit(state, 'customer', id, [{ index: 0, netCents: 101 }]); state = freezeJanuary(state);
    const before = januaryBoxes(state);
    state = unchanged(state, () => refundCredit(state, { side: 'customer', documentId: id, date: '2026-01-21', amountCents: 101, reference: 'REFUND' }));
    assert.deepEqual(januaryBoxes(state), before);
    assert.equal(accountBalance(state, '1510'), 0);
  });
}

for (const multiline of [false, true]) audit(`finalized VAT period rejects tiny supplier reverse base credit, multiline=${multiline}`, () => {
  let { state, id } = supplier(multiline ? { lines: [{ netCents: 1, description: 'Byggtjänst', vatMode: 'reverse-construction', vatRate: 25, account: '4425', reverseConfirmed: true }] } : { netCents: 1, vatMode: 'reverse-construction', reverseConfirmed: true });
  state = freezeJanuary(state);
  const before = januaryBoxes(state);
  rejected(state, () => credit(state, 'supplier', id, [{ index: 0, netCents: 1 }]), /Momsperioden.*fastställd/);
  assert.deepEqual(januaryBoxes(state), before);
});

audit('zero-VAT supplier expense credit is allowed when no declaration field changes', () => {
  let { state, id } = supplier({ netCents: 1, vatMode: 'no-vat' }); state = freezeJanuary(state);
  const before = januaryBoxes(state);
  state = unchanged(state, () => credit(state, 'supplier', id, [{ index: 0, netCents: 1 }]));
  assert.deepEqual(januaryBoxes(state), before);
  assert.equal(accountBalance(state, '2440'), 0);
});
