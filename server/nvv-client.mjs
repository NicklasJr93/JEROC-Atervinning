import https from 'node:https';
import tls from 'node:tls';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';

export const NVV_TEST_API_URL = 'https://apimtest.naturvardsverket.se/btfa/anteckning/v1';
export const NVV_TEST_TOKEN_URL = 'https://apimtest.naturvardsverket.se/oauth2/token';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const receiptPath = /^\/insamlingar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secretKey = /authorization|cookie|password|passphrase|secret|token|pfx|client[_-]?id/i;

function safeValue(value, secrets = [], depth = 0, meta = {}) {
  if (depth > 12) { meta.truncated = true; return '[truncated]'; }
  if (typeof value === 'string') {
    if (value.length > 8192) meta.truncated = true;
    let safe = value;
    for (const secret of secrets) if (secret) safe = safe.split(secret).join('[redacted]');
    return safe.slice(0, 8192);
  }
  if (Array.isArray(value)) { if (value.length > 5000) meta.truncated = true; return value.slice(0, 5000).map((item) => safeValue(item, secrets, depth + 1, meta)); }
  if (value && typeof value === 'object') { if (Object.keys(value).length > 200) meta.truncated = true; return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [safeValue(key, secrets, depth + 1, meta), secretKey.test(key) ? '[redacted]' : safeValue(item, secrets, depth + 1, meta)])); }
  return value ?? null;
}

function parseBody(body) {
  if (body === undefined || body === null || body === '') return null;
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  try { return JSON.parse(text); } catch { return text; }
}

function requestHttps({ url, method, headers, body, pfx, passphrase, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(target, { method, headers, pfx, passphrase, rejectUnauthorized: true, minVersion: 'TLSv1.2' }, (res) => {
      const chunks = [];
      let length = 0;
      res.on('data', (chunk) => {
        length += chunk.length;
        if (length > 10 * 1024 * 1024) req.destroy(new Error('NVV_RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.on('aborted', () => req.destroy(new Error('NVV_RESPONSE_ABORTED')));
      res.on('error', reject);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('NVV_TIMEOUT')), timeoutMs);
    timer.unref();
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

function error(code, message, details) { return { code, message, ...(details ? { details } : {}) }; }
function statusCode(result) { return Number(result?.statusCode ?? result?.status) || null; }
function clock(now) { const value = now(); return value instanceof Date ? value.getTime() : Number(value); }
function iso(now) { return new Date(clock(now)).toISOString(); }

const emptyCertificateMetadata = () => ({ metadataAvailable: false, organisationName: null, organisationNumber: null,
  issuer: null, validFrom: null, validTo: null, fingerprint256: null });
const subjectValues = (subject, names) => names.flatMap(name => {
  const value = subject?.[name];
  return (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string' && item.length <= 500).map(item => item.trim()).filter(Boolean);
});
function certificateOrganisationNumber(value) {
  let number = value.toUpperCase().replace(/[\s-]/g, '');
  if (/^NTRSE\d{10}$/.test(number)) number = number.slice(5);
  else if (/^SE\d{10}(?:01)?$/.test(number)) number = number.slice(2, 12);
  else if (/^16\d{10}$/.test(number)) number = number.slice(2);
  // A Swedish organisation number has a third digit >= 2. In particular, do
  // not turn a person identifier with a 19/20 century prefix into a company.
  return /^\d{2}[2-9]\d{7}$/.test(number) ? number : null;
}

/** Public metadata of the certificate loaded for TLS, not a claim that NVV
 * accepted it. Never return the subject, certificate serial, DER or key bytes. */
export function describeNvvCertificate(raw) {
  try {
    const certificate = raw instanceof X509Certificate ? raw : new X509Certificate(raw);
    const subject = certificate.toLegacyObject().subject;
    const names = [...new Set(subjectValues(subject, ['O', 'organizationName', 'organisationName', '2.5.4.10']))];
    const identifiers = subjectValues(subject, ['serialNumber', '2.5.4.5', 'organizationIdentifier', 'organisationIdentifier', '2.5.4.97']);
    const numbers = [...new Set(identifiers.map(certificateOrganisationNumber).filter(Boolean))];
    return { metadataAvailable: true, organisationName: names.length === 1 ? names[0] : null,
      organisationNumber: numbers.length === 1 ? numbers[0] : null,
      issuer: certificate.issuer.slice(0, 2000), validFrom: new Date(certificate.validFrom).toISOString(),
      validTo: new Date(certificate.validTo).toISOString(), fingerprint256: certificate.fingerprint256 };
  } catch { return emptyCertificateMetadata(); }
}

function loadedCertificateMetadata(context) {
  try {
    const raw = context?.context?.getCertificate?.();
    return raw ? describeNvvCertificate(raw) : emptyCertificateMetadata();
  } catch { return emptyCertificateMetadata(); }
}

/** TEST-only adapter. All external I/O is injectable; a missing mode disables it. */
export function createNvvClient({ env = process.env, request = requestHttps, now = Date.now } = {}) {
  let cachedToken = null;
  let tokenPromise = null;
  const knownTokens = new Set();
  const mockRecords = new Map();
  let cachedConfiguration;
  const configurationLoads = new Map();

  function configurationInput() {
    const mode = String(env.NVV_ENVIRONMENT || 'disabled').trim().toLowerCase();
    const apiBaseUrl = String(env.NVV_API_BASE_URL || NVV_TEST_API_URL).replace(/\/$/, '');
    const tokenUrl = String(env.NVV_TOKEN_URL || NVV_TEST_TOKEN_URL);
    const systemId = String(env.NVV_CLIENT_SYSTEM_ID || '').trim();
    const clientId = String(env.NVV_CLIENT_ID || '').trim();
    const clientSecret = String(env.NVV_CLIENT_SECRET || '');
    const passphrase = env.NVV_CLIENT_PFX_PASSWORD === undefined ? undefined : String(env.NVV_CLIENT_PFX_PASSWORD);
    const secretFile = String(env.NVV_CLIENT_PFX_SECRET_FILE || '');
    const key = createHash('sha256').update(JSON.stringify([mode, apiBaseUrl, tokenUrl, systemId, clientId, clientSecret, passphrase, secretFile])).digest('hex');
    return { mode, apiBaseUrl, tokenUrl, systemId, clientId, clientSecret, passphrase, secretFile, key };
  }
  const fileIdentity = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');

  async function loadConfiguration(input, forceFileRead) {
    const { mode, apiBaseUrl, tokenUrl, systemId, clientId, clientSecret, passphrase, secretFile, key } = input;
    const issues = [], missing = [];
    if (!['disabled', 'mock', 'test'].includes(mode)) issues.push('Endast disabled, mock eller test stöds.');
    if (apiBaseUrl !== NVV_TEST_API_URL || tokenUrl !== NVV_TEST_TOKEN_URL) issues.push('Endast Naturvårdsverkets fasta HTTPS-adresser för TEST får användas.');
    let pfx;
    let validated = false;
    let certificateMetadata = emptyCertificateMetadata();
    let identity = 'unused';
    if (mode === 'test') {
      for (const [name, value] of [['NVV_CLIENT_ID', clientId], ['NVV_CLIENT_SECRET', clientSecret], ['NVV_CLIENT_PFX_SECRET_FILE', secretFile], ['NVV_CLIENT_SYSTEM_ID', systemId]]) if (!value) missing.push(name);
      if (passphrase === undefined) missing.push('NVV_CLIENT_PFX_PASSWORD');
      if (systemId && (!/^[\x20-\x7e]{1,200}$/.test(systemId))) issues.push('Systemnamn och version måste vara en giltig HTTP-header.');
      if (secretFile && passphrase !== undefined && !issues.length) {
        try {
          // Reads only inspect metadata when the certificate has not changed.
          // Real HTTP operations reload bytes as well, including a replacement
          // that preserved timestamps. Never retain a good certificate after a
          // missing/unreadable file or a change during its read.
          let encoded;
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = fileIdentity(await stat(secretFile, { bigint: true }));
            if (!forceFileRead && cachedConfiguration?.key === key && cachedConfiguration.identity === before)
              return cachedConfiguration.config;
            encoded = (await readFile(secretFile, 'utf8')).replace(/\s/g, '');
            identity = fileIdentity(await stat(secretFile, { bigint: true }));
            if (before === identity) break;
            encoded = undefined;
          }
          if (encoded === undefined) throw new Error('CHANGING_PFX');
          if (!encoded || encoded.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('INVALID_PFX');
          pfx = Buffer.from(encoded, 'base64');
          if (cachedConfiguration?.key === key && cachedConfiguration.config.certificate.validated && cachedConfiguration.config.pfx?.equals(pfx)) {
            const { configured: _configured, validated: _validated, ...metadata } = cachedConfiguration.config.certificate;
            certificateMetadata = metadata;
          } else {
            const context = tls.createSecureContext({ pfx, passphrase, minVersion: 'TLSv1.2' });
            certificateMetadata = loadedCertificateMetadata(context);
          }
          validated = true;
        } catch {
          // Errors are not cached: the next call must detect recovery, changed
          // file access, or a restored certificate without needing a restart.
          if (cachedConfiguration?.key === key) cachedConfiguration = undefined;
          issues.push('Klientcertifikatet kunde inte läsas eller öppnas. Kontrollera base64-filen och lösenordet.');
        }
      }
    }
    const ready = ['mock', 'test'].includes(mode) && !missing.length && !issues.length;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const secrets = [clientId, clientSecret, passphrase, secretFile, basic].filter(Boolean);
    const fingerprint = createHash('sha256').update(JSON.stringify([mode, apiBaseUrl, tokenUrl, clientId, clientSecret, passphrase, systemId])).update(pfx || Buffer.alloc(0)).digest('hex');
    const config = { mode, apiBaseUrl, tokenUrl, systemId, clientId, clientSecret, passphrase, pfx, basic, secrets, fingerprint, ready, missing, issues, certificate: { configured: Boolean(secretFile), validated, ...certificateMetadata } };
    if (!issues.length && configurationInput().key === key) cachedConfiguration = { key, identity, config };
    return config;
  }

  async function configuration({ forceFileRead = false } = {}) {
    // Capture one coherent environment version before asynchronous filesystem
    // work. A concurrent rotation must not rewrite an in-flight check's identity.
    const input = configurationInput(), loadKey = `${input.key}:${forceFileRead}`;
    let pending = configurationLoads.get(loadKey);
    if (!pending) {
      pending = loadConfiguration(input, forceFileRead);
      configurationLoads.set(loadKey, pending);
    }
    try {
      const config = await pending;
      return { ...config, secrets: [...config.secrets, ...(cachedToken?.value ? [cachedToken.value] : [])] };
    } finally {
      if (configurationLoads.get(loadKey) === pending) configurationLoads.delete(loadKey);
    }
  }

  function publicConfiguration(config) {
    return { mode: ['mock', 'test', 'disabled'].includes(config.mode) ? config.mode : 'invalid', enabled: ['mock', 'test'].includes(config.mode), ready: config.ready, apiBaseUrl: NVV_TEST_API_URL, tokenUrl: NVV_TEST_TOKEN_URL, systemId: safeValue(config.systemId || null, config.secrets), missing: [...config.missing], issues: [...config.issues], certificate: safeValue(config.certificate, config.secrets) };
  }

  async function token(config, force = false) {
    if (!force && cachedToken?.fingerprint === config.fingerprint && cachedToken.until > clock(now)) return cachedToken.value;
    if (tokenPromise?.fingerprint === config.fingerprint) return tokenPromise.promise;
    const pending = { fingerprint: config.fingerprint };
    pending.promise = (async () => {
      const response = await request({ url: config.tokenUrl, method: 'POST', headers: { Authorization: `Basic ${config.basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: 'grant_type=client_credentials', pfx: config.pfx, passphrase: config.passphrase, timeoutMs: 20_000 });
      const body = parseBody(response.body);
      const seconds = Number(body?.expires_in);
      // Even a malformed token response can echo its token in an error field.
      if (typeof body?.access_token === 'string' && body.access_token.length <= 16384) knownTokens.add(body.access_token);
      if (knownTokens.size > 64) knownTokens.delete(knownTokens.values().next().value);
      if (statusCode(response) !== 200 || typeof body?.access_token !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(body.access_token) || !Number.isFinite(seconds) || seconds <= 0 || (body.token_type && String(body.token_type).toLowerCase() !== 'bearer')) throw Object.assign(new Error('NVV_AUTH_FAILED'), { nvvStatusCode: statusCode(response), nvvResponseBody: body });
      cachedToken = { value: body.access_token, fingerprint: config.fingerprint, until: clock(now) + seconds * 1000 - Math.min(30_000, seconds * 100) };
      return cachedToken.value;
    })();
    tokenPromise = pending;
    try { return await pending.promise; } finally { if (tokenPromise === pending) tokenPromise = null; }
  }

  async function call(config, { method, path, payload, trackingId }) {
    let bearer;
    const authenticationFailure = cause => ({ authError: true, statusCode: cause?.nvvStatusCode ?? null, body: cause?.nvvResponseBody ?? null });
    try { bearer = await token(config); } catch (cause) { return authenticationFailure(cause); }
    const execute = async (value) => request({ url: `${config.apiBaseUrl}${path}`, method, headers: { Authorization: `Bearer ${value}`, 'NV-Client-System-ID': config.systemId, 'NV-Client-Tracking-ID': trackingId, Accept: 'application/json', ...(payload !== undefined ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload), pfx: config.pfx, passphrase: config.passphrase, timeoutMs: 20_000 });
    try {
      let response = await execute(bearer);
      if (statusCode(response) === 401) {
        const previousResponse = response;
        cachedToken = null;
        try { bearer = await token(config, true); } catch (cause) { return { ...authenticationFailure(cause), previousResponse }; }
        response = { ...await execute(bearer), previousResponse };
      }
      return response;
    } catch { return { networkError: true }; }
  }

  function unavailable(config, trackingId) {
    return { outcome: 'rejected', mode: publicConfiguration(config).mode, httpStatus: null, trackingId: safeValue(trackingId, config.secrets), response: null, error: error(config.mode === 'disabled' ? 'NVV_DISABLED' : 'NVV_CONFIGURATION', config.mode === 'disabled' ? 'NVV-anslutningen är avstängd.' : 'NVV TEST är inte färdigkonfigurerat.', [...config.missing, ...config.issues]) };
  }

  function normalized(config, result, trackingId, { write = false } = {}) {
    const httpStatus = statusCode(result);
    const meta = {};
    const parsed = parseBody(result?.body);
    const secrets = [...config.secrets, ...knownTokens, ...(typeof parsed?.access_token === 'string' ? [parsed.access_token] : [])];
    const response = safeValue(parsed, secrets, 0, meta);
    const echoed = result?.headers?.['nv-client-tracking-id'] ?? result?.headers?.['NV-Client-Tracking-ID'];
    const safeTracking = safeValue(typeof echoed === 'string' && /^[\x20-\x7e]{1,200}$/.test(echoed) ? echoed : trackingId, secrets);
    const base = { mode: config.mode, httpStatus, trackingId: safeTracking, response, ...(meta.truncated ? { responseTruncated: true } : {}) };
    if (result?.authError) return { ...base, outcome: 'rejected', error: error('NVV_AUTHENTICATION', 'Autentisering mot Naturvårdsverket misslyckades.') };
    if (result?.networkError || !httpStatus) return { ...base, outcome: 'unknown', error: error('NVV_UNKNOWN_OUTCOME', write ? 'Svaret från Naturvårdsverket saknas. Avstämning krävs före nytt utskick.' : 'Naturvårdsverket kunde inte nås.') };
    if (write && httpStatus === 408) return { ...base, outcome: 'unknown', error: error('NVV_UNKNOWN_OUTCOME', 'Naturvårdsverket svarade med timeout. Avstämning krävs före nytt utskick.') };
    if (httpStatus >= 400 && httpStatus < 500) {
      const errors = Array.isArray(response?.errors) ? response.errors : Array.isArray(response?.Errors) ? response.Errors : undefined;
      const codes = [response?.code, response?.Code, ...(errors ?? []).flatMap(item => [item?.code, item?.Code])];
      const identityMismatch = codes.some(value => (typeof value === 'string' || typeof value === 'number') && String(value).trim() === '1023');
      const providerMessage = typeof response?.message === 'string' ? response.message : typeof response?.Message === 'string' ? response.Message : 'Naturvårdsverket avvisade begäran.';
      return { ...base, outcome: 'rejected', error: error(identityMismatch ? 'NVV_REPORTER_IDENTITY' : httpStatus === 401 || httpStatus === 403 ? 'NVV_AUTHENTICATION' : 'NVV_VALIDATION',
        identityMismatch ? 'NVV kunde inte matcha verksamhetsutövaren eller ombudet mot rapportörens organisationsnummer. Kontrollera klientcertifikatets identitet och rapporteringsrollen.' : providerMessage, errors) };
    }
    if (write) {
      const id = httpStatus === 200 ? response?.avfallId : httpStatus === 201 ? response?.AvfallsId : undefined;
      if (typeof id === 'string' && uuid.test(id)) return { ...base, outcome: 'accepted', avfallId: id };
      return { ...base, outcome: 'unknown', error: error('NVV_UNKNOWN_OUTCOME', 'Svaret innehåller ingen verifierbar kvittens. Avstämning krävs före nytt utskick.') };
    }
    if (httpStatus === 200 && response !== null && typeof response === 'object' && !meta.truncated) return { ...base, outcome: 'accepted' };
    return { ...base, outcome: 'unknown', error: error('NVV_INVALID_RESPONSE', 'Ett oväntat svar kom från Naturvårdsverket.') };
  }

  function validTracking(value) { return typeof value === 'string' && /^[\x20-\x7e]{1,200}$/.test(value) ? value : randomUUID(); }

  async function status() { return publicConfiguration(await configuration()); }

  // Server-internal only: bind persisted checks to the same configuration that
  // was read and used. These descriptors must never be included in HTTP DTOs.
  async function configurationSnapshot() {
    const config = await configuration();
    return { status: publicConfiguration(config), configurationId: config.fingerprint };
  }

  async function checkConfigured(config) {
    const checkedAt = iso(now), diagnostics = [];
    const base = { ...publicConfiguration(config), checkedAt, diagnostics };
    if (!config.ready) return { ...base, connected: false, wasteCodes: [], transportModes: [], error: unavailable(config).error };
    if (config.mode === 'mock') return { ...base, connected: true, simulated: true, wasteCodes: [{ code: '160601', description: 'Blybatterier', hazardous: true }], transportModes: [{ code: 'R', description: 'Vägtransport' }] };
    const excerpt = (value, depth = 0) => {
      if (depth > 4) return '[sammanfattat]';
      if (typeof value === 'string') return value.slice(0, 800);
      if (Array.isArray(value)) return value.slice(0, 8).map(item => excerpt(item, depth + 1));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key, excerpt(item, depth + 1)]));
      return value ?? null;
    };
    const record = (result, path, trackingId, summary) => {
      if (result.previousResponse) record(result.previousResponse, path, trackingId);
      const normalizedResult = normalized(config, result, result.authError ? undefined : trackingId);
      diagnostics.push({ method: result.authError ? 'POST' : 'GET', path: result.authError ? '/oauth2/token' : path,
        httpStatus: normalizedResult.httpStatus, ...(normalizedResult.trackingId && !result.authError && { trackingId: normalizedResult.trackingId }),
        outcome: result.authError && !(normalizedResult.httpStatus >= 400 && normalizedResult.httpStatus < 500) ? 'unknown' : normalizedResult.outcome,
        response: summary ?? excerpt(normalizedResult.response) });
      return normalizedResult;
    };
    const wasteTracking = randomUUID();
    const wasteResult = await call(config, { method: 'GET', path: '/avfallstyper', trackingId: wasteTracking });
    const waste = normalized(config, wasteResult, wasteTracking);
    if (waste.outcome !== 'accepted') { record(wasteResult, '/avfallstyper', wasteTracking); return { ...base, connected: false, wasteCodes: [], transportModes: [], error: waste.error }; }
    // Read the complete raw lists here; diagnostics retain only a labelled excerpt.
    const wasteCodes = []; let batteryExample = null;
    const visit = (items) => { for (const item of Array.isArray(items) ? items : []) { if (typeof item?.kod === 'string') {
      wasteCodes.push({ code: safeValue(item.kod, [...config.secrets, ...knownTokens]), description: safeValue(String(item.beskrivning || ''), [...config.secrets, ...knownTokens]), hazardous: item.farligt === true || ['true', 'ja', '*'].includes(String(item.farligt).toLowerCase()) || (typeof item.ewc === 'string' && item.ewc.includes('*')) });
      if (item.kod === '160601') batteryExample = excerpt(safeValue({ kod: item.kod, beskrivning: item.beskrivning ?? null, farligt: item.farligt ?? null, ...(item.ewc && { ewc: item.ewc }) }, [...config.secrets, ...knownTokens]));
    } visit(item?.avfallstyper); } };
    visit(parseBody(wasteResult.body));
    record(wasteResult, '/avfallstyper', wasteTracking, { summary: 'Sammanfattat utdrag ur NVV:s kodlista.', count: wasteCodes.length, sixDigitCodes: wasteCodes.filter(item => /^\d{6}$/.test(item.code)).length, example: batteryExample });
    const transportTracking = randomUUID();
    const transportResult = await call(config, { method: 'GET', path: '/transportsatt', trackingId: transportTracking });
    const transport = normalized(config, transportResult, transportTracking);
    if (transport.outcome !== 'accepted') { record(transportResult, '/transportsatt', transportTracking); return { ...base, connected: false, wasteCodes, transportModes: [], error: transport.error }; }
    const transportModes = (Array.isArray(transport.response) ? transport.response : []).filter((item) => typeof item?.transportsatt === 'string').map((item) => ({ code: item.transportsatt, description: String(item.beskrivning || '') }));
    record(transportResult, '/transportsatt', transportTracking, { summary: 'Sammanfattat utdrag ur NVV:s transportsätt.', count: transportModes.length,
      items: (Array.isArray(transport.response) ? transport.response : []).slice(0, 8).map(item => excerpt({ transportsatt: item.transportsatt, beskrivning: item.beskrivning ?? null })) });
    const connected = wasteCodes.some((item) => item.code === '160601') && transportModes.some((item) => item.code === 'R');
    return { ...base, connected, wasteCodes, transportModes, ...(!connected ? { error: error('NVV_REFERENCE_DATA', 'Kodlistorna saknar blybatterier 160601 eller vägtransport R.') } : {}) };
  }

  async function checkWithConfiguration() {
    const config = await configuration({ forceFileRead: true });
    return { result: await checkConfigured(config), configurationId: config.fingerprint };
  }

  async function check() { return (await checkWithConfiguration()).result; }

  async function submit({ method, path, payload, trackingId } = {}) {
    const config = await configuration({ forceFileRead: true });
    trackingId = validTracking(trackingId);
    if (!config.ready) return unavailable(config, trackingId);
    const mockCorrection = config.mode === 'mock' && method === 'PUT' && typeof path === 'string' && path.startsWith('/insamlingar/SIM-') && uuid.test(path.slice('/insamlingar/SIM-'.length));
    if (!((method === 'POST' && path === '/insamlingar') || (method === 'PUT' && receiptPath.test(path || '')) || mockCorrection)) return { outcome: 'rejected', mode: config.mode, httpStatus: null, trackingId, response: null, error: error('NVV_OPERATION_DISABLED', 'Denna etapp stöder endast mottagning och rättelse av mottagning i TEST.') };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { outcome: 'rejected', mode: config.mode, httpStatus: null, trackingId, response: null, error: error('NVV_PAYLOAD', 'Rapportunderlaget saknas.') };
    if (config.mode === 'mock') {
      const avfallId = `SIM-${randomUUID()}`;
      const snapshot = structuredClone(payload);
      mockRecords.set(avfallId, { ...snapshot, avfall: { ...snapshot.avfall, avfallId }, avfallId, payload: snapshot, recordedAt: iso(now), simulated: true });
      return { outcome: 'accepted', mode: 'mock', simulated: true, httpStatus: 200, trackingId, avfallId, response: { avfallId, simulated: true } };
    }
    return normalized(config, await call(config, { method, path, payload, trackingId }), trackingId, { write: true });
  }

  async function read({ avfallId, from, to } = {}) {
    const config = await configuration({ forceFileRead: true });
    const trackingId = randomUUID();
    if (!config.ready) return unavailable(config, trackingId);
    if (config.mode === 'mock') return { outcome: 'accepted', mode: 'mock', simulated: true, httpStatus: 200, trackingId, response: avfallId ? mockRecords.get(avfallId) || null : { anteckningar: [...mockRecords.values()], simulated: true } };
    if (avfallId && !uuid.test(avfallId)) return { outcome: 'rejected', mode: 'test', httpStatus: null, trackingId, response: null, error: error('NVV_IDENTIFIER', 'Avfalls-ID är inte giltigt.') };
    const query = new URLSearchParams();
    for (const [key, value] of [['DatumTidFran', from], ['DatumTidTom', to]]) if (value !== undefined) {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return { outcome: 'rejected', mode: 'test', httpStatus: null, trackingId, response: null, error: error('NVV_DATE', 'Datumintervallet är inte giltigt.') };
      query.set(key, value);
    }
    const path = avfallId ? `/anteckningar/${avfallId}` : `/anteckningar${query.size ? `?${query}` : ''}`;
    return normalized(config, await call(config, { method: 'GET', path, trackingId }), trackingId);
  }

  return { status, check, submit, read, configurationSnapshot, checkWithConfiguration };
}
