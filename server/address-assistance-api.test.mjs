import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createAddressAssistanceApi } from './address-assistance-api.mjs';
import { createGoogleAddressValidation, GoogleAddressValidationError } from './google-address-validation.mjs';
import { PlatformError } from './platform-auth.mjs';

const address = { address: 'Exempelvägen 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };
const proposal = { address, verdict: { addressComplete: true, requiresConfirmation: true } };
const principal = { rateKey: 'company-a:actor-a', tenantRateKey: 'company-a', scopeKey: 'company-a:actor-a:session-a' };
const configPath = '/api/address-assistance/config', validatePath = '/api/address-assistance/validate';

async function fixture(run, options = {}) {
  let calls = 0, authorizations = 0;
  const validator = { configured: options.configured ?? true, async validate(value, context) {
    calls++; assert.deepEqual(value, address); assert.ok(context.signal instanceof AbortSignal);
    return options.validate ? options.validate(value, context) : structuredClone(proposal);
  } };
  const handler = createAddressAssistanceApi({ validator, env: options.env ?? { GOOGLE_MAPS_BROWSER_API_KEY: 'browser-public-key', GOOGLE_ADDRESS_VALIDATION_API_KEY: 'server-private-key' },
    authorize: async req => { authorizations++; return options.authorize ? options.authorize(req) : principal; },
    ...(options.now && { now: options.now }), ...(options.perPrincipalLimit && { perPrincipalLimit: options.perPrincipalLimit }),
    ...(options.perTenantLimit && { perTenantLimit: options.perTenantLimit }), ...(options.globalLimit && { globalLimit: options.globalLimit }),
  });
  const failures = [];
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, new URL(req.url, 'http://localhost'))).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end('unexpected fixture error'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request({ route = validatePath, body = { address }, raw, method = 'POST', headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', ...headers },
      ...(!['GET', 'HEAD'].includes(method) && { body: raw ?? JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
  }
  try { await run({ request, get calls() { return calls; }, get authorizations() { return authorizations; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); }
}

test('config exposes only the browser key to a fresh authorized scope, with no-store', () => fixture(async f => {
  const result = await f.request({ route: configPath, body: {} });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, { configured: true, browserConfigured: true, browserApiKey: 'browser-public-key', validationConfigured: true, countryCode: 'SE' });
  assert.ok(!result.text.includes('server-private-key')); assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(f.calls, 0); assert.equal(f.authorizations, 2);
}));

test('browser-only configuration enables Places independently of the unavailable server check', () => fixture(async f => {
  const result = await f.request({ route: configPath, body: {} });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, { configured: true, browserConfigured: true, browserApiKey: 'browser-public-key', validationConfigured: false, countryCode: 'SE' });
  assert.ok(!result.text.includes('server-private-key'));
  assert.equal(f.calls, 0);
  const validation = await f.request();
  assert.equal(validation.status, 503);
  assert.equal(validation.body.code, 'address_validation_not_configured');
  assert.ok(!validation.text.includes(address.address));
  assert.equal(f.calls, 0);
}, { configured: false, env: { GOOGLE_MAPS_BROWSER_API_KEY: 'browser-public-key' } }));

test('missing browser configuration leaves manual entry available without exposing server keys', async () => {
  for (const options of [{ env: { GOOGLE_ADDRESS_VALIDATION_API_KEY: 'server-private-key' } }, { configured: false, env: {} }])
    await fixture(async f => {
      const result = await f.request({ route: configPath, body: {} });
      assert.equal(result.status, 200); assert.equal(result.body.configured, false);
      assert.equal(result.body.browserApiKey, undefined); assert.ok(!result.text.includes('private-key'));
    }, options);
});

test('validation has an abort signal, explicit confirmation and fresh authorization', () => fixture(async f => {
  const result = await f.request();
  assert.equal(result.status, 200, result.text); assert.deepEqual(result.body, proposal);
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(f.calls, 1); assert.equal(f.authorizations, 2);
}));

test('anonymous, forbidden and locked principals cannot read configuration or call Google', async () => {
  for (const status of [401, 403, 409, 423]) await fixture(async f => {
    for (const route of [configPath, validatePath]) {
      const result = await f.request({ route, body: route === configPath ? {} : { address } });
      assert.equal(result.status, status); assert.ok(!result.text.includes('browser-public-key'));
    }
    assert.equal(f.calls, 0);
  }, { authorize: () => { throw new PlatformError('Logga in med rätt behörighet.', status, 'address_denied'); } });
});

test('unknown routes pass through and methods, content-type, size and request fields are checked', () => fixture(async f => {
  assert.equal((await f.request({ route: '/api/unrelated', method: 'GET' })).status, 404);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const result = await f.request({ method }); assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'POST');
  }
  assert.equal((await f.request({ headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request({ raw: '{' })).status, 400);
  assert.equal((await f.request({ raw: ' '.repeat(4097) })).status, 413);
  for (const body of [null, [], {}, { address, companyId: 'forged' }, { address, apiKey: 'forged' }, { address, sessionToken: 'a'.repeat(37) },
    { address: { ...address, countryCode: 'US' } }, { address: { ...address, latitude: 50 } }])
    assert.equal((await f.request({ body })).status, 422, JSON.stringify(body));
  assert.equal((await f.request({ route: configPath, body: { address } })).status, 422);
  assert.equal((await f.request({ route: `${validatePath}?address=private` })).status, 422);
  assert.equal(f.calls, 0);
}));

test('foreign origins cannot read key config or trigger validation', () => fixture(async f => {
  for (const headers of [{ origin: 'https://other.test' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await f.request({ headers })).status, 403);
    assert.equal((await f.request({ headers, route: configPath, body: {} })).status, 403);
  }
  assert.equal(f.calls, 0);
}));

test('principal limit persists across session rotations, then expires after a minute', () => {
  let time = 1_800_000_000_000, generation = 0;
  return fixture(async f => {
    for (let i = 0; i < 2; i++) { assert.equal((await f.request()).status, 200); time += 1001; generation++; }
    const result = await f.request(); assert.equal(result.status, 429); assert.ok(Number(result.headers.get('retry-after')) > 0);
    assert.equal(f.calls, 2); time += 60_001; assert.equal((await f.request()).status, 200);
  }, { now: () => time, perPrincipalLimit: 2, authorize: () => ({ ...principal, scopeKey: `scope-${generation}` }) });
});

test('tenant limit bounds multiple actors together independently of actor session IDs', () => {
  let time = 1_800_000_000_000;
  return fixture(async f => {
    assert.equal((await f.request({ headers: { 'x-actor': 'one' } })).status, 200); time += 1001;
    assert.equal((await f.request({ headers: { 'x-actor': 'two' } })).status, 200); time += 1001;
    assert.equal((await f.request({ headers: { 'x-actor': 'three' } })).status, 429); assert.equal(f.calls, 2);
    assert.equal((await f.request({ headers: { 'x-actor': 'three', 'x-tenant': 'company-b' } })).status, 200);
  }, { now: () => time, perTenantLimit: 2, authorize: req => ({ scopeKey: `scope:${req.headers['x-tenant'] ?? 'company-a'}:${req.headers['x-actor']}`,
    rateKey: `actor:${req.headers['x-actor']}`, tenantRateKey: req.headers['x-tenant'] ?? 'company-a' }) });
});

test('global limiter caps all actors and tenants during one second', () => {
  let time = 1_800_000_000_000;
  return fixture(async f => {
    for (let i = 0; i < 2; i++) assert.equal((await f.request({ headers: { 'x-actor': String(i) } })).status, 200);
    assert.equal((await f.request({ headers: { 'x-actor': '3' } })).status, 429);
    time += 1001; assert.equal((await f.request({ headers: { 'x-actor': '3' } })).status, 200);
  }, { now: () => time, globalLimit: 2, authorize: req => ({ ...principal, rateKey: req.headers['x-actor'] }) });
});

test('a delayed address response or failure is discarded after company/session changes', async () => {
  for (const providerFails of [false, true]) {
    let scope = principal.scopeKey, finish, ready;
    const started = new Promise(resolve => { ready = resolve; });
    await fixture(async f => {
      const pending = f.request(); await started; scope = 'company-b:new-session'; finish();
      const result = await pending; assert.equal(result.status, 409, result.text);
      assert.equal(result.body.code, 'address_assistance_scope_changed'); assert.ok(!result.text.includes(address.address));
    }, { authorize: () => ({ ...principal, scopeKey: scope }), validate: () => new Promise((resolve, reject) => {
      finish = () => providerFails ? reject(new GoogleAddressValidationError('Provider failed.')) : resolve(proposal); ready();
    }) });
  }
});

test('permission revocation discards pending proposals and raw unexpected errors stay private', async () => {
  let allowed = true;
  await fixture(async f => {
    const result = await f.request(); assert.equal(result.status, 403); assert.ok(!result.text.includes(address.address));
  }, { authorize: () => { if (!allowed) throw new PlatformError('Behörigheten har ändrats.', 403, 'denied'); return principal; },
    validate: () => { allowed = false; return proposal; } });
  await fixture(async f => {
    const result = await f.request(); assert.equal(result.status, 503); assert.ok(!result.text.includes('server-private-key'));
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  }, { validate: () => { throw new Error('server-private-key raw provider response'); } });
});

test('structured Google diagnostics reach the authorized response without raw metadata or keys', () => {
  const validator = createGoogleAddressValidation({ env: { GOOGLE_ADDRESS_VALIDATION_API_KEY: 'PRIVATE-KEY' },
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'PRIVATE-GOOGLE-MESSAGE', details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', domain: 'googleapis.com', reason: 'BILLING_DISABLED',
        metadata: { key: 'PRIVATE-KEY', consumer: 'PRIVATE-PROJECT', callerIp: 'PRIVATE-IP' } },
    ] } }), { status: 403 }) });
  return fixture(async f => {
    const result = await f.request();
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'address_validation_billing_disabled');
    assert.match(result.body.error, /faktureringen inte är aktiv/);
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
    assert.ok(!result.text.includes('PRIVATE-'));
    assert.equal(f.authorizations, 2);
  }, { validate: (value, context) => validator.validate(value, context) });
});
