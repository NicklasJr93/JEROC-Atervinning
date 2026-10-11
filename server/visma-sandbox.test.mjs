import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplicationRepository } from './application-storage.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';

const companyId = '55c5ec9b-4e91-4d10-b41e-c58f7ab0a0d2';
const supplierId = '1831c176-4020-4a9c-9fe5-1f8b2fdb0d91';
const fiscalYearId = '6a767af7-43b7-42e8-9d10-cc3e1c02f7db';
const termsOfPaymentId = 'fe2a84d6-8f5b-4f4d-a606-69d57b73a2f6';
const accessToken = 'synthetic-visma-access-token-one';
const refreshToken = 'synthetic-visma-refresh-token-one';
const authorizationCode = 'synthetic-visma-authorization-code';
const grantedScopes = 'ea:api offline_access ea:purchase ea:accounting ea:sales';
const verifiedCompany = () => response({ CompanyIdentifier: companyId, Name: 'Synthetic sandbox company', CorporateIdentityNumber: '5560000000' });
const context = {
  organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'live-session',
  actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' },
};
const request = (operation = 'suppliers', extra = {}) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), operation,
  ...(operation === 'accounts' ? { parameters: { fiscalYearId } } : {}),
  ...(operation === 'createSupplier' ? { payload: { Name: 'Synthetic sandbox supplier', TermsOfPaymentId: termsOfPaymentId } } : {}),
  ...(operation === 'createDraft' ? { payload: { SupplierId: supplierId, IsCreditInvoice: false, Rows: [{ AccountNumber: 4000, DebitAmount: 10, CreditAmount: 0 }] } } : {}),
  ...extra });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const errorCode = code => error => error.code === code;

async function fixture(run, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-visma-sandbox-'));
  const filename = join(directory, 'application.sqlite');
  let repository = await createApplicationRepository({ env: {}, filename, seed: () => ({ office: { cards: [{ id: 'unchanged-office-card' }] }, imports: [] }) });
  let time = new Date('2026-10-11T10:00:00Z');
  const now = () => new Date(time);
  const env = {
    VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'synthetic-visma-client-id', VISMA_CLIENT_SECRET: 'synthetic-visma-client-secret',
    VISMA_REDIRECT_URI: 'https://app.example/api/integrations/visma/oauth/callback',
    VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), VISMA_SANDBOX_COMPANY_ID: companyId, ...extraEnv,
  };
  const calls = [];
  const approvals = [];
  let tokenHandler = async () => response({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: 'Bearer', scope: grantedScopes });
  let apiHandler = async call => {
    if (call.url.pathname === '/v2/companysettings') return verifiedCompany();
    if (call.method === 'POST') return response({ Id: supplierId, Name: 'Synthetic sandbox supplier' }, 201);
    return response([{ Id: supplierId, Name: 'Synthetic sandbox supplier' }]);
  };
  const fetchImpl = async (url, options = {}) => {
    const call = { url: new URL(String(url)), method: options.method ?? 'GET', headers: new Headers(options.headers), body: options.body };
    calls.push(call);
    if (call.url.href === 'https://identity.vismaonline.com/connect/token') return tokenHandler(call);
    assert.equal(call.url.origin, 'https://eaccountingapi.vismaonline.com', 'Only the documented Visma API may receive requests');
    return apiHandler(call);
  };
  const makeService = () => createVismaSandbox({ getRepository: async () => repository, sourceProvider: async () => structuredClone(approvals), env, fetchImpl, now });
  let service = makeService();
  const f = {
    env, calls, now, makeService, approvals,
    get service() { return service; }, get repository() { return repository; },
    advance: milliseconds => { time = new Date(time.getTime() + milliseconds); },
    setTime: value => { time = new Date(value); },
    setApi: handler => { apiHandler = handler; }, setToken: handler => { tokenHandler = handler; },
    setOperation: handler => { apiHandler = call => call.url.pathname === '/v2/companysettings' ? verifiedCompany() : handler(call); },
    apiCalls: () => calls.filter(call => call.url.origin === 'https://eaccountingapi.vismaonline.com'),
    tokenCalls: () => calls.filter(call => call.url.href === 'https://identity.vismaonline.com/connect/token'),
    snapshot: () => repository.read((state, revision) => ({ state, revision })),
    persistedText() {
      const db = new DatabaseSync(filename, { readOnly: true });
      try { return JSON.stringify({ application: db.prepare('SELECT document FROM application').all(), audit: db.prepare('SELECT details FROM application_audit').all() }); }
      finally { db.close(); }
    },
    async persistedBytes() {
      const files = (await readdir(directory)).filter(name => name.startsWith('application.sqlite'));
      return Buffer.concat(await Promise.all(files.map(name => readFile(join(directory, name)))));
    },
    async connect(ctx = context) {
      const started = await service.begin(ctx);
      const state = new URL(started.authorizationUrl).searchParams.get('state');
      assert.ok(state); assert.ok(started.cookieBinding); assert.ok(Date.parse(started.expiresAt));
      assert.deepEqual(await service.callback({ state, code: authorizationCode, error: null, cookieBinding: started.cookieBinding }), { completed: true });
      return service.complete(ctx);
    },
    async restart() {
      await repository.close();
      repository = await createApplicationRepository({ env: {}, filename, seed: () => ({}) });
      service = makeService();
    },
  };
  try { await run(f); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('Visma status is local and admin-only without mutating application data', async () => fixture(async f => {
  const before = await f.snapshot();
  const status = await f.service.status(context);
  assert.equal(status.connected, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.snapshot(), before);
  const ordinary = { ...context, actorId: 'staff', effectiveUserId: 'staff', actor: { id: 'staff', level: 'Personal' }, user: { id: 'staff', level: 'Personal' } };
  const impersonated = { ...context, effectiveUserId: 'staff', user: { id: 'staff', level: 'Personal' } };
  for (const ctx of [ordinary, impersonated, { ...context, organisationId: 'other-organisation' },
    { ...context, actor: { ...context.actor, siteIds: ['norrtalje'] } }, { ...context, user: { ...context.user, siteIds: ['norrtalje'] } }]) {
    for (const action of [() => f.service.status(ctx), () => f.service.begin(ctx), () => f.service.complete(ctx), () => f.service.disconnect(ctx), () => f.service.send(request(), ctx), () => f.service.run(randomUUID(), ctx)])
      await assert.rejects(action, failure => failure.status === 403);
  }
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.snapshot(), before);
}));

test('attested source is read-only and its reference is rechecked before provider dispatch and retained in idempotent history', async () => fixture(async f => {
  f.approvals.push({ id: randomUUID(), cardId: 3016, version: 1, status: 'attested', approvedAt: f.now().toISOString(),
    approvedMethod: 'staff_checked_id_demo', approvedHash: 'a'.repeat(64), attestedAt: f.now().toISOString(), attestedBy: 'Anna',
    snapshot: { hash: 'a'.repeat(64), card: { id: 3016 }, customer: { name: 'Frozen fixture', type: 'Privatperson' },
      rows: [{ articleId: 'copper-1', name: 'Koppar', weight: 10, price: 1, amount: 10 }], gross: 10, offset: 0, net: 10, paymentMethod: 'cash' } });
  const before = await f.snapshot(), list = await f.service.attestedCards(context), prefill = await f.service.prefill(3016, context);
  assert.equal(list.cards.length, 1); assert.equal(prefill.supplier.Name, 'Frozen fixture'); assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(() => f.service.attestedCards({ ...context, user: { ...context.user, level: 'Medarbetare' } }), errorCode('forbidden'));
  const source = { cardId: 3016, approvalId: list.cards[0].approvalId, version: 1, hash: list.cards[0].hash };
  await f.connect();
  const bad = request('createSupplier', { source: { ...source, hash: 'b'.repeat(64) } }), calls = f.calls.length;
  await assert.rejects(() => f.service.send(bad, context), errorCode('visma_source_changed')); assert.equal(f.calls.length, calls);
  const input = request('createSupplier', { source }), sent = await f.service.send(input, context);
  assert.equal(sent.status, 'accepted'); assert.deepEqual(sent.source, source);
  assert.equal(JSON.parse(f.apiCalls().find(call => call.method === 'POST').body).source, undefined, 'Source metadata is local and never a Spiris payload field');
  const after = f.calls.length;
  assert.deepEqual(await f.service.send(input, context), sent); assert.equal(f.calls.length, after);
  await assert.rejects(() => f.service.send({ ...input, source: { ...source, version: 2 } }, context), errorCode('idempotency_conflict'));
  f.setApi(call => { assert.equal(call.method, 'GET'); f.approvals[0].status = 'cancelled'; return verifiedCompany(); });
  const prevented = await f.service.send(request('createSupplier', { source }), context);
  assert.equal(prevented.status, 'rejected'); assert.equal(prevented.error.code, 'visma_source_unattested');
  assert.equal(f.apiCalls().filter(call => call.method === 'POST').length, 1);
  assert.deepEqual((await f.snapshot()).state.office, before.state.office);
}));

test('OAuth uses state, PKCE and browser binding; invalid, expired and replayed states cannot redeem a code', async () => fixture(async f => {
  const started = await f.service.begin(context), url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), f.env.VISMA_REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  const state = url.searchParams.get('state');
  await assert.rejects(() => f.service.callback({ state, code: authorizationCode, cookieBinding: 'wrong-browser-binding' }), errorCode('visma_oauth_state_invalid'));
  await assert.rejects(() => f.service.callback({ state: randomUUID(), code: authorizationCode, cookieBinding: started.cookieBinding }), errorCode('visma_oauth_state_invalid'));
  assert.equal(f.calls.length, 0);
  await f.service.callback({ state, code: authorizationCode, cookieBinding: started.cookieBinding });
  assert.equal(f.calls.length, 0, 'The callback must wait for the initiating admin session before exchanging credentials');
  await assert.rejects(() => f.service.callback({ state, code: authorizationCode, cookieBinding: started.cookieBinding }), errorCode('visma_oauth_state_invalid'));
  assert.equal(f.calls.length, 0);
  await f.service.complete(context);
  assert.equal(f.tokenCalls().length, 1);
  const expired = await f.service.begin(context), expiredState = new URL(expired.authorizationUrl).searchParams.get('state');
  f.setTime(Date.parse(expired.expiresAt) + 1);
  await assert.rejects(() => f.service.callback({ state: expiredState, code: authorizationCode, cookieBinding: expired.cookieBinding }), errorCode('visma_oauth_state_invalid'));
  assert.equal(f.tokenCalls().length, 1);
}));

test('relayed localhost response preserves the registered URI, browser binding, PKCE and initiating admin session', async () => fixture(async f => {
  assert.equal((await f.service.status(context)).localCallbackRelay, true);
  const started = await f.service.begin(context), authorize = new URL(started.authorizationUrl);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://localhost:44300/callback');
  const state = authorize.searchParams.get('state');
  await assert.rejects(() => f.service.callback({ state, code: authorizationCode }), errorCode('visma_oauth_state_invalid'));
  await f.service.callback({ state, code: authorizationCode, cookieBinding: started.cookieBinding });
  await assert.rejects(() => f.service.complete({ ...context, sessionKey: 'different-session' }), errorCode('visma_oauth_pending_missing'));
  assert.equal(f.tokenCalls().length, 0);
  await f.service.complete(context);
  const exchange = new URLSearchParams(f.tokenCalls()[0].body);
  assert.equal(exchange.get('redirect_uri'), 'https://localhost:44300/callback');
  assert.equal(exchange.get('code'), authorizationCode);
  assert.ok(exchange.get('code_verifier'));
  await assert.rejects(() => f.service.callback({ state, code: authorizationCode, cookieBinding: started.cookieBinding }), errorCode('visma_oauth_state_invalid'));
  assert.equal(f.tokenCalls().length, 1);
}, { VISMA_OAUTH_LOCAL_RELAY: 'true', VISMA_REDIRECT_URI: 'https://localhost:44300/callback', NODE_ENV: 'production', RENDER: 'true' }));

test('OAuth completion belongs to its initiating session and encrypted credentials survive SQLite restart', async () => fixture(async f => {
  const started = await f.service.begin(context), state = new URL(started.authorizationUrl).searchParams.get('state');
  await f.service.callback({ state, code: authorizationCode, cookieBinding: started.cookieBinding });
  await assert.rejects(() => f.service.complete({ ...context, sessionKey: 'different-session' }), errorCode('visma_oauth_pending_missing'));
  assert.equal(f.calls.length, 0);
  const connected = await f.service.complete(context);
  assert.equal(connected.connected, true); assert.equal(connected.companyVerified, true);
  const stored = f.persistedText(), persistedBytes = await f.persistedBytes();
  for (const secret of [accessToken, refreshToken, authorizationCode, f.env.VISMA_CLIENT_SECRET, f.env.VISMA_TOKEN_ENCRYPTION_KEY, started.cookieBinding]) {
    assert.equal(stored.includes(secret), false, 'OAuth secrets must not be persisted in plaintext or audit details');
    assert.equal(persistedBytes.includes(Buffer.from(secret)), false, 'OAuth secrets must not remain in SQLite or its write-ahead log');
  }
  const before = await f.snapshot(), callCount = f.calls.length;
  const publicStatus = JSON.stringify(await f.service.status(context));
  for (const secret of [accessToken, refreshToken, authorizationCode, f.env.VISMA_CLIENT_SECRET, f.env.VISMA_TOKEN_ENCRYPTION_KEY]) assert.equal(publicStatus.includes(secret), false);
  assert.equal(f.calls.length, callCount); assert.deepEqual(await f.snapshot(), before);
  await f.restart();
  assert.equal((await f.service.status(context)).connected, true);
  const result = await f.service.send(request(), context);
  assert.equal(result.status, 'accepted'); assert.equal(f.tokenCalls().length, 1);
  assert.equal(f.apiCalls().at(-1).headers.get('Authorization'), `Bearer ${accessToken}`);
  assert.deepEqual((await f.snapshot()).state.office, before.state.office);
}));

test('OAuth denial consumes its state and an expired completion cannot exchange credentials', async () => fixture(async f => {
  const denied = await f.service.begin(context), deniedState = new URL(denied.authorizationUrl).searchParams.get('state');
  await assert.rejects(() => f.service.callback({ state: deniedState, code: null, error: 'access_denied', cookieBinding: denied.cookieBinding }), errorCode('visma_oauth_denied'));
  await assert.rejects(() => f.service.callback({ state: deniedState, code: authorizationCode, cookieBinding: denied.cookieBinding }), errorCode('visma_oauth_state_invalid'));
  await assert.rejects(() => f.service.complete(context), errorCode('visma_oauth_pending_missing'));
  const expired = await f.service.begin(context), expiredState = new URL(expired.authorizationUrl).searchParams.get('state');
  await f.service.callback({ state: expiredState, code: authorizationCode, error: null, cookieBinding: expired.cookieBinding });
  f.setTime(Date.parse(expired.expiresAt) + 1);
  await assert.rejects(() => f.service.complete(context), errorCode('visma_oauth_pending_missing'));
  assert.equal(f.calls.length, 0);
}));

test('stored tokens cannot be used with a different encryption key and plaintext is never sent as fallback', async () => fixture(async f => {
  await f.connect();
  const originalKey = f.env.VISMA_TOKEN_ENCRYPTION_KEY, callCount = f.calls.length;
  f.env.VISMA_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  const invalidService = f.makeService(), input = request(), rejected = await invalidService.send(input, context);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error.code, 'visma_credentials_unavailable');
  assert.equal(f.calls.length, callCount);
  f.env.VISMA_TOKEN_ENCRYPTION_KEY = originalKey;
  assert.deepEqual(await f.service.send(input, context), rejected);
  assert.equal(f.calls.length, callCount, 'A failed reserved request is durable even after the encryption key is restored');
  assert.equal((await f.service.send(request(), context)).status, 'accepted');
}));

test('a different Visma company is inspectable but blocks every noncompany request before network access', async () => fixture(async f => {
  const unexpectedId = randomUUID();
  f.setApi(async () => response({ CompanyIdentifier: unexpectedId, Name: 'Different sandbox company' }));
  const status = await f.connect();
  assert.equal(status.connected, false); assert.equal(status.companyVerified, false);
  const callCount = f.calls.length;
  for (const operation of ['suppliers', 'createSupplier', 'createDraft'])
    await assert.rejects(() => f.service.send(request(operation), context), errorCode('visma_company_mismatch'));
  assert.equal(f.calls.length, callCount);
  assert.equal((await f.service.status(context)).companyVerified, false);
  await f.restart();
  await assert.rejects(() => f.service.send(request(), context), errorCode('visma_company_mismatch'));
  assert.equal(f.calls.length, callCount);
}));

test('without an expected sandbox company only the company inspection operation may dispatch', async () => fixture(async f => {
  const status = await f.connect();
  assert.equal(status.companyVerified, false);
  const inspected = await f.service.send(request('company'), context);
  assert.equal(inspected.status, 'accepted');
  const callCount = f.calls.length;
  for (const operation of ['suppliers', 'createSupplier', 'createDraft'])
    await assert.rejects(() => f.service.send(request(operation), context), errorCode('visma_company_unverified'));
  assert.equal(f.calls.length, callCount);
}, { VISMA_SANDBOX_COMPANY_ID: '' }));

test('a fresh company check blocks both reads and writes when the provider company changes', async () => fixture(async f => {
  await f.connect();
  const unexpectedId = randomUUID(), before = f.apiCalls().length;
  f.setApi(async call => {
    assert.equal(call.url.pathname, '/v2/companysettings', 'The requested operation must not reach a different company');
    return response({ CompanyIdentifier: unexpectedId, Name: 'Changed company' });
  });
  const rejected = await f.service.send(request('suppliers'), context);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.error.code, 'visma_company_mismatch');
  assert.equal(f.apiCalls().length, before + 1);
  await assert.rejects(() => f.service.send(request('createDraft'), context), errorCode('visma_company_mismatch'));
  assert.equal(f.apiCalls().length, before + 1);
  assert.equal((await f.service.status(context)).companyVerified, false);
}));

test('unknown operations and credential or endpoint injection never reserve or dispatch a request', async () => fixture(async f => {
  await f.connect();
  const before = await f.snapshot(), callCount = f.calls.length;
  for (const input of [
    request('sendToBank'), request('approveSupplierInvoice'), request('suppliers', { url: 'https://unexpected.example' }),
    request('suppliers', { headers: { Authorization: 'Bearer injected' } }), request('suppliers', { accessToken: 'injected-token' }),
    request('createSupplier', { payload: { Name: 'Test', TermsOfPaymentId: termsOfPaymentId, UsesAutomaticSupplierInvoiceApproval: true } }),
    request('createDraft', { payload: { SupplierId: supplierId, IsCreditInvoice: false, Rows: [{ AccountNumber: 4000 }], SkipSendToBank: false } }),
  ]) await assert.rejects(() => f.service.send(input, context), errorCode('visma_invalid'));
  assert.equal(f.calls.length, callCount); assert.deepEqual(await f.snapshot(), before);
}));

test('accepted and rejected requests are durable and conflicting duplicates never resend', async () => fixture(async f => {
  await f.connect();
  const input = request('createSupplier');
  const accepted = await f.service.send(input, context);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.id, input.requestId);
  const callCount = f.calls.length;
  assert.deepEqual(await f.service.send(input, context), accepted);
  await assert.rejects(() => f.service.send({ ...input, requestId: randomUUID() }, context), errorCode('idempotency_conflict'));
  await assert.rejects(() => f.service.send({ ...input, payload: { ...input.payload, Name: 'A different supplier' } }, context), errorCode('idempotency_conflict'));
  assert.equal(f.calls.length, callCount);
  f.setOperation(async () => response({ Message: 'Synthetic validation error', ErrorCode: 2000 }, 400));
  const bad = request('createDraft'), rejected = await f.service.send(bad, context);
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.httpStatus, 400);
  const finalCallCount = f.calls.length;
  await f.restart();
  assert.deepEqual(await f.service.run(accepted.id, context), accepted);
  assert.deepEqual(await f.service.send(input, context), accepted);
  assert.deepEqual(await f.service.send(bad, context), rejected);
  assert.equal(f.calls.length, finalCallCount);
}));

test('an in-flight reservation and an unknown result are never transmitted a second time', async () => fixture(async f => {
  await f.connect();
  let release, signal;
  const gate = new Promise(resolve => { release = resolve; }), dispatched = new Promise(resolve => { signal = resolve; });
  f.setOperation(async () => { signal(); await gate; throw new Error('Synthetic lost response with unknown outcome'); });
  const input = request('createDraft'), first = f.service.send(input, context);
  try {
    await dispatched;
    const secondService = f.makeService();
    assert.equal((await secondService.send(input, context)).status, 'in_flight');
    assert.equal((await secondService.run(input.requestId, context)).status, 'in_flight');
  } finally { release(); }
  const result = await first;
  assert.equal(result.status, 'unknown');
  const callCount = f.calls.length;
  await f.restart();
  assert.deepEqual(await f.service.send(input, context), result);
  assert.deepEqual(await f.service.run(input.requestId, context), result);
  assert.equal(f.calls.length, callCount);
}));

test('two service instances refresh once and persist the rotated refresh token before later use', async () => fixture(async f => {
  await f.connect(); f.advance(3600001);
  let refreshes = 0, release, signal;
  const gate = new Promise(resolve => { release = resolve; }), refreshing = new Promise(resolve => { signal = resolve; });
  f.setToken(async call => {
    const form = new URLSearchParams(call.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    refreshes++;
    assert.equal(form.get('refresh_token'), refreshes === 1 ? refreshToken : 'synthetic-visma-refresh-token-two');
    if (refreshes === 1) { signal(); await gate; }
    return response({ access_token: `synthetic-visma-refreshed-access-${refreshes}`, refresh_token: refreshes === 1 ? 'synthetic-visma-refresh-token-two' : 'synthetic-visma-refresh-token-three', expires_in: 3600, token_type: 'Bearer', scope: grantedScopes });
  });
  const secondService = f.makeService(), first = f.service.send(request('suppliers'), context);
  await refreshing;
  const second = secondService.send(request('accounts'), context);
  await new Promise(resolve => setImmediate(resolve));
  const concurrentRefreshes = refreshes;
  release();
  const results = await Promise.all([first, second]);
  assert.equal(concurrentRefreshes, 1, 'Concurrent service instances must share the refresh operation');
  assert.deepEqual(results.map(result => result.status), ['accepted', 'accepted']);
  assert.equal(refreshes, 1);
  assert.equal(f.persistedText().includes('synthetic-visma-refresh-token-two'), false);
  assert.equal((await f.persistedBytes()).includes(Buffer.from('synthetic-visma-refresh-token-two')), false);
  await f.restart(); f.advance(3600001);
  assert.equal((await f.service.send(request(), context)).status, 'accepted');
  assert.equal(refreshes, 2);
}));

test('disconnect removes usable credentials and later requests cannot dispatch', async () => fixture(async f => {
  await f.connect(); await f.service.disconnect(context);
  assert.equal((await f.service.status(context)).connected, false);
  const callCount = f.calls.length;
  await assert.rejects(() => f.service.send(request(), context), failure => failure.status === 409 || failure.status === 503);
  assert.equal(f.calls.length, callCount);
  await f.restart(); assert.equal((await f.service.status(context)).connected, false);
}));
