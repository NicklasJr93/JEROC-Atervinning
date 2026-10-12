import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { proxyExpo, startExpoGo } from './expo-go.mjs';
import { createApplicationService } from './application.mjs';
import { createTerminalDemoApi } from './terminal-demo.mjs';
import { createEnvironmentApi } from './environment-api.mjs';
import { createDocumentsApi } from './documents/api.mjs';
import { renderPdf, closePdfRenderer } from './documents/render-pool.mjs';
import { PricingError, getArticleMediaReferences } from './pricing.mjs';
import { measureDatabaseWork } from './database-runtime.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { createArticleMediaApi } from './article-media.mjs';
import { ensureLogistics } from './logistics.mjs';

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
  if (pathname === '/api/integrations/visma/oauth/callback') {
    if (req.method !== 'GET') { reply(res, 405, 'Method not allowed'); return; }
    const bindingCookie = (req.headers.cookie ?? '').split(';').find(item => item.trim().startsWith('jeroc_visma_oauth='));
    let binding;
    try { binding = bindingCookie && decodeURIComponent(bindingCookie.trim().slice('jeroc_visma_oauth='.length)); } catch { binding = undefined; }
    let outcome = 'error';
    try {
      await vismaService.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'),
        error: url.searchParams.get('error'), cookieBinding: binding });
      outcome = 'ok';
    } catch { /* The fixed redirect never exposes OAuth codes or provider secrets. */ }
    const secure = Boolean(process.env.RENDER) || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.writeHead(303, { Location: `/kontor/integration/systemadminvismatest.html?vismaOAuth=${outcome}#/integrations/visma-test`,
      'Set-Cookie': `jeroc_visma_oauth=; Path=/api/integrations/visma/oauth/callback; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`,
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(); return;
  }
  if (await articleMediaApi(req, res, url)) return;
  if (await applicationApi(req, res, url)) return;
  if (await documentsApi(req, res, url)) return;
  if (pathname.startsWith("/api/terminal-demo") || pathname.startsWith("/api/environment")) {
    const handled = (await terminalDemoApi(req, res, url)) || (await environmentApi(req, res, url));
    if (handled) return;
  }
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
  const staticPath = ['/', '/kontor', '/kontor/', '/kontor/integration/systemadminintegrationtest.html', '/kontor/integration/systemadminvismatest.html', '/mobil', '/mobil/', '/terminal', '/terminal/', '/chauffor', '/chauffor/', '/kund', '/kund/', '/akeri', '/akeri/'].includes(pathname) ? '/index.html' : pathname === '/expo-go' ? '/expo-go.html' : pathname;
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
const applicationApi = createApplicationService({ approvalProvider: () => terminalDemoApi.projections(),
  projections: cardId => terminalDemoApi.projections(cardId),
  sendCustomerReview: (payload, principal, req) => terminalDemoApi.sendPrepared(payload, principal, req),
  withMaterialChangeApproval: (input, identity, operation) => terminalDemoApi.withMaterialChangeApproval(input, identity, operation),
  guardMaterialChange: (input, operation) => environmentApi.guardMaterialChange(input, operation),
  siteProvider: () => environmentApi.getSites(),
  environmentProvider: () => environmentApi.getLogisticsSource(),
  accountingSettingsProvider: customer => vismaService.financeSettingsForCompany(customer),
  accountingCardStatusProvider: cardId => vismaService.cardExportProjection(cardId),
  validateArticleMedia: async (route, input) => {
    const references = getArticleMediaReferences(route, input);
    if (references.length && !await articleMediaApi.hasImages(references))
      throw new PricingError('En uppladdad bild saknas. Ladda upp bilden igen innan du sparar.', 422);
  },
});
const principalStore = applicationApi.principalStore;
const articleMediaApi = createArticleMediaApi({ authorize: req => applicationApi.withPrincipal(() => {
  const actor = req.headers['x-demo-actor'];
  const user = req.headers['x-demo-user'] ?? actor;
  if (typeof actor !== 'string' || typeof user !== 'string')
    throw new PricingError('Välj ett giltigt konto innan du laddar upp en bild.', 401);
  return principalStore.principal(actor, user);
}) });
const vismaService = createVismaSandbox({ getRepository: () => applicationApi.getRepository(),
  sourceProvider: request => terminalDemoApi.documentProjections(request), sitesProvider: () => environmentApi.getSites(),
  authorizeContext: async context => {
    if (typeof context.reauthorize !== 'function') throw new PricingError('Den aktiva integrationssessionen saknas.', 403);
    const session = await context.reauthorize();
    if (session.actor.id !== context.actorId || session.user.id !== context.effectiveUserId) throw new PricingError('Integrationssessionen har ändrats.', 403);
    if (session.actor.level !== 'Systemadmin' || session.user.level !== 'Systemadmin' || session.actor.siteIds || session.user.siteIds)
      throw new PricingError('Systemadmin med åtkomst till alla anläggningar krävs.', 403);
  },
});
const environmentApi = createEnvironmentApi({ principalStore,
  vismaService,
  approvalGuard: (input, operation) => terminalDemoApi.withApprovedCard(input, operation),
  outboundProvider: async () => (await applicationApi.getRepository()).read(state =>
    (state.logistics?.inventoryMovements ?? []).filter(row => row.kind === 'outbound' && row.hazardous)
      .map(row => ({ id: row.id, siteId: row.siteId, articleId: row.articleId, wasteCode: row.wasteCode,
        weight: row.kg, receivedAt: row.at, kind: 'outbound', sourceId: row.sourceId })), { domains: ['logistics'] }),
});
const terminalDemoApi = createTerminalDemoApi({ principalStore, siteProvider: () => environmentApi.getSites(),
  environmentApprovalCheck: approval => environmentApi.assertReceiptForAttest(approval),
  accountingSourceProvider: async request => {
    const customer = await (await applicationApi.getRepository()).read(state => structuredClone(state.office.customers.find(value => value.id === request.customer.id)), { domains: ['office'] });
    const settings = await vismaService.financeSettingsForCompany(customer);
    if (!settings) return null;
    return { settings, customer };
  },
  onAttested: approval => vismaService.processQueuedExports({ cardId: approval.cardId, reconcile: false }),
  onApprovalChanged: (approval, job) => job
    ? documentsApi.archiveApprovalJob(approval, job)
    : documentsApi.ensureApproval(approval),
});
const documentsApi = createDocumentsApi({
  renderPdf,
  resolvePrincipal: req => principalStore.runFreshPrincipal(() => {
    const actor = req.headers['x-demo-actor'];
    const user = req.headers['x-demo-user'] ?? actor;
    if (typeof actor !== 'string' || typeof user !== 'string')
      throw new PricingError('Välj ett giltigt demokonto.', 401);
    return principalStore.principal(actor, user);
  }),
  sourceProvider: async (request = {}) => {
    if (request.kind === 'article-names') {
      const repository = await applicationApi.getRepository();
      return { pricing: { articles: await repository.readArticleNames(request.articleIds) } };
    }
    // A durable PDF job already supplies its frozen business/approval source.
    // Older jobs need only the facility, never all current application history.
    if (request.kind === 'approval-job') return { sites: await environmentApi.getSites() };
    if (request.kind === 'approval') {
      const [approvals, sites] = await Promise.all([
        terminalDemoApi.documentProjections({ cardId: Number(request.sourceId), approvalId: request.approvalId }),
        environmentApi.getSites(),
      ]);
      return { approvals, sites };
    }
    const repository = await applicationApi.getRepository();
    // Release the application aggregate before reading the terminal/environment
    // aggregates. No nested cross-module locks while rendering or archiving PDF.
    const transport = request.kind === 'transport';
    const readSource = async () => {
      const logistics = transport && repository.readProjection
        ? await repository.readProjection(state => state.logistics ?? { details: {} }, { domain: 'logistics', paths: [['details', String(request.sourceId)]] }) : undefined;
      return repository.read(state => {
        if (logistics) state.logistics = logistics;
        const payments = request.kind === 'receipt' ? state.office.payments.filter(value => String(value.id) === String(request.sourceId)) : [];
        const cardId = request.kind === 'receipt' ? payments[0]?.cardId : request.sourceId;
        const cards = transport ? [] : state.office.cards.filter(value => String(value.id) === String(cardId));
        const orders = transport ? state.transport.orders.filter(order => order.id === request.sourceId) : [];
        const customers = state.office.customers.filter(customer => cards.some(card => card.customerId === customer.id) || orders.some(order => order.customerId === customer.id));
        const drivers = transport ? state.transport.drivers.filter(driver => orders.some(order => order.driverId === driver.id || state.logistics?.details?.[order.id]?.assignedDriverId === driver.id)) : [];
        return structuredClone({ office: { cards, customers, payments },
          ...(transport ? {
            transport: { orders, drivers, vehicles: state.transport.vehicles.filter(vehicle => orders.some(order => order.vehicleId === vehicle.id || state.logistics?.details?.[order.id]?.assignedVehicleId === vehicle.id)) },
            personnel: { companies: state.personnel.companies.filter(company => drivers.some(driver => driver.companyId === company.id) || state.logistics?.details?.[request.sourceId]?.carrierId === company.id) },
            logistics: { details: state.logistics?.details?.[request.sourceId] ? { [request.sourceId]: state.logistics.details[request.sourceId] } : {} },
          } : {}),
        });
      }, { domains: transport ? ['office', 'transport', 'personnel', ...(logistics ? [] : ['logistics'])] : ['office'] });
    };
    const source = await (repository.runInReadTransaction ? repository.runInReadTransaction(readSource) : readSource());
    const [approvals, sites] = await Promise.all([
      transport ? [] : terminalDemoApi.documentProjections({ cardId: Number(source.office.cards[0]?.id ?? source.office.payments[0]?.cardId ?? request.sourceId) }),
      environmentApi.getSites(),
    ]);
    return { ...source, approvals, sites };
  },
});
const expoGo = startExpoGo({ onFailure: () => {
  console.error('Expo-servern har stannat. Startar om tjänsten.');
  stop(1);
} });
server.on('error', (error) => {
  console.error('Servern kunde inte starta:', error.code);
  process.exit(1);
});
// Complete migrations/seeding before accepting a request. Read-only snapshots
// and SSE reconnects never need to initialize another repository while open.
await applicationApi.getRepository();
await vismaService.initialize();
await articleMediaApi.ready();
await environmentApi.initialize();
// Persist initial stock/catalog maintenance once, so a fresh installation also
// records physical mobile/office changes without relying on a later GET.
const [logisticsSites, logisticsEnvironment] = await Promise.all([
  environmentApi.getSites(), environmentApi.getLogisticsSource(),
]);
await (await applicationApi.getRepository()).transact(state => ensureLogistics(state, {
  sites: logisticsSites, ...logisticsEnvironment,
}));
await terminalDemoApi.initialize?.();
// Discover committed attests after a restart as well as through the immediate
// hook. The queue is durable; no provider operation runs in the attest request.
const accountingTimer = setInterval(() => { void vismaService.processQueuedExports({ reconcile: false }).catch(() => console.warn('Spiris-kön väntar på nästa kontroll.')); }, 20000);
accountingTimer.unref();
void vismaService.processQueuedExports().catch(() => console.warn('Spiris-kön kunde inte kontrolleras vid start.'));
// Status reads are scheduled from each persisted job's next-check time. This
// heartbeat never books an invoice, pays a supplier or recreates a draft.
const accountingTrackingTimer = setInterval(() => { void vismaService.processAccountingTracking().catch(() => console.warn('Spiris-uppföljningen väntar på nästa kontroll.')); }, 60000);
accountingTrackingTimer.unref();
void vismaService.processAccountingTracking().catch(() => console.warn('Spiris-uppföljningen kunde inte kontrolleras vid start.'));
server.listen(port, '0.0.0.0', () => {
  console.log(`JEROC demo lyssnar på port ${server.address().port}`);
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(accountingTimer);
  clearInterval(accountingTrackingTimer);
  setTimeout(() => process.exit(1), 10000).unref();
  await Promise.all([new Promise((done) => server.close(done)), expoGo.stop(), terminalDemoApi.close(), environmentApi.close(), applicationApi.close(), documentsApi.close(), articleMediaApi.close()]);
  await closePdfRenderer();
  process.exit(code);
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
