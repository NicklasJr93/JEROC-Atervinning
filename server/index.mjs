import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { proxyExpo, startExpoGo } from './expo-go.mjs';
import { createPricingApi } from './pricing-api.mjs';
import { createPricingStore } from './pricing.mjs';
import { createTransportIntegrationsApi } from './transport-integrations.mjs';
import { createTerminalDemoApi } from './terminal-demo.mjs';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT måste vara ett heltal mellan 0 och 65535.');
  process.exit(1);
}
try {
  if (!(await stat(resolve(dist, 'index.html'))).isFile()) throw new Error();
} catch {
  console.error('Webbbygget saknas. Kör npm run build före npm start.');
  process.exit(1);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
function reply(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
async function handle(req, res) {
  let pathname;
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    reply(res, 400, 'Invalid URL');
    return;
  }
  if (await pricingApi(req, res, url)) return;
  if (await transportIntegrationsApi(req, res, url)) return;
  if (await terminalDemoApi(req, res, url)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    reply(res, 405, 'Method not allowed');
    return;
  }
  if (pathname === '/healthz') {
    const ready = !expoGo.enabled || expoGo.ready;
    res.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: ready ? 'ok' : 'starting' }));
    return;
  }
  if (pathname === '/expo/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ enabled: expoGo.enabled, ready: expoGo.ready }));
    return;
  }
  const nativeManifest = pathname === '/' && (req.headers['expo-platform'] || req.headers['exponent-platform'] || req.headers.accept?.includes('application/expo+json'));
  if (nativeManifest || ['/manifest', '/index.exp', '/index.bundle', '/index.ts.bundle'].includes(pathname) || pathname === '/expo' || pathname.startsWith('/expo/')) {
    if (!expoGo.enabled) {
      reply(res, 503, 'Expo Go är inte aktiverat. Se /expo-go för instruktioner.');
      return;
    }
    proxyExpo(req, res, expoGo);
    return;
  }
  // Serve only the build directory. Future API routes belong before this block.
  if (pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    reply(res, 404, 'Not found');
    return;
  }
  const staticPath = ['/', '/kontor', '/kontor/', '/mobil', '/mobil/', '/terminal', '/terminal/'].includes(pathname) ? '/index.html' : pathname === '/expo-go' ? '/expo-go.html' : pathname;
  const file = resolve(dist, `.${staticPath}`);
  const within = relative(dist, file);
  if (within.startsWith('..') || isAbsolute(within)) {
    reply(res, 404, 'Not found');
    return;
  }
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      reply(res, 404, 'Not found');
      return;
    }
    throw error;
  }
  if (!info.isFile()) {
    reply(res, 404, 'Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': /^\/assets\/[^/]+-[\w-]+\.[\w]+$/.test(pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(file), res);
}
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (res.destroyed) return;
    console.error('Kunde inte hantera anrop:', error.code ?? 'unknown');
    if (res.headersSent) res.destroy();
    else reply(res, 500, 'Server error');
  });
});
const principalStore = createPricingStore();
const pricingApi = createPricingApi({ store: principalStore });
const transportIntegrationsApi = createTransportIntegrationsApi({ principalStore });
const terminalDemoApi = createTerminalDemoApi({ principalStore });
const expoGo = startExpoGo({ onFailure: () => {
  console.error('Expo-servern har stannat. Startar om tjänsten.');
  stop(1);
} });
server.on('error', (error) => {
  console.error('Servern kunde inte starta:', error.code);
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`JEROC demo lyssnar på port ${server.address().port}`);
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 10000).unref();
  await Promise.all([new Promise((done) => server.close(done)), expoGo.stop(), terminalDemoApi.close()]);
  process.exit(code);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
