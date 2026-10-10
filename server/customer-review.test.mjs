import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-compound-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  let pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = `jeroc_compound_${randomUUID().replaceAll('-', '')}`; await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = url.toString();
  }
  const repository = await createApplicationRepository({ env, seed: initialApplicationState });
  let terminal, rejectCommit = false;
  const wrapped = { ...repository, transact: (operation, options) => repository.transact(async (...args) => {
    const result = await operation(...args); if (rejectCommit) throw new Error('forced rollback'); return result;
  }, options) };
  const app = createApplicationService({ env, repository: wrapped, projections: cardId => terminal.projections(cardId),
    sendCustomerReview: (payload, principal) => terminal.send(payload, undefined, principal) });
  const terminalRepository = await createTerminalDemoRepository({ env, filename: join(directory, 'terminal.sqlite') });
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: app.principalStore });
  const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function api(path, data, actor = 'admin') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': actor, 'X-Demo-User': actor }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, ...await response.json() };
  }
  const staff = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const device = await terminal.createTerminal({ name: 'Compound test', username: 'compound-test', password: 'local-test-only', siteId: 'norrtalje' }, staff);
  await terminal.login({ username: 'compound-test', password: 'local-test-only' });
  async function card(id = 2053) {
    const base = (await api('/api/application/office')).data, next = structuredClone(base), card = next.cards.find(card => card.id === id);
    Object.assign(card, { status: 'complement', customerId: 'customer-build', origin: 'Testgatan 12, 76141 Norrtälje', reference: '',
      payment: 'Kontant', paymentDetails: { method: 'cash' }, financialPending: true, pricingRowsPending: true,
      rows: [{ articleId: 'copper-1', weight: 72, tier: 'C', price: 1, pricePending: true }] });
    assert.equal((await api('/api/application/office', { base, next })).status, 200);
    return (await api('/api/application/office')).data.cards.find(value => value.id === id);
  }
  const command = card => ({ cardId: card.id, expectedCard: card, terminalId: device.id, siteId: 'norrtalje', idempotencyKey: randomUUID() });
  try { await run({ api, card, command, terminal, staff, repository, postgres: Boolean(pool), rejectCommit: value => { rejectCommit = value; } }); }
  finally {
    await new Promise(resolve => server.close(resolve)); await app.close(); await terminalRepository.close();
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('one review command freezes canonical prices and replays the same session without another snapshot', async () => fixture(async f => {
  const input = f.command(await f.card());
  const first = await f.api('/api/application/customer-review', input);
  assert.equal(first.status, 200, first.error); assert.equal(first.cardProjection.status, 'customer');
  assert.equal(first.cardProjection.rows[0].price, 84); assert.equal(first.approval.snapshot.gross, 6048);
  const again = await f.api('/api/application/customer-review', input);
  assert.equal(again.status, 200, again.error); assert.equal(again.approval.id, first.approval.id);
  assert.equal((await f.api('/api/pricing/snapshots?cardId=2053')).snapshots.length, 1);
  const changedKey = { ...input, terminalId: 'different-terminal' };
  assert.equal((await f.api('/api/application/customer-review', changedKey)).status, 409);
  await f.terminal.cancel(first.approval.id, f.staff);
  const cancelled = await f.api('/api/application/customer-review', input);
  assert.equal(cancelled.status, 200); assert.equal(cancelled.approval.status, 'cancelled');
  const live = await f.api('/api/application/office');
  assert.equal(cancelled.revision, live.revision);
  const resend = await f.api('/api/application/customer-review', f.command(live.data.cards.find(card => card.id === input.cardId)));
  assert.equal(resend.status, 200, resend.error); assert.equal(resend.approval.version, 2);
  assert.equal(resend.cardProjection.pricingSnapshotId, first.cardProjection.pricingSnapshotId);
}));

test('stale quantities and missing origin are rejected before freezing or reserving', async () => fixture(async f => {
  const card = await f.card(), stale = structuredClone(card); stale.rows[0].weight = 73;
  assert.equal((await f.api('/api/application/customer-review', f.command(stale))).status, 409);
  const base = (await f.api('/api/application/office')).data, next = structuredClone(base); next.cards.find(c => c.id === card.id).origin = '';
  assert.equal((await f.api('/api/application/office', { base, next })).status, 200);
  const missing = (await f.api('/api/application/office')).data.cards.find(c => c.id === card.id);
  assert.equal((await f.api('/api/application/customer-review', f.command(missing))).status, 422);
  assert.equal((await f.api('/api/pricing/snapshots?cardId=2053')).snapshots.length, 0);
  assert.equal((await f.terminal.projections()).length, 0);
}));

test('busy terminal rolls back the newly frozen price snapshot and leaves the second card open', async () => fixture(async f => {
  const first = await f.card(), second = await f.card(2052);
  assert.equal((await f.api('/api/application/customer-review', f.command(first))).status, 200);
  const busy = await f.api('/api/application/customer-review', f.command(second));
  assert.equal(busy.status, 409, busy.error); assert.match(busy.error, /upptagen/i);
  assert.equal((await f.api('/api/pricing/snapshots?cardId=2052')).snapshots.length, 0);
  const unchanged = (await f.api('/api/application/office')).data.cards.find(c => c.id === second.id);
  assert.equal(unchanged.status, 'complement'); assert.equal(unchanged.rows[0].price, 1);
}));

test('PostgreSQL failure after terminal reservation rolls back both repositories', async t => fixture(async f => {
  if (!f.postgres) { t.skip('Requires isolated PostgreSQL'); return; }
  const input = f.command(await f.card()); f.rejectCommit(true);
  assert.equal((await f.api('/api/application/customer-review', input)).status, 503); f.rejectCommit(false);
  assert.equal((await f.terminal.projections()).length, 0);
  assert.equal((await f.api('/api/pricing/snapshots?cardId=2053')).snapshots.length, 0);
  assert.equal((await f.api('/api/application/customer-review', input)).status, 200);
}));
