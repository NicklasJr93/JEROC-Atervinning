import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, transact, appendEntry, accountBalance } from '../public/bokforing/suite/core.js';
import { createBill, bookBill, payBill, creditBill, getBillOutstanding, createBankEvent,
  matchBankEvent, bookBankEvent, postManualEntry, correctEntry } from '../public/bokforing/suite/operations.js';
import { createAsset } from '../public/bokforing/suite/finance.js';
import { createAccrual } from '../public/bokforing/suite/periodization.js';
import { createStockItem, recordStockMovement, postStockValuation } from '../public/bokforing/suite/inventory.js';

const billInput = (overrides = {}) => ({ supplier: 'Bygghandel Demo AB', number: 'L-100', date: '2026-10-02', dueDate: '2026-11-01', netCents: 1_000_000,
  vatRate: 25, account: '4010', vatMode: 'standard', ...overrides });
const newBill = (overrides = {}) => createBill(createEmptyState(), billInput(overrides));
const bookedBill = (overrides = {}) => { const state = newBill(overrides); return bookBill(state, state.bills[0].id); };
const assertBalanced = state => state.entries.forEach(entry => assert.equal(entry.rows.reduce((n, row) => n + row.debitCents - row.creditCents, 0), 0));
const bankInput = (overrides = {}) => ({ date: '2026-10-10', description: 'Fiktiv händelse', amountCents: -15_000, ...overrides });

test('supplier bill posts only once, balances and leaves its draft input unchanged', () => {
  const draft = newBill();
  const before = structuredClone(draft);
  const state = bookBill(draft, draft.bills[0].id);
  assert.deepEqual(draft, before);
  assert.equal(state.bills[0].status, 'booked');
  assert.equal(accountBalance(state, '4010'), 1_000_000);
  assert.equal(accountBalance(state, '2641'), 250_000);
  assert.equal(accountBalance(state, '2440'), -1_250_000);
  assert.equal(getBillOutstanding(state.bills[0]), 1_250_000);
  assertBalanced(state);
  assert.throws(() => bookBill(state, state.bills[0].id), /redan bokförd/);
});

test('case-insensitive duplicate supplier reference and invalid dates or cents are rejected', () => {
  const state = newBill();
  assert.throws(() => createBill(state, billInput({ supplier: 'bygghandel demo ab', number: 'l-100' })), /finns redan/);
  assert.throws(() => newBill({ date: '2026-02-29' }), /datum/);
  assert.throws(() => newBill({ dueDate: '2026-10-01' }), /Förfallodagen/);
  assert.throws(() => newBill({ netCents: 100.5 }));
  assert.throws(() => newBill({ netCents: -1 }));
  assert.throws(() => newBill({ account: '1930' }), /kostnadskonto/);
});

test('no VAT and reduced VAT round deterministically in whole cents', () => {
  const noVat = bookedBill({ vatMode: 'no-vat', vatRate: 25 });
  assert.equal(noVat.bills[0].vatCents, 0);
  assert.equal(noVat.bills[0].totalCents, 1_000_000);
  assert.equal(accountBalance(noVat, '2641'), 0);
  const reduced = bookedBill({ vatRate: 6, netCents: 125 });
  assert.equal(reduced.bills[0].vatCents, 8);
  assert.equal(reduced.bills[0].totalCents, 133);
  assertBalanced(reduced);
});

test('reverse construction VAT requires a separate confirmation and two mirrored VAT rows', () => {
  const unconfirmed = newBill({ vatMode: 'reverse-construction' });
  assert.throws(() => bookBill(unconfirmed, unconfirmed.bills[0].id), /Bekräfta/);
  assert.equal(unconfirmed.entries.length, 0);
  const state = bookedBill({ vatMode: 'reverse-construction', reverseConfirmed: true });
  assert.equal(state.bills[0].totalCents, 1_000_000);
  assert.equal(accountBalance(state, '4425'), 1_000_000);
  assert.equal(accountBalance(state, '2647'), 250_000);
  assert.equal(accountBalance(state, '2614'), -250_000);
  assert.equal(accountBalance(state, '2440'), -1_000_000);
  assertBalanced(state);
});

test('partial and final supplier payments reduce debt and have matched bank events', () => {
  let state = bookedBill();
  const id = state.bills[0].id;
  state = payBill(state, id, { date: '2026-10-10', amountCents: 400_000 });
  assert.equal(getBillOutstanding(state.bills[0]), 850_000);
  assert.equal(state.bankTransactions[0].amountCents, -400_000);
  assert.equal(state.bankTransactions[0].matchedEntryId, state.bills[0].payments[0].entryId);
  const before = structuredClone(state);
  assert.throws(() => payBill(state, id, { date: '2026-10-11', amountCents: 850_001 }), /överstiger/);
  assert.deepEqual(state, before);
  state = payBill(state, id, { date: '2026-10-11', amountCents: 850_000 });
  assert.equal(getBillOutstanding(state.bills[0]), 0);
  assert.equal(accountBalance(state, '2440'), 0);
  assert.equal(accountBalance(state, '1930'), -1_250_000);
  assert.throws(() => payBill(state, id, { date: '2026-10-12', amountCents: 1 }), /överstiger/);
  assertBalanced(state);
});

test('a payment cannot precede invoice date or pay an unbooked draft', () => {
  const draft = newBill();
  assert.throws(() => payBill(draft, draft.bills[0].id, { date: '2026-10-03', amountCents: 1 }), /Bokför/);
  const state = bookedBill();
  assert.throws(() => payBill(state, state.bills[0].id, { date: '2026-10-01', amountCents: 1 }), /före fakturadagen/);
});

test('credit keeps original journal and creates a linked reversal; a paid bill cannot be fully credited', () => {
  const original = bookedBill();
  const originalEntry = structuredClone(original.entries[0]);
  const credited = creditBill(original, original.bills[0].id, { date: '2026-10-03', reason: 'Felaktigt underlag' });
  assert.deepEqual(credited.entries[0], originalEntry);
  assert.equal(credited.entries[1].correctsEntryId, originalEntry.id);
  assert.equal(credited.bills[0].status, 'credited');
  assert.equal(getBillOutstanding(credited.bills[0]), 0);
  assert.equal(accountBalance(credited, '2440'), 0);
  assert.equal(accountBalance(credited, '2641'), 0);
  assertBalanced(credited);
  assert.throws(() => creditBill(credited, credited.bills[0].id, { date: '2026-10-04', reason: 'Igen' }), /bokförd/);
  const paid = payBill(original, original.bills[0].id, { date: '2026-10-03', amountCents: 1 });
  assert.throws(() => creditBill(paid, paid.bills[0].id, { date: '2026-10-04', reason: 'Test' }), /obetald/);
});

test('editing booked invoice amounts or supplier reference cannot be hidden by a later payment', () => {
  const state = bookedBill();
  state.bills[0].number = 'L-CHANGED';
  assert.throws(() => payBill(state, state.bills[0].id, { date: '2026-10-10', amountCents: 1 }), /får inte ändras/);
});

test('a mutated draft cannot turn a supplier expense into bank or input VAT postings', () => {
  for (const account of ['1930', '1510', '2641', '2440']) {
    const state = newBill();
    state.bills[0].account = account;
    assert.throws(() => bookBill(state, state.bills[0].id), /Kostnadskontot/);
    assert.equal(state.entries.length, 0);
  }
});

test('supplier payment can consume an existing bank event without creating a duplicate', () => {
  let state = bookedBill();
  state = createBankEvent(state, bankInput({ amountCents: -400_000 }));
  const bankId = state.bankTransactions[0].id;
  state = payBill(state, state.bills[0].id, { date: '2026-10-10', amountCents: 400_000, bankEventId: bankId });
  assert.equal(state.bankTransactions.length, 1);
  assert.equal(state.bankTransactions[0].matchedEntryId, state.bills[0].payments[0].entryId);
  assert.equal(getBillOutstanding(state.bills[0]), 850_000);
  assert.throws(() => payBill(state, state.bills[0].id, { date: '2026-10-10', amountCents: 400_000, bankEventId: bankId }), /ännu inte avstämd/);
});

test('existing bank event must match supplier payment date and amount exactly', () => {
  let state = bookedBill();
  state = createBankEvent(state, bankInput({ amountCents: -400_000 }));
  const bankEventId = state.bankTransactions[0].id;
  for (const payment of [{ date: '2026-10-11', amountCents: 400_000 }, { date: '2026-10-10', amountCents: 400_001 }]) {
    assert.throws(() => payBill(state, state.bills[0].id, { ...payment, bankEventId }), /måste motsvara/);
  }
  assert.equal(state.entries.length, 1);
  assert.equal(state.bankTransactions[0].matchedEntryId, null);
});

test('bank matching requires exact signed amount on same account and rejects reused entries', () => {
  let state = postManualEntry(createEmptyState(), { date: '2026-10-02', description: 'Kapitalinsättning', rows: [
    { account: '1930', debitCents: 100_000, creditCents: 0 }, { account: '2091', debitCents: 0, creditCents: 100_000 },
  ] });
  const entryId = state.entries[0].id;
  state = createBankEvent(state, bankInput({ amountCents: -100_000 }));
  assert.throws(() => matchBankEvent(state, state.bankTransactions[0].id, entryId), /riktning/);
  state = createBankEvent(state, bankInput({ amountCents: 100_000, account: '1910' }));
  assert.throws(() => matchBankEvent(state, state.bankTransactions[1].id, entryId), /samma konto/);
  state = createBankEvent(state, bankInput({ amountCents: 100_000 }));
  state = matchBankEvent(state, state.bankTransactions[2].id, entryId);
  assert.equal(state.bankTransactions[2].matchedEntryId, entryId);
  assert.throws(() => matchBankEvent(state, state.bankTransactions[2].id, entryId), /redan avstämd/);
  state = createBankEvent(state, bankInput({ amountCents: 100_000 }));
  assert.throws(() => matchBankEvent(state, state.bankTransactions[3].id, entryId), /annan händelse/);
});

test('bank fee records expense and cannot be posted twice or as positive income', () => {
  const original = createBankEvent(createEmptyState(), bankInput());
  const state = bookBankEvent(original, original.bankTransactions[0].id, { kind: 'fee' });
  assert.equal(accountBalance(state, '6570'), 15_000);
  assert.equal(accountBalance(state, '1930'), -15_000);
  assert.ok(state.bankTransactions[0].matchedEntryId);
  assert.throws(() => bookBankEvent(state, state.bankTransactions[0].id, { kind: 'fee' }), /redan/);
  const positive = createBankEvent(createEmptyState(), bankInput({ amountCents: 15_000 }));
  assert.throws(() => bookBankEvent(positive, positive.bankTransactions[0].id, { kind: 'fee' }), /utbetalning/);
  assert.equal(positive.entries.length, 0);
});

test('tax and cash transfers post both bank-account sides with matched counterpart events', () => {
  for (const [kind, target] of [['transfer-tax', '1630'], ['cash-transfer', '1910']]) {
    const state0 = createBankEvent(createEmptyState(), bankInput({ amountCents: -80_000 }));
    const state = bookBankEvent(state0, state0.bankTransactions[0].id, { kind });
    assert.equal(accountBalance(state, '1930'), -80_000);
    assert.equal(accountBalance(state, target), 80_000);
    assert.equal(state.bankTransactions.length, 2);
    assert.equal(state.bankTransactions[1].account, target);
    assert.equal(state.bankTransactions[1].amountCents, 80_000);
    assert.equal(state.bankTransactions[0].matchedEntryId, state.bankTransactions[1].matchedEntryId);
    assertBalanced(state);
  }
});

test('loan principal cannot be repaid beyond debt and interest is recorded separately', () => {
  let state = createBankEvent(createEmptyState(), bankInput({ amountCents: 100_000 }));
  state = bookBankEvent(state, state.bankTransactions[0].id, { kind: 'loan' });
  assert.equal(accountBalance(state, '2350'), -100_000);
  state = createBankEvent(state, bankInput({ amountCents: -100_001 }));
  assert.throws(() => bookBankEvent(state, state.bankTransactions[1].id, { kind: 'loan' }), /överstiger/);
  state = createBankEvent(state, bankInput({ amountCents: -20_000 }));
  state = bookBankEvent(state, state.bankTransactions[2].id, { kind: 'loan' });
  assert.equal(accountBalance(state, '2350'), -80_000);
  state = createBankEvent(state, bankInput({ amountCents: -1_000 }));
  state = bookBankEvent(state, state.bankTransactions[3].id, { kind: 'interest' });
  assert.equal(accountBalance(state, '8410'), 1_000);
  assertBalanced(state);
});

test('manual entry uses core balance checks and cannot bypass subledgers or VAT', () => {
  const rows = [{ account: '5410', debitCents: 10_000, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 10_000 }];
  const state = postManualEntry(createEmptyState(), { date: '2026-10-04', description: 'Manuell omföring', rows });
  assert.equal(state.entries.length, 1);
  for (const account of ['1220', '1229', '1460', '1510', '1710', '1790', '2440', '2641', '2710', '2910', '2099', '3973', '4960', '7832', '7973', '8999']) {
    assert.throws(() => postManualEntry(state, { date: '2026-10-05', description: 'Otillåten genväg', rows: [{ ...rows[0], account }, rows[1]] }), /egna flöden/);
  }
  assert.throws(() => postManualEntry(state, { date: '2026-10-05', description: 'Obalans', rows: [{ ...rows[0], debitCents: 10_001 }, rows[1]] }));
});

test('supplier credit cannot leave an asset registered after reversing its source purchase', () => {
  let state = bookedBill({ account: '5410' });
  const id = state.bills[0].id;
  state = createAsset(state, { name: 'Kompressor', date: '2026-10-05', costCents: 1_000_000, lifeMonths: 60 });
  const before = structuredClone(state);
  assert.throws(() => creditBill(state, id, { date: '2026-10-06', reason: 'Återlämnad' }), /omklassificerats/);
  assert.deepEqual(state, before);
  // Backdating a credit ahead of an already-booked asset acquisition also fails.
  assert.throws(() => creditBill(state, id, { date: '2026-10-03', reason: 'Bakdaterad retur' }), /omklassificerats/);
  const plainPurchase = bookedBill({ account: '5410' });
  const credited = creditBill(plainPurchase, plainPurchase.bills[0].id, { date: '2026-10-03', reason: 'Ej omklassificerat inköp' });
  assert.equal(accountBalance(credited, '5410'), 0);
});

test('supplier credit cannot retain a prepaid balance after cancelling its source expense', () => {
  let state = bookedBill({ account: '5010' });
  const id = state.bills[0].id;
  state = createAccrual(state, { name: 'Förutbetald lokalhyra', type: 'prepaid', date: '2026-10-03', amountCents: 1_000_000, expenseAccount: '5010', months: 3, startMonth: '2026-10' });
  assert.throws(() => creditBill(state, id, { date: '2026-10-04', reason: 'Avbruten hyra' }), /omklassificerats/);
  assert.throws(() => creditBill(state, id, { date: '2026-10-02', reason: 'Bakdaterad kredit' }), /omklassificerats/);
  assert.equal(accountBalance(state, '1790'), 1_000_000);
});

test('supplier credit cannot retain a material stock valuation without its original purchase', () => {
  let state = bookedBill({ account: '4010' });
  const id = state.bills[0].id;
  state = createStockItem(state, { name: 'Skivmaterial', unit: 'st', unitCostCents: 100_000 });
  const itemId = state.inventoryItems[0].id;
  state = recordStockMovement(state, itemId, { date: '2026-10-03', kind: 'in', quantity: 10, reason: 'Inleverans' });
  state = postStockValuation(state, { date: '2026-10-03' });
  assert.throws(() => creditBill(state, id, { date: '2026-10-04', reason: 'Returnerat material' }), /omklassificerats/);
  assert.throws(() => creditBill(state, id, { date: '2026-10-02', reason: 'Bakdaterad kredit' }), /omklassificerats/);
  assert.equal(accountBalance(state, '1460'), 1_000_000);
});

test('manual correction cannot remove a source expense that funds a prepaid schedule', () => {
  let state = postManualEntry(createEmptyState(), { date: '2026-01-05', description: 'Betald lokalhyra', rows: [
    { account: '5010', debitCents: 100_000, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 100_000 },
  ] });
  const sourceId = state.entries[0].id;
  state = createAccrual(state, { name: 'Lokalhyra', date: '2026-01-05', amountCents: 100_000, expenseAccount: '5010', months: 3, startMonth: '2026-01' });
  assert.throws(() => correctEntry(state, sourceId, { date: '2026-01-06', reason: 'Ta bort kostnaden' }), /omklassificerats/);
  assert.throws(() => postManualEntry(state, { date: '2026-01-06', description: 'Ta bort kostnaden direkt', rows: [
    { account: '1930', debitCents: 100_000, creditCents: 0 }, { account: '5010', debitCents: 0, creditCents: 100_000 },
  ] }), /omklassificerats/);
  assert.equal(state.entries.length, 2);
  assert.equal(accountBalance(state, '1790'), 100_000);
});

test('manual correction preserves original and links a single reversal; source bills remain protected', () => {
  const rows = [{ account: '5410', debitCents: 10_000, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: 10_000 }];
  const original = postManualEntry(createEmptyState(), { date: '2026-10-04', description: 'Fel konto', rows });
  const first = structuredClone(original.entries[0]);
  const state = correctEntry(original, first.id, { date: '2026-10-05', reason: 'Ska omföras' });
  assert.deepEqual(state.entries[0], first);
  assert.equal(state.entries[1].correctsEntryId, first.id);
  assert.equal(accountBalance(state, '5410'), 0);
  assert.throws(() => correctEntry(state, first.id, { date: '2026-10-06', reason: 'Igen' }), /redan/);
  const bill = bookedBill();
  assert.throws(() => correctEntry(bill, bill.entries[0].id, { date: '2026-10-05', reason: 'Genväg' }), /ursprungsflöde/);
});

test('locked periods block new supplier, bank and manual postings without mutating input', () => {
  const state = bookedBill();
  state.lockedPeriods.push('2026-10');
  const before = structuredClone(state);
  assert.throws(() => payBill(state, state.bills[0].id, { date: '2026-10-10', amountCents: 1 }));
  assert.throws(() => createBill(state, billInput({ number: 'L-101' })));
  assert.throws(() => createBankEvent(state, bankInput()));
  assert.deepEqual(state, before);
});
