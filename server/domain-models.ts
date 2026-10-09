// Reuse the actual UI's domain validation and accounting calculations on the
// server. Bundled at build time; Node never depends on browser-only modules.
export { officeSchema, seedOffice, amount, can } from '../src/office/model';
export { createCorrectionDraft, submitCorrection, migrateOffice, validPaymentDetails, recordPayment, saveCardOnBalance, approveCorrection, settlementPreview } from '../src/office/customer-model';
export { storeSchema, isComplete, rowWeight } from '../src/model';
export { transportSchema, seedTransport } from '../src/office/transport/model';
export { articles, initialCustomers } from '../src/data';
