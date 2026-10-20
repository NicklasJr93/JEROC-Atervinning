import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantGateway } from './tenant-gateway.mjs';

const original = 'Recovery-Private-Initial-2026!';
const replacement = 'Recovery-Private-Replacement-2026!';
const adminEmail = 'admin-recovery@example.test';
const rootPath = '/api/platform/password-reset/';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'password-recovery-gateway-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: original, SCRAPPLANNER_PLATFORM_ADMIN_EMAIL: adminEmail,
    APP_URL: 'https://app.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  const sent = [], failures = [];
  let server, gateway;
  try {
    gateway = await createTenantGateway({ env, systemEmail: { configured: true,
      sendTest: async () => { throw new Error('Test email must not be sent'); },
      sendPasswordReset: async command => { sent.push(structuredClone(command)); return { providerId: randomUUID() }; } } });
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
            ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
          ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) {
          const [name, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json();
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers };
      }
      return { request };
    }
    const token = () => new URLSearchParams(new URL(sent.at(-1).resetUrl).hash.split('?')[1]).get('token');
    await run({ gateway, client, sent, token });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

test('public recovery resets registered admin, consumes once and revokes office and linked employee sessions', () => fixture(async f => {
  const first = f.client(), other = f.client(), employee = f.client(), recovery = f.client();
  assert.equal((await first.request('/api/platform/login', { username: 'admin', password: original })).status, 200);
  const changed = await first.request('/api/platform/change-password', { currentPassword: original, newPassword: 'Recovery-Private-Activated-2026!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await other.request('/api/platform/login', { username: 'admin', password: 'Recovery-Private-Activated-2026!' })).status, 200);
  assert.equal((await employee.request('/api/employee/login?view=bootstrap', { username: 'admin', password: 'Recovery-Private-Activated-2026!' })).status, 200);
  const known = await recovery.request(`${rootPath}request`, { email: adminEmail }, { host: 'attacker.invalid', 'x-platform-generation': 'stale', 'x-client-company': 'other' });
  assert.equal(known.status, 200); assert.equal(known.body.ok, true);
  assert.match(known.headers.get('cache-control'), /no-store/);
  assert.equal(known.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, adminEmail);
  assert.match(f.sent[0].resetUrl, /^https:\/\/app\.scrapplanner\.com\/kontor\/#\/reset-password\?token=[A-Za-z0-9_-]{43}$/);
  const token = f.token();
  const persisted = JSON.stringify(await f.gateway.repository.read(state => state));
  assert.ok(!persisted.includes(token)); assert.ok(!persisted.includes(f.sent[0].resetUrl));
  assert.equal((await recovery.request(`${rootPath}confirm`)).status, 404); // Opening a link never consumes it.
  const invalid = await recovery.request(`${rootPath}confirm`, { token, newPassword: replacement, confirmPassword: 'Different-Private-Password' });
  assert.equal(invalid.status, 422);
  const completed = await recovery.request(`${rootPath}confirm`, { token, newPassword: replacement, confirmPassword: replacement });
  assert.equal(completed.status, 200, JSON.stringify(completed.body)); assert.deepEqual(completed.body, { ok: true });
  assert.match(completed.headers.get('set-cookie'), /jeroc_platform=;[^,]*Max-Age=0/);
  assert.equal((await first.request('/api/platform/session')).status, 401);
  assert.equal((await other.request('/api/platform/session')).status, 401);
  assert.equal((await employee.request('/api/employee/session?view=bootstrap')).status, 401);
  assert.equal((await recovery.request(`${rootPath}confirm`, { token, newPassword: replacement, confirmPassword: replacement })).status, 422);
  assert.equal((await recovery.request('/api/platform/login', { username: 'admin', password: 'Recovery-Private-Activated-2026!' })).status, 401);
  const login = await recovery.request('/api/platform/login', { username: 'admin', password: replacement });
  assert.equal(login.status, 200); assert.equal(login.body.actor.platformAdmin, true); assert.equal(login.body.mustChangePassword, false);
  assert.equal((await f.client().request('/api/employee/login?view=bootstrap', { username: 'admin', password: replacement })).status, 200);
}));

test('owner recovery preserves tenant and role; public errors do not disclose accounts or accept cross-site commands', () => fixture(async f => {
  const admin = f.client(), owner = f.client(), publicClient = f.client();
  await admin.request('/api/platform/login', { username: 'admin', password: original });
  await admin.request('/api/platform/change-password', { currentPassword: original, newPassword: 'Recovery-Another-Activated-2026!' });
  const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: 'Recovery owner AB',
    organisationNumber: '5560000167', vdName: 'Recovery owner', vdEmail: 'owner-recovery@example.test' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await publicClient.request(`${rootPath}request`, { email: 'owner-recovery@example.test' }, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await publicClient.request(`${rootPath}request`, { email: adminEmail, companyId: created.body.company.id })).status, 422);
  assert.equal((await publicClient.request(`${rootPath}request`, '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await publicClient.request(`${rootPath}request`, '{')).status, 400);
  assert.equal(f.sent.length, 0);
  const known = await publicClient.request(`${rootPath}request`, { email: 'owner-recovery@example.test' });
  const unknown = await publicClient.request(`${rootPath}request`, { email: 'nobody-recovery@example.test' });
  assert.equal(known.status, unknown.status); assert.deepEqual(known.body, unknown.body); assert.equal(f.sent.length, 1);
  const token = f.token();
  assert.equal((await publicClient.request(`${rootPath}confirm`, { token, newPassword: replacement, confirmPassword: replacement })).status, 200);
  const login = await owner.request('/api/platform/login', { username: 'owner-recovery@example.test', password: replacement });
  assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.actor.platformAdmin, false);
  assert.equal(login.body.organisationId, created.body.company.id); assert.equal(login.body.companies.length, 1);
  assert.equal((await admin.request('/api/platform/session')).status, 200);
  const employee = f.client();
  assert.equal((await employee.request('/api/platform/select-tenant', { organisationId: created.body.company.id })).status, 200);
  assert.equal((await employee.request('/api/employee/login?view=bootstrap', { username: 'owner-recovery@example.test', password: replacement })).status, 200);
}));

test('office password recovery preserves a deliberately disabled linked employee login', () => fixture(async f => {
  const admin = f.client(), publicClient = f.client();
  await admin.request('/api/platform/login', { username: 'admin', password: original });
  await admin.request('/api/platform/change-password', { currentPassword: original, newPassword: 'Recovery-Disabled-Activated-2026!' });
  const company = await f.gateway.auth.getCompany('jeroc-demo');
  const repository = await (await f.gateway.bundle(company)).applicationApi.getRepository();
  await repository.transact(state => {
    const person = state.personnel.people.find(value => value.userId === 'admin');
    const account = state.personnelAuth.accounts.find(value => value.personId === person.id);
    account.active = false; account.updatedAt = new Date().toISOString();
    state.personnelAuth.sessions = [];
  });
  await publicClient.request(`${rootPath}request`, { email: adminEmail });
  const token = f.token();
  const result = await publicClient.request(`${rootPath}confirm`, { token, newPassword: replacement, confirmPassword: replacement });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await publicClient.request('/api/platform/login', { username: 'admin', password: replacement })).status, 200);
  const account = await repository.read(state => state.personnelAuth.accounts.find(value => value.username === 'admin'));
  assert.equal(account.active, false);
  // The disabled employee remains disabled. The active platform administrator
  // can separately enter the documented support picker, not that employee.
  const support = await f.client().request('/api/employee/login?view=bootstrap', { username: 'admin', password: replacement });
  assert.equal(support.status, 200, JSON.stringify(support.body));
  assert.equal(support.body.kind, 'platform-admin');
  assert.equal(support.body.platformSession.actor.platformAdmin, true);
  assert.equal(await repository.read(state => state.personnelAuth.accounts.find(value => value.username === 'admin').active), false);
}));

test('own profile HTTP endpoint requires session, CSRF and password and never accepts a target user', () => fixture(async f => {
  const admin = f.client(), anonymous = f.client();
  assert.equal((await anonymous.request('/api/platform/profile')).status, 401);
  await admin.request('/api/platform/login', { username: 'admin', password: original });
  const password = 'Profile-Activated-Private-2026!';
  assert.equal((await admin.request('/api/platform/change-password', { currentPassword: original, newPassword: password })).status, 200);
  const before = await admin.request('/api/platform/profile');
  assert.equal(before.status, 200); assert.equal(before.body.email, adminEmail);
  assert.match(before.headers.get('cache-control'), /no-store/);
  const input = { expectedVersion: before.body.version, email: 'changed-profile@example.test', currentPassword: password };
  assert.equal((await admin.request('/api/platform/profile', input, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await admin.request('/api/platform/profile', input, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await admin.request('/api/platform/profile', { ...input, userId: 'another-user' })).status, 422);
  assert.equal((await admin.request('/api/platform/profile', { ...input, currentPassword: 'Wrong-Private-Password' })).status, 403);
  const saved = await admin.request('/api/platform/profile', input);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { ...before.body, email: input.email, version: before.body.version + 1 });
  assert.ok(!JSON.stringify(saved.body).includes(password));
  const session = await admin.request('/api/platform/session');
  assert.equal(session.status, 200); assert.equal(session.body.actor.username, 'admin');
  assert.ok(!JSON.stringify(session.body.actor).includes(input.email));
  assert.equal((await admin.request('/api/platform/profile', input)).status, 409);
}));
