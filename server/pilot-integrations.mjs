import { PricingError } from './pricing.mjs';

export const PILOT_INTEGRATION_MESSAGE = 'Externa integrationer är inte aktiverade i pilotmiljön. Produktionsanslutningen behöver verifieras separat innan något skickas.';
const disabled = () => ({ mode: 'disabled', configured: false, ready: false, connected: false,
  simulation: false, simulated: false, disabledReason: 'pilot_integration_disabled', deploymentMode: 'pilot' });
const fail = () => { throw Object.assign(new PricingError(PILOT_INTEGRATION_MESSAGE, 403), { code: 'pilot_integration_disabled' }); };
const localMethods = {
  visma: new Set(['initialize', 'status', 'settings', 'run', 'attestedCards', 'prefill', 'exports', 'cardExportProjection', 'swishPaymentBookkeeping', 'cardBookingStatus']),
  swish: new Set(['initialize', 'settings', 'job', 'getCardJobs', 'readVerifiedPayment', 'assertNoManagedPayment']),
  bank: new Set(['initialize', 'settings', 'job', 'getCardJobs', 'readVerifiedPayment', 'assertNoManagedPayment']),
  mail: new Set(['state', 'listMessages']),
};
const workerMethods = new Set(['processQueuedExports', 'processAccountingTracking', 'processSpirisPayments', 'processQueuedPayments']);

function localProjection(name, result) {
  if (!result || typeof result !== 'object') return result;
  if (name === 'cardBookingStatus') return { ...result, status: 'not_configured', canBook: false, canRefresh: false, reason: PILOT_INTEGRATION_MESSAGE };
  if (!['status', 'settings', 'state'].includes(name)) return result;
  const value = { ...result, ...disabled() };
  if (name === 'status') Object.assign(value, { companyVerified: false, missing: [PILOT_INTEGRATION_MESSAGE] });
  if (result.configuration) value.configuration = { ...result.configuration, ...disabled(), missing: [], issues: [PILOT_INTEGRATION_MESSAGE] };
  if (result.settings) value.settings = { ...result.settings, enabled: false, bookkeepingEnabled: false, registerSpirisPayment: false };
  if (result.capabilities) value.capabilities = { ...result.capabilities, canConfigure: false, canExport: false, automationEnabled: false };
  if ('companyVerified' in result) value.companyVerified = false;
  if ('issues' in result) value.issues = [PILOT_INTEGRATION_MESSAGE];
  return value;
}

/** These adapters currently support test providers. A pilot must not dispatch
 * real company records to them, even when credentials or old queued jobs exist.
 * Deny new methods by default so a future provider operation cannot bypass the
 * gate. Local projections retain their existing authorisation checks. */
export function restrictPilotIntegrationService({ env, provider, service }) {
  if (env?.SCRAPPLANNER_DEPLOYMENT_MODE !== 'pilot') return service;
  const allowed = localMethods[provider];
  if (!allowed) throw new TypeError('Okänd pilotintegration.');
  return Object.fromEntries(Object.entries(service).map(([name, method]) => {
    if (typeof method !== 'function') return [name, method];
    if (workerMethods.has(name)) return [name, async () => ({ processed: 0, checked: 0, ...disabled() })];
    // Never freeze sandbox finance settings into a real customer approval.
    if (name === 'financeSettingsForCompany') return [name, async () => null];
    if (name === 'integrationStatus') return [name, async () => ({ ...disabled(), failed: false, missing: [PILOT_INTEGRATION_MESSAGE] })];
    if (allowed.has(name)) return [name, async (...args) => localProjection(name, await method.apply(service, args))];
    // Includes checkAttestBooking (called only by explicit Attest + bokför),
    // OAuth callbacks, provider reads, starts, retries, and payment registration.
    return [name, async () => fail()];
  }));
}

const providerPath = /^\/api\/(?:environment\/(?:visma|swish|bank|payments|nvv)(?:\/|$)|(?:visma|swish|bank|integrations|mail|voice-test|ai-support)(?:\/|$)|public\/voice-test(?:\/|$)|transport\/outbox(?:\/|$))/;
const localReads = new Set([
  '/api/environment/visma/status', '/api/environment/visma/accounting/settings', '/api/environment/visma/accounting/exports',
  '/api/environment/visma/attested-cards', '/api/environment/swish/settings', '/api/environment/bank/settings',
  '/api/environment/nvv/status', '/api/environment/nvv/sandbox', '/api/environment/nvv/diagnostics',
  '/api/mail/state', '/api/mail/messages', '/api/transport/outbox',
]);
const localDetail = /^\/api\/environment\/(?:visma\/accounting\/cards\/\d+\/booking|(?:payments|bank\/payments)\/cards\/\d+|(?:payments|swish\/jobs|bank\/payments)\/[a-fA-F0-9-]{36}|visma\/sandbox\/runs\/[a-fA-F0-9-]{36}|nvv\/(?:sandbox|diagnostics)\/runs\/[a-fA-F0-9-]{36})$/;

/** Route defence also covers NVV, voice and mail, whose network operations can
 * run from their API implementations rather than the payment worker bundle. */
export function handlePilotIntegrationRequest(env, req, res, url) {
  if (env?.SCRAPPLANNER_DEPLOYMENT_MODE !== 'pilot' || !providerPath.test(url.pathname)) return false;
  if (['GET', 'HEAD'].includes(req.method) && (localReads.has(url.pathname) || localDetail.test(url.pathname))) return false;
  res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? '' : JSON.stringify({ error: PILOT_INTEGRATION_MESSAGE, message: PILOT_INTEGRATION_MESSAGE,
    code: 'pilot_integration_disabled', ...disabled() }));
  return true;
}
