import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService } from './application.mjs';
import { createPricingStore } from './pricing.mjs';

const mobile = '/api/application/mobile', office = '/api/application/office';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-customer-sync-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  let pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `jeroc_customer_sync_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = url.toString();
  }
  const app = createApplicationService({ env }), server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = async (path, payload, user = 'admin') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: payload ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-demo-actor': user, 'x-demo-user': user }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: response.status, ...await response.json() };
  };
  try { await run({ app, api }); }
  finally { await new Promise(resolve => server.close(resolve)); await app.close();
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true }); }
}
const customer = (patch = {}) => ({ id: randomUUID(), name: 'Formatprov AB', type: 'Företag', number: '559359-3626',
  phone: '0722002220', email: 'test@example.invalid', address: 'Testgatan 1, 761 41 Norrtälje',
  references: [], origins: [], vatRegistered: false, ...patch });
const draft = (patch = {}) => ({ id: randomUUID(), siteId: 'norrtalje', number: 1, mode: 'direct', status: 'draft',
  createdAt: '2026-10-12T09:00:00Z', updatedAt: '2026-10-12T09:00:00Z', reference: '', origin: '',
  rows: [{ id: randomUUID(), articleId: 'lead-battery', method: 'direct', weight: 70 }], ...patch });
const records = (draftChanges = [], customerChanges = []) => ({ kind: 'records', version: 1, drafts: draftChanges, customers: customerChanges });

test('new mobile bank profile is canonical, retries once and stays out of general customer projections', async () => fixture(async ({ api }) => {
  const value = customer({ paymentProfile: { method: 'bank', bankType: 'bankgiro', holder: 'Testmottagare', bankgiro: '123-4566', clearing: '8327', account: '00001234567' } });
  const input = records([], [{ id: value.id, next: value }]);
  const created = await api(mobile, input); assert.equal(created.status, 200, created.error);
  assert.equal(created.data.customers.find(row => row.id === value.id).paymentProfile, undefined);
  const saved = (await api(office)).data.customers.find(row => row.id === value.id);
  assert.deepEqual(saved.paymentProfile, { method: 'bank', bankType: 'bankgiro', holder: 'Testmottagare', bankgiro: '1234566' });
  const retry = await api(mobile, input); assert.equal(retry.status, 200, retry.error);
  assert.deepEqual((await api(office)).data.customers.find(row => row.id === value.id).audit, saved.audit);
}));

test('mobile bank profiles require their own permission and wrong checksum rolls back a new customer', async () => fixture(async ({ app, api }) => {
  await api(mobile); const repo = await app.getRepository();
  await repo.transact(state => {
    state.pricing.users.find(user => user.id === 'kajsa').permissions = ['view', 'prepare', 'customers'];
  });
  const value = customer({ paymentProfile: { method: 'bank', bankType: 'plusgiro', holder: 'Testmottagare', plusgiro: '123455' } });
  const forbidden = await api(mobile, records([], [{ id: value.id, next: value }]), 'kajsa');
  assert.equal(forbidden.status, 403, forbidden.error);
  assert.ok(!(await api(office)).data.customers.some(row => row.id === value.id));
  const imported = await api(mobile, { kind: 'import', data: { version: 1, drafts: [], customers: [value] } }, 'kajsa');
  assert.equal(imported.status, 200, imported.error); assert.ok(imported.importConflicts > 0);
  assert.ok(!(await api(office)).data.customers.some(row => row.id === value.id));
  const invalid = customer({ paymentProfile: { method: 'bank', bankType: 'bankgiro', holder: 'Testmottagare', bankgiro: '1234567' } });
  const rejected = await api(mobile, records([], [{ id: invalid.id, next: invalid }]));
  assert.equal(rejected.status, 422, rejected.error); assert.match(rejected.error, /kontrollsiffra/);
  assert.ok(!(await api(office)).data.customers.some(row => row.id === invalid.id));
}));

test('office card bank fields normalize only changed instructions and reject invalid recipients atomically', async () => fixture(async ({ api }) => {
  const base = (await api(office)).data, next = structuredClone(base);
  next.cards[0].paymentDetails = { method: 'bank', bankType: 'iban', holder: 'Testmottagare', iban: 'se45 5000 0000 0583 9825 7466',
    bic: 'swedsess', clearing: '8327', account: '00001234567' };
  const saved = await api(office, { base, next }); assert.equal(saved.status, 200, saved.error);
  const stored = saved.data.cards[0].paymentDetails;
  assert.deepEqual(stored, { method: 'bank', bankType: 'iban', holder: 'Testmottagare', iban: 'SE4550000000058398257466', bic: 'SWEDSESS' });
  const invalid = structuredClone(saved.data); invalid.cards[0].paymentDetails.iban = 'SE4550000000058398257467';
  const rejected = await api(office, { base: saved.data, next: invalid }); assert.equal(rejected.status, 422);
  assert.deepEqual((await api(office)).data.cards[0].paymentDetails, stored);
}));

test('mobile customer save canonicalizes identity/address/phone and preserves explicit VAT false and office-only economy', async () => fixture(async ({ app, api }) => {
  const value = customer();
  const created = await api(mobile, records([], [{ id: value.id, next: value }]));
  assert.equal(created.status, 200, created.error);
  const saved = created.data.customers.find(row => row.id === value.id);
  assert.equal(saved.number, '5593593626'); assert.equal(saved.phone, '+46722002220');
  assert.equal(saved.address, 'Testgatan 1'); assert.equal(saved.postalCode, '76141'); assert.equal(saved.city, 'Norrtälje');
  assert.equal(saved.countryCode, 'SE'); assert.equal(saved.vatRegistered, false);
  const repo = await app.getRepository();
  await repo.transact(state => Object.assign(state.office.customers.find(row => row.id === value.id), {
    paymentTermDays: 45, contactPerson: 'Ekonomikontakt', paymentProfile: { method: 'swish', phone: '+46722002220' } }));
  const next = { ...saved, phone: '0701112233' };
  const edited = await api(mobile, records([], [{ id: value.id, base: saved, next }]));
  assert.equal(edited.status, 200, edited.error);
  const stored = (await api(office)).data.customers.find(row => row.id === value.id);
  assert.equal(stored.phone, '+46701112233'); assert.equal(stored.vatRegistered, false);
  assert.equal(stored.paymentTermDays, 45); assert.equal(stored.contactPerson, 'Ekonomikontakt');
  assert.deepEqual(stored.paymentProfile, { method: 'swish', phone: '+46722002220' });
}));

test('invalid organization identifiers are rejected before a customer or its mobile weighing is committed', async () => fixture(async ({ api }) => {
  const value = customer({ number: '55935936261' }), weighing = draft({ status: 'ready', customerId: value.id });
  const result = await api(mobile, records([{ id: weighing.id, next: weighing }], [{ id: value.id, next: value }]));
  assert.equal(result.status, 422); assert.match(result.error, /10 siffror/);
  const stored = await api(mobile);
  assert.ok(!stored.data.customers.some(row => row.id === value.id)); assert.ok(!stored.data.drafts.some(row => row.id === weighing.id));
}));

test('new customer and ready mobile weighing are priced together without a snapshot/ledger replay', async () => fixture(async ({ app, api }) => {
  const value = customer(), weighing = draft({ status: 'ready', customerId: value.id,
    reference: '  Projekt   Solen  ', origin: 'Testgatan 1, 761 41 Norrtälje' });
  const input = records([{ id: weighing.id, next: weighing }], [{ id: value.id, next: value }]);
  const saved = await api(mobile, input); assert.equal(saved.status, 200, saved.error);
  const projection = (await api(office)).data, card = projection.cards.find(row => row.sourceId === weighing.id);
  const quote = await api('/api/pricing/quote', { customerId: value.id, deliveredAt: weighing.updatedAt,
    excludeCardId: String(card.id), rows: weighing.rows.map(({ articleId, weight }) => ({ articleId, weight })) });
  assert.equal(quote.status, 200, quote.error);
  assert.equal(card.rows[0].price, quote.rows[0].price); assert.equal(card.rows[0].tier, quote.rows[0].tier);
  assert.equal(card.pricingTotal, quote.total); assert.equal(card.financialPending, false); assert.equal(card.pricingRowsPending, false);
  assert.equal(card.rows[0].pricePending, false); assert.equal(card.pricingSnapshotId, undefined);
  assert.deepEqual(card.originDetails, { address: 'Testgatan 1', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' });
  const before = await (await app.getRepository()).read(state => ({ ledger: state.pricing.ledger.length, snapshots: state.pricing.snapshots.length }));
  const replayed = await api(mobile, input); assert.equal(replayed.status, 200, replayed.error);
  const after = await (await app.getRepository()).read(state => ({ ledger: state.pricing.ledger.length, snapshots: state.pricing.snapshots.length }));
  assert.deepEqual(after, before);
  const latest = (await api(office)).data;
  assert.equal(latest.cards.filter(row => row.sourceId === weighing.id).length, 1);
  assert.deepEqual(latest.customers.find(row => row.id === value.id).origins, ['Testgatan 1, 76141 Norrtälje']);
  assert.deepEqual(latest.customers.find(row => row.id === value.id).references, ['Projekt Solen']);
}));

test('automatic mobile pricing uses delivery date and excludes the same card from historic customer volume', async () => fixture(async ({ app, api }) => {
  await api(mobile); const repo = await app.getRepository();
  const number = await repo.transact(state => {
    const pricing = createPricingStore({ initialState: state.pricing });
    pricing.snapshot({ cardId: 'previous-delivery', customerId: 'customer-build', deliveredAt: '2026-10-10', rows: [{ articleId: 'lead-battery', weight: 40 }] }, pricing.principal('admin'));
    pricing.snapshot({ cardId: String(state.metadata.nextCard), customerId: 'customer-build', deliveredAt: '2026-10-11', rows: [{ articleId: 'lead-battery', weight: 500 }] }, pricing.principal('admin'));
    state.pricing = pricing.exportState(); return state.metadata.nextCard;
  });
  const weighing = draft({ status: 'ready', customerId: 'customer-build' });
  const saved = await api(mobile, records([{ id: weighing.id, next: weighing }])); assert.equal(saved.status, 200, saved.error);
  const card = (await api(office)).data.cards.find(row => row.sourceId === weighing.id);
  assert.equal(card.id, number);
  assert.equal(card.rows[0].volumeBefore, 40); assert.equal(card.rows[0].volumeWithDelivery, 110);
  assert.equal(card.rows[0].tier, 'A');
}));

test('missing historic LME leaves a clearly pending weighing while restricted offices never receive calculated prices', async () => fixture(async ({ app, api }) => {
  const pricingState = await api('/api/pricing/state');
  const unpriced = { ...pricingState.articleHistory[0], id: 'missing-tin-reference', name: 'Saknat referenspris',
    base: { type: 'lme', metal: 'tin' }, effectiveFrom: '2026-10-10', active: true };
  assert.equal((await api('/api/pricing/articles', unpriced)).status, 200);
  await (await app.getRepository()).transact(state => { state.pricing.lme = state.pricing.lme.filter(row => row.metal !== 'tin'); });
  const pending = draft({ status: 'ready', customerId: 'customer-build', rows: [{ id: randomUUID(), articleId: unpriced.id, method: 'direct', weight: 12 }] });
  assert.equal((await api(mobile, records([{ id: pending.id, next: pending }]))).status, 200);
  const pendingCard = (await api(office)).data.cards.find(row => row.sourceId === pending.id);
  assert.equal(pendingCard.rows[0].weight, 12); assert.equal(pendingCard.rows[0].pricePending, true);
  assert.equal(pendingCard.pricingTotal, undefined); assert.match(pendingCard.pricingPendingReason, /LME-pris saknas/);
  const priced = draft({ status: 'ready', customerId: 'customer-build' });
  assert.equal((await api(mobile, records([{ id: priced.id, next: priced }]))).status, 200);
  const state = await api('/api/pricing/state');
  assert.equal((await api('/api/pricing/users', { users: state.users.map(row => row.id === 'kajsa' ? { ...row, permissions: ['view', 'prepare'] } : row) })).status, 200);
  const hidden = (await api(office, undefined, 'kajsa')).data.cards.find(row => row.sourceId === priced.id);
  assert.equal(hidden.pricingRedacted, true); assert.equal(hidden.rows[0].price, 0); assert.equal(hidden.pricingTotal, undefined);
  assert.equal(hidden.pricingRowsPending, false); assert.equal(hidden.pricingPendingReason, undefined);
  assert.ok((await api(office)).data.cards.find(row => row.sourceId === priced.id).rows[0].price > 0);
}));

test('customer choices are remembered on explicit mobile save, never on vehicle-like partial typing, and deduplicate retries', async () => fixture(async ({ api }) => {
  const value = customer(), weighing = draft({ customerId: value.id });
  let saved = await api(mobile, records([{ id: weighing.id, next: weighing }], [{ id: value.id, next: value }]));
  assert.equal(saved.status, 200, saved.error);
  let previous = saved.data.drafts.find(row => row.id === weighing.id);
  let next = { ...previous, origin: 'Te', reference: 'Pr' };
  saved = await api(mobile, records([{ id: next.id, base: previous, next }])); assert.equal(saved.status, 200, saved.error);
  assert.deepEqual(saved.data.customers.find(row => row.id === value.id).origins, []);
  assert.deepEqual(saved.data.customers.find(row => row.id === value.id).references, []);
  previous = saved.data.drafts.find(row => row.id === weighing.id);
  next = { ...previous, origin: 'Testgatan 1, 761 41 Norrtälje', reference: 'Projekt Solen', customerSelectionsSavedAt: '2026-10-12T09:05:00Z' };
  const command = records([{ id: next.id, base: previous, next }]);
  saved = await api(mobile, command); assert.equal(saved.status, 200, saved.error);
  assert.equal((await api(mobile, command)).status, 200);
  previous = saved.data.drafts.find(row => row.id === weighing.id);
  next = { ...previous, origin: 'testgatan 1, 76141 norrtälje', reference: 'projekt solen', customerSelectionsSavedAt: '2026-10-12T09:06:00Z' };
  saved = await api(mobile, records([{ id: next.id, base: previous, next }])); assert.equal(saved.status, 200, saved.error);
  const result = saved.data.customers.find(row => row.id === value.id);
  assert.deepEqual(result.origins, ['Testgatan 1, 76141 Norrtälje']); assert.deepEqual(result.references, ['Projekt Solen']);
}));

test('office saves remember choices atomically and canonicalize Swish without accepting invalid mobile phone numbers', async () => fixture(async ({ api }) => {
  const base = (await api(office)).data, next = structuredClone(base), card = next.cards[0];
  card.origin = 'Testgatan 2, 761 41 Norrtälje'; card.reference = 'Kontorsreferens';
  card.paymentDetails = { method: 'swish', phone: '0722002220' };
  const saved = await api(office, { base, next }); assert.equal(saved.status, 200, saved.error);
  const stored = saved.data.cards.find(row => row.id === card.id);
  assert.equal(stored.paymentDetails.phone, '+46722002220');
  const result = saved.data.customers.find(row => row.id === card.customerId);
  assert.ok(result.origins.includes('Testgatan 2, 76141 Norrtälje')); assert.ok(result.references.includes('Kontorsreferens'));
  const retry = await api(office, { base, next }); assert.equal(retry.status, 200, retry.error);
  assert.deepEqual(retry.data.customers, saved.data.customers);
  const invalid = structuredClone(saved.data); invalid.cards[0].paymentDetails.phone = '018123456';
  const rejected = await api(office, { base: saved.data, next: invalid }); assert.equal(rejected.status, 422); assert.match(rejected.error, /mobilnummer/);
}));

test('payment-only rights can update a customer Swish profile without changing contact/economy permissions', async () => fixture(async ({ api }) => {
  const pricing = await api('/api/pricing/state');
  assert.equal((await api('/api/pricing/users', { users: pricing.users.map(row => row.id === 'kajsa' ?
    { ...row, permissions: ['view', 'paymentDetails'] } : row) })).status, 200);
  const base = (await api(office, undefined, 'kajsa')).data, next = structuredClone(base);
  next.customers[0].paymentProfile = { method: 'swish', phone: '0722002220' };
  const saved = await api(office, { base, next }, 'kajsa'); assert.equal(saved.status, 200, saved.error);
  assert.equal(saved.data.customers[0].paymentProfile.phone, '+46722002220');
  const forbidden = structuredClone(saved.data); forbidden.customers[0].vatRegistered = true;
  assert.equal((await api(office, { base: saved.data, next: forbidden }, 'kajsa')).status, 403);
}));

test('derived origin fields cannot mutate an attested original or append choices from a rejected save', async () => fixture(async ({ app, api }) => {
  await api(office);
  await (await app.getRepository()).transact(state => { state.office.cards[0].status = 'ready'; });
  const base = (await api(office)).data, next = structuredClone(base), original = structuredClone(base.cards[0]);
  next.cards[0].originDetails = { address: 'Annan gata 1', postalCode: '12345', city: 'Stockholm', countryCode: 'SE' };
  const result = await api(office, { base, next }); assert.equal(result.status, 409);
  const stored = (await api(office)).data;
  assert.deepEqual(stored.cards[0], original); assert.deepEqual(stored.customers, base.customers);
}));

test('legacy transport saves canonicalize changed address/phone fields and keep partial or invalid writes out', async () => fixture(async ({ app, api }) => {
  // This legacy all-transport endpoint intentionally requires all facilities.
  // Give this fixture that scope after startup migration, not production users.
  await (await app.getRepository()).transact(state => { delete state.pricing.users.find(user => user.id === 'admin').siteIds; });
  const path = '/api/application/transport', base = (await api(path)).data, next = structuredClone(base), order = next.orders[0];
  order.address = 'Testgatan 1, 761 41 Norrtälje'; order.city = 'Norrtälje'; order.phone = '0722002220';
  const saved = await api(path, { base, next }); assert.equal(saved.status, 200, saved.error);
  const result = saved.data.orders.find(row => row.id === order.id);
  assert.equal(result.address, 'Testgatan 1'); assert.equal(result.postalCode, '76141'); assert.equal(result.city, 'Norrtälje');
  assert.equal(result.countryCode, 'SE'); assert.equal(result.phone, '+46722002220');
  const changed = structuredClone(saved.data); changed.orders.find(row => row.id === order.id).address = 'Annan gata 2, 123 45 Stockholm';
  const moved = await api(path, { base: saved.data, next: changed }); assert.equal(moved.status, 200, moved.error);
  const movedOrder = moved.data.orders.find(row => row.id === order.id);
  assert.equal(movedOrder.address, 'Annan gata 2'); assert.equal(movedOrder.postalCode, '12345'); assert.equal(movedOrder.city, 'Stockholm');
  const invalid = structuredClone(moved.data); invalid.orders.find(row => row.id === order.id).phone = 'inte ett telefonnummer';
  const rejected = await api(path, { base: moved.data, next: invalid }); assert.equal(rejected.status, 422); assert.match(rejected.error, /telefonnummer/);
  assert.deepEqual((await api(path)).data, moved.data);
}));
