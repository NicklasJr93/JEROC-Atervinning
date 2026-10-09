import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENVIRONMENT_MUNICIPALITIES, ENVIRONMENT_MUNICIPALITIES_SOURCE,
  createEnvironmentAddressResolver, createNominatimAddressSearch, parseOriginAddress,
} from './environment-address.mjs';

const origin = 'Storgatan 12, 761 41 Norrtälje';
const address = (extra = {}) => ({ address: { country_code: 'se', road: 'Storgatan', house_number: '12',
  postcode: '761 41', town: 'Norrtälje', municipality: 'Norrtälje kommun', ...extra } });
const resolver = (search) => createEnvironmentAddressResolver({ search, demoReferences: false });

test('municipality codes use a complete attributed SCB list, not a postcode calculation', () => {
  assert.equal(ENVIRONMENT_MUNICIPALITIES.length, 290);
  assert.equal(new Set(ENVIRONMENT_MUNICIPALITIES.map((entry) => entry.code)).size, 290);
  assert.deepEqual(ENVIRONMENT_MUNICIPALITIES.find((entry) => entry.name === 'Norrtälje'), { code: '0188', name: 'Norrtälje' });
  assert.deepEqual(ENVIRONMENT_MUNICIPALITIES.find((entry) => entry.name === 'Uppsala'), { code: '0380', name: 'Uppsala' });
  assert.match(ENVIRONMENT_MUNICIPALITIES_SOURCE.url, /^https:\/\/api\.scb\.se\//);
});

test('the canonical card origin is split without taking the customer billing city', async () => {
  assert.deepEqual(parseOriginAddress(origin), { address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '' });
  assert.deepEqual(parseOriginAddress('Storgatan 12, 76141 Norrtälje, Sverige'),
    { address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '' });
  const resolve = resolver(async () => [address()]);
  const value = await resolve({ originAddress: origin });
  assert.equal(value.place.city, 'Norrtälje'); assert.equal(value.place.municipalityCode, '0188');
  await assert.rejects(() => resolve({ originAddress: origin, billingAddress: 'Annan gata, Stockholm' }),
    (error) => error.status === 422 && error.code === 'address_invalid');
});

test('known demo references are deterministic and explicitly marked as demo, never a live verification', async () => {
  let calls = 0;
  const resolve = createEnvironmentAddressResolver({ search: async () => { calls += 1; return []; } });
  for (const text of ['Industrivägen 8, 761 41 Norrtälje', 'Ängsvägen 19, Norrtälje']) {
    const value = await resolve({ originAddress: text });
    assert.equal(value.status, 'resolved'); assert.equal(value.provider, 'demo-reference');
    assert.equal(value.place.postalCode, '76141'); assert.equal(value.place.municipalityCode, '0188');
    assert.equal(value.municipalityConfirmed, false);
  }
  assert.equal(calls, 0);
  assert.notEqual((await resolve({ originAddress: 'Industrivägen 8, 99999 Norrtälje' })).status, 'resolved');
  assert.notEqual((await resolve({ originAddress: 'Industrivägen 8, Uppsala' })).status, 'resolved');
  assert.equal(calls, 2);
});

test('a single exact Swedish street and house match can complete postal code, city and municipal name', async () => {
  const resolve = resolver(async () => [address()]);
  const value = await resolve({ originAddress: 'Storgatan 12' });
  assert.equal(value.status, 'resolved'); assert.equal(value.provider, 'nominatim');
  assert.deepEqual(value.place, { address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' });
  assert.deepEqual(value.missingFields, []);
  assert.equal((await resolver(async () => [address({ municipality: 'Bengtsfors kommun' })])({ originAddress: 'Storgatan 12' })).place.municipalityCode, '1460');
  assert.equal((await resolver(async () => [address({ municipality: 'Åmåls kommun' })])({ originAddress: 'Storgatan 12' })).place.municipalityCode, '1492');
});

test('ambiguous municipalities do not silently choose the first geocoder result', async () => {
  const resolve = resolver(async () => [address(), address({ municipality: 'Uppsala kommun' })]);
  const value = await resolve({ originAddress: origin });
  assert.equal(value.status, 'needs_municipality'); assert.equal(value.place.municipalityCode, '');
  assert.deepEqual(value.missingFields, ['municipalityCode']);
  assert.deepEqual(value.candidates, [{ code: '0188', name: 'Norrtälje' }, { code: '0380', name: 'Uppsala' }]);
});

test('wrong house numbers, contradictory postal codes, foreign and malformed results are not accepted', async () => {
  for (const result of [address({ house_number: '13' }), address({ postcode: '75320' }), address({ town: 'Stockholm' }),
    address({ country_code: 'no' }), address({ country_code: 123 }), address({ house_number: '' }), { address: null }, null]) {
    const value = await resolver(async () => [result])({ originAddress: origin });
    assert.equal(value.status, 'needs_municipality'); assert.equal(value.place.municipalityCode, '');
    assert.deepEqual(value.missingFields, ['municipalityCode']);
  }
});

test('settlement and county names cannot stand in for actual municipal evidence; only missing fields are requested', async () => {
  const resolve = resolver(async () => [address({ municipality: undefined, county: 'Stockholms län' })]);
  const value = await resolve({ originAddress: origin });
  assert.equal(value.status, 'needs_municipality'); assert.deepEqual(value.missingFields, ['municipalityCode']);
  const incomplete = await resolver(async () => [])({ originAddress: 'Storgatan 12, Norrtälje' });
  assert.equal(incomplete.status, 'needs_address'); assert.deepEqual(incomplete.missingFields, ['postalCode', 'municipalityCode']);
});

test('manual municipality confirmation validates official code/name and leaves missing origin address visible', async () => {
  let calls = 0;
  const resolve = resolver(async () => { calls += 1; return []; });
  const value = await resolve({ originAddress: origin, municipalityCode: '0188', municipalityName: 'Norrtälje kommun' });
  assert.equal(value.status, 'resolved'); assert.equal(value.provider, 'manual'); assert.equal(value.municipalityConfirmed, true);
  assert.equal(calls, 0);
  for (const selected of [{ municipalityCode: '9999' }, { municipalityName: 'Påhittad kommun' },
    { municipalityCode: '0380', municipalityName: 'Norrtälje' }])
    await assert.rejects(() => resolve({ originAddress: origin, ...selected }), (error) => error.status === 422 && error.code === 'municipality_invalid');
  const incomplete = await resolve({ originAddress: 'Storgatan 12, Norrtälje', municipalityCode: '0188' });
  assert.equal(incomplete.status, 'needs_address'); assert.deepEqual(incomplete.missingFields, ['postalCode']);
  assert.equal((await resolve({ originAddress: '', municipalityCode: '0188' })).status, 'needs_address');
});

test('same-address concurrent requests share a bounded cache; a changed canonical origin is re-resolved', async () => {
  let calls = 0, clock = 1000;
  const resolve = createEnvironmentAddressResolver({ demoReferences: false, now: () => clock, cacheAgeMs: 100,
    search: async () => { calls += 1; await new Promise((done) => setTimeout(done, 5)); return [address()]; } });
  const results = await Promise.all([resolve({ originAddress: origin }), resolve({ originAddress: origin })]);
  assert.equal(calls, 1); assert.deepEqual(results[0].place, results[1].place);
  await resolve({ originAddress: origin }); assert.equal(calls, 1);
  await resolve({ originAddress: 'Annan gata 1, 76141 Norrtälje' }); assert.equal(calls, 2);
  clock += 101; await resolve({ originAddress: origin }); assert.equal(calls, 3);
});

test('provider failure is a temporary address/municipality request, not a guessed or verified address', async () => {
  let calls = 0, clock = 0;
  const resolve = createEnvironmentAddressResolver({ demoReferences: false, now: () => clock, search: async () => { calls += 1; throw new Error('offline'); } });
  const value = await resolve({ originAddress: origin });
  assert.equal(value.provider, 'unavailable'); assert.equal(value.status, 'needs_municipality');
  assert.deepEqual(value.missingFields, ['municipalityCode']);
  await resolve({ originAddress: origin }); assert.equal(calls, 1);
  clock += 30_001; await resolve({ originAddress: origin }); assert.equal(calls, 2);
});

test('Nominatim requests are sequential, rate bounded and include only the requested origin address', async () => {
  let clock = 0;
  const calls = [];
  const search = createNominatimAddressSearch({ now: () => clock, wait: async (milliseconds) => { clock += milliseconds; },
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options, started: clock });
      return { ok: true, json: async () => [] };
    } });
  await Promise.all([search(origin), search('Storgatan 13, Norrtälje'), search('Storgatan 14, Norrtälje')]);
  assert.deepEqual(calls.map((entry) => entry.started), [0, 1100, 2200]);
  assert.equal(calls[0].url.searchParams.get('q'), `${origin}, Sverige`);
  assert.equal(calls[0].url.searchParams.get('countrycodes'), 'se');
  assert.equal(calls[0].url.searchParams.get('limit'), '5');
  assert.equal(calls[0].options.redirect, 'error');
  assert.match(calls[0].options.headers['User-Agent'], /JEROC/);
});

test('Nominatim timeout aborts a hanging request and excess concurrent lookups are rejected', async () => {
  let signal;
  const search = createNominatimAddressSearch({ timeoutMs: 25, intervalMs: 0, maxPending: 1,
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const first = search(origin);
  await assert.rejects(() => search('Annan gata'), /upptagen/);
  await assert.rejects(first, /för lång tid/);
  assert.equal(signal.aborted, true);
});
