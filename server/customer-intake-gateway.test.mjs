import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTenantGateway } from './tenant-gateway.mjs';

const STAFF = '/api/employee/customer-intake';
const PUBLIC = '/api/public/customer-intake';
const INITIAL = 'Intake-Initial-Admin-2026!';
const ADMIN = 'Intake-Changed-Admin-2026!';
const OWNER = 'Intake-Owner-Mobile-2026!';
const draftId = '6cff266e-474c-4e8e-a142-de4678c98a62';
const bank = { method: 'bank', bankType: 'account', clearing: '8327', account: '00123456789', holder: 'Testkund AB' };
const customerInput = (extra = {}) => ({ type: 'Företag', name: 'Testkund AB', number: '559359-3626',
  phone: '072 200 22 20', email: 'kund@example.test', address: 'Testgatan 1', postalCode: '761 41', city: 'Norrtälje', countryCode: 'SE', ...extra });
const bankFree = value => {
  const text = JSON.stringify(value); assert.equal(text.includes(bank.account), false); assert.equal(text.includes('paymentProfile'), false);
};
function organisationNumber(prefix) {
  const sum = [...prefix].reduce((total, value, index) => {
    const digit = Number(value) * (index % 2 === 0 ? 2 : 1); return total + (digit > 9 ? digit - 9 : digit);
  }, 0);
  return `${prefix}${(10 - sum % 10) % 10}`;
}

/** The real gateway, platform/personnel authentication, isolated tenant stores
 * and public bearer routing. Only external SMS transmission is substituted. */
async function fixture(run,{companyRegister}={}) {
  const directory = await mkdtemp(join(tmpdir(), 'customer-intake-gateway-'));
  const env = { JEROC_TENANT_DATA_DIR: directory, JEROC_DEMO_AUTO_SESSION: 'false', SCRAPPILOT_PLATFORM_ADMIN_PASSWORD: INITIAL,
    APP_URL: 'https://app.scrapplanner.com', MOBILE_URL: 'https://mobile.scrapplanner.com' };
  for (const key of ['APPLICATION', 'ENVIRONMENT', 'TERMINAL', 'DOCUMENT', 'ARTICLE_MEDIA', 'PLATFORM', 'COMPANY_LOGO', 'SICKNESS_FILES', 'FLEET_FILES'])
    env[`JEROC_${key}_DB_PATH`] = join(directory, `${key.toLowerCase()}.sqlite`);
  let server, gateway; const sends = [], failures = [];
  const systemSms = { configured: true, sendTest: async () => { throw new Error('Unrelated test messages are never sent by this fixture.'); },
    sendCustomerIntake: async input => { sends.push(structuredClone(input)); return { providerId: randomUUID() }; } };
  try {
    gateway = await createTenantGateway({ env, systemSms, companyRegister });
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
            ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }).filter(([, value]) => value !== undefined)),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        for (const entry of response.headers.getSetCookie()) { const [name, value] = entry.split(';')[0].split('='); if (value) cookies.set(name, value); else cookies.delete(name); }
        const value = await response.json(); if (value?.authenticated) session = value;
        return { status: response.status, body: value, headers: response.headers };
      }
      return { request, cookies };
    }
    const admin = client();
    assert.equal((await admin.request('/api/platform/login', { username: 'admin', password: INITIAL })).status, 200);
    assert.equal((await admin.request('/api/platform/change-password', { currentPassword: INITIAL, newPassword: ADMIN })).status, 200);
    async function company(label, prefix) {
      const email = `${label.toLowerCase()}@example.test`;
      const created = await admin.request('/api/platform/companies', { requestId: randomUUID(), name: `${label} Återvinning AB`,
        organisationNumber: organisationNumber(prefix), vdName: `${label} Ägare`, vdEmail: email });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const value = created.body, owner = client();
      assert.equal((await owner.request('/api/platform/login', { username: email, password: value.temporaryCredentials.password })).status, 200);
      assert.equal((await owner.request('/api/platform/change-password', { currentPassword: value.temporaryCredentials.password, newPassword: OWNER })).status, 200);
      const mobile = client();
      assert.equal((await mobile.request('/api/employee/login?view=bootstrap', { username: email, password: OWNER })).status, 200);
      const repository = await (await gateway.bundle(await gateway.auth.getCompany(value.company.id))).applicationApi.getRepository();
      const date = new Date().toISOString();
      const createdDraft = await mobile.request('/api/application/mobile', { kind: 'records', version: 1, customers: [], drafts: [{ id: draftId,
        next: { id: draftId, number: 1, siteId: 'main', mode: 'direct', status: 'draft', createdAt: date, updatedAt: date,
          rows: [{ id: 'row-original', articleId: 'intake-material', method: 'direct', weight: 10 }], reference: '', origin: '' } }] });
      assert.equal(createdDraft.status, 200, JSON.stringify(createdDraft.body));
      return { ...value, email, owner, mobile, repository };
    }
    const alpha = await company('Alpha', '556030001'), beta = await company('Beta', '556030002');
    async function issue(target = alpha, extra = {}) {
      const input = { draftId, channel: 'sms', phone: '+46701234567', requestId: randomUUID(), expectedCustomerId: null, ...extra };
      const result = await target.mobile.request(STAFF, input);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.ok(result.body.intake?.id);
      return { input, result, intake: result.body.intake };
    }
    const capability = delivery => {
      const url = new URL(delivery.intakeUrl);
      assert.equal(url.origin, 'https://app.scrapplanner.com'); assert.equal(url.pathname, '/kunduppgifter/'); assert.equal(url.search, '');
      const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(url.hash); assert.ok(match);
      return { token: match[1], headers: { authorization: `Bearer ${match[1]}` } };
    };
    await run({ gateway, admin, client, alpha, beta, issue, sends, capability });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await gateway?.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(failures, []);
  }
}

test('SMS intake is idempotent, bank data stays private and staff apply preserves concurrent weighing work', () => fixture(async f => {
  const issued = await f.issue(); assert.equal(f.sends.length, 1);
  const retry = await f.alpha.mobile.request(STAFF, issued.input);
  assert.equal(retry.status, 200, JSON.stringify(retry.body)); assert.equal(retry.body.intake.id, issued.intake.id); assert.equal(f.sends.length, 1);
  const capability = f.capability(f.sends[0]), visitor = f.client();
  const view = await visitor.request(PUBLIC, undefined, capability.headers);
  assert.equal(view.status, 200, JSON.stringify(view.body)); assert.equal(view.body.company.name, f.alpha.company.name);
  assert.match(view.headers.get('cache-control'), /no-store/); assert.equal(view.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(view.body.customer, undefined); assert.equal(view.body.proposal, undefined); bankFree(view.body);
  const submit = { requestId: randomUUID(), customer: customerInput({ paymentProfile: bank }) };
  const submitted = await visitor.request(`${PUBLIC}/submit`, submit, capability.headers);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.equal(submitted.body.intake.status, 'submitted'); bankFree(submitted.body);
  assert.equal((await visitor.request(`${PUBLIC}/submit`, submit, capability.headers)).status, 200);
  const status = await f.alpha.mobile.request(`${STAFF}?draftId=${draftId}`);
  assert.equal(status.status, 200, JSON.stringify(status.body)); assert.equal(status.body.intake.hasPaymentProfile, true); bankFree(status.body);
  await f.alpha.repository.transact(state => {
    const draft = state.mobile.drafts.find(value => value.id === draftId);
    draft.rows[0].weight = 37; draft.rows.push({ id: 'row-concurrent', articleId: 'another-material', method: 'direct', weight: 5 });
    draft.reference = 'Referens från personalen'; draft.origin = 'Gårdens sparade ursprung'; draft.updatedAt = new Date().toISOString();
  });
  const apply = { id: issued.intake.id, requestId: randomUUID() };
  const applied = await f.alpha.mobile.request(`${STAFF}/apply`, apply);
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.intake.status, 'applied'); bankFree(applied.body);
  assert.equal(applied.body.draftPatch.rows, undefined); assert.equal(applied.body.customer.paymentProfile, undefined);
  const state = await f.alpha.repository.read(value => value), draft = state.mobile.drafts.find(value => value.id === draftId);
  assert.equal(state.office.customers.length, 1); assert.equal(state.office.customers[0].paymentProfile.account, bank.account);
  assert.equal(draft.customerId, state.office.customers[0].id); assert.equal(draft.rows[0].weight, 37); assert.equal(draft.rows[1].weight, 5);
  assert.equal(draft.reference, 'Referens från personalen'); assert.equal(draft.origin, 'Gårdens sparade ursprung'); assert.equal(draft.status, 'draft');
  assert.equal(state.office.cards.length, 0, 'Collecting customer details must not complete or approve the weighing.');
  const repeated = await f.alpha.mobile.request(`${STAFF}/apply`, apply);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body)); assert.equal(repeated.body.customer.id, applied.body.customer.id);
  assert.equal(await f.alpha.repository.read(value => value.office.customers.length), 1);
  const persisted = JSON.stringify(await f.gateway.repository.read(value => value)) + JSON.stringify(await f.alpha.repository.read(value => value));
  assert.equal(persisted.includes(capability.token), false);
}));

test('bearer capability stays bound to its issuing tenant and only accepts the customer form schema', () => fixture(async f => {
  const issued = await f.issue(), capability = f.capability(f.sends[0]);
  const wrongCookie = f.beta.mobile;
  const read = await wrongCookie.request(PUBLIC, undefined, { ...capability.headers, 'x-employee-company': f.beta.company.id });
  assert.equal(read.status, 200, JSON.stringify(read.body)); assert.equal(read.body.company.name, f.alpha.company.name);
  for (const [path, headers] of [[`${PUBLIC}?token=${capability.token}`, {}], [PUBLIC, { authorization: `Bearer ${'x'.repeat(43)}` }]])
    assert.equal((await f.client().request(path, undefined, headers)).status, 410);
  const invalid = await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput({ rows: [{ weight: 999 }], status: 'ready' }) }, capability.headers);
  assert.ok([400, 422].includes(invalid.status), JSON.stringify(invalid.body));
  const swish = await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput({ paymentProfile: { method: 'swish', phone: '+46701234567', recipient: 'Testkund' } }) }, capability.headers);
  assert.ok([400, 422].includes(swish.status), JSON.stringify(swish.body));
  assert.equal((await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput() }, { ...capability.headers, origin: 'https://foreign.invalid' })).status, 403);
  const sent = await wrongCookie.request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput() }, capability.headers);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await f.beta.mobile.request(`${STAFF}/apply`, { id: issued.intake.id, requestId: randomUUID() })).status, 410);
  const applied = await f.alpha.mobile.request(`${STAFF}/apply`, { id: issued.intake.id, requestId: randomUUID() });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(await f.beta.repository.read(state => state.office.customers.length), 0);
}));

test('matching an existing identifier links its canonical customer without replacing any contact or bank fields', () => fixture(async f => {
  const existing = { id: 'existing-customer', customerNumber: 'K-EXISTING', ...customerInput({ name: 'Kanonisk kund', number: '5593593626',
    phone: '+46709998877', email: 'private-existing@example.test', paymentProfile: { ...bank, account: '999888777' } }), references: ['Bevara'], origins: ['Bevara ursprung'], audit: [] };
  await f.alpha.repository.transact(state => { state.office.customers.push(structuredClone(existing)); state.pricing.customers.push({ id: existing.id, name: existing.name }); });
  const issued = await f.issue(), capability = f.capability(f.sends[0]);
  const read = await f.client().request(PUBLIC, undefined, capability.headers);
  assert.equal(JSON.stringify(read.body).includes(existing.email), false); assert.equal(JSON.stringify(read.body).includes(existing.paymentProfile.account), false);
  assert.equal((await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput({ name: 'Anonymous replacement name', paymentProfile: bank }) }, capability.headers)).status, 200);
  const applied = await f.alpha.mobile.request(`${STAFF}/apply`, { id: issued.intake.id, requestId: randomUUID() });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.customer.id, existing.id);
  assert.equal(applied.body.customer.paymentProfile, undefined);
  const state = await f.alpha.repository.read(value => value);
  assert.equal(state.office.customers.length, 1); assert.deepEqual(state.office.customers[0], existing);
  assert.equal(state.mobile.drafts.find(value => value.id === draftId).customerId, existing.id);
}));

test('cancelled intake and changed customer bindings cannot later attach an obsolete proposal', () => fixture(async f => {
  const issued = await f.issue(), capability = f.capability(f.sends[0]);
  const cancelCommand={id:issued.intake.id,requestId:randomUUID()};
  const cancelled = await f.alpha.mobile.request(`${STAFF}/cancel`, cancelCommand);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body)); assert.equal(cancelled.body.intake.status, 'cancelled');
  assert.equal((await f.client().request(PUBLIC, undefined, capability.headers)).status, 410);
  const next = await f.issue(), fresh = f.capability(f.sends[1]);
  assert.notEqual(next.intake.id,issued.intake.id);assert.notEqual(fresh.token,capability.token);
  const replay=await f.alpha.mobile.request(STAFF,issued.input);
  assert.equal(replay.body.intake.status,'cancelled');assert.equal(f.sends.length,2);
  assert.equal((await f.client().request(PUBLIC,undefined,fresh.headers)).status,200);
  assert.equal((await f.alpha.mobile.request(`${STAFF}/cancel`,cancelCommand)).status,200);
  assert.equal((await f.alpha.mobile.request(`${STAFF}/cancel`,{id:issued.intake.id,requestId:randomUUID()})).status,200);
  assert.equal((await f.client().request(PUBLIC,undefined,fresh.headers)).status,200);
  assert.equal((await f.client().request(`${PUBLIC}/submit`,{requestId:randomUUID(),customer:customerInput()},capability.headers)).status,410);
  assert.equal((await f.client().request(`${PUBLIC}/submit`,{requestId:randomUUID(),customer:customerInput()},fresh.headers)).status,200);
  await f.alpha.repository.transact(state => { state.mobile.drafts.find(value => value.id === draftId).customerId = 'staff-chosen-customer'; });
  const stale = await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput() }, fresh.headers);
  assert.ok([409, 410].includes(stale.status), JSON.stringify(stale.body));
  assert.ok([409, 410].includes((await f.alpha.mobile.request(`${STAFF}/apply`, { id: next.intake.id, requestId: randomUUID() })).status));
  assert.equal(await f.alpha.repository.read(state => state.office.customers.length), 0);
}));

test('issuing requires current staff authority, company fences and platform CSRF; public expiry independently revokes access', () => fixture(async f => {
  const input = { draftId, channel: 'sms', phone: '+46701234567', requestId: randomUUID(), expectedCustomerId: null };
  const anonymous = f.client();
  assert.equal((await anonymous.request('/api/platform/select-tenant', { organisationId: f.alpha.company.id })).status, 200);
  assert.equal((await anonymous.request(STAFF, input)).status, 401);
  assert.equal((await f.alpha.mobile.request(STAFF, input, { 'x-employee-company': f.beta.company.id })).status, 409);
  assert.equal((await f.alpha.mobile.request(STAFF, input, { origin: 'https://foreign.invalid' })).status, 403);
  const selected = await f.admin.request('/api/platform/switch', { organisationId: f.alpha.company.id });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal((await f.admin.request(STAFF, input, { 'x-platform-csrf': undefined })).status, 403);
  assert.equal((await f.admin.request(STAFF, input, { 'x-platform-generation': undefined })).status, 409);
  await f.alpha.repository.transact(state => {
    const user = state.pricing.users.find(value => value.id === f.alpha.user.id);
    user.level = 'Medarbetare'; user.permissions = ['view', 'prepare'];
  });
  assert.equal((await f.alpha.mobile.request(STAFF, input)).status, 403);
  assert.equal(f.sends.length, 0);
  await f.alpha.repository.transact(state => { state.pricing.users.find(value => value.id === f.alpha.user.id).level = 'VD'; });
  const issued = await f.issue(), capability = f.capability(f.sends[0]);
  await f.gateway.repository.transact(state => { state.customerIntakeLinks.find(value => value.intakeId === issued.intake.id).expiresAt = '2000-01-01T00:00:00.000Z'; });
  assert.equal((await f.client().request(PUBLIC, undefined, capability.headers)).status, 410);
  assert.equal((await f.client().request(`${PUBLIC}/submit`, { requestId: randomUUID(), customer: customerInput() }, capability.headers)).status, 410);
  assert.equal(await f.alpha.repository.read(state => state.office.customers.length), 0);
}));

test('a paired terminal submits only its own reserved form and releases it after staff apply', () => fixture(async f => {
  assert.equal((await f.admin.request('/api/platform/switch', { organisationId: f.alpha.company.id })).status, 200);
  const created = await f.admin.request('/api/terminal-demo/terminals', { name: 'Kassan', siteId: 'main', username: 'intake.kassan', password: 'Terminal-Intake-2026!' });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const terminalId = created.body.id;
  const device = f.client();
  assert.equal((await device.request('/api/platform/select-tenant', { organisationId: f.alpha.company.id })).status, 200);
  assert.equal((await device.request('/api/terminal-demo/login', { username: 'intake.kassan', password: 'Terminal-Intake-2026!' })).status, 200);
  const issued = await f.issue(f.alpha, { channel: 'terminal', terminalId, phone: undefined });
  assert.equal(f.sends.length, 0);
  const available = await f.alpha.mobile.request(`${STAFF}?draftId=${draftId}`);
  assert.equal(available.body.terminals.find(value => value.id === terminalId).available, false);
  const session = await device.request('/api/terminal-demo/session');
  assert.equal(session.body.approval, null); assert.equal(session.body.terminal.busyKind, 'intake');
  const view = await device.request('/api/terminal-demo/customer-intake');
  assert.equal(view.status, 200, JSON.stringify(view.body)); assert.equal(view.body.intake.id, issued.intake.id); bankFree(view.body);
  assert.equal((await f.client().request('/api/terminal-demo/customer-intake')).status, 401);
  assert.equal((await device.request('/api/application/mobile')).status, 401);
  const wrong = await device.request('/api/terminal-demo/customer-intake/submit', { id: randomUUID(), requestId: randomUUID(), customer: customerInput() });
  assert.equal(wrong.status, 410, JSON.stringify(wrong.body));
  const command = { id: issued.intake.id, requestId: randomUUID(), customer: customerInput({ paymentProfile: bank }) };
  const submitted = await device.request('/api/terminal-demo/customer-intake/submit', command);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body)); assert.equal(submitted.body.intake.status, 'submitted'); bankFree(submitted.body);
  assert.equal((await device.request('/api/terminal-demo/customer-intake/submit', command)).status, 200);
  const applied = await f.alpha.mobile.request(`${STAFF}/apply`, { id: issued.intake.id, requestId: randomUUID() });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual((await device.request('/api/terminal-demo/customer-intake')).body, { intake: null });
  assert.equal((await device.request('/api/terminal-demo/session')).body.terminal.busy, false);
  assert.equal((await device.request('/api/terminal-demo/customer-intake/submit', command)).status, 410);
  assert.equal((await device.request('/api/terminal-demo/logout', {})).status, 200);
  assert.equal((await device.request('/api/terminal-demo/customer-intake')).status, 401);
}));

test('real gateway routes SCB lookup only through a live SMS capability or the exact paired terminal intake',async()=>{
  const calls=[],companyRegister={configured:true,lookup:async(number,{signal}={})=>{
    calls.push(number);assert.ok(signal instanceof AbortSignal);
    return {organisationNumber:number,name:'Syntetisk SCB-träff AB',address:'Exempelvägen 1',postalCode:'76141',city:'Norrtälje',countryCode:'SE',
      phone:'+46722002220',email:'kontakt@example.test',source:'SCB',fetchedAt:new Date().toISOString(),paymentProfile:bank,vatRegistered:true,privateProviderData:'hidden'};
  }};
  await fixture(async f=>{
    const issued=await f.issue(),capability=f.capability(f.sends[0]),visitor=f.client();
    const found=await visitor.request(`${PUBLIC}/company-lookup`,{organisationNumber:'559359-3626'},capability.headers);
    assert.equal(found.status,200,JSON.stringify(found.body));assert.equal(found.body.company.name,'Syntetisk SCB-träff AB');
    assert.equal(found.body.company.organisationNumber,'5593593626');assert.equal(found.body.company.postalCode,'76141');
    assert.equal(found.body.company.paymentProfile,undefined);assert.equal(found.body.company.vatRegistered,undefined);assert.equal(found.body.company.privateProviderData,undefined);
    assert.equal((await visitor.request('/api/company-register/lookup',{organisationNumber:'5593593626'},capability.headers)).status,401);
    assert.equal((await visitor.request(`${PUBLIC}/company-lookup`,{organisationNumber:'5593593626'})).status,410);
    assert.equal(calls.length,1);
    await f.alpha.mobile.request(`${STAFF}/cancel`,{id:issued.intake.id,requestId:randomUUID()});
    assert.equal((await visitor.request(`${PUBLIC}/company-lookup`,{organisationNumber:'5593593626'},capability.headers)).status,410);
    assert.equal((await f.admin.request('/api/platform/switch',{organisationId:f.alpha.company.id})).status,200);
    const created=await f.admin.request('/api/terminal-demo/terminals',{name:'SCB-terminal',siteId:'main',username:'intake.scb',password:'Terminal-Lookup-2026!'});
    assert.equal(created.status,201,JSON.stringify(created.body));
    const device=f.client();assert.equal((await device.request('/api/platform/select-tenant',{organisationId:f.alpha.company.id})).status,200);
    assert.equal((await device.request('/api/terminal-demo/login',{username:'intake.scb',password:'Terminal-Lookup-2026!'})).status,200);
    const terminal=await f.issue(f.alpha,{channel:'terminal',terminalId:created.body.id,phone:undefined});
    const route='/api/terminal-demo/customer-intake/company-lookup';
    const terminalFound=await device.request(route,{id:terminal.intake.id,organisationNumber:'559359-3626'});
    assert.equal(terminalFound.status,200,JSON.stringify(terminalFound.body));assert.equal(terminalFound.body.company.name,found.body.company.name);
    assert.equal((await device.request(route,{id:randomUUID(),organisationNumber:'5593593626'})).status,410);
    assert.equal((await f.client().request(route,{id:terminal.intake.id,organisationNumber:'5593593626'})).status,401);
    assert.deepEqual(calls,['5593593626','5593593626']);
    assert.equal(await f.alpha.repository.read(state=>state.office.customers.length),0);
  },{companyRegister});
});
