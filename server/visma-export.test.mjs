import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationRepository } from './application-storage.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { createVismaStorage } from './visma-storage.mjs';
import { freezePurchaseAccounting } from './visma-accounting.mjs';
import { verifySpirisBookingRecord } from './visma-export.mjs';

const companyId = '55c5ec9b-4e91-4d10-b41e-c58f7ab0a0d2', supplierId = '1831c176-4020-4a9c-9fe5-1f8b2fdb0d91', draftId = '9841366b-4020-4a9c-9fe5-1f8b2fdb0d91';
const fiscalYearId = '6a767af7-43b7-42e8-9d10-cc3e1c02f7db', termsId = 'fe2a84d6-8f5b-4f4d-a606-69d57b73a2f6', vatId = 'ab0a0d20-4e91-4d10-b41e-c58f7ab0a0d2';
const context = { organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'live-session', actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } };
const body = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = values => body({ Data: values, Meta: { CurrentPage: 1, PageSize: 100, TotalNumberOfPages: 1, TotalNumberOfResults: values.length } });
const configuration = (extra = {}) => ({ revision: 0, enabled: true, exportMode: 'manual', companyId, sandbox: true, paymentTermDays: 0, paymentTermsId: termsId,
  accounts: { privatePurchase: 4000, reversePurchase: 4000, standardPurchase: 4000, noVatPurchase: 4000, supplierLiability: 2440, inputVat: 2641, inputReverseVat: 2645, outputReverseVat: 2614 },
  vatCodes: { reverse25: vatId, standard25: vatId }, sites: [{ siteId: 'yard', useDefaults: true }], ...extra });

function bookingProvider(f, { unknown = false, convert = true, tamper = false, paid = false } = {}) {
  let converted = false;
  const invoiceId = '587f2341-03d0-45b1-bd39-ff01bd1c2a38', voucherId = '6a3b0f40-6f5f-4071-8c74-2200019ab399';
  const record = final => {
    const submitted = f.posts().find(call => call.url.pathname === '/v2/supplierinvoicedrafts').payload;
    const document = { ...structuredClone(submitted), VatHigh: 0, VatMedium: 0, VatLow: 0, Id: final ? invoiceId : draftId };
    if (tamper) document.Rows[0].AccountNumber = 4999;
    if (final) Object.assign(document, { Status: 1, CreatedFromDraftId: draftId, VoucherId: voucherId, VoucherNumber: 'B124',
      RemainingAmountInvoiceCurrency: paid ? 0 : submitted.TotalAmount, Number: 24, NumberSeries: 'L',
      Rows: document.Rows.map(({ DebitAmount, ...row }) => ({ ...row, DebetAmount: DebitAmount })) });
    return document;
  };
  return {
    invoiceId,
    setConverted() { converted = true; },
    provider: async call => {
      if (call.url.pathname === `/v2/supplierinvoicedrafts/${draftId}/convert`) {
        assert.equal(call.method, 'POST'); assert.equal(call.payload, null, 'Documented conversion takes no request body');
        if (convert) converted = true;
        if (unknown) throw new Error('Fixture lost conversion response');
        return body(record(true), 201);
      }
      if (call.url.pathname === `/v2/supplierinvoicedrafts/${draftId}`) return converted ? body({ ErrorCode: 3000 }, 400) : body(record(false));
      if (call.url.pathname === '/v2/supplierinvoices') return page(converted ? [record(true)] : []);
      if (call.url.pathname === `/v2/supplierinvoices/${invoiceId}`) return body(record(true));
      return f.normalProvider(call);
    },
  };
}
async function fixture(run, { local = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-visma-export-')), filename = join(directory, 'application.sqlite');
  const repositoryEnv = {};
  let pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL && !local) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `jeroc_visma_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); repositoryEnv.DATABASE_URL = url.toString();
  }
  let repository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({ office: { sentinel: 'untouched' } }) });
  let time = new Date('2026-10-11T10:00:00Z'), revoked = false, bookingRevoked = false, provider;
  const calls = [], approvals = [], suppliers = [];
  const env = { VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'fixture-client', VISMA_CLIENT_SECRET: 'fixture-secret', VISMA_REDIRECT_URI: 'https://app.example/api/integrations/visma/oauth/callback',
    VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), VISMA_SANDBOX_COMPANY_ID: companyId };
  const normalProvider = async call => {
    if (call.url.pathname === '/v2/companysettings') return body({ CompanyIdentifier: companyId, Name: 'Fixture sandbox' });
    if (call.method === 'POST') return body({ Id: call.url.pathname === '/v2/suppliers' ? supplierId : draftId }, 201);
    if (call.url.pathname === '/v2/suppliers') return page(suppliers);
    if (call.url.pathname === `/v2/suppliers/${supplierId}`) return body({ Id: supplierId, IsActive: true });
    if (call.url.pathname === '/v2/fiscalyears') return page([{ Id: fiscalYearId, StartDate: '2026-01-01T00:00:00Z', EndDate: '2026-12-31T00:00:00Z', IsLockedForAccounting: false }]);
    if (call.url.pathname.startsWith('/v2/accounts/')) return page([4000, 2440, 2641, 2645, 2614].map(Number => ({ Number: String(Number), Name: `Account ${Number}`, FiscalYearId: fiscalYearId, IsActive: true })));
    if (call.url.pathname === '/v2/termsofpayments') return page([{ Id: termsId, Name: 'Direkt', NumberOfDays: 0, AvailableForPurchase: true }]);
    if (call.url.pathname === '/v2/vatcodes') return page([{ Id: vatId, Code: '20', Description: 'Inköp 25 %', VatRate: 25 }]);
    if (['/v2/costcenters', '/v2/projects'].includes(call.url.pathname)) return page([]);
    assert.fail(`Unexpected provider operation ${call.url}`);
  };
  provider = normalProvider;
  const fetchImpl = async (url, options) => {
    const call = { url: new URL(url), method: options.method, signal: options.signal, payload: options.body ? JSON.parse(options.body.startsWith('{') ? options.body : '{}') : null };
    calls.push(call);
    if (call.url.hostname === 'identity.vismaonline.com') return body({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
    return provider(call);
  };
  const otherRepositories = [];
  const inspector = createVismaStorage({ getRepository: async () => repository });
  const makeService = (selectedRepository, options = {}) => createVismaSandbox({ getRepository: async () => selectedRepository ?? repository, env, fetchImpl, now: () => time, ...options,
    sourceProvider: options.sourceProvider ?? (async () => structuredClone(approvals)), sitesProvider: async () => [{ id: 'yard', name: 'Testanläggning' }],
    authorizeBookingContext: async (principal, { siteId }) => {
      if (bookingRevoked || revoked || !principal.actorId || !principal.effectiveUserId || siteId && siteId !== 'yard') {
        const error = new Error('Bokföringsbehörighet saknas'); error.status = 403; error.code = 'forbidden'; throw error;
      }
    },
    authorizeContext: async () => { if (revoked) { const error = new Error('Session revoked'); error.status = 403; error.code = 'session_revoked'; throw error; } } });
  let service = makeService();
  const f = { calls, approvals, suppliers, env, normalProvider, postgres: Boolean(pool),
    makeService,
    readIntegration: operation => inspector.read(operation),
    transactIntegration: operation => inspector.transact(operation),
    withLookupTimeout: milliseconds => makeService(undefined, { lookupTimeoutMs: milliseconds }),
    get service() { return service; }, get repository() { return repository; },
    setProvider: handler => { provider = handler; }, revoke: () => { revoked = true; }, revokeBooking: () => { bookingRevoked = true; },
    advance: (milliseconds = 120001) => { time = new Date(time.getTime() + milliseconds); },
    posts: () => calls.filter(call => call.method === 'POST' && call.url.hostname === 'eaccountingapi.vismaonline.com'),
    async connect() { const started = await service.begin(context); await service.callback({ state: new URL(started.authorizationUrl).searchParams.get('state'), code: 'fixture-code', cookieBinding: started.cookieBinding }); await service.complete(context); },
    async enable(extra = {}) { await f.connect(); await service.lookupChoices(context); return (await service.saveSettings({ expectedRevision: 0, settings: configuration(extra) }, context)).settings; },
    async source(extra = {}) {
      const customer = { id: 'customer-1', customerNumber: 'K1001', name: 'Fixture seller', type: 'Privatperson', number: '199001011234', ...extra.customer }, settings = await service.financeSettingsForCompany(customer);
      const rows = extra.rows ?? [{ articleId: 'copper', name: 'Koppar', taxCategory: extra.taxCategory ?? 'scrap_reverse', weight: 10, price: 100, amount: 1000 }];
      const accounting = freezePurchaseAccounting({ settings, customer, rows, siteId: 'yard', offset: extra.offset ?? 0 });
      const approval = { id: randomUUID(), cardId: extra.cardId ?? 3016, version: 1, status: 'attested', approvedAt: time.toISOString(), approvedMethod: 'staff_checked_id_demo',
        approvedHash: 'a'.repeat(64), attestedAt: time.toISOString(), attestedBy: 'Fixture staff', attestedById: 'staff-1',
        snapshot: { hash: 'a'.repeat(64), card: { id: extra.cardId ?? 3016, accounting }, customer, rows, gross: accounting.gross, offset: accounting.offset, net: accounting.net, paymentMethod: 'cash' } };
      approvals.push(approval); return approval;
    },
    async restart() { await repository.close(); repository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({}) }); service = makeService(); },
    async newInstance() { const secondRepository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({}) }); otherRepositories.push(secondRepository); return makeService(secondRepository); },
    async integrationLockAvailable() { return pool ? (await pool.query('SELECT pg_try_advisory_xact_lock(1860399453) AS available')).rows[0].available : true; },
  };
  try { await run(f); } finally {
    for (const extra of otherRepositories) await extra.close();
    await repository.close();
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('finance settings are company-scoped, revision guarded and select only actual provider choices', async () => fixture(async f => {
  const initial = await f.service.settings(context); assert.equal(initial.settings.revision, 0); assert.equal(initial.settings.paymentTermDays, 0); assert.deepEqual(initial.settings.accounts, {}); assert.equal(f.calls.length, 0);
  await f.connect(); const choices = await f.service.lookupChoices(context); assert.equal(choices.suggestedPaymentTermsId, termsId); assert.deepEqual(choices.settings.accounts, {});
  assert.equal(f.posts().length, 0, 'Lookups never create accounts');
  const saved = await f.service.saveSettings({ expectedRevision: 0, settings: configuration() }, context); assert.equal(saved.settings.revision, 1);
  await assert.rejects(() => f.service.saveSettings({ expectedRevision: 0, settings: configuration() }, context), error => error.code === 'revision_conflict');
  await assert.rejects(() => f.service.saveSettings({ expectedRevision: 1, settings: configuration({ accounts: { privatePurchase: 4999 } }) }, context), error => error.code === 'visma_account_invalid');
  await assert.rejects(() => f.service.saveSettings({ expectedRevision: 1, settings: configuration({ companyId: 'other' }) }, context), error => error.code === 'accounting_company_mismatch');
  const before = f.calls.length; const preview = await f.service.preview({ example: 'private', siteId: 'yard', amount: 1000, date: '2026-10-11' }, context);
  assert.equal(preview.draft.TotalAmount, 1000); assert.equal(preview.draft.DueDate, '2026-10-11'); assert.equal(f.calls.length, before);
}));

test('explicit booking converts the existing frozen draft once and gates payout on verified booked invoice', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f); f.setProvider(remote.provider);
  await f.service.processQueuedExports();
  const before = await f.service.cardBookingStatus(approval.cardId, context);
  assert.equal(before.status, 'draft'); assert.equal(before.canBook, true);
  const source = { cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash };
  await assert.rejects(() => f.service.assertPaymentReady(source), error => error.code === 'visma_payment_not_booked');
  const queue = await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  assert.equal(queue.status, 'booking'); assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 0, 'Reservation does no provider I/O');
  await f.service.processQueuedExports({ reconcile: false });
  const complete = await f.service.cardBookingStatus(approval.cardId, context);
  assert.equal(complete.status, 'booked'); assert.equal(complete.invoiceId, remote.invoiceId); assert.equal(complete.voucherNumber, 'B124');
  const proof = await f.service.assertPaymentReady(source, { fresh: true });
  assert.equal(proof.status, 'booked'); assert.equal(proof.invoiceId, remote.invoiceId); assert.equal(proof.draftId, draftId);
  await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false }); await f.service.refreshCardBooking(approval.cardId, context);
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 1, 'No second invoice draft');
}));

test('a positive 240 SEK draft and booked DebetAmount invoice retain strict payment readiness', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' });
  const approval = await f.source({ rows: [{ articleId: 'copper', name: 'Koppar', taxCategory: 'scrap_reverse', weight: 10, price: 24, amount: 240 }] });
  const remote = bookingProvider(f); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'booked');
  assert.equal(f.posts().find(call => call.url.pathname === '/v2/supplierinvoicedrafts').payload.TotalAmount, 240);
  const source = { cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash };
  assert.equal((await f.service.assertPaymentReady(source, { fresh: true })).status, 'booked');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
}));

function amountBookingRecord() {
  const draft = { InvoiceNumber: 'AV-3016-V1', CurrencyCode: 'SEK', TotalAmount: 240, Vat: 0, IsCreditInvoice: false, SkipSendToBank: true,
    InvoiceDate: '2026-10-11', DueDate: '2026-10-11', Rows: [{ AccountNumber: 4000, DebitAmount: 240, CreditAmount: 0 },
      { AccountNumber: 2440, DebitAmount: 0, CreditAmount: 240 }] };
  const invoiceId = '587f2341-03d0-45b1-bd39-ff01bd1c2a38';
  return { job: { draft, draftId, supplierId, tracking: { invoiceId } }, record: { ...structuredClone(draft), Id: invoiceId, SupplierId: supplierId,
    VatHigh: 0, VatMedium: 0, VatLow: 0, CreatedFromDraftId: draftId, Status: 1, VoucherId: '6a3b0f40-6f5f-4071-8c74-2200019ab399', VoucherNumber: 'B124',
    Rows: draft.Rows.map(({ DebitAmount, ...row }) => ({ ...row, DebetAmount: DebitAmount })) } };
}

test('malformed provider totals, VAT and row amounts identify the original field without exposing values', () => {
  const fields = ['TotalAmount', 'Vat', 'VatHigh', 'VatMedium', 'VatLow', 'Rows[0].DebitAmount', 'Rows[0].DebetAmount', 'Rows[1].CreditAmount'];
  for (const field of fields) for (const value of [-240, '', '240,00', 'private-provider-text', Infinity, true, { privateValue: 'secret' }]) {
    const { job, record } = amountBookingRecord();
    const row = /^Rows\[(\d+)\]\.(\w+)$/.exec(field);
    if (row) record.Rows[Number(row[1])][row[2]] = value;
    else record[field] = value;
    assert.throws(() => verifySpirisBookingRecord(record, job, true), error => {
      assert.equal(error.code, 'accounting_amount_invalid'); assert.equal(error.status, 409); assert.ok(error.message.includes(field));
      assert.deepEqual(error.details, { provider: 'spiris', field, valueType: typeof value });
      assert.equal(error.message.includes('private-provider-text'), false); assert.equal(JSON.stringify(error.details).includes('secret'), false);
      return true;
    }, field);
  }
  for (const value of [null, undefined, []]) {
    const { job, record } = amountBookingRecord(); record.TotalAmount = value;
    assert.throws(() => verifySpirisBookingRecord(record, job, true), error => {
      assert.equal(error.code, 'accounting_amount_invalid');
      assert.deepEqual(error.details, { provider: 'spiris', field: 'TotalAmount', valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : 'undefined' });
      return true;
    });
  }
});

test('provider amount diagnostics preserve row alias priority, nullish zero defaults and accounting identity gates', () => {
  const { job, record } = amountBookingRecord();
  record.Rows[0].DebitAmount = 240; record.Rows[0].DebetAmount = -240;
  record.Rows[1].DebetAmount = null; record.Rows[0].CreditAmount = null; record.Vat = null; delete record.VatHigh;
  assert.equal(verifySpirisBookingRecord(record, job, true), record);
  for (const mutate of [value => { value.SupplierId = randomUUID(); }, value => { value.TotalAmount = 239; },
    value => { value.Rows[0].AccountNumber = 4999; }, value => { value.Rows[0].ProjectId = randomUUID(); },
    value => { value.Rows.pop(); }, value => { value.CreatedFromDraftId = randomUUID(); }, value => { value.Status = 0; },
    value => { value.VoucherId = null; }]) {
    const candidate = structuredClone(record); mutate(candidate);
    assert.throws(() => verifySpirisBookingRecord(candidate, job, true), error => ['visma_booking_identity_conflict', 'visma_booking_unverified'].includes(error.code));
  }
});

test('malformed draft amounts remain blocked before conversion with durable field diagnostics', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f);
  f.setProvider(async call => {
    const response = await remote.provider(call);
    if (call.url.pathname !== `/v2/supplierinvoicedrafts/${draftId}`) return response;
    const document = await response.json(); document.Rows[0].DebitAmount = -1000; return body(document);
  });
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  const status = await f.service.cardBookingStatus(approval.cardId, context);
  assert.equal(status.status, 'failed'); assert.equal(status.error.code, 'accounting_amount_invalid');
  assert.deepEqual(status.error.details, { provider: 'spiris', field: 'Rows[0].DebitAmount', valueType: 'number' });
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 0);
}));

test('attest booking intent survives restart and uses original actual/effective authorisation', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  approval.spirisAction = 'book'; approval.bookingRequestedBy = { actualUserId: 'admin', effectiveUserId: 'admin' };
  approval.bookingConnection = await f.service.checkAttestBooking(approval, context);
  const remote = bookingProvider(f); f.setProvider(remote.provider); await f.restart();
  await f.service.processQueuedExports();
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'booked');
  const stored = await f.readIntegration(document => document.tenants['jeroc-demo'].finance.outbox[0]);
  assert.deepEqual(stored.booking.requestedBy, approval.bookingRequestedBy);
  assert.equal(stored.booking.scope.generation, approval.bookingConnection.generation);
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
}));

test('lost conversion response recovers by readback after restart without a second POST', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f, { unknown: true }); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'unknown');
  await f.restart(); f.advance(300001); await f.service.processQueuedExports({ reconcile: false });
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'booked');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
}));

test('simultaneous booking workers reserve one conversion and unknown outcomes stop automatic polling', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f, { unknown: true, convert: false }); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  const second = f.makeService(f.repository);
  await Promise.all([f.service.processQueuedExports({ reconcile: false }), second.processQueuedExports({ reconcile: false })]);
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
  for (let attempt = 0; attempt < 8; attempt++) { f.advance(300001); await f.service.processQueuedExports({ reconcile: false }); }
  const status = await f.service.cardBookingStatus(approval.cardId, context);
  assert.equal(status.status, 'failed'); assert.equal(status.canBook, false);
  const before = f.calls.length; f.advance(300001); await f.service.processQueuedExports({ reconcile: false });
  await f.service.processAccountingTracking(); assert.equal(f.calls.length, before, 'Uncertain conversion has finite automatic followup');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
}));

test('changed accounting rows block conversion; revoked booking rights and connection pin cannot dispatch', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f, { tamper: true }); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'failed');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 0);
  f.setProvider(bookingProvider(f).provider); await f.service.requestCardBooking({ cardId: approval.cardId }, context); f.revokeBooking();
  await f.service.processQueuedExports({ reconcile: false });
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 0, 'Both principals must remain authorised at dispatch');
}));

test('reconnected Spiris generation pauses an automatic booking intent before dispatch', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  approval.spirisAction = 'book'; approval.bookingRequestedBy = { actualUserId: 'admin', effectiveUserId: 'admin' };
  approval.bookingConnection = await f.service.checkAttestBooking(approval, context);
  const remote = bookingProvider(f); f.setProvider(remote.provider);
  await f.service.disconnect(context); await f.connect(); await f.service.processQueuedExports();
  assert.equal((await f.service.cardBookingStatus(approval.cardId, context)).status, 'paused');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 0);
}));

test('confirmed booking still blocks a new payout when the supplier invoice is paid externally', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  const paid = bookingProvider(f, { paid: true }); paid.setConverted(); f.setProvider(paid.provider);
  await assert.rejects(() => f.service.assertPaymentReady({ cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash }),
    error => error.code === 'visma_payment_already_recorded');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
}));

test('fresh payment readbacks identify invalid amounts and still require exact unpaid balances', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const approval = await f.source();
  const remote = bookingProvider(f); f.setProvider(remote.provider);
  await f.service.processQueuedExports(); await f.service.requestCardBooking({ cardId: approval.cardId }, context);
  await f.service.processQueuedExports({ reconcile: false });
  const source = { cardId: approval.cardId, approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash };
  const cases = [
    ['TotalAmount', -1000, 'accounting_amount_invalid'], ['VatLow', 'provider-private-text', 'accounting_amount_invalid'],
    ['Rows[0].DebetAmount', -1000, 'accounting_amount_invalid'], ['Rows[1].CreditAmount', '', 'accounting_amount_invalid'],
    ['RemainingAmountInvoiceCurrency', -1000, 'accounting_amount_invalid'], ['RemainingAmount', -1000, 'accounting_amount_invalid'],
    ['RemainingAmountInvoiceCurrency', undefined, 'visma_payment_already_recorded'], ['RemainingAmountInvoiceCurrency', null, 'visma_payment_already_recorded'],
    ['RemainingAmountInvoiceCurrency', '1000.00', 'visma_payment_already_recorded'], ['RemainingAmount', null, 'visma_payment_already_recorded'],
    ['RemainingAmount', '1000.00', 'visma_payment_already_recorded'], ['RemainingAmount', '', 'visma_payment_already_recorded'],
    ['RemainingAmountInvoiceCurrency', 0, 'visma_payment_already_recorded'], ['RemainingAmountInvoiceCurrency', 999, 'visma_payment_already_recorded'],
    ['RemainingAmount', 0, 'visma_payment_already_recorded'], ['RemainingAmount', 999, 'visma_payment_already_recorded'],
  ];
  for (const [field, value, code] of cases) {
    f.setProvider(async call => {
      const response = await remote.provider(call);
      if (call.url.pathname !== `/v2/supplierinvoices/${remote.invoiceId}`) return response;
      const document = await response.json(), row = /^Rows\[(\d+)\]\.(\w+)$/.exec(field);
      if (row) document.Rows[Number(row[1])][row[2]] = value;
      else document[field] = value;
      return body(document);
    });
    await assert.rejects(() => f.service.assertPaymentReady(source, { fresh: true }), error => {
      assert.equal(error.code, code); assert.equal(error.status, 409); assert.ok(error.message.includes(field));
      assert.deepEqual(error.details, { provider: 'spiris', field, valueType: value === null ? 'null' : typeof value });
      assert.equal(error.message.includes('provider-private-text'), false); return true;
    }, field);
  }
  f.setProvider(async call => {
    const response = await remote.provider(call);
    if (call.url.pathname !== `/v2/supplierinvoices/${remote.invoiceId}`) return response;
    const document = await response.json(); document.RemainingAmount = 1000; document.PaymentStatus = 3; return body(document);
  });
  assert.equal((await f.service.assertPaymentReady(source, { fresh: true })).status, 'booked');
  f.setProvider(async call => {
    const response = await remote.provider(call);
    if (call.url.pathname !== `/v2/supplierinvoices/${remote.invoiceId}`) return response;
    const document = await response.json(); document.PaymentStatus = 2; return body(document);
  });
  await assert.rejects(() => f.service.assertPaymentReady(source, { fresh: true }), error => error.code === 'visma_payment_already_recorded');
  assert.equal(f.posts().filter(call => call.url.pathname.endsWith('/convert')).length, 1);
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 1);
}));

test('status and accounting settings project one tenant snapshot without historical runs, exports or credentials', async () => fixture(async f => {
  await f.enable();
  const expected = await f.service.settings(context), extraTerm = randomUUID();
  await f.transactIntegration(document => {
    const tenant = document.tenants['jeroc-demo'];
    tenant.runs.push({ id: randomUUID(), startedAt: '2026-10-01T00:00:00Z', response: { historical: 'x'.repeat(2 * 1024 * 1024) } });
    tenant.finance.outbox.push({ historical: 'y'.repeat(1024 * 1024) });
    tenant.finance.mappings.secretHistory = { supplierResponse: 'not-needed-for-settings' };
    tenant.finance.settingsHistory[companyId].unused = { historical: 'z'.repeat(1024 * 1024) };
    tenant.finance.choices[companyId].paymentTerms.push({ id: extraTerm, days: 1, availableForPurchase: true, name: '1 dag' });
    document.tenants['another-tenant'] = { company: { id: 'other' }, secretHistory: 'other-tenant-private' };
  });
  const before = await f.repository.read((state, revision) => ({ state, revision })), projections = [];
  const projectedRepository = {
    kind: f.repository.kind,
    read() { assert.fail('These lightweight reads must not deserialize the full integration document'); },
    readProjection(operation, options) {
      projections.push(options);
      return f.repository.readProjection((state, revision) => {
        const tenant = state.vismaIntegration.tenants['jeroc-demo'];
        assert.equal(state.vismaIntegration.tenants['another-tenant'], undefined);
        assert.equal(tenant.runs, undefined); assert.equal(tenant.audit, undefined);
        if (tenant.tokens) assert.deepEqual(Object.keys(tenant.tokens), ['version']);
        if (tenant.finance) for (const key of ['outbox', 'mappings', 'settingsHistory']) assert.equal(tenant.finance[key], undefined);
        assert.ok(JSON.stringify(state).length < 10000, 'Historical response size cannot enlarge a settings/status snapshot');
        return operation(state, revision);
      }, options);
    },
  };
  const service = f.makeService(projectedRepository), callCount = f.calls.length;
  assert.deepEqual(await service.integrationStatus(context), { mode: 'test', configured: true, connected: true, failed: false, lastCheckedAt: '2026-10-11T10:00:00.000Z' });
  assert.equal(projections.length, 1); assert.ok(projections[0].paths.every(path => path[2] !== 'finance'));
  projections.length = 0;
  const result = await service.settings(context);
  assert.equal(projections.length, 1, 'Status, settings and cached choices are one consistent read');
  assert.deepEqual(result.settings, expected.settings); assert.deepEqual(result.company, expected.company);
  assert.equal(result.companyVerified, true); assert.equal(result.choices.accounts.length, expected.choices.accounts.length);
  assert.equal(result.choices.paymentTerms.length, 2); assert.equal(result.suggestedPaymentTermsId, termsId);
  projections.length = 0;
  const selected = await service.financeSettingsForCompany({ paymentTermDays: 1 });
  assert.equal(selected.paymentTermsId, extraTerm); assert.equal(selected.paymentTermDays, 1);
  assert.equal(projections.length, 2);
  assert.deepEqual(projections[0].paths, [['tenants', 'jeroc-demo', 'finance', 'settings', companyId]]);
  assert.deepEqual(projections[1].paths, [['tenants', 'jeroc-demo', 'finance', 'choices', companyId, 'paymentTerms']]);
  await assert.rejects(() => service.settings({ ...context, organisationId: 'another-tenant' }), error => error.status === 403);
  assert.equal(f.calls.length, callCount, 'Local status/settings never call Spiris');
  assert.deepEqual(await f.repository.read((state, revision) => ({ state, revision })), before, 'Projected reads do not mutate or bump revisions');
}, { local: true }));

test('custom repositories without projection support still read settings once and preserve public results', async () => fixture(async f => {
  await f.enable(); const expected = await f.service.settings(context); let reads = 0;
  const repository = { kind: f.repository.kind, read(operation, options) { reads++; return f.repository.read(operation, options); } };
  assert.deepEqual(await f.makeService(repository).settings(context), expected);
  assert.equal(reads, 1, 'The fallback is also one snapshot rather than three reads');
}, { local: true }));

test('settings lookup fetches three complete 1,413-account plans in six large pages with one company check', { timeout: 5000 }, async () => fixture(async f => {
  await f.connect();
  const years = [2025, 2026, 2027].map(year => ({ Id: randomUUID(), StartDate: `${year}-01-01T00:00:00Z`, EndDate: `${year}-12-31T00:00:00Z`, IsLockedForAccounting: false }));
  const start = f.calls.length; let inFlight = 0, maxInFlight = 0;
  const runsBefore = await f.readIntegration(document => document.tenants['jeroc-demo'].runs.length);
  f.setProvider(async call => {
    if (call.url.pathname === '/v2/fiscalyears') return page(years);
    if (!call.url.pathname.startsWith('/v2/accounts/')) return f.normalProvider(call);
    const yearId = call.url.pathname.split('/').at(-1), currentPage = Number(call.url.searchParams.get('$page'));
    assert.equal(call.url.searchParams.get('$pagesize'), '1000'); assert.ok(years.some(year => year.Id === yearId));
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 10));
      const offset = (currentPage - 1) * 1000, length = Math.min(1000, 1413 - offset);
      // Normal detailed Spiris records exceed the previous 256 KiB response
      // limit for a documented full page, but fit the bounded read budget.
      const data = Array.from({ length }, (_, index) => ({ Number: String(1000 + offset + index), Name: `Account ${offset + index}`, FiscalYearId: yearId, IsActive: true, Detail: 'x'.repeat(600) }));
      return body({ Data: data, Meta: { CurrentPage: currentPage, PageSize: 1000, TotalNumberOfPages: 2, TotalNumberOfResults: 1413 } });
    } finally { inFlight--; }
  });
  const result = await f.service.lookupChoices(context), calls = f.calls.slice(start);
  assert.equal(result.choices.accounts.length, 4239);
  for (const year of years) assert.equal(result.choices.accounts.filter(account => account.fiscalYearId === year.Id).length, 1413);
  assert.equal(calls.filter(call => call.url.pathname.startsWith('/v2/accounts/')).length, 6);
  assert.equal(calls.filter(call => call.url.pathname === '/v2/companysettings').length, 1);
  assert.ok(maxInFlight > 1, 'Independent fiscal-year reads must overlap'); assert.ok(maxInFlight <= 4);
  assert.ok(calls.every(call => call.method === 'GET')); assert.equal(f.posts().length, 0);
  const stored = await f.readIntegration(document => document.tenants['jeroc-demo']);
  assert.equal(stored.runs.length, runsBefore, 'Settings reads do not repeatedly journal full raw account pages');
  assert.equal(stored.audit.at(-1).action, 'visma.accounting_choices_fetched');
  assert.equal(stored.audit.at(-1).accounts, 4239);
}));

test('settings lookup starts account plans as soon as fiscal years arrive while projects are still pending', { timeout: 5000 }, async () => fixture(async f => {
  await f.connect(); let releaseProjects, sawAccount, projectCompleted = false, timer;
  const projectsHeld = new Promise(resolve => { releaseProjects = resolve; });
  const accountStarted = new Promise(resolve => { sawAccount = resolve; });
  f.setProvider(async call => {
    if (call.url.pathname === '/v2/projects') { await projectsHeld; projectCompleted = true; }
    if (call.url.pathname.startsWith('/v2/accounts/')) { assert.equal(projectCompleted, false); sawAccount(); }
    return f.normalProvider(call);
  });
  const lookup = f.service.lookupChoices(context);
  try {
    await Promise.race([accountStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Account plans incorrectly waited for the project response')), 1000); })]);
  } finally { clearTimeout(timer); releaseProjects(); }
  const result = await lookup;
  assert.equal(projectCompleted, true); assert.equal(result.choices.accounts.length, 5);
}));

for (const change of ['revoke', 'disconnect']) test(`settings pages recheck ${change === 'revoke' ? 'live permissions' : 'connection generation'} before the next GET and never replace the previous cache`, { timeout: 5000 }, async () => fixture(async f => {
  await f.connect(); const previous = (await f.service.lookupChoices(context)).choices;
  let release, entered, accountCalls = 0;
  const wait = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  f.setProvider(async call => {
    if (!call.url.pathname.startsWith('/v2/accounts/')) return f.normalProvider(call);
    accountCalls++; entered(); await wait;
    return body({ Data: [{ Number: '4000', Name: 'Inköp', FiscalYearId: fiscalYearId }],
      Meta: { CurrentPage: 1, PageSize: 1000, TotalNumberOfPages: 2, TotalNumberOfResults: 2 } });
  });
  const lookup = f.service.lookupChoices(context); await ready;
  if (change === 'revoke') f.revoke(); else await f.service.disconnect(context);
  release(); await assert.rejects(() => lookup, error => ['session_revoked', 'visma_not_connected'].includes(error.code));
  assert.equal(accountCalls, 1, 'The next page cannot dispatch after permission/connection changes');
  const stored = await f.readIntegration(document => document.tenants['jeroc-demo'].finance.choices[companyId]);
  assert.deepEqual(stored, previous); assert.equal(f.posts().length, 0);
}));

test('whole settings lookup timeout aborts outstanding reads and retains the complete cached choices', { timeout: 5000 }, async () => fixture(async f => {
  await f.connect(); const previous = (await f.service.lookupChoices(context)).choices;
  let active = 0, aborted = 0;
  f.setProvider(call => {
    if (!call.url.pathname.startsWith('/v2/accounts/')) return f.normalProvider(call);
    active++;
    return new Promise((resolve, reject) => {
      const abort = () => { active--; aborted++; reject(call.signal.reason); };
      if (call.signal.aborted) abort(); else call.signal.addEventListener('abort', abort, { once: true });
    });
  });
  const started = performance.now();
  await assert.rejects(() => f.withLookupTimeout(50).lookupChoices(context), error => error.status === 504 && error.code === 'visma_lookup_timeout');
  assert.ok(performance.now() - started < 1000); assert.equal(active, 0); assert.equal(aborted, 1);
  const callsAfterFailure = f.calls.length;
  assert.deepEqual((await f.service.settings(context)).choices, previous);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, callsAfterFailure, 'A timed-out batch cannot continue fetching or publish a partial cache');
  assert.equal(f.posts().length, 0);
}));

test('manual export matches exact supplier number, stores mapping and returned draft ID durably', async () => fixture(async f => {
  await f.enable(); await f.source(); f.suppliers.push({ Id: supplierId, SupplierNumber: 'K1001', IsActive: true });
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'accepted'); assert.equal(result.draftId, draftId); assert.equal(result.supplierId, supplierId);
  assert.equal(f.posts().length, 1); const post = f.posts()[0]; assert.equal(post.url.searchParams.get('useDefaultVatCodes'), 'false'); assert.equal(post.url.searchParams.get('calculateVatOnCostAccounts'), 'false');
  assert.equal(post.payload.SkipSendToBank, true); assert.equal(post.payload.TotalAmount, 1000); assert.equal(post.payload.DueDate, '2026-10-11');
  const count = f.calls.length; await f.restart(); assert.deepEqual(await f.service.sendExport({ cardId: 3016 }, context), result); assert.equal(f.calls.length, count);
  const minimal = JSON.stringify(await f.service.cardExportProjection(3016)); assert.equal(minimal.includes('BankAccountNumber'), false); assert.equal(minimal.includes('Rows'), false);
  assert.deepEqual(await f.repository.read(state => state.office), { sentinel: 'untouched' });
}));

test('private supplier creation never sends a personnummer or matches on it', async () => fixture(async f => {
  await f.enable(); await f.source(); f.suppliers.push({ Id: randomUUID(), CorporateIdentityNumber: '199001011234', IsActive: true });
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'accepted'); assert.equal(f.posts().length, 2);
  const supplier = f.posts()[0].payload; assert.equal(supplier.CorporateIdentityNumber, undefined); assert.equal(supplier.TermsOfPaymentId, termsId); assert.equal(supplier.UsesAutomaticInvoicePostToLedger, false);
  assert.equal(JSON.stringify(f.posts()).includes('199001011234'), false);
  await f.source({ cardId: 3017 }); await f.service.sendExport({ cardId: 3017 }, context); assert.equal(f.posts().filter(call => call.url.pathname === '/v2/suppliers').length, 1);
}));

test('business organisation fallback must be unique and ambiguous matches never dispatch writes', async () => fixture(async f => {
  await f.enable(); await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '5593593626' } });
  f.suppliers.push({ Id: supplierId, CorporateIdentityNumber: '559359-3626', IsActive: true }, { Id: randomUUID(), CorporateIdentityNumber: '5593593626', IsActive: true });
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'visma_supplier_ambiguous'); assert.equal(f.posts().length, 0);
}));

test('unknown supplier and draft POST results survive restart without automatically retrying', async () => fixture(async f => {
  await f.enable(); await f.source();
  f.setProvider(call => call.method === 'POST' ? Promise.reject(new Error('Lost supplier response')) : f.normalProvider(call));
  const unknown = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(unknown.status, 'unknown'); assert.equal(f.posts().length, 1);
  await f.restart(); f.setProvider(f.normalProvider); assert.deepEqual(await f.service.sendExport({ cardId: 3016 }, context), unknown); assert.equal(f.posts().length, 1);
  await f.source({ cardId: 3017 }); const next = await f.service.sendExport({ cardId: 3017 }, context); assert.equal(next.status, 'blocked'); assert.equal(next.error.code, 'visma_supplier_review'); assert.equal(f.posts().length, 1);
}));

test('unknown draft retains supplier mapping and never duplicates the invoice', async () => fixture(async f => {
  await f.enable(); await f.source();
  f.setProvider(call => call.method === 'POST' && call.url.pathname === '/v2/supplierinvoicedrafts' ? Promise.reject(new Error('Lost draft response')) : f.normalProvider(call));
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'unknown'); assert.equal(result.supplierId, supplierId); assert.equal(f.posts().length, 2);
  await f.restart(); assert.deepEqual(await f.service.sendExport({ cardId: 3016 }, context), result); assert.equal(f.posts().length, 2);
}));

test('automatic worker discovers only frozen authorised attest versions and uses service audit identity', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); await f.source();
  f.approvals.push({ ...structuredClone(f.approvals[0]), id: randomUUID(), cardId: 3017, snapshot: { ...f.approvals[0].snapshot, card: { id: 3017 } } });
  assert.equal((await f.service.processQueuedExports()).processed, 1); assert.equal(f.posts().length, 2);
  const jobs = await f.service.exports(context); assert.equal(jobs.exports.length, 1); assert.equal(jobs.exports[0].trigger, 'after_attest'); assert.equal(jobs.exports[0].status, 'accepted');
  const audits = await f.readIntegration(document => document.tenants['jeroc-demo'].audit);
  assert.equal(audits.find(item => item.action === 'visma.export_queued').actualUserId, 'service:spiris-export');
  assert.equal(audits.find(item => item.action === 'visma.export_queued').attestActorId, 'staff-1');
  await f.restart(); await f.service.processQueuedExports(); assert.equal(f.posts().length, 2);
}));

test('automatic reconciliation reads sources once and skips unchanged attest versions before accounting lookups', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); await f.source(); let sourceReads = 0;
  const worker = f.makeService(undefined, { sourceProvider: async () => { sourceReads++; return structuredClone(f.approvals); } });
  assert.equal((await worker.processQueuedExports()).processed, 1);
  const providerCalls = f.calls.length; sourceReads = 0;
  assert.equal((await worker.processQueuedExports()).processed, 0);
  assert.equal(sourceReads, 1, 'An unchanged pass reads one authoritative source snapshot, without rereading every approval to enqueue it again');
  assert.equal(f.calls.length, providerCalls);
  const next = structuredClone(f.approvals[0]); next.id = randomUUID(); next.version = 2; f.approvals.push(next);
  assert.equal((await worker.processQueuedExports()).processed, 1, 'A new frozen version is discovered despite the earlier known source');
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/suppliers').length, 1);
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 2);
}));

test('prefill, export preparation and every pre-dispatch source check request only the selected weight card', async () => fixture(async f => {
  await f.enable(); await f.source(); const requests = [];
  const service = f.makeService(undefined, { sourceProvider: async request => {
    requests.push(request);
    return structuredClone(f.approvals.filter(approval => request?.cardId === undefined || approval.cardId === request.cardId));
  } });
  assert.equal((await service.prefill(3016, context)).source.cardId, 3016);
  assert.equal((await service.preview({ cardId: 3016 }, context)).eligible, true);
  assert.equal((await service.sendExport({ cardId: 3016 }, context)).status, 'accepted');
  assert.ok(requests.length >= 5, 'Source validity still gets checked again before provider dispatch');
  assert.ok(requests.every(request => request?.cardId === 3016), 'Single-card actions cannot read the complete source journal');
}));

test('attest hints survive a busy worker and periodic queue drains avoid full source scans', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); const requests = [];
  const worker = f.makeService(undefined, { sourceProvider: async request => {
    requests.push(request);
    return structuredClone(f.approvals.filter(approval => request?.cardId === undefined || approval.cardId === request.cardId));
  } });
  assert.equal((await worker.processQueuedExports()).processed, 0, 'Startup performs one authoritative empty reconciliation');
  assert.deepEqual(requests, [undefined]); requests.length = 0;
  await f.source(); await f.source({ cardId: 3017 });
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.setProvider(async call => {
    if (call.method === 'POST' && call.url.pathname === '/v2/suppliers') { entered(); await held; }
    return f.normalProvider(call);
  });
  const first = worker.processQueuedExports({ cardId: 3016, reconcile: false });
  await reached;
  assert.deepEqual(await worker.processQueuedExports({ cardId: 3017, reconcile: false }), { processed: 0 });
  release(); assert.equal((await first).processed, 1);
  assert.ok(requests.every(request => request?.cardId === 3016)); requests.length = 0;
  assert.equal((await worker.processQueuedExports({ reconcile: false })).processed, 1, 'The next pass consumes the hint received during the first export');
  assert.ok(requests.length > 0); assert.ok(requests.every(request => request?.cardId === 3017)); requests.length = 0;
  const calls = f.calls.length;
  assert.equal((await worker.processQueuedExports({ reconcile: false })).processed, 0);
  assert.deepEqual(requests, []); assert.equal(f.calls.length, calls);
  f.advance(); f.advance(); f.advance();
  assert.equal((await worker.processQueuedExports({ reconcile: false })).processed, 0);
  assert.deepEqual(requests, [undefined], 'An authoritative full reconciliation remains available periodically even without hints');
  assert.equal(f.calls.length, calls);
}));

test('PostgreSQL keeps integration journals outside the business aggregate and preserves export idempotence after restart', async t => fixture(async f => {
  if (!f.postgres) { t.skip('Requires isolated PostgreSQL'); return; }
  await f.enable(); await f.source(); const result = await f.service.sendExport({ cardId: 3016 }, context);
  assert.equal(result.status, 'accepted');
  const compact = await f.repository.read(state => state.vismaIntegration.tenants['jeroc-demo']);
  assert.equal(compact.runs, undefined); assert.equal(compact.audit, undefined);
  for (const key of ['outbox', 'choices', 'settingsHistory', 'mappings']) assert.equal(compact.finance[key], undefined);
  assert.equal(compact.finance.settings[companyId].enabled, true);
  const complete = await f.readIntegration(document => document.tenants['jeroc-demo']);
  assert.equal(complete.finance.outbox[0].draftId, draftId); assert.ok(complete.runs.length > 0); assert.ok(complete.audit.length > 0);
  const calls = f.calls.length; await f.restart();
  assert.deepEqual(await f.service.sendExport({ cardId: 3016 }, context), result); assert.equal(f.calls.length, calls);
  assert.equal((await f.service.settings(context)).choices.accounts.length, 5);
  assert.equal((await f.service.status(context)).connected, true);
}));

test('explicit manually queued work resumes after restart while automatic discovery remains disabled', async () => fixture(async f => {
  await f.enable(); await f.source(); const queued = await f.service.enqueueExport({ cardId: 3016 }, context); assert.equal(queued.status, 'queued'); assert.equal(f.posts().length, 0);
  await f.source({ cardId: 3017 }); await f.restart(); assert.equal((await f.service.processQueuedExports()).processed, 1); assert.equal(f.posts().length, 2);
  assert.equal((await f.service.exports(context)).exports.length, 1);
}));

test('legacy, changed, inconsistent and offset sources are blocked before provider dispatch', async () => fixture(async f => {
  await f.enable(); const approval = await f.source(); const count = f.calls.length;
  await assert.rejects(() => f.service.sendExport({ cardId: 3016, source: { cardId: 3016, approvalId: approval.id, version: 2, hash: approval.snapshot.hash } }, context), error => error.code === 'visma_source_changed');
  approval.snapshot.gross = 999; await assert.rejects(() => f.service.sendExport({ cardId: 3016 }, context), error => error.code === 'visma_source_incomplete');
  delete approval.snapshot.card.accounting; assert.equal((await f.service.preview({ cardId: 3016 }, context)).eligible, false);
  await f.source({ cardId: 3017, offset: 100 }); await assert.rejects(() => f.service.sendExport({ cardId: 3017 }, context), error => error.code === 'visma_accounting_blocked');
  assert.equal(f.calls.length, count);
}));

test('manual session is revalidated after company lookup immediately before POST', async () => fixture(async f => {
  await f.enable(); await f.source(); let suppliersRead = false;
  f.setProvider(call => { if (call.url.pathname === '/v2/suppliers' && call.method === 'GET') suppliersRead = true;
    if (call.url.pathname === '/v2/companysettings' && suppliersRead) f.revoke(); return f.normalProvider(call); });
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'rejected'); assert.equal(f.posts().length, 0);
}));

test('supplier identifiers cannot be truncated, leak personnummer, or contradict a matched legal entity', async () => fixture(async f => {
  await f.enable(); await f.source({ customer: { customerNumber: 'TOO-LONG-CUSTOMER-NUMBER' } });
  await assert.rejects(() => f.service.sendExport({ cardId: 3016 }, context), error => error.code === 'visma_supplier_number_invalid');
  await f.source({ cardId: 3017, customer: { customerNumber: '199001011234' } });
  await assert.rejects(() => f.service.sendExport({ cardId: 3017 }, context), error => error.code === 'visma_supplier_number_invalid');
  await f.source({ cardId: 3018, customer: { type: 'Företag', vatRegistered: true, number: '5593593626' } });
  f.suppliers.push({ Id: supplierId, SupplierNumber: 'K1001', CorporateIdentityNumber: '5570000000', IsActive: true });
  const conflict = await f.service.sendExport({ cardId: 3018 }, context); assert.equal(conflict.error.code, 'visma_supplier_identity_conflict'); assert.equal(f.posts().length, 0);
}));

test('actual VAT codes with contradictory rates cannot be assigned to a 25 percent purchase', async () => fixture(async f => {
  await f.connect();
  f.setProvider(call => call.url.pathname === '/v2/vatcodes' ? page([{ Id: vatId, Code: '6', Description: 'Moms 6 %', VatRate: 6 }]) : f.normalProvider(call));
  await f.service.lookupChoices(context);
  await assert.rejects(() => f.service.saveSettings({ expectedRevision: 0, settings: configuration() }, context), error => error.code === 'visma_vat_invalid');
}));

test('Spiris fractional VAT rates and old raw caches normalize to percent for settings, validation and preview without refetching', async () => fixture(async f => {
  await f.connect();
  const values = [0, 0.06, 0.12, 0.25];
  f.setProvider(call => call.url.pathname === '/v2/vatcodes' ? page(values.map(rate => ({ Id: rate === 0.25 ? vatId : randomUUID(), Code: String(rate), Description: 'Spiris moms', VatRate: rate }))) : f.normalProvider(call));
  const fetched = await f.service.lookupChoices(context);
  assert.deepEqual(fetched.choices.vatCodes.map(code => code.rate), [0, 6, 12, 25]); assert.equal(fetched.choices.vatRateUnit, 'percent');
  await f.transactIntegration(document => {
    const cached = document.tenants['jeroc-demo'].finance.choices[companyId];
    delete cached.vatRateUnit; cached.vatCodes.forEach(code => { code.rate /= 100; });
  });
  const calls = f.calls.length;
  assert.deepEqual((await f.service.settings(context)).choices.vatCodes.map(code => code.rate), [0, 6, 12, 25]);
  const saved = await f.service.saveSettings({ expectedRevision: 0, settings: configuration() }, context);
  assert.equal(saved.settings.vatCodes.standard25, vatId);
  const preview = await f.service.preview({ example: 'standard_25', siteId: 'yard', amount: 1000, date: '2026-10-11' }, context);
  assert.equal(preview.eligible, true); assert.equal(preview.draft.Vat, 250);
  assert.equal(f.calls.length, calls, 'Old choices are repaired on read without another Spiris request');
  const cached = await f.readIntegration(document => document.tenants['jeroc-demo'].finance.choices[companyId]);
  assert.equal(cached.vatCodes.at(-1).rate, 0.25, 'Read normalization does not rewrite accounting history or old cache');
  await f.transactIntegration(document => {
    const choices = document.tenants['jeroc-demo'].finance.choices[companyId];
    choices.vatRateUnit = 'percent'; choices.vatCodes = [{ id: randomUUID(), code: '1', name: 'One percent', rate: 1 }];
  });
  assert.equal((await f.service.settings(context)).choices.vatCodes[0].rate, 1, 'An explicit percent unit prevents double normalization');
}));

test('company standard VAT exports the approved gross while leaving source economics untouched', async () => fixture(async f => {
  await f.enable(); const source = await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '5593593626' }, taxCategory: 'standard_25' });
  const before = structuredClone(source); const exported = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(exported.status, 'accepted');
  const draft = f.posts().find(call => call.url.pathname === '/v2/supplierinvoicedrafts').payload;
  assert.equal(draft.TotalAmount, 1250); assert.equal(draft.Vat, 250); assert.equal(draft.Rows.find(row => row.AccountNumber === 2440).CreditAmount, 1250);
  assert.deepEqual(source, before);
}));

test('simultaneous requests share one source job and never dispatch a supplier twice', async () => fixture(async f => {
  await f.enable(); await f.source(); const secondService = await f.newInstance(); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { entered = resolve; });
  f.setProvider(async call => { if (call.method === 'POST' && call.url.pathname === '/v2/suppliers') { entered(); await gate; } return f.normalProvider(call); });
  const first = f.service.sendExport({ cardId: 3016 }, context);
  await dispatched;
  const second = await secondService.sendExport({ cardId: 3016 }, context); assert.equal(second.status, 'processing'); assert.equal(f.posts().length, 1);
  release(); assert.equal((await first).status, 'accepted'); assert.equal(f.posts().length, 2);
}));

test('restart recovers a returned supplier ID from its durable run before drafting', async () => fixture(async f => {
  await f.enable(); await f.source(); const result = await f.service.sendExport({ cardId: 3016 }, context);
  // Reconstruct a crash after the supplier response was persisted, before the
  // mapping/outbox stage update committed. The supplier run itself is retained.
  await f.transactIntegration(document => {
    const finance = document.tenants['jeroc-demo'].finance, job = finance.outbox[0], mapping = Object.values(finance.mappings)[0];
    delete mapping.supplierId; mapping.status = 'reserved'; delete job.supplierId; delete job.draftId; job.status = 'processing'; job.stage = 'supplier';
    job.lease = { id: randomUUID(), until: '2026-10-11T09:00:00Z' };
    const runs = document.tenants['jeroc-demo'].runs;
    const draft = runs.find(run => run.id === job.runs.draftRequestId); runs.splice(runs.indexOf(draft), 1);
  });
  await f.restart(); const resumed = await f.service.processExport(result.id, context); assert.equal(resumed.status, 'accepted');
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/suppliers').length, 1);
}));

test('turning exports off blocks a queued manual job and provider dispatch', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.enqueueExport({ cardId: 3016 }, context);
  await f.service.saveSettings({ expectedRevision: 1, settings: configuration({ enabled: false }) }, context);
  const count = f.calls.length; await assert.rejects(() => f.service.processExport(job.id, context), error => error.code === 'visma_export_disabled');
  assert.equal(f.calls.length, count); assert.equal(f.posts().length, 0);
}));

test('automatic processing retains the frozen revision after settings are edited', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' }); await f.source();
  await f.service.saveSettings({ expectedRevision: 1, settings: configuration({ exportMode: 'after_attest', paymentTermDays: 0 }) }, context);
  assert.equal((await f.service.processQueuedExports()).processed, 1);
  const job = (await f.service.exports(context)).exports[0]; assert.equal(job.settingsRevision, 1); assert.equal(job.status, 'accepted');
}));

test('customer override selects a unique genuine provider payment term before review', async () => fixture(async f => {
  const customTermsId = randomUUID(); await f.enable();
  f.setProvider(call => call.url.pathname === '/v2/termsofpayments' ? page([{ Id: termsId, Name: 'Direkt', NumberOfDays: 0, AvailableForPurchase: true },
    { Id: customTermsId, Name: '14 dagar', NumberOfDays: 14, AvailableForPurchase: true }]) : f.normalProvider(call));
  await f.service.lookupChoices(context);
  const effective = await f.service.financeSettingsForCompany({ paymentTermDays: 14 }); assert.equal(effective.paymentTermsId, customTermsId); assert.equal(effective.paymentTermDays, 14); assert.equal(effective.revision, 1);
  const defaultValue = await f.service.financeSettingsForCompany(); assert.equal(defaultValue.paymentTermsId, termsId); assert.equal(defaultValue.paymentTermDays, 0);
  await assert.rejects(() => f.service.financeSettingsForCompany({ paymentTermDays: 30 }), error => error.code === 'accounting_payment_terms_unmapped');
  await f.source({ customer: { paymentTermDays: 14 } }); const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'accepted');
  assert.equal(f.posts().find(call => call.url.pathname === '/v2/suppliers').payload.TermsOfPaymentId, customTermsId);
  assert.equal(f.posts().find(call => call.url.pathname === '/v2/supplierinvoicedrafts').payload.DueDate, '2026-10-25');
}));

test('supplier deduplication reads every documented page before matching or creation', async () => fixture(async f => {
  await f.enable(); await f.source();
  f.setProvider(call => {
    if (call.url.pathname !== '/v2/suppliers') return f.normalProvider(call);
    const current = Number(call.url.searchParams.get('$page'));
    return body({ Data: current === 1 ? [{ Id: randomUUID(), SupplierNumber: 'OTHER', IsActive: true }] : [{ Id: supplierId, SupplierNumber: 'K1001', IsActive: true }],
      Meta: { CurrentPage: current, PageSize: 100, TotalNumberOfPages: 2, TotalNumberOfResults: 2 } });
  });
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'accepted');
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/suppliers').length, 0);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v2/suppliers' && call.method === 'GET').length, 2);
}));

test('unverifiable partial supplier lists cannot authorize creation', async () => fixture(async f => {
  await f.enable(); await f.source();
  f.setProvider(call => call.url.pathname === '/v2/suppliers' ? body([]) : f.normalProvider(call));
  const result = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'visma_lookup_incomplete'); assert.equal(f.posts().length, 0);
}));

test('sample previews enforce real account dimension constraints from cache without provider calls', async () => fixture(async f => {
  await f.enable();
  f.setProvider(async call => {
    const result = await f.normalProvider(call);
    if (!call.url.pathname.startsWith('/v2/accounts/')) return result;
    const document = await result.json(); document.Data.find(account => account.Number === '4000').IsFirstCostCenterMandatory = true; return body(document);
  });
  const refreshed = await f.service.lookupChoices(context); assert.equal(refreshed.choices.accounts.find(account => account.number === 4000).firstCostCenterMandatory, true);
  const calls = f.calls.length;
  await assert.rejects(() => f.service.preview({ example: 'private', siteId: 'yard', amount: 1000, date: '2026-10-11' }, context), error => error.code === 'visma_dimension_required');
  assert.equal(f.calls.length, calls);
}));

test('provider calls happen after the integration reservation commits and releases its PostgreSQL lock', async t => fixture(async f => {
  if (!f.postgres) { t.skip('Requires isolated PostgreSQL'); return; }
  await f.enable(); await f.source(); let writes = 0;
  f.setProvider(async call => {
    if (call.method === 'POST') { writes++; assert.equal(await f.integrationLockAvailable(), true, 'Provider POST cannot hold the durable integration lock'); }
    return f.normalProvider(call);
  });
  const exported = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(exported.status, 'accepted'); assert.equal(writes, 2);
}));

const invoiceId = '11111111-4020-4a9c-9fe5-1f8b2fdb0d91', voucherId = '22222222-4020-4a9c-9fe5-1f8b2fdb0d91';
function trackingProvider(f, mode, { invoice = {}, listing, draft = {}, onGet } = {}) {
  return async call => {
    if (['/v2/supplierinvoicedrafts/', '/v2/supplierinvoices'].some(path => call.url.pathname.startsWith(path)) && call.method === 'GET') {
      await onGet?.(call);
      const record = { Id: invoiceId, CreatedFromDraftId: draftId, SupplierId: supplierId, InvoiceNumber: 'AV-3016-V1', TotalAmount: 1000,
        CurrencyCode: 'SEK', Status: 1, VoucherId: voucherId, VoucherNumber: 'A123', ...invoice };
      if (call.url.pathname === `/v2/supplierinvoicedrafts/${draftId}`) return mode === 'exists'
        ? body({ Id: draftId, SupplierId: supplierId, InvoiceNumber: 'AV-3016-V1', TotalAmount: 1000, CurrencyCode: 'SEK', ...draft })
        : body({ message: 'missing' }, mode === 'unavailable' ? 503 : mode === 'denied' ? 403 : 404);
      if (call.url.pathname === '/v2/supplierinvoices') return listing ? body(listing) : page(mode === 'booked' ? [record] : []);
      if (call.url.pathname === `/v2/supplierinvoices/${invoiceId}`) return body(record);
    }
    return f.normalProvider(call);
  };
}

test('automatic prequeue validation blockers are durable and visible on the card without provider writes or repeated events', async () => fixture(async f => {
  await f.enable({ exportMode: 'after_attest' });
  await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '55935936261' } });
  await f.service.processQueuedExports();
  const status = await f.service.cardExportProjection(3016);
  assert.equal(status.status, 'blocked'); assert.match(status.error.message, /organisationsnummer/);
  assert.equal(status.events[0].type, 'local_blocked'); assert.ok(status.events[0].id);
  assert.equal(status.canRefresh, false); assert.equal(status.canRecreate, false); assert.equal(f.posts().length, 0);
  await f.service.processQueuedExports(); await f.restart(); await f.service.processQueuedExports();
  assert.equal((await f.service.exports(context)).exports.length, 1);
  assert.deepEqual((await f.service.cardExportProjection(3016)).events, status.events);
}));

test('bookkeeping checks are due-only read batches without polling journal spam and stop on verified final invoice', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'exists'));
  const journalBefore = await f.readIntegration(document => document.tenants['jeroc-demo'].runs.length), before = f.calls.length;
  assert.equal((await f.service.processAccountingTracking()).checked, 0); assert.equal(f.calls.length, before);
  f.advance(300001); assert.equal((await f.service.processAccountingTracking()).checked, 1);
  const pending = await f.service.cardExportProjection(3016); assert.equal(pending.tracking.state, 'pending'); assert.ok(pending.tracking.lastCheckedAt);
  assert.equal(await f.readIntegration(document => document.tenants['jeroc-demo'].runs.length), journalBefore);
  assert.equal(pending.events.length, job.events.length, 'No repeated success event for each poll');
  f.setProvider(trackingProvider(f, 'booked')); f.advance(300001);
  await f.service.processAccountingTracking(); const booked = await f.service.cardExportProjection(3016);
  assert.equal(booked.status, 'accepted'); assert.equal(booked.tracking.state, 'booked'); assert.equal(booked.tracking.voucherNumber, 'A123');
  assert.equal(booked.tracking.invoiceId, invoiceId); assert.equal(booked.canRecreate, false); assert.equal(booked.canRefresh, false);
  assert.equal(booked.events.filter(event => event.type === 'booked').length, 1);
  const after = f.calls.length; f.advance(86400000); await f.service.processAccountingTracking(); assert.equal(f.calls.length, after);
  assert.equal(f.posts().length, 2, 'Tracking cannot book, approve or send payments');
}));

test('a missing draft alone cannot prove deletion or bookkeeping, incomplete and ambiguous results cannot enable recreation', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'missing', { listing: { Data: [], Meta: { CurrentPage: 1, TotalNumberOfPages: 1, TotalNumberOfResults: 1 } } }));
  let checked = await f.service.refreshExport(job.id, context); assert.equal(checked.tracking.state, 'pending'); assert.equal(checked.tracking.error.code, 'visma_tracking_incomplete');
  assert.equal((await f.service.cardExportProjection(3016)).canRecreate, false);
  f.setProvider(trackingProvider(f, 'booked', { invoice: { CreatedFromDraftId: randomUUID() } }));
  checked = await f.service.refreshExport(job.id, context); assert.equal(checked.tracking.state, 'attention'); assert.equal(checked.tracking.error.code, 'visma_tracking_ambiguous');
  assert.equal(f.posts().length, 2);
}));

test('final invoice needs Normal status, exact draft identity and a real voucher before bookkeeping is confirmed', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  for (const invoice of [{ Status: 0 }, { Status: 2 }, { VoucherId: null }, { VoucherId: '00000000-0000-0000-0000-000000000000' }, { VoucherNumber: '' }, { SupplierId: randomUUID() }, { TotalAmount: 999 }]) {
    f.setProvider(trackingProvider(f, 'booked', { invoice }));
    const checked = await f.service.refreshExport(job.id, context);
    assert.equal(checked.tracking.state, 'attention'); assert.equal((await f.service.cardExportProjection(3016)).canRecreate, false);
    assert.equal(checked.events.filter(event => event.type === 'booked').length, 0);
  }
  assert.equal(f.posts().length, 2);
}));

test('missing is confirmed twice with separation; active recreation retains the locked data and does not duplicate double clicks or restart', async () => fixture(async f => {
  await f.enable(); await f.source(); const original = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'missing'));
  await f.service.refreshExport(original.id, context);
  await f.service.refreshExport(original.id, context); assert.equal((await f.service.cardExportProjection(3016)).canRecreate, false, 'Immediate repeated click is not a second absence confirmation');
  f.advance(300001); await f.service.refreshExport(original.id, context);
  assert.equal((await f.service.cardExportProjection(3016)).canRecreate, true);
  const newDraftId = randomUUID(), missing = trackingProvider(f, 'missing');
  f.setProvider(call => call.method === 'POST' && call.url.pathname === '/v2/supplierinvoicedrafts' ? body({ Id: newDraftId }, 201) : missing(call));
  const requestId = randomUUID();
  const [a, b] = await Promise.allSettled([f.service.recreateExport(original.id, { requestId }, context), f.service.recreateExport(original.id, { requestId }, context)]);
  const succeeded = [a, b].find(result => result.status === 'fulfilled' && result.value.status === 'accepted');
  assert.ok(succeeded, 'Exactly one concurrent request must complete the recreation');
  for (const result of [a, b]) assert.ok(result.status === 'fulfilled' || result.reason.code === 'visma_tracking_busy');
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 2);
  const posts = f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts'); assert.deepEqual(posts[1].payload, posts[0].payload);
  const latest = await f.service.cardExportProjection(3016); assert.equal(latest.draftId, newDraftId); assert.equal(latest.relatedAttemptIds.length, 2);
  assert.equal(latest.events.filter(event => event.type === 'draft_recreated').length, 1);
  await f.restart(); const repeated = await f.service.recreateExport(original.id, { requestId }, context); assert.equal(repeated.id, succeeded.value.id);
  assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 2);
}));

test('recreation is blocked if an invoice reappears or the attested source changes; unknown recreation is never resent', async () => fixture(async f => {
  await f.enable(); await f.source(); const original = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'missing')); await f.service.refreshExport(original.id, context); f.advance(300001); await f.service.refreshExport(original.id, context);
  f.setProvider(trackingProvider(f, 'booked'));
  await assert.rejects(() => f.service.recreateExport(original.id, { requestId: randomUUID() }, context), error => error.code === 'visma_recreate_exists');
  assert.equal((await f.service.cardExportProjection(3016)).tracking.state, 'booked');
  await f.transactIntegration(document => { document.tenants['jeroc-demo'].finance.outbox.find(job => job.id === original.id).tracking.state = 'missing'; });
  f.setProvider(trackingProvider(f, 'missing')); f.approvals[0].snapshot.hash = 'b'.repeat(64);
  await assert.rejects(() => f.service.recreateExport(original.id, { requestId: randomUUID() }, context), error => ['visma_source_changed', 'visma_source_unattested'].includes(error.code));
  f.approvals[0].snapshot.hash = 'a'.repeat(64);
  const missing = trackingProvider(f, 'missing'); f.setProvider(call => call.method === 'POST' && call.url.pathname === '/v2/supplierinvoicedrafts' ? body({ message: 'lost' }, 503) : missing(call));
  const recreated = await f.service.recreateExport(original.id, { requestId: randomUUID() }, context); assert.equal(recreated.status, 'unknown');
  await f.restart(); await f.service.processQueuedExports(); assert.equal(f.posts().filter(call => call.url.pathname === '/v2/supplierinvoicedrafts').length, 2);
}));

test('disconnect pauses tracking, only a verified same-company reconnection resumes, and expiry has finite retention', async () => fixture(async f => {
  await f.enable({ trackingMaxDays: 2 }); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'exists')); await f.service.disconnect(context);
  const before = f.calls.length; f.advance(300001); await f.service.processAccountingTracking(); assert.equal(f.calls.length, before);
  assert.equal((await f.service.cardExportProjection(3016)).tracking.state, 'paused');
  await f.connect(); await f.service.processAccountingTracking(); assert.equal((await f.service.cardExportProjection(3016)).tracking.state, 'pending');
  f.env.VISMA_SANDBOX_COMPANY_ID = randomUUID(); const switched = await f.service.cardExportProjection(3016); assert.equal(switched.tracking.state, 'paused'); assert.equal(switched.canRecreate, false);
  await assert.rejects(() => f.service.refreshExport(job.id, context), error => ['visma_tracking_paused', 'visma_company_mismatch'].includes(error.code));
  f.env.VISMA_SANDBOX_COMPANY_ID = companyId;
  f.advance(2 * 86400000); const expiryBefore = f.calls.length; await f.service.processAccountingTracking();
  const expired = await f.service.cardExportProjection(3016); assert.equal(expired.tracking.state, 'expired'); assert.equal(expired.tracking.nextCheckAt, null);
  assert.equal(f.calls.length, expiryBefore, 'Expired work stops before provider calls');
  f.advance(86400000); await f.service.processAccountingTracking(); assert.equal(f.calls.length, expiryBefore);
}));

test('transient tracking errors back off and access failures require reconnection or an explicit retry', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  f.setProvider(trackingProvider(f, 'unavailable')); let checked = await f.service.refreshExport(job.id, context);
  assert.equal(checked.status, 'accepted'); assert.equal(checked.tracking.failureCount, 1);
  checked = await f.service.refreshExport(job.id, context); assert.equal(checked.tracking.failureCount, 2);
  assert.equal(Date.parse(checked.tracking.nextCheckAt) - Date.parse(checked.tracking.lastAttemptAt), 600000);
  f.setProvider(trackingProvider(f, 'denied')); checked = await f.service.refreshExport(job.id, context); assert.equal(checked.tracking.state, 'paused');
  const before = f.calls.length; f.advance(86400000); await f.service.processAccountingTracking(); assert.equal(f.calls.length, before);
  await f.connect(); f.setProvider(trackingProvider(f, 'exists')); await f.service.processAccountingTracking();
  assert.equal((await f.service.cardExportProjection(3016)).tracking.state, 'pending');
}));


test('a valid sole-trader identifier is normalized to a business CIN while private identifiers remain absent', async () => fixture(async f => {
  await f.enable();
  await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '19930623-6374' } });
  const first = await f.service.sendExport({ cardId: 3016 }, context); assert.equal(first.status, 'accepted');
  const supplier = f.posts().find(call => call.url.pathname === '/v2/suppliers'); assert.equal(supplier.payload.CorporateIdentityNumber, '9306236374');
  assert.equal(JSON.stringify(supplier.payload).includes('19930623'), false);
}));

test('converted draft HTTP 400 ResourceNotFound resolves bookkeeping; unrelated 400 diagnostics never expose provider body', async () => fixture(async f => {
  await f.enable(); await f.source(); const job = await f.service.sendExport({ cardId: 3016 }, context);
  const booked = trackingProvider(f, 'booked');
  f.setProvider(call => call.url.pathname === `/v2/supplierinvoicedrafts/${draftId}`
    ? body({ ErrorCode: 2000, DeveloperErrorMessage: 'PRIVATE_PROVIDER_MESSAGE', secret: 'PRIVATE_PROVIDER_SECRET' }, 400) : booked(call));
  const failed = await f.service.refreshExport(job.id, context); assert.equal(failed.tracking.state, 'pending');
  assert.equal(failed.tracking.error.httpStatus, 400); assert.equal(failed.tracking.error.providerErrorCode, 2000);
  assert.equal(JSON.stringify(await f.service.cardExportProjection(3016)).includes('PRIVATE_PROVIDER'), false);
  assert.equal(f.calls.filter(call => call.url.pathname === '/v2/supplierinvoices').length, 0);
  f.setProvider(call => call.url.pathname === `/v2/supplierinvoicedrafts/${draftId}`
    ? body({ ErrorCode: 3000, DeveloperErrorMessage: 'SupplierInvoiceNotFound' }, 400) : booked(call));
  const result = await f.service.refreshExport(job.id, context); assert.equal(result.tracking.state, 'booked');
  assert.equal(result.tracking.voucherNumber, 'A123'); assert.equal(result.tracking.error, undefined);
  assert.equal(f.posts().length, 2, 'Bookkeeping tracking makes no provider writes');
}));
