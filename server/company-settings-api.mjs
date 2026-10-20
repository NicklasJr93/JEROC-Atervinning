import { PlatformError } from './platform-auth.mjs';
import { PricingError } from './pricing.mjs';
import { CompanySettingsError } from './company-settings.mjs';

const MAX_BODY = 16 * 1024;
const fail = (message, status, code) => { throw new CompanySettingsError(message, status, code); };

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site')
    fail('Anropet måste komma från samma webbplats.', 403, 'company_settings_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Anropet måste komma från samma webbplats.', 403, 'company_settings_origin_forbidden'); }
}
async function input(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    fail('Använd application/json.', 415, 'company_settings_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY)
    fail('Anropet är för stort.', 413, 'company_settings_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail('Anropet är för stort.', 413, 'company_settings_payload_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Ogiltig JSON.', 400, 'company_settings_invalid_json'); }
}
function reply(res, status, value, head = false, basic = false) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...(status === 405 ? { Allow: basic ? 'GET, HEAD' : 'GET, HEAD, POST' } : {}) });
  res.end(head ? undefined : JSON.stringify(value));
}

/** The injected authorizer resolves real sessions and enforces current
 * actual/effective rights and CSRF. The API never accepts a tenant selector.
 */
export function createCompanySettingsApi({ service, authorize } = {}) {
  if (typeof service?.get !== 'function' || typeof service?.save !== 'function' || typeof service?.basicSettings !== 'function'
    || typeof authorize !== 'function') throw new TypeError('Företagsinställningar och behörighetskontroll krävs.');
  return async (req, res, url) => {
    const basic = url.pathname === '/api/company-settings/defaults';
    if (!basic && url.pathname !== '/api/company-settings') return false;
    const read = ['GET', 'HEAD'].includes(req.method);
    let captured;
    async function freshScope() {
      const principal = await authorize(req, { write: !read, basic });
      if (!principal?.scopeKey || principal.companyId !== service.organisationId)
        fail('Du saknar behörighet för det valda bolaget.', 403, 'company_settings_forbidden');
      if (captured && (principal.scopeKey !== captured.scopeKey || principal.companyId !== captured.companyId
        || principal.actorId !== captured.actorId || principal.userId !== captured.userId))
        fail('Bolaget eller kontot har ändrats. Öppna företagsinställningarna igen.', 409, 'company_settings_scope_changed');
      return principal;
    }
    try {
      if (!read && (req.method !== 'POST' || basic)) fail('Metoden stöds inte.', 405, 'company_settings_method');
      sameOrigin(req);
      if ([...url.searchParams.keys()].length) fail('Anropet får inte innehålla sökparametrar.', 422, 'company_settings_invalid');
      captured = await freshScope();
      if (!read && captured.canManage !== true)
        fail('Du saknar behörighet att ändra företagsinställningar.', 403, 'company_settings_forbidden');
      const value = read ? await (basic ? service.basicSettings() : service.get())
        : await service.save(await input(req), captured, { reauthorize: freshScope });
      const fresh = await freshScope();
      reply(res, 200, basic ? value : { ...value, capabilities: { canManage: fresh.canManage === true } }, req.method === 'HEAD', basic);
    } catch (error) {
      // Delayed reads and failures cannot reveal an old company's response.
      if (captured) try { await freshScope(); } catch (scopeError) { error = scopeError; }
      const known = error instanceof CompanySettingsError || error instanceof PlatformError || error instanceof PricingError;
      reply(res, known ? error.status : 503, { error: known ? error.message : 'Företagsinställningarna kunde inte nås. Försök igen.',
        code: known ? error.code ?? 'company_settings_forbidden' : 'company_settings_unavailable' }, req.method === 'HEAD', basic);
    }
    return true;
  };
}
