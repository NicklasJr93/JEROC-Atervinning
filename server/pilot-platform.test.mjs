import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformUsageStorage } from './platform-usage-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createTenantApplicationState } from './tenant-runtime.mjs';
import { createTenantGateway } from './tenant-gateway.mjs';

const bootstrapPassword = 'Private-Pilot-Bootstrap-2026!';
const changedPassword = 'Changed-Pilot-Administrator-2026!';
const serverRequest = (account, method = 'GET', extra = {}) => ({ method, socket: { remoteAddress: '127.0.0.1' }, headers: {
  ...(account && { cookie: `jeroc_platform=${account.token}; jeroc_tenant=${account.tenantToken}`,
    'x-platform-csrf': account.value.csrfToken, 'x-platform-generation': account.value.generation }), ...extra,
} });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-pilot-auth-'));
  const env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  let repository = await createPlatformStorage({ env }), auth, bootstraps = 0;
  const companyStates = new Map(), passwordChanges = [];
  const callbacks = {
    bootstrapPlatform: async () => { bootstraps++; return { id: 'platform-admin', username: 'admin', name: 'Systemadmin',
      password: await platformPasswordHash(bootstrapPassword), active: true }; },
    bootstrapLegacy: async () => { throw new Error('A pilot must never import the legacy identity'); },
    provisionCompany: async ({ company, user }) => {
      companyStates.set(company.id, createTenantApplicationState({ tenant: company, owner: { id: user.id,
        personId: `person-${user.id}`, name: user.name, username: user.username, email: user.email,
        passwordHash: user.password, mustChangePassword: user.mustChangePassword } }));
    },
    resolveCompanyUser: async (id, userId) => userId === '__platform-admin'
      ? { id: userId, name: 'Systemadmin', level: 'Systemadmin', permissions: [], active: true }
      : companyStates.get(id)?.pricing.users.find(user => user.id === userId),
    companyUsers: async id => companyStates.get(id)?.pricing.users ?? [],
    onPasswordChanged: async input => {
      passwordChanges.push(input);
      for (const companyId of input.companyIds) {
        const account = companyStates.get(companyId).personnelAuth.accounts[0];
        account.password = structuredClone(input.password); account.active = !input.user.mustChangePassword;
      }
    },
  };
  const setup = () => { auth = createPlatformAuth({ repository, ...callbacks }); };
  setup();
  try { await run({ get auth() { return auth; }, get repository() { return repository; }, companyStates, passwordChanges,
    get bootstraps() { return bootstraps; },
    login: (username = 'admin', password = bootstrapPassword) => auth.login({ username, password }, serverRequest()),
    activate: async () => { const initial = await auth.login({ username: 'admin', password: bootstrapPassword }, serverRequest());
      return auth.changePassword({ newPassword: changedPassword }, serverRequest(initial, 'POST')); },
    reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env }); setup(); },
  }); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('pilot bootstrap creates only a private control-plane administrator and never a demo company', () => fixture(async f => {
  await f.auth.initialize();
  const state = await f.repository.read(state => state);
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].username, 'admin');
  assert.equal(state.users[0].platformAdmin, true);
  assert.equal(state.users[0].mustChangePassword, true);
  assert.deepEqual(state.companies, []); assert.deepEqual(state.memberships, []);
  assert.deepEqual(state.sessions, []); assert.equal(state.audit[0].action, 'platform.private_admin_created');
  assert.ok(!JSON.stringify(state).includes(bootstrapPassword));
  const password = structuredClone(state.users[0].password);
  for (let restart = 0; restart < 3; restart++) {
    await f.reopen(); await f.auth.initialize();
    const reopened = await f.repository.read(state => state);
    assert.deepEqual(reopened.companies, []); assert.deepEqual(reopened.memberships, []);
    assert.deepEqual(reopened.users[0].password, password);
  }
  assert.equal(f.bootstraps, 1);
  await assert.rejects(f.login('admin', 'JerocDemo2026!'), error => error.code === 'platform_invalid_credentials');
}));

test('unselected pilot administrator must change password and cannot resolve any business context', () => fixture(async f => {
  const initial = await f.login();
  assert.equal(initial.value.company, undefined); assert.equal(initial.value.organisationId, undefined);
  assert.equal(initial.value.mustChangePassword, true); assert.deepEqual(initial.value.companies, []);
  await assert.rejects(f.auth.companies(serverRequest(initial)), error => error.code === 'platform_password_change_required');
  const active = await f.auth.changePassword({ newPassword: changedPassword }, serverRequest(initial, 'POST'));
  assert.equal(active.value.mustChangePassword, false); assert.equal(active.value.isSupportSession, false);
  assert.equal(active.value.user.id, '__platform-admin'); assert.equal(active.value.company, undefined);
  assert.deepEqual(await f.auth.companies(serverRequest(active)), { companies: [] });
  await assert.rejects(f.auth.resolveContext(serverRequest(active)), error => error.code === 'platform_company_required');
  await assert.rejects(f.auth.session(serverRequest(initial)), error => error.code === 'platform_session_required');
  await assert.rejects(f.auth.companies(serverRequest(active, 'GET', { 'x-platform-organisation-id': 'jeroc-demo' })), error => error.code === 'platform_context_changed');
  assert.equal(await f.auth.withPlatformAdminTransaction(serverRequest(active), state => state.companies.length), 0);
  assert.deepEqual(f.passwordChanges[0].companyIds, []);
  await f.auth.logout(serverRequest(active, 'POST'));
  await assert.rejects(f.auth.session(serverRequest(active)), error => error.code === 'platform_session_required');
  await assert.rejects(f.login(), error => error.code === 'platform_invalid_credentials');
  const again = await f.login('admin', changedPassword);
  assert.equal(again.value.company, undefined);
}));

test('pilot admin provisions the first empty company, while VD and support stay scoped to its identity', () => fixture(async f => {
  const admin = await f.activate();
  const created = await f.auth.createCompany({ requestId: randomUUID(), name: 'Pilotbolaget', organisationNumber: '559359-3626',
    vdName: 'Verklig VD', vdEmail: 'vd@example.test' }, serverRequest(admin, 'POST'));
  assert.equal(created.company.status, 'active'); assert.equal(created.credentialsRevealed, true);
  const state = f.companyStates.get(created.company.id);
  assert.deepEqual(state.office.cards, []); assert.deepEqual(state.office.customers, []);
  assert.deepEqual(state.pricing.articleHistory, []); assert.deepEqual(state.transport.orders, []);
  assert.deepEqual(state.transport.vehicles, []); assert.deepEqual(state.employeeTime.entries, []);
  assert.deepEqual(state.personnel.people.map(person => person.name), ['Verklig VD']);
  assert.equal(state.personnelAuth.accounts[0].active, false);
  assert.equal((await f.auth.session(serverRequest(admin))).company, undefined);
  const ownSupport = await f.auth.switchCompany({ organisationId: created.company.id }, serverRequest(admin, 'POST'));
  const context = await f.auth.resolveContext(serverRequest(ownSupport));
  assert.equal(context.organisationId, created.company.id); assert.equal(context.user.id, '__platform-admin');
  assert.equal(context.actualUser.id, '__platform-admin'); assert.equal(context.isSupportSession, true);
  await assert.rejects(f.auth.withPlatformAdminTransaction(serverRequest(ownSupport), () => true), error => error.code === 'platform_fleet_forbidden');
  const acting = await f.auth.switchCompany({ organisationId: created.company.id, effectiveUserId: created.user.id }, serverRequest(ownSupport, 'POST'));
  const impersonation = await f.auth.resolveContext(serverRequest(acting));
  assert.equal(impersonation.actualUser.id, '__platform-admin'); assert.equal(impersonation.user.id, created.user.id);
  await assert.rejects(f.auth.session(serverRequest(ownSupport)), error => error.code === 'platform_session_required');
  const owner = await f.login(created.temporaryCredentials.username, created.temporaryCredentials.password);
  assert.equal(owner.value.mustChangePassword, true); assert.equal(owner.value.company.id, created.company.id);
  const ownerActive = await f.auth.changePassword({ newPassword: 'Owner-New-Private-Password-2026!' }, serverRequest(owner, 'POST'));
  assert.equal(ownerActive.value.mustChangePassword, false); assert.equal(state.personnelAuth.accounts[0].active, true);
  assert.equal((await f.auth.resolveContext(serverRequest(ownerActive))).organisationId, created.company.id);
  await assert.rejects(f.auth.createCompany({ requestId: randomUUID(), name: 'Other', organisationNumber: '5593593626', vdName: 'Other', vdEmail: 'other@example.test' }, serverRequest(ownerActive, 'POST')),
    error => error.code === 'platform_admin_required');
}));

test('opening system administration ends pilot support, rotates the session and clears tenant selection', () => fixture(async f => {
  const admin = await f.activate();
  const created = await f.auth.createCompany({ requestId: randomUUID(), name: 'Pilotbolaget', organisationNumber: '5593593626',
    vdName: 'VD', vdEmail: 'vd@example.test' }, serverRequest(admin, 'POST'));
  const support = await f.auth.switchCompany({ organisationId: created.company.id, effectiveUserId: created.user.id }, serverRequest(admin, 'POST'));
  assert.equal((await f.auth.resolveContext(serverRequest(support))).isSupportSession, true);
  const own = await f.auth.openAdministration(serverRequest(support, 'POST'));
  assert.equal(own.value.company, undefined); assert.equal(own.value.organisationId, undefined);
  assert.equal(own.value.user.id, '__platform-admin'); assert.equal(own.value.actualUser.id, '__platform-admin');
  assert.equal(own.value.isSupportSession, false); assert.equal(own.tenantToken, '');
  assert.notEqual(own.token, support.token); assert.notEqual(own.value.generation, support.value.generation);
  assert.notEqual(own.value.csrfToken, support.value.csrfToken);
  await assert.rejects(f.auth.session(serverRequest(support)), error => error.code === 'platform_session_required');
  await assert.rejects(f.auth.resolveTenantSelector(serverRequest(support)), error => error.code === 'platform_tenant_selector_invalid');
  await assert.rejects(f.auth.resolveContext(serverRequest(own)), error => error.code === 'platform_company_required');
  assert.equal(await f.auth.withPlatformAdminTransaction(serverRequest(own), () => true, { purpose: 'communications' }), true);
  const state = await f.repository.read(state => state);
  const session = state.sessions.find(item => item.generation === own.value.generation);
  assert.equal(session.tenantTokenHash, undefined);
  assert.equal(state.audit.at(-1).action, 'platform.administration_opened');
  assert.equal(state.audit.at(-1).previousOrganisationId, created.company.id);
  assert.equal(state.audit.at(-1).previousEffectiveUserId, created.user.id);
}));

test('returning to administration requires the real administrator, current generation and CSRF', () => fixture(async f => {
  const initial = await f.login();
  await assert.rejects(f.auth.openAdministration(serverRequest(initial, 'POST')), error => error.code === 'platform_password_change_required');
  const admin = await f.auth.changePassword({ newPassword: changedPassword }, serverRequest(initial, 'POST'));
  await assert.rejects(f.auth.openAdministration(serverRequest(admin, 'POST', { 'x-platform-csrf': '' })), error => error.code === 'platform_csrf_required');
  await assert.rejects(f.auth.openAdministration(serverRequest(admin, 'POST', { 'x-platform-generation': 'stale' })), error => error.code === 'platform_context_changed');
  const created = await f.auth.createCompany({ requestId: randomUUID(), name: 'Pilotbolaget', organisationNumber: '5593593626',
    vdName: 'VD', vdEmail: 'vd@example.test' }, serverRequest(admin, 'POST'));
  const owner = await f.login(created.temporaryCredentials.username, created.temporaryCredentials.password);
  const ownerActive = await f.auth.changePassword({ newPassword: 'Owner-New-Private-Password-2026!' }, serverRequest(owner, 'POST'));
  await assert.rejects(f.auth.openAdministration(serverRequest(ownerActive, 'POST', { 'x-demo-actor': 'platform-admin', 'x-demo-user': '__platform-admin' })),
    error => error.code === 'platform_admin_required');
  assert.equal((await f.auth.session(serverRequest(ownerActive))).company.id, created.company.id);
  const support = await f.auth.switchCompany({ organisationId: created.company.id }, serverRequest(admin, 'POST'));
  await assert.rejects(f.auth.withPlatformAdminTransaction(serverRequest(support), () => true, { purpose: 'communications' }), error => error.code === 'platform_communications_forbidden');
  await f.repository.transact(state => { state.users.find(user => user.id === support.value.actor.id).active = false; });
  await assert.rejects(f.auth.openAdministration(serverRequest(support, 'POST')), error => error.code === 'platform_session_required');
}));

test('an inactive support tenant or tenant user cannot trap an active platform administrator', () => fixture(async f => {
  const admin = await f.activate();
  const created = await f.auth.createCompany({ requestId: randomUUID(), name: 'Pilotbolaget', organisationNumber: '5593593626',
    vdName: 'VD', vdEmail: 'vd@example.test' }, serverRequest(admin, 'POST'));
  const support = await f.auth.switchCompany({ organisationId: created.company.id, effectiveUserId: created.user.id }, serverRequest(admin, 'POST'));
  await f.repository.transact(state => { state.companies.find(company => company.id === created.company.id).status = 'inactive'; });
  f.companyStates.get(created.company.id).pricing.users.find(user => user.id === created.user.id).active = false;
  const own = await f.auth.openAdministration(serverRequest(support, 'POST'));
  assert.equal(own.value.isSupportSession, false); assert.equal(own.value.company, undefined);
  assert.equal(own.value.user.id, '__platform-admin');
}));

test('legacy administration returns to its dedicated principal without impersonating the staff admin account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-legacy-admin-return-'));
  const repository = await createPlatformStorage({ env: { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') } });
  try {
    const auth = createPlatformAuth({ repository,
      bootstrapLegacy: async () => ({ userId: 'legacy-staff-admin', username: 'admin', name: 'Systemadmin', active: true,
        password: await platformPasswordHash(changedPassword) }),
      resolveCompanyUser: async (_company, id) => ['__platform-admin', 'staff'].includes(id)
        ? { id, name: id, level: id === '__platform-admin' ? 'Systemadmin' : 'VD', active: true, permissions: [] } : undefined,
    });
    const admin = await auth.login({ username: 'admin', password: changedPassword }, serverRequest());
    const companyId = randomUUID();
    await repository.transact(state => { state.companies.push({ id: companyId, name: 'Annat bolag', status: 'active' }); });
    const support = await auth.switchCompany({ organisationId: companyId, effectiveUserId: 'staff' }, serverRequest(admin, 'POST'));
    const own = await auth.openAdministration(serverRequest(support, 'POST'));
    assert.equal(own.value.company.id, 'jeroc-demo'); assert.equal(own.value.isSupportSession, false);
    assert.equal(own.value.user.id, '__platform-admin'); assert.equal(own.value.actualUser.id, '__platform-admin');
    assert.ok(own.tenantToken); assert.notEqual(own.tenantToken, support.tenantToken);
    assert.equal(await auth.withPlatformAdminTransaction(serverRequest(own), () => true, { purpose: 'communications' }), true);
    await assert.rejects(auth.session(serverRequest(support)), error => error.code === 'platform_session_required');
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

test('pilot gateway starts without business services and never falls back to the JEROC demo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-pilot-gateway-'));
  const storageEnv = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  const env = { ...storageEnv, SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot',
    DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/pilot', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: bootstrapPassword,
    APP_URL: 'https://app.scrapplanner.com', MOBILE_URL: 'https://mobile.scrapplanner.com', JEROC_DEMO_AUTO_SESSION: 'false', EXPO_GO_ENABLED: 'false' };
  let gateway, server, starts = 0;
  try {
    const makeServices = async () => { starts++; throw new Error('No company may be auto-created'); };
    // Inject every control-plane store: this test proves that no business
    // service is opened, not connectivity to the synthetic profile URL.
    gateway = await createTenantGateway({ env,
      platformRepository: await createPlatformStorage({ env: storageEnv }),
      platformUsageStorage: await createPlatformUsageStorage({ env: storageEnv }), makeServices });
    server = createServer((req, res) => { void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const demo = await fetch(`${base}/api/employee/demo-config`, { headers: { 'x-client-company': 'jeroc-demo', 'x-demo-actor': 'admin' } });
    assert.equal(demo.status, 200); assert.deepEqual(await demo.json(), { enabled: false, accounts: { niklas: false, admin: false } });
    for (const path of ['/api/application/mobile', '/api/platform/tenant-context']) {
      const response = await fetch(`${base}${path}`, { headers: { 'x-client-company': 'jeroc-demo', 'x-demo-actor': 'admin' } });
      assert.equal(response.status, 409, path); assert.equal((await response.json()).code, 'platform_company_required');
    }
    const voice = await fetch(`${base}/api/public/voice-test`); assert.equal(voice.status, 404);
    const legacy = await fetch(`${base}/api/platform/select-tenant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organisationId: 'jeroc-demo' }) });
    assert.equal(legacy.status, 404);
    const registry = await gateway.repository.read(state => state);
    assert.deepEqual(registry.companies, []); assert.deepEqual(registry.memberships, []); assert.equal(registry.users.length, 1);
    await gateway.runWorkers('processQueuedExports'); await gateway.runWorkers('processQueuedPayments');
    assert.equal(starts, 0);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true });
  }
});
