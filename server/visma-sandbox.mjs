import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { EnvironmentError } from './environment-storage.mjs';
import { createVismaClient, parseVismaSandboxInput, readVismaConfiguration, VISMA_OPERATIONS, VISMA_SCOPES, vismaOperationPath } from './visma-client.mjs';
import { createVismaExports } from './visma-export.mjs';
import { latestAttestedVismaCards, attestedVismaSummary, attestedVismaPrefill } from './visma-weightcard.mjs';

const DOMAIN = 'vismaIntegration', OAUTH_LIFETIME = 10 * 60 * 1000, RUN_LIFETIME = 120000, REFRESH_LIFETIME = 45000;
const copy = value => structuredClone(value);
const fail = (message, status = 422, code = 'visma_invalid') => { throw new EnvironmentError(message, status, code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const matchHash = (value, expected) => typeof value === 'string' && typeof expected === 'string' && expected.length === 64 && timingSafeEqual(Buffer.from(hash(value)), Buffer.from(expected));
const initialTenant = () => ({ version: 1, generation: randomUUID(), tokens: null, pending: null, refreshLease: null, company: null, companyVerified: false, runs: [], audit: [] });
const binding = context => hash([context.organisationId, context.actorId, context.effectiveUserId, context.sessionKey]);
function scoped(context, requireAdmin = true) {
  // The application currently has one server-derived organisation. This value
  // never comes from request JSON and is also enforced for catalog projections.
  if (context?.organisationId !== 'jeroc-demo') fail('Integrationen tillhör en annan organisation.', 403, 'forbidden');
  if (!requireAdmin) return;
  if (!context.sessionKey || !context.actorId || !context.effectiveUserId || context.actor?.id !== context.actorId || context.user?.id !== context.effectiveUserId ||
    context.actor?.level !== 'Systemadmin' || context.user?.level !== 'Systemadmin')
    fail('Testverktyget kräver att systemadmin arbetar som systemadmin.', 403, 'forbidden');
  if (Array.isArray(context.actor.siteIds) || Array.isArray(context.user.siteIds)) fail('Testverktyget kräver åtkomst till alla anläggningar.', 403, 'site_forbidden');
}
function publicRun(run, time) {
  const result = Object.fromEntries(['id', 'status', 'operation', 'method', 'path', 'parameters', 'payload', 'source', 'startedAt', 'finishedAt', 'httpStatus', 'response', 'error', 'trackingId', 'resourceId']
    .filter(key => run[key] !== undefined).map(key => [key, copy(run[key])]));
  if (run.status === 'in_flight' && time.getTime() >= Date.parse(run.leaseUntil)) Object.assign(result, { status: 'unknown', error: { code: 'VISMA_UNKNOWN_OUTCOME',
    message: 'Svaret saknas efter avbrott eller timeout. Försöket kan ha nått Spiris och skickas inte automatiskt igen.' } });
  return result;
}
const companyFrom = response => response && typeof response.CompanyIdentifier === 'string' && response.CompanyIdentifier.trim()
  ? { id: response.CompanyIdentifier, name: typeof response.Name === 'string' ? response.Name.slice(0, 100) : '',
    number: typeof response.CorporateIdentityNumber === 'string' ? response.CorporateIdentityNumber.slice(0, 100) : '' } : null;

/** OAuth and test runs live in a separate ApplicationRepository domain. All
 * transactions are short; provider calls happen after the reservation commits. */
export function createVismaSandbox({ getRepository, sourceProvider = async () => [], sitesProvider = async () => [], authorizeContext = async () => {}, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  if (typeof getRepository !== 'function') throw new TypeError('getRepository krävs.');
  const client = createVismaClient({ env, fetchImpl });
  const clock = () => new Date(now());
  const config = () => readVismaConfiguration(env);
  const ready = () => { const result = config(); if (!result.configured) fail('Spiris sandbox är inte färdigkonfigurerad.', 409, 'visma_not_configured'); return result; };
  async function prefill(cardId, context) {
    scoped(context);
    const approval = latestAttestedVismaCards(await sourceProvider()).find(item => String(item.cardId) === String(cardId));
    if (!approval) fail('Kortets aktuella version måste vara kundgodkänd och internt attesterad.', 409, 'visma_source_unattested');
    return attestedVismaPrefill(approval);
  }
  async function assertCurrentSource(reference, context) {
    const approval = latestAttestedVismaCards(await sourceProvider()).find(item => String(item.cardId) === String(reference.cardId));
    if (!approval) fail('Kortets aktuella version måste vara kundgodkänd och internt attesterad.', 409, 'visma_source_unattested');
    const current = { approvalId: approval.id, version: approval.version, hash: approval.snapshot.hash };
    if (current.approvalId !== reference.approvalId || current.version !== reference.version || current.hash !== reference.hash)
      fail('Viktkortets attestversion har ändrats. Hämta kortets uppgifter på nytt.', 409, 'visma_source_changed');
  }
  function encrypt(value, aad) {
    ready(); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(env.VISMA_TOKEN_ENCRYPTION_KEY, 'base64'), iv);
    cipher.setAAD(Buffer.from(aad)); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  function decrypt(value, aad) {
    try {
      ready(); if (value?.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(env.VISMA_TOKEN_ENCRYPTION_KEY, 'base64'), Buffer.from(value.iv, 'base64'));
      decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
    } catch { fail('Den sparade anslutningen kan inte dekrypteras. Anslut på nytt.', 409, 'visma_credentials_unavailable'); }
  }
  const tokenAAD = (organisationId, generation) => `${organisationId}:tokens:${generation}`;
  const pendingAAD = (organisationId, pending, kind) => `${organisationId}:oauth:${pending.id}:${kind}`;
  const read = async operation => (await getRepository()).read(state => operation(state[DOMAIN] ?? { version: 1, tenants: {} }), { domains: [DOMAIN] });
  async function transact(operation) {
    const repo = await getRepository();
    // Use only the integration domain lock in PostgreSQL. The application's
    // business aggregate revision/lock is not involved in OAuth or test runs.
    if (repo.kind === 'postgresql') return repo.runInTransaction(async connection => {
      await connection.query('SELECT pg_advisory_xact_lock(1860399453)');
      const row = (await connection.query('SELECT document FROM jeroc_application_documents WHERE domain=$1 FOR UPDATE', [DOMAIN])).rows[0];
      const state = row?.document ?? { version: 1, tenants: {} }, before = row ? JSON.stringify(state) : null, result = await operation(state), after = JSON.stringify(state);
      if (after !== before) await connection.query('INSERT INTO jeroc_application_documents(domain,document) VALUES($1,$2::jsonb) ON CONFLICT(domain) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()', [DOMAIN, after]);
      return result;
    });
    return repo.transact(state => { state[DOMAIN] ??= { version: 1, tenants: {} }; return operation(state[DOMAIN]); });
  }
  const tenantFor = (state, organisationId, create = false) => create ? state.tenants[organisationId] ??= initialTenant() : state.tenants[organisationId] ?? initialTenant();
  function audit(tenant, context, action, details = {}) {
    tenant.audit.push({ id: randomUUID(), at: clock().toISOString(), actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, action, ...details });
    tenant.audit = tenant.audit.slice(-500);
  }
  function verified(tenant, configuration) { return Boolean(tenant.tokens && configuration.expectedCompanyId && tenant.companyVerified && tenant.company?.id === configuration.expectedCompanyId); }
  function requireCompany(tenant, configuration) {
    if (!tenant.tokens) fail('Anslut Spiris sandbox först.', 409, 'visma_not_connected');
    if (!configuration.expectedCompanyId) fail('VISMA_SANDBOX_COMPANY_ID måste anges innan denna operation kan köras.', 409, 'visma_company_unverified');
    if (!verified(tenant, configuration)) fail('Anslutningen har inte verifierats mot det förväntade sandboxföretaget.', 409,
      tenant.company?.id && tenant.company.id !== configuration.expectedCompanyId ? 'visma_company_mismatch' : 'visma_company_unverified');
  }
  function statusDTO(tenant) {
    const configuration = config(), companyVerified = configuration.configured && verified(tenant, configuration), missing = [...configuration.missing];
    if (!configuration.expectedCompanyId) missing.push('VISMA_SANDBOX_COMPANY_ID');
    if (tenant.tokens && !companyVerified && configuration.expectedCompanyId) missing.push(tenant.company?.id && tenant.company.id !== configuration.expectedCompanyId
      ? 'Anslutet företag skiljer sig från VISMA_SANDBOX_COMPANY_ID.' : 'Sandboxföretaget måste verifieras.');
    return { mode: configuration.mode, configured: configuration.configured, connected: Boolean(configuration.configured && companyVerified), companyVerified,
      expectedCompanyId: configuration.expectedCompanyId, company: copy(tenant.company), missing, scopes: [...VISMA_SCOPES], redirectUri: configuration.redirectUri,
      localCallbackRelay: configuration.localCallbackRelay,
      operations: VISMA_OPERATIONS.map(item => ({ ...item })), templates: {
        createSupplier: { Name: 'JEROC syntetisk testleverantör', TermsOfPaymentId: '00000000-0000-4000-8000-000000000000', CountryCode: 'SE', CurrencyCode: 'SEK', IsActive: true,
          UsesAutomaticSupplierInvoiceApproval: false, UsesAutomaticInvoicePostToLedger: false },
        createDraft: { SupplierId: '00000000-0000-4000-8000-000000000000', IsCreditInvoice: false, InvoiceDate: clock().toISOString().slice(0, 10),
          InvoiceNumber: 'JEROC-SANDBOX', TotalAmount: 10, Vat: 0, CurrencyCode: 'SEK', SkipSendToBank: true,
          Rows: [{ AccountNumber: 4000, DebitAmount: 10, CreditAmount: 0, TransactionText: 'Syntetiskt sandboxutkast' }] },
      }, runs: tenant.runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50).map(run => publicRun(run, clock())) };
  }
  async function access(context, generation) {
    const deadline = Date.now() + REFRESH_LIFETIME;
    while (true) {
      const decision = await transact(state => {
        const tenant = tenantFor(state, context.organisationId, true);
        if (tenant.generation !== generation || !tenant.tokens) fail('Anslutningen har ändrats. Anslut på nytt.', 409, 'visma_not_connected');
        const tokens = decrypt(tenant.tokens, tokenAAD(context.organisationId, generation));
        client.remember(tokens.accessToken, tokens.refreshToken);
        if (Date.parse(tokens.expiresAt) > clock().getTime() + 60000) return { tokens };
        if (tenant.refreshLease) {
          if (clock().getTime() >= Date.parse(tenant.refreshLease.expiresAt)) {
            // A lost refresh response might already have rotated the credential.
            // Reusing it is unsafe, so recovery requires a new OAuth connection.
            tenant.tokens = null; tenant.companyVerified = false; tenant.refreshLease = null; tenant.lastError = 'visma_refresh_unknown';
            return { lost: true };
          }
          return { wait: true };
        }
        const lease = { id: randomUUID(), expiresAt: new Date(clock().getTime() + REFRESH_LIFETIME).toISOString() };
        tenant.refreshLease = lease; return { lease, tokens };
      });
      if (decision.lost) fail('Tokenförnyelsens svar saknas. Anslut på nytt.', 409, 'visma_refresh_unknown');
      if (decision.wait) {
        if (Date.now() >= deadline) fail('Tokenförnyelse pågår. Försöket skickades inte.', 409, 'visma_refresh_busy');
        await pause(30); continue;
      }
      if (!decision.lease) return decision.tokens.accessToken;
      let refreshed;
      try { refreshed = await client.refreshToken(decision.tokens.refreshToken); }
      catch {
        await transact(state => { const tenant = tenantFor(state, context.organisationId, true);
          if (tenant.generation === generation && tenant.refreshLease?.id === decision.lease.id) {
            tenant.tokens = null; tenant.refreshLease = null; tenant.companyVerified = false; tenant.lastError = 'visma_refresh_failed';
          } });
        fail('Tokenförnyelsen misslyckades. Anslut på nytt.', 409, 'visma_refresh_failed');
      }
      return transact(state => {
        const tenant = tenantFor(state, context.organisationId, true);
        if (tenant.generation !== generation || tenant.refreshLease?.id !== decision.lease.id || !tenant.tokens)
          fail('Anslutningen har ändrats under tokenförnyelsen.', 409, 'visma_not_connected');
        const tokens = { ...refreshed, expiresAt: new Date(clock().getTime() + refreshed.expiresIn * 1000).toISOString() };
        tenant.tokens = encrypt(tokens, tokenAAD(context.organisationId, generation)); tenant.refreshLease = null; tenant.lastError = null;
        audit(tenant, context, 'visma.token_refreshed'); return tokens.accessToken;
      });
    }
  }
  async function checkCompany(context, generation, accessToken, trackingId) {
    const result = await client.request({ operation: 'company', accessToken, trackingId });
    const company = result.outcome === 'accepted' ? companyFrom(result.response) : null;
    const configuration = ready();
    await transact(state => {
      const tenant = tenantFor(state, context.organisationId, true);
      if (tenant.generation !== generation) fail('Anslutningen har ändrats under testförsöket.', 409, 'visma_not_connected');
      tenant.lastCheckedAt = clock().toISOString();
      if (result.outcome === 'accepted') tenant.company = company;
      tenant.companyVerified = Boolean(company && configuration.expectedCompanyId && company.id === configuration.expectedCompanyId);
      tenant.lastError = tenant.companyVerified ? null : 'visma_company_unverified';
    });
    return { result, company };
  }
  function existing(tenant, request, context, scopeKey) {
    const keyHash = hash(scopeKey ? [context.organisationId, 'export', scopeKey, request.idempotencyKey] : [context.organisationId, context.actorId, context.effectiveUserId, request.idempotencyKey]);
    const requestHash = hash({ operation: request.operation, parameters: request.parameters ?? {}, payload: request.payload ?? null,
      ...(request.source ? { source: request.source } : {}) });
    const prior = tenant.runs.find(item => item.id === request.requestId || item.keyHash === keyHash);
    if (prior && (prior.id !== request.requestId || prior.keyHash !== keyHash || prior.requestHash !== requestHash))
      fail('Samma testförsök innehåller andra uppgifter. Skapa ett nytt testförsök.', 409, 'idempotency_conflict');
    return { prior, keyHash, requestHash };
  }
  const workerCapability = Object.freeze({});
  let finance;
  async function dispatch(value, context, capability, scopeKey) {
      const checkAuthorization = async () => {
        if (capability === workerCapability) await finance.assertWorkerAuthorization(context);
        else { scoped(context); await authorizeContext(context); }
        if (scopeKey) await finance.assertExportAuthorization(context, capability === workerCapability, scopeKey);
      };
      await checkAuthorization(); const request = parseVismaSandboxInput(value);
      const prior = await read(state => existing(tenantFor(state, context.organisationId), request, context, scopeKey).prior);
      if (prior) return publicRun(prior, clock());
      if (request.source) await assertCurrentSource(request.source, context);
      const configuration = ready(), descriptor = VISMA_OPERATIONS.find(item => item.id === request.operation);
      const reservation = await transact(document => {
        const tenant = tenantFor(document, context.organisationId, true), match = existing(tenant, request, context, scopeKey);
        if (match.prior) return { prior: publicRun(match.prior, clock()) };
        if (request.operation !== 'company') requireCompany(tenant, configuration);
        else if (!tenant.tokens) fail('Anslut Spiris sandbox först.', 409, 'visma_not_connected');
        const run = { id: request.requestId, keyHash: match.keyHash, requestHash: match.requestHash, status: 'in_flight', operation: request.operation, method: descriptor.method,
          path: vismaOperationPath(request.operation, request.parameters), ...(request.parameters === undefined ? {} : { parameters: copy(request.parameters) }),
          ...(request.payload === undefined ? {} : { payload: copy(request.payload) }),
          ...(request.source === undefined ? {} : { source: copy(request.source) }),
          startedAt: clock().toISOString(), leaseUntil: new Date(clock().getTime() + RUN_LIFETIME).toISOString(), trackingId: randomUUID(), httpStatus: null, response: null,
          actualUserId: context.actorId, effectiveUserId: context.effectiveUserId, generation: tenant.generation };
        tenant.runs.push(run); audit(tenant, context, 'visma.sandbox_reserved', { runId: run.id, trackingId: run.trackingId }); return { run: copy(run) };
      });
      if (reservation.prior) return reservation.prior;
      let result, dispatched = false;
      try {
        const accessToken = await access(context, reservation.run.generation);
        if (request.operation === 'company') {
          dispatched = true; result = (await checkCompany(context, reservation.run.generation, accessToken, reservation.run.trackingId)).result;
        } else {
          const check = await checkCompany(context, reservation.run.generation, accessToken, reservation.run.trackingId);
          if (check.result.outcome !== 'accepted' || !check.company) fail('Sandboxföretaget kunde inte verifieras före operationen.', 409, 'visma_company_unverified');
          if (check.company.id !== ready().expectedCompanyId) fail('Anslutningen tillhör ett annat företag. Inget underlag skickades.', 409, 'visma_company_mismatch');
          // Recheck the durable generation after refresh/company validation so
          // a completed disconnect prevents dispatch through stale credentials.
          await read(state => { const tenant = tenantFor(state, context.organisationId); if (tenant.generation !== reservation.run.generation) fail('Anslutningen har ändrats.', 409, 'visma_not_connected'); requireCompany(tenant, ready()); });
          if (request.source) await assertCurrentSource(request.source, context);
          await checkAuthorization();
          dispatched = true; result = await client.request({ operation: request.operation, parameters: request.parameters, payload: reservation.run.payload, accessToken, trackingId: reservation.run.trackingId });
        }
      } catch (error) { result = { outcome: dispatched ? 'unknown' : 'rejected', httpStatus: null, response: null,
        error: { code: error instanceof EnvironmentError ? error.code : 'VISMA_UNKNOWN_OUTCOME', message: error instanceof EnvironmentError ? error.message : 'Svaret saknas. Försöket skickas inte automatiskt igen.' } }; }
      return transact(document => {
        const tenant = tenantFor(document, context.organisationId, true), run = tenant.runs.find(item => item.id === reservation.run.id);
        if (!run || run.requestHash !== reservation.run.requestHash) fail('Testförsökets beständiga reservation saknas.', 409, 'reservation_missing');
        if (run.status !== 'in_flight') return publicRun(run, clock());
        const status = ['accepted', 'rejected', 'unknown'].includes(result?.outcome) ? result.outcome : 'unknown';
        Object.assign(run, { status, finishedAt: clock().toISOString(), httpStatus: result?.httpStatus ?? null, response: client.redact(result?.response ?? null) });
        if (result.error) run.error = client.redact(result.error);
        if (result.resourceId) run.resourceId = result.resourceId;
        audit(tenant, context, `visma.sandbox_${status}`, { runId: run.id, trackingId: run.trackingId }); return publicRun(run, clock());
      });

  }
  const service = {
    async integrationStatus(context) {
      scoped(context, false); return read(state => { const tenant = tenantFor(state, context.organisationId), configuration = config();
        return { mode: configuration.mode === 'sandbox' ? 'test' : 'disabled', configured: configuration.configured, connected: Boolean(configuration.configured && verified(tenant, configuration)),
          failed: Boolean(tenant.lastError), lastCheckedAt: tenant.lastCheckedAt ?? null }; });
    },
    async status(context) { scoped(context); return read(state => statusDTO(tenantFor(state, context.organisationId))); },
    async attestedCards(context) { scoped(context); return { cards: latestAttestedVismaCards(await sourceProvider()).map(attestedVismaSummary) }; },
    prefill,
    async begin(context) {
      scoped(context); await authorizeContext(context); ready(); const state = randomBytes(32).toString('base64url'), cookieBinding = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
      const expiresAt = new Date(clock().getTime() + OAUTH_LIFETIME).toISOString();
      await transact(document => { const tenant = tenantFor(document, context.organisationId, true), pending = {
        id: randomUUID(), stateHash: hash(state), cookieHash: hash(cookieBinding), contextHash: binding(context), expiresAt, used: false,
        actualUserId: context.actorId, effectiveUserId: context.effectiveUserId,
      };
        pending.verifier = encrypt(verifier, pendingAAD(context.organisationId, pending, 'verifier')); tenant.pending = pending;
        audit(tenant, context, 'visma.oauth_started'); });
      return { authorizationUrl: client.authorizationUrl({ state, verifier }), cookieBinding, expiresAt };
    },
    async callback({ state, code, error, cookieBinding } = {}) {
      ready();
      code ??= undefined; error ??= undefined;
      if (typeof state !== 'string' || state.length > 200 || typeof cookieBinding !== 'string' || cookieBinding.length > 200 ||
        typeof error !== 'undefined' && typeof error !== 'string' || !error && (typeof code !== 'string' || !code || code.length > 4096))
        fail('OAuth-svaret är inte giltigt.', 400, 'visma_oauth_state_invalid');
      const result = await transact(document => {
        const entry = Object.entries(document.tenants).find(([, tenant]) => matchHash(state, tenant.pending?.stateHash));
        const pending = entry?.[1].pending;
        if (!pending || pending.used || clock().getTime() >= Date.parse(pending.expiresAt) || !matchHash(cookieBinding, pending.cookieHash))
          fail('OAuth-svaret har fel browserbindning, har löpt ut eller har redan använts.', 400, 'visma_oauth_state_invalid');
        pending.used = true;
        if (error) { entry[1].pending = null; return { denied: true }; }
        pending.code = encrypt(code, pendingAAD(entry[0], pending, 'code')); client.remember(code, cookieBinding);
        return { completed: true };
      });
      if (result.denied) fail('OAuth-anslutningen godkändes inte.', 400, 'visma_oauth_denied');
      return result;
    },
    async complete(context) {
      scoped(context); await authorizeContext(context); ready();
      const reservation = await transact(document => {
        const tenant = tenantFor(document, context.organisationId, true), pending = tenant.pending;
        if (!pending?.used || !pending.code || pending.contextHash !== binding(context) || clock().getTime() >= Date.parse(pending.expiresAt))
          fail('OAuth-utbytet måste slutföras i samma aktiva adminsession innan det löper ut.', 409, 'visma_oauth_pending_missing');
        const code = decrypt(pending.code, pendingAAD(context.organisationId, pending, 'code')), verifier = decrypt(pending.verifier, pendingAAD(context.organisationId, pending, 'verifier'));
        tenant.pending = null; tenant.tokens = null; tenant.companyVerified = false; tenant.refreshLease = null; tenant.generation = randomUUID();
        audit(tenant, context, 'visma.oauth_exchange_reserved'); return { code, verifier, generation: tenant.generation };
      });
      let tokens, companyResult;
      try { await authorizeContext(context); tokens = await client.exchangeCode(reservation); companyResult = await client.request({ operation: 'company', accessToken: tokens.accessToken, trackingId: randomUUID() }); }
      catch (error) {
        await transact(document => { const tenant = tenantFor(document, context.organisationId, true); if (tenant.generation === reservation.generation) tenant.lastError = 'visma_oauth_failed'; });
        if (error instanceof EnvironmentError) throw error;
        fail('OAuth-utbytet misslyckades. Starta en ny anslutning.', 502, 'visma_oauth_failed');
      }
      const company = companyResult.outcome === 'accepted' ? companyFrom(companyResult.response) : null;
      return transact(document => {
        const tenant = tenantFor(document, context.organisationId, true);
        if (tenant.generation !== reservation.generation) fail('Anslutningen har kopplats bort eller ändrats.', 409, 'visma_not_connected');
        const configuration = ready();
        tenant.tokens = encrypt({ ...tokens, expiresAt: new Date(clock().getTime() + tokens.expiresIn * 1000).toISOString() }, tokenAAD(context.organisationId, tenant.generation));
        tenant.company = company; tenant.companyVerified = Boolean(company && configuration.expectedCompanyId && company.id === configuration.expectedCompanyId);
        tenant.lastError = tenant.companyVerified ? null : 'visma_company_unverified'; tenant.lastCheckedAt = clock().toISOString();
        audit(tenant, context, 'visma.oauth_connected', { companyVerified: tenant.companyVerified }); return statusDTO(tenant);
      });
    },
    async disconnect(context) {
      scoped(context); await authorizeContext(context); return transact(document => { const tenant = tenantFor(document, context.organisationId, true);
        tenant.generation = randomUUID(); tenant.tokens = null; tenant.pending = null; tenant.refreshLease = null; tenant.company = null; tenant.companyVerified = false; tenant.lastError = null;
        audit(tenant, context, 'visma.disconnected'); return statusDTO(tenant); });
    },
    async run(id, context) {
      scoped(context); return read(state => { const run = tenantFor(state, context.organisationId).runs.find(item => item.id === id);
        if (!run) fail('Testförsöket finns inte.', 404, 'not_found'); return publicRun(run, clock()); });
    },
    send: (value, context) => dispatch(value, context),
  };
  finance = createVismaExports({ read, transact, tenantFor, scoped, audit, clock, config, sourceProvider, sitesProvider, authorizeContext,
    send: (request, context, worker, scopeKey) => dispatch(request, context, worker ? workerCapability : undefined, scopeKey),
    connection: () => read(state => { const tenant = tenantFor(state, 'jeroc-demo'); return { company: copy(tenant.company), companyVerified: verified(tenant, config()) }; }),
  });
  return Object.assign(service, finance.publicMethods);
}
