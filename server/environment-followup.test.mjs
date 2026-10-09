import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore, environmentHash } from './environment-model.mjs';
import { createEnvironmentApi } from './environment-api.mjs';

const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
const rejects = (operation, status, code) => assert.rejects(async () => operation(), (error) => error.status === status && (!code || error.code === code));
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const receiptInput = (changes = {}) => ({
  sourceId: randomUUID(), cardId: 2050, siteId: 'norrtalje', receivedAt: '2026-10-09T10:00:00+02:00',
  originAddress: 'Testgatan 12, 761 41 Norrtälje',
  rows: [{ articleId: 'lead-battery', weight: 250 }, { articleId: 'copper-1', weight: 12 }],
  previousHolder: { name: 'Verkstad Test AB', number: '556000-0167', contactName: '', email: '', phone: '' },
  lastPlace: { ...place }, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road',
  incomingDocument: { status: 'provided' }, idempotencyKey: randomUUID(), ...changes,
});
const correctionInput = (original, changes = {}) => {
  const { sourceId, cardId, siteId, idempotencyKey, ...fields } = original;
  return { ...fields, expectedVersion: 1, reason: 'Vägaren kontrollerade nettovikten igen.', idempotencyKey: randomUUID(), ...changes };
};
const draftInput = (input, version = 0) => {
  const { idempotencyKey, ...fields } = input;
  return { ...fields, expectedVersion: version };
};

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-env-followup-'));
  let options = { env: {}, filename: join(directory, 'environment.sqlite') }, postgres, schema;
  if (postgresUrl) {
    const { Pool } = await import('pg');
    postgres = new Pool({ connectionString: postgresUrl });
    schema = `jeroc_env_followup_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(postgresUrl); connection.searchParams.set('options', `-c search_path=${schema}`);
    options = { env: { DATABASE_URL: connection.toString() } };
  }
  let repository = await createEnvironmentRepository(options);
  let time = new Date('2026-10-16T10:00:00Z');
  const pricing = createPricingStore({ now: () => time }), restrictions = new Map();
  const principalStore = { ...pricing, principal(actor, effective) {
    const principal = pricing.principal(actor, effective);
    if (restrictions.has(principal.user.id)) principal.user.siteIds = restrictions.get(principal.user.id);
    return principal;
  } };
  const makeStore = () => createEnvironmentStore({ repository, principalStore, now: () => time, demoMode: true });
  let store = makeStore();
  const admin = await store.demoSession({ userId: 'admin' });
  const kajsa = await store.demoSession({ userId: 'kajsa' });
  const anna = await store.demoSession({ userId: 'anna' });
  try {
    await run({ get store() { return store; }, get repository() { return repository; }, admin, kajsa, anna, principalStore, restrictions, repositoryOptions: options,
      advance: (milliseconds) => { time = new Date(time.getTime() + milliseconds); },
      restart: async () => { await repository.close(); repository = await createEnvironmentRepository(options); store = makeStore(); },
    });
  } finally {
    await repository.close();
    if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('a partial environmental draft survives restart without creating stock, report or financial records', async () => fixture(async (f) => {
  const input = receiptInput({ rows: [], previousHolder: { name: '', number: '', contactName: '', email: '', phone: '' },
    lastPlace: { address: '', postalCode: '', city: '', municipalityCode: '' },
    nextPlace: { address: '', postalCode: '', city: '', municipalityCode: '' }, incomingDocument: { status: 'unknown' } });
  assert.equal(await f.store.draft(input.sourceId, f.kajsa.token), null);
  const saved = await f.store.saveDraft(input.sourceId, draftInput(input), f.kajsa.token);
  assert.equal(saved.version, 1); assert.equal(saved.sourceId, input.sourceId);
  assert.equal(saved.input.originAddress, input.originAddress); assert.equal(saved.input.previousHolder.name, '');
  await f.restart();
  assert.deepEqual(await f.store.draft(input.sourceId, f.admin.token), saved);
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts.length, 0); assert.equal(state.inventory.length, 0); assert.equal(state.reports.length, 0);
  const backup = JSON.parse(await f.repository.backup());
  assert.equal(Object.hasOwn(backup, 'payments'), false); assert.equal(Object.hasOwn(backup, 'ledger'), false);
  await rejects(() => f.store.receive(input, f.kajsa.token), 422);
}));

test('draft revisions prevent lost updates and enforce current article, operation and site permissions', async () => fixture(async (f) => {
  const input = receiptInput(), first = await f.store.saveDraft(input.sourceId, draftInput(input), f.kajsa.token);
  await rejects(() => f.store.saveDraft(input.sourceId, draftInput({ ...input, originAddress: 'En gammal ändring' }), f.admin.token), 409, 'version_conflict');
  const updated = await f.store.saveDraft(input.sourceId, draftInput({ ...input, originAddress: 'Ny adress 2, 761 41 Norrtälje' }, first.version), f.admin.token);
  assert.equal(updated.version, 2); assert.equal(updated.input.originAddress, 'Ny adress 2, 761 41 Norrtälje');
  await rejects(() => f.store.saveDraft(input.sourceId, draftInput(input, 2), f.anna.token), 403, 'forbidden');
  const unknownArticle = receiptInput({ rows: [{ articleId: 'not-an-article', weight: 1 }] });
  await rejects(() => f.store.saveDraft(unknownArticle.sourceId, draftInput(unknownArticle), f.admin.token), 422);
  await rejects(() => f.store.saveDraft(input.sourceId, draftInput({ ...input, rows: [{ articleId: 'lead-battery', weight: 0 }] }, 2), f.admin.token), 422);
  f.restrictions.set('kajsa', ['rimbo']);
  await rejects(() => f.store.draft(input.sourceId, f.kajsa.token), 403, 'site_forbidden');
  await rejects(() => f.store.saveDraft(input.sourceId, draftInput(input, 2), f.kajsa.token), 403, 'site_forbidden');
  assert.equal((await f.store.draft(input.sourceId, f.admin.token)).version, 2);
}));

test('holder numbers keep the supported formats and report readable Swedish validation on receipts and corrections', async () => fixture(async (f) => {
  const message = 'Ange ett giltigt org-/personnummer med 10 eller 12 siffror, eller ett utländskt nummer med landskod.';
  for (const number of ['123456789', '1981100225860', 'Demo · privatperson', 'no123456789']) {
    await assert.rejects(async () => f.store.receive(receiptInput({ previousHolder: { name: 'Testinnehavare', number } }), f.admin.token), error => {
      assert.equal(error.status, 422);
      assert.ok(error.message.includes(`Tidigare innehavare – org-/personnummer: ${message}`));
      assert.equal(error.message.includes('Invalid'), false);
      return true;
    });
  }
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 0);
  for (const [number, normalized] of [['811002-2586', '8110022586'], ['19811002-2586', '198110022586'], ['NO123456789MVA', 'NO123456789MVA']]) {
    const input = receiptInput({ previousHolder: { name: 'Testinnehavare', number } });
    const receipt = await f.store.receive(input, f.admin.token);
    assert.equal(receipt.snapshot.previousHolder.number, normalized);
    await assert.rejects(async () => f.store.correct(receipt.id, correctionInput(input, { previousHolder: { name: 'Testinnehavare', number: '123456789' } }), f.admin.token), error => error.status === 422 && error.message.includes(message));
    const current = (await f.store.state(f.admin.token)).receipts.find(item => item.id === receipt.id);
    assert.equal(current.version, 1);
    assert.equal(current.hash, receipt.hash);
  }
}));

test('confirming a receipt clears its draft and subsequent draft edits cannot overwrite the immutable receipt', async () => fixture(async (f) => {
  const input = receiptInput();
  await f.store.saveDraft(input.sourceId, draftInput(input), f.kajsa.token);
  await f.store.saveDraft(input.sourceId, draftInput({ ...input, incomingDocument: { status: 'provided', reference: 'KOLLEGANS-NYA-UPPGIFT' } }, 1), f.admin.token);
  await rejects(() => f.store.receive({ ...input, expectedDraftVersion: 1 }, f.kajsa.token), 409, 'version_conflict');
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 0);
  assert.equal((await f.store.draft(input.sourceId, f.admin.token)).version, 2);
  const original = await f.store.receive({ ...input, incomingDocument: { status: 'provided', reference: 'KOLLEGANS-NYA-UPPGIFT' }, expectedDraftVersion: 2 }, f.kajsa.token);
  assert.equal(await f.store.draft(input.sourceId, f.admin.token), null);
  assert.equal(Object.hasOwn(original.snapshot, 'expectedDraftVersion'), false);
  assert.equal((await f.store.receive({ ...input, incomingDocument: { status: 'provided', reference: 'KOLLEGANS-NYA-UPPGIFT' }, expectedDraftVersion: 2 }, f.kajsa.token)).id, original.id);
  await rejects(() => f.store.saveDraft(input.sourceId, draftInput({ ...input, rows: [{ articleId: 'lead-battery', weight: 245 }] }, 1), f.admin.token), 409, 'receipt_already_recorded');
  assert.equal((await f.store.state(f.admin.token)).receipts[0].hash, original.hash);
}));

test('optional document references distinguish present, exempt, missing and unknown documents', async () => fixture(async (f) => {
  const provided = await f.store.receive(receiptInput(), f.kajsa.token);
  assert.equal(provided.snapshot.incomingDocument.status, 'provided'); assert.equal(provided.deviations.length, 0);
  const exempt = await f.store.receive(receiptInput({ incomingDocument: { status: 'not_required', exemptionReason: 'Privat hushåll lämnar eget avfall.' } }), f.kajsa.token);
  assert.equal(exempt.deviations.length, 0); assert.equal(exempt.snapshot.incomingDocument.exemptionReason, 'Privat hushåll lämnar eget avfall.');
  const unknown = await f.store.receive(receiptInput({ incomingDocument: { status: 'unknown' } }), f.kajsa.token);
  assert.equal(unknown.snapshot.incomingDocument.status, 'unknown');
  assert.equal(unknown.deviations.some((item) => item.code === 'missing_document'), false);
  const missing = await f.store.receive(receiptInput({ incomingDocument: { status: 'missing', missingReason: 'Begärs från åkeriet.' } }), f.kajsa.token);
  assert.equal(missing.deviations.some((item) => item.code === 'missing_document'), true);
  await rejects(() => f.store.receive(receiptInput({ incomingDocument: { status: 'missing' } }), f.kajsa.token), 422);
  const legacyReference = await f.store.receive(receiptInput({ incomingDocument: { reference: 'TD-LEGACY' } }), f.kajsa.token);
  assert.equal(legacyReference.deviations.length, 0);
  const legacyMissing = await f.store.receive(receiptInput({ incomingDocument: { missingReason: 'Legacy avvikelse.' } }), f.kajsa.token);
  assert.equal(legacyMissing.deviations.some((item) => item.code === 'missing_document'), true);
}));

test('not_shown document status needs no reference and preserves automatic or manual selection without reporting blockers', async () => fixture(async (f) => {
  const provided = await f.store.receive(receiptInput({ materialScope: 'hazardous' }), f.kajsa.token);
  const baselineReport = (await f.store.state(f.admin.token)).reports.find(report => report.receiptId === provided.id);
  const originals = [];
  for (const selection of ['automatic', 'manual']) {
    const input = receiptInput({ materialScope: 'hazardous', incomingDocument: { status: 'not_shown', reference: '', selection } });
    const draft = await f.store.saveDraft(input.sourceId, draftInput(input), f.kajsa.token);
    assert.deepEqual(draft.input.incomingDocument, input.incomingDocument);
    const receipt = await f.store.receive({ ...input, expectedDraftVersion: draft.version }, f.kajsa.token);
    assert.deepEqual(receipt.snapshot.incomingDocument, input.incomingDocument);
    assert.deepEqual(receipt.deviations, []);
    assert.equal(receipt.hash, environmentHash(receipt.snapshot));
    assert.equal((await f.store.receive(input, f.kajsa.token)).hash, receipt.hash);
    const report = (await f.store.state(f.admin.token)).reports.find(report => report.receiptId === receipt.id);
    assert.deepEqual(report.missingFields, baselineReport.missingFields);
    originals.push({ input, receipt });
  }
  await rejects(() => f.store.receive(receiptInput({ incomingDocument: { status: 'missing', selection: 'manual' } }), f.kajsa.token), 422);
  await rejects(() => f.store.receive(receiptInput({ incomingDocument: { status: 'not_required', selection: 'automatic' } }), f.kajsa.token), 422);
  await f.restart();
  const state = await f.store.state(f.admin.token);
  for (const { input, receipt } of originals) {
    const reopened = state.receipts.find(item => item.id === receipt.id);
    assert.equal(reopened.hash, receipt.hash);
    assert.deepEqual(reopened.snapshot.incomingDocument, input.incomingDocument);
    assert.equal((await f.store.receive(input, f.kajsa.token)).id, receipt.id);
  }
}));

test('weight corrections retain original snapshots and append signed inventory movements exactly once', async () => fixture(async (f) => {
  const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
  const originalRows = structuredClone((await f.store.state(f.admin.token)).inventory);
  const correction = correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 10 }] });
  const fixed = await f.store.correct(original.id, correction, f.kajsa.token);
  assert.equal(fixed.version, 2); assert.equal(fixed.hash, environmentHash(fixed.snapshot)); assert.notEqual(fixed.hash, original.hash);
  assert.deepEqual(fixed.originalSnapshot, original.snapshot); assert.equal(fixed.correctionHistory.length, 1);
  assert.equal(fixed.snapshot.rows.find((row) => row.articleId === 'lead-battery').weight, 245);
  const state = await f.store.state(f.anna.token), physicalOriginals = state.inventory.filter((row) => row.kind === 'receipt');
  assert.deepEqual(physicalOriginals, originalRows);
  assert.equal(state.inventory.filter((row) => row.kind === 'correction').reduce((sum, row) => sum + row.weight, 0), -7);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 255);
  assert.equal(state.reports.length, 1); assert.equal(state.reports[0].weight, 245);
  const retry = await f.store.correct(original.id, correction, f.kajsa.token);
  assert.equal(retry.hash, fixed.hash); assert.equal(retry.correctionHistory.length, 1);
  assert.equal((await f.store.state(f.admin.token)).inventory.length, state.inventory.length);
  await rejects(() => f.store.correct(original.id, { ...correction, rows: [{ articleId: 'lead-battery', weight: 240 }] }, f.kajsa.token), 409);
  await f.restart();
  const reopened = (await f.store.state(f.admin.token)).receipts.find((receipt) => receipt.id === original.id);
  assert.deepEqual(reopened.originalSnapshot, original.snapshot); assert.equal(reopened.hash, fixed.hash); assert.equal(reopened.correctionHistory.length, 1);
  const backupText = await f.repository.backup(), backup = JSON.parse(backupText);
  assert.deepEqual(backup.receipts.find((receipt) => receipt.id === original.id).snapshot, original.snapshot);
  await f.repository.restore(backupText);
  assert.equal((await f.store.state(f.admin.token)).receipts.find((receipt) => receipt.id === original.id).hash, fixed.hash);
}));

test('metadata corrections preserve physical totals and can shorten but never extend environmental deadlines', async () => fixture(async (f) => {
  const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
  const firstState = await f.store.state(f.admin.token), report = firstState.reports[0];
  assert.equal(report.noteDueDate, '2026-10-13'); assert.equal(report.reportDueDate, '2026-10-15');
  const updated = await f.store.correct(original.id, correctionInput(input, { receivedAt: '2026-10-12T10:00:00+02:00',
    incomingDocument: { status: 'provided', reference: 'TD-COMPLETED' } }), f.kajsa.token);
  let state = await f.store.state(f.admin.token);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 262);
  assert.equal(state.inventory.length, firstState.inventory.length);
  assert.equal(state.reports[0].noteDueDate, report.noteDueDate); assert.equal(state.reports[0].reportDueDate, report.reportDueDate);
  const earlier = await f.store.correct(original.id, correctionInput(input, { expectedVersion: 2, receivedAt: '2026-10-08T10:00:00+02:00' }), f.admin.token);
  assert.equal(earlier.version, 3); assert.equal(earlier.correctionHistory.length, 2);
  state = await f.store.state(f.admin.token);
  assert.equal(state.reports[0].noteDueDate, '2026-10-12'); assert.equal(state.reports[0].reportDueDate, '2026-10-14');
  assert.deepEqual(earlier.originalSnapshot, original.snapshot); assert.notEqual(updated.hash, earlier.hash);
}));

test('concurrent corrections use current versions and recheck write/site rights without accepting financial prices', async () => fixture(async (f) => {
  const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
  await rejects(() => f.store.correct(original.id, correctionInput(input), f.anna.token), 403, 'forbidden');
  await rejects(() => f.store.correct(original.id, correctionInput(input, { reason: '' }), f.kajsa.token), 422);
  await rejects(() => f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245, price: 4.5 }] }), f.kajsa.token), 422);
  f.restrictions.set('kajsa', ['rimbo']);
  await rejects(() => f.store.correct(original.id, correctionInput(input), f.kajsa.token), 403, 'site_forbidden');
  f.restrictions.delete('kajsa');
  const outcomes = await Promise.allSettled([
    f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] }), f.kajsa.token),
    f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 240 }, { articleId: 'copper-1', weight: 12 }] }), f.admin.token),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected'); assert.equal(rejected.reason.status, 409); assert.equal(rejected.reason.code, 'version_conflict');
  const state = await f.store.state(f.admin.token), effective = state.receipts[0];
  assert.equal(effective.correctionHistory.length, 1);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), effective.snapshot.rows.reduce((sum, row) => sum + row.weight, 0));
  assert.equal(state.reports[0].weight, effective.snapshot.rows.find((row) => row.articleId === 'lead-battery').weight);
}));

test('a correction can remove all physical material without deleting its incoming original or extending deadlines', async () => fixture(async (f) => {
  const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
  const corrected = await f.store.correct(original.id, correctionInput(input, { rows: [], reason: 'Lasten registrerades på fel invägning.' }), f.admin.token);
  assert.equal(corrected.snapshot.rows.length, 0); assert.deepEqual(corrected.originalSnapshot, original.snapshot);
  const state = await f.store.state(f.admin.token);
  assert.equal(state.inventory.filter((row) => row.kind === 'receipt').length, 2);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 0);
  assert.equal(state.reports.length, 0);
  const priorReport = state.reportHistory.find((report) => report.receiptId === original.id && report.weight === 250);
  assert.equal(priorReport.noteDueDate, '2026-10-13');
  await rejects(() => f.repository.transact((stored) => { stored.corrections[0].reason = 'Omskrivet original'; }), 409, 'immutable_record');
}));

test('a quantity correction retains the original hazardous classification despite later article master changes', async () => fixture(async (f) => {
  const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
  await f.store.classify('lead-battery', { expectedVersion: 1, hazardous: false, wasteCode: '', wasteDescription: '', handlingInstructions: 'Ny instruktion', adrRequired: false }, f.admin.token);
  const corrected = await f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] }), f.admin.token);
  const lead = corrected.snapshot.rows.find((row) => row.articleId === 'lead-battery');
  assert.equal(lead.classification.version, 1); assert.equal(lead.classification.hazardous, true); assert.equal(lead.classification.wasteCode, '160601');
  const state = await f.store.state(f.admin.token);
  assert.equal(state.reports.length, 1); assert.equal(state.reports[0].wasteCode, '160601'); assert.equal(state.reports[0].weight, 245);
}));

test('derived address data belongs to the weight card origin and rejects stale or incomplete matches', async () => fixture(async (f) => {
  const input = receiptInput();
  const addressResolution = { originAddress: input.originAddress, status: 'resolved', provider: 'demo-address-register', municipalityConfirmed: true };
  const saved = await f.store.saveDraft(input.sourceId, draftInput({ ...input, addressResolution }), f.kajsa.token);
  assert.equal(saved.input.addressResolution.originAddress, input.originAddress);
  const recorded = await f.store.receive({ ...input, addressResolution }, f.kajsa.token);
  assert.deepEqual(recorded.snapshot.addressResolution, addressResolution);
  const stale = receiptInput();
  await rejects(() => f.store.receive({ ...stale, addressResolution: { ...addressResolution, originAddress: 'En annan gata 1' } }, f.kajsa.token), 422, 'address_origin_mismatch');
  await rejects(() => f.store.correct(recorded.id, correctionInput(input, { originAddress: 'Ny gata 3', addressResolution }), f.kajsa.token), 422, 'address_origin_mismatch');
  const unresolved = receiptInput({ lastPlace: { ...place, municipalityCode: '' } });
  await rejects(() => f.store.receive({ ...unresolved, addressResolution: { originAddress: unresolved.originAddress, status: 'needs_municipality', provider: 'demo-address-register' } }, f.kajsa.token), 422);
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 1);
}));

test('changing the canonical origin invalidates old derived draft places without starting stock or deadline records', async () => fixture(async (f) => {
  const input = receiptInput(), addressResolution = { originAddress: input.originAddress, status: 'resolved', provider: 'test-resolver', resolvedAt: '2026-10-09T08:00:00Z' };
  await f.store.saveDraft(input.sourceId, draftInput({ ...input, addressResolution }), f.kajsa.token);
  const originAddress = 'Ny gata 3, 753 20 Uppsala';
  const changed = await f.store.saveDraft(input.sourceId, draftInput({ ...input, originAddress }, 1), f.admin.token);
  assert.equal(changed.version, 2);
  assert.deepEqual(changed.input.lastPlace, { address: 'Ny gata 3', postalCode: '75320', city: 'Uppsala', municipalityCode: '' });
  assert.equal(changed.input.addressResolution.originAddress, originAddress);
  assert.equal(changed.input.addressResolution.status, 'needs_municipality');
  const incomplete = await f.store.saveDraft(input.sourceId, draftInput({ ...input, originAddress: 'Ny gata 3' }, 2), f.admin.token);
  assert.equal(incomplete.input.addressResolution.status, 'needs_address');
  assert.equal(incomplete.input.lastPlace.municipalityCode, '');
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts.length, 0); assert.equal(state.inventory.length, 0); assert.equal(state.reports.length, 0);
}));

test('a matching provenance label cannot confirm a stale place or an invalid Swedish municipality', async () => fixture(async (f) => {
  const changed = receiptInput({ originAddress: 'Ny gata 3, 753 20 Uppsala' });
  changed.addressResolution = { originAddress: changed.originAddress, status: 'resolved', provider: 'test-resolver' };
  await rejects(() => f.store.receive(changed, f.kajsa.token), 422, 'address_origin_mismatch');
  const invalid = receiptInput({ lastPlace: { ...place, municipalityCode: '9999' } });
  await rejects(() => f.store.receive(invalid, f.kajsa.token), 422, 'municipality_invalid');
  const input = receiptInput(), recorded = await f.store.receive(input, f.kajsa.token);
  await rejects(() => f.store.correct(recorded.id, correctionInput(input, { originAddress: changed.originAddress, addressResolution: changed.addressResolution }), f.kajsa.token), 422, 'address_origin_mismatch');
  assert.equal((await f.store.state(f.admin.token)).receipts[0].version, 1);
}));

test('different lookup timestamps do not duplicate the same receipt or correction across staff sessions', async () => fixture(async (f) => {
  const input = receiptInput();
  input.addressResolution = { originAddress: input.originAddress, status: 'resolved', provider: 'test-resolver', resolvedAt: '2026-10-09T08:00:00Z' };
  const original = await f.store.receive(input, f.kajsa.token);
  const retried = await f.store.receive({ ...input, idempotencyKey: randomUUID(), addressResolution: { ...input.addressResolution, resolvedAt: '2026-10-09T08:00:05Z' } }, f.admin.token);
  assert.equal(retried.id, original.id); assert.equal(retried.hash, original.hash);
  const request = correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] });
  const corrected = await f.store.correct(original.id, request, f.kajsa.token);
  const correctionRetry = await f.store.correct(original.id, { ...request, idempotencyKey: randomUUID(), addressResolution: { ...input.addressResolution, resolvedAt: '2026-10-09T08:00:10Z' } }, f.admin.token);
  assert.equal(correctionRetry.hash, corrected.hash); assert.equal(correctionRetry.correctionHistory.length, 1);
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts.length, 1); assert.equal(state.inventory.filter((row) => row.kind === 'correction').length, 1);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 257);
}));

test('adding a hazardous article in a correction uses its current classification and retains prior report versions', async () => fixture(async (f) => {
  const input = receiptInput({ rows: [{ articleId: 'copper-1', weight: 12 }] }), original = await f.store.receive(input, f.kajsa.token);
  assert.equal((await f.store.state(f.admin.token)).reports.length, 0);
  await f.store.classify('lead-battery', { expectedVersion: 1, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier – kontrollerad klassificering', handlingInstructions: 'Skydda mot läckage.', adrRequired: false }, f.admin.token);
  const corrected = await f.store.correct(original.id, correctionInput(input, { receivedAt: '2026-10-12T10:00:00+02:00', rows: [{ articleId: 'copper-1', weight: 12 }, { articleId: 'lead-battery', weight: 5 }] }), f.kajsa.token);
  const lead = corrected.snapshot.rows.find((row) => row.articleId === 'lead-battery');
  assert.equal(lead.classification.version, 2); assert.equal(lead.classification.hazardous, true);
  let state = await f.store.state(f.admin.token);
  assert.equal(state.reports.length, 1); assert.equal(state.reports[0].weight, 5);
  assert.equal(state.reports[0].noteDueDate, '2026-10-13'); assert.equal(state.reports[0].reportDueDate, '2026-10-15');
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 17);
  await f.store.correct(original.id, correctionInput(input, { expectedVersion: 2, receivedAt: '2026-10-12T10:00:00+02:00', reason: 'Batteriraden hörde till ett annat kort.' }), f.admin.token);
  state = await f.store.state(f.admin.token);
  assert.equal(state.reports.length, 0); assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 12);
  const historical = state.reportHistory.find((row) => row.receiptId === original.id && row.version === 2);
  assert.equal(historical.status, 'superseded'); assert.equal(historical.weight, 5); assert.equal(historical.noteDueDate, '2026-10-13');
}));

test('automatic demo sessions retain server permissions and can be disabled without accepting a fake principal', async () => fixture(async (f) => {
  const previousToken = f.admin.token, acting = await f.store.demoSession({ userId: 'admin', effectiveUserId: 'anna' }, previousToken);
  assert.equal(acting.result.actualUserId, 'admin'); assert.equal(acting.result.effectiveUserId, 'anna'); assert.equal(acting.result.demo, true);
  await rejects(() => f.store.session(previousToken), 401, 'session_required');
  await rejects(() => f.store.receive(receiptInput(), acting.token), 403, 'forbidden');
  await rejects(() => f.store.demoSession({ userId: 'kajsa', effectiveUserId: 'admin' }), 401);
  await rejects(() => f.store.demoSession({ userId: 'made-up-systemadmin' }), 401);
  const administrator = f.principalStore.principal('admin'), users = f.principalStore.read(administrator).users;
  const reader = users.find((user) => user.id === 'anna');
  f.principalStore.saveUsers({ users: [...users, { ...reader, id: 'new-demo-reader', name: 'Ny miljöläsare' }] }, administrator);
  const custom = await f.store.demoSession({ userId: 'new-demo-reader' });
  assert.equal(custom.result.effectiveUserId, 'new-demo-reader');
  assert.equal((await f.store.state(custom.token)).receipts.length, 0);
  await rejects(() => f.store.receive(receiptInput(), custom.token), 403, 'forbidden');
  const disabled = createEnvironmentStore({ repository: f.repository, principalStore: f.principalStore, demoMode: false });
  await rejects(() => disabled.demoSession({ userId: 'admin' }), 503, 'demo_disabled');
}));

test('Etapp 1 backups without followup fields preserve legacy checksums and accept semantic retries before a new correction', async () => fixture(async (f) => {
  const input = receiptInput({ incomingDocument: { reference: 'LEGACY-TRANSPORT' } });
  delete input.originAddress;
  const original = await f.store.receive(input, f.kajsa.token);
  const backup = JSON.parse(await f.repository.backup());
  const stored = backup.receipts.find(item => item.id === original.id);
  const legacyHash = createHash('sha256').update(JSON.stringify(stored.snapshot)).digest('hex');
  stored.hash = legacyHash; stored.inputHash = 'legacy-input-before-canonical-format'; delete stored.hashFormat;
  backup.requests.find(item => item.receiptId === original.id).inputHash = stored.inputHash;
  delete backup.drafts; delete backup.corrections;
  await f.repository.restore(JSON.stringify(backup)); await f.restart();
  const retry = await f.store.receive(input, f.kajsa.token);
  assert.equal(retry.id, original.id); assert.equal(retry.hash, legacyHash); assert.equal(retry.version, 1);
  assert.equal((await f.store.state(f.admin.token)).inventory.length, 2);
  const corrected = await f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] }), f.kajsa.token);
  assert.equal(corrected.originalHash, legacyHash);
  assert.equal(corrected.hash, environmentHash(corrected.snapshot));
  assert.equal(corrected.version, 2);
}));

test('HTTP automatic demo sessions use HttpOnly cookies and CSRF on draft and correction writes', async () => fixture(async (f) => {
  const api = createEnvironmentApi({ repository: f.repository, principalStore: f.principalStore, env: {}, now: () => new Date('2026-10-16T10:00:00Z') });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', value, headers = {}) => fetch(`${base}/api/environment${path}`, {
    method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  try {
    assert.equal((await call('/demo-session', 'POST', { userId: 'admin' }, { Origin: 'https://foreign.example' })).status, 403);
    const login = await call('/demo-session', 'POST', { userId: 'kajsa' }, { Origin: base });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    const auth = { Cookie: cookie, Origin: base, 'X-Environment-CSRF': session.csrfToken }, input = receiptInput();
    const staleTab = { ...auth, 'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin' };
    for (const [path, method, value] of [
      [`/drafts/${input.sourceId}`, 'PUT', draftInput(input)],
      ['/receipts', 'POST', input],
      ['/classifications/lead-battery', 'PUT', { hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier', handlingInstructions: '', adrRequired: false, expectedVersion: 1 }],
    ]) {
      const blocked = await call(path, method, value, staleTab);
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).code, 'session_identity_mismatch');
    }
    const unchanged = await call('/state', 'GET', undefined, { Cookie: cookie });
    const unchangedState = await unchanged.json();
    assert.equal(unchangedState.drafts.length, 0); assert.equal(unchangedState.receipts.length, 0);
    const matching = await call('/state', 'GET', undefined, { ...auth, 'X-Environment-Actual-User': 'kajsa', 'X-Environment-Effective-User': 'kajsa' });
    assert.equal(matching.status, 200);
    assert.equal((await call(`/drafts/${input.sourceId}`, 'PUT', draftInput(input), { Cookie: cookie, Origin: base })).status, 403);
    const saved = await call(`/drafts/${input.sourceId}`, 'PUT', draftInput(input), auth); assert.equal(saved.status, 200);
    const reloaded = await call(`/drafts/${input.sourceId}`, 'GET', undefined, { Cookie: cookie });
    assert.equal(reloaded.status, 200); assert.equal((await reloaded.json()).input.originAddress, input.originAddress);
    const receipt = await call('/receipts', 'POST', input, auth); assert.equal(receipt.status, 201); const original = await receipt.json();
    assert.equal((await call(`/receipts/${original.id}/corrections`, 'POST', correctionInput(input), { Cookie: cookie, Origin: base })).status, 403);
    const corrected = await call(`/receipts/${original.id}/corrections`, 'POST', correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] }), auth);
    assert.equal(corrected.status, 201); assert.equal((await corrected.json()).version, 2);
    assert.equal((await call(`/drafts/${input.sourceId}`, 'GET', undefined, { 'X-Demo-User': 'admin', 'X-Demo-Actor': 'admin' })).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('HTTP origin lookup rechecks readable sites before and after resolution and uses the submitted card address only', async () => fixture(async (f) => {
  const resolutions = [];
  let revokeDuringLookup = false;
  const api = createEnvironmentApi({ repository: f.repository, principalStore: f.principalStore, env: {}, now: () => new Date('2026-10-16T10:00:00Z'),
    addressResolver: async (input) => {
      resolutions.push(input);
      if (revokeDuringLookup) f.restrictions.set('kajsa', ['rimbo']);
      return { originAddress: input.originAddress, status: 'resolved', provider: 'test-resolver', place };
    },
  });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, value, headers = {}) => fetch(`${base}/api/environment${path}`, {
    method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const auth = { Cookie: `jeroc_environment_staff=${f.kajsa.token}`, Origin: base, 'X-Environment-CSRF': f.kajsa.result.csrfToken };
  const input = { siteId: 'norrtalje', originAddress: 'Kortets gata 12, 761 41 Norrtälje' };
  try {
    assert.equal((await call('POST', '/address/resolve', input, { 'X-Demo-User': 'admin' })).status, 401);
    assert.equal((await call('POST', '/address/resolve', input, { Cookie: auth.Cookie, Origin: base })).status, 403);
    f.restrictions.set('kajsa', ['rimbo']);
    assert.equal((await call('POST', '/address/resolve', input, auth)).status, 403); assert.equal(resolutions.length, 0);
    f.restrictions.delete('kajsa');
    const resolved = await call('POST', '/address/resolve', input, auth); assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).originAddress, input.originAddress);
    assert.deepEqual(resolutions[0], { originAddress: input.originAddress });
    assert.equal((await call('POST', '/address/resolve', { ...input, billingAddress: 'En annan kundadress' }, auth)).status, 422);
    const municipalities = await call('GET', '/municipalities', undefined, { Cookie: `jeroc_environment_staff=${f.anna.token}` });
    assert.equal(municipalities.status, 200); assert.equal((await municipalities.json()).length, 290);
    revokeDuringLookup = true;
    assert.equal((await call('POST', '/address/resolve', input, auth)).status, 403);
    assert.equal(resolutions.length, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('HTTP automatic demo login can be disabled while ordinary authenticated sessions remain available', async () => fixture(async (f) => {
  const api = createEnvironmentApi({ repository: f.repository, principalStore: f.principalStore, env: { JEROC_DEMO_AUTO_SESSION: 'false' }, now: () => new Date('2026-10-16T10:00:00Z') });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/environment/demo-session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ userId: 'admin' }) });
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'demo_disabled');
    const session = await fetch(`${base}/api/environment/session`, { headers: { Cookie: `jeroc_environment_staff=${f.kajsa.token}` } });
    assert.equal(session.status, 200); assert.equal((await session.json()).effectiveUserId, 'kajsa');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('PostgreSQL followup migration enforces correction receipt/version constraints and durable drafts', { skip: !postgresUrl }, async () => fixture(async (f) => {
  assert.equal(f.repository.kind, 'postgresql');
  const { Pool } = await import('pg'), inspection = new Pool({ connectionString: f.repositoryOptions.env.DATABASE_URL });
  try {
    const input = receiptInput(), original = await f.store.receive(input, f.kajsa.token);
    await f.store.correct(original.id, correctionInput(input, { rows: [{ articleId: 'lead-battery', weight: 245 }, { articleId: 'copper-1', weight: 12 }] }), f.admin.token);
    const pending = receiptInput({ rows: [], receivedAt: '' }); await f.store.saveDraft(pending.sourceId, draftInput(pending), f.kajsa.token);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_corrections')).rows[0].count), 1);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_drafts')).rows[0].count), 1);
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_corrections (id, receipt_id, version, data) VALUES ($1, $2, $3, $4::jsonb)', [randomUUID(), original.id, 2, '{}']), (error) => error.code === '23505');
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_corrections (id, receipt_id, version, data) VALUES ($1, $2, $3, $4::jsonb)', [randomUUID(), randomUUID(), 2, '{}']), (error) => error.code === '23503');
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_corrections (id, receipt_id, version, data) VALUES ($1, $2, $3, $4::jsonb)', [randomUUID(), original.id, 1, '{}']), (error) => error.code === '23514');
    const backup = await f.repository.backup(); await f.repository.restore(backup); await f.restart();
    assert.equal((await f.store.draft(pending.sourceId, f.kajsa.token)).version, 1);
    const current = (await f.store.state(f.admin.token)).receipts[0];
    assert.equal(current.version, 2);
    assert.equal(current.hash, environmentHash(current.snapshot));
    assert.equal(current.originalHash, environmentHash(current.originalSnapshot));
  } finally { await inspection.end(); }
}));
