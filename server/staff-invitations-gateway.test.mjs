import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantGateway } from './tenant-gateway.mjs';

const INITIAL = 'Invite-Private-Initial-2026!';
const ADMIN = 'Invite-Private-Admin-Activated-2026!';
const CHOSEN = 'Employee-Chooses-Own-Password-2026!';
const TEMPORARY = 'Private-Temporary-Employee-2026!';
const PATH = '/api/platform/staff-invitations';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'staff-invitation-http-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, SCRAPPLANNER_PLATFORM_ADMIN_EMAIL: 'invitation-admin@example.test',
    APP_URL: 'https://app.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  const sent = [], failures = [];
  let server, gateway;
  try {
    gateway = await createTenantGateway({ env, systemEmail: { configured: true,
      sendStaffInvitation: async command => { sent.push(structuredClone(command)); return { providerId: randomUUID() }; },
      sendPasswordReset: async () => { throw new Error('This test never sends recovery email.'); },
      sendTest: async () => { throw new Error('This test never sends test email.'); } } });
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
          ...(body !== undefined && { body: JSON.stringify(body) }) });
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
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    const changed = await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const company = await gateway.auth.getCompany('jeroc-demo');
    const business = await (await gateway.bundle(company)).applicationApi.getRepository();
    async function employee(email = `staff-${randomUUID().slice(0, 8)}@example.test`) {
      const id = `invited-${randomUUID().slice(0, 8)}`;
      const created = await admin.request('/api/application/personnel', { action: 'person.save',
        person: { id, name: 'Inbjuden Medarbetare', kind: 'employee', email, active: true },
        createAccount: { kind: 'staff', siteIds: ['norrtalje'] } });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const person = await business.read(state => structuredClone(state.personnel.people.find(value => value.id === id)));
      return person;
    }
    const token = () => new URLSearchParams(new URL(sent.at(-1).activationUrl).hash.split('?')[1]).get('token');
    await run({ gateway, business, client, admin, employee, sent, token });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

test('staff invitation activates actual office and mobile credentials, preserves permissions and consumes once', () => fixture(async f => {
  const person = await f.employee();
  const initial = await f.admin.request(`${PATH}?personId=${person.id}`);
  assert.equal(initial.status, 200, JSON.stringify(initial.body)); assert.equal(initial.body.status, 'not_invited');
  const requestId = randomUUID();
  const issued = await f.admin.request(PATH, { personId: person.id, requestId });
  assert.equal(issued.status, 200, JSON.stringify(issued.body)); assert.equal(issued.body.status, 'sent');
  assert.equal(issued.body.email, person.email); assert.equal(f.sent.length, 1);
  const again = await f.admin.request(PATH, { personId: person.id, requestId });
  assert.equal(again.status, 200, JSON.stringify(again.body)); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].username, person.email);
  assert.match(f.sent[0].activationUrl, /^https:\/\/app\.scrapplanner\.com\/kontor\/#\/activate-account\?token=[A-Za-z0-9_-]{43}$/);
  const token = f.token();
  const persisted = JSON.stringify(await f.gateway.repository.read(state => state));
  assert.ok(!persisted.includes(token)); assert.ok(!persisted.includes(f.sent[0].activationUrl));
  const publicClient = f.client();
  assert.equal((await publicClient.request('/api/platform/login', { username: person.email, password: CHOSEN })).status, 401);
  assert.equal((await publicClient.request(`${PATH}/confirm`)).status, 404);
  const activated = await publicClient.request(`${PATH}/confirm`, { token, newPassword: CHOSEN, confirmPassword: CHOSEN });
  assert.equal(activated.status, 200, JSON.stringify(activated.body)); assert.equal(activated.body.ok, true);
  assert.equal((await publicClient.request(`${PATH}/confirm`, { token, newPassword: CHOSEN, confirmPassword: CHOSEN })).status, 422);
  const login = await publicClient.request('/api/platform/login', { username: person.email, password: CHOSEN });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.actor.platformAdmin, false); assert.equal(login.body.mustChangePassword, false);
  assert.equal(login.body.organisationId, 'jeroc-demo'); assert.equal(login.body.user.id, person.userId);
  assert.equal(login.body.user.level, 'Medarbetare'); assert.deepEqual(login.body.user.permissions, ['view']);
  assert.equal((await publicClient.request('/api/platform/companies', { requestId: randomUUID(), name: 'Forbidden AB',
    organisationNumber: '5560000167', vdName: 'Forbidden Owner', vdEmail: 'forbidden@example.test' })).status, 403);
  const mobile = f.client();
  assert.equal((await mobile.request('/api/platform/select-tenant', { organisationId: 'jeroc-demo' })).status, 200);
  const mobileLogin = await mobile.request('/api/employee/login?view=bootstrap', { username: person.email, password: CHOSEN });
  assert.equal(mobileLogin.status, 200, JSON.stringify(mobileLogin.body));
  assert.equal((await f.admin.request(`${PATH}?personId=${person.id}`)).body.status, 'active');
  const overwrite = await f.admin.request(`${PATH}/temporary-password`, { personId: person.id, requestId: randomUUID(), password: TEMPORARY });
  assert.equal(overwrite.status, 409, JSON.stringify(overwrite.body));
  const repeatMail = await f.admin.request(PATH, { personId: person.id, requestId: randomUUID() });
  assert.equal(repeatMail.status, 409, JSON.stringify(repeatMail.body)); assert.equal(f.sent.length, 1);
}));

test('temporary password is never emailed and cannot access office or mobile before mandatory password change', () => fixture(async f => {
  const person = await f.employee(), employee = f.client(), mobile = f.client();
  const issued = await f.admin.request(`${PATH}/temporary-password`, { personId: person.id, requestId: randomUUID(), password: TEMPORARY });
  assert.equal(issued.status, 200, JSON.stringify(issued.body)); assert.equal(issued.body.status, 'temporary_password');
  assert.equal(issued.body.username, person.email); assert.equal(f.sent.length, 0);
  assert.ok(!JSON.stringify(issued.body).includes(TEMPORARY));
  assert.ok(!JSON.stringify(await f.gateway.repository.read(state => state)).includes(TEMPORARY));
  assert.equal((await mobile.request('/api/platform/select-tenant', { organisationId: 'jeroc-demo' })).status, 200);
  assert.equal((await mobile.request('/api/employee/login?view=bootstrap', { username: person.email, password: TEMPORARY })).status, 401);
  const login = await employee.request('/api/platform/login', { username: person.email, password: TEMPORARY });
  assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.mustChangePassword, true);
  assert.equal((await employee.request('/api/application/office')).status, 423);
  const changed = await employee.request('/api/platform/change-password', { currentPassword: TEMPORARY, newPassword: CHOSEN });
  assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.mustChangePassword, false);
  assert.equal((await f.client().request('/api/platform/login', { username: person.email, password: TEMPORARY })).status, 401);
  assert.equal((await mobile.request('/api/employee/login?view=bootstrap', { username: person.email, password: CHOSEN })).status, 200);
  assert.equal(f.sent.length, 0);
}));

test('staff invitations require CSRF and effective user authority and never accept a client recipient', () => fixture(async f => {
  const person = await f.employee(), input = { personId: person.id, requestId: randomUUID() };
  assert.equal((await f.client().request(PATH, input)).status, 401);
  assert.equal((await f.admin.request(PATH, input, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await f.admin.request(PATH, input, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.admin.request(PATH, { ...input, email: 'attacker@example.test' })).status, 422);
  assert.equal((await f.admin.request(PATH, input, { 'x-platform-generation': 'stale' })).status, 409);
  assert.equal(f.sent.length, 0);
  const switched = await f.admin.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: person.userId });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal((await f.admin.request(PATH, input)).status, 403);
  assert.equal(f.sent.length, 0);
}));

test('changing staff email or deactivating staff invalidates an outstanding activation proof', () => fixture(async f => {
  const person = await f.employee(), publicClient = f.client();
  assert.equal((await f.admin.request(PATH, { personId: person.id, requestId: randomUUID() })).status, 200);
  const token = f.token();
  await f.business.transact(state => { state.personnel.people.find(value => value.id === person.id).email = 'replacement@example.test'; });
  const changed = await publicClient.request(`${PATH}/confirm`, { token, newPassword: CHOSEN, confirmPassword: CHOSEN });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal((await publicClient.request('/api/platform/login', { username: person.email, password: CHOSEN })).status, 401);
  const other = await f.employee();
  assert.equal((await f.admin.request(`${PATH}/temporary-password`, { personId: other.id, requestId: randomUUID(), password: TEMPORARY })).status, 200);
  const temporaryClient = f.client();
  assert.equal((await temporaryClient.request('/api/platform/login', { username: other.email, password: TEMPORARY })).status, 200);
  await f.business.transact(state => { state.personnel.people.find(value => value.id === other.id).active = false; });
  const disabled = await temporaryClient.request('/api/platform/change-password', { currentPassword: TEMPORARY, newPassword: CHOSEN });
  assert.ok(disabled.status >= 400, JSON.stringify(disabled.body));
  assert.equal((await publicClient.request('/api/platform/login', { username: other.email, password: CHOSEN })).status, 401);
}));
