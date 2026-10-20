import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationRepository } from './application-storage.mjs';
import { createCompanySettingsService } from './company-settings.mjs';
import { createCompanySettingsApi } from './company-settings-api.mjs';
import { PlatformError } from './platform-auth.mjs';

const path = '/api/company-settings';
const company = { id: 'company-a', name: 'Exempelbolaget AB', organisationNumber: '5593593626' };
const principal = { companyId: company.id, actorId: 'actual-user', userId: 'effective-user', scopeKey: 'company-a:session-a:1', canManage: true };
const writable = value => ({ expectedVersion: value.version, profile: value.profile, documents: value.documents, defaults: value.defaults, notifications: value.notifications });

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-company-settings-api-'));
  const repository = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: () => ({ metadata: {}, imports: [] }) });
  const service = createCompanySettingsService({ organisationId: company.id, company, getRepository: async () => repository,
    ...(options.validateLogo ? { validateLogo: options.validateLogo } : {}) });
  let authorizationCalls = 0;
  const calls = [], failures = [];
  const handler = createCompanySettingsApi({ service: options.wrapService ? options.wrapService(service) : service,
    authorize: async (req, context) => {
      calls.push(context); authorizationCalls++;
      return options.authorize ? options.authorize(req, context, authorizationCalls) : structuredClone(principal);
    } });
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res, new URL(req.url, 'http://localhost'))).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end('unexpected fixture failure'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request({ method = 'GET', route = path, body, raw, headers = {} } = {}) {
    const response = await fetch(`${base}${route}`, { method,
      headers: { ...(!['GET', 'HEAD'].includes(method) ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(!['GET', 'HEAD'].includes(method) ? { body: raw ?? JSON.stringify(body ?? {}) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
  }
  try { await run({ request, service, repository, calls, base, get authorizationCalls() { return authorizationCalls; } }); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await repository.close();
    await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []);
  }
}

test('GET and HEAD provide only the server-selected company with private no-store and fresh authorization', () => fixture(async f => {
  const value = await f.request();
  assert.equal(value.status, 200, value.text); assert.equal(value.body.companyId, company.id);
  assert.equal(value.body.organisationNumber, company.organisationNumber); assert.equal(value.body.capabilities.canManage, true);
  assert.match(value.headers.get('cache-control'), /no-store/); assert.match(value.headers.get('content-type'), /application\/json/);
  assert.deepEqual(f.calls, [{ write: false, basic: false }, { write: false, basic: false }]);
  const head = await f.request({ method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.text, '');
}));

test('POST atomically saves current editable fields and duplicate/stale versions cannot overwrite it', () => fixture(async f => {
  const before = writable((await f.request()).body);
  const changed = { ...before, profile: { ...before.profile, contactPerson: 'Kontaktperson' }, defaults: { paymentTermsDays: 30 } };
  const saved = await f.request({ method: 'POST', body: changed });
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.version, 1); assert.equal(saved.body.profile.contactPerson, 'Kontaktperson');
  const conflict = await f.request({ method: 'POST', body: { ...changed, profile: { ...changed.profile, contactPerson: 'Late overwrite' } } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'company_settings_version_conflict');
  assert.equal((await f.request()).body.profile.contactPerson, 'Kontaktperson');
  assert.ok(f.calls.filter(value => value.write).length >= 3, 'save must perform the injected current authorization inside the transaction');
}));

test('read-only sessions can inspect settings but cannot save or gain a true manage capability', () => fixture(async f => {
  const value = await f.request(); assert.equal(value.status, 200); assert.equal(value.body.capabilities.canManage, false);
  const write = await f.request({ method: 'POST', body: writable(value.body) }); assert.equal(write.status, 403);
  assert.equal((await f.service.get()).version, 0);
}, { authorize: () => ({ ...principal, canManage: false }) }));

test('anonymous, forbidden, stale or locked real-session authorizer failures stop settings access', async () => {
  for (const status of [401, 403, 409, 423]) await fixture(async f => {
    const get = await f.request(); assert.equal(get.status, status); assert.deepEqual(Object.keys(get.body).sort(), ['code', 'error']);
    const post = await f.request({ method: 'POST' }); assert.equal(post.status, status);
    assert.equal(await f.repository.read(state => state.metadata.companySettings), undefined);
  }, { authorize: () => { throw new PlatformError('Logga in med rätt behörighet.', status, 'session_required'); } });
});

test('query-based tenant selection, wrong scope, foreign origin and forged form identities are rejected', () => fixture(async f => {
  const current = writable((await f.request()).body);
  for (const route of [`${path}?company=company-b`, `${path}?expectedCompany=company-b`, `${path}/defaults?company=company-b`])
    assert.equal((await f.request({ route })).status, 422);
  for (const headers of [{ origin: 'https://foreign.example.test' }, { 'sec-fetch-site': 'cross-site' }, { origin: f.base.replace('http:', 'https:') }]) {
    assert.equal((await f.request({ headers })).status, 403);
    assert.equal((await f.request({ method: 'POST', body: current, headers })).status, 403);
  }
  for (const injected of [{ companyId: 'company-b' }, { organisationNumber: 'foreign-number' }, { actorId: 'admin' }, { capabilities: { canManage: true } }]) {
    const result = await f.request({ method: 'POST', body: { ...current, ...injected } }); assert.equal(result.status, 422, result.text);
  }
  assert.equal((await f.service.get()).version, 0);
}));

test('an authorizer returning another company cannot read from or write to this tenant service', () => fixture(async f => {
  assert.equal((await f.request()).status, 403); assert.equal((await f.request({ method: 'POST' })).status, 403);
  assert.equal((await f.service.get()).version, 0);
}, { authorize: () => ({ ...principal, companyId: 'company-b' }) }));

test('methods, content type, bounded input and malformed JSON are checked before mutation', () => fixture(async f => {
  assert.equal((await f.request({ route: '/api/unrelated' })).status, 404);
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const result = await f.request({ method }); assert.equal(result.status, 405); assert.equal(result.headers.get('allow'), 'GET, HEAD, POST');
  }
  const basicWrite = await f.request({ method: 'POST', route: `${path}/defaults` });
  assert.equal(basicWrite.status, 405); assert.equal(basicWrite.headers.get('allow'), 'GET, HEAD');
  assert.equal((await f.request({ method: 'POST', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request({ method: 'POST', raw: '{' })).status, 400);
  assert.equal((await f.request({ method: 'POST', raw: ' '.repeat(16 * 1024) + '{}' })).status, 413);
  assert.equal((await f.request({ method: 'POST', body: [] })).status, 422);
  assert.equal((await f.service.get()).version, 0);
}));

test('a delayed read or unexpected storage error cannot leak stale company settings or raw server details', async () => {
  await fixture(async f => {
    const result = await f.request(); assert.equal(result.status, 409); assert.equal(result.body.code, 'company_settings_scope_changed');
    assert.ok(!result.text.includes(company.name));
  }, { authorize: (_req, _context, calls) => ({ ...principal, scopeKey: calls === 1 ? 'old' : 'new' }) });
  await fixture(async f => {
    const result = await f.request(); assert.equal(result.status, 403); assert.ok(!result.text.includes(company.name));
  }, { authorize: (_req, _context, calls) => { if (calls > 1) throw new PlatformError('Behörigheten har ändrats.', 403); return principal; } });
  await fixture(async f => {
    const result = await f.request(); assert.equal(result.status, 503); assert.ok(!result.text.includes('private-provider-token'));
  }, { wrapService: service => ({ ...service, get: async () => { throw new Error('private-provider-token'); } }) });
});

test('basic default projection is authorized separately and omits invoice contacts and notification recipients', () => fixture(async f => {
  const input = writable(await f.service.get());
  input.profile.invoiceEmail = 'private-invoice@example.test'; input.profile.contactPerson = 'Private Person';
  input.notifications.customerInquiries = ['private-inquiries@example.test']; input.defaults.paymentTermsDays = 14;
  await f.service.save(input, principal, { reauthorize: async () => principal });
  const result = await f.request({ route: `${path}/defaults` });
  assert.equal(result.status, 200); assert.equal(result.body.defaults.paymentTermsDays, 14);
  assert.deepEqual(result.body.profile, { name: company.name });
  assert.deepEqual(f.calls, [{ write: false, basic: true }, { write: false, basic: true }]);
  assert.ok(!result.text.includes('private')); assert.ok(!('capabilities' in result.body));
  assert.equal((await f.request({ method: 'HEAD', route: `${path}/defaults` })).text, '');
}));
