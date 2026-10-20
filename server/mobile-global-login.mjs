import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { z } from 'zod';
import { PlatformError, PLATFORM_COOKIE, PLATFORM_TENANT_COOKIE } from './platform-auth.mjs';

// These bindings are authored only by the gateway. A JSON field or header can
// neither choose a tenant/person nor bypass its current personnel credential.
const loginContext = Symbol('employee.global.login');
export const globalEmployeeLoginContext = req => req[loginContext];
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const hash = value => createHash('sha256').update(value).digest('hex');
export function employeeLoginAddress(req, env = process.env) {
  // Render terminates the public connection and appends its client address.
  // Direct/local deployments never trust a caller's forwarding header.
  const forwarded = req.headers['x-forwarded-for'];
  const candidate = env.RENDER && typeof forwarded === 'string' && forwarded.length <= 2048 ? forwarded.split(',').at(-1).trim() : undefined;
  return hash(candidate && isIP(candidate) ? candidate.toLowerCase() : req.socket?.remoteAddress ?? 'unknown');
}
const derive = promisify(scrypt);
const dummy = { salt: randomBytes(24).toString('hex'), digest: randomBytes(64).toString('hex') };
const validHash = value => /^[a-f0-9]{32,128}$/i.test(value?.salt ?? '') && /^[a-f0-9]{128}$/i.test(value?.digest ?? '');
export async function employeeLoginPasswordValid(password, stored) {
  const expected = validHash(stored) ? stored : dummy;
  const actual = await derive(password, expected.salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected.digest, 'hex')) && validHash(stored);
}
const denied = () => new PlatformError('Fel inloggning eller inaktivt konto.', 401, 'employee_login_failed');
const schema = z.object({ username: z.string().min(1).max(200).transform(normalize).refine(value => value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)),
  password: z.string().min(1).max(200) }).strict();
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new PlatformError('Använd application/json.', 415, 'employee_content_type');
  if (Number(req.headers['content-length']) > 4096) throw new PlatformError('Anropet är för stort.', 413, 'employee_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new PlatformError('Anropet är för stort.', 413, 'employee_payload_too_large'); chunks.push(chunk); }
  let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PlatformError('Ogiltig JSON.', 400, 'employee_invalid_json'); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PlatformError('Ange inloggningsnamn eller e-postadress och lösenord.', 422, 'employee_login_invalid');
  return parsed.data;
}
function target(state, identifier) {
  const matches = state.users.filter(user => normalize(user.username) === identifier || normalize(user.email) === identifier);
  // Even a disabled or pending duplicate makes the identifier ambiguous. Never
  // guess another company or silently link identities that share an address.
  if (matches.length !== 1) return { matched: matches.length > 0 };
  const user = matches[0];
  if (!user.active || user.mustChangePassword || user.passwordRecoveryPending || user.passwordSyncPending) return { matched: true };
  const memberships = state.memberships.filter(value => value.userId === user.id && value.active
    && state.companies.some(company => company.id === value.organisationId && company.status === 'active'));
  if (memberships.length !== 1) return { matched: true };
  const membership = memberships[0], company = state.companies.find(value => value.id === membership.organisationId);
  const businessUserId = membership.businessUserId ?? user.businessId;
  if (!businessUserId) return { matched: true };
  return { matched: true, userId: user.id, businessUserId, company: structuredClone(company) };
}
function assertTarget(state, expected, identifier) {
  const current = target(state, identifier);
  if (current.userId !== expected.userId || current.company?.id !== expected.company.id || current.businessUserId !== expected.businessUserId) throw denied();
}
export function createGlobalEmployeeLogin({ repository, auth, openCompany, fallbackCompany, sameOrigin, json, env = process.env, now = () => Date.now() }) {
  const attempts = new Map(); let running = 0;
  function reserve(req, identifier) {
    const at = now(), cutoff = at - 15 * 60_000;
    for (const [key, value] of attempts) if (value.at <= cutoff) attempts.delete(key);
    const keys = [`ip:${employeeLoginAddress(req, env)}`, `name:${hash(identifier)}`, 'worker'];
    if (running >= 4 || attempts.size >= 10_000 || keys.some(key => {
      const value = attempts.get(key); return value && value.count >= (key === 'worker' ? 240 : 12);
    })) throw new PlatformError('För många inloggningsförsök. Vänta 15 minuter.', 429, 'employee_login_rate_limit');
    for (const key of keys) { const old = attempts.get(key); attempts.set(key, { at: old?.at ?? at, count: (old?.count ?? 0) + 1 }); }
    running += 1;
  }
  return {
    async handle(req, res, url) {
      if (url.pathname !== '/api/employee/login') return false;
      let reserved = false;
      try {
        sameOrigin(req);
        if (req.method !== 'POST') throw new PlatformError('Metoden stöds inte.', 405, 'employee_method');
        const queryKeys = [...url.searchParams.keys()];
        if (new Set(queryKeys).size !== queryKeys.length || queryKeys.some(key => !['view', 'month', 'date'].includes(key))
          || url.searchParams.has('view') && url.searchParams.get('view') !== 'bootstrap'
          || url.searchParams.has('month') && !/^\d{4}-(0[1-9]|1[0-2])$/.test(url.searchParams.get('month'))
          || url.searchParams.has('date') && !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(url.searchParams.get('date')))
          throw new PlatformError('Använd inloggningsformuläret.', 422, 'employee_login_invalid');
        const input = await body(req); reserve(req, input.username); reserved = true;
        const found = await repository.read(state => target(state, input.username));
        let selected = found.company;
        if (!selected && !found.matched) selected = (await auth.resolveTenantSelector(req))?.company ?? fallbackCompany;
        if (!selected) { await employeeLoginPasswordValid(input.password); throw denied(); }
        const service = await openCompany(selected);
        const binding = { input,
          ...(found.userId && { businessUserId: found.businessUserId, platformUserId: found.userId }),
          authorize: async () => {
            if (found.userId) await repository.read(state => assertTarget(state, found, input.username));
            // Check stale view fences only after the credential is proven, so
            // a forged scope header cannot enumerate known staff identities.
            for (const header of ['x-client-company', 'x-employee-company'])
              if (req.headers[header] !== undefined && req.headers[header] !== selected.id)
                throw new PlatformError('Bolaget har bytts i en annan flik. Logga in igen.', 409, 'company_selection_changed');
          },
          finish: async () => {
            if (found.userId) await repository.read(state => assertTarget(state, found, input.username));
            const result = await auth.selectTenant(selected.id, { ...req, headers: { ...req.headers, cookie: '' } });
            const secure = env.RENDER || req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
            const values = [`${PLATFORM_TENANT_COOKIE}=${result.tenantToken}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`,
              `${PLATFORM_COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`];
            const existing = res.getHeader('Set-Cookie');
            res.setHeader('Set-Cookie', [...(existing ? Array.isArray(existing) ? existing : [existing] : []), ...values]);
          } };
        Object.defineProperty(req, loginContext, { value: binding, configurable: true });
        return await service.handle(req, res, url);
      } catch (error) {
        json(res, error.status ?? 503, { error: error instanceof PlatformError ? error.message : 'Inloggningen kunde inte genomföras. Försök igen.', code: error instanceof PlatformError ? error.code : 'employee_login_unavailable' });
        return true;
      } finally { if (reserved) running -= 1; delete req[loginContext]; }
    },
    async authorizeSession(req, company, service) {
      // Old scoped personnel sessions remain independent. New directory-based
      // sessions also follow current platform disable/recovery/membership state.
      const session = await (await service.applicationApi.getRepository()).read(state => {
        const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('jeroc_employee='))?.slice(15);
        const saved = cookie && state.personnelAuth?.sessions?.find(value => value.kind === 'employee' && value.tokenHash === hash(cookie));
        return saved?.platformUserId ? { userId: saved.platformUserId, businessUserId: saved.businessUserId } : undefined;
      }, { domains: ['personnelAuth'] });
      if (!session) return;
      await repository.read(state => {
        const user = state.users.find(value => value.id === session.userId);
        const membership = state.memberships.find(value => value.userId === user?.id && value.organisationId === company.id && value.active);
        if (!user?.active || user.mustChangePassword || user.passwordRecoveryPending || user.passwordSyncPending || !membership
          || (membership.businessUserId ?? user.businessId) !== session.businessUserId
          || !state.companies.some(value => value.id === company.id && value.status === 'active')) throw denied();
      });
    },
  };
}
