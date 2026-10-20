import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTenantGateway } from './tenant-gateway.mjs';

const INITIAL = 'Delegation-Initial-Password-2026!';
const ADMIN = 'Delegation-Admin-Password-2026!';
const OWNER = 'Delegation-Owner-Password-2026!';
const TEMPORARY = 'Delegation-Temporary-Password-2026!';
const EMPLOYEE = 'Delegation-Employee-Password-2026!';
const delegateRights = ['view', 'prepare', 'personnelRead', 'personnelWrite', 'companySettingsRead'];

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'delegated-users-http-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false',
    SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL, APP_URL: 'https://app.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let gateway, server, repository; const failures = [];
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
            ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) {
          const [name, value] = entry.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name);
        }
        const value = await response.json(); if (value?.authenticated) session = value;
        return { status: response.status, body: value };
      }
      return { request };
    }
    const admin = client(), owner = client(), delegate = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    assert.equal((await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN })).status, 200);
    const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: 'Delegeringstest AB',
      organisationNumber: '5560000167', vdName: 'Bolagets VD', vdEmail: 'delegation.owner@example.test' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const company = created.body.company, ownerId = created.body.user.id;
    assert.equal((await admin.request('/api/platform/switch', { organisationId: company.id })).status, 200);
    repository = await (await gateway.bundle(await gateway.auth.getCompany(company.id))).applicationApi.getRepository();
    async function createPerson(name, permissions = ['view']) {
      const id = `person-${name}`;
      const response = await admin.request('/api/application/personnel', { action: 'person.save', person: {
        id, name, kind: 'employee', siteIds: ['main'], email: `${name}@example.test`, active: true,
      }, createAccount: { kind: 'staff', permissions, siteIds: ['main'] } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return repository.read(state => structuredClone(state.personnel.people.find(value => value.id === id)));
    }
    const manager = await createPerson('delegate', delegateRights), target = await createPerson('ordinary'), peer = await createPerson('other-delegate', delegateRights);
    const users = () => repository.read(state => structuredClone(state.pricing.users));
    const change = async (by, userId, alteration, extra = {}) => by.request('/api/pricing/users', {
      users: (await users()).map(user => user.id === userId ? { ...user, ...alteration } : user),
      userManagementDelegationVersion: 1, ...extra,
    });
    assert.equal((await change(admin, ownerId, { maxAttest: 1000 })).status, 200);
    assert.equal((await change(admin, manager.userId, { maxAttest: 100 })).status, 200);
    assert.equal((await admin.request('/api/platform/staff-invitations/temporary-password', {
      personId: manager.id, requestId: randomUUID(), password: TEMPORARY,
    })).status, 200);
    assert.equal((await delegate.request('/api/platform/login', { username: manager.email, password: TEMPORARY })).status, 200);
    assert.equal((await delegate.request('/api/platform/change-password', { currentPassword: TEMPORARY, newPassword: EMPLOYEE })).status, 200);
    assert.equal((await owner.request('/api/platform/login', { username: 'delegation.owner@example.test', password: created.body.temporaryCredentials.password })).status, 200);
    assert.equal((await owner.request('/api/platform/change-password', { currentPassword: created.body.temporaryCredentials.password, newPassword: OWNER })).status, 200);
    const grant = (userId = manager.userId) => change(owner, userId, { permissions: [...delegateRights, 'users'] });
    const snapshot = () => repository.read(state => structuredClone({ users: state.pricing.users,
      officeUsers: state.office.users, people: state.personnel.people, accounts: state.personnelAuth.accounts }));
    async function restart() {
      await gateway.close(); gateway = await createTenantGateway({ env });
      repository = await (await gateway.bundle(await gateway.auth.getCompany(company.id))).applicationApi.getRepository();
    }
    await run({ admin, owner, delegate, client, company, ownerId, manager, target, peer, users, change, grant, snapshot,
      get repository() { return repository; }, get gateway() { return gateway; }, restart });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []);
  }
}

test('a VD explicitly delegates ordinary account management and revocation takes effect on the next request', () => fixture(async f => {
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Must stay unchanged' })).status, 403);
  const granted = await f.grant(); assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const directory = await f.delegate.request('/api/pricing/state');
  assert.equal(directory.status, 200, JSON.stringify(directory.body));
  assert.deepEqual(new Set(directory.body.users.map(user => user.id)), new Set((await f.users()).map(user => user.id)),
    'The real account-directory response must support an unchanged protected-record round trip.');
  const unchanged = await f.snapshot();
  assert.equal((await f.delegate.request('/api/pricing/users', { users: directory.body.users }, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await f.delegate.request('/api/pricing/users', { users: directory.body.users }, { 'x-platform-generation': 'stale' })).status, 409);
  assert.deepEqual(await f.snapshot(), unchanged);
  const saved = await f.change(f.delegate, f.target.userId, {
    name: 'Updated by delegated administrator', permissions: ['view', 'prepare'], maxAttest: 100,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const account = (await f.users()).find(user => user.id === f.target.userId);
  assert.equal(account.name, 'Updated by delegated administrator'); assert.equal(account.level, 'Medarbetare');
  assert.deepEqual(account.permissions, ['view', 'prepare']); assert.equal(account.maxAttest, 100);
  const audit = await f.repository.read(state => structuredClone(state.pricing.audit.at(-1)));
  assert.equal(audit.actor, f.manager.userId); assert.equal(audit.actingUser, f.manager.userId);
  assert.equal((await f.change(f.owner, f.manager.userId, { permissions: delegateRights })).status, 200);
  const before = await f.snapshot();
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Forbidden after revocation' })).status, 403);
  assert.deepEqual(await f.snapshot(), before);
}));

test('delegated saves reject rights, scope, attestation, onward delegation and privileged targets atomically', () => fixture(async f => {
  assert.equal((await f.grant()).status, 200); assert.equal((await f.grant(f.peer.userId)).status, 200);
  const before = await f.snapshot();
  const ordinaryAttempts = [
    { permissions: ['view', 'companySettingsWrite'] },
    { permissions: ['view', 'users'] },
    { siteIds: ['outside-delegate-scope'] },
    { maxAttest: 101 },
    { ownAttest: true },
    { level: 'VD' },
    { level: 'Systemadmin' },
  ];
  for (const alteration of ordinaryAttempts) {
    const result = await f.change(f.delegate, f.target.userId, alteration);
    assert.equal(result.status, 403, JSON.stringify({ alteration, result }));
    assert.deepEqual(await f.snapshot(), before);
  }
  const allSites = await f.change(f.delegate, f.target.userId, { siteIds: undefined }, { allSiteUserIds: [f.target.userId] });
  assert.equal(allSites.status, 403, JSON.stringify(allSites.body)); assert.deepEqual(await f.snapshot(), before);
  const administrator = before.users.find(user => user.level === 'Systemadmin'); assert.ok(administrator);
  for (const userId of [f.ownerId, administrator.id, f.peer.userId, f.manager.userId]) {
    // Systemadmin permissions are role-implied and normalized by the server;
    // change its name to exercise a real protected-account mutation.
    const alteration = userId === administrator.id ? { name: 'Unauthorized administrator rename' } : { permissions: ['view'] };
    const result = await f.change(f.delegate, userId, alteration);
    assert.equal(result.status, 403, JSON.stringify({ userId, result })); assert.deepEqual(await f.snapshot(), before);
  }
  const deleted = await f.delegate.request('/api/pricing/users', { users: before.users.filter(user => user.id !== f.peer.userId) });
  assert.equal(deleted.status, 403, JSON.stringify(deleted.body)); assert.deepEqual(await f.snapshot(), before);
}));

test('the effective account limits real platform support and forged actor headers do not bypass delegation', () => fixture(async f => {
  assert.equal((await f.grant()).status, 200);
  const selected = await f.admin.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.manager.userId });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const saved = await f.change(f.admin, f.target.userId, { name: 'Support respecting delegated scope', permissions: ['view', 'prepare'] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const before = await f.snapshot();
  const denied = await f.change(f.admin, f.target.userId, { permissions: ['view', 'companySettingsWrite'] });
  assert.equal(denied.status, 403, JSON.stringify(denied.body)); assert.deepEqual(await f.snapshot(), before);
  const ordinary = await f.admin.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.target.userId });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  assert.equal((await f.change(f.admin, f.target.userId, { name: 'No effective users grant' })).status, 403);
  const forged = await f.delegate.request('/api/pricing/users', { users: before.users.map(user => user.id === f.ownerId
    ? { ...user, name: 'Forged privileged mutation' } : user) }, { 'x-demo-actor': '__platform-admin', 'x-demo-user': '__platform-admin' });
  assert.ok(forged.status >= 400, JSON.stringify(forged.body)); assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.delegate.request('/api/platform/switch', { organisationId: f.company.id, effectiveUserId: f.ownerId })).status, 403);
}));

test('historically inert users flags are removed before authentication and later explicit grants survive a restart', () => fixture(async f => {
  await f.repository.transact(state => {
    delete state.metadata.userManagementDelegationVersion;
    for (const catalog of [state.pricing.users, state.office.users])
      for (const user of catalog) if (user.id === f.manager.userId) user.permissions = [...delegateRights, 'users'];
  });
  await f.restart();
  const session = await f.delegate.request('/api/platform/session');
  assert.equal(session.status, 200, JSON.stringify(session.body));
  assert.ok(!session.body.user.permissions.includes('users'));
  const state = await f.repository.read(value => structuredClone(value));
  assert.equal(state.metadata.userManagementDelegationVersion, 1);
  assert.ok(!state.office.users.find(user => user.id === f.manager.userId).permissions.includes('users'));
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Legacy bit must not authorize' })).status, 403);
  const grant = await f.grant(); assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Explicit post-migration grant' })).status, 200);
  await f.restart();
  const retained = await f.delegate.request('/api/platform/session');
  assert.equal(retained.status, 200, JSON.stringify(retained.body)); assert.ok(retained.body.user.permissions.includes('users'));
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Delegation survives second restart' })).status, 200);
}));

test('an old owner tab cannot restore an inert delegation flag without acknowledging the new grant contract', () => fixture(async f => {
  const before = await f.snapshot();
  const staleTabUsers = before.users.map(user => user.id === f.manager.userId
    ? { ...user, permissions: [...delegateRights, 'users'] } : user);
  const denied = await f.owner.request('/api/pricing/users', { users: staleTabUsers });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'No restored legacy authority' })).status, 403);
  const acknowledged = await f.owner.request('/api/pricing/users', {
    users: staleTabUsers, userManagementDelegationVersion: 1,
  });
  assert.equal(acknowledged.status, 200, JSON.stringify(acknowledged.body));
  assert.equal((await f.change(f.delegate, f.target.userId, { name: 'Explicit acknowledged authority' })).status, 200);
  const ordinaryEdit = await f.owner.request('/api/pricing/users', { users: (await f.users()).map(user => user.id === f.target.userId
    ? { ...user, name: 'Ordinary edit needs no new delegation acknowledgment' } : user) });
  assert.equal(ordinaryEdit.status, 200, JSON.stringify(ordinaryEdit.body));
  const beforeDemotion = await f.snapshot();
  const staleRoleChange = beforeDemotion.users.map(user => user.id === f.ownerId ? { ...user, level: 'Medarbetare' } : user);
  assert.ok(staleRoleChange.find(user => user.id === f.ownerId).permissions.includes('users'));
  const roleChange = await f.admin.request('/api/pricing/users', { users: staleRoleChange });
  assert.equal(roleChange.status, 409, JSON.stringify(roleChange.body));
  assert.deepEqual(await f.snapshot(), beforeDemotion);
  assert.equal((await f.admin.request('/api/pricing/users', {
    users: staleRoleChange, userManagementDelegationVersion: 1,
  })).status, 200);
}));

test('delegates can provision an ordinary employee but cannot take over a VD or another delegated identity through HR', () => fixture(async f => {
  assert.equal((await f.grant()).status, 200); assert.equal((await f.grant(f.peer.userId)).status, 200);
  const created = await f.delegate.request('/api/application/personnel', { action: 'person.save', person: {
    id: 'person-created-by-delegate', name: 'Created ordinary employee', kind: 'employee', email: 'created-by-delegate@example.test',
    siteIds: ['main'], active: true,
  }, createAccount: { kind: 'staff', permissions: ['view', 'prepare'], maxAttest: 50, siteIds: ['main'] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const createdPerson = await f.repository.read(state => structuredClone(state.personnel.people.find(person => person.id === 'person-created-by-delegate')));
  assert.ok(createdPerson?.userId);
  const invitation = await f.delegate.request('/api/platform/staff-invitations/temporary-password', {
    personId: createdPerson.id, requestId: randomUUID(), password: TEMPORARY,
  });
  assert.equal(invitation.status, 200, JSON.stringify(invitation.body));
  const before = await f.snapshot();
  const owner = before.people.find(person => person.userId === f.ownerId); assert.ok(owner);
  for (const person of [owner, f.peer, f.manager]) {
    const invitation = await f.delegate.request('/api/platform/staff-invitations/temporary-password', {
      personId: person.id, requestId: randomUUID(), password: TEMPORARY,
    });
    assert.equal(invitation.status, 403, JSON.stringify(invitation.body)); assert.deepEqual(await f.snapshot(), before);
    const disabled = await f.delegate.request('/api/application/personnel', { action: 'person.save', person: { ...person, active: false } });
    assert.equal(disabled.status, 403, JSON.stringify(disabled.body)); assert.deepEqual(await f.snapshot(), before);
  }
}));
