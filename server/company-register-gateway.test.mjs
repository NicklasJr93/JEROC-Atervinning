import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createPlatformStorage } from './platform-storage.mjs';

const path = '/api/company-register/lookup';
const lookupBody = { organisationNumber: '5593593626' };
const result = { ...lookupBody, name: 'Syntetiskt Företag AB', source: 'SCB' };
const firstPassword = 'Company-Lookup-Fixture-Private-2026!';
const changedPassword = 'Company-Lookup-Changed-Private-2026!';

async function fixture(run, { pilot = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-company-lookup-'));
  const env = {
    JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'), JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'),
    JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: firstPassword,
    GOOGLE_MAPS_BROWSER_API_KEY: 'fixture-public-browser-key', GOOGLE_ADDRESS_VALIDATION_API_KEY: 'fixture-private-validation-key',
  };
  let gateway, server, calls = 0, addressCalls = 0;
  const failures = [];
  try {
    // The pilot bootstrap test uses the injected local platform repository and
    // creates no tenant bundle, so no network/database connection is opened.
    const platformRepository = pilot ? await createPlatformStorage({ env }) : undefined;
    gateway = await createTenantGateway({ env: pilot ? { ...env, SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', DATABASE_URL: 'postgresql://unused.example.test/company_lookup_fixture' } : env,
      ...(platformRepository && { platformRepository }), companyRegister: { configured: true, async lookup(number, { signal }) {
        assert.equal(number, lookupBody.organisationNumber); assert.ok(signal instanceof AbortSignal);
        calls++; return structuredClone(result);
      } }, addressValidation: { configured: true, async validate(address) {
        addressCalls++; return { address, verdict: { addressComplete: true, hasUnconfirmedComponents: false, hasInferredComponents: false, hasReplacedComponents: false, requiresConfirmation: true } };
      } } });
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      void (async () => {
        if (await gateway.selectPage(req, res, url) || await gateway(req, res, url)) return;
        res.writeHead(404); res.end();
      })().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end('unexpected fixture failure'); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function client() {
      const cookies = new Map(); let session;
      async function request(route, body, headers = {}) {
        const response = await fetch(`${base}${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
            ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': session.generation }),
            ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) {
          const [key, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        const text = await response.text();
        const value = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers };
      }
      async function admin() {
        const login = await request('/api/platform/login', { username: 'admin', password: firstPassword });
        assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.mustChangePassword, true);
        const changed = await request('/api/platform/change-password', { currentPassword: firstPassword, newPassword: changedPassword });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        return changed.body;
      }
      return { request, admin, get session() { return session; } };
    }
    await run({ gateway, client, get calls() { return calls; }, get addressCalls() { return addressCalls; } });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'gateway must return safe API errors rather than throw');
  }
}

test('company lookups require genuine platform credentials, password change, CSRF, origin and current generation', () => fixture(async f => {
  const admin = f.client();
  assert.equal((await admin.request(path, lookupBody)).status, 401);
  assert.equal((await admin.request(path, lookupBody, { 'x-demo-actor': 'admin', 'x-demo-user': 'admin', 'x-client-company': 'jeroc-demo' })).status, 401);
  assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: firstPassword })).status, 200);
  assert.equal((await admin.request(path, lookupBody)).status, 423, 'bootstrap password cannot access company data');
  assert.equal(f.calls, 0);
  assert.equal((await admin.request('/api/platform/change-password', { currentPassword: firstPassword, newPassword: changedPassword })).status, 200);
  assert.equal((await admin.request(path, lookupBody, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await admin.request(path, lookupBody, { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await admin.request(path, lookupBody, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await admin.request(path, lookupBody, { 'x-platform-generation': 'outdated-generation' })).status, 409);
  assert.equal((await admin.request(path, lookupBody, { 'x-client-company': 'other-company' })).status, 409);
  assert.equal(f.calls, 0, 'all security failures must stop before any external request');
  const found = await admin.request(path, lookupBody);
  assert.equal(found.status, 200, JSON.stringify(found.body)); assert.deepEqual(found.body, { company: result });
  assert.match(found.headers.get('cache-control'), /no-store/); assert.equal(f.calls, 1);

  const selected = await admin.request('/api/platform/switch', { organisationId: 'jeroc-demo' });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const repository = await (await f.gateway.bundle(company)).applicationApi.getRepository();
  await repository.transact(state => {
    const denied = { id: 'lookup-denied-effective-user', name: 'Begränsad medarbetare', level: 'Medarbetare', permissions: ['view'], active: true, siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false };
    state.pricing.users.push(structuredClone(denied)); state.office.users.push(structuredClone(denied));
  });
  const switched = await admin.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: 'lookup-denied-effective-user' });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const denied = await admin.request(path, lookupBody);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(f.calls, 1, 'systemadmin acting as a restricted user must not bypass effective customer permissions');
}));

test('employee lookup verifies its real cookie and company/person scope and immediately respects permission revocation', () => fixture(async f => {
  const mobile = f.client();
  const forged = { 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'person-mobile-demo', 'x-demo-actor': 'mobile-demo', 'x-demo-user': 'mobile-demo' };
  assert.equal((await mobile.request(path, lookupBody, forged)).status, 401);
  assert.equal(f.calls, 0);
  assert.equal((await mobile.request('/mobil?company=jeroc-demo')).status, 303);
  const login = await mobile.request('/api/employee/login', { username: 'niklas', password: 'Demo123!' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const validScope = { 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'person-mobile-demo' };
  assert.equal((await mobile.request(path, lookupBody, { ...validScope, 'x-employee-company': 'foreign-company' })).status, 409);
  assert.equal((await mobile.request(path, lookupBody, { ...validScope, 'x-employee-person': 'other-person' })).status, 409);
  assert.equal((await mobile.request(path, lookupBody, { ...validScope, origin: 'https://foreign.example.test' })).status, 403);
  assert.equal(f.calls, 0);
  const found = await mobile.request(path, lookupBody, validScope);
  assert.equal(found.status, 200, JSON.stringify(found.body)); assert.equal(f.calls, 1);

  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const repository = await (await f.gateway.bundle(company)).applicationApi.getRepository();
  await repository.transact(state => {
    const user = state.pricing.users.find(value => value.id === 'mobile-demo');
    user.permissions = user.permissions.filter(permission => permission !== 'customers');
  });
  const revoked = await mobile.request(path, lookupBody, validScope);
  assert.equal(revoked.status, 403, JSON.stringify(revoked.body));
  assert.equal(f.calls, 1, 'a previously authenticated cookie cannot retain revoked customer rights');
}));

test('a pilot systemadmin can look up a legal entity before selecting or creating the first company', () => fixture(async f => {
  const admin = f.client();
  await admin.admin();
  assert.equal(admin.session.organisationId, undefined);
  assert.equal((await admin.request(path, lookupBody, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await admin.request(path, lookupBody, { 'x-platform-generation': 'outdated' })).status, 409);
  assert.equal(f.calls, 0);
  const found = await admin.request(path, lookupBody);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body, { company: result }); assert.equal(f.calls, 1);
}, { pilot: true }));


test('address assistance is protected by real platform and employee sessions, CSRF and tenant permissions', () => fixture(async f => {
  const configPath = '/api/address-assistance/config', validationPath = '/api/address-assistance/validate';
  const body = { address: { address: 'Testvägen 10', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' } };
  const admin = f.client();
  assert.equal((await admin.request(configPath, {})).status, 401);
  assert.equal((await admin.request(validationPath, body, { 'x-demo-actor': 'admin' })).status, 401);
  await admin.admin();
  assert.equal((await admin.request(configPath, {}, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await admin.request(validationPath, body, { 'x-client-company': 'foreign-company' })).status, 409);
  assert.equal((await admin.request(validationPath, body, { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal(f.addressCalls, 0);
  const config = await admin.request(configPath, {});
  assert.equal(config.status, 200); assert.equal(config.body.configured, true); assert.equal(config.body.browserConfigured, true);
  assert.equal(config.body.browserApiKey, 'fixture-public-browser-key');
  assert.ok(!JSON.stringify(config.body).includes('fixture-private-validation-key'));
  const validated = await admin.request(validationPath, body);
  assert.equal(validated.status, 200); assert.deepEqual(validated.body.address, body.address); assert.equal(f.addressCalls, 1);
  assert.match(validated.headers.get('cache-control'), /no-store/);

  const mobile = f.client();
  await mobile.request('/mobil?company=jeroc-demo');
  assert.equal((await mobile.request('/api/employee/login', { username: 'niklas', password: 'Demo123!' })).status, 200);
  const headers = { 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'person-mobile-demo' };
  assert.equal((await mobile.request(validationPath, body, { ...headers, 'x-employee-company': 'foreign-company' })).status, 409);
  assert.equal((await mobile.request(validationPath, body, { ...headers, 'x-employee-person': 'foreign-person' })).status, 409);
  assert.equal((await mobile.request(validationPath, body, headers)).status, 200); assert.equal(f.addressCalls, 2);
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const repository = await (await f.gateway.bundle(company)).applicationApi.getRepository();
  await repository.transact(state => { state.pricing.users.find(value => value.id === 'mobile-demo').permissions = ['view']; });
  assert.equal((await mobile.request(validationPath, body, headers)).status, 403); assert.equal(f.addressCalls, 2);
}));
