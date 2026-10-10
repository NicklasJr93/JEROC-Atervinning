import { createHash } from 'node:crypto';

/** Provider definitions are application code, never supplied by a browser.
 * Adapters and credentials are registered by the server. This module does not
 * connect a provider, send an event, store a secret or invent an OAuth session.
 */
const definitions = [
  { id: 'nvv', name: 'Naturvårdsverket', category: 'environment', description: 'Rapportering av farligt avfall till Avfallsregistret. Testanslutningen hanteras här.', requiredSetup: ['API-anslutning och klientcertifikat', 'Rapporterande organisation'], settings: '/integrations?service=nvv' },
  { id: 'visma', name: 'Spiris / Visma eEkonomi', category: 'accounting', description: 'Planerad överföring av inköpsunderlag och återläsning av bekräftade bokföringsreferenser.', requiredSetup: ['Verifierat inköpsflöde och kontomappning', 'API-avtal och OAuth-anslutning'] },
  { id: 'fortnox', name: 'Fortnox', category: 'accounting', description: 'Planerad koppling för inköpsunderlag, bokföringsreferenser och avstämning.', requiredSetup: ['Verifierat inköpsflöde och kontomappning', 'API-avtal och OAuth-anslutning'] },
  { id: 'microsoft365', name: 'Microsoft 365 / Outlook', category: 'productivity', description: 'Planerad koppling till organisationens e-post och kalender med valda rättigheter.', requiredSetup: ['Microsoft Entra-app', 'Administratörens godkännande av valda rättigheter'] },
  { id: 'bankid', name: 'BankID', category: 'identity', description: 'Planerad identitetsverifiering och signering av kundens aktuella avräkning.', requiredSetup: ['BankID-avtal eller förmedlaravtal', 'Testanslutning och verifierat signeringsflöde'] },
  { id: 'messaging', name: 'SMS och e-post', category: 'messaging', description: 'Planerade kundlänkar och aviseringar med spårbar leveransstatus.', requiredSetup: ['Vald SMS- och e-postleverantör', 'Verifierad avsändare och leveranshantering'] },
  { id: 'google-maps', name: 'Google Maps', category: 'maps', description: 'Planerat adressförslag och kartstöd för kunder och transportplanering.', requiredSetup: ['Google Cloud-projekt och fakturering', 'API-nycklar begränsade till rätt tjänster och domäner'] },
  { id: 'lme', name: 'LME-priser', category: 'market', description: 'Planerad prisdatakälla för LME Cash. Manuella LME-priser används tills dess.', requiredSetup: ['Licensierad prisdataleverantör', 'Avtal och verifierad Cash-prisdatamappning'] },
];
export const integrationProviders = Object.freeze(definitions.map(definition => Object.freeze({ ...definition, requiredSetup: Object.freeze(definition.requiredSetup) })));
const providerById = new Map(integrationProviders.map(provider => [provider.id, provider]));
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,120}$/.test(value);
export class IntegrationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new IntegrationError(message, status); };
const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Callers construct this from authenticated server sessions. In particular,
 * organisationId must not be read from request headers, query or JSON bodies.
 * The membership check is retained here even for the single demo organisation.
 */
function scopedContext(context, manage = false) {
  if (!context || !identifier(context.organisationId) || !identifier(context.actorId) || !identifier(context.effectiveUserId)) fail('En verifierad integrationssession krävs.', 401);
  if (!Array.isArray(context.allowedOrganisationIds) || !context.allowedOrganisationIds.includes(context.organisationId)) fail('Organisationen omfattas inte av sessionen.', 403);
  if (context.canRead !== true || manage && context.canManage !== true) fail('Du saknar behörighet för integrationer.', 403);
  return Object.freeze({ organisationId: context.organisationId, actorId: context.actorId, effectiveUserId: context.effectiveUserId, allowedOrganisationIds: Object.freeze([context.organisationId]), canRead: true, canManage: context.canManage === true });
}
function provider(id) {
  if (!providerById.has(id)) fail('Integrationen finns inte.', 404);
  return providerById.get(id);
}
function statusProjection(raw) {
  const mode = ['disabled', 'mock', 'test', 'production'].includes(raw?.mode) ? raw.mode : 'disabled';
  const configured = mode !== 'disabled' && raw?.configured === true;
  // A simulation never proves a connection to an external service.
  const connected = configured && ['test', 'production'].includes(mode) && raw?.connected === true;
  const failed = !connected && mode !== 'disabled' && raw?.failed === true;
  return { mode, configured, connected, status: mode === 'disabled' ? 'disabled' : connected ? 'connected' : failed ? 'error' : !configured ? 'not-configured' : 'not-verified', ...(validTime(raw?.lastCheckedAt) ? { lastCheckedAt: raw.lastCheckedAt } : {}) };
}

/** Reusable registry façade. There is no shared "current tenant" variable and
 * every adapter call receives a freshly verified, narrowed organisation scope.
 * Adapters implement their own persistent settings/operations in that scope.
 */
export function createIntegrationEngine({ adapters = [], now = () => new Date() } = {}) {
  const registry = new Map();
  for (const adapter of adapters) {
    provider(adapter?.providerId);
    if (registry.has(adapter.providerId) || typeof adapter.status !== 'function' || adapter.check !== undefined && typeof adapter.check !== 'function') fail('Registrera en unik serveradapter med statusfunktion.', 422);
    const supportedEvents = adapter.supportedEvents ?? [];
    if (!Array.isArray(supportedEvents) || supportedEvents.some(type => !identifier(type))) fail('Adapterns händelsetyper är ogiltiga.', 422);
    if (adapter.allowedOrganisationIds !== undefined && (!Array.isArray(adapter.allowedOrganisationIds) || !adapter.allowedOrganisationIds.length || adapter.allowedOrganisationIds.some(id => !identifier(id)))) fail('Adapterns organisationskoppling är ogiltig.', 422);
    registry.set(adapter.providerId, Object.freeze({ ...adapter, ...(adapter.allowedOrganisationIds ? { allowedOrganisationIds: Object.freeze([...new Set(adapter.allowedOrganisationIds)]) } : {}), supportedEvents: Object.freeze([...new Set(supportedEvents)]) }));
  }
  const allowed = (adapter, scope) => !!adapter && (!adapter.allowedOrganisationIds || adapter.allowedOrganisationIds.includes(scope.organisationId));
  async function detail(providerId, context) {
    const scope = scopedContext(context), definition = provider(providerId), adapter = registry.get(providerId);
    let status = { status: 'planned', mode: 'planned', configured: false, connected: false };
    const usable = allowed(adapter, scope);
    if (adapter && !usable) status = { status: 'disabled', mode: 'disabled', configured: false, connected: false };
    else if (adapter) {
      try { status = statusProjection(await adapter.status(scope)); }
      catch { status = { status: 'error', mode: 'disabled', configured: false, connected: false }; }
    }
    return {
      id: definition.id, name: definition.name, description: definition.description, category: definition.category,
      ...status, implemented: !!adapter, requiredSetup: [...definition.requiredSetup],
      capabilities: { canView: true, canConfigure: usable && scope.canManage, canCheck: usable && !!adapter?.check && scope.canManage && status.mode !== 'disabled', canConnect: false },
      links: usable && definition.settings ? { settings: definition.settings } : {},
    };
  }
  return Object.freeze({
    async catalog(context) {
      const scope = scopedContext(context);
      return { version: 1, organisationId: scope.organisationId, providers: await Promise.all(integrationProviders.map(definition => detail(definition.id, scope))), capabilities: { canManage: scope.canManage } };
    },
    detail,
    async check(providerId, context) {
      const scope = scopedContext(context, true);provider(providerId);
      const adapter = registry.get(providerId);
      if (!adapter?.check) fail('Anslutningskontrollen är inte implementerad för denna integration.', 501);
      if (!allowed(adapter, scope)) fail('Integrationsanslutningen tillhör en annan organisation.', 403);
      let current;
      try { current = statusProjection(await adapter.status(scope)); }
      catch { fail('Anslutningsstatusen kunde inte kontrolleras.', 502); }
      if (current.mode === 'disabled') fail('Integrationen är avstängd.', 409);
      // The adapter owns validation and durable check history. Do not expose
      // its raw response, tokens, provider errors or credential fields.
      try { await adapter.check(scope); }
      catch (error) { if (error?.status === 403 || error?.status === 401) fail('Anslutningskontrollen är inte tillåten.', error.status); fail('Anslutningskontrollen kunde inte slutföras.', 502); }
      return detail(providerId, scope);
    },
    prepareEvent(providerId, event, context) {
      const scope = scopedContext(context, true);provider(providerId);
      const adapter = registry.get(providerId);
      if (!adapter || !adapter.supportedEvents.includes(event?.type)) fail('Händelsen saknar en implementerad integrationsadapter.', 501);
      if (!allowed(adapter, scope)) fail('Integrationsanslutningen tillhör en annan organisation.', 403);
      if (!identifier(event.id) || !identifier(event.aggregateId) || !Number.isSafeInteger(event.version) || event.version < 1) fail('Händelsen kräver stabil identitet och version.', 422);
      if (event.organisationId !== undefined && event.organisationId !== scope.organisationId) fail('Händelsen tillhör en annan organisation.', 403);
      const payload = canonical(event.payload);
      if (Buffer.byteLength(payload) > 65536) fail('Integrationshändelsen är för stor.', 413);
      const identity = canonical([scope.organisationId, providerId, event.id, event.type, event.aggregateId, event.version]);
      return {
        organisationId: scope.organisationId, providerId, eventId: event.id, eventType: event.type, aggregateId: event.aggregateId, version: event.version,
        idempotencyKey: `integration-${hash(identity)}`, payloadHash: hash(payload), status: 'prepared', dispatchEnabled: false,
        preparedAt: now().toISOString(), actorId: scope.actorId, effectiveUserId: scope.effectiveUserId,
      };
    },
  });
}

function canonical(value, ancestors = new Set()) {
  if (ancestors.size > 40) fail('Händelsedata är för djupt nästlad.', 422);
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value) || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('Händelsedata ska vara giltig JSON.', 422);
  const next = new Set(ancestors).add(value);
  return Array.isArray(value) ? `[${value.map(item => canonical(item, next)).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], next)}`).join(',')}}`;
}
/** Persistent outbox repositories use this before accepting a repeated key.
 * A key retry with a changed snapshot is a conflict, never another dispatch.
 */
export function assertSamePreparedEvent(previous, next) {
  if (previous?.idempotencyKey !== next?.idempotencyKey || previous?.organisationId !== next?.organisationId || previous?.payloadHash !== next?.payloadHash) fail('Integrationshändelsen finns redan med ett annat underlag.', 409);
  return previous;
}

/** The NVV adapter reuses the existing reporting service. It intentionally
 * exposes neither reporter personal details nor OAuth/certificate material.
 * Production remains disabled in the current NVV implementation.
 */
export function createNvvIntegrationAdapter({ organisationId = 'jeroc-demo', status, check } = {}) {
  if (typeof status !== 'function' || check !== undefined && typeof check !== 'function') fail('NVV:s befintliga statusfunktion krävs.', 422);
  if (!identifier(organisationId)) fail('NVV:s serveranslutning kräver en bestämd organisation.', 422);
  return {
    providerId: 'nvv',
    allowedOrganisationIds: [organisationId],
    async status(context) {
      const current = await status(context);
      const mode = ['disabled', 'mock', 'test'].includes(current?.mode) ? current.mode : 'disabled';
      return { mode, configured: current?.configured === true, connected: mode === 'test' && current?.connected === true,
        failed: current?.lastCheck?.connected === false && !!current?.lastCheck?.error,
        lastCheckedAt: current?.lastCheck?.checkedAt };
    },
    ...(check ? { check: context => check(context) } : {}),
  };
}
