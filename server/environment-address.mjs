import { z } from 'zod';
import municipalities from './data/environment-municipalities.json' with { type: 'json' };
import { EnvironmentError } from './environment-storage.mjs';

/** SCB's four-digit municipal regions, never inferred from postal codes. */
export const ENVIRONMENT_MUNICIPALITIES = Object.freeze(municipalities.municipalities.map((entry) => Object.freeze(entry)));
export const ENVIRONMENT_MUNICIPALITIES_SOURCE = Object.freeze(municipalities.source);
const municipalityByCode = new Map(ENVIRONMENT_MUNICIPALITIES.map((entry) => [entry.code, entry]));
const normalize = (value = '') => (typeof value === 'string' ? value : '').normalize('NFKC').toLocaleLowerCase('sv-SE').replaceAll(/\s+/g, ' ').trim();
const municipalityName = (value = '') => normalize(value).replace(/ kommun$/, '').trim();
const municipalityByName = new Map(ENVIRONMENT_MUNICIPALITIES.map((entry) => [municipalityName(entry.name), entry]));
const municipalityForName = (value) => {
  const name = municipalityName(value);
  return municipalityByName.get(name) ?? (/s$/.test(name) ? municipalityByName.get(name.slice(0, -1)) : undefined);
};
const trimSeparators = (value) => value.replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
const postal = (value = '') => String(value).replaceAll(' ', '');
const schema = z.object({
  originAddress: z.string().trim().max(300),
  municipalityCode: z.string().trim().max(4).optional(),
  municipalityName: z.string().trim().max(100).optional(),
}).strict();

/** Parse only the card's origin. A customer's postal/billing address is never a fallback. */
export function parseOriginAddress(originAddress) {
  const origin = String(originAddress ?? '').trim().replace(/,?\s+(?:Sverige|Sweden)$/i, '').trim();
  const postMatch = /(?:^|[\s,;])(\d{3}\s?\d{2})(?=$|[\s,;])/.exec(origin);
  if (postMatch) {
    const postStart = postMatch.index + postMatch[0].indexOf(postMatch[1]);
    return {
      address: trimSeparators(origin.slice(0, postStart)), postalCode: postal(postMatch[1]),
      city: trimSeparators(origin.slice(postStart + postMatch[1].length)), municipalityCode: '',
    };
  }
  const parts = origin.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  return {
    address: parts.length > 1 ? parts.slice(0, -1).join(', ') : origin,
    postalCode: '', city: parts.length > 1 ? parts.at(-1) : '', municipalityCode: '',
  };
}

const DEMO_REFERENCES = [
  { address: 'Industrivägen 8', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
  { address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
];

function demoReference(place) {
  return DEMO_REFERENCES.find((record) => normalize(record.address) === normalize(place.address)
    && normalize(record.city) === normalize(place.city)
    && (!place.postalCode || record.postalCode === place.postalCode));
}

/** A deliberate address lookup, not autocomplete. Nominatim permits at most one
 * public request per second; the shared scheduler also bounds queue and duration. */
export function createNominatimAddressSearch({ fetchImpl = (...args) => fetch(...args), timeoutMs = 5000,
  intervalMs = 1100, maxPending = 4, now = Date.now, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let tail = Promise.resolve(), pending = 0, lastStarted = -Infinity;
  return (originAddress) => {
    if (pending >= maxPending) return Promise.reject(new Error('Adressökningen är upptagen.'));
    pending += 1;
    const deadline = now() + timeoutMs;
    const task = tail.catch(() => {}).then(async () => {
      const delay = Math.max(0, intervalMs - (now() - lastStarted));
      if (deadline - now() <= delay) throw new Error('Adressökningen tog för lång tid.');
      if (delay) await wait(delay);
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('Adressökningen tog för lång tid.');
      const controller = new AbortController();
      let timeout;
      const timedOut = new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Adressökningen tog för lång tid.')); }, remaining);
      });
      lastStarted = now();
      try {
        const query = new URLSearchParams({ q: `${originAddress}, Sverige`, countrycodes: 'se',
          format: 'jsonv2', addressdetails: '1', limit: '5' });
        const request = (async () => {
          const response = await fetchImpl(`https://nominatim.openstreetmap.org/search?${query}`, {
            signal: controller.signal, redirect: 'error',
            headers: { Accept: 'application/json', 'User-Agent': 'JEROC address confirmation demo (https://jeroc-atervinning.onrender.com)' },
          });
          if (!response.ok) throw new Error('Adressökningen är tillfälligt otillgänglig.');
          const result = await response.json();
          if (!Array.isArray(result) || result.length > 20) throw new Error('Adressökningen gav ett ogiltigt svar.');
          return result;
        })();
        return await Promise.race([request, timedOut]);
      } finally { clearTimeout(timeout); }
    });
    tail = task.then(() => {}, () => {});
    return task.finally(() => { pending -= 1; });
  };
}

const defaultSearch = createNominatimAddressSearch();
const validPostal = (value) => /^\d{5}$/.test(value);
const requiredPlaceFields = (place) => ['address', 'postalCode', 'city'].filter((field) => !place[field]
  || (field === 'postalCode' && !validPostal(place[field])));
const streetParts = (value) => {
  const match = /^(.*?)\s+(\d+(?:\s?[a-zåäö])?(?:[-/]\d+)?)$/i.exec(value);
  return match ? { road: normalize(match[1]), houseNumber: normalize(match[2]).replaceAll(' ', '') } : null;
};

function candidatePlace(candidate, original) {
  if (!candidate || typeof candidate !== 'object' || !candidate.address || typeof candidate.address !== 'object') return null;
  const source = candidate.address;
  if (normalize(source.country_code) !== 'se') return null;
  const road = typeof source.road === 'string' ? source.road : typeof source.pedestrian === 'string' ? source.pedestrian : '';
  const houseNumber = typeof source.house_number === 'string' ? source.house_number : '';
  const parts = streetParts(original.address);
  if (!parts || parts.road !== normalize(road) || parts.houseNumber !== normalize(houseNumber).replaceAll(' ', '')) return null;
  const code = postal(source.postcode), city = [source.city, source.town, source.village, source.hamlet].find((value) => typeof value === 'string' && value.trim());
  if (!validPostal(code) || !city) return null;
  if (original.postalCode && original.postalCode !== code) return null;
  if (original.city && normalize(original.city) !== normalize(city)) return null;
  // A settlement's name alone is not sufficient evidence of its municipality.
  const explicitMunicipality = [source.municipality, source.county].find((value) => typeof value === 'string'
    && (value === source.municipality || / kommun$/i.test(value)));
  const municipality = explicitMunicipality && municipalityForName(explicitMunicipality);
  return {
    place: { address: original.address, postalCode: code, city: city.trim(), municipalityCode: municipality?.code ?? '' },
    municipality,
  };
}

/** Resolve a canonical origin safely. Network errors and ambiguous results ask
 * for just the unresolved address/municipality, never silently pick result 0. */
export function createEnvironmentAddressResolver({ search = defaultSearch, now = Date.now, demoReferences = true,
  cacheAgeMs = 24 * 60 * 60 * 1000, cacheLimit = 500,
} = {}) {
  const cache = new Map(), inFlight = new Map();
  const lookup = async (originAddress) => {
    const key = normalize(originAddress), previous = cache.get(key);
    if (previous && previous.expiresAt > now()) return previous.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      let result;
      try { result = { records: await search(originAddress), provider: 'nominatim' }; }
      catch { result = { records: [], provider: 'unavailable' }; }
      if (!Array.isArray(result.records)) result = { records: [], provider: 'unavailable' };
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { value: result, expiresAt: now() + (result.provider === 'unavailable' ? 30_000 : cacheAgeMs) });
      return result;
    })();
    inFlight.set(key, promise);
    try { return await promise; } finally { inFlight.delete(key); }
  };
  return async (input) => {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new EnvironmentError('Kontrollera ursprungsadressen och kommunen.', 422, 'address_invalid');
    const { originAddress, municipalityCode, municipalityName: selectedName } = parsed.data;
    const place = parseOriginAddress(originAddress);
    const byCode = municipalityCode ? municipalityByCode.get(municipalityCode) : null;
    const byName = selectedName ? municipalityForName(selectedName) : null;
    if ((municipalityCode && !byCode) || (selectedName && !byName) || (byCode && byName && byCode.code !== byName.code))
      throw new EnvironmentError('Välj en giltig svensk kommun.', 422, 'municipality_invalid');
    const manual = byCode ?? byName;
    const result = (current, provider, candidates = []) => {
      const missing = requiredPlaceFields(current);
      if (!current.municipalityCode) missing.push('municipalityCode');
      return { originAddress, place: current, status: missing.some((field) => field !== 'municipalityCode') ? 'needs_address'
        : missing.length ? 'needs_municipality' : 'resolved', provider,
        missingFields: missing, resolvedAt: new Date(now()).toISOString(), municipalityConfirmed: Boolean(manual),
        ...(candidates.length ? { candidates } : {}),
      };
    };
    if (!place.address) return result({ ...place, municipalityCode: manual?.code ?? '' }, manual ? 'manual' : 'address');
    if (manual && !requiredPlaceFields(place).length) return result({ ...place, municipalityCode: manual.code }, 'manual');
    const demo = demoReferences && demoReference(place);
    if (demo) return result({ ...demo, address: place.address, municipalityCode: manual?.code ?? demo.municipalityCode }, 'demo-reference');
    const lookupResult = await lookup(originAddress);
    const matches = lookupResult.records.map((record) => candidatePlace(record, place)).filter(Boolean);
    const unique = new Map(matches.map((match) => [JSON.stringify(match.place), match]));
    if (unique.size === 1) {
      const match = [...unique.values()][0];
      return result({ ...match.place, municipalityCode: manual?.code ?? match.place.municipalityCode }, manual ? 'manual' : lookupResult.provider);
    }
    const candidates = [...new Map(matches.filter((match) => match.municipality)
      .map((match) => [match.municipality.code, match.municipality])).values()];
    return result({ ...place, municipalityCode: manual?.code ?? '' }, manual ? 'manual' : lookupResult.provider, candidates);
  };
}
