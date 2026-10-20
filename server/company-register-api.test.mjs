import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createCompanyRegisterApi } from './company-register-api.mjs';
import { ScbCompanyRegisterError } from './scb-company-register.mjs';
import { PlatformError } from './platform-auth.mjs';

const path = '/api/company-register/lookup';
const number = '5593593626';
const company = { organisationNumber: number, name: 'Syntetiskt Exempel AB', address: 'Exempelvägen 1', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', source: 'SCB' };
const principal = { scopeKey: 'company-a:actor-a:session-a:generation-a', rateKey: 'company-a:actor-a' };

async function fixture(run, options = {}) {
  let calls = 0, authorizations = 0;
  const register = { configured: true, async lookup(value, context) {
    calls++;
    assert.equal(value, number);
    assert.ok(context.signal instanceof AbortSignal);
    return options.lookup ? options.lookup(value, context) : structuredClone(company);
  } };
  const handler = createCompanyRegisterApi({ register,
    authorize: async req => { authorizations++; return options.authorize ? options.authorize(req) : principal; },
    ...(options.now && { now: options.now }),
    ...(options.perPrincipalLimit && { perPrincipalLimit: options.perPrincipalLimit }),
    ...(options.globalLimit && { globalLimit: options.globalLimit }),
  });
  const failures = [];
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, new URL(req.url, 'http://localhost'))).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end('unexpected fixture failure');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request({ body = { organisationNumber: number }, raw, method = 'POST', headers = {}, route = path } = {}) {
    const response = await fetch(`${base}${route}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(!['GET', 'HEAD'].includes(method) && { body: raw ?? JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
  }
  try { await run({ request, get calls() { return calls; }, get authorizations() { return authorizations; } }); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'the handler must handle its own request failures');
  }
}

test('company lookup returns an exact result with no-store, a cancellation signal and fresh authorization before replying', () => fixture(async f => {
  const result = await f.request();
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, { company });
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.match(result.headers.get('content-type'), /application\/json/);
  assert.equal(f.calls, 1);
  assert.equal(f.authorizations, 2, 'permissions and the selected company must be checked again after the external call');
}));

test('anonymous and forbidden principals cannot trigger any external lookup', async () => {
  for (const status of [401, 403, 409, 423]) await fixture(async f => {
    const result = await f.request();
    assert.equal(result.status, status, result.text);
    assert.equal(f.calls, 0);
    assert.match(result.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  }, { authorize: () => { throw new PlatformError('Logga in med rätt behörighet.', status, 'platform_lookup_denied'); } });
});

test('unrelated routes pass through and methods other than POST never invoke the registry', () => fixture(async f => {
  assert.equal((await f.request({ route: '/api/unrelated', method: 'GET' })).status, 404);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const result = await f.request({ method });
    assert.equal(result.status, 405, `${method}: ${result.text}`);
    assert.match(result.headers.get('allow') ?? '', /POST/);
    assert.match(result.headers.get('cache-control'), /no-store/);
  }
  assert.equal(f.calls, 0);
}));

test('content type, body size, malformed JSON and foreign request fields are checked on the server', () => fixture(async f => {
  assert.equal((await f.request({ headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request({ raw: '{' })).status, 400);
  assert.equal((await f.request({ raw: ' '.repeat(1025) + JSON.stringify({ organisationNumber: number }) })).status, 413);
  for (const body of [null, [], { organisationNumber: number, companyId: 'forged-company' }, { organisationNumber: number, apiKey: 'forged-key' }]) {
    const result = await f.request({ body });
    assert.equal(result.status, 422, result.text);
  }
  assert.equal(f.calls, 0);
}));

test('incomplete, malformed, personal and wrong-check-digit identities are rejected before external work', () => fixture(async f => {
  for (const organisationNumber of ['', '559359362', '5593593627', '9001010009', '199001010009', 'SE559359362601', `${number}?other=1`, 5593593626]) {
    const result = await f.request({ body: { organisationNumber } });
    assert.equal(result.status, 422, `${String(organisationNumber)}: ${result.text}`);
  }
  assert.equal(f.calls, 0);
}));

test('only an explicit registry not-found becomes 404; outages and unexpected errors cannot masquerade as missing companies', async () => {
  await fixture(async f => {
    const result = await f.request();
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'company_lookup_not_found');
  }, { lookup: () => { throw new ScbCompanyRegisterError('Ingen träff hittades.', 404, 'company_lookup_not_found'); } });
  await fixture(async f => {
    const result = await f.request();
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'company_lookup_unavailable');
  }, { lookup: () => { throw new ScbCompanyRegisterError('Företagsregistret kan inte nås.', 503, 'company_lookup_unavailable'); } });
  await fixture(async f => {
    const result = await f.request();
    assert.ok(result.status >= 500, result.text);
    assert.ok(!result.text.includes('secret-scb-key'));
    assert.ok(!result.text.includes('upstream-dump'));
    assert.notEqual(result.body.code, 'company_lookup_not_found');
    assert.deepEqual(Object.keys(result.body).sort(), ['code', 'error']);
  }, { lookup: () => { throw Object.assign(new Error('secret-scb-key upstream-dump'), { status: 404, code: 'company_lookup_not_found' }); } });
});

test('actor limits survive session rotation and expire after one minute', () => {
  let milliseconds = 1_800_000_000_000;
  let generation = 1;
  return fixture(async f => {
    assert.equal((await f.request()).status, 200);
    milliseconds += 1001; generation++;
    assert.equal((await f.request()).status, 200);
    milliseconds += 1001; generation++;
    const limited = await f.request();
    assert.equal(limited.status, 429, limited.text);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(f.calls, 2);
    milliseconds += 60_001;
    assert.equal((await f.request()).status, 200);
    assert.equal(f.calls, 3);
  }, { now: () => milliseconds, perPrincipalLimit: 2,
    authorize: () => ({ scopeKey: `company-a:actor-a:session-${generation}`, rateKey: principal.rateKey }) });
});

test('global sliding limit bounds all actors together and permits work once the second has passed', () => {
  let milliseconds = 1_800_000_000_000;
  return fixture(async f => {
    for (let index = 0; index < 4; index++) assert.equal((await f.request({ headers: { 'x-fixture-actor': `actor-${index}` } })).status, 200);
    const limited = await f.request({ headers: { 'x-fixture-actor': 'actor-5' } });
    assert.equal(limited.status, 429, limited.text);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(f.calls, 4);
    milliseconds += 1001;
    assert.equal((await f.request({ headers: { 'x-fixture-actor': 'actor-5' } })).status, 200);
    assert.equal(f.calls, 5);
  }, { now: () => milliseconds, authorize: req => {
    const actor = req.headers['x-fixture-actor'];
    return { scopeKey: `company-a:${actor}:session-a`, rateKey: `company-a:${actor}` };
  } });
});

test('a delayed response is discarded after the active company or session generation changes', () => {
  let scope = principal.scopeKey;
  let finishLookup;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  return fixture(async f => {
    const pending = f.request();
    await ready;
    scope = 'company-b:actor-a:session-b:generation-b';
    finishLookup(structuredClone(company));
    const result = await pending;
    assert.equal(result.status, 409, result.text);
    assert.equal(result.body.code, 'company_lookup_scope_changed');
    assert.ok(!result.text.includes(company.name), 'a stale company hit must not reach the new context');
    assert.equal(f.calls, 1);
    assert.equal(f.authorizations, 2);
  }, { authorize: () => ({ ...principal, scopeKey: scope }), lookup: () => new Promise(resolve => { finishLookup = resolve; started(); }) });
});

test('permissions revoked while the registry is responding discard the result', () => {
  let authorized = true;
  return fixture(async f => {
    const result = await f.request();
    assert.equal(result.status, 403, result.text);
    assert.equal(f.calls, 1);
    assert.ok(!result.text.includes(company.name));
  }, { authorize: () => {
    if (!authorized) throw new PlatformError('Behörigheten har ändrats.', 403, 'platform_lookup_denied');
    return principal;
  }, lookup: () => { authorized = false; return structuredClone(company); } });
});
