import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, transact, appendEntry, nextId, accountBalance } from '../public/bokforing/suite/core.js';
import { createBill, bookBill } from '../public/bokforing/suite/operations.js';
import { createAsset, depreciateAsset, closeYear, lockPeriod, getReports } from '../public/bokforing/suite/finance.js';
import { createAccrual, postAccrualMonth, accrualBookingSnapshot } from '../public/bokforing/suite/periodization.js';
import { openNextYear } from '../public/bokforing/suite/financial-years.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const debit = (account, value) => ({ account, debitCents: value, creditCents: 0 });
const credit = (account, value) => ({ account, debitCents: 0, creditCents: value });
const accrualInput = extra => ({ name: 'Granskad hyra', date: '2027-01-01', amountCents: 120000, expenseAccount: '5010', months: 12, startMonth: '2027-01', ...extra });
const assetInput = extra => ({ name: 'Kompressor', date: '2027-01-01', costCents: 120000, lifeMonths: 24, ...extra });
function purchase(state, account, date = '2026-12-01', number = 'OLD-1') {
  state = createBill(state, { supplier: 'Testleverantör', number, date, dueDate: date, netCents: 120000, vatMode: 'no-vat', vatRate: 0, account });
  return bookBill(state, state.bills.at(-1).id);
}
function rollYear(state) {
  for (let m = 1; m <= 12; m++) state = lockPeriod(state, `2026-${String(m).padStart(2, '0')}`);
  state = closeYear(state, { date: '2026-12-31', confirmed: true });
  state = openNextYear(state, { confirmed: true }); validateSuiteState(state); return state;
}

test('new reclassification cannot reuse an expense from a closed prior year', () => {
  for (const account of ['5010', '5410']) {
    const state = rollYear(purchase(createEmptyState(), account)), before = structuredClone(state);
    const create = account === '5010' ? () => createAccrual(state, accrualInput()) : () => createAsset(state, assetInput());
    assert.throws(create, /aktuellt räkenskapsår/);
    assert.deepEqual(state, before); assert.equal(getReports(state).resultCents, 0);
  }
});

test('new-year purchases can be reclassified without borrowing the old-year expense', () => {
  for (const account of ['5010', '5410']) {
    let state = rollYear(purchase(createEmptyState(), account));
    state = purchase(state, account, '2027-01-01', 'NEW-1');
    state = account === '5010' ? createAccrual(state, accrualInput()) : createAsset(state, assetInput());
    validateSuiteState(state); assert.equal(getReports(state).resultCents, 0);
    assert.equal(accountBalance(state, account === '5010' ? '1790' : '1220'), 120000);
    const again = account === '5010' ? () => createAccrual(state, accrualInput()) : () => createAsset(state, assetInput());
    assert.throws(again, /Bokför först/);
  }
});

test('carried expense and asset schedules continue, but recognized cost is not a new purchase', () => {
  let state = purchase(createEmptyState(), '5010');
  state = createAccrual(state, accrualInput({ date: '2026-12-01', startMonth: '2026-12', months: 3 }));
  const accrualId = state.accruals[0].id;
  state = postAccrualMonth(state, accrualId, { date: '2026-12-31' });
  state = purchase(state, '5410', '2026-12-01', 'ASSET-1');
  state = createAsset(state, assetInput({ date: '2026-12-01' }));
  const assetId = state.assets[0].id;
  state = depreciateAsset(state, assetId, { date: '2026-12-31' });
  state = rollYear(state);
  state = postAccrualMonth(state, accrualId, { date: '2027-01-31' });
  state = depreciateAsset(state, assetId, { date: '2027-01-31' });
  validateSuiteState(state);
  assert.equal(accountBalance(state, '1790'), 40000); assert.equal(accountBalance(state, '1229'), -10000);
  assert.throws(() => createAccrual(state, accrualInput({ date: '2027-01-31', amountCents: 40000 })), /Bokför först/);
});

test('restore validation rejects a forged new-year reclassification without a same-year source', () => {
  for (const account of ['5010', '5410']) {
    const state = rollYear(purchase(createEmptyState(), account));
    const forged = transact(state, draft => {
      const id = nextId(draft, account === '5010' ? 'accrual' : 'asset');
      const entry = appendEntry(draft, { date: '2027-01-01', description: 'Felaktig omklassificering', sourceType: account === '5010' ? 'accrual-prepaid' : 'asset-acquisition', sourceId: id,
        rows: [debit(account === '5010' ? '1790' : '1220', 120000), credit(account, 120000)] });
      if (account === '5010') {
        const item = { id, ...accrualInput(), type: 'prepaid', status: 'active', postings: [], entryId: entry.id };
        item.bookingSnapshot = accrualBookingSnapshot(item); draft.accruals.push(item);
      } else draft.assets.push({ id, ...assetInput(), residualCents: 0, depreciations: [], status: 'active', entryId: entry.id });
    });
    assert.throws(() => validateSuiteState(forged), /kostnadsunderlag i sitt eget räkenskapsår/);
  }
});
