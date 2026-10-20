import { z } from 'zod';

export const GOOGLE_ADDRESS_VALIDATION_URL = 'https://addressvalidation.googleapis.com/v1:validateAddress';
const MAX_RESPONSE_BYTES = 64 * 1024;
const clean = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const text = (max, optional = false) => z.string().max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
  .transform(clean).refine(value => optional || value.length > 0);
const inputSchema = z.object({
  address: text(300), postalCode: text(16, true), city: text(200, true),
  countryCode: z.literal('SE'),
}).strict();
export const addressSessionTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,36}$/);

export class GoogleAddressValidationError extends Error {
  constructor(message, status = 503, code = 'address_validation_unavailable') {
    super(message); this.name = 'GoogleAddressValidationError'; this.status = status; this.code = code;
  }
}
const fail = (message, status, code) => { throw new GoogleAddressValidationError(message, status, code); };
const invalidResponse = () => fail('Adresskontrollen gav ett oväntat svar. Fyll i adressen manuellt.', 502, 'address_validation_response_invalid');

export function normalizeAddressValidationInput(value) {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) fail('Ange en svensk adress. Adressen kan också fyllas i manuellt.', 422, 'address_validation_invalid');
  const address = parsed.data;
  if (address.address.length + address.postalCode.length + address.city.length + address.countryCode.length > 280)
    fail('Adressen är för lång för adresskontrollen. Fyll i uppgifterna manuellt.', 422, 'address_validation_invalid');
  if (address.postalCode && !/^\d{3}\s?\d{2}$/.test(address.postalCode))
    fail('Ange ett svenskt postnummer med fem siffror.', 422, 'address_validation_invalid');
  return { ...address, postalCode: address.postalCode.replace(/\s/g, '') };
}

function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function readResult(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {}); invalidResponse();
  }
  if (!response.body || typeof response.body.getReader !== 'function') invalidResponse();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) invalidResponse();
      chunks.push(Buffer.from(value));
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { invalidResponse(); }
    const postal = data?.result?.address?.postalAddress;
    if (!postal || postal.regionCode !== 'SE' || !Array.isArray(postal.addressLines)
      || postal.addressLines.length < 1 || postal.addressLines.length > 4
      || postal.addressLines.some(line => typeof line !== 'string' || line.length > 300)
      || typeof postal.postalCode !== 'string' || typeof postal.locality !== 'string') invalidResponse();
    let address;
    try {
      address = normalizeAddressValidationInput({ address: postal.addressLines.join(', '), postalCode: postal.postalCode,
        city: postal.locality, countryCode: 'SE' });
    } catch { invalidResponse(); }
    if (!address.postalCode || !address.city)
      fail('Hela adressen kunde inte föreslås. Fyll i adress, postnummer och ort manuellt.', 422, 'address_validation_incomplete');
    const verdict = data.result.verdict;
    if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) invalidResponse();
    return { address, verdict: {
      addressComplete: verdict.addressComplete === true,
      hasUnconfirmedComponents: verdict.hasUnconfirmedComponents === true,
      hasInferredComponents: verdict.hasInferredComponents === true,
      hasReplacedComponents: verdict.hasReplacedComponents === true,
      requiresConfirmation: true,
    } };
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A transient, fixed-provider address proposal. It does not save addresses,
 * coordinates, raw Google content or any customer data. The caller must obtain
 * the end user's explicit confirmation/correction before persisting an address.
 */
export function createGoogleAddressValidation({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const apiKey = typeof env.GOOGLE_ADDRESS_VALIDATION_API_KEY === 'string' ? env.GOOGLE_ADDRESS_VALIDATION_API_KEY.trim() : '';
  const configured = Boolean(apiKey);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new TypeError('Invalid address validation timeout.');
  async function validate(value, { signal: callerSignal, sessionToken } = {}) {
    const address = normalizeAddressValidationInput(value);
    if (sessionToken !== undefined && !addressSessionTokenSchema.safeParse(sessionToken).success)
      fail('Adressökningens session är ogiltig. Sök igen.', 422, 'address_validation_invalid');
    if (!configured)
      fail('Adresskontrollen är inte aktiverad ännu. Fyll i adressen manuellt.', 503, 'address_validation_not_configured');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      signal.throwIfAborted();
      const response = await withSignal(fetchImpl(GOOGLE_ADDRESS_VALIDATION_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({ address: { regionCode: 'SE', addressLines: [address.address],
          ...(address.postalCode && { postalCode: address.postalCode }), ...(address.city && { locality: address.city }) },
        ...(sessionToken === undefined ? {} : { sessionToken }) }),
      }), signal);
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 400)
          fail('Adressen kunde inte kontrolleras. Kontrollera uppgifterna eller fyll i dem manuellt.', 422, 'address_validation_invalid');
        if (response.status === 429)
          fail('Adresskontrollen används mycket just nu. Vänta en stund eller fyll i adressen manuellt.', 429, 'address_validation_rate_limited');
        fail('Adresskontrollen kan inte nås just nu. Fyll i adressen manuellt.', 503, 'address_validation_unavailable');
      }
      return await readResult(response, signal);
    } catch (error) {
      if (error instanceof GoogleAddressValidationError) throw error;
      if (callerSignal?.aborted) fail('Adresskontrollen avbröts.', 499, 'address_validation_cancelled');
      fail('Adresskontrollen kan inte nås just nu. Fyll i adressen manuellt.', 503, 'address_validation_unavailable');
    }
  }
  return Object.freeze({ configured, validate });
}
