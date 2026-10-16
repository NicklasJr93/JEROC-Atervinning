import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createTestCarApi } from './telematics/testcar-api.mjs';
import { createTestCar } from './telematics/testcar-model.mjs';

async function fixture(t, settings = {}) {
  let clock = Date.parse('2026-10-16T12:00:00Z'), fallbacks = 0;
  const api = createTestCarApi({ autoTick: false, now: () => clock, ...settings });
  const server = createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { fallbacks++; res.writeHead(404); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function request(path, { session, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
    const response = await fetch(`${base}/api/testcar/${path}`, { method, headers: {
      ...(session && { cookie: session.cookie, 'x-testcar-csrf': session.csrfToken }),
      ...(body !== undefined && { 'content-type': 'application/json', origin: base }), ...headers,
    }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const data = await response.json();
    return { status: response.status, headers: response.headers, ...data };
  }
  const bootstrap = async () => {
    const result = await request('session');
    return { ...result, cookie: result.headers.get('set-cookie')?.split(';')[0] };
  };
  return { api, request, bootstrap, base, advance: amount => { clock += amount; api.tick(); }, fallbacks: () => fallbacks };
}

test('test cars are browser-isolated, synthetic-only and keep public requests out of tenant services', async t => {
  const f = await fixture(t), a = await f.bootstrap(), b = await f.bootstrap();
  assert.equal(a.status, 200); assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.csrfToken, b.csrfToken);
  assert.equal(a.car.simulated, true); assert.equal(a.car.currentPlace.id, 'office');
  assert.equal((await f.request('command', { session: a, body: { action: 'start' } })).car.engineOn, true);
  assert.equal((await f.request('state', { session: b })).car.engineOn, false);
  assert.equal((await f.request('state?session=other&tenant=other', { session: a })).car.engineOn, true);
  assert.equal(f.fallbacks(), 0);
});

test('current-place guard is enforced by HTTP command, including directly crafted requests', async t => {
  const f = await fixture(t), session = await f.bootstrap();
  await f.request('command', { session, body: { action: 'start' } });
  const before = (await f.request('state', { session })).car;
  const blocked = await f.request('command', { session, body: { action: 'drive', destination: 'office' } });
  assert.equal(blocked.status, 409); assert.ok(blocked.error);
  const after = (await f.request('state', { session })).car;
  assert.equal(after.mode, before.mode); assert.equal(after.currentPlace.id, 'office');
  assert.equal(after.stats.distanceKm, 0);
});

test('cross-site commands, a different sessions CSRF and forged cookies cannot control a car', async t => {
  const f = await fixture(t), a = await f.bootstrap(), b = await f.bootstrap();
  for (const headers of [
    { 'x-testcar-csrf': '' }, { 'x-testcar-csrf': b.csrfToken },
    { origin: 'https://another.example' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await f.request('command', { session: a, body: { action: 'start' }, headers })).status, 403);
  assert.equal((await f.request('state', { headers: { cookie: `scrappilot_testcar=${'f'.repeat(64)}` } })).status, 401);
  assert.equal((await f.request('state', { session: a })).car.engineOn, false);
});

test('strict input limits, methods and unknown lab routes return readable uncached errors', async t => {
  const f = await fixture(t), session = await f.bootstrap();
  const results = [
    [await f.request('command', { session, body: '{' }), 400],
    [await f.request('command', { session, body: 'x'.repeat(2050) }), 413],
    [await f.request('command', { session, body: '{}', headers: { 'content-type': 'text/plain' } }), 415],
    [await f.request('command', { session, body: { action: 'drive', destination: 'foreign' } }), 422],
    [await f.request('command', { session, body: { action: 'start', tenantId: 'real-customer' } }), 422],
    [await f.request('command', { session }), 405],
    [await f.request('anything', { session }), 404],
  ];
  for (const [result, status] of results) {
    assert.equal(result.status, status); assert.match(result.headers.get('cache-control'), /no-store/); assert.ok(result.error);
  }
  assert.equal(f.fallbacks(), 0);
});

test('idle expiration starts a clean car and cannot revive the old state', async t => {
  const f = await fixture(t, { idleMs: 1000 }), first = await f.bootstrap();
  await f.request('command', { session: first, body: { action: 'start' } });
  f.advance(1001);
  assert.equal((await f.request('state', { session: first })).status, 401);
  assert.equal((await f.request('command', { session: first, body: { action: 'start' } })).status, 401);
  const next = await f.bootstrap(); assert.notEqual(next.cookie, first.cookie); assert.equal(next.car.engineOn, false);
});

test('active sessions are not evicted at capacity, and capacity is reclaimed after expiry', async t => {
  const f = await fixture(t, { maxSessions: 2, idleMs: 1000 }), a = await f.bootstrap(), b = await f.bootstrap();
  const full = await f.bootstrap(); assert.equal(full.status, 429); assert.equal(full.code, 'testcar_capacity');
  assert.equal((await f.request('state', { session: a })).status, 200);
  assert.equal((await f.request('state', { session: b })).status, 200);
  f.advance(1001); assert.equal((await f.bootstrap()).status, 200);
});

test('command and bootstrap read budgets apply to the same session', async t => {
  const f = await fixture(t), session = await f.bootstrap();
  let limited = 0;
  for (let i = 0; i < 15; i++) {
    const response = await f.request('command', { session, body: { action: 'speed', timeScale: i % 2 ? 5 : 10 } });
    if (response.status === 429) { limited++; assert.equal(response.headers.get('retry-after'), '10'); }
  }
  assert.ok(limited > 0);
  const statuses = [];
  for (let i = 0; i < 15; i++) statuses.push((await f.request('session', { session })).status);
  assert.ok(statuses.includes(429));
});

test('server advances the car, bounds each tick and automatically stops an overlong engine run', async t => {
  const f = await fixture(t, { maxRunMs: 5000, idleMs: 60000 }), session = await f.bootstrap();
  await f.request('command', { session, body: { action: 'start' } });
  await f.request('command', { session, body: { action: 'drive', destination: 'customer1' } });
  f.advance(1000);
  const moving = (await f.request('state', { session })).car;
  assert.equal(moving.mode, 'driving'); assert.ok(moving.telemetry.speedKmh > 0); assert.equal(moving.currentPlace.id, null);
  f.advance(5001);
  const stopped = (await f.request('state', { session })).car;
  assert.equal(stopped.engineOn, false); assert.equal(stopped.telemetry.speedKmh, 0);
});

test('secure host-only cookies and no-store responses do not reuse business sessions', async t => {
  const f = await fixture(t, { env: { RENDER: 'true' } }), session = await f.bootstrap();
  const cookie = session.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Path=/api/testcar', 'Secure']) assert.ok(cookie.includes(flag));
  assert.equal(cookie.includes('Domain='), false); assert.match(session.headers.get('cache-control'), /no-store/);
  const state = await f.request('state', { headers: { cookie: 'jeroc_platform=some-company-session' } });
  assert.equal(state.status, 401); assert.equal(state.code, 'testcar_session_expired');
});

test('a broken synthetic model is removed without interrupting another car or the server tick', async t => {
  let broken = false, created = 0;
  const f = await fixture(t, { factory: () => {
    const car = createTestCar(), first = created++ === 0;
    return { ...car, snapshot: () => {
      if (first && broken) throw new Error('A synthetic model failed');
      return car.snapshot();
    } };
  } });
  const a = await f.bootstrap(), b = await f.bootstrap();
  await f.request('command', { session: a, body: { action: 'start' } });
  await f.request('command', { session: b, body: { action: 'start' } });
  broken = true; assert.doesNotThrow(() => f.advance(1000));
  assert.equal((await f.request('state', { session: a })).status, 401);
  const healthy = await f.request('state', { session: b });
  assert.equal(healthy.status, 200); assert.equal(healthy.car.engineOn, true);
});
