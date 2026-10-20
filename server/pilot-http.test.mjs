import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPilotSecurityHeaders, pilotRequestPolicy } from './pilot-http.mjs';

const profile = { mode: 'pilot', pilot: true, appOrigin: 'https://app.scrapplanner.com', mobileOrigin: 'https://mobile.scrapplanner.com' };
const request = (path, { host = 'app.scrapplanner.com', method = 'GET', expoGoEnabled = false, ...headers } = {}) =>
  pilotRequestPolicy({ method, headers: { host, ...headers } }, new URL(path, 'http://localhost'), { ...profile, expoGoEnabled });

test('pilot homepage selects only configured mobile host and preserves tenant query', () => {
  assert.deepEqual(request('/?company=company-one'), { status: 303, location: '/kontor/?company=company-one' });
  assert.deepEqual(request('/?company=company-one', { host: 'mobile.scrapplanner.com' }), { status: 303, location: '/mobil/?company=company-one' });
  assert.equal(request('/', { host: 'MOBILE.SCRAPPLANNER.COM' }).location, '/mobil/');
  assert.equal(request('/', { host: 'scrapplanner-pilot.onrender.com' }).location, '/kontor/');
  assert.equal(request('/?next=https://untrusted.example', { host: 'untrusted.example' }).location, '/kontor/?next=https://untrusted.example');
  assert.equal(request('/', { method: 'HEAD' }).status, 303);
  assert.equal(request('/', { method: 'POST' }), null);
  assert.equal(request('/mobil/'), null);
  assert.equal(request('/api/platform/login', { method: 'POST' }), null);
});

test('explicit optional Expo hosting preserves pilot laboratory blocks and native manifest routing', () => {
  for (const path of ['/expo', '/expo/status', '/expo/retry', '/expo-go', '/expo-go.html', '/expo-go-qr.svg',
    '/manifest', '/index.exp', '/index.ts.bundle?platform=ios', '/assets/assets/icon.png'])
    assert.equal(request(path, { expoGoEnabled: true }), null, path);
  for (const headers of [{ 'expo-platform': 'ios' }, { 'exponent-platform': 'android' }, { accept: 'application/expo+json' }])
    assert.equal(request('/', { ...headers, expoGoEnabled: true }), null);
  assert.equal(request('/', { expoGoEnabled: true }).location, '/kontor/');
  for (const path of ['/testbil1', '/rosttest', '/api/testcar/session', '/api/public/voice-test/calls',
    '/kontor/integration/systemadminintegrationtest.html'])
    assert.equal(request(path, { expoGoEnabled: true }).status, 404, path);
  assert.equal(request('/assets/assets/icon.png').status, 404);
});

test('pilot rejects laboratory pages and APIs before they can allocate a demo runtime', () => {
  for (const path of ['/testbil1', '/testbil1/', '/rosttest', '/kontor/rosttest', '/api/public/voice-test',
    '/api/public/voice-test/calls', '/api/testcar', '/api/testcar/session', '/api/testcar/fleet',
    '/kontor/integration/systemadminintegrationtest.html', '/kontor/integration/systemadminvismatest.html',
    '/kontor/integration/systemadminswishtest.html', '/kontor/integration/systemadminbanktest.html',
    '/expo', '/expo/', '/expo/status', '/expo/retry', '/expo-go', '/expo-go.html', '/expo-go-qr.svg',
    '/manifest', '/index.exp', '/index.bundle', '/index.ts.bundle', '/%72osttest']) {
    assert.equal(request(path).status, 404, path);
    assert.equal(request(path, { method: 'POST' }).status, 404, path);
  }
  for (const headers of [{ 'expo-platform': 'ios' }, { 'exponent-platform': 'android' }, { accept: 'application/expo+json' }])
    assert.equal(request('/', headers).status, 404);
  assert.equal(request('/healthz'), null);
  assert.equal(request('/readyz'), null);
  assert.equal(request('/api/platform/session'), null);
  assert.equal(request('/%zz').status, 400);
});

test('existing demo routing and optional laboratories are unchanged', () => {
  for (const path of ['/', '/testbil1', '/api/testcar/session', '/rosttest', '/expo/status'])
    assert.equal(pilotRequestPolicy({ method: 'GET', headers: {} }, new URL(path, 'http://localhost'), { pilot: false }), null);
});

test('pilot applies frame and type protections, and HSTS only on HTTPS', () => {
  for (const [req, https] of [[{ headers: {}, socket: {} }, false], [{ headers: { 'x-forwarded-proto': 'https' } }, true],
    [{ headers: {}, socket: { encrypted: true } }, true]]) {
    const headers = new Map();
    applyPilotSecurityHeaders(req, { setHeader: (key, value) => headers.set(key, value) }, profile);
    assert.equal(headers.get('X-Frame-Options'), 'DENY');
    assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(headers.has('Strict-Transport-Security'), https);
  }
  applyPilotSecurityHeaders({ headers: {} }, { setHeader: () => assert.fail('Demo headers changed') }, { pilot: false });
});
