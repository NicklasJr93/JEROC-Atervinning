import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentApi } from './environment-api.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createBankPayments } from './bank-payments.mjs';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createTenantServices } from './tenant-services.mjs';

// Real cookies, CSRF, live identities and company-owned settings; provider
// operations are recorded stubs and never call a bank or accounting API.
async function fixture(run, { restrictedSites = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-bank-api-'));
  const repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const applicationRepository = await createApplicationRepository({ env: {}, filename: ':memory:', seed: initialApplicationState });
  const initial = createPricingStore().exportState();
  if (restrictedSites) initial.users.find(user => user.id === 'admin').siteIds = ['norrtalje'];
  const principalStore = createPricingStore({ initialState: initial }), calls = [];
  const job = { id: randomUUID(), kind: 'card', status: 'queued', mode: 'sandbox', simulation: true, source: { cardId: 3026 } };
  const companyId = 'sandbox-bank-api-company', bankAccountId = randomUUID();
  const choices = { environment: 'sandbox', companyId, bankAccounts: [{ id: bankAccountId, active: true, currency: 'SEK' }] };
  const record = (name, input, context) => {
    calls.push({ name, input: structuredClone(input), organisationId: context?.organisationId,
      actorId: context?.actorId, effectiveUserId: context?.effectiveUserId, sessionKey: context?.sessionKey });
  };
  const payments = createBankPayments({ getRepository: async () => applicationRepository, env: {}, client: {
    configurationStatus: async () => ({ ready: true, mode: 'sandbox', issues: [], missing: [] }),
  } });
  const bankService = {
    async settings(context) { record('settings', null, context); return payments.settings(context); },
    async saveSettings(input, context) { record('saveSettings', input, context); return payments.saveSettings(input, context); },
    async prepare(id, context) { record('prepare', id, context); return { cardId: id, canStart: true }; },
    async start(input, context) { record('start', input, context); return job; },
    async job(id, context) { record('job', id, context); return job; },
    async getCardJobs(id, context) { record('getCardJobs', id, context); return [job]; },
    async refresh(id, context) { record('refresh', id, context); return job; },
    async resume(id, context) { record('resume', id, context); return job; },
    async beginAuthorisation(id, input, context) { record('authorise', { id, ...input }, context); return job; },
    async banks(context) { record('banks', null, context); return { banks: [], simulation: true }; },
    async testConnection(context) { record('test', null, context); return { ok: true, simulation: true }; },
    async connectConsent(input, context) { record('consent', input, context); return { id: 'test-consent', status: 'received' }; },
    async getAccounts(context) { record('accounts', null, context); return { accounts: [], simulation: true }; },
    async balances(context) { record('balances', null, context); return { data: [], simulation: true }; },
    async processQueuedPayments() { record('worker'); },
    async integrationStatus() { record('catalog'); return { mode: 'test', configured: true, connected: false }; },
  };
  const vismaService = {
    async paymentChoices(context) { record('choices', null, context); return structuredClone(choices); },
    async integrationStatus() { return { mode: 'test', configured: true, connected: false }; },
  };
  const api = createEnvironmentApi({ repository, principalStore, env: {}, bankService, vismaService });
  const server = createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, base = origin + '/api/environment';
  async function login(userId = 'admin', effectiveUserId = userId) {
    const response = await fetch(base + '/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, effectiveUserId }) });
    assert.equal(response.status, 200);
    const session = await response.json();
    return { Cookie: response.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json',
      'X-Environment-CSRF': session.csrfToken, 'X-Environment-Actual-User': userId, 'X-Environment-Effective-User': effectiveUserId };
  }
  try { await run({ base, origin, login, calls, job, companyId, bankAccountId, choices }); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close();
    await applicationRepository.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('bank actions require a staff cookie, matching identities, CSRF and same-origin before any provider action', () => fixture(async f => {
  assert.equal((await fetch(f.base + '/bank/payments/cards/3026/prepare')).status, 401);
  const headers = await f.login();
  const post = (path, override) => fetch(f.base + path, { method: 'POST', headers: { ...headers, ...override }, body: '{}' });
  for (const path of ['/bank/payments', `/bank/payments/${f.job.id}/authorise`, `/bank/payments/${f.job.id}/resume`, '/bank/test', '/bank/consent']) {
    assert.equal((await post(path, { 'X-Environment-CSRF': 'wrong' })).status, 403, path);
    assert.equal((await post(path, { Origin: 'https://other.invalid' })).status, 403, path);
    assert.equal((await post(path, { 'X-Environment-Actual-User': 'kajsa' })).status, 403, path);
  }
  assert.equal(f.calls.filter(call => ['start', 'authorise', 'resume', 'test', 'consent', 'worker'].includes(call.name)).length, 0);
  const response = await fetch(f.base + '/bank/payments', { method: 'POST', headers, body: '{"cardId":3026}' });
  assert.equal(response.status, 202); assert.equal((await response.json()).id, f.job.id);
  assert.equal(f.calls.find(call => call.name === 'start').organisationId, 'jeroc-demo');
  assert.equal(f.calls.find(call => call.name === 'start').actorId, 'admin');
}));

test('acting as another user retains the actual identity and cannot grant their missing payout or integration rights', () => fixture(async f => {
  const headers = await f.login('admin', 'anna');
  assert.equal((await fetch(f.base + '/bank/payments/cards/3026/prepare', { headers })).status, 200);
  const read = f.calls.find(call => call.name === 'prepare');
  assert.equal(read.actorId, 'admin'); assert.equal(read.effectiveUserId, 'anna');
  assert.equal((await fetch(f.base + '/bank/settings', { headers })).status, 403);
  const denied = await f.login('admin', 'kajsa');
  assert.equal((await fetch(f.base + '/bank/payments', { method: 'POST', headers: denied, body: '{"cardId":3026}' })).status, 403);
  assert.equal(f.calls.filter(call => ['start', 'settings', 'worker'].includes(call.name)).length, 0);
}));

test('integration administration requires access to all sites before reading settings, balances or opening consent', () => fixture(async f => {
  const headers = await f.login();
  for (const path of ['/bank/settings', '/bank/banks', '/bank/choices', '/bank/accounts', '/bank/balances'])
    assert.equal((await fetch(f.base + path, { headers })).status, 403, path);
  assert.equal((await fetch(f.base + '/bank/consent', { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal(f.calls.length, 0);
}, { restrictedSites: true }));

test('bank settings pin bookkeeping to an active SEK account in the verified Spiris sandbox company', () => fixture(async f => {
  const headers = await f.login(), save = input => fetch(f.base + '/bank/settings', { method: 'POST', headers, body: JSON.stringify(input) });
  const input = { enabled: true, bookkeepingEnabled: true, spirisBankAccountId: f.bankAccountId };
  assert.equal((await save({ ...input, spirisBankAccountId: randomUUID() })).status, 422);
  assert.equal((await save({ ...input, spirisCompanyId: 'someone-elses-company' })).status, 409);
  f.choices.bankAccounts[0].active = false; assert.equal((await save(input)).status, 422);
  f.choices.bankAccounts[0].active = true; f.choices.bankAccounts[0].currency = 'EUR'; assert.equal((await save(input)).status, 422);
  f.choices.bankAccounts[0].currency = 'SEK'; f.choices.environment = 'production'; assert.equal((await save(input)).status, 422);
  assert.equal(f.calls.filter(call => call.name === 'saveSettings').length, 0);
  f.choices.environment = 'sandbox'; const response = await save(input); assert.equal(response.status, 200);
  const saved = (await response.json()).settings;
  assert.equal(saved.spirisCompanyId, f.companyId); assert.equal(saved.spirisBankAccountId, f.bankAccountId); assert.equal(saved.bookkeepingEnabled, true);
  const read = await fetch(f.base + '/bank/settings', { headers }); assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).settings, saved);
}));

test('legacy registerSpirisPayment alias receives the same account validation and disabling removes accounting identity', () => fixture(async f => {
  const headers = await f.login(), save = input => fetch(f.base + '/bank/settings', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await save({ enabled: true, registerSpirisPayment: true, spirisBankAccountId: randomUUID() })).status, 422);
  const accepted = await save({ enabled: true, registerSpirisPayment: true, spirisBankAccountId: f.bankAccountId });
  assert.equal(accepted.status, 200); const state = (await accepted.json()).settings;
  assert.equal(state.bookkeepingEnabled, true); assert.equal(state.spirisCompanyId, f.companyId);
  const disabled = await save({ enabled: true, bookkeepingEnabled: false, registerSpirisPayment: false, spirisBankAccountId: f.bankAccountId, spirisCompanyId: 'stale-company' });
  assert.equal(disabled.status, 200); const next = (await disabled.json()).settings;
  assert.equal(next.spirisCompanyId, null); assert.equal(next.spirisBankAccountId, null); assert.equal(next.bookkeepingEnabled, false);
}));

test('card and job GETs read only; refresh preserves the existing ID and never starts a payment or bank authorisation', () => fixture(async f => {
  const headers = await f.login();
  for (const path of ['/bank/payments/cards/3026/prepare', '/bank/payments/cards/3026', `/bank/payments/${f.job.id}`])
    assert.equal((await fetch(f.base + path, { headers })).status, 200, path);
  const refreshed = await fetch(f.base + `/bank/payments/${f.job.id}/refresh`, { method: 'POST', headers, body: '{}' });
  assert.equal(refreshed.status, 200); assert.equal((await refreshed.json()).id, f.job.id);
  assert.equal(f.calls.filter(call => call.name === 'refresh').length, 1);
  assert.equal(f.calls.filter(call => ['start', 'authorise', 'resume', 'worker'].includes(call.name)).length, 0);
  assert.equal((await fetch(f.base + `/bank/payments/${f.job.id}/refresh`, { method: 'POST', headers, body: '{"amount":999}' })).status, 422);
  assert.equal(f.calls.filter(call => call.name === 'refresh').length, 1);
}));

test('authorisation and resume are explicit protected actions for the same existing job with empty payloads', () => fixture(async f => {
  const headers = await f.login(), path = f.base + `/bank/payments/${f.job.id}`;
  for (const action of ['authorise', 'resume'])
    assert.equal((await fetch(path + '/' + action, { method: 'POST', headers, body: '{"bankId":"override"}' })).status, 422);
  assert.equal(f.calls.filter(call => ['authorise', 'resume'].includes(call.name)).length, 0);
  const authorised = await fetch(path + '/authorise', { method: 'POST', headers, body: '{}' }); assert.equal(authorised.status, 200);
  const resumed = await fetch(path + '/resume', { method: 'POST', headers, body: '{}' }); assert.equal(resumed.status, 202);
  assert.equal(f.calls.find(call => call.name === 'authorise').input.id, f.job.id);
  assert.equal(f.calls.find(call => call.name === 'resume').input, f.job.id);
  assert.equal(f.calls.filter(call => call.name === 'start').length, 0);
}));

test('account and catalog reads never create consent or payment instructions, and explicit connection tests accept no financial payload', () => fixture(async f => {
  const headers = await f.login();
  for (const path of ['/bank/banks', '/bank/accounts', '/bank/balances', '/integrations/catalog'])
    assert.equal((await fetch(f.base + path, { headers })).status, 200, path);
  assert.equal(f.calls.filter(call => ['start', 'authorise', 'consent', 'worker'].includes(call.name)).length, 0);
  assert.equal((await fetch(f.base + '/bank/test', { method: 'POST', headers, body: '{"amount":999}' })).status, 422);
  assert.equal((await fetch(f.base + '/bank/test', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal(f.calls.filter(call => call.name === 'test').length, 1);
}));

test('bank redirect retains the same authenticated platform session binding without an environment cookie', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-bank-callback-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'), JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'), JEROC_TENANT_DATA_DIR: directory,
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Private-Bank-Callback-Fixture-2026!' };
  let gateway, server; const calls = [];
  try {
    gateway = await createTenantGateway({ env, makeServices: async options => {
      const service = await createTenantServices(options);
      service.bankService.settings = async context => { calls.push({ name: 'settings', context }); return { mode: 'sandbox', simulation: true, settings: {}, configuration: {} }; };
      service.bankService.completeAuthorisation = async (query, context) => { calls.push({ name: 'callback', query, context }); return {}; };
      return service;
    } });
    server = createServer((req, res) => { void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, cookies = new Map(); let session;
    async function request(path, payload, extra = {}) {
      const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(session && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': String(session.generation) }), ...extra },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      for (const raw of response.headers.getSetCookie()) { const [key, value] = raw.split(';')[0].split('='); if (value) cookies.set(key, value); else cookies.delete(key); }
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (body?.authenticated) session = body;
      return { response, body };
    }
    assert.equal((await request('/api/platform/login', { username: 'admin', password: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD })).response.status, 200);
    assert.equal((await request('/api/platform/change-password', { currentPassword: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD, newPassword: 'Changed-Private-Bank-Callback-Fixture-2026!' })).response.status, 200);
    assert.equal((await request('/api/environment/bank/settings')).response.status, 200);
    assert.equal(cookies.has('jeroc_environment_staff'), false);
    const redirected = await request('/api/integrations/openpayments/callback?state=test-return-state&code=test-return-code', undefined, { Origin: 'https://testbank.invalid', 'sec-fetch-site': 'cross-site' });
    assert.equal(redirected.response.status, 303); assert.match(redirected.response.headers.get('location'), /bankAuth=ok/);
    const original = calls.find(call => call.name === 'settings').context, returned = calls.find(call => call.name === 'callback').context;
    assert.equal(returned.organisationId, original.organisationId); assert.equal(returned.actorId, original.actorId);
    assert.equal(returned.effectiveUserId, original.effectiveUserId); assert.equal(returned.sessionKey, original.sessionKey);
    assert.equal(returned.sessionKey.length, 64); assert.equal(redirected.response.headers.get('referrer-policy'), 'no-referrer');
    cookies.clear(); const anonymous = await request('/api/integrations/openpayments/callback?state=test-return-state&code=test-return-code');
    assert.equal(anonymous.response.status, 401); assert.equal(calls.filter(call => call.name === 'callback').length, 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true });
  }
});
