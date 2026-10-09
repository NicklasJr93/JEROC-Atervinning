import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';

const reject = (run, code) => assert.rejects(run, error => error.code === code);
const customer = { id: 'customer-build', name: 'Bygg & Riv AB', type: 'Företag', number: '556000-0167', customerNumber: 'K-1001', phone: '', email: '',
  paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Bygg & Riv AB' } };
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const origin = 'Testgatan 12, 761 41 Norrtälje';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-approval-receipt-'));
  let options = { env: {} }, postgres, schema;
  const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
  if (postgresUrl) {
    const { Pool } = await import('pg'); postgres = new Pool({ connectionString: postgresUrl });
    schema = `jeroc_approval_receipt_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(postgresUrl); connection.searchParams.set('options', `-c search_path=${schema}`);
    options = { env: { DATABASE_URL: connection.toString() } };
  }
  const environmentRepository = await createEnvironmentRepository({ ...options, filename: join(directory, 'environment.sqlite') });
  const terminalRepository = await createTerminalDemoRepository({ ...options, filename: join(directory, 'terminal.sqlite') });
  const pricing = createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
  const clock = () => new Date('2026-10-09T10:00:00Z');
  let terminal;
  const environment = createEnvironmentStore({ repository: environmentRepository, principalStore: pricing, now: clock,
    approvalGuard: (input, operation) => terminal.withApprovedCard(input, operation) });
  terminal = createTerminalDemoStore({ repository: terminalRepository, principalStore: pricing, now: clock,
    siteProvider: () => environment.catalog(), environmentApprovalCheck: approval => environment.assertReceiptForAttest(approval) });
  const staff = {};
  for (const id of ['admin', 'kajsa', 'anna']) staff[id] = { terminal: (await terminal.staffSession({ actualUserId: id, effectiveUserId: id })).token,
    environment: (await environment.demoSession({ userId: id })).token };
  const t = await terminal.createTerminal({ name: 'Testterminal', username: 'testterminal', password: 'terminal-test-only', siteId: 'norrtalje' }, staff.admin.terminal);
  const device = await terminal.login({ username: t.username, password: 'terminal-test-only' });
  function payload({ cardId = 9100, sourceId = randomUUID(), rows = [{ articleId: 'lead-battery', weight: 10 }, { articleId: 'copper-1', weight: 20 }] } = {}) {
    const pricingSnapshot = pricing.snapshot({ cardId, customerId: customer.id, deliveredAt: '2026-10-09T09:00:00Z', rows, supersedesSnapshotId: pricing.snapshots(pricing.principal('admin'), cardId).at(-1)?.id }, pricing.principal('kajsa'));
    const pricedRows = pricingSnapshot.rows.map(row => ({ ...row, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
    return { card: { id: cardId, sourceId, siteId: 'norrtalje', customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: '2026-10-09T09:00:00Z',
      reference: '', origin, pricingSnapshotId: pricingSnapshot.id, rows: pricedRows, audit: [] }, customer, terminalId: t.id, siteId: 'norrtalje',
      rows: pricedRows.map(row => ({ articleId: row.articleId, name: row.articleId, weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
      offset: 0, correctionIds: [], idempotencyKey: randomUUID() };
  }
  function receipt(request, extra = {}) {
    return { sourceId: request.card.sourceId, cardId: request.card.id, siteId: 'norrtalje', materialScope: 'hazardous', receivedAt: '2026-10-09T09:00:00Z',
      originAddress: origin, rows: request.card.rows.map(({ articleId, weight }) => ({ articleId, weight })), previousHolder: { name: customer.name, number: customer.number, contactName: '', email: '', phone: '' },
      lastPlace: { ...place }, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road', incomingDocument: { status: 'not_shown' }, idempotencyKey: randomUUID(), ...extra };
  }
  async function approve(approval) {
    await terminal.respond(approval.id, { action: 'id_requested', termsAccepted: true }, device.token);
    return terminal.confirmId(approval.id, staff.kajsa.terminal);
  }
  try { await run({ environment, terminal, environmentRepository, terminalRepository, pricing, staff, device, payload, receipt, approve }); }
  finally { await environmentRepository.close(); await terminalRepository.close(); if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); } await rm(directory, { recursive: true, force: true }); }
}

test('hazardous flow requires current customer approval, then physical receipt, then internal attest', async () => fixture(async f => {
  const request = f.payload(), input = f.receipt(request);
  await reject(() => f.environment.receive(input, f.staff.kajsa.environment), 'customer_approval_required');
  const approval = await f.terminal.send(request, f.staff.kajsa.terminal);
  await reject(() => f.environment.receive(input, f.staff.kajsa.environment), 'customer_approval_required');
  await f.approve(approval);
  await reject(() => f.environment.receive({ ...input, sourceId: randomUUID() }, f.staff.admin.environment), 'customer_approval_required');
  await reject(() => f.terminal.attest(approval.id, f.staff.anna.terminal), 'environment_receipt_required');
  const [first, repeated] = await Promise.all([f.environment.receive(input, f.staff.kajsa.environment), f.environment.receive({ ...input, idempotencyKey: randomUUID() }, f.staff.admin.environment)]);
  assert.equal(first.id, repeated.id);
  assert.equal(first.receivedAt, '2026-10-09T09:00:00Z');
  assert.equal(first.snapshot.customerApproval.id, approval.id);
  assert.equal(first.snapshot.customerApproval.hash, approval.snapshot.hash);
  assert.equal(first.snapshot.customerApproval.approvedAt, '2026-10-09T10:00:00.000Z');
  assert.equal((await f.environment.state(f.staff.admin.environment)).reports[0].weight, 10);
  assert.equal((await f.terminal.attest(approval.id, f.staff.anna.terminal)).status, 'attested');
  assert.equal((await f.environment.receive(input, f.staff.kajsa.environment)).id, first.id);
  assert.equal((await f.environment.state(f.staff.admin.environment)).inventory.length, 1);
}));

test('cancelled or superseded approval and changed hazardous weight/origin cannot register or attest', async () => fixture(async f => {
  const request = f.payload(), approval = await f.terminal.send(request, f.staff.kajsa.terminal);
  await f.approve(approval);
  await reject(() => f.environment.receive(f.receipt(request, { rows: [{ articleId: 'lead-battery', weight: 11 }] }), f.staff.admin.environment), 'customer_approval_mismatch');
  const changedOrigin = 'Testgatan 13, 761 41 Norrtälje';
  await reject(() => f.environment.receive(f.receipt(request, { originAddress: changedOrigin, lastPlace: { ...place, address: 'Testgatan 13' } }), f.staff.admin.environment), 'customer_approval_mismatch');
  await f.terminal.cancel(approval.id, f.staff.kajsa.terminal);
  await reject(() => f.environment.receive(f.receipt(request), f.staff.admin.environment), 'customer_approval_required');
  const revised = f.payload({ sourceId: request.card.sourceId, rows: [{ articleId: 'lead-battery', weight: 15 }, { articleId: 'copper-1', weight: 20 }] });
  const latest = await f.terminal.send(revised, f.staff.kajsa.terminal);
  await reject(() => f.environment.receive(f.receipt(request), f.staff.admin.environment), 'customer_approval_required');
  await f.approve(latest);
  await reject(() => f.environment.receive(f.receipt(request), f.staff.admin.environment), 'customer_approval_mismatch');
  const receipt = await f.environment.receive(f.receipt(revised), f.staff.kajsa.environment);
  assert.equal(receipt.snapshot.rows[0].weight, 15);
  // A traceable later physical correction cannot silently satisfy the old approval.
  const { expectedDraftVersion, approvalExceptionReason, ...correction } = f.receipt(revised, { rows: [{ articleId: 'lead-battery', weight: 16 }] });
  await f.environment.correct(receipt.id, { ...correction, expectedVersion: 1, reason: 'Kontrollvägning visade 16 kg.' }, f.staff.admin.environment);
  await reject(() => f.terminal.attest(latest.id, f.staff.anna.terminal), 'environment_receipt_mismatch');
}));

test('nonhazardous cards skip the environment stage, while legacy matching receipts stay usable', async () => fixture(async f => {
  const request = f.payload({ rows: [{ articleId: 'copper-1', weight: 20 }] });
  const approval = await f.terminal.send(request, f.staff.kajsa.terminal); await f.approve(approval);
  assert.equal((await f.terminal.attest(approval.id, f.staff.anna.terminal)).status, 'attested');
  assert.equal((await f.environment.state(f.staff.admin.environment)).receipts.length, 0);
  const legacy = f.payload({ cardId: 9101 });
  const ungatedLegacyStore = createEnvironmentStore({ repository: f.environmentRepository, principalStore: f.pricing, now: () => new Date('2026-10-09T10:00:00Z') });
  const old = await ungatedLegacyStore.receive(f.receipt(legacy), f.staff.admin.environment);
  const review = await f.terminal.send(legacy, f.staff.kajsa.terminal); await f.approve(review);
  assert.equal((await f.terminal.attest(review.id, f.staff.anna.terminal)).status, 'attested');
  assert.equal((await f.environment.state(f.staff.admin.environment)).receipts[0].originalHash, old.hash);
}));

test('physical receipt exception needs privileged permission, an actual change request and a reason; it never approves attest', async () => fixture(async f => {
  const request = f.payload(), approval = await f.terminal.send(request, f.staff.kajsa.terminal);
  const input = f.receipt(request, { approvalExceptionReason: 'Avfallet är redan lossat; kunden har begärt kontrollvägning.' });
  await reject(() => f.environment.receive(input, f.staff.admin.environment), 'receipt_exception_not_allowed');
  await f.terminal.respond(approval.id, { action: 'change_requested', comment: 'Kontrollera vikten igen.', termsAccepted: false }, f.device.token);
  await reject(() => f.environment.receive(input, f.staff.kajsa.environment), 'forbidden');
  const changed = { ...input, rows: [{ articleId: 'lead-battery', weight: 11 }] };
  const receipt = await f.environment.receive(changed, f.staff.admin.environment);
  assert.equal(receipt.snapshot.customerApproval.status, 'change_requested');
  assert.match(receipt.snapshot.customerApproval.exceptionReason, /lossat/);
  const audit = await f.environmentRepository.transact(state => state.audit);
  assert.equal(audit.filter(event => event.action === 'environment.received_exception').length, 1);
  await reject(() => f.terminal.attest(approval.id, f.staff.anna.terminal), 'customer_approval_required');
}));
