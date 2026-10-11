import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';

// Sandbox clients use these same documented hosts. There is deliberately no
// selectable production mode, endpoint, query string or caller supplied header.
export const VISMA_API_BASE = 'https://eaccountingapi.vismaonline.com/v2';
export const VISMA_AUTHORIZATION_URL = 'https://identity.vismaonline.com/connect/authorize';
export const VISMA_TOKEN_URL = 'https://identity.vismaonline.com/connect/token';
export const VISMA_LOCAL_CALLBACK_URI = 'https://localhost:44300/callback';
// These are the scopes granted to the user's registered sandbox client. The
// local operation allowlist still prevents posting invoices or payments.
export const VISMA_SCOPES = Object.freeze(['ea:api', 'offline_access', 'ea:purchase', 'ea:accounting', 'ea:sales']);
export const VISMA_OPERATIONS = Object.freeze([
  { id: 'company', label: 'Företagsinställningar', method: 'GET', path: '/companysettings', write: false },
  { id: 'fiscalYears', label: 'Räkenskapsår', method: 'GET', path: '/fiscalyears', write: false },
  { id: 'accounts', label: 'Kontoplan', method: 'GET', path: '/accounts/{fiscalYearId}', write: false },
  { id: 'paymentTerms', label: 'Betalningsvillkor', method: 'GET', path: '/termsofpayments', write: false },
  { id: 'suppliers', label: 'Leverantörer', method: 'GET', path: '/suppliers', write: false },
  { id: 'supplier', label: 'Hämta leverantör', method: 'GET', path: '/suppliers/{resourceId}', write: false },
  { id: 'draft', label: 'Hämta fakturautkast', method: 'GET', path: '/supplierinvoicedrafts/{resourceId}', write: false },
  { id: 'createSupplier', label: 'Skapa testleverantör', method: 'POST', path: '/suppliers', write: true },
  { id: 'createDraft', label: 'Skapa testfakturautkast', method: 'POST', path: '/supplierinvoicedrafts', write: true },
].map(item => Object.freeze(item)));
const byOperation = new Map(VISMA_OPERATIONS.map(item => [item.id, item]));
const fail = (message, status = 422, code = 'visma_invalid') => { throw new EnvironmentError(message, status, code); };
const uuid = z.string().uuid();
const optionalText = max => z.string().max(max).nullable().optional();
const amount = z.number().finite().refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001, 'Högst två decimaler.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/).nullable().optional();
// This is a documented, conservative subset of SupplierApi. Automation cannot
// be enabled from the sandbox page, even if the provider adds more fields.
const supplier = z.object({
  Name: z.string().min(1).max(50), TermsOfPaymentId: uuid,
  SupplierNumber: optionalText(16), Address1: optionalText(50), Address2: optionalText(50), City: optionalText(50), PostalCode: optionalText(10),
  CountryCode: optionalText(2), CurrencyCode: optionalText(3), CorporateIdentityNumber: optionalText(20), VatNumber: optionalText(20),
  EmailAddress: optionalText(255), Telephone: optionalText(50), MobilePhone: optionalText(50), Note: optionalText(4000),
  ContactPersonEmail: optionalText(255), ContactPersonMobile: optionalText(50), ContactPersonName: optionalText(50), ContactPersonPhone: optionalText(50),
  BankAccountNumber: optionalText(50), Clearing: optionalText(5), BankgiroNumber: optionalText(10), PlusgiroNumber: optionalText(10),
  BankIban: optionalText(50), BankBic: optionalText(50), BankName: optionalText(50), BankCountryCode: optionalText(2),
  IsActive: z.boolean().optional(), UsesPaymentReferenceNumbers: z.boolean().optional(),
  UsesAutomaticSupplierInvoiceApproval: z.literal(false).default(false), UsesAutomaticInvoicePostToLedger: z.literal(false).default(false),
}).strict();
const row = z.object({
  AccountNumber: z.number().int().min(1).max(9999999999), AccountName: optionalText(200),
  DebitAmount: amount.optional(), CreditAmount: amount.optional(), TransactionText: optionalText(100), LineNumber: z.number().int().positive().optional(),
  VatCodeId: uuid.nullable().optional(), CostCenterItemId1: uuid.nullable().optional(), CostCenterItemId2: uuid.nullable().optional(),
  CostCenterItemId3: uuid.nullable().optional(), ProjectId: uuid.nullable().optional(),
}).strict();
const draft = z.object({
  SupplierId: uuid, IsCreditInvoice: z.boolean(), Rows: z.array(row).min(1).max(100),
  InvoiceDate: date, DueDate: date, InvoiceNumber: optionalText(50), TotalAmount: amount.optional(), Vat: amount.optional(),
  VatHigh: amount.optional(), VatMedium: amount.optional(), VatLow: amount.optional(), CurrencyCode: optionalText(3), CurrencyRate: z.number().finite().positive().optional(),
  OcrNumber: optionalText(25), Message: optionalText(25), IsDomestic: z.boolean().optional(),
  // Drafts are never marked paid or submitted to a bank by this tool.
  SkipSendToBank: z.literal(true).default(true),
}).strict();
const inputSchema = z.object({ requestId: uuid, idempotencyKey: z.string().trim().min(1).max(100), operation: z.enum(VISMA_OPERATIONS.map(item => item.id)),
  parameters: z.object({ fiscalYearId: uuid.optional(), resourceId: uuid.optional() }).strict().optional(), payload: z.unknown().optional(),
  source: z.object({ cardId: z.number().int().positive().safe(), approvalId: uuid, version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();

export function parseVismaSandboxInput(value) {
  let size; try { size = Buffer.byteLength(JSON.stringify(value)); } catch { fail('Testunderlaget måste vara JSON.'); }
  if (size > 128 * 1024) fail('Testunderlaget är för stort.', 413, 'payload_too_large');
  const input = inputSchema.safeParse(value);
  if (!input.success) fail('Testunderlaget innehåller okända fält eller fel datatyp.');
  const request = input.data, operation = byOperation.get(request.operation), parameters = request.parameters ?? {};
  if (request.source && !operation.write) fail('Viktkortsreferens används endast för leverantörs- och fakturautkaststest.');
  const expected = request.operation === 'accounts' ? 'fiscalYearId' : ['supplier', 'draft'].includes(request.operation) ? 'resourceId' : null;
  if (Object.keys(parameters).some(key => key !== expected) || expected && !parameters[expected]) fail('Ange endast operationens dokumenterade resursidentifierare.');
  if (operation.write) {
    const payload = (request.operation === 'createSupplier' ? supplier : draft).safeParse(request.payload);
    if (!payload.success) fail('Underlaget innehåller okända, skrivskyddade eller felaktiga Spiris-fält.');
    request.payload = payload.data;
  } else if (request.payload !== undefined) fail('En läsoperation får inte innehålla ett underlag.');
  return request;
}

export function vismaOperationPath(operation, parameters = {}) {
  const descriptor = byOperation.get(operation);
  if (!descriptor) fail('Operationen är inte tillåten.');
  const parameter = operation === 'accounts' ? 'fiscalYearId' : ['supplier', 'draft'].includes(operation) ? 'resourceId' : null;
  if (parameter && !uuid.safeParse(parameters[parameter]).success) fail('Resursidentifieraren måste vara ett UUID.');
  return parameter ? descriptor.path.replace(`{${parameter}}`, parameters[parameter]) : descriptor.path;
}

export function readVismaConfiguration(env = process.env) {
  const mode = env.VISMA_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'disabled';
  const missing = [];
  if (mode === 'disabled') missing.push('VISMA_ENVIRONMENT=sandbox');
  for (const name of ['VISMA_CLIENT_ID', 'VISMA_CLIENT_SECRET', 'VISMA_REDIRECT_URI', 'VISMA_TOKEN_ENCRYPTION_KEY']) if (!env[name]) missing.push(name);
  let redirectUri = null, localCallbackRelay = false;
  if (env.VISMA_REDIRECT_URI) {
    try {
      const uri = new URL(env.VISMA_REDIRECT_URI);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) && env.NODE_ENV !== 'production' && !env.RENDER;
      if (env.VISMA_OAUTH_LOCAL_RELAY === 'true') {
        // Keep the provider-registered URI for both authorization and token
        // exchange. Only its browser response is relayed to our normal callback.
        if (mode !== 'sandbox' || uri.href !== VISMA_LOCAL_CALLBACK_URI) throw new Error();
        localCallbackRelay = true;
      } else if (uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '/api/integrations/visma/oauth/callback' || !(uri.protocol === 'https:' || local && uri.protocol === 'http:')) throw new Error();
      redirectUri = uri.href;
    } catch { missing.push('VISMA_REDIRECT_URI måste vara en fast HTTPS callback-adress.'); }
  }
  if (env.VISMA_TOKEN_ENCRYPTION_KEY && (!/^[A-Za-z0-9+/]{43}=$/.test(env.VISMA_TOKEN_ENCRYPTION_KEY) || Buffer.from(env.VISMA_TOKEN_ENCRYPTION_KEY, 'base64').length !== 32))
    missing.push('VISMA_TOKEN_ENCRYPTION_KEY måste vara 32 byte i base64.');
  const expectedCompanyId = typeof env.VISMA_SANDBOX_COMPANY_ID === 'string' && env.VISMA_SANDBOX_COMPANY_ID.trim() ? env.VISMA_SANDBOX_COMPANY_ID.trim() : null;
  return { mode, configured: mode === 'sandbox' && !missing.length, missing, redirectUri, expectedCompanyId, localCallbackRelay };
}

const sensitiveKey = /(?:access.?token|refresh.?token|id.?token|client.?secret|authorization|password|cookie|code.?verifier|pkce|authorization.?code|private.?key)/i;
export function redactVisma(value, secrets = []) {
  const strings = secrets.filter(secret => typeof secret === 'string' && secret.length >= 4).sort((a, b) => b.length - a.length);
  const clean = (item, depth = 0) => {
    if (depth > 24) return '[TRUNCATED]';
    if (typeof item === 'string') { let result = item; for (const secret of strings) result = result.split(secret).join('[REDACTED]');
      return result.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]').slice(0, 16000); }
    if (Array.isArray(item)) return item.slice(0, 1000).map(part => clean(part, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 1000).map(([key, part]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : clean(part, depth + 1)]));
    return item;
  };
  return clean(value);
}

export function createVismaClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const secrets = new Set([env.VISMA_CLIENT_SECRET]);
  const remember = (...values) => values.forEach(value => { if (typeof value === 'string') secrets.add(value); });
  const redact = value => redactVisma(value, [...secrets]);
  const configured = () => { const config = readVismaConfiguration(env); if (!config.configured) fail('Spiris sandbox är inte färdigkonfigurerad.', 409, 'visma_not_configured'); return config; };
  async function transport(url, options) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    const content = await response.text();
    if (Buffer.byteLength(content) > 256 * 1024) throw new Error('provider_response_too_large');
    let body; try { body = content ? JSON.parse(content) : null; } catch { body = { message: content.slice(0, 16000) }; }
    return { httpStatus: response.status, body };
  }
  async function token(fields, previousRefreshToken) {
    configured(); remember(fields.code, fields.code_verifier, fields.refresh_token);
    let result; try {
      result = await transport(VISMA_TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.VISMA_CLIENT_ID}:${env.VISMA_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString() });
    } catch { fail('OAuth-svaret saknas. Starta en ny anslutning innan du försöker igen.', 502, 'visma_oauth_failed'); }
    const body = result.body;
    if (result.httpStatus < 200 || result.httpStatus >= 300 || !body || typeof body.access_token !== 'string' || !body.access_token ||
      typeof (body.refresh_token ?? previousRefreshToken) !== 'string' || !(body.refresh_token ?? previousRefreshToken) || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0 || Number(body.expires_in) > 2592000)
      fail('OAuth-utbytet misslyckades. Starta en ny anslutning.', 502, 'visma_oauth_failed');
    const tokens = { accessToken: body.access_token, refreshToken: body.refresh_token ?? previousRefreshToken, expiresIn: Number(body.expires_in),
      scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [...VISMA_SCOPES] };
    remember(tokens.accessToken, tokens.refreshToken); return tokens;
  }
  return {
    redact, remember,
    authorizationUrl({ state, verifier }) {
      const config = configured();
      const url = new URL(VISMA_AUTHORIZATION_URL); url.search = new URLSearchParams({ client_id: env.VISMA_CLIENT_ID, redirect_uri: config.redirectUri,
        response_type: 'code', scope: VISMA_SCOPES.join(' '), state, prompt: 'select_account', acr_values: 'service:44643EB1-3F76-4C1C-A672-402AE8085934',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return url.href;
    },
    exchangeCode({ code, verifier }) { return token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: configured().redirectUri }); },
    refreshToken(refreshToken) { return token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken); },
    async request({ operation, parameters, payload, accessToken, trackingId }) {
      configured(); const descriptor = byOperation.get(operation);
      if (!descriptor) fail('Operationen är inte tillåten.');
      const path = vismaOperationPath(operation, parameters);
      const parameter = operation === 'accounts' ? 'fiscalYearId' : ['supplier', 'draft'].includes(operation) ? 'resourceId' : null;
      if (Object.keys(parameters ?? {}).some(key => key !== parameter)) fail('Operationen innehåller okända resursparametrar.');
      if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) fail('En giltig serverlagrad åtkomsttoken krävs.', 409, 'visma_invalid');
      // Validate again at the transport boundary; no service caller can add a
      // hidden body, even if it bypasses the browser input parser.
      if (descriptor.write) payload = parseVismaSandboxInput({ requestId: trackingId, idempotencyKey: trackingId, operation, parameters, payload }).payload;
      else if (payload !== undefined) fail('En läsoperation får inte innehålla ett underlag.');
      remember(accessToken);
      let result; try {
        result = await transport(`${VISMA_API_BASE}${path}`, { method: descriptor.method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
          ...(descriptor.write ? { 'Content-Type': 'application/json' } : {}) }, ...(descriptor.write ? { body: JSON.stringify(payload) } : {}) });
      } catch { return { outcome: 'unknown', httpStatus: null, response: null, error: { code: 'VISMA_UNKNOWN_OUTCOME', message: 'Svar saknas efter avbrott eller timeout. Försöket skickas inte automatiskt igen.' } }; }
      const response = redact(result.body), accepted = result.httpStatus >= 200 && result.httpStatus < 300;
      if (descriptor.write && (result.httpStatus === 408 || result.httpStatus >= 500)) return { outcome: 'unknown', httpStatus: result.httpStatus, response,
        error: { code: 'VISMA_UNKNOWN_OUTCOME', message: 'Spiris gav ett osäkert serversvar. Underlaget kan ha skapats och försöket skickas inte automatiskt igen.' } };
      if (!accepted) return { outcome: 'rejected', httpStatus: result.httpStatus, response,
        error: { code: result.httpStatus === 401 ? 'VISMA_UNAUTHORIZED' : 'VISMA_PROVIDER_REJECTED', message: 'Spiris avvisade testförsöket. Se det redigerade providersvaret.' } };
      if (descriptor.write && !uuid.safeParse(result.body?.Id).success) return { outcome: 'unknown', httpStatus: result.httpStatus, response,
        error: { code: 'VISMA_UNKNOWN_OUTCOME', message: 'Svaret saknar ett verifierbart resurs-ID. Försöket skickas inte automatiskt igen.' } };
      return { outcome: 'accepted', httpStatus: result.httpStatus, response, ...(descriptor.write ? { resourceId: result.body.Id } : {}) };
    },
  };
}
