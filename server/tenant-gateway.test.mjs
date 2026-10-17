import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';

function number(prefix) {
  const sum = [...prefix].reduce((total, value, index) => { let digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit); }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}
async function fixture(run, { privateBootstrap = true, postgres = false, demoAutoSession = true, primePortalDemo = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-gateway-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'), JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'), JEROC_TENANT_DATA_DIR: directory,
    JEROC_DEMO_AUTO_SESSION: demoAutoSession ? 'true' : 'false',
    ...(privateBootstrap && { SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Private-Gateway-Fixture-2026!' }) };
  let pool, schema;
  if (postgres) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `gateway_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = url.toString();
  }
  let gateway, server;
  try {
    if (primePortalDemo) {
      const seeded = await createTenantGateway({ env: { ...env, JEROC_DEMO_AUTO_SESSION: 'true' } });
      await seeded.close();
    }
    gateway = await createTenantGateway({ env });
    server = createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); void (async () => {
      if (await gateway.selectPage(req, res, url) || await gateway(req, res, url)) return;
      res.writeHead(404); res.end();
    })().catch(error => { res.writeHead(500); res.end(error.code ?? 'unexpected'); }); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`, cookies = new Map(); let session;
    async function request(path, payload, headers = {}) {
      const response = await fetch(`${base}${path}`, { method: payload === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': session.generation }),
          ...(payload !== undefined && { 'Content-Type': 'application/json' }), ...headers }, ...(payload !== undefined && { body: JSON.stringify(payload) }) });
      for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0].split('='); if (!value) cookies.delete(key); else cookies.set(key, value); }
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
      if (body?.authenticated) session = body;
      return { response, body, status: response.status };
    }
    const admin = async () => {
      let result = await request('/api/platform/login', { username: 'admin', password: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD });
      assert.equal(result.status, 200); assert.equal(result.body.mustChangePassword, true);
      result = await request('/api/platform/change-password', { currentPassword: env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD, newPassword: 'Changed-Private-Administrator-2026!' });
      assert.equal(result.status, 200); return result.body;
    };
    const create = async (label, prefix) => {
      const result = await request('/api/platform/companies', { requestId: randomUUID(), name: label, organisationNumber: number(prefix), vdName: `${label} VD`, vdEmail: `${label.toLowerCase().replaceAll(' ', '')}@example.test` });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
    };
    await run({ gateway, env, request, cookies, admin, create, get session() { return session; } });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    const companies = gateway ? await gateway.repository.read(state => structuredClone(state.companies)) : [];
    await gateway?.close();
    if (pool) { for (const company of companies.filter(value => value.id !== 'jeroc-demo')) await pool.query(`DROP SCHEMA IF EXISTS "${company.storageSchema}" CASCADE`); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('public demo password cannot bootstrap platform; mobile keeps its existing independent login', () => fixture(async f => {
  assert.equal((await f.request('/api/platform/session')).status, 503);
  assert.equal((await f.request('/api/application/office', undefined, { 'x-demo-actor': 'admin', 'x-demo-user': 'admin' })).status, 503);
  assert.equal((await f.request('/api/employee/demo-config')).status, 200);
  const state = await f.gateway.repository.read(state => state); assert.equal(state.users.length, 0);
}, { privateBootstrap: false }));

test('voice demo requires platform authentication, a selected company and CSRF before provider work', () => fixture(async f => {
  assert.equal((await f.request('/api/voice-test')).status, 401);
  await f.admin();
  assert.equal((await f.request('/api/platform/switch', { organisationId: 'jeroc-demo' })).status, 200);
  const result = await f.request('/api/voice-test');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.response.headers.get('cache-control'), /no-store/);
  assert.equal((await f.request('/api/voice-test/connection-test', {}, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await f.request('/api/voice-test/connection-test', {}, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.request('/api/voice-test', undefined, { 'x-platform-generation': 'stale' })).status, 409);
  const fakeEmployee = await f.request('/api/voice-test', undefined, { cookie: '', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  assert.equal(fakeEmployee.status, 401);
}));

test('public voice demo is independent of platform login and tenant selection, without exposing office history or settings', () => fixture(async f => {
  let demo = await f.request('/api/public/voice-test', undefined, { cookie: '', 'x-client-company': 'forged-company', 'x-demo-actor': 'admin' });
  assert.equal(demo.status, 200, JSON.stringify(demo.body)); assert.deepEqual(demo.body.calls, []); assert.equal(demo.body.currentCall, null);
  assert.equal(demo.body.config.companyName, 'JEROC Återvinning AB'); assert.equal(typeof demo.body.csrfToken, 'string');
  assert.equal(demo.body.config.model, undefined); assert.equal(demo.body.config.keyPresent, undefined);
  assert.match(demo.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.request('/api/voice-test')).status, 401);
  assert.equal((await f.request('/api/ai-support')).status, 401);
  for (const path of ['/api/public/voice-test/history', '/api/public/voice-test/settings', '/api/public/voice-test/calls']) assert.ok((await f.request(path)).status >= 400, path);
  assert.equal((await f.request('/api/public/voice-test/calls', { requestId: randomUUID(), sdp: 'v=0\r\nm=audio 9 RTP/AVP 0\r\n' })).status, 403);
  await f.admin(); const company = await f.create('Voice Public Selector', '556010097');
  await f.request('/api/platform/switch', { organisationId: company.company.id });
  demo = await f.request('/api/public/voice-test'); assert.equal(demo.status, 200); assert.equal(demo.body.config.companyName, 'JEROC Återvinning AB');
  assert.equal((await f.request('/api/public/voice-test?organisationId=foreign')).status, 404);
  assert.equal((await f.request('/api/public/voice-test', undefined, { origin: 'https://foreign.invalid' })).status, 403);
}));

test('voice call history and object IDs stay inside the selected company', () => fixture(async f => {
  await f.admin();
  const a = await f.create('Voice Alpha', '556010001'), b = await f.create('Voice Beta', '556010002');
  const service = await f.gateway.bundle(a.company), repo = await service.applicationApi.getRepository();
  const callId = randomUUID(), at = '2026-10-17T10:00:00.000Z';
  await repo.transact(state => {
    state.voiceTest = { version: 1, organisationId: a.company.id, revision: 1, audit: [], calls: [{
      id: callId, requestId: randomUUID(), revision: 1, status: 'ended', createdAt: at, endedAt: at,
      site: { id: 'main', name: 'Voice Alpha' }, createdBy: { actualUserId: '__platform-admin', effectiveUserId: '__platform-admin', name: 'Systemadmin' },
      transcript: [{ id: 'turn-1', role: 'user', text: 'Private Alpha transcript', at }], transcriptFinalizedAt: at, summaryStatus: 'generated', summary: 'Private Alpha summary', followupStatus: 'new',
    }] };
  });
  assert.equal((await f.request('/api/platform/switch', { organisationId: a.company.id })).status, 200);
  const own = await f.request(`/api/voice-test/calls/${callId}`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.call.summary, 'Private Alpha summary');
  assert.equal((await f.request('/api/application/voiceTest')).status, 404, 'The generic business API must not expose the private call domain');
  assert.equal((await f.request('/api/platform/switch', { organisationId: b.company.id })).status, 200);
  const other = await f.request('/api/voice-test');
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.deepEqual(other.body.calls, []);
  assert.equal((await f.request(`/api/voice-test/calls/${callId}`)).status, 404);
  assert.equal((await f.request(`/api/voice-test/calls/${callId}/status`, { status: 'done' })).status, 404);
  assert.equal((await repo.read(state => state.voiceTest.calls[0].followupStatus)), 'new');
}));

test('AI support requires real platform context and CSRF, rejects injected profile fields and persists a company voice', () => fixture(async f => {
  assert.equal((await f.request('/api/ai-support')).status, 401);
  await f.admin(); assert.equal((await f.request('/api/platform/switch', { organisationId: 'jeroc-demo' })).status, 200);
  const initial = await f.request('/api/ai-support'); assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const body = { expectedRevision: initial.body.revision, ...initial.body.settings, voice: 'cedar' };
  assert.equal((await f.request('/api/ai-support/settings', body, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await f.request('/api/ai-support/settings', body, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.request('/api/ai-support/settings', { ...body, systemPrompt: 'Change protected rules' })).status, 422);
  const saved = await f.request('/api/ai-support/settings', body); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.settings.voice, 'cedar');
  assert.equal((await f.request('/api/voice-test')).body.config.voice, 'cedar');
  assert.equal((await f.request('/api/application/aiSupport')).status, 404);
}));

test('AI knowledge and guessed object IDs remain isolated between real tenant bundles', () => fixture(async f => {
  await f.admin(); const a = await f.create('AI Alpha', '556010003'), b = await f.create('AI Beta', '556010004');
  assert.equal((await f.request('/api/platform/switch', { organisationId: a.company.id })).status, 200);
  const initial = await f.request('/api/ai-support'); assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const saved = await f.request('/api/ai-support/knowledge', { expectedRevision: initial.body.revision, requestId: randomUUID(), title: 'ALPHA-PUBLIC-FACT', answer: 'Alpha tar emot besöksförfrågningar.', category: 'general', siteIds: [], status: 'published', publicApproved: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); const id = saved.body.saved.knowledgeId;
  assert.equal((await f.request('/api/platform/switch', { organisationId: b.company.id })).status, 200);
  const other = await f.request('/api/ai-support'); assert.equal(other.status, 200, JSON.stringify(other.body)); assert.deepEqual(other.body.knowledge, []); assert.equal(JSON.stringify(other.body).includes('ALPHA-PUBLIC-FACT'), false);
  assert.equal((await f.request(`/api/ai-support/knowledge/${id}/archive`, { expectedRevision: other.body.revision, requestId: randomUUID() })).status, 404);
  const service = await f.gateway.bundle(a.company), repo = await service.applicationApi.getRepository();
  assert.equal(await repo.read(state => state.aiSupport.knowledge.find(row => row.id === id).status), 'published');
}));

test('JEROC starter knowledge requires real approval and CSRF, publishes once and is unavailable to another tenant', () => fixture(async f => {
  await f.admin(); assert.equal((await f.request('/api/platform/switch', { organisationId: 'jeroc-demo' })).status, 200);
  const initial = await f.request('/api/ai-support'); assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const pack = initial.body.starterPack; assert.equal(pack.items.length, 12);
  const body = { requestId: randomUUID(), expectedRevision: initial.body.revision, packId: pack.id, packVersion: pack.version, itemIds: pack.items.slice(0, 2).map(item => item.id), status: 'published', publicApproved: true };
  assert.equal((await f.request('/api/ai-support/knowledge/from-starter-pack', body, { 'x-platform-csrf': '' })).status, 403);
  const denied = await f.request('/api/ai-support/knowledge/from-starter-pack', { ...body, publicApproved: false }); assert.equal(denied.status, 422);
  const saved = await f.request('/api/ai-support/knowledge/from-starter-pack', body); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.saved.knowledgeIds.length, 2);
  const replay = await f.request('/api/ai-support/knowledge/from-starter-pack', body); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.knowledge.length, 2);
  assert.equal(saved.body.runtimePreview.items.length, 2); assert.ok(saved.body.knowledge.every(item => item.source.type === 'starter_pack' && item.source.sources.every(source => new URL(source.url).hostname === 'www.jeroc.se')));
  const other = await f.create('FAQ Beta', '556010005'); assert.equal((await f.request('/api/platform/switch', { organisationId: other.company.id })).status, 200);
  const foreign = await f.request('/api/ai-support'); assert.equal(foreign.status, 200); assert.equal(foreign.body.starterPack, undefined); assert.deepEqual(foreign.body.knowledge, []);
  assert.equal((await f.request('/api/ai-support/knowledge/from-starter-pack', { ...body, requestId: randomUUID(), expectedRevision: foreign.body.revision })).status, 404);
}));

const portalDemoDefaults = [
  { kind: 'driver', id: 'portal-demo-driver-v1', username: 'demo.chauffor', password: 'ChaufforDemo2026!', subjectId: 'person-oskar' },
  { kind: 'carrier', id: 'portal-demo-carrier-v1', username: 'demo.akeri', password: 'AkeriDemo2026!', subjectId: 'carrier-roslagen' },
  { kind: 'customer', id: 'portal-demo-customer-v1', username: 'demo.kund', password: 'KundDemo2026!', subjectId: 'customer-build' },
];

test('public portal demo configs advertise only working original JEROC fixtures and GET leaves all persisted state unchanged', () => fixture(async f => {
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const service = await f.gateway.bundle(company), repository = await service.applicationApi.getRepository();
  const before = await repository.read(state => structuredClone(state));
  const platformBefore = await f.gateway.repository.read(state => structuredClone(state));
  assert.equal(f.cookies.size, 0);
  for (const { kind, id, username, password } of portalDemoDefaults) {
    const config = await f.request(`/api/${kind}/demo-config`);
    assert.equal(config.status, 200, JSON.stringify(config.body));
    assert.match(config.response.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Object.keys(config.body).sort(), ['accounts', 'companyId', 'companyName', 'enabled']);
    assert.equal(config.body.companyId, 'jeroc-demo'); assert.equal(config.body.companyName, company.name);
    assert.equal(config.body.enabled, true); assert.equal(config.body.accounts.length, 1);
    const account = config.body.accounts[0];
    assert.deepEqual(Object.keys(account).sort(), ['id', 'label', 'password', 'username']);
    assert.equal(account.id, id);
    assert.ok(typeof account.label === 'string' && account.label.length > 0);
    assert.equal(account.username, username); assert.equal(account.password, password);
  }
  assert.equal(f.cookies.size, 0, 'Public configuration does not create a session');
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  assert.deepEqual(await f.gateway.repository.read(state => structuredClone(state)), platformBefore);
  for (const { kind, id, username, password, subjectId } of portalDemoDefaults) {
    const result = await f.request(`/api/${kind}/login`, { username, password });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(f.cookies.has('jeroc_platform'), false);
    const session = await f.request(`/api/${kind}/session`);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    if (kind === 'driver') {
      const account = before.personnelAuth.accounts.find(account => account.username === username);
      const person = before.personnel.people.find(person => person.id === account.personId);
      assert.equal(account.id, id); assert.equal(person.id, subjectId);
      assert.equal(result.body.person.id, subjectId); assert.equal(result.body.person.driverId, 'oskar');
      assert.equal(result.body.person.companyId, 'carrier-roslagen');
    } else {
      const account = before.logisticsAuth.accounts.find(account => account.kind === kind && account.username === username);
      assert.equal(account.id, id); assert.equal(account.subjectId, subjectId);
      assert.equal((kind === 'customer' ? result.body.customer : result.body.company).id, subjectId);
    }
  }
}));

test('office account edits preserve portal fixture provenance and existing sessions reject repurposed subjects', () => fixture(async f => {
  await f.admin();
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const service = await f.gateway.bundle(company), repository = await service.applicationApi.getRepository();
  const accountFor = (state, kind, id) => (kind === 'driver' ? state.personnelAuth : state.logisticsAuth).accounts.find(account => account.id === id);
  const sessionsFor = (state, kind) => (kind === 'driver' ? state.personnelAuth : state.logisticsAuth).sessions;
  for (const { kind, id, username, password, subjectId } of portalDemoDefaults) {
    const before = await repository.read(state => structuredClone(accountFor(state, kind, id)));
    assert.equal(before.demoFixture, 'portal-demo-v1');
    const saved = kind === 'driver'
      ? await f.request('/api/application/personnel', { action: 'externalAccount.save', personId: subjectId, username, active: true, siteIds: ['norrtalje'] })
      : await f.request('/api/logistics/office', { action: 'account.save', account: { id, kind, subjectId, username, active: true } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const after = await repository.read(state => structuredClone(accountFor(state, kind, id)));
    assert.ok(after); assert.equal(after.id, before.id); assert.equal(after.demoFixture, before.demoFixture);
    assert.deepEqual(after.password, before.password, 'Editing an account without a password preserves its stored hash');
    const login = await f.request(`/api/${kind}/login`, { username, password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const session = await f.request(`/api/${kind}/session`);
    assert.equal(session.status, 200, JSON.stringify(session.body));
    const sessions = await repository.read(state => structuredClone(sessionsFor(state, kind)));
    await repository.transact(state => {
      const subject = kind === 'driver' ? state.personnel.people.find(person => person.id === subjectId)
        : kind === 'carrier' ? state.personnel.companies.find(company => company.id === subjectId)
          : state.office.customers.find(customer => customer.id === subjectId);
      subject.name = `Repurposed ${kind}`;
    });
    const rejected = await f.request(`/api/${kind}/session`);
    assert.equal(rejected.status, 401, JSON.stringify(rejected.body));
    assert.deepEqual(await repository.read(state => structuredClone(sessionsFor(state, kind))), sessions,
      'The session remains stored: rejection comes from rechecking the fixture identity');
    const config = await f.request(`/api/${kind}/demo-config`);
    assert.equal(config.status, 200); assert.equal(config.body.enabled, false); assert.deepEqual(config.body.accounts, []);
  }
}));

test('disabling public portal demos hides persisted fixtures and rejects their existing passwords without rotating accounts', () => fixture(async f => {
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const service = await f.gateway.bundle(company), repository = await service.applicationApi.getRepository();
  const before = await repository.read(state => structuredClone(state));
  for (const { kind, username } of portalDemoDefaults) {
    const accounts = kind === 'driver' ? before.personnelAuth.accounts : before.logisticsAuth.accounts;
    assert.ok(accounts.some(account => account.username === username), 'A marked fixture from the enabled startup must survive disabling demos');
    const config = await f.request(`/api/${kind}/demo-config`);
    assert.equal(config.status, 200, JSON.stringify(config.body)); assert.equal(config.body.companyId, 'jeroc-demo');
    assert.equal(config.body.enabled, false); assert.deepEqual(config.body.accounts, []);
    assert.match(config.response.headers.get('cache-control'), /no-store/);
  }
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  for (const { kind, username, password } of portalDemoDefaults) {
    const result = await f.request(`/api/${kind}/login`, { username, password });
    assert.equal(result.status, 401, JSON.stringify(result.body));
  }
  const after = await repository.read(state => structuredClone(state));
  assert.deepEqual(after.personnelAuth.accounts, before.personnelAuth.accounts);
  assert.deepEqual(after.logisticsAuth.accounts, before.logisticsAuth.accounts);
  assert.deepEqual(after.personnelAuth.sessions, before.personnelAuth.sessions);
  assert.deepEqual(after.logisticsAuth.sessions, before.logisticsAuth.sessions);
}, { demoAutoSession: false, primePortalDemo: true }));

test('JEROC platform administrator opens the NVV sandbox through its own unscoped identity while impersonated users remain restricted', () => fixture(async f => {
  const sandboxPath = '/api/environment/nvv/sandbox';
  assert.equal((await f.request(sandboxPath)).status, 401);
  const anonymous = await f.request('/api/platform/session', undefined, {
    'x-platform-self-business-user-ids': '__platform-admin,admin', 'x-platform-credential-business-id': 'admin',
  });
  assert.equal(anonymous.body.authenticated, false);
  assert.equal(Object.hasOwn(anonymous.body, 'selfBusinessUserIds'), false);
  const login = await f.admin();
  assert.equal(login.organisationId, 'jeroc-demo');
  assert.equal(login.actualUser.id, '__platform-admin');
  assert.equal(login.user.id, '__platform-admin');
  assert.deepEqual(login.selfBusinessUserIds, ['__platform-admin', 'admin']);
  assert.equal(Array.isArray(login.actualUser.siteIds), false);
  assert.equal(Array.isArray(login.user.siteIds), false);

  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const service = await f.gateway.bundle(company), repository = await service.applicationApi.getRepository();
  const users = await repository.read(state => structuredClone(state.pricing.users));
  const legacyAdmin = users.find(user => user.id === 'admin'), support = users.find(user => user.id === '__platform-admin');
  assert.ok(Array.isArray(legacyAdmin.siteIds) && legacyAdmin.siteIds.length > 0, 'Startup personnel synchronization keeps the legacy account scoped');
  assert.equal(support.level, 'Systemadmin'); assert.equal(Array.isArray(support.siteIds), false);
  assert.equal(support.maxAttest, legacyAdmin.maxAttest); assert.equal(support.ownAttest, legacyAdmin.ownAttest);
  assert.equal(Object.hasOwn(support, 'password'), false);
  assert.deepEqual(await repository.read(state => ({
    people: state.personnel.people.filter(person => person.userId === support.id),
    accounts: state.personnelAuth.accounts.filter(account => account.username === support.id || account.personId === support.id),
  })), { people: [], accounts: [] });
  const first = await f.request(sandboxPath);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.mode, 'disabled'); assert.equal(first.body.ready, false);
  assert.deepEqual(first.body.runs, []);

  const forged = await f.request(sandboxPath, undefined, { 'x-environment-actual-user': 'admin' });
  assert.equal(forged.status, 409); assert.equal(forged.body.code, 'platform_context_changed');
  const session = await f.request('/api/platform/session', undefined, {
    'x-platform-self-business-user-ids': '__platform-admin,admin,kajsa', 'x-platform-credential-business-id': 'kajsa',
  });
  assert.deepEqual(session.body.selfBusinessUserIds, ['__platform-admin', 'admin']);

  const scopedAdmin = { ...legacyAdmin, id: 'scoped-systemadmin', name: 'Scoped Systemadmin', siteIds: [legacyAdmin.siteIds[0]] };
  await repository.transact(state => {
    state.pricing.users.push(structuredClone(scopedAdmin)); state.office.users.push(structuredClone(scopedAdmin));
  });
  const scoped = await f.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: scopedAdmin.id });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.actualUser.id, '__platform-admin'); assert.equal(scoped.body.user.id, scopedAdmin.id);
  assert.deepEqual(scoped.body.selfBusinessUserIds, ['__platform-admin', 'admin']);
  assert.deepEqual(scoped.body.user.siteIds, scopedAdmin.siteIds);
  assert.equal((await f.request(sandboxPath)).status, 403);

  const legacy = await f.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: 'admin' });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(legacy.body.actualUser.id, '__platform-admin'); assert.equal(legacy.body.user.id, 'admin');
  assert.deepEqual(legacy.body.selfBusinessUserIds, ['__platform-admin', 'admin']);
  assert.deepEqual(legacy.body.user.siteIds, legacyAdmin.siteIds);
  assert.equal((await f.request(sandboxPath)).status, 403);

  const director = users.find(user => user.level === 'VD' && user.active !== false);
  assert.ok(director);
  const impersonated = await f.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: director.id });
  assert.equal(impersonated.status, 200, JSON.stringify(impersonated.body));
  assert.equal(impersonated.body.actualUser.id, '__platform-admin'); assert.equal(impersonated.body.user.id, director.id);
  assert.deepEqual(impersonated.body.selfBusinessUserIds, ['__platform-admin', 'admin']);
  assert.equal((await f.request(sandboxPath)).status, 403);

  const own = await f.request('/api/platform/switch', { organisationId: 'jeroc-demo' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.actualUser.id, '__platform-admin'); assert.equal(own.body.user.id, '__platform-admin');
  assert.deepEqual(own.body.selfBusinessUserIds, ['__platform-admin', 'admin']);
  assert.equal((await f.request(sandboxPath)).status, 200);
  assert.deepEqual(await repository.read(state => state.pricing.users.find(user => user.id === 'admin').siteIds), legacyAdmin.siteIds);
}));

test('gateway dispatch preserves the trusted legacy self-attest prohibition for a customer-approved terminal original', () => fixture(async f => {
  await f.admin();
  const company = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === 'jeroc-demo')));
  const service = await f.gateway.bundle(company), repository = await service.applicationApi.getRepository();
  const cardId = 9984, deliveredAt = '2026-10-09T09:00:00Z';
  const { siteId, snapshot } = await repository.transact(state => {
    for (const users of [state.pricing.users, state.office.users]) {
      const root = users.find(user => user.id === '__platform-admin'); root.ownAttest = false; root.maxAttest = 1000000;
    }
    const pricing = createPricingStore({ initialState: state.pricing });
    const snapshot = pricing.snapshot({ cardId, customerId: 'customer-build', deliveredAt,
      rows: [{ articleId: 'copper-1', weight: 10 }] }, pricing.principal('admin'));
    const siteId = pricing.principal('admin').user.siteIds[0];
    state.pricing = pricing.exportState();
    return { siteId, snapshot };
  });
  const terminalRepository = await createTerminalDemoRepository({ env: f.env });
  try {
    // Create a historical original through the actual terminal workflow. Only
    // the attempted attest uses HTTP, so it must acquire the alias in dispatch.
    const terminalStore = createTerminalDemoStore({ repository: terminalRepository,
      principalStore: service.applicationApi.principalStore, siteProvider: () => service.environmentApi.getSites() });
    const staff = (await terminalStore.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
    const terminal = await terminalStore.createTerminal({ name: 'Legacy approval terminal', username: 'legacyapproval', password: 'demolosen123', siteId }, staff);
    const device = await terminalStore.login({ username: terminal.username, password: 'demolosen123' });
    const customer = { id: 'customer-build', name: 'Bygg & Riv AB', type: 'Företag', number: '5591237895',
      customerNumber: 'K-1001', phone: '0701234567', email: 'kund@example.invalid', address: 'Storgatan 12',
      paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Bygg & Riv AB' } };
    const approval = await terminalStore.send({ card: { id: cardId, customerId: customer.id, status: 'complement', siteId, yard: 'Norrtälje', date: deliveredAt,
      reference: 'Legacy self-attest', origin: 'Ängsvägen 19', pricingSnapshotId: snapshot.id, idVerified: false, weigher: 'Niklas', payment: 'Bankkonto', audit: [],
      rows: snapshot.rows.map(row => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: row.tier === 'Special' ? 'Eget' : row.tier })) },
      customer, terminalId: terminal.id, siteId, offset: 0, correctionIds: [], idempotencyKey: randomUUID(),
      rows: snapshot.rows.map(row => ({ articleId: row.articleId, name: 'Koppar klass 1', weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })) }, staff);
    await terminalStore.respond(approval.id, { action: 'id_requested', termsAccepted: true }, device.token);
    await terminalStore.confirmId(approval.id, staff);
    const before = (await service.terminalDemoApi.documentProjections({ approvalId: approval.id }))[0];
    assert.equal(before.status, 'approved'); assert.equal(before.actualUserId, 'admin'); assert.equal(before.effectiveUserId, 'admin');
    for (const headers of [{}, { 'x-platform-credential-business-id': 'unrelated-user', 'x-platform-self-business-user-ids': '__platform-admin' }]) {
      const result = await f.request(`/api/terminal-demo/approvals/${approval.id}/attest`, {}, headers);
      assert.equal(result.status, 403, JSON.stringify(result.body)); assert.equal(result.body.code, 'own_attest_forbidden');
      assert.deepEqual((await service.terminalDemoApi.documentProjections({ approvalId: approval.id }))[0], before);
    }
  } finally { await terminalRepository.close(); }
}));

test('real platform bridge isolates same customer, file and actor IDs; no header-only access or stale writes', async () => fixture(async f => {
  assert.equal((await f.request('/api/application/office', undefined, { 'x-demo-actor': 'admin' })).status, 401);
  await f.admin(); const a = await f.create('Bolag A', '556100100'), b = await f.create('Bolag B', '556100101');
  const companies = await f.gateway.repository.read(state => structuredClone(state.companies));
  const mediaId = randomUUID();
  for (const created of [a, b]) {
    const company = companies.find(value => value.id === created.company.id), service = await f.gateway.bundle(company);
    await (await service.applicationApi.getRepository()).transact(state => {
      assert.equal(state.office.cards.length, 0); assert.equal(state.office.customers.length, 0); assert.equal(state.transport.orders.length, 0);
      const support = state.pricing.users.find(user => user.id === '__platform-admin');
      assert.equal(support.maxAttest, 0); assert.equal(support.ownAttest, true); assert.equal(Array.isArray(support.siteIds), false);
      const customer = { id: 'same-customer', name: company.name, type: 'Företag', number: company.organisationNumber, customerNumber: 'same', phone: '', email: '', address: '', references: [], origins: [], audit: [] };
      state.office.customers.push(customer); state.pricing.customers.push(structuredClone(customer));
    });
    const bytes = Buffer.from(`company-file:${company.id}`), digest = createHash('sha256').update(bytes).digest('hex');
    await (await service.articleMediaApi.ready()).insert({ id: mediaId, contentHash: digest, fullHash: digest, thumbnailHash: digest, createdAt: new Date().toISOString(), createdBy: company.ownerUserId }, bytes, bytes);
  }
  const sw = await f.request('/api/platform/switch', { organisationId: a.company.id });
  assert.equal(sw.status, 200); assert.equal(sw.body.actualUser.id, '__platform-admin'); assert.equal(sw.body.user.id, '__platform-admin');
  assert.equal(Object.hasOwn(sw.body, 'selfBusinessUserIds'), false);
  const forgedAlias = await f.request('/api/platform/session', undefined, {
    'x-platform-self-business-user-ids': '__platform-admin,admin', 'x-platform-credential-business-id': 'admin',
  });
  assert.equal(forgedAlias.status, 200);
  assert.equal(Object.hasOwn(forgedAlias.body, 'selfBusinessUserIds'), false);
  const oldGeneration = f.session.generation;
  const officeA = await f.request('/api/application/office'); assert.equal(officeA.status, 200, JSON.stringify(officeA.body));
  assert.deepEqual(officeA.body.data.customers.map(value => value.name), ['Bolag A']);
  assert.equal((await f.request('/api/application/office', undefined, { 'x-demo-user': b.user.id })).status, 409);
  let image = await f.request(`/api/article-media/${mediaId}`); assert.equal(image.status, 200); assert.equal(image.body.toString(), `company-file:${a.company.id}`); assert.equal(image.response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await f.request('/api/environment/session')).status, 200);
  assert.equal((await f.request('/api/terminal-demo/staff-session', { actualUserId: '__platform-admin', effectiveUserId: '__platform-admin' })).status, 200);
  assert.equal((await f.request('/api/terminal-demo/state')).status, 200);
  assert.equal((await f.request('/api/platform/switch', { organisationId: b.company.id })).status, 200);
  assert.equal((await f.request('/api/application/office', undefined, { 'x-platform-generation': oldGeneration })).status, 409);
  assert.equal((await f.request('/api/employee/session', undefined, { 'x-employee-company': a.company.id })).status, 409);
  const officeB = await f.request('/api/application/office'); assert.deepEqual(officeB.body.data.customers.map(value => value.name), ['Bolag B']);
  image = await f.request(`/api/article-media/${mediaId}`); assert.equal(image.body.toString(), `company-file:${b.company.id}`);
  const login = await f.request('/api/platform/login', { username: a.temporaryCredentials.username, password: a.temporaryCredentials.password });
  assert.equal(login.status, 200); assert.equal(login.body.mustChangePassword, true);
  assert.equal(Object.hasOwn(login.body, 'selfBusinessUserIds'), false);
  const blocked = await f.request('/api/application/office'); assert.equal(blocked.status, 423); assert.equal(blocked.body.code, 'platform_password_change_required');
  assert.equal((await f.request('/api/platform/change-password', { currentPassword: a.temporaryCredentials.password, newPassword: 'Private-New-Tenant-Owner-2026!' })).status, 200);
  assert.equal((await f.request('/api/platform/switch', { organisationId: b.company.id })).status, 403);
  const ownerOffice = await f.request('/api/application/office'); assert.equal(ownerOffice.status, 200); assert.deepEqual(ownerOffice.body.data.customers.map(value => value.name), ['Bolag A']);
  assert.equal((await f.request('/api/employee/login', { username: a.temporaryCredentials.username, password: 'Private-New-Tenant-Owner-2026!' })).status, 200);
  const audit = await f.gateway.repository.read(state => state.audit);
  assert.ok(audit.some(value => value.action === 'platform.support_context_changed' && value.organisationId === a.company.id));
}, { postgres: Boolean(process.env.JEROC_TEST_DATABASE_URL) }));

test('public company link selects a login scope but never grants office, staff, document or image rights', () => fixture(async f => {
  await f.admin(); const company = await f.create('Public Bolag', '556100102');
  const selected = await f.request(`/mobil?company=${company.company.id}`); assert.equal(selected.status, 303);
  const context = await f.request('/api/platform/tenant-context'); assert.equal(context.body.companyId, company.company.id);
  const config = await f.request('/api/employee/demo-config'); assert.equal(config.body.companyId, company.company.id); assert.equal(config.body.enabled, false);
  const tenant = await f.gateway.repository.read(state => structuredClone(state.companies.find(value => value.id === company.company.id)));
  const service = await f.gateway.bundle(tenant), repository = await service.applicationApi.getRepository();
  const before = await repository.read(state => structuredClone(state));
  for (const { kind } of portalDemoDefaults) {
    const portal = await f.request(`/api/${kind}/demo-config`);
    assert.equal(portal.status, 200, JSON.stringify(portal.body)); assert.equal(portal.body.companyId, company.company.id);
    assert.equal(portal.body.companyName, company.company.name); assert.equal(portal.body.enabled, false);
    assert.deepEqual(portal.body.accounts, []); assert.match(portal.response.headers.get('cache-control'), /no-store/);
  }
  assert.deepEqual(await repository.read(state => structuredClone(state)), before);
  for (const { kind, username, password } of portalDemoDefaults) {
    assert.equal((await f.request(`/api/${kind}/login`, { username, password })).status, 401);
  }
  for (const path of ['/api/application/office', '/api/environment/session', '/api/terminal-demo/state', '/api/documents/same', `/api/article-media/${randomUUID()}`])
    assert.equal((await f.request(path)).status, 401, path);
  assert.equal((await f.request('/api/carrier/session', undefined, { 'x-client-company': 'jeroc-demo' })).status, 409);
}));
