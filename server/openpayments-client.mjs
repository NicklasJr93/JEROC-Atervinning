import { randomUUID, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

// Contracts verified against current docs and openapi YAML:
// https://docs.openpayments.io/docs/{api,sandbox,quickstart_pis,quickstart_ais,authorisations}.md
export const OPENPAYMENTS_SANDBOX_API = 'https://api.sandbox.openbankingplatform.com';
export const OPENPAYMENTS_SANDBOX_OAUTH = 'https://oauth.sandbox.openbankingplatform.com';
const corporateScope = 'accountinformation paymentinitiation corporate';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const bic = /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/;
const sensitiveField = /secret|password|authorization|cookie|certificate|private.?key|access.?token|refresh.?token|signature|^(?:code|state|psu.?id|corporate.?id)$/i;
const accountField = /^(?:iban|bban|clearing(?:number)?|account(?:number)?|giroNumber|bankgiro|plusgiro|bankgiroNumber|plusgiroNumber|msisdn|ssn|phone|personalidentitynumber)$/i;

/** Safe for browser journals. Raw API data is returned separately to the private
 * engine so that it can compare the actual amount/account before accepting ACSC. */
export function safeOpenPaymentsData(value, depth = 0, secrets = []) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[redacted]');
    return result.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[redacted]')
      .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b|\b\d{6,8}[-+]\d{4}\b|\b\d{10,15}\b/g, '[redacted]').slice(0, 4000);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeOpenPaymentsData(item, depth + 1, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key,
    sensitiveField.test(key) ? '[redacted]' : accountField.test(key) ? (item ? `••••${String(item).slice(-4)}` : null) : safeOpenPaymentsData(item, depth + 1, secrets)]));
  return value ?? null;
}

const errorResult = (code, message, extra = {}) => ({ ok: false, environment: 'sandbox', statusCode: null, uncertain: false,
  data: null, error: { code, message, providerCodes: [] }, ...extra });
const validIban = value => {
  if (typeof value !== 'string' || !/^SE\d{22}$/.test(value)) return false;
  const expanded = `${value.slice(4)}${value.slice(0, 4)}`.replace(/[A-Z]/g, character => String(character.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
};
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const amount = z.object({ currency: z.literal('SEK'), amount: z.string().regex(/^(?:0|[1-9]\d{0,11})\.\d{2}$/)
  .refine(value => Number(value) > 0 && Number.isSafeInteger(Math.round(Number(value) * 100))) }).strict();
const legacyAccount = z.object({ iban: z.string().refine(validIban).optional(), bban: z.string().regex(/^[A-Za-z0-9]{1,30}$/).optional(),
  clearingNumber: z.string().regex(/^\d{4,5}$/).optional(), accountNumber: z.string().regex(/^\d{4,15}$/).optional(), currency: z.literal('SEK').optional() }).strict()
  .refine(value => Number(Boolean(value.iban)) + Number(Boolean(value.bban)) + Number(Boolean(value.clearingNumber && value.accountNumber)) === 1)
  .refine(value => Boolean(value.clearingNumber) === Boolean(value.accountNumber));
const pisAccount = z.object({ iban: z.string().refine(validIban).optional(), bban: z.string().regex(/^[A-Za-z0-9]{1,30}$/).optional(),
  currency: z.literal('SEK').optional() }).strict().refine(value => Number(Boolean(value.iban)) + Number(Boolean(value.bban)) === 1);
const paymentBase = { instructedAmount: amount, creditorName: z.string().trim().min(1).max(70),
  requestedExecutionDate: dateString.optional(), endToEndIdentification: z.string().min(1).max(35).optional() };
const domesticSchema = account => z.object({ ...paymentBase, debtorAccount: account, creditorAccount: account,
  remittanceInformationUnstructured: z.string().min(1).max(140).optional() }).strict();
const giroSchema = account => z.object({ ...paymentBase, debtorAccount: account,
  creditorGiro: z.object({ giroNumber: z.string().regex(/^\d{5,10}$/), giroType: z.enum(['BANKGIRO', 'PLUSGIRO']) }).strict(),
  invoiceRef: z.string().min(1).max(25).optional(), ocrRef: z.string().regex(/^\d{2,25}$/).optional() }).strict();
const domestic = domesticSchema(pisAccount), giro = giroSchema(pisAccount);
const legacyDomestic = domesticSchema(legacyAccount), legacyGiro = giroSchema(legacyAccount);
const incompleteSwedbankClearing = recipient => /^8\d{3}$/.test(recipient?.clearing ?? '');

/** National Swedish account references preserve every supplied digit, including
 * Swedbank's fifth clearing digit. No padding or IBAN conversion is inferred.
 * Version 1 exists only to reconstruct previously frozen payment instructions. */
export function bankPaymentCreditorAccount(recipient, payloadVersion = 2) {
  if (payloadVersion !== 1 && payloadVersion !== 2) return null;
  const type = recipient?.bankType ?? 'account';
  let reference;
  if (type === 'iban') reference = { iban: recipient?.iban, currency: 'SEK' };
  else if (type === 'account') {
    if (!/^\d{4,5}$/.test(recipient?.clearing ?? '') || !/^\d{4,15}$/.test(recipient?.account ?? '')
      || payloadVersion === 2 && incompleteSwedbankClearing(recipient)) return null;
    reference = payloadVersion === 1
      ? { clearingNumber: recipient.clearing, accountNumber: recipient.account, currency: 'SEK' }
      : { bban: `${recipient.clearing}${recipient.account}`, currency: 'SEK' };
  } else return null;
  const parsed = (payloadVersion === 1 ? legacyAccount : pisAccount).safeParse(reference);
  return parsed.success ? parsed.data : null;
}

/** AIS can expose separate clearing/account fields; PIS needs IBAN or BBAN.
 * Foreign IBANs, FX and EUR/SEPA remain outside this sandbox adapter. */
export function buildSandboxPaymentPayload({ amountCents, recipient, debtorAccount, reference, executionDate, bankDetails, payloadVersion = 2 } = {}) {
  if (payloadVersion !== 1 && payloadVersion !== 2)
    return errorResult('bank_payload_version_invalid', 'Betalningsunderlagets formatversion stöds inte.');
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 99999999999999)
    return errorResult('bank_amount_invalid', 'Beloppet måste vara ett positivt belopp i hela ören.');
  const type = recipient?.bankType ?? 'account', product = ['bankgiro', 'plusgiro'].includes(type) ? 'swedish-giro' : 'domestic';
  if (!['account', 'iban', 'bankgiro', 'plusgiro'].includes(type)) return errorResult('bank_recipient_invalid', 'Mottagarens banktyp stöds inte.');
  if (recipient?.bankCountry && recipient.bankCountry !== 'SE' || type === 'iban' && !String(recipient?.iban ?? '').startsWith('SE'))
    return errorResult('bank_country_unsupported', 'Första bankkopplingen stöder svenska SEK-betalningar. Utländska IBAN behöver en annan betalningsprodukt.');
  if (!Array.isArray(bankDetails?.globalPaymentProducts) || !bankDetails.globalPaymentProducts.includes(product))
    return errorResult('bank_product_unsupported', 'Den valda banken har inte bekräftat stöd för denna betalningstyp.');
  if (debtorAccount?.currency && debtorAccount.currency !== 'SEK')
    return errorResult('bank_currency_unsupported', 'Avsändarkontot måste vara ett verifierat SEK-konto.');
  if (payloadVersion === 2 && type === 'account' && incompleteSwedbankClearing(recipient))
    return errorResult('bank_clearing_incomplete', 'Clearingnummer som börjar med 8 behöver fem siffror. Komplettera mottagarens fullständiga clearingnummer.');
  let debtorReference = { ...debtorAccount, currency: 'SEK' };
  if (payloadVersion === 2) {
    const parsed = legacyAccount.safeParse(debtorReference);
    if (parsed.success && parsed.data.clearingNumber && parsed.data.accountNumber)
      debtorReference = { bban: `${parsed.data.clearingNumber}${parsed.data.accountNumber}`, currency: 'SEK' };
  }
  const referenceValue = String(reference ?? '');
  const payload = { instructedAmount: { amount: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`, currency: 'SEK' },
    debtorAccount: debtorReference, creditorName: recipient?.holder,
    ...(executionDate ? { requestedExecutionDate: executionDate } : {}), endToEndIdentification: referenceValue };
  if (product === 'swedish-giro') {
    payload.creditorGiro = { giroNumber: recipient?.[type], giroType: type === 'bankgiro' ? 'BANKGIRO' : 'PLUSGIRO' };
    if (recipient?.ocr) payload.ocrRef = recipient.ocr;
    else payload.invoiceRef = referenceValue;
  } else {
    payload.creditorAccount = bankPaymentCreditorAccount(recipient, payloadVersion);
    payload.remittanceInformationUnstructured = referenceValue;
  }
  const schema = product === 'domestic' ? (payloadVersion === 1 ? legacyDomestic : domestic) : (payloadVersion === 1 ? legacyGiro : giro);
  const parsed = schema.safeParse(payload);
  return parsed.success ? { ok: true, product, payload: parsed.data, payloadVersion } : errorResult('bank_payload_invalid', 'Kontrollera mottagaruppgifter, avsändarkonto, datum och betalningsreferens.');
}

const scopeFor = resource => resource === 'consent' ? 'accountinformation corporate' : 'paymentinitiation corporate';
const providerCodes = (data, secrets = []) => [...new Set([...(Array.isArray(data?.tppMessages) ? data.tppMessages : []), ...(Array.isArray(data?.errors) ? data.errors : []), data]
  .map(item => item?.code ?? item?.error).filter(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
    && !secrets.some(secret => typeof secret === 'string' && secret.length >= 4 && value.includes(secret))))].slice(0, 20);

/** Sandbox only. Fixed HTTPS origins, no automatic redirects and no HTTP retries.
 * X-Request-ID is trace correlation, NOT a provider idempotency promise. The
 * durable engine must reserve every POST before calling this client. */
export function createOpenPaymentsClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  let token = null, tokenPromise = null;
  const activeSecrets = new Set();
  const safe = data => safeOpenPaymentsData(data, 0, [env.OPENPAYMENTS_CLIENT_SECRET, ...activeSecrets]);

  function configuration() {
    const missing = ['OPENPAYMENTS_CLIENT_ID', 'OPENPAYMENTS_CLIENT_SECRET'].filter(field => typeof env[field] !== 'string' || !env[field].trim());
    const issues = [];
    if (env.OPENPAYMENTS_ENVIRONMENT && env.OPENPAYMENTS_ENVIRONMENT !== 'sandbox') issues.push('Endast Open Payments sandbox stöds.');
    for (const [field, expected] of [['OPENPAYMENTS_API_BASE_URL', OPENPAYMENTS_SANDBOX_API], ['OPENPAYMENTS_AUTH_BASE_URL', OPENPAYMENTS_SANDBOX_OAUTH]])
      if (env[field] && env[field] !== expected) issues.push('Open Payments-adresserna är låsta till sandbox.');
    return { ready: !missing.length && !issues.length, configured: !missing.length, mode: 'sandbox', environment: 'sandbox', missing, issues,
      baseUrl: OPENPAYMENTS_SANDBOX_API, authUrl: OPENPAYMENTS_SANDBOX_OAUTH, products: ['domestic', 'swedish-giro'] };
  }
  const credentialKey = () => createHash('sha256').update(`${env.OPENPAYMENTS_CLIENT_ID}\0${env.OPENPAYMENTS_CLIENT_SECRET}\0${corporateScope}`).digest('hex');
  async function transport(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(20000, timeoutMs)));
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
      let text = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(); let total = 0; const decoder = new TextDecoder();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > 512 * 1024) { await reader.cancel(); throw new Error('response_too_large'); }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
        } finally { reader.releaseLock(); }
      } else { text = await response.text(); if (Buffer.byteLength(text) > 512 * 1024) throw new Error('response_too_large'); }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* Never include raw HTML/provider text. */ }
      return { statusCode: response.status, headers: response.headers, data };
    } finally { clearTimeout(timer); }
  }
  async function accessToken() {
    const config = configuration();
    if (!config.ready) return errorResult('bank_not_configured', 'Bankkopplingen saknar giltiga sandboxinställningar.');
    const key = credentialKey();
    if (token?.key === key && token.expiresAt > Number(now()) + 30000) return { ok: true, value: token.value };
    if (tokenPromise?.key === key) return tokenPromise.promise;
    const promise = (async () => {
      try {
        const body = new URLSearchParams({ client_id: env.OPENPAYMENTS_CLIENT_ID, client_secret: env.OPENPAYMENTS_CLIENT_SECRET,
          grant_type: 'client_credentials', scope: corporateScope });
        const response = await transport(`${OPENPAYMENTS_SANDBOX_OAUTH}/connect/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
        const codes = providerCodes(response.data,[env.OPENPAYMENTS_CLIENT_SECRET,...activeSecrets]);
        if (response.statusCode !== 200 || typeof response.data?.access_token !== 'string' || !response.data.access_token ||
          String(response.data?.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(response.data?.expires_in) || response.data.expires_in <= 0)
          return errorResult('bank_authentication_failed', 'Open Payments kunde inte autentisera sandboxkopplingen. Kontrollera klientuppgifterna.', {
            statusCode: response.statusCode, data: safe(response.data), error: { code: 'bank_authentication_failed', message: 'Open Payments kunde inte autentisera sandboxkopplingen. Kontrollera klientuppgifterna.', providerCodes: codes } });
        activeSecrets.add(response.data.access_token);
        if (activeSecrets.size > 10) activeSecrets.delete(activeSecrets.values().next().value);
        const entry = { key, value: response.data.access_token, expiresAt: Number(now()) + Math.min(response.data.expires_in, 3600) * 1000 };
        if (key === credentialKey()) token = entry;
        return { ok: true, value: entry.value };
      } catch { return errorResult('bank_authentication_unavailable', 'Open Payments autentisering kunde inte nås. Försök igen senare.'); }
      finally { if (tokenPromise?.promise === promise) tokenPromise = null; }
    })();
    tokenPromise = { key, promise };
    return promise;
  }

  function bankContext(options = {}, { consent = false } = {}) {
    if (!bic.test(options.bankId ?? '') || !identifier.test(options.psuId ?? '') || !identifier.test(options.corporateId ?? '') ||
      !isIP(options.psuIp ?? '') || typeof options.userAgent !== 'string' || options.userAgent.length < 1 || options.userAgent.length > 500 || /[\r\n]/.test(options.userAgent) ||
      consent && !identifier.test(options.consentId ?? '')) return null;
    return { 'X-BicFi': options.bankId, 'PSU-ID': options.psuId, 'PSU-Corporate-ID': options.corporateId, 'PSU-IP-Address': options.psuIp,
      'PSU-User-Agent': options.userAgent, 'TPP-Redirect-Preferred': options.redirectUri ? 'true' : 'false',
      ...(consent ? { 'Consent-ID': options.consentId } : {}) };
  }
  function callbackUri(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && value.length <= 2048 &&
        (!env.OPENPAYMENTS_REDIRECT_URI || value === env.OPENPAYMENTS_REDIRECT_URI) ? url : null;
    } catch { return null; }
  }
  async function request(method, path, { headers = {}, body, requestId } = {}) {
    if (!path.startsWith('/psd2/') || path.includes('..') || path.includes('\\') || !['GET', 'POST', 'PUT'].includes(method))
      return errorResult('bank_target_forbidden', 'Bankanropets adress är inte tillåten.');
    const traceId = requestId ?? randomUUID();
    if (!uuid.test(traceId)) return errorResult('bank_request_id_invalid', 'Bankanropets spårnings-ID har fel format.');
    const auth = await accessToken();
    if (!auth.ok) return auth;
    const journal = { method, path, requestId: traceId, request: body === undefined ? null : safe(body), response: null, statusCode: null };
    try {
      const response = await transport(`${OPENPAYMENTS_SANDBOX_API}${path}`, { method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${auth.value}`, 'X-Request-ID': traceId, ...headers,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      journal.statusCode = response.statusCode; journal.response = safe(response.data);
      if (response.statusCode >= 200 && response.statusCode < 300 && response.data && typeof response.data === 'object' && !Array.isArray(response.data))
        return { ok: true, environment: 'sandbox', statusCode: response.statusCode, data: response.data, journal, uncertain: false,
          scaApproach: response.headers?.get?.('aspsp-sca-approach') ?? null };
      if (response.statusCode === 401) token = null;
      const uncertain = method !== 'GET' && (response.statusCode >= 500 || response.statusCode === 409 || response.statusCode >= 300 && response.statusCode < 400 || response.statusCode >= 200 && response.statusCode < 300);
      const code = response.statusCode === 404 ? 'bank_not_found' : response.statusCode === 401 || response.statusCode === 403 ? 'bank_access_denied'
        : response.statusCode >= 300 && response.statusCode < 400 ? 'bank_redirect_forbidden' : 'bank_request_rejected';
      return errorResult(code, uncertain ? 'Bankanropets resultat är osäkert. Kontrollera samma betalning; skicka inte en ny.' : 'Open Payments kunde inte godkänna bankanropet.', {
        statusCode: response.statusCode, uncertain, data: safe(response.data), journal,
        error: { code, message: uncertain ? 'Bankanropets resultat är osäkert. Kontrollera samma betalning; skicka inte en ny.' : 'Open Payments kunde inte godkänna bankanropet.', providerCodes: providerCodes(response.data,[env.OPENPAYMENTS_CLIENT_SECRET,...activeSecrets]) } });
    } catch { return errorResult('bank_transport_unknown', method === 'GET' ? 'Bankens svar kunde inte hämtas. Senaste bekräftade status behålls.'
      : 'Bankanropet avbröts utan bekräftat svar. Kontrollera samma betalning; skicka inte en ny.', { uncertain: method !== 'GET', journal }); }
  }
  function resourcePath(options = {}) {
    if (!identifier.test(options.id ?? '')) return null;
    if (options.resource === 'consent') return `/psd2/consent/v1/consents/${options.id}`;
    if (options.resource === undefined || options.resource === 'payment') return ['domestic', 'swedish-giro'].includes(options.product)
      ? `/psd2/paymentinitiation/v1/payments/${options.product}/${options.id}` : null;
    return null;
  }
  const badContext = () => errorResult('bank_context_invalid', 'Bank, bankanvändare, bolagsnummer och webbläsaruppgifter måste vara ifyllda.');
  const boundRequest = (method, path, options = {}, body) => {
    const headers = bankContext(options);
    if (!path || !headers) return Promise.resolve(badContext());
    if (options.redirectUri) {
      if (!callbackUri(options.redirectUri)) return Promise.resolve(errorResult('bank_redirect_uri_invalid', 'Bankens returadress måste vara den registrerade HTTPS-adressen.'));
      headers['TPP-Redirect-URI'] = options.redirectUri;
    }
    return request(method, path, { headers, body, requestId: options.requestId });
  };
  function boundAuthorisationUrl(options, link = `${OPENPAYMENTS_SANDBOX_OAUTH}/connect/authorize`) {
    if (!configuration().ready || !resourcePath(options) || !identifier.test(options.authorisationId ?? '')
      || !bic.test(options.bankId ?? '') || !callbackUri(options.redirectUri) || !/^[A-Za-z0-9_-]{16,256}$/.test(options.state ?? '')) throw new Error();
    const url = new URL(link);
    if (!['https://oauth.sandbox.openbankingplatform.com', 'https://auth.sandbox.openbankingplatform.com'].includes(url.origin)
      || url.pathname !== '/connect/authorize' || url.username || url.password || url.hash || link.length > 4096) throw new Error();
    const resource = options.resource === 'consent' ? 'consent' : 'payment', title = resource === 'consent' ? 'Consent' : 'Payment';
    // Actual sandbox links use lower-case consentAuthorisationId; the current
    // prose documentation also shows the upper-case spelling. Preserve only
    // this verified selector's spelling, never any provider-supplied IDs.
    const supported = new Set([`${resource}AuthorisationId`, `${title}AuthorisationId`]);
    const selectors = (url.searchParams.get('acr_values') ?? '').split(/\s+/).map(value => value.split(':')[0]).filter(key => supported.has(key));
    if (selectors.length > 1) throw new Error();
    const selector = selectors[0] ?? (resource === 'consent' ? 'consentAuthorisationId' : 'PaymentAuthorisationId');
    url.search = '';
    for (const [key,value] of Object.entries({client_id:env.OPENPAYMENTS_CLIENT_ID,redirect_uri:options.redirectUri,state:options.state,
      scope:scopeFor(resource),response_type:'code',acr_values:`idp:${options.bankId} ${resource}Id:${options.id} ${selector}:${options.authorisationId}`})) url.searchParams.set(key,value);
    return url.toString();
  }

  return {
    configuration, configurationStatus: configuration,
    async testConnection() {
      const result = await this.banks();
      return { ...result, ...(result.ok ? { bankCount: result.data.aspsps.length } : {}) };
    },
    async banks() {
      const result = await request('GET', '/psd2/aspspinformation/v1/aspsps?isoCountryCodes=SE');
      if (result.ok && !Array.isArray(result.data.aspsps)) return errorResult('bank_response_invalid', 'Banklistan kunde inte verifieras.', { statusCode: result.statusCode, journal: result.journal });
      return result;
    },
    async bankDetails(bankId) {
      if (!bic.test(bankId ?? '')) return badContext();
      const result = await request('GET', `/psd2/aspspinformation/v1/aspsps/${bankId}`);
      if (result.ok && result.data.bicFi !== bankId) return errorResult('bank_response_invalid', 'Bankuppgifterna kunde inte kopplas till vald bank.', { statusCode: result.statusCode, journal: result.journal });
      return result;
    },
    async createConsent(options = {}) {
      const consent = z.object({ access: z.object({}).strict(), combinedServiceIndicator: z.boolean(), frequencyPerDay: z.number().int().min(1).max(4),
        recurringIndicator: z.boolean(), validUntil: dateString }).strict().safeParse(options.payload);
      if (!consent.success) return errorResult('bank_consent_invalid', 'Bankmedgivandets uppgifter är ofullständiga.');
      const result = await boundRequest('POST', '/psd2/consent/v1/consents', options, consent.data);
      if (result.ok && !identifier.test(result.data.consentId ?? '')) return errorResult('bank_consent_unconfirmed', 'Banken tog emot medgivandet men dess ID kunde inte verifieras.', { statusCode: result.statusCode, journal: result.journal, uncertain: true });
      return result;
    },
    readConsentStatus: options => boundRequest('GET', resourcePath({ ...options, resource: 'consent' }) ? `${resourcePath({ ...options, resource: 'consent' })}/status` : null, options),
    async accounts(options = {}) {
      const headers = bankContext(options, { consent: true });
      if (!headers) return badContext();
      return request('GET', '/psd2/accountinformation/v1/accounts?withBalance=true', { headers: { ...headers, 'X-Feature-Flags': 'new-balances' }, requestId: options.requestId });
    },
    async balances(options = {}) {
      const headers = bankContext(options, { consent: true });
      if (!headers || !identifier.test(options.accountId ?? '')) return badContext();
      return request('GET', `/psd2/accountinformation/v1/accounts/${options.accountId}/balances`, { headers: { ...headers, 'X-Feature-Flags': 'new-balances' }, requestId: options.requestId });
    },
    async createPayment(options = {}) {
      const schema = options.product === 'domestic' ? domestic : options.product === 'swedish-giro' ? giro : null;
      const parsed = schema?.safeParse(options.payload);
      if (!parsed?.success) return errorResult('bank_payload_invalid', 'Endast svenska domestic- eller girobetalningar i SEK med giltiga uppgifter stöds.');
      const result = await boundRequest('POST', `/psd2/paymentinitiation/v1/payments/${options.product}`, options, parsed.data);
      if (result.ok && (!identifier.test(result.data.paymentId ?? '') || typeof result.data.transactionStatus !== 'string'))
        return errorResult('bank_payment_unconfirmed', 'Banken tog emot begäran men betalnings-ID eller status kunde inte verifieras. Skicka inte en ny.', { statusCode: result.statusCode, journal: result.journal, uncertain: true });
      return result;
    },
    readPayment: options => boundRequest('GET', resourcePath(options), options),
    readPaymentStatus: options => boundRequest('GET', resourcePath(options) ? `${resourcePath(options)}/status` : null, options),
    async createAuthorisation(options = {}) {
      const result = await boundRequest('POST', resourcePath(options) ? `${resourcePath(options)}/authorisations` : null, options, {});
      if (result.ok && !identifier.test(result.data.authorisationId ?? '')) return errorResult('bank_authorisation_unconfirmed',
        'Banken tog emot godkännandebegäran men dess ID kunde inte verifieras.', { statusCode: result.statusCode, journal: result.journal, uncertain: true });
      return result;
    },
    async startAuthorisation(options = {}) {
      const path = resourcePath(options);
      if (!path || !identifier.test(options.authorisationId ?? '') || !identifier.test(options.authenticationMethodId ?? '')) return badContext();
      const result = await boundRequest('PUT', `${path}/authorisations/${options.authorisationId}`, options, { authenticationMethodId: options.authenticationMethodId });
      if (!result.ok) return result;
      const link = result.data?._links?.scaOAuth?.href;
      if (!link) return result;
      try {
        return { ...result, authorisationUrl: boundAuthorisationUrl(options,link) };
      } catch { return errorResult('bank_authorisation_link_invalid', 'Bankens godkännandelänk kunde inte verifieras. Ingen omdirigering görs.', { statusCode: result.statusCode, journal: result.journal, uncertain: true }); }
    },
    renewAuthorisation(options = {}) {
      // Caller first reconciles the SAME existing consent/SCA. A started
      // authorisation needs only fresh OAuth state/code; creating another one
      // is rejected by the real sandbox and must not be attempted here.
      try { return {ok:true,environment:'sandbox',authorisationUrl:boundAuthorisationUrl(options)}; }
      catch { return errorResult('bank_authorisation_link_invalid','Bankens nya godkännandelänk kunde inte verifieras.'); }
    },
    readAuthorisation: options => boundRequest('GET', resourcePath(options) && identifier.test(options.authorisationId ?? '') ? `${resourcePath(options)}/authorisations/${options.authorisationId}` : null, options),
    async completeAuthorisation(options = {}) {
      // The server route, not this adapter, must verify one-time state/session/
      // tenant ownership before exchanging the callback code. The token is not
      // a payment receipt and is never returned/stored as a corporate API token.
      if (!configuration().ready || !resourcePath(options) || !identifier.test(options.authorisationId ?? '') || !callbackUri(options.redirectUri) ||
        typeof options.code !== 'string' || options.code.length < 1 || options.code.length > 2048 || /[\r\n]/.test(options.code)) return badContext();
      const resource = options.resource === 'consent' ? 'consent' : 'payment';
      const title = resource === 'consent' ? 'Consent' : 'Payment';
      const requestId = options.requestId ?? randomUUID();
      if (!uuid.test(requestId)) return badContext();
      activeSecrets.add(options.code);
      const journal = { method: 'POST', path: '/connect/token', requestId, request: { grant_type: 'authorization_code', scope: scopeFor(resource),
        redirect_uri: options.redirectUri, code: '[redacted]' }, response: null, statusCode: null };
      try {
        const body = new URLSearchParams({ client_id: env.OPENPAYMENTS_CLIENT_ID, client_secret: env.OPENPAYMENTS_CLIENT_SECRET,
          code: options.code, redirect_uri: options.redirectUri, scope: scopeFor(resource), grant_type: 'authorization_code' });
        const response = await transport(`${OPENPAYMENTS_SANDBOX_OAUTH}/connect/token`, { method: 'POST', headers: {
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Request-ID': requestId,
          [`X-${resource}Id`]: options.id, [`X-${title}AuthorisationId`]: options.authorisationId }, body });
        if (typeof response.data?.access_token === 'string') activeSecrets.add(response.data.access_token);
        journal.statusCode = response.statusCode; journal.response = safe(response.data);
        if (response.statusCode === 200 && typeof response.data?.access_token === 'string' && response.data.access_token && String(response.data?.token_type).toLowerCase() === 'bearer')
          return { ok: true, environment: 'sandbox', statusCode: 200, uncertain: false, data: { activated: true }, journal };
        return errorResult('bank_authorisation_activation_failed', 'Bankgodkännandet kunde inte aktiveras. Kontrollera samma medgivande eller betalning.', {
          statusCode: response.statusCode, uncertain: response.statusCode >= 500, data: safe(response.data), journal,
          error: { code: 'bank_authorisation_activation_failed', message: 'Bankgodkännandet kunde inte aktiveras. Kontrollera samma medgivande eller betalning.', providerCodes: providerCodes(response.data,[env.OPENPAYMENTS_CLIENT_SECRET,...activeSecrets]) } });
      } catch { return errorResult('bank_authorisation_activation_unknown', 'Bankgodkännandets resultat är osäkert. Kontrollera samma medgivande eller betalning.', { uncertain: true, journal }); }
    },
  };
}
