import { createCustomer, createEmptyState, createInvoice } from './fixtures/bokforing-compliant-invoices.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice } from '../public/bokforing/suite/sales.js';
import { createRevenueSchedule } from '../public/bokforing/suite/commercial.js';
import { createCreditNote, previewCreditNote } from '../public/bokforing/suite/settlements.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';

function deferredInvoice() {
  let state = createCustomer(createEmptyState(), { name: 'Granskningskund' });
  state = createInvoice(state, {
    customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31',
    lines: [{ description: 'Avtal', kind: 'labor', quantity: 1, unitCents: 100_000, vatRate: 25 }],
  });
  state = issueInvoice(state, state.invoices[0].id);
  return createRevenueSchedule(state, {
    invoiceId: state.invoices[0].id, name: 'Framtida intäktsfördelning',
    date: '2026-10-20', startMonth: '2026-11', months: 4, amountCents: 100_000,
  });
}
const credit = state => ({
  side: 'customer', documentId: state.invoices[0].id, date: '2026-10-15',
  reason: 'Avtalet minskas', reference: 'GRANSKNING-1',
  lines: [{ index: 0, netCents: 40_000 }], specialReviewed: true,
});

test('credit and preview cannot reverse a revenue deferral before the deferral exists', () => {
  const state = deferredInvoice(), original = JSON.stringify(state);
  assert.throws(() => previewCreditNote(state, credit(state)), /före|periodiser|datum/);
  assert.throws(() => createCreditNote(state, credit(state)), /före|periodiser|datum/);
  assert.equal(JSON.stringify(state), original);
});

test('a revenue credit on the deferral date preserves both journal and full restore validation', () => {
  const original = deferredInvoice();
  const next = createCreditNote(original, { ...credit(original), date: '2026-10-20' });
  validateSuiteState(next);
  assert.deepEqual(next.entries.slice(0, original.entries.length), original.entries);
  assert.equal(next.entries.at(-1).rows.find(row => row.account === '2990').debitCents, 40_000);
});
