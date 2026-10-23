import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, transact, appendEntry, accountBalance } from '../public/bokforing/suite/core.js';
import { createAccrual, postAccrualMonth, getAccrualRemaining } from '../public/bokforing/suite/periodization.js';

const expenseState = (amount = 1_200_000, date = '2026-01-05') => transact(createEmptyState(), draft => {
  appendEntry(draft, { date, description: 'Förbetald hyra', sourceType: 'manual', sourceId: 'rent', rows: [
    { account: '5010', debitCents: amount, creditCents: 0 }, { account: '1930', debitCents: 0, creditCents: amount },
  ] });
});
const input = (overrides = {}) => ({ name: 'Hyra första kvartalet', type: 'prepaid', date: '2026-01-05', amountCents: 1_200_000,
  expenseAccount: '5010', months: 3, startMonth: '2026-01', ...overrides });

test('prepaid cost reclassifies existing expense and three months recognize exactly the original amount', () => {
  const original = expenseState();
  const before = structuredClone(original);
  let state = createAccrual(original, input());
  const id = state.accruals[0].id;
  assert.deepEqual(original, before);
  assert.equal(accountBalance(state, '5010'), 0);
  assert.equal(accountBalance(state, '1790'), 1_200_000);
  assert.equal(getAccrualRemaining(state.accruals[0]), 1_200_000);
  for (const month of ['01', '02', '03']) state = postAccrualMonth(state, id, { date: `2026-${month}-28` });
  assert.equal(accountBalance(state, '5010'), 1_200_000);
  assert.equal(accountBalance(state, '1790'), 0);
  assert.equal(getAccrualRemaining(state.accruals[0]), 0);
  assert.equal(state.accruals[0].status, 'completed');
  assert.deepEqual(state.accruals[0].postings.map(item => item.amountCents), [400_000, 400_000, 400_000]);
});

test('cumulative rounding allocates every cent without a residual', () => {
  let state = createAccrual(expenseState(100), input({ amountCents: 100 }));
  for (const month of ['01', '02', '03']) state = postAccrualMonth(state, state.accruals[0].id, { date: `2026-${month}-28` });
  assert.deepEqual(state.accruals[0].postings.map(item => item.amountCents), [33, 34, 33]);
  assert.equal(accountBalance(state, '1790'), 0);
});

test('zero-cent allocation records the month without creating an invalid zero journal', () => {
  let state = createAccrual(expenseState(1), input({ amountCents: 1 }));
  const count = state.entries.length;
  state = postAccrualMonth(state, state.accruals[0].id, { date: '2026-01-28' });
  assert.equal(state.entries.length, count);
  assert.equal(state.accruals[0].postings[0].entryId, null);
  state = postAccrualMonth(state, state.accruals[0].id, { date: '2026-02-28' });
  state = postAccrualMonth(state, state.accruals[0].id, { date: '2026-03-28' });
  assert.deepEqual(state.accruals[0].postings.map(item => item.amountCents), [0, 1, 0]);
  assert.equal(getAccrualRemaining(state.accruals[0]), 0);
  assert.equal(state.accruals[0].status, 'completed');
});

test('monthly recognition cannot skip or repeat a month', () => {
  const initial = createAccrual(expenseState(), input());
  const id = initial.accruals[0].id;
  assert.throws(() => postAccrualMonth(initial, id, { date: '2026-02-28' }), /2026-01/);
  const state = postAccrualMonth(initial, id, { date: '2026-01-28' });
  assert.throws(() => postAccrualMonth(state, id, { date: '2026-01-28' }), /2026-02/);
  assert.equal(initial.accruals[0].postings.length, 0);
});

test('source expense must exist by the reclassification date and cannot be consumed twice', () => {
  assert.throws(() => createAccrual(createEmptyState(), input()), /Bokför först/);
  assert.throws(() => createAccrual(expenseState(1_200_000, '2026-01-20'), input()), /Bokför först/);
  const state = createAccrual(expenseState(), input());
  assert.throws(() => createAccrual(state, input({ name: 'Samma kostnad igen' })), /Bokför först/);
  const future = createAccrual(expenseState(), input({ date: '2026-02-05', startMonth: '2026-03' }));
  assert.throws(() => createAccrual(future, input({ name: 'Bakdaterad dubbel periodisering' })), /redan använd/);
});

test('plan parameters and expense accounts are validated before posting', () => {
  const state = expenseState();
  for (const change of [{ type: 'accrued' }, { months: 0 }, { months: 121 }, { months: 1.5 }, { expenseAccount: '5410' },
    { startMonth: '2025-12' }, { startMonth: '2026-13' }, { amountCents: -1 }, { amountCents: 0.5 }, { name: '' }]) {
    assert.throws(() => createAccrual(state, input(change)));
  }
  assert.equal(state.entries.length, 1);
  assert.equal(state.accruals.length, 0);
});

test('monthly booking rejects a changed schedule and preserves existing journal rows', () => {
  const state = createAccrual(expenseState(), input());
  state.accruals[0].name = 'Ändrat bokfört underlag';
  assert.throws(() => postAccrualMonth(state, state.accruals[0].id, { date: '2026-01-28' }), /får inte ändras/);
  assert.equal(state.entries.length, 2);
});

test('cross-year schedule retains prepaid balance but cannot post outside the current fiscal year', () => {
  let state = createAccrual(expenseState(1_200_000, '2026-12-05'), input({ date: '2026-12-05', startMonth: '2026-12' }));
  state = postAccrualMonth(state, state.accruals[0].id, { date: '2026-12-31' });
  assert.equal(getAccrualRemaining(state.accruals[0]), 800_000);
  assert.throws(() => postAccrualMonth(state, state.accruals[0].id, { date: '2027-01-31' }), /räkenskapsåret/);
  assert.equal(accountBalance(state, '1790'), 800_000);
});

test('locked periods stop both acquisition and monthly recognition', () => {
  const locked = expenseState(); locked.lockedPeriods.push('2026-01');
  assert.throws(() => createAccrual(locked, input()), /låst/);
  const state = createAccrual(expenseState(), input()); state.lockedPeriods.push('2026-01');
  assert.throws(() => postAccrualMonth(state, state.accruals[0].id, { date: '2026-01-28' }), /låst/);
});

test('recognition before initial date and after completed schedule is rejected', () => {
  let state = createAccrual(expenseState(), input({ months: 1 }));
  const id = state.accruals[0].id;
  assert.throws(() => postAccrualMonth(state, id, { date: '2026-01-01' }), /2026-01/);
  state = postAccrualMonth(state, id, { date: '2026-01-31' });
  assert.throws(() => postAccrualMonth(state, id, { date: '2026-02-28' }), /färdigfördelad/);
});
