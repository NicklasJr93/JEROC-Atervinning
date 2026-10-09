import { createEnvironmentRepository, EnvironmentError } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createPricingStore } from './pricing.mjs';
import { z } from 'zod';
import { createEnvironmentAddressResolver, ENVIRONMENT_MUNICIPALITIES } from './environment-address.mjs';

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

/** This module deliberately exports no NVV transport. It prepares durable
 * receipt/report records only. Staff sessions are explicit demo sessions;
 * legacy demo APIs keep their documented security boundaries. */
export function createEnvironmentApi({ principalStore = createPricingStore(), repository, env = process.env, now, approvalGuard, addressResolver = createEnvironmentAddressResolver() } = {}) {
  let repositoryPromise, storePromise;
  const getStore = () => {
    if (!storePromise) {
      repositoryPromise = repository ? Promise.resolve(repository) : createEnvironmentRepository({ env });
      storePromise = repositoryPromise.then((value) => createEnvironmentStore({ repository: value, principalStore, now, approvalGuard, demoMode: env.JEROC_DEMO_AUTO_SESSION !== 'false' }));
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
      // These headers are conditions on the cookie identity, never credentials.
      // A second tab may replace the shared cookie while the first tab is editing.
      if (!['/session', '/login', '/demo-session'].includes(route)
        && (req.headers['x-environment-actual-user'] || req.headers['x-environment-effective-user'])) {
        const current = await store.session(token);
        if (current.actualUserId !== req.headers['x-environment-actual-user']
          || current.effectiveUserId !== req.headers['x-environment-effective-user'])
          throw new EnvironmentError('Kontot har ändrats i en annan flik. Uppdatera miljöuppgifterna innan du fortsätter.', 403, 'session_identity_mismatch');
      }
      if (!['/login', '/demo-session'].includes(route) && (req.headers['x-environment-actual-user'] !== undefined || req.headers['x-environment-effective-user'] !== undefined))
        await store.assertIdentity(token, req.headers['x-environment-actual-user'], req.headers['x-environment-effective-user']);
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
        if (!read) await store.csrf(token, req.headers['x-environment-csrf']);
        const classification = route.match(/^\/classifications\/([a-zA-Z0-9_-]{1,100})$/);
        const draft = route.match(/^\/drafts\/([a-fA-F0-9-]{36})$/);
        const correction = route.match(/^\/receipts\/([a-fA-F0-9-]{36})\/corrections$/);
        const site = route.match(/^\/sites\/([a-zA-Z0-9_-]{1,100})$/);
        const storage = route.match(/^\/storage(?:\/policies)?\/([a-zA-Z0-9_-]{1,100})$/);
        if (read && classification) json(res, 200, await store.classification(classification[1], token), req.method === 'HEAD');
        else if (req.method === 'PUT' && classification) json(res, 200, await store.classify(classification[1], await body(req), token));
        else if (req.method === 'PUT' && site) json(res, 200, await store.saveSite(site[1], await body(req), token));
        else if (req.method === 'PUT' && storage) json(res, 200, await store.saveStoragePolicy(storage[1], await body(req), token));
        else if (req.method === 'POST' && route === '/storage/check') json(res, 200, await store.checkStorage(await body(req), token));
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
    } catch (error) {
      const known = error instanceof EnvironmentError;
      json(res, known ? error.status : 503, { demo: true, mode: 'prepared-only', error: known ? error.message : 'Miljödatabasen kunde inte nås. Kontrollera serverns databasinställningar.',
        code: known ? error.code : 'storage_unavailable' });
    }
    return true;
  };
  // Only used by other server modules. Terminal accounts receive their own
  // restricted DTO, not an unauthenticated facility-management endpoint.
  api.getSites = async () => (await getStore()).catalog();
  api.assertReceiptForAttest = async (approval) => (await getStore()).assertReceiptForAttest(approval);
  api.close = async () => { if (repositoryPromise) await repositoryPromise.then((value) => value.close()).catch(() => {}); };
  return api;
}
