import { PlatformError, PLATFORM_COOKIE, PLATFORM_TENANT_COOKIE } from './platform-auth.mjs';

const MAX_BODY = 24 * 1024;
function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new PlatformError('Anropet måste komma från samma webbplats.', 403, 'platform_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new Error();
  } catch { throw new PlatformError('Anropet måste komma från samma webbplats.', 403, 'platform_origin_forbidden'); }
}
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new PlatformError('Använd application/json.', 415, 'platform_content_type');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new PlatformError('Anropet är för stort.', 413, 'platform_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new PlatformError('Anropet är för stort.', 413, 'platform_payload_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PlatformError('Ogiltig JSON.', 400, 'platform_invalid_json'); }
}
function empty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new PlatformError('Åtgärden tar inga klientuppgifter.');
}
function json(res, status, value, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
}
function setCookies(req, res, result, env) {
  if (result.token === undefined) return;
  const secure = Boolean(env.RENDER) || req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const values = [[PLATFORM_COOKIE, result.token], [PLATFORM_TENANT_COOKIE, result.tenantToken]]
    .filter(([, token]) => token !== undefined).map(([name, token]) => `${name}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=${name === PLATFORM_COOKIE ? 'Lax' : 'Strict'}${secure ? '; Secure' : ''}; Max-Age=${token ? 8 * 3600 : 0}`);
  // A company/context change must not leave a cookie authenticated against the
  // previous tenant. Expire both known old and current cookie paths explicitly.
  for (const [name, path] of [
    ['jeroc_employee', '/api'], ['jeroc_driver', '/api/driver'], ['jeroc_customer', '/api/customer'], ['jeroc_carrier', '/api/carrier'],
    ['jeroc_environment_staff', '/api/environment'], ['jeroc_terminal_demo_staff', '/'], ['jeroc_terminal_demo_staff', '/api'], ['jeroc_terminal_demo_staff', '/api/terminal-demo'],
    ['jeroc_terminal_demo_device', '/api/terminal-demo'], ['jeroc_visma_oauth', '/api/integrations/visma/oauth/callback'],
  ]) values.push(`${name}=; Path=${path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=0`);
  const existing = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(existing ? Array.isArray(existing) ? existing : [existing] : []), ...values]);
}

/** The API never exposes hashes, schema names or credentials on reads. */
export function createPlatformApi({ auth, fleet, communications, env = process.env } = {}) {
  if (!auth) throw new TypeError('Plattformsautentisering krävs.');
  const api = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/platform/')) return false;
    try {
      checkOrigin(req);
      const path = url.pathname.slice('/api/platform/'.length), read = ['GET', 'HEAD'].includes(req.method);
      if (!read && req.method !== 'POST') throw new PlatformError('Metoden stöds inte.', 405, 'platform_method');
      const users = path.match(/^companies\/([a-zA-Z0-9-]{1,100})\/users$/);
      const reset = path.match(/^companies\/([a-zA-Z0-9-]{1,100})\/reset-initial-password$/);
      let result;
      if (read && path === 'session') result = { value: await auth.session(req) };
      else if (path === 'communications' && communications && read) result = { value: await communications.read(req) };
      else if (path === 'communications/test-email' && communications && !read) result = { value: await communications.sendTest(await body(req), req) };
      else if (path === 'communications/test-sms' && communications && !read) result = { value: await communications.sendTestSms(await body(req), req) };
      else if (path === 'communications/review-sms' && communications && !read) result = { value: await communications.reviewSms(await body(req), req) };
      else if (path === 'telematics' && fleet) result = { value: read ? await fleet.read(req) : await fleet.mutate(await body(req), req) };
      else if (read && path === 'companies') result = { value: await auth.companies(req) };
      else if (read && users) result = { value: await auth.users(users[1], req) };
      else if (!read && path === 'login') result = await auth.login(await body(req), req);
      else if (!read && path === 'select-tenant') result = await auth.selectTenant(await body(req), req);
      else if (!read && path === 'logout') { empty(await body(req)); result = await auth.logout(req); }
      else if (!read && path === 'open-administration') { empty(await body(req)); result = await auth.openAdministration(req); }
      else if (!read && path === 'change-password') result = await auth.changePassword(await body(req), req);
      else if (!read && path === 'switch') result = await auth.switchCompany(await body(req), req);
      else if (!read && path === 'companies') result = { value: await auth.createCompany(await body(req), req) };
      else if (!read && reset) result = { value: await auth.resetInitialPassword(reset[1], await body(req), req) };
      else throw new PlatformError('Plattformssidan finns inte.', 404, 'platform_not_found');
      setCookies(req, res, result, env); json(res, 200, result.value, req.method === 'HEAD');
    } catch (error) {
      const expected = error instanceof PlatformError;
      json(res, expected ? error.status : 500, { error: expected ? error.message : 'Plattformstjänsten kunde inte slutföra anropet.', code: expected ? error.code : 'platform_unavailable' }, req.method === 'HEAD');
    }
    return true;
  };
  return Object.assign(api, { auth });
}
