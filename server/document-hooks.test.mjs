import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createTerminalDemoApi } from './terminal-demo.mjs';
import { createDocumentRepository } from './documents/storage.mjs';
import { createDocumentService } from './documents/model.mjs';

const now = () => new Date('2026-10-10T08:00:00.000Z');
const customer = { id: 'customer-build', name: 'Bygg & Riv AB', type: 'Företag', number: '556000-0167', customerNumber: 'K-1001', phone: '', email: '',
  paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Bygg & Riv AB' } };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true, address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' }];

async function fixture(run, { failHook = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-document-hooks-'));
  const terminalRepository = await createTerminalDemoRepository({ env: {}, filename: join(directory, 'terminal.sqlite') });
  const documentRepository = await createDocumentRepository({ env: {}, filename: join(directory, 'documents.sqlite') });
  const pricing = createPricingStore({ now });
  const hooks = [];
  let documents;
  const terminal = createTerminalDemoApi({ env: {}, repository: terminalRepository, principalStore: pricing, siteProvider: async () => sites, now,
    onApprovalChanged: async result => {
      // Read the committed original BEFORE touching the file archive. A hook
      // invoked inside the terminal transaction would deadlock this fresh read.
      const saved = (await terminal.documentProjections()).find(value => value.id === result.id);
      assert.equal(saved.status, result.status);
      assert.equal(saved.snapshot.card.status, 'complement', 'The public DTO must not become the PDF source');
      if (result.status === 'approved' || result.status === 'attested') {
        assert.equal(saved.approvedHash, saved.snapshot.hash);
        assert.equal(saved.approvedMethod, 'staff_checked_id_demo');
        assert.equal(result.approvedHash, undefined, 'Signing proof is server-private');
      }
      hooks.push({ id: result.id, status: saved.status, hash: saved.snapshot.hash });
      if (failHook) throw new Error('Injected PDF archive outage');
      await documents.ensureApproval(result);
    },
  });
  documents = createDocumentService({ repository: documentRepository, now, renderPdf: async snapshot => Buffer.from(`%PDF-1.4\n${snapshot.type}:${snapshot.status}\n%%EOF\n`),
    sourceProvider: async () => ({ office: { cards: [], customers: [customer], payments: [] }, transport: { orders: [], drivers: [], vehicles: [] }, sites, approvals: await terminal.documentProjections() }),
  });
  const server = createServer(async (req, res) => {
    if (!await terminal(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/terminal-demo`;
  const request = async (path, input, cookie) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const staff = {};
  for (const id of ['admin', 'kajsa', 'anna']) {
    const response = await request('/staff-session', { actualUserId: id, effectiveUserId: id });
    assert.equal(response.status, 200); staff[id] = response.cookie;
  }
  const created = await request('/terminals', { name: 'PDF hook terminal', username: 'pdfhookterminal', password: 'terminal-test-only', siteId: 'norrtalje' }, staff.admin);
  assert.equal(created.status, 201);
  const logged = await request('/login', { username: 'pdfhookterminal', password: 'terminal-test-only' });
  assert.equal(logged.status, 200);
  const frozen = pricing.snapshot({ cardId: 9201, customerId: customer.id, deliveredAt: '2026-10-09T09:00:00Z', rows: [{ articleId: 'copper-1', weight: 10 }] }, pricing.principal('kajsa'));
  const rows = frozen.rows.map(row => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: row.tier === 'Special' ? 'Eget' : row.tier }));
  const payload = { card: { id: 9201, siteId: 'norrtalje', customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: '2026-10-09T09:00:00Z', reference: 'PDF hook test', origin: 'Testgatan 12', pricingSnapshotId: frozen.id, rows, audit: [] },
    customer, terminalId: created.value.id, siteId: 'norrtalje', rows: rows.map(row => ({ articleId: row.articleId, name: 'Koppar klass 1', weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })), offset: 0, correctionIds: [], idempotencyKey: 'pdf-hook-first-send' };
  try { await run({ request, payload, staff, device: logged.cookie, hooks, terminal, documents, documentRepository }); }
  finally { server.closeAllConnections(); server.close(); await once(server, 'close'); await terminal.close(); await documentRepository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('real terminal HTTP actions archive preliminary, customer-approved and final PDFs immediately after commit without a document GET/backfill', { timeout: 12000 }, async () => fixture(async context => {
  const { request, payload, staff, device, hooks, documentRepository } = context;
  const sent = await request('/approvals', payload, staff.kajsa);
  assert.equal(sent.status, 201);
  const readArchiveDirectly = () => documentRepository.transact(database => database.documents('settlement', '9201'));
  assert.deepEqual((await readArchiveDirectly()).map(record => record.stage), ['preliminary']);
  assert.deepEqual(hooks.map(hook => hook.status), ['waiting']);
  const id = sent.value.id;
  assert.equal((await request(`/approvals/${id}/respond`, { action: 'id_requested', termsAccepted: true }, device)).status, 200);
  assert.deepEqual((await readArchiveDirectly()).map(record => record.stage), ['preliminary']);
  assert.equal((await request(`/approvals/${id}/confirm-id`, {}, staff.kajsa)).status, 200);
  assert.deepEqual(new Set((await readArchiveDirectly()).map(record => record.stage)), new Set(['preliminary', 'reviewed']));
  assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
  const records = await readArchiveDirectly();
  assert.deepEqual(new Set(records.map(record => record.stage)), new Set(['preliminary', 'reviewed', 'final']));
  assert.deepEqual(hooks.map(hook => hook.status), ['waiting', 'approved', 'attested']);
  assert.equal(new Set(records.map(record => record.sourceHash)).size, 1);
  const final = records.find(record => record.stage === 'final');
  assert.ok(final.snapshot.approval.at); assert.ok(final.snapshot.attest.at);
  assert.equal(final.snapshot.approval.version, 1);
  // A repeated successful HTTP action does not create another immutable original.
  assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
  assert.equal((await readArchiveDirectly()).length, 3);
}));

test('PDF-hook failure never reverts successful customer approval or attest; committed signing proof supports later recovery', { timeout: 12000 }, async t => {
  const warnings = []; t.mock.method(console, 'error', message => warnings.push(message));
  await fixture(async ({ request, payload, staff, device, hooks, terminal, documents, documentRepository }) => {
    const sent = await request('/approvals', payload, staff.kajsa);
    assert.equal(sent.status, 201); const id = sent.value.id;
    assert.equal((await request(`/approvals/${id}/respond`, { action: 'id_requested', termsAccepted: true }, device)).status, 200);
    assert.equal((await request(`/approvals/${id}/confirm-id`, {}, staff.kajsa)).status, 200);
    let persisted = (await terminal.documentProjections()).find(value => value.id === id);
    assert.equal(persisted.status, 'approved'); assert.equal(persisted.approvedHash, persisted.snapshot.hash);
    assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
    persisted = (await terminal.documentProjections()).find(value => value.id === id);
    assert.equal(persisted.status, 'attested'); assert.ok(persisted.attestedAt);
    assert.deepEqual(hooks.map(hook => hook.status), ['waiting', 'approved', 'attested']);
    assert.equal(warnings.length, 3);
    assert.deepEqual(await documentRepository.transact(database => database.documents('settlement', '9201')), []);
    // Recovery explicitly uses the durable terminal proof, with no repeated
    // customer action, no payment, and no public document-list request.
    await documents.ensureApproval({ id });
    const recovered = await documentRepository.transact(database => database.documents('settlement', '9201'));
    assert.deepEqual(new Set(recovered.map(record => record.stage)), new Set(['preliminary', 'reviewed', 'final']));
    assert.equal((await terminal.documentProjections()).find(value => value.id === id).attestedAt, persisted.attestedAt);
  }, { failHook: true });
});
