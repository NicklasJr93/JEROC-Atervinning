import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationRepository } from './application-storage.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { freezePurchaseAccounting } from './visma-accounting.mjs';

const companyId = '55c5ec9b-4e91-4d10-b41e-c58f7ab0a0d2', supplierId = '1831c176-4020-4a9c-9fe5-1f8b2fdb0d91', draftId = '9841366b-4020-4a9c-9fe5-1f8b2fdb0d91';
const fiscalYearId = '6a767af7-43b7-42e8-9d10-cc3e1c02f7db', termsId = 'fe2a84d6-8f5b-4f4d-a606-69d57b73a2f6', vatId = 'ab0a0d20-4e91-4d10-b41e-c58f7ab0a0d2';
const context = { organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'live-session', actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } };
const body = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const page = values => body({ Data: values, Meta: { CurrentPage: 1, PageSize: 100, TotalNumberOfPages: 1, TotalNumberOfResults: values.length } });
const configuration = (extra = {}) => ({ revision: 0, enabled: true, exportMode: 'manual', companyId, sandbox: true, paymentTermDays: 0, paymentTermsId: termsId,
  accounts: { privatePurchase: 4000, reversePurchase: 4000, standardPurchase: 4000, noVatPurchase: 4000, supplierLiability: 2440, inputVat: 2641, inputReverseVat: 2645, outputReverseVat: 2614 },
  vatCodes: { reverse25: vatId, standard25: vatId }, sites: [{ siteId: 'yard', useDefaults: true }], ...extra });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-visma-export-')), filename = join(directory, 'application.sqlite');
  const repositoryEnv = {};
  let pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `jeroc_visma_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); repositoryEnv.DATABASE_URL = url.toString();
  }
  let repository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({ office: { sentinel: 'untouched' } }) });
  let time = new Date('2026-10-11T10:00:00Z'), revoked = false, provider;
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
    const call = { url: new URL(url), method: options.method, payload: options.body ? JSON.parse(options.body.startsWith('{') ? options.body : '{}') : null };
    calls.push(call);
    if (call.url.hostname === 'identity.vismaonline.com') return body({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
    return provider(call);
  };
  const otherRepositories = [];
  const makeService = selectedRepository => createVismaSandbox({ getRepository: async () => selectedRepository ?? repository, env, fetchImpl, now: () => time,
    sourceProvider: async () => structuredClone(approvals), sitesProvider: async () => [{ id: 'yard', name: 'Testanläggning' }],
    authorizeContext: async () => { if (revoked) { const error = new Error('Session revoked'); error.status = 403; error.code = 'session_revoked'; throw error; } } });
  let service = makeService();
  const f = { calls, approvals, suppliers, env, normalProvider, postgres: Boolean(pool),
    get service() { return service; }, get repository() { return repository; },
    setProvider: handler => { provider = handler; }, revoke: () => { revoked = true; }, advance: () => { time = new Date(time.getTime() + 120001); },
    posts: () => calls.filter(call => call.method === 'POST' && call.url.hostname === 'eaccountingapi.vismaonline.com'),
    async connect() { const started = await service.begin(context); await service.callback({ state: new URL(started.authorizationUrl).searchParams.get('state'), code: 'fixture-code', cookieBinding: started.cookieBinding }); await service.complete(context); },
    async enable(extra = {}) { await f.connect(); await service.lookupChoices(context); return (await service.saveSettings({ expectedRevision: 0, settings: configuration(extra) }, context)).settings; },
    async source(extra = {}) {
      const customer = { id: 'customer-1', customerNumber: 'K1001', name: 'Fixture seller', type: 'Privatperson', number: '199001011234', ...extra.customer }, settings = await service.financeSettingsForCompany(customer);
      const rows = [{ articleId: 'copper', name: 'Koppar', taxCategory: extra.taxCategory ?? 'scrap_reverse', weight: 10, price: 100, amount: 1000 }];
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
  await f.enable(); await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '5560000000' } });
  f.suppliers.push({ Id: supplierId, CorporateIdentityNumber: '556000-0000', IsActive: true }, { Id: randomUUID(), CorporateIdentityNumber: '5560000000', IsActive: true });
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
  const audits = await f.repository.read(state => state.vismaIntegration.tenants['jeroc-demo'].audit);
  assert.equal(audits.find(item => item.action === 'visma.export_queued').actualUserId, 'service:spiris-export');
  assert.equal(audits.find(item => item.action === 'visma.export_queued').attestActorId, 'staff-1');
  await f.restart(); await f.service.processQueuedExports(); assert.equal(f.posts().length, 2);
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
  await f.source({ cardId: 3018, customer: { type: 'Företag', vatRegistered: true, number: '5560000000' } });
  f.suppliers.push({ Id: supplierId, SupplierNumber: 'K1001', CorporateIdentityNumber: '5570000000', IsActive: true });
  const conflict = await f.service.sendExport({ cardId: 3018 }, context); assert.equal(conflict.error.code, 'visma_supplier_identity_conflict'); assert.equal(f.posts().length, 0);
}));

test('actual VAT codes with contradictory rates cannot be assigned to a 25 percent purchase', async () => fixture(async f => {
  await f.connect();
  f.setProvider(call => call.url.pathname === '/v2/vatcodes' ? page([{ Id: vatId, Code: '6', Description: 'Moms 6 %', VatRate: 6 }]) : f.normalProvider(call));
  await f.service.lookupChoices(context);
  await assert.rejects(() => f.service.saveSettings({ expectedRevision: 0, settings: configuration() }, context), error => error.code === 'visma_vat_invalid');
}));

test('company standard VAT exports the approved gross while leaving source economics untouched', async () => fixture(async f => {
  await f.enable(); const source = await f.source({ customer: { type: 'Företag', vatRegistered: true, number: '5560000000' }, taxCategory: 'standard_25' });
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
  await f.repository.transact(state => {
    const finance = state.vismaIntegration.tenants['jeroc-demo'].finance, job = finance.outbox[0], mapping = Object.values(finance.mappings)[0];
    delete mapping.supplierId; mapping.status = 'reserved'; delete job.supplierId; delete job.draftId; job.status = 'processing'; job.stage = 'supplier';
    job.lease = { id: randomUUID(), until: '2026-10-11T09:00:00Z' };
    const runs = state.vismaIntegration.tenants['jeroc-demo'].runs;
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
