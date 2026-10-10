import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createLogisticsApi, applyDriverAction, driverOrderView, validateLogisticsTransportChange, logisticsOutboundInventory } from './logistics.mjs';
import { ensurePersonnel } from './personnel.mjs';
import { transportSchema } from '../dist-server/domain-models.mjs';

const sites = [{ id: 'norrtalje', name: 'Norrtälje', address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', address: 'Industrivägen 1', postalCode: '76231', city: 'Rimbo', active: true }];
const classifications = [{ articleId: 'lead-battery', hazardous: true, wasteCode: '160601', handlingInstructions: 'Skydda mot läckage.' }];
const place = (name = 'Verkstad') => ({ name, address: 'Industrivägen 8', postalCode: '76141', city: 'Norrtälje' });
const input = (extra = {}) => ({ siteId: 'norrtalje', action: 'pickup', from: place(), to: place('JEROC Norrtälje'), operator: 'own', vesselType: 'battery', materialRows: [], ...extra });
const officePath = '/api/logistics/office';
async function fixture(run, postgres = false) {
  const folder = await mkdtemp(join(tmpdir(), 'jeroc-logistics-')); let pool, schema, env = { JEROC_APPLICATION_DB_PATH: join(folder, 'business.sqlite') };
  if (postgres) { const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL }); schema = `jeroc_logistics_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`); const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env = { DATABASE_URL: url.toString() }; }
  const initial = () => { const state = initialApplicationState(); state.office.cards = []; ensurePersonnel(state); return state; };
  const repos = [], servers = [], inventory = [];
  async function instance() {
    const repository = await createApplicationRepository({ env, initial }); repos.push(repository);
    const handler = createLogisticsApi({ getRepository: async () => repository, readBody: async req => { let body = ''; for await (const part of req) body += part; return body ? JSON.parse(body) : {}; }, json: (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }, siteProvider: async () => sites, environmentProvider: async () => ({ classifications, inventory: structuredClone(inventory) }) });
    const server = createServer((req, res) => void handler(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } })); servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path = officePath, data, actor = 'admin', cookie) { const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-actor': actor, 'x-demo-user': actor } : {}), ...(cookie ? { cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) }); return { status: response.status, cookie: response.headers.get('set-cookie'), ...await response.json() }; }
    return { repository, request };
  }
  try { const first = await instance(); await run({ ...first, instance, inventory }); } finally { for (const server of servers) await new Promise(resolve => server.close(resolve)); for (const repo of repos) await repo.close(); if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); } await rm(folder, { recursive: true, force: true }); }
}
async function setupVessel(request, extra = {}) {
  const state = await request(), customer = state.customers.find(customer => customer.id === 'customer-build') ?? state.customers[0];
  const vessel = { id: `C-${randomUUID()}`, name: 'Demokärl', type: 'battery', siteId: 'norrtalje', customerId: customer.id, place: place(customer.name), status: 'placed', materialArticleId: 'lead-battery', ...extra };
  const saved = await request(officePath, { action: 'vessel.save', vessel, expectedVersion: 0 }); assert.equal(saved.status, 200, saved.error);
  return { customer, vessel: saved.vessels.find(value => value.id === vessel.id) };
}
async function account(request, kind, subjectId) { const username = `${kind}.${randomUUID()}`; const password = 'TestPassword-2026!'; const saved = await request(officePath, { action: 'account.save', account: { kind, subjectId, username, active: true, password } }); assert.equal(saved.status, 200, saved.error); const login = await request(`/api/${kind}/login`, { username, password }, null); assert.equal(login.status, 200, login.error); return { cookie: login.cookie.split(';')[0], account: saved.accounts.find(account => account.username === username), username, password }; }
async function createOrder(request, value) { const created = await request(officePath, { action: 'order.create', input: value, idempotencyKey: randomUUID() }); assert.equal(created.status, 200, created.error); return created.orders.find(order => order.id === created.result.orderId); }
async function commandOrder(request, order, action, extra = {}) { const response = await request(officePath, { action, orderId: order.id, expectedVersion: order.detail.version, ...extra }); assert.equal(response.status, 200, response.error); return response.orders.find(value => value.id === order.id); }

test('logistics persists on the existing repository and read views preserve legacy orders', async () => fixture(async ({ request, repository, instance }) => {
  const original = await repository.transact(state => structuredClone(state.transport.orders));
  const state = await request(); assert.equal(state.status, 200, state.error); assert.equal(state.vessels.length, 0); assert.equal(state.stock.length, 0);
  const stored = await repository.transact(state => structuredClone(state)); assert.ok(!JSON.stringify(stored.logisticsAuth).includes('password')); assert.equal(Object.keys(stored.logistics.details).length, 0);
  for (const order of original) assert.deepEqual(stored.transport.orders.find(value => value.id === order.id), { ...order, siteId: 'norrtalje' });
  const order = await createOrder(request, input()); const second = await (await instance()).request(); assert.ok(second.orders.some(value => value.id === order.id));
  assert.equal(order.durationMinutes, 60); assert.equal(order.operator, 'own'); assert.equal(order.driverId, undefined);
}));
test('office scopes all records and denies cross-facility mutations and missing permissions', async () => fixture(async ({ request, repository }) => {
  const first = await createOrder(request, input()); const other = await createOrder(request, input({ siteId: 'rimbo' }));
  await repository.transact(state => { const user = state.pricing.users.find(user => user.id === 'kajsa'); user.level = 'Medarbetare'; user.permissions = ['workOrdersRead', 'workOrdersWrite']; user.siteIds = ['rimbo']; });
  const view = await request(officePath, undefined, 'kajsa'); assert.equal(view.status, 200); assert.ok(view.orders.some(order => order.id === other.id)); assert.ok(!view.orders.some(order => order.id === first.id)); assert.deepEqual(view.stock, []); assert.equal(view.sites.length, 1);
  assert.equal((await request(officePath, { action: 'order.cancel', orderId: first.id, expectedVersion: first.detail.version, reason: 'Fel anläggning' }, 'kajsa')).status, 403);
  assert.equal((await request(officePath, { action: 'inventory.adjust', siteId: 'rimbo', articleId: 'copper-clean', kg: 10, reason: 'Öppningslager', idempotencyKey: randomUUID() }, 'kajsa')).status, 403);
  assert.equal((await request(officePath, undefined, null)).status, 401);
}));
test('customer account passwords are hashed, sessions scoped and revoked on reset', async () => fixture(async ({ request, repository }) => {
  const first = await setupVessel(request), second = await setupVessel(request, { customerId: 'customer-erik' }); const login = await account(request, 'customer', first.customer.id);
  const view = await request('/api/customer/state', undefined, null, login.cookie); assert.ok(view.vessels.some(vessel => vessel.id === first.vessel.id)); assert.ok(!view.vessels.some(vessel => vessel.id === second.vessel.id)); assert.ok(!JSON.stringify(view).includes('salaries')); assert.equal(view.accounts, undefined);
  const auth = await repository.transact(state => structuredClone(state.logisticsAuth)); assert.ok(auth.accounts[0].password.digest); assert.ok(!JSON.stringify(auth).includes(login.password));
  assert.equal((await request('/api/customer/requests', { vesselId: second.vessel.id, type: 'pickup', comment: '', idempotencyKey: randomUUID() }, null, login.cookie)).status, 403);
  const reset = await request(officePath, { action: 'account.save', account: { ...Object.fromEntries(['id','kind','subjectId','username','active'].map(key => [key, login.account[key]])), password: 'OtherPassword-2026!' } }); assert.equal(reset.status, 200, reset.error);
  assert.equal((await request('/api/customer/session', undefined, null, login.cookie)).status, 401);
}));
test('concurrent customer exchanges share a single AO and leave recurring dates intact', async () => fixture(async ({ request, instance }) => {
  const { customer, vessel } = await setupVessel(request); const agreement = { id: randomUUID(), customerId: customer.id, siteId: vessel.siteId, vesselId: vessel.id, active: true, action: 'exchange', intervalDays: 14, nextDate: '2026-11-02', notes: 'Rullande byte', kind: 'rolling', allowedActions: ['exchange','pickup'] };
  const saved = await request(officePath, { action: 'agreement.save', agreement, expectedVersion: 0 }); assert.equal(saved.status, 200, saved.error); const regularOrderId = saved.result.orderId; const login = await account(request, 'customer', customer.id), second = (await instance()).request;
  const body = { vesselId: vessel.id, type: 'exchange', requestedDate: '2026-10-20', comment: 'Fullt', idempotencyKey: randomUUID() };
  const results = await Promise.all([request('/api/customer/requests', body, null, login.cookie), second('/api/customer/requests', { ...body, idempotencyKey: randomUUID() }, null, login.cookie)]);
  assert.ok(results.every(value => value.status === 200), JSON.stringify(results)); assert.equal(new Set(results.map(value => value.request.id)).size, 1); assert.equal(results[0].request.orderId, regularOrderId);
  const view = await request(); assert.equal(view.requests.length, 1); assert.equal(view.orders.filter(order => order.detail.vesselId === vessel.id).length, 1); assert.equal(view.agreements[0].nextDate, '2026-11-02');
}));
test('earlier request references existing booked order without overwriting its confirmed slot', async () => fixture(async ({ request, repository }) => {
  const { customer, vessel } = await setupVessel(request); let order = await createOrder(request, input({ customerId: customer.id, vesselId: vessel.id }));
  await repository.transact(state => { const stored = state.transport.orders.find(value => value.id === order.id); Object.assign(stored, { status: 'booked', date: '2026-11-02', startMinute: 600, driverId: 'kalle', vehicleId: 'vehicle-kalle' }); const detail = state.logistics.details[order.id]; detail.assignedDriverId = 'kalle'; detail.assignedVehicleId = 'vehicle-kalle'; detail.confirmedWindow = { date: '2026-11-02', from: '10:00' }; });
  const login = await account(request, 'customer', customer.id), result = await request('/api/customer/requests', { vesselId: vessel.id, type: 'earlier', existingOrderId: order.id, requestedDate: '2026-10-20', comment: 'Önskar tidigare', idempotencyKey: randomUUID() }, null, login.cookie); assert.equal(result.status, 200, result.error);
  const pending = result.orders.find(value => value.id === order.id); assert.equal(pending.date, '2026-11-02'); assert.equal(pending.detail.confirmedWindow.date, '2026-11-02');
  const accepted = await request(officePath, { action: 'request.respond', requestId: result.request.id, expectedVersion: result.request.version, accepted: true }); assert.equal(accepted.status, 200, accepted.error); assert.equal(accepted.orders.find(value => value.id === order.id).date, '2026-11-02'); assert.equal(accepted.orders.find(value => value.id === order.id).requestedDate, '2026-10-20');
}));
test('carrier can propose and accept a wish, and only assign its own active people and vehicles', async () => fixture(async ({ request }) => {
  const office = await request(), carrier = office.carriers[0], login = await account(request, 'carrier', carrier.id); let order = await createOrder(request, input({ operator: 'external', carrierId: carrier.id, requestedWindow: { date: '2026-11-02', from: '09:00', to: '12:00' } }));
  assert.equal((await request('/api/carrier/state', undefined, null, login.cookie)).orders.length, 0);
  order = await commandOrder(request, order, 'order.send');
  let result = await request('/api/carrier/actions', { action: 'request.respond', orderId: order.id, expectedVersion: order.detail.version, response: 'propose', window: { date: '2026-11-03' } }, null, login.cookie); assert.equal(result.status, 200, result.error); order = result.orders.find(value => value.id === order.id); assert.equal(order.detail.confirmedWindow, undefined); assert.equal(order.detail.requestedWindow.date, '2026-11-02');
  order = await commandOrder(request, order, 'order.confirmTime', { window: { date: '2026-11-03', from: '11:00' } });
  assert.equal((await request('/api/carrier/actions', { action: 'order.assign', orderId: order.id, expectedVersion: order.detail.version, driverId: 'kalle', vehicleId: 'vehicle-kalle' }, null, login.cookie)).status, 403);
  result = await request('/api/carrier/actions', { action: 'order.assign', orderId: order.id, expectedVersion: order.detail.version, driverId: 'oskar', vehicleId: 'vehicle-oskar' }, null, login.cookie); assert.equal(result.status, 200, result.error); order = result.orders.find(value => value.id === order.id); assert.equal(order.status, 'unbooked'); assert.equal(order.detail.assignedDriverId, 'oskar');
}));
test('normal submitted yard stock is projected once and reconciles later weight edits without financial dependency', async () => fixture(async ({ request, repository, instance }) => {
  const articles = (await request()).articles, article = articles.find(article => !article.hazardous), sourceId = randomUUID();
  await repository.transact(state => state.office.cards.push({ id: 9010, sourceId, siteId: 'norrtalje', status: 'new', yard: 'Norrtälje', date: '2026-10-10', rows: [{ articleId: article.id, weight: 100 }] }));
  const before = await request(); assert.equal(before.stock.find(row => row.articleId === article.id).onHandKg, 100);
  assert.equal((await (await instance()).request()).stock.find(row => row.articleId === article.id).onHandKg, 100);
  await repository.transact(state => { state.office.cards[0].rows[0].weight = 90; });
  const changed = await request(); assert.equal(changed.stock.find(row => row.articleId === article.id).onHandKg, 90); assert.equal(changed.inventoryMovements.filter(row => row.sourceId === sourceId).length, 2);
}));
test('hazard stock comes solely from genuine environmental movements and cannot be manually invented', async () => fixture(async ({ request, inventory, repository }) => {
  await repository.transact(state => state.office.cards.push({ id: 9010, sourceId: randomUUID(), siteId: 'norrtalje', status: 'new', yard: 'Norrtälje', date: '2026-10-10', rows: [{ articleId: 'lead-battery', weight: 100 }] }));
  assert.ok(!(await request()).stock.some(row => row.articleId === 'lead-battery'));
  inventory.push({ id: randomUUID(), articleId: 'lead-battery', siteId: 'norrtalje', wasteCode: '160601', weight: 100, receivedAt: '2026-10-10', classification: classifications[0] });
  assert.equal((await request()).stock.find(row => row.articleId === 'lead-battery').onHandKg, 100); assert.equal((await request()).stock.find(row => row.articleId === 'lead-battery').onHandKg, 100);
  assert.equal((await request(officePath, { action: 'inventory.adjust', siteId: 'norrtalje', articleId: 'lead-battery', kg: 50, reason: 'Öppningslager', idempotencyKey: randomUUID() })).status, 422);
}));
test('outbound reservations are atomic and cancellation frees them without a stock movement', async () => fixture(async ({ request, instance }) => {
  const article = (await request()).articles.find(article => !article.hazardous); assert.equal((await request(officePath, { action: 'inventory.adjust', siteId: 'norrtalje', articleId: article.id, kg: 100, reason: 'Öppningslager', idempotencyKey: randomUUID() })).status, 200);
  const body = { action: 'order.create', input: input({ action: 'outbound', materialRows: [{ articleId: article.id, plannedKg: 80 }] }), idempotencyKey: randomUUID() }, second = (await instance()).request;
  const results = await Promise.all([request(officePath, body), second(officePath, { ...body, idempotencyKey: randomUUID() })]); assert.equal(results.filter(value => value.status === 200).length, 1); assert.equal(results.filter(value => value.status === 422).length, 1);
  const result = results.find(value => value.status === 200), order = result.orders.find(order => order.id === result.result.orderId); const row = result.stock.find(row => row.articleId === article.id); assert.equal(row.onHandKg, 100); assert.equal(row.reservedKg, 80);
  await commandOrder(request, order, 'order.cancel', { reason: 'Ingen körning behövs' }); const final = await request(); assert.equal(final.stock.find(row => row.articleId === article.id).availableKg, 100); assert.equal(final.inventoryMovements.length, 1);
}));
test('hazard departure blocks stale documents, needs weights/signatures/clearance and deducts once', async () => fixture(async ({ request, repository, inventory }) => {
  inventory.push({ id: randomUUID(), articleId: 'lead-battery', siteId: 'norrtalje', wasteCode: '160601', weight: 100, receivedAt: '2026-10-10', classification: classifications[0] });
  let order = await createOrder(request, input({ action: 'outbound', materialRows: [{ articleId: 'lead-battery', plannedKg: 50 }], assignedDriverId: 'kalle', assignedVehicleId: 'vehicle-kalle' }));
  const person = await repository.transact(state => structuredClone(state.personnel.people.find(person => person.driverId === 'kalle')));
  const drive = async (action, extra = {}) => repository.transact((state, _, changes) => applyDriverAction(state, person, order.id, { action, expectedVersion: state.logistics.details[order.id].version, ...extra }, changes));
  order = await drive('travel.empty'); assert.equal(order.detail.execution.stage, 'travelling_empty'); assert.equal((await request()).stock[0].onHandKg, 100);
  await assert.rejects(drive('depart'), /frigöra/); order = await drive('load', { rows: [{ articleId: 'lead-battery', actualKg: 48 }] }); order = await commandOrder(request, order, 'order.clearance', { cleared: true });
  await assert.rejects(drive('depart'), /transportdokument/); order = await commandOrder(request, order, 'order.document'); const version = order.detail.document.version;
  order = await commandOrder(request, order, 'order.sign', { role: 'sender', documentVersion: version }); await assert.rejects(drive('depart'), /godkänna/);
  order = await drive('sign', { documentVersion: version }); order = await drive('load', { rows: [{ articleId: 'lead-battery', actualKg: 49 }] }); assert.equal(order.detail.document, undefined); assert.equal(order.detail.execution.officeCleared, false);
  await assert.rejects(drive('sign', { documentVersion: version }), /ändrats/);
  order = await commandOrder(request, order, 'order.document'); assert.ok(order.detail.document.version > version);
  order = await commandOrder(request, order, 'order.sign', { role: 'sender', documentVersion: order.detail.document.version }); order = await drive('sign', { documentVersion: order.detail.document.version }); order = await commandOrder(request, order, 'order.clearance', { cleared: true });
  order = await drive('depart'); assert.equal(order.detail.execution.stage, 'departed'); assert.equal((await request()).stock.find(row => row.articleId === 'lead-battery').onHandKg, 51);
  await drive('depart'); assert.equal((await request()).inventoryMovements.filter(row => row.kind === 'outbound').length, 1);
  const capacity = await repository.transact(state => logisticsOutboundInventory(state)); assert.equal(capacity[0].weight, -49);
}));
test('placement changes only on completed delivery, and driver/legacy visibility stays scoped', async () => fixture(async ({ request, repository }) => {
  const { customer, vessel } = await setupVessel(request); const saved = await request(officePath, { action: 'vessel.save', vessel: { id: `C-${randomUUID()}`, name: 'Ersättningskärl', type: 'battery', siteId: 'norrtalje' }, expectedVersion: 0 }); const replacement = saved.vessels.find(value => value.id !== vessel.id); let order = await createOrder(request, input({ action: 'exchange', customerId: customer.id, vesselId: vessel.id, replacementVesselId: replacement.id, assignedDriverId: 'kalle', assignedVehicleId: 'vehicle-kalle' }));
  order = await commandOrder(request, order, 'order.clearance', { cleared: true }); order = await commandOrder(request, order, 'order.depart'); let current = await request(); assert.equal(current.vessels.find(value => value.id === vessel.id).customerId, customer.id); assert.equal(current.vessels.find(value => value.id === replacement.id).customerId, undefined);
  order = await commandOrder(request, order, 'order.deliver'); current = await request(); assert.equal(current.vessels.find(value => value.id === vessel.id).status, 'available'); assert.equal(current.vessels.find(value => value.id === replacement.id).customerId, customer.id);
  await repository.transact(state => { const kalle = state.personnel.people.find(person => person.driverId === 'kalle'), oskar = state.personnel.people.find(person => person.driverId === 'oskar'); assert.equal(driverOrderView(state, oskar, state.transport.orders.find(value => value.id === order.id)), undefined); const legacy = state.transport.orders.find(value => value.driverId === 'oskar' && !state.logistics.details[value.id]); assert.equal(driverOrderView(state, kalle, legacy), undefined); assert.ok(driverOrderView(state, oskar, legacy)); });
}));
test('planner cannot bypass managed external or departure flows and stale revisions are rejected', async () => fixture(async ({ request, repository }) => {
  let order = await createOrder(request, input()); const stale = structuredClone(order); order = await commandOrder(request, order, 'order.clearance', { cleared: true }); assert.equal((await request(officePath, { action: 'order.cancel', orderId: stale.id, expectedVersion: stale.detail.version, reason: 'Föråldrad' })).status, 409);
  await repository.transact(state => { const base = structuredClone(state.transport), next = structuredClone(base); next.orders.find(value => value.id === order.id).status = 'done'; assert.throws(() => validateLogisticsTransportChange(state, base, next), /avfärds/); });
}));
test('PostgreSQL multiple instances preserve authentication and atomic reservations', { skip: !process.env.JEROC_TEST_DATABASE_URL }, async () => fixture(async ({ request, instance }) => {
  const { customer, vessel } = await setupVessel(request); const login = await account(request, 'customer', customer.id), second = (await instance()).request;
  const body = { vesselId: vessel.id, type: 'pickup', requestedDate: '2026-10-20', comment: 'Hämta', idempotencyKey: randomUUID() };
  const responses = await Promise.all([request('/api/customer/requests', body, null, login.cookie), second('/api/customer/requests', body, null, login.cookie)]); assert.ok(responses.every(value => value.status === 200)); assert.equal(responses[0].request.id, responses[1].request.id); assert.equal((await second()).requests.length, 1);
}, true));

test('removing an incoming article reverses its ordinary warehouse projection once', async () => fixture(async ({ request, repository }) => {
  const article = (await request()).articles.find(article => !article.hazardous), sourceId = randomUUID();
  await repository.transact(state => state.office.cards.push({ id: 9010, sourceId, siteId: 'norrtalje', date: '2026-10-10', rows: [{ articleId: article.id, weight: 100 }] }));
  assert.equal((await request()).stock.find(row => row.articleId === article.id).onHandKg, 100);
  await repository.transact(state => { state.office.cards[0].rows = []; });
  assert.equal((await request()).stock.find(row => row.articleId === article.id).onHandKg, 0);
  assert.equal((await request()).inventoryMovements.filter(row => row.sourceId === sourceId).length, 2);
}));
test('a scoped office account cannot provision a global customer portal login', async () => fixture(async ({ request, repository }) => {
  const { customer } = await setupVessel(request);
  await repository.transact(state => { const user = state.pricing.users.find(user => user.id === 'kajsa'); user.level = 'Medarbetare'; user.permissions = ['customerAccounts']; user.siteIds = ['norrtalje']; });
  const response = await request(officePath, { action: 'account.save', account: { kind: 'customer', subjectId: customer.id, username: 'global.customer', active: true, password: 'TestPassword-2026!' } }, 'kajsa'); assert.equal(response.status, 403);
  assert.equal((await request()).accounts.length, 0);
}));
test('carrier assignment acceptance does not silently confirm its requested time and prepared mail remains durable', async () => fixture(async ({ request, instance }) => {
  const carrier = (await request()).carriers[0], login = await account(request, 'carrier', carrier.id); let order = await createOrder(request, input({ operator: 'external', carrierId: carrier.id, requestedWindow: { date: '2026-11-02' } })); order = await commandOrder(request, order, 'order.send');
  const accepted = await request('/api/carrier/actions', { action: 'request.respond', orderId: order.id, expectedVersion: order.detail.version, response: 'accept' }, null, login.cookie); assert.equal(accepted.status, 200, accepted.error); order = accepted.orders.find(value => value.id === order.id); assert.equal(order.detail.confirmedWindow, undefined); assert.equal(order.detail.requestedWindow.date, '2026-11-02');
  const second = await (await instance()).request(); assert.equal(second.deliveryOutbox.length, 1); assert.equal(second.deliveryOutbox[0].deliveryEnabled, false); assert.equal(second.deliveryOutbox[0].recipient, carrier.email); assert.equal(second.deliveryOutbox[0].status, 'prepared');
  order = await commandOrder(request, order, 'order.cancel', { reason: 'Ingen transport' }); assert.equal((await request()).deliveryOutbox[0].status, 'cancelled');
}));
test('agreement action permissions reject a pickup that is not covered', async () => fixture(async ({ request }) => {
  const { customer, vessel } = await setupVessel(request); const agreement = { id: randomUUID(), customerId: customer.id, siteId: vessel.siteId, vesselId: vessel.id, active: true, action: 'exchange', intervalDays: 14, nextDate: '2026-11-02', notes: 'Endast byte', allowedActions: ['exchange'] };
  assert.equal((await request(officePath, { action: 'agreement.save', agreement, expectedVersion: 0 })).status, 200); const login = await account(request, 'customer', customer.id);
  const rejected = await request('/api/customer/requests', { vesselId: vessel.id, type: 'pickup', requestedDate: '2026-10-20', comment: '', idempotencyKey: randomUUID() }, null, login.cookie); assert.equal(rejected.status, 422); assert.equal((await request()).requests.length, 0);
}));
test('rolling exchange rebinds the vessel and creates the next occurrence; an extra exchange preserves its schedule', async () => fixture(async ({ request }) => {
  const { customer, vessel } = await setupVessel(request, { materialArticleId: undefined });
  const savedReplacement = await request(officePath, { action: 'vessel.save', vessel: { id: `C-${randomUUID()}`, name: 'Byte', type: 'battery', siteId: 'norrtalje' }, expectedVersion: 0 }); const replacement = savedReplacement.vessels.find(value => value.id !== vessel.id);
  const agreement = { id: randomUUID(), customerId: customer.id, siteId: vessel.siteId, vesselId: vessel.id, active: true, action: 'exchange', intervalDays: 14, nextDate: '2026-11-02', notes: 'Rullande', kind: 'rolling', allowedActions: ['exchange','pickup'] };
  const saved = await request(officePath, { action: 'agreement.save', agreement, expectedVersion: 0 }); let order = saved.orders.find(value => value.id === saved.result.orderId);
  const assignInput = (originalVessel, replacementId) => input({ action: 'exchange', customerId: customer.id, vesselId: originalVessel, replacementVesselId: replacementId, agreementId: agreement.id, assignedDriverId: 'kalle', assignedVehicleId: 'vehicle-kalle' });
  order = await commandOrder(request, order, 'order.edit', { input: assignInput(vessel.id, replacement.id) }); order = await commandOrder(request, order, 'order.clearance', { cleared: true }); order = await commandOrder(request, order, 'order.depart'); await commandOrder(request, order, 'order.deliver');
  let current = await request(), recurring = current.orders.find(value => value.detail.agreementId === agreement.id && value.status === 'unbooked'); assert.ok(recurring); assert.equal(current.agreements[0].nextDate, '2026-11-16'); assert.equal(current.agreements[0].vesselId, replacement.id); assert.equal(recurring.detail.vesselId, replacement.id);
  const login = await account(request, 'customer', customer.id), extra = await request('/api/customer/requests', { vesselId: replacement.id, type: 'exchange', requestedDate: '2026-11-05', comment: 'Extra', idempotencyKey: randomUUID() }, null, login.cookie); assert.equal(extra.status, 200, extra.error);
  const accepted = await request(officePath, { action: 'request.respond', requestId: extra.request.id, expectedVersion: extra.request.version, accepted: true }); recurring = accepted.orders.find(value => value.id === extra.request.orderId);
  recurring = await commandOrder(request, recurring, 'order.edit', { input: assignInput(replacement.id, vessel.id) }); recurring = await commandOrder(request, recurring, 'order.clearance', { cleared: true }); recurring = await commandOrder(request, recurring, 'order.depart'); await commandOrder(request, recurring, 'order.deliver');
  current = await request(); assert.equal(current.agreements[0].nextDate, '2026-11-16'); assert.equal(current.orders.filter(value => value.detail.agreementId === agreement.id && value.status === 'unbooked').length, 1);
}));

test('new work-order rights do not bypass transport planning and exchange requires a replacement vessel', async () => fixture(async ({ request, repository }) => {
  const { customer, vessel } = await setupVessel(request, { materialArticleId: undefined }); let order = await createOrder(request, input({ action: 'exchange', customerId: customer.id, vesselId: vessel.id, assignedDriverId: 'kalle', assignedVehicleId: 'vehicle-kalle' }));
  await repository.transact(state => { const user = state.pricing.users.find(user => user.id === 'kajsa'); user.level = 'Medarbetare'; user.permissions = ['workOrdersRead', 'workOrdersWrite']; });
  const blocked = await request(officePath, { action: 'order.book', orderId: order.id, expectedVersion: order.detail.version, plan: { date: '2026-11-02', startMinute: 600, durationMinutes: 60, driverId: 'kalle', vehicleId: 'vehicle-kalle' } }, 'kajsa'); assert.equal(blocked.status, 403);
  assert.equal((await request(officePath, { action: 'order.confirmTime', orderId: order.id, expectedVersion: order.detail.version, window: { date: '2026-11-03' } })).status, 422);
  order = await commandOrder(request, order, 'order.clearance', { cleared: true }); const departure = await request(officePath, { action: 'order.depart', orderId: order.id, expectedVersion: order.detail.version }); assert.equal(departure.status, 422); assert.match(departure.error, /ersättningskärl/);
}));
test('the synchronized warehouse revision advances only when physical source quantities change', async () => fixture(async ({ request, repository }) => {
  const first = await request(), article = first.articles.find(article => !article.hazardous);
  await repository.transact(state => state.office.cards.push({ id: 9010, sourceId: randomUUID(), siteId: 'norrtalje', date: '2026-10-10', rows: [{ articleId: article.id, weight: 10 }] }));
  const updated = await request(); assert.ok(updated.revision > first.revision); assert.equal((await request()).revision, updated.revision);
}));

test('a completed workflow without an internal calendar slot remains a valid shared transport record', async () => fixture(async ({ request, repository }) => {
  let order = await createOrder(request, input({ action: 'placement', assignedDriverId: 'kalle', assignedVehicleId: 'vehicle-kalle' })); order = await commandOrder(request, order, 'order.clearance', { cleared: true }); order = await commandOrder(request, order, 'order.depart'); await commandOrder(request, order, 'order.deliver');
  const carrier = (await request()).carriers[0], login = await account(request, 'carrier', carrier.id); let external = await createOrder(request, input({ action: 'placement', operator: 'external', carrierId: carrier.id })); external = await commandOrder(request, external, 'order.send');
  const accepted = await request('/api/carrier/actions', { action: 'request.respond', orderId: external.id, expectedVersion: external.detail.version, response: 'accept' }, null, login.cookie); assert.equal(accepted.status, 200, accepted.error); external = accepted.orders.find(value => value.id === external.id);
  const assigned = await request('/api/carrier/actions', { action: 'order.assign', orderId: external.id, expectedVersion: external.detail.version, driverId: 'oskar', vehicleId: 'vehicle-oskar' }, null, login.cookie); assert.equal(assigned.status, 200, assigned.error); external = assigned.orders.find(value => value.id === external.id);
  external = await commandOrder(request, external, 'order.clearance', { cleared: true }); external = await commandOrder(request, external, 'order.depart'); await commandOrder(request, external, 'order.deliver');
  await repository.transact(state => {
    const parsed = transportSchema.safeParse(state.transport); assert.equal(parsed.success, true, parsed.error?.message);
    for (const id of [order.id, external.id]) { const completed = state.transport.orders.find(value => value.id === id); assert.equal(completed.status, 'done'); assert.equal(completed.date, undefined); assert.equal(completed.driverId, undefined); }
    const base = structuredClone(state.transport), next = structuredClone(base); next.orders.push({ ...next.orders.find(value => value.id === order.id), id: 'AO-fabricated' }); assert.throws(() => validateLogisticsTransportChange(state, base, next), /kringgå/);
  });
}));
test('legacy planner cannot add external or fabricated final orders before logistics initialization', async () => fixture(async ({ repository }) => {
  await repository.transact(state => {
    assert.equal(state.logistics, undefined); const base = structuredClone(state.transport), template = base.orders[0];
    for (const changes of [{ operator: 'external', status: 'unbooked' }, { action: 'outbound', status: 'unbooked' }, { operator: 'own', status: 'done' }]) { const next = structuredClone(base); next.orders.push({ ...template, ...changes, id: 'AO-fabricated' }); assert.throws(() => validateLogisticsTransportChange(state, base, next)); }
    const changed = structuredClone(base); changed.orders[0].action = 'outbound'; assert.throws(() => validateLogisticsTransportChange(state, base, changed), /utleverans/);
    const normal = structuredClone(base); normal.orders.push({ ...template, status: 'unbooked', id: 'AO-normal' }); assert.doesNotThrow(() => validateLogisticsTransportChange(state, base, normal));
  });
}));
