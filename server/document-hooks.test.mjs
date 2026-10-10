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

const initialTime = Date.parse('2026-10-10T08:00:00.000Z');
const customer = { id: 'customer-build', name: 'Bygg & Riv AB', type: 'Företag', number: '556000-0167', customerNumber: 'K-1001', phone: '', email: '',
  paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Bygg & Riv AB' } };
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true, address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' }];

async function fixture(run, { failHook = false, hookGate } = {}) {
  let time = initialTime; const now=()=>new Date(time);
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-document-hooks-'));
  const terminalRepository = await createTerminalDemoRepository({ env: {}, filename: join(directory, 'terminal.sqlite') });
  const documentRepository = await createDocumentRepository({ env: {}, filename: join(directory, 'documents.sqlite') });
  const pricing = createPricingStore({ now });
  const hooks = [];
  let documents;
  const terminal = createTerminalDemoApi({ env: {}, repository: terminalRepository, principalStore: pricing, siteProvider: async () => sites, now,
    onApprovalChanged: async (approval, job) => {
      // The lease contains the immutable committed milestone, not a public DTO
      // or a fresh read whose status may have advanced before this worker runs.
      assert.equal(approval.snapshot.card.status, 'complement');
      assert.equal(job.sourceHash, approval.snapshot.hash);
      if (job.stage === 'reviewed' || job.stage === 'final') {
        assert.equal(approval.approvedHash, approval.snapshot.hash);
        assert.equal(approval.approvedMethod, 'staff_checked_id_demo');
      }
      hooks.push({ id: approval.id, status: approval.status, stage: job.stage, hash: approval.snapshot.hash });
      if (hookGate) await hookGate;
      if (failHook) throw new Error('Injected PDF archive outage');
      await documents.archiveApprovalJob(approval, job);

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
  try { await run({ request, payload, staff, device: logged.cookie, hooks, terminal, documents, documentRepository, advance: milliseconds=>{time+=milliseconds;}, recover:()=>{failHook=false;} }); }
  finally { server.closeAllConnections(); server.close(); await once(server, 'close'); await terminal.close(); await documentRepository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('terminal actions durably queue preliminary, customer-approved and final PDFs after commit, without a document GET', { timeout: 12000 }, async () => fixture(async context => {
  const { request, payload, staff, device, hooks, documentRepository, terminal } = context;
  const sent = await request('/approvals', payload, staff.kajsa);
  assert.equal(sent.status, 201);
  const readArchiveDirectly = () => documentRepository.transact(database => database.documents('settlement', '9201'));
  await terminal.drainDocumentJobs();
  assert.deepEqual((await readArchiveDirectly()).map(record => record.stage), ['preliminary']);
  const id = sent.value.id;
  assert.equal((await request(`/approvals/${id}/respond`, { action: 'id_requested', termsAccepted: true }, device)).status, 200);
  assert.equal((await request(`/approvals/${id}/confirm-id`, {}, staff.kajsa)).status, 200);
  await terminal.drainDocumentJobs();
  assert.deepEqual(new Set((await readArchiveDirectly()).map(record => record.stage)), new Set(['preliminary', 'reviewed']));
  assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
  await terminal.drainDocumentJobs();
  const records = await readArchiveDirectly();
  assert.deepEqual(new Set(records.map(record => record.stage)), new Set(['preliminary', 'reviewed', 'final']));
  assert.deepEqual(hooks.map(hook => hook.stage), ['preliminary', 'reviewed', 'final']);
  assert.equal(new Set(records.map(record => record.sourceHash)).size, 1);
  const final = records.find(record => record.stage === 'final');
  assert.ok(final.snapshot.approval.at); assert.ok(final.snapshot.attest.at);
  assert.equal(final.snapshot.approval.version, 1);
  assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
  await terminal.drainDocumentJobs();
  assert.equal((await readArchiveDirectly()).length, 3);
  assert.equal((await terminal.documentJobs()).filter(job=>job.status==='completed').length,3);
}));

test('PDF outage leaves durable retry jobs and never reverts successful customer approval or attest', { timeout: 12000 }, async () => {
  await fixture(async ({ request, payload, staff, device, terminal, documentRepository, advance, recover }) => {
    const sent = await request('/approvals', payload, staff.kajsa);
    assert.equal(sent.status, 201); const id = sent.value.id;
    await terminal.drainDocumentJobs();
    assert.equal((await request(`/approvals/${id}/respond`, { action: 'id_requested', termsAccepted: true }, device)).status, 200);
    assert.equal((await request(`/approvals/${id}/confirm-id`, {}, staff.kajsa)).status, 200);
    assert.equal((await request(`/approvals/${id}/attest`, {}, staff.anna)).status, 200);
    await terminal.drainDocumentJobs();
    const persisted = (await terminal.documentProjections()).find(value => value.id === id);
    assert.equal(persisted.status, 'attested'); assert.equal(persisted.approvedHash,persisted.snapshot.hash); assert.ok(persisted.attestedAt);
    assert.equal((await terminal.documentJobs()).length,3);
    assert.ok((await terminal.documentJobs()).every(job=>job.status==='pending'));
    assert.deepEqual(await documentRepository.transact(database => database.documents('settlement', '9201')), []);
    recover(); advance(10000); await terminal.drainDocumentJobs();
    const recovered = await documentRepository.transact(database => database.documents('settlement', '9201'));
    assert.deepEqual(new Set(recovered.map(record => record.stage)), new Set(['preliminary', 'reviewed', 'final']));
    assert.ok((await terminal.documentJobs()).every(job=>job.status==='completed'));
    assert.equal((await terminal.documentProjections()).find(value => value.id === id).attestedAt, persisted.attestedAt);
  }, { failHook: true });
});

test('slow PDF work never delays terminal replies, and cancelling later preserves the reviewed milestone', { timeout:12000 }, async()=>{
  let unblock; const gate=new Promise(resolve=>{unblock=resolve;});
  try {
    await fixture(async({request,payload,staff,device,terminal,documentRepository})=>{
      const sent=await request('/approvals',payload,staff.kajsa);
      assert.equal(sent.status,201,'The request must reply while archive worker is blocked');
      const id=sent.value.id;
      assert.equal((await request(`/approvals/${id}/respond`,{action:'id_requested',termsAccepted:true},device)).status,200);
      assert.equal((await request(`/approvals/${id}/confirm-id`,{},staff.kajsa)).status,200);
      assert.equal((await request(`/approvals/${id}/cancel`,{},staff.kajsa)).status,200);
      unblock(); await terminal.drainDocumentJobs();
      const originals=await documentRepository.transact(database=>database.documents('settlement','9201'));
      assert.deepEqual(new Set(originals.map(record=>record.stage)),new Set(['preliminary','reviewed']));
      assert.equal(originals.find(record=>record.stage==='reviewed').snapshot.approval.method,'staff_checked_id_demo');
      assert.equal((await terminal.documentProjections()).find(value=>value.id===id).status,'cancelled');
    },{hookGate:gate});
  } finally { unblock(); }
});
