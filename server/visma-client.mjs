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
// The public sandbox allowlist prevents posting invoices or payments. Payment
// bookkeeping has a separate server-only, verified-payout transport below.
export const VISMA_SCOPES = Object.freeze(['ea:api', 'offline_access', 'ea:purchase', 'ea:accounting', 'ea:sales']);
export const VISMA_OPERATIONS = Object.freeze([
  { id: 'company', label: 'Företagsinställningar', method: 'GET', path: '/companysettings', write: false },
  { id: 'fiscalYears', label: 'Räkenskapsår', method: 'GET', path: '/fiscalyears', write: false },
  { id: 'accounts', label: 'Kontoplan', method: 'GET', path: '/accounts/{fiscalYearId}', write: false },
  { id: 'paymentTerms', label: 'Betalningsvillkor', method: 'GET', path: '/termsofpayments', write: false },
  { id: 'vatCodes', label: 'Momskoder', method: 'GET', path: '/vatcodes', write: false },
  { id: 'costCenters', label: 'Resultatenheter', method: 'GET', path: '/costcenters', write: false },
  { id: 'projects', label: 'Projekt', method: 'GET', path: '/projects', write: false },
  { id: 'suppliers', label: 'Leverantörer', method: 'GET', path: '/suppliers', write: false },
  { id: 'supplier', label: 'Hämta leverantör', method: 'GET', path: '/suppliers/{resourceId}', write: false },
  { id: 'draft', label: 'Hämta fakturautkast', method: 'GET', path: '/supplierinvoicedrafts/{resourceId}', write: false },
  { id: 'invoices', label: 'Hämta leverantörsfakturor', method: 'GET', path: '/supplierinvoices', write: false },
  { id: 'invoice', label: 'Hämta bokförd leverantörsfaktura', method: 'GET', path: '/supplierinvoices/{resourceId}', write: false },
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
  parameters: z.object({ fiscalYearId: uuid.optional(), resourceId: uuid.optional(), page: z.number().int().min(1).max(100).optional(),
    pageSize: z.number().int().min(1).max(1000).optional(), useDefaultVatCodes: z.literal(false).optional(), calculateVatOnCostAccounts: z.literal(false).optional() }).strict().optional(), payload: z.unknown().optional(),
  source: z.object({ cardId: z.number().int().positive().safe(), approvalId: uuid, version: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict();

export function parseVismaSandboxInput(value) {
  let size; try { size = Buffer.byteLength(JSON.stringify(value)); } catch { fail('Testunderlaget måste vara JSON.'); }
  if (size > 128 * 1024) fail('Testunderlaget är för stort.', 413, 'payload_too_large');
  const input = inputSchema.safeParse(value);
  if (!input.success) fail('Testunderlaget innehåller okända fält eller fel datatyp.');
  const request = input.data, operation = byOperation.get(request.operation), parameters = request.parameters ?? {};
  if (request.source && !operation.write) fail('Viktkortsreferens används endast för leverantörs- och fakturautkaststest.');
  const expected = request.operation === 'accounts' ? 'fiscalYearId' : ['supplier', 'draft', 'invoice'].includes(request.operation) ? 'resourceId' : null;
  if (Object.keys(parameters).some(key => !allowedParameters(request.operation).includes(key)) || expected && !parameters[expected]) fail('Ange endast operationens dokumenterade resursidentifierare.');
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
  const parameter = operation === 'accounts' ? 'fiscalYearId' : ['supplier', 'draft', 'invoice'].includes(operation) ? 'resourceId' : null;
  if (parameter && !uuid.safeParse(parameters[parameter]).success) fail('Resursidentifieraren måste vara ett UUID.');
  const path = parameter ? descriptor.path.replace(`{${parameter}}`, parameters[parameter]) : descriptor.path;
  if (Object.keys(parameters).some(key => !allowedParameters(operation).includes(key))) fail('Operationen innehåller okända resursparametrar.');
  const query = new URLSearchParams();
  for (const key of ['page', 'pageSize', 'useDefaultVatCodes', 'calculateVatOnCostAccounts']) if (parameters[key] !== undefined) {
    if (['page', 'pageSize'].includes(key) && (!Number.isInteger(parameters[key]) || parameters[key] < 1 || parameters[key] > (key === 'pageSize' ? 1000 : 100)) ||
      !['page', 'pageSize'].includes(key) && parameters[key] !== false) fail('Operationens frågeparametrar är inte giltiga.');
    query.set(key === 'page' ? '$page' : key === 'pageSize' ? '$pagesize' : key, String(parameters[key]));
  }
  return `${path}${query.size ? `?${query}` : ''}`;
}

function allowedParameters(operation) {
  if (operation === 'createDraft') return ['useDefaultVatCodes', 'calculateVatOnCostAccounts'];
  if (['supplier', 'draft', 'invoice'].includes(operation)) return ['resourceId'];
  if (['fiscalYears', 'paymentTerms', 'vatCodes', 'costCenters', 'projects', 'suppliers', 'accounts', 'invoices'].includes(operation))
    return [...(operation === 'accounts' ? ['fiscalYearId'] : []), 'page', 'pageSize'];
  return [];
}

/** Scope comes from the server-owned company runtime, never request JSON. */
export function readVismaOrganisationId(env = process.env) {
  if (env.SCRAPPILOT_ORGANISATION_ID === undefined) return 'jeroc-demo';
  const id = env.SCRAPPILOT_ORGANISATION_ID;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id))
    fail('Spiris-kopplingen saknar en giltig serverägd företagstillhörighet.', 409, 'visma_organisation_invalid');
  return id;
}

/** Both actual and effective principals must be authorised in this company. */
export function canManageVisma(principal) {
  return principal?.level === 'Systemadmin' || principal?.level === 'VD' &&
    Array.isArray(principal.permissions) && ['integrationsRead', 'integrationsManage'].every(right => principal.permissions.includes(right));
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
  const organisationId = readVismaOrganisationId(env);
  // A new SaaS company must never inherit the JEROC environment's provider pin.
  // Its explicit binding is supplied by its own trusted runtime configuration.
  const pinnedCompany = organisationId === 'jeroc-demo' ? env.VISMA_SANDBOX_COMPANY_ID : env.VISMA_TENANT_COMPANY_ID;
  const expectedCompanyId = typeof pinnedCompany === 'string' && pinnedCompany.trim() ? pinnedCompany.trim() : null;
  return { mode, organisationId, configured: mode === 'sandbox' && !missing.length, missing, redirectUri, expectedCompanyId, localCallbackRelay };
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
  async function transport(url, options, responseLimit = 256 * 1024) {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    const content = await response.text();
    // A documented page may contain 1,000 detailed account records. Keep a
    // finite budget without rejecting a normal full account-plan page.
    if (Buffer.byteLength(content) > responseLimit) throw new Error('provider_response_too_large');
    let body; try { body = content ? JSON.parse(content) : null; } catch { body = { message: content.slice(0, 16000) }; }
    return { httpStatus: response.status, body };
  }
  async function token(fields, previousRefreshToken, signal) {
    configured(); remember(fields.code, fields.code_verifier, fields.refresh_token);
    let result; try {
      result = await transport(VISMA_TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.VISMA_CLIENT_ID}:${env.VISMA_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(fields).toString(), signal });
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
    refreshToken(refreshToken, signal) { return token({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken, signal); },
    // Narrow server-only conversion capability. The generic sandbox parser
    // deliberately cannot name this operation or supply an arbitrary body.
    async bookingRequest({ operation, parameters, payload, accessToken, signal }) {
      configured();
      if (payload !== undefined) fail('Bokföring av ett befintligt utkast får inte innehålla ett nytt underlag.', 422);
      if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) fail('En giltig serverlagrad åtkomsttoken krävs.', 409);
      const write = operation === 'convertDraft';
      let path;
      if (['convertDraft', 'draft', 'invoice'].includes(operation)) {
        const parsed = z.object({ resourceId: uuid }).strict().safeParse(parameters);
        if (!parsed.success) fail('Bokföringen saknar en giltig kopplad resurs.', 422);
        path = operation === 'invoice' ? `/supplierinvoices/${parsed.data.resourceId}` : `/supplierinvoicedrafts/${parsed.data.resourceId}${write ? '/convert' : ''}`;
      } else if (operation === 'invoices') path = vismaOperationPath(operation, parameters);
      else fail('Bokföringen innehåller en otillåten operation.', 422);
      remember(accessToken);
      let result;
      try { result = await transport(`${VISMA_API_BASE}${path}`, { method: write ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, signal }, 2 * 1024 * 1024); }
      catch { return { outcome: 'unknown', httpStatus: null, response: null, error: { code: 'visma_booking_unknown', message: 'Bokföringssvaret saknas. Samma utkast skickas inte automatiskt igen.' } }; }
      const response = redact(result.body);
      if (write && (result.httpStatus === 408 || result.httpStatus >= 500)) return { outcome: 'unknown', httpStatus: result.httpStatus, response,
        error: { code: 'visma_booking_unknown', message: 'Spiris gav ett osäkert bokföringssvar. Det befintliga underlaget kontrolleras.' } };
      if (result.httpStatus < 200 || result.httpStatus >= 300) return { outcome: 'rejected', httpStatus: result.httpStatus, response,
        error: { code: 'visma_booking_rejected', message: 'Spiris avvisade bokföringen av utkastet.' } };
      return { outcome: 'accepted', httpStatus: result.httpStatus, response };
    },
    // Never exposed as a sandbox-page operation. Only the private payout
    // bookkeeping batch may use this exact documented subset.
    async paymentRequest({ operation, parameters, payload, accessToken, signal }) {
      configured();
      if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) fail('En giltig serverlagrad åtkomsttoken krävs.', 409);
      const definitions = {
        bankAccounts: { method: 'GET', schema: z.object({ page: z.number().int().min(1).max(100), pageSize: z.number().int().min(1).max(1000) }).strict(), path: p => `/bankaccounts?$page=${p.page}&$pagesize=${p.pageSize}` },
        invoice: { method: 'GET', schema: z.object({ resourceId: uuid }).strict(), path: p => `/supplierinvoices/${p.resourceId}` },
        bankTransaction: { method: 'GET', schema: z.object({ bankAccountId: uuid, bankTransactionId: uuid }).strict(), path: p => `/banktransactions/${p.bankAccountId}/${p.bankTransactionId}` },
        matchedTransactions: { method: 'GET', schema: z.object({ bankAccountId: uuid, fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), page: z.number().int().min(1).max(100), pageSize: z.number().int().min(1).max(1000) }).strict(),
          path: p => `/banktransactions/${p.bankAccountId}/matched?${new URLSearchParams({ fromDate: p.fromDate, toDate: p.toDate, $page: String(p.page), $pagesize: String(p.pageSize) })}` },
        recordPayment: { method: 'POST', schema: z.object({ resourceId: uuid }).strict(), path: p => `/supplierinvoices/${p.resourceId}/payments` },
      };
      const definition = definitions[operation];
      if (!definition || !definition.schema.safeParse(parameters).success) fail('Betalningsbokföringen innehåller en otillåten operation eller resurs.', 422);
      const write = definition.method === 'POST';
      if (write) {
        const parsed = z.object({ CompanyBankAccountId: uuid, PaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          PaymentAmount: amount.refine(value => value > 0), PaymentCurrency: z.literal('SEK'), PaymentType: z.union([z.literal(1), z.literal(2)]), Reference: z.string().min(1).max(100) }).strict().safeParse(payload);
        if (!parsed.success) fail('Betalningsbokföringen innehåller okända eller felaktiga fält.', 422);
        payload = parsed.data;
      } else if (payload !== undefined) fail('En läsoperation får inte innehålla ett underlag.', 422);
      remember(accessToken);
      let result;
      try { result = await transport(`${VISMA_API_BASE}${definition.path(parameters)}`, { method: definition.method,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(write ? { 'Content-Type': 'application/json' } : {}) },
        ...(write ? { body: JSON.stringify(payload) } : {}), signal }, write ? 256 * 1024 : 2 * 1024 * 1024); }
      catch { return { outcome: 'unknown', httpStatus: null, response: null, error: { code: 'VISMA_PAYMENT_UNKNOWN', message: 'Spiris-svaret saknas. Ingen automatisk omsändning av betalningsbokföringen sker.' } }; }
      const response = redact(result.body);
      if (write && (result.httpStatus === 408 || result.httpStatus >= 500)) return { outcome: 'unknown', httpStatus: result.httpStatus, response,
        error: { code: 'VISMA_PAYMENT_UNKNOWN', message: 'Spiris gav ett osäkert svar. Bokföringen kontrolleras före fortsatt arbete.' } };
      if (result.httpStatus < 200 || result.httpStatus >= 300) return { outcome: 'rejected', httpStatus: result.httpStatus, response,
        error: { code: 'VISMA_PAYMENT_REJECTED', message: 'Spiris avvisade betalningsbokföringen.' } };
      return { outcome: 'accepted', httpStatus: result.httpStatus, response };
    },
    async request({ operation, parameters, payload, accessToken, trackingId, signal }) {
      configured(); const descriptor = byOperation.get(operation);
      if (!descriptor) fail('Operationen är inte tillåten.');
      const path = vismaOperationPath(operation, parameters);
      if (Object.keys(parameters ?? {}).some(key => !allowedParameters(operation).includes(key))) fail('Operationen innehåller okända resursparametrar.');
      if (typeof accessToken !== 'string' || !accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken)) fail('En giltig serverlagrad åtkomsttoken krävs.', 409, 'visma_invalid');
      // Validate again at the transport boundary; no service caller can add a
      // hidden body, even if it bypasses the browser input parser.
      if (descriptor.write) payload = parseVismaSandboxInput({ requestId: trackingId, idempotencyKey: trackingId, operation, parameters, payload }).payload;
      else if (payload !== undefined) fail('En läsoperation får inte innehålla ett underlag.');
      remember(accessToken);
      let result; try {
        result = await transport(`${VISMA_API_BASE}${path}`, { method: descriptor.method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
          ...(descriptor.write ? { 'Content-Type': 'application/json' } : {}) }, ...(descriptor.write ? { body: JSON.stringify(payload) } : {}), signal }, descriptor.write ? 256 * 1024 : 2 * 1024 * 1024);
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
