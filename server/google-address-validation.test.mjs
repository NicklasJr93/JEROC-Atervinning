import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGoogleAddressValidation, GoogleAddressValidationError, GOOGLE_ADDRESS_VALIDATION_URL } from './google-address-validation.mjs';

const address = { address: 'Exempelvägen 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };
const key = 'synthetic-private-validation-key';
const fixture = () => ({ result: {
  address: { postalAddress: { regionCode: 'SE', addressLines: [' Exempelvägen 12 '], postalCode: '761 41', locality: ' Norrtälje ' },
    formattedAddress: 'must not escape', addressComponents: [{ componentName: { text: 'must not escape' } }] },
  verdict: { addressComplete: true, hasInferredComponents: true },
  geocode: { location: { latitude: 59, longitude: 18 } }, metadata: { unrelated: 'must not escape' },
}, responseId: 'must not escape' });
const response = (body = fixture(), status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const client = fetchImpl => createGoogleAddressValidation({ env: { GOOGLE_ADDRESS_VALIDATION_API_KEY: key }, fetchImpl });
const rejects = (promise, status, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof GoogleAddressValidationError);
  assert.equal(error.status, status); assert.equal(error.code, code);
  assert.ok(!JSON.stringify(error).includes(key)); return true;
});

test('validation uses a fixed HTTPS provider, server-only key and minimum structured fields', async () => {
  const sessionToken = '12345678-1234-1234-1234-123456789012';
  const provider = client(async (url, options) => {
    assert.equal(url, GOOGLE_ADDRESS_VALIDATION_URL);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Goog-Api-Key'], key);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { address: { regionCode: 'SE', addressLines: [address.address], postalCode: '76141', locality: address.city }, sessionToken });
    return response();
  });
  assert.equal(provider.configured, true);
  const result = await provider.validate({ ...address, postalCode: '761 41' }, { sessionToken });
  assert.deepEqual(result, { address, verdict: { addressComplete: true, hasInferredComponents: true,
    hasUnconfirmedComponents: false, hasReplacedComponents: false, requiresConfirmation: true } });
  assert.ok(!JSON.stringify(result).includes('must not escape'));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(result.geocode, undefined);
});

test('only Swedish structured input is accepted, with bounded text and no arbitrary provider fields', async () => {
  const provider = client(() => assert.fail('must not fetch'));
  for (const input of [null, [], {}, { ...address, address: '' }, { ...address, countryCode: 'US' },
    { ...address, postalCode: '7614x' }, { ...address, address: 'x'.repeat(301) }, { ...address, city: 'a\nadmin' },
    { ...address, url: 'https://example.test' }, { ...address, latitude: 59 }]) {
    await rejects(provider.validate(input), 422, 'address_validation_invalid');
  }
  for (const sessionToken of ['', '?key=secret', 'a'.repeat(37), 5])
    await rejects(provider.validate(address, { sessionToken }), 422, 'address_validation_invalid');
});

test('a browser key alone cannot activate server validation', async () => {
  const provider = createGoogleAddressValidation({ env: { GOOGLE_MAPS_BROWSER_API_KEY: key }, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(provider.configured, false);
  await rejects(provider.validate(address), 503, 'address_validation_not_configured');
});

test('incomplete input can be completed but incomplete provider output requires manual entry', async () => {
  const provider = client(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { address: { regionCode: 'SE', addressLines: [address.address] } });
    return response();
  });
  assert.deepEqual((await provider.validate({ ...address, postalCode: '', city: '' })).address, address);
  const incomplete = fixture(); incomplete.result.address.postalAddress.locality = '';
  await rejects(client(async () => response(incomplete)).validate(address), 422, 'address_validation_incomplete');
});

test('all Google suggestions require explicit confirmation, including low-confidence proposals', async () => {
  const body = fixture(); body.result.verdict = { addressComplete: false, hasUnconfirmedComponents: true, hasReplacedComponents: true };
  const result = await client(async () => response(body)).validate(address);
  assert.equal(result.verdict.addressComplete, false);
  assert.equal(result.verdict.hasUnconfirmedComponents, true);
  assert.equal(result.verdict.hasReplacedComponents, true);
  assert.equal(result.verdict.requiresConfirmation, true);
});

test('malformed, foreign, oversized and otherwise unexpected responses cannot enter customer forms', async () => {
  for (const edit of [body => { body.result.address.postalAddress.regionCode = 'US'; },
    body => { body.result.address.postalAddress.postalCode = '7x'; },
    body => { body.result.address.postalAddress.addressLines = []; },
    body => { body.result.address.postalAddress.locality = null; },
    body => { delete body.result.verdict; }]) {
    const body = fixture(); edit(body);
    await rejects(client(async () => response(body)).validate(address), 502, 'address_validation_response_invalid');
  }
  for (const body of [null, [], {}, { error: 'private details' }])
    await rejects(client(async () => response(body)).validate(address), 502, 'address_validation_response_invalid');
  await rejects(client(async () => new Response('<html>oops</html>')).validate(address), 502, 'address_validation_response_invalid');
  await rejects(client(async () => response(fixture(), 200, { 'content-length': '1000000' })).validate(address), 502, 'address_validation_response_invalid');
  await rejects(client(async () => response({ ...fixture(), ignored: 'x'.repeat(66000) })).validate(address), 502, 'address_validation_response_invalid');
});

test('provider errors have safe bounded messages; no raw key, response or network error escapes', async () => {
  for (const [status, expected, code] of [[400, 422, 'address_validation_invalid'], [429, 429, 'address_validation_rate_limited'],
    [401, 503, 'address_validation_unavailable'], [403, 503, 'address_validation_unavailable'], [500, 503, 'address_validation_unavailable']])
    await rejects(client(async () => response({ message: key }, status)).validate(address), expected, code);
  await rejects(client(async () => { throw new Error(key); }).validate(address), 503, 'address_validation_unavailable');
});

test('timeout bounds headers and stalled bodies, and caller cancellation is distinct', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const stalledHeaders = createGoogleAddressValidation({ env: { GOOGLE_ADDRESS_VALIDATION_API_KEY: key }, timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}) });
    await rejects(stalledHeaders.validate(address), 503, 'address_validation_unavailable');
    const stalledBody = createGoogleAddressValidation({ env: { GOOGLE_ADDRESS_VALIDATION_API_KEY: key }, timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    await rejects(stalledBody.validate(address), 503, 'address_validation_unavailable');
    const controller = new AbortController(); controller.abort();
    await rejects(client(() => assert.fail('must not fetch')).validate(address, { signal: controller.signal }), 499, 'address_validation_cancelled');
  } finally { clearTimeout(keepAlive); }
});
