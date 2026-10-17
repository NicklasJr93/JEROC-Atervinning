import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { expoStatus, retryExpo, serveExpo, startExpoGo } from './expo-go.mjs';
import { closePdfRenderer } from './documents/render-pool.mjs';
import { measureDatabaseWork } from './database-runtime.mjs';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createTestCarApi } from './telematics/testcar-api.mjs';
import { createDemoReceiverRuntime } from './telematics/demo-runtime.mjs';
import { createServiceTestCar } from './telematics/demo-client.mjs';

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
  // A public, synthetic-only lab has its own bounded browser sessions. It has
  // no capability to select a tenant or write business/production telemetry.
  if (await testCarApi(req, res, url)) return;
  if (await tenantGateway.selectPage(req, res, url)) return;
  if (await tenantGateway(req, res, url)) return;
  if (pathname === '/expo/retry' && req.method === 'POST') {
    retryExpo(req, res, expoGo);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    reply(res, 405, 'Method not allowed');
    return;
  }
  if (pathname === '/healthz') {
    // Expo is optional. Warming or a failed Metro process must not hold
    // customer, payroll or payment APIs unavailable during a deployment.
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok' }));
    return;
  }
  if (pathname === '/expo/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(expoStatus(expoGo)));
    return;
  }
  const nativeManifest = pathname === '/' && (req.headers['expo-platform'] || req.headers['exponent-platform'] || req.headers.accept?.includes('application/expo+json'));
  if (nativeManifest || ['/manifest', '/index.exp', '/index.bundle', '/index.ts.bundle'].includes(pathname) || pathname === '/expo' || pathname.startsWith('/expo/')) {
    serveExpo(req, res, expoGo);
    return;
  }
  // Serve only the build directory. Future API routes belong before this block.
  if (pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
    reply(res, 404, 'Not found');
    return;
  }
  const staticPath = ['/', '/testbil1', '/testbil1/', '/rosttest', '/rosttest/', '/kontor', '/kontor/', '/kontor/integration/systemadminintegrationtest.html', '/kontor/integration/systemadminvismatest.html', '/kontor/integration/systemadminswishtest.html', '/kontor/integration/systemadminbanktest.html', '/mobil', '/mobil/', '/terminal', '/terminal/', '/chauffor', '/chauffor/', '/kund', '/kund/', '/akeri', '/akeri/'].includes(pathname) ? '/index.html' : pathname === '/expo-go' ? '/expo-go.html' : pathname;
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
  const started = performance.now();
  const operation = async metrics => {
    if (metrics) {
      const writeHead = res.writeHead;
      res.writeHead = function (...args) {
        const fields = args.find(value => value && typeof value === 'object');
        const current = fields?.['Server-Timing'] ?? this.getHeader('Server-Timing');
        const timings = `request;dur=${(performance.now() - started).toFixed(1)}, db_pool;dur=${metrics.poolWaitMs.toFixed(1)}, db_sql;dur=${metrics.sqlMs.toFixed(1)}, db_queries;desc="${metrics.sqlCount}", db_lock;dur=${metrics.lockQueryMs.toFixed(1)}`;
        const merged = [current, timings].filter(Boolean).join(', ');
        if (fields) fields['Server-Timing'] = merged;
        else this.setHeader('Server-Timing', merged);
        return writeHead.apply(this, args);
      };
    }
    await handle(req, res);
  };
  (req.url?.startsWith('/api/') ? measureDatabaseWork(operation) : operation()).catch((error) => {
    if (res.destroyed) return;
    console.error('Kunde inte hantera anrop:', error.code ?? 'unknown');
    if (res.headersSent) res.destroy();
    else reply(res, 500, 'Server error');
  });
});
const testCarRuntime = createDemoReceiverRuntime();
const testCarApi = createTestCarApi({ factory: callbacks => createServiceTestCar({ createClient: testCarRuntime.createClient, ...callbacks }) });
const tenantGateway = await createTenantGateway({ testCarApi });
let expoGo;
try {
  expoGo = startExpoGo({ onFailure: state => { console.error('Expo Go kunde inte förberedas:', state.errorCode, 'Webbappen och dess API fortsätter fungera.'); } });
} catch {
  console.error('Expo Go-inställningarna kunde inte användas. Kontrollera Expo-konfigurationen i Render.');
  expoGo = { enabled: true, ready: false, state: 'error', compilingPlatform: null, warmedPlatforms: [], errorCode: 'EXPO_CONFIGURATION_ERROR', stop: async () => {} };
}
server.on('error', (error) => {
  console.error('Servern kunde inte starta:', error.code);
  process.exit(1);
});
// Every worker obtains its immutable company service bundle; no active browser
// selection or current support account can redirect a queued integration job.
const accountingTimer = setInterval(() => { void tenantGateway.runWorkers('processQueuedExports').catch(() => console.warn('Spiris-kön väntar på nästa kontroll.')); }, 20000);
accountingTimer.unref();
const accountingTrackingTimer = setInterval(() => { void tenantGateway.runWorkers('processAccountingTracking').catch(() => console.warn('Spiris-uppföljningen väntar på nästa kontroll.')); }, 60000);
accountingTrackingTimer.unref();
void tenantGateway.runWorkers('processQueuedExports');
void tenantGateway.runWorkers('processAccountingTracking');
const paymentTimer = setInterval(() => {
  void tenantGateway.runWorkers('processQueuedPayments').catch(() => console.warn('Betalningskön väntar på nästa kontroll.'));
}, 3000);
paymentTimer.unref();
void tenantGateway.runWorkers('processQueuedPayments');
server.listen(port, '0.0.0.0', () => {
  console.log(`ScrapPilot lyssnar på port ${server.address().port}`);
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(accountingTimer);
  clearInterval(accountingTrackingTimer);
  clearInterval(paymentTimer);
  testCarApi.close();
  setTimeout(() => process.exit(1), 10000).unref();
  await Promise.all([new Promise((done) => server.close(done)), expoGo.stop(), tenantGateway.close(), testCarRuntime.close()]);
  await closePdfRenderer();
  process.exit(code);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
