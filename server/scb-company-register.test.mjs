import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScbCompanyRegister, ScbCompanyRegisterError, SCB_API_BASE } from './scb-company-register.mjs';

// Synthetic data using the official OpenAPI jeFullData/postAdressData contract.
const fixture = () => ({
  peOrgNr: '165593593626', orgNr: '5593593626', namn: 'Exempel Återvinning AB',
  postAdress: { gatuAdress: ' Exempelvägen 12 ', coAdress: 'Ekonomiavdelningen', postNr: '76141', postOrt: ' Norrtälje ' },
  ftgStat: '1', jurform: '49', momsStat: '1', fSkattStat: '1',
  tel: '+46123456789', epost: 'ignored@example.test', omsKl: '8',
});
const response = (body = fixture(), status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const key = 'synthetic-test-key-not-a-real-credential';
const clock = () => new Date('2026-10-20T12:00:00.000Z');
const client = fetchImpl => createScbCompanyRegister({ env: { SCB_API_KEY: key }, fetchImpl, now: clock });
const rejects = (promise, status, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof ScbCompanyRegisterError);
  assert.equal(error.status, status); assert.equal(error.code, code);
  assert.ok(!JSON.stringify(error).includes(key));
  return true;
});

test('SCB legal lookup uses exact PeOrgNr path, GET and a server-only API key', async () => {
  let calls = 0;
  const provider = client(async (url, options) => {
    calls++;
    assert.equal(url, `${SCB_API_BASE}/juridiskaenheter/165593593626/full`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['X-API-Key'], key);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  });
  assert.equal(provider.configured, true);
  const result = await provider.lookup(' 559359 - 3626 ');
  assert.deepEqual(result, {
    organisationNumber: '5593593626', name: 'Exempel Återvinning AB', address: 'Exempelvägen 12',
    postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', careOf: 'Ekonomiavdelningen',
    status: 'active', statusCode: '1', legalFormCode: '49', vatRegistered: true, fTaxRegistered: true,
    phone: '+46123456789', email: 'ignored@example.test',
    source: 'SCB', fetchedAt: clock().toISOString(),
  });
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(result.tel, undefined); assert.equal(result.epost, undefined); assert.equal(result.omsKl, undefined);
  await provider.lookup('5593593626');
  await provider.lookup('16 559359-3626');
  assert.equal(calls, 3, 'provider must not retain a shared registry/cache across tenant requests');
});

test('documented SCB tel/epost are optional normalized company contacts without inventing a person or director', async () => {
  for (const [tel, phone] of [['072-200 22 20', '+46722002220'], ['0046 72 200 22 20', '+46722002220'], ['+44 20 7946 0958', '+442079460958']]) {
    const result = await client(async () => response({ ...fixture(), tel, epost: ' Sales.Team+SE@Example.test ', contactName: 'Must not be returned', vdEmail: 'director@example.test' })).lookup('5593593626');
    assert.equal(result.phone, phone);
    assert.equal(result.email, 'Sales.Team+SE@Example.test');
    assert.equal(result.contactName, undefined); assert.equal(result.vdEmail, undefined);
    assert.equal(result.tel, undefined); assert.equal(result.epost, undefined);
  }
});

test('missing, malformed or unsafe SCB contacts never break the company hit or reach its form', async () => {
  for (const contacts of [
    { tel: undefined, epost: undefined }, { tel: null, epost: null }, { tel: '', epost: '   ' },
    { tel: { value: '+46722002220' }, epost: ['sales@example.test'] },
    { tel: '12345', epost: 'not-an-email' }, { tel: '+460722002220', epost: 'sales@example.test\r\nBcc: attacker@example.test' },
    { tel: 'x'.repeat(1000), epost: `${'x'.repeat(255)}@example.test` },
  ]) {
    const result = await client(async () => response({ ...fixture(), ...contacts })).lookup('5593593626');
    assert.equal(result.name, fixture().namn);
    assert.equal(result.phone, undefined); assert.equal(result.email, undefined);
  }
});

test('incomplete identities, personal/sole-trader IDs, extra characters and wrong check digits never reach SCB', async () => {
  const provider = client(() => { throw new Error('must not fetch'); });
  for (const value of ['', '559359362', '5593593627', '9001010009', '199001010009', 'SE559359362601', '5593593626?x=1', null, 5593593626])
    await rejects(provider.lookup(value), 422, 'company_lookup_invalid');
});

test('without approved server API key manual customer entry remains available', async () => {
  const provider = createScbCompanyRegister({ env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(provider.configured, false);
  await rejects(provider.lookup('5593593626'), 503, 'company_lookup_not_configured');
});

test('VAT, F-tax and company status codes follow SCB definitions without guessing unknown codes', async () => {
  for (const [codeValue, registered] of [['0', false], ['1', true], ['3', true], ['9', false], ['7', undefined]]) {
    const result = await client(async () => response({ ...fixture(), momsStat: codeValue })).lookup('5593593626');
    assert.equal(result.vatRegistered, registered);
  }
  for (const [ftgStat, status] of [[0, 'never_active'], [1, 'active'], [9, 'inactive'], [7, 'unknown']]) {
    const result = await client(async () => response({ ...fixture(), ftgStat, fSkattStat: 9 })).lookup('5593593626');
    assert.equal(result.status, status); assert.equal(result.fTaxRegistered, false);
  }
  const result = await client(async () => response({ peOrgNr: fixture().peOrgNr, orgNr: fixture().orgNr, namn: 'Exempel AB' })).lookup('5593593626');
  assert.equal(result.status, 'unknown'); assert.equal(result.vatRegistered, undefined);
  assert.equal(result.fTaxRegistered, undefined); assert.equal(result.address, '');
});

test('a provider record for a different identity or malformed content cannot autofill a customer', async () => {
  for (const body of [
    { ...fixture(), orgNr: '5560000167' }, { ...fixture(), peOrgNr: '165560000167' },
    { ...fixture(), peOrgNr: '199001010009' }, { ...fixture(), namn: '' },
    { ...fixture(), postAdress: { postNr: '7614x' } }, null, [], { error: 'no hit' },
  ]) await rejects(client(async () => response(body)).lookup('5593593626'), 502, 'company_lookup_response_invalid');
  await rejects(client(async () => new Response('<html>proxy error</html>')).lookup('5593593626'), 502, 'company_lookup_response_invalid');
});

test('only upstream 404 means no hit; quota/auth/outages remain retryable connection errors and raw errors stay private', async () => {
  for (const [status, expectedStatus, code] of [
    [404, 404, 'company_lookup_not_found'], [429, 429, 'company_lookup_rate_limited'],
    [401, 503, 'company_lookup_unavailable'], [403, 503, 'company_lookup_unavailable'],
    [400, 503, 'company_lookup_unavailable'], [500, 503, 'company_lookup_unavailable'], [503, 503, 'company_lookup_unavailable'],
  ]) await rejects(client(async () => response({ details: `secret ${key}` }, status)).lookup('5593593626'), expectedStatus, code);
  await rejects(client(async () => { throw new Error(`network failed ${key}`); }).lookup('5593593626'), 503, 'company_lookup_unavailable');
});

test('oversized responses are bounded even when the upstream omits content length', async () => {
  await rejects(client(async () => response(fixture(), 200, { 'content-length': '1000000' })).lookup('5593593626'), 502, 'company_lookup_response_invalid');
  await rejects(client(async () => new Response(JSON.stringify({ ...fixture(), unused: 'x'.repeat(66000) }))).lookup('5593593626'), 502, 'company_lookup_response_invalid');
});

test('timeouts bound headers and stalled bodies and caller cancellation produces a separate safe error', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const provider = createScbCompanyRegister({ env: { SCB_API_KEY: key }, timeoutMs: 20,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
    await rejects(provider.lookup('5593593626'), 503, 'company_lookup_unavailable');
    const stalledBody = createScbCompanyRegister({ env: { SCB_API_KEY: key }, timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
    await rejects(stalledBody.lookup('5593593626'), 503, 'company_lookup_unavailable');
    const controller = new AbortController(); controller.abort();
    await rejects(client(() => assert.fail('must not fetch')).lookup('5593593626', { signal: controller.signal }), 499, 'company_lookup_cancelled');
  } finally { clearTimeout(keepAlive); }
});
