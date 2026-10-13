import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createApplicationRepository } from './application-storage.mjs';
import { measureDatabaseWork } from './database-runtime.mjs';
import { createVismaStorage } from './visma-storage.mjs';

const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
const tenantId = 'jeroc-demo', companyId = 'company', mappingKey = JSON.stringify([companyId, 'customer']);
for (const postgres of [false, true]) {
  test(`${postgres ? 'PostgreSQL' : 'SQLite'}: due booking query bypasses older unrelated drafts and fences leases and tenants`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ storage }) => {
    await storage.ready();
    const now = '2026-10-13T10:00:00.000Z';
    await storage.transact(document => {
      const outbox = document.tenants[tenantId].finance.outbox;
      for (let index = 0; index < 60; index++) outbox.push({ id: `old-draft-${index}`, key: `old-draft-${index}`, companyId, status: 'accepted', createdAt: '2026-10-11T09:00:00Z',
        tracking: { state: 'pending', nextCheckAt: '2026-10-12T09:00:00Z' } });
      const base = { companyId, status: 'accepted', createdAt: now, tracking: { state: 'pending', nextCheckAt: now } };
      for (const job of [
        { id: 'booking-active-lease', booking: { status: 'processing', lease: { until: '2026-10-13T10:05:00.000Z' } } },
        { id: 'booking-later', booking: { status: 'unknown', nextCheckAt: '2026-10-13T10:05:00.000Z' } },
        { id: 'booking-failed', booking: { status: 'failed' } },
        { id: 'booking-other-company', companyId: 'foreign-company', booking: { status: 'queued' } },
        { id: 'booking-due', booking: { status: 'queued' }, privateFutureAttribute: 'not-returned' },
      ]) outbox.push({ ...structuredClone(base), ...job, key: job.id });
    }, { organisationId: tenantId, runs: false, finance: true });
    const due = await storage.queryExports({ companyId, statuses: ['accepted'], trackingDueAt: now, bookingDueOnly: true, fields: ['id'], limit: 1 });
    assert.deepEqual(due, [{ id: 'booking-due' }]);
    await assert.rejects(() => storage.queryExports({ bookingDueOnly: true }), TypeError);
  }, postgres));
}
function seed() {
  return { office: { marker: 'business-untouched' }, vismaIntegration: { version: 1, tenants: {
    [tenantId]: { generation: 'generation-before', tokens: { version: 1, ciphertext: 'encrypted-test-token' }, company: { id: companyId }, companyVerified: true,
      futureConnectionAttribute: { preserved: true },
      runs: [{ id: 'old-run', keyHash: 'old-key', startedAt: '2026-10-11T09:00:00Z', status: 'accepted', response: { futureField: 'historical'.repeat(120_000) } }],
      audit: [{ id: 'old-audit', at: '2026-10-11T09:00:00Z', action: 'connected' }],
      finance: { settings: { [companyId]: { companyId, revision: 1, enabled: true } },
        choices: { [companyId]: { companyId, accounts: [{ number: 4000 }], paymentTerms: [{ id: 'terms', days: 0 }], futureChoicesField: true } },
        settingsHistory: { [companyId]: { 1: { revision: 1, enabled: true, futureRule: { preserved: true } } } },
        mappings: { [mappingKey]: { companyId, customerId: 'customer', supplierId: 'supplier-before' } },
        outbox: [
          { id: 'old-export', key: 'old-export-key', companyId, customerId: 'customer', source: { cardId: 3016 }, status: 'accepted', trigger: 'manual', createdAt: '2026-10-11T09:00:00Z', payload: 'excluded'.repeat(120_000) },
          { id: 'queued-export', key: 'queued-export-key', companyId, customerId: 'customer', source: { cardId: 3017 }, status: 'queued', trigger: 'after_attest', createdAt: '2026-10-12T09:00:00Z' },
        ] },
    },
    other: { generation: 'other-generation', runs: [{ id: 'other-run', keyHash: 'other-key', startedAt: '2026-10-12T09:00:00Z' }], audit: [],
      finance: { settings: {}, choices: {}, mappings: {}, settingsHistory: {}, outbox: [{ id: 'other-export', key: 'other-export-key', createdAt: '2026-10-12T09:00:00Z' }] } },
  } } };
}
async function fixture(run, postgres = false, initial = seed) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-visma-storage-')), filename = join(directory, 'application.sqlite');
  let admin, schema, env = {};
  if (postgres) {
    admin = new pg.Pool({ connectionString: postgresUrl }); schema = `visma_storage_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`); env = { DATABASE_URL: url.toString() };
  }
  const repositories = [];
  async function create() {
    const repository = await createApplicationRepository({ env, filename, seed: initial }); repositories.push(repository);
    return { repository, storage: createVismaStorage({ getRepository: async () => repository }) };
  }
  try { await run({ ...await create(), create, admin, schema }); }
  finally {
    for (const repository of repositories) await repository.close();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const postgres of [false, true]) {
  const backend = postgres ? 'PostgreSQL' : 'SQLite';
  test(`${backend}: legacy Visma histories/cache/mappings survive migration, projection and restart`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, storage, create }) => {
    await storage.ready();
    const state = await storage.read(document => document);
    for (const collection of ['runs', 'audit']) assert.deepEqual(state.tenants[tenantId][collection], seed().vismaIntegration.tenants[tenantId][collection]);
    assert.deepEqual(state.tenants[tenantId].finance, seed().vismaIntegration.tenants[tenantId].finance);
    const projected = await storage.readTenantProjection(value => value, [
      ['generation'], ['finance', 'choices', companyId, 'paymentTerms'], ['finance', 'settingsHistory', companyId, '1'],
      ['finance', 'mappings', mappingKey], ['finance', 'choices', 'missing'],
    ]);
    assert.equal(projected.generation, 'generation-before');
    assert.deepEqual(projected.finance.choices[companyId], { paymentTerms: [{ id: 'terms', days: 0 }] });
    assert.equal(projected.finance.settingsHistory[companyId]['1'].futureRule.preserved, true);
    assert.equal(projected.finance.mappings[mappingKey].supplierId, 'supplier-before');
    assert.equal(projected.finance.choices.missing, undefined);
    assert.equal((await storage.findRun('old-run')).id, 'old-run');
    assert.equal((await storage.findRun('missing', 'old-key')).id, 'old-run');
    assert.equal(await storage.findRun('other-run'), null);
    assert.equal((await storage.findRun('other-run', undefined, 'other')).id, 'other-run');
    const second = await create();
    assert.equal((await second.storage.findRun('old-run')).response.futureField.length, 1_200_000);
    assert.equal((await second.storage.latestRuns(1))[0].id, 'old-run');
    assert.deepEqual(await repository.read(state => state.office), { marker: 'business-untouched' });
    if (postgres) {
      const root = await repository.read(state => state.vismaIntegration);
      assert.equal(root.storageVersion, 1); assert.equal(root.tenants[tenantId].runs, undefined); assert.equal(root.tenants[tenantId].audit, undefined);
      for (const collection of ['outbox', 'choices', 'settingsHistory', 'mappings']) assert.equal(root.tenants[tenantId].finance[collection], undefined);
      assert.ok(JSON.stringify(root).length < 1000);
    }
  }, postgres));

  test(`${backend}: targeted changes retain unselected history, append audit and do not retry provider work`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ storage, repository }) => {
    await storage.ready();
    await storage.transact(document => {
      const tenant = document.tenants[tenantId];
      if (postgres) { assert.deepEqual(tenant.runs, []); assert.deepEqual(tenant.finance.outbox, []); assert.deepEqual(tenant.audit, []); }
      tenant.generation = 'generation-after'; tenant.audit.push({ id: 'new-audit', at: '2026-10-12T09:01:00Z', action: 'local-change' });
    }, { organisationId: tenantId, runs: false, finance: false, audit: true });
    await storage.transact(document => {
      const finance = document.tenants[tenantId].finance;
      assert.equal(finance.outbox.find(job => job.id === 'queued-export').status, 'queued');
      if (postgres) { assert.equal(finance.outbox.length, 1); assert.deepEqual(finance.choices, {}); assert.deepEqual(finance.settingsHistory, {}); }
      finance.outbox.find(job => job.id === 'queued-export').status = 'accepted';
      finance.outbox.find(job => job.id === 'queued-export').lease = { id: 'owner-before', until: '2026-10-12T09:05:00Z' };
      finance.mappings[mappingKey].supplierId = 'supplier-after';
      finance.mappings[mappingKey].lease = { jobId: 'queued-export', until: '2026-10-12T09:05:00Z' };
    }, { organisationId: tenantId, runs: false, finance: { outbox: { id: 'queued-export' }, mappingKeys: [mappingKey] } });
    await storage.transact(document => {
      const tenant = document.tenants[tenantId], existing = tenant.runs.find(run => run.id === 'old-run');
      existing.response.localNote = 'updated-record-only';
    }, { organisationId: tenantId, runs: { id: 'old-run', keyHash: 'old-key' }, finance: false });
    const actual = await storage.read(document => document.tenants[tenantId]);
    assert.equal(actual.runs.length, 1); assert.equal(actual.runs[0].response.futureField.length, 1_200_000);
    assert.equal(actual.runs[0].response.localNote, 'updated-record-only');
    assert.equal(actual.finance.outbox.length, 2); assert.equal(actual.finance.outbox[0].payload.length, 960_000);
    assert.equal(actual.finance.outbox[1].status, 'accepted'); assert.equal(actual.finance.mappings[mappingKey].supplierId, 'supplier-after');
    assert.equal(actual.finance.outbox[1].lease.id, 'owner-before'); assert.equal(actual.finance.mappings[mappingKey].lease.jobId, 'queued-export');
    assert.deepEqual(actual.finance.choices, seed().vismaIntegration.tenants[tenantId].finance.choices);
    assert.deepEqual(actual.finance.settingsHistory, seed().vismaIntegration.tenants[tenantId].finance.settingsHistory);
    assert.deepEqual(actual.audit.map(event => event.id), ['old-audit', 'new-audit']);
    assert.equal(await repository.read((state, revision) => revision), postgres ? 0 : 3);
  }, postgres));

  test(`${backend}: export queries filter tenant/company/card/status and transfer only selected fields`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ storage }) => {
    const fields = await storage.queryExports({ companyId, fields: ['id', 'key'], descending: true });
    assert.deepEqual(fields, [{ id: 'queued-export', key: 'queued-export-key' }, { id: 'old-export', key: 'old-export-key' }]);
    assert.ok(JSON.stringify(fields).length < 160);
    assert.deepEqual(await storage.queryExports({ statuses: ['queued', 'processing'], fields: ['id'], limit: 25 }), [{ id: 'queued-export' }]);
    assert.deepEqual(await storage.queryExports({ statuses: ['queued'], trigger: 'manual', fields: ['id'], limit: 25 }), []);
    assert.equal((await storage.queryExports({ cardId: 3016, limit: 1 }))[0].id, 'old-export');
    assert.equal((await storage.queryExports({ key: 'queued-export-key' }))[0].id, 'queued-export');
    assert.equal((await storage.queryExports({ organisationId: 'other' }))[0].id, 'other-export');
    assert.equal((await storage.queryExports({ companyId: 'wrong' })).length, 0);
    await assert.rejects(storage.queryExports({ fields: 'id' }), TypeError);
    await assert.rejects(storage.latestRuns(0), TypeError);
  }, postgres));
}

test('PostgreSQL: hot projections use one SELECT and cache/token changes never load growing run/outbox/history records', { skip: !postgresUrl }, async () => fixture(async ({ storage, repository, admin, schema }) => {
  await storage.ready();
  const before = (await admin.query(`SELECT collection,record_key,updated_at FROM "${schema}".jeroc_visma_records ORDER BY collection,record_key`)).rows;
  const projected = await measureDatabaseWork(() => storage.readTenantProjection(value => value, [['generation'], ['tokens', 'version'], ['finance', 'choices', companyId, 'paymentTerms']]));
  assert.equal(projected.metrics.sqlCount, 3); assert.equal(projected.metrics.lockQueryMs, 0);
  assert.ok(JSON.stringify(projected.result).length < 200);
  const selectedCollections = [], runTransaction = repository.runInTransaction;
  repository.runInTransaction = callback => runTransaction(async client => {
    const original = client.query;
    client.query = async function (sql, values) { if (sql.includes('records.document') && sql.includes('FROM jeroc_visma_records AS records')) selectedCollections.push(values); return original.call(this, sql, values); };
    try { return await callback(client); } finally { client.query = original; }
  });
  try {
    await storage.transact(document => { document.tenants[tenantId].tokens.ciphertext = 'new-encrypted-value'; }, { organisationId: tenantId, runs: false, finance: false, audit: true });
    assert.deepEqual(selectedCollections, []);
  } finally { repository.runInTransaction = runTransaction; }
  const after = (await admin.query(`SELECT collection,record_key,updated_at FROM "${schema}".jeroc_visma_records ORDER BY collection,record_key`)).rows;
  assert.deepEqual(after, before); assert.equal(await repository.read((state, revision) => revision), 0);
} , true));

test('PostgreSQL: migration and mutations roll back together, preserving unknown provider fields and the outer business unit', { skip: !postgresUrl }, async () => fixture(async ({ repository, storage, create, admin, schema }) => {
  await storage.ready(); const second = await create(); await second.storage.ready();
  const before = await storage.read(document => document);
  await assert.rejects(repository.runInTransaction(async () => {
    await storage.transact(document => {
      document.tenants[tenantId].runs[0].status = 'rejected';
      document.tenants[tenantId].finance.outbox[0].status = 'rejected';
      document.tenants[tenantId].audit.push({ id: 'rolled-back', at: '2026-10-12T10:00:00Z' });
    });
    await second.repository.transact(state => { state.office.marker = 'bad'; throw new Error('business unit failed'); });
  }), /business unit failed/);
  assert.deepEqual(await second.storage.read(document => document), before);
  assert.deepEqual(await repository.read(state => state.office), { marker: 'business-untouched' });
  assert.equal(await repository.read((state, revision) => revision), 0);
  assert.equal((await admin.query(`SELECT record_key FROM "${schema}".jeroc_visma_records WHERE record_key='rolled-back'`)).rows.length, 0);
}, true));

test('PostgreSQL: concurrent indexed reservations keep one durable idempotency record', { skip: !postgresUrl }, async () => fixture(async ({ storage, create }) => {
  await storage.ready(); const second = await create(); await second.storage.ready();
  const reserve = selected => selected.transact(document => {
    const tenant = document.tenants[tenantId], prior = tenant.runs.find(run => run.id === 'reserved-run' || run.keyHash === 'reserved-key');
    if (prior) return prior.id;
    tenant.runs.push({ id: 'reserved-run', keyHash: 'reserved-key', status: 'in_flight', startedAt: '2026-10-12T11:00:00Z' }); return 'reserved-run';
  }, { organisationId: tenantId, runs: { id: 'reserved-run', keyHash: 'reserved-key' }, finance: false });
  assert.deepEqual(await Promise.all([reserve(storage), reserve(second.storage)]), ['reserved-run', 'reserved-run']);
  assert.equal((await storage.read(document => document.tenants[tenantId].runs)).filter(run => run.id === 'reserved-run').length, 1);
  assert.equal((await second.storage.latestRuns(1))[0].id, 'reserved-run');
}, true));

test('PostgreSQL: an invalid legacy idempotency collision leaves the original domain and migration untouched', { skip: !postgresUrl }, async () => fixture(async ({ storage, repository, admin, schema }) => {
  await assert.rejects(storage.ready(), error => error.code === '23505');
  const original = await repository.read(state => state.vismaIntegration);
  assert.equal(original.storageVersion, undefined); assert.equal(original.tenants[tenantId].runs.length, 2);
  assert.equal((await admin.query('SELECT to_regclass($1) AS name', [`${schema}.jeroc_visma_records`])).rows[0].name, null);
  await repository.transact(state => { state.vismaIntegration.tenants[tenantId].runs[1].keyHash = 'corrected-key'; });
  await storage.ready(); assert.equal((await storage.latestRuns(10)).length, 2);
}, true, () => {
  const result = seed(); result.vismaIntegration.tenants[tenantId].runs.push({ id: 'collision-run', keyHash: 'old-key', startedAt: '2026-10-12T11:00:00Z' }); return result;
}));

test('PostgreSQL: first-use migration inside a rolled-back outer unit retries instead of caching nonexistent tables', { skip: !postgresUrl }, async () => fixture(async ({ storage, repository, admin, schema }) => {
  await assert.rejects(repository.runInTransaction(async () => {
    await storage.ready();
    assert.equal((await storage.findRun('old-run')).id, 'old-run');
    throw new Error('abort first migration');
  }), /abort first migration/);
  assert.equal((await admin.query('SELECT to_regclass($1) AS name', [`${schema}.jeroc_visma_records`])).rows[0].name, null);
  assert.equal(await repository.read(state => state.vismaIntegration.storageVersion), undefined);
  await storage.ready(); assert.equal((await storage.findRun('old-run')).id, 'old-run');
  assert.equal(await repository.read((state, revision) => revision), 0);
}, true));

test('PostgreSQL: concurrent first initialization never makes an outer unit wait on its own migration lock', { skip: !postgresUrl }, async () => fixture(async ({ storage, repository }) => {
  let initialized, proceed, deadline;
  const firstInitialized = new Promise(resolve => { initialized = resolve; });
  const mayRead = new Promise(resolve => { proceed = resolve; });
  const first = repository.runInTransaction(async () => {
    await storage.ready(); initialized(); await mayRead;
    const run = await Promise.race([storage.findRun('old-run'), new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Nested first-use migration deadlocked')), 1000); })]);
    assert.equal(run.id, 'old-run'); clearTimeout(deadline);
  });
  await firstInitialized;
  // This second unit uses the same factory and repository, so a shared pending
  // readiness promise would form a cycle when the first unit calls findRun.
  let enteredSecond;
  const secondEntered = new Promise(resolve => { enteredSecond = resolve; });
  const original = repository.runInTransaction;
  repository.runInTransaction = callback => original(async client => { enteredSecond(); return callback(client); });
  const second = storage.ready();
  await secondEntered;
  proceed();
  try { await Promise.all([first, second]); } finally { clearTimeout(deadline); repository.runInTransaction = original; }
  assert.equal((await storage.findRun('old-run')).id, 'old-run');
}, true));

test('PostgreSQL: rolling-deploy guard rejects legacy writers before they can reserve another provider operation', { skip: !postgresUrl }, async () => fixture(async ({ storage, repository }) => {
  await storage.ready();
  const before = await storage.read(document => document), root = await repository.read(state => state.vismaIntegration);
  await assert.rejects(repository.transact(state => { delete state.vismaIntegration.storageVersion; }), error => error.code === '55000');
  for (const collection of ['runs', 'audit', 'outbox', 'choices', 'settingsHistory', 'mappings']) {
    await assert.rejects(repository.transact(state => {
      const tenant = state.vismaIntegration.tenants[tenantId];
      if (['runs', 'audit'].includes(collection)) tenant[collection] = [{ id: 'old-instance-new-reservation' }];
      else tenant.finance[collection] = collection === 'outbox' ? [{ id: 'old-instance-new-export' }] : {};
    }), error => error.code === '55000');
  }
  assert.deepEqual(await repository.read(state => state.vismaIntegration), root);
  assert.deepEqual(await storage.read(document => document), before);
  assert.equal(await repository.read((state, revision) => revision), 0);
  await storage.transact(document => { document.tenants[tenantId].audit.push({ id: 'new-adapter-entry', at: '2026-10-12T12:00:00Z' }); }, { runs: false, finance: false });
  assert.equal((await storage.read(document => document.tenants[tenantId].audit)).at(-1).id, 'new-adapter-entry');
}, true));

test('PostgreSQL: an operation already in flight before migration retains its original idempotency key and unknown outcome', { skip: !postgresUrl }, async () => fixture(async ({ storage }) => {
  await storage.ready();
  const run = await storage.findRun('old-run', 'old-key');
  assert.equal(run.status, 'in_flight'); assert.equal(run.keyHash, 'old-key');
  assert.equal(run.leaseUntil, '2026-10-11T09:02:00Z'); assert.equal(run.response, null);
  assert.equal((await storage.latestRuns(50)).length, 1);
}, true, () => {
  const result = seed(), run = result.vismaIntegration.tenants[tenantId].runs[0];
  run.status = 'in_flight'; run.leaseUntil = '2026-10-11T09:02:00Z'; run.response = null; return result;
}));
