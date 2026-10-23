import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance } from '../public/bokforing/suite/core.js';
import { createCashState, createCashDocument, issueCashDocument, payCashDocument, creditCashDocument, refundCashDocument, recognizeCashYearEnd, getCashDocumentSummary, getCashTaxRows, getCashClosingIssues, deleteCashDraft } from '../public/bokforing/suite/cash-method.js';
import { createFxDocument, issueFxDocument, settleFxDocument, creditFxDocument, revalueFxDocument, getFxPosition, getFxTaxRows, getFxClosingIssues, parseFxRate, convertFxMinor } from '../public/bokforing/suite/fx.js';
import { fileVatPeriod, lockPeriod, closeYear } from '../public/bokforing/suite/finance.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { getTaxDeclarationReport } from '../public/bokforing/suite/tax-ledger.js';

// Independent integer oracles. No production rounding/allocation helper is used.
// Each invocation registers one separately reported business scenario.
let caseNumber = 0;
const scenario = (name, run) => test(`AUDIT-CASHFX-${String(++caseNumber).padStart(3, '0')} ${name}`, run);
const clone = value => structuredClone(value);
const rounded = (value, numerator, denominator = 100) => {
  const n = BigInt(value) * BigInt(numerator), d = BigInt(denominator);
  return Number(n / d + (n % d * 2n >= d ? 1n : 0n));
};
const rateRatio = value => { const [whole, decimals = ''] = value.replace(',', '.').split('.'); return [BigInt(whole + decimals), 10n ** BigInt(decimals.length)]; };
const converted = (amount, rate) => { const [n, d] = rateRatio(rate), sign = amount < 0 ? -1 : 1; return sign * rounded(Math.abs(amount), n, d); };
const distributed = (amount, weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  const values = weights.map(w => Math.floor(amount * w / total));
  const order = weights.map((w, i) => ({ i, rem: BigInt(amount) * BigInt(w) % BigInt(total) })).sort((a, b) => a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1);
  let rest = amount - values.reduce((a, b) => a + b, 0);
  for (const { i } of order) if (rest-- > 0) values[i]++;
  return values;
};
const checked = state => { validateSuiteState(state); validateSuiteState(JSON.parse(JSON.stringify(state))); return state; };
const balances = (state, expected) => { for (const [account, value] of Object.entries(expected)) assert.equal(accountBalance(state, account), value || 0, account); };
const cashStart = () => createCashState({ eligibilityConfirmed: true, expectedTurnoverCents: 50_000_000, vatPeriod: 'year', orgNumber: '559900-1236', vatNumber: 'SE559900123601', postalCode: '111 22', city: 'Demostaden', country: 'SE' });
function cashIssue({ side = 'customer', lines = [{ description: 'Arbete', netCents: 10000, vatRate: 25 }], ...extra } = {}) {
  let state = createCashDocument(cashStart(), { side, partyName: 'Granskningsmotpart AB', partyAddress: 'Granskningsgatan 7', partyPostalCode: '111 22', partyCity: 'Demostaden', partyCountry: 'SE', performance: { mode: 'invoice-date', confirmed: true }, vatExemption: lines.some(line => line.vatRate === 0) ? { code: 'property-rental', legalBasis: 'Granskad fiktiv momsfri lokalhyra enligt 10 kap. 35 § ML', confirmed: true } : undefined, reference: 'REV-2026', date: '2026-10-01', dueDate: '2026-10-31', supplyConfirmed: true, vatReason: 'Granskad svensk momsfri omsättning', lines, ...extra });
  const id = state.cashDocuments[0].id;
  state = checked(issueCashDocument(state, id));
  return { state, id };
}
const cashPay = (state, id, amountCents, reference = 'P1', date = '2026-10-10') => checked(payCashDocument(state, id, { date, amountCents, reference }));
const cashCredit = (state, id, amountCents, reference = 'C1', date = '2026-10-11') => checked(creditCashDocument(state, id, { date, amountCents, reference, reason: 'Avtalad prisnedsättning' }));
const cashRefund = (state, id, amountCents, reference = 'R1', date = '2026-10-12') => checked(refundCashDocument(state, id, { date, amountCents, reference }));
function nextYear(state) {
  const year = state.company.fiscalYearStart.slice(0, 4);
  state = fileVatPeriod(state, { from: `${year}-01-01`, to: `${year}-12-31`, date: `${year}-12-31` });
  for (let m = 1; m <= 12; m++) state = lockPeriod(state, `${year}-${String(m).padStart(2, '0')}`);
  state = closeYear(state, { date: `${year}-12-31`, confirmed: true });
  return checked(openNextYear(state, { confirmed: true }));
}
const fxBase = { side: 'customer', currency: 'EUR', number: 'FX-AUDIT', date: '2026-10-01', dueDate: '2026-10-31', partyName: 'Granskningsmotpart', partyAddress: 'Kundgatan 2', sellerName: 'Leverantören AB', sellerAddress: 'Säljgatan 1', sellerOrgNumber: '559900-1236', sellerVatNumber: 'SE559900123601', sellerPostalCode: '111 22', sellerCity: 'Demostaden', sellerCountry: 'SE', partyPostalCode: '111 22', partyCity: 'Demostaden', partyCountry: 'SE', performance: { mode: 'invoice-date', confirmed: true }, paymentReference: 'FX-AUDIT', taxTreatment: 'domestic', taxReviewed: true, rate: '11', rateSource: 'Dokumenterat granskningsunderlag', taxReason: 'Granskad svensk momsfri omsättning', lines: [{ description: 'Arbete', account: '4010', foreignNetMinor: 8000, vatRate: 25 }] };
function fxIssue(extra = {}) {
  const start = createEmptyState(); start.company.vatPeriod = 'year';
  let state = createFxDocument(start, { ...fxBase, ...extra, vatExemption: (extra.lines ?? fxBase.lines).some(line => line.vatRate === 0) ? { code: 'property-rental', legalBasis: 'Granskad fiktiv momsfri lokalhyra enligt 10 kap. 35 § ML', confirmed: true } : undefined });
  const id = state.fxDocuments[0].id;
  state = checked(issueFxDocument(state, id));
  return { state, id };
}
const fxPay = (state, id, foreignMinor, bankCents, reference = 'FX-P1', extra = {}) => checked(settleFxDocument(state, id, { date: '2026-10-10', foreignMinor, bankCents, reference, ...extra }));
const fxCredit = (state, id, amount, reference = 'FX-C1', extra = {}) => checked(creditFxDocument(state, id, { date: '2026-10-11', lines: [{ index: 0, foreignNetMinor: amount }], reference, reason: 'Retur enligt överenskommelse', rate: '11', rateSource: 'Kreditdagens kursunderlag', rateReviewed: true, ...extra }));
const vatAccount = rate => ({ 25: '2611', 12: '2621', 6: '2631' })[rate];

for (const side of ['customer', 'supplier']) for (const rate of [0, 6, 12, 25]) for (const [net, deduction] of side === 'customer' ? [[1, 10000], [101, 10000], [10719, 10000], [987654, 10000]] : [[137, 0], [29001, 3333], [19837, 5000], [110003, 10000]]) {
  scenario(`cash ${side} full payment, net ${net}, VAT ${rate}%, deduction ${deduction}`, () => {
    const vat = rounded(net, rate), deductible = rounded(vat, deduction, 10000), gross = net + vat;
    let { state, id } = cashIssue({ side, lines: [{ description: 'Granskad rad', netCents: net, vatRate: rate, account: '6540', deductibleBps: deduction }] });
    assert.equal(state.entries.length, 0);
    const original = clone(state.cashDocuments[0]);
    state = cashPay(state, id, gross);
    balances(state, { '1930': side === 'customer' ? gross : -gross, '1510': 0, '2440': 0 });
    if (side === 'customer') { balances(state, { '3000': -net }); if (rate) balances(state, { [vatAccount(rate)]: -vat }); }
    else balances(state, { '6540': gross - deductible, '2641': deductible });
    assert.equal(getCashDocumentSummary(state, id).outstandingCents, 0);
    assert.deepEqual(state.cashDocuments[0], original);
    const tax = getCashTaxRows(state).at(-1).boxes;
    assert.equal(tax[side === 'supplier' ? '48' : rate ? '05' : '42'] ?? 0, side === 'supplier' ? deductible : net);
  });
}

for (const side of ['customer', 'supplier']) for (let variant = 0; variant < 12; variant++) {
  scenario(`cash ${side} mixed-rate partial allocation ${variant + 1}`, () => {
    const lines = [
      { description: 'Material', account: '4010', netCents: 1003 + variant * 53, vatRate: [25, 12, 6][variant % 3], deductibleBps: [0, 3333, 10000][variant % 3] },
      { description: 'Tjänst', account: '6540', netCents: 2077 + variant * 79, vatRate: [6, 25, 12][variant % 3], deductibleBps: [7500, 10000, 5000][variant % 3] },
      { description: 'Momsfritt', account: '6110', netCents: 109 + variant * 11, vatRate: 0, deductibleBps: 0 },
    ];
    const gross = lines.map(l => l.netCents + rounded(l.netCents, l.vatRate)), total = gross.reduce((a, b) => a + b, 0), first = Math.floor(total * (variant + 2) / 17);
    const parts = distributed(first, gross);
    let { state, id } = cashIssue({ side, lines }); state = cashPay(state, id, first);
    const expected = {};
    lines.forEach((line, i) => {
      const vat = rounded(line.netCents, line.vatRate), input = side === 'supplier' ? rounded(vat, line.deductibleBps, 10000) : vat, recognizedVat = rounded(parts[i], input, gross[i]);
      const account = side === 'customer' ? '3000' : line.account;
      expected[account] = (expected[account] ?? 0) + (side === 'customer' ? -1 : 1) * (parts[i] - recognizedVat);
      const vatAcc = side === 'supplier' ? '2641' : vatAccount(line.vatRate);
      if (vatAcc) expected[vatAcc] = (expected[vatAcc] ?? 0) + (side === 'customer' ? -1 : 1) * recognizedVat;
    });
    balances(state, expected); assert.deepEqual(state.cashEvents[0].allocations, parts);
    state = cashPay(state, id, total - first, 'P2');
    assert.equal(getCashDocumentSummary(state, id).recognizedCents, total);
    if (side === 'customer') balances(state, { '3000': -lines.reduce((n, l) => n + l.netCents, 0) });
    else balances(state, { '2641': lines.reduce((n, l) => n + rounded(rounded(l.netCents, l.vatRate), l.deductibleBps, 10000), 0) });
  });
}

for (const side of ['customer', 'supplier']) for (const rate of [6, 12, 25]) for (const mode of ['before', 'after', 'cross', 'closing']) {
  scenario(`cash ${side} credit/refund ${mode}, VAT ${rate}%`, () => {
    const net = 10000 + rate * 40, vat = rounded(net, rate), total = net + vat, credit = Math.floor(total * 3 / 5), remaining = total - credit;
    let { state, id } = cashIssue({ side, lines: [{ description: 'Returbar prestation', netCents: net, vatRate: rate, account: '6540', deductibleBps: 5000 }] });
    if (mode === 'before') { state = cashCredit(state, id, credit); assert.equal(state.entries.length, 0); state = cashPay(state, id, remaining, 'P1', '2026-10-12'); }
    else {
      const initial = mode === 'cross' ? Math.floor(total * 4 / 5) : total;
      state = cashPay(state, id, initial); state = cashCredit(state, id, credit);
      const refundable = initial - remaining; assert.equal(getCashDocumentSummary(state, id).refundableCents, refundable);
      if (mode === 'closing') { state = checked(recognizeCashYearEnd(state, { reviewed: true })); balances(state, { [side === 'customer' ? '2490' : '1680']: side === 'customer' ? -refundable : refundable }); state = nextYear(state); state = cashRefund(state, id, refundable, 'R1', '2027-01-12'); assert.equal(getCashTaxRows(state).filter(r => r.date.startsWith('2027')).reduce((n, r) => n + Object.values(r.boxes).reduce((a, b) => a + b, 0), 0), 0); }
      else state = cashRefund(state, id, refundable);
    }
    const summary = getCashDocumentSummary(state, id);
    assert.equal(summary.paidCents, remaining); assert.equal(summary.refundableCents, 0); assert.equal(summary.outstandingCents, 0); assert.equal(summary.recognizedCents, remaining);
    balances(state, { '1930': side === 'customer' ? remaining : -remaining, '1510': 0, '2440': 0, '2490': 0, '1680': 0 });
    if (mode !== 'closing') { const tax = rounded(remaining, side === 'customer' ? vat : rounded(vat, 5000, 10000), total); balances(state, side === 'customer' ? { '3000': -(remaining - tax), [vatAccount(rate)]: -tax } : { '6540': remaining - tax, '2641': tax }); }
  });
}

for (const side of ['customer', 'supplier']) for (const rate of [0, 6, 12, 25]) for (const paid of [false, true]) {
  scenario(`cash ${side} annual carry and next-year settlement, VAT ${rate}%, partial ${paid}`, () => {
    const net = 17003 + rate * 7, total = net + rounded(net, rate), first = paid ? Math.floor(total / 3) : 0;
    let { state, id } = cashIssue({ side, lines: [{ description: 'Årsfaktura', netCents: net, vatRate: rate, account: '6110', deductibleBps: 7500 }] });
    if (first) state = cashPay(state, id, first);
    state = checked(recognizeCashYearEnd(state, { reviewed: true })); assert.equal(getCashClosingIssues(state).length, 0);
    balances(state, { [side === 'customer' ? '1510' : '2440']: (side === 'customer' ? 1 : -1) * (total - first) });
    state = nextYear(state); const oldYear = JSON.stringify(state.fiscalYears[0].snapshot);
    state = cashPay(state, id, total - first, 'NEXT', '2027-01-09');
    balances(state, { '1510': 0, '2440': 0 }); assert.equal(JSON.stringify(state.fiscalYears[0].snapshot), oldYear);
    assert.equal(getCashTaxRows(state).filter(r => r.date.startsWith('2027')).reduce((n, r) => n + Object.values(r.boxes).reduce((a, b) => a + b, 0), 0), 0);
  });
}

for (const rate of ['0.000001', '0.125', '0,5', '1.00000001', '1.23456789', '7.335', '10.50000000', '11,12345678', '12', '999.99999999', '999999.99', '0.00000001']) for (const amount of [101, 987654]) {
  scenario(`FX exact rational conversion ${rate} on ${amount} minor units`, () => {
    const parsed = parseFxRate(rate, { date: '2026-10-01', source: 'Kursunderlag' });
    const [n, d] = rateRatio(rate); assert.equal(BigInt(parsed.numerator) * d, BigInt(parsed.denominator) * n);
    assert.equal(convertFxMinor(amount, parsed), converted(amount, rate)); assert.equal(convertFxMinor(-amount, parsed), -converted(amount, rate) || 0);
    const input = { rate, lines: [{ description: 'Rationell omräkning', foreignNetMinor: amount, vatRate: 25, account: '4010' }] };
    const expectedNet = converted(amount, rate), expectedVat = converted(rounded(amount, 25), rate);
    if (expectedNet + expectedVat === 0) { assert.throws(() => fxIssue(input), /för litet/); checked(createEmptyState()); }
    else if (expectedNet + expectedVat > 1_000_000_000_000) { assert.throws(() => fxIssue(input), /för stort/); checked(createEmptyState()); }
    else { const { state } = fxIssue(input); balances(state, { '1510': expectedNet + expectedVat, '3000': -expectedNet, '2611': -expectedVat }); }
  });
}

for (const side of ['customer', 'supplier']) for (const currency of ['EUR', 'USD']) for (const rate of ['0.875', '7.335', '11.12345678', '12.5']) for (const fee of [0, 137]) {
  scenario(`FX ${side} ${currency} partial/final at ${rate}, fee ${fee}`, () => {
    const net = 9001, vat = rounded(net, 25), foreign = net + vat, gross = converted(net, rate) + converted(vat, rate), first = Math.floor(foreign * 2 / 7), carried = rounded(gross, first, foreign), sign = side === 'customer' ? 1 : -1;
    let { state, id } = fxIssue({ side, currency, rate, lines: [{ description: 'Delbetalning', foreignNetMinor: net, vatRate: 25, account: '6540' }] });
    const original = clone(state.fxDocuments[0]), firstBank = carried + 239;
    state = fxPay(state, id, first, firstBank, 'FX-P1', { feeCents: fee });
    assert.equal(getFxPosition(state, id).carryingCents, gross - carried);
    const finalBank = gross - carried - 113;
    state = fxPay(state, id, foreign - first, finalBank, 'FX-P2');
    assert.equal(getFxPosition(state, id).foreignBalanceMinor, 0); assert.equal(getFxPosition(state, id).carryingCents, 0);
    balances(state, { '1930': sign * (firstBank + finalBank), '6570': fee, '1510': 0, '2440': 0 });
    const firstDifference = sign * (firstBank - carried) + fee, secondDifference = sign * (finalBank - (gross - carried));
    balances(state, { '3960': -Math.max(0, firstDifference) - Math.max(0, secondDifference), '7960': Math.max(0, -firstDifference) + Math.max(0, -secondDifference) });
    assert.equal(getFxTaxRows(state).reduce((n, r) => n + r.vatCents, 0), converted(vat, rate)); assert.deepEqual(state.fxDocuments[0], original);
  });
}

for (const side of ['customer', 'supplier']) for (const rate of ['1.125', '10.33333333', '12.75']) for (const mode of ['unpaid', 'paid', 'cross', 'successive']) {
  scenario(`FX ${side} ${mode} credits preserve original VAT at ${rate}`, () => {
    const net = 8000, foreign = 10000, initial = converted(net, rate) + converted(2000, rate), sign = side === 'customer' ? 1 : -1;
    let { state, id } = fxIssue({ side, rate });
    if (mode !== 'unpaid') state = fxPay(state, id, mode === 'cross' ? 7500 : foreign, mode === 'cross' ? rounded(initial, 3, 4) : initial);
    if (mode === 'successive') { state = fxCredit(state, id, 1600, 'C-A', { rate: '9.25' }); state = fxCredit(state, id, 2400, 'C-B', { rate: '12.125' }); }
    else state = fxCredit(state, id, 4000, 'C-A', { rate: '9.25' });
    const pos = getFxPosition(state, id);
    assert.equal(pos.foreignBalanceMinor, mode === 'unpaid' ? 5000 : mode === 'cross' ? -2500 : -5000);
    const expectedCarry = mode === 'unpaid' ? initial - rounded(initial, 1, 2) : mode === 'successive' ? -(converted(2000, '9.25') + converted(3000, '12.125')) : -converted(mode === 'cross' ? 2500 : 5000, '9.25');
    assert.equal(pos.carryingCents, expectedCarry);
    assert.equal(getFxTaxRows(state).reduce((n, r) => n + r.vatCents, 0), converted(2000, rate) - rounded(converted(2000, rate), 1, 2));
    const bank = Math.abs(expectedCarry) + 67;
    state = fxPay(state, id, Math.abs(pos.foreignBalanceMinor), bank, 'SETTLE', { date: '2026-10-12', refund: mode !== 'unpaid', feeCents: 13 });
    balances(state, { '1510': 0, '2440': 0, '6570': 13 }); assert.equal(getFxPosition(state, id).foreignBalanceMinor, 0);
    assert.equal(state.bankTransactions.at(-1).amountCents, sign * (mode === 'unpaid' ? 1 : -1) * bank);
  });
}

for (const side of ['customer', 'supplier']) for (const finalRate of ['9.75', '11', '13.125']) for (const refund of [false, true]) {
  scenario(`FX ${side} annual ${refund ? 'credit' : 'debit'} carry at ${finalRate}`, () => {
    let { state, id } = fxIssue({ side });
    if (refund) { state = fxPay(state, id, 10000, 110000); state = fxCredit(state, id, 4000); }
    const foreign = refund ? -5000 : 10000, carrying = converted(foreign, finalRate), vatBefore = getFxTaxRows(state).reduce((n, r) => n + r.vatCents, 0);
    state = checked(revalueFxDocument(state, id, { date: '2026-12-31', rate: finalRate, rateSource: 'Balansdagens dokumenterade kurs', reviewed: true, reference: 'YEAR-VALUE' }));
    assert.equal(getFxClosingIssues(state).length, 0); assert.equal(getFxPosition(state, id).carryingCents, carrying);
    state = nextYear(state); const snapshot = JSON.stringify(state.fiscalYears[0].snapshot);
    state = fxPay(state, id, Math.abs(foreign), Math.abs(carrying) + 175, 'NEXT', { date: '2027-01-08', refund, feeCents: 25 });
    assert.equal(getFxPosition(state, id).carryingCents, 0); assert.equal(JSON.stringify(state.fiscalYears[0].snapshot), snapshot);
    assert.equal(getFxTaxRows(state).reduce((n, r) => n + r.vatCents, 0), vatBefore); assert.equal(getFxTaxRows(state).filter(r => r.date.startsWith('2027')).length, 0);
  });
}

for (const side of ['customer', 'supplier']) for (const [net, rate] of [[1, 0], [100, 25], [101, 6], [99, 12]]) for (const deduction of side === 'customer' ? [10000] : [0, 5000, 10000]) {
  scenario(`cash zero-net closing allocation after paid credit, ${side}, net ${net}, VAT ${rate}, deduction ${deduction}`, () => {
    const gross = net + rounded(net, rate);
    let { state, id } = cashIssue({ side, lines: ['A', 'B'].map(description => ({ description, netCents: net, vatRate: rate, account: '6540', deductibleBps: deduction })) });
    state = cashPay(state, id, gross); state = cashCredit(state, id, gross);
    const summary = getCashDocumentSummary(state, id);
    assert.equal(summary.outstandingCents, 0); assert.equal(summary.refundableCents, 0); assert.equal(summary.unrecognizedCents, 0);
    assert.equal(summary.recognitionNeeded, true);
    const entries = JSON.stringify(state.entries), taxes = JSON.stringify(getCashTaxRows(state));
    state = checked(recognizeCashYearEnd(state, { reviewed: true }));
    assert.equal(getCashClosingIssues(state).length, 0); assert.equal(getCashDocumentSummary(state, id).recognitionNeeded, false);
    assert.equal(JSON.stringify(state.entries), entries); assert.equal(JSON.stringify(getCashTaxRows(state)), taxes);
    assert.equal(state.cashEvents.at(-1).kind, 'year-end'); assert.equal(state.cashEvents.at(-1).entryId, undefined);
    state = nextYear(state); assert.equal(getCashClosingIssues(state).length, 0);
    const secondCredit = Math.ceil(gross / 2), effective = [Math.floor(gross / 2), Math.ceil(gross / 2)], parts = distributed(secondCredit, effective);
    const taxPerLine = side === 'supplier' ? rounded(rounded(net, rate), deduction, 10000) : rounded(net, rate);
    const vatBefore = effective.reduce((n, value) => n + rounded(value, taxPerLine, gross), 0);
    const vatAfter = effective.reduce((n, value, i) => n + rounded(value - parts[i], taxPerLine, gross), 0);
    state = cashCredit(state, id, secondCredit, 'C-NEXT', '2027-01-10');
    state = cashRefund(state, id, secondCredit, 'R-NEXT', '2027-01-11');
    const nextTax = getCashTaxRows(state).filter(row => row.date.startsWith('2027')).reduce((n, row) => n + (row.boxes[side === 'supplier' ? '48' : ({ 25: '10', 12: '11', 6: '12' })[rate]] ?? 0), 0);
    assert.equal(nextTax, vatAfter - vatBefore);
    balances(state, { '1930': (side === 'customer' ? 1 : -1) * (gross - secondCredit), '1510': 0, '2440': 0, '2490': 0, '1680': 0 });
  });
}

const cashGuards = [
  ['overpayment', (s, id) => payCashDocument(s, id, { date: '2026-10-12', amountCents: 7501, reference: 'OVER' })],
  ['duplicate reference', (s, id) => payCashDocument(s, id, { date: '2026-10-12', amountCents: 1, reference: 'P1' })],
  ['zero payment', (s, id) => payCashDocument(s, id, { date: '2026-10-12', amountCents: 0, reference: 'ZERO' })],
  ['fractional payment', (s, id) => payCashDocument(s, id, { date: '2026-10-12', amountCents: 1.5, reference: 'FRACTION' })],
  ['before prior event', (s, id) => payCashDocument(s, id, { date: '2026-10-09', amountCents: 1, reference: 'OLD' })],
  ['outside fiscal year', (s, id) => payCashDocument(s, id, { date: '2027-01-01', amountCents: 1, reference: 'FUTURE' })],
  ['refund without credit', (s, id) => refundCashDocument(s, id, { date: '2026-10-12', amountCents: 1, reference: 'REFUND' })],
  ['credit beyond invoice', (s, id) => creditCashDocument(s, id, { date: '2026-10-12', amountCents: 12501, reference: 'CREDIT', reason: 'Retur' })],
  ['credit without reason', (s, id) => creditCashDocument(s, id, { date: '2026-10-12', amountCents: 1, reference: 'CREDIT', reason: '' })],
  ['year-end without review', s => recognizeCashYearEnd(s, { reviewed: false })],
  ['deletion of original', (s, id) => deleteCashDraft(s, id)],
  ['wrong bank match', (s, id) => payCashDocument(s, id, { date: '2026-10-12', amountCents: 1, reference: 'BANK', bankEventId: s.bankTransactions[0].id })],
];
for (const side of ['customer', 'supplier']) for (const [name, invalid] of cashGuards) {
  scenario(`cash ${side} rejects ${name} atomically after partial payment`, () => {
    let { state, id } = cashIssue({ side }); state = cashPay(state, id, 5000);
    const before = JSON.stringify(state); assert.throws(() => invalid(state, id)); assert.equal(JSON.stringify(state), before); checked(state);
  });
}

const cashTampering = [
  ['original value', s => s.cashDocuments[0].lines[0].netCents++],
  ['original address', s => s.cashDocuments[0].partyAddress = 'Utbytt adress'],
  ['seller identity', s => s.cashDocuments[0].companyDetails.orgNumber = 'UTBYTT'],
  ['event amount', s => s.cashEvents[0].amountCents++],
  ['event allocation', s => s.cashEvents[0].allocations[0]++],
  ['event date', s => s.cashEvents[0].date = '2026-10-09'],
  ['event rows', s => s.cashEvents[0].rows[0].debitCents++],
  ['bank value', s => s.bankTransactions[0].amountCents++],
  ['bank account', s => s.bankTransactions[0].account = '1910'],
  ['bank removal', s => s.bankTransactions.splice(0)],
  ['journal source', s => s.entries[0].sourceId = 'WRONG'],
  ['journal removal', s => s.entries.splice(0)],
];
for (const [name, mutate] of cashTampering) scenario(`cash restored state rejects tampered ${name}`, () => {
  let { state, id } = cashIssue(); state = cashPay(state, id, 7777);
  const bad = clone(state); mutate(bad); assert.throws(() => validateSuiteState(bad)); checked(state);
});

const fxGuards = [
  ['overpayment', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 7001, bankCents: 77011, reference: 'OVER' })],
  ['duplicate reference', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 1, bankCents: 11, reference: 'FX-P1' })],
  ['zero foreign payment', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 0, bankCents: 11, reference: 'ZERO' })],
  ['zero bank payment', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 1, bankCents: 0, reference: 'ZERO' })],
  ['negative fee', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 1, bankCents: 11, feeCents: -1, reference: 'FEE' })],
  ['before prior event', (s, id) => settleFxDocument(s, id, { date: '2026-10-09', foreignMinor: 1, bankCents: 11, reference: 'OLD' })],
  ['refund without credit', (s, id) => settleFxDocument(s, id, { date: '2026-10-12', foreignMinor: 1, bankCents: 11, refund: true, reference: 'REFUND' })],
  ['credit beyond original', (s, id) => creditFxDocument(s, id, { date: '2026-10-12', lines: [{ index: 0, foreignNetMinor: 8001 }], reference: 'C', reason: 'Retur' })],
  ['duplicate credit selection', (s, id) => creditFxDocument(s, id, { date: '2026-10-12', lines: [{ index: 0, foreignNetMinor: 1 }, { index: 0, foreignNetMinor: 1 }], reference: 'C', reason: 'Retur' })],
  ['missing credit-day rate', (s, id) => creditFxDocument(s, id, { date: '2026-10-12', lines: [{ index: 0, foreignNetMinor: 8000 }], reference: 'C', reason: 'Retur' })],
  ['unreviewed valuation', (s, id) => revalueFxDocument(s, id, { date: '2026-12-31', rate: '12', rateSource: 'Källa', reviewed: false, reference: 'V' })],
  ['valuation outside closing date', (s, id) => revalueFxDocument(s, id, { date: '2026-12-30', rate: '12', rateSource: 'Källa', reviewed: true, reference: 'V' })],
];
for (const side of ['customer', 'supplier']) for (const [name, invalid] of fxGuards) {
  scenario(`FX ${side} rejects ${name} atomically after partial payment`, () => {
    let { state, id } = fxIssue({ side }); state = fxPay(state, id, 3000, 33000);
    const before = JSON.stringify(state); assert.throws(() => invalid(state, id)); assert.equal(JSON.stringify(state), before); checked(state);
  });
}

const fxTampering = [
  ['original currency', s => s.fxDocuments[0].currency = 'USD'],
  ['original rate', s => s.fxDocuments[0].rate.numerator++],
  ['original SEK total', s => s.fxDocuments[0].grossCents++],
  ['original foreign total', s => s.fxDocuments[0].foreignGrossMinor++],
  ['original supplier name', s => s.fxDocuments[0].sellerName = 'Utbytt säljare'],
  ['payment amount', s => s.fxEvents[1].foreignMinor++],
  ['payment fee', s => s.fxEvents[1].feeCents++],
  ['event reference', s => s.fxEvents[1].reference = 'UTBYTT'],
  ['event date', s => s.fxEvents[1].date = '2026-10-09'],
  ['bank value', s => s.bankTransactions[0].amountCents++],
  ['bank removal', s => s.bankTransactions.splice(0)],
  ['journal source', s => s.entries[1].sourceId = 'WRONG'],
];
for (const [name, mutate] of fxTampering) scenario(`FX restored state rejects tampered ${name}`, () => {
  let { state, id } = fxIssue(); state = fxPay(state, id, 3700, 40700);
  const bad = clone(state); mutate(bad); assert.throws(() => validateSuiteState(bad)); checked(state);
});

for (const engine of ['cash', 'fx']) for (const side of ['customer', 'supplier']) for (const lock of ['month', 'vat']) {
  scenario(`${engine} ${side} respects ${lock} lock and preserves filed VAT`, () => {
    let { state, id } = engine === 'cash' ? cashIssue({ side }) : fxIssue({ side });
    if (lock === 'month') state = checked(lockPeriod(state, '2026-10'));
    else state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
    const old = JSON.stringify(state);
    if (engine === 'fx' && lock === 'vat') {
      const vat = JSON.stringify(state.vatReturns), tax = JSON.stringify(getFxTaxRows(state));
      state = fxPay(state, id, 500, 5500);
      assert.equal(JSON.stringify(state.vatReturns), vat); assert.equal(JSON.stringify(getFxTaxRows(state)), tax);
      assert.equal(getFxPosition(state, id).foreignBalanceMinor, 9500);
    } else {
      assert.throws(() => engine === 'cash' ? cashPay(state, id, 500) : fxPay(state, id, 500, 5500), /låst|momsperiod|fastställ/);
      assert.equal(JSON.stringify(state), old); checked(state);
    }
  });
}

for (const rates of [[25, 0], [0, 25], [12, 0], [0, 6]]) scenario(`cash zero-net closing reclassifies taxable/exempt base ${rates.join('/')}`, () => {
  let { state, id } = cashIssue({ lines: rates.map((vatRate, index) => ({ description: `Del ${index}`, netCents: 1, vatRate })) });
  state = cashPay(state, id, 1); state = cashCredit(state, id, 1);
  const before = getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(before.boxes[rates[0] ? '05' : '42'], 1);
  const entryCount = state.entries.length;
  state = checked(recognizeCashYearEnd(state, { reviewed: true }));
  const after = getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(state.entries.length, entryCount); assert.equal(after.boxes[rates[1] ? '05' : '42'], 1); assert.equal(after.boxes[rates[0] ? '05' : '42'], 0); assert.equal(after.reconciled, true);
  const adjustment = getCashTaxRows(state).at(-1); assert.equal(adjustment.entryId, null); assert.equal(adjustment.date, '2026-12-31');
  state = nextYear(state); assert.equal(getCashClosingIssues(state).length, 0);
});

for (const rate of [0, 6, 12, 25]) scenario(`cash rejects base-only VAT ${rate}% payment in filed period`, () => {
  let { state, id } = cashIssue({ lines: [{ description: 'Öresbelopp', netCents: 1, vatRate: rate }] });
  state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
  const original = JSON.stringify(state); assert.throws(() => cashPay(state, id, 1), /Momsperioden är redan fastställd/); assert.equal(JSON.stringify(state), original); checked(state);
});

for (const rates of [[25, 0], [0, 6]]) scenario(`cash rejects journal-free VAT reclassification ${rates.join('/')} in filed period`, () => {
  let { state, id } = cashIssue({ lines: rates.map((vatRate, i) => ({ description: `Öresrad ${i}`, netCents: 1, vatRate })) });
  state = cashPay(state, id, 1); state = cashCredit(state, id, 1);
  state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
  const original = JSON.stringify(state); assert.throws(() => recognizeCashYearEnd(state, { reviewed: true }), /Momsperioden är redan fastställd/); assert.equal(JSON.stringify(state), original); checked(state);
});

for (const side of ['customer', 'supplier']) scenario(`cash ${side} permits carried settlement after filing without changing tax`, () => {
  let { state, id } = cashIssue({ side }); state = checked(recognizeCashYearEnd(state, { reviewed: true }));
  state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
  const report = JSON.stringify(getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' }).boxes);
  state = cashPay(state, id, 12500, 'PAY-AFTER-FILING', '2026-12-31');
  assert.equal(getCashDocumentSummary(state, id).outstandingCents, 0); assert.equal(JSON.stringify(getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' }).boxes), report);
  balances(state, { '1510': 0, '2440': 0 });
});

for (const kind of ['no-vat', 'rounded-zero']) for (const operation of ['issue', 'credit']) scenario(`FX customer ${kind} ${operation} cannot change a filed VAT base`, () => {
  const input = { ...fxBase, vatExemption: kind === 'no-vat' ? { code: 'property-rental', legalBasis: 'Granskad fiktiv momsfri lokalhyra enligt 10 kap. 35 § ML', confirmed: true } : undefined, taxTreatment: kind === 'no-vat' ? 'no-vat' : 'domestic', lines: [{ description: 'Momsbas med noll skatt', foreignNetMinor: kind === 'no-vat' ? 101 : 1, vatRate: kind === 'no-vat' ? 0 : 25, account: '4010' }] };
  const start = createEmptyState(); start.company.vatPeriod = 'year';
  let state = createFxDocument(start, input), id = state.fxDocuments[0].id;
  if (operation === 'credit') state = checked(issueFxDocument(state, id));
  state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
  const before = JSON.stringify(state);
  assert.throws(() => operation === 'issue' ? issueFxDocument(state, id) : creditFxDocument(state, id, { date: '2026-10-12', lines: [{ index: 0, foreignNetMinor: 1 }], reason: 'Prisjustering', reference: 'C-FILED' }), /Momsperioden är redan fastställd/);
  assert.equal(JSON.stringify(state), before); checked(state);
});

for (const operation of ['issue', 'credit']) scenario(`FX tax-free supplier ${operation} preserves filed VAT and remains allowed`, () => {
  const start = createEmptyState(); start.company.vatPeriod = 'year';
  let state = createFxDocument(start, { ...fxBase, side: 'supplier', taxTreatment: 'no-vat', lines: [{ description: 'Granskat momsfritt inköp', foreignNetMinor: 101, vatRate: 0, account: '6540' }] }), id = state.fxDocuments[0].id;
  if (operation === 'credit') state = checked(issueFxDocument(state, id));
  state = checked(fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' }));
  const before = JSON.stringify(state.vatReturns), boxes = JSON.stringify(getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' }).boxes);
  state = operation === 'issue' ? checked(issueFxDocument(state, id)) : checked(creditFxDocument(state, id, { date: '2026-10-12', lines: [{ index: 0, foreignNetMinor: 1 }], reason: 'Prisjustering', reference: 'C-FILED' }));
  assert.equal(JSON.stringify(state.vatReturns), before); assert.equal(JSON.stringify(getTaxDeclarationReport(state, { from: '2026-01-01', to: '2026-12-31' }).boxes), boxes);
});
