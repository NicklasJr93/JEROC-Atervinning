import { CompanyLogoError, companyLogoIdPattern, MAX_COMPANY_LOGO_BYTES } from './company-logo.mjs';

const MAX_BODY = Math.ceil(MAX_COMPANY_LOGO_BYTES / 3) * 4 + 1024;
// Shared across the per-tenant API instances: decoding several compressed
// twenty-megapixel files at once must not exhaust the app process's memory.
let activeUploads = 0;
const MAX_ACTIVE_UPLOADS = 2;
const fail = (message, status, code) => { throw new CompanyLogoError(message, status, code); };
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Anropet måste komma från samma webbplats.', 403, 'company_logo_origin');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Anropet måste komma från samma webbplats.', 403, 'company_logo_origin'); }
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('Använd application/json.', 415, 'company_logo_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY) fail('Loggan får vara högst 1 MB.', 413, 'company_logo_too_large');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail('Loggan får vara högst 1 MB.', 413, 'company_logo_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Ogiltig JSON.', 400, 'company_logo_invalid_json'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

/** authorize comes from the platform gateway, never browser actor headers. */
export function createCompanyLogoApi({ service, authorize, now = Date.now } = {}) {
  if (!service || typeof authorize !== 'function') throw new TypeError('Loggarkiv och verifierad behörighet krävs.');
  const attempts = new Map();
  const consume = principal => {
    const at = Number(now()), key = `${principal.companyId}/${principal.actorId}`;
    for (const [id, values] of attempts) {
      const recent = values.filter(time => time > at - 60_000);
      if (recent.length) attempts.set(id, recent); else attempts.delete(id);
    }
    const own = attempts.get(key) ?? [];
    if (own.length >= 10 || attempts.size >= 10_000 && !attempts.has(key)) fail('För många loggauppladdningar. Vänta en minut.', 429, 'company_logo_rate_limited');
    attempts.set(key, [...own, at]);
  };
  return async (req, res, url) => {
    const upload = url.pathname === '/api/company-settings/logo';
    const match = url.pathname.match(/^\/api\/company-settings\/logos\/([^/]+)$/);
    if (!upload && !match) return false;
    const write = upload && req.method === 'POST';
    let principal, reauthorize, uploadSlot = false;
    try {
      sameOrigin(req);
      if (url.search) fail('Anropet tar inga sökparametrar.', 422, 'company_logo_invalid');
      if (upload && !write || match && !['GET', 'HEAD'].includes(req.method)) fail('Metoden stöds inte.', 405, 'company_logo_method');
      principal = await authorize(req, { write, basic: !write });
      if (!principal?.scopeKey || !principal?.companyId || !principal?.actorId || !principal?.userId)
        fail('Logga in i bolaget för att läsa eller ändra loggan.', 401, 'company_logo_session_required');
      if (principal.companyId !== service.organisationId) fail('Loggan tillhör inte det valda bolaget.', 403, 'company_logo_forbidden');
      reauthorize = async () => {
        const current = await authorize(req, { write, basic: !write });
        if (!current?.scopeKey || current.scopeKey !== principal?.scopeKey || current.companyId !== principal.companyId
          || current.actorId !== principal.actorId || current.userId !== principal.userId)
          fail('Bolaget eller kontot har ändrats.', 409, 'company_logo_scope_changed');
        return current;
      };
      if (write) {
        consume(principal);
        if (activeUploads >= MAX_ACTIVE_UPLOADS)
          fail('Andra loggor behandlas just nu. Försök igen om en stund.', 429, 'company_logo_busy');
        activeUploads++; uploadSlot = true;
        const result = await service.upload(await body(req), principal, { reauthorize });
        await reauthorize(); json(res, 201, result);
      } else {
        if (!companyLogoIdPattern.test(match[1])) fail('Loggan finns inte.', 404, 'company_logo_not_found');
        const image = await service.read(match[1]);
        await reauthorize();
        if (!image) fail('Loggan finns inte.', 404, 'company_logo_not_found');
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.bytes.length, 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(req.method === 'HEAD' ? undefined : image.bytes);
      }
    } catch (error) {
      if (principal && reauthorize) try { await reauthorize(); } catch (scopeError) { error = scopeError; }
      // Never expose a provider/storage path or image contents as an error.
      const known = error instanceof CompanyLogoError || Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
      if (error?.status === 429) res.setHeader('Retry-After', '2');
      json(res, known ? error.status : 503, { error: known ? error.message : 'Loggan kunde inte sparas eller läsas. Försök igen.',
        code: known ? error.code ?? 'company_logo_forbidden' : 'company_logo_unavailable' });
    } finally { if (uploadSlot) activeUploads--; }
    return true;
  };
}
