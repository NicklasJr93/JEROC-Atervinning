import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { expoProxyPath, proxyExpo } from './expo-go.mjs';

let upstream, front, base, seen;
before(async () => {
  upstream = createServer((req, res) => {
    seen = { path: req.url, host: req.headers.host, proto: req.headers['x-forwarded-proto'], platform: req.headers['expo-platform'] };
    res.writeHead(200, { 'Content-Type': 'application/expo+json', 'expo-protocol-version': '0' });
    res.end(JSON.stringify({ sdk: '57.0.0' }));
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  const port = upstream.address().port;
  front = createServer((req, res) => proxyExpo(req, res, { port, publicUrl: 'https://jeroc-atervinning.onrender.com' }));
  await new Promise((done) => front.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${front.address().port}`;
});
after(async () => {
  await Promise.all([front, upstream].map((server) => new Promise((done) => server.close(done))));
});
test('forwards the Expo manifest with public HTTPS host and platform', async () => {
  const response = await fetch(`${base}/expo`, { headers: { 'Expo-Platform': 'ios' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('expo-protocol-version'), '0');
  assert.deepEqual(await response.json(), { sdk: '57.0.0' });
  assert.deepEqual(seen, { path: '/', host: 'jeroc-atervinning.onrender.com', proto: 'https', platform: 'ios' });
});
test('allows the CLI bundle URL at the origin root but fixes unsafe transform options', async () => {
  const response = await fetch(`${base}/index.ts.bundle?platform=android&dev=true&transform.routerRoot=../server&transform.engine=jsc`);
  assert.equal(response.status, 200);
  const url = new URL(seen.path, base);
  assert.equal(url.pathname, '/index.ts.bundle');
  assert.equal(url.searchParams.get('platform'), 'android');
  assert.equal(url.searchParams.get('dev'), 'false');
  assert.equal(url.searchParams.get('minify'), 'true');
  assert.equal(url.searchParams.get('transform.engine'), 'hermes');
  assert.equal(url.searchParams.has('transform.routerRoot'), false);
});
test('never exposes debugger, sockets, project files or non-native bundles through the proxy', async () => {
  for (const path of ['/expo/open-debugger', '/expo/inspector/debug', '/expo/assets/.env', '/expo/symbolicate', '/expo/server/index.mjs', '/index.bundle?platform=web', '/index.bundle']) {
    seen = null;
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.equal(seen, null, path);
  }
  assert.equal(expoProxyPath('/expoevil/index.bundle?platform=ios'), null);
  assert.equal((await fetch(`${base}/expo`, { method: 'POST' })).status, 404);
});
test('reports a unavailable Expo process without taking down the web server', async () => {
  await new Promise((done) => { upstream.close(done); upstream.closeAllConnections(); });
  const response = await fetch(`${base}/expo`);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /startar/);
});
