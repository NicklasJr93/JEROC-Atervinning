import { PlatformError, PLATFORM_COOKIE, PLATFORM_TENANT_COOKIE, platformCookieToken } from './platform-auth.mjs';
import { attachMobileSupport } from './mobile-support-identity.mjs';
import { withBusinessIdentity } from './business-identity.mjs';

const fail = (message, status = 403, code = 'mobile_support_forbidden') => { throw new PlatformError(message, status, code); };
function generation(req, session) {
  if (!req.headers['x-platform-generation'] || req.headers['x-platform-generation'] !== session.generation)
    fail('Bolaget eller sessionen har ändrats. Öppna bolaget igen.', 409, 'platform_context_changed');
}
function activeCompanies(session) {
  return session.mustChangePassword ? [] : session.companies.filter(company => company.status === 'active');
}
function picker(session) { return { kind: 'platform-admin', platformSession: session.mustChangePassword ? { ...session, companies: [] } : session, companies: activeCompanies(session) }; }
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail('Använd application/json.', 415, 'mobile_support_content_type');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2048) fail('Anropet är för stort.', 413, 'mobile_support_payload_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Ogiltig JSON.', 400, 'mobile_support_invalid_json'); }
}
export function createMobilePlatformSupport({ auth, openCompany, sameOrigin, json, env = process.env }) {
  const cookies = (req, res, result) => {
    const secure = env.RENDER || req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
    const values = [[PLATFORM_COOKIE, result.token, 'Lax'], [PLATFORM_TENANT_COOKIE, result.tenantToken, 'Strict'], ['jeroc_employee', '', 'Strict']]
      .filter(([, token]) => token !== undefined).map(([name, token, sameSite]) => `${name}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=${sameSite}; Max-Age=${token ? 28800 : 0}${secure ? '; Secure' : ''}`);
    const existing = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(existing ? Array.isArray(existing) ? existing : [existing] : []), ...values]);
  };
  const adminSession = async req => {
    const session = await auth.session(req);
    if (!session.authenticated || session.actor?.platformAdmin !== true) fail('Logga in med ditt systemadminkonto.', 403);
    if (session.mustChangePassword) fail('Byt det tillfälliga lösenordet innan du fortsätter.', 423, 'platform_password_change_required');
    if (session.actualUser?.id !== '__platform-admin' || session.effectiveUserId !== '__platform-admin') fail('Öppna bolaget med din egen systemadminbehörighet.');
    return session;
  };
  return {
    async login(input, req, res, username) {
      let result;
      try { result = await auth.login({ username, password: input.password }, req); }
      catch (error) {
        if (error.status === 401) fail('Fel inloggning eller inaktivt konto.', 401, 'employee_login_failed');
        if (error.status === 429) fail('För många inloggningsförsök. Vänta 15 minuter.', 429, 'employee_login_rate_limit');
        throw error;
      }
      const session = result.value;
      if (!session.actor?.platformAdmin) fail('Logga in med ditt systemadminkonto.');
      cookies(req, res, result); json(res, 200, picker(session)); return true;
    },
    async handle(req, res, url) {
      if (!['/api/employee/companies', '/api/employee/company', '/api/employee/session', '/api/employee/logout'].includes(url.pathname)) return false;
      if (platformCookieToken(req) === undefined) return false;
      try {
        sameOrigin(req);
        const raw = await auth.session(req);
        if (!raw.authenticated || !raw.actor?.platformAdmin) return false;
        if (url.pathname === '/api/employee/logout' && req.method === 'POST') {
          generation(req, raw);
          const payload = await body(req);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) fail('Utloggningen tar inga klientuppgifter.', 422);
          const result = await auth.logout(req); cookies(req, res, result); json(res, 200, { ok: true }); return true;
        }
        if (raw.mustChangePassword && url.pathname === '/api/employee/session' && req.method === 'GET') { json(res, 200, picker(raw)); return true; }
        const session = await adminSession(req);
        if (url.pathname === '/api/employee/session' && req.method === 'GET') {
          if (session.company) return false;
          json(res, 200, picker(session)); return true;
        }
        generation(req, session);
        if (url.pathname === '/api/employee/companies' && req.method === 'GET') { json(res, 200, picker(session)); return true; }
        if (url.pathname !== '/api/employee/company' || req.method !== 'POST') fail('Metoden stöds inte.', 405);
        const payload = await body(req);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.companyId !== 'string' || payload.companyId.length > 100)
          fail('Välj ett aktivt bolag.', 422);
        const result = await auth.switchCompany({ organisationId: payload.companyId }, req);
        cookies(req, res, result);
        // Continue with the newly rotated real platform session. Old client
        // company/person headers belong to the previous view and grant nothing.
        const headers = { ...req.headers, cookie: `${PLATFORM_COOKIE}=${result.token}; ${PLATFORM_TENANT_COOKIE}=${result.tenantToken}`,
          'x-platform-generation': result.value.generation, 'x-platform-csrf': result.value.csrfToken };
        delete headers['x-employee-company']; delete headers['x-client-company']; delete headers['x-employee-person']; delete headers['x-platform-organisation-id'];
        const selected = { ...req, method: 'GET', headers };
        const context = await auth.resolveContext(selected, { writes: false });
        if (!attachMobileSupport(selected, context, result.value)) fail('Bolagets supportbehörighet kunde inte öppnas.');
        return await withBusinessIdentity(context, () => openCompany(context.company).then(service => service.handle(selected, res, new URL('/api/employee/session?view=bootstrap', url.origin))));
      } catch (error) {
        json(res, error.status ?? 503, { error: error instanceof PlatformError ? error.message : 'Systemadminvyn kunde inte öppnas.', code: error instanceof PlatformError ? error.code : 'mobile_support_unavailable' });
        return true;
      }
    },
  };
}
