import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore, environmentHash } from './environment-model.mjs';
import { createEnvironmentApi } from './environment-api.mjs';

const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
const rejects = (run, status, code) => assert.rejects(async () => run(), error => error.status === status && (!code || error.code === code));
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const receiptInput = (changes = {}) => ({ sourceId: randomUUID(), cardId: 2050, siteId: 'norrtalje', receivedAt: '2026-10-09T10:00:00+02:00',
  rows: [{ articleId: 'lead-battery', weight: 10 }], previousHolder: { name: 'Testverkstad AB', number: '5560000167' },
  lastPlace: place, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road',
  incomingDocument: { status: 'provided' }, idempotencyKey: randomUUID(), ...changes });
const correctionInput = (original, changes = {}) => {
  const { sourceId, cardId, siteId, idempotencyKey, ...fields } = original;
  return { ...fields, expectedVersion: 1, reason: 'Ny kontroll av mottagen mängd.', idempotencyKey: randomUUID(), ...changes };
};
const siteInput = (changes = {}) => ({ expectedVersion: 0, name: 'Testanläggning', ...place, active: true, permitReference: '', permitNotes: '', ...changes });
const classificationInput = (classification, changes = {}) => ({ expectedVersion: classification.version, hazardous: classification.hazardous,
  wasteCode: classification.wasteCode, wasteDescription: classification.wasteDescription, handlingInstructions: classification.handlingInstructions,
  adrRequired: classification.adrRequired, ...changes });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-storage-test-'));
  let options = { env: {}, filename: join(directory, 'environment.sqlite') }, postgres, schema;
  if (postgresUrl) {
    const { Pool } = await import('pg'); postgres = new Pool({ connectionString: postgresUrl });
    schema = `jeroc_storage_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(postgresUrl); connection.searchParams.set('options', `-c search_path=${schema}`);
    options = { env: { DATABASE_URL: connection.toString() } };
  }
  let repository = await createEnvironmentRepository(options);
  const restrictions = new Map(), grants = new Map(), now = () => new Date('2026-10-16T10:00:00Z');
  const pricing = createPricingStore({ now });
  const principalStore = { ...pricing, principal(actor, effective) {
    const principal = pricing.principal(actor, effective);
    if (restrictions.has(principal.user.id)) principal.user.siteIds = restrictions.get(principal.user.id);
    if (grants.has(principal.user.id)) principal.user.permissions = grants.get(principal.user.id);
    return principal;
  } };
  const makeStore = () => createEnvironmentStore({ repository, principalStore, now });
  let store = makeStore();
  const admin = await store.demoSession({ userId: 'admin' }), kajsa = await store.demoSession({ userId: 'kajsa' }), anna = await store.demoSession({ userId: 'anna' });
  const f = { get store() { return store; }, get repository() { return repository; }, options, principalStore, now, admin, kajsa, anna, restrictions, grants,
    classify: async (articleId, changes) => store.classify(articleId, classificationInput(await store.classification(articleId, admin.token), changes), admin.token),
    policy: (changes = {}, siteId = 'norrtalje') => store.saveStoragePolicy(siteId, { expectedVersion: 0, totalMaxKg: null, rules: [{ wasteCode: '160601', allowed: true, maxKg: null }], ...changes }, admin.token),
    restart: async () => { await repository.close(); repository = await createEnvironmentRepository(options); store = makeStore(); },
  };
  try { await run(f); }
  finally { await repository.close(); if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); } await rm(directory, { recursive: true, force: true }); }
}

test('legacy receipts survive the storage migration without seeded limits or an inferred legal permit', async () => fixture(async f => {
  const input = receiptInput(), original = await f.store.receive(input, f.admin.token);
  assert.equal(original.snapshot.storageAssessment.canReceive, true);
  assert.ok(original.snapshot.storageAssessment.checks.some(check => check.code === 'site_policy_unconfigured'));
  assert.ok(original.snapshot.storageAssessment.checks.some(check => check.code === 'article_storage_unconfigured'));
  const before = JSON.parse(await f.repository.backup()); delete before.siteRecords; delete before.storagePolicies;
  await f.repository.restore(JSON.stringify(before)); await f.restart();
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts[0].hash, original.hash); assert.equal(state.inventory.length, 1);
  assert.equal(state.storagePolicies.length, 0); assert.equal(state.sites.length, 2);
  assert.ok(state.sites.every(site => site.permitReference === '' && site.permitNotes === ''));
  assert.equal((await f.store.receive(input, f.admin.token)).id, original.id);
}));

test('the dynamic facility register is versioned, durable, scoped and validates complete addresses', async () => fixture(async f => {
  await rejects(() => f.store.saveSite('new-site', siteInput({ address: '' }), f.admin.token), 422);
  await rejects(() => f.store.saveSite('new-site', siteInput({ municipalityCode: '9999' }), f.admin.token), 422);
  const site = await f.store.saveSite('new-site', siteInput({ permitReference: 'Verksamhetens egen testreferens' }), f.admin.token);
  assert.equal(site.version, 1);
  await rejects(() => f.store.saveSite(site.id, siteInput(), f.admin.token), 409, 'version_conflict');
  const changed = await f.store.saveSite(site.id, siteInput({ expectedVersion: 1, name: 'Ändrat namn', active: false }), f.admin.token);
  assert.equal(changed.version, 2); assert.equal((await f.store.catalog()).find(item => item.id === site.id).name, 'Ändrat namn');
  const legacy = (await f.store.catalog()).find(item => item.id === 'rimbo');
  const { id: legacyId, version: legacyVersion, updatedAt, updatedBy, ...legacyValues } = legacy;
  const updatedLegacy = await f.store.saveSite(legacyId, { ...legacyValues, expectedVersion: legacyVersion, name: 'Rimbo äldre mottagningsplats', active: false }, f.admin.token);
  assert.equal(updatedLegacy.address, ''); assert.equal(updatedLegacy.postalCode, ''); assert.equal(updatedLegacy.active, false);
  await rejects(() => f.store.saveSite(legacyId, { ...legacyValues, expectedVersion: updatedLegacy.version, postalCode: '1234' }, f.admin.token), 422);
  f.restrictions.set('kajsa', ['norrtalje']); f.grants.set('kajsa', ['environmentRead', 'environmentStorage']);
  assert.deepEqual((await f.store.state(f.kajsa.token)).sites.map(item => item.id), ['norrtalje']);
  await rejects(() => f.store.saveSite(site.id, siteInput({ expectedVersion: 2 }), f.kajsa.token), 403, 'site_forbidden');
  await rejects(() => f.store.saveSite('another-site', siteInput(), f.kajsa.token), 403, 'site_forbidden');
  await f.restart(); assert.equal((await f.store.catalog()).find(item => item.id === site.id).active, false);
  assert.equal((await f.store.catalog()).find(item => item.id === legacyId).name, updatedLegacy.name);
  const backup = JSON.parse(await f.repository.backup()); assert.equal(backup.siteRecords.filter(item => item.id === site.id).length, 2);
}));

test('article storage changes require their own permission and cannot remove hidden facility rules', async () => fixture(async f => {
  const rules = [{ siteId: 'norrtalje', allowed: true, maxKg: 100 }, { siteId: 'rimbo', allowed: true, maxKg: 200 }];
  let classification = await f.classify('lead-battery', { storageRules: rules });
  f.grants.set('kajsa', ['environmentRead', 'environmentClassify']);
  const omission = await f.store.classify('lead-battery', classificationInput(classification, { handlingInstructions: 'Nya säkerhetsanvisningar' }), f.kajsa.token);
  assert.deepEqual(omission.storageRules, rules);
  await rejects(() => f.store.classify('lead-battery', classificationInput(omission, { storageRules: [] }), f.kajsa.token), 403, 'forbidden');
  f.grants.set('kajsa', ['environmentRead', 'environmentClassify', 'environmentStorage']); f.restrictions.set('kajsa', ['norrtalje']);
  await rejects(() => f.store.classify('lead-battery', classificationInput(omission, { storageRules: [rules[0]] }), f.kajsa.token), 403, 'site_forbidden');
  classification = await f.store.classify('lead-battery', classificationInput(omission, { storageRules: [{ ...rules[0], maxKg: 110 }, rules[1]] }), f.kajsa.token);
  assert.equal(classification.storageRules[1].maxKg, 200);
  await f.restart(); assert.deepEqual((await f.store.classification('lead-battery', f.admin.token)).storageRules, classification.storageRules);
}));

test('article limits include existing stock, pass the exact boundary and reject zero, duplicates and invalid amounts', async () => fixture(async f => {
  await f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 10 }] });
  const original = await f.store.receive(receiptInput(), f.kajsa.token);
  const check = await f.store.checkStorage({ siteId: 'norrtalje', rows: [{ articleId: 'lead-battery', weight: 0.001 }] }, f.admin.token);
  assert.equal(check.canReceive, false); assert.equal(check.checks.find(item => item.code === 'article_capacity_exceeded').projectedKg, 10.001);
  await rejects(() => f.store.receive(receiptInput({ rows: [{ articleId: 'lead-battery', weight: 0.001 }] }), f.kajsa.token), 409, 'storage_blocked');
  await rejects(() => f.store.receive(receiptInput({ siteId: 'rimbo' }), f.admin.token), 409, 'storage_blocked');
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 1);
  await f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 0 }] });
  await rejects(() => f.store.receive(receiptInput(), f.admin.token), 409, 'storage_blocked');
  for (const maxKg of [-1, 0.0001, '100', Infinity]) await rejects(() => f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg }] }), 422);
  await rejects(() => f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 10 }, { siteId: 'norrtalje', allowed: true, maxKg: 20 }] }), 422);
  assert.equal(original.hash, environmentHash(original.snapshot));
}));

test('site waste-code limits combine several articles and a stricter article limit still applies', async () => fixture(async f => {
  await f.policy({ totalMaxKg: 100, rules: [{ wasteCode: '160601', allowed: true, maxKg: 15 }] });
  await f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 10 }] });
  await f.classify('copper-1', { wasteCode: '160601', storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 100 }] });
  await f.store.receive(receiptInput(), f.admin.token);
  const rows = [{ articleId: 'copper-1', weight: 5 }];
  const exact = await f.store.checkStorage({ siteId: 'norrtalje', rows }, f.admin.token);
  assert.equal(exact.canReceive, true); assert.equal(exact.checks.find(item => item.wasteCode === '160601').projectedKg, 15);
  await f.store.receive(receiptInput({ rows }), f.admin.token);
  await rejects(() => f.store.receive(receiptInput({ rows: [{ articleId: 'copper-1', weight: 0.001 }] }), f.admin.token), 409, 'storage_blocked');
  await rejects(() => f.store.receive(receiptInput({ rows: [{ articleId: 'lead-battery', weight: 1 }] }), f.admin.token), 409, 'storage_blocked');
}));

test('total capacity counts all registered rows and configured empty rules explicitly deny new waste', async () => fixture(async f => {
  await f.policy({ totalMaxKg: 12 });
  await f.classify('copper-1', { wasteCode: '160601' });
  await f.store.receive(receiptInput({ rows: [{ articleId: 'lead-battery', weight: 10 }, { articleId: 'copper-1', weight: 2 }] }), f.admin.token);
  const check = await f.store.checkStorage({ siteId: 'norrtalje', rows: [{ articleId: 'copper-1', weight: 1 }] }, f.admin.token);
  assert.equal(check.canReceive, false); assert.equal(check.checks.find(item => item.code === 'site_capacity_exceeded').currentKg, 12);
  await f.policy({ expectedVersion: 1, totalMaxKg: null, rules: [] });
  await rejects(() => f.store.receive(receiptInput(), f.admin.token), 409, 'storage_blocked');
  await f.classify('copper-1', { storageRules: [] });
  await rejects(() => f.store.receive(receiptInput({ rows: [{ articleId: 'copper-1', weight: 1 }] }), f.admin.token), 409, 'storage_blocked');
  await f.classify('copper-1', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: null }] });
  assert.equal((await f.store.checkStorage({ siteId: 'norrtalje', rows: [{ articleId: 'copper-1', weight: 1 }] }, f.admin.token)).checks.some(item => item.code === 'article_capacity_unset'), true);
}));

test('configured site policies block new uncoded articles but preserve metadata and reducing corrections of legacy stock', async () => fixture(async f => {
  const input = receiptInput({ rows: [{ articleId: 'copper-1', weight: 10 }] });
  const original = await f.store.receive(input, f.admin.token);
  assert.equal(original.snapshot.storageAssessment.canReceive, true);
  await f.policy({ totalMaxKg: 100, rules: [] });
  for (const rules of [[], [{ wasteCode: '160601', allowed: true, maxKg: 100 }]]) {
    const policy = (await f.store.state(f.admin.token)).storagePolicies[0];
    await f.policy({ expectedVersion: policy.version, totalMaxKg: 100, rules });
    const check = await f.store.checkStorage({ siteId: 'norrtalje', rows: input.rows }, f.admin.token);
    assert.equal(check.canReceive, false);
    assert.equal(check.checks.find(item => item.code === 'waste_code_unconfigured').severity, 'blocked');
    await rejects(() => f.store.receive(receiptInput({ rows: input.rows }), f.admin.token), 409, 'storage_blocked');
  }
  const metadata = await f.store.correct(original.id, correctionInput(input, { incomingDocument: { status: 'provided', reference: 'NY-REFERENS' } }), f.admin.token);
  assert.equal(metadata.snapshot.storageAssessment.canReceive, true);
  assert.equal(metadata.snapshot.storageAssessment.checks.find(item => item.code === 'waste_code_unconfigured').severity, 'warning');
  await rejects(() => f.store.correct(original.id, correctionInput(input, { expectedVersion: 2, rows: [{ articleId: 'copper-1', weight: 11 }] }), f.admin.token), 409, 'storage_blocked');
  const reduced = await f.store.correct(original.id, correctionInput(input, { expectedVersion: 2, rows: [{ articleId: 'copper-1', weight: 8 }] }), f.admin.token);
  assert.equal(reduced.snapshot.storageAssessment.canReceive, true);
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts.length, 1);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 8);
}));

test('hazardous scope excludes uncoded copper from the NVV card, stock and reports while preserving generic checks', async () => fixture(async f => {
  await f.policy({ totalMaxKg: 100, rules: [{ wasteCode: '160601', allowed: true, maxKg: 100 }] });
  const input = receiptInput({ materialScope: 'hazardous', rows: [{ articleId: 'copper-1', weight: 20 }, { articleId: 'lead-battery', weight: 10 }] });
  const scoped = await f.store.checkStorage({ siteId: input.siteId, rows: input.rows, materialScope: 'hazardous' }, f.admin.token);
  assert.equal(scoped.canReceive, true);
  assert.equal(scoped.checks.some(check => check.code === 'waste_code_unconfigured' || check.articleId === 'copper-1'), false);
  const generic = await f.store.checkStorage({ siteId: input.siteId, rows: input.rows }, f.admin.token);
  assert.equal(generic.canReceive, false);
  const { idempotencyKey, ...draft } = input;
  const saved = await f.store.saveDraft(input.sourceId, { ...draft, expectedVersion: 0 }, f.admin.token);
  assert.deepEqual(saved.input.rows, [{ articleId: 'lead-battery', weight: 10 }]);
  const original = await f.store.receive({ ...input, expectedDraftVersion: saved.version }, f.admin.token);
  assert.equal(original.snapshot.materialScope, 'hazardous');
  assert.deepEqual(original.snapshot.rows.map(row => row.articleId), ['lead-battery']);
  assert.equal(original.hash, environmentHash(original.snapshot));
  assert.equal((await f.store.receive(input, f.admin.token)).id, original.id);
  const state = await f.store.state(f.admin.token);
  assert.deepEqual(state.inventory.map(row => [row.articleId, row.weight]), [['lead-battery', 10]]);
  assert.deepEqual(state.reports.map(row => [row.articleId, row.weight]), [['lead-battery', 10]]);
  await rejects(() => f.store.receive(receiptInput({ materialScope: 'hazardous', rows: [{ articleId: 'copper-1', weight: 20 }] }), f.admin.token), 422, 'hazardous_material_required');
  // Omitting scope cannot widen an already scoped receipt or inventory.
  const widened = await f.store.correct(original.id, correctionInput(input, { materialScope: undefined, rows: input.rows }), f.admin.token);
  assert.deepEqual(widened.snapshot.rows.map(row => row.articleId), ['lead-battery']);
  assert.equal(widened.snapshot.materialScope, 'hazardous');
}));

test('hazardous scope still enforces waste-code capacity and article storage permission atomically', async () => fixture(async f => {
  await f.policy({ rules: [{ wasteCode: '160601', allowed: true, maxKg: 5 }] });
  const input = receiptInput({ materialScope: 'hazardous', rows: [{ articleId: 'copper-1', weight: 20 }, { articleId: 'lead-battery', weight: 10 }] });
  const blocked = await f.store.checkStorage({ siteId: input.siteId, rows: input.rows, materialScope: 'hazardous' }, f.admin.token);
  assert.equal(blocked.canReceive, false);
  assert.equal(blocked.checks.some(check => check.code === 'waste_code_capacity_exceeded'), true);
  await rejects(() => f.store.receive(input, f.admin.token), 409, 'storage_blocked');
  await f.policy({ expectedVersion: 1, rules: [{ wasteCode: '160601', allowed: true, maxKg: 100 }] });
  await f.classify('lead-battery', { storageRules: [] });
  await rejects(() => f.store.receive(input, f.admin.token), 409, 'storage_blocked');
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts.length, 0); assert.equal(state.inventory.length, 0); assert.equal(state.reports.length, 0);
}));

test('hazardous scope corrections preserve legacy copper stock and the frozen hazardous classification', async () => fixture(async f => {
  const input = receiptInput({ rows: [{ articleId: 'copper-1', weight: 20 }, { articleId: 'lead-battery', weight: 10 }] });
  const original = await f.store.receive(input, f.admin.token);
  await f.policy({ totalMaxKg: 100, rules: [{ wasteCode: '160601', allowed: true, maxKg: 20 }] });
  await f.classify('lead-battery', { hazardous: false, wasteCode: '', wasteDescription: '' });
  const rows = [{ articleId: 'lead-battery', weight: 12 }];
  const check = await f.store.checkStorage({ siteId: input.siteId, receiptId: original.id, rows, materialScope: 'hazardous' }, f.admin.token);
  assert.equal(check.canReceive, true);
  assert.equal(check.checks.some(item => item.articleId === 'copper-1' || item.code === 'waste_code_unconfigured'), false);
  assert.equal(check.checks.find(item => item.code === 'site_capacity').currentKg, 30);
  assert.equal(check.checks.find(item => item.code === 'site_capacity').incomingKg, 2);
  const correction = correctionInput(input, { materialScope: 'hazardous', rows });
  const updated = await f.store.correct(original.id, correction, f.admin.token);
  assert.deepEqual(updated.originalSnapshot, original.snapshot);
  assert.deepEqual(updated.snapshot.rows.map(row => [row.articleId, row.weight]), [['copper-1', 20], ['lead-battery', 12]]);
  assert.equal(updated.snapshot.rows[1].classification.hazardous, true);
  assert.equal(updated.snapshot.rows[1].classification.wasteCode, '160601');
  assert.deepEqual(updated.correctionHistory[0].inventoryMovements.map(row => [row.articleId, row.weight]), [['lead-battery', 2]]);
  assert.equal((await f.store.correct(original.id, correction, f.admin.token)).hash, updated.hash);
  await rejects(() => f.store.correct(original.id, correctionInput(input, { materialScope: 'hazardous', expectedVersion: 2, rows: [{ articleId: 'lead-battery', weight: 21 }] }), f.admin.token), 409, 'storage_blocked');
  const state = await f.store.state(f.admin.token);
  assert.equal(state.inventory.filter(row => row.articleId === 'copper-1').reduce((sum, row) => sum + row.weight, 0), 20);
  assert.deepEqual(state.reports.map(row => [row.articleId, row.weight]), [['lead-battery', 12]]);
  await f.restart(); assert.equal((await f.store.state(f.admin.token)).receipts[0].hash, updated.hash);
}));

test('hazardous scope removal can correct the last hazardous row without clearing legacy stock or widening drafts', async () => fixture(async f => {
  const input = receiptInput({ rows: [{ articleId: 'copper-1', weight: 20 }, { articleId: 'lead-battery', weight: 10 }] });
  const original = await f.store.receive(input, f.admin.token);
  await f.policy({ rules: [{ wasteCode: '160601', allowed: true, maxKg: 100 }] });
  const correction = correctionInput(input, { materialScope: 'hazardous', rows: [] });
  const updated = await f.store.correct(original.id, correction, f.admin.token);
  assert.deepEqual(updated.snapshot.rows.map(row => [row.articleId, row.weight]), [['copper-1', 20]]);
  assert.deepEqual(updated.originalSnapshot, original.snapshot);
  assert.deepEqual(updated.correctionHistory[0].inventoryMovements.map(row => [row.articleId, row.weight]), [['lead-battery', -10]]);
  assert.equal((await f.store.correct(original.id, correction, f.admin.token)).hash, updated.hash);
  const state = await f.store.state(f.admin.token);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 20);
  assert.equal(state.reports.length, 0);
  const draftInput = receiptInput({ materialScope: 'hazardous', rows: input.rows });
  const { idempotencyKey, ...draft } = draftInput;
  const first = await f.store.saveDraft(draft.sourceId, { ...draft, expectedVersion: 0 }, f.admin.token);
  const { materialScope, ...withoutScope } = draft;
  const second = await f.store.saveDraft(draft.sourceId, { ...withoutScope, expectedVersion: first.version }, f.admin.token);
  assert.equal(second.input.materialScope, 'hazardous');
  assert.deepEqual(second.input.rows, [{ articleId: 'lead-battery', weight: 10 }]);
  await rejects(() => f.store.receive(receiptInput({ materialScope: 'hazardous', rows: [] }), f.admin.token), 422);
}));

test('capacity enforcement is atomic across repository instances and failed receipts leave no stock or audit', async () => fixture(async f => {
  await f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 10 }] });
  const otherRepository = await createEnvironmentRepository(f.options);
  try {
    const otherStore = createEnvironmentStore({ repository: otherRepository, principalStore: f.principalStore, now: f.now });
    const results = await Promise.allSettled([f.store.receive(receiptInput(), f.kajsa.token), otherStore.receive(receiptInput(), f.admin.token)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'storage_blocked');
    const state = await f.store.state(f.admin.token), backup = JSON.parse(await f.repository.backup());
    assert.equal(state.receipts.length, 1); assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 10);
    assert.equal(backup.audit.filter(item => item.action === 'environment.received').length, 1);
    const successful = results.find(result => result.status === 'fulfilled').value;
    await f.classify('lead-battery', { storageRules: [] });
    const originalRequest = receiptInput({ sourceId: successful.sourceId, cardId: successful.cardId, receivedAt: successful.snapshot.receivedAt });
    assert.equal((await f.store.receive(originalRequest, f.admin.token)).id, successful.id);
  } finally { await otherRepository.close(); }
}));

test('corrections assess only the delta and reductions remain possible after revoked permits and site deactivation', async () => fixture(async f => {
  await f.classify('lead-battery', { storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 10 }] });
  const input = receiptInput(), original = await f.store.receive(input, f.admin.token);
  const unchanged = await f.store.checkStorage({ siteId: 'norrtalje', receiptId: original.id, rows: input.rows }, f.admin.token);
  assert.equal(unchanged.canReceive, true); assert.equal(unchanged.checks.find(item => item.articleId === 'lead-battery').incomingKg, 0);
  await rejects(() => f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 11 }] }), f.admin.token), 409, 'storage_blocked');
  await f.classify('lead-battery', { storageRules: [] }); await f.policy({ totalMaxKg: 0, rules: [] });
  const site = (await f.store.catalog()).find(item => item.id === 'norrtalje');
  const { id, version, updatedAt, updatedBy, ...siteValues } = site;
  await f.store.saveSite(site.id, { ...siteValues, expectedVersion: version, active: false }, f.admin.token);
  const correction = correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 8 }] });
  const reduced = await f.store.correct(original.id, correction, f.admin.token);
  assert.equal(reduced.version, 2); assert.equal(reduced.snapshot.storageAssessment.canReceive, true);
  assert.equal((await f.store.correct(original.id, correction, f.admin.token)).hash, reduced.hash);
  assert.deepEqual(reduced.originalSnapshot, original.snapshot);
  const state = await f.store.state(f.admin.token); assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 8);
  await rejects(() => f.store.correct(original.id, correctionInput(input, { expectedVersion: 2, rows: [{ articleId: 'lead-battery', weight: 9 }] }), f.admin.token), 409, 'storage_blocked');
  await rejects(() => f.store.receive(receiptInput(), f.admin.token), 409, 'storage_blocked');
  await f.restart(); assert.equal((await f.store.state(f.admin.token)).receipts[0].hash, reduced.hash);
}));

test('receipt waste codes remain frozen while current article storage rules govern positive corrections', async () => fixture(async f => {
  await f.policy({ rules: [{ wasteCode: '160601', allowed: true, maxKg: 12 }, { wasteCode: '170401', allowed: true, maxKg: 100 }] });
  const input = receiptInput(), original = await f.store.receive(input, f.admin.token);
  await f.classify('lead-battery', { wasteCode: '170401', storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 100 }] });
  const preview = await f.store.checkStorage({ siteId: 'norrtalje', receiptId: original.id, rows: [{ articleId: 'lead-battery', weight: 13 }] }, f.admin.token);
  assert.equal(preview.canReceive, false); assert.equal(preview.checks.find(item => item.code === 'waste_code_capacity_exceeded').wasteCode, '160601');
  const updated = await f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 12 }] }), f.admin.token);
  assert.equal(updated.snapshot.rows[0].classification.wasteCode, '160601');
  const newReceipt = await f.store.receive(receiptInput(), f.admin.token);
  assert.equal(newReceipt.snapshot.rows[0].classification.wasteCode, '170401');
}));

test('storage policies reject stale writes, invalid limits and operation/site permission bypasses', async () => fixture(async f => {
  await rejects(() => f.store.saveStoragePolicy('norrtalje', { expectedVersion: 0, totalMaxKg: -1, rules: [] }, f.admin.token), 422);
  await rejects(() => f.policy({ rules: [{ wasteCode: '160601', allowed: true, maxKg: null }, { wasteCode: '160601', allowed: true, maxKg: 1 }] }), 422);
  await rejects(() => f.store.saveStoragePolicy('norrtalje', { expectedVersion: 0, totalMaxKg: null, rules: [] }, f.kajsa.token), 403, 'forbidden');
  const results = await Promise.allSettled([f.policy(), f.policy({ totalMaxKg: 100 })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.find(result => result.status === 'rejected').reason.code, 'version_conflict');
  f.grants.set('kajsa', ['environmentRead', 'environmentStorage']); f.restrictions.set('kajsa', ['rimbo']);
  await rejects(() => f.store.checkStorage({ siteId: 'norrtalje', rows: receiptInput().rows }, f.kajsa.token), 403, 'site_forbidden');
  await rejects(() => f.store.saveStoragePolicy('norrtalje', { expectedVersion: 1, totalMaxKg: null, rules: [] }, f.kajsa.token), 403, 'site_forbidden');
  const before = (await f.store.state(f.admin.token)).revision;
  await f.store.checkStorage({ siteId: 'norrtalje', rows: receiptInput().rows }, f.admin.token);
  assert.equal((await f.store.state(f.admin.token)).revision, before);
}));

test('HTTP facility/storage endpoints enforce staff cookies and CSRF and support newly registered site addresses', async () => fixture(async f => {
  const api = createEnvironmentApi({ repository: f.repository, principalStore: f.principalStore, now: f.now });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', value, headers = {}) => fetch(`${base}/api/environment${path}`, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) });
  try {
    assert.equal((await call('/sites/new-site', 'PUT', siteInput(), { 'X-Demo-User': 'admin' })).status, 401);
    const login = await call('/demo-session', 'POST', { userId: 'admin' }, { Origin: base });
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/sites/new-site', 'PUT', siteInput(), { Cookie: cookie, Origin: base })).status, 403);
    const auth = { Cookie: cookie, Origin: base, 'X-Environment-CSRF': session.csrfToken };
    assert.equal((await call('/sites/new-site', 'PUT', siteInput(), auth)).status, 200);
    assert.equal((await api.getSites()).find(item => item.id === 'new-site').name, 'Testanläggning');
    assert.equal((await call('/storage/policies/new-site', 'PUT', { expectedVersion: 0, totalMaxKg: 100, rules: [{ wasteCode: '160601', allowed: true, maxKg: 100 }] }, auth)).status, 200);
    const check = await call('/storage/check', 'POST', { siteId: 'new-site', rows: receiptInput().rows }, auth);
    assert.equal(check.status, 200); assert.equal((await check.json()).canReceive, true);
    const address = await call('/address/resolve', 'POST', { siteId: 'new-site', originAddress: 'Testgatan 12, 761 41 Norrtälje', municipalityCode: '0188' }, auth);
    assert.equal(address.status, 200);
    assert.equal((await call('/storage/check', 'POST', { siteId: 'new-site', rows: receiptInput().rows }, { ...auth, Origin: 'https://hostile.example' })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));
