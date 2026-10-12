import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { normalizeOrganisationNumber, customerIdentifierError } from '../dist-server/domain-models.mjs';

const derive = promisify(scrypt), clone = value => structuredClone(value);
const SESSION_MS = 8 * 3600_000, ATTEMPT_MS = 15 * 60_000;
export const PLATFORM_COOKIE = 'jeroc_platform';
export const PLATFORM_TENANT_COOKIE = 'jeroc_tenant';
// This symbol carries server-authenticated context. No request header can set it.
const trustedContext = Symbol('jeroc.platform.context');
export const getPlatformContext = req => req?.[trustedContext];
export const attachPlatformContext = (req, context) => {
  Object.defineProperty(req, trustedContext, { value: context, configurable: true }); return context;
};
export class PlatformError extends Error {
  constructor(message, status = 422, code = 'platform_invalid') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status = 422, code) => { throw new PlatformError(message, status, code); };
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalHash = value => hash(JSON.stringify(value));
const username = value => value.normalize('NFKC').trim().toLowerCase();
const passwordSchema = z.string().min(12, 'Lösenordet måste innehålla minst 12 tecken.').max(200);
const parse = (schema, value) => { const parsed = schema.safeParse(value); if (!parsed.success) fail(parsed.error.issues.map(issue => issue.message).join(' ')); return parsed.data; };
const validPasswordHash = value => value && /^[a-f0-9]{32,128}$/i.test(value.salt ?? '') && /^[a-f0-9]{128}$/i.test(value.digest ?? '');
export async function platformPasswordHash(password) {
  const salt = randomBytes(24).toString('hex'); return { salt, digest: (await derive(password, salt, 64)).toString('hex') };
}
const unknownPassword = await platformPasswordHash(secret());
async function passwordValid(password, stored) {
  const safe = validPasswordHash(stored) ? stored : unknownPassword;
  const actual = await derive(password, safe.salt, 64), expected = Buffer.from(safe.digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) && validPasswordHash(stored);
}
export function platformCookieToken(req) {
  const item = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${PLATFORM_COOKIE}=`));
  if (!item) return undefined;
  try { return decodeURIComponent(item.slice(PLATFORM_COOKIE.length + 1)); } catch { return ''; }
}
function tenantCookieToken(req) {
  const item = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${PLATFORM_TENANT_COOKIE}=`));
  if (!item) return undefined;
  try { return decodeURIComponent(item.slice(PLATFORM_TENANT_COOKIE.length + 1)); } catch { return ''; }
}
const publicCompany = value => Object.fromEntries(['id', 'name', 'organisationNumber', 'status', 'createdAt', 'ownerUserId'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const publicActor = user => ({ id: user.id, name: user.name, username: user.username, platformAdmin: user.platformAdmin === true });
const userIdSchema = z.string().trim().min(1).max(100);
const newCompanySchema = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(2).max(200), organisationNumber: z.string().max(40), vdName: z.string().trim().min(2).max(200), vdEmail: z.string().trim().email().max(200) }).strict();

/** Platform identity owns company memberships; business permissions still come
 * from each company's current user register, never from this cookie or JSON. */
export function createPlatformAuth({ repository, bootstrapLegacy = async () => null, provisionCompany,
  companyUsers = async () => [], resolveCompanyUser = async () => null, onPasswordChanged = async () => {},
  now = () => new Date(), legacyCompany = { name: 'JEROC Återvinning AB', organisationNumber: '', storageSchema: 'public' } } = {}) {
  if (!repository?.read || !repository?.transact) throw new TypeError('Plattformsregistret krävs.');
  const at = () => new Date(now()).toISOString();
  let bootstrapPromise;
  function audit(state, actor, action, values = {}) {
    state.audit.push({ id: randomUUID(), at: at(), actorId: actor?.id, action, ...values });
  }
  async function initialize() {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      const existing = await repository.read(state => clone(state.users.find(user => user.platformAdmin)));
      if (existing) {
        if (await passwordValid('JerocDemo2026!', existing.password)) fail('Ett privat initialt plattformslösenord krävs innan bolagsadministrationen kan aktiveras.', 503, 'platform_bootstrap_required');
        return;
      }
      const imported = await bootstrapLegacy();
      if (!imported || !validPasswordHash(imported.password) || imported.active === false) fail('Aktivt befintligt administratörskonto saknas. Ingen ny inloggning har skapats.', 503, 'platform_bootstrap_missing');
      const knownDemoPassword = await passwordValid('JerocDemo2026!', imported.password);
      if (knownDemoPassword) fail('Ett privat initialt plattformslösenord krävs innan bolagsadministrationen kan aktiveras.', 503, 'platform_bootstrap_required');
      await repository.transact(state => {
        if (state.users.some(user => user.platformAdmin)) return;
        const stamp = at(), businessId = imported.userId ?? imported.id ?? 'admin';
        const company = { id: 'jeroc-demo', ...legacyCompany, status: 'active', ownerUserId: businessId, createdAt: stamp };
        if (!state.companies.some(value => value.id === company.id)) state.companies.push(company);
        const user = { id: businessId, businessId, name: imported.name ?? 'Systemadmin', username: username(imported.username ?? businessId),
          email: imported.email ?? '', password: clone(imported.password), platformAdmin: true, active: true, mustChangePassword: imported.privateBootstrap === true, createdAt: stamp };
        state.users.push(user); state.memberships.push({ userId: user.id, organisationId: company.id, businessUserId: businessId, active: true });
        audit(state, user, 'platform.legacy_admin_imported', { organisationId: company.id });
      });
    })();
    bootstrapPromise.catch(() => { bootstrapPromise = undefined; }); return bootstrapPromise;
  }
  function identity(state, token, { allowPasswordChange = false, allowInactiveCompany = false } = {}) {
    const stamp = at();
    const session = token && state.sessions.find(value => value.tokenHash === hash(token) && value.expiresAt > stamp);
    const actor = state.users.find(value => value.id === session?.userId && value.active);
    if (!session || !actor) fail('Logga in för att använda systemet.', 401, 'platform_session_required');
    if (actor.mustChangePassword && !allowPasswordChange) fail('Byt det tillfälliga lösenordet innan du fortsätter.', 423, 'platform_password_change_required');
    const company = state.companies.find(value => value.id === session.organisationId);
    const membership = state.memberships.find(value => value.userId === actor.id && value.organisationId === company?.id && value.active);
    if (!company || !actor.platformAdmin && !membership) fail('Bolaget omfattas inte av din inloggning.', 403, 'platform_company_forbidden');
    if (company.status !== 'active' && !allowInactiveCompany) fail('Bolaget är inte tillgängligt än.', 409, 'platform_company_unavailable');
    if (!actor.platformAdmin && session.effectiveUserId !== membership.businessUserId) fail('Kontot omfattas inte av din bolagsbehörighet.', 403, 'platform_user_forbidden');
    return { session, actor, company, membership };
  }
  function checkExpected(req, value, writes = false) {
    const expected = req.headers['x-platform-generation'];
    if (expected !== undefined && expected !== value.session.generation) fail('Bolag eller konto har bytts i en annan flik. Ladda om sidan.', 409, 'platform_context_changed');
    const expectedOrg = req.headers['x-platform-organisation-id'];
    if (expectedOrg !== undefined && expectedOrg !== value.company.id) fail('Bolaget har bytts i en annan flik. Ladda om sidan.', 409, 'platform_context_changed');
    if (writes && (!req.headers['x-platform-csrf'] || req.headers['x-platform-csrf'] !== value.session.csrfToken))
      fail('Sessionsskyddet saknas eller har ändrats. Ladda om sidan.', 403, 'platform_csrf_required');
  }
  async function businessUser(value) {
    const result = await resolveCompanyUser(value.company.id, value.session.effectiveUserId);
    if (!result || result.active === false || result.id !== value.session.effectiveUserId) fail('Det valda användarkontot är inte aktivt i bolaget.', 403, 'platform_account_inactive');
    return clone(result);
  }
  const actualBusinessId = value => value.actor.platformAdmin ? value.company.id === 'jeroc-demo' ? value.actor.businessId : '__platform-admin' : value.membership.businessUserId;
  async function actualBusinessUser(value, user) {
    if (actualBusinessId(value) === user.id) return user;
    const result = await resolveCompanyUser(value.company.id, actualBusinessId(value));
    if (!result || result.active === false || result.id !== actualBusinessId(value) || result.level !== 'Systemadmin') fail('Administratörens bolagsbehörighet saknas.', 403, 'platform_account_inactive');
    return clone(result);
  }
  function sessionDto(value, user, actualUser, state) {
    const accessible = state.companies.filter(company => value.actor.platformAdmin || state.memberships.some(member => member.userId === value.actor.id && member.organisationId === company.id && member.active));
    return { enabled: true, authenticated: true, actor: publicActor(value.actor), user, actualUser,
      company: publicCompany(value.company), organisationId: value.company.id, effectiveUserId: value.session.effectiveUserId,
      isSupportSession: Boolean(value.actor.platformAdmin && (value.company.id !== 'jeroc-demo' || value.session.effectiveUserId !== value.actor.businessId)),
      mustChangePassword: value.actor.mustChangePassword === true, csrfToken: value.session.csrfToken, generation: value.session.generation,
      expiresAt: value.session.expiresAt, companies: accessible.map(publicCompany) };
  }
  async function readSession(req, { writes = false, allowPasswordChange = false, allowInactiveCompany = false } = {}) {
    await initialize(); const token = platformCookieToken(req);
    const value = await repository.read(state => clone(identity(state, token, { allowPasswordChange, allowInactiveCompany })));
    checkExpected(req, value, writes); return { value, token };
  }
  async function resolveContext(req, { writes = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) } = {}) {
    const { value, token } = await readSession(req, { writes });
    const user = await businessUser(value);
    const actualUser = await actualBusinessUser(value, user);
    // Recheck after reading the other database so a concurrent company switch
    // or membership revocation cannot leave a stale authenticated context.
    await repository.read(state => { const current = identity(state, token); if (current.session.generation !== value.session.generation) fail('Bolaget har bytts. Ladda om sidan.', 409, 'platform_context_changed'); });
    return attachPlatformContext(req, Object.freeze({ organisationId: value.company.id, company: clone(value.company), storageSchema: value.company.storageSchema,
      actor: { ...publicActor(value.actor), businessId: actualBusinessId(value) }, actualUser,
      user, actorId: value.actor.id, effectiveUserId: user.id, sessionKey: value.session.tokenHash, sessionId: value.session.tokenHash,
      csrfToken: value.session.csrfToken, generation: value.session.generation, expiresAt: value.session.expiresAt, platformAdmin: value.actor.platformAdmin === true,
      isSupportSession: Boolean(value.actor.platformAdmin && (value.company.id !== 'jeroc-demo' || user.id !== value.actor.businessId)) }));
  }
  async function session(req) {
    await initialize();
    if (platformCookieToken(req) === undefined) return { enabled: true, authenticated: false };
    const { value, token } = await readSession(req, { allowPasswordChange: true, allowInactiveCompany: true });
    const user = value.actor.mustChangePassword ? { id: value.session.effectiveUserId, name: value.actor.name, level: value.actor.platformAdmin ? 'Systemadmin' : 'VD', permissions: [], active: true } : await businessUser(value);
    const actualUser = value.actor.mustChangePassword ? { ...user, id: actualBusinessId(value) } : await actualBusinessUser(value, user);
    return repository.read(state => { const current = identity(state, token, { allowPasswordChange: true, allowInactiveCompany: true });
      if (current.session.generation !== value.session.generation) fail('Bolaget har bytts. Ladda om sidan.', 409, 'platform_context_changed');
      return sessionDto(current, user, actualUser, state); });
  }
  function newSession(user, organisationId, effectiveUserId, token, tenantToken) {
    return { userId: user.id, organisationId, effectiveUserId, tokenHash: hash(token), tenantTokenHash: hash(tenantToken), csrfToken: secret(), generation: randomUUID(), createdAt: at(), expiresAt: new Date(Date.parse(at()) + SESSION_MS).toISOString() };
  }
  async function login(input, req) {
    await initialize();
    const parsed = parse(z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).strict(), input);
    const loginName = username(parsed.username), address = hash(req.socket?.remoteAddress ?? 'unknown'), stamp = at(), key = hash(loginName);
    const candidate = await repository.read(state => {
      const attempts = state.attempts.filter(value => Date.parse(value.at) > Date.parse(stamp) - ATTEMPT_MS);
      if (attempts.filter(value => value.address === address).length >= 30 || attempts.filter(value => value.key === key).length >= 10) fail('För många inloggningsförsök. Vänta 15 minuter.', 429, 'platform_login_rate_limit');
      return clone(state.users.find(value => value.username === loginName));
    });
    const valid = await passwordValid(parsed.password, candidate?.password), token = secret(), tenantToken = secret();
    const result = await repository.transact(state => {
      state.sessions = state.sessions.filter(value => value.expiresAt > stamp);
      state.attempts = state.attempts.filter(value => Date.parse(value.at) > Date.parse(stamp) - ATTEMPT_MS);
      if (state.attempts.filter(value => value.address === address).length >= 30 || state.attempts.filter(value => value.key === key).length >= 10)
        return { error: new PlatformError('För många inloggningsförsök. Vänta 15 minuter.', 429, 'platform_login_rate_limit') };
      const user = state.users.find(value => value.id === candidate?.id);
      const membership = state.memberships.find(value => value.userId === user?.id && value.active && state.companies.some(company => company.id === value.organisationId && company.status === 'active'));
      if (!valid || !user?.active || canonicalHash(user.password) !== canonicalHash(candidate.password) || !membership) {
        state.attempts.push({ address, key, at: stamp }); audit(state, undefined, 'platform.login_rejected', { attemptKey: key });
        return { error: new PlatformError('Fel inloggning eller inaktivt konto.', 401, 'platform_invalid_credentials') };
      }
      const prior = platformCookieToken(req);
      if (prior) state.sessions = state.sessions.filter(value => value.tokenHash !== hash(prior));
      const session = newSession(user, membership.organisationId, membership.businessUserId, token, tenantToken);
      state.sessions.push(session); user.lastLoginAt = stamp; state.attempts = state.attempts.filter(value => value.key !== key);
      audit(state, user, 'platform.login', { organisationId: session.organisationId, effectiveUserId: session.effectiveUserId, generation: session.generation });
      return { token };
    });
    if (result.error) throw result.error;
    return { token, tenantToken, value: await session({ ...req, headers: { cookie: `${PLATFORM_COOKIE}=${token}` } }) };
  }
  async function logout(req) {
    const { token, value } = await readSession(req, { writes: true, allowPasswordChange: true, allowInactiveCompany: true });
    await repository.transact(state => { const current = identity(state, token, { allowPasswordChange: true, allowInactiveCompany: true }); checkExpected(req, current, true);
      state.sessions = state.sessions.filter(item => item.tokenHash !== current.session.tokenHash); audit(state, value.actor, 'platform.logout', { organisationId: value.company.id }); });
    return { token: '', tenantToken: '', value: { enabled: true, authenticated: false } };
  }
  async function changePassword(input, req) {
    const parsed = parse(z.object({ currentPassword: z.string().max(200).optional(), newPassword: passwordSchema }).strict(), input);
    if (parsed.newPassword === 'JerocDemo2026!') fail('Välj ett privat lösenord. Det offentliga demolösenordet får inte användas.');
    const { token, value } = await readSession(req, { writes: true, allowPasswordChange: true });
    if (!value.actor.mustChangePassword && (!parsed.currentPassword || !await passwordValid(parsed.currentPassword, value.actor.password))) fail('Det nuvarande lösenordet stämmer inte.', 403, 'platform_password_mismatch');
    if (await passwordValid(parsed.newPassword, value.actor.password)) fail('Välj ett nytt lösenord.');
    const password = await platformPasswordHash(parsed.newPassword);
    const pending = await repository.transact(state => { const current = identity(state, token, { allowPasswordChange: true }); checkExpected(req, current, true);
      if (canonicalHash(current.actor.password) !== canonicalHash(value.actor.password)) fail('Lösenordet har ändrats i en annan session.', 409, 'platform_context_changed');
      if (current.actor.passwordSyncPending && current.actor.passwordSyncLeaseUntil > at()) fail('Lösenordet håller redan på att synkroniseras. Vänta en stund.', 409, 'platform_password_sync_pending');
      current.actor.password = password; current.actor.mustChangePassword = true; current.actor.passwordSyncPending = true; current.actor.passwordSyncLeaseUntil = new Date(Date.parse(at()) + 120_000).toISOString();
      state.sessions = state.sessions.filter(item => item.userId !== current.actor.id || item.tokenHash === current.session.tokenHash);
      return { user: clone(current.actor), companyIds: state.memberships.filter(item => item.userId === current.actor.id && item.active).map(item => item.organisationId) }; });
    try { await onPasswordChanged({ ...pending, user: { ...pending.user, mustChangePassword: false }, password }); }
    catch { await repository.transact(state => { const actor = state.users.find(user => user.id === value.actor.id); if (canonicalHash(actor.password) === canonicalHash(password)) actor.passwordSyncLeaseUntil = at(); });
      fail('Lösenordet har sparats men bolagskontot kunde inte aktiveras. Försök igen eller logga in med ditt nya lösenord.', 503, 'platform_password_sync_failed'); }
    const nextToken = secret(), tenantToken = secret();
    await repository.transact(state => { const current = identity(state, token, { allowPasswordChange: true }); checkExpected(req, current, true);
      if (canonicalHash(current.actor.password) !== canonicalHash(password)) fail('Lösenordet har ändrats i en annan session.', 409, 'platform_context_changed');
      current.actor.mustChangePassword = false; delete current.actor.passwordSyncPending; delete current.actor.passwordSyncLeaseUntil; current.actor.passwordChangedAt = at();
      state.sessions = state.sessions.filter(item => item.userId !== current.actor.id);
      state.sessions.push(newSession(current.actor, current.company.id, current.session.effectiveUserId, nextToken, tenantToken));
      audit(state, current.actor, 'platform.password_changed', { organisationId: current.company.id }); });
    return { token: nextToken, tenantToken, value: await session({ ...req, headers: { cookie: `${PLATFORM_COOKIE}=${nextToken}` } }) };
  }
  const admin = value => { if (!value.actor.platformAdmin) fail('Plattformsadministratör krävs.', 403, 'platform_admin_required'); };
  async function companies(req) { const { value } = await readSession(req); return repository.read(state => ({ companies: state.companies.filter(company => value.actor.platformAdmin || state.memberships.some(member => member.userId === value.actor.id && member.organisationId === company.id && member.active))
    .map(company => ({ ...publicCompany(company), ...(value.actor.platformAdmin && { ownerPasswordChangePending: state.users.some(user => user.id === company.ownerUserId && user.mustChangePassword && !user.platformAdmin) }) })) })); }
  async function users(organisationId, req) {
    const { value } = await readSession(req); admin(value);
    const company = await repository.read(state => clone(state.companies.find(item => item.id === organisationId)));
    if (!company || company.status !== 'active') fail('Bolaget är inte tillgängligt.', 404, 'platform_company_unavailable');
    const result = await companyUsers(organisationId);
    return { users: result.filter(user => user.active !== false && user.id !== '__platform-admin').map(user => ({ id: user.id, name: user.name, level: user.level, active: user.active !== false })) };
  }
  async function switchCompany(input, req) {
    const parsed = parse(z.object({ organisationId: userIdSchema, effectiveUserId: userIdSchema.optional() }).strict(), input);
    const { value, token } = await readSession(req, { writes: true });
    const target = await repository.read(state => {
      const company = state.companies.find(item => item.id === parsed.organisationId);
      const membership = state.memberships.find(item => item.userId === value.actor.id && item.organisationId === company?.id && item.active);
      if (!company || company.status !== 'active') fail('Bolaget är inte tillgängligt.', 409, 'platform_company_unavailable');
      if (!value.actor.platformAdmin && (!membership || parsed.effectiveUserId && parsed.effectiveUserId !== membership.businessUserId)) fail('Bolaget eller kontot omfattas inte av din inloggning.', 403, 'platform_company_forbidden');
      return { company: clone(company), effectiveUserId: parsed.effectiveUserId ?? (value.actor.platformAdmin ? company.id === 'jeroc-demo' ? value.actor.businessId : '__platform-admin' : membership.businessUserId) };
    });
    const selected = await resolveCompanyUser(target.company.id, target.effectiveUserId);
    if (!selected || selected.active === false || selected.id !== target.effectiveUserId) fail('Välj ett aktivt konto i bolaget.', 403, 'platform_account_inactive');
    const nextToken = secret(), tenantToken = secret();
    await repository.transact(state => { const current = identity(state, token); checkExpected(req, current, true);
      const company = state.companies.find(item => item.id === target.company.id);
      if (!company || company.status !== 'active') fail('Bolaget är inte tillgängligt.', 409, 'platform_company_unavailable');
      if (!current.actor.platformAdmin && !state.memberships.some(item => item.userId === current.actor.id && item.organisationId === company.id && item.businessUserId === selected.id && item.active)) fail('Bolagsbehörigheten har ändrats.', 403, 'platform_company_forbidden');
      state.sessions = state.sessions.filter(item => item.tokenHash !== current.session.tokenHash);
      const next = newSession(current.actor, company.id, selected.id, nextToken, tenantToken); state.sessions.push(next);
      audit(state, current.actor, current.actor.platformAdmin ? 'platform.support_context_changed' : 'platform.company_changed', { organisationId: company.id, effectiveUserId: selected.id, previousOrganisationId: current.company.id, previousEffectiveUserId: current.session.effectiveUserId, generation: next.generation }); });
    return { token: nextToken, tenantToken, value: await session({ ...req, headers: { cookie: `${PLATFORM_COOKIE}=${nextToken}` } }) };
  }
  async function createCompany(input, req) {
    const parsed = parse(newCompanySchema, input);
    parsed.organisationNumber = normalizeOrganisationNumber(parsed.organisationNumber); parsed.vdEmail = username(parsed.vdEmail);
    const numberError = customerIdentifierError('Företag', parsed.organisationNumber); if (numberError) fail(numberError);
    const { value, token } = await readSession(req, { writes: true }); admin(value);
    if (typeof provisionCompany !== 'function') fail('Bolagsprovisionering är inte tillgänglig.', 503, 'platform_provisioning_unavailable');
    const fingerprint = canonicalHash(parsed), temporaryPassword = `${randomBytes(21).toString('base64url')}!a1`, password = await platformPasswordHash(temporaryPassword);
    const reservation = await repository.transact(state => { const current = identity(state, token); checkExpected(req, current, true); admin(current);
      const existing = state.creations.find(item => item.actorId === current.actor.id && item.requestId === parsed.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('Samma skapandeförsök innehåller andra uppgifter.', 409, 'platform_idempotency_conflict');
        const company = state.companies.find(item => item.id === existing.companyId), user = state.users.find(item => item.id === company?.ownerUserId);
        if (existing.status === 'active') return { existing: true, company: clone(company), user: clone(user) };
        if (existing.leaseUntil > at()) fail('Bolaget håller redan på att skapas. Uppdatera bolagslistan.', 409, 'platform_provisioning_in_progress');
        existing.leaseUntil = new Date(Date.parse(at()) + 120_000).toISOString(); company.status = 'provisioning';
        // A failed attempt never returned credentials. Rotate its inaccessible
        // first-login credential before resuming; the company/user/schema IDs
        // remain stable and no active employee account is reset.
        if (!user.mustChangePassword) fail('Bolagskontot har redan aktiverats. Provisioneringen kan inte återstartas.', 409, 'platform_provisioning_conflict');
        user.password = password;
        return { existing: true, company: clone(company), user: clone(user), retry: true };
      }
      if (state.companies.some(item => item.organisationNumber === parsed.organisationNumber)) fail('Ett bolag med detta organisationsnummer finns redan.', 409, 'platform_company_exists');
      if (state.users.some(item => item.username === parsed.vdEmail)) fail('E-postadressen används redan av ett plattformskonto.', 409, 'platform_username_exists');
      const company = { id: randomUUID(), storageSchema: `jeroc_t_${randomUUID().replaceAll('-', '')}`, name: parsed.name, organisationNumber: parsed.organisationNumber, status: 'provisioning', createdAt: at(), ownerUserId: randomUUID() };
      const user = { id: company.ownerUserId, businessId: company.ownerUserId, name: parsed.vdName, username: parsed.vdEmail, email: parsed.vdEmail,
        password, platformAdmin: false, active: true, mustChangePassword: true, createdAt: at() };
      state.companies.push(company); state.users.push(user); state.memberships.push({ userId: user.id, organisationId: company.id, businessUserId: user.id, active: true });
      state.creations.push({ actorId: current.actor.id, requestId: parsed.requestId, fingerprint, companyId: company.id, status: 'provisioning', leaseUntil: new Date(Date.parse(at()) + 120_000).toISOString() });
      audit(state, current.actor, 'platform.company_provisioning_started', { organisationId: company.id, ownerUserId: user.id });
      return { company: clone(company), user: clone(user) };
    });
    if (reservation.existing && !reservation.retry) return { company: publicCompany(reservation.company), user: publicActor(reservation.user), credentialsRevealed: false };
    try { await provisionCompany({ company: reservation.company, user: reservation.user, temporaryPassword, passwordHash: reservation.user.password }); }
    catch {
      await repository.transact(state => { const company = state.companies.find(item => item.id === reservation.company.id), creation = state.creations.find(item => item.companyId === company?.id);
        company.status = 'failed'; creation.status = 'failed'; creation.leaseUntil = at(); audit(state, value.actor, 'platform.company_provisioning_failed', { organisationId: company.id }); });
      fail('Bolaget kunde inte färdigställas och är spärrat för inloggning. Försök igen med samma skapandeförsök.', 503, 'platform_provisioning_failed');
    }
    const saved = await repository.transact(state => { const company = state.companies.find(item => item.id === reservation.company.id), creation = state.creations.find(item => item.companyId === company?.id);
      company.status = 'active'; company.provisionedAt = at(); creation.status = 'active'; delete creation.leaseUntil;
      audit(state, value.actor, 'platform.company_created', { organisationId: company.id, ownerUserId: company.ownerUserId }); return clone(company); });
    return { company: publicCompany(saved), user: publicActor(reservation.user), credentialsRevealed: true,
      temporaryCredentials: { username: reservation.user.username, password: temporaryPassword, mustChangePassword: true } };
  }
  async function resetInitialPassword(organisationId, input, req) {
    const parsed = parse(z.object({ requestId: z.string().uuid() }).strict(), input);
    const { value, token } = await readSession(req, { writes: true }); admin(value);
    const temporaryPassword = `${randomBytes(21).toString('base64url')}!a1`, password = await platformPasswordHash(temporaryPassword);
    const reservation = await repository.transact(state => {
      const current = identity(state, token); checkExpected(req, current, true); admin(current);
      const company = state.companies.find(item => item.id === organisationId && item.status === 'active');
      const user = state.users.find(item => item.id === company?.ownerUserId && item.active);
      if (!company || !user || user.platformAdmin) fail('Bolagets VD-konto kunde inte väljas.', 404, 'platform_account_inactive');
      state.initialPasswordResets ??= [];
      const existing = state.initialPasswordResets.find(item => item.actorId === current.actor.id && item.organisationId === organisationId && item.requestId === parsed.requestId);
      if (existing?.status === 'completed') return { completed: true, company: clone(company), user: clone(user) };
      if (existing?.leaseUntil > at()) fail('Ett tillfälligt lösenord håller redan på att skapas.', 409, 'platform_password_reset_in_progress');
      if (!user.mustChangePassword) fail('VD-kontot har redan aktiverats. Detta gäller bara ett väntande första lösenordsbyte.', 409, 'platform_password_already_activated');
      if (user.passwordSyncPending && user.passwordSyncLeaseUntil > at()) fail('VD-kontots lösenord håller redan på att synkroniseras. Vänta en stund.', 409, 'platform_password_sync_pending');
      const record = existing ?? { actorId: current.actor.id, organisationId, requestId: parsed.requestId };
      record.status = 'pending'; record.leaseUntil = new Date(Date.parse(at()) + 120_000).toISOString();
      if (!existing) state.initialPasswordResets.push(record);
      user.password = password; user.passwordSyncPending = true; user.passwordSyncLeaseUntil = record.leaseUntil;
      state.sessions = state.sessions.filter(session => session.userId !== user.id);
      return { company: clone(company), user: clone(user), companyIds: state.memberships.filter(item => item.userId === user.id && item.active).map(item => item.organisationId) };
    });
    if (reservation.completed) return { company: publicCompany(reservation.company), user: publicActor(reservation.user), credentialsRevealed: false };
    try { await onPasswordChanged({ user: reservation.user, companyIds: reservation.companyIds, password, temporaryReset: true }); }
    catch {
      await repository.transact(state => { const record = state.initialPasswordResets.find(item => item.actorId === value.actor.id && item.organisationId === organisationId && item.requestId === parsed.requestId); record.status = 'failed'; record.leaseUntil = at(); const user = state.users.find(item => item.id === reservation.user.id); if (canonicalHash(user.password) === canonicalHash(password)) user.passwordSyncLeaseUntil = at(); });
      fail('Det väntande VD-kontot kunde inte synkroniseras. Försök skapa ett nytt tillfälligt lösenord igen.', 503, 'platform_password_sync_failed');
    }
    await repository.transact(state => {
      const record = state.initialPasswordResets.find(item => item.actorId === value.actor.id && item.organisationId === organisationId && item.requestId === parsed.requestId);
      const user = state.users.find(item => item.id === reservation.user.id);
      if (!user.mustChangePassword || canonicalHash(user.password) !== canonicalHash(password)) fail('VD-kontot har ändrats under tiden. Uppdatera bolagslistan.', 409, 'platform_context_changed');
      delete user.passwordSyncPending; delete user.passwordSyncLeaseUntil; record.status = 'completed'; delete record.leaseUntil;
      audit(state, value.actor, 'platform.initial_password_reissued', { organisationId, effectiveUserId: user.id, requestId: parsed.requestId });
    });
    return { company: publicCompany(reservation.company), user: publicActor(reservation.user), credentialsRevealed: true,
      temporaryCredentials: { username: reservation.user.username, password: temporaryPassword, mustChangePassword: true } };
  }
  async function resolveTenantSelector(req) {
    const token = tenantCookieToken(req); if (token === undefined) return undefined;
    await initialize();
    return repository.read(state => {
      const selection = state.selections?.find(item => item.tokenHash === hash(token) && item.expiresAt > at());
      if (selection) {
        const company = state.companies.find(item => item.id === selection.organisationId && item.status === 'active');
        if (!company) fail('Bolaget är inte tillgängligt.', 401, 'platform_tenant_selector_invalid');
        return { organisationId: company.id, company: clone(company), storageSchema: company.storageSchema, publicSelection: true };
      }
      const session = state.sessions.find(item => item.tenantTokenHash === hash(token) && item.expiresAt > at());
      const actor = state.users.find(item => item.id === session?.userId && item.active);
      const company = state.companies.find(item => item.id === session?.organisationId && item.status === 'active');
      if (!session || !actor || actor.mustChangePassword || !company || !actor.platformAdmin && !state.memberships.some(item => item.userId === actor.id && item.organisationId === company.id && item.active))
        fail('Bolagsvalet är inte giltigt längre. Logga in igen.', 401, 'platform_tenant_selector_invalid');
      return { organisationId: company.id, company: clone(company), storageSchema: company.storageSchema };
    });
  }
  async function selectTenant(input, req = { headers: {}, socket: {} }) {
    await initialize();
    const parsed = parse(z.object({ organisationId: z.union([z.literal('jeroc-demo'), z.string().uuid()]) }).strict(), typeof input === 'string' ? { organisationId: input } : input);
    const tenantToken = secret(), address = hash(req.socket?.remoteAddress ?? 'unknown');
    const company = await repository.transact(state => {
      const company = state.companies.find(item => item.id === parsed.organisationId && item.status === 'active');
      if (!company) fail('Bolaget är inte tillgängligt.', 404, 'platform_company_unavailable');
      state.selections ??= []; state.selections = state.selections.filter(item => item.expiresAt > at());
      if (state.selections.filter(item => item.address === address && Date.parse(item.createdAt) > Date.parse(at()) - ATTEMPT_MS).length >= 60)
        fail('För många bolagsval. Vänta en stund och försök igen.', 429, 'platform_selection_rate_limit');
      const old = tenantCookieToken(req); if (old) state.selections = state.selections.filter(item => item.tokenHash !== hash(old));
      const platform = platformCookieToken(req); if (platform) state.sessions = state.sessions.filter(item => item.tokenHash !== hash(platform));
      state.selections.push({ tokenHash: hash(tenantToken), organisationId: company.id, address, createdAt: at(), expiresAt: new Date(Date.parse(at()) + SESSION_MS).toISOString() });
      const selected = publicCompany(company); delete selected.ownerUserId; return selected;
    });
    return { token: '', tenantToken, value: { enabled: true, authenticated: false, company } };
  }
  async function checkRequest(req, { write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) } = {}) {
    const { value } = await readSession(req, { writes: write }); return value;
  }
  return { initialize, login, logout, session, changePassword, resolveContext, checkRequest, resolveTenantSelector, selectTenant, companies, users, switchCompany, createCompany, resetInitialPassword,
    getCompany: organisationId => repository.read(state => clone(state.companies.find(item => item.id === organisationId))), repository };
}
