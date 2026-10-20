import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';

const LOGIN = '/api/employee/login?view=bootstrap';
const INITIAL = 'Mobile-Support-Initial-2026!';
const ADMIN = 'Mobile-Support-Admin-2026!';
const OWNER = 'Mobile-Support-Owner-2026!';
const customer = name => ({ id: 'shared-customer-id', name, type: 'Företag', number: '559359-3626',
  phone: '0722002220', email: 'yard@example.invalid', address: 'Testgatan 1, 761 41 Norrtälje',
  references: [], origins: [], vatRegistered: true });
const records = value => ({ kind: 'records', version: 1, drafts: [], customers: [{ id: value.id, next: value }] });

function organisationNumber(prefix) {
  const sum = [...prefix].reduce((total, value, index) => {
    const digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit);
  }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}

/** Real platform authentication, tenant provisioning, cookies and application
 * commands. Support never gains permission from a mocked employee/person row. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-admin-support-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, SCRAPPLANNER_PLATFORM_ADMIN_EMAIL: 'admin@example.test',
    APP_URL: 'https://app.scrapplanner.com', MOBILE_URL: 'https://mobile.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let gateway, server;
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
    function client(copy) {
      const cookies = new Map(copy?.cookies); let credentials = copy?.credentials;
      async function request(path, body, headers = {}) {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: Object.fromEntries(Object.entries({ cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(credentials && { 'x-platform-csrf': credentials.csrfToken, 'x-platform-generation': credentials.generation }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }).filter(([, value]) => value !== undefined)),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const setCookies = response.headers.getSetCookie();
        for (const entry of setCookies) {
          const [name, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json();
        if (value?.authenticated) credentials = value;
        if (value?.platformSession) credentials = value.platformSession;
        if (value?.support) credentials = value.support;
        return { status: response.status, body: value, headers: response.headers, setCookies };
      }
      return { request, cookies, snapshot: () => ({ cookies: new Map(cookies), credentials: structuredClone(credentials) }) };
    }
    function delayedWrite(snapshot, payload) {
      const data = JSON.stringify(payload), split = Math.floor(data.length / 2);
      let req;
      const response = new Promise((resolve, reject) => {
        req = httpRequest(`${base}/api/application/mobile`, { method: 'POST', headers: {
          cookie: [...snapshot.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          'x-platform-csrf': snapshot.credentials.csrfToken, 'x-platform-generation': snapshot.credentials.generation,
          'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        } }, res => {
          const chunks = []; res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
          res.on('error', reject);
        });
        req.on('error', reject); req.write(data.slice(0, split));
      });
      return { response, finish: () => req.end(data.slice(split)), cancel: () => req.destroy() };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    const changed = await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const actorId = changed.body.actor.id;
    async function company(label, prefix) {
      const email = `${label.toLowerCase()}@example.test`;
      const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: `${label} Återvinning AB`,
        organisationNumber: organisationNumber(prefix), vdName: `${label} Ägare`, vdEmail: email });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const value = created.body, owner = client();
      assert.equal((await owner.request('/api/platform/login', { username: email, password: value.temporaryCredentials.password })).status, 200);
      assert.equal((await owner.request('/api/platform/change-password', { currentPassword: value.temporaryCredentials.password, newPassword: OWNER })).status, 200);
      const repository = await (await gateway.bundle(await gateway.auth.getCompany(value.company.id))).applicationApi.getRepository();
      return { ...value, email, owner, repository };
    }
    const alpha = await company('Alpha', '556020001'), beta = await company('Beta', '556020002');
    const login = async (mobile = client()) => {
      const result = await mobile.request(LOGIN, { username: 'admin', password: ADMIN });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.kind, 'platform-admin');
      return mobile;
    };
    const select = async (mobile, target) => {
      const result = await mobile.request('/api/employee/company', { companyId: target.company.id });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.companyId, target.company.id);
      assert.equal(result.body.support.kind, 'platform-admin');
      return result;
    };
    await run({ gateway, actorId, admin, client, alpha, beta, login, select, delayedWrite });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}

const hrFootprint = repository => repository.read(state => structuredClone({ personnel: state.personnel,
  accounts: state.personnelAuth.accounts, employeeTime: state.employeeTime,
  users: state.pricing.users, transport: { drivers: state.transport.drivers, vehicles: state.transport.vehicles } }));

test('a real platform administrator selects either tenant and performs isolated yard writes without becoming HR staff', () => fixture(async f => {
  const beforeAlpha = await hrFootprint(f.alpha.repository), beforeBeta = await hrFootprint(f.beta.repository);
  const mobile = await f.login();
  assert.ok(mobile.cookies.has('jeroc_platform')); assert.equal(mobile.cookies.has('jeroc_employee'), false);
  const picker = await mobile.request('/api/employee/companies');
  assert.equal(picker.status, 200, JSON.stringify(picker.body));
  assert.ok(picker.body.companies.some(value => value.id === f.alpha.company.id));
  assert.ok(picker.body.companies.some(value => value.id === f.beta.company.id));
  assert.equal(picker.body.companies.every(value => value.status === 'active'), true);
  for (const [target, name] of [[f.alpha, 'Alpha yard customer'], [f.beta, 'Beta yard customer']]) {
    const selected = await f.select(mobile, target);
    assert.equal(selected.body.person.id, '__platform-admin');
    assert.equal(selected.body.capabilities.yardWork, true); assert.equal(selected.body.capabilities.employeeTime, false);
    assert.ok(selected.body.support.csrfToken); assert.ok(selected.body.support.generation);
    const ownFleet = await mobile.request('/api/employee/fleet');
    assert.equal(ownFleet.status, 403); assert.equal(ownFleet.body.code, 'mobile_support_personal_unavailable');
    assert.equal(ownFleet.body.trips, undefined); assert.equal(ownFleet.body.pendingTrips, undefined);
    const ownAction = await mobile.request('/api/employee/fleet/actions', {
      action: 'trip.complete', tripId: 'another-persons-trip', classification: 'private', expectedTripRevision: 0,
      requestId: randomUUID(), expectedRevision: 0,
    });
    assert.equal(ownAction.status, 403); assert.equal(ownAction.body.code, 'mobile_support_personal_unavailable');
    const saved = await mobile.request('/api/application/mobile', records(customer(name)));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const snapshot = await mobile.request('/api/application/mobile');
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    assert.equal(snapshot.body.data.customers.find(value => value.id === 'shared-customer-id').name, name);
    const persisted = await target.repository.read(state => state.office.customers.find(value => value.id === 'shared-customer-id'));
    assert.equal(persisted.name, name); assert.equal(persisted.audit.at(-1).actualUserId, '__platform-admin');
    const audits = await f.gateway.repository.read(state => state.audit.filter(value => value.action === 'platform.mobile_support_action'
      && value.organisationId === target.company.id && value.route === '/api/application/mobile'));
    assert.equal(audits.length, 1); assert.equal(audits[0].actorId, f.actorId);
    assert.equal(audits[0].effectiveUserId, '__platform-admin'); assert.equal(audits[0].generation, selected.body.support.generation);
    assert.equal(audits[0].method, 'POST'); assert.equal(audits[0].status, 'succeeded');
    assert.equal(JSON.stringify(audits).includes('yard@example.invalid'), false);
    assert.equal(JSON.stringify(audits).includes(selected.body.support.csrfToken), false);
  }
  assert.deepEqual(await hrFootprint(f.alpha.repository), beforeAlpha);
  assert.deepEqual(await hrFootprint(f.beta.repository), beforeBeta);
  assert.equal(await f.alpha.repository.read(state => state.office.customers[0].name), 'Alpha yard customer');
  assert.equal(await f.beta.repository.read(state => state.office.customers[0].name), 'Beta yard customer');
}));

test('company switching fences old tabs, stale cookies, forged scope and missing CSRF before any write', () => fixture(async f => {
  const mobile = await f.login();
  for (const headers of [{ 'x-platform-csrf': undefined }, { 'x-platform-generation': undefined }, { origin: 'https://foreign.invalid' }]) {
    const denied = await mobile.request('/api/employee/company', { companyId: f.alpha.company.id }, headers);
    assert.ok([403, 409].includes(denied.status), JSON.stringify(denied));
  }
  const first = await f.select(mobile, f.alpha), previous = mobile.snapshot(), old = f.client(previous);
  await f.select(mobile, f.beta);
  const stale = await mobile.request('/api/application/mobile', records(customer('stale write')), {
    'x-platform-generation': first.body.support.generation,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.ok([401, 403, 409].includes((await old.request('/api/employee/session?view=bootstrap')).status));
  assert.ok([401, 403, 409].includes((await old.request('/api/application/mobile', records(customer('old cookie')))).status));
  for (const headers of [{ 'x-platform-csrf': undefined }, { 'x-platform-generation': undefined },
    { 'x-employee-company': f.alpha.company.id }, { 'x-client-company': f.alpha.company.id },
    { 'x-demo-actor': f.alpha.user.id }, { 'x-demo-user': f.alpha.user.id }]) {
    const denied = await mobile.request('/api/application/mobile', records(customer('forged write')), headers);
    assert.ok([403, 409].includes(denied.status), JSON.stringify(denied));
  }
  assert.deepEqual(await f.alpha.repository.read(state => state.office.customers), []);
  assert.deepEqual(await f.beta.repository.read(state => state.office.customers), []);
}));

test('ordinary employee, company VD and a caller-controlled header cannot gain platform mobile support', () => fixture(async f => {
  const anonymous = await f.client().request('/api/employee/company', { companyId: f.beta.company.id }, {
    'x-demo-actor': '__platform-admin', 'x-demo-user': '__platform-admin', 'x-platform-csrf': 'forged', 'x-platform-generation': randomUUID(),
  });
  assert.ok([401, 403].includes(anonymous.status), JSON.stringify(anonymous.body));
  const ownerSelect = await f.alpha.owner.request('/api/employee/company', { companyId: f.beta.company.id });
  assert.ok([401, 403].includes(ownerSelect.status), JSON.stringify(ownerSelect.body));
  const staff = f.client();
  const logged = await staff.request(LOGIN, { username: f.alpha.email, password: OWNER });
  assert.equal(logged.status, 200, JSON.stringify(logged.body)); assert.equal(logged.body.support, undefined);
  const denied = await staff.request('/api/employee/company', { companyId: f.beta.company.id });
  assert.ok([401, 403, 404].includes(denied.status), JSON.stringify(denied.body));
  const retained = await staff.request('/api/employee/session?view=bootstrap');
  assert.equal(retained.status, 200, JSON.stringify(retained.body)); assert.equal(retained.body.companyId, f.alpha.company.id);
  assert.equal(retained.body.support, undefined);
}));

test('a temporary administrator password reaches the existing password-change gate before any company operation', () => fixture(async f => {
  await f.gateway.repository.transact(state => { state.users.find(value => value.id === f.actorId).mustChangePassword = true; });
  const mobile = f.client();
  const login = await mobile.request(LOGIN, { username: 'admin', password: ADMIN });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.kind, 'platform-admin'); assert.equal(login.body.platformSession.mustChangePassword, true);
  assert.deepEqual(login.body.companies, []); assert.ok(mobile.cookies.has('jeroc_platform'));
  const blocked = await mobile.request('/api/employee/company', { companyId: f.alpha.company.id });
  assert.equal(blocked.status, 423, JSON.stringify(blocked.body));
  const old = f.client(mobile.snapshot());
  const logout = await mobile.request('/api/employee/logout', {});
  assert.equal(logout.status, 200, JSON.stringify(logout.body));
  assert.equal(mobile.cookies.has('jeroc_platform'), false);
  assert.equal((await old.request('/api/employee/session?view=bootstrap')).status, 401);
  const relogin = await mobile.request(LOGIN, { username: 'admin', password: ADMIN });
  assert.equal(relogin.status, 200, JSON.stringify(relogin.body));
  assert.equal(relogin.body.platformSession.mustChangePassword, true);
  const changed = await mobile.request('/api/platform/change-password', { currentPassword: ADMIN, newPassword: 'Mobile-Support-New-Admin-2026!' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.mustChangePassword, false);
  await f.select(mobile, f.alpha);
  assert.equal((await mobile.request('/api/application/mobile', records(customer('changed password write')))).status, 200);
}));

test('an unfinished support write cannot mutate the old company after its platform session has switched', () => fixture(async f => {
  const mobile = await f.login(); await f.select(mobile, f.alpha);
  const pending = f.delayedWrite(mobile.snapshot(), records(customer('delayed stale write')));
  try {
    let started;
    for (let attempt = 0; attempt < 200; attempt++) {
      started = await f.gateway.repository.read(state => state.audit.some(value => value.action === 'platform.mobile_support_action'
        && value.organisationId === f.alpha.company.id && value.route === '/api/application/mobile' && value.status === 'attempted'));
      if (started) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(started, true, 'The real gateway must authenticate the request before its JSON body is completed.');
    await f.select(mobile, f.beta);
    pending.finish();
    const result = await pending.response;
    assert.ok([401, 403, 409].includes(result.status), JSON.stringify(result));
    assert.deepEqual(await f.alpha.repository.read(state => state.office.customers), []);
    assert.deepEqual(await f.beta.repository.read(state => state.office.customers), []);
  } finally { pending.cancel(); }
}));

test('disabled companies and revoked or recovering administrators cannot continue selected operations', () => fixture(async f => {
  const mobile = await f.login(); await f.select(mobile, f.alpha);
  await f.gateway.repository.transact(state => { state.companies.find(value => value.id === f.beta.company.id).status = 'inactive'; });
  const selectInactive = await mobile.request('/api/employee/company', { companyId: f.beta.company.id });
  assert.ok([403, 409].includes(selectInactive.status), JSON.stringify(selectInactive.body));
  await f.gateway.repository.transact(state => { state.companies.find(value => value.id === f.alpha.company.id).status = 'inactive'; });
  assert.ok([403, 409].includes((await mobile.request('/api/application/mobile', records(customer('inactive company write')))).status));
  await f.gateway.repository.transact(state => { for (const value of state.companies) value.status = 'active'; });
  for (const flag of ['active', 'mustChangePassword', 'passwordRecoveryPending']) {
    await f.gateway.repository.transact(state => { state.users.find(value => value.id === f.actorId)[flag] = flag !== 'active'; });
    const denied = await mobile.request('/api/application/mobile', records(customer('revoked write')));
    assert.ok([401, 403, 423].includes(denied.status), JSON.stringify(denied.body));
    await f.gateway.repository.transact(state => { const user = state.users.find(value => value.id === f.actorId); if (flag === 'active') user.active = true; else delete user[flag]; });
  }
  const loggedOut = f.client(mobile.snapshot());
  const logout = await mobile.request('/api/employee/logout', {});
  assert.equal(logout.status, 200, JSON.stringify(logout.body));
  assert.equal(mobile.cookies.has('jeroc_platform'), false);
  assert.ok([401, 403].includes((await loggedOut.request('/api/employee/session?view=bootstrap')).status));
  assert.ok([401, 403].includes((await loggedOut.request('/api/application/mobile', records(customer('logout replay')))).status));
  assert.deepEqual(await f.alpha.repository.read(state => state.office.customers), []);
}));
