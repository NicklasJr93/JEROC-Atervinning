import { z } from 'zod';
import { customerIdentifierError, normalizePersonalNumber } from '../dist-server/domain-models.mjs';

export const ROARING_PERSON_BASE = 'https://api.roaring.io/person/2.0';
const TOKEN_URL = 'https://api.roaring.io/token';
const MAX_BODY = 64 * 1024;
export class PersonRegisterError extends Error {
  constructor(message, status = 503, code = 'person_lookup_unavailable', outcome = 'failed', billableConfirmed = false) {
    super(message); this.status = status; this.code = code; this.outcome = outcome; this.billableConfirmed = billableConfirmed;
  }
}
const invalid = () => new PersonRegisterError('Ange ett giltigt personnummer med tolv siffror, inklusive århundrade.', 422, 'person_lookup_invalid', 'rejected');
const manual = () => new PersonRegisterError('Uppgifterna kan inte fyllas i automatiskt. Fyll i dem manuellt så hjälper personalen dig.', 409, 'person_lookup_manual_required', 'rejected', true);
const unavailable = outcome => new PersonRegisterError('Personuppslaget kunde inte genomföras. Fyll i uppgifterna manuellt eller försök igen senare.', 503, 'person_lookup_unavailable', outcome);
const responseInvalid = () => new PersonRegisterError('Personregistret gav ett oväntat svar. Fyll i uppgifterna manuellt.', 502, 'person_lookup_response_invalid', 'unknown');
const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const dateKey = now => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

export function normalizePersonLookupNumber(input, now = new Date()) {
  if (typeof input !== 'string' || input.length > 40 || !/^[\d\s+-]+$/.test(input)) throw invalid();
  const compact = input.normalize('NFKC').trim().replace(/\s/g, '');
  if (!/^(?:\d{10}|\d{12}|\d{6}[-+]\d{4}|\d{8}[-+]\d{4})$/.test(compact)) throw invalid();
  const number = normalizePersonalNumber(compact);
  if (/^\d{10}$/.test(number))
    throw new PersonRegisterError('Ange även århundradet: personnumret behöver tolv siffror för uppslag.', 422, 'person_lookup_century_required', 'rejected');
  if (!/^\d{12}$/.test(number) || customerIdentifierError('Privatperson', number)) throw invalid();
  if (Number(number.slice(6, 8)) > 60)
    throw new PersonRegisterError('Samordningsnummer fylls i manuellt i detta steg.', 409, 'person_lookup_manual_required', 'rejected');
  const birthday = `${number.slice(0, 4)}-${number.slice(4, 6)}-${number.slice(6, 8)}`;
  if (birthday > dateKey(now)) throw invalid();
  return number;
}

async function boundedJson(response, signal, max = MAX_BODY) {
  if (!response.body?.getReader || Number(response.headers.get('content-length')) > max) {
    void response.body?.cancel().catch(() => {}); throw responseInvalid();
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else reader.read().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      if (done) break;
      size += value.byteLength; if (size > max) throw responseInvalid(); chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { throw responseInvalid(); }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const discard = response => { void response.body?.cancel().catch(() => {}); };
const currentRows = (rows, today) => Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object'
  && (!row.dateFrom || /^\d{4}-\d{2}-\d{2}$/.test(row.dateFrom) && row.dateFrom <= today)
  && (row.dateTo === '9999-12-31' || !row.dateTo && rows.length === 1)) : [];
const isProtected = row => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
  if (row.protectedRegistration !== undefined && typeof row.protectedRegistration !== 'boolean') return true;
  if (row.secrecy !== undefined && (!row.secrecy || typeof row.secrecy !== 'object' || Array.isArray(row.secrecy))) return true;
  for (const key of ['secrecy', 'secrecySetBySpar'])
    if (row.secrecy?.[key] !== undefined && typeof row.secrecy[key] !== 'boolean') return true;
  return row.protectedRegistration === true || row.secrecy?.secrecy === true || row.secrecy?.secrecySetBySpar === true;
};

function personResult(payload, number, now) {
  if (!payload || ![0, 1].includes(payload.status?.code)) throw responseInvalid();
  if (payload.status.code === 1) {
    if (payload.records !== undefined && (!Array.isArray(payload.records) || payload.records.length)) throw responseInvalid();
    throw new PersonRegisterError('Ingen personträff hittades. Fyll i uppgifterna manuellt.', 404, 'person_lookup_not_found', 'not_found', true);
  }
  if (!Array.isArray(payload.records) || payload.records.length !== 1 || payload.records[0]?.personId !== number) throw responseInvalid();
  const row = payload.records[0], today = dateKey(now);
  if (row.details !== undefined && !Array.isArray(row.details)) throw manual();
  if (isProtected(row) || (row.details ?? []).some(value => isProtected(value)
    || clean(value?.death?.deathDate) || clean(value?.death?.foundDeadDate)
    || clean(value?.deRegistrationReasonCode) || clean(value?.deRegistrationDate))) throw manual();
  const names = currentRows(row.name, today), addresses = currentRows(row.populationRegistrationAddress, today);
  if (names.length !== 1 || addresses.length !== 1) throw manual();
  const name = names[0], address = addresses[0].swedishAddress;
  if (!address || addresses[0].internationalAddress) throw manual();
  const fullName = [clean(name.firstName), clean(name.middleName), clean(name.surName)].filter(Boolean).join(' ');
  // Roaring documents deliveryAddress2 as the primary street line. Keep the
  // additional line, if present, rather than guessing a different address.
  const street = [...new Set([clean(address.deliveryAddress2), clean(address.deliveryAddress1)].filter(Boolean))].join(', ');
  const postalCode = clean(address.zipCode).replace(/\s/g, ''), city = clean(address.city), careOf = clean(address.coAddress);
  if (!fullName || fullName.length > 200 || !street || street.length > 300 || !/^\d{5}$/.test(postalCode)
    || !city || city.length > 200 || careOf.length > 256) throw manual();
  return { personalNumber: number, name: fullName, address: street, ...(careOf ? { careOf } : {}),
    postalCode, city, countryCode: 'SE', source: 'Roaring', fetchedAt: new Date(now).toISOString() };
}

/** Fixed-origin current-record lookup. OAuth and tokens remain server-only.
 * beforeDispatch is invoked after OAuth, immediately before ONE provider GET;
 * the caller uses it to atomically meter that attempt. No automatic retries. */
export function createRoaringPersonRegister({ env = process.env, fetchImpl = fetch, now = () => new Date(), timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid person lookup timeout.');
  const key = typeof env.ROARING_CONSUMER_KEY === 'string' ? env.ROARING_CONSUMER_KEY.trim() : '';
  const secret = typeof env.ROARING_CONSUMER_SECRET === 'string' ? env.ROARING_CONSUMER_SECRET.trim() : '';
  let cached, tokenFlight, closed = false;
  const shutdown = new AbortController();
  const tokenSchema = z.object({ access_token: z.string().min(1).max(8192), token_type: z.string().regex(/^Bearer$/i), expires_in: z.number().int().positive().max(86400) });
  const token = async () => {
    if (cached && cached.expiresAt > new Date(now()).getTime() + 30_000) return cached.value;
    if (!tokenFlight) {
      tokenFlight = (async () => {
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs)]);
        const response = await fetchImpl(TOKEN_URL, { method: 'POST', redirect: 'error', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
          body: 'grant_type=client_credentials' });
        if (response.status !== 200) { discard(response); throw unavailable('rejected'); }
        const parsed = tokenSchema.safeParse(await boundedJson(response, signal, 16 * 1024));
        if (!parsed.success) throw unavailable('rejected');
        cached = { value: parsed.data.access_token, expiresAt: new Date(now()).getTime() + Math.min(3600, parsed.data.expires_in) * 1000 };
        return cached.value;
      })().catch(() => { throw unavailable('rejected'); }).finally(() => { tokenFlight = undefined; });
    }
    return tokenFlight;
  };
  return Object.freeze({ configured: Boolean(key && secret), close() { closed = true; cached = undefined; shutdown.abort(); }, async lookup(input, { signal: callerSignal, beforeDispatch } = {}) {
    const number = normalizePersonLookupNumber(input, now());
    if (closed) throw unavailable('rejected');
    if (!key || !secret) throw new PersonRegisterError('Personuppslaget är inte aktiverat. Fyll i uppgifterna manuellt.', 503, 'person_lookup_not_configured', 'rejected');
    const signal = AbortSignal.any([shutdown.signal, ...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(timeoutMs)]);
    let dispatched = false;
    try {
      signal.throwIfAborted();
      const accessToken = await token();
      signal.throwIfAborted();
      await beforeDispatch?.();
      dispatched = true;
      const response = await fetchImpl(`${ROARING_PERSON_BASE}/current/${number}`, {
        method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      });
      if (response.status !== 200) {
        discard(response);
        if (response.status === 401) cached = undefined;
        if (response.status === 404) throw new PersonRegisterError('Ingen personträff hittades. Fyll i uppgifterna manuellt.', 404, 'person_lookup_not_found', 'not_found', true);
        throw unavailable('failed');
      }
      return personResult(await boundedJson(response, signal), number, now());
    } catch (error) {
      if (error instanceof PersonRegisterError) throw error;
      // Authorization/metering errors before dispatch keep their typed safe
      // status. They must prevent both the provider GET and its charge.
      if (!dispatched && Number.isInteger(error?.status)) throw error;
      if (callerSignal?.aborted) throw new PersonRegisterError('Personuppslaget avbröts.', 499, 'person_lookup_cancelled', dispatched ? 'unknown' : 'rejected');
      throw unavailable(dispatched ? 'unknown' : 'rejected');
    }
  } });
}
