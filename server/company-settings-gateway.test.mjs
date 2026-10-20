import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createTenantGateway } from './tenant-gateway.mjs';

const initialPassword = 'Company-Settings-Private-Fixture-2026!';
const changedPassword = 'Company-Settings-Changed-Fixture-2026!';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'company-settings-gateway-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: initialPassword };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let gateway, server;
  const failures = [];
  try {
    gateway = await createTenantGateway({ env });
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      void (async () => {
        if (await gateway.selectPage(req, res, url) || await gateway(req, res, url)) return;
        res.writeHead(404); res.end();
      })().catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function client() {
      const cookies = new Map(); let session;
      async function request(path, body, headers = {}) {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
            ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': String(session.generation) }),
            ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) {
          const [key, value] = entry.split(';')[0].split('=');
          if (value) cookies.set(key, value); else cookies.delete(key);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const value = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : bytes;
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers };
      }
      async function admin() {
        assert.equal((await request('/api/platform/login', { username: 'admin', password: initialPassword })).status, 200);
        assert.equal((await request('/api/platform/change-password', { currentPassword: initialPassword, newPassword: changedPassword })).status, 200);
      }
      return { request, admin };
    }
    await run({ gateway, client });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close();
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  }
}
const draft = settings => ({ expectedVersion: settings.version, profile: settings.profile, documents: settings.documents,
  defaults: settings.defaults, notifications: settings.notifications });

test('company settings enforce real sessions, CSRF, strict identity, CAS and current effective permissions', () => fixture(async f => {
  const admin = f.client();
  assert.equal((await admin.request('/api/company-settings')).status, 401);
  await admin.admin();
  const loaded = await admin.request('/api/company-settings');
  assert.equal(loaded.status, 200); assert.equal(loaded.body.companyId, 'jeroc-demo');
  assert.equal(loaded.body.organisationNumber, '5593593626'); assert.equal(loaded.body.capabilities.canManage, true);
  const input = draft(loaded.body); input.profile.name = 'Uppdaterat profilnamn'; input.defaults.paymentTermsDays = 45;
  input.notifications.customerInquiries = ['internal@example.test'];
  assert.equal((await admin.request('/api/company-settings', input, { 'x-platform-csrf': '' })).status, 403);
  assert.equal((await admin.request('/api/company-settings', input, { origin: 'https://foreign.example.test' })).status, 403);
  assert.equal((await admin.request('/api/company-settings', { ...input, organisationNumber: '5560000167' })).status, 422);
  assert.equal((await admin.request('/api/company-settings', input, { 'x-client-company': 'other-company' })).status, 409);
  const saved = await admin.request('/api/company-settings', input);
  assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.version, 1);
  assert.equal((await admin.request('/api/company-settings', input)).status, 409);
  const legal = await f.gateway.auth.getCompany('jeroc-demo');
  assert.equal(legal.organisationNumber, '5593593626'); assert.equal(legal.name, 'JEROC Återvinning AB');
  const basic = await admin.request('/api/company-settings/defaults');
  assert.equal(basic.body.profile.name, input.profile.name); assert.equal(basic.body.defaults.paymentTermsDays, 45);
  assert.ok(!JSON.stringify(basic.body).includes('internal@example.test'));
  assert.match(basic.headers.get('cache-control'), /no-store/);
  const repository = await (await f.gateway.bundle(legal)).applicationApi.getRepository();
  await repository.transact(state => {
    const user = { id: 'settings-reader', name: 'Begränsad läsare', level: 'Medarbetare', active: true,
      permissions: ['view', 'companySettingsRead'], maxAttest: 0, ownAttest: false };
    state.pricing.users.push(structuredClone(user)); state.office.users.push(structuredClone(user));
  });
  assert.equal((await admin.request('/api/platform/switch', { organisationId: 'jeroc-demo', effectiveUserId: 'settings-reader' })).status, 200);
  const readonly = await admin.request('/api/company-settings');
  assert.equal(readonly.status, 200); assert.equal(readonly.body.capabilities.canManage, false);
  assert.equal((await admin.request('/api/company-settings', { ...input, expectedVersion: 1 })).status, 403);
  await repository.transact(state => {
    const user = state.pricing.users.find(value => value.id === 'settings-reader');
    user.permissions.push('companySettingsWrite'); user.siteIds = ['norrtalje'];
  });
  const siteLimited = await admin.request('/api/company-settings');
  assert.equal(siteLimited.status, 200); assert.equal(siteLimited.body.capabilities.canManage, false);
  assert.equal((await admin.request('/api/company-settings', { ...input, expectedVersion: 1 })).status, 403);
}));

test('company logo IDs and settings stay in their tenant; mobile sees only the minimal defaults', () => fixture(async f => {
  const admin = f.client(); await admin.admin();
  const png = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#17334f' } }).png().toBuffer();
  const uploaded = await admin.request('/api/company-settings/logo', { contentType: 'image/png', base64: png.toString('base64') });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const profileA = (await admin.request('/api/company-settings')).body;
  const inputA = draft(profileA); inputA.documents.logoId = uploaded.body.logoId; inputA.profile.name = 'Endast bolag A';
  inputA.notifications.bookings = ['private-a@example.test'];
  assert.equal((await admin.request('/api/company-settings', inputA)).status, 200);
  const image = await admin.request(uploaded.body.url);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.isBuffer(image.body));
  const created = await admin.request('/api/platform/companies', { requestId: crypto.randomUUID(), name: 'Separat bolag B',
    organisationNumber: '5560160680', vdName: 'VD Exempel', vdEmail: 'company-b@example.test' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await admin.request('/api/platform/switch', { organisationId: created.body.company.id })).status, 200);
  const profileB = (await admin.request('/api/company-settings')).body;
  assert.equal(profileB.profile.name, 'Separat bolag B'); assert.equal(profileB.version, 0);
  assert.ok(!JSON.stringify(profileB).includes('private-a@example.test'));
  assert.equal((await admin.request(uploaded.body.url)).status, 404);
  const inputB = draft(profileB); inputB.documents.logoId = uploaded.body.logoId;
  assert.equal((await admin.request('/api/company-settings', inputB)).status, 422);

  const mobile = f.client(); await mobile.request('/mobil?company=jeroc-demo');
  assert.equal((await mobile.request('/api/employee/login', { username: 'niklas', password: 'Demo123!' })).status, 200);
  const basic = await mobile.request('/api/company-settings/defaults', undefined,
    { 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'person-mobile-demo' });
  assert.equal(basic.status, 200); assert.equal(basic.body.profile.name, 'Endast bolag A');
  assert.ok(!JSON.stringify(basic.body).includes('private-a@example.test'));
  assert.equal((await mobile.request('/api/company-settings')).status, 401);
  assert.equal((await mobile.request('/api/company-settings/defaults', undefined, { 'x-employee-company': created.body.company.id })).status, 409);
}));
