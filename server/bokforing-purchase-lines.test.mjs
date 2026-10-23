import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyState } from '../public/bokforing/suite/core.js';
import { createBill, bookBill, updateBillDraft, getBillBookingRows, getBillLineBookingRows, getBillOutstanding, validateBillFinancials, copyBillPayload, creditBill, payBill } from '../public/bokforing/suite/operations.js';
import { billSnapshot } from '../public/bokforing/suite/purchase-data.js';
import { calculatePurchaseLines, normalizePurchaseLines } from '../public/bokforing/suite/purchase-lines.js';
import { createCreditNote, offsetCredit } from '../public/bokforing/suite/settlements.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const line = extra => ({ description: 'Material', account: '4010', netCents: 10000, vatMode: 'standard', vatRate: 25, deductibleBps: 10000, ...extra });
const payload = lines => ({ supplier: 'Fiktiv leverantör AB', number: 'MULTI-1', date: '2026-10-23', dueDate: '2026-11-22', lines });
const last = state => state.bills.at(-1);
const mixed = () => [line(), line({ account: '6540', vatRate: 12, deductibleBps: 5000 }), line({ account: '5010', netCents: 5000, vatMode: 'no-vat', vatRate: 0 }), line({ account: '4425', netCents: 20000, vatMode: 'reverse-construction', reverseConfirmed: true, deductibleBps: 5000 })];
const sum = (rows, account) => rows.filter(row => row.account === account).reduce((total, row) => total + row.debitCents - row.creditCents, 0);

test('supplier lines combine rates, tax-free and reverse VAT with individually limited deduction', () => {
  const result = calculatePurchaseLines(mixed());
  assert.equal(result.netCents, 45000); assert.equal(result.vatCents, 3700); assert.equal(result.totalCents, 48700);
  assert.equal(result.deductibleVatCents, 5600); assert.equal(result.nonDeductibleVatCents, 3100);
  assert.equal(sum(result.rows, '2641'), 3100); assert.equal(sum(result.rows, '2647'), 2500); assert.equal(sum(result.rows, '2614'), -5000);
  assert.equal(sum(result.rows, '6540'), 10600); assert.equal(sum(result.rows, '4425'), 22500); assert.equal(sum(result.rows, '2440'), -48700);
  assert.equal(result.rows.reduce((total, row) => total + row.debitCents - row.creditCents, 0), 0);
});

test('multi-line invoice persists, posts preview unchanged, restores and accepts partial payment', () => {
  const original = createEmptyState(), input = payload(mixed()), inputCopy = structuredClone(input);
  const pending = createBill(original, input), pendingCopy = structuredClone(pending), preview = getBillBookingRows(last(pending));
  assert.equal(original.bills.length, 0); assert.deepEqual(input, inputCopy);
  const booked = bookBill(pending, last(pending).id);
  assert.deepEqual(pending, pendingCopy); assert.deepEqual(booked.entries[0].rows, preview);
  const restored = JSON.parse(JSON.stringify(booked)); validateSuiteState(restored);
  const paid = payBill(restored, last(restored).id, { date: '2026-10-24', amountCents: 10000 });
  validateSuiteState(paid); assert.equal(last(paid).payments[0].amountCents, 10000);
  assert.equal(last(paid).bookingSnapshot, billSnapshot(last(booked)));
});

test('reverse VAT requires each reverse row reviewed and rolls back a failed booking', () => {
  const pending = createBill(createEmptyState(), payload([line({ account: '4425', vatMode: 'reverse-construction' })]));
  const before = structuredClone(pending);
  assert.throws(() => bookBill(pending, last(pending).id), /Bekräfta/); assert.deepEqual(pending, before);
  const reviewed = updateBillDraft(pending, last(pending).id, { lines: [line({ account: '4425', vatMode: 'reverse-construction', reverseConfirmed: true })] });
  validateSuiteState(bookBill(reviewed, last(reviewed).id));
});

test('zero VAT deduction expenses all invoice VAT and still pays the supplier gross amount', () => {
  const result = calculatePurchaseLines([line({ deductibleBps: 0 })]);
  assert.deepEqual(result.rows, [{ account: '4010', debitCents: 12500, creditCents: 0 }, { account: '2440', debitCents: 0, creditCents: 12500 }]);
});

test('line VAT and deduction round to whole cents deterministically', () => {
  const result = calculatePurchaseLines([line({ netCents: 3, deductibleBps: 5000 }), line({ netCents: 3, deductibleBps: 5000 })]);
  assert.equal(result.vatCents, 2); assert.equal(result.totalCents, 8); assert.equal(result.deductibleVatCents, 2);
  assert.equal(result.rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0), 0);
});

test('invalid line tax, accounts, rates, arithmetic and empty invoice are rejected', () => {
  const bad = [[], [line({ netCents: 0 })], [line({ netCents: 1.5 })], [line({ account: '1930' })], [line({ vatMode: 'eu-import' })], [line({ vatRate: 21 })], [line({ vatMode: 'no-vat', vatRate: 25 })], [line({ vatMode: 'reverse-construction', account: '4010' })], [line({ deductibleBps: 10001 })], [line({ deductibleBps: -1 })], [line({ deductibleBps: 33.3 })], [line({ reverseConfirmed: 'yes' })], Array.from({ length: 101 }, () => line())];
  for (const lines of bad) assert.throws(() => createBill(createEmptyState(), payload(lines)));
});

test('line project must exist and edits keep prior state immutable', () => {
  const initial = createEmptyState();
  assert.throws(() => createBill(initial, payload([line({ projectId: 'missing-project' })])), /projekt/);
  const state = createBill(initial, payload([line()])), before = structuredClone(state);
  const edited = updateBillDraft(state, last(state).id, { lines: [line(), line({ account: '6110', netCents: 2000, vatRate: 6 })] });
  assert.deepEqual(state, before); assert.equal(last(edited).totalCents, 14620); validateSuiteState(edited);
});

test('booked line edits and cached aggregate edits are detected after restoration', () => {
  const pending = createBill(createEmptyState(), payload(mixed())), state = bookBill(pending, last(pending).id);
  const changed = structuredClone(state); last(changed).lines[0].account = '6110';
  assert.throws(() => validateSuiteState(changed));
  assert.throws(() => payBill(changed, last(changed).id, { date: '2026-10-24', amountCents: 1 }), /får inte ändras/);
  const totals = structuredClone(last(state)); totals.netCents++;
  assert.throws(() => validateBillFinancials(totals), /konteringsraderna/);
});

test('copying preserves independent line allocations but resets reverse review and attachments', () => {
  const pending = createBill(createEmptyState(), payload(mixed())), state = bookBill(pending, last(pending).id), before = structuredClone(state);
  const copy = copyBillPayload(last(state));
  assert.equal(copy.number, ''); assert.equal(copy.lines[3].reverseConfirmed, false); assert.deepEqual(copy.attachments, []);
  copy.lines[0].netCents = 123; assert.deepEqual(state, before);
});

test('a whole legacy-style credit reverses every mixed line and supports line-wise credit allocation', () => {
  const pending = createBill(createEmptyState(), payload(mixed())), state = bookBill(pending, last(pending).id);
  assert.deepEqual(getBillLineBookingRows(last(state), 0), calculatePurchaseLines([mixed()[0]]).rows);
  assert.throws(() => getBillLineBookingRows(last(state), 4));
  const credited = creditBill(state, last(state).id, { date: '2026-10-24', reason: 'Felaktig faktura' });
  validateSuiteState(credited);
  for (const account of ['4010', '6540', '5010', '4425', '2641', '2647', '2614', '2440']) assert.equal(credited.entries.flatMap(entry => entry.rows).filter(row => row.account === account).reduce((total, row) => total + row.debitCents - row.creditCents, 0), 0);
});

test('normalization returns independent lines and rejects control characters', () => {
  const input = mixed(), normalized = normalizePurchaseLines(input);
  normalized[0].netCents = 1; assert.equal(input[0].netCents, 10000);
  assert.throws(() => normalizePurchaseLines([line({ description: 'Bad\u0000line' })]));
});


test('supplier offsets reduce the amount payable in the ordinary payment flow', () => {
  let state = createBill(createEmptyState(), payload([line()]));
  const sourceId = last(state).id; state = bookBill(state, sourceId);
  state = payBill(state, sourceId, { date: '2026-10-24', amountCents: 12500 });
  state = createCreditNote(state, { side: 'supplier', documentId: sourceId, date: '2026-10-25', reason: 'Prisjustering', reference: 'CREDIT-5000', lines: [{ index: 0, netCents: 4000 }] });
  state = createBill(state, { ...payload([line()]), number: 'MULTI-2' });
  const targetId = last(state).id; state = bookBill(state, targetId);
  state = offsetCredit(state, { side: 'supplier', documentId: sourceId, targetDocumentId: targetId, date: '2026-10-26', amountCents: 5000, reference: 'OFFSET-5000' });
  validateSuiteState(state);
  assert.equal(getBillOutstanding(last(state)), 7500);
  assert.throws(() => payBill(state, targetId, { date: '2026-10-27', amountCents: 7501 }), /överstiger/);
  state = payBill(state, targetId, { date: '2026-10-27', amountCents: 7500 });
  assert.equal(getBillOutstanding(last(state)), 0); validateSuiteState(state);
});
