import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApplicationRepository } from './application-storage.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentApi } from './environment-api.mjs';
import { createPricingStore } from './pricing.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { createVismaStorage } from './visma-storage.mjs';
import { readVismaConfiguration } from './visma-client.mjs';

const postgresUrl = process.env.JEROC_TEST_DATABASE_URL;
const now = () => new Date('2026-10-12T10:00:00Z');
const companyA = '55c5ec9b-4e91-4d10-b41e-c58f7ab0a0d2';
const companyB = '85e5ec9b-4e91-4d10-b41e-c58f7ab0a0d2';
const sharedTerms = '1831c176-4020-4a9c-9fe5-1f8b2fdb0d91';
const sharedYear = '6a767af7-43b7-42e8-9d10-cc3e1c02f7db';
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const page = values => response({ Data: values, Meta: { CurrentPage: 1, PageSize: 1000, TotalNumberOfPages: 1, TotalNumberOfResults: values.length } });
const context = (organisationId, level = 'VD', permissions = ['integrationsRead', 'integrationsManage']) => ({
  organisationId, actorId: 'owner', effectiveUserId: 'owner', sessionKey: 'same-local-session-id',
  actor: { id: 'owner', level, permissions }, user: { id: 'owner', level, permissions },
});

async function fixture(run, postgres = false) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-visma-tenants-'));
  let provisioner;
  const schemas = [], repositories = [];
  if (postgres) { const { Pool } = await import('pg'); provisioner = new Pool({ connectionString: postgresUrl }); }
  const shared = { VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'shared-fixture-client', VISMA_CLIENT_SECRET: 'shared-fixture-secret',
    VISMA_REDIRECT_URI: 'https://app.fixture.invalid/api/integrations/visma/oauth/callback',
    VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), VISMA_SANDBOX_COMPANY_ID: 'jeroc-global-company-must-not-inherit' };
  async function tenant(organisationId, providerId = companyA) {
    const repositoryEnv = {}, filename = join(directory, `${organisationId}.sqlite`);
    if (postgres) {
      const schema = `visma_tenant_${randomUUID().replaceAll('-', '')}`; schemas.push(schema);
      await provisioner.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`); repositoryEnv.DATABASE_URL = url.toString();
    }
    let repository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({ office: { cards: [{ id: 3024, name: organisationId }] } }) });
    repositories.push(repository);
    const env = { ...shared, SCRAPPILOT_ORGANISATION_ID: organisationId }, calls = [], ctx = context(organisationId);
    let selectedCompany = providerId;
    const fetchImpl = async (url, input = {}) => {
      const parsed = new URL(url), headers = new Headers(input.headers); calls.push({ url: parsed, method: input.method, headers });
      if (parsed.origin === 'https://identity.vismaonline.com') return response({ access_token: `synthetic-access-${organisationId}`,
        refresh_token: `synthetic-refresh-${organisationId}`, expires_in: 3600 });
      assert.equal(parsed.origin, 'https://eaccountingapi.vismaonline.com'); assert.equal(input.method, 'GET', 'No financial provider writes in these tests');
      assert.equal(headers.get('authorization'), `Bearer synthetic-access-${organisationId}`);
      if (parsed.pathname === '/v2/companysettings') return response({ CompanyIdentifier: selectedCompany, Name: organisationId });
      if (parsed.pathname === '/v2/termsofpayments') return page([{ Id: sharedTerms, Name: `Direkt ${organisationId}`, NumberOfDays: 0, AvailableForPurchase: true }]);
      if (parsed.pathname === '/v2/fiscalyears') return page([{ Id: sharedYear, StartDate: '2026-01-01', EndDate: '2026-12-31' }]);
      if (parsed.pathname.startsWith('/v2/accounts/')) return page([{ Number: '4000', Name: `Inköp ${organisationId}`, FiscalYearId: sharedYear, IsActive: true }]);
      if (['/v2/vatcodes', '/v2/costcenters', '/v2/projects'].includes(parsed.pathname)) return page([]);
      assert.fail(`Unexpected provider path ${parsed.pathname}`);
    };
    const makeService = (selectedRepository = repository, selectedId = organisationId) => createVismaSandbox({ env: { ...env, SCRAPPILOT_ORGANISATION_ID: selectedId },
      getRepository: async () => selectedRepository, fetchImpl, now, sitesProvider: async () => [] });
    let service = makeService();
    const value = { ctx, env, calls, makeService,
      get repository() { return repository; }, get service() { return service; },
      setCompany(id) { selectedCompany = id; },
      inspector: () => createVismaStorage({ getRepository: async () => repository, organisationId }),
      async connect(instance = service, current = ctx) {
        const started = await instance.begin(current), state = new URL(started.authorizationUrl).searchParams.get('state');
        await instance.callback({ state, code: 'synthetic-code', cookieBinding: started.cookieBinding }); return instance.complete(current);
      },
      async restart() {
        await repository.close(); repositories.splice(repositories.indexOf(repository), 1);
        repository = await createApplicationRepository({ env: repositoryEnv, filename, seed: () => ({}) });
        repositories.push(repository); service = makeService(); await service.initialize();
      },
    };
    await service.initialize(); return value;
  }
  try { await run({ tenant, shared }); }
  finally {
    for (const repository of repositories) await repository.close();
    for (const schema of schemas) await provisioner.query(`DROP SCHEMA "${schema}" CASCADE`);
    if (provisioner) await provisioner.end();
    await rm(directory, { recursive: true, force: true });
  }
}

test('Spiris organisation configuration retains legacy defaults and ignores the global company pin for new companies', () => {
  assert.equal(readVismaConfiguration({}).organisationId, 'jeroc-demo');
  assert.equal(readVismaConfiguration({ VISMA_SANDBOX_COMPANY_ID: companyA }).expectedCompanyId, companyA);
  const newCompany = { SCRAPPILOT_ORGANISATION_ID: 'company-a', VISMA_SANDBOX_COMPANY_ID: companyA };
  assert.equal(readVismaConfiguration(newCompany).expectedCompanyId, null);
  assert.equal(readVismaConfiguration({ ...newCompany, VISMA_TENANT_COMPANY_ID: companyB }).expectedCompanyId, companyB);
  for (const id of ['', '../other', 'a,b', 'a/b', 12]) assert.throws(() => readVismaConfiguration({ SCRAPPILOT_ORGANISATION_ID: id }), error => error.code === 'visma_organisation_invalid');
});

for (const postgres of [false, true]) {
  const backend = postgres ? 'PostgreSQL' : 'SQLite', options = { skip: postgres && !postgresUrl };
  test(`${backend}: company repositories isolate OAuth credentials, accounting settings and identical provider/local IDs`, options, async () => fixture(async ({ tenant }) => {
    const a = await tenant('company-a'), b = await tenant('company-b');
    assert.equal((await a.service.status(a.ctx)).expectedCompanyId, null);
    assert.equal((await a.connect()).companyVerified, true);
    assert.equal((await b.service.status(b.ctx)).connected, false); assert.equal(b.calls.length, 0);
    const aChoices = await a.service.lookupChoices(a.ctx);
    assert.equal(aChoices.choices.paymentTerms[0].name, 'Direkt company-a');
    const aSaved = await a.service.saveSettings({ expectedRevision: 0, settings: { ...aChoices.settings, trackingMaxDays: 12 } }, a.ctx);
    assert.equal(aSaved.settings.revision, 1);
    const beforeB = await b.service.settings(b.ctx); assert.equal(beforeB.choices, null); assert.equal(beforeB.settings.revision, 0);
    await assert.rejects(() => b.service.status(a.ctx), error => error.status === 403);
    assert.equal((await b.connect()).expectedCompanyId, companyA, 'Even an identical provider company ID must have a separate local connection');
    const bChoices = await b.service.lookupChoices(b.ctx);
    const bSaved = await b.service.saveSettings({ expectedRevision: 0, settings: { ...bChoices.settings, trackingMaxDays: 19 } }, b.ctx);
    assert.equal(bSaved.settings.revision, 1); assert.equal(bSaved.choices.paymentTerms[0].name, 'Direkt company-b');
    const runId = randomUUID(), exportId = randomUUID(), approvalId = randomUUID();
    const input = { operation: 'company', requestId: runId, idempotencyKey: 'same-request-in-each-company' };
    for (const item of [a, b]) {
      const result = await item.service.send(input, item.ctx);
      assert.equal(result.id, runId); assert.equal(result.response.Name, item.ctx.organisationId);
      assert.equal((await item.service.run(runId, item.ctx)).response.Name, item.ctx.organisationId);
      assert.equal((await item.inspector().findRun(runId)).response.Name, item.ctx.organisationId);
      assert.deepEqual(await item.repository.read(state => state.office.cards), [{ id: 3024, name: item.ctx.organisationId }]);
      await item.inspector().transact(document => {
        document.tenants[item.ctx.organisationId].finance.outbox.push({ id: exportId, key: 'same-export-key', companyId: companyA,
          source: { cardId: 3024, approvalId, version: 1, hash: 'a'.repeat(64) }, status: 'blocked', createdAt: now().toISOString(),
          error: { code: 'tenant-fixture', message: item.ctx.organisationId }, events: [], runs: {} });
      }, { organisationId: item.ctx.organisationId, finance: { outbox: { id: exportId } }, runs: false, audit: false });
      assert.equal((await item.service.exports(item.ctx)).exports[0].error.message, item.ctx.organisationId);
      assert.equal((await item.service.cardExportProjection(3024)).error.message, item.ctx.organisationId);
      assert.equal((await item.inspector().queryExports({ id: exportId }))[0].error.message, item.ctx.organisationId);
    }
    await a.restart(); await b.restart();
    assert.equal((await a.service.settings(a.ctx)).settings.trackingMaxDays, 12);
    assert.equal((await b.service.settings(b.ctx)).settings.trackingMaxDays, 19);
    for (const item of [a, b]) {
      assert.equal((await item.service.status(item.ctx)).connected, true);
      const all = await item.inspector().read(document => document);
      assert.deepEqual(Object.keys(all.tenants), [item.ctx.organisationId]);
    }
  }, postgres));

  test(`${backend}: OAuth callback cannot consume another company's state even if foreign histories share a legacy document`, options, async () => fixture(async ({ tenant }) => {
    const a = await tenant('company-a'), bOnSameRepository = a.makeService(a.repository, 'company-b');
    const ctxB = context('company-b'), startedA = await a.service.begin(a.ctx), startedB = await bOnSameRepository.begin(ctxB);
    const stateA = new URL(startedA.authorizationUrl).searchParams.get('state'), stateB = new URL(startedB.authorizationUrl).searchParams.get('state');
    await assert.rejects(() => bOnSameRepository.callback({ state: stateA, code: 'code-a', cookieBinding: startedA.cookieBinding }), error => error.code === 'visma_oauth_state_invalid');
    await assert.rejects(() => a.service.callback({ state: stateB, code: 'code-b', cookieBinding: startedB.cookieBinding }), error => error.code === 'visma_oauth_state_invalid');
    assert.equal(a.calls.length, 0);
    await a.service.callback({ state: stateA, code: 'code-a', cookieBinding: startedA.cookieBinding });
    assert.equal((await a.service.complete(a.ctx)).companyVerified, true);
    await bOnSameRepository.callback({ state: stateB, code: 'code-b', cookieBinding: startedB.cookieBinding });
    assert.equal((await bOnSameRepository.complete(ctxB)).companyVerified, true);
  }, postgres));

  test(`${backend}: first OAuth binding is durable across instances and cannot be silently retargeted on reconnect`, options, async () => fixture(async ({ tenant }) => {
    const a = await tenant('company-a'), second = a.makeService(); await second.initialize();
    assert.equal((await a.connect()).expectedCompanyId, companyA);
    assert.equal((await second.status(a.ctx)).expectedCompanyId, companyA, 'An instance started before OAuth must observe the committed binding');
    a.setCompany(companyB);
    const changed = await a.connect(second); assert.equal(changed.expectedCompanyId, companyA); assert.equal(changed.company.id, companyB); assert.equal(changed.companyVerified, false);
    const calls = a.calls.length;
    await assert.rejects(() => second.send({ operation: 'suppliers', requestId: randomUUID(), idempotencyKey: randomUUID() }, a.ctx), error => error.code === 'visma_company_mismatch');
    assert.equal(a.calls.length, calls, 'A mismatched connection cannot dispatch provider operations');
    assert.equal(await a.inspector().readTenantProjection(value => value.expectedCompanyId, [['expectedCompanyId']]), companyA);
    a.setCompany(companyA); assert.equal((await a.connect(second)).companyVerified, true);
    await second.disconnect(a.ctx); await a.restart();
    const disconnected = await a.service.status(a.ctx); assert.equal(disconnected.connected, false); assert.equal(disconnected.expectedCompanyId, companyA);
  }, postgres));
}

test('VD integration management requires explicit rights for both principals and unrestricted company sites', async () => fixture(async ({ tenant }) => {
  const a = await tenant('company-a');
  assert.equal((await a.service.status(a.ctx)).configured, true);
  const contexts = [context('company-b'), context('company-a', 'VD', ['integrationsRead']), context('company-a', 'VD', []),
    { ...a.ctx, user: { ...a.ctx.user, level: 'Personal' } }, { ...a.ctx, actor: { ...a.ctx.actor, siteIds: ['yard'] } }];
  for (const bad of contexts) {
    for (const operation of [() => a.service.status(bad), () => a.service.begin(bad), () => a.service.settings(bad)])
      await assert.rejects(operation, error => error.status === 403);
  }
  assert.equal((await a.service.status(context('company-a', 'Systemadmin', []))).configured, true);
  assert.equal(a.calls.length, 0);
}));

test('trusted environment bridge uses the selected company and platform identity without minting or falling back to demo cookies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-visma-trusted-api-'));
  const repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const pricing = createPricingStore({ now }); let allowed = true, contexts = [];
  const principalStore = { ...pricing, principal(actor, user) {
    const value = pricing.principal(actor, user);
    for (const account of [value.actor, value.user]) if (account.id === 'lars') {
      account.level = 'VD'; account.permissions = [...new Set([...account.permissions.filter(right => !right.startsWith('integrations')),
        'integrationsRead', ...(allowed ? ['integrationsManage'] : [])])];
    }
    return value;
  } };
  let trusted = { actorId: 'lars', userId: 'lars', csrfToken: 'verified-platform-csrf', expiresAt: '2026-10-12T18:00:00Z' };
  const ownSite = { id: 'company-yard', label: 'Bolagets anläggning', name: 'Bolagets anläggning', municipalityCode: '0188',
    address: { street: '', postalCode: '', city: '' }, active: true };
  const api = createEnvironmentApi({ repository, principalStore, env: { SCRAPPILOT_ORGANISATION_ID: 'company-a', JEROC_DEMO_AUTO_SESSION: 'false' },
    now, initialSites: [ownSite], trustedPrincipalProvider: async () => trusted,
    vismaService: { async status(ctx) { await ctx.reauthorize(); contexts.push(ctx); return { companyVerified: false }; } } });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/environment`;
  const headers = { 'Content-Type': 'application/json', 'X-Environment-CSRF': trusted.csrfToken,
    'X-Environment-Actual-User': trusted.actorId, 'X-Environment-Effective-User': trusted.userId,
    'X-Organisation-Id': 'jeroc-demo', Cookie: 'jeroc_environment=untrusted-legacy-cookie' };
  const session = await fetch(`${base}/demo-session`, { method: 'POST', headers, body: JSON.stringify({ userId: 'lars' }) });
  assert.equal(session.status, 200); assert.equal(session.headers.get('set-cookie'), null);
  const projected = await session.json(); assert.equal(projected.demo, false); assert.equal(projected.actualUserId, 'lars'); assert.equal(projected.csrfToken, trusted.csrfToken);
  const state = await fetch(`${base}/state`, { headers }); assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).sites.map(value => value.id), ['company-yard']);
  assert.equal((await fetch(`${base}/visma/status?organisationId=jeroc-demo`, { headers })).status, 200);
  assert.equal(contexts[0].organisationId, 'company-a'); assert.equal(contexts[0].actorId, 'lars'); assert.equal(contexts[0].user.level, 'VD');
  const key = contexts[0].sessionKey;
  assert.equal((await fetch(`${base}/visma/status`, { headers })).status, 200); assert.equal(contexts[1].sessionKey, key);
  assert.equal((await fetch(`${base}/demo-session`, { method: 'POST', headers, body: JSON.stringify({ userId: 'admin' }) })).status, 403);
  assert.equal((await fetch(`${base}/visma/disconnect`, { method: 'POST', headers: { ...headers, 'X-Environment-CSRF': 'wrong' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/visma/status`, { headers: { ...headers, 'X-Environment-Actual-User': 'admin' } })).status, 403);
  allowed = false; assert.equal((await fetch(`${base}/visma/status`, { headers })).status, 403);
  trusted = undefined; assert.equal((await fetch(`${base}/session`, { headers })).status, 401);
  assert.equal((await fetch(`${base}/demo-session`, { method: 'POST', headers, body: JSON.stringify({ userId: 'admin' }) })).status, 401);
  assert.deepEqual(await repository.read(state => state.sessions), []);
  assert.equal(contexts.length, 2);
});
