import https from 'node:https';
import tls from 'node:tls';
import { createHash, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensureSwishMssCertificates, SWISH_MSS_MERCHANT_ALIAS, validateSwishMssCredentials } from './swish-mss-certificates.mjs';

export const SWISH_MSS_PAYOUTS_URL = 'https://mss.cpc.getswish.net/swish-cpcapi/api/v1/payouts';
const instruction = /^[0-9A-F]{32}$/;
const secretField = /certificate|signature|private|secret|password|passphrase|authorization|cookie|token|key/i;
const piiField = /ssn|personnummer|personalidentity|payeealias|payeralias/i;
const payloadSchema = z.object({
  payoutInstructionUUID: z.string().regex(instruction), payerPaymentReference: z.string().regex(/^[A-Za-zÅÄÖåäö0-9-]{1,35}$/),
  payerAlias: z.literal(SWISH_MSS_MERCHANT_ALIAS).optional(), payeeAlias: z.string().regex(/^[1-9][0-9]{7,14}$/),
  payeeSSN: z.string().regex(/^[0-9]{12}$/), amount: z.string().regex(/^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$/).refine(value => Number(value) >= 0.01),
  currency: z.literal('SEK'), payoutType: z.literal('PAYOUT'),
  message: z.string().max(50).regex(/^[A-Za-zÅÄÖåäö0-9 !?(),.\-:;]*$/), instructionDate: z.string().datetime({ offset: true }),
  signingCertificateSerialNumber: z.string().regex(/^[0-9A-F]+$/).optional(),
}).strict();

/** Redacted diagnostics, never raw certificate/key/signature or recipient SSN.
 * Untrusted error messages are scrubbed as well, including reflected numbers. */
export function safeSwishData(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/\b\d{6}[-+]\d{4}\b|\b\d{8}[-+]\d{4}\b|\b\d{10,15}\b/g, '[redacted]').slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 40).map(item => safeSwishData(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 60).map(([name, item]) =>
    [name, secretField.test(name) || piiField.test(name) ? '[redacted]' : safeSwishData(item, depth + 1)]));
  return value ?? null;
}

function assertMssTarget(url, method) {
  const target = new URL(url), base = new URL(SWISH_MSS_PAYOUTS_URL);
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash ||
    !(method === 'POST' && target.pathname === base.pathname || method === 'GET' && new RegExp(`^${base.pathname}/[0-9A-F]{32}$`).test(target.pathname)))
    throw new Error('SWISH_TARGET_FORBIDDEN');
  return target;
}

/** Native HTTPS keeps mTLS and peer verification on. Redirects and POST retries
 * are deliberately absent. A timeout may have happened AFTER Swish accepted. */
export function requestSwishMssHttps({ url, method, headers, body, cert, key, ca, timeoutMs = 12000 }) {
  const target = assertMssTarget(url, method);
  return new Promise((resolve, reject) => {
    const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
    let request;
    try {
      request = https.request(target, { method, headers, cert, key, ca, agent, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, response => {
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 256 * 1024) request.destroy(new Error('SWISH_RESPONSE_TOO_LARGE')); else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('aborted', () => request.destroy(new Error('SWISH_RESPONSE_ABORTED')));
        response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
    } catch (cause) { agent.destroy(); reject(cause); return; }
    const timer = setTimeout(() => request.destroy(new Error('SWISH_TIMEOUT')), Math.max(500, Math.min(20000, timeoutMs)));
    timer.unref();
    request.on('error', reject);
    request.on('close', () => { clearTimeout(timer); agent.destroy(); });
    if (body) request.write(body);
    request.end();
  });
}

/** Swish's guide specifies SHA512(payload UTF8), then SHA512withRSA(hash).
 * Signing only the original JSON would miss the guide's second hash. */
export function signSwishPayoutPayload(serializedPayload, signingKey) {
  const digest = createHash('sha512').update(serializedPayload, 'utf8').digest();
  return sign('RSA-SHA512', digest, signingKey).toString('base64');
}

async function loadEnvironmentCredentials(env) {
  if (env.SWISH_MSS_PUBLIC_TEST_CERTIFICATES === 'true') return ensureSwishMssCertificates();
  const fields = { tlsCert: 'SWISH_TLS_CERT_FILE', tlsKey: 'SWISH_TLS_KEY_FILE', signingCert: 'SWISH_SIGNING_CERT_FILE',
    signingKey: 'SWISH_SIGNING_KEY_FILE', ca: 'SWISH_TLS_CA_FILE' };
  return Object.fromEntries(await Promise.all(Object.entries(fields).map(async ([name, variable]) => [name, await readFile(env[variable])])));
}

function readBody(body) {
  if (body === undefined || body === null || body === '') return null;
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  try { return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)); } catch { return null; }
}
const providerCodes = data => {
  const errors = Array.isArray(data) ? data : Array.isArray(data?.errors) ? data.errors : [data];
  return [...new Set(errors.map(error => error?.errorCode ?? error?.code).filter(code => typeof code === 'string' && /^[A-Z0-9_-]{1,40}$/.test(code)))].slice(0, 16);
};
const resultError = (code, message, { statusCode = null, uncertain = false, instructionUUID = null, data = null, codes = [] } = {}) => ({
  ok: false, environment: 'mss', statusCode, uncertain, instructionUUID, data: safeSwishData(data), error: { code, message, providerCodes: codes },
});

/** MSS only; no production mode or configurable request URL exists.
 * credentialLoader/request are server-side test seams, never browser fields. */
export function createSwishMssClient({ env = process.env, request = requestSwishMssHttps, credentialLoader = loadEnvironmentCredentials,
  credentialValidator = validateSwishMssCredentials, now = Date.now, timeoutMs = 12000 } = {}) {
  if (credentialValidator !== validateSwishMssCredentials && request === requestSwishMssHttps)
    throw new Error('SWISH_TEST_VALIDATOR_REQUIRES_TEST_TRANSPORT');
  async function configuration() {
    const mode = env.SWISH_ENVIRONMENT === 'mss' ? 'mss' : 'disabled', missing = [], issues = [];
    if (mode === 'disabled') missing.push('SWISH_ENVIRONMENT=mss');
    if (env.SWISH_ENVIRONMENT && !['mss', 'disabled'].includes(env.SWISH_ENVIRONMENT)) issues.push('Endast Swish MSS:s simulator stöds.');
    if (env.SWISH_API_BASE_URL && env.SWISH_API_BASE_URL !== SWISH_MSS_PAYOUTS_URL) issues.push('Swish-adressen får endast vara MSS:s fasta utbetalningsadress.');
    if (mode === 'mss' && env.SWISH_MSS_PUBLIC_TEST_CERTIFICATES !== 'true' && credentialLoader === loadEnvironmentCredentials)
      for (const field of ['SWISH_TLS_CERT_FILE', 'SWISH_TLS_KEY_FILE', 'SWISH_SIGNING_CERT_FILE', 'SWISH_SIGNING_KEY_FILE', 'SWISH_TLS_CA_FILE']) if (!env[field]) missing.push(field);
    let credentials = null, metadata = null;
    if (mode === 'mss' && !missing.length && !issues.length) {
      try {
        credentials = await credentialLoader(env);
        metadata = credentialValidator(credentials, Number(now()));
        // Ensure the separate TLS key and certificate chain also parse as a
        // client context, before a payout can leave the server.
        tls.createSecureContext({ cert: credentials.tlsCert, key: credentials.tlsKey, ca: credentials.ca, minVersion: 'TLSv1.2' });
      } catch { issues.push('MSS-testcertifikaten kunde inte hämtas eller verifieras. Kontrollera serverns testinställningar och certifikatens giltighet.'); }
    }
    const ready = mode === 'mss' && !missing.length && !issues.length && Boolean(credentials);
    const status = { ready, configured: mode === 'mss' && !missing.length, mode, missing, issues, merchantAlias: SWISH_MSS_MERCHANT_ALIAS,
      baseUrl: SWISH_MSS_PAYOUTS_URL, certificate: metadata ? { serialNumber: metadata.signingSerial, validTo: metadata.validTo, tlsValidTo: metadata.tlsValidTo } : null };
    return { status, credentials, metadata };
  }

  async function send(method, uuid, body, config) {
    const url = method === 'POST' ? SWISH_MSS_PAYOUTS_URL : `${SWISH_MSS_PAYOUTS_URL}/${uuid}`;
    try {
      const response = await request({ url, method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(body && { 'Content-Length': Buffer.byteLength(body) }) },
        body, cert: config.credentials.tlsCert, key: config.credentials.tlsKey, ca: config.credentials.ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', timeoutMs });
      const statusCode = Number(response?.statusCode ?? response?.status) || null, data = readBody(response?.body ?? response?.data), codes = providerCodes(data);
      if (method === 'POST' && statusCode === 201) {
        const location = response.headers?.location ?? response.headers?.Location;
        if (typeof location !== 'string') return resultError('swish_create_unconfirmed', 'Swish tog emot begäran men returadressen saknas. Kontrollera samma utbetalning innan något nytt försök.', { statusCode, uncertain: true, instructionUUID: uuid });
        try { if (assertMssTarget(location, 'GET').pathname !== new URL(`${SWISH_MSS_PAYOUTS_URL}/${uuid}`).pathname) throw new Error(); }
        catch { return resultError('swish_location_invalid', 'Swish tog emot begäran men returadressen kunde inte verifieras. Kontrollera samma utbetalning.', { statusCode, uncertain: true, instructionUUID: uuid }); }
        return { ok: true, environment: 'mss', statusCode, uncertain: false, instructionUUID: uuid, payoutReference: uuid, data };
      }
      if (method === 'GET' && statusCode === 200) {
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.payoutInstructionUUID !== uuid || !['CREATED', 'DEBITED', 'PAID', 'ERROR'].includes(data.status))
          return resultError('swish_status_unverified', 'Svaret kunde inte kopplas till rätt utbetalning. Tidigare bekräftad status behålls.', { statusCode, uncertain: true, instructionUUID: uuid });
        return { ok: true, environment: 'mss', statusCode, uncertain: false, instructionUUID: uuid, payoutReference: uuid, data };
      }
      if (statusCode >= 300 && statusCode < 400) return resultError('swish_redirect_rejected', 'Swish svarade med en otillåten omdirigering. Ingen omdirigering följdes.', { statusCode, uncertain: true, instructionUUID: uuid });
      const uncertain = !statusCode || statusCode >= 500 || statusCode === 409 || codes.includes('RP09') || method === 'GET';
      return resultError(statusCode === 404 ? 'swish_not_found' : statusCode === 401 || statusCode === 403 ? 'swish_authentication_failed' : 'swish_rejected',
        uncertain ? 'Utbetalningen kunde inte bekräftas. Kontrollera samma utbetalnings-ID; skicka inte på nytt.' : 'Swish avvisade begäran. Ingen utbetalning startades.',
        { statusCode, uncertain, instructionUUID: uuid, data, codes });
    } catch {
      return resultError('swish_transport_unknown', 'Swish kunde inte bekräfta resultatet. Kontrollera samma utbetalnings-ID innan ett nytt försök.', { uncertain: true, instructionUUID: uuid });
    }
  }

  return {
    configurationStatus: async () => (await configuration()).status,
    async createPayout(payload, options = {}) {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success || !options || Object.keys(options).some(name => !['callbackUrl', 'callbackIdentifier'].includes(name)))
        return resultError('swish_invalid_payload', 'Utbetalningsuppgifterna har fel format. Kontrollera belopp, telefonnummer och personnummer.');
      if (options.callbackUrl !== undefined) {
        try { const callback = new URL(options.callbackUrl); if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash || options.callbackUrl.length > 2048) throw new Error(); }
        catch { return resultError('swish_invalid_callback', 'Återkopplingsadressen måste vara en giltig HTTPS-adress.'); }
      }
      if (options.callbackIdentifier !== undefined && (typeof options.callbackIdentifier !== 'string' || !instruction.test(options.callbackIdentifier)))
        return resultError('swish_invalid_callback', 'Återkopplingsidentifieraren har fel format.');
      const config = await configuration(), uuid = parsed.data.payoutInstructionUUID;
      if (!config.status.ready) return resultError('swish_not_configured', 'Swish MSS är inte färdigkonfigurerad på servern.', { instructionUUID: uuid });
      if (parsed.data.signingCertificateSerialNumber && parsed.data.signingCertificateSerialNumber !== config.metadata.signingSerial)
        return resultError('swish_invalid_signing_certificate', 'Signeringscertifikatet måste vara simulatorns offentliga testcertifikat.', { instructionUUID: uuid });
      // An explicit order produces exactly the same UTF8 JSON bytes in the
      // signature input and the transmitted nested payload. No later sorting,
      // pretty printing or stringification may modify this serialized value.
      const value = parsed.data, canonical = {
        payoutInstructionUUID: uuid, payerPaymentReference: value.payerPaymentReference, payerAlias: SWISH_MSS_MERCHANT_ALIAS,
        payeeAlias: value.payeeAlias, payeeSSN: value.payeeSSN, amount: value.amount, currency: 'SEK', payoutType: 'PAYOUT',
        message: value.message, instructionDate: value.instructionDate, signingCertificateSerialNumber: config.metadata.signingSerial,
      };
      try {
        const serialized = JSON.stringify(canonical), signature = signSwishPayoutPayload(serialized, config.credentials.signingKey);
        const extra = { ...(options.callbackUrl !== undefined && { callbackUrl: options.callbackUrl }), ...(options.callbackIdentifier !== undefined && { callbackIdentifier: options.callbackIdentifier }), signature };
        const body = `{"payload":${serialized},${JSON.stringify(extra).slice(1)}`;
        return send('POST', uuid, body, config);
      } catch { return resultError('swish_signing_failed', 'Testutbetalningen kunde inte signeras. Inget skickades till Swish.', { instructionUUID: uuid }); }
    },
    async getPayout(uuid) {
      if (typeof uuid !== 'string' || !instruction.test(uuid)) return resultError('swish_invalid_instruction', 'Utbetalningsidentifieraren har fel format.');
      const config = await configuration();
      if (!config.status.ready) return resultError('swish_not_configured', 'Swish MSS är inte färdigkonfigurerad på servern.', { instructionUUID: uuid });
      return send('GET', uuid, undefined, config);
    },
  };
}
