import test from 'node:test';
import assert from 'node:assert/strict';
import { createMicrosoftMailClient, MicrosoftMailError } from './microsoft-mail-client.mjs';

const settings = overrides => ({ MICROSOFT_MAIL_CLIENT_ID: 'fixture-client', MICROSOFT_MAIL_CLIENT_SECRET: 'fixture-client-secret',
  MAIL_REDIRECT_URI: 'https://app.example/api/integrations/microsoft-mail/callback', ...overrides });
const scopes = ['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'openid', 'profile', 'offline_access'];
const clock = 1791882000000;
const message = id => ({ id, subject: `Subject ${id}`, from: { emailAddress: { name: 'Sender', address: 'sender@example.test' } },
  receivedDateTime: '2026-10-13T09:00:00Z', isRead: false, bodyPreview: 'Preview', hasAttachments: false });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mock(handler, overrides = {}) {
  const calls = [];
  const client = createMicrosoftMailClient({ env: settings(), now: () => clock, ...overrides,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), ...options, body: options.body?.toString() });
      return handler(String(url), options, calls.length);
    } });
  return { client, calls };
}
const tokenReply = extras => ({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'Bearer',
  expires_in: 3600, scope: scopes.join(' '), ...extras });
const codeOptions = () => ({ code: 'fixture-callback-code', verifier: 'v'.repeat(64) });
const rejected = (code, status) => error => error instanceof MicrosoftMailError && error.code === code && (status === undefined || error.status === status);

test('configuration reports missing names, supports Render callback and limits development HTTP callbacks', () => {
  assert.deepEqual(createMicrosoftMailClient({ env: {} }).configuration().missing,
    ['MICROSOFT_MAIL_CLIENT_ID', 'MICROSOFT_MAIL_CLIENT_SECRET', 'MAIL_REDIRECT_URI']);
  const config = createMicrosoftMailClient({ env: settings({ MAIL_REDIRECT_URI: undefined, RENDER_EXTERNAL_URL: 'https://render.example/' }) }).configuration();
  assert.equal(config.ready, true); assert.equal(config.redirectUri, 'https://render.example/api/integrations/microsoft-mail/callback');
  assert.deepEqual(config.scopes, scopes);
  assert.equal(JSON.stringify(config).includes('fixture-client-secret'), false);
  for (const hostname of ['localhost', '127.0.0.1']) {
    assert.equal(createMicrosoftMailClient({ env: settings({ MAIL_REDIRECT_URI: `http://${hostname}:3000/callback` }) }).configuration().ready, true);
    assert.equal(createMicrosoftMailClient({ env: settings({ MAIL_REDIRECT_URI: `http://${hostname}:3000/callback`, NODE_ENV: 'production' }) }).configuration().ready, false);
  }
  for (const value of ['http://app.example/callback', 'https://user:password@app.example/callback', 'https://app.example/callback#fragment'])
    assert.equal(createMicrosoftMailClient({ env: settings({ MAIL_REDIRECT_URI: value }) }).configuration().ready, false);
  assert.equal(createMicrosoftMailClient({ env: settings({ MICROSOFT_MAIL_TENANT_ID: '../evil?query' }) }).configuration().ready, false);
});

test('authorization URL uses fixed tenant endpoint, delegated read scopes, state and S256 PKCE', () => {
  const { client, calls } = mock(() => { throw new Error('OAuth URL building makes no request'); });
  const url = new URL(client.authorisationUrl({ state: 's'.repeat(32), challenge: 'c'.repeat(43), loginHint: 'person+mail@example.test' }));
  assert.equal(url.origin, 'https://login.microsoftonline.com'); assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('scope'), scopes.join(' ')); assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('response_mode'), 'query'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'c'.repeat(43)); assert.equal(url.searchParams.get('state'), 's'.repeat(32));
  assert.equal(url.searchParams.get('login_hint'), 'person+mail@example.test');
  assert.equal(url.toString().includes('fixture-client-secret'), false); assert.equal(calls.length, 0);
  assert.throws(() => client.authorisationUrl({ state: 'short', challenge: 'c'.repeat(43) }), rejected('microsoft_mail_authorisation_invalid', 422));
});

test('code redemption and refresh are form encoded; expiry and rotating refresh credentials are preserved', async () => {
  const { client, calls } = mock((_url, _options, call) => json(tokenReply(call === 2 ? { refresh_token: 'rotated-refresh-token' } : call === 3 ? { refresh_token: undefined } : {})));
  const first = await client.exchangeCode(codeOptions());
  assert.deepEqual(first, { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: clock + 3600000, scopes });
  const form = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].url, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form.get('client_id'), 'fixture-client'); assert.equal(form.get('client_secret'), 'fixture-client-secret');
  assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), 'fixture-callback-code');
  assert.equal(form.get('code_verifier'), 'v'.repeat(64)); assert.equal(form.get('redirect_uri'), settings().MAIL_REDIRECT_URI);
  assert.equal(form.get('scope'), scopes.join(' '));
  const rotated = await client.refreshToken({ refreshToken: first.refreshToken }); assert.equal(rotated.refreshToken, 'rotated-refresh-token');
  const retained = await client.refreshToken({ refreshToken: rotated.refreshToken }); assert.equal(retained.refreshToken, 'rotated-refresh-token');
  const refresh = new URLSearchParams(calls[1].body);
  assert.equal(refresh.get('grant_type'), 'refresh_token'); assert.equal(refresh.get('refresh_token'), 'fixture-refresh-token');
  assert.equal(refresh.get('scope'), scopes.join(' ')); assert.equal(refresh.has('code'), false);
  assert.equal(calls.length, 3);
});

test('tokens with send permission, missing refresh credentials or invalid expiry are rejected safely', async () => {
  for (const response of [tokenReply({ scope: 'Mail.Send User.Read' }), tokenReply({ refresh_token: undefined }), tokenReply({ expires_in: -1 })]) {
    const { client } = mock(() => json(response));
    await assert.rejects(() => client.exchangeCode(codeOptions()), error => {
      assert.equal(error instanceof MicrosoftMailError, true);
      for (const secret of ['fixture-access-token', 'fixture-refresh-token', 'fixture-client-secret', 'fixture-callback-code'])
        assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes(secret), false);
      return true;
    });
  }
});

test('documented resource-qualified and URL-encoded token scopes normalize to permission names', async () => {
  const { client } = mock(() => json(tokenReply({ scope: 'https%3A%2F%2Fgraph.microsoft.com%2Fmail.read https://graph.microsoft.com/User.Read openid profile' })));
  assert.deepEqual((await client.exchangeCode(codeOptions())).scopes, ['Mail.Read', 'User.Read', 'openid', 'profile']);
});

test('Microsofts documented email profile claim is accepted only in token responses without expanding requested access', async () => {
  const {client,calls}=mock(()=>json(tokenReply({scope:'openid profile email https://graph.microsoft.com/User.Read Mail.Read Mail.Read.Shared'})));
  const token=await client.exchangeCode(codeOptions());
  assert.deepEqual(token.scopes,['openid','profile','email','User.Read','Mail.Read','Mail.Read.Shared']);
  assert.equal(new URLSearchParams(calls[0].body).get('scope'),scopes.join(' '));
  assert.equal(client.configuration().scopes.includes('email'),false);
  const url=new URL(client.authorisationUrl({state:'s'.repeat(32),challenge:'c'.repeat(43)}));
  assert.equal(url.searchParams.get('scope'),scopes.join(' '));
  for(const scope of ['openid profile email Mail.Send','openid email Mail.ReadWrite.Shared','email api://other-resource/read']){
    const denied=mock(()=>json(tokenReply({scope})));
    await assert.rejects(()=>denied.client.exchangeCode(codeOptions()),rejected('microsoft_mail_scope_invalid'));
  }
});

test('omitted granted scopes remain unknown instead of claiming shared-mailbox access', async () => {
  const {client}=mock(()=>json(tokenReply({scope:undefined})));
  assert.deepEqual((await client.exchangeCode(codeOptions())).scopes,[]);
  for(const scope of ['',null]){
    const denied=mock(()=>json(tokenReply({scope})));
    await assert.rejects(()=>denied.client.exchangeCode(codeOptions()),rejected('microsoft_mail_scope_invalid'));
  }
});

test('me uses Graph GET with immutable IDs and selects only the account identity', async () => {
  const { client, calls } = mock(() => json({ id: 'user-id', displayName: 'User', mail: null, userPrincipalName: 'user@example.test', extra: 'not exposed' }));
  assert.deepEqual(await client.me('fixture-access-token'), { id: 'user-id', displayName: 'User', mail: null, userPrincipalName: 'user@example.test' });
  const url = new URL(calls[0].url); assert.equal(url.origin, 'https://graph.microsoft.com'); assert.equal(url.pathname, '/v1.0/me');
  assert.equal(url.searchParams.get('$select'), 'id,displayName,mail,userPrincipalName');
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].headers.Authorization, 'Bearer fixture-access-token');
  assert.equal(calls[0].headers.Prefer, 'IdType="ImmutableId"');
});

test('message list follows complete next links including empty pages, bounds records and applies headers on every page', async () => {
  const second = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=987&$skiptoken=opaque%2Bcursor';
  const third = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=1234';
  const { client, calls } = mock((_url, _options, call) => json(call === 1 ? { value: [], '@odata.nextLink': second }
    : call === 2 ? { value: Array.from({ length: 30 }, (_, i) => message(`second-${i}`)), '@odata.nextLink': third }
      : { value: Array.from({ length: 30 }, (_, i) => message(`third-${i}`)) }));
  const result = await client.listMessages({ accessToken: 'fixture-access-token', mailbox: 'me', maxCount: 50 });
  assert.equal(result.messages.length, 50); assert.equal(result.hasMore, true); assert.equal(calls.length, 3);
  assert.equal(calls[1].url, second); assert.equal(calls[2].url, third);
  const first = new URL(calls[0].url); assert.equal(first.searchParams.get('$top'), '50');
  assert.equal(first.pathname, '/v1.0/me/mailFolders/inbox/messages');
  assert.equal(first.searchParams.get('$orderby'), 'receivedDateTime desc'); assert.equal(first.searchParams.get('$select').includes('body,'), false);
  for (const call of calls) { assert.equal(call.method, 'GET'); assert.equal(call.redirect, 'error'); assert.equal(call.headers.Prefer, 'IdType="ImmutableId"'); }
  assert.deepEqual(result.messages[0], message('second-0'));
});

test('message paging stops after three requests and reports additional pages', async () => {
  const { client, calls } = mock((_url, _options, call) => json({ value: [message(`page-${call}`)],
    '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=${call}` }));
  const result = await client.listMessages({ accessToken: 'fixture-access-token' });
  assert.equal(calls.length, 3); assert.equal(result.messages.length, 3); assert.equal(result.hasMore, true);
});

test('unsafe, cross mailbox, credential-bearing and circular paging links never receive bearer credentials', async () => {
  const links = ['https://attacker.example/messages', 'http://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/users/other@example.test/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/messages', 'https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages',
    'https://user:password@graph.microsoft.com/v1.0/me/mailFolders/inbox/messages',
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages#fragment'];
  for (const next of links) {
    const { client, calls } = mock(() => json({ value: [message('message-1')], '@odata.nextLink': next }));
    await assert.rejects(() => client.listMessages({ accessToken: 'private-bearer-token' }), error => {
      assert.equal(rejected('microsoft_mail_paging_invalid')(error), true);
      assert.equal(`${JSON.stringify(error)} ${error.stack}`.includes('private-bearer-token'), false);
      return true;
    });
    assert.equal(calls.length, 1); assert.equal(new URL(calls[0].url).origin, 'https://graph.microsoft.com');
  }
  const { client, calls } = mock(url => json({ value: [], '@odata.nextLink': url }));
  await assert.rejects(() => client.listMessages({ accessToken: 'fixture-access-token' }), rejected('microsoft_mail_paging_invalid'));
  assert.equal(calls.length, 1);
});

test('shared mailbox listing selects its inbox while detail collection remains independent', async () => {
  const { client, calls } = mock(() => json({ value: [message('shared-message')] }));
  await client.listMessages({ accessToken: 'fixture-access-token', mailbox: 'team@example.test' });
  assert.equal(new URL(calls[0].url).pathname, '/v1.0/users/team%40example.test/mailFolders/inbox/messages');
});

test('single shared message requests plaintext and separately selects attachment metadata without bytes', async () => {
  const { client, calls } = mock((_url, _options, call) => json(call === 1 ? { ...message('immutable/id+value'),
    body: { contentType: 'text', content: 'Hello\nPlain text.' }, toRecipients: [{ emailAddress: { name: 'Team', address: 'team@example.test' } }],
    webLink: 'https://outlook.office.com/mail/message', unexpected: 'not exposed' }
    : { value: [{ id: 'attachment-1', name: 'invoice.pdf', size: 8192, contentType: 'application/pdf', contentBytes: 'never-return-this-binary' }] }));
  const result = await client.getMessage({ accessToken: 'fixture-access-token', mailbox: 'team@example.test', messageId: 'immutable/id+value' });
  assert.equal(calls.length, 2);
  const detail = new URL(calls[0].url), attachments = new URL(calls[1].url);
  assert.equal(detail.pathname, '/v1.0/users/team%40example.test/messages/immutable%2Fid%2Bvalue');
  assert.equal(calls[0].headers.Prefer, 'IdType="ImmutableId", outlook.body-content-type="text"');
  assert.equal(attachments.pathname, `${detail.pathname}/attachments`); assert.equal(attachments.searchParams.get('$select'), 'id,name,size,contentType');
  assert.equal(calls[1].headers.Prefer, 'IdType="ImmutableId"'); assert.equal(detail.searchParams.has('$expand'), false);
  assert.deepEqual(result.body, { contentType: 'text', content: 'Hello\nPlain text.' });
  assert.deepEqual(result.attachments, [{ id: 'attachment-1', name: 'invoice.pdf', size: 8192, contentType: 'application/pdf' }]);
  assert.equal(result.attachmentsHasMore, false); assert.equal(JSON.stringify(result).includes('contentBytes'), false);
  assert.equal(JSON.stringify(result).includes('never-return-this-binary'), false); assert.equal(result.unexpected, undefined);
});

test('unexpected HTML bodies are rejected and unsafe attachment paging is never followed', async () => {
  const html = mock(() => json({ ...message('message-1'), body: { contentType: 'html', content: '<script>untrusted</script>' } }));
  await assert.rejects(() => html.client.getMessage({ accessToken: 'fixture-access-token', messageId: 'message-1' }), rejected('microsoft_mail_body_invalid'));
  assert.equal(html.calls.length, 1);
  const unsafe = mock((_url, _options, call) => json(call === 1 ? { ...message('message-1'), body: { contentType: 'text', content: 'Hello' } }
    : { value: [], '@odata.nextLink': 'https://attacker.example/attachments' }));
  await assert.rejects(() => unsafe.client.getMessage({ accessToken: 'fixture-access-token', messageId: 'message-1' }), rejected('microsoft_mail_paging_invalid'));
  assert.equal(unsafe.calls.length, 2);
});

test('a message returned for a different or differently cased immutable ID is rejected before attachment lookup', async () => {
  for (const id of ['other-message', 'MESSAGE-1']) {
    const { client, calls } = mock(() => json({ ...message(id), body: { contentType: 'text', content: 'Wrong message' } }));
    await assert.rejects(() => client.getMessage({ accessToken: 'fixture-access-token', messageId: 'message-1' }), rejected('microsoft_mail_response_invalid'));
    assert.equal(calls.length, 1);
  }
});

test('invalid mailbox, IDs, credentials and callback inputs fail before HTTP', async () => {
  const { client, calls } = mock(() => { throw new Error('Invalid local arguments must not be fetched'); });
  await assert.rejects(() => client.listMessages({ accessToken: 'fixture-access-token', mailbox: '../users/other' }), rejected('microsoft_mail_mailbox_invalid', 422));
  await assert.rejects(() => client.listMessages({ accessToken: 'fixture-access-token', maxCount: 51 }), rejected('microsoft_mail_count_invalid', 422));
  await assert.rejects(() => client.getMessage({ accessToken: 'fixture-access-token', messageId: '..' }), rejected('microsoft_mail_message_invalid', 422));
  await assert.rejects(() => client.me('Bearer\r\nInjected'), rejected('microsoft_mail_token_missing', 401));
  await assert.rejects(() => client.exchangeCode({ code: 'code', verifier: 'short' }), rejected('microsoft_mail_authorisation_invalid', 422));
  await assert.rejects(() => client.refreshToken({ refreshToken: '' }), rejected('microsoft_mail_token_missing', 401));
  assert.equal(calls.length, 0);
});

test('provider errors, malformed JSON and network failures expose no echoed tokens, code or secret and never retry', async () => {
  const reflected = 'fixture-access-token fixture-client-secret fixture-callback-code fixture-refresh-token';
  for (const status of [400, 401, 403, 404, 429, 500, 302]) {
    const { client, calls } = mock(() => new Response(reflected, { status }));
    await assert.rejects(() => client.exchangeCode(codeOptions()), error => {
      assert.equal(error instanceof MicrosoftMailError, true);
      const serialized = `${JSON.stringify(error)} ${error.stack}`;
      for (const secret of reflected.split(' ')) assert.equal(serialized.includes(secret), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const malformed = mock(() => new Response(reflected));
  await assert.rejects(() => malformed.client.me('fixture-access-token'), rejected('microsoft_mail_response_invalid'));
  const failed = mock(() => { throw new Error(reflected); });
  await assert.rejects(() => failed.client.me('fixture-access-token'), error => {
    assert.equal(rejected('microsoft_mail_unavailable', 502)(error), true); assert.equal(error.stack.includes(reflected), false); return true;
  });
  assert.equal(failed.calls.length, 1);
});

test('oversized successful responses and request timeouts are bounded without automatic retries', async () => {
  const huge = mock(() => new Response(JSON.stringify({ payload: 'x'.repeat(1024 * 1024) })));
  await assert.rejects(() => huge.client.me('fixture-access-token'), rejected('microsoft_mail_response_too_large'));
  assert.equal(huge.calls.length, 1);
  let calls = 0;
  const client = createMicrosoftMailClient({ env: settings(), timeoutMs: 100, fetchImpl: (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('Fixture exceeded the expected timeout')), 1000);
      options.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(new Error('Synthetic abort')); }, { once: true });
    });
  } });
  await assert.rejects(() => client.me('fixture-access-token'), rejected('microsoft_mail_timeout', 504));
  assert.equal(calls, 1);
});
