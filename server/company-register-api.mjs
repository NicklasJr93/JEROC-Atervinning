import { PlatformError } from './platform-auth.mjs';
import { PricingError } from './pricing.mjs';
import { ScbCompanyRegisterError } from './scb-company-register.mjs';
import { customerIdentifierError, normalizeOrganisationNumber } from '../dist-server/domain-models.mjs';

const MAX_BODY = 1024;
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site')
    fail('Anropet måste komma från samma webbplats.', 403, 'company_lookup_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Anropet måste komma från samma webbplats.', 403, 'company_lookup_origin_forbidden'); }
}

async function input(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('Använd application/json.', 415, 'company_lookup_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY)
    fail('Anropet är för stort.', 413, 'company_lookup_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail('Anropet är för stort.', 413, 'company_lookup_payload_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Ogiltig JSON.', 400, 'company_lookup_invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || typeof value.organisationNumber !== 'string' || value.organisationNumber.length > 40)
    fail('Ange endast ett organisationsnummer.', 422, 'company_lookup_invalid');
  const raw = normalizeOrganisationNumber(value.organisationNumber);
  const number = /^16\d{10}$/.test(raw) ? raw.slice(2) : raw;
  // Only juridical persons in this service. A sole trader's personal identity
  // may remain manually entered, but is never sent to the company provider.
  if (customerIdentifierError('BRF', number))
    fail('Ange ett giltigt organisationsnummer med tio siffror. Personnummer och enskild firma omfattas inte av detta uppslag.', 422, 'company_lookup_invalid');
  return number;
}

function reply(res, status, value, retryAfter) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 405 ? { Allow: 'POST' } : {}), ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
  res.end(JSON.stringify(value));
}

/** One server-owned provider/key. Nothing here saves customer or tenant data.
 * Production currently runs one app instance; multiple instances must share a
 * limiter before using the same SCB key (SCB allows five requests/second/key).
 */
export function createCompanyRegisterApi({ register, authorize, now = Date.now, perPrincipalLimit = 30, globalLimit = 4 } = {}) {
  if (typeof register?.lookup !== 'function' || typeof authorize !== 'function') throw new TypeError('Company register and authorization are required.');
  const attempts = new Map(); let globalAttempts = [];
  function consume(key) {
    const at = Number(now());
    for (const [id, times] of attempts) {
      const recent = times.filter(time => time > at - 60_000);
      if (recent.length) attempts.set(id, recent); else attempts.delete(id);
    }
    const own = attempts.get(key) ?? [];
    if (own.length >= perPrincipalLimit)
      fail('För många företagsuppslag. Vänta en minut och försök igen.', 429, 'company_lookup_rate_limited');
    globalAttempts = globalAttempts.filter(time => time > at - 1000);
    if (globalAttempts.length >= globalLimit || attempts.size >= 10_000 && !attempts.has(key))
      fail('Företagsuppslaget används just nu. Vänta en stund och försök igen.', 429, 'company_lookup_rate_limited');
    attempts.set(key, [...own, at]); globalAttempts.push(at);
  }
  return async (req, res, url) => {
    if (url.pathname !== '/api/company-register/lookup') return false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      if (req.method !== 'POST') fail('Metoden stöds inte.', 405, 'company_lookup_method');
      sameOrigin(req);
      if ([...url.searchParams.keys()].length) fail('Ange organisationsnumret i anropets innehåll.', 422, 'company_lookup_invalid');
      const captured = await authorize(req);
      if (!captured?.scopeKey || !captured?.rateKey) fail('Du saknar behörighet för företagsuppslag.', 403, 'company_lookup_forbidden');
      const organisationNumber = await input(req);
      consume(captured.rateKey);
      const company = await register.lookup(organisationNumber, { signal: controller.signal });
      const current = await authorize(req);
      if (current.scopeKey !== captured.scopeKey)
        fail('Bolaget eller kontot har ändrats. Sök igen i den aktuella arbetsytan.', 409, 'company_lookup_scope_changed');
      if (!controller.signal.aborted) reply(res, 200, { company });
    } catch (error) {
      const known = error instanceof PlatformError || error instanceof PricingError || error instanceof ScbCompanyRegisterError;
      const status = known ? error.status : 503;
      if (!controller.signal.aborted) reply(res, status, {
        error: known ? error.message : 'Företagsuppslaget kunde inte genomföras. Försök igen senare eller fyll i uppgifterna manuellt.',
        code: known ? error.code ?? 'company_lookup_forbidden' : 'company_lookup_unavailable',
      }, status === 429 ? 1 : undefined);
    } finally { req.off('aborted', abort); res.off('close', abort); }
    return true;
  };
}
