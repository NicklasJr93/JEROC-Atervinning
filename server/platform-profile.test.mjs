import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformPasswordReset } from './platform-password-reset.mjs';

const PASSWORD = 'Own-Profile-Private-Password-2026!';
const OTHER_PASSWORD = 'Changed-Profile-Private-Password-2026!';
const failure = code => error => error.code === code;
const req = (account, method = 'POST', headers = {}) => ({ method, socket: { remoteAddress: '127.0.0.1' }, headers: {
  ...(account && { cookie: `jeroc_platform=${account.token}; jeroc_tenant=${account.tenantToken}`,
    'x-platform-csrf': account.value.csrfToken, 'x-platform-generation': account.value.generation,
    ...(account.value.organisationId && { 'x-platform-organisation-id': account.value.organisationId }) }), ...headers,
} });
const input = (email = 'new-profile@example.test', expectedVersion = 0) => ({ email, expectedVersion, currentPassword: PASSWORD });

async function fixture(run, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'platform-profile-'));
  const env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  let repository = await createPlatformStorage({ env }), auth, time = new Date('2026-10-20T12:00:00Z');
  const hash = await platformPasswordHash(PASSWORD), callbacks = {
    bootstrapPlatform: async () => ({ id: extra.adminId ?? 'platform-admin', username: 'admin', name: 'Systemadmin',
      email: extra.importedEmail ?? '', password: hash, active: true }),
    resolveCompanyUser: async (_companyId, id) => ({ id, name: id, level: id === '__platform-admin' ? 'Systemadmin' : 'VD', active: true, permissions: [] }),
    companyUsers: async () => [], now: () => time,
  };
  let options = { platformAdminEmail: extra.platformAdminEmail, initialAdminProfile: extra.initialAdminProfile };
  const open = () => { auth = createPlatformAuth({ repository, ...callbacks, ...options }); };
  open(); await auth.initialize();
  await repository.transact(state => {
    state.users[0].mustChangePassword = extra.mustChangePassword ?? false;
    state.companies.push({ id: 'company-a', name: 'Company A', status: 'active', storageSchema: 'company_a', ownerUserId: 'owner-a' });
    state.users.push({ id: 'owner-a', businessId: 'owner-a', username: 'owner-a@example.test', email: 'owner-contact@example.test',
      name: 'Owner A', active: true, mustChangePassword: false, platformAdmin: false, password: structuredClone(hash) });
    state.memberships.push({ userId: 'owner-a', organisationId: 'company-a', businessUserId: 'owner-a', active: true });
  });
  const login = (username = 'admin', password = PASSWORD) => auth.login({ username, password }, req());
  try {
    await run({ get auth() { return auth; }, get repository() { return repository; }, login, env,
      advance: delta => { time = new Date(Number(time) + delta); },
      reopen: async changes => {
        options = { ...options, ...changes };
        await repository.close(); repository = await createPlatformStorage({ env }); open(); await auth.initialize();
      },
    });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('own profile returns only the actual actor and saves recovery email without changing username, password or permissions', () => fixture(async f => {
  const admin = await f.login();
  assert.equal(admin.value.actor.email, undefined);
  assert.deepEqual(await f.auth.profile(req(admin, 'GET')), { id: 'platform-admin', name: 'Systemadmin', username: 'admin', email: '', version: 0 });
  const before = await f.repository.read(state => structuredClone(state.users[0]));
  const saved = await f.auth.updateProfile(input('  NEW-PROFILE@example.test  '), req(admin));
  assert.deepEqual(saved, { id: 'platform-admin', name: 'Systemadmin', username: 'admin', email: 'new-profile@example.test', version: 1 });
  const after = await f.repository.read(state => state.users[0]);
  assert.deepEqual(after.password, before.password); assert.equal(after.username, before.username); assert.equal(after.platformAdmin, true);
  assert.equal(after.profileEmailManaged, true);
  assert.equal((await f.auth.session(req(admin, 'GET'))).authenticated, true);
  const audits = await f.repository.read(state => JSON.stringify(state.audit));
  assert.ok(audits.includes('platform.profile_email_changed'));
  assert.ok(!audits.includes('new-profile@example.test')); assert.ok(!audits.includes(PASSWORD));
}));

test('support impersonation edits systemadmin profile, never the selected company owner', () => fixture(async f => {
  const admin = await f.login();
  const support = await f.auth.switchCompany({ organisationId: 'company-a', effectiveUserId: 'owner-a' }, req(admin));
  assert.equal(support.value.isSupportSession, true); assert.equal(support.value.user.id, 'owner-a');
  assert.equal((await f.auth.profile(req(support, 'GET'))).id, 'platform-admin');
  await f.auth.updateProfile(input(), req(support));
  assert.equal(await f.repository.read(state => state.users.find(user => user.id === 'owner-a').email), 'owner-contact@example.test');
  const owner = await f.login('owner-a@example.test');
  assert.equal((await f.auth.profile(req(owner, 'GET'))).id, 'owner-a');
  await f.auth.updateProfile(input('own-owner@example.test'), req(owner));
  assert.equal(await f.repository.read(state => state.users[0].email), 'new-profile@example.test');
  assert.equal((await f.auth.profile(req(owner, 'GET'))).username, 'owner-a@example.test');
}));

test('profile reads and writes require real session, current generation and CSRF; temporary password cannot update it', () => fixture(async f => {
  await assert.rejects(f.auth.profile(req()), failure('platform_session_required'));
  await assert.rejects(f.auth.updateProfile(input(), req()), failure('platform_session_required'));
  const admin = await f.login();
  await assert.rejects(f.auth.profile(req(admin, 'GET', { 'x-platform-generation': 'stale' })), failure('platform_context_changed'));
  await assert.rejects(f.auth.updateProfile(input(), req(admin, 'POST', { 'x-platform-csrf': '' })), failure('platform_csrf_required'));
  await assert.rejects(f.auth.updateProfile(input(), req(admin, 'POST', { 'x-platform-generation': 'stale' })), failure('platform_context_changed'));
  await f.repository.transact(state => { state.users[0].mustChangePassword = true; });
  await assert.rejects(f.auth.updateProfile(input(), req(admin)), failure('platform_password_change_required'));
}));

test('wrong current password and strict payload validation cannot change a profile or choose a different actor', () => fixture(async f => {
  const admin = await f.login();
  await assert.rejects(f.auth.updateProfile({ ...input(), currentPassword: 'Wrong-Private-Password' }, req(admin)), failure('platform_password_mismatch'));
  for (const invalid of [null, [], {}, { ...input(), userId: 'owner-a' }, { ...input(), name: 'Injected name' },
    { ...input(), email: 'a@example.test,b@example.test' }, { ...input(), email: 'a@example.test\r\nBcc:b@example.test' },
    { ...input(), email: '' }, { ...input(), email: 'x'.repeat(255) }, { ...input(), expectedVersion: -1 },
    { ...input(), expectedVersion: 0.5 }, { ...input(), currentPassword: 'x'.repeat(201) }])
    await assert.rejects(f.auth.updateProfile(invalid, req(admin)), failure('platform_invalid'));
  assert.equal((await f.auth.profile(req(admin, 'GET'))).version, 0);
  assert.equal((await f.auth.profile(req(admin, 'GET'))).email, '');
}));

test('version CAS permits one concurrent email update and keeps the winner across restart', () => fixture(async f => {
  const first = await f.login(), second = await f.login();
  const results = await Promise.allSettled([
    f.auth.updateProfile(input('first@example.test'), req(first)), f.auth.updateProfile(input('second@example.test'), req(second)),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.find(result => result.status === 'rejected'); assert.equal(loser.reason.code, 'platform_profile_conflict');
  const winner = results.find(result => result.status === 'fulfilled').value;
  await f.reopen({ platformAdminEmail: 'old-environment@example.test' });
  const logged = await f.login(); assert.deepEqual(await f.auth.profile(req(logged, 'GET')), winner);
  await assert.rejects(f.auth.updateProfile(input('stale@example.test'), req(logged)), failure('platform_profile_conflict'));
}));

for (const changed of ['password', 'session']) test(`a ${changed} change during current-password verification cannot save stale profile data`, () => fixture(async f => {
  const admin = await f.login(), transact = f.repository.transact.bind(f.repository);
  const replacement = await platformPasswordHash(OTHER_PASSWORD);
  let changedOnce = false;
  f.repository.transact = async operation => {
    const result = await transact(operation);
    if (!changedOnce) {
      changedOnce = true;
      await transact(state => {
        if (changed === 'password') state.users[0].password = replacement;
        else state.sessions = [];
      });
    }
    return result;
  };
  await assert.rejects(f.auth.updateProfile(input(), req(admin)), failure(changed === 'password' ? 'platform_context_changed' : 'platform_session_required'));
  assert.equal(await f.repository.read(state => state.users[0].email), '');
  assert.equal(await f.repository.read(state => state.users[0].profileVersion ?? 0), 0);
}));

test('registered email edit invalidates old recovery links and new requests use the saved address', () => fixture(async f => {
  const admin = await f.login(), sent = [];
  await f.auth.updateProfile(input('old-recovery@example.test'), req(admin));
  const recovery = createPlatformPasswordReset({ auth: f.auth, repository: f.repository, env: f.env, minResponseMs: 0,
    email: { configured: true, sendPasswordReset: async value => { sent.push(value); } } });
  await recovery.request({ email: 'old-recovery@example.test' }, req());
  assert.equal(sent.length, 1);
  const token = new URLSearchParams(new URL(sent[0].resetUrl).hash.split('?')[1]).get('token');
  await f.auth.updateProfile(input('new-recovery@example.test', 1), req(admin));
  await assert.rejects(recovery.confirm({ token, newPassword: OTHER_PASSWORD, confirmPassword: OTHER_PASSWORD }, req()), failure('password_reset_invalid'));
  await recovery.request({ email: 'new-recovery@example.test' }, req()); assert.equal(sent.at(-1).to, 'new-recovery@example.test');
  assert.equal((await f.auth.profile(req(admin, 'GET'))).version, 2);
}));

test('current password checks are durably throttled even when account and source headers change', () => fixture(async f => {
  const admin = await f.login();
  for (let i = 0; i < 6; i++)
    await assert.rejects(f.auth.updateProfile({ ...input(), currentPassword: 'Wrong-Private-Password' }, req(admin, 'POST', { 'x-forwarded-for': `fake-${i}` })), failure('platform_password_mismatch'));
  await f.reopen();
  await assert.rejects(f.auth.updateProfile(input(), req(admin)), failure('platform_profile_rate_limit'));
  f.advance(15 * 60_000 + 1);
  assert.equal((await f.auth.updateProfile(input(), req(admin))).version, 1);
}));

test('one-time initial profile seed applies only to the target blank admin and never overwrites a saved or pre-existing address', () => fixture(async f => {
  const seed = { id: 'platform-admin', email: 'seeded@example.test', seedId: 'test-seed-v1' };
  await f.reopen({ initialAdminProfile: seed });
  let admin = await f.login(); assert.equal((await f.auth.profile(req(admin, 'GET'))).email, 'seeded@example.test');
  assert.equal((await f.repository.read(state => state.initialProfileSeeds)).length, 1);
  await f.auth.updateProfile(input('saved@example.test'), req(admin));
  await f.reopen({ initialAdminProfile: { ...seed, email: 'different@example.test' }, platformAdminEmail: 'environment@example.test' });
  admin = await f.login(); assert.equal((await f.auth.profile(req(admin, 'GET'))).email, 'saved@example.test');
  assert.equal((await f.repository.read(state => state.initialProfileSeeds)).length, 1);
  const audits = await f.repository.read(state => JSON.stringify(state.audit)); assert.ok(!audits.includes('seeded@example.test'));
}));

test('initial profile seed and environment fallback leave unrelated administrators and existing registered addresses intact', async () => {
  await fixture(async f => {
    await f.reopen({ initialAdminProfile: { id: 'different-admin', email: 'wrong@example.test', seedId: 'other-target' } });
    assert.equal((await f.auth.profile(req(await f.login(), 'GET'))).email, '');
    assert.equal(await f.repository.read(state => state.initialProfileSeeds?.length ?? 0), 0);
    await f.reopen({ initialAdminProfile: undefined, platformAdminEmail: 'fallback@example.test' });
    assert.equal((await f.auth.profile(req(await f.login(), 'GET'))).email, 'fallback@example.test');
    await f.reopen({ platformAdminEmail: 'new-env@example.test' });
    assert.equal((await f.auth.profile(req(await f.login(), 'GET'))).email, 'fallback@example.test');
  });
  await fixture(async f => {
    await f.reopen({ initialAdminProfile: { id: 'platform-admin', email: 'seed@example.test', seedId: 'existing-address' }, platformAdminEmail: 'env@example.test' });
    assert.equal((await f.auth.profile(req(await f.login(), 'GET'))).email, 'registered@example.test');
    assert.equal((await f.repository.read(state => state.initialProfileSeeds))[0].applied, false);
  }, { importedEmail: 'registered@example.test' });
});
