import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentApi } from './environment-api.mjs';

const now = () => new Date('2026-10-11T10:00:00Z');
const sampleRun = { id: randomUUID(), status: 'accepted', operation: 'company', method: 'GET', path: '/v2/companysettings',
  startedAt: now().toISOString(), finishedAt: now().toISOString(), httpStatus: 200,
  response: { Id: 'sandbox-company', Name: 'Local sandbox fixture' }, trackingId: 'local-visma-api-fixture' };

// Exercise the real environment cookie, request snapshot and CSRF checks. The
// injected provider only records calls and never contacts OAuth or Spiris.
async function fixture(run, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-visma-api-'));
  const repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const pricing = createPricingStore({ now }), scopes = new Map(), calls = [];
  const principalStore = { ...pricing, principal(actor, user) {
    const principal = pricing.principal(actor, user);
    for (const account of [principal.actor, principal.user]) {
      // A staff account may be granted catalog access without being permitted
      // to operate the Systemadmin sandbox.
      if (account.id === 'lars') account.permissions = [...account.permissions, 'integrationsRead'];
      if (scopes.has(account.id)) account.siteIds = scopes.get(account.id);
    }
    return principal;
  } };
  const record = (method, context, input) => {
    const { reauthorize, ...publicContext } = context;
    calls.push({ method, context: structuredClone(publicContext), input: structuredClone(input) });
  };
  const status = { mode: 'sandbox', configured: true, connected: true, companyVerified: true, expectedCompanyId: 'sandbox-company',
    company: { id: 'sandbox-company', name: 'Local sandbox fixture', number: '5560000167' }, runs: [] };
  const vismaService = {
    async status(context) { record('status', context); return status; },
    async attestedCards(context) { record('attestedCards', context); return { cards: [] }; },
    async prefill(id, context) { record('prefill', context, id); return { source: { cardId: id } }; },
    async settings(context) { record('settings', context); return { settings: { revision: 0 } }; },
    async saveSettings(input, context) { record('saveSettings', context, input); return { settings: input.settings }; },
    async lookupChoices(context) { record('lookupChoices', context); return { choices: { paymentTerms: [] } }; },
    async preview(input, context) { record('preview', context, input); return { rows: [] }; },
    async exports(context) { record('exports', context); return { exports: [] }; },
    async sendExport(input, context) { record('sendExport', context, input); return { id: 'export-example', status: 'accepted' }; },
    async begin(context) { record('begin', context); return { authorizationUrl: 'https://oauth.fixture.invalid/authorize?state=public-fixture-state', cookieBinding: 'opaque-server-only-binding', expiresAt: '2026-10-11T10:10:00Z' }; },
    async complete(context) { record('complete', context); return status; },
    async disconnect(context) { record('disconnect', context); return { ...status, connected: false }; },
    async send(input, context) { record('send', context, input); return { ...sampleRun, id: input.requestId }; },
    async run(id, context) { record('run', context, id); return { ...sampleRun, id }; },
    async integrationStatus(context) { record('integrationStatus', context); return { mode: 'test', configured: true, connected: true, accessToken: 'PRIVATE-FIXTURE-TOKEN', company: { private: true } }; },
  };
  const api = createEnvironmentApi({ repository, principalStore, env, now, vismaService });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, base = `${origin}/api/environment`;
  async function login(userId = 'admin', effectiveUserId = userId) {
    const response = await fetch(`${base}/demo-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, effectiveUserId }) });
    assert.equal(response.status, 200);
    const state = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    return { state, cookie, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Environment-CSRF': state.csrfToken,
      'X-Environment-Actual-User': state.actualUserId, 'X-Environment-Effective-User': state.effectiveUserId } };
  }
  try { await run({ base, origin, calls, scopes, login, status }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close(); await rm(directory, { recursive: true, force: true }); }
}

test('Visma bridge requires an actual and effective unrestricted Systemadmin on every provider route', async () => fixture(async f => {
  const admin = await f.login(), lars = await f.login('lars'), impersonated = await f.login('admin', 'lars');
  const input = { requestId: randomUUID(), idempotencyKey: randomUUID(), operation: 'company' };
  const routes = [ ['GET', '/visma/status'], ['GET', '/visma/attested-cards'], ['GET', '/visma/attested-cards/3016'], ['GET', `/visma/sandbox/runs/${sampleRun.id}`],
    ['POST', '/visma/oauth/start'], ['POST', '/visma/oauth/complete'], ['POST', '/visma/disconnect'], ['POST', '/visma/sandbox'],
    ['GET', '/visma/accounting/settings'], ['POST', '/visma/accounting/settings'], ['POST', '/visma/accounting/choices'],
    ['POST', '/visma/accounting/preview'], ['GET', '/visma/accounting/exports'], ['POST', '/visma/accounting/exports'] ];
  for (const [method, path] of routes) {
    const request = headers => fetch(`${f.base}${path}`, { method, headers, ...(method === 'POST' && { body: JSON.stringify(path === '/visma/sandbox' ? input : {}) }) });
    assert.equal((await request({ 'Content-Type': 'application/json' })).status, 401, path);
    for (const session of [lars, impersonated]) assert.equal((await request(session.headers)).status, 403, path);
    f.scopes.set('admin', ['norrtalje']);
    assert.equal((await request(admin.headers)).status, 403, path);
    f.scopes.delete('admin');
  }
  assert.deepEqual(f.calls, []);
}));

test('attested card listing and prefill are authenticated read-only routes', async () => fixture(async f => {
  const admin = await f.login();
  const list = await fetch(`${f.base}/visma/attested-cards`, { headers: admin.headers });
  assert.equal(list.status, 200); assert.deepEqual(await list.json(), { cards: [] });
  const filled = await fetch(`${f.base}/visma/attested-cards/3016`, { headers: admin.headers });
  assert.equal(filled.status, 200); assert.deepEqual(await filled.json(), { source: { cardId: 3016 } });
  assert.deepEqual(f.calls.map(call => call.method), ['attestedCards', 'prefill']); assert.equal(f.calls[1].input, 3016);
  for (const id of ['-1', '0', '3016abc', '123456789012345']) assert.equal((await fetch(`${f.base}/visma/attested-cards/${id}`, { headers: admin.headers })).status, 404);
  assert.equal((await fetch(`${f.base}/visma/attested-cards/3016`, { method: 'POST', headers: admin.headers, body: '{}' })).status, 404);
  assert.equal(f.calls.length, 2);
}));

test('Visma writes check live CSRF, expected identities and origin before invoking the service', async () => fixture(async f => {
  const admin = await f.login(), body = JSON.stringify({ requestId: randomUUID(), idempotencyKey: randomUUID(), operation: 'company' });
  for (const patch of [ { 'X-Environment-CSRF': '' }, { 'X-Environment-CSRF': 'wrong-token' },
    { 'X-Environment-Actual-User': 'lars' }, { 'X-Environment-Effective-User': 'lars' },
    { Origin: 'https://another.fixture.invalid' }, { 'Sec-Fetch-Site': 'cross-site' } ]) {
    const response = await fetch(`${f.base}/visma/sandbox`, { method: 'POST', headers: { ...admin.headers, ...patch }, body });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(f.calls, []);
  const accepted = await fetch(`${f.base}/visma/sandbox`, { method: 'POST', headers: admin.headers, body });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).status, 'accepted'); assert.equal(f.calls.length, 1);
}));

test('Visma context derives tenant, live principals and session hash from the authenticated cookie', async () => fixture(async f => {
  const admin = await f.login();
  const forged = { ...admin.headers, 'X-Organisation-Id': 'other-tenant', 'X-Tenant-Id': 'other-tenant', 'X-Session-Key': 'browser-session' };
  const response = await fetch(`${f.base}/visma/status?organisationId=other-tenant&sessionKey=browser-session`, { headers: forged });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), f.status);
  const token = decodeURIComponent(admin.cookie.slice(admin.cookie.indexOf('=') + 1)), context = f.calls[0].context;
  assert.equal(context.organisationId, 'jeroc-demo'); assert.equal(context.actorId, 'admin'); assert.equal(context.effectiveUserId, 'admin');
  assert.equal(context.actor.level, 'Systemadmin'); assert.equal(context.user.level, 'Systemadmin');
  assert.equal(context.sessionKey, createHash('sha256').update(token).digest('hex')); assert.notEqual(context.sessionKey, token);
  const second = await f.login();
  assert.equal((await fetch(`${f.base}/visma/status`, { headers: second.headers })).status, 200);
  assert.notEqual(f.calls[1].context.sessionKey, context.sessionKey);
  assert.ok(!JSON.stringify(await (await fetch(`${f.base}/visma/status`, { headers: admin.headers })).json()).includes(token));
}));

test('OAuth start exposes only the authorization URL and places binding in its scoped HttpOnly cookie', async () => fixture(async f => {
  const admin = await f.login();
  const response = await fetch(`${f.base}/visma/oauth/start`, { method: 'POST', headers: admin.headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authorizationUrl: 'https://oauth.fixture.invalid/authorize?state=public-fixture-state', expiresAt: '2026-10-11T10:10:00Z' });
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^jeroc_visma_oauth=opaque-server-only-binding;/);
  assert.match(cookie, /; Path=\/api\/integrations\/visma\/oauth\/callback;/); assert.match(cookie, /; HttpOnly;/);
  assert.match(cookie, /; SameSite=Lax;/); assert.match(cookie, /; Max-Age=600/);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const secure = await fetch(`${f.base}/visma/oauth/start`, { method: 'POST', headers: { ...admin.headers, 'X-Forwarded-Proto': 'https' }, body: '{}' });
  assert.match(secure.headers.get('set-cookie'), /; Secure;/);
}));

test('OAuth and disconnect actions reject browser credentials, endpoints and tenant fields before service dispatch', async () => fixture(async f => {
  const admin = await f.login();
  for (const path of ['/visma/oauth/start', '/visma/oauth/complete', '/visma/disconnect']) {
    for (const input of [ { clientId: 'browser-client' }, { clientSecret: 'browser-secret' }, { redirectUri: 'https://another.fixture.invalid/callback' },
      { organisationId: 'other-tenant' }, { cookieBinding: 'browser-binding' }, { code: 'browser-code' }, { headers: { Authorization: 'browser-token' } } ]) {
      const response = await fetch(`${f.base}${path}`, { method: 'POST', headers: admin.headers, body: JSON.stringify(input) });
      assert.equal(response.status, 422, path); assert.equal((await response.json()).code, 'visma_invalid');
    }
  }
  assert.deepEqual(f.calls, []);
}));

test('catalog narrows the Visma adapter to the server organisation and removes provider secrets', async () => fixture(async f => {
  const admin = await f.login(), lars = await f.login('lars');
  for (const session of [admin, lars]) {
    const response = await fetch(`${f.base}/integrations/catalog?organisationId=other-tenant`, { headers: { ...session.headers, 'X-Organisation-Id': 'other-tenant' } });
    assert.equal(response.status, 200); const catalog = await response.json(), visma = catalog.providers.find(provider => provider.id === 'visma');
    assert.equal(catalog.organisationId, 'jeroc-demo'); assert.equal(visma.implemented, true); assert.equal(visma.connected, true);
    assert.equal(visma.capabilities.canConfigure, session.state.actualUserId === 'admin');
    assert.ok(!JSON.stringify(catalog).includes('PRIVATE-FIXTURE-TOKEN')); assert.equal(Object.hasOwn(visma, 'company'), false);
  }
  const catalogCalls = f.calls.filter(call => call.method === 'integrationStatus'); assert.equal(catalogCalls.length, 2);
  for (const call of catalogCalls) {
    assert.equal(call.context.organisationId, 'jeroc-demo'); assert.deepEqual(call.context.allowedOrganisationIds, ['jeroc-demo']);
    assert.equal(call.context.canRead, true); assert.equal(Object.hasOwn(call.context, 'sessionKey'), false);
  }
  assert.equal(catalogCalls[0].context.canManage, true); assert.equal(catalogCalls[1].context.canManage, false);
}));
