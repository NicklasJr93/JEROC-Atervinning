import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, accountBalance, transact, appendEntry } from '../public/bokforing/suite/core.js';
import { createStockItem, recordStockMovement, postStockValuation, getStockValue, validateInventoryState } from '../public/bokforing/suite/inventory.js';
import { createBill, bookBill, creditBill } from '../public/bokforing/suite/operations.js';

const itemInput = (overrides = {}) => ({ name: 'Reglar', unit: 'm', unitCostCents: 1_000, ...overrides });
const itemState = (overrides = {}) => createStockItem(createEmptyState(), itemInput(overrides));
const move = (state, overrides = {}) => recordStockMovement(state, state.inventoryItems[0].id, {
  date: '2026-10-01', kind: 'in', quantity: 100, reason: 'Inventerade demovaror', ...overrides,
});
const purchase = (state, overrides = {}) => {
  let next = createBill(state, { supplier: 'Material Demo AB', number: `L-${state.bills.length + 1}`, date: '2026-10-01', dueDate: '2026-10-31',
    netCents: 100_000, vatRate: 25, account: '4010', ...overrides });
  return bookBill(next, next.bills.at(-1).id);
};
const valued = () => postStockValuation(move(purchase(itemState())), { date: '2026-10-01' });

test('stock item creation is immutable and validates name, unit, cost and duplicates', () => {
  const empty = createEmptyState();
  const state = createStockItem(empty, itemInput());
  assert.equal(empty.inventoryItems.length, 0);
  assert.equal(state.inventoryItems[0].quantity, 0);
  assert.equal(getStockValue(state), 0);
  assert.throws(() => createStockItem(state, itemInput({ name: 'reglar' })), /finns redan/);
  assert.throws(() => itemState({ name: '' }));
  assert.throws(() => itemState({ unit: '' }));
  for (const value of [0, -1, 1.5, Infinity]) assert.throws(() => itemState({ unitCostCents: value }));
});

test('stock value rounds each physical item to whole cents using exact hundredths', () => {
  let state = move(itemState({ unitCostCents: 101 }), { quantity: 1.5 });
  assert.equal(getStockValue(state), 152);
  state = createStockItem(state, itemInput({ name: 'Spik', unitCostCents: 101 }));
  state = recordStockMovement(state, state.inventoryItems[1].id, { date: '2026-10-01', kind: 'count', quantity: 1.25, reason: 'Kontrollräkning' });
  assert.equal(getStockValue(state), 278);
});

test('in, out and count preserve a complete history without negative quantities', () => {
  let state = move(itemState(), { quantity: 10.5 });
  state = move(state, { kind: 'out', quantity: 2.25, date: '2026-10-02' });
  state = move(state, { kind: 'count', quantity: 6.5, date: '2026-10-03' });
  assert.equal(state.inventoryItems[0].quantity, 6.5);
  assert.deepEqual(state.inventoryItems[0].movements.map(m => [m.beforeQuantity, m.afterQuantity]), [[0, 10.5], [10.5, 8.25], [8.25, 6.5]]);
  const before = structuredClone(state);
  assert.throws(() => move(state, { kind: 'out', quantity: 6.51, date: '2026-10-04' }), /överstiger/);
  assert.deepEqual(state, before);
  for (const quantity of [-1, 0, 1.001, NaN, 1_000_001]) assert.throws(() => move(state, { quantity, date: '2026-10-04' }));
  state = move(state, { kind: 'count', quantity: 0, date: '2026-10-04' });
  assert.equal(getStockValue(state), 0);
});

test('physical quantities do not create a journal; stock needs booked material acquisition', () => {
  const state = move(itemState());
  assert.equal(state.entries.length, 0);
  assert.throws(() => postStockValuation(state, { date: '2026-10-01' }), /materialinköp/);
  assert.equal(state.inventoryValuations.length, 0);
});

test('periodic valuation reclassifies material expense and saves an immutable count snapshot', () => {
  const state = valued();
  const valuation = state.inventoryValuations[0];
  assert.equal(valuation.valueCents, 100_000);
  assert.equal(valuation.deltaCents, 100_000);
  assert.equal(valuation.items[0].quantity, 100);
  assert.equal(accountBalance(state, '1460'), 100_000);
  assert.equal(accountBalance(state, '4010') + accountBalance(state, '4960'), 0);
  assert.equal(state.entries.find(e => e.id === valuation.entryId).sourceId, valuation.id);
  validateInventoryState(state);
  for (const entry of state.entries) assert.equal(entry.rows.reduce((sum, row) => sum + row.debitCents - row.creditCents, 0), 0);
});

test('later stock consumption releases expense while preserving the original valuation', () => {
  const original = valued();
  const originalValuation = structuredClone(original.inventoryValuations[0]);
  let state = move(original, { kind: 'out', quantity: 40, date: '2026-10-02', reason: 'Förbrukat i uppdrag' });
  state = postStockValuation(state, { date: '2026-10-02' });
  assert.equal(accountBalance(state, '1460'), 60_000);
  assert.equal(accountBalance(state, '4010') + accountBalance(state, '4960'), 40_000);
  assert.equal(state.inventoryValuations[1].deltaCents, -40_000);
  assert.deepEqual(state.inventoryValuations[0], originalValuation);
  assert.deepEqual(original.inventoryValuations[0], originalValuation);
});

test('unchanged valuation produces history but no zero journal entry', () => {
  const original = valued();
  const state = postStockValuation(original, { date: '2026-10-02' });
  assert.equal(state.entries.length, original.entries.length);
  assert.equal(state.inventoryValuations.length, 2);
  assert.equal(state.inventoryValuations[1].deltaCents, 0);
  assert.equal(state.inventoryValuations[1].entryId, null);
  assert.ok(state.activity.length > original.activity.length);
});

test('closed or already-valued dates cannot rewrite counts or repeat valuation', () => {
  const state = valued();
  assert.throws(() => move(state, { kind: 'count', date: '2026-10-01', quantity: 90 }), /redan värderad/);
  assert.throws(() => postStockValuation(state, { date: '2026-10-01' }), /senaste lagervärderingen/);
  assert.throws(() => postStockValuation(state, { date: '2026-09-30' }), /senaste lagervärderingen/);
  const locked = structuredClone(state);
  locked.lockedPeriods.push('2026-10');
  assert.throws(() => move(locked, { date: '2026-10-02' }), /låst/);
  assert.throws(() => postStockValuation(locked, { date: '2026-10-02' }), /låst/);
});

test('backdated counts and valuations cannot use future physical movements or purchases', () => {
  let state = move(purchase(itemState()), { date: '2026-10-10' });
  assert.throws(() => move(state, { date: '2026-10-09' }), /senaste rörelse/);
  assert.throws(() => postStockValuation(state, { date: '2026-10-09' }), /registrerad lagerrörelse/);
  state = move(purchase(itemState(), { date: '2026-10-20' }), { date: '2026-10-01' });
  assert.throws(() => postStockValuation(state, { date: '2026-10-01' }), /materialinköp/);
  assert.equal(postStockValuation(state, { date: '2026-10-20' }).inventoryValuations[0].valueCents, 100_000);
});

test('a later existing supplier credit prevents backdating stock that becomes unfunded', () => {
  let state = move(purchase(itemState()));
  state = creditBill(state, state.bills[0].id, { date: '2026-10-20', reason: 'Returnerat inköp' });
  const before = structuredClone(state);
  assert.throws(() => postStockValuation(state, { date: '2026-10-01' }), /täckning/);
  assert.deepEqual(state, before);
});

test('domain validation rejects count, value and posted snapshot tampering', () => {
  const original = valued();
  const changedQuantity = structuredClone(original);
  changedQuantity.inventoryItems[0].quantity = 99;
  assert.throws(() => validateInventoryState(changedQuantity), /Lagersaldot/);
  const changedValue = structuredClone(original);
  changedValue.inventoryValuations[0].valueCents += 1;
  assert.throws(() => validateInventoryState(changedValue), /totalbelopp/);
  const changedSnapshot = structuredClone(original);
  changedSnapshot.inventoryValuations[0].items[0].quantity = 99;
  assert.throws(() => validateInventoryState(changedSnapshot), /Värderat antal/);
});

test('an opening stock balance can be confirmed without creating fictitious purchases', () => {
  let state = transact(itemState(), draft => appendEntry(draft, { date: '2026-01-01', description: 'Ingående lager', sourceType: 'opening', sourceId: 'stock-opening',
    rows: [{ account: '1460', debitCents: 100_000, creditCents: 0 }, { account: '2091', debitCents: 0, creditCents: 100_000 }] }));
  state = move(state, { date: '2026-01-01' });
  state = postStockValuation(state, { date: '2026-01-01' });
  assert.equal(state.inventoryValuations[0].deltaCents, 0);
  assert.equal(accountBalance(state, '1460'), 100_000);
});
