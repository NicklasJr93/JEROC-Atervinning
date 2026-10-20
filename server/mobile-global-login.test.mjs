import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';

const LOGIN = '/api/employee/login?view=bootstrap';
const INITIAL = 'Mobile-Global-Initial-2026!';
const ADMIN = 'Mobile-Global-Admin-2026!';
const PASSWORD = 'Mobile-Global-Employee-2026!';

function organisationNumber(prefix) {
  const sum = [...prefix].reduce((total, value, index) => {
    const digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit);
  }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}

/** Real global registry, provisioned tenant bundles and employee HTTP handlers.
 * No mocked login response or tenant-selector cookie grants authentication. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-global-login-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, SCRAPPLANNER_PLATFORM_ADMIN_EMAIL: 'admin@example.test',
    APP_URL: 'https://app.scrapplanner.com', MOBILE_URL: 'https://mobile.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let server, gateway;
  const failures = [];
  try {
    gateway = await createTenantGateway({ env });
    server = createServer((req, res) => {
      void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => {
        if (!handled) { res.writeHead(404); res.end(); }
      }).catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function client() {
      const cookies = new Map(); let session;
      async function request(path, body, headers = {}) {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': session.generation }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const setCookies = response.headers.getSetCookie();
        for (const entry of setCookies) {
          const [name, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json();
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers, setCookies };
      }
      return { request, cookies };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    const changed = await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    async function company(label, prefix, { activate = true } = {}) {
      const email = `${label.toLowerCase()}@example.test`;
      const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: `${label} Återvinning AB`,
        organisationNumber: organisationNumber(prefix), vdName: `${label} Ägare`, vdEmail: email });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const value = created.body, owner = client();
      if (activate) {
        const login = await owner.request('/api/platform/login', { username: email, password: value.temporaryCredentials.password });
        assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.mustChangePassword, true);
        const updated = await owner.request('/api/platform/change-password', { currentPassword: value.temporaryCredentials.password, newPassword: PASSWORD });
        assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.mustChangePassword, false);
      }
      const repository = await (await gateway.bundle(await gateway.auth.getCompany(value.company.id))).applicationApi.getRepository();
      const person = await repository.read(state => structuredClone(state.personnel.people.find(item => item.userId === value.user.id)));
      assert.ok(person);
      return { ...value, email, owner, repository, person, password: activate ? PASSWORD : value.temporaryCredentials.password };
    }
    const alpha = await company('Alpha', '556010001');
    const beta = await company('Beta', '556010002');
    await run({ gateway, admin, client, company, alpha, beta });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

test('username or email resolves the right tenant without prior cookies and grants only the employee session', () => fixture(async f => {
  await f.gateway.repository.transact(state => { state.users.find(user => user.id === f.alpha.user.id).username = 'alpha.owner'; });
  for (const [username, target] of [[' ALPHA@EXAMPLE.TEST ', f.alpha], ['alpha.owner', f.alpha], [f.beta.email, f.beta]]) {
    const mobile = f.client();
    const login = await mobile.request(LOGIN, { username, password: target.password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.companyId, target.company.id); assert.equal(login.body.person.id, target.person.id);
    assert.ok(mobile.cookies.has('jeroc_employee')); assert.ok(mobile.cookies.has('jeroc_tenant'));
    assert.equal(mobile.cookies.has('jeroc_platform'), false);
    for (const name of ['jeroc_employee', 'jeroc_tenant']) {
      const cookie = login.setCookies.find(value => value.startsWith(`${name}=`) && !value.includes('Max-Age=0'));
      assert.ok(cookie); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\/api/);
    }
    const current = await mobile.request('/api/employee/session?view=bootstrap');
    assert.equal(current.status, 200, JSON.stringify(current.body)); assert.equal(current.body.companyId, target.company.id);
    assert.equal((await mobile.request('/api/platform/tenant-context')).body.companyId, target.company.id);
    assert.equal((await mobile.request('/api/application/office')).status, 401);
    const other = target === f.alpha ? f.beta : f.alpha;
    assert.equal((await mobile.request('/api/employee/overview?view=bootstrap', undefined, { 'x-employee-company': other.company.id })).status, 409);
  }
}));

test('explicit credentials ignore ambient company/platform cookies while explicit stale scope and cross-site requests fail closed', () => fixture(async f => {
  const mobile = f.client();
  assert.equal((await mobile.request('/api/platform/select-tenant', { organisationId: f.beta.company.id })).status, 200);
  mobile.cookies.set('jeroc_platform', 'stale-office-cookie');
  const login = await mobile.request(LOGIN, { username: f.alpha.email, password: f.alpha.password });
  assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.companyId, f.alpha.company.id);
  assert.equal(mobile.cookies.has('jeroc_platform'), false);
  for (const headers of [{ 'x-client-company': f.beta.company.id }, { 'x-employee-company': f.beta.company.id }, { 'x-employee-person': f.beta.person.id }]) {
    const refused = await f.client().request(LOGIN, { username: f.alpha.email, password: f.alpha.password }, headers);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.setCookies.some(value => value.startsWith('jeroc_employee=') && !value.includes('Max-Age=0')), false);
  }
  assert.equal((await f.client().request(LOGIN, { username: f.alpha.email, password: f.alpha.password }, { origin: 'https://foreign.invalid' })).status, 403);
  const injected = await f.client().request(`${LOGIN}&company=${f.beta.company.id}`, { username: f.alpha.email, password: f.alpha.password });
  assert.equal(injected.status, 422, JSON.stringify(injected.body));
  assert.equal((await f.client().request('/api/employee/session?view=bootstrap')).status, 401);
}));

test('wrong credentials and inactive or pending account bindings never issue a mobile session or reveal a company', () => fixture(async f => {
  const invalid = await f.client().request(LOGIN, { username: 'unknown@example.test', password: PASSWORD });
  assert.equal(invalid.status, 401);
  const fail = async (username = f.alpha.email, password = f.alpha.password) => {
    const result = await f.client().request(LOGIN, { username, password });
    assert.equal(result.status, 401, JSON.stringify(result.body)); assert.deepEqual(result.body, invalid.body);
    assert.equal(result.setCookies.some(value => value.startsWith('jeroc_employee=') && !value.includes('Max-Age=0')), false);
    assert.equal(result.body.companyId, undefined); assert.equal(result.body.person, undefined);
  };
  await fail(f.alpha.email, 'Wrong-Password-2026!');
  for (const field of ['active', 'mustChangePassword', 'passwordRecoveryPending']) {
    await f.gateway.repository.transact(state => { state.users.find(user => user.id === f.alpha.user.id)[field] = field !== 'active'; });
    await fail();
    await f.gateway.repository.transact(state => { const user = state.users.find(user => user.id === f.alpha.user.id); if (field === 'active') user.active = true; else delete user[field]; });
  }
  await f.gateway.repository.transact(state => { state.companies.find(company => company.id === f.alpha.company.id).status = 'inactive'; });
  await fail();
  await f.gateway.repository.transact(state => { state.companies.find(company => company.id === f.alpha.company.id).status = 'active'; });
  await f.gateway.repository.transact(state => { state.memberships.find(membership => membership.userId === f.alpha.user.id).active = false; });
  await fail();
  await f.gateway.repository.transact(state => { state.memberships.find(membership => membership.userId === f.alpha.user.id).active = true; });
  for (const target of ['account', 'person', 'user']) {
    const update = active => f.alpha.repository.transact(state => {
      const value = target === 'account' ? state.personnelAuth.accounts.find(account => account.personId === f.alpha.person.id)
        : target === 'person' ? state.personnel.people.find(person => person.id === f.alpha.person.id)
          : state.pricing.users.find(user => user.id === f.alpha.user.id);
      value.active = active;
    });
    await update(false); await fail(); await update(true);
  }
}));

test('duplicate global identities and multiple active memberships cannot silently choose the ambient company', () => fixture(async f => {
  const mobile = f.client();
  await mobile.request('/api/platform/select-tenant', { organisationId: f.alpha.company.id });
  await f.gateway.repository.transact(state => {
    const user = state.users.find(user => user.id === f.alpha.user.id);
    state.users.push({ ...structuredClone(user), id: randomUUID(), username: 'duplicate-alias', email: f.alpha.email });
  });
  const duplicate = await mobile.request(LOGIN, { username: f.alpha.email, password: f.alpha.password });
  assert.equal(duplicate.status, 401, JSON.stringify(duplicate.body)); assert.equal(mobile.cookies.has('jeroc_employee'), false);
  await f.gateway.repository.transact(state => {
    state.users = state.users.filter(user => user.username !== 'duplicate-alias');
    state.memberships.push({ userId: f.alpha.user.id, organisationId: f.beta.company.id, businessUserId: f.beta.user.id, active: true });
  });
  const ambiguous = await mobile.request(LOGIN, { username: f.alpha.email, password: f.alpha.password });
  assert.equal(ambiguous.status, 401, JSON.stringify(ambiguous.body)); assert.equal(mobile.cookies.has('jeroc_employee'), false);
}));

test('an existing global mobile session follows actor revocation and rejects a changed business-user binding', () => fixture(async f => {
  const mobile = f.client();
  const login = () => mobile.request(LOGIN, { username: f.alpha.email, password: f.alpha.password });
  assert.equal((await login()).status, 200);
  await f.gateway.repository.transact(state => { state.users.find(user => user.id === f.alpha.user.id).active = false; });
  assert.equal((await mobile.request('/api/employee/session?view=bootstrap')).status, 401);
  await f.gateway.repository.transact(state => { state.users.find(user => user.id === f.alpha.user.id).active = true; });
  assert.equal((await login()).status, 200);
  await f.gateway.repository.transact(state => { state.memberships.find(value => value.userId === f.alpha.user.id).businessUserId = f.beta.user.id; });
  assert.equal((await mobile.request('/api/employee/session?view=bootstrap')).status, 401);
  await f.gateway.repository.transact(state => { state.memberships.find(value => value.userId === f.alpha.user.id).businessUserId = f.alpha.user.id; });
  assert.equal((await login()).status, 200);
  await f.alpha.repository.transact(state => {
    const user = state.pricing.users.find(value => value.id === f.alpha.user.id);
    state.pricing.users.push({ ...structuredClone(user), id: 'replacement-user', name: 'Annan aktiv användare' });
    state.personnel.people.find(value => value.id === f.alpha.person.id).userId = 'replacement-user';
  });
  assert.equal((await mobile.request('/api/employee/session?view=bootstrap')).status, 401);
}));

test('global failures are rate limited before sessions can be issued and never persist plaintext passwords', () => fixture(async f => {
  const mobile = f.client();
  let limited;
  for (let attempt = 0; attempt < 25; attempt++) {
    const result = await mobile.request(LOGIN, { username: 'missing@example.test', password: PASSWORD });
    if (result.status === 429) { limited = result; break; }
    assert.equal(result.status, 401, JSON.stringify(result.body));
  }
  assert.ok(limited, 'A bounded number of rejected global attempts must trigger rate limiting.');
  assert.equal(mobile.cookies.has('jeroc_employee'), false);
  const persisted = JSON.stringify(await f.gateway.repository.read(state => state));
  assert.equal(persisted.includes(PASSWORD), false); assert.equal(persisted.includes('Wrong-Password-2026!'), false);
}));

test('existing standalone personnel credentials still authenticate through an explicitly selected company', () => fixture(async f => {
  const personId = 'local-person', userId = 'local-worker', username = 'only.local';
  await f.alpha.repository.transact(state => {
    const person = state.personnel.people.find(value => value.id === f.alpha.person.id);
    const user = state.pricing.users.find(value => value.id === f.alpha.user.id);
    const account = state.personnelAuth.accounts.find(value => value.personId === person.id);
    state.personnel.people.push({ ...structuredClone(person), id: personId, userId, name: 'Lokal medarbetare', email: '' });
    state.pricing.users.push({ ...structuredClone(user), id: userId, name: 'Lokal medarbetare', level: 'Medarbetare', permissions: ['view'] });
    state.personnelAuth.accounts.push({ ...structuredClone(account), personId, username });
  });
  const mobile = f.client();
  assert.equal((await mobile.request('/api/platform/select-tenant', { organisationId: f.alpha.company.id })).status, 200);
  const login = await mobile.request(LOGIN, { username, password: PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.companyId, f.alpha.company.id);
  assert.equal(login.body.person.id, personId);
  const current = await mobile.request('/api/employee/session?view=bootstrap');
  assert.equal(current.status, 200, JSON.stringify(current.body)); assert.equal(current.body.person.id, personId);
  assert.equal((await mobile.request('/api/application/office')).status, 401);
}));
