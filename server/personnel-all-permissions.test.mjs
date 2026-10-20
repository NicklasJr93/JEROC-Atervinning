import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';
import { officeSchema } from '../dist-server/domain-models.mjs';

// Read the UI's actual schema, independently of pricing.mjs's input validator:
// importing its own server list would conceal a newly added UI permission.
const allPermissions = [...officeSchema.shape.users.element.shape.permissions.element.options];
const INITIAL = 'Permissions-Initial-2026!';
const ADMIN = 'Permissions-Admin-2026!';
const OWNER = 'Permissions-Owner-2026!';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'personnel-all-permissions-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, APP_URL: 'https://app.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let gateway, server; const failures = [];
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
        for (const entry of response.headers.getSetCookie()) {
          const [name, value] = entry.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json(); if (value?.authenticated) session = value;
        return { status: response.status, body: value };
      }
      return { request };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    assert.equal((await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN })).status, 200);
    const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: 'Behörighetstest AB',
      organisationNumber: '5560000167', vdName: 'Bolagets VD', vdEmail: 'permissions.owner@example.test' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const company = created.body.company, ownerId = created.body.user.id;
    assert.equal((await admin.request('/api/platform/switch', { organisationId: company.id })).status, 200);
    const employee = await admin.request('/api/application/personnel', { action: 'person.save', person: {
      id: 'person-existing-employee', name: 'Befintlig medarbetare', kind: 'employee', siteIds: ['main'], email: 'employee@example.test',
    }, createAccount: { kind: 'staff', permissions: ['view'] } });
    assert.equal(employee.status, 200, JSON.stringify(employee.body));
    const person = employee.body.data.people.find(value => value.id === 'person-existing-employee');
    assert.ok(person?.userId);
    const repository = await (await gateway.bundle(await gateway.auth.getCompany(company.id))).applicationApi.getRepository();
    const users = async () => {
      const result = await admin.request('/api/pricing/state'); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.users;
    };
    const owner = client();
    assert.equal((await owner.request('/api/platform/login', { username: 'permissions.owner@example.test', password: created.body.temporaryCredentials.password })).status, 200);
    assert.equal((await owner.request('/api/platform/change-password', { currentPassword: created.body.temporaryCredentials.password, newPassword: OWNER })).status, 200);
    await run({ gateway, admin, owner, company, ownerId, person, repository, users });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []);
  }
}

test('an authenticated platform administrator can persist every UI permission on an existing employee account', () => fixture(async f => {
  assert.ok(allPermissions.includes('companySettingsRead')); assert.ok(allPermissions.includes('companySettingsWrite'));
  const before = await f.repository.read(state => structuredClone(state.personnel.people));
  const users = (await f.users()).map(user => user.id === f.person.userId ? { ...user, permissions: allPermissions } : user);
  const saved = await f.admin.request('/api/pricing/users', { users, userManagementDelegationVersion: 1 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const returned = saved.body.users.find(user => user.id === f.person.userId);
  assert.deepEqual(new Set(returned.permissions), new Set(allPermissions));
  const state = await f.repository.read(value => structuredClone(value));
  for (const catalog of [state.pricing.users, state.office.users]) {
    const user = catalog.find(value => value.id === f.person.userId);
    assert.deepEqual(new Set(user.permissions), new Set(allPermissions)); assert.equal(user.level, 'Medarbetare');
  }
  assert.deepEqual(state.personnel.people, before);
  const refreshed = await f.admin.request('/api/application/personnel');
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(new Set(refreshed.body.users.find(user => user.id === f.person.userId).permissions), new Set(allPermissions));
  const asEmployee = await f.admin.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.person.userId });
  assert.equal(asEmployee.status, 200, JSON.stringify(asEmployee.body));
  const denied = await f.admin.request('/api/pricing/users', { users: saved.body.users.map(user => user.level === 'VD'
    ? { ...user, name: 'Forbidden VD mutation by delegated employee' } : user) });
  assert.equal(denied.status, 403, 'An explicit users grant must not let an employee manage a VD account.');
}));

test('unknown permission strings are rejected atomically instead of widening the catalog', () => fixture(async f => {
  const before = await f.repository.read(state => structuredClone({ pricing: state.pricing, officeUsers: state.office.users, personnel: state.personnel }));
  const users = (await f.users()).map(user => user.id === f.person.userId ? { ...user, permissions: ['view', 'companySettingsWrite', 'notARealPermission'] } : user);
  const rejected = await f.admin.request('/api/pricing/users', { users });
  assert.ok([400, 422].includes(rejected.status), JSON.stringify(rejected.body));
  assert.equal(typeof rejected.body.error, 'string');
  assert.deepEqual(await f.repository.read(state => structuredClone({ pricing: state.pricing, officeUsers: state.office.users, personnel: state.personnel })), before);
}));

test('the wider valid catalog preserves VD grant ceilings and current effective-user authorization', () => fixture(async f => {
  let users = (await f.users()).map(user => user.id === f.ownerId ? { ...user, maxAttest: 100, siteIds: ['main'] } : user);
  assert.equal((await f.admin.request('/api/pricing/users', { users })).status, 200);
  const before = await f.repository.read(state => structuredClone(state.pricing.users));
  const change = alteration => before.map(user => user.id === f.person.userId ? { ...user, ...alteration } : user);
  for (const alteration of [{ level: 'Systemadmin', permissions: allPermissions }, { maxAttest: 101 }, { siteIds: ['outside-owner-scope'] }]) {
    const rejected = await f.owner.request('/api/pricing/users', { users: change(alteration) });
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
    assert.deepEqual(await f.repository.read(state => state.pricing.users), before);
  }
  const asOwner = await f.admin.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.ownerId });
  assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
  const inheritedCeiling = await f.admin.request('/api/pricing/users', { users: change({ maxAttest: 101 }) });
  assert.equal(inheritedCeiling.status, 403, JSON.stringify(inheritedCeiling.body));
  assert.deepEqual(await f.repository.read(state => state.pricing.users), before);
  const switched = await f.admin.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.person.userId });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const denied = await f.admin.request('/api/pricing/users', { users: change({ permissions: allPermissions }) });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.deepEqual(await f.repository.read(state => state.pricing.users), before);
}));

test('an unchanged administrator from the previous permission catalog does not block a legitimate VD employee edit', () => fixture(async f => {
  // Existing deployments stored the former catalog in a different order. Its
  // administrator still has all effective rights; this is not a role change.
  const legacyPermissions = allPermissions.filter(value => !['companySettingsRead', 'companySettingsWrite'].includes(value)).toReversed();
  await f.repository.transact(state => {
    for (const catalog of [state.pricing.users, state.office.users])
      for (const user of catalog) if (user.level === 'Systemadmin') user.permissions = [...legacyPermissions];
  });
  const before = await f.repository.read(state => structuredClone(state.pricing.users));
  const users = before.map(user => user.id === f.person.userId ? { ...user, name: 'Uppdaterad av bolagets VD' } : user);
  const saved = await f.owner.request('/api/pricing/users', { users });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.users.find(user => user.id === f.person.userId).name, 'Uppdaterad av bolagets VD');
  const forbidden = saved.body.users.map(user => user.level === 'Systemadmin' ? { ...user, name: 'Otillåten ändring av administratör' } : user);
  assert.equal((await f.owner.request('/api/pricing/users', { users: forbidden })).status, 403);
}));
