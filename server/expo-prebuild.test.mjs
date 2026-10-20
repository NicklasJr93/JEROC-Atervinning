import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { precompileExpo, readNativeBundle } from '../scripts/expo-prebuild.mjs';
import { expoBundlePath, expoGoConfiguration } from './expo-go.mjs';

const publicUrl = 'https://native-build.example.invalid';
function processFixture() {
  const child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null; child.signals = [];
  child.stdout = { resume() {} }; child.stderr = { resume() {} };
  child.kill = signal => { child.signals.push(signal); queueMicrotask(() => { child.signalCode = signal; child.emit('exit'); }); return true; };
  return child;
}
test('offline prebuild uses the exact public runtime address, strips Expo credentials and warms platforms sequentially', async () => {
  const child = processFixture(), requests = [], logs = [];
  let launch, completeFirst, completeSecond;
  const first = new Promise(done => { completeFirst = done; }), second = new Promise(done => { completeSecond = done; });
  const running = precompileExpo({ env: { EXPO_TOKEN: 'fictional-private-token', RENDER_EXTERNAL_URL: `${publicUrl}/`, NODE_OPTIONS: '--max-old-space-size=256' },
    fileExists: () => true, choosePort: async () => 32123, waitReady: async () => {}, stopGraceMs: 10, log: message => logs.push(message),
    spawnProcess: (...args) => { launch = args; return child; },
    readBundle: async options => { requests.push(options); await (options.platform === 'ios' ? first : second); return { platform: options.platform, bytes: 123, format: 'javascript', publicAddressPresent: true }; },
  });
  await new Promise(done => setImmediate(done));
  assert.equal(requests.length, 1); assert.equal(requests[0].platform, 'ios');
  assert.equal(launch[2].env.EXPO_TOKEN, ''); assert.equal(launch[2].env.EXPO_OFFLINE, '1');
  assert.equal(launch[2].env.EXPO_PUBLIC_WEB_APP_URL, publicUrl); assert.equal(launch[2].env.EXPO_PACKAGER_PROXY_URL, publicUrl);
  assert.ok(launch[1].includes('--no-dev')); assert.ok(launch[1].includes('--minify'));
  assert.equal(launch[1][launch[1].indexOf('--max-workers') + 1], '1');
  completeFirst(); await new Promise(done => setImmediate(done));
  assert.equal(requests.length, 2); assert.equal(requests[1].platform, 'android'); assert.equal(requests[1].publicUrl, publicUrl);
  completeSecond(); const result = await running;
  assert.equal(result.skipped, false); assert.deepEqual(result.bundles.map(bundle => bundle.platform), ['ios', 'android']);
  assert.deepEqual(child.signals, ['SIGTERM']); assert.equal(logs.join('').includes('fictional-private-token'), false);
});
test('pilot prebuild and runtime compile the same explicit mobile target independently of the packager host', async () => {
  const child = processFixture(), reads = []; let launch;
  const mobileUrl = 'https://mobile.scrapplanner.com/mobil/';
  const result = await precompileExpo({ env: { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', EXPO_GO_ENABLED: 'true',
    EXPO_TOKEN: 'fictional-private-token', RENDER_EXTERNAL_URL: `${publicUrl}/`, EXPO_PUBLIC_WEB_APP_URL: mobileUrl },
    fileExists: () => true, choosePort: async () => 32123, waitReady: async () => {}, stopGraceMs: 10, log() {},
    spawnProcess: (...args) => { launch = args; return child; },
    readBundle: async options => { reads.push(options); return { platform: options.platform, bytes: 123, format: 'javascript', publicAddressPresent: true }; },
  });
  assert.equal(result.skipped, false); assert.equal(launch[2].env.EXPO_PACKAGER_PROXY_URL, publicUrl);
  assert.equal(launch[2].env.EXPO_PUBLIC_WEB_APP_URL, mobileUrl); assert.equal(launch[2].env.EXPO_TOKEN, '');
  assert.equal(launch[2].env.EXPO_METRO_CACHE_DIRECTORY, expoGoConfiguration({ SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot',
    RENDER_EXTERNAL_URL: publicUrl, EXPO_PUBLIC_WEB_APP_URL: mobileUrl }).cacheDirectory);
  assert.deepEqual(reads.map(({ platform, publicUrl, webAppUrl }) => ({ platform, publicUrl, webAppUrl })),
    ['ios', 'android'].map(platform => ({ platform, publicUrl, webAppUrl: mobileUrl })));
});
test('a compile failure preserves diagnosis, stops its own Metro and does not claim a ready cache', async () => {
  const child = processFixture(), requests = [], logs = [];
  await assert.rejects(precompileExpo({ env: { EXPO_TOKEN: 'fictional-private-token', RENDER_EXTERNAL_URL: publicUrl },
    fileExists: () => true, choosePort: async () => 32123, waitReady: async () => {}, stopGraceMs: 10,
    spawnProcess: () => child, log: message => logs.push(message),
    readBundle: async options => { requests.push(options.platform); throw Object.assign(new Error('fixture'), { code: 'EXPO_PREBUILD_BUNDLE_TIMEOUT' }); },
  }), error => error.code === 'EXPO_PREBUILD_BUNDLE_TIMEOUT');
  assert.deepEqual(requests, ['ios']); assert.deepEqual(child.signals, ['SIGTERM']); assert.deepEqual(logs, []);
});
test('disabled or unconfigured prebuild skips and unsafe address fails before any subprocess', async () => {
  let starts = 0; const options = { spawnProcess: () => { starts++; }, log() {} };
  assert.equal((await precompileExpo({ ...options, env: {} })).reason, 'disabled');
  assert.equal((await precompileExpo({ ...options, env: { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', EXPO_TOKEN: 'fixture', RENDER_EXTERNAL_URL: publicUrl } })).reason, 'disabled');
  assert.equal((await precompileExpo({ ...options, env: { SCRAPPLANNER_DEPLOYMENT_MODE: 'pilot', EXPO_TOKEN: 'fixture', EXPO_GO_ENABLED: 'false', RENDER_EXTERNAL_URL: publicUrl } })).reason, 'disabled');
  assert.equal((await precompileExpo({ ...options, env: { EXPO_TOKEN: 'fixture' } })).reason, 'missing_public_url');
  for (const value of ['file:///private', 'https://user:password@example.invalid']) await assert.rejects(precompileExpo({ ...options,
    env: { EXPO_TOKEN: 'fixture', RENDER_EXTERNAL_URL: value } }), error => error.code === 'EXPO_PREBUILD_INVALID_URL');
  assert.equal(starts, 0);
});
test('the build CLI treats optional precompile failure as a warning rather than preventing web deployment', async () => {
  const child = spawn(process.execPath, ['scripts/expo-prebuild.mjs'], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, EXPO_TOKEN: 'fictional-not-used', EXPO_GO_ENABLED: 'true', RENDER_EXTERNAL_URL: 'https://user:password@example.invalid' } });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0); assert.match(output, /EXPO_PREBUILD_INVALID_URL/); assert.match(output, /Webbtjänsten kan publiceras/);
  assert.equal(output.includes('user:password'), false); assert.equal(output.includes('fictional-not-used'), false);
});
test('the SDK binary transform cache persists across independent Metro config loads under the project-selected directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-metro-store-')), previous = process.env.EXPO_METRO_CACHE_DIRECTORY;
  const require = createRequire(import.meta.url), configPath = resolve('expo/metro.config.js');
  try {
    process.env.EXPO_METRO_CACHE_DIRECTORY = directory; delete require.cache[configPath];
    const first = require(configPath), key = Buffer.from('11223344', 'hex'), value = { code: 'public-native-cache-fixture' };
    assert.equal(first.cacheStores[0].constructor.name, 'BinaryFileStore');
    assert.equal(first.fileMapCacheDirectory, join(directory, 'file-map'));
    await first.cacheStores[0].set(key, value);
    assert.ok((await readdir(directory)).includes('11'));
    delete require.cache[configPath]; const second = require(configPath);
    assert.deepEqual(await second.cacheStores[0].get(key), value);
  } finally { if (previous === undefined) delete process.env.EXPO_METRO_CACHE_DIRECTORY; else process.env.EXPO_METRO_CACHE_DIRECTORY = previous;
    delete require.cache[configPath]; await rm(directory, { recursive: true, force: true }); }
});
test('real local HTTP warming matches canonical bundle options and validates the public address without retaining the body', async () => {
  const seen = [], server = createServer((req, res) => {
    seen.push(req.url); const platform = new URL(req.url, 'http://localhost').searchParams.get('platform');
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.write('var __BUNDLE_START_TIME__=0; const address="https://native-build.');
    res.end(`example.invalid"; const platform="${platform}";`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const result = await readNativeBundle({ port, publicUrl, platform: 'ios', timeoutMs: 1000 });
    assert.equal(result.publicAddressPresent, true); assert.equal(result.format, 'javascript'); assert.ok(result.bytes > 8);
    assert.deepEqual(seen, [expoBundlePath('ios')]);
    await assert.rejects(readNativeBundle({ port, publicUrl: 'https://wrong-address.example.invalid', platform: 'android' }), error => error.code === 'EXPO_PREBUILD_INVALID_BUNDLE');
    await assert.rejects(readNativeBundle({ port, publicUrl, platform: 'web' }), error => error.code === 'EXPO_PREBUILD_PLATFORM');
    await assert.rejects(readNativeBundle({ port, publicUrl, platform: 'ios', maxBytes: 4 }), error => error.code === 'EXPO_PREBUILD_TOO_LARGE');
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
test('prebuild verifies the mobile URL in native bundle bytes instead of mistakenly accepting the packager origin', async () => {
  const webAppUrl = 'https://mobile.scrapplanner.com/mobil/', seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.host); res.writeHead(200, { 'content-type': 'application/javascript' });
    res.write('const target="https://mobile.scrap'); res.end('planner.com/mobil/";');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const port = server.address().port;
    const result = await readNativeBundle({ port, publicUrl, webAppUrl, platform: 'ios' });
    assert.equal(result.publicAddressPresent, true); assert.equal(seen[0], new URL(publicUrl).host);
    await assert.rejects(readNativeBundle({ port, publicUrl, webAppUrl: publicUrl, platform: 'android' }), error => error.code === 'EXPO_PREBUILD_INVALID_BUNDLE');
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});
