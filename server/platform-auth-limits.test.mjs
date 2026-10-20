import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatformAuth, platformPasswordHash, PLATFORM_COOKIE } from './platform-auth.mjs';
import { createPlatformStorage } from './platform-storage.mjs';
import { clientAddressHash } from './client-address.mjs';

const INITIAL = 'Isolated-Private-Administrator-2026!';
const NEXT = 'New-Isolated-Administrator-2026!';
const password = platformPasswordHash(INITIAL);
const peer = '10.0.0.9', firstClient = '198.51.100.10', secondClient = '203.0.113.20';
const failure = code => error => error.code === code;
const request = (account, address = firstClient, headers = {}) => ({ method: 'POST', socket: { remoteAddress: peer }, headers: {
  'x-forwarded-for': address,
  ...(account && { cookie: `${PLATFORM_COOKIE}=${account.token}`, 'x-platform-csrf': account.value.csrfToken, 'x-platform-generation': account.value.generation }),
  ...headers,
} });

async function fixture(run, { env = { RENDER: 'true' }, mandatory = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-auth-limits-'));
  // This fixture never inherits any database/provider connection from the shell.
  const storageEnv = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  let repository = await createPlatformStorage({ env: storageEnv }), auth;
  let time = new Date('2026-10-20T12:00:00Z'), failSync = false;
  const changes = [];
  const open = () => createPlatformAuth({ repository, env, now: () => time,
    bootstrapPlatform: async () => ({ id: 'admin', name: 'Systemadmin', username: 'admin', active: true, password: await password }),
    onPasswordChanged: async value => { changes.push(value); if (failSync) throw new Error('Synthetic synchronization failure'); },
  });
  auth = open();
  try {
    await auth.initialize();
    if (!mandatory) await repository.transact(state => { state.users[0].mustChangePassword = false; });
    await run({ auth: () => auth, repository: () => repository, changes,
      login: (address = firstClient) => auth.login({ username: 'admin', password: INITIAL }, request(undefined, address)),
      advance: milliseconds => { time = new Date(Number(time) + milliseconds); },
      failSync: value => { failSync = value; },
      reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env: storageEnv }); auth = open(); },
    });
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('only an explicitly trusted Render edge supplies a bounded final client address', () => {
  const original = request(undefined, `192.0.2.5, ${firstClient}`);
  const direct = { ...original, headers: {} };
  for (const env of [{}, { RENDER: 'false' }, { RENDER: 'yes' }])
    assert.equal(clientAddressHash(original, env), clientAddressHash(direct, env));
  assert.equal(clientAddressHash(original, { RENDER: 'true' }), clientAddressHash({ headers: {}, socket: { remoteAddress: firstClient } }, {}));
  for (const forwarded of ['spoofed', `${'x'.repeat(2048)},${firstClient}`, `${firstClient}:444`, [firstClient, secondClient], ''])
    assert.equal(clientAddressHash(request(undefined, forwarded), { RENDER: 'true' }), clientAddressHash(direct, {}));
});

test('failed clients behind a trusted proxy do not lock out an unrelated client', () => fixture(async f => {
  for (let index = 0; index < 30; index++) await assert.rejects(
    f.auth().login({ username: `unknown-${index}`, password: 'Synthetic-Wrong-Password!' }, request()), failure('platform_invalid_credentials'));
  await assert.rejects(f.login(), failure('platform_login_rate_limit'));
  assert.equal((await f.login(secondClient)).value.actor.id, 'admin');
  const attempts = await f.repository().read(state => JSON.stringify(state.attempts));
  assert.ok(!attempts.includes(firstClient) && !attempts.includes(peer));
}));

test('untrusted forwarding headers cannot rotate a direct client out of its login budget', () => fixture(async f => {
  for (let index = 0; index < 30; index++) await assert.rejects(
    f.auth().login({ username: `unknown-${index}`, password: 'Synthetic-Wrong-Password!' }, request(undefined, `198.51.100.${index}`)), failure('platform_invalid_credentials'));
  await assert.rejects(f.login(secondClient), failure('platform_login_rate_limit'));
}, { env: {} }));

test('account login budget survives a new client and process restart, then expires', () => fixture(async f => {
  for (let index = 0; index < 10; index++) await assert.rejects(
    f.auth().login({ username: 'admin', password: 'Synthetic-Wrong-Password!' }, request(undefined, `198.51.100.${index}`)), failure('platform_invalid_credentials'));
  await f.reopen();
  await assert.rejects(f.login(secondClient), failure('platform_login_rate_limit'));
  f.advance(15 * 60_000 + 1);
  assert.equal((await f.login(secondClient)).value.authenticated, true);
}));

test('parallel login work is reserved atomically before credential hashing', () => fixture(async f => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
    f.auth().login({ username: `unknown-${index}`, password: 'Synthetic-Wrong-Password!' }, request(undefined, `198.51.100.${index}`))));
  assert.equal(results.filter(value => value.status === 'rejected' && value.reason.code === 'platform_invalid_credentials').length, 4);
  assert.equal(results.filter(value => value.status === 'rejected' && value.reason.code === 'platform_login_rate_limit').length, 8);
  assert.equal(await f.repository().read(state => state.attempts.filter(item => item.status === 'pending').length), 0);
}));

test('a restarted process honors login work leases without holding crashed slots forever', () => fixture(async f => {
  await f.repository().transact(state => { state.attempts = Array.from({ length: 4 }, (_, index) => ({
    id: `crashed-${index}`, key: `other-account-${index}`, address: `other-source-${index}`, status: 'pending',
    at: '2026-10-20T12:00:00.000Z', leaseUntil: '2026-10-20T12:02:00.000Z',
  })); });
  await f.reopen();
  await assert.rejects(f.login(), failure('platform_login_rate_limit'));
  f.advance(120_001);
  assert.equal((await f.login()).value.actor.id, 'admin');
}));

test('password guesses share a durable actor budget across clients and sessions', () => fixture(async f => {
  const account = await f.login();
  for (let index = 0; index < 6; index++) await assert.rejects(
    f.auth().changePassword({ currentPassword: 'Synthetic-Wrong-Password!', newPassword: NEXT }, request(account, `198.51.100.${index}`)), failure('platform_password_mismatch'));
  await f.reopen();
  const otherSession = await f.login(secondClient);
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(otherSession, secondClient)), failure('platform_password_rate_limit'));
  f.advance(15 * 60_000 + 1);
  const changed = await f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(otherSession, secondClient));
  assert.equal(changed.value.mustChangePassword, false);
  await assert.rejects(f.auth().session(request(otherSession)), failure('platform_session_required'));
}));

test('parallel password guesses cannot bypass the expensive-check slots', () => fixture(async f => {
  const account = await f.login();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
    f.auth().changePassword({ currentPassword: 'Synthetic-Wrong-Password!', newPassword: NEXT }, request(account))));
  assert.equal(results.filter(value => value.status === 'rejected' && value.reason.code === 'platform_password_mismatch').length, 4);
  assert.equal(results.filter(value => value.status === 'rejected' && value.reason.code === 'platform_password_rate_limit').length, 8);
  assert.equal(await f.repository().read(state => state.credentialAttempts.filter(item => item.status === 'pending').length), 0);
}));

test('profile and password changes cannot be alternated to evade the actor budget', () => fixture(async f => {
  const account = await f.login();
  for (let index = 0; index < 3; index++) {
    await assert.rejects(f.auth().updateProfile({ expectedVersion: 0, email: 'synthetic@example.invalid', currentPassword: 'Synthetic-Wrong-Password!' }, request(account)), failure('platform_password_mismatch'));
    await assert.rejects(f.auth().changePassword({ currentPassword: 'Synthetic-Wrong-Password!', newPassword: NEXT }, request(account)), failure('platform_password_mismatch'));
  }
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account)), failure('platform_password_rate_limit'));
  await assert.rejects(f.auth().updateProfile({ expectedVersion: 0, email: 'synthetic@example.invalid', currentPassword: INITIAL }, request(account)), failure('platform_profile_rate_limit'));
}));

test('credential source budgets separate trusted clients and retain a global ceiling', () => fixture(async f => {
  const account = await f.login();
  const source = clientAddressHash(request(), { RENDER: 'true' });
  await f.repository().transact(state => { state.credentialAttempts = Array.from({ length: 60 }, (_, index) => ({
    id: `source-${index}`, actorId: `other-actor-${index}`, address: source, purpose: 'password', status: 'complete', at: '2026-10-20T12:00:00.000Z',
  })); });
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account)), failure('platform_password_rate_limit'));
  await assert.rejects(f.auth().changePassword({ currentPassword: 'Synthetic-Wrong-Password!', newPassword: NEXT }, request(account, secondClient)), failure('platform_password_mismatch'));
  await f.repository().transact(state => { state.credentialAttempts = Array.from({ length: 300 }, (_, index) => ({
    id: `global-${index}`, actorId: `other-actor-${index}`, address: `other-source-${index}`, purpose: 'profile', status: 'complete', at: '2026-10-20T12:00:00.000Z',
  })); });
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account, secondClient)), failure('platform_password_rate_limit'));
}));

test('a previous profile-edit lock remains effective during the additive migration', () => fixture(async f => {
  const account = await f.login();
  await f.repository().transact(state => { state.profileEmailAttempts = Array.from({ length: 6 }, () => ({ actorId: 'admin', address: 'synthetic-hash', at: '2026-10-20T12:00:00.000Z' })); });
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account)), failure('platform_password_rate_limit'));
  f.advance(15 * 60_000 + 1);
  assert.equal((await f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account))).value.mustChangePassword, false);
}));

test('first password activation and synchronization retry retain their authenticated gate', () => fixture(async f => {
  const account = await f.login();
  f.failSync(true);
  await assert.rejects(f.auth().changePassword({ newPassword: NEXT }, request(account)), failure('platform_password_sync_failed'));
  assert.equal((await f.auth().session(request(account))).mustChangePassword, true);
  f.failSync(false);
  const changed = await f.auth().changePassword({ newPassword: 'Second-Isolated-Administrator-2026!' }, request(account));
  assert.equal(changed.value.mustChangePassword, false);
  assert.equal(f.changes.length, 2);
}, { mandatory: true }));

test('CSRF and generation failures do not reserve a credential attempt', () => fixture(async f => {
  const account = await f.login();
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account, firstClient, { 'x-platform-csrf': 'wrong' })), failure('platform_csrf_required'));
  await assert.rejects(f.auth().changePassword({ currentPassword: INITIAL, newPassword: NEXT }, request(account, firstClient, { 'x-platform-generation': 'wrong' })), failure('platform_context_changed'));
  assert.equal(await f.repository().read(state => state.credentialAttempts?.length ?? 0), 0);
}));
