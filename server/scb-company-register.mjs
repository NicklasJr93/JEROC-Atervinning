import { z } from 'zod';
import { customerIdentifierError, normalizeOrganisationNumber } from '../dist-server/domain-models.mjs';
import { EnvironmentError } from './environment-storage.mjs';

// Fixed upstream: callers cannot select a URL, headers, fields or a collection
// search. The API key stays on the server and is never part of a response.
export const SCB_API_BASE = 'https://apiafr.scb.se/v1';
const MAX_RESPONSE_BYTES = 64 * 1024;
const field = max => z.string().max(max).optional();
const code = z.union([z.string().max(12), z.number().int().min(0).max(999999)]).optional();
const recordSchema = z.object({
  orgNr: z.string().regex(/^\d{10}$/),
  peOrgNr: z.string().regex(/^16\d{10}$/),
  namn: z.string().trim().min(1).max(200),
  postAdress: z.object({
    gatuAdress: field(512), coAdress: field(256), postNr: field(5), postOrt: field(30),
  }).optional(),
  ftgStat: code, jurform: field(2), momsStat: code, fSkattStat: code,
});

export class ScbCompanyRegisterError extends EnvironmentError {
  constructor(message, status = 503, code = 'company_lookup_unavailable') {
    super(message, status, code);
    this.name = 'ScbCompanyRegisterError';
  }
}

const fail = (message, status, code) => { throw new ScbCompanyRegisterError(message, status, code); };
const invalidResponse = () => fail('Företagsregistret gav ett oväntat svar. Försök igen senare eller fyll i uppgifterna manuellt.', 502, 'company_lookup_response_invalid');
const clean = value => (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const registrationStatus = value => ['1', '3'].includes(String(value)) ? true : ['0', '9'].includes(String(value)) ? false : undefined;

function companyNumber(input) {
  if (typeof input !== 'string' || input.length > 40)
    fail('Ange ett giltigt svenskt organisationsnummer med tio siffror.', 422, 'company_lookup_invalid');
  const number = normalizeOrganisationNumber(input);
  // BRF validation accepts legal entities only. Företag intentionally also
  // accepts a sole trader's personal number elsewhere in the application.
  if (customerIdentifierError('BRF', number))
    fail('Ange ett giltigt organisationsnummer med tio siffror. Personnummer och enskild firma omfattas inte av detta företagsuppslag.', 422, 'company_lookup_invalid');
  return number;
}

async function readRecord(response, signal) {
  const contentLength = response.headers?.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    invalidResponse();
  }
  if (!response.body || typeof response.body.getReader !== 'function') invalidResponse();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) invalidResponse();
      chunks.push(Buffer.from(value));
    }
    let record;
    try { record = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { invalidResponse(); }
    const parsed = recordSchema.safeParse(record);
    if (!parsed.success) invalidResponse();
    return parsed.data;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// The timeout also covers a response whose headers arrive but whose body stalls.
function readWithSignal(reader, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Exact, read-only legal-entity lookup. A successful lookup never saves a
 * customer, changes tax rules or proves that a person represents the company.
 * Caller owns authentication, permissions and the shared SCB request limiter.
 */
export function createScbCompanyRegister({ env = process.env, fetchImpl = fetch, now = () => new Date(), timeoutMs = 8000 } = {}) {
  const apiKey = typeof env.SCB_API_KEY === 'string' ? env.SCB_API_KEY.trim() : '';
  const configured = Boolean(apiKey);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid company lookup timeout.');

  async function lookup(input, { signal: callerSignal } = {}) {
    const organisationNumber = companyNumber(input);
    if (!configured)
      fail('Företagsuppslaget är inte aktiverat ännu. Uppgifterna kan fyllas i manuellt.', 503, 'company_lookup_not_configured');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      signal.throwIfAborted();
      // SCB's PeOrgNr is a 12-position identity; legal entities use prefix 16.
      const response = await fetchImpl(`${SCB_API_BASE}/juridiskaenheter/16${organisationNumber}/full`, {
        method: 'GET', headers: { Accept: 'application/json', 'X-API-Key': apiKey }, redirect: 'error', signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 404)
          fail('Ingen träff hittades för organisationsnumret. Kontrollera numret eller fyll i uppgifterna manuellt.', 404, 'company_lookup_not_found');
        if (response.status === 429)
          fail('Företagsregistret får många förfrågningar. Vänta en stund och försök igen.', 429, 'company_lookup_rate_limited');
        fail('Företagsregistret kan inte nås just nu. Försök igen senare eller fyll i uppgifterna manuellt.', 503, 'company_lookup_unavailable');
      }
      const record = await readRecord(response, signal);
      // Never apply a hit for a different identity, even if a provider/proxy
      // accidentally returns another company's otherwise valid record.
      if (record.orgNr !== organisationNumber || record.peOrgNr !== `16${organisationNumber}`) invalidResponse();
      const statusCode = record.ftgStat === undefined ? undefined : String(record.ftgStat);
      const status = ({ '1': 'active', '0': 'never_active', '9': 'inactive' })[statusCode] ?? 'unknown';
      const vatRegistered = registrationStatus(record.momsStat);
      const fTaxRegistered = record.fSkattStat === undefined ? undefined
        : String(record.fSkattStat) === '1' ? true : ['0', '9'].includes(String(record.fSkattStat)) ? false : undefined;
      const address = record.postAdress ?? {};
      if (address.postNr && !/^\d{5}$/.test(address.postNr)) invalidResponse();
      return {
        organisationNumber, name: clean(record.namn), address: clean(address.gatuAdress),
        postalCode: address.postNr ?? '', city: clean(address.postOrt), countryCode: 'SE',
        ...(clean(address.coAdress) ? { careOf: clean(address.coAdress) } : {}),
        status, ...(statusCode === undefined ? {} : { statusCode }),
        ...(record.jurform ? { legalFormCode: record.jurform } : {}),
        ...(vatRegistered === undefined ? {} : { vatRegistered }),
        ...(fTaxRegistered === undefined ? {} : { fTaxRegistered }),
        source: 'SCB', fetchedAt: new Date(now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof ScbCompanyRegisterError) throw error;
      if (callerSignal?.aborted)
        fail('Företagsuppslaget avbröts.', 499, 'company_lookup_cancelled');
      // Do not expose raw provider bodies, request paths, key, headers or errors.
      fail('Företagsregistret kan inte nås just nu. Försök igen senare eller fyll i uppgifterna manuellt.', 503, 'company_lookup_unavailable');
    }
  }
  return Object.freeze({ configured, lookup });
}
