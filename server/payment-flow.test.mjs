import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { freezePurchaseAccounting } from './visma-accounting.mjs';
import { createSwishPayments } from './swish-payments.mjs';
import { createDocumentRepository } from './documents/storage.mjs';
import { createDocumentService } from './documents/model.mjs';
import { renderPdf } from './documents/render.mjs';

// Exercise the production service contracts together. Only the external OAuth,
// Spiris HTTP provider and Swish TLS transport are injected; no real API calls.
const context = { organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'combined-payment-flow',
  actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } };
const principal = { actor: context.actor, user: context.user };
const CARD = 2053, COMPANY = 'sandbox-company-opaque-123', SSN = '197709306828', PHONE = '+46711111132';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = values => json({ Data: values, Meta: { CurrentPage: 1, PageSize: 100, TotalNumberOfPages: 1, TotalNumberOfResults: values.length } });

async function workflow(run, { unknownConversion = false, deferBookkeeping = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-payment-flow-'));
  const application = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: initialApplicationState });
  const documentRepository = await createDocumentRepository({ env: {}, filename: join(directory, 'documents.sqlite') });
  const ids = Object.fromEntries(['supplier', 'draft', 'invoice', 'fiscalYear', 'terms', 'vat', 'bank', 'transaction', 'voucher', 'paymentVoucher'].map(key => [key, randomUUID()]));
  let time = new Date('2026-10-13T09:00:00Z'), draftPayload, converted = false, recorded = false, swishPaid = false;
  let failingBookkeeping = deferBookkeeping;
  const approvals = [], calls = [], swishCalls = [], swishRequests = new Map();
  const invoice = () => ({ ...structuredClone(draftPayload), Id: ids.invoice, CreatedFromDraftId: ids.draft, Status: 1,
    VoucherId: ids.voucher, VoucherNumber: 'A11', Number: 24, NumberSeries: 'L',
    RemainingAmountInvoiceCurrency: recorded ? 0 : draftPayload.TotalAmount, PaymentStatus: recorded ? 6 : 3,
    Rows: draftPayload.Rows.map(({ DebitAmount, ...row }) => ({ ...row, DebetAmount: DebitAmount })) });
  let paymentPayload;
  const bankTransaction = () => ({ Id: ids.transaction, Reference: paymentPayload.Reference, TransactionDate: '2026-10-13T00:00:00',
    TransactionAmount: -100, TransactionAmountCurrency: 'SEK', IsReconciled: true,
    Rows: [{ SourceId: ids.invoice, AmountTransactionCurrency: -100, PaymentVoucherId: ids.paymentVoucher, PaymentVoucherNumber: 'B12' }] });
  let swish;
  const visma = createVismaSandbox({ getRepository: async () => application,
    sourceProvider: async () => structuredClone(approvals), sitesProvider: async () => [{ id: 'norrtalje', name: 'Norrtälje' }],
    swishPaymentProvider: id => swish.readVerifiedPayment(id), now: () => time,
    authorizeBookingContext: async (actor, { siteId }) => {
      assert.equal(actor.organisationId, 'jeroc-demo'); assert.ok(actor.actorId && actor.effectiveUserId);
      if (siteId) assert.equal(siteId, 'norrtalje');
    },
    env: { VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'fixture-client', VISMA_CLIENT_SECRET: 'fixture-secret',
      VISMA_REDIRECT_URI: 'https://example.org/api/integrations/visma/oauth/callback', VISMA_SANDBOX_COMPANY_ID: COMPANY,
      VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    fetchImpl: async (url, options) => {
      const address = new URL(url), path = address.pathname;
      const payload = options.body?.startsWith('{') ? JSON.parse(options.body) : null;
      calls.push({ path, method: options.method, payload });
      if (address.hostname === 'identity.vismaonline.com') return json({ access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_in: 3600 });
      if (path === '/v2/companysettings') return json({ CompanyIdentifier: COMPANY, Name: 'Our sandbox' });
      if (path === '/v2/fiscalyears') return page([{ Id: ids.fiscalYear, StartDate: '2026-01-01T00:00:00Z', EndDate: '2026-12-31T00:00:00Z', IsLockedForAccounting: false }]);
      if (path.startsWith('/v2/accounts/')) return page([4000, 2440, 2641, 2645, 2614].map(number => ({ Number: String(number), Name: `Account ${number}`, FiscalYearId: ids.fiscalYear, IsActive: true })));
      if (path === '/v2/termsofpayments') return page([{ Id: ids.terms, Name: 'Direkt', NumberOfDays: 0, AvailableForPurchase: true }]);
      if (path === '/v2/vatcodes') return page([{ Id: ids.vat, Code: '20', Description: 'Inköp 25 %', VatRate: 25 }]);
      if (['/v2/costcenters', '/v2/projects'].includes(path)) return page([]);
      if (path === '/v2/suppliers') return options.method === 'POST' ? json({ Id: ids.supplier }, 201) : page([]);
      if (path === `/v2/suppliers/${ids.supplier}`) return json({ Id: ids.supplier, IsActive: true });
      if (path === '/v2/supplierinvoicedrafts' && options.method === 'POST') {
        assert.equal(draftPayload, undefined, 'One frozen settlement creates one invoice draft');
        draftPayload = structuredClone(payload); return json({ Id: ids.draft }, 201);
      }
      if (path === `/v2/supplierinvoicedrafts/${ids.draft}/convert`) {
        assert.equal(options.method, 'POST'); assert.equal(options.body, undefined);
        converted = true;
        if (unknownConversion) throw new Error('Connection dropped after Spiris committed conversion');
        return json(invoice(), 201);
      }
      if (path === `/v2/supplierinvoicedrafts/${ids.draft}`) return converted ? json({ ErrorCode: 3000 }, 400) : json({ ...structuredClone(draftPayload), Id: ids.draft });
      if (path === '/v2/supplierinvoices') return page(converted ? [invoice()] : []);
      if (path === `/v2/supplierinvoices/${ids.invoice}`) {
        if (swishPaid && failingBookkeeping) return json({ Message: 'Temporary accounting provider outage' }, 503);
        return json(invoice());
      }
      if (path === '/v2/bankaccounts') return page([{ Id: ids.bank, IsActive: true, Name: 'Företagskonto', BankAccountType: 1, LedgerAccountNumber: 1930, CurrencyCode: 'SEK' }]);
      if (path === `/v2/supplierinvoices/${ids.invoice}/payments` && options.method === 'POST') {
        assert.equal(recorded, false, 'No duplicate accounting payment POST'); recorded = true; paymentPayload = structuredClone(payload);
        return json({ BankTransactionId: ids.transaction }, 201);
      }
      if (path === `/v2/banktransactions/${ids.bank}/${ids.transaction}`) return json(bankTransaction());
      assert.fail(`Unexpected injected provider call: ${options.method} ${path}`);
    } });
  const documents = createDocumentService({ repository: documentRepository, now: () => time, renderPdf,
    sourceProvider: async () => ({ company: { id: 'jeroc-demo', name: 'JEROC Återvinning AB', number: '5593593626' },
      office: await application.read(state => structuredClone(state.office)), approvals: structuredClone(approvals),
      sites: [{ id: 'norrtalje', name: 'Norrtälje', address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' }] }) });
  swish = createSwishPayments({ getRepository: async () => application, sourceProvider: async () => structuredClone(approvals), now: () => time,
    assertPaymentReady: (...args) => visma.assertPaymentReady(...args),
    onPrepared: job => documents.archivePaymentRevision(job), onPaymentConfirmed: job => documents.archivePaymentConfirmation(job),
    onVerifiedPayment: (job, options) => visma.synchronizeSwishPayment(job.id, options),
    client: {
      configurationStatus: async () => ({ ready: true, mode: 'mss', merchantAlias: '1234679304', issues: [], missing: [] }),
      createPayout: async payload => {
        swishCalls.push({ method: 'POST', id: payload.payoutInstructionUUID }); swishRequests.set(payload.payoutInstructionUUID, structuredClone(payload));
        return { ok: true, statusCode: 201, environment: 'mss', data: { ...payload, status: 'CREATED' } };
      },
      getPayout: async id => {
        swishCalls.push({ method: 'GET', id }); assert.ok(swishRequests.has(id)); swishPaid = true;
        return { ok: true, statusCode: 200, environment: 'mss', data: { ...swishRequests.get(id), status: 'PAID',
          paymentReference: '9559320588048323', datePaid: new Date(time.getTime() - 1000).toISOString() } };
      },
    } });
  try {
    const oauth = await visma.begin(context);
    await visma.callback({ state: new URL(oauth.authorizationUrl).searchParams.get('state'), code: 'fixture-code', cookieBinding: oauth.cookieBinding });
    await visma.complete(context); await visma.lookupChoices(context);
    await visma.saveSettings({ expectedRevision: 0, settings: { revision: 0, enabled: true, exportMode: 'after_attest', companyId: COMPANY, sandbox: true,
      paymentTermDays: 0, paymentTermsId: ids.terms, accounts: { privatePurchase: 4000, reversePurchase: 4000, standardPurchase: 4000, noVatPurchase: 4000,
        supplierLiability: 2440, inputVat: 2641, inputReverseVat: 2645, outputReverseVat: 2614 },
      vatCodes: { reverse25: ids.vat, standard25: ids.vat }, sites: [{ siteId: 'norrtalje', useDefaults: true }] } }, context);
    const customer = await application.read(state => structuredClone(state.office.customers.find(value => value.id === 'customer-erik')));
    Object.assign(customer, { customerNumber: 'K1001', type: 'Privatperson', number: SSN, phone: PHONE });
    const rows = [{ articleId: 'copper-1', name: 'Koppar klass 1', taxCategory: 'scrap_reverse', weight: 1, price: 100, amount: 100 }];
    const settings = await visma.financeSettingsForCompany(customer);
    const accounting = freezePurchaseAccounting({ settings, customer, rows, siteId: 'norrtalje', offset: 0 });
    const approvalId = randomUUID();
    const card = await application.transact(state => {
      const selected = state.office.cards.find(value => value.id === CARD);
      Object.assign(selected, { status: 'ready', siteId: 'norrtalje', customerId: customer.id, origin: 'Testgatan 1, 761 41 Norrtälje', reference: 'Combined payout test',
        date: time.toISOString(), payment: 'Swish', paymentDetails: { method: 'swish', phone: PHONE, recipient: customer.name }, accounting,
        rows: [{ articleId: 'copper-1', weight: 1, price: 100, tier: 'C' }], pricingSnapshotId: 'combined-frozen-prices',
        financialPending: false, pricingRowsPending: false, customerApproval: { id: approvalId, version: 1, status: 'attested' } });
      return structuredClone(selected);
    });
    const snapshot = { hash: 'a'.repeat(64), card, customer, rows, gross: 100, net: 100, offset: 0, paymentMethod: 'swish',
      origin: card.origin, reference: card.reference, deliveredAt: card.date };
    approvals.push({ id: approvalId, cardId: CARD, siteId: 'norrtalje', version: 1, status: 'attested', approvedAt: time.toISOString(), approvedMethod: 'staff_checked_id_demo',
      approvedBy: 'Systemadmin', approvedHash: snapshot.hash, attestedAt: time.toISOString(), attestedBy: 'Systemadmin', snapshot });
    await swish.saveSettings({ enabled: true, bookkeepingEnabled: true, spirisCompanyId: COMPANY, spirisBankAccountId: ids.bank }, context);
    const input = { cardId: CARD, source: { approvalId, version: 1, hash: snapshot.hash },
      paymentDetails: { method: 'swish', phone: PHONE, recipient: customer.name, personalNumber: SSN } };
    await run({ application, approvals, visma, swish, documents, calls, swishCalls, ids, input,
      posts: path => calls.filter(call => call.method === 'POST' && call.path === path),
      advance: milliseconds => { time = new Date(time.getTime() + milliseconds); },
      restoreBookkeeping: () => { failingBookkeeping = false; } });
  } finally { await documentRepository.close(); await application.close(); await rm(directory, { recursive: true, force: true }); }
}

test('draft review, explicit booking, Swish proof, PDF and Spiris payment compose without duplicate writes', async () => workflow(async f => {
  const officeBefore = await f.application.read(state => structuredClone(state.office));
  const approvalBefore = structuredClone(f.approvals);
  await f.visma.processQueuedExports();
  assert.equal((await f.visma.cardBookingStatus(CARD, context)).status, 'draft');
  assert.equal((await f.swish.prepare(CARD, context)).canStart, false);
  await assert.rejects(() => f.swish.start(f.input, context), error => error.code === 'visma_payment_not_booked');
  assert.equal(f.swishCalls.length, 0);
  await f.visma.requestCardBooking({ cardId: CARD }, context); await f.visma.processQueuedExports({ reconcile: false });
  assert.equal((await f.visma.cardBookingStatus(CARD, context)).status, 'booked');
  const payout = await f.swish.start(f.input, context);
  await f.swish.processQueuedPayments(); f.advance(5000); await f.swish.processQueuedPayments();
  const paid = await f.swish.job(payout.id, context);
  assert.equal(paid.status, 'simulated_paid'); assert.equal(paid.paymentDocumentStatus, 'archived');
  assert.equal(paid.bookkeepingStatus, 'pending', 'Accounting outage cannot prevent confirmed payment PDF');
  assert.equal(f.posts(`/v2/supplierinvoices/${f.ids.invoice}/payments`).length, 0);
  const latest = (await f.documents.generateSettlement(CARD, { stage: 'final' }, principal)).document;
  assert.equal(latest.id, paid.paymentConfirmationDocument.documentId); assert.equal(latest.paymentConfirmation, true);
  const pdf = await f.documents.download(latest.id, principal);
  assert.equal(pdf.snapshot.paymentConfirmation.providerRef, '9559320588048323'); assert.equal(pdf.snapshot.paymentConfirmation.amountCents, 10000);
  assert.equal(pdf.snapshot.paymentConfirmation.maskedPersonalNumber, '•••• 6828');
  f.restoreBookkeeping();
  await f.swish.refresh(payout.id, context);
  assert.equal((await f.swish.job(payout.id, context)).bookkeepingStatus, 'registered');
  for (let index = 0; index < 3; index++) {
    await f.swish.refresh(payout.id, context); await f.swish.processQueuedPayments();
    await f.visma.requestCardBooking({ cardId: CARD }, context); await f.visma.processQueuedExports({ reconcile: false });
  }
  assert.equal(f.posts('/v2/supplierinvoicedrafts').length, 1);
  assert.equal(f.posts(`/v2/supplierinvoicedrafts/${f.ids.draft}/convert`).length, 1);
  assert.equal(f.posts(`/v2/supplierinvoices/${f.ids.invoice}/payments`).length, 1);
  assert.equal(f.swishCalls.filter(call => call.method === 'POST').length, 1);
  assert.ok(f.swishCalls.every(call => call.id === payout.providerInstructionUUID));
  const archived = await f.documents.list({ kind: 'settlement', sourceId: String(CARD) }, principal);
  assert.equal(archived.documents.filter(value => value.paymentConfirmation).length, 1);
  assert.deepEqual(await f.application.read(state => state.office), officeBefore);
  assert.deepEqual(f.approvals, approvalBefore, 'Simulation preserves approval and financial business state');
}, { deferBookkeeping: true }));

test('lost conversion response keeps payout gated and reconciles existing invoice without resending conversion', async () => workflow(async f => {
  await f.visma.processQueuedExports(); await f.visma.requestCardBooking({ cardId: CARD }, context);
  await f.visma.processQueuedExports({ reconcile: false });
  assert.equal((await f.visma.cardBookingStatus(CARD, context)).status, 'unknown');
  await assert.rejects(() => f.swish.start(f.input, context), error => error.code === 'visma_payment_not_booked');
  assert.equal(f.swishCalls.length, 0);
  await f.visma.refreshCardBooking(CARD, context);
  assert.equal((await f.visma.cardBookingStatus(CARD, context)).status, 'booked');
  assert.equal((await f.swish.prepare(CARD, context)).canStart, true);
  await f.visma.requestCardBooking({ cardId: CARD }, context); f.advance(300001);
  await f.visma.processQueuedExports({ reconcile: false });
  assert.equal(f.posts(`/v2/supplierinvoicedrafts/${f.ids.draft}/convert`).length, 1);
  assert.equal(f.posts('/v2/supplierinvoicedrafts').length, 1);
}, { unknownConversion: true }));
