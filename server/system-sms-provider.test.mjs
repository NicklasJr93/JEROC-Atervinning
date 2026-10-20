import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystemSmsProvider, SYSTEM_SMS_FROM, SYSTEM_SMS_TEST_MESSAGE, ELKS_SMS_URL, SystemSmsError } from './system-sms-provider.mjs';

const env = { ELKS_API_USERNAME: 'synthetic-api-username', ELKS_API_PASSWORD: 'synthetic-private-password' };
const input = { to: '+46722002220', requestId: '2181c90e-90fb-4bcb-a2ed-9e3fef20f135' };
const approvalToken = 'A'.repeat(43);
const approvalInput = { ...input, companyName: 'Återvinning & Miljö AB',
  approvalUrl: `https://app.scrapplanner.com/godkann/#token=${approvalToken}`,
  createdAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-10-21T10:00:00.000Z' };
const receipt = (status = 'created') => ({ id: 's70df59406a1b4643b96f3f91e0bfb7b0', status, to: input.to,
  from: SYSTEM_SMS_FROM, direction: 'outgoing', message: 'RAW-PRIVATE-TEXT', private: env.ELKS_API_PASSWORD });
const response = (body = receipt(), status = 201, headers) => new Response(JSON.stringify(body), { status, headers });
const client = fetchImpl => createSystemSmsProvider({ env, fetchImpl });
const rejects = (promise, code, outcome = 'not_sent', status) => assert.rejects(promise, error => {
  assert.ok(error instanceof SystemSmsError); assert.equal(error.code, code); assert.equal(error.outcome, outcome);
  if (status) assert.equal(error.status, status);
  for (const privateText of [env.ELKS_API_USERNAME, env.ELKS_API_PASSWORD, input.to, 'RAW-PRIVATE-TEXT']) {
    assert.ok(!error.message.includes(privateText)); assert.ok(!JSON.stringify(error).includes(privateText));
  }
  return true;
});

test('46elks test posts Basic Auth and a single fixed short message without tenant data or fake idempotency', async () => {
  let calls = 0;
  const provider = client(async (url, options) => {
    calls++;
    assert.equal(url, ELKS_SMS_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${env.ELKS_API_USERNAME}:${env.ELKS_API_PASSWORD}`).toString('base64')}`);
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded'); assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['Idempotency-Key'], undefined); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), {
      from: SYSTEM_SMS_FROM, to: input.to, message: SYSTEM_SMS_TEST_MESSAGE, dontlog: 'message',
    });
    assert.ok(!options.body.includes(input.requestId)); assert.ok(!options.body.includes('dryrun'));
    return response();
  });
  const result = await provider.sendTest(input);
  assert.deepEqual(result, { providerId: receipt().id, providerStatus: 'created' });
  assert.deepEqual(Object.keys(result).sort(), ['providerId', 'providerStatus']); assert.equal(calls, 1);
  assert.equal(SYSTEM_SMS_FROM, 'ScrapPlan'); assert.match(SYSTEM_SMS_FROM, /^[A-Za-z][A-Za-z0-9]{0,10}$/);
  assert.ok(SYSTEM_SMS_TEST_MESSAGE.length <= 160);
  // Every character in this fixed template is a single-septet GSM7 character.
  assert.match(SYSTEM_SMS_TEST_MESSAGE, /^[A-Za-z0-9 åäöÅÄÖ.,-]+$/);
});

test('Swedish local and international phone formats normalize to one E164 recipient', async () => {
  let calls = 0;
  const provider = client(async (_url, options) => {
    assert.equal(new URLSearchParams(options.body).get('to'), input.to); calls++; return response();
  });
  for (const to of ['072-200 22 20', '+46 72 200 22 20', '0046 72 200 22 20'])
    await provider.sendTest({ ...input, to });
  assert.equal(calls, 3);
});

test('both API credentials are required and invalid inputs never reach the provider', async () => {
  for (const settings of [{}, { ELKS_API_USERNAME: env.ELKS_API_USERNAME }, { ELKS_API_PASSWORD: env.ELKS_API_PASSWORD },
    { ...env, ELKS_API_PASSWORD: '   ' }, { RESEND_API_KEY: 'synthetic-email-key' }]) {
    const provider = createSystemSmsProvider({ env: settings, fetchImpl: () => assert.fail('must not fetch') });
    assert.equal(provider.configured, false);
    await rejects(provider.sendTest(input), 'system_sms_not_configured', 'not_sent', 503);
  }
  const provider = client(() => assert.fail('must not fetch'));
  assert.equal(provider.configured, true);
  for (const invalid of [null, [], {}, { ...input, to: ['+46722002220'] }, { ...input, to: '' }, { ...input, to: '12345' },
    { ...input, to: '+46722002220,+46722002221' }, { ...input, to: '+46722002220\r\nInjected' },
    { ...input, requestId: 'unsafe' }, { ...input, message: 'ARBITRARY-CONTENT' }, { ...input, from: 'Spoof' },
    { ...input, organisationId: 'other-company' }, { ...input, dryrun: 'yes' }])
    await rejects(provider.sendTest(invalid), 'system_sms_invalid', 'not_sent', 422);
});

test('only recognized successful receipts produce acceptance, with failed delivery kept distinct', async () => {
  for (const status of ['created', 'sent', 'delivered'])
    assert.deepEqual(await client(async () => response(receipt(status))).sendTest(input), { providerId: receipt().id, providerStatus: status });
  await rejects(client(async () => response(receipt('failed'))).sendTest(input), 'system_sms_delivery_failed', 'not_sent', 502);
  for (const body of [null, [], {}, { id: receipt().id }, { ...receipt(), id: 'untrusted-id' }, { ...receipt(), status: 'queued' },
    { id: 's70df59406a1b4643b96f3f91e0bfb7b0', status: 'dryrun' }])
    await rejects(client(async () => response(body)).sendTest(input), 'system_sms_outcome_unknown', 'unknown', 503);
});

test('definitive provider rejections use fixed safe messages and are never retried', async () => {
  for (const [status, code, expectedStatus] of [[400, 'system_sms_rejected', 503], [401, 'system_sms_credentials_rejected', 503],
    [403, 'system_sms_credentials_rejected', 503], [402, 'system_sms_balance_required', 503],
    [422, 'system_sms_rejected', 503], [429, 'system_sms_rate_limited', 429]]) {
    let calls = 0, cancelled = false;
    const provider = client(async () => { calls++; return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${env.ELKS_API_PASSWORD} ${input.to}`)); },
      cancel() { cancelled = true; },
    }), { status }); });
    await rejects(provider.sendTest(input), code, 'not_sent', expectedStatus);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test('network failures, uncertain HTTP failures and malformed or oversized success bodies never trigger a retry', async () => {
  const responses = [
    () => response({ private: env.ELKS_API_PASSWORD }, 500),
    () => response({ private: env.ELKS_API_PASSWORD }, 503),
    () => response({ private: env.ELKS_API_PASSWORD }, 408),
    () => response({ private: env.ELKS_API_PASSWORD }, 409),
    () => new Response('<html>RAW-PRIVATE-TEXT</html>', { status: 200 }),
    () => new Response(null, { status: 204 }),
    () => response({ ...receipt(), extra: 'x'.repeat(17000) }),
    () => response(receipt(), 201, { 'content-length': '1000000' }),
    () => { throw new Error(`${env.ELKS_API_USERNAME} ${env.ELKS_API_PASSWORD} ${input.to}`); },
  ];
  for (const makeResponse of responses) {
    let calls = 0;
    await rejects(client(async () => { calls++; return makeResponse(); }).sendTest(input), 'system_sms_outcome_unknown', 'unknown', 503);
    assert.equal(calls, 1);
  }
});

test('timeouts bound both response headers and bodies without declaring an uncertain send unsent', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    const headers = createSystemSmsProvider({ env, timeoutMs: 20, fetchImpl: () => { calls++; return new Promise(() => {}); } });
    await rejects(headers.sendTest(input), 'system_sms_outcome_unknown', 'unknown', 503);
    assert.equal(calls, 1);
    let cancelled = false;
    const body = createSystemSmsProvider({ env, timeoutMs: 20, fetchImpl: async () => new Response(new ReadableStream({
      start() {}, cancel() { cancelled = true; },
    }), { status: 201 }) });
    await rejects(body.sendTest(input), 'system_sms_outcome_unknown', 'unknown', 503);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test('cancellation before a provider call is unsent; cancellation after starting is uncertain', async () => {
  const before = new AbortController(); before.abort();
  await rejects(client(() => assert.fail('must not fetch')).sendTest(input, { signal: before.signal }), 'system_sms_cancelled', 'not_sent', 499);
  const during = new AbortController(); let calls = 0;
  const provider = client(async () => { calls++; queueMicrotask(() => during.abort()); return new Promise(() => {}); });
  await rejects(provider.sendTest(input, { signal: during.signal }), 'system_sms_outcome_unknown', 'unknown', 503);
  assert.equal(calls, 1);
});

test('customer approval SMS uses a fixed GSM-friendly company message, opaque link and no pretend provider idempotency', async () => {
  let calls = 0;
  const provider = client(async (url, options) => {
    calls++;
    assert.equal(url, ELKS_SMS_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Idempotency-Key'], undefined);
    const body = Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(body.from, 'ScrapPlan'); assert.equal(body.to, input.to); assert.equal(body.dontlog, 'message');
    assert.equal(body.message, `Atervinning & Miljo AB: Godkann underlaget: ${approvalInput.approvalUrl} /ScrapPlanner`);
    assert.match(body.message, /^[\x20-\x7e]+$/); assert.ok(body.message.length <= 160);
    assert.ok(!body.message.includes(input.to)); assert.ok(!body.message.includes(input.requestId));
    assert.deepEqual(Object.keys(body).sort(), ['dontlog', 'from', 'message', 'to']);
    return response();
  });
  assert.deepEqual(await provider.sendCustomerApproval({ ...approvalInput, to: '072-200 22 20' }), {
    providerId: receipt().id, providerStatus: 'created',
  });
  assert.equal(calls, 1);
});

test('customer approval SMS sanitizes display-only company names and never accepts arbitrary content', async () => {
  const names = ['🚛 Återvinning <AB>\u2028”proffs”', '🚛', 'Ä'.repeat(200)];
  let calls = 0;
  const provider = client(async (_url, options) => {
    const message = new URLSearchParams(options.body).get('message');
    assert.match(message, /^[\x20-\x7e]+$/); assert.ok(message.length <= 160);
    assert.ok(message.includes(approvalInput.approvalUrl)); calls++; return response();
  });
  for (const companyName of names) await provider.sendCustomerApproval({ ...approvalInput, companyName });
  assert.equal(calls, names.length);
  const invalidProvider = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, {}, [],
    { ...approvalInput, to: '1234' }, { ...approvalInput, to: '+46722002220,+46722002221' },
    { ...approvalInput, requestId: 'not-a-uuid' }, { ...approvalInput, createdAt: 'yesterday' },
    { ...approvalInput, expiresAt: 'tomorrow' }, { ...approvalInput, expiresAt: approvalInput.createdAt },
    { ...approvalInput, expiresAt: '2026-10-20T09:59:59.000Z' }, { ...approvalInput, expiresAt: '2026-10-21T10:00:01.000Z' },
    ...['', ' ', 'Unsafe\nHeader', 'x'.repeat(201), 'ﬀ'.repeat(101)].map(companyName => ({ ...approvalInput, companyName })),
    { ...approvalInput, message: 'ARBITRARY-CONTENT' }, { ...approvalInput, from: 'Spoof' },
    { ...approvalInput, customerName: 'Private Name' }, { ...approvalInput, bankAccount: 'PRIVATE-BANK-ACCOUNT' },
  ]) await rejects(invalidProvider.sendCustomerApproval(invalid), 'system_sms_invalid', 'not_sent', 422);
  assert.deepEqual(await client(async () => response()).sendCustomerApproval({ ...approvalInput,
    expiresAt: '2026-10-20T10:01:00.000Z' }), { providerId: receipt().id, providerStatus: 'created' });
});

test('customer approval SMS requires the configured HTTPS origin, public path and one fragment token', async () => {
  const provider = client(() => assert.fail('must not fetch'));
  for (const approvalUrl of [
    approvalInput.approvalUrl.replace('https:', 'http:'),
    approvalInput.approvalUrl.replace('app.scrapplanner.com', 'attacker.example'),
    approvalInput.approvalUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com.attacker.example'),
    approvalInput.approvalUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com:444'),
    approvalInput.approvalUrl.replace('app.scrapplanner.com', 'user:password@app.scrapplanner.com'),
    approvalInput.approvalUrl.replace('/godkann/', '/kontor/'),
    approvalInput.approvalUrl.replace('/godkann/', '/godkann/?company=untrusted'),
    approvalInput.approvalUrl.replace('#token=', '?token='),
    `${approvalInput.approvalUrl}&token=${approvalToken}`, `${approvalInput.approvalUrl}&company=untrusted`,
    `${approvalInput.approvalUrl}A`, approvalInput.approvalUrl.slice(0, -1), `${approvalInput.approvalUrl}\n`,
    'javascript:alert(1)',
  ]) await rejects(provider.sendCustomerApproval({ ...approvalInput, approvalUrl }), 'system_sms_invalid', 'not_sent', 422);
  for (const APP_URL of ['http://app.scrapplanner.com', 'https://user:password@app.scrapplanner.com',
    'https://app.scrapplanner.com/kontor/', 'https://app.scrapplanner.com?next=bad', 'https://app.scrapplanner.com/#bad', 'not-a-url']) {
    const invalidOrigin = createSystemSmsProvider({ env: { ...env, APP_URL }, fetchImpl: () => assert.fail('must not fetch') });
    await rejects(invalidOrigin.sendCustomerApproval(approvalInput), 'system_sms_invalid', 'not_sent', 422);
  }
  const custom = createSystemSmsProvider({ env: { ...env, APP_URL: 'https://pilot.example.invalid' },
    fetchImpl: async (_url, options) => {
      assert.ok(new URLSearchParams(options.body).get('message').includes('https://pilot.example.invalid/godkann/#token='));
      return response();
    } });
  await rejects(custom.sendCustomerApproval(approvalInput), 'system_sms_invalid', 'not_sent', 422);
  assert.deepEqual(await custom.sendCustomerApproval({ ...approvalInput,
    approvalUrl: approvalInput.approvalUrl.replace('app.scrapplanner.com', 'pilot.example.invalid') }), {
    providerId: receipt().id, providerStatus: 'created',
  });
});

test('customer approval SMS safely distinguishes rejected, failed and unknown outcomes without retries or bearer leaks', async () => {
  const privateData = `${env.ELKS_API_PASSWORD} ${input.to} ${approvalInput.approvalUrl} RAW-PRIVATE-TEXT`;
  for (const [makeResponse, code, outcome, status] of [
    [() => response({ message: privateData }, 401), 'system_sms_credentials_rejected', 'not_sent', 503],
    [() => response({ message: privateData }, 402), 'system_sms_balance_required', 'not_sent', 503],
    [() => response({ message: privateData }, 403), 'system_sms_credentials_rejected', 'not_sent', 503],
    [() => response({ message: privateData }, 422), 'system_sms_rejected', 'not_sent', 503],
    [() => response({ message: privateData }, 429), 'system_sms_rate_limited', 'not_sent', 429],
    [() => response(receipt('failed')), 'system_sms_delivery_failed', 'not_sent', 502],
    [() => response({ message: privateData }, 500), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => response({ message: privateData }, 408), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => new Response(privateData), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => response({ ...receipt(), id: 'untrusted-id' }), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => response({ ...receipt(), extra: 'x'.repeat(17000) }), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => response(receipt(), 201, { 'content-length': '1000000' }), 'system_sms_outcome_unknown', 'unknown', 503],
    [() => { throw new Error(privateData); }, 'system_sms_outcome_unknown', 'unknown', 503],
  ]) {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return makeResponse(); }).sendCustomerApproval(approvalInput), error => {
      assert.ok(error instanceof SystemSmsError); assert.equal(error.code, code); assert.equal(error.outcome, outcome); assert.equal(error.status, status);
      for (const secret of [env.ELKS_API_USERNAME, env.ELKS_API_PASSWORD, input.to, approvalInput.approvalUrl, approvalToken, 'RAW-PRIVATE-TEXT']) {
        assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      }
      assert.ok(!/sms-test|test-sms/i.test(error.message));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('customer approval SMS preserves missing credentials, timeout and before/after cancellation semantics', async () => {
  await rejects(createSystemSmsProvider({ env: {}, fetchImpl: () => assert.fail('must not fetch') })
    .sendCustomerApproval(approvalInput), 'system_sms_not_configured', 'not_sent', 503);
  const before = new AbortController(); before.abort();
  await rejects(client(() => assert.fail('must not fetch')).sendCustomerApproval(approvalInput, { signal: before.signal }), 'system_sms_cancelled', 'not_sent', 499);
  const during = new AbortController(); let calls = 0;
  await rejects(client(async () => { calls++; queueMicrotask(() => during.abort()); return new Promise(() => {}); })
    .sendCustomerApproval(approvalInput, { signal: during.signal }), 'system_sms_outcome_unknown', 'unknown', 503);
  assert.equal(calls, 1);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    calls = 0;
    await rejects(createSystemSmsProvider({ env, timeoutMs: 20, fetchImpl: () => { calls++; return new Promise(() => {}); } })
      .sendCustomerApproval(approvalInput), 'system_sms_outcome_unknown', 'unknown', 503);
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});
