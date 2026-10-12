import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';

function number(prefix) {
  const sum = [...prefix].reduce((total, value, index) => { let digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit); }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}
async function fixture(run, { privateBootstrap = true, postgres = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-gateway-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite'), JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
    JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'), JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
    JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'), JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite'), JEROC_TENANT_DATA_DIR: directory,
    ...(privateBootstrap && { SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: 'Private-Gateway-Fixture-2026!' }) };
  let pool, schema;
  if (postgres) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `gateway_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = url.toString();
  }
  let gateway, server;
  try {
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

test('real platform bridge isolates same customer, file and actor IDs; no header-only access or stale writes', async () => fixture(async f => {
  assert.equal((await f.request('/api/application/office', undefined, { 'x-demo-actor': 'admin' })).status, 401);
  await f.admin(); const a = await f.create('Bolag A', '556100100'), b = await f.create('Bolag B', '556100101');
  const companies = await f.gateway.repository.read(state => structuredClone(state.companies));
  const mediaId = randomUUID();
  for (const created of [a, b]) {
    const company = companies.find(value => value.id === created.company.id), service = await f.gateway.bundle(company);
    await (await service.applicationApi.getRepository()).transact(state => {
      assert.equal(state.office.cards.length, 0); assert.equal(state.office.customers.length, 0); assert.equal(state.transport.orders.length, 0);
      const customer = { id: 'same-customer', name: company.name, type: 'Företag', number: company.organisationNumber, customerNumber: 'same', phone: '', email: '', address: '', references: [], origins: [], audit: [] };
      state.office.customers.push(customer); state.pricing.customers.push(structuredClone(customer));
    });
    const bytes = Buffer.from(`company-file:${company.id}`), digest = createHash('sha256').update(bytes).digest('hex');
    await (await service.articleMediaApi.ready()).insert({ id: mediaId, contentHash: digest, fullHash: digest, thumbnailHash: digest, createdAt: new Date().toISOString(), createdBy: company.ownerUserId }, bytes, bytes);
  }
  const sw = await f.request('/api/platform/switch', { organisationId: a.company.id });
  assert.equal(sw.status, 200); assert.equal(sw.body.actualUser.id, '__platform-admin'); assert.equal(sw.body.user.id, '__platform-admin');
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
  for (const path of ['/api/application/office', '/api/environment/session', '/api/terminal-demo/state', '/api/documents/same', `/api/article-media/${randomUUID()}`])
    assert.equal((await f.request(path)).status, 401, path);
  assert.equal((await f.request('/api/carrier/session', undefined, { 'x-client-company': 'jeroc-demo' })).status, 409);
}));
