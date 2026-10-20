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
import { SYSTEM_EMAIL_FROM, SystemEmailError } from './system-email.mjs';

const bootstrapPassword = 'Private-System-Email-Bootstrap-2026!';
const adminPassword = 'Changed-System-Email-Administrator-2026!';
const passwordHash = platformPasswordHash(bootstrapPassword);
const emailPath = 'communications/test-email';
const command = (to = 'recipient@example.invalid', requestId = randomUUID()) => ({ to, requestId });

async function fixture(run, { configured = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-system-email-'));
  const env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'), RESEND_API_KEY: 'PRIVATE-RESEND-KEY' };
  const companyId = randomUUID(), calls = [];
  let time = Date.parse('2026-10-20T10:00:00Z'), repository = await createPlatformStorage({ env }), auth, api;
  let send = async () => ({ providerId: '80a33bfb-c0b6-4fbe-ad0f-e098c3ec8f4f' });
  function setup() {
    auth = createPlatformAuth({ repository, now: () => new Date(time),
      bootstrapPlatform: async () => ({ id: 'platform-admin', name: 'Systemadmin', username: 'admin', active: true, password: await passwordHash }),
      resolveCompanyUser: async (_companyId, id) => ['__platform-admin', 'vd'].includes(id)
        ? { id, name: id, level: id === '__platform-admin' ? 'Systemadmin' : 'VD', active: true, permissions: [] } : undefined,
    });
    const email = { configured, async sendTest(input) { calls.push(structuredClone(input)); return send(input); } };
    const communications = createPlatformCommunications({ auth, email, repository, now: () => new Date(time) });
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
    const account = await request('login', { username, password }); assert.equal(account.status, 200, account.body.error); return account;
  }
  async function activate() {
    const initial = await login('admin', bootstrapPassword);
    assert.equal(initial.body.mustChangePassword, true);
    const account = await request('change-password', { newPassword: adminPassword }, initial);
    assert.equal(account.status, 200, account.body.error); assert.equal(account.body.mustChangePassword, false);
    return account;
  }
  try {
    await run({ request, login, activate, calls, companyId, setSend: implementation => { send = implementation; },
      advance: milliseconds => { time += milliseconds; },
      state: () => repository.read(state => state),
      reopen: async () => { await repository.close(); repository = await createPlatformStorage({ env }); setup(); },
      addAdmin: async id => repository.transact(async state => { state.users.push({ id, businessId: id, name: id, username: id,
        password: await passwordHash, active: true, platformAdmin: true, mustChangePassword: false }); }),
    });
    assert.deepEqual(failures, []);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await repository.close(); await rm(directory, { recursive: true, force: true });
  }
}

test('only the real pilot systemadmin outside all tenant contexts can inspect or send tests', () => fixture(async f => {
  assert.equal((await f.request()).status, 401);
  assert.equal((await f.request(emailPath, command(), undefined, { 'x-demo-actor': 'platform-admin', 'x-platform-admin': 'true' })).status, 401);
  const initial = await f.login('admin', bootstrapPassword);
  assert.equal((await f.request(emailPath, command(), initial)).status, 423);
  const admin = await f.request('change-password', { newPassword: adminPassword }, initial);
  assert.equal(admin.status, 200); assert.equal(admin.body.company, undefined);
  const config = await f.request('communications', undefined, admin);
  assert.equal(config.status, 200); assert.equal(config.body.email.configured, true);
  assert.equal(config.body.email.from, SYSTEM_EMAIL_FROM); assert.match(config.headers.get('cache-control'), /no-store/);
  assert.equal(config.body.sms.configured, false); assert.deepEqual(config.body.sms.useCases.map(item => item.id), ['customer_approval', 'transport_notification']);
  assert.ok(!JSON.stringify(config.body).includes('PRIVATE-RESEND-KEY'));
  const vd = await f.login('vd', bootstrapPassword);
  for (const [path, payload] of [['communications'], [emailPath, command()]]) {
    const result = await f.request(path, payload, vd, { 'x-demo-actor': 'platform-admin', 'x-demo-user': '__platform-admin' });
    assert.equal(result.status, 403); assert.equal(result.body.code, 'platform_communications_forbidden');
  }
  const support = await f.request('switch', { organisationId: f.companyId }, admin);
  assert.equal(support.status, 200); assert.equal(support.body.user.id, '__platform-admin'); assert.equal(support.body.isSupportSession, true);
  assert.equal((await f.request('communications', undefined, support)).status, 403);
  assert.equal((await f.request(emailPath, command(), support)).status, 403);
  const own = await f.request('open-administration', {}, support);
  assert.equal(own.status, 200); assert.equal(own.body.company, undefined);
  assert.equal((await f.request(emailPath, command(), own)).status, 200);
  assert.equal(f.calls.length, 1);
}));

test('CSRF, generation, origin and forged company selectors block sending before the provider', () => fixture(async f => {
  const admin = await f.activate();
  for (const [headers, status] of [[{ 'x-platform-csrf': '' }, 403], [{ 'x-platform-generation': 'old-generation' }, 409],
    [{ origin: 'https://foreign.invalid' }, 403], [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'x-platform-organisation-id': f.companyId }, 409]])
    assert.equal((await f.request(emailPath, command(), admin, headers)).status, status);
  assert.equal(f.calls.length, 0); assert.equal((await f.state()).systemCommunications, undefined);
}));

test('server permits one validated recipient and fixed-template sends only', () => fixture(async f => {
  const admin = await f.activate();
  for (const payload of [null, [], {}, { ...command(), to: ['a@example.invalid'] },
    command('a@example.invalid,b@example.invalid'), command('Name <a@example.invalid>'), command('a@example.invalid\r\nBcc:b@example.invalid'),
    { ...command(), requestId: 'not-a-uuid' }, { ...command(), from: 'spoof@example.invalid' },
    { ...command(), subject: 'User-supplied subject' }, { ...command(), html: '<script>arbitrary</script>' }])
    assert.equal((await f.request(emailPath, payload, admin)).status, 422);
  assert.equal(f.calls.length, 0);
}));

test('accepted requests replay durably across reopen without resending or storing recipient addresses', () => fixture(async f => {
  const admin = await f.activate(), payload = command('private-recipient@example.invalid');
  const first = await f.request(emailPath, payload, admin);
  assert.equal(first.status, 200); assert.equal(first.body.status, 'accepted'); assert.equal(first.body.from, SYSTEM_EMAIL_FROM);
  assert.equal(first.body.to, payload.to); assert.equal(f.calls.length, 1);
  await f.reopen();
  const replay = await f.request(emailPath, payload, admin);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body); assert.equal(f.calls.length, 1);
  const upperCaseId = await f.request(emailPath, { ...payload, requestId: payload.requestId.toUpperCase() }, admin);
  assert.equal(upperCaseId.status, 200); assert.deepEqual(upperCaseId.body, first.body); assert.equal(f.calls.length, 1);
  const changed = await f.request(emailPath, { ...payload, to: 'someone-else@example.invalid' }, admin);
  assert.equal(changed.status, 409); assert.equal(changed.body.code, 'system_email_request_conflict'); assert.equal(f.calls.length, 1);
  const state = await f.state();
  assert.ok(!JSON.stringify(state).includes(payload.to)); assert.ok(!JSON.stringify(state).includes('PRIVATE-RESEND-KEY'));
  assert.equal(state.systemCommunications.requests[0].status, 'accepted');
  assert.equal(state.audit.filter(event => event.action === 'platform.test_email_requested').length, 1);
  assert.equal(state.audit.filter(event => event.action === 'platform.test_email_accepted').length, 1);
}));

test('concurrent copies of one request reserve one provider call only', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; return { providerId: '84a870f9-175c-43e0-8032-fec27c77f72d' }; });
  const pending = f.request(emailPath, payload, admin);
  try {
    await started;
    const duplicate = await f.request(emailPath, payload, admin);
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.code, 'system_email_in_progress'); assert.equal(f.calls.length, 1);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await f.request(emailPath, payload, admin)).status, 200); assert.equal(f.calls.length, 1);
}));

test('uncertain outcomes persist without background retries and explicit same-request retry preserves the payload', () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  f.setSend(async () => { throw new SystemEmailError(503, 'system_email_outcome_unknown', 'Testets resultat kunde inte bekräftas.'); });
  const unknown = await f.request(emailPath, payload, admin);
  assert.equal(unknown.status, 503); assert.equal(unknown.body.code, 'system_email_outcome_unknown'); assert.equal(f.calls.length, 1);
  assert.equal((await f.state()).systemCommunications.requests[0].status, 'unknown');
  f.advance(60_000); await f.reopen(); await f.request('communications', undefined, admin);
  assert.equal(f.calls.length, 1);
  f.setSend(async () => ({ providerId: '8c348db3-ad5b-4f73-9498-e6562094b912' }));
  const retried = await f.request(emailPath, payload, admin);
  assert.equal(retried.status, 200); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[1], f.calls[0]);
  const second = command('second@example.invalid');
  f.setSend(async () => { throw new Error('PRIVATE-RESEND-KEY second@example.invalid raw failure'); });
  assert.equal((await f.request(emailPath, second, admin)).status, 503);
  f.advance(24 * 3_600_000);
  const freshLogin = await f.login();
  const expired = await f.request(emailPath, second, freshLogin);
  assert.equal(expired.status, 409); assert.equal(expired.body.code, 'system_email_retry_expired'); assert.equal(f.calls.length, 3);
  assert.ok(!JSON.stringify(await f.state()).includes(second.to));
  // Resend forgets idempotency after 24h. Local cleanup must not make an old
  // uncertain UUID eligible for a new provider send, even after detail expiry.
  f.advance(25 * 3_600_000);
  const laterLogin = await f.login();
  const muchLater = await f.request(emailPath, { ...second, requestId: second.requestId.toUpperCase() }, laterLogin);
  assert.equal(muchLater.status, 409); assert.equal(muchLater.body.code, 'system_email_retry_expired'); assert.equal(f.calls.length, 3);
  f.setSend(async () => ({ providerId: '8c348db3-ad5b-4f73-9498-e6562094b912' }));
  assert.equal((await f.request(emailPath, command('new-test@example.invalid'), laterLogin)).status, 200);
  assert.equal((await f.state()).systemCommunications.expiredRequestIds.length, 2);
  await f.reopen();
  const archived = await f.request(emailPath, second, laterLogin);
  assert.equal(archived.status, 409); assert.equal(archived.body.code, 'system_email_retry_expired'); assert.equal(f.calls.length, 4);
}));

test('per-recipient and per-actor hourly limits persist across restarts and expire', () => fixture(async f => {
  const admin = await f.activate();
  for (let i = 0; i < 3; i++) assert.equal((await f.request(emailPath, command(' SAME@example.invalid '), admin)).status, 200);
  await f.reopen();
  assert.equal((await f.request(emailPath, command('same@example.invalid'), admin)).status, 429); assert.equal(f.calls.length, 3);
  for (let i = 3; i < 10; i++) assert.equal((await f.request(emailPath, command(`recipient-${i}@example.invalid`), admin)).status, 200);
  const limited = await f.request(emailPath, command('eleventh@example.invalid'), admin);
  assert.equal(limited.status, 429); assert.equal(limited.body.code, 'system_email_test_rate_limited'); assert.equal(f.calls.length, 10);
  f.advance(3_600_001);
  assert.equal((await f.request(emailPath, command('same@example.invalid'), admin)).status, 200); assert.equal(f.calls.length, 11);
}));

test('global hourly cap applies across separate real systemadmin accounts', () => fixture(async f => {
  await f.activate();
  for (let actor = 0; actor < 5; actor++) {
    await f.addAdmin(`admin-${actor}`); const account = await f.login(`admin-${actor}`, bootstrapPassword);
    for (let send = 0; send < 10; send++)
      assert.equal((await f.request(emailPath, command(`actor-${actor}-${send}@example.invalid`), account)).status, 200);
  }
  await f.addAdmin('last-admin'); const lastAdmin = await f.login('last-admin', bootstrapPassword);
  assert.equal((await f.request(emailPath, command('global-overflow@example.invalid'), lastAdmin)).status, 429);
  assert.equal(f.calls.length, 50);
}));

test('a context switch while Resend accepts stores the acknowledgement but denies the stale response', { timeout: 5000 }, () => fixture(async f => {
  const admin = await f.activate(), payload = command();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.setSend(async () => { entered(); await gate; return { providerId: 'e6495e0a-f2d0-4cb2-b479-5e9c5adc5c98' }; });
  const pending = f.request(emailPath, payload, admin); let support;
  try {
    await started; support = await f.request('switch', { organisationId: f.companyId }, admin); assert.equal(support.status, 200);
  } finally { release(); }
  const stale = await pending; assert.equal(stale.status, 401);
  assert.equal((await f.state()).systemCommunications.requests[0].status, 'accepted');
  const own = await f.request('open-administration', {}, support); assert.equal(own.status, 200);
  const replay = await f.request(emailPath, payload, own);
  assert.equal(replay.status, 200); assert.equal(replay.body.status, 'accepted'); assert.equal(f.calls.length, 1);
}));

test('missing provider configuration is explicit and cannot reserve or emit a test', () => fixture(async f => {
  const admin = await f.activate();
  const config = await f.request('communications', undefined, admin); assert.equal(config.body.email.configured, false);
  const result = await f.request(emailPath, command(), admin);
  assert.equal(result.status, 503); assert.equal(result.body.code, 'system_email_not_configured'); assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).systemCommunications, undefined);
}, { configured: false }));
