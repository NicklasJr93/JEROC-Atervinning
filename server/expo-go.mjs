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

export function startExpoGo({ onFailure }) {
  const enabled = process.env.EXPO_GO_ENABLED !== 'false' && Boolean(process.env.EXPO_TOKEN);
  if (!enabled) return { enabled: false, ready: false, stop: async () => {} };
  const publicUrl = process.env.RENDER_EXTERNAL_URL ?? process.env.EXPO_PUBLIC_WEB_APP_URL;
  if (!publicUrl || !/^https?:\/\//.test(publicUrl)) {
    throw new Error('Expo Go behöver RENDER_EXTERNAL_URL eller EXPO_PUBLIC_WEB_APP_URL.');
  }
  const cli = resolve(expoRoot, 'node_modules/expo/bin/cli');
  if (!existsSync(cli)) throw new Error('Expo-beroenden saknas. Använd npm run build:render i Render.');
  const port = Number(process.env.EXPO_INTERNAL_PORT ?? '8081');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(process.env.PORT)) {
    throw new Error('EXPO_INTERNAL_PORT måste vara en egen port mellan 1 och 65535.');
  }
  const control = { enabled: true, ready: false, port, publicUrl };
  const child = spawn(process.execPath, [cli, 'start', '--lan', '--go', '--port', String(port), '--max-workers', '1', '--no-dev', '--minify'], {
    cwd: expoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env, CI: '1', EXPO_UNSTABLE_HEADLESS: '1', EXPO_OFFLINE: '0', EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=256',
      EXPO_PACKAGER_PROXY_URL: publicUrl.replace(/\/$/, ''),
      EXPO_PUBLIC_WEB_APP_URL: publicUrl.replace(/\/$/, ''),
    },
  });
  let stopping = false;
  const probe = setInterval(() => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(500, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('connect', () => {
      control.ready = true;
      clearInterval(probe);
      socket.destroy();
      console.log('Expo Go-servern är startad. Öppna /expo-go för QR-koden.');
    });
  }, 500);
  probe.unref();
  child.once('error', () => {
    clearInterval(probe);
    if (!stopping) onFailure();
  });
  child.once('exit', () => {
    control.ready = false;
    clearInterval(probe);
    if (!stopping) onFailure();
  });
  control.stop = async () => {
    stopping = true;
    clearInterval(probe);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((done) => {
      child.once('exit', done);
      child.kill('SIGTERM');
    });
  };
  return control;
}
