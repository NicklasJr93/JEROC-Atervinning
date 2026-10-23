import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNTS, MAX_CENTS, accountBalance, addActivity, appendEntry, cents, createEmptyState, nextId, requireOpenPeriod, toCents, transact, validDate, validateState } from '../public/bokforing/suite/core.js';

const rows = amount => [{ account: '1930', debitCents: amount, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: amount }];
const post = (state, overrides = {}) => transact(state, draft => appendEntry(draft, { date: '2026-01-01', description: 'Aktiekapital', sourceType: 'opening', sourceId: 'capital', rows: rows(2_500_000), ...overrides }));

test('empty suite state has isolated arrays and a complete immutable chart', () => {
  const state = createEmptyState();
  assert.equal(validateState(state), state);
  assert.equal(state.schemaVersion, 2);
  assert.equal(createEmptyState().customers.length, 0);
  assert(Object.isFrozen(ACCOUNTS));
  assert(ACCOUNTS.every(Object.isFrozen));
  for (const number of ['1229', '1510', '1630', '2081', '2611', '2621', '2631', '2647', '2910', '3231', '4425', '7832', '8999']) assert(ACCOUNTS.some(account => account.number === number));
});

test('decimal parsing preserves exact cents and rejects ambiguous, negative or unsafe input', () => {
  for (const [input, expected] of [['0', 0], ['1', 100], ['1,2', 120], ['1.25', 125], ['1 234,56', 123456], ['1\u00a0234\u00a0567,89', 123456789], [' 0,01 ', 1]]) assert.equal(toCents(input), expected);
  for (const input of ['', '-1', '1,234', '1.000', '12 34', '1  234', '1e3', 'Infinity', '1,00 kr', '1.2.3', Number.NaN, '10000000000,01']) assert.throws(() => toCents(input));
  assert.equal(toCents('10000000000,00'), MAX_CENTS);
  assert.equal(cents(0), 0);
  assert.throws(() => cents(0, false));
  assert.throws(() => cents(-1));
  assert.throws(() => cents(1.2));
});

test('date validation checks real calendar dates and open fiscal-year periods', () => {
  for (const day of ['2024-02-29', '2026-10-31', '2026-01-01']) assert.equal(validDate(day), true);
  for (const day of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', '2026-01-01T00:00:00Z', null]) assert.equal(validDate(day), false);
  const state = createEmptyState();
  assert.throws(() => requireOpenPeriod(state, '2025-12-31'), /räkenskapsåret/);
  state.lockedPeriods.push('2026-10');
  assert.throws(() => requireOpenPeriod(state, '2026-10-31'), /låst/);
  assert.doesNotThrow(() => requireOpenPeriod(state, '2026-11-01'));
});

test('posting is immutable, balanced and gives sequential unique journal references', () => {
  const original = createEmptyState();
  const state = post(original);
  assert.equal(original.entries.length, 0);
  assert.equal(original.sequence, 0);
  assert.equal(state.entries[0].number, 'A1');
  assert.equal(state.entries[0].actor, 'Åke');
  assert.equal(state.activity.length, 1);
  assert.equal(accountBalance(state, '1930'), 2_500_000);
  assert.equal(accountBalance(state, '2081'), -2_500_000);
  const next = post(state, { sourceId: 'second' });
  assert.equal(next.entries[1].number, 'A2');
  assert.notEqual(next.entries[0].id, next.entries[1].id);
  assert.throws(() => post(state), /redan bokförd/);
});

test('invalid rows, sources, totals and dates cannot be posted', () => {
  const state = createEmptyState();
  for (const changes of [
    { rows: [{ account: '1930', debitCents: 1, creditCents: 0 }] },
    { rows: [{ account: '1930', debitCents: 1, creditCents: 1 }, { account: '2081', debitCents: 1, creditCents: 1 }] },
    { rows: [{ account: '9999', debitCents: 1, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 1 }] },
    { rows: [{ account: '1930', debitCents: 2, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 1 }] },
    { rows: rows(0) }, { rows: rows(-1) }, { rows: rows(1.5) },
    { date: '2026-02-29' }, { date: '2027-01-01' }, { sourceId: '' }, { description: ' ' },
  ]) assert.throws(() => post(state, changes));
  assert.equal(state.entries.length, 0);
});

test('posted journal entries cannot be edited, deleted or replaced in a transaction', () => {
  const state = post(createEmptyState());
  for (const operation of [
    draft => { draft.entries[0].description = 'Ändrat'; },
    draft => { draft.entries = []; },
    draft => { draft.entries[0].rows = rows(500); },
    draft => { draft.entries[0].sourceId = 'other'; },
  ]) assert.throws(() => transact(state, operation), /inte ändras eller raderas/);
  assert.equal(state.entries[0].description, 'Aktiekapital');
  assert.throws(() => transact(state, async () => {}), /asynkrona/);
});

test('linked correction reverses the original once and retains both entries', () => {
  const state = post(createEmptyState());
  const original = state.entries[0];
  const reversed = post(state, { date: '2026-02-01', sourceType: 'correction', sourceId: 'correct-capital', correctsEntryId: original.id,
    rows: original.rows.map(row => ({ account: row.account, debitCents: row.creditCents, creditCents: row.debitCents })) });
  assert.equal(reversed.entries.length, 2);
  assert.deepEqual(reversed.entries[0], original);
  assert.equal(reversed.entries[1].correctsEntryId, original.id);
  assert.equal(accountBalance(reversed, '1930'), 0);
  assert.throws(() => post(reversed, { sourceId: 'second-reversal', correctsEntryId: original.id }), /redan rättats/);
  assert.throws(() => post(state, { sourceId: 'wrong-reversal', correctsEntryId: original.id }), /återföra/);
});

test('invalid restored states fail closed, including duplicate IDs and missing journal links', () => {
  const original = post(createEmptyState());
  for (const change of [
    state => { state.schemaVersion = 1; },
    state => { state.entries[0].number = 'A2'; },
    state => { state.entries.push(structuredClone(state.entries[0])); },
    state => { state.company.fiscalYearEnd = '2026-02-29'; },
    state => { state.lockedPeriods = ['2026-13']; },
    state => { state.customers = [{ id: 'same' }, { id: 'same' }]; },
    state => { state.bankTransactions.push({ id: 'bank-test', date: '2026-01-01', description: 'Bank', account: '1930', amountCents: 1, matchedEntryId: 'missing' }); },
  ]) {
    const state = structuredClone(original);
    change(state);
    assert.throws(() => validateState(state));
  }
});

test('activity and identifiers share a monotonic sequence without mutating other states', () => {
  const state = createEmptyState();
  assert.equal(nextId(state, 'customer'), 'customer-1');
  assert.equal(addActivity(state, 'Kund skapad', 'customer-1').id, 'activity-2');
  assert.throws(() => nextId(state, 'bad prefix'));
  assert.equal(validateState(state), state);
  assert.throws(() => transact(state, draft => { draft.activity.length = 0; }), /historiken/);
  assert.throws(() => transact(state, draft => { draft.sequence = 0; }), /bakåt/);
});

test('restored bank matches must reconcile the exact signed account movement once', () => {
  const state = post(createEmptyState());
  const makeEvent = id => ({ id, date: '2026-01-01', description: 'Aktiekapital', account: '1930', amountCents: 2_500_000, matchedEntryId: state.entries[0].id });
  state.bankTransactions.push(makeEvent('bank-one'));
  assert.doesNotThrow(() => validateState(state));
  state.bankTransactions[0].amountCents = -2_500_000;
  assert.throws(() => validateState(state), /belopp/);
  state.bankTransactions[0].amountCents = 2_500_000;
  state.bankTransactions.push(makeEvent('bank-two'));
  assert.throws(() => validateState(state), /två gånger/);
});

test('any completed year record prevents additional journal posting', () => {
  const state = createEmptyState();
  state.yearClosures.push({ id: 'closure-1', year: '2026' });
  assert.throws(() => post(state), /avslutat/);
});

test('VAT journal additions cannot change an already finalized VAT period', () => {
  const state = createEmptyState();
  state.vatReturns.push({ id: 'vat-1', from: '2026-01-01', to: '2026-03-31' });
  const spec = { sourceType: 'invoice', sourceId: 'later-sale', date: '2026-03-01', rows: [
    { account: '1930', debitCents: 125, creditCents: 0 },
    { account: '3000', debitCents: 0, creditCents: 100 },
    { account: '2611', debitCents: 0, creditCents: 25 },
  ] };
  assert.throws(() => post(state, spec), /fastställd/);
  assert.doesNotThrow(() => post(state, { ...spec, date: '2026-04-01' }));
});
