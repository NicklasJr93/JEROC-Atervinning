import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expoRoot = fileURLToPath(new URL('../expo/', import.meta.url));
const bundlePaths = new Set(['/index.bundle', '/index.ts.bundle']);
const allowedPaths = new Set(['/', '/manifest', '/index.exp', ...bundlePaths]);

export function expoProxyPath(url) {
  const parsed = new URL(url, 'http://localhost');
  const path = parsed.pathname === '/expo' ? '/' : parsed.pathname.startsWith('/expo/') ? parsed.pathname.slice('/expo'.length) : parsed.pathname;
  if (!allowedPaths.has(path)) return null;
  if (!bundlePaths.has(path)) {
    const platform = parsed.searchParams.get('platform');
    if (platform && platform !== 'ios' && platform !== 'android') return null;
    return path + (platform ? '?platform=' + platform : '');
  }
  const platform = parsed.searchParams.get('platform');
  if (platform !== 'ios' && platform !== 'android') return null;
  // Only expose this project's entry bundle. Debugger and arbitrary transform routes stay private.
  const params = new URLSearchParams({
    platform, dev: 'false', minify: 'true', hot: 'false', lazy: 'false',
    'transform.engine': 'hermes', 'transform.bytecode': '1',
    unstable_transformProfile: 'hermes-stable',
  });
  return path + '?' + params;
}

export function proxyExpo(req, res, { port, publicUrl }) {
  const path = expoProxyPath(req.url);
  const platform = req.headers['expo-platform'] ?? req.headers['exponent-platform'];
  if (!path || (platform && platform !== 'ios' && platform !== 'android') || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }
  const url = new URL(publicUrl);
  const upstream = request({
    hostname: '127.0.0.1', port, method: req.method, path,
    headers: { ...req.headers, host: url.host, 'x-forwarded-proto': url.protocol.slice(0, -1) },
  }, (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(120000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Expo-servern startar. Försök igen om en stund.');
    }
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
  upstream.end();
}

export function expoBundlePath(platform) {
  return expoProxyPath(`/index.ts.bundle?platform=${platform}`);
}

/** Drain Metro's bytecode into its existing cache, without retaining a bundle
 * in the business server. The total deadline also covers a server that keeps
 * its socket alive but never finishes a response. */
function warmBundle({ port, publicUrl, platform, httpRequest, timeoutMs, maxBytes, signal }) {
  return new Promise((done, reject) => {
    let upstream, response, bytes = 0, settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener('abort', aborted);
      if (code) {
        response?.destroy();
        upstream?.destroy();
        reject(Object.assign(new Error('Expo-paketet kunde inte förberedas.'), { code }));
      } else done();
    };
    const aborted = () => finish('EXPO_STARTUP_ABORTED');
    const deadline = setTimeout(() => finish('EXPO_COMPILE_TIMEOUT'), timeoutMs);
    deadline.unref?.();
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    const url = new URL(publicUrl);
    try {
      upstream = httpRequest({ hostname: '127.0.0.1', port, method: 'GET', path: expoBundlePath(platform),
        headers: { host: url.host, 'x-forwarded-proto': url.protocol.slice(0, -1), 'expo-platform': platform } }, incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        if (incoming.statusCode !== 200) { finish('EXPO_COMPILE_HTTP'); return; }
        incoming.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) finish('EXPO_COMPILE_TOO_LARGE');
        });
        incoming.once('end', () => finish(bytes > 0 ? undefined : 'EXPO_COMPILE_EMPTY'));
        incoming.once('aborted', () => finish('EXPO_COMPILE_INTERRUPTED'));
        incoming.on('error', () => finish('EXPO_COMPILE_INTERRUPTED'));
      });
      upstream.on('error', () => finish('EXPO_COMPILE_CONNECTION'));
      upstream.end();
    } catch { finish('EXPO_COMPILE_CONNECTION'); }
  });
}

/** Readiness means both native bundles finished compiling. Injectable process,
 * socket and HTTP boundaries keep lifecycle tests off real Expo and accounts. */
export function startExpoGo({ onFailure = () => {}, env = process.env, spawnProcess = spawn,
  fileExists = existsSync, connectSocket = connect, httpRequest = request, timing = {} } = {}) {
  const enabled = env.EXPO_GO_ENABLED !== 'false' && Boolean(env.EXPO_TOKEN);
  if (!enabled) return { enabled: false, ready: false, state: 'disabled', compilingPlatform: null, warmedPlatforms: [], stop: async () => {} };
  const publicUrl = env.RENDER_EXTERNAL_URL ?? env.EXPO_PUBLIC_WEB_APP_URL;
  if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
    throw new Error('Expo Go behöver RENDER_EXTERNAL_URL eller EXPO_PUBLIC_WEB_APP_URL.');
  }
  const cli = resolve(expoRoot, 'node_modules/expo/bin/cli');
  if (!fileExists(cli)) throw new Error('Expo-beroenden saknas. Använd npm run build:render i Render.');
  const port = Number(env.EXPO_INTERNAL_PORT ?? '8081');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(env.PORT)) {
    throw new Error('EXPO_INTERNAL_PORT måste vara en egen port mellan 1 och 65535.');
  }
  const bounds = { probeIntervalMs: 500, socketTimeoutMs: 500, startupTimeoutMs: 60_000,
    warmupTimeoutMs: 120_000, overallTimeoutMs: 300_000, stopTimeoutMs: 5_000, maxBundleBytes: 64 * 1024 * 1024, ...timing };
  if (Object.values(bounds).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Expo-startens gränser måste vara positiva heltal.');
  const control = { enabled: true, ready: false, state: 'starting', compilingPlatform: null, warmedPlatforms: [], port, publicUrl };
  const child = spawnProcess(process.execPath, [cli, 'start', '--lan', '--go', '--port', String(port), '--max-workers', '1', '--no-dev', '--minify'], {
    cwd: expoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...env, CI: '1', EXPO_UNSTABLE_HEADLESS: '1', EXPO_OFFLINE: '0', EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: env.NODE_OPTIONS ?? '--max-old-space-size=256',
      EXPO_PACKAGER_PROXY_URL: publicUrl.replace(/\/$/, ''),
      EXPO_PUBLIC_WEB_APP_URL: publicUrl.replace(/\/$/, ''),
    },
  });
  let stopping = false, failed = false, probe, startupDeadline, overallDeadline, killDeadline, stopPromise;
  const sockets = new Set(), abort = new AbortController();
  const alive = () => child.exitCode == null && child.signalCode == null;
  const clearStartup = () => {
    clearInterval(probe); clearTimeout(startupDeadline); clearTimeout(overallDeadline);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  const terminate = () => {
    if (!alive()) return;
    child.kill('SIGTERM');
    killDeadline ??= setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, bounds.stopTimeoutMs);
    killDeadline.unref?.();
  };
  const fail = code => {
    if (stopping || failed) return;
    failed = true; control.ready = false; control.state = 'error'; control.errorCode = code;
    clearStartup(); abort.abort(); terminate();
    // The owning HTTP server reports this optional subsystem failure. It must
    // remain available for business APIs when Metro exits or runs out of heap.
    try { onFailure(control); } catch { console.error('Expo Go-starten misslyckades.'); }
  };
  const compile = async () => {
    if (stopping || failed || control.state !== 'starting') return;
    control.state = 'compiling'; clearInterval(probe); clearTimeout(startupDeadline);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    try {
      for (const platform of ['ios', 'android']) {
        if (stopping || failed) return;
        control.compilingPlatform = platform;
        await warmBundle({ port, publicUrl, platform, httpRequest, timeoutMs: bounds.warmupTimeoutMs,
          maxBytes: bounds.maxBundleBytes, signal: abort.signal });
        if (stopping || failed) return;
        control.warmedPlatforms.push(platform);
      }
      control.compilingPlatform = null; control.state = 'ready'; control.ready = true;
      clearTimeout(overallDeadline);
      console.log('Expo Go-paketen är förberedda. Öppna /expo-go för QR-koden.');
    } catch (error) { if (!stopping && !failed) fail(error.code ?? 'EXPO_COMPILE_CONNECTION'); }
  };
  probe = setInterval(() => {
    if (stopping || failed || control.state !== 'starting' || sockets.size) return;
    let socket;
    try { socket = connectSocket({ host: '127.0.0.1', port }); } catch { return; }
    sockets.add(socket);
    socket.setTimeout(bounds.socketTimeoutMs, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => { sockets.delete(socket); socket.destroy(); });
    socket.once('connect', () => { sockets.delete(socket); socket.destroy(); void compile(); });
  }, bounds.probeIntervalMs);
  probe.unref();
  startupDeadline = setTimeout(() => fail('EXPO_STARTUP_TIMEOUT'), bounds.startupTimeoutMs);
  overallDeadline = setTimeout(() => fail('EXPO_STARTUP_TIMEOUT'), bounds.overallTimeoutMs);
  startupDeadline.unref?.(); overallDeadline.unref?.();
  child.on('error', () => {
    fail('EXPO_PROCESS_ERROR');
  });
  child.once('exit', () => {
    control.ready = false; clearTimeout(killDeadline);
    if (!stopping) fail('EXPO_PROCESS_EXIT');
  });
  control.stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true; control.ready = false; clearStartup(); abort.abort();
    stopPromise = alive() ? new Promise(done => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; clearTimeout(finishDeadline); clearTimeout(killDeadline); done(); } };
      const finishDeadline = setTimeout(finish, bounds.stopTimeoutMs * 2);
      finishDeadline.unref?.();
      child.once('exit', finish); terminate();
    }) : Promise.resolve();
    return stopPromise;
  };
  return control;
}
