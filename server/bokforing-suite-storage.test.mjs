import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSuiteStorage, STORAGE_KEY } from '../public/bokforing/suite/storage.js';
import { issueInvoice, receivePayment, requestRot, decideRot } from '../public/bokforing/suite/sales.js';
import { bookBill } from '../public/bokforing/suite/operations.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

const LEGACY_KEY = 'scrapplanner-bokforing-demo-v1';
function harness() {
  const values = new Map([[LEGACY_KEY, 'earlier-demo-is-preserved']]);
  let pending = Promise.resolve(), revision = 0;
  const locks = { request(_name, _options, callback) {
    const result = pending.then(() => callback({ mode: 'exclusive' }));
    pending = result.catch(() => {}); return result;
  } };
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const create = () => createSuiteStorage({ getStorage: () => storage, locks, makeRevision: () => `suite-test-${++revision}` });
  return { values, store: create(), second: create() };
}

test('expanded demo uses its own key and reset preserves the earlier saved demo', async () => {
  const { values, store } = harness();
  const first = store.load();
  assert.equal(first.writable, true);
  assert.equal(first.state.schemaVersion, 2);
  assert.equal(values.has(STORAGE_KEY), false);
  const invoiceId = first.state.invoices.find(item => item.rot).id;
  const saved = await store.commit(first, state => issueInvoice(state, invoiceId));
  assert.equal(saved.state.invoices.find(item => item.id === invoiceId).status, 'issued');
  const reset = await store.reset(saved);
  assert.equal(reset.state.invoices.find(item => item.rot).status, 'draft');
  assert.equal(values.get(LEGACY_KEY), 'earlier-demo-is-preserved');
  assert.equal(reset.state.entries.length, 4);
});

test('simultaneous invoice and purchase actions cannot overwrite the shared ledger', async () => {
  const { values, store, second } = harness();
  const first = store.load(), other = second.load();
  const invoiceId = first.state.invoices.find(item => item.rot).id;
  const billId = other.state.bills.find(item => item.status === 'draft').id;
  const result = await Promise.allSettled([
    store.commit(first, state => issueInvoice(state, invoiceId)),
    second.commit(other, state => bookBill(state, billId)),
  ]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(result.filter(item => item.status === 'rejected' && item.reason.code === 'STALE_STATE').length, 1);
  let restored = second.load();
  assert.equal(restored.state.entries.length, 5);
  restored = await second.commit(restored, state => bookBill(state, billId));
  assert.equal(restored.state.entries.length, 6);
  validateSuiteState(JSON.parse(values.get(STORAGE_KEY)));
});

test('ROT invoice, reduced decision and both payers restore with the same receivable', async () => {
  const { store } = harness();
  let saved = store.load();
  const id = saved.state.invoices.find(item => item.rot).id;
  const commit = async transition => { saved = await store.commit(saved, transition); };
  await commit(state => issueInvoice(state, id));
  await commit(state => receivePayment(state, id, { date: '2026-10-23', amountCents: 2_640_000 }));
  await commit(state => requestRot(state, id, { date: '2026-10-23', workCompletedConfirmed: true, electronicPaymentConfirmed: true }));
  await commit(state => decideRot(state, id, { date: '2026-10-23', approvedCents: 500_000, reason: 'Fiktivt begränsat utrymme' }));
  await commit(state => receivePayment(state, id, { date: '2026-10-23', amountCents: 500_000, payer: 'tax' }));
  await commit(state => receivePayment(state, id, { date: '2026-10-23', amountCents: 160_000, reference: 'Kundens återstående del' }));
  const reloaded = store.load();
  assert.equal(reloaded.error, null);
  assert.equal(reloaded.state.invoices.find(item => item.id === id).payments.reduce((total, item) => total + item.amountCents, 0), 3_300_000);
  assert.equal(reloaded.state.entries.filter(item => item.sourceType === 'invoice' && item.sourceId === id).length, 1);
  validateSuiteState(reloaded.state);
});

test('balanced but inconsistent source data cannot be saved or silently replaced on restoration', async () => {
  const { store, values } = harness();
  const initial = store.load();
  await assert.rejects(store.commit(initial, state => {
    state.invoices.find(item => item.status === 'issued').lines[0].unitCents += 100;
    return state;
  }), error => error.code === 'INVALID_DATA');
  assert.equal(values.has(STORAGE_KEY), false);
  const invalid = structuredClone(initial.state);
  invalid.bills.find(item => item.status === 'booked').totalCents += 100;
  const raw = JSON.stringify(invalid);
  values.set(STORAGE_KEY, raw);
  const loaded = store.load();
  assert.equal(loaded.error.code, 'INVALID_DATA');
  assert.equal(loaded.writable, false);
  assert.equal(values.get(STORAGE_KEY), raw);
  const reset = await store.reset(loaded);
  validateSuiteState(reset.state);
  assert.equal(values.get(LEGACY_KEY), 'earlier-demo-is-preserved');
});
