import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';
import { ensureLogistics } from './logistics.mjs';

const office = '/api/application/office', material = `${office}/material`;
const users = [
  ['weight-only', ['weighingEditWeight']], ['remove-only', ['weighingRemoveArticle']],
  ['add-only', ['weighingAddArticle']], ['quantity-editor', ['weighingEditWeight', 'weighingRemoveArticle', 'weighingAddArticle']],
].map(([id, rights]) => ({ id, name: id, level: 'Medarbetare', permissions: ['view', ...rights], maxAttest: 0, ownAttest: false }));
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-material-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  let pool, schema;
  const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
  if (postgresUrl) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: postgresUrl });
    schema = `jeroc_material_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = url.toString();
  }
  const repository = await createApplicationRepository({ env, seed: initialApplicationState });
  const terminalRepository = await createTerminalDemoRepository({ env, filename: join(directory, 'terminal.sqlite') });
  let terminal, rejectCommit = false;
  const recorded = new Set(), wrapped = { ...repository,
    transact: (operation, options) => repository.transact(async (...args) => {
      const result = await operation(...args); if (rejectCommit) throw new Error('forced material rollback'); return result;
    }, options) };
  const app = createApplicationService({ env, repository: wrapped, projections: cardId => terminal.projections(cardId),
    sendCustomerReview: (payload, identity) => terminal.send(payload, undefined, identity),
    withMaterialChangeApproval: (input, identity, operation) => terminal.withMaterialChangeApproval(input, identity, operation),
    guardMaterialChange: (input, operation) => {
      if (recorded.has(input.sourceId)) throw Object.assign(new Error('Mottagningen är registrerad. Använd rättelseflödet.'), { status: 409 });
      return operation();
    } });
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: app.principalStore });
  const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function api(path, input, actor = 'admin') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: input === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor, 'X-Demo-User': actor },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  }
  const seedUsers = (await api('/api/pricing/state')).users;
  assert.equal((await api('/api/pricing/users', { users: [...seedUsers, ...users] })).status, 200);
  const staff = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const device = await terminal.createTerminal({ name: 'Material test', username: 'material-test', password: 'local-test-only', siteId: 'norrtalje' }, staff);
  const login = await terminal.login({ username: 'material-test', password: 'local-test-only' });
  const card = async (actor = 'admin', id = 2053) => (await api(office, undefined, actor)).data.cards.find(value => value.id === id);
  const command = (card, patch) => ({ cardId: card.id, expectedRows: card.rows, ...patch });
  async function review() {
    await repository.transact(state => {
      const row = state.office.cards.find(value => value.id === 2053);
      Object.assign(row, { status: 'complement', origin: 'Testgatan 12, 761 41 Norrtälje', customerId: 'customer-build',
        payment: 'Kontant', paymentDetails: { method: 'cash' }, rows: [{ articleId: 'copper-1', weight: 72, price: 0, tier: 'C', pricePending: true }] });
    });
    const response = await api('/api/application/customer-review', { cardId: 2053, expectedCard: await card(), terminalId: device.id,
      siteId: 'norrtalje', idempotencyKey: randomUUID() });
    assert.equal(response.status, 200, response.error); return response;
  }
  try { await run({ api, card, command, repository, terminal, staff, login, device, recorded, review, postgres: Boolean(pool), rejectCommit: value => { rejectCommit = value; } }); }
  finally {
    await new Promise(resolve => server.close(resolve)); await app.close(); await terminalRepository.close();
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('material rights are independent and zero weight requires both edit and removal rights', async () => fixture(async f => {
  const start = await f.card('weight-only');
  const edited = await f.api(material, f.command(start, { operation: 'weight', rowIndex: 0, weight: 80 }), 'weight-only');
  assert.equal(edited.status, 200, edited.error); assert.equal(edited.cardProjection.rows[0].weight, 80);
  assert.equal(edited.cardProjection.rows[0].price, 0); assert.equal(edited.cardProjection.pricingTotal, undefined);
  assert.equal((await f.api(material, f.command(edited.cardProjection, { operation: 'weight', rowIndex: 0, weight: 0 }), 'weight-only')).status, 403);
  assert.equal((await f.api(material, f.command(await f.card('remove-only'), { operation: 'weight', rowIndex: 0, weight: 81 }), 'remove-only')).status, 403);
  assert.equal((await f.api(material, f.command(await f.card('add-only'), { operation: 'remove', rowIndex: 0 }), 'add-only')).status, 403);
  const zero = await f.api(material, f.command(await f.card('quantity-editor'), { operation: 'weight', rowIndex: 0, weight: 0 }), 'quantity-editor');
  assert.equal(zero.status, 200, zero.error); assert.equal(zero.cardProjection.rows.length, 0);
  assert.match(zero.cardProjection.audit.at(-1).text, /80 kg → 0 kg/);
  const added = await f.api(material, f.command(zero.cardProjection, { operation: 'add', articleId: 'iron', weight: 4 }), 'quantity-editor');
  assert.equal(added.status, 200, added.error); assert.equal(added.cardProjection.rows[0].articleId, 'iron');
  const removed = await f.api(material, f.command(await f.card('remove-only'), { operation: 'remove', rowIndex: 0 }), 'remove-only');
  assert.equal(removed.status, 200, removed.error); assert.equal(removed.cardProjection.rows.length, 0);
}));

test('physical material commands persist incoming stock corrections atomically, without relying on a later logistics GET', async () => fixture(async f => {
  const sourceId = randomUUID();
  await f.repository.transact(state => {
    const card = state.office.cards.find(card => card.id === 2053); card.sourceId = sourceId; card.siteId = 'norrtalje';
    ensureLogistics(state, { sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], classifications: [] });
  });
  const ledger = () => f.repository.read(state => structuredClone(state.logistics.inventoryMovements.filter(row => row.sourceId === sourceId)));
  const original = await ledger(); assert.equal(original.reduce((sum, row) => sum + row.kg, 0), 72);
  const start = await f.card();
  const edited = await f.api(material, f.command(start, { operation: 'weight', rowIndex: 0, weight: 80 }));
  assert.equal(edited.status, 200, edited.error);
  assert.deepEqual((await ledger()).map(row => row.kg), [72, 8]);
  f.rejectCommit(true);
  assert.equal((await f.api(material, f.command(edited.cardProjection, { operation: 'weight', rowIndex: 0, weight: 90 }))).status, 503);
  f.rejectCommit(false);
  assert.deepEqual((await ledger()).map(row => row.kg), [72, 8]);
  assert.equal((await f.card()).rows[0].weight, 80);
  const removed = await f.api(material, f.command(await f.card(), { operation: 'weight', rowIndex: 0, weight: 0 }));
  assert.equal(removed.status, 200, removed.error);
  assert.deepEqual((await ledger()).map(row => row.kg), [72, 8, -80]);
  assert.equal((await ledger()).reduce((sum, row) => sum + row.kg, 0), 0);
}));

test('mobile submission records normal incoming physical stock in the weighing commit exactly once', async () => fixture(async f => {
  await f.repository.transact(state => ensureLogistics(state, { sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], classifications: [] }));
  const path = '/api/application/mobile', base = (await f.api(path)).data, next = structuredClone(base), sourceId = randomUUID();
  next.drafts.push({ id: sourceId, number: 1418, mode: 'direct', status: 'ready', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    reference: 'Lager från mobil', origin: 'Testgatan 1', rows: [{ id: randomUUID(), articleId: 'copper-1', method: 'direct', weight: 15 }] });
  const submitted = await f.api(path, { base, next }); assert.equal(submitted.status, 200, submitted.error);
  assert.equal((await f.api(path, { base, next })).status, 200);
  const saved = await f.repository.read(state => structuredClone(state));
  assert.equal(saved.office.cards.filter(card => card.sourceId === sourceId).length, 1);
  assert.deepEqual(saved.logistics.inventoryMovements.filter(row => row.sourceId === sourceId).map(row => row.kg), [15]);
}));

test('quantity commands reject stale or tampered input and recompute authoritative volume prices and totals', async () => fixture(async f => {
  await f.repository.transact(state => Object.assign(state.office.cards.find(value => value.id === 2053), {
    customerId: 'customer-build', rows: [{ articleId: 'lead-battery', weight: 10, price: 3.6, tier: 'C', source: 'Volympris C' }] }));
  const before = await f.card();
  assert.equal((await f.api(material, f.command(before, { operation: 'add', articleId: 'not-in-the-register', weight: 10 }))).status, 422);
  assert.equal((await f.api(material, { ...f.command(before, { operation: 'weight', rowIndex: 0, weight: 100 }), price: 999 })).status, 422);
  const response = await f.api(material, f.command(before, { operation: 'weight', rowIndex: 0, weight: 100 }));
  assert.equal(response.status, 200, response.error); assert.equal(response.cardProjection.rows[0].tier, 'A');
  assert.equal(response.cardProjection.rows[0].price, 4.5); assert.equal(response.cardProjection.pricingTotal, 450);
  assert.equal(response.cardProjection.idVerified, false); assert.equal(response.cardProjection.pricingSnapshotId, undefined);
  assert.equal((await f.api(material, f.command(before, { operation: 'remove', rowIndex: 0 }))).status, 409);
  const current = await f.card();
  assert.equal((await f.api(material, f.command(current, { operation: 'weight', rowIndex: 0, weight: -1 }))).status, 422);
  const users = (await f.api('/api/pricing/state')).users.map(user => user.id === 'quantity-editor' ? { ...user, siteIds: ['rimbo'] } : user);
  assert.equal((await f.api('/api/pricing/users', { users })).status, 200);
  assert.equal((await f.api(material, f.command(current, { operation: 'remove', rowIndex: 0 }), 'quantity-editor')).status, 403);
}));

test('generic saves cannot conceal replacements or weight changes behind a shorter row list', async () => fixture(async f => {
  await f.repository.transact(state => { state.office.cards.find(value => value.id === 2053).rows.push({ articleId: 'iron', weight: 5, tier: 'C', price: 0, pricePending: true }); });
  const base = (await f.api(office, undefined, 'remove-only')).data, next = structuredClone(base);
  const row = next.cards.find(value => value.id === 2053); row.rows.shift(); row.rows[0].weight = 10;
  assert.equal((await f.api(office, { base, next }, 'remove-only')).status, 403);
  const addBase = (await f.api(office, undefined, 'add-only')).data, replaced = structuredClone(addBase);
  replaced.cards.find(value => value.id === 2053).rows[0].articleId = 'brass';
  assert.equal((await f.api(office, { base: addBase, next: replaced }, 'add-only')).status, 403);
  const weightBase = (await f.api(office, undefined, 'weight-only')).data;
  for (const patch of [{ manualOverride: true }, { source: 'Eget pris' }, { pricePending: false }]) {
    const tampered = structuredClone(weightBase);
    Object.assign(tampered.cards.find(value => value.id === 2053).rows[0], patch);
    assert.equal((await f.api(office, { base: weightBase, next: tampered }, 'weight-only')).status, 403);
  }
}));

test('editing a pending or approved review cancels terminal display, keeps its original and requires a new review', async () => fixture(async f => {
  for (const approved of [false, true]) {
    const sent = await f.review();
    if (approved) {
      await f.terminal.respond(sent.approval.id, { action: 'id_requested', termsAccepted: true }, f.login.token);
      await f.terminal.confirmId(sent.approval.id, f.staff);
    }
    const original = structuredClone((await f.terminal.documentProjections()).find(value => value.id === sent.approval.id));
    const response = await f.api(material, f.command(await f.card('weight-only'), { operation: 'weight', rowIndex: 0, weight: 73 }), 'weight-only');
    assert.equal(response.status, 200, response.error); assert.equal(response.cardProjection.status, 'complement');
    assert.equal(response.cardProjection.idVerified, false); assert.equal(response.cardProjection.customerApproval.status, 'cancelled');
    assert.equal(response.cardProjection.pricingSnapshotId, undefined); assert.equal(response.approval.snapshot, undefined);
    const saved = (await f.terminal.documentProjections()).find(value => value.id === original.id);
    assert.equal(saved.status, 'cancelled'); assert.deepEqual(saved.snapshot, original.snapshot);
    assert.deepEqual(saved.approvedHash, original.approvedHash); assert.deepEqual(saved.approvedAt, original.approvedAt);
    assert.equal((await f.terminal.projections()).find(value => value.id === original.id).status, 'cancelled');
    assert.match(response.cardProjection.audit.at(-1).text, /kundgodkännande återkallat/);
  }
}));

test('registered receipt or internal attest blocks quantity commands without cancelling the approved original', async () => fixture(async f => {
  const sent = await f.review();
  await f.terminal.respond(sent.approval.id, { action: 'id_requested', termsAccepted: true }, f.login.token);
  await f.terminal.confirmId(sent.approval.id, f.staff);
  const approved = await f.card(); f.recorded.add(approved.sourceId);
  assert.equal((await f.api(material, f.command(approved, { operation: 'remove', rowIndex: 0 }))).status, 409);
  assert.equal((await f.terminal.projections()).find(value => value.id === sent.approval.id).status, 'approved');
  assert.equal((await f.card()).rows[0].weight, approved.rows[0].weight);
  f.recorded.clear(); await f.terminal.attest(sent.approval.id, f.staff);
  assert.equal((await f.api(material, f.command(await f.card(), { operation: 'weight', rowIndex: 0, weight: 90 }))).status, 409);
  assert.equal((await f.terminal.projections()).find(value => value.id === sent.approval.id).status, 'attested');
}));

test('PostgreSQL commit failure rolls back material edits and terminal cancellation together', async t => fixture(async f => {
  if (!f.postgres) { t.skip('Requires isolated PostgreSQL'); return; }
  const sent = await f.review(), card = await f.card(); f.rejectCommit(true);
  assert.equal((await f.api(material, f.command(card, { operation: 'weight', rowIndex: 0, weight: 99 }))).status, 503);
  f.rejectCommit(false);
  assert.equal((await f.card()).rows[0].weight, card.rows[0].weight);
  assert.equal((await f.terminal.projections()).find(value => value.id === sent.approval.id).status, 'waiting');
}));
