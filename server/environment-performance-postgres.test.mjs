import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createPricingStore } from './pricing.mjs';

// Never inherit DATABASE_URL: these tests require the explicitly selected test
// database and create an isolated schema, including when run beside other tests.
const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
const options = { skip: !postgresUrl, timeout: 20_000 };
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const schema = `jeroc_environment_perf_${randomUUID().replaceAll('-', '')}`;
  const administration = new pg.Pool({ connectionString: postgresUrl });
  const repositories = [];
  let scoped;
  t.after(async () => {
    for (const repository of repositories) await repository.close();
    if (scoped) await scoped.end();
    try { await administration.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await administration.end(); }
  });
  await administration.query(`CREATE SCHEMA "${schema}"`);
  const connection = new URL(postgresUrl);
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const env = { DATABASE_URL: connection.toString() };
  scoped = new pg.Pool({ connectionString: env.DATABASE_URL });
  const open = async () => {
    const repository = await createEnvironmentRepository({ env });
    repositories.push(repository); return repository;
  };
  const repository = await open();
  const log = { active: false, queries: [], onQuery: undefined };
  const originalQuery = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, 'query', function (...args) {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (log.active) { log.queries.push(sql); log.onQuery?.(sql); }
    return originalQuery.apply(this, args);
  });
  const capture = async operation => {
    log.queries = []; log.active = true;
    try { return { value: await operation(), queries: [...log.queries] }; }
    finally { log.active = false; }
  };
  return { repository, open, scoped, log, capture };
}

function records(siteId = 'norrtalje', weight = 10) {
  const sourceId = randomUUID(), id = randomUUID(), articleId = 'lead-battery';
  const receipt = { id, sourceId, cardId: 5001, siteId, version: 1, hash: 'immutable-receipt-hash',
    snapshot: { version: 1, rows: [{ articleId, weight, classification: { hazardous: true, wasteCode: '160601' } }] } };
  return {
    receipt,
    inventory: { id: randomUUID(), receiptId: id, sourceId, siteId, articleId, wasteCode: '160601', weight },
    report: { id: randomUUID(), receiptId: id, sourceId, siteId, articleId, weight },
    correction: { id: randomUUID(), receiptId: id, sourceId, siteId, version: 2, hash: 'immutable-correction-hash',
      snapshot: { version: 2, rows: [{ articleId, weight: weight - 1 }] }, inventoryMovements: [] },
    draft: { id: randomUUID(), sourceId, siteId, version: 1, input: { originAddress: 'Saved origin' } },
  };
}

const append = (state, value, withCorrection = false) => {
  state.receipts.push(value.receipt);
  state.inventory.push(value.inventory);
  state.reports.push(value.report);
  if (withCorrection) state.corrections.push(value.correction);
};

test('PostgreSQL scoped environmental read uses one snapshot SELECT and never writes omitted entities or metadata', options, async t => {
  const f = await fixture(t), first = records(), second = records('rimbo');
  await f.repository.transact(state => {
    append(state, first, true); append(state, second, true);
    state.drafts.push(first.draft, second.draft);
    state.sessions.push({ tokenHash: 'selected-session', expiresAt: '2030-01-01T00:00:00Z' }, { tokenHash: 'other-session' });
    state.siteRecords.push({ id: 'norrtalje', version: 1, name: 'Norrtälje' }, { id: 'rimbo', version: 1, name: 'Rimbo' });
    state.nvvSettings.push({ id: randomUUID(), reporter: 'Preserve omitted settings' });
    state.audit.push({ id: randomUUID(), action: 'preserve.history' });
    state.revision = 12;
  });
  const before = JSON.parse(await f.repository.backup());
  const metadataBefore = (await f.scoped.query('SELECT data,xmin::text AS xmin FROM jeroc_environment_meta WHERE id=1')).rows[0];
  const result = await f.capture(() => f.repository.read(state => {
    assert.equal(state.receipts.length, 1); assert.equal(state.receipts[0].id, first.receipt.id);
    assert.equal(state.inventory.length, 1); assert.equal(state.drafts.length, 1);
    assert.deepEqual(state.sessions.map(value => value.tokenHash), ['selected-session']);
    assert.deepEqual(state.siteRecords.map(value => value.id), ['norrtalje']);
    assert.deepEqual(state.corrections, []); assert.deepEqual(state.nvvSettings, []); assert.deepEqual(state.audit, []);
    // Callback state is a disposable projection, not an aggregate writeback.
    state.revision = 999; state.receipts[0].snapshot.rows[0].weight = 999;
    state.drafts.length = 0; state.sessions.length = 0; state.audit.push({ id: 'never-persisted' });
  }, { entities: ['sessions', 'siteRecords', 'drafts', 'receipts', 'inventory'],
    tokenHash: 'selected-session', sourceId: first.receipt.sourceId, siteId: 'norrtalje' }));
  assert.equal(result.queries.length, 3, 'BEGIN read-only, one combined SELECT, COMMIT');
  assert.match(result.queries[0], /REPEATABLE READ READ ONLY/);
  assert.equal(result.queries.filter(sql => /^SELECT /.test(sql)).length, 1);
  assert.ok(result.queries.every(sql => !/FOR UPDATE|\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)));
  assert.deepEqual((await f.scoped.query('SELECT data,xmin::text AS xmin FROM jeroc_environment_meta WHERE id=1')).rows[0], metadataBefore);
  assert.deepEqual(JSON.parse(await f.repository.backup()), before);
});

test('PostgreSQL environmental batch writes parent and child records atomically in one CTE statement', options, async t => {
  const f = await fixture(t), value = records();
  await f.repository.transact(state => { state.drafts.push(value.draft); });
  const result = await f.capture(() => f.repository.transact(state => {
    append(state, value, true);
    state.drafts = [];
    state.requests.push({ id: 'successful-request', receiptId: value.receipt.id });
    state.audit.push({ id: randomUUID(), action: 'receipt.received' });
    state.revision += 1;
    return value.receipt.id;
  }));
  assert.equal(result.value, value.receipt.id);
  assert.equal(result.queries.length, 5, 'BEGIN, lock, fresh SELECT, batched write, COMMIT');
  const writes = result.queries.filter(sql => /^WITH /.test(sql));
  assert.equal(writes.length, 1);
  for (const table of ['receipts', 'corrections', 'inventory', 'reports', 'requests', 'audit'])
    assert.ok(writes[0].includes(`INSERT INTO jeroc_environment_${table}`));
  assert.ok(writes[0].includes('DELETE FROM jeroc_environment_drafts'));
  const after = JSON.parse(await f.repository.backup());
  assert.equal(after.receipts.length, 1); assert.equal(after.corrections.length, 1);
  assert.equal(after.inventory.length, 1); assert.equal(after.reports.length, 1);
  assert.equal(after.drafts.length, 0); assert.equal(after.revision, 1);
  const invalid = records();
  await assert.rejects(() => f.repository.transact(state => {
    state.receipts.push(invalid.receipt);
    state.inventory.push({ ...invalid.inventory, receiptId: randomUUID() });
    state.audit.push({ id: randomUUID(), action: 'must.rollback' });
    state.revision += 1;
  }), error => error.code === '23503');
  assert.deepEqual(JSON.parse(await f.repository.backup()), after, 'FK failure rolls back all CTE inserts and metadata');
});

test('PostgreSQL receipt, correction and inventory originals remain immutable through optimized writes', options, async t => {
  const f = await fixture(t), value = records();
  await f.repository.transact(state => { append(state, value, true); });
  const before = JSON.parse(await f.repository.backup());
  for (const change of [
    state => { state.receipts[0].snapshot.rows[0].weight += 1; },
    state => { state.receipts = []; },
    state => { state.corrections[0].hash = 'changed'; },
    state => { state.corrections = []; },
    state => { state.inventory[0].weight += 1; },
    state => { state.inventory = []; },
  ]) {
    await assert.rejects(() => f.repository.transact(state => { change(state); state.revision += 1; }),
      error => error.code === 'immutable_record' && error.status === 409);
    assert.deepEqual(JSON.parse(await f.repository.backup()), before);
  }
});

test('independent PostgreSQL environmental writers read committed predecessor changes after waiting for the lock', options, async t => {
  const f = await fixture(t), secondRepository = await f.open();
  const firstEntered = deferred(), secondLockIssued = deferred(), release = deferred();
  let locks = 0;
  f.log.onQuery = sql => { if (/SELECT id FROM jeroc_environment_meta.*FOR UPDATE/.test(sql) && ++locks === 2) secondLockIssued.resolve(); };
  f.log.active = true;
  const first = f.repository.transact(async state => {
    firstEntered.resolve(); await release.promise;
    state.revision += 1; state.requests.push({ id: 'first-writer', observedRevision: state.revision });
  });
  let second;
  try {
    await firstEntered.promise;
    second = secondRepository.transact(state => {
      assert.equal(state.revision, 1, 'a fresh statement sees the preceding committed writer');
      assert.deepEqual(state.requests.map(value => value.id), ['first-writer']);
      state.revision += 1; state.requests.push({ id: 'second-writer', observedRevision: state.revision });
    });
    await secondLockIssued.promise;
    release.resolve(); await Promise.all([first, second]);
  } finally { release.resolve(); f.log.active = false; }
  const after = JSON.parse(await f.repository.backup());
  assert.equal(after.revision, 2);
  assert.deepEqual(after.requests.map(value => [value.id, value.observedRevision]).sort(), [['first-writer', 1], ['second-writer', 2]]);
});

test('two PostgreSQL environmental receipts cannot both consume the same remaining site capacity', options, async t => {
  const f = await fixture(t), secondRepository = await f.open();
  const now = () => new Date('2026-10-16T10:00:00Z'), principalStore = createPricingStore({ now });
  const firstStore = createEnvironmentStore({ repository: f.repository, principalStore, now });
  const secondStore = createEnvironmentStore({ repository: secondRepository, principalStore, now });
  const firstUser = await firstStore.demoSession({ userId: 'admin' });
  const secondUser = await secondStore.demoSession({ userId: 'kajsa' });
  const existing = await firstStore.classification('lead-battery', firstUser.token);
  await firstStore.classify('lead-battery', { expectedVersion: existing.version, hazardous: true, wasteCode: '160601',
    wasteDescription: 'Blybatterier', handlingInstructions: '', adrRequired: false,
    storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 15 }] }, firstUser.token);
  await firstStore.saveStoragePolicy('norrtalje', { expectedVersion: 0, totalMaxKg: 15,
    rules: [{ wasteCode: '160601', allowed: true, maxKg: 15 }] }, firstUser.token);
  const material = [{ articleId: 'lead-battery', weight: 10 }];
  const previews = await Promise.all([
    firstStore.checkStorage({ siteId: 'norrtalje', rows: material, materialScope: 'hazardous' }, firstUser.token),
    secondStore.checkStorage({ siteId: 'norrtalje', rows: material, materialScope: 'hazardous' }, secondUser.token),
  ]);
  assert.ok(previews.every(value => value.canReceive), 'both previews see the same initially available capacity');
  const input = cardId => ({ sourceId: randomUUID(), cardId, siteId: 'norrtalje', materialScope: 'hazardous',
    rows: material, receivedAt: '2026-10-16T10:00:00Z', previousHolder: { name: 'Testbolag 1', number: '5560000167' },
    lastPlace: place, nextPlace: place, transportMode: 'road', incomingDocument: { status: 'provided' }, idempotencyKey: randomUUID() });
  const results = await Promise.allSettled([
    firstStore.receive(input(5101), firstUser.token), secondStore.receive(input(5102), secondUser.token),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const failure = results.find(value => value.status === 'rejected');
  assert.equal(failure.reason.code, 'storage_blocked'); assert.equal(failure.reason.status, 409);
  const after = JSON.parse(await f.repository.backup());
  assert.equal(after.receipts.length, 1); assert.equal(after.inventory.length, 1); assert.equal(after.requests.length, 1);
  assert.equal(after.inventory.reduce((sum, value) => sum + value.weight, 0), 10);
});

test('PostgreSQL environmental restore replaces a receipt graph without breaking foreign keys or changing originals', options, async t => {
  const f = await fixture(t), original = records(), replacement = records('rimbo');
  await f.repository.transact(state => {
    append(state, original, true);
    state.requests.push({ id: 'original-request', receiptId: original.receipt.id });
    state.audit.push({ id: randomUUID(), action: 'original.history' });
    state.revision = 7;
  });
  const backup = await f.repository.backup(), expected = JSON.parse(backup);
  const empty = structuredClone(expected);
  for (const name of ['receipts', 'corrections', 'inventory', 'reports', 'requests', 'audit']) empty[name] = [];
  empty.revision = 8;
  const cleared = await f.capture(() => f.repository.restore(JSON.stringify(empty)));
  assert.equal(cleared.queries.length, 5);
  assert.equal(cleared.queries.filter(sql => /^WITH /.test(sql)).length, 1);
  assert.deepEqual(JSON.parse(await f.repository.backup()), empty);
  await f.repository.transact(state => { append(state, replacement, true); state.revision = 9; });
  const restored = await f.capture(() => f.repository.restore(backup));
  assert.equal(restored.queries.length, 5);
  const [write] = restored.queries.filter(sql => /^WITH /.test(sql));
  assert.ok(write.indexOf('DELETE FROM jeroc_environment_inventory') < write.indexOf('DELETE FROM jeroc_environment_receipts'));
  assert.ok(write.indexOf('INSERT INTO jeroc_environment_receipts') < write.indexOf('INSERT INTO jeroc_environment_inventory'));
  assert.deepEqual(JSON.parse(await f.repository.backup()), expected);
  assert.equal((await f.scoped.query('SELECT count(*)::int AS count FROM jeroc_environment_inventory WHERE receipt_id=$1', [replacement.receipt.id])).rows[0].count, 0);
  const invalid = structuredClone(expected);
  invalid.inventory[0].receiptId = randomUUID();
  await assert.rejects(async () => f.repository.restore(JSON.stringify(invalid)), /saknar en mottagning/);
  assert.deepEqual(JSON.parse(await f.repository.backup()), expected, 'an invalid backup leaves the restored originals untouched');
});

test('PostgreSQL targeted reads scope receipt history, classifications and NVV children in one read-only snapshot', options, async t => {
  const f = await fixture(t), first = records(), second = records('rimbo');
  const firstVersion = randomUUID(), secondVersion = randomUUID();
  await f.repository.transact(state => {
    append(state, first, true); append(state, second, true);
    state.classifications.push({ articleId: 'lead-battery', version: 1 }, { articleId: 'copper', version: 1 });
    state.nvvReports.push({ id: firstVersion, receiptId: first.receipt.id, sourceId: first.receipt.sourceId, siteId: first.receipt.siteId },
      { id: secondVersion, receiptId: second.receipt.id, sourceId: second.receipt.sourceId, siteId: second.receipt.siteId });
    for (const name of ['nvvAttempts', 'nvvJobs']) state[name].push({ id: randomUUID(), versionId: firstVersion }, { id: randomUUID(), versionId: secondVersion });
  });
  const before = JSON.parse(await f.repository.backup());
  const read = await f.capture(() => f.repository.read(state => {
    assert.deepEqual(state.receipts.map(value => value.id), [first.receipt.id]);
    assert.deepEqual(state.corrections.map(value => value.receiptId), [first.receipt.id]);
    assert.deepEqual(state.classifications.map(value => value.articleId), ['lead-battery']);
    assert.deepEqual(state.nvvReports.map(value => value.id), [firstVersion]);
    for (const name of ['nvvAttempts', 'nvvJobs']) assert.deepEqual(state[name].map(value => value.versionId), [firstVersion]);
  }, { entities: ['receipts', 'corrections', 'classifications', 'nvvReports', 'nvvAttempts', 'nvvJobs'],
    receiptId: first.receipt.id, sourceId: first.receipt.sourceId, articleIds: ['lead-battery'], siteId: first.receipt.siteId }));
  assert.equal(read.queries.length, 3);
  assert.equal(read.queries.filter(sql => /^SELECT /.test(sql)).length, 1);
  assert.deepEqual(JSON.parse(await f.repository.backup()), before);
});

test('PostgreSQL stock projection applies signed corrections exactly once and preserves all facility receipts', options, async t => {
  const f = await fixture(t), now = () => new Date('2026-10-16T10:00:00Z');
  const store = createEnvironmentStore({ repository: f.repository, principalStore: createPricingStore({ now }), now });
  const user = await store.demoSession({ userId: 'admin' });
  const classification = await store.classification('lead-battery', user.token);
  await store.classify('lead-battery', { expectedVersion: classification.version, hazardous: true, wasteCode: '160601',
    wasteDescription: 'Blybatterier', handlingInstructions: '', adrRequired: false,
    storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 20 }] }, user.token);
  await store.saveStoragePolicy('norrtalje', { expectedVersion: 0, totalMaxKg: 20,
    rules: [{ wasteCode: '160601', allowed: true, maxKg: 20 }] }, user.token);
  const input = (cardId, amount) => ({ sourceId: randomUUID(), cardId, siteId: 'norrtalje', materialScope: 'hazardous',
    rows: [{ articleId: 'lead-battery', weight: amount }], receivedAt: '2026-10-16T10:00:00Z',
    previousHolder: { name: 'Testbolag 1', number: '5560000167' }, lastPlace: place, nextPlace: place,
    transportMode: 'road', incomingDocument: { status: 'provided' }, idempotencyKey: randomUUID() });
  const firstInput = input(5201, 10), first = await store.receive(firstInput, user.token);
  await store.receive(input(5202, 5), user.token);
  const { sourceId, cardId, siteId, ...physical } = firstInput;
  await store.correct(first.id, { ...physical, rows: [{ articleId: 'lead-battery', weight: 7 }],
    expectedVersion: 1, reason: 'Minska den uppmätta mängden', idempotencyKey: randomUUID() }, user.token);
  const increase = { ...physical, rows: [{ articleId: 'lead-battery', weight: 12 }],
    expectedVersion: 2, reason: 'Korrigera den uppmätta mängden igen', idempotencyKey: randomUUID() };
  await store.correct(first.id, increase, user.token);
  const beforeRetry = JSON.parse(await f.repository.backup());
  await store.correct(first.id, increase, user.token);
  assert.deepEqual(JSON.parse(await f.repository.backup()), beforeRetry, 'a repeated correction does not duplicate its signed movement');
  const otherFacility = records('rimbo', 100);
  await f.repository.transact(state => { append(state, otherFacility); });
  const projection = await f.capture(() => f.repository.read(state => {
    assert.equal(state.environmentStockProjection, true);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(state)), 'environmentStockProjection'), false);
    assert.deepEqual(state.inventory, [{ siteId: 'norrtalje', articleId: 'lead-battery', wasteCode: '160601', weight: 17 }]);
    assert.equal(state.receipts.length, 1); assert.equal(state.corrections.length, 2);
  }, { entities: ['receipts', 'corrections', 'inventory'], siteId: 'norrtalje', receiptId: first.id, stock: true }));
  assert.equal(projection.queries.length, 3);
  for (const [receiptId, weight, incoming, projected, allowed] of [[undefined, 4, 4, 21, false], [first.id, 15, 3, 20, true], [first.id, 16, 4, 21, false]]) {
    const assessment = await store.checkStorage({ siteId: 'norrtalje', materialScope: 'hazardous',
      rows: [{ articleId: 'lead-battery', weight }], ...(receiptId ? { receiptId } : {}) }, user.token);
    assert.equal(assessment.canReceive, allowed);
    assert.equal(assessment.checks.length, 3);
    for (const check of assessment.checks) {
      assert.equal(check.currentKg, 17, 'base stock plus -3 kg plus +5 kg, including the other 5 kg receipt');
      assert.equal(check.incomingKg, incoming); assert.equal(check.projectedKg, projected);
    }
  }
  const originals = JSON.parse(await f.repository.backup());
  assert.deepEqual(originals.receipts.find(value => value.id === first.id), beforeRetry.receipts.find(value => value.id === first.id));
  assert.deepEqual(originals.corrections.sort((a, b) => a.version - b.version).map(value => value.inventoryMovements[0].weight), [-3, 5]);
  assert.equal(originals.inventory.filter(value => value.siteId === 'norrtalje').reduce((sum, value) => sum + value.weight, 0), 15,
    'correction deltas stay in immutable correction history rather than rewriting original inventory');
});
