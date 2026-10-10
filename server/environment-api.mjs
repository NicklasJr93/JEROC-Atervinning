import { createEnvironmentRepository, EnvironmentError } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createPricingStore } from './pricing.mjs';
import { z } from 'zod';
import { createEnvironmentAddressResolver, ENVIRONMENT_MUNICIPALITIES } from './environment-address.mjs';
import { createNvvClient } from './nvv-client.mjs';
import { createIntegrationEngine, createNvvIntegrationAdapter } from './integrations.mjs';
import { getChangeEvents } from './change-events.mjs';

const COOKIE = 'jeroc_environment_staff';
const MAX_BODY = 128 * 1024;
function cookies(req) {
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const equal = item.indexOf('=');
    if (item.slice(0, equal).trim() === COOKIE) {
      try { return decodeURIComponent(item.slice(equal + 1)); } catch { return undefined; }
    }
  }
}
function setCookie(req, res, value, expiresAt, env) {
  const secure = Boolean(env.RENDER) || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const expires = value ? `; Expires=${new Date(expiresAt).toUTCString()}` : '; Max-Age=0';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; Path=/api/environment; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${expires}`);
}
function json(res, status, value, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
}
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new EnvironmentError('Anropet måste komma från samma webbplats.', 403, 'origin_forbidden');
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); } catch { throw new EnvironmentError('Ogiltigt ursprung.', 403, 'origin_forbidden'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.host)
    throw new EnvironmentError('Anropet måste komma från samma webbplats.', 403, 'origin_forbidden');
}
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new EnvironmentError('Använd application/json.', 415, 'content_type');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new EnvironmentError('Anropet är för stort.', 413, 'payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new EnvironmentError('Anropet är för stort.', 413, 'payload_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new EnvironmentError('Ogiltig JSON.'); }
}

/** Cookie-authenticated façade over the durable environment/reporting service.
 * Staff sessions remain explicit demo sessions. The integration registry uses
 * a server-owned organisation scope, not browser-supplied tenant identifiers. */
export function createEnvironmentApi({ principalStore = createPricingStore(), repository, env = process.env, now, approvalGuard, outboundProvider, nvvClient, addressResolver = createEnvironmentAddressResolver() } = {}) {
  let repositoryPromise, storePromise;
  const changes = getChangeEvents(env);
  const getStore = () => {
    if (!storePromise) {
      repositoryPromise = repository ? Promise.resolve(repository) : createEnvironmentRepository({ env });
      storePromise = repositoryPromise.then((value) => createEnvironmentStore({ repository: value, principalStore, now, approvalGuard, outboundProvider, nvvClient: nvvClient ?? createNvvClient({ env, now }), onChanged: revision => changes.publish({ domain: 'environment', revision }), demoMode: env.JEROC_DEMO_AUTO_SESSION !== 'false' }));
      const attempt = storePromise;
      attempt.catch(() => { if (storePromise === attempt) { storePromise = undefined; repositoryPromise = undefined; } });
    }
    return storePromise;
  };
  const api = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/environment/')) return false;
    try {
      checkOrigin(req);
      const store = await getStore(), token = cookies(req);
      const route = url.pathname.slice('/api/environment'.length), read = req.method === 'GET' || req.method === 'HEAD';
      // Expected identities and CSRF are verified with the cookie and live
      // permissions inside the same operation/snapshot, never as a warm chain.
      const loginRoute = ['/login', '/demo-session'].includes(route);
      await store.withRequest({ token, includePatch: true,
        ...(!loginRoute && { actualUserId: req.headers['x-environment-actual-user'], effectiveUserId: req.headers['x-environment-effective-user'] }),
        csrfToken: req.headers['x-environment-csrf'], requireCsrf: !read && !loginRoute,
      }, async () => {
        if (read && route === '/session') json(res, 200, await store.session(token), req.method === 'HEAD');
        else if (read && route === '/state') json(res, 200, { ...await store.state(token, url.searchParams.get('siteId') ?? 'all'), municipalities: ENVIRONMENT_MUNICIPALITIES }, req.method === 'HEAD');
        else if (req.method === 'POST' && route === '/login') {
          const result = await store.login(await body(req), token, req.socket.remoteAddress ?? '');
          setCookie(req, res, result.token, result.result.expiresAt, env); json(res, 200, result.result);
        } else if (req.method === 'POST' && route === '/demo-session') {
          // Explicitly DEMO: selecting a known demo staff account is sufficient.
          // Real staff authentication is not claimed or enabled by this endpoint.
          const result = await store.demoSession(await body(req), token);
          setCookie(req, res, result.token, result.result.expiresAt, env); json(res, 200, result.result);
        } else {
          const classification = route.match(/^\/classifications\/([a-zA-Z0-9_-]{1,100})$/);
          const source = route.match(/^\/sources\/([a-fA-F0-9-]{36})$/);
          const draft = route.match(/^\/drafts\/([a-fA-F0-9-]{36})$/);
          const correction = route.match(/^\/receipts\/([a-fA-F0-9-]{36})\/corrections$/);
          const site = route.match(/^\/sites\/([a-zA-Z0-9_-]{1,100})$/);
          const storage = route.match(/^\/storage(?:\/policies)?\/([a-zA-Z0-9_-]{1,100})$/);
          const nvvReport = route.match(/^\/nvv\/reports\/([^/]+)(?:\/(send|reconcile))?$/);
          const sandboxRun = route.match(/^\/nvv\/sandbox\/runs\/([a-fA-F0-9-]{36})$/);
          const diagnosticRun = route.match(/^\/nvv\/diagnostics\/runs\/([a-fA-F0-9-]{36})$/);
          let nvvReportId;
          if (nvvReport) { try { nvvReportId = decodeURIComponent(nvvReport[1]); if (nvvReportId.length > 200) throw new Error(); } catch { throw new EnvironmentError('Ogiltigt miljöunderlags-ID.', 400, 'report_invalid'); } }
          if (read && route === '/integrations/catalog') {
            const principal = await store.authorize(token, 'integrationsRead');
            // There is one demo organisation today. A future SaaS authenticator
            // must derive memberships here and migrate provider storage by tenant.
            const context = { organisationId: 'jeroc-demo', allowedOrganisationIds: ['jeroc-demo'],
              actorId: principal.actor.id, effectiveUserId: principal.user.id, canRead: true,
              canManage: principal.actor.level === 'Systemadmin' && principal.user.level === 'Systemadmin'
                && !principal.actor.siteIds && !principal.user.siteIds };
            const integrations = createIntegrationEngine({ adapters: [createNvvIntegrationAdapter({
              organisationId: 'jeroc-demo', status: () => store.nvvStatus(token), check: () => store.nvvCheck(token),
            })] });
            json(res, 200, await integrations.catalog(context), req.method === 'HEAD');
          }
          else if (read && route === '/nvv/status') json(res, 200, await store.nvvStatus(token), req.method === 'HEAD');
          else if (read && route === '/nvv/sandbox') json(res, 200, await store.nvvSandbox(token), req.method === 'HEAD');
          else if (req.method === 'POST' && route === '/nvv/sandbox') json(res, 200, await store.nvvSandboxSend(await body(req), token));
          else if (read && sandboxRun) json(res, 200, await store.nvvSandboxRun(sandboxRun[1], token), req.method === 'HEAD');
          else if (read && route === '/nvv/diagnostics') json(res, 200, await store.nvvDiagnostics(token), req.method === 'HEAD');
          else if (req.method === 'POST' && route === '/nvv/diagnostics') json(res, 200, await store.nvvDiagnosticSend(await body(req), token));
          else if (read && diagnosticRun) json(res, 200, await store.nvvDiagnosticRun(diagnosticRun[1], token), req.method === 'HEAD');
          else if (req.method === 'PUT' && route === '/nvv/reporter') json(res, 200, await store.nvvSaveReporter(await body(req), token));
          else if (req.method === 'POST' && route === '/nvv/check') { const input = await body(req); if (!z.object({}).strict().safeParse(input).success) throw new EnvironmentError('Anslutningsprovet tar inga klientuppgifter.', 422); json(res, 200, await store.nvvCheck(token)); }
          else if (read && nvvReport && !nvvReport[2]) json(res, 200, await store.nvvDetail(nvvReportId, token), req.method === 'HEAD');
          else if (req.method === 'POST' && nvvReport?.[2] === 'send') json(res, 200, await store.nvvSend(nvvReportId, await body(req), token));
          else if (req.method === 'POST' && nvvReport?.[2] === 'reconcile') json(res, 200, await store.nvvReconcile(nvvReportId, await body(req), token));
          else if (read && classification) json(res, 200, await store.classification(classification[1], token), req.method === 'HEAD');
          else if (req.method === 'PUT' && classification) json(res, 200, await store.classify(classification[1], await body(req), token));
          else if (req.method === 'PUT' && site) json(res, 200, await store.saveSite(site[1], await body(req), token));
          else if (req.method === 'PUT' && storage) json(res, 200, await store.saveStoragePolicy(storage[1], await body(req), token));
          else if (req.method === 'POST' && route === '/storage/check') json(res, 200, await store.checkStorage(await body(req), token));
          else if (read && source) json(res, 200, await store.source(source[1], token), req.method === 'HEAD');
          else if (read && draft) json(res, 200, await store.draft(draft[1], token), req.method === 'HEAD');
          else if (req.method === 'PUT' && draft) json(res, 200, await store.saveDraft(draft[1], await body(req), token));
          else if (req.method === 'POST' && route === '/receipts') json(res, 201, await store.receive(await body(req), token));
          else if (req.method === 'POST' && correction) json(res, 201, await store.correct(correction[1], await body(req), token));
          else if (read && route === '/municipalities') { await store.authorize(token, 'environmentRead'); json(res, 200, ENVIRONMENT_MUNICIPALITIES, req.method === 'HEAD'); }
          else if (req.method === 'POST' && route === '/address/resolve') {
            const parsed = z.object({ siteId: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/), originAddress: z.string().trim().max(1000),
              municipalityCode: z.string().trim().max(10).optional(), municipalityName: z.string().trim().max(100).optional() }).strict().safeParse(await body(req));
            if (!parsed.success) throw new EnvironmentError('Kontrollera ursprungsadressen och kommunen.', 422, 'address_invalid');
            const { siteId, ...input } = parsed.data;
            await store.authorize(token, 'environmentRead', siteId);
            const result = await addressResolver(input);
            await store.authorize(token, 'environmentRead', siteId);
            json(res, 200, result);
          }
          else if (req.method === 'POST' && route === '/logout') {
            await body(req); await store.logout(token); setCookie(req, res, '', '', env); json(res, 200, { demo: true });
          } else throw new EnvironmentError('Miljö-API-vyn finns inte eller metoden stöds inte.', 404, 'not_found');
        }
      });
    } catch (error) {
      const known = error instanceof EnvironmentError;
      json(res, known ? error.status : 503, { demo: true, mode: 'prepared-only', error: known ? error.message : 'Miljödatabasen kunde inte nås. Kontrollera serverns databasinställningar.',
        code: known ? error.code : 'storage_unavailable' });
    }
    return true;
  };
  // Only used by other server modules. Terminal accounts receive their own
  // restricted DTO, not an unauthenticated facility-management endpoint.
  api.initialize = async () => (await getStore()).initialize();
  api.getSites = async () => (await getStore()).catalog();
  api.getLogisticsSource = async () => (await getStore()).logisticsSource();
  api.assertReceiptForAttest = async (approval) => (await getStore()).assertReceiptForAttest(approval);
  api.close = async () => { await changes.close(); if (repositoryPromise) await repositoryPromise.then((value) => value.close()).catch(() => {}); };
  return api;
}
