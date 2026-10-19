import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createApplicationService } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createTenantApplicationState } from './tenant-runtime.mjs';

const owner = { id: 'pilot-owner', personId: 'pilot-owner-person', name: 'Pilotägare', username: 'pilot.owner',
  passwordHash: { salt: 'a'.repeat(48), digest: 'b'.repeat(128) } };
const tenant = { id: 'pilot-company', name: 'Pilotbolag', storageSchema: 'jeroc_t_0123456789abcdef0123456789abcdef' };
const seed = () => createTenantApplicationState({ tenant, owner });

async function fixture(t, mode = 'pilot') {
  const env = { SCRAPPLANNER_DEPLOYMENT_MODE: mode };
  const repository = await createApplicationRepository({ env, filename: ':memory:', seed });
  let transactionCount = 0;
  const app = createApplicationService({ env, seed, repository: new Proxy(repository, {
    get(target, property) {
      if (property === 'transact') return (...args) => { transactionCount++; return target.transact(...args); };
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    },
  }), siteProvider: async () => [{ id: 'main', name: 'Huvudanläggning', active: true }] });
  const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.close(); });
  const request = async (path, input) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-actor': owner.id, 'x-demo-user': owner.id },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, ...await response.json() };
  };
  return { app, repository, request, transactionCount: () => transactionCount };
}

test('pilot rejects every legacy browser-import spelling without opening or mutating the application', async t => {
  const { repository, request, transactionCount } = await fixture(t);
  const before = await repository.read(state => state);
  const inputs = [
    { kind: 'import', data: { cards: [{ id: 3027 }], customers: [{ id: 'demo-customer' }] } },
    { kind: 'archive', data: { cards: [{ id: 3027 }] } },
    { importData: { cards: [{ id: 3027 }] } },
    { archiveData: { cards: [{ id: 3027 }] } },
    { importData: null }, { archiveData: false },
    { kind: 'records', version: 1, drafts: [], customers: [], importData: {} },
  ];
  const pricing = await request('/api/application/import-pricing', { pricing: { users: [{ id: 'admin' }] }, outbox: [] });
  assert.equal(pricing.status, 403);
  assert.equal(pricing.code, 'pilot_legacy_import_disabled');
  for (const domain of ['office', 'mobile', 'transport']) for (const input of inputs) {
    const result = await request(`/api/application/${domain}`, input);
    assert.equal(result.status, 403, `${domain}: ${JSON.stringify(input)}`);
    assert.equal(result.code, 'pilot_legacy_import_disabled');
  }
  assert.equal(transactionCount(), 0, 'rejected imports must not run startup migrations or write transactions');
  assert.deepEqual(await repository.read(state => state), before);
});

test('fresh pilot startup stays empty and normal customer commands remain usable', async t => {
  const { app, repository, request } = await fixture(t);
  await app.getRepository();
  const original = await repository.read(state => state);
  for (const key of ['cards', 'customers', 'payments', 'corrections']) assert.deepEqual(original.office[key], []);
  for (const key of ['orders', 'drivers', 'vehicles']) assert.deepEqual(original.transport[key], []);
  assert.deepEqual(original.pricing.users.map(user => user.id), [owner.id]);
  assert.deepEqual(original.personnelAuth.accounts.map(account => account.username), [owner.username]);
  assert.deepEqual(original.pricing.articleHistory, []);
  assert.deepEqual(original.pricing.groups, []);
  assert.deepEqual(original.imports, []);
  const office = await request('/api/application/office');
  assert.equal(office.status, 200, office.error);
  const customer = { id: 'real-pilot-customer', name: 'Pilotkund AB', type: 'Företag', number: '559359-3626',
    phone: '0722002220', email: 'pilot@example.invalid', address: 'Testgatan 1, 761 41 Norrtälje',
    references: [], origins: [], vatRegistered: true };
  const created = await request('/api/application/mobile', {
    kind: 'records', version: 1, drafts: [], customers: [{ id: customer.id, next: customer }],
  });
  assert.equal(created.status, 200, created.error);
  const saved = await repository.read(state => state);
  assert.deepEqual(saved.office.customers.map(value => value.id), [customer.id]);
  assert.equal(saved.office.customers[0].number, '5593593626');
  assert.equal(saved.office.customers[0].phone, '+46722002220');
  assert.deepEqual(saved.imports, []);
});

test('demo environments retain their existing browser-archive compatibility', async t => {
  const { request, repository } = await fixture(t, 'demo');
  const result = await request('/api/application/office', { kind: 'archive', data: { fixture: 'old-demo-copy' } });
  assert.equal(result.status, 200, result.error);
  const state = await repository.read(value => value);
  assert.equal(state.imports.length, 1);
  assert.deepEqual(state.imports[0].original, { fixture: 'old-demo-copy' });
});
