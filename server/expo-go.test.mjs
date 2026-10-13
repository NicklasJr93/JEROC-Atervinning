import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import { expoProxyPath, proxyExpo, expoBundlePath, startExpoGo } from './expo-go.mjs';

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

function startupFixture(options = {}) {
  const child = new EventEmitter(), requests = [], failures = [], launches = [];
  child.exitCode = null; child.signalCode = null; child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    queueMicrotask(() => { if (child.signalCode === null) { child.signalCode = signal; child.emit('exit', null, signal); } });
    return true;
  };
  const fixture = { child, requests, failures, launches };
  fixture.control = startExpoGo({
    env: { EXPO_TOKEN: 'fictional-test-token', RENDER_EXTERNAL_URL: 'https://expo.example.invalid', PORT: '4173' },
    onFailure: value => failures.push(value.errorCode), fileExists: () => true,
    spawnProcess: (...args) => { launches.push(args); return child; },
    connectSocket: () => {
      const socket = new EventEmitter(); socket.setTimeout = () => socket;
      socket.destroy = () => socket.emit('close');
      if (options.connect !== false) queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
    httpRequest: (input, callback) => {
      const req = new EventEmitter(); req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = () => {
        const response = new PassThrough(); response.statusCode = 200;
        const entry = { input, req, response, callback };
        requests.push(entry);
        queueMicrotask(() => callback(response));
      };
      return req;
    },
    timing: { probeIntervalMs: 2, socketTimeoutMs: 5, startupTimeoutMs: 1000, warmupTimeoutMs: 1000,
      overallTimeoutMs: 2500, stopTimeoutMs: 5, ...options.timing },
  });
  return fixture;
}
async function until(condition) {
  const deadline = Date.now() + 1500;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail('Lifecycle did not finish before test deadline');
    await new Promise(done => setTimeout(done, 2));
  }
}

test('prewarms exact canonical bytecode sequentially before publishing readiness', async () => {
  const { control, requests, failures, launches } = startupFixture();
  try {
    assert.equal(control.state, 'starting'); assert.equal(control.ready, false);
    await until(() => requests.length === 1);
    assert.equal(control.state, 'compiling'); assert.equal(control.compilingPlatform, 'ios');
    assert.equal(control.ready, false); assert.deepEqual(control.warmedPlatforms, []);
    const first = requests[0];
    assert.equal(first.input.path, expoBundlePath('ios'));
    assert.equal(first.input.path, expoProxyPath('/index.ts.bundle?platform=ios&dev=true'));
    assert.equal(first.input.headers.host, 'expo.example.invalid');
    assert.equal(first.input.headers['x-forwarded-proto'], 'https');
    first.response.write(Buffer.alloc(65536)); first.response.write(Buffer.alloc(65536));
    await new Promise(done => setTimeout(done, 10));
    assert.equal(requests.length, 1, 'Android cannot compile while iOS is unfinished');
    assert.equal(control.ready, false);
    first.response.end();
    await until(() => requests.length === 2);
    assert.equal(control.compilingPlatform, 'android'); assert.deepEqual(control.warmedPlatforms, ['ios']);
    assert.equal(control.ready, false); assert.equal(requests[1].input.path, expoBundlePath('android'));
    requests[1].response.end('fictional-bytecode');
    await until(() => control.ready);
    assert.equal(control.state, 'ready'); assert.equal(control.compilingPlatform, null);
    assert.deepEqual(control.warmedPlatforms, ['ios', 'android']); assert.deepEqual(failures, []);
    assert.equal(launches[0][2].env.NODE_OPTIONS, '--max-old-space-size=256');
    assert.ok(launches[0][1].includes('--no-dev')); assert.ok(launches[0][1].includes('--minify'));
    assert.equal(launches[0][1][launches[0][1].indexOf('--max-workers') + 1], '1');
  } finally { await control.stop(); }
});

test('compile deadlines discard unfinished streams, terminate only Metro and report failure once', async () => {
  const { control, requests, failures, child } = startupFixture({ timing: { warmupTimeoutMs: 20 } });
  try {
    await until(() => requests.length === 1);
    requests[0].response.write('not-yet-finished');
    await until(() => control.state === 'error');
    assert.equal(control.ready, false); assert.equal(control.errorCode, 'EXPO_COMPILE_TIMEOUT');
    assert.equal(requests[0].req.destroyed, true); assert.equal(requests[0].response.destroyed, true);
    assert.equal(requests.length, 1); assert.deepEqual(failures, ['EXPO_COMPILE_TIMEOUT']);
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('error', new Error('fictional duplicate process failure'));
    child.emit('error', new Error('fictional late process failure'));
    assert.deepEqual(failures, ['EXPO_COMPILE_TIMEOUT']);
  } finally { await control.stop(); }
});

test('oversized and empty bytecode never become ready or trigger the next platform', async () => {
  for (const { content, code } of [{ content: '12345', code: 'EXPO_COMPILE_TOO_LARGE' }, { content: '', code: 'EXPO_COMPILE_EMPTY' }]) {
    const { control, requests, failures } = startupFixture({ timing: { maxBundleBytes: 4 } });
    try {
      await until(() => requests.length === 1);
      requests[0].response.end(content);
      await until(() => control.state === 'error');
      assert.equal(control.ready, false); assert.equal(control.errorCode, code);
      assert.deepEqual(control.warmedPlatforms, []); assert.equal(requests.length, 1);
      assert.deepEqual(failures, [code]);
    } finally { await control.stop(); }
  }
});

test('stopping during compilation cannot publish stale readiness or report a normal shutdown as failure', async () => {
  const { control, requests, failures } = startupFixture();
  await until(() => requests.length === 1);
  await control.stop();
  requests[0].response.emit('end');
  await new Promise(done => setTimeout(done, 10));
  assert.equal(control.ready, false); assert.equal(requests.length, 1);
  assert.deepEqual(control.warmedPlatforms, []); assert.deepEqual(failures, []);
  await control.stop();
});

test('unavailable Metro is bounded at startup rather than marking a listening probe as ready', async () => {
  const { control, requests, failures } = startupFixture({ connect: false, timing: { startupTimeoutMs: 20 } });
  try {
    await until(() => control.state === 'error');
    assert.equal(control.ready, false); assert.equal(requests.length, 0);
    assert.deepEqual(failures, ['EXPO_STARTUP_TIMEOUT']);
  } finally { await control.stop(); }
});
