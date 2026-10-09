import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService } from './application.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';
import { recordPayment } from '../dist-server/domain-models.mjs';

const office = '/api/application/office';
const preparer = { id: 'price-preparer', name: 'Prisberäkning utan prisändring', level: 'Medarbetare',
  permissions: ['view', 'prepare', 'prices', 'priceA', 'priceB', 'priceC', 'customerPrices', 'paymentDetails', 'verifyId', 'customerApprovalRead'],
  maxAttest: 0, ownAttest: false };

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-review-projection-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  let postgres, schema;
  const connectionString = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
  if (connectionString) {
    const { Pool } = await import('pg'); postgres = new Pool({ connectionString });
    schema = `jeroc_review_projection_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(connectionString); connection.searchParams.set('options', `-c search_path=${schema}`);
    env.DATABASE_URL = connection.toString();
  }
  const terminalRepository = await createTerminalDemoRepository({ env, filename: join(directory, 'terminal.sqlite') });
  let terminal; const apps = [], servers = [];
  async function instance() {
    const app = createApplicationService({ env, approvalProvider: () => terminal.projections() }); apps.push(app);
    const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost'))); servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    async function api(path, input, actor = 'admin') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-actor': actor, 'x-demo-user': actor }, body: input === undefined ? undefined : JSON.stringify(input) });
      return { status: response.status, ...await response.json() };
    }
    return { app, api };
  }
  const first = await instance();
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: first.app.principalStore });
  const staff = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const users = (await first.api('/api/pricing/state')).users;
  assert.equal((await first.api('/api/pricing/users', { users: [...users, preparer] })).status, 200);
  const prepareSession = (await terminal.staffSession({ actualUserId: preparer.id, effectiveUserId: preparer.id })).token;
  const device = await terminal.createTerminal({ name: 'Testterminal', username: 'review-test', password: 'local-test-only', siteId: 'norrtalje' }, staff);
  const login = await terminal.login({ username: 'review-test', password: 'local-test-only' });
  async function save(base, next, actor) { const result = await first.api(office, { base, next }, actor); assert.equal(result.status, 200, result.error); return result.data; }
  async function pendingCard() {
    const base = (await first.api(office)).data, next = structuredClone(base), card = next.cards.find(card => card.id === 2053);
    Object.assign(card, { status: 'complement', customerId: 'customer-build', origin: 'Testgatan 12, 761 41 Norrtälje', reference: 'Granskning',
      payment: 'Kontant', paymentDetails: { method: 'cash' }, financialPending: true, pricingRowsPending: true,
      rows: [{ articleId: 'copper-1', weight: 72, tier: 'C', price: 1, pricePending: true }] });
    await save(base, next); return { card: structuredClone(card), customer: next.customers.find(c => c.id === card.customerId) };
  }
  async function send(input) {
    const snapshot = await first.api('/api/pricing/snapshots', { cardId: input.card.id, customerId: input.card.customerId, deliveredAt: input.card.date,
      rows: input.card.rows.map(row => ({ articleId: row.articleId, weight: row.weight })) }, preparer.id);
    assert.equal(snapshot.status, 201, snapshot.error);
    const rows = snapshot.rows.map(row => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier, pricePending: false }));
    return terminal.send({ card: { ...input.card, rows, pricingSnapshotId: snapshot.id, pricingTotal: snapshot.total, financialPending: false, pricingRowsPending: false },
      customer: input.customer, terminalId: device.id, siteId: 'norrtalje', offset: 0, correctionIds: [], idempotencyKey: randomUUID(),
      rows: rows.map(row => ({ articleId: row.articleId, name: row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })) }, prepareSession);
  }
  async function approve(review) {
    await terminal.respond(review.id, { action: 'id_requested', termsAccepted: true }, login.token);
    await terminal.confirmId(review.id, prepareSession);
  }
  try { await run({ ...first, instance, terminal, staff, prepareSession, save, pendingCard, send, approve }); }
  finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const app of apps) await app.close(); await terminalRepository.close();
    if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('genuine first customer review binds pending prices and the frozen snapshot once, then supports attest/payment across instances', async () => fixture(async f => {
  const input = await f.pendingCard(), review = await f.send(input);
  assert.equal(review.snapshot.rows[0].price, 84);
  let current = (await f.api(office, undefined, preparer.id)).data.cards.find(c => c.id === input.card.id);
  assert.equal(current.status, 'customer'); assert.equal(current.rows[0].price, 84); assert.equal(current.rows[0].tier, 'Eget');
  assert.equal(current.rows[0].pricePending, false); assert.equal(current.financialPending, false); assert.equal(current.pricingRowsPending, false);
  assert.equal(current.pricingSnapshotId, review.snapshot.card.pricingSnapshotId); assert.equal(current.pricingTotal, 6048);
  assert.equal(current.preparedBy, preparer.id);
  assert.equal(current.audit.filter(event => event.text.includes('fryst och visad')).length, 1);
  await f.approve(review); assert.equal((await f.api(office)).data.cards.find(c => c.id === input.card.id).status, 'attest');
  const base = (await f.api(office)).data, tampered = structuredClone(base); tampered.cards.find(c => c.id === input.card.id).rows[0].price = 85;
  tampered.cards.find(c => c.id === input.card.id).status = 'complement'; assert.equal((await f.api(office, { base, next: tampered })).status, 409);
  await f.terminal.attest(review.id, f.staff);
  const ready = (await f.api(office)).data, admin = ready.users.find(user => user.id === 'admin');
  await f.save(ready, recordPayment(ready, input.card.id, { user: admin, actualUser: admin }, { method: 'cash' }, 'Testjournal'));
  const other = await f.instance(), paid = (await other.api(office)).data.cards.find(c => c.id === input.card.id);
  assert.equal(paid.status, 'paid'); assert.equal(paid.rows[0].price, 84); assert.equal(paid.pricingSnapshotId, review.snapshot.card.pricingSnapshotId);
  assert.equal(paid.approvedBy, 'admin');
  assert.equal(paid.audit.filter(event => event.text.includes('fryst och visad')).length, 1);
  assert.equal(paid.audit.filter(event => event.text.includes('Kundgodkännande version')).length, 1);
  assert.equal(paid.audit.filter(event => event.text.includes('internt attesterad')).length, 1);
  assert.equal(paid.audit.filter(event => event.text.includes('Demoutbetalning')).length, 1);
  const users = (await f.api('/api/pricing/state')).users.map(user => user.id === preparer.id ? { ...user, permissions: user.permissions.filter(right => right !== 'customerPrices') } : user);
  assert.equal((await f.api('/api/pricing/users', { users })).status, 200);
  const hidden = (await f.api(office, undefined, preparer.id)).data.cards.find(c => c.id === input.card.id);
  assert.equal(hidden.rows[0].price, 0); assert.equal(hidden.rows[0].pricePending, true); assert.equal(hidden.pricingTotal, undefined);
  assert.equal((await f.api(office)).data.cards.find(c => c.id === input.card.id).rows[0].price, 84);
}));

test('attested save-to-balance review is projected directly into saldo without a payment journal', async () => fixture(async f => {
  const original = await f.pendingCard(), base = (await f.api(office)).data, next = structuredClone(base);
  const card = next.cards.find(c => c.id === original.card.id); card.paymentDetails = { method: 'balance' }; card.payment = 'Spara på saldo';
  await f.save(base, next);
  const review = await f.send({ ...original, card }); await f.approve(review); await f.terminal.attest(review.id, f.staff);
  const data = (await f.api(office)).data, held = data.cards.find(c => c.id === card.id);
  assert.equal(held.status, 'balance'); assert.equal(held.approvedBy, 'admin'); assert.equal(held.pricingTotal, 6048);
  assert.equal(data.payments.filter(payment => payment.cardId === held.id).length, 0);
}));

test('a review of stale quantities or reference does not overwrite the newer current draft', async () => fixture(async f => {
  const input = await f.pendingCard(), base = (await f.api(office)).data, edited = structuredClone(base);
  const card = edited.cards.find(c => c.id === input.card.id); card.rows[0].weight = 73; card.reference = 'Kassa 2 ändrade';
  await f.save(base, edited); const review = await f.send(input); await f.approve(review);
  const current = (await f.api(office)).data.cards.find(c => c.id === input.card.id);
  assert.equal(current.rows[0].weight, 73); assert.equal(current.rows[0].price, 1); assert.equal(current.reference, 'Kassa 2 ändrade');
  assert.equal(current.status, 'complement'); assert.equal(current.idVerified, false); assert.equal(current.pricingSnapshotId, undefined);
}));

test('later editing a shown review cannot cause an old snapshot to silently replace the changed price', async () => fixture(async f => {
  const input = await f.pendingCard(), review = await f.send(input), base = (await f.api(office)).data, edited = structuredClone(base);
  const card = edited.cards.find(c => c.id === input.card.id); card.rows[0].price = 85; card.status = 'complement';
  await f.save(base, edited); await f.approve(review);
  const current = (await f.api(office)).data.cards.find(c => c.id === input.card.id);
  assert.equal(current.rows[0].price, 85); assert.equal(current.status, 'complement'); assert.equal(current.idVerified, false);
  assert.equal(current.customerApproval.id, review.id);
}));
