import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const expoRoot = fileURLToPath(new URL('../expo/', import.meta.url));
const bundlePaths = new Set(['/index.bundle', '/index.ts.bundle']);
const allowedPaths = new Set(['/', '/manifest', '/index.exp', ...bundlePaths]);
// These are the only local files referenced by the Expo manifest. Do not open
// Metro's general assets endpoint: it can resolve arbitrary project paths.
const manifestAssets = new Set(['icon.png', 'splash.png', 'adaptive-icon.png'].map(name => `/assets/assets/${name}`));
const expoRequire = createRequire(new URL('../expo/package.json', import.meta.url));
let qrCache;

export function expoGoEnabled(env = process.env) {
  const tokenPresent = typeof env.EXPO_TOKEN === 'string' && Boolean(env.EXPO_TOKEN.trim());
  return tokenPresent && (env.SCRAPPLANNER_DEPLOYMENT_MODE === 'pilot'
    ? env.EXPO_GO_ENABLED === 'true' : env.EXPO_GO_ENABLED !== 'false');
}

/** The packager origin is infrastructure; the WebView target is the mobile
 * product. Keep the two values identical between build and runtime so Metro's
 * persistent transform cache contains the intended mobile URL. */
export function expoGoConfiguration(env = process.env) {
  const pilot = env.SCRAPPLANNER_DEPLOYMENT_MODE === 'pilot';
  try {
    const source = env.RENDER_EXTERNAL_URL ?? (!pilot ? env.EXPO_PUBLIC_WEB_APP_URL : undefined);
    const packager = new URL(source);
    if (!['https:', ...(!pilot ? ['http:'] : [])].includes(packager.protocol) || packager.username || packager.password
      || packager.pathname !== '/' || packager.search || packager.hash) throw new Error();
    const publicUrl = packager.origin;
    const configuredWebUrl = env.EXPO_PUBLIC_WEB_APP_URL;
    if (pilot && !configuredWebUrl) throw new Error();
    const mobile = new URL(configuredWebUrl ?? publicUrl);
    if (!['https:', ...(!pilot ? ['http:'] : [])].includes(mobile.protocol) || mobile.username || mobile.password
      || mobile.search || mobile.hash) throw new Error();
    if (pilot && (mobile.origin !== new URL(env.MOBILE_URL || 'https://mobile.scrapplanner.com').origin
      || mobile.pathname !== '/mobil/')) throw new Error();
    const webAppUrl = configuredWebUrl ? mobile.href : publicUrl;
    const office = pilot ? new URL(env.APP_URL || 'https://app.scrapplanner.com') : undefined;
    if (office && (office.protocol !== 'https:' || office.username || office.password
      || office.pathname !== '/' || office.search || office.hash)) throw new Error();
    const targetKey = createHash('sha256').update(`${publicUrl}\n${webAppUrl}`).digest('hex').slice(0, 24);
    return { publicUrl, webAppUrl, deploymentMode: pilot ? 'pilot' : 'demo',
      pageOrigins: [...new Set([publicUrl, mobile.origin, ...(office ? [office.origin] : [])])],
      cacheDirectory: resolve(env.EXPO_METRO_CACHE_DIRECTORY || resolve(expoRoot, '.expo/metro-cache'), targetKey),
      deepLink: `${packager.protocol === 'https:' ? 'exps:' : 'exp:'}//${packager.host}/expo` };
  } catch {
    throw Object.assign(new Error('Expo Go behöver en giltig offentlig serveradress och separat mobiladress. Pilot kräver HTTPS och mobiladressen /mobil/.'), { code: 'EXPO_CONFIGURATION_ERROR' });
  }
}

export function expoProxyPath(url) {
  let parsed;
  try { parsed = new URL(url, 'http://localhost'); } catch { return null; }
  const path = parsed.pathname === '/expo' ? '/' : parsed.pathname.startsWith('/expo/') ? parsed.pathname.slice('/expo'.length) : parsed.pathname;
  if (!allowedPaths.has(path) && !manifestAssets.has(path)) return null;
  if (manifestAssets.has(path)) {
    const platform = parsed.searchParams.get('platform');
    if (platform && !['ios', 'android'].includes(platform)) return null;
    return path + (platform ? '?platform=' + platform : '');
  }
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

function expoRequest(req) {
  const path = expoProxyPath(req.url);
  const headerPlatform = req.headers['expo-platform'] ?? req.headers['exponent-platform'];
  if (!path || (headerPlatform && headerPlatform !== 'ios' && headerPlatform !== 'android') || !['GET', 'HEAD'].includes(req.method)) return null;
  const queryPlatform = new URL(path, 'http://localhost').searchParams.get('platform');
  // The readiness check and Metro must resolve the same platform.
  if (headerPlatform && queryPlatform && headerPlatform !== queryPlatform) return null;
  return { path, platform: queryPlatform ?? headerPlatform };
}

export function proxyExpo(req, res, { port, publicUrl }) {
  const selected = expoRequest(req);
  if (!selected) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }
  const { path } = selected;
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

export function expoStatus(control) {
  return { enabled: control.enabled, ready: control.ready, state: control.state,
    compilingPlatform: control.compilingPlatform ?? null, warmedPlatforms: control.warmedPlatforms ?? [],
    ...(control.publicUrl ? { publicUrl: control.publicUrl, webAppUrl: control.webAppUrl,
      deepLink: control.deepLink, deploymentMode: control.deploymentMode } : {}),
    retryable: Boolean(control.retryable), ...(control.retryAt ? { retryAt: control.retryAt } : {}),
    ...(control.errorCode ? { errorCode: control.errorCode } : {}) };
}

/** Generate the QR from configuration, never request Host/query values. The
 * existing Expo CLI encoder is loaded only while Expo Go is enabled. */
export function serveExpoQr(req, res, control) {
  if (!control.enabled || !control.deepLink || !['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Not found'); return;
  }
  try {
    if (qrCache?.deepLink !== control.deepLink) {
      const pixels = expoRequire('toqr').toQR(control.deepLink), size = Math.sqrt(pixels.length);
      if (!Number.isInteger(size) || size < 21 || size > 177) throw new Error();
      const paths = [];
      for (let index = 0; index < pixels.length; index++) if (pixels[index])
        paths.push(`M${index % size + 4},${Math.floor(index / size) + 4}h1v1h-1z`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><title>Öppna ScrapPlanner i Expo Go</title><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join('')}" fill="#16334e"/></svg>`;
      qrCache = { deepLink: control.deepLink, svg };
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(qrCache.svg),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : qrCache.svg);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Expo Go-koden kunde inte förberedas.');
  }
}

export function retryExpo(req, res, control) {
  // This public wrapper bundle contains no company data. Only configured page
  // origins may prepare it; the controller enforces single-flight/cooldown.
  const origin = req.headers.origin;
  const allowedOrigins = control.pageOrigins ?? [control.publicUrl, control.webAppUrl].filter(Boolean).map(value => new URL(value).origin);
  if (req.method !== 'POST' || !control.publicUrl || !allowedOrigins.includes(origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Expo-förberedelsen kan bara startas från den egna Expo-sidan.');
    return;
  }
  if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Expo-förberedelsen tar inga uppgifter.');
    return;
  }
  const accepted = control.retry?.() ?? false;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ accepted, ...expoStatus(control) }));
}

/** A finished iPhone bundle remains usable while Android is being prepared. */
export function serveExpo(req, res, control) {
  const selected = expoRequest(req);
  if (!selected) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Not found');
    return;
  }
  const { platform } = selected;
  const assetReady = manifestAssets.has(new URL(selected.path, 'http://localhost').pathname)
    && control.listening && control.warmedPlatforms.length > 0;
  const ready = control.ready || (control.listening && control.warmedPlatforms.includes(platform)) || assetReady;
  if (!control.enabled || !ready) {
    // Coalesced and cooled down inside the controller. Repeated native retries
    // cannot spawn another Metro or compile a concurrent second bundle.
    if (control.enabled && control.retryable) control.retry?.();
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '3' });
    const message = !control.enabled ? 'Expo Go är inte aktiverat. Se /expo-go för instruktioner.'
      : control.state === 'error' && !control.retryable ? 'Expo Go kunde inte förberedas. Kontrollera /expo-go.'
      : 'Appaketet förbereds fortfarande. Följ starten på /expo-go och försök igen när din mobil är klar.';
    res.end(req.method === 'HEAD' ? undefined : message);
    return;
  }
  proxyExpo(req, res, control);
}

/** Drain Metro's native bundle into its existing cache, without retaining it
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

/** Readiness means both native bundles finished compiling; warmedPlatforms also
 * permits each finished platform independently. A warmup failure must never
 * kill a healthy Metro. Injectable boundaries keep tests off real accounts. */
export function startExpoGo({ onFailure = () => {}, env = process.env, spawnProcess = spawn,
  fileExists = existsSync, connectSocket = connect, httpRequest = request, timing = {} } = {}) {
  const enabled = expoGoEnabled(env);
  if (!enabled) return { enabled: false, ready: false, state: 'disabled', compilingPlatform: null, warmedPlatforms: [], stop: async () => {} };
  const configuration = expoGoConfiguration(env), { publicUrl, webAppUrl } = configuration;
  const cli = resolve(expoRoot, 'node_modules/expo/bin/cli');
  if (!fileExists(cli)) throw new Error('Expo-beroenden saknas. Använd npm run build:render i Render.');
  const port = Number(env.EXPO_INTERNAL_PORT ?? '8081');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(env.PORT)) {
    throw new Error('EXPO_INTERNAL_PORT måste vara en egen port mellan 1 och 65535.');
  }
  const bounds = { probeIntervalMs: 500, socketTimeoutMs: 500, startupTimeoutMs: 60_000,
    warmupTimeoutMs: 600_000, retryDelayMs: 30_000, maxWarmupAttempts: 3,
    stopTimeoutMs: 5_000, maxBundleBytes: 64 * 1024 * 1024, ...timing };
  if (Object.values(bounds).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Expo-startens gränser måste vara positiva heltal.');
  const control = { enabled: true, ready: false, state: 'starting', listening: false, retryable: false,
    compilingPlatform: null, warmedPlatforms: [], port, ...configuration };
  const child = spawnProcess(process.execPath, [cli, 'start', '--lan', '--go', '--port', String(port), '--max-workers', '1', '--no-dev', '--minify'], {
    cwd: expoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...env, CI: '1', EXPO_UNSTABLE_HEADLESS: '1', EXPO_OFFLINE: '0', EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: env.NODE_OPTIONS ?? '--max-old-space-size=256',
      EXPO_PACKAGER_PROXY_URL: publicUrl,
      EXPO_PUBLIC_WEB_APP_URL: webAppUrl,
      EXPO_METRO_CACHE_DIRECTORY: configuration.cacheDirectory,
    },
  });
  let stopping = false, failed = false, compiling = false, attempts = 0, probe, startupDeadline, retryTimer, killDeadline, stopPromise;
  const platformErrors = new Map();
  const transientErrors = new Set(['EXPO_COMPILE_TIMEOUT', 'EXPO_COMPILE_HTTP', 'EXPO_COMPILE_INTERRUPTED', 'EXPO_COMPILE_CONNECTION']);
  const sockets = new Set(), abort = new AbortController();
  const alive = () => child.exitCode == null && child.signalCode == null;
  const clearStartup = () => {
    clearInterval(probe); clearTimeout(startupDeadline); clearTimeout(retryTimer);
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
    failed = true; control.ready = false; control.listening = false; control.retryable = false;
    control.state = 'error'; control.errorCode = code; control.compilingPlatform = null;
    control.warmedPlatforms = [];
    delete control.retryAt;
    clearStartup(); abort.abort(); terminate();
    // The owning HTTP server reports this optional subsystem failure. It must
    // remain available for business APIs when Metro exits or runs out of heap.
    try { onFailure(control); } catch { console.error('Expo Go-starten misslyckades.'); }
  };
  const compile = async () => {
    if (stopping || failed || compiling || !control.listening) return;
    compiling = true; attempts += 1;
    control.state = 'compiling'; delete control.retryAt;
    clearInterval(probe); clearTimeout(startupDeadline); clearTimeout(retryTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    try {
      for (const platform of ['ios', 'android']) {
        if (stopping || failed) return;
        if (control.warmedPlatforms.includes(platform)) continue;
        if (platformErrors.has(platform) && !transientErrors.has(platformErrors.get(platform))) continue;
        control.compilingPlatform = platform;
        try {
          await warmBundle({ port, publicUrl, platform, httpRequest, timeoutMs: bounds.warmupTimeoutMs,
            maxBytes: bounds.maxBundleBytes, signal: abort.signal });
          if (stopping || failed) return;
          control.warmedPlatforms.push(platform);
          platformErrors.delete(platform);
        } catch (error) {
          if (stopping || failed) return;
          const code = error.code ?? 'EXPO_COMPILE_CONNECTION';
          platformErrors.set(platform, code);
          console.warn(`Expo-förberedelse ${platform}: ${code}. Metro behålls för återhämtning.`);
        }
        control.errorCode = platformErrors.values().next().value;
      }
      if (stopping || failed) return;
      control.compilingPlatform = null;
      control.ready = control.warmedPlatforms.length === 2;
      if (control.ready) {
        control.state = 'ready'; control.retryable = false; delete control.errorCode;
        console.log('Expo Go-paketen är förberedda. Öppna /expo-go för QR-koden.');
      } else {
        control.retryable = [...platformErrors.values()].some(code => transientErrors.has(code));
        control.state = control.retryable && attempts < bounds.maxWarmupAttempts ? 'retrying' : 'error';
        if (control.retryable) control.retryAt = new Date(Date.now() + bounds.retryDelayMs).toISOString();
        if (control.state === 'retrying') {
          retryTimer = setTimeout(() => { void compile(); }, bounds.retryDelayMs);
          retryTimer.unref?.();
        } else {
          try { onFailure(control); } catch { console.error('Expo Go-förberedelsen väntar.'); }
        }
      }
    } finally { compiling = false; }
  };
  control.retry = () => {
    if (stopping || failed || compiling || !control.listening || !control.retryable || control.state !== 'error') return false;
    if (control.retryAt && Date.parse(control.retryAt) > Date.now()) return false;
    attempts = 0;
    void compile();
    return true;
  };
  probe = setInterval(() => {
    if (stopping || failed || control.state !== 'starting' || sockets.size) return;
    let socket;
    try { socket = connectSocket({ host: '127.0.0.1', port }); } catch { return; }
    sockets.add(socket);
    socket.setTimeout(bounds.socketTimeoutMs, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => { sockets.delete(socket); socket.destroy(); });
    socket.once('connect', () => {
      sockets.delete(socket); socket.destroy();
      if (stopping || failed) return;
      control.listening = true; void compile();
    });
  }, bounds.probeIntervalMs);
  probe.unref();
  startupDeadline = setTimeout(() => fail('EXPO_STARTUP_TIMEOUT'), bounds.startupTimeoutMs);
  startupDeadline.unref?.();
  child.on('error', () => {
    fail('EXPO_PROCESS_ERROR');
  });
  child.once('exit', () => {
    control.ready = false; clearTimeout(killDeadline);
    if (!stopping) fail('EXPO_PROCESS_EXIT');
  });
  control.stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true; control.ready = false; control.listening = false; control.retryable = false;
    control.warmedPlatforms = [];
    delete control.retryAt; clearStartup(); abort.abort();
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
