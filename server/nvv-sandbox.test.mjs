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
import { NVV_SUPPORT_PRESET, NVV_SUPPORT_CERTIFICATE_FINGERPRINT, supportPayload } from './nvv-support-payload.mjs';

const now = () => new Date('2026-10-10T15:00:00Z');
const certificate = { configured: true, validated: true, metadataAvailable: true, organisationName: 'Actual testcertificate organisation', organisationNumber: '5560000167', fingerprint256: 'PUBLIC-TEST-FINGERPRINT' };
const supportCertificate = { ...certificate, organisationName: 'Testbolag 1', fingerprint256: NVV_SUPPORT_CERTIFICATE_FINGERPRINT,
  validFrom: '2026-04-09T00:00:00Z', validTo: '2028-04-09T00:00:00Z' };
const supportConfig = () => ({ mode: 'test', ready: true, missing: [], issues: [], certificate: structuredClone(supportCertificate) });
const request = (payload = { verksamhetsutovare: '5560000167', avfall: { kod: '160601', mangd: 10 } }) => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), payload });
const supportRequest = () => ({ ...request(supportPayload(now(), randomUUID())), preset: NVV_SUPPORT_PRESET });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-nvv-sandbox-')), filename = join(directory, 'environment.sqlite');
  let repository = await createEnvironmentRepository({ env: {}, filename });
  let time = now(); const clock = () => new Date(time);
  const pricing = createPricingStore({ now: clock }), scopes = new Map(), calls = [], diagnosticCalls = [], profiles = [];
  const principals = { ...pricing, principal(actor, user) { const p = pricing.principal(actor, user); if (scopes.has(p.user.id)) p.user.siteIds = scopes.get(p.user.id); return p; } };
  let config = { mode: 'test', ready: true, missing: [], issues: [], certificate }, operation = async () => ({ outcome: 'rejected', httpStatus: 400, response: { Code: 1023 }, error: { code: 'NVV_REPORTER_IDENTITY', message: 'Test rejection' }, clientCertificate: certificate });
  const adapter = { status: async () => structuredClone(config), submit: async input => { calls.push(structuredClone(input)); return operation(input); },
    diagnosticSession: async profile => {
      profiles.push(structuredClone(profile)); const snapshot = structuredClone(config);
      return { status: async () => structuredClone(snapshot), submit: async input => { calls.push(structuredClone(input)); diagnosticCalls.push(structuredClone(input)); return operation(input); } };
    } };
  const makeStore = () => createEnvironmentStore({ repository, principalStore: principals, now: clock, nvvClient: adapter });
  let store = makeStore();
  const admin = await store.demoSession({ userId: 'admin' }), lars = await store.demoSession({ userId: 'lars' });
  try { await run({ get store() { return store; }, get repository() { return repository; }, adapter, principals, admin, lars, scopes, calls, diagnosticCalls, profiles,
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

test('support template uses the quoted roles and synthetic fields without changing ordinary settings or dispatching', async () => fixture(async f => {
  f.config(supportConfig()); const before = await f.repository.backup(), status = await f.store.nvvSandbox(f.admin.token);
  assert.equal(status.supportTest.ready, true); assert.deepEqual(status.supportTest.issues, []);
  const payload = status.supportTest.template;
  assert.equal(payload.verksamhetsutovare, '5593593626'); assert.equal(payload.verksamhetensNamn, 'JEROC Återvinning AB');
  assert.equal(payload.ombud, '5560000167'); assert.equal(payload.ombudetsNamn, 'Testbolag 1');
  assert.match(payload.ombudetsKontaktpersonNamn, /^[A-Za-zÀ-ÖØ-öø-ž,.: '\-]+$/);
  for (const field of ['verksamhetensKontaktpersonNamn', 'verksamhetensKontaktpersonEpost', 'verksamhetensKontaktpersonTelefonnummer',
    'ombudetsKontaktpersonNamn', 'ombudetsKontaktpersonEpost', 'ombudetsKontaktpersonTelefonnummer']) assert.ok(payload[field]);
  assert.equal(payload.tidpunkt, now().toISOString()); assert.equal(payload.mottagningsDatum, now().toISOString());
  assert.equal(payload.avfall.kod, '160601'); assert.equal(payload.avfall.mangd, 10); assert.equal(payload.transportsatt, 'R');
  assert.ok(payload.referens.length <= 40); assert.equal(payload.senasteHanteringsPlats.land, undefined);
  assert.equal(status.template.verksamhetsutovare, '5560000167', 'The ordinary template retains its certificate organisation');
  f.advance(60000); const next = await f.store.nvvSandbox(f.admin.token);
  assert.notEqual(next.supportTest.template.tidpunkt, payload.tidpunkt); assert.notEqual(next.supportTest.template.referens, payload.referens);
  assert.equal(f.calls.length, 0); assert.equal(f.profiles.length, 0); assert.equal(await f.repository.backup(), before);
}));

test('support submission binds an isolated TLS 1.2 certificate and preserves the first response and preset on restart', async () => fixture(async f => {
  f.config(supportConfig()); const input = supportRequest(), trace = randomUUID(), before = JSON.parse(await f.repository.backup());
  const diagnosticSession = f.adapter.diagnosticSession;
  f.adapter.diagnosticSession = async profile => {
    const snapshot = await diagnosticSession(profile);
    f.config({ ...supportConfig(), certificate: { ...supportCertificate, fingerprint256: 'ROTATED-AFTER-SNAPSHOT' } });
    return snapshot;
  };
  f.operation(async () => ({ outcome: 'rejected', mode: 'test', httpStatus: 401, response: { TraceId: trace, Code: 1023 },
    clientCertificate: supportCertificate, transport: { protocol: 'TLSv1.2', cipher: 'test-cipher' }, error: { code: 'NVV_AUTHENTICATION', message: 'Test rejection' } }));
  const run = await f.store.nvvSandboxSend(input, f.admin.token);
  assert.deepEqual(f.profiles, [{ tls: 'tls12' }]); assert.equal(f.diagnosticCalls.length, 1);
  assert.equal(f.calls[0].retryUnauthorized, false); assert.deepEqual(f.calls[0].payload, input.payload);
  assert.equal(run.preset, NVV_SUPPORT_PRESET); assert.equal(run.httpStatus, 401); assert.equal(run.response.TraceId, trace);
  assert.deepEqual(run.profile, { tls: 'tls12', certificateFP: NVV_SUPPORT_CERTIFICATE_FINGERPRINT, certificateOrganisationNumber: '5560000167' });
  assert.equal(run.transport.protocol, 'TLSv1.2');
  await f.restart(); assert.deepEqual(await f.store.nvvSandboxRun(run.id, f.admin.token), run);
  f.config({ mode: 'disabled', ready: false, missing: [], issues: [] });
  assert.deepEqual(await f.store.nvvSandboxSend(input, f.admin.token), run); assert.equal(f.calls.length, 1);
  const after = JSON.parse(await f.repository.backup());
  for (const key of ['receipts', 'reports', 'inventory', 'nvvReports', 'nvvJobs', 'nvvSettings']) assert.deepEqual(after[key], before[key]);
}));

test('support preset requires the verified, currently valid Testbolag 1 profile while normal sandbox sends remain available', async () => fixture(async f => {
  for (const patch of [{ fingerprint256: 'ANOTHER-PUBLIC-FINGERPRINT' }, { organisationNumber: '5560065087' }, { metadataAvailable: false },
    { validated: false }, { validTo: '2026-10-01T00:00:00Z' }, { validFrom: '2026-11-01T00:00:00Z' }, { validTo: null }]) {
    f.config({ ...supportConfig(), certificate: { ...supportCertificate, ...patch } });
    const status = await f.store.nvvSandbox(f.admin.token); assert.equal(status.supportTest.ready, false); assert.ok(status.supportTest.issues.length);
    await assert.rejects(() => f.store.nvvSandboxSend(supportRequest(), f.admin.token), error => error.code === 'sandbox_support_certificate');
  }
  assert.equal(f.calls.length, 0); assert.equal((JSON.parse(await f.repository.backup())).nvvSandboxRuns.length, 0);
  await f.store.nvvSandboxSend(request(), f.admin.token); assert.equal(f.calls.length, 1);
  f.config(supportConfig()); f.adapter.diagnosticSession = async () => { throw new Error('DO-NOT-EXPOSE'); };
  await assert.rejects(() => f.store.nvvSandboxSend(supportRequest(), f.admin.token), error => error.code === 'sandbox_support_certificate' && !error.message.includes('DO-NOT-EXPOSE'));
}));

test('support preset rejects different VU or ombud roles and cannot be added to or removed from an existing idempotent request', async () => fixture(async f => {
  f.config(supportConfig());
  for (const patch of [{ verksamhetsutovare: '5560000167' }, { verksamhetensNamn: 'Testbolag 1' }, { ombud: null }, { ombud: '5593593626' }, { ombudetsNamn: 'JEROC' }]) {
    const input = supportRequest(); Object.assign(input.payload, patch);
    await assert.rejects(() => f.store.nvvSandboxSend(input, f.admin.token), error => error.code === 'sandbox_support_roles');
  }
  assert.equal(f.calls.length, 0);
  const input = supportRequest(), normal = { ...input }; delete normal.preset;
  await f.store.nvvSandboxSend(normal, f.admin.token);
  await assert.rejects(() => f.store.nvvSandboxSend(input, f.admin.token), error => error.code === 'idempotency_conflict');
  const actualSupport = supportRequest(); await f.store.nvvSandboxSend(actualSupport, f.admin.token);
  const withoutPreset = { ...actualSupport }; delete withoutPreset.preset;
  await assert.rejects(() => f.store.nvvSandboxSend(withoutPreset, f.admin.token), error => error.code === 'idempotency_conflict');
  assert.equal(f.calls.length, 2);
  assert.throws(() => parseNvvSandboxInput({ ...supportRequest(), preset: 'other-preset' }), error => error.code === 'sandbox_invalid');
}));

test('a persisted support reservation blocks a different request atomically and unknown results keep the stop across reloads', async () => fixture(async f => {
  f.config(supportConfig()); let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; }), dispatched = new Promise(resolve => { started = resolve; });
  f.operation(async () => { started(); await gate; throw new Error('Synthetic interruption'); });
  const input = supportRequest(), first = f.store.nvvSandboxSend(input, f.admin.token);
  const competing = f.store.nvvSandboxSend(supportRequest(), f.admin.token);
  const rejectedCompeting = assert.rejects(competing, error => error.code === 'sandbox_support_pending');
  await dispatched; await rejectedCompeting;
  assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).status, 'in_flight');
  await assert.rejects(() => f.store.nvvSandboxSend(supportRequest(), f.admin.token), error => error.code === 'sandbox_support_pending');
  assert.equal((await f.store.nvvSandbox(f.admin.token)).supportTest.ready, false);
  unblock(); assert.equal((await first).status, 'unknown'); await f.restart();
  await assert.rejects(() => f.store.nvvSandboxSend(supportRequest(), f.admin.token), error => error.code === 'sandbox_support_pending');
  assert.equal((await f.store.nvvSandboxSend(input, f.admin.token)).status, 'unknown'); assert.equal(f.calls.length, 1);
  const status = await f.store.nvvSandbox(f.admin.token); assert.ok(status.supportTest.issues.some(issue => issue.includes('okänt utfall')));
}));

test('a rejected support run permits a deliberate fresh request, while accepted support history stops later probes', async () => fixture(async f => {
  f.config(supportConfig()); await f.store.nvvSandboxSend(supportRequest(), f.admin.token);
  assert.equal((await f.store.nvvSandbox(f.admin.token)).supportTest.ready, true);
  const id = randomUUID(); f.operation(async () => ({ outcome: 'accepted', mode: 'test', httpStatus: 201, response: { AvfallsId: id }, avfallId: id }));
  const input = supportRequest(), accepted = await f.store.nvvSandboxSend(input, f.admin.token); assert.equal(accepted.status, 'accepted');
  await f.restart(); const status = await f.store.nvvSandbox(f.admin.token);
  assert.equal(status.supportTest.ready, false); assert.ok(status.supportTest.issues.some(issue => issue.includes('accepterats')));
  await assert.rejects(() => f.store.nvvSandboxSend(supportRequest(), f.admin.token), error => error.code === 'sandbox_support_pending');
  assert.deepEqual(await f.store.nvvSandboxSend(input, f.admin.token), accepted); assert.equal(f.calls.length, 2);
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
