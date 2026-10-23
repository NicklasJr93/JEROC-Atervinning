import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from './platform-auth.mjs';
import { createBokforingAndeProvider, AndeProviderError, ANDE_MAX_OUTPUT_TOKENS } from './bokforing-ande-provider.mjs';
import { andeKnowledge, ANDE_KNOWLEDGE_VERSION, getAndeCitations } from './bokforing-ande-knowledge.mjs';
import { clientAddressHash } from './client-address.mjs';

const PREFIX = '/api/bokforing/ande';
const MAX_BODY_BYTES = 48 * 1024;
const LEASE_MS = 90_000;
const RETENTION_MS = 3_600_000;
const SESSION_MS = 86_400_000;
const COOKIE = 'bokforing_ande_demo';
const safeText = max => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const short = safeText(160);
const cents = z.number().int().safe().min(-1_000_000_000_000).max(1_000_000_000_000);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const stamp = Date.parse(value); return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
});
const lineSchema = z.object({
  description: short.optional(), kind: safeText(40).optional(), account: safeText(12).optional(),
  quantity: z.number().finite().min(-1e9).max(1e9).optional(), unitCents: cents.optional(),
  netCents: cents.optional(), vatRate: z.number().finite().min(0).max(100).optional(),
  vatMode: safeText(50).optional(), debitCents: cents.optional(), creditCents: cents.optional(),
  vatCents: cents.optional(), grossCents: cents.optional(),
  discountBps: z.number().int().min(0).max(10_000).optional(),
  deductibleBps: z.number().int().min(0).max(10_000).optional(), unitPriceIncludesVat: z.boolean().optional(),
}).strict();
const selectedSchema = z.object({
  kind: z.enum(['customer-invoice', 'supplier-invoice', 'journal-entry']), id: safeText(200),
  number: safeText(120), status: safeText(50).optional(), date, dueDate: date.optional(),
  netCents: cents.optional(), vatCents: cents.optional(), totalCents: cents.optional(),
  outstandingCents: cents.optional(), rotCents: cents.optional(), vatMode: safeText(50).optional(),
  lineCount: z.number().int().min(0).max(100_000), lines: z.array(lineSchema).max(12),
}).strict();
const contextSchema = z.object({
  schemaVersion: z.literal(1), source: z.literal('browser-demo'), view: safeText(100),
  route: safeText(320), label: safeText(160), fiscalYear: z.object({ start: date, end: date }).strict(),
  overview: z.object({ invoiceDrafts: z.number().int().nonnegative().max(100_000),
    purchaseDrafts: z.number().int().nonnegative().max(100_000),
    unmatchedBankEvents: z.number().int().nonnegative().max(100_000),
    journalEntries: z.number().int().nonnegative().max(100_000),
    figures: z.object({ bankCents: cents, assetsCents: cents, liabilitiesEquityCents: cents,
      revenueCents: cents, expenseCents: cents, resultCents: cents,
      receivablesCents: cents, payablesCents: cents, balanced: z.boolean() }).strict().optional() }).strict(),
  selected: selectedSchema.nullable(),
}).strict();
const inputSchema = z.object({
  question: safeText(2000).transform(value => value.trim()).refine(Boolean),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: safeText(3000).refine(value => value.length > 0) }).strict()).max(8).default([]),
  context: contextSchema.nullable().default(null),
}).strict();
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site')
    fail('Öppna Ande på samma webbplats som bokföringsdemon.', 403, 'ande_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Öppna Ande på samma webbplats som bokföringsdemon.', 403, 'ande_origin_forbidden'); }
}

async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('Anropet måste innehålla JSON.', 415, 'ande_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES)
    fail('Frågan och underlaget är för stora.', 413, 'ande_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail('Frågan och underlaget är för stora.', 413, 'ande_payload_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Frågan innehåller ogiltig JSON.', 400, 'ande_invalid_json'); }
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) fail('Frågan eller demounderlaget är ogiltigt. Öppna Ande igen och försök på nytt.', 422, 'ande_invalid_input');
  return parsed.data;
}

function reply(res, status, value, { allow, retryAfter } = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(allow ? { Allow: allow } : {}), ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
  res.end(JSON.stringify(value));
}

/** Explicitly public, synthetic-only AI demonstration. Its random capability
 * cookie is entirely separate from platform authentication, cannot select a
 * tenant and cannot grant access to business APIs. The user's usage approval
 * removes daily budgets, not basic short-window anti-spam/concurrency guards.
 * Short reservations survive deploys and are never transcripts. The provider
 * receives only the caller's bounded, allowlisted browser-demo snapshot.
 */
export function createBokforingAndeApi({ repository, env = process.env,
  provider = createBokforingAndeProvider({ env }), now = () => new Date() } = {}) {
  if (!repository?.transact || !repository?.read)
    throw new TypeError('Ande requires durable demo-session storage.');
  const limits = Object.freeze({ perSessionMinute: 10, perAddressMinute: 20,
    globalMinute: 30, concurrentGlobal: 5, maxOutputTokens: ANDE_MAX_OUTPUT_TOKENS });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const csrf = token => createHash('sha256').update(`bokforing-ande-csrf:${token}`).digest('base64url');
  function cookieToken(req) {
    const cookies = String(req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return undefined;
    const token = cookies[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  function ledgerFor(state, stamp) {
    state.bokforingAndeUsage ??= { version: 2, salt: randomBytes(32).toString('hex'), sessions: [], requests: [] };
    const ledger = state.bokforingAndeUsage;
    if (ledger.version !== 2 || !/^[a-f0-9]{64}$/.test(ledger.salt ?? '') || !Array.isArray(ledger.sessions) || !Array.isArray(ledger.requests))
      fail('Andes användningskontroll är tillfälligt otillgänglig.', 503, 'ande_usage_unavailable');
    const at = stamp.toISOString();
    ledger.sessions = ledger.sessions.filter(item => item.expiresAt > at);
    ledger.requests = ledger.requests.filter(item => Date.parse(item.at) > stamp.getTime() - RETENTION_MS);
    return ledger;
  }
  const addressFor = (ledger, req) => createHmac('sha256', ledger.salt).update(clientAddressHash(req, env)).digest('hex');
  async function getSession(req, res) {
    const stamp = new Date(now()), at = stamp.toISOString();
    let token = cookieToken(req), isNew = false;
    const session = await repository.transact(state => {
      const ledger = ledgerFor(state, stamp);
      const found = token && ledger.sessions.find(item => item.tokenHash === hash(token));
      if (found) return { ...found };
      const addressKey = addressFor(ledger, req);
      const recent = ledger.sessions.filter(item => Date.parse(item.createdAt) > stamp.getTime() - 60_000);
      if (ledger.sessions.length >= 5000 || recent.length >= 100 || recent.filter(item => item.addressKey === addressKey).length >= 20)
        fail('AI-demonstrationen används mycket just nu. Vänta en minut och försök igen.', 429, 'ande_session_limit');
      token = randomBytes(32).toString('base64url'); isNew = true;
      const next = { id: randomUUID(), tokenHash: hash(token), addressKey, createdAt: at,
        expiresAt: new Date(stamp.getTime() + SESSION_MS).toISOString() };
      ledger.sessions.push(next); return { ...next };
    });
    if (isNew) res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=86400${env.NODE_ENV === 'production' || env.RENDER === 'true' || req.socket?.encrypted ? '; Secure' : ''}`);
    return { ...session, csrfToken: csrf(token) };
  }
  async function authenticate(req) {
    const token = cookieToken(req);
    if (!token) fail('Öppna Ande eller kontrollera anslutningen för att starta en ny demosession.', 401, 'ande_session_required');
    const submitted = req.headers['x-csrf-token'];
    const expected = csrf(token);
    if (typeof submitted !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(submitted) || !timingSafeEqual(Buffer.from(submitted), Buffer.from(expected)))
      fail('Demosessionens skydd saknas eller har ändrats. Kontrollera anslutningen och försök igen.', 403, 'ande_csrf_required');
    return repository.read(state => {
      const session = state.bokforingAndeUsage?.sessions?.find(item => item.tokenHash === hash(token) && item.expiresAt > new Date(now()).toISOString());
      if (!session) fail('Demosessionen har gått ut. Kontrollera anslutningen för att fortsätta.', 401, 'ande_session_expired');
      return { ...session };
    });
  }
  async function reserve(principal, req) {
    const stamp = new Date(now()), at = stamp.toISOString(), id = randomUUID();
    return repository.transact(state => {
      const ledger = ledgerFor(state, stamp), addressKey = addressFor(ledger, req);
      if (!ledger.sessions.some(item => item.id === principal.id))
        fail('Demosessionen har gått ut. Kontrollera anslutningen för att fortsätta.', 401, 'ande_session_expired');
      const recent = ledger.requests.filter(item => Date.parse(item.at) > stamp.getTime() - 60_000);
      if (recent.length >= limits.globalMinute || recent.filter(item => item.addressKey === addressKey).length >= limits.perAddressMinute
        || recent.filter(item => item.sessionId === principal.id).length >= limits.perSessionMinute)
        fail('Ande har fått många frågor på kort tid. Vänta en minut och försök igen.', 429, 'ande_minute_limit');
      const pending = ledger.requests.filter(item => item.status === 'pending' && item.leaseUntil > at);
      if (pending.some(item => item.sessionId === principal.id) || pending.length >= limits.concurrentGlobal)
        fail('Ande arbetar redan med en fråga. Vänta tills svaret är färdigt.', 429, 'ande_busy');
      ledger.requests.push({ id, sessionId: principal.id, addressKey, at, status: 'pending', leaseUntil: new Date(stamp.getTime() + LEASE_MS).toISOString() });
      return id;
    });
  }
  async function finish(id, result) {
    await repository.transact(state => {
      const item = state.bokforingAndeUsage?.requests?.find(value => value.id === id);
      if (!item || item.status !== 'pending') return;
      item.status = result ? 'complete' : 'failed'; item.completedAt = new Date(now()).toISOString();
      delete item.leaseUntil;
      if (result) item.usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
    });
  }
  return async (req, res, url) => {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const controller = new AbortController();
    const onAbort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', onAbort); res.once?.('close', onAbort);
    let reservation, captured, completed = false;
    try {
      const statusRoute = url.pathname === `${PREFIX}/status`, chatRoute = url.pathname === `${PREFIX}/chat`;
      if (!statusRoute && !chatRoute) { reply(res, 404, { error: 'Ande-funktionen finns inte.', code: 'ande_not_found' }); return true; }
      if (req.method !== (statusRoute ? 'GET' : 'POST')) {
        reply(res, 405, { error: 'Metoden stöds inte.', code: 'ande_method' }, { allow: statusRoute ? 'GET' : 'POST' }); return true;
      }
      sameOrigin(req);
      if ([...url.searchParams.keys()].length) fail('Ange frågan i anropets innehåll.', 422, 'ande_invalid_query');
      const status = provider.status();
      if (statusRoute) {
        if (status.configured) captured = await getSession(req, res);
        reply(res, 200, { configured: status.configured, authenticated: Boolean(captured), available: status.configured,
          authmode: 'public-demo', model: status.model, ...(captured ? { csrfToken: captured.csrfToken, sessionGeneration: captured.id } : {}), limits,
          ...(!status.configured ? { reason: 'OpenAI-anslutningen är inte konfigurerad på servern.' } : {}) });
        return true;
      }
      captured = await authenticate(req);
      if (!status.configured) fail('OpenAI-anslutningen är inte konfigurerad på servern.', 503, 'ande_not_configured');
      const value = await readInput(req);
      // The atomic reservation rechecks session expiry after reading the body.
      if (controller.signal.aborted) fail('Frågan avbröts.', 499, 'ande_request_aborted');
      reservation = await reserve(captured, req);
      const result = await provider.respond({ ...value, context: value.context ?? { source: 'no-demo-context' }, knowledge: andeKnowledge }, { signal: controller.signal });
      await finish(reservation, result); completed = true;
      await authenticate(req);
      const ids = [...result.text.matchAll(/\[(?:källa:\s*)?([a-z][a-z0-9-]{1,80})\]/g)].map(match => match[1]);
      reply(res, 200, { text: result.text, model: result.model, usage: result.usage,
        knowledgeVersion: ANDE_KNOWLEDGE_VERSION, citations: getAndeCitations(ids) });
    } catch (error) {
      if (reservation && !completed) try { await finish(reservation); } catch { /* Reservation remains spent if completion recording fails. */ }
      const known = error instanceof PlatformError || error instanceof AndeProviderError;
      const status = known ? error.status : 503;
      reply(res, status, { error: known ? error.message : 'Ande är tillfälligt otillgänglig. Försök igen senare.',
        code: known ? error.code : 'ande_unavailable' }, { retryAfter: status === 429 ? 60 : undefined });
    } finally { req.off('aborted', onAbort); res.off?.('close', onAbort); }
    return true;
  };
}
