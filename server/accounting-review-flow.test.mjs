import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';
import { createPricingStore } from './pricing.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { accountingExportEligibility, buildAccountingDraft, freezePurchaseAccounting, moneyToCents } from './visma-accounting.mjs';
import { withBusinessIdentity } from './business-identity.mjs';
import { amount, approveCorrection, createCorrectionDraft, recordPayment, settlementPreview, submitCorrection } from '../dist-server/domain-models.mjs';

const OFFICE = '/api/application/office', ARTICLE = 'accounting-flow-material', CUSTOMER = 'customer-build';
const companyId = 'e7e2f051-d3ab-498f-b7cc-c2fc57f5d441';
const context = { organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'fixture-session', actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } };
const configuration = () => ({ revision: 1, enabled: true, exportMode: 'after_attest', companyId, sandbox: true, paymentTermDays: 0, paymentTermsId: randomUUID(),
  accounts: { privatePurchase: 4000, reversePurchase: 4415, standardPurchase: 4010, noVatPurchase: 4001, supplierLiability: 2440, inputVat: 2641, inputReverseVat: 2647, outputReverseVat: 2614 },
  vatCodes: { reverse25: randomUUID(), standard25: randomUUID() }, sites: [{ siteId: 'norrtalje', useDefaults: true, costCenterId: randomUUID(), projectId: randomUUID() }] });
const balanced = rows => rows.reduce((sum, row) => sum + moneyToCents(row.DebitAmount) - moneyToCents(row.CreditAmount), 0);

async function fixture(run, { enabled = true, businessIdentity } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-accounting-flow-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  const repository = await createApplicationRepository({ env, seed: initialApplicationState });
  const terminalRepository = await createTerminalDemoRepository({ env, filename: join(directory, 'terminal.sqlite') });
  let terminal, sendHook, settings = { ...configuration(), enabled };
  const app = createApplicationService({ env, repository, projections: cardId => terminal.projections(cardId), approvalProvider: () => terminal.projections(),
    accountingSettingsProvider: async () => structuredClone(settings),
    sendCustomerReview: async (payload, principal) => { await sendHook?.(payload); return terminal.send(payload, undefined, principal); } });
  const sourceCustomer = request => repository.read(state => structuredClone(state.office.customers.find(customer => customer.id === request.customer.id)), { domains: ['office'] });
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: app.principalStore, now: () => new Date('2026-10-09T10:00:00Z'),
    accountingSourceProvider: async request => ({ settings: structuredClone(settings), customer: await sourceCustomer(request) }) });
  const server = createServer((req, res) => {
    const handle = () => app(req, res, new URL(req.url, 'http://localhost'));
    // Install the trusted scope at the request boundary; an ALS scope around
    // the test's fetch would not reach the independently dispatched HTTP handler.
    void (businessIdentity ? withBusinessIdentity(businessIdentity, handle) : handle());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function api(path, input, actor = 'admin', user = actor) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor, 'X-Demo-User': user }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(5000) });
    return { status: response.status, ...await response.json() };
  }
  const staff = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const device = await terminal.createTerminal({ name: 'Accounting flow', username: 'accounting-flow', password: 'fixture-password', siteId: 'norrtalje' }, staff);
  const login = await terminal.login({ username: device.username, password: 'fixture-password' });
  async function saveOffice(base, next, actor = 'admin') { const result = await api(OFFICE, { base, next }, actor); assert.equal(result.status, 200, result.error); return result.data; }
  async function setCustomer(patch) {
    const base = (await api(OFFICE)).data, next = structuredClone(base);
    Object.assign(next.customers.find(customer => customer.id === CUSTOMER), patch);
    return saveOffice(base, next);
  }
  async function setArticle(taxCategory, price = 100) {
    const catalog = await api('/api/pricing/state');
    const article = catalog.articles.find(article => article.id === ARTICLE) ?? catalog.articles[0];
    const result = await api('/api/pricing/articles', { ...article, id: ARTICLE, name: 'Accounting test material', taxCategory, effectiveFrom: '2026-10-01',
      base: { type: 'manual', price }, tiers: { A: { discountPercent: 0, adjustmentKr: 0 }, B: { discountPercent: 0, adjustmentKr: 0 }, C: { discountPercent: 0, adjustmentKr: 0 } } });
    assert.equal(result.status, 200, result.error);
  }
  async function card(id = 2053) {
    const base = (await api(OFFICE)).data, next = structuredClone(base), card = next.cards.find(card => card.id === id);
    Object.assign(card, { status: 'complement', date: '2026-10-09T09:00:00Z', customerId: CUSTOMER, origin: 'Testgatan 12, Norrtälje', reference: 'Financial integration',
      payment: 'Kontant', paymentDetails: { method: 'cash' }, financialPending: true, pricingRowsPending: true,
      rows: [{ articleId: ARTICLE, weight: 1, tier: 'C', price: 1, pricePending: true }] });
    const saved = await saveOffice(base, next); return saved.cards.find(card => card.id === id);
  }
  const command = card => ({ cardId: card.id, expectedCard: card, terminalId: device.id, siteId: 'norrtalje', idempotencyKey: randomUUID() });
  async function review() { const response = await api('/api/application/customer-review', command(await card())); assert.equal(response.status, 200, response.error); return response; }
  async function approve(approval) { await terminal.respond(approval.id, { action: 'id_requested', termsAccepted: true }, login.token); return terminal.confirmId(approval.id, staff); }
  async function directPayload() {
    const current = await card(), customer = (await api(OFFICE)).data.customers.find(customer => customer.id === CUSTOMER);
    const locked = await api('/api/pricing/snapshots', { cardId: String(current.id), customerId: CUSTOMER, deliveredAt: current.date, rows: [{ articleId: ARTICLE, weight: 1 }] });
    assert.equal(locked.status, 201, locked.error);
    const articles = (await api('/api/pricing/state')).articles;
    const rows = locked.rows.map(row => ({ articleId: row.articleId, name: articles.find(article => article.id === row.articleId).name, weight: row.weight, price: row.price, amount: row.weight * row.price }));
    const accounting = freezePurchaseAccounting({ settings, customer, siteId: 'norrtalje', rows: rows.map(row => ({ ...row, taxCategory: articles.find(article => article.id === row.articleId).taxCategory })) });
    return { card: { ...current, pricingSnapshotId: locked.id, pricingTotal: locked.total, rows: current.rows.map((row, index) => ({ ...row, price: rows[index].price, pricePending: false })), accounting },
      customer, rows, offset: 0, correctionIds: [], terminalId: device.id, siteId: 'norrtalje', idempotencyKey: randomUUID() };
  }
  try { await run({ api, saveOffice, repository, terminal, app, staff, login, device, setArticle, setCustomer, card, command, review, approve, directPayload,
    get settings() { return settings; }, setSettings: value => { settings = structuredClone(value); }, onSend: hook => { sendHook = hook; } }); }
  finally { await new Promise(resolve => server.close(resolve)); await app.close(); await terminalRepository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('ordinary VAT is computed from the actual article before approval and appears in the public terminal and office gross', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ type: 'Företag', vatRegistered: true });
  const review = await f.review(), snapshot = review.approval.snapshot;
  assert.equal(snapshot.rows[0].amount, 100); assert.equal(snapshot.card.pricingTotal, 100);
  assert.equal(snapshot.card.accounting.baseTotal, 100); assert.equal(snapshot.card.accounting.sellerVat, 25); assert.equal(snapshot.gross, 125); assert.equal(snapshot.net, 125);
  assert.equal(amount(review.cardProjection), 125);
  const publicSnapshot = (await f.terminal.session(f.login.token)).approval.snapshot;
  assert.deepEqual(publicSnapshot.tax, { baseTotal: 100, sellerVat: 25, treatments: ['standard25'] });
  assert.equal(publicSnapshot.gross, 125); assert.equal(publicSnapshot.rows[0].amount, 100);
  assert.equal(JSON.stringify(publicSnapshot).includes('standardPurchase'), false, 'Provider account configuration is not a terminal customer field');
  await f.approve(review.approval); const attested = await f.terminal.attest(review.approval.id, f.staff);
  const result = buildAccountingDraft({ accounting: attested.snapshot.card.accounting, attestedAt: attested.attestedAt, invoiceNumber: 'AV-2053-V1' });
  assert.equal(result.TotalAmount, 125); assert.equal(result.Vat, 25); assert.equal(result.Rows.at(-1).CreditAmount, 125); assert.equal(balanced(result.Rows), 0);
}));

test('registered scrap and private purchases both have zero seller VAT and fully balanced frozen drafts', async () => {
  for (const privateSeller of [false, true]) await fixture(async f => {
    await f.setArticle(privateSeller ? 'standard_25' : 'scrap_reverse'); await f.setCustomer({ type: privateSeller ? 'Privatperson' : 'Företag', vatRegistered: !privateSeller,
      // Changing customer type must also replace the company's identifier with
      // a synthetic, date/checksum-valid personal identifier for the private case.
      ...(privateSeller && { number: '199001010009' }) });
    const review = await f.review(), accounting = review.approval.snapshot.card.accounting;
    assert.equal(accounting.sellerVat, 0); assert.equal(accounting.gross, 100); assert.equal(accounting.reverseVat, privateSeller ? 0 : 25);
    assert.equal(accounting.lines[0].treatment, privateSeller ? 'private' : 'reverse25');
    assert.deepEqual((await f.terminal.session(f.login.token)).approval.snapshot.tax, { baseTotal: 100, sellerVat: 0, treatments: [privateSeller ? 'private' : 'reverse25'] });
    const result = buildAccountingDraft({ accounting, attestedAt: '2026-10-09T10:00:00Z', invoiceNumber: 'AV-2053-V1' });
    assert.equal(result.TotalAmount, 100); assert.equal(result.Vat, 0); assert.equal(balanced(result.Rows), 0); assert.equal(result.Rows.length, privateSeller ? 2 : 4);
  });
});

test('direct terminal sends reject forged accounting and customer VAT metadata before reserving an approval', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ vatRegistered: true });
  const payload = await f.directPayload();
  const forgedAccounting = structuredClone(payload); forgedAccounting.card.accounting.gross = 100;
  await assert.rejects(() => f.app.withPrincipal(() => f.terminal.send(forgedAccounting, f.staff)), error => error.status === 409 && error.code === 'accounting_snapshot_changed');
  const forgedCustomer = structuredClone(payload); forgedCustomer.customer.vatRegistered = false;
  await assert.rejects(() => f.app.withPrincipal(() => f.terminal.send(forgedCustomer, f.staff)), error => error.status === 409 && error.code === 'accounting_customer_changed');
  assert.equal((await f.terminal.documentProjections()).length, 0);
  const valid = await f.app.withPrincipal(() => f.terminal.send(payload, f.staff)); assert.equal(valid.snapshot.gross, 125);
}));

test('a settings revision race rejects the prepared review and rolls back the new canonical price snapshot', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ vatRegistered: true });
  f.onSend(() => f.setSettings({ ...f.settings, revision: f.settings.revision + 1 }));
  const current = await f.card(), rejected = await f.api('/api/application/customer-review', f.command(current));
  assert.equal(rejected.status, 409); assert.match(rejected.error, /Ekonomiunderlaget har ändrats/);
  assert.equal((await f.terminal.documentProjections()).length, 0);
  assert.equal((await f.api('/api/pricing/snapshots?cardId=2053')).snapshots.length, 0);
  assert.equal((await f.api(OFFICE)).data.cards.find(card => card.id === 2053).status, 'complement');
}));

test('later live customer, article and settings changes leave the customer-approved hash, tax and due-date terms frozen', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ vatRegistered: true, paymentTermDays: 30 });
  const review = await f.review(), original = await f.terminal.repository.read(state => structuredClone(state.approvals[0].snapshot));
  await f.setCustomer({ vatRegistered: false, paymentTermDays: 0 }); await f.setArticle('scrap_reverse', 200);
  f.setSettings({ ...f.settings, revision: 2, paymentTermDays: 90, accounts: { ...f.settings.accounts, standardPurchase: 4999 } });
  const approved = await f.approve(review.approval), attested = await f.terminal.attest(approved.id, f.staff);
  const persisted = await f.terminal.repository.read(state => structuredClone(state.approvals[0]));
  assert.deepEqual(persisted.snapshot, original); assert.equal(persisted.approvedHash, original.hash); assert.equal(attested.snapshot.hash, original.hash);
  assert.equal(attested.snapshot.gross, 125); assert.equal(attested.snapshot.card.accounting.settingsRevision, 1);
  assert.equal(attested.snapshot.customer.vatRegistered, true); assert.equal(attested.snapshot.card.accounting.lines[0].taxCategory, 'standard_25');
  const result = buildAccountingDraft({ accounting: attested.snapshot.card.accounting, attestedAt: attested.attestedAt, invoiceNumber: 'AV-2053-V1' });
  assert.equal(result.DueDate, '2026-11-08'); assert.equal(result.Rows[0].AccountNumber, 4010); assert.equal(result.TotalAmount, 125);
  assert.equal(amount((await f.api(OFFICE)).data.cards.find(card => card.id === 2053)), 125);
}));

test('VAT-inclusive gross bounds offset, pays only the net and blocks every managed export before any provider operation', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ vatRegistered: true });
  await f.repository.transact(state => {
    // Keep the seeded demo cards outside this customer's ledger.
    for (const card of state.office.cards) if (card.customerId === CUSTOMER) card.customerId = 'customer-andersson';
    const pricing = createPricingStore({ initialState: state.pricing }), admin = pricing.principal('admin');
    const locked = pricing.snapshot({ cardId: '2050', customerId: CUSTOMER, deliveredAt: '2026-10-08', rows: [{ articleId: 'copper-1', weight: 4, override: { price: 50, tier: 'C', reason: 'Historical settlement fixture' } }] }, admin);
    Object.assign(state.office.cards.find(card => card.id === 2050), { status: 'ready', customerId: CUSTOMER, date: '2026-10-08T09:00:00Z', origin: 'Historikgatan 1', idVerified: true, approvedBy: 'admin',
      pricingSnapshotId: locked.id, pricingTotal: 200, financialPending: false, pricingRowsPending: false, payment: 'Kontant', paymentDetails: { method: 'cash' },
      rows: locked.rows.map(row => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: 'C', pricePending: false })), audit: [] });
    state.office = recordPayment(state.office, 2050, { user: admin.user, now: '2026-10-08T10:00:00Z' }, { method: 'cash' }, 'Paid historical original');
    state.pricing = pricing.exportState();
  });
  let base = (await f.api(OFFICE)).data, kajsa = base.users.find(user => user.id === 'kajsa'), anna = base.users.find(user => user.id === 'anna');
  await f.saveOffice(base, createCorrectionDraft(base, { cardId: 2050, articleId: 'copper-1', weightDelta: -2.4, reason: 'Return quantity', document: 'Return receipt' }, { user: kajsa, now: '2026-10-08T11:00:00Z' }), 'kajsa');
  base = (await f.api(OFFICE)).data; const correction = base.corrections.at(-1);
  const submitted = submitCorrection(base, correction.id, { user: kajsa }); await f.saveOffice(base, submitted, 'kajsa');
  const receipt = await f.api('/api/pricing/approved-corrections', { sourceSnapshotId: submitted.cards.find(card => card.id === 2050).pricingSnapshotId, cardId: correction.serverId,
    rows: [{ articleId: 'copper-1', weightDelta: -2.4 }], reason: correction.reason, correctedAt: correction.at, creatorId: 'kajsa', submittedBy: 'kajsa', document: correction.document }, 'anna');
  assert.equal(receipt.status, 201, receipt.error);
  base = (await f.api(OFFICE)).data; await f.saveOffice(base, approveCorrection(base, correction.id, { user: anna }), 'anna');
  const review = await f.review(), accounting = review.approval.snapshot.card.accounting;
  assert.equal(accounting.gross, 125); assert.equal(accounting.offset, 120); assert.equal(accounting.net, 5);
  assert.ok(accounting.offset > accounting.baseTotal, 'The invoice gross including VAT bounds offset, so debt may exceed the material base');
  assert.equal(review.approval.snapshot.offset, 120); assert.equal(review.approval.snapshot.net, 5);
  await f.approve(review.approval); await f.terminal.attest(review.approval.id, f.staff);
  base = (await f.api(OFFICE)).data;
  const settlement = settlementPreview(base, 2053); assert.equal(settlement.gross, 125); assert.equal(settlement.offset, 120); assert.equal(settlement.net, 5); assert.equal(settlement.balanceAfter, 0);
  const paid = recordPayment(base, 2053, { user: base.users.find(user => user.id === 'admin'), now: '2026-10-09T11:00:00Z' }, { method: 'cash' }, 'Actual net payment');
  await f.saveOffice(base, paid); await f.saveOffice(base, paid);
  const saved = (await f.api(OFFICE)).data, payments = saved.payments.filter(payment => payment.cardId === 2053);
  assert.equal(payments.length, 1); assert.equal(payments[0].amount, 5); assert.equal(payments[0].offset, 120); assert.equal(settlementPreview(saved, 2053).balanceAfter, 0);
  assert.equal(accountingExportEligibility(accounting).issues[0].code, 'accounting_offset_reconciliation');
  const providerCalls = [];
  const exportEnv = { VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'fixture', VISMA_CLIENT_SECRET: 'fixture', VISMA_REDIRECT_URI: 'https://example.invalid/api/integrations/visma/oauth/callback', VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), VISMA_SANDBOX_COMPANY_ID: companyId };
  const service = createVismaSandbox({ getRepository: async () => f.repository, sourceProvider: () => f.terminal.documentProjections(), env: exportEnv, fetchImpl: async url => { providerCalls.push(url); assert.fail('Offsets must not dispatch any provider request'); } });
  const preview = await service.preview({ cardId: 2053 }, context);
  assert.equal(preview.eligible, false); assert.equal(preview.code, 'visma_accounting_blocked'); assert.match(preview.issues.join(' '), /Kvittning behöver kopplas till kreditunderlag/);
  await assert.rejects(() => service.sendExport({ cardId: 2053 }, context), error => error.code === 'visma_accounting_blocked');
  await f.repository.transact(state => {
    const authorized = { ...f.settings, enabledBy: { actualUserId: 'admin', effectiveUserId: 'admin' } };
    state.vismaIntegration = { version: 1, tenants: { 'jeroc-demo': { finance: { settings: { [companyId]: authorized }, settingsHistory: { [companyId]: { 1: authorized } }, choices: {}, mappings: {}, outbox: [] }, audit: [] } } };
  });
  assert.deepEqual(await service.processQueuedExports(), { processed: 0 }); assert.deepEqual(await service.processQueuedExports(), { processed: 0 });
  // A rejected source is retained once for diagnosis, without queuing or
  // reserving any provider operation, even when the worker runs again.
  const exports = (await service.exports(context)).exports;
  assert.equal(exports.length, 1);
  assert.deepEqual(exports[0].source, { cardId: 2053, approvalId: review.approval.id, version: review.approval.version, hash: review.approval.snapshot.hash });
  assert.equal(exports[0].companyId, companyId); assert.equal(exports[0].customerId, CUSTOMER);
  assert.equal(exports[0].status, 'blocked'); assert.equal(exports[0].stage, 'validation');
  assert.equal(exports[0].error.code, 'visma_accounting_blocked');
  assert.match(exports[0].error.message, /Kvittning behöver kopplas till kreditunderlag/);
  assert.deepEqual(exports[0].runs, {}); assert.equal(exports[0].draftId, undefined); assert.equal(exports[0].supplierId, undefined);
  assert.equal(providerCalls.length, 0);
}));

test('office-save rejects a legacy own correction for platform admin working as an independent attestant despite a valid server receipt', async () => fixture(async f => {
  await f.setArticle('scrap_reverse');
  const review = await f.review(); await f.approve(review.approval); await f.terminal.attest(review.approval.id, f.staff);
  const catalog = await f.api('/api/pricing/state');
  const virtual = { ...catalog.users.find(user => user.id === 'admin'), id: '__platform-admin', name: 'Platform administrator', ownAttest: false };
  const configured = await f.api('/api/pricing/users', { users: [...catalog.users, virtual] });
  assert.equal(configured.status, 200, configured.error);
  let base = (await f.api(OFFICE)).data;
  const admin = base.users.find(user => user.id === 'admin'), anna = base.users.find(user => user.id === 'anna');
  assert.equal(base.users.find(user => user.id === '__platform-admin').ownAttest, false);
  assert.equal(anna.ownAttest, false);
  await f.saveOffice(base, createCorrectionDraft(base, { cardId: 2053, articleId: ARTICLE, weightDelta: -0.25,
    reason: 'Legacy administrator correction', document: 'Verified return document' }, { user: admin, now: '2026-10-09T11:00:00Z' }));
  base = (await f.api(OFFICE)).data; const correction = base.corrections.at(-1);
  await f.saveOffice(base, submitCorrection(base, correction.id, { user: admin }));
  base = (await f.api(OFFICE)).data;
  const submitted = base.corrections.find(row => row.id === correction.id);
  assert.equal(submitted.actualUserId, 'admin'); assert.equal(submitted.effectiveUserId, 'admin'); assert.equal(submitted.submittedBy, 'admin');
  const receipt = await f.api('/api/pricing/approved-corrections', { sourceSnapshotId: base.cards.find(card => card.id === 2053).pricingSnapshotId,
    cardId: correction.serverId, rows: [{ articleId: ARTICLE, weightDelta: -0.25 }], reason: correction.reason,
    correctedAt: correction.at, creatorId: 'admin', submittedBy: 'admin', document: correction.document }, 'anna');
  assert.equal(receipt.status, 201, receipt.error); assert.equal(receipt.approvedBy, 'anna');
  base = (await f.api(OFFICE)).data;
  const next = approveCorrection(base, correction.id, { actualUser: virtual, user: anna });
  const before = await f.repository.read(state => structuredClone(state.office));
  const denied = await f.api(OFFICE, { base, next }, '__platform-admin', 'anna');
  assert.equal(denied.status, 403, 'A valid independent receipt must not let the same human attest their legacy own correction while working as Anna');
  assert.match(denied.error, /eget underlag/);
  const after = await f.repository.read(state => structuredClone(state.office));
  assert.deepEqual(after, before, 'Failed approval preserves the stored correction status and complete audit history');
  assert.equal(after.corrections.find(row => row.id === correction.id).status, 'attest');
  const independent = await f.api(OFFICE, { base, next: approveCorrection(base, correction.id, { user: anna }) }, 'anna');
  assert.equal(independent.status, 200, independent.error);
  assert.equal(independent.data.corrections.find(row => row.id === correction.id).status, 'approved', 'The receipt passes the real office validation for the independent attestant');
}, { enabled: false, businessIdentity: { organisationId: 'jeroc-demo', platformAdmin: true,
  actualUser: { id: '__platform-admin' }, user: { id: 'anna' }, credentialBusinessId: 'admin' } }));

test('disabled accounting leaves the legacy customer review and terminal settlement flow unchanged', async () => fixture(async f => {
  await f.setArticle('standard_25'); await f.setCustomer({ vatRegistered: undefined });
  const review = await f.review(); assert.equal(review.approval.snapshot.card.accounting, undefined); assert.equal(review.approval.snapshot.gross, 100); assert.equal(amount(review.cardProjection), 100);
  assert.equal((await f.terminal.session(f.login.token)).approval.snapshot.tax, undefined);
  const original = await f.terminal.repository.read(state => structuredClone(state.approvals[0].snapshot));
  // Enabling integration later must not retrofit tax onto an already shown agreement.
  f.setSettings({ ...f.settings, enabled: true, revision: 2 }); await f.setCustomer({ vatRegistered: true }); await f.setArticle('scrap_reverse', 200);
  await f.approve(review.approval); const attested = await f.terminal.attest(review.approval.id, f.staff);
  assert.equal(attested.snapshot.card.accounting, undefined); assert.equal(attested.snapshot.gross, 100);
  assert.equal(attested.snapshot.hash, original.hash); assert.deepEqual(await f.terminal.repository.read(state => state.approvals[0].snapshot), original);
}, { enabled: false }));
