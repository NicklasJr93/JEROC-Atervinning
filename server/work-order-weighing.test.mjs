import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', address: 'Industrivägen 1', postalCode: '76231', city: 'Rimbo', active: true }];
const classifications = [{ articleId: 'lead-battery', version: 7, hazardous: true, wasteCode: '160601', handlingInstructions: 'Skydda mot läckage.' }];
const place = { name: 'Verkstad Test AB', address: 'Industrivägen 8', postalCode: '76141', city: 'Norrtälje' };
const input = (extra = {}) => ({ siteId: 'norrtalje', action: 'pickup', customerId: 'customer-build', from: place, to: { ...place, name: 'JEROC Norrtälje' }, operator: 'own', vesselType: 'battery', materialRows: [], ...extra });
const endpoint = '/api/logistics/office';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-ao-weighing-')), filename = join(directory, 'application.sqlite');
  const repositories = [], servers = [];
  const seed = () => { const state = initialApplicationState(); state.office.cards = []; return state; };
  async function instance() {
    const repository = await createApplicationRepository({ env: {}, filename, seed }); repositories.push(repository);
    const app = createApplicationService({ repository, siteProvider: async () => sites, environmentProvider: async () => ({ classifications, inventory: [] }) });
    const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }));
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    async function request(path = endpoint, data, user = 'admin') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-demo-actor': user, 'x-demo-user': user }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, ...await response.json() };
    }
    return { repository, request };
  }
  try { await run({ ...await instance(), instance }); }
  finally { for (const server of servers) await new Promise(resolve => server.close(resolve)); for (const repository of repositories) await repository.close(); await rm(directory, { recursive: true, force: true }); }
}
async function create(request, value) { const result = await request(endpoint, { action: 'order.create', input: value, idempotencyKey: randomUUID() }); assert.equal(result.status, 200, result.error); return result.orders.find(order => order.id === result.result.orderId); }
async function change(request, order, action, extra = {}) { const result = await request(endpoint, { action, orderId: order.id, expectedVersion: order.detail.version, ...extra }); assert.equal(result.status, 200, result.error); return result.orders.find(value => value.id === order.id); }
const weighingInput = (order, rows) => ({ customerId: order.detail.weighing.customerId, origin: order.detail.weighing.origin, reference: order.detail.weighing.reference, rows });

test('first saved incoming material prepares one durable draft with no INV, receipt, stock or authority side effects', async () => fixture(async f => {
  let order = await create(f.request, input()); assert.equal(order.detail.weighing, undefined);
  const initial = await f.repository.transact(state => structuredClone(state));
  order = await change(f.request, order, 'order.edit', { input: input({ materialRows: [{ articleId: 'copper-1', plannedKg: 200 }] }) });
  const id = order.detail.weighing.id; assert.equal(order.detail.weighing.status, 'prepared'); assert.equal(order.detail.weighing.cardId, undefined); assert.equal(order.detail.weighing.rows[0].weight, undefined);
  order = await change(f.request, order, 'order.edit', { input: input({ materialRows: [{ articleId: 'copper-1', plannedKg: 250 }, { articleId: 'lead-battery', plannedKg: 10 }] }) });
  assert.equal(order.detail.weighing.id, id); assert.equal(order.detail.weighing.rows.length, 2); assert.equal(order.detail.weighing.rows[0].plannedKg, 250);
  assert.deepEqual(order.detail.weighing.environmentPreparation.rows, [{ articleId: 'lead-battery', name: 'Blybatterier', wasteCode: '160601', classificationVersion: 7 }]);
  const other = await f.instance(), reopened = (await other.request()).orders.find(value => value.id === order.id); assert.equal(reopened.detail.weighing.id, id);
  const state = await other.repository.transact(state => structuredClone(state)); assert.equal(state.office.cards.length, 0); assert.equal(state.mobile.drafts.length, 0); assert.equal(state.metadata.nextCard, initial.metadata.nextCard); assert.deepEqual(state.logistics.inventoryMovements, []);
  assert.equal(Object.keys(state.workOrderWeighing.drafts).length, 1); assert.equal(state.workOrderWeighing.drafts[order.id].environmentPreparation.status, 'prepared');
}));

test('cancel removes only unused preparation, while started physical facts remain and outbound creates none', async () => fixture(async f => {
  let unused = await create(f.request, input({ materialRows: [{ articleId: 'lead-battery', plannedKg: 10 }] })); unused = await change(f.request, unused, 'order.cancel', { reason: 'Ingen hämtning behövs' }); assert.equal(unused.detail.weighing, undefined);
  let started = await create(f.request, input({ materialRows: [{ articleId: 'copper-1', plannedKg: 30 }] })); started = await change(f.request, started, 'order.weighing.save', { input: weighingInput(started, [{ articleId: 'copper-1', weight: 28 }]) });
  started = await change(f.request, started, 'order.cancel', { reason: 'Transportplanen avbruten' }); assert.equal(started.detail.weighing.status, 'started'); assert.equal(started.detail.weighing.rows[0].weight, 28);
  await f.request(endpoint, { action: 'inventory.adjust', siteId: 'norrtalje', articleId: 'copper-1', kg: 100, reason: 'Kontrollerat öppningslager', idempotencyKey: randomUUID() });
  const outbound = await create(f.request, input({ action: 'outbound', materialRows: [{ articleId: 'copper-1', plannedKg: 20 }] })); assert.equal(outbound.detail.weighing, undefined);
  assert.equal((await f.request(endpoint, { action: 'order.weighing.start', orderId: outbound.id, expectedVersion: outbound.detail.version })).status, 422);
}));

test('delivered transport preserves the same draft for subsequent actual yard weighing and never copies truck weights', async () => fixture(async f => {
  let order = await create(f.request, input({ materialRows: [{ articleId: 'copper-1', plannedKg: 90 }] })); const id = order.detail.weighing.id;
  await f.repository.transact(state => { const record = state.transport.orders.find(value => value.id === order.id), detail = state.logistics.details[order.id]; record.status = 'done'; detail.execution.stage = 'delivered'; detail.materialRows[0].actualKg = 88; });
  order = (await f.request()).orders.find(value => value.id === order.id); assert.equal(order.detail.weighing.id, id); assert.equal(order.detail.weighing.status, 'prepared'); assert.equal(order.detail.weighing.rows[0].weight, undefined);
  order = await change(f.request, order, 'order.weighing.save', { input: weighingInput(order, [{ articleId: 'copper-1', weight: 87 }]) });
  order = await change(f.request, order, 'order.weighing.complete'); assert.equal(order.detail.weighing.status, 'completed');
  assert.equal((await f.repository.transact(state => state.office.cards[0])).rows[0].weight, 87);
}));

test('actual rows stay independent of the plan and simultaneous completion allocates one unique card after mobile numbers', async () => fixture(async f => {
  let order = await create(f.request, input({ materialRows: [{ articleId: 'copper-1', plannedKg: 200 }] }));
  assert.equal((await f.request(endpoint, { action: 'order.weighing.complete', orderId: order.id, expectedVersion: order.detail.version })).status, 422);
  order = await change(f.request, order, 'order.weighing.save', { input: weighingInput(order, [{ articleId: 'copper-1', weight: 190.125 }, { articleId: 'lead-battery', weight: 10 }]) });
  assert.equal(order.detail.materialRows.length, 1); assert.equal(order.detail.weighing.rows[1].plannedKg, 0);
  await f.repository.transact(state => state.mobile.drafts.push({ id: randomUUID(), number: 9000, mode: 'direct', status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), rows: [], reference: '', origin: '' }));
  const other = await f.instance(), command = { action: 'order.weighing.complete', orderId: order.id, expectedVersion: order.detail.version };
  const results = await Promise.all([f.request(endpoint, command), other.request(endpoint, command)]); assert.ok(results.every(value => value.status === 200), JSON.stringify(results)); assert.deepEqual(results.map(value => value.result.cardId), [9001, 9001]);
  const state = await f.repository.transact(state => structuredClone(state)); assert.equal(state.office.cards.length, 1); const card = state.office.cards[0];
  assert.equal(card.workOrderId, order.id); assert.equal(card.sourceId, order.detail.weighing.id); assert.equal(card.status, 'new'); assert.equal(card.idVerified, false); assert.equal(card.customerApproval, undefined); assert.equal(card.rows[0].pricePending, true); assert.equal(card.rows[0].weight, 190.125); assert.equal(state.metadata.nextCard, 9002);
  const view = await f.request(); assert.equal(view.stock.find(row => row.articleId === 'copper-1').onHandKg, 190.125); assert.equal(view.stock.some(row => row.articleId === 'lead-battery'), false);
  const repeated = await f.request(endpoint, command); assert.equal(repeated.result.cardId, card.id); assert.equal((await f.repository.transact(state => state.office.cards)).length, 1);
  const changed = await change(f.request, repeated.orders.find(value => value.id === order.id), 'order.edit', { input: input({ materialRows: [{ articleId: 'copper-1', plannedKg: 300 }] }) }); assert.equal(changed.detail.weighing.rows[0].weight, 190.125);
}));

test('actual weighing requires prepare and original facility scope; browser cannot forge or alter the AO link', async () => fixture(async f => {
  let order = await create(f.request, input({ materialRows: [{ articleId: 'copper-1', plannedKg: 20 }] }));
  await f.repository.transact(state => { const user = state.pricing.users.find(value => value.id === 'kajsa'); Object.assign(user, { level: 'Medarbetare', permissions: ['workOrdersRead', 'workOrdersWrite'], siteIds: ['norrtalje'] }); });
  assert.equal((await f.request(endpoint, { action: 'order.weighing.start', orderId: order.id, expectedVersion: order.detail.version }, 'kajsa')).status, 403);
  await f.repository.transact(state => { const user = state.pricing.users.find(value => value.id === 'kajsa'); user.permissions.push('prepare'); user.siteIds = ['rimbo']; });
  assert.equal((await f.request(endpoint, { action: 'order.weighing.start', orderId: order.id, expectedVersion: order.detail.version }, 'kajsa')).status, 403);
  order = await change(f.request, order, 'order.weighing.save', { input: weighingInput(order, [{ articleId: 'copper-1', weight: 19 }]) }); order = await change(f.request, order, 'order.weighing.complete');
  const base = (await f.request('/api/application/office')).data;
  for (const field of ['workOrderId', 'sourceId']) { const next = structuredClone(base); next.cards[0][field] = field === 'sourceId' ? randomUUID() : 'AO-FAKE'; assert.equal((await f.request('/api/application/office', { base, next })).status, 409); }
  const next = structuredClone(base); next.cards.push({ ...structuredClone(next.cards[0]), id: 9500, sourceId: randomUUID(), workOrderId: 'AO-FAKE' }); assert.equal((await f.request('/api/application/office', { base, next })).status, 409);
}));
