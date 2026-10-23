import test from 'node:test';
import assert from 'node:assert/strict';
import { fileVatPeriod } from '../public/bokforing/suite/finance.js';
import { postTaxTransaction } from '../public/bokforing/suite/tax-ledger.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { createEmptyState, legacyZeroVatFixture, invoiceTestExemption } from './fixtures/bokforing-compliant-invoices.mjs';

const quarter = { from:'2026-10-01',to:'2026-12-31',date:'2026-12-31' };
test('VAT-FINALIZE-001 legacy unclassified zero-VAT sale cannot be finalized through the model API', () => {
  const state=legacyZeroVatFixture('sole'), before=structuredClone(state);
  assert.throws(()=>fileVatPeriod(state,quarter),/oklassificerade|granskningsvarning/);
  assert.deepEqual(state,before);
});
test('VAT-FINALIZE-002 explicitly reviewed exempt rent can be finalized without a synthetic zero journal', () => {
  const state=postTaxTransaction(createEmptyState(),{kind:'domestic-sale',date:'2026-10-03',reference:'RENT',counterparty:'Fiktiv hyresgäst',country:'SE',netCents:100000,vatRate:0,conditionsConfirmed:true,vatExemption:{...invoiceTestExemption}});
  const next=fileVatPeriod(state,quarter);
  assert.equal(Math.abs(next.vatReturns[0].payableCents),0);
  assert.equal(next.vatReturns[0].entryId,null);
  assert.equal(next.entries.length,state.entries.length);
  validateSuiteState(next);
});
test('VAT-FINALIZE-003 an older unclassified sale does not prevent finalizing a later clean quarter', () => {
  const state=legacyZeroVatFixture('prior');
  const next=fileVatPeriod(state,quarter);
  assert.equal(next.vatReturns.length,1);
  assert.deepEqual(next.entries,state.entries);
  validateSuiteState(next);
});
