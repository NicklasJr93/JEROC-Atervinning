import { bankRequestContext } from './bank-http.mjs';
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, getPlatformContext, platformCookieToken, PlatformError, PLATFORM_TENANT_COOKIE, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformApi } from './platform-api.mjs';
import { tenantRuntimeEnvironment, tenantInitialSites, createTenantApplicationState } from './tenant-runtime.mjs';
import { createTenantServices } from './tenant-services.mjs';
import { employeeRequestPrincipal, employeeCompanyLookupContext, hasEmployeeSession } from './mobile-employee-api.mjs';
import { withBusinessIdentity } from './business-identity.mjs';
import { createPlatformFleet } from './platform-fleet.mjs';
import { applyFleetDeviceAssignment } from './fleet-telematics.mjs';
import { createFleetSimulatorBridge } from './fleet-simulator.mjs';
import { readDeploymentProfile } from './deployment-profile.mjs';
import { createScbCompanyRegister } from './scb-company-register.mjs';
import { createCompanyRegisterApi } from './company-register-api.mjs';
import { createAddressAssistanceApi } from './address-assistance-api.mjs';
import { createGoogleAddressValidation } from './google-address-validation.mjs';
import { createSystemEmail } from './system-email.mjs';
import { createPlatformCommunications } from './platform-communications.mjs';
import { createSystemSmsProvider } from './system-sms-provider.mjs';
import { createPlatformPasswordReset } from './platform-password-reset.mjs';
import { initialAdminProfileForDeployment } from './deployment-profile-seeds.mjs';
import { createStaffInvitations, validateStaffInvitationTarget } from './staff-invitations.mjs';
import { createPublicCustomerApproval } from './public-customer-approval.mjs';
import { createGlobalEmployeeLogin } from './mobile-global-login.mjs';
import { createMobilePlatformSupport } from './mobile-platform-support.mjs';
import { attachMobileSupport, mobileSupportIdentity, withMobileSupportAuthorization } from './mobile-support-identity.mjs';

const legacyId = 'jeroc-demo';
const knownPages = new Set(['/kontor', '/kontor/', '/mobil', '/mobil/', '/', '/terminal', '/terminal/', '/chauffor', '/chauffor/', '/kund', '/kund/', '/akeri', '/akeri/']);
const deviceRoute = url => /^\/api\/terminal-demo\/(session|login|logout|heartbeat|terminal-events)$/.test(url.pathname)
  || /^\/api\/terminal-demo\/approvals\/[^/]+\/(respond|displayed)$/.test(url.pathname);
const employeeRoute = url => url.pathname === '/api/company-settings/defaults' || url.pathname.startsWith('/api/employee/') || url.pathname.startsWith('/api/driver/')
  || /^\/api\/(customer|carrier)\//.test(url.pathname)
  || /^\/api\/application\/(mobile|mobile-prices)(?:$|\/)/.test(url.pathname)
  || url.pathname === '/api/application/revision' && url.searchParams.get('domain') === 'mobile';
const mobileData = url => /^\/api\/application\/(mobile|mobile-prices)(?:$|\/)/.test(url.pathname)
  || url.pathname === '/api/application/revision' && url.searchParams.get('domain') === 'mobile';
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
};
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new PlatformError('Anropet måste komma från samma webbplats.', 403, 'platform_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { throw new PlatformError('Anropet måste komma från samma webbplats.', 403, 'platform_origin_forbidden'); }
}

/** The sole production entry into business APIs. Schema/actor selection always
 * comes from the platform registry and a server-authenticated session. Public
 * login endpoints select a bundle but still require its own employee/device or
 * partner credentials; a tenant selector is never a permission grant. */
export async function createTenantGateway({ env = process.env, makeServices = createTenantServices, testCarApi, platformRepository, companyRegister, addressValidation, systemEmail, systemSms } = {}) {
  const profile = readDeploymentProfile(env);
  const bundles = new Map(), streams = new Set();
  const fleetSimulator = createFleetSimulatorBridge({ testCarApi });
  const repository = platformRepository ?? await createPlatformStorage({ env });
  const customerApprovalLinks = createPublicCustomerApproval({ repository, env, openCompany: company => bundle(company) });
  let schemaPool, auth, stopping = false;
  const defaultCompany = profile.pilot ? undefined : { id: legacyId, name: 'JEROC Återvinning AB', organisationNumber: '5593593626', status: 'active', storageSchema: 'public' };
  if (profile.pilot && await repository.read(state => state.companies.some(company => company.id === legacyId))) {
    await repository.close();
    throw new PlatformError('Pilotmiljön får inte använda den befintliga demodatabasen. Välj en ny separat databas.', 503, 'platform_pilot_database_conflict');
  }
  const trustedPrincipalProvider = req => {
    const context = getPlatformContext(req);
    return context && { actorId: context.actualUser.id, userId: context.user.id, csrfToken: context.csrfToken, expiresAt: context.expiresAt, sessionKey: context.sessionKey };
  };
  const reauthorizeTrustedPrincipal = async req => {
    const current = await auth.resolveContext(req, { writes: false });
    return { actorId: current.actualUser.id, userId: current.user.id, csrfToken: current.csrfToken, expiresAt: current.expiresAt, sessionKey: current.sessionKey };
  };
  async function ensureSchema(company) {
    if (!env.DATABASE_URL || company.id === legacyId) return;
    if (!/^jeroc_t_[a-z0-9]{16,48}$/.test(company.storageSchema ?? '')) throw new PlatformError('Bolagets lagring är inte giltig.', 503);
    schemaPool ??= new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, connectionTimeoutMillis: 8000 });
    // The identifier is generated by the platform and strictly validated above.
    await schemaPool.query(`CREATE SCHEMA IF NOT EXISTS "${company.storageSchema}"`);
    await schemaPool.query(`REVOKE ALL ON SCHEMA "${company.storageSchema}" FROM PUBLIC`);
  }
  async function bundle(company, owner) {
    if (stopping) throw new PlatformError('Servern stängs av.', 503);
    if (!company || profile.pilot && company.id === legacyId) throw new PlatformError('Välj ett bolag innan du öppnar verksamheten.', 409, 'platform_company_required');
    let pending = bundles.get(company.id);
    if (!pending) {
      pending = (async () => {
        if (owner) await ensureSchema(company);
        const scopedEnv = tenantRuntimeEnvironment(env, company);
        const registeredOwner = owner ?? (company.id !== legacyId ? await repository.read(state => structuredClone(state.users.find(user => user.id === company.ownerUserId))) : undefined);
        if (company.id !== legacyId && !registeredOwner) throw new PlatformError('Bolagets VD-konto saknas.', 503);
        return makeServices({ env: scopedEnv, company,
          customerApprovalEmail: systemEmail, customerApprovalSms: systemSms,
          registerCustomerApprovalLink: input => customerApprovalLinks.register(company.id, input),
          ...(registeredOwner && { seed: () => createTenantApplicationState({ tenant: company, owner: {
            id: registeredOwner.id, personId: `person-${registeredOwner.id}`, name: registeredOwner.name, username: registeredOwner.username,
            email: registeredOwner.email, passwordHash: registeredOwner.password, mustChangePassword: registeredOwner.mustChangePassword,
          } }) }),
          ...(company.id !== legacyId && { initialSites: tenantInitialSites(company) }), trustedPrincipalProvider, reauthorizeTrustedPrincipal,
          companySettingsAuthorize: (req, options) => authorizeCompanySettingsRequest(req, company, options) });
      })();
      bundles.set(company.id, pending);
      pending.catch(() => { if (bundles.get(company.id) === pending) bundles.delete(company.id); });
    }
    return pending;
  }
  const legacy = profile.pilot ? undefined : await bundle(defaultCompany);
  auth = createPlatformAuth({ repository, platformAdminEmail: env.SCRAPPLANNER_PLATFORM_ADMIN_EMAIL,
    initialAdminProfile: initialAdminProfileForDeployment(env),
    ...(profile.pilot && { bootstrapPlatform: async () => ({ id: 'platform-admin', username: 'admin', name: 'Systemadmin', active: true,
      password: await platformPasswordHash(env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD) }) }),
    bootstrapLegacy: async () => {
      const imported = await (await legacy.applicationApi.getRepository()).read(state => {
        const user = state.pricing.users.find(value => value.id === 'admin' && value.level === 'Systemadmin' && value.active !== false);
        const person = user && state.personnel.people.find(value => value.userId === user.id && value.active);
        const account = person && state.personnelAuth.accounts.find(value => value.personId === person.id && value.active);
        return account ? { userId: user.id, name: user.name, username: account.username, password: account.password,
          personId: person.id, email: person.email, active: true } : null;
      }, { domains: ['pricing', 'personnel', 'personnelAuth'] });
      if (imported && env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD) {
        if (env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD.length < 16) throw new PlatformError('SCRAPPILOT_PLATFORM_ADMIN_PASSWORD måste innehålla minst 16 tecken.', 503, 'platform_bootstrap_required');
        imported.password = await platformPasswordHash(env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD);
        imported.privateBootstrap = true;
        // The same administrator account exists in the employee app. Retire its
        // public fixture credential as soon as private bootstrap is configured,
        // before the first platform login, without replacing its identity.
        await (await legacy.applicationApi.getRepository()).transact(state => {
          const account = state.personnelAuth.accounts.find(value => value.personId === imported.personId);
          account.password = structuredClone(imported.password);
          state.personnelAuth.sessions = state.personnelAuth.sessions.filter(value => value.personId !== imported.personId);
        });
      }
      return imported;
    },
    legacyCompany: { name: 'JEROC Återvinning AB', organisationNumber: '5593593626', storageSchema: 'public' },
    provisionCompany: async ({ company, user }) => { await bundle(company, user); },
    companyUsers: async organisationId => {
      const company = await auth.getCompany(organisationId);
      const service = await bundle(company);
      const business = await service.applicationApi.getRepository();
      return business.readProjection(state => structuredClone(state.pricing.users), { domain: 'pricing', paths: [['users']] });
    },
    resolveCompanyUser: async (organisationId, userId) => {
      const company = await auth.getCompany(organisationId);
      if (!company) return null;
      const service = await bundle(company);
      const business = await service.applicationApi.getRepository();
      return business.readProjection(state => structuredClone(state.pricing.users.find(value => value.id === userId) ?? null), { domain: 'pricing', paths: [['users']] });
    },
    validateStaffInvitation: async target => {
      const company = await auth.getCompany(target?.companyId);
      if (!company || company.status !== 'active') throw new PlatformError('Bolaget är inte tillgängligt.', 409, 'staff_invitation_changed');
      const service = await bundle(company);
      await (await service.applicationApi.getRepository()).read(state => validateStaffInvitationTarget(state, target), { domains: ['pricing', 'personnel', 'personnelAuth'] });
    },
    onPasswordChanged: async ({ user, password, companyIds, recovery = false, phase, requestId, initialPasswordChange = false, companyMemberships = [], assertCurrent }) => {
      for (const companyId of companyIds) {
        await assertCurrent?.();
        const company = await auth.getCompany(companyId), service = await bundle(company);
        await (await service.applicationApi.getRepository()).transact(async state => {
          await assertCurrent?.();
          const businessUserId = companyMemberships.find(value => value.organisationId === companyId)?.businessUserId ?? user.businessId;
          const person = state.personnel.people.find(value => value.userId === businessUserId);
          const account = person && state.personnelAuth.accounts.find(value => value.personId === person.id);
          if (!account) throw new PlatformError('Personalkontot saknas. Lösenordet har inte ändrats.', 409);
          if (user.staffInvitationTarget && !user.passwordChangedAt) validateStaffInvitationTarget(state, user.staffInvitationTarget);
          // Recovery revokes every linked account first, before any new hash
          // is activated. A partial failure can never leave an old password
          // active after a successful reset.
          if (recovery) {
            const linked = state.pricing.users.find(value => value.id === businessUserId);
            const fingerprint = () => createHash('sha256').update(JSON.stringify([person.id, person.userId, person.active,
              linked?.active, account.username, account.active, account.password, account.updatedAt])).digest('hex');
            // Private auth metadata stays outside the public account list. It
            // preserves deliberate deactivation across retries and detects an
            // administrator editing the account while recovery is running.
            const markers = state.personnelAuth.passwordRecoveries ??= [];
            let marker = markers.find(value => value.personId === person.id);
            if (phase === 'revoke') {
              const unchanged = marker?.fingerprint === fingerprint();
              if (marker?.requestId === requestId && !unchanged)
                throw new PlatformError('Personalkontot ändrades under återställningen. Kontakta systemadmin.', 409);
              const saved = { personId: person.id, requestId,
                wasActive: unchanged ? marker.wasActive : account.active === true,
                allowInitialActivation: unchanged ? marker.allowInitialActivation : initialPasswordChange };
              account.active = false; account.updatedAt = new Date().toISOString();
              marker = { ...saved, fingerprint: fingerprint() };
              state.personnelAuth.passwordRecoveries = markers.filter(value => value.personId !== person.id).concat(marker);
            } else {
              if (phase !== 'apply' || marker?.requestId !== requestId || marker.fingerprint !== fingerprint())
                throw new PlatformError('Personalkontot ändrades under återställningen. Kontakta systemadmin.', 409);
              account.password = structuredClone(password);
              account.active = Boolean((marker.wasActive || marker.allowInitialActivation) && person.active && linked?.active !== false);
              account.updatedAt = new Date().toISOString(); marker.fingerprint = fingerprint();
            }
          } else { account.password = structuredClone(password); account.active = user.mustChangePassword !== true; account.updatedAt = new Date().toISOString(); }
          state.personnelAuth.sessions = state.personnelAuth.sessions.filter(value => value.personId !== person.id);
        });
      }
    },
  });
  try { await auth.initialize(); } catch (error) {
    if (error.code !== 'platform_bootstrap_required') throw error;
    console.warn('Bolagsadministrationen väntar på ett privat systemadminlösenord i Render.');
  }
  const platformFleet = createPlatformFleet({ auth, repository, applyAssignment: async (company, device) => {
    const service = await bundle(company);
    await (await service.applicationApi.getRepository()).transact(state => {
      applyFleetDeviceAssignment(state, device, { organisationId: company.id });
    });
  } });
  const email = systemEmail ?? createSystemEmail({ env });
  const communications = createPlatformCommunications({ auth, email, sms: systemSms ?? createSystemSmsProvider({ env }), repository });
  const passwordReset = createPlatformPasswordReset({ auth, email, repository, env });
  const staffInvitations = createStaffInvitations({ auth, email, repository, env,
    companyRepository: async company => (await bundle(company)).applicationApi.getRepository() });
  const platformApi = createPlatformApi({ auth, fleet: platformFleet, communications, passwordReset, staffInvitations, env });
  const mobilePlatformSupport = createMobilePlatformSupport({ auth, env, openCompany: bundle, sameOrigin, json });
  const globalEmployeeLogin = createGlobalEmployeeLogin({ repository, auth, env, openCompany: bundle,
    fallbackCompany: defaultCompany, sameOrigin, json, platformAdminLogin: mobilePlatformSupport.login });
  const fleetTimer = setInterval(() => { void platformFleet.reconcile().catch(() => console.warn('Trackerregistret väntar på synkronisering.')); }, 30_000);
  fleetTimer.unref();
  void platformFleet.reconcile().catch(() => console.warn('Trackerregistret väntar på synkronisering.'));
  // Reopen existing companies, never seed them from JEROC or a lost temporary
  // password. Their independent durable queues resume in their original scope.
  for (const company of await repository.read(state => structuredClone(state.companies.filter(value => value.status === 'active' && value.id !== legacyId)))) {
    try { await bundle(company); } catch { console.warn('Ett bolags tjänst kunde inte startas. Övriga bolag fortsätter och dess lagring används inte som ersättning.'); }
  }

  function bindIdentity(req, context) {
    for (const [header, expected] of [
      ['x-demo-actor', context.actualUser.id], ['x-demo-user', context.user.id],
      ['x-terminal-actual-user', context.actualUser.id], ['x-terminal-effective-user', context.user.id],
      ['x-environment-actual-user', context.actualUser.id], ['x-environment-effective-user', context.user.id],
    ]) {
      if (req.headers[header] !== undefined && req.headers[header] !== expected) throw new PlatformError('Det aktiva bolaget eller kontot har ändrats. Ladda om sidan.', 409, 'platform_context_changed');
      req.headers[header] = expected;
    }
    delete req.headers['x-demo-mobile'];
  }
  function protectStream(req, res, context) {
    let checking = false, timer;
    const check = async () => {
      if (checking || res.destroyed || res.writableEnded) return;
      checking = true;
      try { await auth.checkRequest(req, { write: false }); }
      catch { if (!res.writableEnded) res.end(); }
      finally { checking = false; }
    };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const headers = args.find(value => value && typeof value === 'object');
      if (String(headers?.['Content-Type'] ?? this.getHeader('Content-Type')).startsWith('text/event-stream')) {
        req.headers['x-platform-generation'] = context.generation;
        timer = setInterval(check, 5000); timer.unref(); streams.add(res);
        res.once('close', () => { clearInterval(timer); streams.delete(res); });
      }
      return writeHead.apply(this, args);
    };
  }
  // Both helpers authenticate their own asynchronous requests, including a
  // second check after the provider returns. A browser-supplied tenant never
  // grants access; the SCB lookup retains its narrower customer permission.
  const addressRights = ['prepare', 'customers', 'transportPlan', 'workOrdersWrite', 'vesselsWrite',
    'environmentWrite', 'environmentStorage', 'personnelWrite', 'employmentWrite', 'environmentIntegration', 'integrationsManage'];
  const authorizeAssistance = async (req, address = false) => {
      const configOnly = address && req.url?.split('?')[0] === '/api/address-assistance/config';
      const allowed = user => user?.active !== false && (user?.level && user.level !== 'Medarbetare'
        || (address ? [...addressRights, ...(configOnly ? ['integrationsRead'] : [])] : ['customers']).some(right => user?.permissions?.includes(right)));
      const deniedMessage = address ? 'Du saknar behörighet att använda adresshjälpen.' : 'Du saknar behörighet att registrera kunder.';
      if (platformCookieToken(req) !== undefined) {
        const identity = await auth.checkRequest(req, { write: true });
        const selected = identity.company;
        if (!selected && identity.actor.platformAdmin) {
          return { rateKey: `platform:${identity.actor.id}`, tenantRateKey: `platform:${identity.actor.id}`, scopeKey: JSON.stringify([
            identity.actor.id, identity.session.tokenHash, identity.session.generation, null,
          ]) };
        }
        const context = await auth.resolveContext(req, { writes: true });
        bindIdentity(req, context);
        if (!allowed(context.actualUser) || !allowed(context.user))
          throw new PlatformError(deniedMessage, 403, address ? 'address_assistance_forbidden' : 'company_lookup_forbidden');
        const expected = req.headers['x-client-company'] ?? req.headers['x-employee-company'];
        if (expected !== undefined && expected !== context.company.id)
          throw new PlatformError('Bolaget har bytts i en annan flik. Sök igen.', 409, 'company_selection_changed');
        return { rateKey: `platform:${context.actorId}:${context.company.id}`, tenantRateKey: context.company.id, scopeKey: JSON.stringify([
          context.actorId, context.actualUser.id, context.user.id, context.company.id, context.sessionKey, context.generation,
        ]) };
      }
      // A mobile lookup requires its real employee cookie and the signed tenant
      // selector, never an actor/user or company ID supplied by the browser.
      if (!hasEmployeeSession(req)) throw new PlatformError('Logga in för att söka företag.', 401, 'company_lookup_session_required');
      const company = (await auth.resolveTenantSelector(req))?.company ?? defaultCompany;
      if (!company) throw new PlatformError('Öppna bolagets egen inloggningslänk.', 409, 'platform_company_required');
      const expected = req.headers['x-employee-company'] ?? req.headers['x-client-company'];
      if (expected !== undefined && expected !== company.id)
        throw new PlatformError('Bolaget har bytts i en annan flik. Sök igen.', 409, 'company_selection_changed');
      const service = await bundle(company);
      const identity = await (await service.applicationApi.getRepository()).read(state => employeeCompanyLookupContext(state, req), { domains: ['pricing', 'personnel', 'personnelAuth'] });
      if (!allowed(identity.actor) || !allowed(identity.user))
        throw new PlatformError(deniedMessage, 403, address ? 'address_assistance_forbidden' : 'company_lookup_forbidden');
      return { rateKey: `employee:${identity.actor.id}:${company.id}`, tenantRateKey: company.id, scopeKey: JSON.stringify([
        identity.actor.id, identity.user.id, identity.personId, company.id, identity.sessionKey,
      ]) };
    };
  async function authorizeCompanySettingsRequest(req, expectedCompany, { write = false, basic = false } = {}) {
    const mayRead = user => user?.active !== false && (['VD', 'Systemadmin'].includes(user.level)
      || user.permissions?.some(right => ['companySettingsRead', 'companySettingsWrite'].includes(right)));
    const mayWrite = user => user?.active !== false && !user.siteIds
      && (['VD', 'Systemadmin'].includes(user.level) || user.permissions?.includes('companySettingsWrite'));
    let company, actor, user, actorId, userId, scopeKey;
    if (platformCookieToken(req) !== undefined) {
      const context = await auth.resolveContext(req, { writes: write });
      bindIdentity(req, context);
      company = context.company; actor = context.actualUser; user = context.user;
      actorId = actor.id; userId = user.id;
      scopeKey = JSON.stringify([context.actorId, actorId, userId, company.id, context.sessionKey, context.generation]);
    } else {
      if (!basic || write || !hasEmployeeSession(req)) throw new PlatformError('Logga in för att öppna företagsinställningarna.', 401, 'company_settings_session_required');
      company = (await auth.resolveTenantSelector(req))?.company ?? defaultCompany;
      if (!company) throw new PlatformError('Öppna bolagets egen inloggningslänk.', 409, 'platform_company_required');
      const service = await bundle(company);
      const identity = await (await service.applicationApi.getRepository()).read(state => employeeCompanyLookupContext(state, req), { domains: ['pricing', 'personnel', 'personnelAuth'] });
      actor = identity.actor; user = identity.user; actorId = actor.id; userId = user.id;
      scopeKey = JSON.stringify([actorId, userId, identity.personId, company.id, identity.sessionKey]);
    }
    const selected = req.headers['x-client-company'] ?? req.headers['x-employee-company'];
    if (company.id !== expectedCompany.id || selected !== undefined && selected !== company.id)
      throw new PlatformError('Bolaget har ändrats. Öppna sidan igen.', 409, 'company_settings_scope_changed');
    const canManage = mayWrite(actor) && mayWrite(user);
    if (!basic && (!mayRead(actor) || !mayRead(user)) || write && !canManage)
      throw new PlatformError('Du saknar behörighet för företagsinställningarna.', 403, 'company_settings_forbidden');
    return { companyId: company.id, actorId, userId, scopeKey, canManage };
  }
  const companyRegisterApi = createCompanyRegisterApi({ register: companyRegister ?? createScbCompanyRegister({ env }),
    authorize: req => authorizeAssistance(req) });
  const addressAssistanceApi = createAddressAssistanceApi({ validator: addressValidation ?? createGoogleAddressValidation({ env }),
    env, authorize: req => authorizeAssistance(req, true) });
  const api = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/')) return false;
    if (await customerApprovalLinks.handle(req, res, url)) return true;
    if (await mobilePlatformSupport.handle(req, res, url)) return true;
    if (await globalEmployeeLogin.handle(req, res, url)) return true;
    if (await companyRegisterApi(req, res, url)) return true;
    if (await addressAssistanceApi(req, res, url)) return true;
    if (url.pathname.startsWith('/api/public/voice-test')) {
      if (profile.pilot) { json(res, 404, { error: 'Rösttestet är inte tillgängligt i pilotmiljön.', code: 'not_found' }); return true; }
      // This capability is for the fixed demo tenant, never for a caller's
      // selected tenant or an arbitrary company supplied in headers/query.
      try {
        const company = await auth.getCompany(legacyId);
        if (!company || company.status !== 'active') throw new PlatformError('Rösttestet är inte tillgängligt.', 503, 'voice_demo_unavailable');
        const service = await bundle(company);
        if (await service.applicationApi.publicVoiceTestApi(req, res, url)) return true;
      } catch { json(res, 503, { error: 'Rösttestet är inte tillgängligt just nu.', code: 'voice_demo_unavailable' }); }
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/platform/tenant-context') {
      try {
        const context = platformCookieToken(req) !== undefined ? await auth.resolveContext(req, { writes: false }) : undefined;
        const company = context?.company ?? (await auth.resolveTenantSelector(req))?.company ?? defaultCompany;
        if (!company) throw new PlatformError('Öppna bolagets egen inloggningslänk för att fortsätta.', 409, 'platform_company_required');
        json(res, 200, { companyId: company.id, companyName: company.name });
      } catch (error) { json(res, error.status ?? 503, { error: error.message, code: error.code ?? 'tenant_unavailable' }); }
      return true;
    }
    if (await platformApi(req, res, url)) return true;
    try {
      const bankCallback = url.pathname === '/api/integrations/openpayments/callback';
      const mailCallback = url.pathname === '/api/integrations/microsoft-mail/callback';
      const callback = bankCallback || mailCallback || url.pathname === '/api/integrations/visma/oauth/callback';
      if (!callback || req.method !== 'GET') sameOrigin(req);
      const mediaRead = (/^\/api\/company-settings\/logos\/[a-f0-9-]+$/.test(url.pathname) || url.pathname.startsWith('/api/article-media/') || /^\/api\/fleet\/files\/[a-f0-9-]+$/.test(url.pathname)) && ['GET', 'HEAD'].includes(req.method);
      const office = callback || !employeeRoute(url) && !deviceRoute(url) && !mediaRead;
      let context, company;
      if (office) { context = await auth.resolveContext(req); company = context.company; bindIdentity(req, context); protectStream(req, res, context); }
      else {
        // Invalid/stale platform cookies cannot silently fall back into JEROC.
        if (platformCookieToken(req) !== undefined) context = await auth.resolveContext(req, { writes: false });
        company = context?.company ?? (await auth.resolveTenantSelector(req))?.company ?? defaultCompany;
      }
      if (!company && url.pathname === '/api/employee/demo-config' && req.method === 'GET') {
        json(res, 200, { enabled: false, accounts: { niklas: false, admin: false } }); return true;
      }
      if (!company && url.pathname.startsWith('/api/employee/')) throw new PlatformError('Logga in för att använda appen.', 401, 'employee_session_required');
      if (!company) throw new PlatformError('Öppna bolagets egen inloggningslänk för att fortsätta.', 409, 'platform_company_required');
      if (context?.platformAdmin && (employeeRoute(url) || mediaRead) && context.actualUser?.id === '__platform-admin' && context.user?.id === '__platform-admin') {
        const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        if (write && !req.headers['x-platform-generation']) throw new PlatformError('Sessionens bolagsversion saknas. Öppna bolaget igen.', 409, 'platform_context_changed');
        context = await auth.resolveContext(req, { writes: write });
        bindIdentity(req, context);
        attachMobileSupport(req, context, await auth.session(req));
      }
      return await withBusinessIdentity(context, async () => {
      const expectedCompany = req.headers['x-client-company'] ?? req.headers['x-employee-company'] ?? url.searchParams.get('expectedCompany');
      if (expectedCompany !== undefined && expectedCompany !== null && expectedCompany !== company.id)
        throw new PlatformError('Bolaget har bytts i en annan flik. Logga in igen.', 409, 'company_selection_changed');
      const service = await bundle(company);
      if (hasEmployeeSession(req) && (employeeRoute(url) || mediaRead)) await globalEmployeeLogin.authorizeSession(req, company, service);
      if (url.pathname === '/api/testcar/fleet') {
        const captured = { method: 'POST', headers: { ...req.headers,
          'x-platform-generation': String(context.generation), 'x-platform-organisation-id': company.id } };
        const reauthorize = async () => {
          const current = await auth.resolveContext(captured);
          if (current.company.id !== company.id || current.generation !== context.generation || current.sessionKey !== context.sessionKey
            || current.actualUser.id !== context.actualUser.id || current.user.id !== context.user.id)
            throw new PlatformError('Sessionen eller det valda bolaget har ändrats.', 403, 'fleet_simulator_session_changed');
          return current;
        };
        if (await fleetSimulator(req, res, url, { context, repository: await service.applicationApi.getRepository(), reauthorize })) return true;
      }
      if (mobileData(url) && !hasEmployeeSession(req)) throw new PlatformError('Logga in med ditt personalkonto.', 401, 'employee_session_required');
      if (mediaRead) {
        if (!context) {
          const principal = await (await service.applicationApi.getRepository()).read(state => employeeRequestPrincipal(state, req), { domains: ['pricing', 'personnel', 'personnelAuth'] });
          if (!principal) throw new PlatformError('Logga in för att öppna artikelbilder.', 401);
        }
        // A URL can denote another company's file after switching; it must not
        // inherit an old browser/proxy cache even when record IDs collide.
        const writeHead = res.writeHead;
        res.writeHead = function (...args) {
          const fields = args.find(value => value && typeof value === 'object');
          if (fields) fields['Cache-Control'] = 'private, no-store'; else this.setHeader('Cache-Control', 'private, no-store');
          return writeHead.apply(this, args);
        };
      }
      if (mailCallback) {
        if (req.method !== 'GET') throw new PlatformError('Metoden stöds inte.', 405);
        let outcome = 'error';
        try {
          await service.mailService.completeMicrosoft({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error') }, await service.resolveMailContext(req));
          outcome = 'ok';
        } catch {}
        res.writeHead(303, { Location: `/kontor/#/integrations?service=microsoft365&mailAuth=${outcome}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return true;
      }
      if (bankCallback) {
        if (req.method !== 'GET') throw new PlatformError('Metoden stöds inte.', 405);
        const organisationId = company.id;
        const bankContext = bankRequestContext({ req, env, organisationId,
          principal: { actor: context.actualUser, user: context.user },
          trustedPrincipal: { actorId: context.actualUser.id, userId: context.user.id, sessionKey: context.sessionKey, csrfToken: context.csrfToken },
          reauthorize: async () => {
            const current = await auth.resolveContext(req, { writes: false });
            if (current.company.id !== organisationId || current.actualUser.id !== context.actualUser.id || current.user.id !== context.user.id || current.sessionKey !== context.sessionKey)
              throw new PlatformError('Bankgodkännandets session eller bolag har ändrats.', 403, 'bank_session_changed');
            return { actor: current.actualUser, user: current.user };
          } });
        let outcome = 'error';
        try {
          await service.bankService.completeAuthorisation({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error') }, bankContext);
          outcome = 'ok';
        } catch {}
        res.writeHead(303, { Location: `/kontor/integration/systemadminbanktest.html?bankAuth=${outcome}#/integrations/bank-test`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return true;
      }
      if (callback) {
        if (req.method !== 'GET') throw new PlatformError('Metoden stöds inte.', 405);
        const binding = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('jeroc_visma_oauth='));
        let outcome = 'error';
        try { await service.vismaService.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'), cookieBinding: binding && decodeURIComponent(binding.slice('jeroc_visma_oauth='.length)) }); outcome = 'ok'; } catch {}
        res.writeHead(303, { Location: `/kontor/integration/systemadminvismatest.html?vismaOAuth=${outcome}#/integrations/visma-test`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return true;
      }
      if (mobileSupportIdentity(req) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const requestId = randomUUID();
        // Record the real control-plane actor before any business mutation.
        // No payload, password, cookie or token enters this durable audit.
        await repository.transact(state => {
          auth.assertCompanyContext(state, req, context);
          state.audit = state.audit.filter(row => row.action !== 'platform.mobile_support_action' || Date.parse(row.at) > Date.now() - 90 * 86400_000);
          const retained = state.audit.filter(row => row.action === 'platform.mobile_support_action');
          if (retained.length >= 20_000) { const remove = new Set(retained.slice(0, retained.length - 19_999).map(row => row.id)); state.audit = state.audit.filter(row => !remove.has(row.id)); }
          state.audit.push({ id: requestId, requestId, at: new Date().toISOString(), action: 'platform.mobile_support_action',
            actorId: context.actorId, organisationId: company.id, effectiveUserId: context.user.id,
            generation: context.generation, method: req.method, route: url.pathname.slice(0, 200), status: 'attempted' });
        });
        let handled;
        try { handled = await withMobileSupportAuthorization(
          () => repository.read(state => auth.assertCompanyContext(state, req, context)),
          () => service.handle(req, res, url)); }
        finally {
          await repository.transact(state => { const record = state.audit.find(row => row.id === requestId);
            if (record) { record.status = res.writableEnded && res.statusCode >= 200 && res.statusCode < 300 ? 'succeeded' : 'failed'; record.completedAt = new Date().toISOString(); } });
        }
        if (handled) return true;
      } else if (await service.handle(req, res, url)) return true;
      json(res, 404, { error: 'API-vyn finns inte.', code: 'not_found' });
      return true;
      });
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      const known = error instanceof PlatformError || Number.isInteger(error.status);
      json(res, known ? error.status : 503, { error: known ? error.message : 'Bolagets tjänst kunde inte öppnas. Försök igen.', code: known ? error.code ?? 'forbidden' : 'tenant_unavailable' });
    }
    return true;
  };
  api.auth = auth; api.repository = repository; api.bundle = bundle;
  const workerFlights = new Map();
  api.runWorkers = method => {
    if (workerFlights.has(method)) return workerFlights.get(method);
    const operation = (async () => {
      for (const [id, pending] of bundles) {
        const company = await auth.getCompany(id); if (company?.status !== 'active') continue;
        try {
          const service = await pending;
          const workers = method === 'processQueuedPayments' ? [service.swishService, service.bankService]
            : method === 'processQueuedWeighedDocumentEmails' ? [service.weighedDocumentEmailService] : [service.vismaService];
          for (const worker of workers) if (typeof worker?.[method] === 'function') await worker[method]({ reconcile: false });
        } catch { console.warn('En bolagsspecifik integrationskö väntar på nästa kontroll.'); }
      }
    })();
    workerFlights.set(method, operation);
    operation.finally(() => { if (workerFlights.get(method) === operation) workerFlights.delete(method); }).catch(() => {});
    return operation;
  };
  api.close = async () => {
    stopping = true; for (const res of streams) res.end();
    clearInterval(fleetTimer); await platformFleet.close();
    await Promise.allSettled([...bundles.values()].map(async pending => (await pending).close()));
    if (schemaPool) await schemaPool.end(); await repository.close();
  };
  api.selectPage = async (req, res, url) => {
    if (req.method !== 'GET' || !knownPages.has(url.pathname) || ['/kontor','/kontor/'].includes(url.pathname) || !url.searchParams.has('company')) return false;
    try {
      const result = await auth.selectTenant(url.searchParams.get('company'), req);
      const secure = env.RENDER || req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', [`${PLATFORM_TENANT_COOKIE}=${result.tenantToken}; Path=/api; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=28800`,
        'jeroc_platform=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0',
        ...[['jeroc_employee','/api'], ['jeroc_driver','/api/driver'], ['jeroc_customer','/api/customer'], ['jeroc_carrier','/api/carrier'], ['jeroc_terminal_demo_staff','/api/terminal-demo'], ['jeroc_terminal_demo_device','/'], ['jeroc_terminal_demo_device','/api/terminal-demo'], ['jeroc_environment_staff','/api/environment']].map(([name,path]) => `${name}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0`)]);
      url.searchParams.delete('company'); res.writeHead(303, { Location: `${url.pathname}${url.search}${url.hash}`, 'Cache-Control': 'no-store' }); res.end();
    } catch { json(res, 404, { error: 'Bolaget finns inte eller är inte aktivt.' }); }
    return true;
  };
  return api;
}
