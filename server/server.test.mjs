import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

let child;
let base;
let output = '';
before(async () => {
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: '0', EXPO_GO_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const abort = AbortSignal.timeout(10000);
  child.stderr.on('data', (chunk) => { output += chunk; });
  for await (const [chunk] of on(child.stdout, 'data', { signal: abort })) {
    output += chunk;
    const match = output.match(/lyssnar på port (\d+)/);
    if (match) {
      base = `http://127.0.0.1:${match[1]}`;
      break;
    }
  }
}, { timeout: 12000 });
after(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const finished = once(child, 'exit');
    child.kill('SIGTERM');
    const [code] = await finished;
    assert.equal(code, 0, output);
  }
});
test('serves the production app, its JS and reference images', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const html = await response.text();
  assert.match(html, /JEROC · Gårdsappen/);
  const jsPath = html.match(/src="([^\"]+\.js)"/)?.[1];
  assert.ok(jsPath);
  const js = await fetch(new URL(jsPath, base));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.ok((await js.text()).length > 10000);
  const image = await fetch(`${base}/images/materials.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok((await image.arrayBuffer()).byteLength > 1000);
});
test('health and HEAD requests work without returning a body for HEAD', async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
});
test('does not expose source, secret paths or missing API routes', async () => {
  for (const path of ['/package.json', '/server/index.mjs', '/.env', '/assets/', '/api/weighings', '/missing.js']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
  }
  // Send the encoded path literally so a client cannot normalize traversal away.
  const status = await new Promise((accept, reject) => {
    const req = request(`${base}/`, { path: '/%2e%2e%2fpackage.json' }, (response) => {
      response.resume();
      accept(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 404);
});
test('rejects writes and malformed URLs', async () => {
  const post = await fetch(base, { method: 'POST', body: 'test' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const malformed = await fetch(`${base}/%zz`);
  assert.equal(malformed.status, 400);
});
test('web demo stays available while Expo Go waits for account setup', async () => {
  const status = await fetch(`${base}/expo/status`);
  assert.deepEqual(await status.json(), { enabled: false, ready: false });
  const manifest = await fetch(`${base}/expo`, { headers: { 'Expo-Platform': 'ios' } });
  assert.equal(manifest.status, 503);
  const nativeRoot = await fetch(base, { headers: { 'Expo-Platform': 'android' } });
  assert.equal(nativeRoot.status, 503);
  const setup = await fetch(`${base}/expo-go`);
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /exps:\/\/jeroc-atervinning\.onrender\.com\/expo/);
  const qr = await fetch(`${base}/expo-go-qr.svg`);
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
});

test('serves office and mobile aliases without exposing other routes', async () => {
 for (const path of ['/kontor','/kontor/','/mobil']) {
  const response=await fetch(base+path);
  assert.equal(response.status,200,path);
  assert.match(response.headers.get('content-type'),/text\/html/);
 }
 assert.equal((await fetch(base+'/kontor/private')).status,404);
});
