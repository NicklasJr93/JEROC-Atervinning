import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTenantGateway } from './tenant-gateway.mjs';
import { createRoaringPersonRegister } from './roaring-person-register.mjs';
import { platformUsageMonth } from './platform-usage.mjs';

const PATH = '/api/person-register/lookup';
const STAFF = '/api/employee/customer-intake';
const PUBLIC = '/api/public/customer-intake';
const INITIAL = 'Person-Lookup-Initial-2026!';
const ADMIN = 'Person-Lookup-Activated-2026!';
const OWNER = 'Person-Lookup-Owner-2026!';
const draftId = '31681dc1-d668-46fe-b3b7-577b967cfc7f';
function checksum(prefix) {
  const sum = [...prefix].reduce((total, value, index) => {
    const digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit);
  }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}
const personalNumber = index => `19${checksum(`900101${String(index).padStart(3, '0')}`)}`;
const personName = number => `Syntetisk Person ${number.slice(-4)}`;
const currentRecord = number => ({ status: { code: 0 }, records: [{ personId: number,
  name: [{ firstName: 'Syntetisk', surName: `Person ${number.slice(-4)}`, dateTo: '9999-12-31' }],
  populationRegistrationAddress: [{ dateTo: '9999-12-31', swedishAddress: {
    deliveryAddress2: 'Syntetiska vägen 7', zipCode: '76141', city: 'Norrtälje',
  } }],
}] });
const jsonResponse = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Real HTTP, tenant authentication, intake capabilities and durable usage SQL.
 * Only the fixed-origin Roaring HTTP transport and SMS delivery are replaced. */
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'person-register-http-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL,
    APP_URL: 'https://app.scrapplanner.com', MOBILE_URL: 'https://mobile.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  const gets = [], sends = [], failures = []; let oauthCalls = 0, hold;
  const personRegister = createRoaringPersonRegister({ env: { ROARING_CONSUMER_KEY: 'fixture-key', ROARING_CONSUMER_SECRET: 'fixture-secret' },
    fetchImpl: async (input, options) => {
      if (input === 'https://api.roaring.io/token') {
        oauthCalls++; assert.equal(options.method, 'POST');
        return jsonResponse({ access_token: 'fixture-roaring-token', token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(options.method, 'GET'); assert.match(input, /^https:\/\/api\.roaring\.io\/person\/2\.0\/current\/\d{12}$/);
      const number = new URL(input).pathname.split('/').at(-1); gets.push(number);
      const pending = hold; hold = undefined;
      if (pending) { pending.started(); await pending.ready; }
      return jsonResponse(currentRecord(number));
    } });
  const systemSms = { configured: true, sendTest: async () => { throw new Error('Unrelated SMS is outside this fixture.'); },
    sendCustomerIntake: async input => { sends.push(structuredClone(input)); return { providerId: randomUUID() }; } };
  let gateway, server;
  try {
    gateway = await createTenantGateway({ env, personRegister, systemSms });
    server = createServer((req, res) => {
      void gateway(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } })
        .catch(error => { failures.push(error); if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function client() {
      const cookies = new Map(); let session;
      async function request(path, body, headers = {}) {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: Object.fromEntries(Object.entries({ cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(session?.authenticated && { 'x-platform-csrf': session.csrfToken, 'x-platform-generation': session.generation }),
            ...(body !== undefined && { 'content-type': 'application/json' }), ...headers }).filter(([, value]) => value !== undefined)),
          ...(body !== undefined && { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) { const [name, value] = entry.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name); }
        const text = await response.text(), value = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : text;
        if (value?.authenticated) session = value;
        return { status: response.status, body: value, text, headers: response.headers };
      }
      return { request, get session() { return session; } };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    assert.equal((await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN })).status, 200);
    async function company(label, prefix) {
      const email = `${label.toLowerCase()}@example.test`;
      const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: `${label} Personuppslag AB`,
        organisationNumber: checksum(prefix), vdName: `${label} Ägare`, vdEmail: email });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const owner = client(), value = created.body;
      assert.equal((await owner.request('/api/platform/login', { username: email, password: value.temporaryCredentials.password })).status, 200);
      assert.equal((await owner.request('/api/platform/change-password', { currentPassword: value.temporaryCredentials.password, newPassword: OWNER })).status, 200);
      const mobile = client(), login = await mobile.request('/api/employee/login?view=bootstrap', { username: email, password: OWNER });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const repository = await (await gateway.bundle(await gateway.auth.getCompany(value.company.id))).applicationApi.getRepository();
      const date = new Date().toISOString();
      const draft = await mobile.request('/api/application/mobile', { kind: 'records', version: 1, customers: [], drafts: [{ id: draftId,
        next: { id: draftId, number: 1, siteId: 'main', mode: 'direct', status: 'draft', createdAt: date, updatedAt: date, rows: [], reference: '', origin: '' } }] });
      assert.equal(draft.status, 200, JSON.stringify(draft.body));
      return { ...value, owner, mobile, repository, personId: login.body.person.id };
    }
    const alpha = await company('Alpha', '556080001'), beta = await company('Beta', '556080002');
    async function issue(target, channel, terminalId) {
      const result = await target.mobile.request(STAFF, { draftId, requestId: randomUUID(), expectedCustomerId: null,
        channel, ...(channel === 'sms' ? { phone: '+46701234567' } : { terminalId }) });
      assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.intake;
    }
    async function entrypoints() {
      const sms = await issue(alpha, 'sms');
      const token = /^#token=([A-Za-z0-9_-]{43})$/.exec(new URL(sends.at(-1).intakeUrl).hash)?.[1]; assert.ok(token);
      assert.equal((await admin.request('/api/platform/switch', { organisationId: beta.company.id })).status, 200);
      const created = await admin.request('/api/terminal-demo/terminals', { name: 'Personterminal', siteId: 'main', username: 'person.terminal', password: 'Person-Terminal-2026!' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const device = client(); assert.equal((await device.request('/api/platform/select-tenant', { organisationId: beta.company.id })).status, 200);
      assert.equal((await device.request('/api/terminal-demo/login', { username: 'person.terminal', password: 'Person-Terminal-2026!' })).status, 200);
      const terminal = await issue(beta, 'terminal', created.body.id);
      return [
        { label: 'office-full-customer', company: alpha.company.id, client: alpha.owner, path: PATH },
        { label: 'office-quick-customer', company: beta.company.id, client: beta.owner, path: PATH },
        { label: 'mobile-customer', company: alpha.company.id, client: alpha.mobile, path: PATH,
          headers: { 'x-employee-company': alpha.company.id, 'x-employee-person': alpha.personId } },
        // Deliberately conflicting ambient tenant cookies must not redirect a
        // single-purpose anonymous capability or its bill to the wrong company.
        { label: 'sms-intake', company: alpha.company.id, client: beta.mobile, path: `${PUBLIC}/person-lookup`,
          headers: { authorization: `Bearer ${token}`, 'x-employee-company': beta.company.id }, intake: sms },
        { label: 'terminal-intake', company: beta.company.id, client: device, path: '/api/terminal-demo/customer-intake/person-lookup',
          extra: { id: terminal.id }, intake: terminal },
      ];
    }
    function records() {
      const database = new DatabaseSync(env.JEROC_PLATFORM_DB_PATH, { readOnly: true });
      try { return database.prepare("SELECT document FROM jeroc_platform_usage WHERE service='roaring.person.lookup' ORDER BY operation_id").all().map(row => JSON.parse(row.document)); }
      finally { database.close(); }
    }
    const month = platformUsageMonth(new Date());
    const usagePath = `/api/platform/usage?month=${month}`, csvPath = `/api/platform/usage/export?month=${month}`;
    const lookup = (entry, number, requestId = randomUUID()) => entry.client.request(entry.path,
      { personalNumber: number, requestId, ...entry.extra }, entry.headers);
    const pauseNext = () => {
      let started, release; const began = new Promise(resolve => { started = resolve; }), ready = new Promise(resolve => { release = resolve; });
      hold = { started, ready }; return { began, release };
    };
    await run({ gateway, admin, alpha, beta, client, entrypoints, lookup, records, gets, month, usagePath, csvPath, pauseNext,
      get oauthCalls() { return oauthCalls; } });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []);
  }
}

test('all five registration entrypoints bill only their server-selected tenant and UUID retries never repeat the provider GET', () => fixture(async f => {
  const entries = await f.entrypoints(), attempts = [];
  for (const [index, entry] of entries.entries()) {
    // This scenario verifies five legitimate registration surfaces, not the
    // separate four-dispatches-per-second burst budget.
    if (index === 4) await new Promise(resolve => setTimeout(resolve, 1050));
    const number = personalNumber(index + 1), requestId = randomUUID(); attempts.push({ entry, number, requestId });
    const found = await f.lookup(entry, number, requestId);
    assert.equal(found.status, 200, JSON.stringify({ entrypoint: entry.label, body: found.body }));
    assert.equal(found.body.existing, false); assert.equal(found.body.person.personalNumber, number); assert.equal(found.body.person.name, personName(number));
    assert.equal(found.body.person.phone, undefined); assert.equal(found.body.person.email, undefined);
    assert.match(found.headers.get('cache-control'), /no-store/);
    const repeat = await f.lookup(entry, number, requestId);
    assert.equal(repeat.status, 409, JSON.stringify(repeat.body)); assert.equal(repeat.body.code, 'person_lookup_already_processed');
  }
  assert.equal(f.gets.length, 5); assert.equal(f.oauthCalls, 1);
  const rows = f.records(); assert.equal(rows.length, 5);
  for (const { entry, number, requestId } of attempts) {
    const row = rows.find(value => value.operationId === requestId); assert.ok(row);
    assert.equal(row.organisationId, entry.company); assert.equal(row.status, 'success'); assert.equal(row.billableConfirmed, true);
    assert.equal(row.unitSalesMinor, 200); assert.equal(row.currency, 'SEK'); assert.match(row.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(rows).includes(number), false); assert.equal(JSON.stringify(rows).includes(number.slice(-10)), false);
    assert.equal(JSON.stringify(rows).includes(personName(number)), false);
  }
  assert.equal((await f.admin.request('/api/platform/open-administration', {})).status, 200);
  const report = await f.admin.request(f.usagePath); assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.pricing.pricesExcludeVat, true); assert.equal(report.body.pricing.roaringLookupSalesMinor, 200);
  assert.equal(report.body.totals.providerCalls, 5); assert.equal(report.body.totals.billableCount, 5); assert.equal(report.body.totals.salesMinor, 1000);
  assert.equal(report.body.companies.find(value => value.companyId === f.alpha.company.id).totals.salesMinor, 600);
  assert.equal(report.body.companies.find(value => value.companyId === f.beta.company.id).totals.salesMinor, 400);
}));

test('an existing customer bypasses the paid provider and the usage ledger on all five entrypoints', () => fixture(async f => {
  const number = personalNumber(20);
  for (const target of [f.alpha, f.beta]) await target.repository.transact(state => {
    state.office.customers.push({ id: 'existing-person-customer', name: 'Befintlig kund behålls', type: 'Privatperson', number,
      customerNumber: 'K-PERSON', phone: '', email: '', address: '', postalCode: '', city: '', countryCode: 'SE', references: [], origins: [], audit: [] });
  });
  for (const entry of await f.entrypoints()) {
    const found = await f.lookup(entry, number);
    assert.equal(found.status, 200, JSON.stringify({ entrypoint: entry.label, body: found.body }));
    assert.deepEqual(found.body, { existing: true, person: null });
  }
  assert.equal(f.gets.length, 0); assert.equal(f.oauthCalls, 0); assert.deepEqual(f.records(), []);
}));

test('existing-customer suppression is tenant-local and cannot hide another company\'s billable lookup', () => fixture(async f => {
  const number = personalNumber(21);
  await f.alpha.repository.transact(state => { state.office.customers.push({ id: 'alpha-only-person', name: 'Alpha existing customer',
    type: 'Privatperson', number, customerNumber: 'K-ALPHA', phone: '', email: '', address: '', postalCode: '', city: '', countryCode: 'SE', references: [], origins: [], audit: [] }); });
  assert.deepEqual((await f.alpha.owner.request(PATH, { personalNumber: number, requestId: randomUUID() })).body, { existing: true, person: null });
  const found = await f.beta.owner.request(PATH, { personalNumber: number, requestId: randomUUID() });
  assert.equal(found.status, 200, JSON.stringify(found.body)); assert.equal(found.body.existing, false);
  assert.equal(f.gets.length, 1); const rows = f.records(); assert.equal(rows.length, 1); assert.equal(rows[0].organisationId, f.beta.company.id);
}));

test('provider work is blocked before dispatch for unauthenticated, stale, foreign and unauthorized customer contexts', () => fixture(async f => {
  const body = { personalNumber: personalNumber(30), requestId: randomUUID() };
  assert.equal((await f.client().request(PATH, body)).status, 401);
  for (const [headers, status] of [[{ 'x-platform-csrf': '' }, 403], [{ 'x-platform-generation': 'stale' }, 409],
    [{ origin: 'https://foreign.example.test' }, 403], [{ 'x-client-company': f.beta.company.id }, 409]]) {
    const denied = await f.alpha.owner.request(PATH, body, headers); assert.equal(denied.status, status, JSON.stringify(denied.body));
  }
  const invalid = await f.alpha.owner.request(PATH, { ...body, companyId: f.beta.company.id });
  assert.equal(invalid.status, 422, JSON.stringify(invalid.body));
  await f.alpha.repository.transact(state => { const user = state.pricing.users.find(value => value.id === f.alpha.user.id);
    user.level = 'Medarbetare'; user.permissions = ['view']; });
  const denied = await f.alpha.owner.request(PATH, body); assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(f.gets.length, 0); assert.equal(f.oauthCalls, 0); assert.deepEqual(f.records(), []);
}));

test('usage JSON and CSV are reserved for the actual systemadmin outside a company support session', () => fixture(async f => {
  const found = await f.alpha.owner.request(PATH, { personalNumber: personalNumber(40), requestId: randomUUID() });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  for (const path of [f.usagePath, f.csvPath]) {
    assert.equal((await f.client().request(path)).status, 401);
    assert.equal((await f.alpha.owner.request(path)).status, 403);
  }
  assert.equal((await f.admin.request('/api/platform/switch', { organisationId: f.alpha.company.id })).status, 200);
  for (const path of [f.usagePath, f.csvPath]) assert.equal((await f.admin.request(path)).status, 403);
  assert.equal((await f.admin.request('/api/platform/open-administration', {})).status, 200);
  const report = await f.admin.request(`${f.usagePath}&companyId=${f.alpha.company.id}`);
  assert.equal(report.status, 200, JSON.stringify(report.body)); assert.equal(report.body.companies.length, 1);
  assert.equal(report.body.totals.salesMinor, 200); assert.equal(report.body.companies[0].companyId, f.alpha.company.id);
  const csv = await f.admin.request(`${f.csvPath}&companyId=${f.alpha.company.id}`);
  assert.equal(csv.status, 200, csv.text); assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/); assert.match(csv.headers.get('cache-control'), /no-store/);
  assert.ok(csv.text.includes(f.alpha.company.id)); assert.ok(!csv.text.includes(f.beta.company.id));
  assert.ok(csv.text.includes('SEK exkl. moms')); assert.ok(csv.text.includes('"2,00"'));
  for (const output of [JSON.stringify(report.body), csv.text, JSON.stringify(f.records())]) {
    assert.ok(!output.includes(personalNumber(40))); assert.ok(!output.includes(personName(personalNumber(40))));
    assert.ok(!output.includes('Syntetiska vägen 7')); assert.ok(!output.includes('fixture-roaring-token'));
  }
}));

test('a late person result is withheld after a real company switch while the dispatched lookup remains billed to its original tenant', () => fixture(async f => {
  assert.equal((await f.admin.request('/api/platform/switch', { organisationId: f.alpha.company.id })).status, 200);
  const gate = f.pauseNext(), number = personalNumber(50), requestId = randomUUID();
  const pending = f.admin.request(PATH, { personalNumber: number, requestId });
  try {
    await Promise.race([gate.began, pending.then(value => { throw new Error(`Lookup returned before the provider: ${value.status} ${value.text}`); })]);
    assert.equal((await f.admin.request('/api/platform/switch', { organisationId: f.beta.company.id })).status, 200);
  } finally { gate.release(); }
  const stale = await pending;
  assert.ok([401, 409].includes(stale.status), JSON.stringify(stale.body)); assert.equal(stale.body.person, undefined);
  assert.ok(!stale.text.includes(number)); assert.ok(!stale.text.includes(personName(number))); assert.ok(!stale.text.includes('Syntetiska vägen 7'));
  assert.equal(f.gets.length, 1); const rows = f.records(); assert.equal(rows.length, 1);
  assert.equal(rows[0].organisationId, f.alpha.company.id); assert.equal(rows[0].operationId, requestId); assert.equal(rows[0].unitSalesMinor, 200);
}));
