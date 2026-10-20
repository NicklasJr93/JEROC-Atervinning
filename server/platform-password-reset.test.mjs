import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformPasswordReset } from './platform-password-reset.mjs';

const OLD = 'Original-Password-2026!', NEXT = 'New-Recovered-Password-2026!', AGAIN = 'Another-Recovered-Password!';
const request = ip => ({ method: 'POST', headers: { host: 'attacker.invalid', 'x-forwarded-for': 'forged-client' }, socket: { remoteAddress: ip ?? '127.0.0.1' } });
const token = mail => new URLSearchParams(new URL(mail.resetUrl).hash.split('?')[1]).get('token');
const command = (mail, newPassword = NEXT) => ({ token: token(mail), newPassword, confirmPassword: newPassword });
const failure = code => error => error.code === code;

async function fixture(run, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'password-recovery-')), env = { JEROC_PLATFORM_DB_PATH: join(dir, 'platform.sqlite'), APP_URL: 'https://app.scrapplanner.com' };
  let repository = await createPlatformStorage({ env }), time = new Date('2026-10-20T08:00:00Z'), auth, recovery;
  const oldHash = await platformPasswordHash(OLD), sent = [], changes = [], employee = new Map();
  let failPhase, gate, release, emailFailure = false;
  const callbacks = {
    bootstrapPlatform: async () => ({ id: 'platform-admin', username: 'admin', name: 'Administrator', email: 'admin@example.test', password: oldHash }),
    platformAdminEmail: extra.platformAdminEmail,
    resolveCompanyUser: async (companyId, id) => ({ id, name: id, level: 'VD', active: true, permissions: [] }),
    now: () => time,
    onPasswordChanged: async input => {
      await input.assertCurrent?.(); changes.push(input);
      if (input.phase === failPhase) throw new Error('PRIVATE-SYNC-DETAIL');
      if (gate) await gate;
      for (const id of input.companyIds) employee.set(id, { active: input.phase !== 'revoke', password: input.password });
    },
  };
  const email = { configured: true, sendPasswordReset: async mail => { sent.push(mail); if (emailFailure) throw new Error('PRIVATE-API-KEY'); } };
  const open = () => {
    auth = createPlatformAuth({ repository, ...callbacks });
    recovery = createPlatformPasswordReset({ auth, email, env, now: () => time, minResponseMs: 0 });
  };
  open(); await auth.initialize();
  await repository.transact(state => {
    state.companies.push({ id: 'company-a', name: 'Company A', status: 'active', storageSchema: 'a', ownerUserId: 'owner-a' });
    state.users.push({ id: 'owner-a', businessId: 'owner-a', username: 'owner@example.test', email: 'owner@example.test', name: 'Owner', active: true,
      platformAdmin: false, mustChangePassword: false, password: structuredClone(oldHash) });
    state.memberships.push({ userId: 'owner-a', organisationId: 'company-a', businessUserId: 'owner-a', active: true });
  });
  try {
    await run({ recovery: () => recovery, auth: () => auth, repository: () => repository, sent, changes, employee,
      clock: delta => { time = new Date(Number(time) + delta); }, failSync: phase => { failPhase = phase; }, failEmail: value => { emailFailure = value; },
      blockSync: () => { gate = new Promise(resolve => { release = resolve; }); }, releaseSync: () => { gate = undefined; release?.(); },
      reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env }); open(); await auth.initialize(); },
      disableEmail: () => { email.configured = false; },
    });
  } finally { await repository.close(); await rm(dir, { recursive: true, force: true }); }
}

test('registered recovery sends a trusted one-use link, keeps only hashes and revokes every platform/tenant session', () => fixture(async f => {
  const first = await f.auth().login({ username: 'owner@example.test', password: OLD }, request());
  const second = await f.auth().login({ username: 'owner@example.test', password: OLD }, request());
  const result = await f.recovery().request({ email: ' OWNER@example.test ' }, request());
  assert.deepEqual(result, { ok: true, message: 'Om adressen är kopplad till ett aktivt konto skickar vi en återställningslänk.' });
  assert.equal(f.sent.length, 1); const mail = f.sent[0], link = new URL(mail.resetUrl);
  assert.equal(mail.to, 'owner@example.test'); assert.equal(link.origin, 'https://app.scrapplanner.com'); assert.equal(link.pathname, '/kontor/');
  assert.equal(link.search, ''); assert.match(token(mail), /^[A-Za-z0-9_-]{43}$/); assert.equal(Date.parse(mail.expiresAt) - Date.parse(mail.createdAt), 30 * 60_000);
  const before = await f.repository().read(state => JSON.stringify(state.passwordRecovery));
  assert.ok(!before.includes(token(mail))); assert.ok(!before.includes(mail.to)); assert.ok(!before.includes(OLD)); assert.ok(!before.includes(mail.resetUrl));
  assert.deepEqual(await f.recovery().confirm(command(mail), request()), { ok: true });
  assert.deepEqual(f.changes.map(value => value.phase), ['revoke', 'apply']); assert.equal(f.employee.get('company-a').active, true);
  assert.ok(f.changes.every(value => value.initialPasswordChange === false));
  for (const session of [first, second]) {
    await assert.rejects(f.auth().session({ headers: { cookie: `jeroc_platform=${session.token}` } }), failure('platform_session_required'));
    await assert.rejects(f.auth().resolveTenantSelector({ headers: { cookie: `jeroc_tenant=${session.tenantToken}` } }), failure('platform_tenant_selector_invalid'));
  }
  await assert.rejects(f.auth().login({ username: 'owner@example.test', password: OLD }, request()), failure('platform_invalid_credentials'));
  const logged = await f.auth().login({ username: 'owner@example.test', password: NEXT }, request()); assert.equal(logged.value.mustChangePassword, false);
  await assert.rejects(f.recovery().confirm(command(mail), request()), failure('password_reset_invalid'));
  const after = await f.repository().read(state => JSON.stringify(state));
  for (const raw of [NEXT, token(mail), mail.resetUrl]) assert.ok(!after.includes(raw));
}));

test('unknown, inactive, duplicate and unregistered addresses get identical responses without sending', () => fixture(async f => {
  const expected = await f.recovery().request({ email: 'unknown@example.test' }, request());
  await f.repository().transact(state => {
    state.users.find(value => value.id === 'owner-a').active = false;
    state.users.push({ ...state.users[0], id: 'duplicate-admin' });
  });
  for (const email of ['owner@example.test', 'admin@example.test', 'company-contact@example.test'])
    assert.deepEqual(await f.recovery().request({ email }, request()), expected);
  assert.equal(f.sent.length, 0);
}));

test('optional exact username disambiguates a shared address while requests still share the email rate limit', () => fixture(async f => {
  await f.repository().transact(state => { state.users.find(user => user.id === 'owner-a').email = 'admin@example.test'; });
  const generic = await f.recovery().request({ email: 'admin@example.test' }, request());
  assert.equal(f.sent.length, 0);
  f.clock(61_000);
  assert.deepEqual(await f.recovery().request({ email: 'admin@example.test', username: 'wrong-user' }, request()), generic);
  assert.equal(f.sent.length, 0);
  f.clock(61_000);
  assert.deepEqual(await f.recovery().request({ email: 'admin@example.test', username: ' ADMIN ' }, request()), generic);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.repository().read(state => state.passwordRecovery.requests.at(-1))).userId, 'platform-admin');
  f.clock(61_000);
  assert.deepEqual(await f.recovery().request({ email: 'admin@example.test', username: 'owner@example.test' }, request()), generic);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await f.recovery().confirm(command(f.sent[0]), request()), { ok: true });
  assert.equal((await f.auth().login({ username: 'admin', password: NEXT }, request())).value.actor.platformAdmin, true);
  assert.equal((await f.auth().login({ username: 'owner@example.test', password: OLD }, request())).value.actor.id, 'owner-a');
}));

test('a new request supersedes the old link and the token expires exactly after 30 minutes', () => fixture(async f => {
  await f.recovery().request({ email: 'owner@example.test' }, request()); const old = f.sent[0];
  f.clock(61_000); await f.recovery().request({ email: 'owner@example.test' }, request()); const latest = f.sent[1];
  await assert.rejects(f.recovery().confirm(command(old), request()), failure('password_reset_invalid'));
  f.clock(30 * 60_000); await assert.rejects(f.recovery().confirm(command(latest), request()), failure('password_reset_invalid'));
  assert.equal(f.changes.length, 0);
}));

test('later password, email and membership edits invalidate an issued recovery link', () => fixture(async f => {
  for (const edit of ['password', 'email', 'membership']) {
    await f.repository().transact(state => {
      const user = state.users.find(value => value.id === 'owner-a'); user.password = structuredClone(state.users[0].password); user.email = 'owner@example.test';
      state.memberships[0].active = true;
    });
    await f.recovery().request({ email: 'owner@example.test' }, request()); const mail = f.sent.at(-1);
    const otherHash = await platformPasswordHash(AGAIN);
    await f.repository().transact(state => {
      const user = state.users.find(value => value.id === 'owner-a');
      if (edit === 'password') user.password = otherHash;
      if (edit === 'email') user.email = 'changed@example.test';
      if (edit === 'membership') state.memberships[0].active = false;
    });
    await assert.rejects(f.recovery().confirm(command(mail), request()), failure('password_reset_invalid'));
    f.clock(16 * 60_000);
  }
}));

test('rate reservations are durable, suppress rapid resends and expire without growing an unbounded registry', () => fixture(async f => {
  await f.recovery().request({ email: 'owner@example.test' }, request());
  await f.recovery().request({ email: 'owner@example.test' }, request()); assert.equal(f.sent.length, 1);
  await f.reopen(); await f.recovery().request({ email: 'owner@example.test' }, request()); assert.equal(f.sent.length, 1);
  f.clock(61_000); await f.recovery().request({ email: 'owner@example.test' }, request());
  f.clock(61_000); await f.recovery().request({ email: 'owner@example.test' }, request());
  f.clock(61_000); await f.recovery().request({ email: 'owner@example.test' }, request()); assert.equal(f.sent.length, 3);
  f.clock(2 * 3_600_000); await f.recovery().request({ email: 'owner@example.test' }, request()); assert.equal(f.sent.length, 4);
  const data = await f.repository().read(state => state.passwordRecovery); assert.equal(data.requests.length, 1); assert.equal(data.attempts.length, 1);
}));

test('concurrent redemption allows only one synchronization and no second password update', () => fixture(async f => {
  await f.recovery().request({ email: 'owner@example.test' }, request()); f.blockSync();
  const pending = f.recovery().confirm(command(f.sent[0]), request());
  while (!f.changes.length) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.recovery().confirm(command(f.sent[0]), request()), failure('password_reset_in_progress'));
  f.releaseSync(); await pending; assert.deepEqual(f.changes.map(value => value.phase), ['revoke', 'apply']);
}));

for (const phase of ['revoke', 'apply']) test(`failed ${phase} stays locked and can resume the same token/password after restart`, () => fixture(async f => {
  await f.recovery().request({ email: 'owner@example.test' }, request()); f.failSync(phase);
  await assert.rejects(f.recovery().confirm(command(f.sent[0]), request()), error => error.code === 'platform_password_sync_failed' && !error.message.includes('PRIVATE'));
  const user = await f.repository().read(state => state.users.find(value => value.id === 'owner-a'));
  assert.equal(user.passwordRecoveryPending, true);
  await assert.rejects(f.auth().login({ username: 'owner@example.test', password: NEXT }, request()), failure('platform_invalid_credentials'));
  await assert.rejects(f.auth().login({ username: 'owner@example.test', password: OLD }, request()), failure('platform_invalid_credentials'));
  await f.reopen(); f.failSync(undefined);
  await assert.rejects(f.recovery().confirm(command(f.sent[0], AGAIN), request()), failure('password_reset_invalid'));
  assert.deepEqual(await f.recovery().confirm(command(f.sent[0]), request()), { ok: true });
  assert.ok(f.changes.every(value => value.initialPasswordChange === false));
  assert.equal((await f.auth().login({ username: 'owner@example.test', password: NEXT }, request())).value.mustChangePassword, false);
}));

test('provider failure stays private and makes the unconfirmed link unusable', () => fixture(async f => {
  f.failEmail(true); const known = await f.recovery().request({ email: 'owner@example.test' }, request());
  const unknown = await f.recovery().request({ email: 'unknown@example.test' }, request()); assert.deepEqual(known, unknown);
  await assert.rejects(f.recovery().confirm(command(f.sent[0]), request()), failure('password_reset_invalid'));
  assert.ok(!JSON.stringify(await f.repository().read(state => state)).includes('PRIVATE-API-KEY'));
}));

test('password policy and strict input validation never consume a valid link on validation failure', () => fixture(async f => {
  await f.recovery().request({ email: 'owner@example.test' }, request()); const mail = f.sent[0];
  await assert.rejects(f.recovery().confirm({ ...command(mail), confirmPassword: AGAIN }, request()), failure('password_reset_password_mismatch'));
  for (const password of ['short', 'x'.repeat(201), 'JerocDemo2026!']) await assert.rejects(f.recovery().confirm(command(mail, password), request()));
  await assert.rejects(f.recovery().confirm({ ...command(mail), organisationId: 'other-company' }, request()), failure('password_reset_password_invalid'));
  await assert.rejects(f.recovery().confirm(command(mail, OLD), request()), failure('password_reset_password_unchanged'));
  assert.deepEqual(await f.recovery().confirm(command(mail), request()), { ok: true });
}));

test('invalid token attempts are throttled before password derivation and cannot spoof a new source header', () => fixture(async f => {
  for (let i = 0; i < 30; i++) await assert.rejects(f.recovery().confirm({ token: 'x', newPassword: NEXT, confirmPassword: NEXT }, request()), failure('password_reset_invalid'));
  await assert.rejects(f.recovery().confirm({ token: 'x', newPassword: NEXT, confirmPassword: NEXT }, { ...request(), headers: { 'x-forwarded-for': 'different-attacker' } }), failure('password_reset_rate_limit'));
  assert.equal(f.changes.length, 0);
}));

test('explicit systemadmin recovery email config works on existing registries and never uses arbitrary company contacts', () => fixture(async f => {
  await f.recovery().request({ email: 'configured@example.test' }, request()); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'configured@example.test');
  assert.deepEqual(await f.recovery().confirm(command(f.sent[0]), request()), { ok: true });
  await f.reopen();
  assert.equal((await f.auth().login({ username: 'admin', password: NEXT }, request())).value.actor.platformAdmin, true);
}, { platformAdminEmail: 'configured@example.test' }));

test('a genuine initial password change stays distinct from the recovery lock across failed sync and restart', () => fixture(async f => {
  await f.recovery().request({ email: 'admin@example.test' }, request()); f.failSync('apply');
  await assert.rejects(f.recovery().confirm(command(f.sent[0]), request()), failure('platform_password_sync_failed'));
  assert.ok(f.changes.every(value => value.initialPasswordChange === true));
  await f.reopen(); f.failSync(undefined);
  assert.deepEqual(await f.recovery().confirm(command(f.sent[0]), request()), { ok: true });
  assert.ok(f.changes.every(value => value.initialPasswordChange === true));
}));

test('a membership removed during synchronization stops application even when another company still permits login', () => fixture(async f => {
  await f.repository().transact(state => {
    state.companies.push({ id: 'company-b', name: 'Company B', status: 'active', storageSchema: 'b', ownerUserId: 'owner-a' });
    state.memberships.push({ userId: 'owner-a', organisationId: 'company-b', businessUserId: 'owner-a', active: true });
  });
  await f.recovery().request({ email: 'owner@example.test' }, request()); f.blockSync();
  const pending = f.recovery().confirm(command(f.sent[0]), request());
  while (!f.changes.length) await new Promise(resolve => setTimeout(resolve, 1));
  await f.repository().transact(state => { state.memberships.find(item => item.organisationId === 'company-a').active = false; });
  f.releaseSync();
  await assert.rejects(pending, failure('platform_password_sync_failed'));
  assert.deepEqual(f.changes.map(value => value.phase), ['revoke']);
  assert.equal((await f.repository().read(state => state.users.find(user => user.id === 'owner-a'))).passwordRecoveryPending, true);
}));
