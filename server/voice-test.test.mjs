import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createApplicationRepository } from './application-storage.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';
import { createVoiceTestApi, VOICE_TEST_LIMITS } from './voice-test.mjs';
import { createAiSupportApi } from './ai-support.mjs';

const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Voice test\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const org = 'fictional-voice-company';
const sites = [{ id: 'north', name: 'Norra gården', active: true, address: 'Testgatan 1', phone: '0101234567', secretPermit: 'DO-NOT-EXPOSE' }, { id: 'south', name: 'Södra gården', active: true }];
const user = (id, level, extra = {}) => ({ id, name: id, level, active: true, permissions: [], ...extra });
const seed = () => ({ metadata: { organisation: { id: org } }, pricing: { users: [user('admin', 'Systemadmin'), user('vd', 'VD'), user('employee', 'Medarbetare'),
  user('inactive', 'Systemadmin', { active: false }), user('south', 'VD', { siteIds: ['south'] }), user('empty', 'VD', { siteIds: [] })] },
  office: { cards: [{ id: 'FINANCIAL-UNCHANGED' }] }, transport: { orders: [{ id: 'AO-UNCHANGED' }] } });
function mockProvider() {
  const requests = [], handles = [], summaries = []; let checks = 0, starts = 0, closes = 0;
  return { requests, handles, summaries, get starts() { return starts; }, get checks() { return checks; }, get closes() { return closes; },
    status: () => ({ keyPresent: true, available: true, model: 'test-realtime' }),
    async connectionTest() { checks++; return { ok: true, model: 'test-realtime', unsafe: 'MUST-NOT-LEAK' }; },
    async start(input) {
      starts++; requests.push(input); const handle = { answerSdp: sdp.replace('Voice test', 'Answer'), providerCallId: `provider-private-${starts}`, readyCount: 0, closeCount: 0,
        async ready() { handle.readyCount++; }, async close() { handle.closeCount++; } };
      handles.push(handle); return handle;
    },
    async summarize(input) { const { signal: _signal, ...saved } = input; summaries.push(structuredClone(saved)); return { status: 'generated', summary: 'Kunden vill bli kontaktad om hämtning.', topic: 'Hämtning', callbackRequested: true, callerNumber: '+46700000000', model: 'test-summary' }; },
    async close() { closes++; } };
}
async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-voice-test-')), env = { SCRAPPILOT_ORGANISATION_ID: org, OPENAI_API_KEY: 'PRIVATE-FAKE-KEY-NEVER-RETURN', ...options.env };
  let clock = new Date('2026-10-17T10:00:00Z'), provider = options.provider ?? mockProvider(), api;
  const repository = await createApplicationRepository({ filename: join(directory, 'application.sqlite'), seed });
  const principal = (state, req) => { const match = /(?:^|;\s*)office=([a-z]+)(?:\|([a-z]+))?/.exec(req.headers.cookie ?? ''); return match ? resolvePricingPrincipal(state.pricing.users, match[1], match[2] ?? match[1]) : undefined; };
  const apis = [], makeApi = (extra = {}) => { const instance = createVoiceTestApi({ getRepository: async () => repository, officePrincipal: principal, siteProvider: async () => sites,
    companyName: 'Fiktivt Skrot AB', env, provider, now: () => clock, ...options.api, ...extra }); apis.push(instance); return instance; };
  api = makeApi();
  const aiApi = createAiSupportApi({ getRepository: async () => repository, officePrincipal: principal, siteProvider: async () => sites, companyName: 'Fiktivt Skrot AB', env, provider, now: () => clock });
  const server = createServer((req, res) => void (async () => await aiApi(req, res, new URL(req.url, 'http://localhost')) || await api(req, res, new URL(req.url, 'http://localhost')))().then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path = '/api/voice-test', { body, raw, cookie = 'office=admin', method = body === undefined && raw === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
    const text = await response.text(); return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) : undefined };
  };
  const start = async (extra = {}) => request('/api/voice-test/calls', { body: { requestId: randomUUID(), sdp, ...extra } });
  try { await run({ request, start, repository, provider, env, api, clock: value => { clock = new Date(value); }, makeApi,
    use: value => { api = value; }, providerUse: value => { provider = value; } }); }
  finally { await aiApi.close(); for (const instance of apis) await instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('voice context freezes reviewed tenant and site knowledge and never reads private ERP data into provider input', async () => fixture(async f => {
  let result = await f.request('/api/ai-support'); assert.equal(result.status, 200, result.text);
  result = await f.request('/api/ai-support/settings', { body: { expectedRevision: result.body.revision, ...result.body.settings, voice: 'cedar', greeting: 'Välkommen till vår mottagning!', tone: 'calm' } }); assert.equal(result.status, 200, result.text);
  for (const entry of [
    { title: 'Kopparkabel', answer: 'Beskriv kabeln och om isoleringen sitter kvar. Kontoret bekräftar villkoren.', siteIds: ['north'], status: 'published', publicApproved: true },
    { title: 'DRAFT-CANARY', answer: 'DRAFT-PRIVATE-CANARY', siteIds: [], status: 'draft', publicApproved: false },
    { title: 'SOUTH-CANARY', answer: 'SOUTH-PRIVATE-CANARY', siteIds: ['south'], status: 'published', publicApproved: true },
  ]) { result = await f.request('/api/ai-support/knowledge', { body: { requestId: randomUUID(), expectedRevision: result.body.revision, category: 'materials', ...entry } }); assert.equal(result.status, 200, result.text); }
  await f.repository.transact(state => {
    state.personnel = { salaries: 'PAYROLL-PRIVATE-CANARY' };
    state.office.customers = [{ banking: 'CUSTOMER-BANK-PRIVATE-CANARY' }];
    state.pricing.customerPrices = 'CUSTOMER-PRICE-PRIVATE-CANARY';
    state.aiSupport.knowledge[0].hiddenCanary = 'EXTRA-FIELD-PRIVATE-CANARY';
  });
  const call = await f.start(); assert.equal(call.status, 200, call.text);
  const input = f.provider.requests[0], safeInput = JSON.stringify({ companyName: input.companyName, supportProfile: input.supportProfile, instructions: input.instructions });
  assert.equal(input.supportProfile.voice, 'cedar'); assert.equal(input.supportProfile.tone, 'calm'); assert.match(input.instructions, /Kopparkabel/);
  for (const hidden of ['DRAFT-PRIVATE', 'SOUTH-PRIVATE', 'PAYROLL-PRIVATE', 'CUSTOMER-BANK-PRIVATE', 'CUSTOMER-PRICE-PRIVATE', 'EXTRA-FIELD-PRIVATE', 'PRIVATE-FAKE-KEY', 'DO-NOT-EXPOSE']) assert.equal(safeInput.includes(hidden), false, hidden);
  assert.equal(call.body.call.aiSupportSnapshot.voice, 'cedar'); assert.equal(call.body.call.aiSupportSnapshot.knowledgeIds.length, 1); assert.match(call.body.call.aiSupportSnapshot.contextHash, /^[a-f0-9]{64}$/);
  result = await f.request('/api/ai-support/settings', { body: { expectedRevision: result.body.revision, ...result.body.settings, voice: 'marin' } }); assert.equal(result.status, 200, result.text);
  assert.equal(input.supportProfile.voice, 'cedar'); assert.equal((await f.request()).body.config.voice, 'marin');
}));

test('disabled company support profile blocks provider work and does not reserve a paid call', async () => fixture(async f => {
  let result = await f.request('/api/ai-support');
  result = await f.request('/api/ai-support/settings', { body: { expectedRevision: result.body.revision, ...result.body.settings, enabled: false } }); assert.equal(result.status, 200, result.text);
  const denied = await f.start(); assert.equal(denied.status, 503); assert.equal(f.provider.starts, 0); assert.equal((await f.request()).body.config.available, false);
  assert.equal((await f.repository.read(state => state.voiceTest))?.calls.length ?? 0, 0);
}));

test('voice HTTP requires both active privileged identities, scopes real sites and returns safe immutable configuration', async () => fixture(async f => {
  const before = await f.repository.read(state => state), result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.config.callerNumber, '+46700000000'); assert.equal(result.body.config.callerLabel, 'TEST'); assert.equal(result.body.config.companyName, 'Fiktivt Skrot AB');
  assert.equal(result.body.config.available, true); assert.deepEqual(result.body.calls, []); assert.equal(result.body.currentCall, null);
  for (const value of ['PRIVATE-FAKE-KEY', 'DO-NOT-EXPOSE', 'FINANCIAL-UNCHANGED', 'AO-UNCHANGED']) assert.equal(result.text.includes(value), false);
  assert.deepEqual(await f.repository.read(state => state), before); assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal((await f.request(undefined, { cookie: '' })).status, 401);
  for (const cookie of ['office=employee|admin', 'office=admin|employee']) assert.equal((await f.request(undefined, { cookie })).status, 403);
  assert.equal((await f.request(undefined, { cookie: 'office=inactive|admin' })).status, 401);
  assert.equal((await f.request(undefined, { cookie: 'office=south' })).body.config.site.id, 'south');
  assert.equal((await f.request(undefined, { cookie: 'office=empty' })).body.config.available, false);
  assert.equal((await f.request(undefined, { method: 'HEAD' })).text, ''); assert.equal(f.provider.starts, 0);
}));

test('strict routes, origin and body boundaries reject forged transcript, tenant and caller fields before provider use', async () => fixture(async f => {
  for (const extra of [{ transcript: [] }, { callerNumber: '+46123456789' }, { organisationId: 'foreign' }, { siteId: 'south' }]) assert.equal((await f.start(extra)).status, 422);
  assert.equal((await f.request('/api/voice-test?organisationId=foreign')).status, 404);
  assert.equal((await f.request('/api/voice-test/calls', { body: { requestId: randomUUID(), sdp: 'forged' } })).status, 422);
  assert.equal((await f.request('/api/voice-test/calls', { body: { requestId: randomUUID(), sdp }, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await f.request('/api/voice-test/calls', { body: { requestId: randomUUID(), sdp }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/api/voice-test/calls', { raw: 'x'.repeat(VOICE_TEST_LIMITS.maxBodyBytes + 1) })).status, 413);
  assert.equal((await f.request('/api/voice-test/calls', { raw: '{invalid' })).status, 422);
  assert.equal((await f.request('/api/voice-test/calls', { raw: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.provider.starts, 0); assert.equal(await f.repository.read(state => state.voiceTest), undefined);
}));

test('server sideband transcript is durable, ordered and completed before one summary; ready/end and followup retries are idempotent', async () => fixture(async f => {
  const initialBusiness = await f.repository.read(state => ({ office: state.office, transport: state.transport }));
  const input = { requestId: randomUUID(), sdp }, started = await f.request('/api/voice-test/calls', { body: input }); assert.equal(started.status, 200, started.text);
  const id = started.body.call.id; assert.equal(started.body.call.status, 'connecting'); assert.equal(started.body.call.siteId, 'north'); assert.equal(started.body.call.requestId, input.requestId);
  assert.match(f.provider.requests[0].instructions, /Fiktivt Skrot AB/); assert.equal(f.provider.requests[0].instructions.includes('JEROC'), false); assert.equal(f.provider.requests[0].instructions.includes('DO-NOT-EXPOSE'), false);
  assert.equal(f.provider.handles[0].readyCount, 0);
  const repeat = await f.request('/api/voice-test/calls', { body: input }); assert.equal(repeat.status, 200); assert.equal(repeat.body.answerSdp, started.body.answerSdp); assert.equal(f.provider.starts, 1);
  const conflict = await f.request('/api/voice-test/calls', { body: { ...input, sdp: `${sdp}a=changed\r\n` } }); assert.equal(conflict.status, 409);
  const ready = await Promise.all([1, 2, 3].map(() => f.request(`/api/voice-test/calls/${id}/ready`, { body: {} }))); assert.ok(ready.every(value => value.status === 200)); assert.equal(f.provider.handles[0].readyCount, 1);
  const inputTurn = { id: 'customer-question', role: 'user', text: 'Jag behöver hämtning av skrot och vill bli uppringd.', sequence: 0 };
  await f.provider.requests[0].onTranscript({ id: 'reply', role: 'assistant', text: 'En kollega behöver följa upp hämtningen.', sequence: 1 });
  await f.provider.requests[0].onTranscript(inputTurn); await f.provider.requests[0].onTranscript(inputTurn);
  f.provider.handles[0].close = async () => { f.provider.handles[0].closeCount++; await f.provider.requests[0].onTranscript({ id: 'final-question', role: 'user', text: 'Tack, jag heter Testkund.', sequence: 2 }); await f.provider.requests[0].onEnded({ reason: 'closed' }); };
  const summarize = f.provider.summarize; f.provider.summarize = async input => { const saved = await f.repository.read(state => state.voiceTest.calls.find(call => call.id === id)); assert.ok(saved.transcriptFinalizedAt); assert.deepEqual(input.transcript, saved.transcript); return summarize(input); };
  const ended = await Promise.all([1, 2].map(() => f.request(`/api/voice-test/calls/${id}/end`, { body: {} }))); assert.ok(ended.every(value => value.status === 200), JSON.stringify(ended));
  assert.equal(f.provider.handles[0].closeCount, 1); assert.equal(f.provider.summaries.length, 1);
  assert.deepEqual(ended[0].body.call.transcript.map(turn => turn.id), ['customer-question', 'reply', 'final-question']); assert.equal(ended[0].body.call.summaryStatus, 'generated'); assert.equal(ended[0].body.call.callbackRequested, true);
  assert.equal(ended[0].text.includes('provider-private'), false);
  const readyAfterEnd = await f.request(`/api/voice-test/calls/${id}/ready`, { body: {} }); assert.equal(readyAfterEnd.status, 200); assert.equal(f.provider.handles[0].readyCount, 1);
  const changed = await f.request(`/api/voice-test/calls/${id}/status`, { body: { status: 'done' } }), replay = await f.request(`/api/voice-test/calls/${id}/status`, { body: { status: 'done' } });
  assert.equal(changed.status, 200); assert.deepEqual(changed.body.call, replay.body.call);
  await f.api.close(); const next = f.makeApi(); f.use(next); const restored = await f.request(`/api/voice-test/calls/${id}`);
  assert.equal(restored.body.call.followupStatus, 'done'); assert.equal(restored.body.call.transcript.length, 3); assert.deepEqual(await f.repository.read(state => ({ office: state.office, transport: state.transport })), initialBusiness);
  assert.equal((await f.request(`/api/voice-test/calls/${id}`, { cookie: 'office=south' })).status, 404);
}));

test('one company slot and request reservation survive concurrent runtimes without duplicated provider work', async () => fixture(async f => {
  const otherProvider = mockProvider(), other = f.makeApi({ provider: otherProvider, runtimeId: 'other-runtime' });
  const results = await Promise.all([f.start(), f.start()]); assert.equal(results.filter(value => value.status === 200).length, 1); assert.equal(results.filter(value => value.status === 409).length, 1); assert.equal(f.provider.starts, 1);
  const id = results.find(value => value.status === 200).body.call.id;
  f.use(other); const remote = await f.start(); assert.equal(remote.status, 409); assert.equal(otherProvider.starts, 0);
  assert.equal((await f.request(`/api/voice-test/calls/${id}/ready`, { body: {} })).status, 409);
  assert.equal((await f.request(`/api/voice-test/calls/${id}/end`, { body: {} })).status, 200);
  await f.api.recover(); assert.equal(f.provider.handles[0].closeCount, 1); assert.equal((await f.request()).body.currentCall, null);
}));

test('durable start quotas use actual/effective accounts and Stockholm calendar days, and full journals preserve all existing records', async () => fixture(async f => {
  for (let i = 0; i < 6; i++) { const result = await f.start(); assert.equal(result.status, 200); await f.request(`/api/voice-test/calls/${result.body.call.id}/end`, { body: {} }); }
  assert.equal((await f.start()).body.code, 'voice_test_hour_quota');
  assert.equal((await f.request('/api/voice-test/calls', { body: { requestId: randomUUID(), sdp }, cookie: 'office=admin|vd' })).body.code, 'voice_test_hour_quota');
  f.clock('2026-10-17T11:00:00.001Z'); const afterHour = await f.start(); assert.equal(afterHour.status, 200); await f.request(`/api/voice-test/calls/${afterHour.body.call.id}/end`, { body: {} });
  await f.repository.transact(state => { const sample = state.voiceTest.calls[0]; while (state.voiceTest.calls.length < 30) state.voiceTest.calls.push({ ...structuredClone(sample), id: randomUUID(), requestId: randomUUID(), createdAt: '2026-10-16T22:30:00Z', createdBy: { actualUserId: randomUUID(), effectiveUserId: randomUUID(), name: 'Fiktiv annan administratör' } }); });
  assert.equal((await f.start()).body.code, 'voice_test_day_quota');
  f.clock('2026-10-17T22:00:00Z'); const nextDay = await f.start(); assert.equal(nextDay.status, 200); await f.request(`/api/voice-test/calls/${nextDay.body.call.id}/end`, { body: {} });
  await f.repository.transact(state => { const sample = state.voiceTest.calls[0]; while (state.voiceTest.calls.length < 300) state.voiceTest.calls.push({ ...structuredClone(sample), id: randomUUID(), requestId: randomUUID() }); });
  assert.equal((await f.start()).body.code, 'voice_test_journal_full'); assert.equal(await f.repository.read(state => state.voiceTest.calls.length), 300);
  const listed = await f.request(); assert.equal(listed.body.calls.length, 20);
}));

test('connection checks never create calls, missing configuration never consumes quota and provider secrets/errors are redacted', async () => fixture(async f => {
  assert.equal((await f.request('/api/voice-test/connection-test', { body: {} })).status, 200); assert.equal(f.provider.checks, 1); assert.equal(f.provider.starts, 0);
  assert.equal(await f.repository.read(state => state.voiceTest), undefined);
  f.provider.status = () => ({ keyPresent: false, available: false, model: 'test-realtime' }); assert.equal((await f.start()).status, 503); assert.equal(await f.repository.read(state => state.voiceTest), undefined);
  f.provider.status = () => ({ keyPresent: true, available: true, model: 'test-realtime' }); f.provider.start = async () => { throw new Error('PRIVATE-FAKE-KEY-NEVER-RETURN provider-private-secret'); };
  const failed = await f.start(); assert.equal(failed.status, 503); assert.equal(failed.text.includes('PRIVATE'), false);
  const saved = (await f.request()).body.calls[0]; assert.equal(saved.status, 'failed'); assert.equal(saved.endReason, 'connection_failed'); assert.equal(saved.error.includes('PRIVATE'), false);
}));

test('provider callbacks before start resolution and explicit early end preserve one terminal record and close the eventual handle', async () => fixture(async f => {
  let entered, release; const reached = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const original = f.provider.start; f.provider.start = async input => { const handle = await original(input); entered(); await blocked; return handle; };
  const attempt = f.start(); await reached; const current = (await f.request()).body.currentCall;
  await f.provider.requests[0].onTranscript({ id: 'early-user', role: 'user', text: 'Det här är en tidig fråga.' });
  const aborted = new Promise(resolve => f.provider.requests[0].signal.addEventListener('abort', resolve, { once: true }));
  const ending = f.request(`/api/voice-test/calls/${current.id}/end`, { body: {} }); await aborted; release();
  const [started, ended] = await Promise.all([attempt, ending]); assert.equal(started.status, 409); assert.equal(ended.status, 200); assert.equal(ended.body.call.status, 'ended'); assert.equal(ended.body.call.transcript.length, 1); assert.ok(f.provider.handles[0].closeCount >= 1);
  assert.equal((await f.request()).body.currentCall, null); assert.equal((await f.request()).body.calls.length, 1);
}));

test('max duration, trusted session revocation and shutdown interrupt live provider sessions without automatic restart', async () => fixture(async f => {
  const first = await f.start(), id = first.body.call.id; await f.request(`/api/voice-test/calls/${id}/ready`, { body: {} });
  f.clock('2026-10-17T10:03:00Z'); await f.api.recover(); let saved = (await f.request(`/api/voice-test/calls/${id}`)).body.call;
  assert.equal(saved.endReason, 'time_limit'); assert.equal(saved.durationSeconds, 180); assert.equal(f.provider.handles[0].closeCount, 1);
  const second = await f.start(); await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'admin').level = 'Medarbetare'; });
  await f.api.recover(); assert.equal(await f.repository.read(state => state.voiceTest.calls.find(call => call.id === second.body.call.id).endReason), 'authorization_revoked');
  await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'admin').level = 'Systemadmin'; });
  const third = await f.start(); await f.api.close(); saved = await f.repository.read(state => state.voiceTest.calls.find(call => call.id === third.body.call.id));
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.endReason, 'server_shutdown'); assert.equal(f.provider.starts, 3);
}));

test('an expired owner lease is durably interrupted on another runtime and a mismatched tenant never exposes its journal', async () => fixture(async f => {
  const started = await f.start(); const id = started.body.call.id;
  const next = f.makeApi({ provider: mockProvider(), runtimeId: 'new-runtime' }); f.use(next); f.clock('2026-10-17T10:00:21Z'); await next.recover();
  const saved = (await f.request(`/api/voice-test/calls/${id}`)).body.call; assert.equal(saved.status, 'interrupted'); assert.equal(saved.endReason, 'server_interrupted');
  f.use(f.makeApi({ env: { SCRAPPILOT_ORGANISATION_ID: 'foreign-company' }, provider: mockProvider() }));
  const foreign = await f.request(); assert.equal(foreign.status, 403); assert.equal(foreign.text.includes(id), false);
}));

test('live platform reauthorization runs outside repository callbacks and a newer local role change still stops the call', async () => fixture(async f => {
  const context = new AsyncLocalStorage(); let checked = 0;
  const repository = { read: (operation, options) => f.repository.read((...args) => context.run('read', () => operation(...args)), options),
    transact: operation => f.repository.transact((...args) => context.run('write', () => operation(...args))) };
  const api = f.makeApi({ getRepository: async () => repository, reauthorizeCall: async state => {
    assert.equal(context.getStore(), undefined, 'Platform authorization must not join the tenant database transaction or read context'); checked++;
    const user = state.pricing.users.find(user => user.id === 'admin');
    await f.repository.transact(current => { current.pricing.users.find(user => user.id === 'admin').level = 'Medarbetare'; });
    return { actor: user, user };
  } });
  f.use(api); const created = await f.start(); assert.equal(created.status, 200); await api.recover(); assert.equal(checked, 1);
  const saved = await f.repository.read(state => state.voiceTest.calls.find(call => call.id === created.body.call.id)); assert.equal(saved.endReason, 'authorization_revoked');
}));

test('a new legitimate call created during an older reauthorization sweep is not falsely revoked', async () => fixture(async f => {
  let entered, release, checks = 0; const reached = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const api = f.makeApi({ reauthorizeCall: async state => { if (++checks === 1) { entered(); await hold; } const user = state.pricing.users.find(user => user.id === 'admin'); return { actor: user, user }; } });
  f.use(api); const old = await f.start(); assert.equal(old.status, 200);
  const sweep = api.recover(); await reached;
  assert.equal((await f.request(`/api/voice-test/calls/${old.body.call.id}/end`, { body: {} })).status, 200);
  const newer = await f.start(); assert.equal(newer.status, 200); release(); await sweep;
  const saved = await f.repository.read(state => state.voiceTest.calls.find(call => call.id === newer.body.call.id)); assert.equal(saved.status, 'connecting'); assert.equal(saved.endReason, undefined);
}));

test('unconfirmed final audio and interrupted summaries remain explicit, preserve the transcript and never retry a summary after a crash', async () => fixture(async f => {
  const created = await f.start(), id = created.body.call.id;
  await f.provider.requests[0].onTranscript({ id: 'saved-user', role: 'user', text: 'Spara detta ärende även om anslutningen bryts.' });
  f.provider.handles[0].close = async () => ({ transcriptComplete: false, providerConfirmed: false });
  const ended = await f.request(`/api/voice-test/calls/${id}/end`, { body: {} }); assert.equal(ended.status, 200); assert.equal(ended.body.call.transcriptComplete, false); assert.equal(ended.body.call.providerConfirmed, false);
  await f.repository.transact(state => { const call = state.voiceTest.calls.find(call => call.id === id); call.summaryStatus = 'pending'; call.summaryDeadlineAt = '2026-10-17T10:00:01Z'; });
  f.clock('2026-10-17T10:00:02Z'); const otherProvider = mockProvider(), next = f.makeApi({ provider: otherProvider }); f.use(next); await next.recover();
  const saved = (await f.request(`/api/voice-test/calls/${id}`)).body.call; assert.equal(saved.summaryStatus, 'fallback'); assert.match(saved.summary, /Spara detta ärende/); assert.equal(saved.transcript.length, 1); assert.equal(otherProvider.summaries.length, 0);
}));

test('the real adapter can report missing server credentials without creating a call or making an OpenAI request', async () => fixture(async f => {
  const api = f.makeApi({ provider: null, env: { SCRAPPILOT_ORGANISATION_ID: org } }); f.use(api);
  const result = await f.request(); assert.equal(result.status, 200); assert.equal(result.body.config.keyPresent, false); assert.equal(result.body.config.available, false);
  assert.equal((await f.request('/api/voice-test/connection-test', { body: {} })).status, 503);
  assert.equal((await f.start()).status, 503); assert.equal(await f.repository.read(state => state.voiceTest), undefined);
}));
