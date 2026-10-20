import { PlatformError } from './platform-auth.mjs';
import { PricingError } from './pricing.mjs';
import { GoogleAddressValidationError, normalizeAddressValidationInput, addressSessionTokenSchema } from './google-address-validation.mjs';

const MAX_BODY = 4096;
const prefix = '/api/address-assistance/';
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site')
    fail('Anropet måste komma från samma webbplats.', 403, 'address_assistance_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Anropet måste komma från samma webbplats.', 403, 'address_assistance_origin_forbidden'); }
}

async function input(req, config) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('Använd application/json.', 415, 'address_assistance_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY)
    fail('Anropet är för stort.', 413, 'address_assistance_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail('Anropet är för stort.', 413, 'address_assistance_payload_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Ogiltig JSON.', 400, 'address_assistance_invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['address', 'sessionToken'].includes(key))
    || config && Object.keys(value).length)
    fail('Ange endast adressuppgifterna.', 422, 'address_assistance_invalid');
  if (config) return {};
  if (value.sessionToken !== undefined && !addressSessionTokenSchema.safeParse(value.sessionToken).success)
    fail('Adressökningens session är ogiltig. Sök igen.', 422, 'address_assistance_invalid');
  return { address: normalizeAddressValidationInput(value.address),
    ...(value.sessionToken === undefined ? {} : { sessionToken: value.sessionToken }) };
}

function reply(res, status, value, retryAfter) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 405 ? { Allow: 'POST' } : {}), ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) });
  res.end(JSON.stringify(value));
}

/** Authenticated read-only helpers. Limits are per app instance; scale-out must
 * replace these bounded in-memory windows with a shared limiter. authorize must
 * return an immutable session/company scope and stable actor/tenant rate keys.
 */
export function createAddressAssistanceApi({ validator, authorize, env = process.env, now = Date.now,
  perPrincipalLimit = 30, perTenantLimit = 120, globalLimit = 8 } = {}) {
  if (typeof validator?.validate !== 'function' || typeof authorize !== 'function')
    throw new TypeError('Address validation and authorization are required.');
  const browserApiKey = typeof env.GOOGLE_MAPS_BROWSER_API_KEY === 'string' ? env.GOOGLE_MAPS_BROWSER_API_KEY.trim() : '';
  const attempts = new Map(); let globalAttempts = [];
  function consume(principal) {
    const at = Number(now());
    for (const [key, times] of attempts) {
      const recent = times.filter(time => time > at - 60_000);
      if (recent.length) attempts.set(key, recent); else attempts.delete(key);
    }
    const keys = [[`actor:${principal.rateKey}`, perPrincipalLimit], [`tenant:${principal.tenantRateKey ?? principal.rateKey}`, perTenantLimit]];
    globalAttempts = globalAttempts.filter(time => time > at - 1000);
    if (globalAttempts.length >= globalLimit || attempts.size >= 20_000 && keys.some(([key]) => !attempts.has(key)))
      fail('Adresskontrollen används mycket just nu. Vänta en stund eller fyll i adressen manuellt.', 429, 'address_assistance_rate_limited');
    for (const [key, limit] of keys) if ((attempts.get(key)?.length ?? 0) >= limit)
      fail('För många adresskontroller. Vänta en minut eller fyll i adressen manuellt.', 429, 'address_assistance_rate_limited');
    for (const [key] of keys) attempts.set(key, [...(attempts.get(key) ?? []), at]);
    globalAttempts.push(at);
  }
  return async (req, res, url) => {
    const config = url.pathname === `${prefix}config`;
    if (!config && url.pathname !== `${prefix}validate`) return false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    let captured;
    async function freshScope() {
      const current = await authorize(req);
      if (!current?.scopeKey || !current?.rateKey) fail('Du saknar behörighet för adresshjälp.', 403, 'address_assistance_forbidden');
      if (captured && current.scopeKey !== captured.scopeKey)
        fail('Bolaget eller kontot har ändrats. Sök igen i den aktuella arbetsytan.', 409, 'address_assistance_scope_changed');
      return current;
    }
    try {
      if (req.method !== 'POST') fail('Metoden stöds inte.', 405, 'address_assistance_method');
      sameOrigin(req);
      if ([...url.searchParams.keys()].length) fail('Ange adressen i anropets innehåll.', 422, 'address_assistance_invalid');
      captured = await freshScope();
      const value = await input(req, config);
      let result;
      if (config) result = { configured: Boolean(browserApiKey && validator.configured), browserConfigured: Boolean(browserApiKey), validationConfigured: validator.configured === true,
        ...(browserApiKey && validator.configured ? { browserApiKey } : {}), countryCode: 'SE' };
      else {
        consume(captured);
        result = await validator.validate(value.address, { signal: controller.signal, sessionToken: value.sessionToken });
      }
      await freshScope();
      if (!controller.signal.aborted) reply(res, 200, result);
    } catch (error) {
      // A delayed provider failure must not outlive a revoked or switched scope.
      if (captured) try { await freshScope(); } catch (scopeError) { error = scopeError; }
      const known = error instanceof PlatformError || error instanceof PricingError || error instanceof GoogleAddressValidationError;
      const status = known ? error.status : 503;
      if (!controller.signal.aborted) reply(res, status, { error: known ? error.message : 'Adresshjälpen kunde inte nås. Fyll i adressen manuellt.',
        code: known ? error.code ?? 'address_assistance_forbidden' : 'address_assistance_unavailable' }, status === 429 ? 1 : undefined);
    } finally { req.off('aborted', abort); res.off('close', abort); }
    return true;
  };
}
