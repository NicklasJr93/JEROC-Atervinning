import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createNvvClient } from './nvv-client.mjs';
import { createEnvironmentApi } from './environment-api.mjs';

const reporter = { expectedVersion: 0, name: 'NVV Testbolag', number: '5560000167', contactName: 'Test Person', email: 'test@example.test', phone: '0101234567', certificateOrganisationNumber: '5560000167', testIdentityConfirmed: true };
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const input = (changes = {}) => ({ sourceId: randomUUID(), cardId: 3010, siteId: 'norrtalje', receivedAt: '2026-10-10T10:00:00+02:00', materialScope: 'hazardous', originAddress: 'Testgatan 12, 76141 Norrtälje',
  rows: [{ articleId: 'lead-battery', weight: 250 }, { articleId: 'copper-1', weight: 12 }], previousHolder: { name: 'Verkstad Test AB', number: '5560000167', contactName: '', phone: '', email: '' },
  lastPlace: { ...place }, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road', incomingDocument: { status: 'provided' }, idempotencyKey: randomUUID(), ...changes });
const correction = (original, changes = {}) => { const { sourceId, cardId, siteId, idempotencyKey, ...values } = original; return { ...values, expectedVersion: 1, reason: 'Kontrollerad verklig nettovikt.', idempotencyKey: randomUUID(), ...changes }; };
const rejected = (operation, code) => assert.rejects(operation, error => error.code === code);

async function fixture(run, { mode = 'mock', client } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-nvv-reporting-'));
  let repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  let time = new Date('2026-10-10T10:30:00Z');
  const pricing = createPricingStore({ now: () => time }), grants = new Map(), scopes = new Map();
  const principals = { ...pricing, principal(actor, effective) { const principal = pricing.principal(actor, effective); if (grants.has(principal.user.id)) principal.user.permissions = grants.get(principal.user.id); if (scopes.has(principal.user.id)) principal.user.siteIds = scopes.get(principal.user.id); return principal; } };
  const adapter = client ?? createNvvClient({ env: { NVV_ENVIRONMENT: mode }, now: () => time });
  const makeStore = () => createEnvironmentStore({ repository, principalStore: principals, now: () => time, nvvClient: adapter });
  let store = makeStore();
  const admin = await store.demoSession({ userId: 'admin' }), kajsa = await store.demoSession({ userId: 'kajsa' }), lars = await store.demoSession({ userId: 'lars' });
  const setup = async () => { await store.nvvSaveReporter(reporter, admin.token); await store.nvvCheck(admin.token); };
  const create = async (changes = {}) => { const original = input(changes); const receipt = await store.receive(original, admin.token); const report = (await store.state(admin.token)).reports.find(item => item.receiptId === receipt.id); return { original, receipt, report }; };
  try { await run({ get store() { return store; }, get repository() { return repository; }, adapter, pricing, principals, admin, kajsa, lars, grants, scopes, setup, create,
    advance: ms => { time = new Date(time.getTime() + ms); }, restart: async () => { await repository.close(); repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') }); store = makeStore(); } }); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('NVV stays disabled by default and reporter setup is versioned without changing receipt originals', async () => fixture(async f => {
  const initial = await f.store.nvvStatus(f.admin.token); assert.equal(initial.mode, 'disabled'); assert.equal(initial.configured, false); assert.equal(initial.productionEnabled, false);
  const { receipt, report } = await f.create();
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'disabled' }, f.admin.token), 'nvv_incomplete');
  assert.equal(JSON.parse(await f.repository.backup()).nvvReports.length, 0);
  await f.store.nvvSaveReporter(reporter, f.admin.token);
  await rejected(() => f.store.nvvSaveReporter(reporter, f.admin.token), 'version_conflict');
  await f.restart(); const current = await f.store.state(f.admin.token);
  assert.equal(current.receipts[0].hash, receipt.hash); assert.equal(current.receipts[0].snapshot.operator.verified, false);
  assert.equal((await f.store.nvvStatus(f.admin.token)).reporterVersion, 1);
}, { mode: 'disabled' }));

test('actual certificate identity overrides a matching manual declaration and is frozen with the report', async () => {
  let checks = 0, submits = 0;
  const certificate = { configured: true, validated: true, metadataAvailable: true,
    organisationName: 'Testbolag 2', organisationNumber: '5560065087', issuer: 'Local fixture CA',
    validFrom: '2026-04-09T00:00:00.000Z', validTo: '2028-04-09T00:00:00.000Z', fingerprint256: 'PUBLIC-FIXTURE-FINGERPRINT' };
  const client = { status: async () => ({ mode: 'test', ready: true, missing: [], issues: [], certificate }),
    async check() { checks++; return { mode: 'test', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }] }; },
    async submit() { submits++; return { mode: 'test', outcome: 'accepted', httpStatus: 200, avfallId: randomUUID(), response: {}, clientCertificate: structuredClone(certificate) }; } };
  await fixture(async f => {
    await f.store.nvvSaveReporter(reporter, f.admin.token);
    const status = await f.store.nvvStatus(f.admin.token);
    assert.equal(status.configured, false);
    assert.ok(status.missing.some(value => value.includes('5560065087') && value.includes('egen rapportering')));
    await rejected(() => f.store.nvvCheck(f.admin.token), 'nvv_setup_required');
    const { report } = await f.create();
    await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'mismatched-cert' }, f.admin.token), 'nvv_incomplete');
    assert.equal(checks, 0); assert.equal(submits, 0);
    assert.equal(JSON.parse(await f.repository.backup()).nvvReports.length, 0);
    await f.store.nvvSaveReporter({ ...reporter, expectedVersion: 1, number: '5560065087', certificateOrganisationNumber: '5560065087' }, f.admin.token);
    await f.store.nvvCheck(f.admin.token);
    const sent = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'correct-cert' }, f.admin.token);
    assert.equal(sent.status, 'reported'); assert.equal(submits, 1);
    assert.deepEqual(sent.versions[0].clientCertificate, certificate);
    assert.deepEqual(sent.attempts[0].clientCertificate, certificate);
    certificate.organisationNumber = '5560000167';
    await f.restart();
    const history = await f.store.nvvDetail(report.id, f.admin.token);
    assert.equal(history.versions[0].clientCertificate.organisationNumber, '5560065087');
    assert.equal(history.attempts[0].clientCertificate.organisationNumber, '5560065087');
    assert.equal(history.versions[0].payload.verksamhetsutovare, '5560065087');
  }, { client });
});

test('mock reception freezes only hazardous kg and saves one immutable response across click retries and restart', async () => fixture(async f => {
  await f.setup(); const { receipt, report } = await f.create(); const before = JSON.parse(await f.repository.backup());
  const a = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'send-once' }, f.admin.token);
  assert.equal(a.status, 'simulated'); assert.match(a.avfallId, /^SIM-/); assert.equal(a.versions.length, 1); assert.equal(a.attempts.length, 1);
  const payload = a.versions[0].payload;
  assert.deepEqual(payload.avfall, { kod: '160601', mangd: 250 }); assert.equal(payload.transportsatt, 'R'); assert.equal(payload.tidigareInnehavare, '5560000167');
  assert.equal(Object.hasOwn(payload, 'price'), false); assert.equal(Object.hasOwn(payload, 'payment'), false); assert.equal(Object.hasOwn(payload, 'transportDocument'), false);
  await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'send-once' }, f.admin.token);
  await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'another-click' }, f.admin.token);
  await f.restart(); const b = await f.store.nvvDetail(report.id, f.admin.token);
  assert.equal(b.avfallId, a.avfallId); assert.equal(b.versions.length, 1); assert.equal(b.attempts.length, 1);
  const after = JSON.parse(await f.repository.backup()); assert.deepEqual(after.inventory, before.inventory); assert.deepEqual(after.receipts, before.receipts); assert.equal(after.receipts[0].hash, receipt.hash);
}));

test('a physical correction sends full PUT against latest accepted ID and keeps every earlier payload/receipt', async () => fixture(async f => {
  await f.setup(); const { original, receipt, report } = await f.create();
  const first = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'first' }, f.admin.token);
  await f.store.correct(receipt.id, correction(original, { rows: [{ articleId: 'lead-battery', weight: 245 }] }), f.admin.token);
  assert.equal((await f.store.nvvDetail(report.id, f.admin.token)).status, 'correction_required');
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'stale' }, f.admin.token), 'version_conflict');
  const corrected = await f.store.nvvSend(report.id, { receiptVersion: 2, idempotencyKey: 'corrected' }, f.admin.token);
  assert.equal(corrected.versions.length, 2); assert.equal(corrected.versions[1].method, 'PUT'); assert.equal(corrected.versions[1].previousAvfallId, first.avfallId);
  assert.equal(corrected.versions[1].payload.avfall.mangd, 245); assert.notEqual(corrected.avfallId, first.avfallId); assert.equal(corrected.versions[0].payload.avfall.mangd, 250);
  const state = await f.store.state(f.admin.token); assert.equal(state.inventory.reduce((sum, movement) => sum + movement.weight, 0), 245); assert.equal(state.receipts[0].originalHash, receipt.hash);
  const read = await f.store.nvvReconcile(report.id, {}, f.admin.token); assert.equal(read.attempts.at(-1).kind, 'read'); assert.equal(read.attempts.at(-1).outcome, 'accepted');
}));

test('NVV rights are explicit for VD, updates need both send/correction and facility scope, global setup blocks Jobba som', async () => fixture(async f => {
  await f.setup(); const { original, receipt, report } = await f.create();
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'vd' }, f.lars.token), 'forbidden');
  await rejected(() => f.store.nvvSaveReporter({ ...reporter, expectedVersion: 1 }, f.kajsa.token), 'forbidden');
  const impersonated = await f.store.demoSession({ userId: 'admin', effectiveUserId: 'lars' });
  await rejected(() => f.store.nvvCheck(impersonated.token), 'forbidden');
  f.grants.set('kajsa', ['environmentRead', 'environmentWrite', 'environmentReport']);
  await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'granted' }, f.kajsa.token);
  await f.store.correct(receipt.id, correction(original, { rows: [{ articleId: 'lead-battery', weight: 240 }] }), f.admin.token);
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 2, idempotencyKey: 'no-correct-right' }, f.kajsa.token), 'forbidden');
  f.scopes.set('kajsa', ['rimbo']);
  await rejected(() => f.store.nvvDetail(report.id, f.kajsa.token), 'site_forbidden');
  await rejected(() => f.store.nvvReconcile(report.id, {}, f.kajsa.token), 'site_forbidden');
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 2, idempotencyKey: 'other-site' }, f.kajsa.token), 'site_forbidden');
}));

test('household and incomplete reporter data never reserve a report or network call', async () => fixture(async f => {
  const { report } = await f.create({ previousHolder: { name: 'Privat testperson', number: '8110022586' } });
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'no-reporter' }, f.admin.token), 'nvv_incomplete');
  await f.setup(); const detail = await f.store.nvvDetail(report.id, f.admin.token); assert.ok(detail.missingFields.some(field => field.includes('Hushålls')));
  await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'household' }, f.admin.token), 'nvv_incomplete');
  assert.equal(JSON.parse(await f.repository.backup()).nvvReports.length, 0);
}));

test('two desks reserve once while HTTP runs outside the database lock', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let calls = 0, started;
  const began = new Promise(resolve => { started = resolve; });
  const client = { status: async () => ({ mode: 'mock', ready: true, missing: [], issues: [] }), check: async () => ({ mode: 'mock', connected: true, checkedAt: new Date().toISOString(), wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }] }),
    async submit() { calls++; started(); await waiting; return { mode: 'mock', outcome: 'accepted', httpStatus: 200, avfallId: `SIM-${randomUUID()}`, response: { simulated: true } }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create();
    const first = f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'desk-a' }, f.admin.token); await began;
    const other = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'desk-b' }, f.admin.token); assert.equal(other.status, 'sending');
    await f.store.nvvSaveReporter({ ...reporter, expectedVersion: 1 }, f.admin.token); assert.equal(calls, 1); release(); await first;
    assert.equal((await f.store.nvvDetail(report.id, f.admin.token)).versions.length, 1);
  }, { client });
});

test('timeout and stale process lease stay unknown across restart and never blindly resubmit', async () => {
  let calls = 0;
  const client = { status: async () => ({ mode: 'mock', ready: true, missing: [], issues: [] }), check: async () => ({ mode: 'mock', connected: true, checkedAt: new Date().toISOString(), wasteCodes: [], transportModes: [] }),
    async submit() { calls++; return { outcome: 'unknown', mode: 'mock', httpStatus: null, response: null, error: { code: 'timeout', message: 'Svar saknas.' } }; },
    async read() { return { outcome: 'accepted', mode: 'mock', httpStatus: 200, response: { anteckningar: [] } }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create(); const detail = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'timeout' }, f.admin.token); assert.equal(detail.status, 'unknown');
    await f.restart(); await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'retry' }, f.admin.token); assert.equal(calls, 1);
    const reread = await f.store.nvvReconcile(report.id, {}, f.admin.token); assert.equal(reread.status, 'unknown'); assert.equal(reread.attempts.at(-1).outcome, 'unknown');
    await f.repository.transact(state => { const job = state.nvvJobs[0]; job.status = 'in_flight'; job.leaseUntil = '2026-10-10T10:00:00Z'; job.trackingId = randomUUID(); });
    await f.restart(); const stale = await f.store.nvvDetail(report.id, f.admin.token); assert.equal(stale.status, 'unknown'); assert.equal(stale.attempts.at(-1).error.code, 'interrupted'); assert.equal(calls, 1);
  }, { client });
});

test('a late verified response can settle an expired lease without discarding its interrupted-attempt evidence', async () => {
  let release, began; const waiting = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { began = resolve; });
  const avfallId = `SIM-${randomUUID()}`;
  const client = { status: async () => ({ mode: 'mock', ready: true, missing: [], issues: [] }), check: async () => ({ mode: 'mock', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [], transportModes: [] }),
    async submit() { began(); await waiting; return { outcome: 'accepted', mode: 'mock', httpStatus: 200, avfallId, response: { avfallId, simulated: true } }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create();
    const sent = f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'slow-response' }, f.admin.token); await started;
    f.advance(130000); assert.equal((await f.store.nvvDetail(report.id, f.admin.token)).status, 'unknown'); release();
    const result = await sent; assert.equal(result.avfallId, avfallId); assert.equal(result.status, 'simulated'); assert.equal(result.attempts.length, 2); assert.equal(result.attempts[0].outcome, 'unknown'); assert.equal(result.attempts[1].outcome, 'accepted');
  }, { client });
});

test('TEST unknown result is reconciled only from one full matching authority record, not an unrelated ID', async () => {
  let sent, body = { anteckningar: [] }, calls = 0;
  const client = { status: async () => ({ mode: 'test', ready: true, missing: [], issues: [], certificate: { configured: true, validated: true, metadataAvailable: false } }),
    check: async () => ({ mode: 'test', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }] }),
    async submit({ payload }) { calls++; sent = payload; return { outcome: 'unknown', mode: 'test', httpStatus: null, response: null }; }, async read() { return { outcome: 'accepted', mode: 'test', httpStatus: 200, response: body }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create(); await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'lost' }, f.admin.token);
    body = { anteckningar: [{ ...sent, referens: 'other', avfall: { ...sent.avfall, avfallId: randomUUID() } }] };
    assert.equal((await f.store.nvvReconcile(report.id, {}, f.admin.token)).status, 'unknown');
    const avfallId = randomUUID(); body = { antalSidor: 1, anteckningar: [{ ...sent, id: randomUUID(), avfall: { ...sent.avfall, avfallId } }] };
    const matched = await f.store.nvvReconcile(report.id, {}, f.admin.token); assert.equal(matched.status, 'reported'); assert.equal(matched.avfallId, avfallId); assert.equal(calls, 1);
  }, { client });
});

test('a 2xx without avfallId is unknown, and reporter settings cannot bypass TEST identity confirmation', async () => {
  let calls = 0;
  const client = { status: async () => ({ mode: 'test', ready: true, missing: [], issues: [] }), check: async () => ({ mode: 'test', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }] }),
    async submit() { calls++; return { outcome: 'accepted', mode: 'test', httpStatus: 200, response: {} }; } };
  await fixture(async f => {
    await f.store.nvvSaveReporter({ ...reporter, testIdentityConfirmed: false }, f.admin.token); const { report } = await f.create();
    await rejected(() => f.store.nvvCheck(f.admin.token), 'nvv_setup_required');
    await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'unconfirmed' }, f.admin.token), 'nvv_incomplete'); assert.equal(calls, 0);
    await f.store.nvvSaveReporter({ ...reporter, expectedVersion: 1 }, f.admin.token); await f.store.nvvCheck(f.admin.token);
    const result = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'invalid-2xx' }, f.admin.token); assert.equal(result.status, 'unknown'); assert.equal(result.attempts[0].error.code, 'missing_avfall_id');
  }, { client });
});

test('TEST connection checks bind privately to exact credentials and a rotation during checking cannot validate the new setup', async () => {
  let configurationId = 'private-config-a', calls = 0, pause = false, began, release;
  const publicStatus = { mode: 'test', ready: true, missing: [], issues: [], certificate: { configured: true, validated: true, metadataAvailable: false } };
  const checkResult = { mode: 'test', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [{ code: '160601', hazardous: true }], transportModes: [{ code: 'R' }] };
  const client = { status: async () => publicStatus, configurationSnapshot: async () => ({ status: publicStatus, configurationId }),
    async checkWithConfiguration() { const identity = configurationId; if (pause) { began(); await new Promise(resolve => { release = resolve; }); } return { result: checkResult, configurationId: identity }; },
    async submit() { calls++; return { mode: 'test', outcome: 'accepted', httpStatus: 200, avfallId: randomUUID(), response: {} }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create();
    const checked = await f.store.nvvStatus(f.admin.token); assert.equal(checked.connected, true); assert.equal(JSON.stringify(checked).includes('configurationId'), false); assert.equal(JSON.stringify(checked).includes('private-config'), false);
    configurationId = 'private-config-b'; await f.restart();
    assert.equal((await f.store.nvvStatus(f.admin.token)).connected, false);
    await rejected(() => f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'rotated' }, f.admin.token), 'nvv_incomplete'); assert.equal(calls, 0);
    const started = new Promise(resolve => { began = resolve; }); pause = true;
    const checking = f.store.nvvCheck(f.admin.token); await started; configurationId = 'private-config-c'; release();
    const stale = await checking; assert.equal(stale.connected, false); assert.equal(stale.lastCheck, null); assert.equal(JSON.stringify(stale).includes('private-config'), false);
    pause = false; assert.equal((await f.store.nvvCheck(f.admin.token)).connected, true);
    const sent = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'new-setup' }, f.admin.token);
    assert.equal(sent.status, 'reported'); assert.equal(calls, 1); assert.equal(JSON.stringify(sent).includes('private-config'), false);
    const backup = JSON.parse(await f.repository.backup()); assert.deepEqual(backup.nvvChecks.map(value => value.configurationId), ['private-config-a', 'private-config-b', 'private-config-c']);
  }, { client });
});

test('a confirmed validation rejection is actionable and a deliberate new retry preserves the failed attempt', async () => {
  let calls = 0;
  const client = { status: async () => ({ mode: 'mock', ready: true, missing: [], issues: [] }), check: async () => ({ mode: 'mock', connected: true, checkedAt: '2026-10-10T10:30:00Z', wasteCodes: [], transportModes: [] }),
    async submit() { calls++; return calls === 1 ? { outcome: 'rejected', mode: 'mock', httpStatus: 400, response: { traceId: 'TEST-TRACE', errors: [{ code: '1101', message: 'Ogiltig uppgift.' }] }, error: { code: '1101', message: 'Ogiltig uppgift.' } }
      : { outcome: 'accepted', mode: 'mock', httpStatus: 200, avfallId: `SIM-${randomUUID()}`, response: { simulated: true } }; } };
  await fixture(async f => {
    await f.setup(); const { report } = await f.create(); const error = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'invalid' }, f.admin.token);
    assert.equal(error.status, 'error'); assert.equal(error.attempts[0].response.traceId, 'TEST-TRACE');
    await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'invalid' }, f.admin.token); assert.equal(calls, 1);
    const retry = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'deliberate-new-try' }, f.admin.token); assert.equal(retry.status, 'simulated'); assert.equal(retry.versions.length, 2); assert.equal(retry.attempts.length, 2);
  }, { client });
});

test('NVV immutable evidence and complete backup restore preserve receipts, responses and no auto replay', async () => fixture(async f => {
  await f.setup(); const { report } = await f.create(); const detail = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'backup' }, f.admin.token);
  const backup = await f.repository.backup();
  await rejected(() => f.repository.transact(state => { state.nvvReports[0].payload.avfall.mangd = 1; }), 'immutable_record');
  await rejected(() => f.repository.transact(state => { state.nvvAttempts = []; }), 'immutable_record');
  await f.repository.restore(backup); await f.restart(); const restored = await f.store.nvvDetail(report.id, f.admin.token);
  assert.deepEqual(restored.versions, detail.versions); assert.deepEqual(restored.attempts, detail.attempts); assert.equal(restored.avfallId, detail.avfallId);
}));

test('several articles with the same waste code share a single receipt-role submission', async () => fixture(async f => {
  await f.setup();
  await f.store.classify('copper-1', { expectedVersion: 0, hazardous: true, wasteCode: '160601', wasteDescription: 'Andra testbatterier', handlingInstructions: '', adrRequired: false }, f.admin.token);
  const { receipt } = await f.create(); const reports = (await f.store.state(f.admin.token)).reports.filter(report => report.receiptId === receipt.id); assert.equal(reports.length, 2);
  const first = await f.store.nvvSend(reports[0].id, { receiptVersion: 1, idempotencyKey: 'row-1' }, f.admin.token);
  const second = await f.store.nvvSend(reports[1].id, { receiptVersion: 1, idempotencyKey: 'row-2' }, f.admin.token);
  assert.equal(second.avfallId, first.avfallId); assert.equal(first.versions[0].payload.avfall.mangd, 262); assert.equal(first.versions[0].sourceReportIds.length, 2);
  assert.equal(JSON.parse(await f.repository.backup()).nvvReports.length, 1);
}));

test('accepted evidence remains visible after disabling the connector and idempotency keys cannot target another receipt', async () => {
  const env = { NVV_ENVIRONMENT: 'mock' }; const client = createNvvClient({ env });
  await fixture(async f => {
    await f.setup(); const { report } = await f.create(); const accepted = await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'original-key' }, f.admin.token);
    await f.store.nvvSend(report.id, { receiptVersion: 1, idempotencyKey: 'alias-key' }, f.admin.token);
    const other = await f.create(); await rejected(() => f.store.nvvSend(other.report.id, { receiptVersion: 1, idempotencyKey: 'alias-key' }, f.admin.token), 'idempotency_conflict');
    env.NVV_ENVIRONMENT = 'disabled'; const history = await f.store.nvvDetail(report.id, f.admin.token);
    assert.equal(history.versions.length, 1); assert.equal(history.attempts.length, 1); assert.equal(history.avfallId, accepted.avfallId); assert.equal(history.status, 'simulated');
    assert.equal((await f.store.nvvStatus(f.admin.token)).mode, 'disabled');
    await rejected(() => f.store.nvvSend(other.report.id, { receiptVersion: 1, idempotencyKey: 'disabled-new' }, f.admin.token), 'nvv_incomplete');
  }, { client });
});

test('HTTP NVV actions keep cookie, CSRF, expected identity and same-origin boundaries', async () => fixture(async f => {
  await f.setup(); const { report } = await f.create();
  const api = createEnvironmentApi({ env: { NVV_ENVIRONMENT: 'mock' }, repository: f.repository, principalStore: f.principals, nvvClient: f.adapter, now: () => new Date('2026-10-10T10:30:00Z') });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/environment/nvv/status')).status, 401);
    const login = await fetch(base + '/api/environment/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'admin' }) });
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    const target = base + `/api/environment/nvv/reports/${report.id}/send`, payload = JSON.stringify({ receiptVersion: 1, idempotencyKey: 'http-once' });
    const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin' };
    assert.equal((await fetch(target, { method: 'POST', headers, body: payload })).status, 403);
    headers['X-Environment-CSRF'] = session.csrfToken;
    assert.equal((await fetch(target, { method: 'POST', headers: { ...headers, Origin: 'https://unrelated.example' }, body: payload })).status, 403);
    assert.equal((await fetch(target, { method: 'POST', headers: { ...headers, 'X-Environment-Effective-User': 'anna' }, body: payload })).status, 403);
    const response = await fetch(target, { method: 'POST', headers, body: payload }); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'simulated');
    const beforeCatalog = JSON.parse(await f.repository.backup());
    const catalogResponse = await fetch(base + '/api/environment/integrations/catalog?organisationId=other-tenant', { headers: { Cookie: cookie } });
    assert.equal(catalogResponse.status, 200); const catalog = await catalogResponse.json(); assert.equal(catalog.organisationId, 'jeroc-demo'); assert.equal(catalog.providers.find(item => item.id === 'nvv').mode, 'mock'); assert.equal(catalog.providers.find(item => item.id === 'nvv').connected, false);
    assert.deepEqual(JSON.parse(await f.repository.backup()).nvvAttempts, beforeCatalog.nvvAttempts);
    const kajsaLogin = await fetch(base + '/api/environment/demo-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'kajsa' }) });
    const kajsaCookie = kajsaLogin.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/api/environment/integrations/catalog', { headers: { Cookie: kajsaCookie } })).status, 403);
    assert.equal((await fetch(base + '/api/environment/nvv/makulera', { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { server.close(); await once(server, 'close'); }
}));

const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
test('PostgreSQL NVV migration persists settings and immutable evidence without resetting existing environmental data', { skip: !postgresUrl }, async () => {
  const { Pool } = await import('pg'); const administration = new Pool({ connectionString: postgresUrl });
  const schema = `jeroc_nvv_${randomUUID().replaceAll('-', '')}`; await administration.query(`CREATE SCHEMA "${schema}"`);
  const connection = new URL(postgresUrl); connection.searchParams.set('options', `-c search_path=${schema}`);
  let repository;
  try {
    repository = await createEnvironmentRepository({ env: { DATABASE_URL: connection.toString() } });
    await repository.transact(state => { state.nvvSettings.push({ id: randomUUID(), ...reporter, version: 1, updatedAt: '2026-10-10T10:30:00Z' }); });
    const before = await repository.backup(); await repository.close();
    repository = await createEnvironmentRepository({ env: { DATABASE_URL: connection.toString() } });
    assert.deepEqual(JSON.parse(await repository.backup()), JSON.parse(before));
    await rejected(() => repository.transact(state => { state.nvvSettings[0].name = 'Changed immutable original'; }), 'immutable_record');
  } finally { if (repository) await repository.close(); await administration.query(`DROP SCHEMA "${schema}" CASCADE`); await administration.end(); }
});
