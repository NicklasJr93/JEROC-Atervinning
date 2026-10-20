import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonLookup } from './customer-intake-person-lookup.mjs';
import { PersonRegisterError } from './roaring-person-register.mjs';
import { createPlatformUsage } from './platform-usage.mjs';
import { createPlatformUsageStorage } from './platform-usage-storage.mjs';

const number = '199002092386', month = '2026-10';
const person = { personalNumber: number, name: 'Syntetisk Person', address: 'Testgatan 1', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', source: 'Roaring', fetchedAt: '2026-10-20T10:00:00.000Z' };
async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'person-usage-test-')), filename = join(directory, 'usage.sqlite');
  let time = new Date('2026-10-20T10:00:00.000Z'), calls = 0, exists = false, usage, lookup, storage;
  const now = () => time;
  async function open() {
    storage = await createPlatformUsageStorage({ env: {}, filename });
    usage = createPlatformUsage({ storage, now });
    lookup = createPersonLookup({ usage, now, findExisting: async context => {
      assert.equal(context.organisationId, 'company-a'); assert.equal(context.personalNumber, number); return exists;
    }, register: { configured: true, async lookup(value, { beforeDispatch, signal }) {
      calls++; assert.equal(value, number);
      if (options.provider) return options.provider({ beforeDispatch, signal, setExists: value => { exists = value; } });
      await beforeDispatch(); return structuredClone(person);
    } } });
  }
  await open();
  try { await run({ request: (input = { personalNumber: number, requestId: randomUUID() }, context = {}) => lookup(input, {
    organisationId: 'company-a', channel: 'customer_registration', actorId: 'actor-a', ...context }),
    rows: () => storage.list({ month }), get calls() { return calls; }, setExists: value => { exists = value; },
    advance: milliseconds => { time = new Date(time.getTime() + milliseconds); },
    restart: async () => { usage.close(); await storage.close(); await open(); },
  }); }
  finally { usage.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); }
}
const rejects = (action, code) => assert.rejects(action, error => error.code === code);

test('internal customer hits and invalid input cannot call the provider or create usage entries', () => fixture(async f => {
  f.setExists(true);
  assert.deepEqual(await f.request(), { existing: true, person: null });
  assert.equal(f.calls, 0); assert.deepEqual(await f.rows(), []);
  await rejects(() => f.request({ personalNumber: number.slice(2), requestId: randomUUID() }), 'person_lookup_century_required');
  await rejects(() => f.request({ personalNumber: number, requestId: 'not-an-id' }), 'person_lookup_invalid');
  assert.equal(f.calls, 0); assert.deepEqual(await f.rows(), []);
}));

test('one successful provider GET creates one durable 200-minor usage record and never resends on retry or restart', () => fixture(async f => {
  const input = { personalNumber: number, requestId: randomUUID() };
  assert.deepEqual(await f.request(input), { existing: false, person });
  await rejects(() => f.request(input), 'person_lookup_already_processed');
  assert.equal(f.calls, 1);
  await f.restart();
  await rejects(() => f.request(input), 'person_lookup_already_processed');
  assert.equal(f.calls, 1);
  const rows = await f.rows(); assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'success'); assert.equal(rows[0].billableConfirmed, true);
  assert.equal(rows[0].unitCostMinor, 200); assert.equal(rows[0].unitSalesMinor, 200); assert.ok(rows[0].dispatchedAt);
  const serialized = JSON.stringify(rows);
  for (const privateValue of [number, person.name, person.address, 'personalNumber', 'access_token']) assert.equal(serialized.includes(privateValue), false, privateValue);
}));

test('OAuth/pre-dispatch authorization failures never create a dispatched or billable query', async () => {
  await fixture(async f => {
    await rejects(() => f.request(), 'person_lookup_unavailable');
    const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].status, 'rejected');
    assert.equal(rows[0].dispatchedAt, undefined); assert.equal(rows[0].billableConfirmed, false);
  }, { provider: async () => { throw new PersonRegisterError('Safe auth failure', 503, 'person_lookup_unavailable', 'rejected'); } });
  let checks = 0;
  await fixture(async f => {
    await rejects(() => f.request(undefined, { revalidate: async () => { if (++checks > 1) throw Object.assign(new Error('Access revoked'), { status: 403, code: 'revoked' }); } }), 'revoked');
    const rows = await f.rows(); assert.equal(rows[0].dispatchedAt, undefined); assert.equal(rows[0].billableConfirmed, false);
  });
});

test('a customer created during OAuth suppresses the provider GET without returning private existing fields', () => fixture(async f => {
  assert.deepEqual(await f.request(), { existing: true, person: null });
  const rows = await f.rows(); assert.equal(rows.length, 1); assert.equal(rows[0].dispatchedAt, undefined); assert.equal(rows[0].billableConfirmed, false);
}, { provider: async ({ setExists, beforeDispatch }) => { setExists(true); await beforeDispatch(); throw new Error('GET must not run'); } }));

test('confirmed no-hit/protected results are counted once while an uncertain transport failure remains reviewable', async () => {
  for (const [outcome, status, code, confirmed] of [
    ['not_found', 404, 'person_lookup_not_found', true], ['rejected', 409, 'person_lookup_manual_required', true], ['unknown', 503, 'person_lookup_unavailable', false],
  ]) await fixture(async f => {
    const input = { personalNumber: number, requestId: randomUUID() };
    await rejects(() => f.request(input), code);
    await rejects(() => f.request(input), 'person_lookup_already_processed');
    const rows = await f.rows(); assert.equal(rows.length, 1); assert.ok(rows[0].dispatchedAt);
    assert.equal(rows[0].status, outcome); assert.equal(rows[0].billableConfirmed, confirmed); assert.equal(f.calls, 1);
  }, { provider: async ({ beforeDispatch }) => { await beforeDispatch(); throw new PersonRegisterError('Safe public error', status, code, outcome, confirmed); } });
});

test('the shared person budget limits bursts and stable intake/actor callers before an additional paid dispatch', () => fixture(async f => {
  for (let index = 0; index < 4; index++) await f.request();
  await rejects(() => f.request(), 'person_lookup_rate_limited');
  assert.equal((await f.rows()).filter(row => row.dispatchedAt).length, 4);
  f.advance(1001);
  for (let index = 0; index < 6; index++) { await f.request(); f.advance(1001); }
  await rejects(() => f.request(), 'person_lookup_rate_limited');
  assert.equal((await f.rows()).filter(row => row.dispatchedAt).length, 10);
  // A different intake has its own caller budget, within the same company cap.
  await f.request(undefined, { rateKey: 'intake-b' });
  assert.equal((await f.rows()).filter(row => row.dispatchedAt).length, 11);
  for (let index = 0; index < 19; index++) {
    f.advance(1001); await f.request(undefined, { rateKey: `intake-new-${index}` });
  }
  f.advance(1001);
  await rejects(() => f.request(undefined, { rateKey: 'another-fresh-intake' }), 'person_lookup_rate_limited');
  assert.equal((await f.rows()).filter(row => row.dispatchedAt).length, 30, 'fresh callers cannot bypass the shared company budget');
}));
