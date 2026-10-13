import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expoBundlePath } from '../server/expo-go.mjs';

const projectRoot = fileURLToPath(new URL('../expo/', import.meta.url));
const fail = code => Object.assign(new Error('Expo-paketen kunde inte förberedas under bygget.'), { code });
const nativePlatforms = ['ios', 'android'];

async function localPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
async function waitForMetro({ port, child, timeoutMs, isFailed }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isFailed?.()) throw isFailed();
    if (child.exitCode !== null || child.signalCode !== null) throw fail('EXPO_PREBUILD_PROCESS_EXIT');
    const ready = await new Promise(done => {
      const req = request({ hostname: '127.0.0.1', port, path: '/status' }, response => {
        response.resume(); done(response.statusCode === 200);
      });
      req.setTimeout(500, () => req.destroy()); req.on('error', () => done(false)); req.end();
    });
    if (ready) return;
    await new Promise(done => setTimeout(done, 250));
  }
  throw fail('EXPO_PREBUILD_STARTUP_TIMEOUT');
}

/** Match the runtime's native request, not expo export's static serializer.
 * Only a prefix and a small address-search suffix survive each data chunk. */
export function readNativeBundle({ port, publicUrl, platform, timeoutMs = 300000, maxBytes = 64 * 1024 * 1024 }) {
  if (!nativePlatforms.includes(platform)) return Promise.reject(fail('EXPO_PREBUILD_PLATFORM'));
  return new Promise((done, reject) => {
    let upstream, response, settled = false, bytes = 0, prefix = Buffer.alloc(0), suffix = Buffer.alloc(0), addressPresent = false, contentType;
    const address = Buffer.from(publicUrl), url = new URL(publicUrl);
    const finish = (code) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      if (code) { response?.destroy(); upstream?.destroy(); reject(fail(code)); return; }
      const format = prefix.toString('hex') === 'c61fbc03c103191f' ? 'hermes' : /javascript/i.test(contentType ?? '') ? 'javascript' : null;
      if (!bytes || !addressPresent || !format) { reject(fail('EXPO_PREBUILD_INVALID_BUNDLE')); return; }
      done({ platform, bytes, format, publicAddressPresent: addressPresent });
    };
    const deadline = setTimeout(() => finish('EXPO_PREBUILD_BUNDLE_TIMEOUT'), timeoutMs);
    upstream = request({ hostname: '127.0.0.1', port, method: 'GET', path: expoBundlePath(platform),
      headers: { host: url.host, 'x-forwarded-proto': url.protocol.slice(0, -1), 'expo-platform': platform } }, incoming => {
      response = incoming;
      contentType = incoming.headers['content-type'];
      incoming.on('error', () => finish('EXPO_PREBUILD_INTERRUPTED'));
      if (incoming.statusCode !== 200 || /(?:json|html)/i.test(incoming.headers['content-type'] ?? '')) { finish('EXPO_PREBUILD_HTTP'); return; }
      incoming.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { finish('EXPO_PREBUILD_TOO_LARGE'); return; }
        if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8)]).subarray(0, 8);
        if (!addressPresent) {
          const scan = Buffer.concat([suffix, chunk]); addressPresent = scan.includes(address);
          suffix = scan.subarray(Math.max(0, scan.length - address.length + 1));
        }
      });
      incoming.once('end', () => finish());
      incoming.once('aborted', () => finish('EXPO_PREBUILD_INTERRUPTED'));
    });
    upstream.on('error', () => finish('EXPO_PREBUILD_CONNECTION')); upstream.end();
  });
}
async function stopMetro(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise(done => {
    let finished = false, force, deadline;
    const finish = () => { if (finished) return; finished = true; clearTimeout(force); clearTimeout(deadline); done(); };
    child.once('exit', finish);
    force = setTimeout(() => child.kill('SIGKILL'), graceMs);
    deadline = setTimeout(finish, graceMs * 2);
    child.kill('SIGTERM');
  });
}

export async function precompileExpo({ env = process.env, spawnProcess = spawn, choosePort = localPort,
  waitReady = waitForMetro, readBundle = readNativeBundle, fileExists = existsSync, log = console.log,
  startupTimeoutMs = 60000, bundleTimeoutMs = 300000, stopGraceMs = 5000 } = {}) {
  if (env.EXPO_GO_ENABLED === 'false' || !env.EXPO_TOKEN) {
    log('Expo-förbygget hoppas över: Expo Go är inte aktiverat.'); return { skipped: true, reason: 'disabled' };
  }
  const configuredUrl = env.RENDER_EXTERNAL_URL ?? env.EXPO_PUBLIC_WEB_APP_URL;
  if (!configuredUrl) {
    log('Expo-förbygget hoppas över: offentlig webbadress saknas under bygget.'); return { skipped: true, reason: 'missing_public_url' };
  }
  let parsedUrl;
  try { parsedUrl = new URL(configuredUrl); } catch { throw fail('EXPO_PREBUILD_INVALID_URL'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw fail('EXPO_PREBUILD_INVALID_URL');
  const publicUrl = configuredUrl.replace(/\/$/, '');
  if ([startupTimeoutMs, bundleTimeoutMs, stopGraceMs].some(value => !Number.isSafeInteger(value) || value <= 0)) throw fail('EXPO_PREBUILD_INVALID_BOUNDS');
  const cli = resolve(projectRoot, 'node_modules/expo/bin/cli');
  if (!fileExists(cli)) throw fail('EXPO_PREBUILD_DEPENDENCIES');
  const port = await choosePort();
  const child = spawnProcess(process.execPath, [cli, 'start', '--lan', '--go', '--port', String(port), '--max-workers', '1', '--no-dev', '--minify'], {
    cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, EXPO_TOKEN: '', CI: '1', EXPO_OFFLINE: '1', EXPO_UNSTABLE_HEADLESS: '1', EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: env.NODE_OPTIONS ?? '--max-old-space-size=256', EXPO_PACKAGER_PROXY_URL: publicUrl, EXPO_PUBLIC_WEB_APP_URL: publicUrl },
  });
  // Build only needs local transforms, never Expo account access. Do not print
  // arbitrary subprocess output, environment values or authentication tokens.
  child.stdout?.resume(); child.stderr?.resume();
  let processError;
  child.on('error', () => { processError = fail('EXPO_PREBUILD_PROCESS_ERROR'); });
  const started = performance.now(), bundles = [];
  try {
    await waitReady({ port, child, timeoutMs: startupTimeoutMs, isFailed: () => processError });
    if (processError) throw processError;
    for (const platform of nativePlatforms) {
      const begin = performance.now();
      const bundle = await readBundle({ port, publicUrl, platform, timeoutMs: bundleTimeoutMs });
      if (processError || child.exitCode !== null || child.signalCode !== null) throw processError ?? fail('EXPO_PREBUILD_PROCESS_EXIT');
      bundles.push(bundle);
      log(JSON.stringify({ phase: 'expo-prebuild', platform, bytes: bundle.bytes, format: bundle.format, elapsedMs: Math.round(performance.now() - begin) }));
    }
    return { skipped: false, bundles, elapsedMs: Math.round(performance.now() - started) };
  } finally { await stopMetro(child, stopGraceMs); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  precompileExpo().catch(error => {
    console.warn(`Expo-förbygget kunde inte slutföras (${error.code ?? 'EXPO_PREBUILD_FAILED'}). Webbtjänsten kan publiceras; Expo förbereds och försöks igen vid driftstart.`);
  });
}
