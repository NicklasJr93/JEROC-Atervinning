import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { createCompanyLogoService, CompanyLogoError } from './company-logo.mjs';
import { createCompanyLogoRepository } from './company-logo-storage.mjs';
import { createCompanyLogoApi } from './company-logo-api.mjs';

const path = '/api/company-settings/logo';
const actor = () => ({ companyId: 'company-a', actorId: 'actor-a', userId: 'owner-a', canManage: true, scopeKey: 'session-a' });
const image = async () => ({ contentType: 'image/png', base64: (await sharp({ create: { width: 70, height: 30, channels: 3, background: '#223344' } }).png().toBuffer()).toString('base64') });
async function fixture(operation, { serviceOverride, authorizeOverride } = {}) {
  const repository = await createCompanyLogoRepository({ organisationId: 'company-a', filename: ':memory:', env: {} });
  const service = createCompanyLogoService({ organisationId: 'company-a', repository });
  let principal = actor(), authorizationCount = 0;
  const seen = [];
  const api = createCompanyLogoApi({ service: serviceOverride ?? service,
    authorize: authorizeOverride ?? (async (_req, options) => {
      authorizationCount++; seen.push(options);
      if (!principal) throw new CompanyLogoError('Logga in.', 401, 'session_required');
      return structuredClone(principal);
    }) });
  const failures = [];
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(error => { failures.push(error); res.writeHead(500); res.end(); }); });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (route, body, headers = {}, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${route}`, {
      method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    await operation({ request, service, seen, setPrincipal: value => { principal = value; }, get authorizationCount() { return authorizationCount; } });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.close();
    assert.deepEqual(failures, []);
  }
}

test('logo upload returns an immutable scoped URL and image reads reauthorize with private/no-store', () => fixture(async f => {
  const response = await f.request(path, await image());
  assert.equal(response.status, 201);
  const value = await response.json(); assert.match(value.logoId, /^[0-9a-f-]{36}$/); assert.equal(value.url, `/api/company-settings/logos/${value.logoId}`);
  const download = await f.request(value.url), bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('cache-control'), /private, no-store/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await sharp(bytes).metadata()).format, 'png');
  const head = await f.request(value.url, undefined, {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.ok(f.seen.some(value => value.write && !value.basic)); assert.ok(f.seen.some(value => !value.write && value.basic));
}));

test('anonymous, foreign-tenant and non-managing principals cannot upload or access a guessed image', () => fixture(async f => {
  f.setPrincipal(undefined);
  assert.equal((await f.request(path, await image(), { 'x-demo-actor': 'admin', 'x-client-company': 'company-a' })).status, 401);
  f.setPrincipal({ ...actor(), companyId: 'company-b' });
  assert.equal((await f.request(path, await image())).status, 403);
  assert.equal((await f.request('/api/company-settings/logos/00000000-0000-4000-8000-000000000001')).status, 403);
  f.setPrincipal({ ...actor(), canManage: false });
  assert.equal((await f.request(path, await image())).status, 403);
}));

test('foreign origins, query payloads, invalid methods, malformed JSON and MIME are rejected before upload', () => fixture(async f => {
  const payload = await image();
  assert.equal((await f.request(path, payload, { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await f.request(path, payload, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request(`${path}?company=company-b`, payload)).status, 422);
  assert.equal((await f.request(path)).status, 405);
  assert.equal((await f.request(path, payload, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.request(path, '{')).status, 400);
  assert.equal((await f.request(path, { ...payload, companyId: 'company-b' })).status, 415);
  assert.equal((await f.request('/api/company-settings/logos/invalid')).status, 404);
}));

test('logout while image storage is responding discards the pending image', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = { organisationId: 'company-a', async read() { await gate; return { bytes: Buffer.from('PRIVATE_IMAGE') }; } };
  await fixture(async f => {
    const pending = f.request('/api/company-settings/logos/00000000-0000-4000-8000-000000000001');
    while (!f.authorizationCount) await new Promise(resolve => setImmediate(resolve));
    f.setPrincipal(undefined); release();
    const response = await pending; assert.equal(response.status, 401); assert.ok(!(await response.text()).includes('PRIVATE_IMAGE'));
  }, { serviceOverride: service });
});

test('storage failures are safe and do not reveal paths or bytes', () => fixture(async f => {
  const response = await f.request('/api/company-settings/logos/00000000-0000-4000-8000-000000000001');
  assert.equal(response.status, 503); const value = await response.text();
  assert.ok(!value.includes('PRIVATE_IMAGE') && !value.includes('/secret/'));
}, { serviceOverride: { organisationId: 'company-a', async read() { throw Error('/secret/path PRIVATE_IMAGE'); } } }));

test('actor upload limiting persists across session rotation without leaking stored image content', () => fixture(async f => {
  const payload = await image();
  for (let index = 0; index < 10; index++) {
    f.setPrincipal({ ...actor(), scopeKey: `session-${index}` });
    assert.equal((await f.request(path, payload)).status, 201);
  }
  assert.equal((await f.request(path, payload)).status, 429);
}));


test('process-wide upload cap bounds concurrent decoding across tenant API instances and releases failed slots', async () => {
  let releaseFirst, releaseSecond, calls = 0;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise(resolve => { releaseSecond = resolve; });
  const fake = { organisationId: 'company-a', async upload() {
    const index = ++calls;
    if (index === 1) { await firstGate; throw Error('decoder failure'); }
    if (index === 2) await secondGate;
    return { logoId: '00000000-0000-4000-8000-000000000001', url: '/api/company-settings/logos/00000000-0000-4000-8000-000000000001' };
  } };
  try {
    await fixture(async a => fixture(async b => {
      const payload = await image();
      const first = a.request(path, payload), second = b.request(path, payload);
      while (calls < 2) await new Promise(resolve => setImmediate(resolve));
      const rejected = await a.request(path, payload);
      assert.equal(rejected.status, 429); assert.equal(rejected.headers.get('retry-after'), '2');
      assert.equal(calls, 2, 'third upload must stop before decoding or storage');
      releaseFirst();
      assert.equal((await first).status, 503);
      assert.equal((await b.request(path, payload)).status, 201, 'a decoder failure must release its process-wide slot');
      assert.equal(calls, 3);
      releaseSecond(); assert.equal((await second).status, 201);
    }, { serviceOverride: fake }), { serviceOverride: fake });
  } finally { releaseFirst(); releaseSecond(); }
});
