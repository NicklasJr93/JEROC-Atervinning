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
import { createEnvironmentApi } from './environment-api.mjs';
import { parseNvvSandboxInput } from './nvv-sandbox.mjs';

const now = () => new Date('2026-10-10T15:00:00Z');
const certificate = { configured: true, validated: true, metadataAvailable: true, organisationName: 'Actual testcertificate organisation', organisationNumber: '5560000167', fingerprint256: 'PUBLIC-TEST-FINGERPRINT' };
const request = (payload = { verksamhetsutovare: '5560000167', avfall: { kod: '160601', mangd: 10 } }) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), payload });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-nvv-sandbox-')), filename = join(directory, 'environment.sqlite');
  let repository = await createEnvironmentRepository({ env: {}, filename });
  let time = now(); const clock = () => new Date(time);
  const pricing = createPricingStore({ now: clock }), scopes = new Map(), calls = [];
  const principals = { ...pricing, principal(actor, user) { const p = pricing.principal(actor, user); if (scopes.has(p.user.id)) p.user.siteIds = scopes.get(p.user.id); return p; } };
  let config = { mode: 'test', ready: true, missing: [], issues: [], certificate }, operation = async () => ({ outcome: 'rejected', httpStatus: 400, response: { Code: 1023 }, error: { code: 'NVV_REPORTER_IDENTITY', message: 'Test rejection' }, clientCertificate: certificate });
  const adapter = { status: async () => structuredClone(config), submit: async input => { calls.push(structuredClone(input)); return operation(input); } };
  const makeStore = () => createEnvironmentStore({ repository, principalStore: principals, now: clock, nvvClient: adapter });
  let store = makeStore();
  const admin = await store.demoSession({ userId: 'admin' }), lars = await store.demoSession({ userId: 'lars' });
  try { await run({ get store() { return store; }, get repository() { return repository; }, adapter, principals, admin, lars, scopes, calls,
    config: value => { config = value; }, operation: value => { operation = value; },
    advance: milliseconds => { time = new Date(time.getTime() + milliseconds); },
    restart: async () => { await repository.close(); repository = await createEnvironmentRepository({ env: {}, filename }); store = makeStore(); } }); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('sandbox status is admin-only, prefills actual certificate and does not dispatch or create receipt/report/stock', async () => fixture(async f => {
  const before = JSON.parse(await f.repository.backup()), status = await f.store.nvvSandbox(f.admin.token);
  assert.equal(status.mode, 'test'); assert.equal(status.ready, true); assert.equal(f.calls.length, 0);
  assert.equal(status.template.verksamhetsutovare, certificate.organisationNumber); assert.equal(status.template.verksamhetensNamn, certificate.organisationName);
  assert.ok(status.template.referens.length <= 40);
  assert.equal(status.template.senasteHanteringsPlats.kommunkod, '0188'); assert.equal(status.template.avfall.mangd, 10);
  await assert.rejects(() => f.store.nvvSandbox(f.lars.token), error => error.status === 403);
  const impersonated = await f.store.demoSession({ userId: 'admin', effectiveUserId: 'lars' });
  await assert.rejects(() => f.store.nvvSandbox(impersonated.token), error => error.status === 403);
  f.scopes.set('admin', ['norrtalje']);
  await assert.rejects(() => f.store.nvvSandbox(f.admin.token), error => error.code === 'site_forbidden');
  const after = JSON.parse(await f.repository.backup());
  for (const key of ['receipts', 'reports', 'inventory', 'nvvReports', 'nvvJobs']) assert.deepEqual(after[key], before[key]);
}));

test('sandbox allows documented raw ombud values for NVV validation and durably stores rejected result without normal reporter setup', async () => fixture(async f => {
  const input = request({ ombud: '5560065087', ombudetsNamn: 'Synthetic ombud AB', ombudetsKontaktpersonNamn: 'Test Person', ombudetsKontaktpersonEpost: 'test@example.invalid', ombudetsKontaktpersonTelefonnummer: '0100000000',
    verksamhetsutovare: '5560000167', avfall: { kod: '160601', mangd: -10 }, senasteHanteringsPlats: { kommunkod: '0188', koordinat: { nposition: 10, eposition: 20 }, cfarNR: '12345678', land: 'SE' } });
  const before = JSON.parse(await f.repository.backup()), result = await f.store.nvvSandboxSend(input, f.admin.token);
  assert.equal(result.status, 'rejected'); assert.equal(result.httpStatus, 400); assert.equal(result.error.code, 'NVV_REPORTER_IDENTITY');
  assert.deepEqual(f.calls[0], { method: 'POST', path: '/insamlingar', payload: input.payload, trackingId: result.trackingId });
  assert.deepEqual(result.clientCertificate, certificate); assert.deepEqual(result.payload, input.payload);
  await f.restart(); const history = await f.store.nvvSandbox(f.admin.token);
  assert.equal(history.runs.length, 1); assert.deepEqual(await f.store.nvvSandboxRun(result.id, f.admin.token), result);
  assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).id, result.id); assert.equal(f.calls.length, 1);
  const after = JSON.parse(await f.repository.backup());
  for (const key of ['receipts', 'reports', 'inventory', 'nvvReports', 'nvvJobs', 'nvvSettings']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.audit.filter(event => event.action.startsWith('nvv.sandbox_')).map(event => event.action), ['nvv.sandbox_reserved', 'nvv.sandbox_rejected']);
  assert.equal(Object.hasOwn(result, 'payloadHash'), false); assert.equal(Object.hasOwn(result, 'keyHash'), false);
}));

test('two concurrent sandbox sends reserve once; in-flight, final and unknown duplicate requests never resend', async () => fixture(async f => {
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; }), dispatched = new Promise(resolve => { started = resolve; });
  f.operation(async () => { started(); await gate; throw new Error('Lost connection with unknown outcome'); });
  const input = request(), first = f.store.nvvSandboxSend(input, f.admin.token); await dispatched;
  assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).status, 'in_flight');
  assert.equal((await f.store.nvvSandboxRun(input.requestId, f.admin.token)).status, 'in_flight');
  unblock(); assert.equal((await first).status, 'unknown');
  await f.restart(); assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).status, 'unknown');
  assert.equal(f.calls.length, 1);
  await assert.rejects(() => f.store.nvvSandboxSend({ ...input, payload: { avfall: { kod: '160601', mangd: 20 } } }, f.admin.token), error => error.code === 'idempotency_conflict');
  await assert.rejects(() => f.store.nvvSandboxSend({ ...input, requestId: randomUUID() }, f.admin.token), error => error.code === 'idempotency_conflict');
}));

test('only ready TEST may dispatch, and finished duplicates can still be inspected when mode changes', async () => fixture(async f => {
  const input = request(), finished = await f.store.nvvSandboxSend(input, f.admin.token);
  for (const mode of ['mock', 'disabled', 'production']) {
    f.config({ mode, ready: true, certificate, missing: [], issues: [] });
    await assert.rejects(() => f.store.nvvSandboxSend(request(), f.admin.token), error => error.code === 'sandbox_test_only');
    assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).id, finished.id);
  }
  f.config({ mode: 'test', ready: false, certificate, missing: ['Certificate missing'], issues: [] });
  await assert.rejects(() => f.store.nvvSandboxSend(request(), f.admin.token), error => error.code === 'sandbox_not_ready');
  assert.equal(f.calls.length, 1);
}));

test('sandbox rejects credentials, endpoint injection, unknown nested keys, prototype keys and oversized JSON', () => {
  for (const payload of [{ url: 'https://wrong.invalid' }, { authorization: 'secret' }, { pfx: 'private' }, { avfall: { kod: '160601', password: 'secret' } },
    { senasteHanteringsPlats: { headers: {} } }, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: 'bad' }])
    assert.throws(() => parseNvvSandboxInput(request(payload)), error => error.code === 'sandbox_invalid');
  assert.throws(() => parseNvvSandboxInput(request({ referens: 'x'.repeat(128 * 1024) })), error => error.status === 413);
  assert.throws(() => parseNvvSandboxInput(request({ senasteHanteringsPlats: { koordinat: { nposition: 1.5 } } })), error => error.code === 'sandbox_invalid');
  const documentedNulls = { ombud: null, referens: null, avfall: { foregaendeAvfallId: null }, senasteHanteringsPlats: { adress: { adressrad: null, postnummer: null }, cfarNR: null, land: null, koordinat: { beskrivning: null } } };
  assert.deepEqual(parseNvvSandboxInput(request(documentedNulls)).payload, documentedNulls);
  assert.equal(Object.prototype.polluted, undefined);
});

test('restart and restore of an interrupted reservation project unknown after lease without GET writes or retransmission', async () => fixture(async f => {
  const input = request(); await f.store.nvvSandboxSend(input, f.admin.token);
  const interrupted = JSON.parse(await f.repository.backup()), stored = interrupted.nvvSandboxRuns[0];
  stored.status = 'in_flight'; delete stored.outcome; delete stored.finishedAt; delete stored.error; stored.httpStatus = null; stored.response = null;
  await f.repository.restore(JSON.stringify(interrupted)); await f.restart();
  assert.equal((await f.store.nvvSandboxRun(input.requestId, f.admin.token)).status, 'in_flight');
  f.advance(120001); const before = await f.repository.backup();
  assert.equal((await f.store.nvvSandboxRun(input.requestId, f.admin.token)).status, 'unknown');
  assert.equal((await f.store.nvvSandbox(f.admin.token)).runs[0].status, 'unknown');
  assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).status, 'unknown');
  assert.equal(await f.repository.backup(), before); assert.equal(f.calls.length, 1);
}));

test('sandbox accepts only a verified TEST waste UUID, preserving ambiguous response for inspection', async () => fixture(async f => {
  for (const result of [{ outcome: 'accepted', mode: 'test', httpStatus: 201, response: {} },
    { outcome: 'accepted', mode: 'mock', httpStatus: 200, response: { simulated: true }, avfallId: randomUUID() }]) {
    f.operation(async () => result); const run = await f.store.nvvSandboxSend(request(), f.admin.token);
    assert.equal(run.status, 'unknown'); assert.equal(run.avfallId, undefined); assert.deepEqual(run.response, result.response);
  }
  const avfallId = randomUUID(); f.operation(async () => ({ outcome: 'accepted', mode: 'test', httpStatus: 201, response: { AvfallsId: avfallId }, avfallId }));
  const run = await f.store.nvvSandboxSend(request(), f.admin.token);
  assert.equal(run.status, 'accepted'); assert.equal(run.avfallId, avfallId);
}));

test('sandbox runs are complete backup entities with no linked cards and restore never replays a request', async () => fixture(async f => {
  const input = request(), result = await f.store.nvvSandboxSend(input, f.admin.token), backup = await f.repository.backup();
  const empty = JSON.parse(backup); empty.nvvSandboxRuns = []; empty.audit = [];
  await f.repository.restore(JSON.stringify(empty)); assert.equal((await f.store.nvvSandbox(f.admin.token)).runs.length, 0);
  await f.repository.restore(backup); await f.restart();
  assert.deepEqual(await f.store.nvvSandboxRun(result.id, f.admin.token), result); assert.equal(f.calls.length, 1);
  const older = JSON.parse(backup); delete older.nvvSandboxRuns;
  await f.repository.restore(JSON.stringify(older)); assert.deepEqual((await f.store.nvvSandbox(f.admin.token)).runs, []);
}));

test('sandbox API enforces cookie, CSRF, expected identity and systemadmin on reads and writes', async () => fixture(async f => {
  const api = createEnvironmentApi({ env: {}, repository: { ...f.repository, close: async () => {} }, principalStore: f.principals, now, nvvClient: f.adapter });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/environment/nvv/sandbox`;
  const headers = { Cookie: `jeroc_environment_staff=${f.admin.token}`, 'Content-Type': 'application/json',
    'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin', 'X-Environment-CSRF': f.admin.result.csrfToken };
  try {
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { headers: { Cookie: `jeroc_environment_staff=${f.lars.token}` } })).status, 403);
    assert.equal((await fetch(base, { headers })).status, 200);
    const input = request();
    assert.equal((await fetch(base, { method: 'POST', headers: { ...headers, 'X-Environment-CSRF': '' }, body: JSON.stringify(input) })).status, 403);
    assert.equal((await fetch(base, { method: 'POST', headers: { ...headers, 'X-Environment-Effective-User': 'lars' }, body: JSON.stringify(input) })).status, 403);
    const posted = await fetch(base, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(posted.status, 200); assert.equal((await posted.json()).status, 'rejected'); assert.equal(f.calls.length, 1);
    assert.equal((await fetch(`${base}/runs/${input.requestId}`, { headers })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await api.close(); }
}));
