import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService } from './application.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-customer-economy-'));
  const app = createApplicationService({ env: { JEROC_APPLICATION_DB_PATH: join(directory, 'business.sqlite') } });
  const server = createServer((request, response) => void app(request, response, new URL(request.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (path, payload, user = 'admin') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-demo-actor': user, 'x-demo-user': user },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: response.status, ...await response.json() };
  };
  const office = (payload, user) => request('/api/application/office', payload, user);
  try { await run({ office, request }); }
  finally {
    await new Promise(resolve => server.close(resolve));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('customer economy edits are authoritative, preserve missing history and retry once', async () => fixture(async ({ office }) => {
  const base = (await office()).data;
  const next = structuredClone(base), customer = next.customers.find(row => row.type === 'Företag');
  assert.equal(customer.vatRegistered, undefined);
  customer.contactPerson = 'Vanlig kontaktändring';
  const savedContact = await office({ base, next });
  assert.equal(savedContact.status, 200, savedContact.error);
  assert.equal(savedContact.data.customers.find(row => row.id === customer.id).vatRegistered, undefined);
  const economyBase = savedContact.data, economyNext = structuredClone(economyBase);
  const edited = economyNext.customers.find(row => row.id === customer.id);
  edited.vatRegistered = false;
  edited.paymentTermDays = 45;
  edited.audit.push({ at: '2000-01-01', actor: 'Browser supplied name', text: 'Kunduppgifter uppdaterade.', actualUserId: 'admin', effectiveUserId: 'admin' });
  const saved = await office({ base: economyBase, next: economyNext });
  assert.equal(saved.status, 200, saved.error);
  const stored = saved.data.customers.find(row => row.id === customer.id);
  assert.equal(stored.vatRegistered, false);
  assert.equal(stored.paymentTermDays, 45);
  assert.ok(stored.audit.some(row => row.text === 'Momsregistrering ändrad: Ej angivet → Nej.'));
  assert.ok(stored.audit.some(row => row.text === 'Betalningsvillkor ändrade: Integrationens standard → 45 dagar.'));
  assert.ok(stored.audit.slice(-3).every(row => row.actualUserId === 'admin' && row.effectiveUserId === 'admin' && row.actor !== 'Browser supplied name'));
  const retried = await office({ base: economyBase, next: economyNext });
  assert.equal(retried.status, 200, retried.error);
  assert.deepEqual(retried.data.customers.find(row => row.id === customer.id).audit, stored.audit);
  const reset = structuredClone(saved.data);
  delete reset.customers.find(row => row.id === customer.id).paymentTermDays;
  const inherited = await office({ base: saved.data, next: reset });
  assert.equal(inherited.status, 200, inherited.error);
  const inheritedCustomer = inherited.data.customers.find(row => row.id === customer.id);
  assert.equal(inheritedCustomer.paymentTermDays, undefined);
  assert.equal(inheritedCustomer.audit.at(-1).text, 'Betalningsvillkor ändrade: 45 dagar → Integrationens standard.');
}));

test('customer economy edits reject forged audit and invalid terms and require customer rights', async () => fixture(async ({ office, request }) => {
  const base = (await office()).data;
  const forged = structuredClone(base);
  forged.customers[0].vatRegistered = true;
  forged.customers[0].audit.push({ at: '2000-01-01', actor: 'Systemadmin', text: 'Momsregistrering ändrad: Ej angivet → Ja.', actualUserId: 'admin', effectiveUserId: 'admin' });
  assert.equal((await office({ base, next: forged })).status, 409);
  for (const paymentTermDays of [-1, 3651, 1.5]) {
    const next = structuredClone(base);
    next.customers[0].paymentTermDays = paymentTermDays;
    const invalid = await office({ base, next });
    assert.notEqual(invalid.status, 200);
  }
  const users = (await request('/api/pricing/state')).users.map(user => user.id === 'kajsa' ? { ...user, permissions: ['view'] } : user);
  assert.equal((await request('/api/pricing/users', { users })).status, 200);
  const restrictedBase = (await office(undefined, 'kajsa')).data, forbidden = structuredClone(restrictedBase);
  forbidden.customers[0].paymentTermDays = 0;
  assert.equal((await office({ base: restrictedBase, next: forbidden }, 'kajsa')).status, 403);
}));

test('changing a customer to private saves VAT false and prevents rewriting old audit', async () => fixture(async ({ office }) => {
  const base = (await office()).data, next = structuredClone(base);
  next.customers[0].type = 'Privatperson';
  next.customers[0].vatRegistered = true;
  const saved = await office({ base, next });
  assert.equal(saved.status, 200, saved.error);
  assert.equal(saved.data.customers[0].vatRegistered, false);
  const forged = structuredClone(saved.data);
  forged.customers[0].audit[0].text = 'Omskriven historik';
  assert.equal((await office({ base: saved.data, next: forged })).status, 409);
}));

test('new company and BRF API customers default to VAT while private customers default false', async () => fixture(async ({ office }) => {
  const base = (await office()).data, next = structuredClone(base);
  for (const type of ['Företag', 'BRF', 'Privatperson']) {
    const customer = { ...structuredClone(base.customers[0]), id: `new-${type}`, name: `Ny ${type}`, type, audit: [] };
    delete customer.paymentProfile;
    delete customer.vatRegistered;
    next.customers.push(customer);
  }
  const saved = await office({ base, next });
  assert.equal(saved.status, 200, saved.error);
  for (const type of ['Företag', 'BRF', 'Privatperson']) {
    const customer = saved.data.customers.find(row => row.id === `new-${type}`);
    assert.equal(customer.vatRegistered, type !== 'Privatperson');
    assert.ok(customer.audit.some(row => row.text === `Momsregistrering ändrad: Ej angivet → ${type === 'Privatperson' ? 'Nej' : 'Ja'}.`));
  }
  const retried = await office({ base, next });
  assert.equal(retried.status, 200, retried.error);
  assert.deepEqual(retried.data.customers, saved.data.customers);
}));
