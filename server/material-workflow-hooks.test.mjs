import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';

const reject = (operation, code) => assert.rejects(operation, error => error.code === code);
const customer = { id: 'customer-build', name: 'Testkund AB', type: 'Företag', number: '5560000167', customerNumber: 'K-1001', phone: '', email: '',
  paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Testkund AB' } };
const origin = 'Testgatan 12, 761 41 Norrtälje';
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-material-hooks-'));
  let options = { env: {} }, postgres, schema;
  const url = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
  if (url) {
    const { Pool } = await import('pg'); postgres = new Pool({ connectionString: url });
    schema = `jeroc_material_hooks_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(url); connection.searchParams.set('options', `-c search_path=${schema}`);
    options = { env: { DATABASE_URL: connection.toString() } };
  }
  const clock = () => new Date('2026-10-11T10:00:00Z');
  const pricing = createPricingStore({ now: clock });
  const terminalRepository = await createTerminalDemoRepository({ ...options, filename: join(directory, 'terminal.sqlite') });
  const environmentRepository = await createEnvironmentRepository({ ...options, filename: join(directory, 'environment.sqlite') });
  let terminal;
  const environment = createEnvironmentStore({ repository: environmentRepository, principalStore: pricing, now: clock,
    approvalGuard: (input, callback) => terminal.withApprovedCard(input, callback) });
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: pricing, now: clock,
    siteProvider: () => environment.catalog(), environmentApprovalCheck: approval => environment.assertReceiptForAttest(approval) });
  try {
    const admin = (await terminal.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
    const environmentAdmin = (await environment.demoSession({ userId: 'admin' })).token;
    const t = await terminal.createTerminal({ name: 'Testterminal', username: 'testterminal', password: 'terminal-test-only', siteId: 'norrtalje' }, admin);
    const device = await terminal.login({ username: t.username, password: 'terminal-test-only' });
    const payload = (cardId, articleId = 'copper-1', sourceId = randomUUID()) => {
      const priced = pricing.snapshot({ cardId, customerId: customer.id, deliveredAt: '2026-10-11T09:00:00Z', rows: [{ articleId, weight: 10 }],
        supersedesSnapshotId: pricing.snapshots(pricing.principal('admin'), cardId).at(-1)?.id }, pricing.principal('admin'));
      const rows = priced.rows.map(row => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
      return { card: { id: cardId, sourceId, siteId: 'norrtalje', customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: '2026-10-11T09:00:00Z',
        reference: '', origin, pricingSnapshotId: priced.id, rows, audit: [] }, customer, terminalId: t.id, siteId: 'norrtalje',
        rows: rows.map(row => ({ articleId: row.articleId, name: row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
        offset: 0, correctionIds: [], idempotencyKey: randomUUID() };
    };
    const command = (request, approval, extra = {}) => ({ cardId: request.card.id, sourceId: request.card.sourceId, siteId: 'norrtalje', expectedRows: request.card.rows,
      operation: 'weight', weight: 11, ...(approval && { approvalId: approval.id }), ...extra });
    const approve = async approval => { await terminal.respond(approval.id, { action: 'id_requested', termsAccepted: true }, device.token); return terminal.confirmId(approval.id, admin); };
    const rights = permissions => pricing.saveUsers({ users: pricing.read(pricing.principal('admin')).users.map(user => user.id === 'kajsa' ? { ...user, permissions } : user) }, pricing.principal('admin'));
    const receipt = request => ({ sourceId: request.card.sourceId, cardId: request.card.id, siteId: 'norrtalje', materialScope: 'hazardous', receivedAt: '2026-10-11T09:00:00Z',
      rows: request.card.rows.map(({ articleId, weight }) => ({ articleId, weight })), originAddress: origin,
      previousHolder: { name: customer.name, number: customer.number, contactName: '', email: '', phone: '' }, lastPlace: place, nextPlace: { ...place, address: 'Ängsvägen 19' },
      transportMode: 'road', incomingDocument: { status: 'not_shown' }, idempotencyKey: randomUUID() });
    await operation({ terminal, environment, pricing, terminalRepository, environmentRepository, admin, environmentAdmin, device, payload, command, approve, rights, receipt });
  } finally {
    terminal.close(); await terminalRepository.close(); await environmentRepository.close();
    if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('material rights invalidate an approved version without prepare or money rights and preserve its frozen history', () => fixture(async f => {
  const request = f.payload(9901), approval = await f.terminal.send(request, f.admin);
  await f.approve(approval);
  const before = (await f.terminal.documentProjections()).find(item => item.id === approval.id);
  const jobs = await f.terminalRepository.documentJobs();
  f.rights(['weighingEditWeight']);
  let changed = false;
  const cancelled = await f.terminal.withMaterialChangeApproval(f.command(request, approval), { actorId: 'kajsa', userId: 'kajsa' }, ({ cancel }) =>
    f.environment.guardMaterialChange(f.command(request, approval), () => { changed = true; return cancel(); }));
  assert.equal(changed, true); assert.equal(cancelled.status, 'cancelled');
  const after = (await f.terminal.documentProjections()).find(item => item.id === approval.id);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(after.approvedAt, before.approvedAt); assert.equal(after.approvedHash, before.approvedHash);
  assert.deepEqual((await f.terminalRepository.documentJobs()).map(job => job.id), jobs.map(job => job.id));
  assert.equal((await f.terminal.session(f.device.token)).approval, null);
  await reject(() => f.terminal.withMaterialChangeApproval(f.command(request, approval, { weight: 0 }), { actorId: 'kajsa', userId: 'kajsa' }, ({ cancel }) => cancel()), 'forbidden');
  f.rights(['weighingEditWeight', 'weighingRemoveArticle']);
  assert.equal((await f.terminal.withMaterialChangeApproval(f.command(request, approval, { weight: 0 }), { actorId: 'kajsa', userId: 'kajsa' }, ({ cancel }) => cancel())).status, 'cancelled');
  f.rights(['weighingRemoveArticle']);
  await reject(() => f.terminal.withMaterialChangeApproval(f.command(request, approval), { actorId: 'kajsa', userId: 'kajsa' }, ({ cancel }) => cancel()), 'forbidden');
}));

test('material changes reject superseded approval identity, attested versions and terminal confirmation racing cancellation', () => fixture(async f => {
  const request = f.payload(9902), first = await f.terminal.send(request, f.admin);
  await f.terminal.cancel(first.id, f.admin);
  const second = await f.terminal.send({ ...request, idempotencyKey: randomUUID() }, f.admin);
  await reject(() => f.terminal.withMaterialChangeApproval(f.command(request, first), { actorId: 'admin', userId: 'admin' }, ({ cancel }) => cancel()), 'stale_approval');
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; }), releasePromise = new Promise(resolve => { release = resolve; });
  const editing = f.terminal.withMaterialChangeApproval(f.command(request, second), { actorId: 'admin', userId: 'admin' }, async ({ cancel }) => { entered(); await releasePromise; return cancel(); });
  await enteredPromise;
  const responding = f.terminal.respond(second.id, { action: 'id_requested', termsAccepted: true }, f.device.token);
  release(); assert.equal((await editing).status, 'cancelled');
  await assert.rejects(responding, error => error.status === 409);
  const third = await f.terminal.send({ ...request, idempotencyKey: randomUUID() }, f.admin);
  await f.approve(third); await f.terminal.attest(third.id, f.admin);
  await reject(() => f.terminal.withMaterialChangeApproval(f.command(request, third), { actorId: 'admin', userId: 'admin' }, ({ cancel }) => cancel()), 'card_locked');
}));

test('registered hazardous receipt blocks material edits before cancelling approval, including removing its final hazardous row', () => fixture(async f => {
  const request = f.payload(9903, 'lead-battery'), approval = await f.terminal.send(request, f.admin);
  await f.approve(approval);
  const receipt = await f.environment.receive(f.receipt(request), f.environmentAdmin);
  let changed = false;
  await reject(() => f.terminal.withMaterialChangeApproval(f.command(request, approval, { operation: 'remove' }), { actorId: 'admin', userId: 'admin' }, ({ cancel }) =>
    f.environment.guardMaterialChange(f.command(request, approval), () => { cancel(); changed = true; })), 'environment_receipt_locked');
  assert.equal(changed, false);
  assert.equal((await f.terminal.documentProjections()).find(item => item.id === approval.id).status, 'approved');
  assert.equal((await f.environment.state(f.environmentAdmin)).receipts[0].hash, receipt.hash);
  assert.equal((await f.environment.state(f.environmentAdmin)).inventory[0].weight, 10);
  await reject(() => f.environment.guardMaterialChange({ cardId: request.card.id }, () => {}), 'environment_receipt_locked');
  // Reused legacy card numbers remain independent when both sources have IDs.
  assert.equal(await f.environment.guardMaterialChange({ cardId: request.card.id, sourceId: randomUUID() }, () => 'independent'), 'independent');
}));
