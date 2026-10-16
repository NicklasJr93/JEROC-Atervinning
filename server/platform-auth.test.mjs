import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash, getPlatformContext } from './platform-auth.mjs';
import { createPlatformApi } from './platform-api.mjs';

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-platform-'));
  let env = { JEROC_PLATFORM_DB_PATH: join(directory, 'registry.sqlite') }, pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `platform_test_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env = { DATABASE_URL: url.toString() };
  }
  let repository = await createPlatformStorage({ env });
  const administratorPassword = options.demo ? 'JerocDemo2026!' : 'Legacy-Administrator-2026!';
  const legacyHash = await platformPasswordHash(administratorPassword);
  const adminUser = { id: 'admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [], active: true };
  const usersByCompany = new Map([['jeroc-demo', [adminUser, { id: 'lars', name: 'Lars', level: 'VD', permissions: [], active: true },
    { id: '__platform-admin', name: 'Platform support', level: 'Systemadmin', permissions: [], active: true }]]]);
  const employeeAccounts = new Map(), provisions = [], passwordChanges = [];
  let failProvision = false, failSync = false;
  const callbacks = {
    bootstrapLegacy: async () => ({ userId: 'admin', username: 'admin', name: 'Systemadmin', password: legacyHash, active: true, privateBootstrap: options.privateBootstrap === true }),
    legacyCompany: { name: 'JEROC', organisationNumber: '5591237895', storageSchema: schema ?? 'public' },
    provisionCompany: async input => {
      provisions.push(structuredClone(input)); if (failProvision) throw new Error('private connection failure');
      if (!usersByCompany.has(input.company.id)) usersByCompany.set(input.company.id, [
        { id: input.user.id, name: input.user.name, level: 'VD', permissions: [], active: true },
        { id: '__platform-admin', name: 'Platform support', level: 'Systemadmin', permissions: [], active: true },
      ]);
      employeeAccounts.set(input.user.id, { active: false, password: input.user.password });
    },
    companyUsers: async id => usersByCompany.get(id) ?? [],
    resolveCompanyUser: async (id, userId) => usersByCompany.get(id)?.find(user => user.id === userId),
    onPasswordChanged: async input => { passwordChanges.push(input); if (failSync) throw new Error('private credential synchronization failure'); employeeAccounts.set(input.user.id, { active: input.user.mustChangePassword !== true, password: input.password }); },
  };
  let now = new Date('2026-10-12T10:00:00Z');
  let auth = createPlatformAuth({ repository, ...callbacks, now: () => now });
  let api = createPlatformApi({ auth, env });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, input, account, extraHeaders = {}) => {
    const cookies = account?.cookies ?? new Map();
    const response = await fetch(`${base}/api/platform/${path}`, { method: input === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', origin: base, ...(cookies.size && { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }),
      ...(account?.value?.csrfToken && { 'x-platform-csrf': account.value.csrfToken, 'x-platform-generation': account.value.generation }), ...extraHeaders,
    }, ...(input !== undefined && { body: JSON.stringify(input) }) });
    const nextCookies = new Map(cookies);
    for (const value of response.headers.getSetCookie()) { const item = value.split(';')[0], equal = item.indexOf('='); nextCookies.set(item.slice(0, equal), item.slice(equal + 1)); }
    return { status: response.status, value: await response.json(), cookies: nextCookies, headers: response.headers };
  };
  const login = async (user = 'admin', password = administratorPassword) => { const result = await request('login', { username: user, password }); assert.equal(result.status, 200, result.value.error); return result; };
  const input = extra => ({ requestId: randomUUID(), name: 'Company B', organisationNumber: '559359-3626', vdName: 'VD B', vdEmail: 'vd-b@example.invalid', ...extra });
  const serverReq = (account, overrides = {}) => ({ method: 'GET', headers: { cookie: [...account.cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'x-platform-generation': account.value.generation, ...overrides }, socket: { remoteAddress: '127.0.0.1' } });
  try { await run({ request, login, input, auth: () => auth, repository: () => repository, legacyHash, usersByCompany, employeeAccounts, provisions, passwordChanges, serverReq,
    failProvision: value => { failProvision = value; }, failSync: value => { failSync = value; }, clock: value => { now = new Date(value); },
    reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env }); auth = createPlatformAuth({ repository, ...callbacks, now: () => now }); api = createPlatformApi({ auth, env }); },
  }); }
  finally { await new Promise(resolve => server.close(resolve)); await repository.close(); if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); } await rm(directory, { recursive: true, force: true }); }
}

test('bootstrap imports the existing hash without password reset; restart retains session and registry', async () => fixture(async ({ request, login, repository, legacyHash, reopen, auth, serverReq }) => {
  const visitor = await request('session'); assert.deepEqual(visitor.value, { enabled: true, authenticated: false });
  const administrator = await login(); assert.equal(administrator.value.actor.platformAdmin, true); assert.equal(administrator.value.actualUser.id, '__platform-admin');
  assert.equal(administrator.value.mustChangePassword, false);
  await repository().read(state => { assert.deepEqual(state.users[0].password, legacyHash); assert.ok(!JSON.stringify(state).includes(administrator.cookies.get('jeroc_platform'))); });
  await reopen(); const current = await request('session', undefined, administrator); assert.equal(current.status, 200); assert.equal(current.value.actor.id, 'admin');
  const req = serverReq(current, { 'x-demo-actor': 'lars', 'x-demo-user': 'lars' }); const context = await auth().resolveContext(req);
  assert.equal(context.actor.businessId, '__platform-admin'); assert.equal(context.user.id, '__platform-admin'); assert.equal(getPlatformContext(req), context);
  assert.ok(administrator.headers.getSetCookie().every(value => value.includes('HttpOnly; SameSite=')));
  assert.ok(administrator.headers.getSetCookie().find(value => value.startsWith('jeroc_platform=')).includes('SameSite=Lax'));
  assert.ok(administrator.headers.getSetCookie().find(value => value.startsWith('jeroc_tenant=')).includes('SameSite=Strict'));
}));

test('a private initial bootstrap password must be changed before any business use', async () => fixture(async ({ login, request, auth, serverReq, passwordChanges }) => {
  const administrator = await login(); assert.equal(administrator.value.mustChangePassword, true);
  assert.equal((await request('companies', undefined, administrator)).status, 423);
  await assert.rejects(auth().resolveContext(serverReq(administrator)), error => error.code === 'platform_password_change_required');
  const changed = await request('change-password', { currentPassword: 'Legacy-Administrator-2026!', newPassword: 'My-New-Private-Password-2026!' }, administrator);
  assert.equal(changed.status, 200, changed.value.error); assert.equal(changed.value.mustChangePassword, false); assert.notEqual(changed.value.csrfToken, administrator.value.csrfToken);
  assert.equal((await request('session', undefined, administrator)).status, 401); assert.equal(passwordChanges.length, 1);
}, { privateBootstrap: true }));

test('a public fixture password cannot bootstrap platform authority or mint any administrator account', async () => fixture(async ({ request, repository }) => {
  const status = await request('session'); assert.equal(status.status, 503); assert.equal(status.value.code, 'platform_bootstrap_required');
  const login = await request('login', { username: 'admin', password: 'JerocDemo2026!' }); assert.equal(login.status, 503);
  await repository().read(state => { assert.deepEqual(state.users, []); assert.deepEqual(state.sessions, []); });
}, { demo: true }));

test('company provisioning uses only server IDs and hashes; owner is isolated and must change password first', async () => fixture(async ({ request, login, input, provisions, repository, employeeAccounts, auth, serverReq }) => {
  const administrator = await login(), created = await request('companies', input(), administrator);
  assert.equal(created.status, 200, created.value.error); assert.equal(created.value.company.status, 'active');
  const ownerId = created.value.user.id, credentials = created.value.temporaryCredentials;
  assert.equal(provisions.length, 1); assert.match(provisions[0].company.storageSchema, /^jeroc_t_[a-z0-9]{32}$/); assert.equal(provisions[0].user.mustChangePassword, true);
  assert.equal(employeeAccounts.get(ownerId).active, false);
  await repository().read(state => { assert.ok(!JSON.stringify(state).includes(credentials.password)); assert.equal(state.companies.length, 2); });
  const owner = await login(credentials.username, credentials.password); assert.equal(owner.value.company.id, created.value.company.id); assert.equal(owner.value.mustChangePassword, true);
  assert.equal((await request('companies', undefined, owner)).status, 423); assert.equal((await request('switch', { organisationId: 'jeroc-demo' }, owner)).status, 423);
  await assert.rejects(auth().resolveTenantSelector(serverReq(owner)), error => error.code === 'platform_tenant_selector_invalid');
  const changed = await request('change-password', { currentPassword: credentials.password, newPassword: 'Owner-New-Password-2026!' }, owner);
  assert.equal(changed.status, 200, changed.value.error); assert.equal(changed.value.mustChangePassword, false); assert.equal(employeeAccounts.get(ownerId).active, true);
  assert.equal((await request('switch', { organisationId: 'jeroc-demo' }, changed)).status, 403);
  assert.equal((await request('companies', input({ organisationNumber: '5592345671', vdEmail: 'other@example.invalid' }), changed)).status, 403);
  const context = await auth().resolveContext(serverReq(changed, { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' }));
  assert.equal(context.organisationId, created.value.company.id); assert.equal(context.actor.businessId, ownerId); assert.equal(context.user.level, 'VD');
  assert.equal((await request('companies', undefined, changed)).value.companies.length, 1);
}));

test('support impersonation is admin-only, audited, rotates both cookies and fails stale requests closed', async () => fixture(async ({ request, login, input, auth, serverReq, repository }) => {
  const administrator = await login(), created = await request('companies', input(), administrator), company = created.value.company;
  const switchResult = await request('switch', { organisationId: company.id, effectiveUserId: created.value.user.id }, administrator);
  assert.equal(switchResult.status, 200, switchResult.value.error); assert.equal(switchResult.value.isSupportSession, true);
  assert.equal(switchResult.value.actualUser.id, '__platform-admin'); assert.equal(switchResult.value.user.id, created.value.user.id);
  assert.notEqual(switchResult.value.generation, administrator.value.generation); assert.notEqual(switchResult.cookies.get('jeroc_tenant'), administrator.cookies.get('jeroc_tenant'));
  assert.equal((await request('session', undefined, administrator)).status, 401);
  await assert.rejects(auth().resolveContext(serverReq(switchResult, { 'x-platform-generation': administrator.value.generation })), error => error.code === 'platform_context_changed');
  const selector = await auth().resolveTenantSelector(serverReq(switchResult)); assert.equal(selector.organisationId, company.id);
  const users = await request(`companies/${company.id}/users`, undefined, switchResult); assert.equal(users.status, 200); assert.equal(users.value.users.length, 1); assert.ok(!users.value.users.some(user => user.id === '__platform-admin'));
  await repository().read(state => { const event = state.audit.find(event => event.action === 'platform.support_context_changed'); assert.equal(event.actorId, 'admin'); assert.equal(event.effectiveUserId, created.value.user.id); assert.equal(event.organisationId, company.id); });
}));

test('origin, CSRF, context generation, strict input and guessed tenant selectors are rejected', async () => fixture(async ({ login, request, input, auth, serverReq }) => {
  const administrator = await login();
  assert.equal((await request('companies', input(), administrator, { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await request('companies', input(), administrator, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await request('companies', input(), administrator, { 'x-platform-generation': 'wrong' })).status, 409);
  assert.equal((await request('companies', { ...input(), storageSchema: 'public' }, administrator)).status, 422);
  assert.equal((await request('switch', { organisationId: 'jeroc-demo', actorId: 'lars' }, administrator)).status, 422);
  await assert.rejects(auth().resolveTenantSelector({ ...serverReq(administrator), headers: { cookie: 'jeroc_tenant=jeroc-demo' } }), error => error.code === 'platform_tenant_selector_invalid');
}));

test('retry and concurrent create requests never create another company or reveal temporary credentials twice', async () => fixture(async ({ login, request, input, repository, provisions }) => {
  const administrator = await login(), payload = input();
  const results = await Promise.all([request('companies', payload, administrator), request('companies', payload, administrator)]);
  assert.equal(results.filter(result => result.status === 200 && result.value.credentialsRevealed).length, 1);
  assert.ok(results.every(result => result.status === 200 || result.status === 409));
  const retry = await request('companies', payload, administrator); assert.equal(retry.status, 200); assert.equal(retry.value.credentialsRevealed, false); assert.equal(retry.value.temporaryCredentials, undefined);
  assert.equal((await request('companies', { ...payload, name: 'Different' }, administrator)).status, 409);
  assert.equal(provisions.length, 1); await repository().read(state => { assert.equal(state.companies.length, 2); assert.equal(state.users.length, 2); assert.equal(state.creations.length, 1); });
}));

test('failed provisioning stays inaccessible, has a safe error and retries its original reserved identities', async () => fixture(async ({ login, request, input, repository, provisions, failProvision }) => {
  const administrator = await login(), payload = input(); failProvision(true);
  const failed = await request('companies', payload, administrator); assert.equal(failed.status, 503); assert.ok(!JSON.stringify(failed.value).includes('private'));
  const reserved = await repository().read(state => state.companies.find(company => company.id !== 'jeroc-demo')); assert.equal(reserved.status, 'failed');
  assert.equal((await request('switch', { organisationId: reserved.id }, administrator)).status, 409);
  failProvision(false); const retry = await request('companies', payload, administrator); assert.equal(retry.status, 200, retry.value.error); assert.equal(retry.value.company.id, reserved.id); assert.equal(retry.value.credentialsRevealed, true);
  assert.equal(provisions[0].company.storageSchema, provisions[1].company.storageSchema); assert.equal(provisions[0].user.id, provisions[1].user.id); assert.notDeepEqual(provisions[0].user.password, provisions[1].user.password);
  assert.equal((await login(retry.value.temporaryCredentials.username, retry.value.temporaryCredentials.password)).value.mustChangePassword, true);
}));

test('persistent account rate limiting survives restart and expires without leaking credentials', async () => fixture(async ({ request, reopen, clock }) => {
  for (let index = 0; index < 10; index += 1) assert.equal((await request('login', { username: 'admin', password: 'wrong' })).status, 401);
  await reopen(); assert.equal((await request('login', { username: 'admin', password: 'wrong' })).status, 429);
  clock('2026-10-12T10:16:00Z'); assert.equal((await request('login', { username: 'admin', password: 'Legacy-Administrator-2026!' })).status, 200);
}));

test('current membership and business-account revocations take effect without trusting a cached login', async () => fixture(async ({ login, auth, serverReq, usersByCompany, repository }) => {
  const administrator = await login(), support = usersByCompany.get('jeroc-demo').find(user => user.id === '__platform-admin'); support.active = false;
  await assert.rejects(auth().resolveContext(serverReq(administrator)), error => error.code === 'platform_account_inactive');
  support.active = true; await repository().transact(state => { state.users[0].active = false; });
  await assert.rejects(auth().resolveTenantSelector(serverReq(administrator)), error => error.code === 'platform_tenant_selector_invalid');
}));

test('failed password synchronization retains a closed account and can be retried through its authenticated change-password gate', async () => fixture(async ({ login, request, failSync, auth, serverReq }) => {
  const administrator = await login(); failSync(true);
  const failed = await request('change-password', { currentPassword: 'Legacy-Administrator-2026!', newPassword: 'Changed-Private-Password-2026!' }, administrator);
  assert.equal(failed.status, 503); await assert.rejects(auth().resolveContext(serverReq(administrator)), error => error.code === 'platform_password_change_required');
  failSync(false); const retry = await request('change-password', { currentPassword: 'Changed-Private-Password-2026!', newPassword: 'Second-Private-Password-2026!' }, administrator);
  assert.equal(retry.status, 200, retry.value.error); assert.equal(retry.value.mustChangePassword, false);
}));

test('public opaque selectors allow only company routing and grant no office login, membership or business-data access', async () => fixture(async ({ login, request, input, auth, serverReq, clock }) => {
  const administrator = await login(), created = await request('companies', input(), administrator);
  const selected = await request('select-tenant', { organisationId: created.value.company.id });
  assert.equal(selected.status, 200, selected.value.error); assert.equal(selected.value.authenticated, false);
  assert.equal(selected.value.company.id, created.value.company.id); assert.equal(selected.value.company.storageSchema, undefined);
  const selector = await auth().resolveTenantSelector(serverReq(selected)); assert.equal(selector.organisationId, created.value.company.id); assert.equal(selector.publicSelection, true);
  await assert.rejects(auth().resolveContext(serverReq(selected)), error => error.code === 'platform_session_required');
  assert.equal((await request('companies', undefined, selected)).status, 401);
  assert.equal((await request('select-tenant', { organisationId: created.value.company.id, storageSchema: 'public' })).status, 422);
  assert.equal((await request('select-tenant', { organisationId: randomUUID() })).status, 404);
  clock('2026-10-12T19:00:00Z'); await assert.rejects(auth().resolveTenantSelector(serverReq(selected)), error => error.code === 'platform_tenant_selector_invalid');
}));

test('admin pending-owner credential recovery is idempotent, revokes old temporary sessions and cannot reset an activated owner', async () => fixture(async ({ login, request, input, employeeAccounts }) => {
  const administrator = await login(), created = await request('companies', input(), administrator), companyId = created.value.company.id;
  const oldOwner = await login(created.value.temporaryCredentials.username, created.value.temporaryCredentials.password);
  const directory = await request('companies', undefined, administrator); assert.equal(directory.value.companies.find(company => company.id === companyId).ownerPasswordChangePending, true);
  const resetId = randomUUID(), reset = await request(`companies/${companyId}/reset-initial-password`, { requestId: resetId }, administrator);
  assert.equal(reset.status, 200, reset.value.error); assert.equal(reset.value.credentialsRevealed, true); assert.notEqual(reset.value.temporaryCredentials.password, created.value.temporaryCredentials.password);
  assert.equal(employeeAccounts.get(created.value.user.id).active, false); assert.equal((await request('session', undefined, oldOwner)).status, 401);
  assert.equal((await request('login', { username: created.value.temporaryCredentials.username, password: created.value.temporaryCredentials.password })).status, 401);
  const replay = await request(`companies/${companyId}/reset-initial-password`, { requestId: resetId }, administrator); assert.equal(replay.status, 200); assert.equal(replay.value.credentialsRevealed, false); assert.equal(replay.value.temporaryCredentials, undefined);
  const owner = await login(reset.value.temporaryCredentials.username, reset.value.temporaryCredentials.password);
  const active = await request('change-password', { newPassword: 'Activated-Owner-Private-Password-2026!' }, owner); assert.equal(active.status, 200, active.value.error);
  assert.equal((await request(`companies/${companyId}/reset-initial-password`, { requestId: randomUUID() }, administrator)).status, 409);
}));

test('switching company without an effective user gives platform admin their own company-scoped permissions', async () => fixture(async ({ login, request, input }) => {
  const administrator = await login(), created = await request('companies', input(), administrator);
  const own = await request('switch', { organisationId: created.value.company.id }, administrator); assert.equal(own.status, 200, own.value.error);
  assert.equal(own.value.user.id, '__platform-admin'); assert.equal(own.value.actualUser.id, '__platform-admin'); assert.equal(own.value.user.level, 'Systemadmin');
  const legacy = await request('switch', { organisationId: 'jeroc-demo' }, own); assert.equal(legacy.status, 200, legacy.value.error); assert.equal(legacy.value.user.id, '__platform-admin');
}));

test('old JEROC own sessions resolve to platform authority without rewriting staff scope or the stored session', async () => fixture(async ({ login, request, auth, serverReq, usersByCompany, repository }) => {
  const administrator = await login(), legacy = usersByCompany.get('jeroc-demo').find(user => user.id === 'admin');
  legacy.siteIds = ['norrtalje']; const staffBefore = structuredClone(legacy);
  await repository().transact(state => {
    const session = state.sessions.find(item => item.userId === 'admin'); session.effectiveUserId = 'admin'; delete session.businessPrincipalVersion;
  });
  const storedBefore = await repository().read(state => structuredClone(state.sessions));
  const fresh = await request('session', undefined, administrator);
  assert.equal(fresh.status, 200); assert.equal(fresh.value.actor.id, 'admin'); assert.equal(fresh.value.actor.platformAdmin, true);
  assert.equal(fresh.value.actualUser.id, '__platform-admin'); assert.equal(fresh.value.user.id, '__platform-admin');
  assert.equal(fresh.value.effectiveUserId, '__platform-admin'); assert.equal(fresh.value.actualUser.siteIds, undefined); assert.equal(fresh.value.user.siteIds, undefined);
  assert.equal(fresh.value.isSupportSession, false);
  const context = await auth().resolveContext(serverReq(fresh));
  assert.equal(context.actualUser.id, '__platform-admin'); assert.equal(context.user.id, '__platform-admin');
  assert.deepEqual(await repository().read(state => state.sessions), storedBefore); assert.deepEqual(legacy, staffBefore);
  const changed = await request('change-password', { currentPassword: 'Legacy-Administrator-2026!', newPassword: 'Resolved-Legacy-Own-Password-2026!' }, fresh);
  assert.equal(changed.status, 200, changed.value.error); assert.equal(changed.value.user.id, '__platform-admin');
  const rotated = await repository().read(state => state.sessions.find(item => item.userId === 'admin'));
  assert.equal(rotated.businessPrincipalVersion, 2); assert.equal(rotated.effectiveUserId, '__platform-admin');
}));

test('new explicit JEROC staff impersonation preserves site limits even for the legacy admin identity', async () => fixture(async ({ login, request, auth, serverReq, usersByCompany, repository }) => {
  const administrator = await login(), legacy = usersByCompany.get('jeroc-demo').find(user => user.id === 'admin');
  legacy.siteIds = ['norrtalje']; const original = structuredClone(legacy);
  const impersonated = await request('switch', { organisationId: 'jeroc-demo', effectiveUserId: 'admin' }, administrator);
  assert.equal(impersonated.status, 200, impersonated.value.error); assert.equal(impersonated.value.actualUser.id, '__platform-admin');
  assert.equal(impersonated.value.user.id, 'admin'); assert.deepEqual(impersonated.value.user.siteIds, ['norrtalje']);
  assert.equal(impersonated.value.effectiveUserId, 'admin'); assert.equal(impersonated.value.isSupportSession, true);
  const context = await auth().resolveContext(serverReq(impersonated));
  assert.equal(context.user.id, 'admin'); assert.deepEqual(context.user.siteIds, ['norrtalje']);
  assert.equal((await repository().read(state => state.sessions.find(item => item.userId === 'admin'))).businessPrincipalVersion, 2);
  const vd = await request('switch', { organisationId: 'jeroc-demo', effectiveUserId: 'lars' }, impersonated);
  assert.equal(vd.status, 200, vd.value.error); assert.equal(vd.value.actualUser.id, '__platform-admin'); assert.equal(vd.value.user.level, 'VD');
  const own = await request('switch', { organisationId: 'jeroc-demo' }, vd);
  assert.equal(own.status, 200, own.value.error); assert.equal(own.value.actualUser.id, '__platform-admin'); assert.equal(own.value.user.id, '__platform-admin');
  assert.equal(own.value.user.siteIds, undefined); assert.deepEqual(legacy, original);
}));
