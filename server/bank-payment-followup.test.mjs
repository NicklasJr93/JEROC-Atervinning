import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { verifiedBankPaymentProof } from './bank-payment-proof.mjs';
import { createDocumentRepository } from './documents/storage.mjs';
import { createDocumentService } from './documents/model.mjs';
import { renderPdf } from './documents/render.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createVismaPayments } from './visma-payments.mjs';

const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const admin = { actor: { id: 'admin', active: true }, user: { id: 'admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [], active: true } };

function bankFixture() {
  const paymentDetails = { method: 'bank', bankType: 'account', holder: 'Testmottagare', clearing: '8327', account: '00123456789' };
  const customer = { id: 'customer-a', name: 'Testmottagare', type: 'Privatperson', number: '199001010009', address: 'Testgatan 1', postalCode: '76141', city: 'Norrtälje' };
  const card = { id: 3040, siteId: 'norrtalje', yard: 'Norrtälje', customerId: customer.id, status: 'ready',
    origin: 'Testgatan 1, 76141 Norrtälje', reference: 'Projekt A', date: '2026-10-13T07:00:00Z', paymentDetails: copy(paymentDetails),
    rows: [{ articleId: 'iron', weight: 10, price: 4 }] };
  const snapshot = { card: copy(card), customer: copy(customer), rows: [{ articleId: 'iron', name: 'Järnskrot', weight: 10, price: 4, amount: 40 }],
    gross: 40, offset: 0, net: 40, reference: card.reference, origin: card.origin, deliveredAt: card.date, paymentMethod: 'bank', termsVersion: 'terms-1', hash: 'a'.repeat(64) };
  const approval = { id: randomUUID(), cardId: card.id, siteId: card.siteId, version: 1, status: 'attested', snapshot,
    createdAt: '2026-10-13T07:15:00Z', approvedAt: '2026-10-13T07:20:00Z', approvedMethod: 'staff_checked_id_demo', approvedHash: snapshot.hash,
    approvedBy: 'Kajsa', attestedAt: '2026-10-13T07:30:00Z', attestedBy: 'Anna', actualUserId: 'admin', effectiveUserId: 'anna' };
  const source = { cardId: card.id, approvalId: approval.id, version: 1, siteId: card.siteId, customerId: customer.id, hash: snapshot.hash };
  const payload = { creditorName: paymentDetails.holder, creditorAccount: { clearingNumber: paymentDetails.clearing, accountNumber: paymentDetails.account, currency: 'SEK' },
    debtorAccount: { iban: 'SE4550000000058398257466', currency: 'SEK' }, instructedAmount: { amount: '40.00', currency: 'SEK' }, remittanceInformationUnstructured: 'AV-3040-V1' };
  const providerPaymentId = randomUUID();
  const value = { id: randomUUID(), organisationId: 'tenant-a', provider: 'openpayments', kind: 'card', mode: 'sandbox', simulation: true, status: 'simulated_paid',
    source, sourceSnapshot: copy(snapshot), sourceSnapshotHash: snapshot.hash, originalPaymentDetails: copy(paymentDetails), paymentDetails: copy(paymentDetails),
    revisionActor: { actualUserId: 'admin', effectiveUserId: 'anna' }, amountCents: 4000, currency: 'SEK',
    spirisCompanyId: 'sandbox-company-a', spirisBankAccountId: randomUUID(), providerInstructionUUID: randomUUID(), providerProduct: 'domestic',
    providerPaymentId, providerPaymentReference: providerPaymentId, verifiedAt: '2026-10-13T08:47:01Z', request: { payload: copy(payload) },
    providerResult: { ...copy(payload), status: 'ACSC', transactionStatus: 'ACSC', paymentId: providerPaymentId, datePaid: '2026-10-13T08:47:00Z', datePaidSource: 'sandbox_confirmation' } };
  const sources = { company: { name: 'Testföretag AB', number: '5593593626' }, office: { cards: [card], customers: [customer], payments: [] },
    sites: [{ id: card.siteId, name: card.yard, active: true, address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' }], approvals: [approval] };
  return { value, sources };
}

async function withDocuments(run, { realPdf = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bank-pdf-followup-'));
  const repository = await createDocumentRepository({ env: {}, filename: join(directory, 'documents.sqlite') });
  const { value, sources } = bankFixture(), rendered = [];
  let reads = 0;
  const service = createDocumentService({ repository, sourceProvider: async () => { reads++; return copy(sources); },
    renderPdf: async snapshot => { rendered.push(copy(snapshot)); return realPdf ? renderPdf(snapshot) : Buffer.from('%PDF-1.4\nBank test\n%%EOF'); },
    now: () => new Date('2026-10-13T09:00:00Z') });
  try { await run({ repository, value, sources, service, rendered, reads: () => reads }); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('bank ACSC proof archives a real masked PDF once and preserves the immutable financial original', async () => withDocuments(async f => {
  f.value.providerResult.creditorAccount.bankName = 'Testbank';
  f.value.providerResult.debtorAccount.resourceId = 'sandbox-account-1';
  assert.equal(verifiedBankPaymentProof(f.value), true);
  const before = copy(f.sources);
  const [first, retry] = await Promise.all([f.service.archivePaymentConfirmation(copy(f.value)), f.service.archivePaymentConfirmation(copy(f.value))]);
  assert.equal(first.documentId, retry.documentId); assert.equal(first.version, 2);
  const document = await f.service.download(first.documentId, admin), original = await f.service.download(first.originalDocumentId, admin);
  assert.equal(document.pdf.subarray(0, 5).toString(), '%PDF-'); assert.ok(document.pdf.length > 1000);
  for (const key of ['rows', 'customer', 'company', 'site', 'gross', 'offset', 'net', 'approval', 'attest']) assert.deepEqual(document.snapshot[key], original.snapshot[key], key);
  assert.deepEqual(document.snapshot.payment, { method: 'bank', label: 'Bankkonto', maskedAccount: '•••• 6789', recipient: 'Testmottagare', bankType: 'account' });
  assert.equal(document.snapshot.paymentConfirmation.mode, 'openpayments_sandbox');
  assert.equal(document.snapshot.paymentConfirmation.method, 'bank');
  assert.equal(document.snapshot.paymentConfirmation.simulation, true);
  assert.equal(document.snapshot.paymentConfirmation.providerRef, f.value.providerPaymentId);
  assert.equal(document.snapshot.paymentConfirmation.datePaidSource, 'sandbox_confirmation');
  assert.doesNotMatch(JSON.stringify(document.snapshot), /00123456789/);
  assert.equal((await f.service.generateSettlement(f.value.source.cardId, { stage: 'final' }, admin)).document.id, first.documentId);
  assert.deepEqual(await f.service.download(original.id, admin), original);
  assert.deepEqual(f.sources, before, 'A sandbox confirmation must not mutate source approval, invoice or actual paid state.');
  assert.equal((await f.service.archivePaymentConfirmation(copy(f.value))).documentId, first.documentId);
  await assert.rejects(() => f.service.archivePaymentConfirmation({ ...f.value, verifiedAt: '2026-10-13T08:48:00Z' }), error => error.code === 'payment_confirmation_conflict');
}, { realPdf: true }));

test('bank pending, altered recipient, amount, currency, debtor and provider status cannot write a confirmation PDF', async () => withDocuments(async f => {
  const changes = [
    value => { value.status = 'awaiting_signature'; },
    value => { value.providerResult.transactionStatus = 'ACSP'; },
    value => { value.providerResult.status = 'ACSP'; },
    value => { value.providerResult.creditorAccount.accountNumber = '9987654321'; },
    value => { value.providerResult.creditorName = 'Annan mottagare'; },
    value => { value.providerResult.instructedAmount.amount = '41.00'; },
    value => { value.providerResult.instructedAmount.currency = 'EUR'; },
    value => { value.providerResult.debtorAccount.iban = 'OTHER'; },
    value => { value.providerResult.paymentId = randomUUID(); },
    value => { value.providerResult.datePaidSource = 'untrusted_callback'; },
    value => { value.mode = 'production'; },
  ];
  for (const change of changes) {
    const invalid = copy(f.value); change(invalid); assert.equal(verifiedBankPaymentProof(invalid), false);
    await assert.rejects(() => f.service.archivePaymentConfirmation(invalid), error => error.code === 'payment_confirmation_unverified');
  }
  assert.equal(f.reads(), 0); assert.equal(f.rendered.length, 0);
  assert.equal((await f.repository.read(db => db.documents('settlement', f.value.source.cardId))).length, 0);
}));

test('giro proof follows the exact typed route while harmless bank echo metadata is accepted', () => {
  for (const [type, number, giroType] of [['bankgiro', '1234566', 'BANKGIRO'], ['plusgiro', '123455', 'PLUSGIRO']]) {
    const { value } = bankFixture();
    value.paymentDetails = { method: 'bank', bankType: type, holder: 'Testmottagare', [type]: number };
    value.providerProduct = 'swedish-giro';
    delete value.request.payload.creditorAccount; delete value.providerResult.creditorAccount;
    value.request.payload.creditorGiro = { giroNumber: number, giroType };
    value.providerResult.creditorGiro = { giroNumber: number, giroType, bankName: 'Sandbox girobank' };
    assert.equal(verifiedBankPaymentProof(value), true, type);
    const altered = copy(value); altered.providerResult.creditorGiro.giroNumber = '9999999'; assert.equal(verifiedBankPaymentProof(altered), false);
    const wrongType = copy(value); wrongType.providerResult.creditorGiro.giroType = giroType === 'BANKGIRO' ? 'PLUSGIRO' : 'BANKGIRO'; assert.equal(verifiedBankPaymentProof(wrongType), false);
    const contradictory = copy(value); contradictory.request.payload.creditorAccount = { iban: 'SE4550000000058398257466', currency: 'SEK' };
    assert.equal(verifiedBankPaymentProof(contradictory), false, 'The sent instruction must contain only its declared route.');
  }
});

async function withAccounting(run) {
  const directory = await mkdtemp(join(tmpdir(), 'bank-spiris-followup-'));
  let repository = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: () => ({}) });
  const { value } = bankFixture(), invoiceId = randomUUID(), draftId = randomUUID(), supplierId = randomUUID(), voucherId = randomUUID(), transactionId = randomUUID(), paymentVoucherId = randomUUID();
  let booked = true, posted = false, now = new Date('2026-10-13T12:00:00Z');
  const calls = [];
  const invoice = { Id: invoiceId, CreatedFromDraftId: draftId, SupplierId: supplierId, InvoiceNumber: 'AV-3040-V1', CurrencyCode: 'SEK', TotalAmount: 40,
    IsCreditInvoice: false, Status: 1, VoucherId: voucherId, VoucherNumber: 'A1', RemainingAmountInvoiceCurrency: -40, PaymentStatus: 3, SkipSendToBank: true };
  const job = { source: copy(value.source), companyId: value.spirisCompanyId, status: 'accepted', environment: 'sandbox', draftId, supplierId,
    draft: { InvoiceNumber: invoice.InvoiceNumber, CurrencyCode: 'SEK', TotalAmount: 40 }, accounting: { paymentNetCents: 4000, offsetCents: 0 },
    tracking: { state: 'booked', invoiceId } };
  const send = async (operation, parameters, payload) => {
    calls.push({ operation, parameters: copy(parameters), payload: copy(payload) });
    if (operation === 'invoice') return { outcome: 'accepted', response: { ...invoice, ...(posted ? { RemainingAmountInvoiceCurrency: 0, PaymentStatus: 6 } : {}) } };
    if (operation === 'bankAccounts') return { outcome: 'accepted', response: { Data: [{ Id: value.spirisBankAccountId, IsActive: true, BankAccountType: 1, CurrencyCode: 'SEK' }], Meta: { CurrentPage: 1, TotalNumberOfPages: 1 } } };
    if (operation === 'recordPayment') { posted = true; return { outcome: 'accepted', httpStatus: 201, response: { BankTransactionId: transactionId } }; }
    if (operation === 'bankTransaction') return { outcome: 'accepted', response: { Id: transactionId, TransactionDate: '2026-10-13T12:00:00', Reference: calls.find(call => call.operation === 'recordPayment').payload.Reference,
      IsReconciled: true, TransactionAmount: -40, TransactionAmountCurrency: 'SEK', Rows: [{ SourceId: invoiceId, PaymentVoucherId: paymentVoucherId, PaymentVoucherNumber: 'B2', AmountTransactionCurrency: -40 }] } };
    assert.fail(`Unexpected operation ${operation}`);
  };
  const make = () => createVismaPayments({ organisationId: value.organisationId, getRepository: async () => repository, clock: () => now,
    proofProvider: async id => id === value.id ? copy(value) : null, config: () => ({ mode: 'sandbox', configured: true, expectedCompanyId: value.spirisCompanyId }),
    connection: async () => ({ generation: 'generation-a', companyVerified: true, company: { id: value.spirisCompanyId } }),
    target: async () => ({ settings: { enabled: true, sandbox: true, companyId: value.spirisCompanyId, enabledBy: { actualUserId: 'admin' } },
      job: booked ? copy(job) : { ...copy(job), tracking: { state: 'pending' } } }),
    batch: async (_scope, authorize, operation) => { await authorize(); return operation(async (...args) => { await authorize(); return send(...args); }); } });
  let service = make();
  const fixture = { value, calls, get service() { return service; }, setBooked: flag => { booked = flag; }, advance: () => { now = new Date(now.getTime() + 300001); },
    posts: () => calls.filter(call => call.operation === 'recordPayment'),
    stored: () => repository.read(state => copy(state.vismaPayments?.records.find(record => record.paymentId === value.id)), { domains: ['vismaPayments'] }),
    restart: async () => { await repository.close(); repository = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: () => ({}) }); service = make(); } };
  try { await run(fixture); } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('only verified bank ACSC registers a positive Spiris payment with SP-BANK reference exactly once', async () => withAccounting(async f => {
  f.setBooked(false); const waiting = await f.service.synchronize(f.value.id);
  assert.equal(waiting.status, 'waiting_booked'); assert.equal(f.posts().length, 0);
  f.setBooked(true); f.advance(); const result = await f.service.processQueue();
  assert.equal(result.processed, 1); assert.equal(result.payments[0].status, 'registered'); assert.equal(result.payments[0].paymentVoucherNumber, 'B2');
  assert.deepEqual(f.posts()[0].payload, { CompanyBankAccountId: f.value.spirisBankAccountId, PaymentDate: '2026-10-13', PaymentAmount: 40,
    PaymentCurrency: 'SEK', PaymentType: 2, Reference: `SP-BANK-${f.value.providerInstructionUUID}` });
  await f.restart(); await f.service.synchronize(f.value.id, { force: true }); assert.equal(f.posts().length, 1);
}));

test('altered bank proof cannot queue Spiris payment and a consistent recipient replacement changes the sealed proof', async () => withAccounting(async f => {
  const original = copy(f.value);
  for (const change of [value => { value.providerResult.transactionStatus = 'ACSP'; }, value => { value.providerResult.instructedAmount.amount = '41.00'; },
    value => { value.providerResult.creditorAccount.accountNumber = '9987654321'; }, value => { value.providerResult.instructedAmount.currency = 'EUR'; }]) {
    Object.assign(f.value, copy(original)); change(f.value);
    await assert.rejects(() => f.service.synchronize(f.value.id), error => error.code === 'visma_payment_proof_missing');
  }
  Object.assign(f.value, copy(original)); f.setBooked(false);
  assert.equal((await f.service.synchronize(f.value.id)).status, 'waiting_booked');
  f.value.paymentDetails.account = '9987654321';
  f.value.request.payload.creditorAccount.accountNumber = '9987654321'; f.value.providerResult.creditorAccount.accountNumber = '9987654321';
  assert.equal(verifiedBankPaymentProof(f.value), true, 'Evidence remains internally consistent, but differs from the journaled proof.');
  f.setBooked(true); f.advance();
  const result = await f.service.processQueue(); assert.equal(result.payments[0].status, 'blocked'); assert.equal(f.posts().length, 0);
}));

test('old Swish proof identity stays byte-compatible and uses its original SP-SWISH registration', async () => withAccounting(async f => {
  delete f.value.provider; f.value.mode = 'mss'; f.value.providerResult = { status: 'PAID', datePaid: '2026-10-13T08:47:00Z' };
  const legacyIdentity = [f.value.id, f.value.organisationId, f.value.providerInstructionUUID, f.value.providerPaymentReference,
    f.value.source.cardId, f.value.source.approvalId, f.value.source.version, f.value.source.hash, f.value.amountCents, f.value.currency,
    f.value.spirisCompanyId, f.value.spirisBankAccountId, f.value.providerResult.datePaid];
  f.setBooked(false); assert.equal((await f.service.synchronize(f.value.id)).status, 'waiting_booked');
  assert.equal((await f.stored()).proofHash, digest(legacyIdentity));
  f.setBooked(true); f.advance(); const result = await f.service.processQueue(); assert.equal(result.payments[0].status, 'registered');
  assert.equal(f.posts()[0].payload.Reference, `SP-SWISH-${f.value.providerInstructionUUID}`); assert.equal(f.posts().length, 1);
}));
