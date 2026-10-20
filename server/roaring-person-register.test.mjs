import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoaringPersonRegister } from './roaring-person-register.mjs';

// Entirely synthetic transport responses. No test in this file calls Roaring.
const personalNumber = '199002092386';
const consumerKey = 'synthetic-consumer-key';
const consumerSecret = 'synthetic-consumer-secret-not-real';
const bearer = 'synthetic-bearer-not-real';
const currentDate = '2026-10-20T12:00:00.000Z';
const env = { ROARING_CONSUMER_KEY: consumerKey, ROARING_CONSUMER_SECRET: consumerSecret };
const token = () => reply({ access_token: bearer, token_type: 'Bearer', expires_in: 3600 });
const reply = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const period = { dateFrom: '2020-01-01', dateTo: '9999-12-31' };
const record = () => ({
  personId: personalNumber,
  personIdType: 'PERSONAL_NUMBER',
  protectedRegistration: false,
  secrecy: { secrecy: false, secrecySetBySpar: false },
  name: [{ ...period, firstName: ' Test ', middleName: ' Mellan ', surName: ' Person ' }],
  populationRegistrationAddress: [{ ...period, swedishAddress: {
    deliveryAddress2: ' Testgatan 1 ', zipCode: '76141', city: ' Norrtälje ', coAddress: ' C/O Testmottagare ',
  } }],
  details: [{ ...period, protectedRegistration: false, secrecy: { secrecy: false, secrecySetBySpar: false } }],
  aggregatedIncome: 'private-income', relation: [{ personId: 'private-relative' }], realEstate: [{ identification: 'private-property' }],
});
const result = (person = record()) => ({ status: { code: 0, text: 'found' }, records: [person] });
function mockProvider(handler, options = {}) {
  const calls = [];
  const provider = createRoaringPersonRegister({ env, now: () => new Date(currentDate),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...init });
      return handler(String(url), init, calls);
    }, ...options });
  return { provider, calls };
}
const rejects = (promise, status, code) => assert.rejects(promise, error => {
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  for (const secret of [consumerKey, consumerSecret, bearer]) {
    assert.ok(!String(error.message).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
  }
  return true;
});
const header = (init, name) => new Headers(init.headers).get(name);

function checkDigit(prefix) {
  let sum = 0;
  for (const [index, value] of [...prefix].entries()) { const digit = Number(value) * (index % 2 === 0 ? 2 : 1); sum += digit > 9 ? digit - 9 : digit; }
  return `${prefix}${(10 - sum % 10) % 10}`;
}

test('Roaring uses server-only OAuth and the exact current/full12 GET, returning a narrow current postal DTO', async () => {
  let dispatches = 0;
  const { provider, calls } = mockProvider(async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    if (url === 'https://api.roaring.io/token') {
      assert.equal(init.method, 'POST');
      assert.equal(header(init, 'authorization'), `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`);
      assert.match(header(init, 'content-type'), /application\/x-www-form-urlencoded/);
      assert.deepEqual([...new URLSearchParams(init.body)], [['grant_type', 'client_credentials']]);
      assert.equal(dispatches, 0, 'OAuth never starts a billable person dispatch');
      return token();
    }
    assert.equal(url, `https://api.roaring.io/person/2.0/current/${personalNumber}`);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(header(init, 'authorization'), `Bearer ${bearer}`);
    assert.equal(dispatches, 1, 'the durable dispatch hook must finish before GET');
    return reply(result());
  });
  assert.equal(provider.configured, true);
  const person = await provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } });
  assert.deepEqual(person, { personalNumber, name: 'Test Mellan Person', address: 'Testgatan 1', careOf: 'C/O Testmottagare',
    postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', source: 'Roaring', fetchedAt: currentDate });
  assert.equal(calls.length, 2);
  for (const forbidden of ['private-income', 'private-relative', 'private-property', consumerKey, consumerSecret, bearer])
    assert.ok(!JSON.stringify(person).includes(forbidden));
});

test('concurrent lookups share OAuth only, retain one dispatch hook per GET and refresh an expired token', async () => {
  let milliseconds = Date.parse(currentDate), tokenCalls = 0, personCalls = 0, dispatches = 0;
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const { provider } = mockProvider(async url => {
    if (url.endsWith('/token')) { tokenCalls++; await ready; return token(); }
    personCalls++; return reply(result());
  }, { now: () => new Date(milliseconds) });
  const pending = [provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } }),
    provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } })];
  release();
  await Promise.all(pending);
  assert.equal(tokenCalls, 1); assert.equal(personCalls, 2); assert.equal(dispatches, 2);
  milliseconds += 3_601_000;
  await provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } });
  assert.equal(tokenCalls, 2); assert.equal(personCalls, 3); assert.equal(dispatches, 3);
});

test('missing configuration and malformed, short, coordination or future identities never authenticate or dispatch', async () => {
  const { provider, calls } = mockProvider(() => assert.fail('must not fetch'));
  for (const value of ['', '199002092387', '199002092386/path', '165593593626', null, 199002092386])
    await rejects(provider.lookup(value), 422, 'person_lookup_invalid');
  await rejects(provider.lookup('9002092386'), 422, 'person_lookup_century_required');
  await rejects(provider.lookup('5593593626'), 422);
  const coordination = `19${checkDigit('900269238')}`;
  await rejects(provider.lookup(coordination), 409, 'person_lookup_manual_required');
  const future = `20${checkDigit('990209238')}`;
  await rejects(provider.lookup(future), 422, 'person_lookup_invalid');
  assert.equal(calls.length, 0);
  const missing = createRoaringPersonRegister({ env: {}, fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(missing.configured, false);
  await rejects(missing.lookup(personalNumber), 503, 'person_lookup_not_configured');
});

test('failed OAuth and a rejected durable dispatch hook prevent the paid GET and expose no raw credentials', async () => {
  for (const status of [400, 401, 403, 500]) {
    let dispatches = 0;
    const { provider, calls } = mockProvider(async () => reply({ error: consumerSecret }, status));
    await rejects(provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } }), 503);
    assert.equal(calls.length, 1); assert.equal(dispatches, 0);
  }
  const { provider, calls } = mockProvider(async url => url.endsWith('/token') ? token() : assert.fail('paid GET must not run'));
  const denial = Object.assign(new Error('Already reserved'), { status: 409, code: 'already_reserved' });
  await assert.rejects(provider.lookup(personalNumber, { beforeDispatch: async () => { throw denial; } }), error => error === denial || error.status === 409);
  assert.equal(calls.length, 1);
});

test('only explicit status1 or HTTP404 is not found and person identity mismatches cannot autofill', async () => {
  for (const response of [reply({ status: { code: 1 }, records: [] }), reply({ status: { code: 1 } }), reply({}, 404)]) {
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : response);
    await rejects(provider.lookup(personalNumber), 404, 'person_lookup_not_found');
  }
  for (const body of [result({ ...record(), personId: '199001010009' }), { status: { code: 2 }, records: [] }, null, []]) {
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : reply(body));
    await rejects(provider.lookup(personalNumber), 502, 'person_lookup_response_invalid');
  }
});

test('protected, secrecy-marked or deceased people always fall back to manual entry without returning sensitive records', async () => {
  const changes = [
    value => { value.protectedRegistration = true; },
    value => { value.secrecy.secrecy = true; },
    value => { value.secrecy.secrecySetBySpar = true; },
    value => { value.details[0].protectedRegistration = true; },
    value => { value.details[0].secrecy.secrecy = true; },
    value => { value.details[0].death = { deathDate: '2026-01-01' }; },
  ];
  for (const change of changes) {
    const person = record(); change(person);
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : reply(result(person)));
    await rejects(provider.lookup(personalNumber), 409, 'person_lookup_manual_required');
  }
  // A malformed privacy flag is not evidence that address publication is safe.
  for (const change of [
    value => { value.protectedRegistration = 'true'; },
    value => { value.secrecy.secrecy = 'true'; },
    value => { value.details[0].protectedRegistration = 'true'; },
  ]) {
    const person = record(); change(person);
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : reply(result(person)));
    await assert.rejects(provider.lookup(personalNumber), error => error.status === 409 || error.status === 502);
  }
});

test('historical-only, ambiguous current or foreign addresses cannot be selected as a Swedish current address', async () => {
  const records = [
    value => { value.name[0].dateTo = '2020-01-01'; },
    value => { value.name.push({ ...period, firstName: 'Another', surName: 'Name' }); },
    value => { value.populationRegistrationAddress[0].dateTo = '2020-01-01'; },
    value => { value.populationRegistrationAddress.push(structuredClone(value.populationRegistrationAddress[0])); },
    value => { delete value.populationRegistrationAddress; value.foreignAddress = [{ ...period, internationalAddress: { country: 'Finland', deliveryAddress1: 'Foreign address' } }]; },
  ];
  for (const change of records) {
    const person = record(); change(person);
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : reply(result(person)));
    await rejects(provider.lookup(personalNumber), 409, 'person_lookup_manual_required');
  }
});

test('provider errors do not retry GET or expose raw bodies, tokens, request paths or personal records', async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    const { provider, calls } = mockProvider(async url => url.endsWith('/token') ? token() : reply({ secret: bearer, record: record() }, status));
    await assert.rejects(provider.lookup(personalNumber), error => {
      assert.ok(error.status >= 400);
      const visible = String(error.message) + JSON.stringify(error);
      for (const privateValue of [bearer, consumerSecret, 'Testgatan 1', '/current/']) assert.ok(!visible.includes(privateValue));
      return true;
    });
    assert.equal(calls.filter(call => call.method === 'GET').length, 1);
  }
});

test('response length limits cover both advertised and streaming person payloads', async () => {
  for (const response of [reply(result(), 200, { 'content-length': '2000000' }),
    reply({ ...result(), ignored: 'x'.repeat(1_100_000) })]) {
    const { provider } = mockProvider(async url => url.endsWith('/token') ? token() : response);
    await rejects(provider.lookup(personalNumber), 502, 'person_lookup_response_invalid');
  }
});

test('timeouts and caller cancellation bound OAuth and body reads without an extra provider GET', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let dispatches = 0;
    const { provider, calls } = mockProvider(async (_url, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }), { timeoutMs: 20 });
    await rejects(provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } }), 503);
    assert.equal(calls.length, 1); assert.equal(dispatches, 0);
    const { provider: stalled } = mockProvider(async url => url.endsWith('/token') ? token() : new Response(new ReadableStream({ start() {} })), { timeoutMs: 20 });
    await rejects(stalled.lookup(personalNumber), 503);
    const controller = new AbortController(); controller.abort();
    const { provider: cancelled, calls: cancelledCalls } = mockProvider(() => assert.fail('must not fetch'));
    await assert.rejects(cancelled.lookup(personalNumber, { signal: controller.signal }), error => error.status === 499 || error.name === 'AbortError');
    assert.equal(cancelledCalls.length, 0);
  } finally { clearTimeout(keepAlive); }
});


test('provider shutdown aborts pending OAuth and cannot dispatch a later paid lookup', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { provider, calls } = mockProvider(async (_url, { signal }) => {
    started();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  });
  let dispatches = 0;
  const pending = provider.lookup(personalNumber, { beforeDispatch: async () => { dispatches++; } });
  await entered; provider.close();
  await rejects(pending, 503, 'person_lookup_unavailable');
  await rejects(provider.lookup(personalNumber), 503, 'person_lookup_unavailable');
  assert.equal(calls.length, 1); assert.equal(dispatches, 0);
});
