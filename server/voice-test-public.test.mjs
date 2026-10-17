import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { ensureAiSupport } from './ai-support.mjs';
import { createVoiceTestApi, VOICE_TEST_LIMITS } from './voice-test.mjs';
import { createPublicVoiceTestApi, PUBLIC_VOICE_LIMITS } from './voice-test-public.mjs';

const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Anonymous voice test\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
async function fixture(run, { env: extraEnv = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'public-voice-')), env = { SCRAPPILOT_ORGANISATION_ID: 'jeroc-demo', VOICE_TEST_ENGINE: 'live', ...extraEnv };
  const repository = await createApplicationRepository({ filename: join(directory, 'app.sqlite'), seed: () => ({ metadata: { organisation: { id: 'jeroc-demo' } }, pricing: { users: [] }, office: { customers: [{ name: 'PRIVATE-CUSTOMER-CANARY' }] }, personnel: { payroll: 'PRIVATE-PAYROLL-CANARY' } }) });
  await repository.transact(state => {
    const support = ensureAiSupport(state, { organisationId: 'jeroc-demo', companyName: 'JEROC', defaultVoice: 'meridian', engine: 'live' });
    support.knowledge.push({ id: 'public-faq', version: 1, title: 'Kabelskrot', answer: 'Vi köper kabelskrot. Kontoret bekräftar pris.', category: 'materials', siteIds: [], status: 'published', publicApproved: true, approvedAt: '2026-10-17T10:00:00Z' },
      { id: 'private-draft', version: 1, title: 'Utkast', answer: 'PRIVATE-DRAFT-CANARY', category: 'materials', siteIds: [], status: 'draft', publicApproved: false });
    const entry = support.knowledge[0]; entry.approvedVersion = entry.version;
    entry.approvedHash = createHash('sha256').update(JSON.stringify({ title: entry.title, answer: entry.answer, category: entry.category, siteIds: [] })).digest('hex');
  });
  let clock = new Date('2026-10-17T10:00:00Z'), starts = 0;
  const requests = [], handles = [], instances = [];
  const provider = { status: () => ({ keyPresent: true, available: true, model: 'fake-live-model', protocol: 'live' }),
    async start(input) { starts++; requests.push(input); const handle = { answerSdp: sdp, protocol: 'live', readyCount: 0, closeCount: 0,
      async ready() { this.readyCount++; }, async close() { this.closeCount++; return { providerConfirmed: true, transcriptComplete: true }; } }; handles.push(handle); return handle; },
    async summarize() { return { status: 'generated', summary: 'Privat intern sammanfattning ska inte vara publik.' }; } };
  const makeApi = () => { const api = createPublicVoiceTestApi({ getRepository: async () => repository, siteProvider: async () => [{ id: 'north', name: 'Norrtälje', active: true, address: 'PRIVATE-DEMO-ADDRESS-CANARY' }], env, provider, now: () => clock }); instances.push(api); return api; };
  let api = makeApi(), privateApi;
  const makePrivateApi = (id = 'private-admin') => {
    const identity = { id, name: 'Kontorsadmin', active: true, level: 'Systemadmin' };
    privateApi = createVoiceTestApi({ getRepository: async () => repository, officePrincipal: () => ({ actor: identity, user: identity }),
      siteProvider: async () => [{ id: 'north', name: 'Norrtälje', active: true }], env, provider, now: () => clock }); instances.push(privateApi); return privateApi;
  };
  const server = createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); void (async () => await api(req, res, url) || await privateApi?.(req, res, url))().then(handled => { if (!handled) { res.writeHead(404); res.end(); } }).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = () => { let cookie = '', csrfToken; return {
    async request(path = '/api/public/voice-test', body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Voice-Demo-CSRF': csrfToken ?? '' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const set = response.headers.getSetCookie()[0]; if (set) cookie = set.split(';')[0]; const text = await response.text(), value = text ? JSON.parse(text) : undefined; if (value?.csrfToken) csrfToken = value.csrfToken;
      return { status: response.status, body: value, text, headers: response.headers };
    }, start(extra = {}) { return this.request('/api/public/voice-test/calls', { requestId: randomUUID(), sdp, ...extra }); },
    get cookie() { return cookie; }, get csrfToken() { return csrfToken; }
  }; };
  try { await run({ browser, repository, provider, requests, handles, get starts() { return starts; }, api, makeApi, makePrivateApi, use(value) { api = value; }, advance(ms) { clock = new Date(clock.getTime() + ms); } }); }
  finally { for (const instance of instances) await instance.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('anonymous bootstrap exposes no history or internal configuration and cookies are short-lived capabilities', () => fixture(async f => {
  const a = f.browser(), b = f.browser(), first = await a.request(); assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.calls, []); assert.equal(first.body.currentCall, null); assert.equal(first.body.config.available, true); assert.equal(typeof first.body.csrfToken, 'string');
  assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=900/); assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal((await b.request()).status, 200); assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.csrfToken, b.csrfToken);
  for (const hidden of ['fake-live-model', 'PRIVATE-', 'backendModel', 'knowledge', 'createdBy']) assert.equal(first.text.includes(hidden), false, hidden);
  for (const path of ['/history', '/calls', '/connection-test', '/settings', '?organisationId=other']) assert.equal((await a.request(`/api/public/voice-test${path}`)).status >= 400, true, path);
  assert.equal(f.starts, 0);
}));

test('only server-reviewed public facts enter provider and each browser sees only its own current transcript', () => fixture(async f => {
  const a = f.browser(), b = f.browser(); await a.request(); await b.request();
  const started = await a.start(); assert.equal(started.status, 200, started.text); const id = started.body.call.id;
  assert.equal(started.body.protocol, 'live'); assert.equal(started.body.call.createdBy, undefined); assert.equal(started.body.call.aiSupportSnapshot, undefined);
  const context = JSON.stringify({ instructions: f.requests[0].instructions, site: f.requests[0].site, supportProfile: f.requests[0].supportProfile });
  assert.match(context, /kabelskrot/); assert.equal(context.includes('PRIVATE-'), false); assert.equal(f.requests[0].supportProfile.voice, 'meridian');
  await f.requests[0].onTranscript({ id: 'own-turn', role: 'user', text: 'Jag undrar om kopparkabel.', sequence: 0 });
  assert.equal((await b.request(`/api/public/voice-test/calls/${id}`)).status, 404);
  assert.equal((await b.request(`/api/public/voice-test/calls/${id}/end`, {})).status, 404);
  assert.equal((await a.request(`/api/public/voice-test/calls/${id}/ready`, {})).status, 200); assert.equal(f.handles[0].readyCount, 1);
  const ended = await a.request(`/api/public/voice-test/calls/${id}/end`, {}); assert.equal(ended.status, 200, ended.text); assert.equal(ended.body.call.transcript[0].text, 'Jag undrar om kopparkabel.'); assert.equal(ended.body.call.summary, undefined);
  assert.equal((await a.request()).body.currentCall.id, id); assert.equal((await b.request()).body.currentCall, null);
  f.advance(3600001); const next = await a.start(); assert.equal(next.status, 401, 'Expired capability cannot start without a new bootstrap');
}));

test('two anonymous capabilities have independent simultaneous sessions, transcripts and end actions', () => fixture(async f => {
  const a = f.browser(), b = f.browser(); await a.request(); await b.request();
  const results = await Promise.all([a.start(), b.start()]); assert.ok(results.every(item => item.status === 200), JSON.stringify(results)); assert.equal(f.starts, 2);
  const aId = results[0].body.call.id, bId = results[1].body.call.id; assert.notEqual(aId, bId);
  const forCall = id => f.requests.find(input => input.callId === id);
  await forCall(aId).onTranscript({ id: 'first-provider-row', role: 'user', text: 'Bara kund A:s kopparkabel.', sequence: 0 });
  await forCall(bId).onTranscript({ id: 'second-provider-row', role: 'user', text: 'Bara kund B:s järnskrot.', sequence: 0 });
  const aView = await a.request(), bView = await b.request();
  assert.equal(aView.body.currentCall.id, aId); assert.equal(bView.body.currentCall.id, bId);
  assert.equal(aView.text.includes('kund B'), false); assert.equal(bView.text.includes('kund A'), false);
  assert.deepEqual(aView.body.calls, []); assert.deepEqual(bView.body.calls, []);
  assert.equal((await a.start()).body.code, 'voice_demo_active_call'); assert.equal(f.starts, 2);
  assert.equal((await a.request(`/api/public/voice-test/calls/${bId}/end`, {})).status, 404);
  const ended = await a.request(`/api/public/voice-test/calls/${aId}/end`, {}); assert.equal(ended.status, 200, ended.text);
  assert.equal((await b.request()).body.currentCall.status, 'connecting');
  assert.equal(f.handles[f.requests.indexOf(forCall(aId))].closeCount, 1); assert.equal(f.handles[f.requests.indexOf(forCall(bId))].closeCount, 0);
  assert.equal((await f.repository.read(state => state.voiceTest.publicDemo.starts)).length, 2);
}));

test('five visitors behind one office IP can start and poll concurrently within unchanged global budgets', () => fixture(async f => {
  const visitors = Array.from({ length: VOICE_TEST_LIMITS.maxConcurrentCalls }, () => f.browser());
  await Promise.all(visitors.map(visitor => visitor.request()));
  const started = await Promise.all(visitors.map(visitor => visitor.start()));
  assert.ok(started.every(item => item.status === 200), JSON.stringify(started)); assert.equal(f.starts, 5);
  for (let poll = 0; poll < 31; poll++) {
    const results = await Promise.all(visitors.map((visitor, index) => visitor.request(`/api/public/voice-test/calls/${started[index].body.call.id}`)));
    assert.ok(results.every(item => item.status === 200), JSON.stringify(results));
    results.forEach((item, index) => assert.equal(item.body.call.id, started[index].body.call.id));
  }
  assert.equal(PUBLIC_VOICE_LIMITS.startsPerHour, 10); assert.equal(PUBLIC_VOICE_LIMITS.startsPerDay, 30);
  assert.equal(PUBLIC_VOICE_LIMITS.requestsPerMinuteGlobal, 300); assert.equal(PUBLIC_VOICE_LIMITS.startsPerSession, 2);
}));

test('known-full shared capacity does not consume public attempt quota and is released by an ended call', () => fixture(async f => {
  const a = f.browser(); await a.request(); const ids = [];
  for (let index = 0; index < VOICE_TEST_LIMITS.maxConcurrentCalls; index++) {
    f.makePrivateApi(`private-${index}`); const result = await a.request('/api/voice-test/calls', { requestId: randomUUID(), sdp });
    assert.equal(result.status, 200, result.text); ids.push(result.body.call.id);
  }
  const before = await f.repository.read(state => state.voiceTest.publicDemo), denied = await a.start();
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'voice_test_capacity'); assert.match(denied.body.error, /fem samtalsplatser/);
  const after = await f.repository.read(state => state.voiceTest.publicDemo); assert.deepEqual(after.starts, before.starts); assert.equal(after.sessions[0].starts, 0);
  await a.request(`/api/voice-test/calls/${ids.at(-1)}/end`, {});
  const started = await a.start(); assert.equal(started.status, 200, started.text); assert.equal(f.starts, 6);
  assert.equal((await f.repository.read(state => state.voiceTest.calls)).filter(call => ['connecting', 'active'].includes(call.status)).length, 5);
  assert.equal((await f.repository.read(state => state.voiceTest.publicDemo.sessions[0])).starts, 1);
}));

test('public and private calls run together and close independently while retaining final authenticated captions', () => fixture(async f => {
  const privateApi = f.makePrivateApi(), a = f.browser(); await a.request();
  const [privateStarted, publicStarted] = await Promise.all([
    a.request('/api/voice-test/calls', { requestId: randomUUID(), sdp }), a.start(),
  ]);
  assert.equal(privateStarted.status, 200, privateStarted.text); assert.equal(publicStarted.status, 200, publicStarted.text);
  const privateId = privateStarted.body.call.id, publicId = publicStarted.body.call.id;
  const privateIndex = f.requests.findIndex(input => input.callId === privateId), publicIndex = f.requests.findIndex(input => input.callId === publicId);
  f.handles[publicIndex].close = async () => {
    f.handles[publicIndex].closeCount++;
    await f.requests[publicIndex].onTranscript({ id: 'public-final', role: 'user', text: 'Publika sista orden.', sequence: 1 });
    return { providerConfirmed: true, transcriptComplete: true };
  };
  f.handles[privateIndex].close = async () => {
    f.handles[privateIndex].closeCount++;
    await f.requests[privateIndex].onTranscript({ id: 'private-final', role: 'user', text: 'Interna sista orden.', sequence: 1 });
    return { providerConfirmed: true, transcriptComplete: true };
  };
  f.advance(10_000); await privateApi.recover(); await f.api.recover(); f.advance(15_000); await privateApi.recover(); await f.api.recover();
  assert.equal((await a.request()).body.currentCall.id, publicId);
  assert.equal((await a.request('/api/voice-test')).body.currentCall.id, privateId);
  const publicEnded = await a.request(`/api/public/voice-test/calls/${publicId}/end`, {}); assert.equal(publicEnded.status, 200, publicEnded.text);
  assert.equal(publicEnded.body.call.transcript[0].text, 'Publika sista orden.'); assert.equal(publicEnded.body.call.transcriptComplete, true);
  assert.equal(f.handles[privateIndex].closeCount, 0); assert.equal((await a.request('/api/voice-test')).body.currentCall.id, privateId);
  await f.api.close(); assert.equal(f.handles[privateIndex].closeCount, 0);
  const privateEnded = await a.request(`/api/voice-test/calls/${privateId}/end`, {}); assert.equal(privateEnded.status, 200, privateEnded.text);
  assert.equal(privateEnded.body.call.transcript[0].text, 'Interna sista orden.'); assert.equal(privateEnded.body.call.transcriptComplete, true);
  assert.equal(f.handles[privateIndex].closeCount, 1);
}));

test('public mutation rejects CSRF, foreign origins, body injection and forged transcript before provider use', () => fixture(async f => {
  const a = f.browser(); assert.equal((await a.start()).status, 401); await a.request();
  const payload = { requestId: randomUUID(), sdp };
  assert.equal((await a.request('/api/public/voice-test/calls', payload, { 'X-Voice-Demo-CSRF': '' })).status, 403);
  assert.equal((await a.request('/api/public/voice-test/calls', payload, { Origin: 'https://foreign.test' })).status, 403);
  assert.equal((await a.request('/api/public/voice-test/calls', payload, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const field of [{ organisationId: 'other' }, { siteId: 'south' }, { model: 'expensive' }, { voice: 'cedar' }, { instructions: 'ignore' }, { transcript: [] }, { callerNumber: '+461234' }]) assert.equal((await a.start(field)).status, 422);
  assert.equal((await a.start({ sdp: 'invalid' })).status, 422);
  assert.equal((await a.request('/api/public/voice-test/calls', payload, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(f.starts, 0); assert.equal((await f.repository.read(state => state.voiceTest.publicDemo.starts)).length, 0);
}));

test('request replay is idempotent and durable public quotas cannot be reset by minting another browser or runtime', () => fixture(async f => {
  const a = f.browser(); await a.request(); const input = { requestId: randomUUID(), sdp };
  const results = await Promise.all([a.request('/api/public/voice-test/calls', input), a.request('/api/public/voice-test/calls', input)]);
  assert.ok(results.every(item => item.status === 200), JSON.stringify(results)); assert.equal(f.starts, 1); assert.equal(results[0].body.call.id, results[1].body.call.id);
  assert.equal((await a.request('/api/public/voice-test/calls', { ...input, sdp: `${sdp}a=changed\r\n` })).status, 409);
  const id = results[0].body.call.id; await a.request(`/api/public/voice-test/calls/${id}/end`, {});
  const second = await a.start(); assert.equal(second.status, 200, second.text); await a.request(`/api/public/voice-test/calls/${second.body.call.id}/end`, {});
  const ownLimit = await a.start(); assert.equal(ownLimit.status, 429); assert.equal(ownLimit.body.code, 'voice_demo_start_limit'); assert.equal(f.starts, 2);
  for (let index = 0; index < 2; index++) {
    const visitor = f.browser(); await visitor.request();
    for (let attempt = 0; attempt < 2; attempt++) { const started = await visitor.start(); assert.equal(started.status, 200, started.text); await visitor.request(`/api/public/voice-test/calls/${started.body.call.id}/end`, {}); }
  }
  f.use(f.makeApi()); const next = f.browser(); await next.request(); const denied = await next.start();
  assert.equal(denied.status, 429); assert.equal(denied.body.code, 'voice_demo_start_limit'); assert.equal(f.starts, PUBLIC_VOICE_LIMITS.startsPerIpHour);
  assert.equal((await f.repository.read(state => state.voiceTest.publicDemo.starts)).length, PUBLIC_VOICE_LIMITS.startsPerIpHour);
}));

test('new request hides the same browser previous transcript and cannot change followup status', () => fixture(async f => {
  const a = f.browser(); await a.request(); const first = await a.start(), firstId = first.body.call.id;
  await a.request(`/api/public/voice-test/calls/${firstId}/end`, {});
  const second = await a.start(); assert.equal(second.status, 200, second.text);
  assert.equal((await a.request(`/api/public/voice-test/calls/${firstId}`)).status, 404);
  assert.equal((await a.request(`/api/public/voice-test/calls/${second.body.call.id}/status`, { status: 'done' })).status, 404);
  assert.deepEqual((await a.request()).body.calls, []); assert.equal((await a.request()).body.currentCall.id, second.body.call.id);
}));

test('session mint limits and tenant fail-closed guard prevent arbitrary anonymous tenant access', () => fixture(async f => {
  for (let index = 0; index < PUBLIC_VOICE_LIMITS.sessionsPerIpHour; index++) assert.equal((await f.browser().request()).status, 200);
  assert.equal((await f.browser().request()).status, 429); assert.equal(f.starts, 0);
}));
test('non-demo tenants do not expose a public voice capability', () => fixture(async f => {
  assert.equal((await f.browser().request()).status, 404); assert.equal(f.starts, 0);
}, { env: { SCRAPPILOT_ORGANISATION_ID: 'another-company' } }));

test('anonymous request bursts are rejected before database access and valid-cookie bootstrap is read-only', () => fixture(async f => {
  const a = f.browser(); await a.request();
  const original = f.repository.transact; let writes = 0;
  f.repository.transact = (...args) => { writes++; return original.apply(f.repository, args); };
  for (let index = 1; index < PUBLIC_VOICE_LIMITS.requestsPerMinute; index++) assert.equal((await a.request()).status, 200);
  assert.equal(writes, 0, 'Existing capability bootstrap must not take a CRM write lock');
  const response = await a.request(); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '60'); assert.equal(writes, 0);
  f.advance(60_001); assert.equal((await a.request()).status, 200);
}));

test('private and public cores preserve each other live leases and final captions across deadline recovery', () => fixture(async f => {
  const privateApi = f.makePrivateApi(), a = f.browser(); await a.request(); const started = await a.start(), id = started.body.call.id;
  f.advance(10_000); await privateApi.recover(); assert.equal((await f.repository.read(state => state.voiceTest.calls[0])).status, 'connecting');
  await f.api.recover(); f.advance(15_000); await privateApi.recover(); assert.equal((await f.repository.read(state => state.voiceTest.calls[0])).status, 'connecting');
  f.advance(154_000); await f.api.recover(); f.advance(1001); await privateApi.recover();
  const deadline = await f.repository.read(state => state.voiceTest.calls[0]); assert.equal(deadline.status, 'ended'); assert.equal(deadline.transcriptFinalizedAt, undefined, 'Other live runtime receives time to drain authenticated final captions');
  f.handles[0].close = async () => { f.handles[0].closeCount++; await f.requests[0].onTranscript({ id: 'provider-final-id', role: 'user', text: 'Sista orden sparas.', sequence: 1 }); return { providerConfirmed: true, transcriptComplete: true }; };
  await f.api.recover(); const ended = await a.request(`/api/public/voice-test/calls/${id}`); assert.equal(ended.status, 200, ended.text); assert.equal(ended.body.call.transcript[0].text, 'Sista orden sparas.'); assert.equal(ended.body.call.transcriptComplete, true);
  assert.equal(ended.text.includes('provider-final-id'), false); assert.equal(ended.body.call.transcript[0].liveFragments, undefined);
  await privateApi.close(); assert.equal(f.handles[0].closeCount, 1);
}));

test('public recovery and shutdown do not revoke or close an authenticated core conversation', () => fixture(async f => {
  const privateApi = f.makePrivateApi(), a = f.browser();
  const started = await a.request('/api/voice-test/calls', { requestId: randomUUID(), sdp }); assert.equal(started.status, 200, started.text);
  await f.api.recover(); await f.api.close();
  const call = await f.repository.read(state => state.voiceTest.calls[0]); assert.equal(call.status, 'connecting'); assert.equal(f.handles[0].closeCount, 0);
  await privateApi.close(); assert.equal(f.handles[0].closeCount, 1);
}));

test('a new anonymous visitor recovers an expired owner after restart before reserving another call', () => fixture(async f => {
  const a = f.browser(); await a.request(); const first = await a.start(); assert.equal(first.status, 200);
  f.advance(181_000); f.use(f.makeApi());
  const b = f.browser(); await b.request(); const next = await b.start(); assert.equal(next.status, 200, next.text);
  const previous = await f.repository.read(state => state.voiceTest.calls.find(call => call.id === first.body.call.id));
  assert.equal(previous.status, 'ended'); assert.equal(previous.endReason, 'time_limit'); assert.equal(f.starts, 2);
}));

test('public voice fails closed for legacy Realtime transport before consuming paid quotas', () => fixture(async f => {
  f.provider.status = () => ({ keyPresent: true, available: true, model: 'fake-realtime', protocol: 'realtime' });
  const a = f.browser(), config = await a.request(); assert.equal(config.status, 200); assert.equal(config.body.config.available, false);
  const started = await a.start(); assert.equal(started.status, 503); assert.equal(f.starts, 0);
  assert.equal((await f.repository.read(state => state.voiceTest.publicDemo.starts)).length, 0);
}, { env: { VOICE_TEST_ENGINE: 'realtime' } }));
