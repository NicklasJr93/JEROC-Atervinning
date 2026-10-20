import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformApi } from './platform-api.mjs';
import { createPlatformCommunications } from './platform-communications.mjs';
import { SYSTEM_SMS_FROM, SystemSmsError } from './system-sms-provider.mjs';

const bootstrapPassword = 'Private-Platform-Sms-Bootstrap-2026!';
const adminPassword = 'Changed-Private-Platform-Sms-2026!';
const passwordHash = platformPasswordHash(bootstrapPassword);
const sendPath = 'communications/test-sms', reviewPath = 'communications/review-sms';
const phone = '+46700000001';
const command = (to = phone, requestId = randomUUID()) => ({ to, requestId });
const receipt = { providerId: 's70df59406a1b4643b96f3f91e0bfb7b0', providerStatus: 'created' };

async function fixture(run, { configured = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-platform-sms-'));
  const env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'),
    ELKS_API_USERNAME: 'PRIVATE-ELKS-USERNAME', ELKS_API_PASSWORD: 'PRIVATE-ELKS-PASSWORD' };
  const companyId = randomUUID(), calls = [];
  let time = Date.parse('2026-10-20T10:00:00Z'), repository = await createPlatformStorage({ env }), auth, api;
  let send = async () => ({ ...receipt });
  function setup() {
    auth = createPlatformAuth({ repository, now: () => new Date(time),
      bootstrapPlatform: async () => ({ id: 'platform-admin', name: 'Systemadmin', username: 'admin', active: true, password: await passwordHash }),
      resolveCompanyUser: async (_companyId, id) => ['__platform-admin', 'vd'].includes(id)
        ? { id, name: id, level: id === '__platform-admin' ? 'Systemadmin' : 'VD', active: true, permissions: [] } : undefined,
    });
    const sms = { configured, async sendTest(input) { calls.push(structuredClone(input)); return send(input); } };
    const email = { configured: false, sendTest: () => assert.fail('SMS test must never send email') };
    const communications = createPlatformCommunications({ auth, email, sms, repository, now: () => new Date(time) });
    api = createPlatformApi({ auth, communications, env });
  }
  setup(); await auth.initialize();
  await repository.transact(async state => {
    state.companies.push({ id: companyId, name: 'Testbolaget', organisationNumber: '5593593626', status: 'active', ownerUserId: 'vd' });
    state.users.push({ id: 'vd', businessId: 'vd', name: 'VD', username: 'vd', password: await passwordHash,
      active: true, platformAdmin: false, mustChangePassword: false });
    state.memberships.push({ userId: 'vd', organisationId: companyId, businessUserId: 'vd', active: true });
  });
  const failures = [];
  const server = createServer((req, res) => {
    void api(req, res, new URL(req.url, 'http://localhost')).catch(error => {
      failures.push(error); if (!res.headersSent) res.writeHead(500); res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = 'communications', payload, account, headers = {}) {
    const response = await fetch(`${base}/api/platform/${path}`, { method: payload === undefined ? 'GET' : 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...(account && { cookie: account.cookie,
        'x-platform-csrf': account.body.csrfToken, 'x-platform-generation': account.body.generation }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const cookie = response.headers.getSetCookie().filter(value => value.startsWith('jeroc_platform=') || value.startsWith('jeroc_tenant='))
      .map(value => value.split(';')[0]).join('; ');
    return { status: response.status, body: await response.json(), cookie: cookie || account?.cookie, headers: response.headers };
  }
  async function login(username = 'admin', password = adminPassword) {
    const result = await request('login', { username, password }); assert.equal(result.status, 200, result.body.error); return result;
  }
  async function activate() {
    const initial = await login('admin', bootstrapPassword);
    const active = await request('change-password', { newPassword: adminPassword }, initial);
    assert.equal(active.status, 200, active.body.error); return active;
  }
  try {
    await run({ request, login, activate, calls, companyId, setSend: implementation => { send = implementation; },
      advance: milliseconds => { time += milliseconds; }, state: () => repository.read(state => state),
      reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env }); setup(); },
      addAdmin: async id => repository.transact(async state => state.users.push({ id, businessId: id, name: id, username: id,
        password: await passwordHash, active: true, platformAdmin: true, mustChangePassword: false })),
    });
    assert.deepEqual(failures, []);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await repository.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('SMS send and review require the real own platform administrator, never a tenant or forged header', () => fixture(async f => {
  for (const path of [sendPath, reviewPath]) {
    assert.equal((await f.request(path, command())).status, 401);
    assert.equal((await f.request(path, command(), undefined, { 'x-demo-actor': 'platform-admin', 'x-platform-admin': 'true' })).status, 401);
  }
  const initial = await f.login('admin', bootstrapPassword);
  assert.equal((await f.request(sendPath, command(), initial)).status, 423);
  const admin = await f.request('change-password', { newPassword: adminPassword }, initial);
  const config = await f.request('communications', undefined, admin);
  assert.equal(config.status, 200); assert.equal(config.body.sms.configured, true);
  assert.equal(config.body.sms.from, SYSTEM_SMS_FROM); assert.equal(config.body.sms.provider, '46elks');
  assert.ok(!JSON.stringify(config.body).includes('PRIVATE-ELKS'));
  const vd = await f.login('vd', bootstrapPassword);
  for (const path of [sendPath, reviewPath]) {
    assert.equal((await f.request(path, command(), vd, { 'x-demo-actor': 'platform-admin', 'x-demo-user': '__platform-admin' })).status, 403);
  }
  const support = await f.request('switch', { organisationId: f.companyId }, admin);
  assert.equal(support.status, 200); assert.equal(support.body.isSupportSession, true);
  for (const path of [sendPath, reviewPath]) assert.equal((await f.request(path, command(), support)).status, 403);
  assert.equal(f.calls.length, 0);
}));

test('CSRF, generation, origin and company selector checks precede SMS sending and review', () => fixture(async f => {
  const admin = await f.activate();
  for (const path of [sendPath, reviewPath]) for (const [headers, status] of [
    [{ 'x-platform-csrf': '' }, 403], [{ 'x-platform-generation': 'stale' }, 409],
    [{ origin: 'https://foreign.invalid' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403], [{ 'x-platform-organisation-id': f.companyId }, 409],
  ]) assert.equal((await f.request(path, command(), admin, headers)).status, status);
  assert.equal(f.calls.length, 0); assert.equal((await f.state()).systemSmsTests, undefined);
}));

test('single-recipient SMS payload is strict and Swedish numbers normalize to E164', () => fixture(async f => {
  const admin = await f.activate();
  for (const payload of [null, [], {}, { ...command(), to: [phone] }, command('0700000001,0700000002'),
    command('0700000001\r\nfrom=Other'), command('not a phone'), { ...command(), requestId: 'invalid' },
    { ...command(), from: 'Other' }, { ...command(), text: 'Arbitrary content' }, { ...command(), companyId: f.companyId }])
    assert.equal((await f.request(sendPath, payload, admin)).status, 422);
  assert.equal(f.calls.length, 0);
  const payload = command('070-000 00 01');
  const sent = await f.request(sendPath, payload, admin);
  assert.equal(sent.status, 200, sent.body.error); assert.equal(sent.body.to, phone);
  assert.equal(sent.body.from, 'ScrapPlan'); assert.equal(sent.body.status, 'accepted');
  assert.deepEqual(f.calls[0], { requestId: payload.requestId, to: phone });
}));

test('accepted SMS replays safely after restart and UUID case normalization without retaining phone plaintext', () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  const first = await f.request(sendPath, payload, admin);
  assert.equal(first.status, 200); assert.equal(first.body.providerStatus, 'created');
  await f.reopen();
  const replay = await f.request(sendPath, { ...payload, to: '0700000001', requestId: payload.requestId.toUpperCase() }, admin);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.equal(f.calls.length, 1);
  assert.equal((await f.request(sendPath, { ...payload, to: '+46700000002' }, admin)).status, 409);
  const state = await f.state(), persisted = JSON.stringify(state);
  assert.ok(!persisted.includes(phone)); assert.ok(!persisted.includes('0700000001')); assert.ok(!persisted.includes('PRIVATE-ELKS'));
  assert.equal(state.audit.filter(item => item.action === 'platform.test_sms_requested').length, 1);
  assert.equal(state.audit.filter(item => item.action === 'platform.test_sms_accepted').length, 1);
}));

test('concurrent SMS requests and review cannot duplicate an active send', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; return { ...receipt }; });
  const pending = f.request(sendPath, payload, admin);
  try {
    await started;
    for (const copy of [payload, command('0700000001')]) {
      const duplicate = await f.request(sendPath, copy, admin);
      assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'system_sms_in_progress');
    }
    const review = await f.request(reviewPath, command(), admin);
    assert.equal(review.status, 409); assert.equal(review.body.code, 'system_sms_in_progress');
    assert.equal(f.calls.length, 1);
  } finally { release(); }
  assert.equal((await pending).status, 200);
}));

test('a late acknowledgement after manual review is retained and replayed without another SMS', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; return { ...receipt }; });
  const pending = f.request(sendPath, payload, admin);
  try {
    await started; f.advance(31_000);
    const reviewed = await f.request(reviewPath, command(), admin);
    assert.equal(reviewed.status, 200); assert.equal(reviewed.body.reviewed, true); assert.equal(f.calls.length, 1);
  } finally { release(); }
  const acknowledged = await pending;
  assert.equal(acknowledged.status, 200); assert.equal(acknowledged.body.providerId, receipt.providerId);
  const persisted = (await f.state()).systemSmsTests.requests[0];
  assert.equal(persisted.status, 'accepted'); assert.equal(persisted.providerId, receipt.providerId);
  assert.ok(persisted.reviewedAt);
  await f.reopen();
  const replay = await f.request(sendPath, payload, admin);
  assert.equal(replay.status, 200); assert.equal(f.calls.length, 1);
}));

test('a late unknown failure cannot undo an administrator review or block the recipient again', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; throw new SystemSmsError(503, 'system_sms_outcome_unknown', 'Kontrollera 46elks.', 'unknown'); });
  const pending = f.request(sendPath, payload, admin);
  try {
    await started; f.advance(31_000);
    assert.equal((await f.request(reviewPath, command(), admin)).status, 200);
  } finally { release(); }
  assert.equal((await pending).status, 503);
  assert.equal((await f.state()).systemSmsTests.requests[0].status, 'reviewed');
  f.setSend(async () => ({ ...receipt }));
  const fresh = await f.request(sendPath, command(), admin);
  assert.equal(fresh.status, 200); assert.equal(f.calls.length, 2);
}));

test('uncertain SMS blocks recipient across IDs, admins, restarts and retention until explicit review', () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  f.setSend(async () => { throw new SystemSmsError(503, 'system_sms_outcome_unknown', 'Kontrollera utskicksloggen.', 'unknown'); });
  assert.equal((await f.request(sendPath, payload, admin)).status, 503); assert.equal(f.calls.length, 1);
  for (const next of [payload, command('0700000001')]) {
    const blocked = await f.request(sendPath, next, admin);
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'system_sms_recipient_blocked');
  }
  await f.addAdmin('other-admin'); const other = await f.login('other-admin', bootstrapPassword);
  assert.equal((await f.request(sendPath, command(), other)).status, 409);
  f.advance(49 * 3_600_000); await f.reopen(); const later = await f.login();
  await f.request('communications', undefined, later); assert.equal(f.calls.length, 1);
  const blockedAfterRetention = await f.request(sendPath, command(), later);
  assert.equal(blockedAfterRetention.status, 409); assert.equal(blockedAfterRetention.body.code, 'system_sms_recipient_blocked');
  const reviewed = await f.request(reviewPath, command(), later);
  assert.equal(reviewed.status, 200); assert.deepEqual(reviewed.body, { reviewed: true }); assert.equal(f.calls.length, 1);
  const old = await f.request(sendPath, payload, later); assert.equal(old.status, 409); assert.equal(f.calls.length, 1);
  f.setSend(async () => ({ ...receipt }));
  const fresh = await f.request(sendPath, command(), later);
  assert.equal(fresh.status, 200, fresh.body.error); assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).audit.filter(item => item.action === 'platform.test_sms_reviewed').length, 1);
}));

test('definitive not-sent rejection permits a manual retry but never retries in the background', () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  f.setSend(async () => { throw new SystemSmsError(503, 'system_sms_auth_rejected', 'Kontrollera API-uppgifterna.', 'not_sent'); });
  const rejected = await f.request(sendPath, payload, admin);
  assert.equal(rejected.status, 503); assert.equal((await f.state()).systemSmsTests.requests[0].status, 'failed');
  await f.reopen(); assert.equal(f.calls.length, 1);
  f.setSend(async () => ({ ...receipt }));
  const accepted = await f.request(sendPath, payload, admin);
  assert.equal(accepted.status, 200); assert.equal(f.calls.length, 2);
}));

test('SMS per-recipient and actor limits remain durable and reset after an hour', () => fixture(async f => {
  const admin = await f.activate();
  for (let i = 0; i < 3; i++) assert.equal((await f.request(sendPath, command(), admin)).status, 200);
  await f.reopen();
  assert.equal((await f.request(sendPath, command('0700000001'), admin)).status, 429);
  for (let i = 3; i < 10; i++) assert.equal((await f.request(sendPath, command(`+4670000${String(i).padStart(4, '0')}`), admin)).status, 200);
  assert.equal((await f.request(sendPath, command('+46711111111'), admin)).status, 429); assert.equal(f.calls.length, 10);
  f.advance(3_600_001);
  assert.equal((await f.request(sendPath, command(), admin)).status, 200); assert.equal(f.calls.length, 11);
}));

test('SMS global limit applies across real administrators and cannot be bypassed by rotating account', () => fixture(async f => {
  await f.activate();
  for (let actor = 0; actor < 5; actor++) {
    await f.addAdmin(`sms-admin-${actor}`); const account = await f.login(`sms-admin-${actor}`, bootstrapPassword);
    for (let i = 0; i < 10; i++)
      assert.equal((await f.request(sendPath, command(`+46700${actor}${String(i).padStart(5, '0')}`), account)).status, 200);
  }
  await f.addAdmin('extra-admin'); const extra = await f.login('extra-admin', bootstrapPassword);
  assert.equal((await f.request(sendPath, command('+46711111111'), extra)).status, 429); assert.equal(f.calls.length, 50);
}));

test('accepted SMS acknowledgement survives a scope switch while stale browser receives no result', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; return { ...receipt }; });
  const pending = f.request(sendPath, payload, admin); let support;
  try { await started; support = await f.request('switch', { organisationId: f.companyId }, admin); }
  finally { release(); }
  assert.equal(support.status, 200); assert.equal((await pending).status, 401);
  assert.equal((await f.state()).systemSmsTests.requests[0].status, 'accepted');
  const own = await f.request('open-administration', {}, support);
  assert.equal((await f.request(sendPath, payload, own)).status, 200); assert.equal(f.calls.length, 1);
}));

test('missing SMS provider configuration cannot reserve or send a test', () => fixture(async f => {
  const admin = await f.activate();
  const config = await f.request('communications', undefined, admin); assert.equal(config.body.sms.configured, false);
  const attempted = await f.request(sendPath, command(), admin);
  assert.equal(attempted.status, 503); assert.equal(attempted.body.code, 'system_sms_not_configured');
  assert.equal(f.calls.length, 0); assert.equal((await f.state()).systemSmsTests, undefined);
}, { configured: false }));
