import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystemEmail, SystemEmailError, SYSTEM_EMAIL_FROM, RESEND_EMAIL_URL, MAX_SYSTEM_EMAIL_PDF_BYTES } from './system-email.mjs';

const key = 'PRIVATE-RESEND-API-KEY';
const request = { to: 'test@example.invalid', requestId: '1cf1eef4-d17d-4cc6-9cff-2412660166af', createdAt: '2026-10-20T10:00:00.000Z' };
const resetToken = 'A'.repeat(43);
const resetRequest = { ...request, expiresAt: '2026-10-20T10:30:00.000Z', resetUrl: `https://app.scrapplanner.com/kontor/#/reset-password?token=${resetToken}` };
const invitationRequest = { ...request, name: 'Alma <Återvinning> & Co', companyName: 'Testbolaget & Återvinning <AB>',
  username: 'alma@example.invalid', activationUrl: `https://app.scrapplanner.com/kontor/#/activate-account?token=${resetToken}`,
  expiresAt: '2026-10-21T10:00:00.000Z' };
const approvalRequest = { ...request, companyName: 'Testbolaget & Återvinning <AB>',
  approvalUrl: `https://app.scrapplanner.com/godkann/#token=${resetToken}`, expiresAt: '2026-10-21T10:00:00.000Z' };
const weighedRequest = { ...request, companyName: 'Testbolaget & Återvinning <AB>', cardNumber: 3010,
  documentId: '1247623a-e124-4f1b-a920-191a19bcadf2', pdf: Buffer.from('%PDF-1.7\nSYNTHETIC-ARCHIVED-PDF-CONTENT\n%%EOF\n') };
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

test('password reset uses the fixed sender and a single-use Swedish link without generating or including a password', async () => {
  const calls = [];
  const adapter = client(async (url, options) => {
    assert.equal(url, RESEND_EMAIL_URL); assert.equal(options.redirect, 'error');
    calls.push({ body: options.body, key: options.headers['Idempotency-Key'] });
    const message = JSON.parse(options.body);
    assert.equal(message.from, SYSTEM_EMAIL_FROM); assert.deepEqual(message.to, [request.to]);
    assert.equal(message.subject, 'Återställ ditt lösenord');
    assert.match(message.text, /30 minuter/); assert.match(message.text, /bara användas en gång/);
    assert.match(message.text, /Om du inte begärde detta kan du ignorera mejlet/);
    assert.match(message.html, /EndorGroup/);
    assert.ok(message.text.includes(resetRequest.resetUrl));
    assert.ok(message.html.includes(`href="${resetRequest.resetUrl}"`));
    assert.deepEqual(Object.keys(message).sort(), ['from', 'html', 'subject', 'text', 'to']);
    assert.ok(!options.body.includes('newPassword')); assert.ok(!options.body.includes('temporaryPassword'));
    return response();
  });
  assert.deepEqual(await adapter.sendPasswordReset(resetRequest), { providerId });
  assert.deepEqual(await adapter.sendPasswordReset({ ...resetRequest }), { providerId });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0].key, `password-reset/${request.requestId}`);
});

test('reset links stay in the trusted HTTPS application origin and fixed route', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const resetUrl of [
    `http://app.scrapplanner.com/kontor/#/reset-password?token=${resetToken}`,
    `https://attacker.example/kontor/#/reset-password?token=${resetToken}`,
    `https://app.scrapplanner.com.attacker.example/kontor/#/reset-password?token=${resetToken}`,
    `https://app.scrapplanner.com:444/kontor/#/reset-password?token=${resetToken}`,
    `https://user:password@app.scrapplanner.com/kontor/#/reset-password?token=${resetToken}`,
    `https://app.scrapplanner.com/kund/#/reset-password?token=${resetToken}`,
    `https://app.scrapplanner.com/kontor/?next=https://attacker.example#/reset-password?token=${resetToken}`,
    `https://app.scrapplanner.com/kontor/#/reset-password?token=${resetToken}&next=https://attacker.example`,
    `https://app.scrapplanner.com/kontor/#/reset-password?token=${resetToken.slice(1)}`,
    `https://app.scrapplanner.com/kontor/#/reset-password?token=${resetToken}A`,
    `https://app.scrapplanner.com/kontor/#/reset-password?token=${'A'.repeat(42)}<`,
    `${resetRequest.resetUrl}\n`, `${resetRequest.resetUrl}" onclick="alert(1)`,
    '<a href="https://attacker.example">Reset</a>', 'javascript:alert(1)',
  ]) await rejects(adapter.sendPasswordReset({ ...resetRequest, resetUrl }), 'system_email_invalid', 422);
  const configured = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL: 'https://office.example.invalid' }, fetchImpl: async (_url, options) => {
    const message = JSON.parse(options.body);
    assert.ok(message.html.includes('href="https://office.example.invalid/kontor/#/reset-password?token='));
    assert.ok(!message.html.includes('<script>'));
    return response();
  } });
  await rejects(configured.sendPasswordReset(resetRequest), 'system_email_invalid', 422);
  assert.deepEqual(await configured.sendPasswordReset({ ...resetRequest, resetUrl: resetRequest.resetUrl.replace('app.scrapplanner.com', 'office.example.invalid') }), { providerId });
});

test('password reset validates recipient, timestamps, lifespan and fixed content before provider access', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, {}, [], { ...resetRequest, to: 'Name <user@example.invalid>' },
    { ...resetRequest, to: 'a@example.invalid\r\nBcc:b@example.invalid' }, { ...resetRequest, requestId: 'not-a-uuid' },
    { ...resetRequest, createdAt: 'yesterday' }, { ...resetRequest, expiresAt: 'tomorrow' },
    { ...resetRequest, expiresAt: '2026-10-20T10:00:00.000Z' }, { ...resetRequest, expiresAt: '2026-10-20T11:00:00.000Z' },
    { ...resetRequest, expiresAt: '2026-10-20T10:29:59.000Z' }, { ...resetRequest, password: 'Never-In-Email' },
    { ...resetRequest, subject: 'untrusted HTML' }, { ...resetRequest, from: 'attacker@example.invalid' },
  ]) await rejects(adapter.sendPasswordReset(invalid), 'system_email_invalid', 422);
  for (const APP_URL of ['http://app.scrapplanner.com', 'https://user:password@app.scrapplanner.com',
    'https://app.scrapplanner.com/kontor/', 'https://app.scrapplanner.com?next=bad', 'not-a-url']) {
    const invalidOrigin = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL }, fetchImpl: () => assert.fail('must not fetch') });
    await rejects(invalidOrigin.sendPasswordReset(resetRequest), 'system_email_invalid', 422);
  }
});

test('reset mail shares bounded provider classification without leaking recipient, token, URL or provider contents', async () => {
  const secretProviderData = `${key} ${resetRequest.to} ${resetRequest.resetUrl} PRIVATE-PROVIDER-DATA`;
  for (const [makeResponse, code, status] of [
    [() => response({ message: secretProviderData }, 403), 'system_email_rejected', 503],
    [() => response({ message: secretProviderData }, 429), 'system_email_rate_limited', 429],
    [() => response({ name: 'invalid_idempotent_request', message: secretProviderData }, 409), 'system_email_idempotency_conflict', 409],
    [() => response({ message: secretProviderData }, 500), 'system_email_outcome_unknown', 503],
    [() => new Response('<html>PRIVATE-PROVIDER-DATA</html>', { status: 403 }), 'system_email_rejected', 503],
    [() => response({ id: providerId, ignored: 'x'.repeat(16384) }), 'system_email_outcome_unknown', 503],
    [() => response({ id: providerId }, 200, { 'content-length': '999999' }), 'system_email_outcome_unknown', 503],
  ]) {
    let calls = 0;
    const adapter = client(async () => { calls++; return makeResponse(); });
    await assert.rejects(adapter.sendPasswordReset(resetRequest), error => {
      assert.ok(error instanceof SystemEmailError); assert.equal(error.code, code); assert.equal(error.status, status);
      for (const secret of [key, resetRequest.to, resetToken, resetRequest.resetUrl, 'PRIVATE-PROVIDER-DATA']) {
        assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      }
      assert.ok(!error.message.includes('testmejl'));
      return true;
    });
    assert.equal(calls, 1);
  }
  await rejects(createSystemEmail({ env: {}, fetchImpl: () => assert.fail('must not fetch') }).sendPasswordReset(resetRequest), 'system_email_not_configured');
});

test('reset mail is cancelled and timed out without retrying or exposing raw errors', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    const adapter = client(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 });
    await rejects(adapter.sendPasswordReset(resetRequest), 'system_email_outcome_unknown');
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort(new Error(resetRequest.resetUrl));
    await rejects(client(() => assert.fail('must not fetch')).sendPasswordReset(resetRequest, { signal: controller.signal }), 'system_email_outcome_unknown');
  } finally { clearTimeout(keepAlive); }
});

test('weighed document sends the attested office copy with a fixed sender and one inline archived PDF attachment', async () => {
  const calls = [];
  const adapter = client(async (url, options) => {
    assert.equal(url, RESEND_EMAIL_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push({ body: options.body, key: options.headers['Idempotency-Key'] });
    const message = JSON.parse(options.body);
    assert.equal(message.from, SYSTEM_EMAIL_FROM); assert.deepEqual(message.to, [weighedRequest.to]);
    assert.equal(message.subject, `${weighedRequest.companyName} · Vägt underlag 3010`);
    assert.match(message.text, /attesterade vägda underlaget 3010/);
    assert.match(message.html, /attesterade vägda underlaget/);
    assert.match(message.html, /Testbolaget &amp; Återvinning &lt;AB&gt;/);
    assert.ok(!message.html.includes(weighedRequest.companyName));
    assert.match(message.html, /Skickat via ScrapPlanner/); assert.match(message.text, /EndorGroup/);
    assert.deepEqual(message.attachments, [{ filename: `Vagt-underlag-3010-${weighedRequest.documentId}.pdf`,
      content: weighedRequest.pdf.toString('base64'), content_type: 'application/pdf' }]);
    assert.deepEqual(Buffer.from(message.attachments[0].content, 'base64'), weighedRequest.pdf);
    assert.deepEqual(Object.keys(message).sort(), ['attachments', 'from', 'html', 'subject', 'text', 'to']);
    return response({ id: providerId, ignored: 'PRIVATE-PROVIDER-DATA' });
  });
  assert.deepEqual(await adapter.sendWeighedDocument(weighedRequest), { providerId });
  assert.deepEqual(await adapter.sendWeighedDocument({ ...weighedRequest, cardNumber: '3010' }), { providerId });
  assert.equal(calls[0].key, `weighed-document/${request.requestId}`);
  assert.deepEqual(calls[0], calls[1]);
});

test('weighed document validates metadata, recipient and bounded PDF bytes before provider access', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, [], {}, { ...weighedRequest, to: 'a@example.invalid,b@example.invalid' },
    { ...weighedRequest, to: 'a@example.invalid\r\nBcc:b@example.invalid' },
    { ...weighedRequest, companyName: ' ' }, { ...weighedRequest, companyName: 'Unsafe\nHeader' },
    { ...weighedRequest, companyName: 'x'.repeat(201) }, { ...weighedRequest, companyName: 'ﬀ'.repeat(101) },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0', '001', '1.5', '../file', '9'.repeat(17)].map(cardNumber => ({ ...weighedRequest, cardNumber })),
    { ...weighedRequest, requestId: 'invalid' }, { ...weighedRequest, documentId: '../not-a-uuid' },
    { ...weighedRequest, createdAt: 'yesterday' },
    ...[undefined, null, 'https://attacker.example/pdf', weighedRequest.pdf.toString('base64'),
      new Uint8Array(weighedRequest.pdf), Buffer.from('<html>not PDF</html>'), Buffer.from('%PDF-1.7\nwithout-end-marker'),
      Buffer.from('%PDF-1.7\n%%EOF\n<script>bad</script>'), Buffer.alloc(MAX_SYSTEM_EMAIL_PDF_BYTES + 1)].map(pdf => ({ ...weighedRequest, pdf })),
    { ...weighedRequest, from: 'attacker@example.invalid' }, { ...weighedRequest, subject: 'arbitrary' },
    { ...weighedRequest, attachments: [{ path: 'https://attacker.example' }] },
  ]) await rejects(adapter.sendWeighedDocument(invalid), 'system_email_invalid', 422);
});

test('weighed document retains safe provider rejection, rate-limit and uncertain outcome classifications', async () => {
  const privateData = `${key} ${weighedRequest.to} ${weighedRequest.companyName} ${weighedRequest.pdf.toString('base64')} PRIVATE-PROVIDER-DATA`;
  for (const [makeResponse, code, status] of [
    [() => response({ message: privateData }, 403), 'system_email_rejected', 503],
    [() => response({ message: privateData }, 429), 'system_email_rate_limited', 429],
    [() => response({ name: 'invalid_idempotent_request', message: privateData }, 409), 'system_email_idempotency_conflict', 409],
    [() => response({ name: 'concurrent_idempotent_requests', message: privateData }, 409), 'system_email_outcome_unknown', 503],
    [() => response({ message: privateData }, 500), 'system_email_outcome_unknown', 503],
    [() => new Response(privateData, { status: 403 }), 'system_email_rejected', 503],
    [() => new Response('not-json'), 'system_email_outcome_unknown', 503],
    [() => response({ id: providerId, ignored: 'x'.repeat(16384) }), 'system_email_outcome_unknown', 503],
  ]) {
    let calls = 0;
    const adapter = client(async () => { calls++; return makeResponse(); });
    await assert.rejects(adapter.sendWeighedDocument(weighedRequest), error => {
      assert.ok(error instanceof SystemEmailError); assert.equal(error.code, code); assert.equal(error.status, status);
      for (const secret of [key, weighedRequest.to, weighedRequest.companyName, weighedRequest.pdf.toString('base64'), 'PRIVATE-PROVIDER-DATA']) {
        assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      }
      assert.ok(!error.message.includes('testmejl'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('weighed document uses the existing server key and bounded cancellation without automatic retries', async () => {
  await rejects(createSystemEmail({ env: {}, fetchImpl: () => assert.fail('must not fetch') }).sendWeighedDocument(weighedRequest), 'system_email_not_configured');
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    await rejects(client(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 }).sendWeighedDocument(weighedRequest), 'system_email_outcome_unknown');
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort(new Error(key));
    await rejects(client(() => assert.fail('must not fetch')).sendWeighedDocument(weighedRequest, { signal: controller.signal }), 'system_email_outcome_unknown');
  } finally { clearTimeout(keepAlive); }
});

test('staff invitation uses a fixed sender and escaped Swedish activation message without a password', async () => {
  const calls = [];
  const adapter = client(async (url, options) => {
    assert.equal(url, RESEND_EMAIL_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push({ body: options.body, key: options.headers['Idempotency-Key'] });
    const message = JSON.parse(options.body);
    assert.equal(message.from, SYSTEM_EMAIL_FROM); assert.deepEqual(message.to, [invitationRequest.to]);
    assert.equal(message.subject, 'Du är inbjuden till ScrapPlanner');
    assert.match(message.text, /Hej Alma <Återvinning> & Co!/);
    assert.ok(message.text.includes(invitationRequest.companyName));
    assert.ok(message.text.includes(invitationRequest.username));
    assert.ok(message.text.includes(invitationRequest.activationUrl));
    assert.match(message.text, /24 timmar/); assert.match(message.text, /bara användas en gång/);
    assert.match(message.text, /välja ditt eget lösenord/);
    assert.match(message.html, /Alma &lt;Återvinning&gt; &amp; Co/);
    assert.match(message.html, /Testbolaget &amp; Återvinning &lt;AB&gt;/);
    assert.ok(message.html.includes(`href="${invitationRequest.activationUrl}"`));
    assert.match(message.html, /Aktivera mitt konto/); assert.match(message.html, /EndorGroup/);
    assert.ok(!message.html.includes(invitationRequest.companyName));
    assert.deepEqual(Object.keys(message).sort(), ['from', 'html', 'subject', 'text', 'to']);
    assert.ok(!options.body.includes('temporaryPassword')); assert.ok(!options.body.includes('newPassword'));
    return response();
  });
  assert.deepEqual(await adapter.sendStaffInvitation(invitationRequest), { providerId });
  assert.deepEqual(await adapter.sendStaffInvitation({ ...invitationRequest }), { providerId });
  assert.equal(calls[0].key, `staff-invitation/${request.requestId}`); assert.deepEqual(calls[0], calls[1]);
  const escapedLogin = client(async (_url, options) => {
    assert.match(JSON.parse(options.body).html, /alma\+&lt;tag&gt;&amp;&quot;&#39;@example.invalid/);
    return response();
  });
  await escapedLogin.sendStaffInvitation({ ...invitationRequest, username: `alma+<tag>&"'@example.invalid` });
});

test('staff invitation only accepts its trusted HTTPS activation route with one fixed bearer token', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const activationUrl of [
    invitationRequest.activationUrl.replace('https:', 'http:'),
    invitationRequest.activationUrl.replace('app.scrapplanner.com', 'attacker.example'),
    invitationRequest.activationUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com.attacker.example'),
    invitationRequest.activationUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com:444'),
    invitationRequest.activationUrl.replace('app.scrapplanner.com', 'user:password@app.scrapplanner.com'),
    invitationRequest.activationUrl.replace('/kontor/', '/kund/'), resetRequest.resetUrl,
    invitationRequest.activationUrl.replace('/kontor/', '/kontor/?next=bad'),
    `${invitationRequest.activationUrl}&next=https://attacker.example`,
    `${invitationRequest.activationUrl}A`, invitationRequest.activationUrl.slice(0, -1),
    `${invitationRequest.activationUrl}\n`, `${invitationRequest.activationUrl}" onclick="alert(1)`,
    'javascript:alert(1)', '<a href="https://attacker.example">Activate</a>',
  ]) await rejects(adapter.sendStaffInvitation({ ...invitationRequest, activationUrl }), 'system_email_invalid', 422);
  const custom = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL: 'https://office.example.invalid' },
    fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).html, /href="https:\/\/office.example.invalid\/kontor\/#\/activate-account\?token=/);
      return response();
    } });
  await rejects(custom.sendStaffInvitation(invitationRequest), 'system_email_invalid', 422);
  assert.deepEqual(await custom.sendStaffInvitation({ ...invitationRequest,
    activationUrl: invitationRequest.activationUrl.replace('app.scrapplanner.com', 'office.example.invalid') }), { providerId });
});

test('staff invitation validates fixed fields, recipient, names and exact 24 hour lifespan before provider access', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, {}, [],
    { ...invitationRequest, to: 'Name <alma@example.invalid>' }, { ...invitationRequest, to: ['alma@example.invalid'] },
    { ...invitationRequest, to: 'alma@example.invalid\r\nBcc:attacker@example.invalid' },
    { ...invitationRequest, requestId: 'not-a-uuid' }, { ...invitationRequest, createdAt: 'yesterday' },
    { ...invitationRequest, expiresAt: 'tomorrow' }, { ...invitationRequest, expiresAt: resetRequest.expiresAt },
    { ...invitationRequest, expiresAt: '2026-10-21T09:59:59.000Z' }, { ...invitationRequest, expiresAt: '2026-10-21T10:00:01.000Z' },
    ...['', ' ', 'Unsafe\nHeader', 'x'.repeat(201), 'ﬀ'.repeat(101)].flatMap(value =>
      [{ ...invitationRequest, name: value }, { ...invitationRequest, companyName: value }]),
    ...['', 'alma staff', 'alma\r\nname', 'x'.repeat(255)].map(username => ({ ...invitationRequest, username })),
    { ...invitationRequest, password: 'Never-In-Email' }, { ...invitationRequest, subject: 'untrusted HTML' },
    { ...invitationRequest, from: 'attacker@example.invalid' }, { ...invitationRequest, attachments: [] },
  ]) await rejects(adapter.sendStaffInvitation(invalid), 'system_email_invalid', 422);
  for (const APP_URL of ['http://app.scrapplanner.com', 'https://user:password@app.scrapplanner.com',
    'https://app.scrapplanner.com/kontor/', 'https://app.scrapplanner.com?next=bad', 'not-a-url']) {
    const invalidOrigin = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL }, fetchImpl: () => assert.fail('must not fetch') });
    await rejects(invalidOrigin.sendStaffInvitation(invitationRequest), 'system_email_invalid', 422);
  }
});

test('staff invitation errors retain safe classifications without exposing recipient, proof or provider data', async () => {
  const privateData = `${key} ${invitationRequest.to} ${invitationRequest.activationUrl} PRIVATE-PROVIDER-DATA`;
  for (const [makeResponse, code, status] of [
    [() => response({ message: privateData }, 403), 'system_email_rejected', 503],
    [() => response({ message: privateData }, 429), 'system_email_rate_limited', 429],
    [() => response({ name: 'invalid_idempotent_request', message: privateData }, 409), 'system_email_idempotency_conflict', 409],
    [() => response({ name: 'concurrent_idempotent_requests', message: privateData }, 409), 'system_email_outcome_unknown', 503],
    [() => response({ message: privateData }, 500), 'system_email_outcome_unknown', 503],
    [() => new Response(privateData, { status: 403 }), 'system_email_rejected', 503],
    [() => new Response('not-json'), 'system_email_outcome_unknown', 503],
    [() => response({ id: providerId, ignored: 'x'.repeat(16384) }), 'system_email_outcome_unknown', 503],
  ]) {
    let calls = 0;
    const adapter = client(async () => { calls++; return makeResponse(); });
    await assert.rejects(adapter.sendStaffInvitation(invitationRequest), error => {
      assert.ok(error instanceof SystemEmailError); assert.equal(error.code, code); assert.equal(error.status, status);
      for (const secret of [key, invitationRequest.to, invitationRequest.activationUrl, resetToken, 'PRIVATE-PROVIDER-DATA']) {
        assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      }
      assert.ok(!error.message.includes('testmejl'));
      return true;
    });
    assert.equal(calls, 1);
  }
  await rejects(createSystemEmail({ env: {}, fetchImpl: () => assert.fail('must not fetch') }).sendStaffInvitation(invitationRequest), 'system_email_not_configured');
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    await rejects(client(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 }).sendStaffInvitation(invitationRequest), 'system_email_outcome_unknown');
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort(new Error(invitationRequest.activationUrl));
    await rejects(client(() => assert.fail('must not fetch')).sendStaffInvitation(invitationRequest, { signal: controller.signal }), 'system_email_outcome_unknown');
  } finally { clearTimeout(keepAlive); }
});

test('customer approval email keeps company branding, a fixed sender, an opaque link and stable request idempotency', async () => {
  const calls = [];
  const adapter = client(async (url, options) => {
    assert.equal(url, RESEND_EMAIL_URL); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    calls.push({ body: options.body, key: options.headers['Idempotency-Key'] });
    const message = JSON.parse(options.body);
    assert.equal(message.from, SYSTEM_EMAIL_FROM); assert.deepEqual(message.to, [approvalRequest.to]);
    assert.equal(message.subject, `${approvalRequest.companyName} · Godkänn ditt vägda underlag`);
    assert.ok(message.text.includes(approvalRequest.approvalUrl));
    assert.ok(message.html.includes(`href="${approvalRequest.approvalUrl}"`));
    assert.match(message.html, /Testbolaget &amp; Återvinning &lt;AB&gt;/);
    assert.ok(!message.html.includes(approvalRequest.companyName));
    for (const content of [message.text, message.html]) {
      assert.match(content, /legitimation fysiskt/); assert.match(content, /inte en BankID-signering/);
      assert.match(content, /svensk tid/); assert.match(content, /personlig/); assert.match(content, /Skickat via ScrapPlanner/);
      assert.match(content, /EndorGroup/);
    }
    assert.deepEqual(Object.keys(message).sort(), ['from', 'html', 'subject', 'text', 'to']);
    return response({ id: providerId, ignored: 'PRIVATE-PROVIDER-DATA' });
  });
  assert.deepEqual(await adapter.sendCustomerApproval(approvalRequest), { providerId });
  assert.deepEqual(await adapter.sendCustomerApproval({ ...approvalRequest }), { providerId });
  assert.equal(calls[0].key, `customer-approval/${request.requestId}`); assert.deepEqual(calls[0], calls[1]);
});

test('customer approval email only uses the trusted HTTPS origin, public path and one fragment token', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const approvalUrl of [
    approvalRequest.approvalUrl.replace('https:', 'http:'),
    approvalRequest.approvalUrl.replace('app.scrapplanner.com', 'attacker.example'),
    approvalRequest.approvalUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com.attacker.example'),
    approvalRequest.approvalUrl.replace('app.scrapplanner.com', 'app.scrapplanner.com:444'),
    approvalRequest.approvalUrl.replace('app.scrapplanner.com', 'user:password@app.scrapplanner.com'),
    approvalRequest.approvalUrl.replace('/godkann/', '/kontor/'),
    approvalRequest.approvalUrl.replace('/godkann/', '/godkann/?company=untrusted'),
    approvalRequest.approvalUrl.replace('#token=', '?token='),
    `${approvalRequest.approvalUrl}&token=${resetToken}`, `${approvalRequest.approvalUrl}&company=untrusted`,
    `${approvalRequest.approvalUrl}A`, approvalRequest.approvalUrl.slice(0, -1),
    `${approvalRequest.approvalUrl}\n`, `${approvalRequest.approvalUrl}" onclick="alert(1)`,
    'javascript:alert(1)', '<a href="https://attacker.example">Approve</a>',
  ]) await rejects(adapter.sendCustomerApproval({ ...approvalRequest, approvalUrl }), 'system_email_invalid', 422);
  const custom = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL: 'https://pilot.example.invalid' },
    fetchImpl: async (_url, options) => {
      assert.match(JSON.parse(options.body).html, /href="https:\/\/pilot.example.invalid\/godkann\/#token=/);
      return response();
    } });
  await rejects(custom.sendCustomerApproval(approvalRequest), 'system_email_invalid', 422);
  assert.deepEqual(await custom.sendCustomerApproval({ ...approvalRequest,
    approvalUrl: approvalRequest.approvalUrl.replace('app.scrapplanner.com', 'pilot.example.invalid') }), { providerId });
});

test('customer approval email validates recipient, bounded positive lifespan and fixed metadata before provider access', async () => {
  const adapter = client(() => assert.fail('must not fetch'));
  for (const invalid of [null, {}, [],
    { ...approvalRequest, to: 'Name <user@example.invalid>' }, { ...approvalRequest, to: ['user@example.invalid'] },
    { ...approvalRequest, to: 'user@example.invalid\r\nBcc:attacker@example.invalid' },
    { ...approvalRequest, requestId: 'not-a-uuid' }, { ...approvalRequest, createdAt: 'yesterday' },
    { ...approvalRequest, expiresAt: 'tomorrow' }, { ...approvalRequest, expiresAt: request.createdAt },
    { ...approvalRequest, expiresAt: '2026-10-20T09:59:59.000Z' }, { ...approvalRequest, expiresAt: '2026-10-21T10:00:01.000Z' },
    ...['', ' ', 'Unsafe\nHeader', 'x'.repeat(201), 'ﬀ'.repeat(101)].map(companyName => ({ ...approvalRequest, companyName })),
    { ...approvalRequest, subject: 'arbitrary subject' }, { ...approvalRequest, from: 'attacker@example.invalid' },
    { ...approvalRequest, attachments: [] }, { ...approvalRequest, customerName: 'Private Name' },
    { ...approvalRequest, bankAccount: 'PRIVATE-BANK-ACCOUNT' },
  ]) await rejects(adapter.sendCustomerApproval(invalid), 'system_email_invalid', 422);
  for (const APP_URL of ['http://app.scrapplanner.com', 'https://user:password@app.scrapplanner.com',
    'https://app.scrapplanner.com/kontor/', 'https://app.scrapplanner.com?next=bad', 'https://app.scrapplanner.com/#bad', 'not-a-url']) {
    const invalidOrigin = createSystemEmail({ env: { RESEND_API_KEY: key, APP_URL }, fetchImpl: () => assert.fail('must not fetch') });
    await rejects(invalidOrigin.sendCustomerApproval(approvalRequest), 'system_email_invalid', 422);
  }
  const accepted = client(async () => response());
  assert.deepEqual(await accepted.sendCustomerApproval({ ...approvalRequest, expiresAt: '2026-10-20T10:01:00.000Z' }), { providerId });
});

test('customer approval email retains safe delivery classifications, bounded reads and cancellation without retries', async () => {
  const privateData = `${key} ${approvalRequest.to} ${approvalRequest.approvalUrl} PRIVATE-PROVIDER-DATA`;
  for (const [makeResponse, code, status] of [
    [() => response({ message: privateData }, 403), 'system_email_rejected', 503],
    [() => response({ message: privateData }, 429), 'system_email_rate_limited', 429],
    [() => response({ name: 'invalid_idempotent_request', message: privateData }, 409), 'system_email_idempotency_conflict', 409],
    [() => response({ name: 'concurrent_idempotent_requests', message: privateData }, 409), 'system_email_outcome_unknown', 503],
    [() => response({ message: privateData }, 500), 'system_email_outcome_unknown', 503],
    [() => new Response(privateData, { status: 403 }), 'system_email_rejected', 503],
    [() => new Response('not-json'), 'system_email_outcome_unknown', 503],
    [() => response({ id: key }), 'system_email_outcome_unknown', 503],
    [() => response({ id: providerId, ignored: 'x'.repeat(16384) }), 'system_email_outcome_unknown', 503],
    [() => response({ id: providerId }, 200, { 'content-length': '999999' }), 'system_email_outcome_unknown', 503],
    [() => { throw new Error(privateData); }, 'system_email_outcome_unknown', 503],
  ]) {
    let calls = 0;
    const adapter = client(async () => { calls++; return makeResponse(); });
    await assert.rejects(adapter.sendCustomerApproval(approvalRequest), error => {
      assert.ok(error instanceof SystemEmailError); assert.equal(error.code, code); assert.equal(error.status, status);
      for (const secret of [key, approvalRequest.to, approvalRequest.approvalUrl, resetToken, 'PRIVATE-PROVIDER-DATA']) {
        assert.ok(!error.message.includes(secret)); assert.ok(!JSON.stringify(error).includes(secret));
      }
      assert.ok(!/testmejl|testets|nytt test/i.test(error.message));
      return true;
    });
    assert.equal(calls, 1);
  }
  await rejects(createSystemEmail({ env: {}, fetchImpl: () => assert.fail('must not fetch') }).sendCustomerApproval(approvalRequest), 'system_email_not_configured');
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let calls = 0;
    await rejects(client(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 20 }).sendCustomerApproval(approvalRequest), 'system_email_outcome_unknown');
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort(new Error(approvalRequest.approvalUrl));
    await rejects(client(() => assert.fail('must not fetch')).sendCustomerApproval(approvalRequest, { signal: controller.signal }), 'system_email_outcome_unknown');
  } finally { clearTimeout(keepAlive); }
});
