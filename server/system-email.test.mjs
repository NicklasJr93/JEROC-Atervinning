import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystemEmail, SystemEmailError, SYSTEM_EMAIL_FROM, RESEND_EMAIL_URL } from './system-email.mjs';

const key = 'PRIVATE-RESEND-API-KEY';
const request = { to: 'test@example.invalid', requestId: '1cf1eef4-d17d-4cc6-9cff-2412660166af', createdAt: '2026-10-20T10:00:00.000Z' };
const providerId = '99d645f5-b788-45c5-a733-9f84bcb1727e';
const client = (fetchImpl, extra = {}) => createSystemEmail({ env: { RESEND_API_KEY: key }, fetchImpl, ...extra });
const response = (value = { id: providerId }, status = 200, headers) => new Response(JSON.stringify(value), { status, headers });
async function rejects(promise, code, status = 503) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof SystemEmailError); assert.equal(error.code, code); assert.equal(error.status, status);
    for (const value of [key, request.to, 'PRIVATE-PROVIDER-DATA']) {
      assert.ok(!error.message.includes(value)); assert.ok(!JSON.stringify(error).includes(value));
    }
    return true;
  });
}

test('test email uses a fixed sender, HTTPS endpoint and Swedish template with no arbitrary sender or content', async () => {
  const adapter = client(async (url, options) => {
    assert.equal(url, RESEND_EMAIL_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.headers['Idempotency-Key'], `platform-test-email/${request.requestId}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.from, SYSTEM_EMAIL_FROM); assert.deepEqual(body.to, [request.to]);
    assert.equal(body.subject, 'Testmejl från ScrapPlanner');
    assert.match(body.text, /systemadministratör begärde ett test/); assert.match(body.html, /EndorGroup/);
    assert.ok(body.text.includes(request.requestId)); assert.ok(body.text.includes(request.createdAt));
    assert.deepEqual(Object.keys(body).sort(), ['from', 'html', 'subject', 'text', 'to']);
    return response({ id: providerId, ignored: { secret: 'PRIVATE-PROVIDER-DATA' } });
  });
  assert.equal(adapter.configured, true); assert.deepEqual(await adapter.sendTest(request), { providerId });
});

test('repeating the same accepted command has byte-identical payload and provider idempotency key', async () => {
  const calls = [];
  const adapter = client(async (_url, options) => { calls.push({ body: options.body, idempotencyKey: options.headers['Idempotency-Key'] }); return response(); });
  await adapter.sendTest(request); await adapter.sendTest({ ...request });
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls.length, 2);
});

test('only one plain email address, UUID and ISO timestamp are accepted before any provider call', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, [], {}, { ...request, to: 'a@example.invalid,b@example.invalid' },
    { ...request, to: 'Name <a@example.invalid>' }, { ...request, to: 'a@example.invalid\r\nBcc:b@example.invalid' },
    { ...request, to: `${'a'.repeat(255)}@example.invalid` }, { ...request, to: ['a@example.invalid'] },
    { ...request, requestId: 'not-a-uuid' }, { ...request, createdAt: 'yesterday' }, { ...request, createdAt: '2026-02-31T00:00:00Z' },
    { ...request, from: 'attacker@example.invalid' }, { ...request, subject: 'arbitrary content' }])
    await rejects(adapter.sendTest(invalid), 'system_email_invalid', 422);
});

test('missing or blank server key disables the adapter without calling Resend', async () => {
  for (const env of [{}, { RESEND_API_KEY: '' }, { RESEND_API_KEY: '  ' }]) {
    const adapter = createSystemEmail({ env, fetchImpl: () => assert.fail('must not fetch') });
    assert.equal(adapter.configured, false); await rejects(adapter.sendTest(request), 'system_email_not_configured');
  }
});

test('provider rejections and rate limits use fixed messages and do not auto-retry or leak raw data', async () => {
  for (const [status, code, expectedStatus] of [[400, 'system_email_rejected', 503], [401, 'system_email_rejected', 503],
    [403, 'system_email_rejected', 503], [422, 'system_email_rejected', 503], [429, 'system_email_rate_limited', 429],
    [404, 'system_email_unavailable', 503], [500, 'system_email_outcome_unknown', 503], [503, 'system_email_outcome_unknown', 503]]) {
    let calls = 0;
    const adapter = client(async () => { calls++; return response({ name: key, message: `${request.to} PRIVATE-PROVIDER-DATA` }, status); });
    await rejects(adapter.sendTest(request), code, expectedStatus); assert.equal(calls, 1);
  }
  await rejects(client(async () => response({ name: 'invalid_idempotent_request', message: key }, 409)).sendTest(request), 'system_email_idempotency_conflict', 409);
  await rejects(client(async () => response({ name: 'concurrent_idempotent_requests', message: key }, 409)).sendTest(request), 'system_email_outcome_unknown');
});

test('malformed or oversized acceptance is uncertain and never reported as delivered', async () => {
  for (const makeResponse of [() => new Response('not JSON'), () => new Response(null, { status: 204 }),
    () => response({}), () => response({ id: ['invalid'] }), () => response({ id: key }),
    () => response({ id: providerId, ignored: 'x'.repeat(16384) }),
    () => response({ id: providerId }, 200, { 'content-length': '999999' })])
    await rejects(client(async () => makeResponse()).sendTest(request), 'system_email_outcome_unknown');
});

test('bounded malformed rejection retains its safe HTTP classification without provider details', async () => {
  for (const makeResponse of [() => new Response('<html>PRIVATE-PROVIDER-DATA</html>', { status: 403 }),
    () => response({ message: 'x'.repeat(20000) }, 403), () => new Response(null, { status: 403 })])
    await rejects(client(async () => makeResponse()).sendTest(request), 'system_email_rejected');
});

test('timeout bounds request and streamed response, and cancellation never leaks raw errors or retries', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    const stalledHeaders = client(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 });
    await rejects(stalledHeaders.sendTest(request), 'system_email_outcome_unknown'); assert.equal(calls, 1);
    let cancelled = false;
    const stalledBody = client(async () => new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } })), { timeoutMs: 20 });
    await rejects(stalledBody.sendTest(request), 'system_email_outcome_unknown'); assert.equal(cancelled, true);
    const controller = new AbortController(); controller.abort(new Error(key));
    await rejects(client(() => assert.fail('must not fetch')).sendTest(request, { signal: controller.signal }), 'system_email_outcome_unknown');
    await rejects(client(async () => { throw new Error(`${key} PRIVATE-PROVIDER-DATA`); }).sendTest(request), 'system_email_outcome_unknown');
  } finally { clearTimeout(keepAlive); }
});
