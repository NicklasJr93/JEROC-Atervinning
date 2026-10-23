import { readFileSync } from 'node:fs';
// Explicit, fictional identity and performance data for older cross-domain
// fixtures. New completeness/negative tests call the production API directly.
// A checksum-valid demo VAT number is not a claim of actual registration.
import * as Core from '../../public/bokforing/suite/core.js';
import * as Sales from '../../public/bokforing/suite/sales.js';
import * as Commercial from '../../public/bokforing/suite/commercial.js';

export const invoiceTestParty = Object.freeze({
  address: 'Fiktivgatan 1', postalCode: '12345', city: 'Demostaden',
  country: 'SE', vatNumber: 'SE559900123601',
});
export const invoiceTestPerformance = Object.freeze({ mode: 'invoice-date', confirmed: true });
export function invoiceTestPayload(payload) {
  return { ...payload, details: { performance: { ...invoiceTestPerformance }, ...payload?.details } };
}
export function createEmptyState() {
  const state = Core.createEmptyState();
  Object.assign(state.company, invoiceTestParty, {orgNumber:'5599001236'});
  return state;
}
export function createCustomer(state, payload) {
  return Sales.createCustomer(state, { ...invoiceTestParty, ...payload });
}
export function createInvoice(state, payload) {
  return Sales.createInvoice(state, invoiceTestPayload(payload));
}
export function invoiceFromQuote(state, id, payload) {
  return Sales.invoiceFromQuote(state, id, invoiceTestPayload(payload));
}
export function createArticleInvoice(state, payload) {
  return Commercial.createArticleInvoice(state, invoiceTestPayload(payload));
}

export const invoiceTestExemption = Object.freeze({ code: 'property-rental', legalBasis: 'Fiktiv momsfri lokalupplåtelse; ingen frivillig beskattning.', confirmed: true });
export function reviewInvoiceFixture(state, id) {
  const invoice = state.invoices.find(item => item.id === id);
  return Sales.updateInvoiceDraft(state, id, { details: { ...invoice.details, performance: { ...invoiceTestPerformance } },
    lines: invoice.lines.map(line => ({ ...line, ...(line.vatRate === 0 ? { vatExemption: { ...invoiceTestExemption } } : {}) })) });
}
const legacy = JSON.parse(readFileSync(new URL('./bokforing-legacy-zero-vat-8a1c143.json', import.meta.url), 'utf8'));
export const legacyZeroVatFixture = name => structuredClone(legacy.scenarios[name]);
