import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createPublicCustomerIntake } from './public-customer-intake.mjs';
import { createCustomerIntakeApi } from './customer-intake-api.mjs';
import { createCompanyRegisterApi, createCompanyRegisterLimiter } from './company-register-api.mjs';
import { createCustomerIntakeCompanyLookup } from './customer-intake-company-lookup.mjs';

const PUBLIC = '/api/public/customer-intake/company-lookup';
const TERMINAL = '/api/terminal-demo/customer-intake/company-lookup';
const STAFF = '/api/company-register/lookup';
const number = '5593593626';
const personalNumber = '199002092386';
const token = 'a'.repeat(43);
const digest = createHash('sha256').update(token).digest('hex');
const intakeId = '0b3a3489-752a-439f-9a90-f96b55a6940a';
const otherIntake = '6cff266e-474c-4e8e-a142-de4678c98a62';
const company = { organisationNumber: number, name: 'Syntetiskt bolag AB', address: 'Exempelvägen 1', careOf: 'C/O Reception',
  postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', phone: '+46722002220', email: 'kontakt@example.test',
  source: 'SCB', fetchedAt: '2026-10-20T10:00:00.000Z' };
const error = (status, code = 'customer_intake_unavailable') => Object.assign(new Error('Kundformuläret är inte tillgängligt.'), { status, code });

async function fixture(run, options = {}) {
  let time = Date.now();
  const expiresAt = new Date(time + 30 * 60_000).toISOString();
  const state = { customerIntakeLinks: [{ tokenHash: digest, intakeId, companyId: 'company-a', expiresAt }],
    companies: [{ id: 'company-a', name: 'Intagsbolaget AB', status: 'active' }] };
  let status = 'waiting', currentId = intakeId, deviceActive = true, connectionId = 'epoch-one';
  let activeReads = 0, calls = 0, publicReads = 0, deviceAuthorizations = 0;
  const repository = {
    async read(callback) { activeReads++; try { return await callback(state); } finally { activeReads--; } },
    async transact(callback) { activeReads++; try { return await callback(state); } finally { activeReads--; } },
  };
  const publicState = () => ({ intake: { id: currentId, status, expiresAt }, company: { name: 'Intagsbolaget AB' } });
  const service = {
    async publicRead(value) { publicReads++; assert.equal(value, token); return publicState(); },
    async terminalRead(device) {
      if (!deviceActive) throw error(401, 'terminal_session_required');
      if (device.connectionId !== connectionId) throw error(409, 'terminal_session_changed');
      return publicState();
    },
  };
  const terminalAccess = {
    async authorizeIntakeDevice(req) {
      deviceAuthorizations++;
      if (!deviceActive || req.headers.cookie !== 'paired-session=valid') throw error(401, 'terminal_session_required');
      return Object.freeze({ id: 'terminal-a', siteId: 'site-a', name: 'Kassan', connectionId });
    },
  };
  const register = { configured: true, async lookup(value, { signal } = {}) {
    calls++; assert.equal(value, number); assert.ok(signal instanceof AbortSignal);
    assert.equal(activeReads, 0, 'provider await must not run inside a repository read or write callback');
    return options.lookup ? options.lookup({ value, signal, changeStatus: value => { status = value; },
      changeCurrentId: value => { currentId = value; }, disconnect: () => { deviceActive = false; },
      replaceConnection: () => { connectionId = 'epoch-two'; }, state }) : { ...company,
      bankAccount: 'private-account-must-not-leak', apiKey: 'private-key-must-not-leak',
      vatRegistered: true, fTaxRegistered: true, legalFormCode: '49', internalPayload: { unexpected: 'private' } };
  } };
  const limiter = createCompanyRegisterLimiter({ now: () => time, perPrincipalLimit: options.perPrincipalLimit ?? 30, globalLimit: options.globalLimit ?? 4 });
  const companyLookup = createCustomerIntakeCompanyLookup({ register, limiter });
  const publicApi = createPublicCustomerIntake({ repository, companyLookup, now: () => time,
    openCompany: async selected => { assert.equal(selected.id, 'company-a'); return { customerIntakeService: service }; } });
  const terminalApi = createCustomerIntakeApi({ service, terminalAccess, companyLookup });
  const staffApi = createCompanyRegisterApi({ register, limiter, authorize: async () => ({ rateKey: 'staff-user', scopeKey: 'company-a:staff-session' }) });
  const failures = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void (async () => {
      if (await publicApi.handle(req, res, url) || await terminalApi(req, res, url) || await staffApi(req, res, url)) return;
      res.writeHead(404); res.end();
    })().catch(failure => { failures.push(failure); if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = PUBLIC, { body, method = 'POST', headers = {} } = {}) {
    const data = body ?? (path === TERMINAL ? { id: intakeId, organisationNumber: number } : { organisationNumber: number });
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json',
      ...(path.startsWith('/api/public/') ? { authorization: `Bearer ${token}` } : {}),
      ...(path.startsWith('/api/terminal-demo/') ? { cookie: 'paired-session=valid' } : {}), ...headers },
      ...(!['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(data) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }
  try {
    await run({ request, state, changeStatus: value => { status = value; }, changeCurrentId: value => { currentId = value; },
      disconnect: () => { deviceActive = false; }, advance: delta => { time += delta; },
      get calls() { return calls; }, get publicReads() { return publicReads; }, get deviceAuthorizations() { return deviceAuthorizations; } });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, [], 'lookup routes handle all failures without escaping their HTTP adapters');
  }
}

test('SMS lookup is bearer-bound, exact and returns only public contact/address assistance', () => fixture(async f => {
  const result = await f.request();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { company });
  assert.equal(f.calls, 1); assert.ok(f.publicReads >= 2, 'intake must be checked before and after SCB');
  assert.match(result.headers.get('cache-control'), /no-store/);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!JSON.stringify(result.body).includes('private-'));
}));

test('missing/foreign capability, expired registry and nonwaiting intake cannot trigger SCB', async () => {
  await fixture(async f => {
    for (const headers of [{ authorization: '' }, { authorization: `Bearer ${'b'.repeat(43)}` }]) {
      const result = await f.request(PUBLIC, { headers }); assert.equal(result.status, 410);
    }
    f.state.customerIntakeLinks[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal((await f.request()).status, 410); assert.equal(f.calls, 0);
  });
  for (const status of ['submitted', 'applied', 'cancelled', 'expired', 'failed', 'unknown']) await fixture(async f => {
    f.changeStatus(status);
    assert.ok((await f.request()).status >= 400, status); assert.equal(f.calls, 0, status);
  });
});

test('lookup rejects personal identifiers and untrusted body/query tenant selectors before the provider', () => fixture(async f => {
  for (const body of [{ organisationNumber: personalNumber }, { organisationNumber: '5593593627' },
    { organisationNumber: number, companyId: 'company-b' }, { organisationNumber: number, token }]) {
    assert.equal((await f.request(PUBLIC, { body })).status, 422);
  }
  assert.ok((await f.request(`${PUBLIC}?companyId=company-b`)).status >= 400);
  assert.equal(f.calls, 0);
}));

test('SMS revocation, replacement and company suspension during SCB suppress the late result', async () => {
  for (const mutate of [context => context.changeStatus('cancelled'), context => context.changeCurrentId(otherIntake),
    context => { context.state.companies[0].status = 'suspended'; }, context => { context.state.customerIntakeLinks = []; }]) {
    await fixture(async f => {
      const result = await f.request();
      assert.ok(result.status >= 400, JSON.stringify(result.body)); assert.equal(result.body.company, undefined); assert.equal(f.calls, 1);
    }, { lookup: async context => { mutate(context); return structuredClone(company); } });
  }
});

test('paired terminal lookup binds the current intake and rechecks the authenticated device', () => fixture(async f => {
  const result = await f.request(TERMINAL);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.deepEqual(result.body, { company });
  assert.equal(f.calls, 1); assert.ok(f.deviceAuthorizations >= 2);
  f.advance(1001);
  assert.ok((await f.request(TERMINAL, { body: { id: otherIntake, organisationNumber: number } })).status >= 400);
  assert.equal(f.calls, 1, 'another customer intake cannot be looked up through this device');
  assert.equal((await f.request(TERMINAL, { headers: { cookie: '' } })).status, 401);
}));

test('terminal disconnect or intake replacement while SCB is pending never exposes a late company hit', async () => {
  for (const mutate of [context => context.disconnect(), context => context.replaceConnection(), context => context.changeCurrentId(otherIntake),
    context => context.changeStatus('submitted')]) await fixture(async f => {
    const result = await f.request(TERMINAL);
    assert.ok(result.status >= 400, JSON.stringify(result.body)); assert.equal(result.body.company, undefined); assert.equal(f.calls, 1);
  }, { lookup: async context => { mutate(context); return structuredClone(company); } });
});

test('anonymous intake and authenticated staff share the same global upstream budget', () => fixture(async f => {
  assert.equal((await f.request(STAFF)).status, 200);
  assert.equal((await f.request()).status, 200);
  const third = await f.request(TERMINAL);
  assert.equal(third.status, 429, JSON.stringify(third.body)); assert.equal(f.calls, 2);
  f.advance(1001);
  assert.equal((await f.request(TERMINAL)).status, 200); assert.equal(f.calls, 3);
}, { globalLimit: 2 }));
