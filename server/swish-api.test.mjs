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
import { createSwishPayments } from './swish-payments.mjs';

// The real cookie, CSRF and environment request scope are exercised here. The
// provider stubs only record calls; no bank, Swish or Spiris writes occur.
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-swish-api-'));
  const repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const applicationRepository = await createApplicationRepository({ env: {}, filename: ':memory:', seed: initialApplicationState });
  const principalStore = createPricingStore(), calls = [];
  const job = { id: randomUUID(), status: 'queued', mode: 'mss', simulation: true };
  // CompanyIdentifier is an opaque string in Spiris; only the bank-account ID
  // has the UUID contract. Exercise the real settings schema and persistence.
  const companyId = 'sandbox-company-123', bankAccountId = randomUUID();
  const record = (name, input, context) => {
    calls.push({ name, input: structuredClone(input), organisationId: context?.organisationId,
      actorId: context?.actorId, effectiveUserId: context?.effectiveUserId });
  };
  const payments = createSwishPayments({ getRepository: async () => applicationRepository, env: {}, client: {
    configurationStatus: async () => ({ ready: true, mode: 'mss', issues: [], missing: [] }),
  } });
  const swishService = {
    async settings(context) { record('settings', null, context); return payments.settings(context); },
    async saveSettings(input, context) { record('saveSettings', input, context); return payments.saveSettings(input, context); },
    async prepare(id, context) { record('prepare', id, context); return { cardId: id, canStart: true }; },
    async start(input, context) { record('start', input, context); return job; },
    async sandboxSend(input, context) { record('sandboxSend', input, context); return job; },
    async job(id, context) { record('job', id, context); return job; },
    async getCardJobs(id, context) { record('getCardJobs', id, context); return []; },
    async refresh(id, context) { record('refresh', id, context); return job; },
    async resume(id, context) { record('resume', id, context); return job; },
    async processQueuedPayments() { record('worker'); },
    async integrationStatus() { record('catalog'); return { mode: 'test', configured: true, connected: false }; },
  };
  const vismaService = {
    async paymentChoices(context) { record('choices', null, context); return { environment: 'sandbox', companyId,
      bankAccounts: [{ id: bankAccountId, active: true, currency: 'SEK' }] }; },
    async integrationStatus() { return { mode: 'test', configured: true, connected: false }; },
  };
  const api = createEnvironmentApi({ repository, principalStore, env: {}, swishService, vismaService });
  const server = createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port, base = origin + '/api/environment';
  async function login(userId = 'admin') {
    const result = await fetch(base + '/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }) });
    assert.equal(result.status, 200);
    const session = await result.json();
    return { Cookie: result.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json',
      'X-Environment-CSRF': session.csrfToken, 'X-Environment-Actual-User': userId, 'X-Environment-Effective-User': userId };
  }
  try { await run({ base, origin, login, calls, job, companyId, bankAccountId }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close(); await applicationRepository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('payment routes require a real staff session, payout rights, same-origin and CSRF before reserving a job', async () => fixture(async f => {
  assert.equal((await fetch(f.base + '/payments/cards/3024/prepare')).status, 401);
  const headers = await f.login();
  assert.equal((await fetch(f.base + '/payments/cards/3024/prepare', { headers })).status, 200);
  const badCsrf = { ...headers, 'X-Environment-CSRF': 'wrong' };
  assert.equal((await fetch(f.base + '/payments', { method: 'POST', headers: badCsrf, body: '{"cardId":3024}' })).status, 403);
  assert.equal((await fetch(f.base + '/payments', { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{"cardId":3024}' })).status, 403);
  assert.equal(f.calls.filter(call => call.name === 'start').length, 0);
  const response = await fetch(f.base + '/payments', { method: 'POST', headers, body: '{"cardId":3024}' });
  assert.equal(response.status, 202); assert.equal((await response.json()).id, f.job.id);
  assert.equal(f.calls.find(call => call.name === 'start').organisationId, 'jeroc-demo');
  assert.equal(f.calls.find(call => call.name === 'start').actorId, 'admin');
}));

test('Swish settings pin the selected SEK bank account to the verified Spiris sandbox company', async () => fixture(async f => {
  const headers = await f.login();
  const save = input => fetch(f.base + '/swish/settings', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await save({ enabled: true, bookkeepingEnabled: true, spirisBankAccountId: randomUUID() })).status, 422);
  assert.equal((await save({ enabled: true, bookkeepingEnabled: true, spirisBankAccountId: f.bankAccountId, spirisCompanyId: randomUUID() })).status, 409);
  assert.equal(f.calls.filter(call => call.name === 'saveSettings').length, 0);
  const response = await save({ enabled: true, bookkeepingEnabled: true, spirisBankAccountId: f.bankAccountId });
  assert.equal(response.status, 200);
  const saved = (await response.json()).settings;
  assert.equal(saved.spirisCompanyId, f.companyId);
  assert.equal(saved.spirisBankAccountId, f.bankAccountId);
  const settings = await fetch(f.base + '/swish/settings', { headers });
  assert.equal(settings.status, 200);
  assert.deepEqual((await settings.json()).settings, saved);
  assert.equal(f.calls.filter(call => call.name === 'saveSettings').length, 1);
}));

test('sandbox jobs and status refresh preserve the ID and never create a second payout instruction', async () => fixture(async f => {
  const headers = await f.login();
  assert.equal((await fetch(f.base + '/swish/sandbox', { method: 'POST', headers, body: '{}' })).status, 202);
  assert.equal((await fetch(f.base + '/swish/jobs/' + f.job.id, { headers })).status, 200);
  assert.equal((await fetch(f.base + '/swish/jobs/' + f.job.id + '/refresh', { method: 'POST', headers, body: '{}' })).status, 202);
  assert.equal((await fetch(f.base + '/payments/' + f.job.id + '/refresh', { method: 'POST', headers, body: '{"amount":999}' })).status, 422);
  assert.equal(f.calls.filter(call => call.name === 'sandboxSend').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'start').length, 0);
  assert.equal(f.calls.find(call => call.name === 'refresh').input, f.job.id);
}));

test('blocked status refresh is read back and explicit resume has its own protected empty-body action', async () => fixture(async f => {
  const headers = await f.login(), path = f.base + '/payments/' + f.job.id;
  f.job.status = 'blocked';
  const refreshed = await fetch(path + '/refresh', { method: 'POST', headers, body: '{}' });
  assert.equal(refreshed.status, 200);
  assert.equal(f.calls.filter(call => call.name === 'refresh').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'resume' || call.name === 'worker').length, 0);
  assert.equal((await fetch(path + '/resume', { method: 'POST', headers: { ...headers, 'X-Environment-CSRF': 'wrong' }, body: '{}' })).status, 403);
  assert.equal((await fetch(path + '/resume', { method: 'POST', headers, body: '{"amount":999}' })).status, 422);
  assert.equal((await fetch(f.base + '/swish/jobs/' + f.job.id + '/resume', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal(f.calls.filter(call => call.name === 'resume').length, 0);
  const resumed = await fetch(path + '/resume', { method: 'POST', headers, body: '{}' });
  assert.equal(resumed.status, 202); assert.equal((await resumed.json()).id, f.job.id);
  assert.equal(f.calls.find(call => call.name === 'resume').input, f.job.id);
  assert.equal(f.calls.find(call => call.name === 'resume').organisationId, 'jeroc-demo');
  assert.equal(f.calls.filter(call => call.name === 'start' || call.name === 'sandboxSend').length, 0);
}));

test('the integration catalog exposes the Swish test adapter without sending or provisioning a payout', async () => fixture(async f => {
  const headers = await f.login();
  const response = await fetch(f.base + '/integrations/catalog', { headers }); assert.equal(response.status, 200);
  const value = await response.json(), swish = value.providers.find(provider => provider.id === 'swish');
  assert.equal(swish.implemented, true); assert.equal(swish.mode, 'test'); assert.equal(swish.connected, false);
  assert.equal(f.calls.filter(call => ['settings', 'start', 'sandboxSend', 'worker'].includes(call.name)).length, 0);
}));
