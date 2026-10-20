import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailApi } from './mail-api.mjs';
import { createApplicationService, initialApplicationState } from './application.mjs';

const context = Object.freeze({ organisationId: 'mail-company-a', actorId: 'actual-admin', effectiveUserId: 'mail-reader',
  sessionKey: 'private-platform-fixture-session', csrfToken: 'private-platform-fixture-csrf' });
const cookie = 'jeroc_platform=private-platform-fixture-cookie';

async function fixture(run) {
  const calls = [], behavior = new Map(); let trusted = context;
  const service = Object.fromEntries(['state', 'listMessages', 'message', 'connectMicrosoft', 'sync', 'disconnect', 'addMailbox', 'updateMailbox']
    .map(name => [name, async (...args) => {
      calls.push({ name, input: args.slice(0, -1), context: args.at(-1) });
      if (behavior.has(name)) return behavior.get(name)(...args);
      return { operation: name };
    }]));
  const api = createMailApi({ service, organisationId: context.organisationId,
    resolveContext: async req => req.headers.cookie === cookie ? trusted : undefined });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', value, raw, headers = {}, authenticated = true } = {}) => {
    const response = await fetch(base + '/api/mail' + path, { method,
      headers: { ...(authenticated ? { Cookie: cookie, 'X-Platform-CSRF': context.csrfToken } : {}),
        ...(value !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(value !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(value) } : {}) });
    return { response, value: method === 'HEAD' ? undefined : await response.json().catch(() => undefined) };
  };
  try { await run({ calls, behavior, request, trusted: value => { trusted = value; } }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('mail API requires trusted platform context and never accepts client tenant or principal claims', async () => fixture(async f => {
  const spoofed = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin', 'X-Client-Company': 'mail-company-b',
    'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin', 'X-Platform-CSRF': context.csrfToken };
  assert.equal((await f.request('/state', { authenticated: false, headers: spoofed })).response.status, 401);
  assert.equal(f.calls.length, 0);
  f.trusted({ ...context, organisationId: 'mail-company-b' });
  assert.equal((await f.request('/state')).response.status, 401); assert.equal(f.calls.length, 0);
  f.trusted(context);
  const read = await f.request('/state?organisationId=mail-company-b', { headers: spoofed });
  assert.equal(read.response.status, 200); assert.equal(f.calls[0].context, context);
  assert.equal(read.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(read.response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(JSON.stringify(read.value).includes(context.sessionKey), false);
  assert.equal(JSON.stringify(read.value).includes(context.csrfToken), false);
}));

test('mail writes require session CSRF and same origin before any OAuth or mailbox action', async () => fixture(async f => {
  assert.equal((await f.request('/microsoft/connect', { method: 'POST', value: {}, headers: { 'X-Platform-CSRF': '' } })).response.status, 403);
  assert.equal((await f.request('/microsoft/connect', { method: 'POST', value: {}, headers: { Origin: 'https://attacker.invalid' } })).response.status, 403);
  assert.equal((await f.request('/sync', { method: 'POST', value: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).response.status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request('/microsoft/connect', { method: 'POST', value: {} })).response.status, 200);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].name, 'connectMicrosoft'); assert.equal(f.calls[0].context, context);
}));

test('mail payload and filter allowlists reject credentials, tenant injection, provider writes and oversized input', async () => fixture(async f => {
  for (const [path, method, value] of [
    ['/sync', 'POST', { mailboxId: 'box-a', organisationId: 'mail-company-b' }],
    ['/microsoft/connect', 'POST', { scopes: ['Mail.ReadWrite'] }],
    ['/mailboxes', 'POST', { connectionId: 'connection-a', address: 'shared@example.invalid', accessToken: 'private-synthetic-token' }],
    ['/mailboxes/box-a', 'PUT', { enabled: true, actorId: 'other-actor' }],
    ['/sync', 'POST', JSON.parse('{"__proto__":{"mailboxId":"other-box"}}')],
  ]) assert.equal((await f.request(path, { method, value })).response.status, 422);
  for (const raw of ['[]', 'null', '{']) assert.equal((await f.request('/sync', { method: 'POST', raw })).response.status, 422);
  assert.equal((await f.request('/sync', { method: 'POST', value: { mailboxId: 'x'.repeat(17000) } })).response.status, 413);
  for (const path of ['/messages?accessToken=private-synthetic-token', '/messages?unreadOnly=maybe', '/messages?search=' + 'x'.repeat(201)])
    assert.equal((await f.request(path)).response.status, 422);
  for (const [path, method] of [['/send', 'POST'], ['/mailboxes/box-a/messages/message-a/read', 'PATCH'],
    ['/mailboxes/box-a/messages/message-a', 'DELETE'], ['/microsoft/callback?code=synthetic', 'GET']])
    assert.equal((await f.request(path, { method, ...(method === 'GET' ? {} : { value: {} }) })).response.status, 404);
  assert.equal(f.calls.length, 0); assert.equal(Object.prototype.mailboxId, undefined);
}));

test('mail reads preserve encoded immutable IDs and bounded filters without selecting provider paths', async () => fixture(async f => {
  const mailbox = 'mailbox-a', message = 'AA+/immutable=id';
  assert.equal((await f.request(`/mailboxes/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(message)}`)).response.status, 200);
  assert.deepEqual(f.calls[0].input, [mailbox, message]); assert.equal(f.calls[0].context, context);
  assert.equal((await f.request('/messages?mailboxId=mailbox-a&unreadOnly=1&search=Customer%20name')).response.status, 200);
  assert.deepEqual(f.calls[1].input, [{ mailboxId: 'mailbox-a', unreadOnly: true, search: 'Customer name', cursor: undefined }]);
  const head = await f.request('/state', { method: 'HEAD' }); assert.equal(head.response.status, 200);
  assert.equal(head.value, undefined); assert.equal(f.calls[2].name, 'state');
  assert.equal((await f.request('/mailboxes/box-a/messages/%00')).response.status, 400);
  assert.equal(f.calls.length, 3);
}));

test('mail facade masks unexpected internal failures and retains only intentional public errors', async () => fixture(async f => {
  f.behavior.set('state', () => { throw new Error('private-synthetic-token/credential-file/path'); });
  const failure = await f.request('/state');
  assert.equal(failure.response.status, 503); assert.equal(failure.value.code, 'mail_unavailable');
  assert.equal(JSON.stringify(failure.value).includes('private-synthetic'), false);
  f.behavior.set('state', () => { throw Object.assign(new Error('Inkorgen är inte tillgänglig.'), { status: 403, code: 'mail_mailbox_forbidden' }); });
  const denied = await f.request('/state');
  assert.equal(denied.response.status, 403); assert.equal(denied.value.code, 'mail_mailbox_forbidden');
  assert.equal(denied.value.message, 'Inkorgen är inte tillgänglig.');
}));

test('private mail domain is excluded from generic business views and cannot be requested as an application projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-mail-projection-'));
  const app = createApplicationService({ env: { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') },
    seed: () => ({ ...initialApplicationState(), mailIntegration: { organisationId: 'jeroc-demo',
      connection: { refreshToken: 'private-refresh-fixture' }, message: { body: 'private-email-body-fixture' } } }) });
  // The transport projection in this privacy test needs an explicitly
  // all-facility principal after the safe startup migration.
  await (await app.getRepository()).transact(state => { delete state.pricing.users.find(user => user.id === 'admin').siteIds; });
  const server = createServer(async (req, res) => { if (!await app(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/application`;
    const read = path => fetch(base + path, { headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' } });
    for (const path of ['/office', '/mobile', '/transport']) {
      const response = await read(path); assert.equal(response.status, 200);
      const body = await response.text();
      for (const privateValue of ['mailIntegration', 'private-refresh-fixture', 'private-email-body-fixture']) assert.equal(body.includes(privateValue), false);
    }
    for (const path of ['/mailIntegration', '/revision?domain=mailIntegration']) assert.equal((await read(path)).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('real tenant gateway binds Microsoft mail state, catalog and OAuth return to the authenticated platform cookie', async () => {
  const { createTenantGateway } = await import('./tenant-gateway.mjs');
  const { createTenantServices } = await import('./tenant-services.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-mail-gateway-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'), JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'),
    JEROC_TENANT_DATA_DIR: directory, SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Local-Private-Mail-Gateway-Fixture-2026!' };
  let gateway, server; const calls = [];
  try {
    gateway = await createTenantGateway({ env, makeServices: async options => {
      const service = await createTenantServices(options), originalState = service.mailService.state;
      service.mailService.state = async context => { calls.push({ name: 'state', context }); return originalState(context); };
      // Exercise the real authenticated callback facade and context resolver;
      // replace only the provider workflow so no Microsoft request is possible.
      service.mailService.completeMicrosoft = async (query, context) => {
        const principal = await context.reauthorize();
        calls.push({ name: 'callback', query, context, principal }); return {};
      };
      return service;
    } });
    server = createServer((req, res) => { void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`, cookies = new Map(); let session;
    async function request(path, payload, extra = {}) {
      const response = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(session ? { 'X-Platform-CSRF': session.csrfToken, 'X-Platform-Generation': session.generation } : {}), ...extra },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      for (const raw of response.headers.getSetCookie()) {
        const [name, value] = raw.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name);
      }
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (body?.authenticated) session = body;
      return { response, body };
    }
    assert.equal((await request('/api/platform/login', { username: 'admin', password: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD })).response.status, 200);
    assert.equal((await request('/api/platform/change-password', { currentPassword: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD,
      newPassword: 'Changed-Local-Mail-Gateway-Fixture-2026!' })).response.status, 200);
    const state = await request('/api/mail/state');
    assert.equal(state.response.status, 200); assert.equal(state.body.configuration.ready, false);
    assert.deepEqual(state.body.mailboxes, []); assert.deepEqual(state.body.connections, []);
    assert.equal(state.body.organisationId, session.organisationId); assert.equal(cookies.has('jeroc_environment_staff'), false);
    const catalog = await request('/api/environment/integrations/catalog'); assert.equal(catalog.response.status, 200);
    const microsoft = catalog.body.providers.find(item => item.id === 'microsoft365');
    assert.ok(microsoft); assert.equal(microsoft.implemented, true); assert.notEqual(microsoft.status, 'error');
    const callbackPath = '/api/integrations/microsoft-mail/callback?state=synthetic-return-state&code=synthetic-return-code';
    const wrongCompany = await request(callbackPath, undefined, { 'X-Client-Company': 'other-company' });
    assert.equal(wrongCompany.response.status, 409); assert.equal(calls.filter(item => item.name === 'callback').length, 0);
    const returned = await request(callbackPath, undefined, { Origin: 'https://login.microsoftonline.com', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(returned.response.status, 303);
    assert.equal(returned.response.headers.get('Location'), '/kontor/#/integrations?service=microsoft365&mailAuth=ok');
    assert.equal(returned.response.headers.get('Referrer-Policy'), 'no-referrer');
    const before = calls.find(item => item.name === 'state').context, after = calls.find(item => item.name === 'callback').context;
    for (const key of ['organisationId', 'actorId', 'effectiveUserId', 'sessionKey']) assert.equal(after[key], before[key]);
    assert.equal(after.sessionKey.length, 64); assert.equal(calls.find(item => item.name === 'callback').principal.user.id, after.effectiveUserId);
    assert.equal(returned.response.headers.get('Location').includes('synthetic-return-code'), false);
    cookies.clear(); session = undefined;
    assert.equal((await request(callbackPath)).response.status, 401); assert.equal(calls.filter(item => item.name === 'callback').length, 1);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true });
  }
});
