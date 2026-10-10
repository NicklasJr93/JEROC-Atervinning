import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createDocumentRepository, DocumentError } from './documents/storage.mjs';
import { createDocumentService, documentHash } from './documents/model.mjs';
import { createDocumentsApi } from './documents/api.mjs';

const pdfBytes = Buffer.from('%PDF-1.4\nJEROC archived test original\n%%EOF\n');
const digest = value => createHash('sha256').update(value).digest('hex');
const original = changes => ({
  id: randomUUID(), kind: 'settlement', sourceId: '3010', sourceVersion: 1,
  stage: 'preliminary', sourceHash: digest('frozen approval version 1'),
  templateVersion: 'jeroc-a4-v1', fileHash: digest(pdfBytes),
  createdAt: '2026-10-10T10:00:00.000Z', ...changes,
});

async function archiveFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-document-tests-'));
  const filename = join(directory, 'documents.sqlite');
  const repositories = [];
  const instance = async () => {
    const repository = await createDocumentRepository({ env: {}, filename });
    repositories.push(repository);
    return repository;
  };
  try { await run({ repository: await instance(), instance }); }
  finally {
    for (const repository of repositories) await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('archived PDF bytes and their immutable hash survive an independent repository instance', async () => archiveFixture(async ({ repository, instance }) => {
  const record = original();
  const stored = await repository.transact(db => db.insertDocument(record, pdfBytes));
  assert.equal(stored.inserted, true);
  const reopened = await instance();
  const document = await reopened.transact(db => db.document(record.id, true));
  assert.deepEqual(document.pdf, pdfBytes);
  assert.equal(digest(document.pdf), record.fileHash);
  assert.deepEqual(await reopened.transact(db => db.document(record.id)), record);
  assert.equal('pdf' in await reopened.transact(db => db.document(record.id)), false);
}));

test('concurrent requests for one version retain exactly one original instead of overwriting its bytes', async () => archiveFixture(async ({ repository }) => {
  const record = original();
  const competing = Array.from({ length: 6 }, () => ({ ...record, id: randomUUID() }));
  const results = await Promise.all(competing.map(value => repository.transact(db => db.insertDocument(value, pdfBytes))));
  assert.equal(results.filter(value => value.inserted).length, 1);
  assert.equal(new Set(results.map(value => value.record.id)).size, 1);
  const replacement = Buffer.from('%PDF-1.4\nnot the original\n');
  const repeated = await repository.transact(db => db.insertDocument({ ...record, id: randomUUID(), fileHash: digest(replacement) }, replacement));
  assert.equal(repeated.inserted, false);
  const document = await repository.transact(db => db.document(repeated.record.id, true));
  assert.deepEqual(document.pdf, pdfBytes);
  assert.equal(document.fileHash, digest(pdfBytes));
  assert.equal((await repository.transact(db => db.documents('settlement', record.sourceId))).length, 1);
}));

test('new stages, frozen source hashes and template versions preserve their own originals', async () => archiveFixture(async ({ repository }) => {
  const first = original();
  const records = [first, original({ stage: 'approved' }), original({ stage: 'final' }),
    original({ sourceVersion: 2, sourceHash: digest('corrected approved version 2') }),
    original({ templateVersion: 'jeroc-a4-v2' })];
  for (const record of records) assert.equal((await repository.transact(db => db.insertDocument(record, pdfBytes))).inserted, true);
  const listed = await repository.transact(db => db.documents('settlement', first.sourceId));
  assert.equal(listed.length, records.length);
  assert.equal(new Set(listed.map(record => record.id)).size, records.length);
  assert.deepEqual(await repository.transact(db => db.document(first.id, true)), { ...first, pdf: pdfBytes });
}));

test('failed archive transactions roll back PDF and transport-draft records together', async () => archiveFixture(async ({ repository }) => {
  const record = original();
  await assert.rejects(() => repository.transact(async db => {
    await db.insertDocument(record, pdfBytes);
    await db.insertTransportDraft({ orderId: 'AO-test', version: 1, updatedAt: record.createdAt });
    throw new Error('transaction interrupted');
  }), /transaction interrupted/);
  assert.equal(await repository.transact(db => db.document(record.id)), undefined);
  assert.equal(await repository.transact(db => db.transportDraft('AO-test')), undefined);
}));

test('Render refuses document persistence without PostgreSQL instead of choosing RAM or an ephemeral local file', async () => {
  await assert.rejects(() => createDocumentRepository({ env: { RENDER: 'true' } }), error =>
    error instanceof DocumentError && error.status === 503 && error.code === 'setup_required');
});

test('PostgreSQL archive prevents duplicate originals across independent concurrent server instances', { skip: !process.env.JEROC_TEST_DATABASE_URL }, async () => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
  const schema = `jeroc_document_tests_${randomUUID().replaceAll('-', '')}`;
  const repositories = [];
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.JEROC_TEST_DATABASE_URL);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    const env = { RENDER: 'true', DATABASE_URL: connection.toString() };
    repositories.push(...await Promise.all([createDocumentRepository({ env }), createDocumentRepository({ env })]));
    const record = original();
    const results = await Promise.all(repositories.map(repository => repository.transact(db => db.insertDocument({ ...record, id: randomUUID() }, pdfBytes))));
    assert.equal(results.filter(result => result.inserted).length, 1);
    assert.equal(results[0].record.id, results[1].record.id);
    const archived = await repositories[1].transact(db => db.document(results[0].record.id, true));
    assert.deepEqual(archived.pdf, pdfBytes);
    assert.equal(digest(archived.pdf), record.fileHash);
    assert.equal((await pool.query(`SELECT count(*) FROM "${schema}".jeroc_document_archive`)).rows[0].count, '1');
  } finally {
    for (const repository of repositories) await repository.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
});

const admin = { actor: { id: 'admin', active: true }, user: { id: 'admin', name: 'Systemadmin', level: 'Systemadmin', permissions: [], active: true } };
const worker = (permissions, siteIds) => ({ actor: { id: 'worker', active: true }, user: { id: 'worker', level: 'Medarbetare', permissions, ...(siteIds ? { siteIds } : {}), active: true } });
function businessSources() {
  const card = { id: 3010, siteId: 'norrtalje', yard: 'Norrtälje', customerId: 'private-1', origin: 'Testgatan 12, 761 41 Norrtälje', reference: 'Kundens referens', date: '2026-10-10T08:00:00.000Z', status: 'customer', rows: [{ articleId: 'lead-battery', weight: 10, price: 4 }], paymentDetails: { method: 'bank', account: '1234567890', clearing: '1234', holder: 'Testkunden' } };
  const customer = { id: 'private-1', type: 'Privatperson', name: 'Testkunden', number: '198001011234', address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje' };
  const snapshot = { card: structuredClone(card), customer: structuredClone(customer), rows: [{ articleId: 'lead-battery', name: 'Blybatterier', weight: 10, price: 4, amount: 40 }], gross: 40, offset: 0, net: 40, reference: card.reference, origin: card.origin, deliveredAt: card.date, paymentMethod: 'bank', termsVersion: 'terms-1', hash: digest('trusted frozen approval v1') };
  return { company: { name: 'JEROC Återvinning AB', number: '5591234567', vat: 'SE559123456701' },
    office: { cards: [card], customers: [customer], payments: [] },
    sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true, address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje' }],
    approvals: [{ id: 'approval-1', cardId: card.id, siteId: 'norrtalje', version: 1, status: 'waiting', createdAt: '2026-10-10T09:00:00.000Z', actualUserId: 'admin', effectiveUserId: 'admin', snapshot }],
    transport: { orders: [{ id: 'AO-1042', customerId: customer.id, customerName: customer.name, siteId: 'norrtalje', address: customer.address, city: customer.city, material: 'Blybatterier', driverId: 'driver-1', vehicleId: 'vehicle-1', date: '2026-10-12', requestedDate: '2026-10-12', notes: 'Önskad tid, invänta transportörens bekräftelse.', updatedAt: '2026-10-10T09:00:00.000Z' }],
      drivers: [{ id: 'driver-1', name: 'Extern förare', companyId: 'carrier-1' }], vehicles: [{ id: 'vehicle-1', registration: 'ABC123' }] },
    personnel: { companies: [{ id: 'carrier-1', name: 'Exempelåkeriet AB', number: '5595551234', address: 'Åkerivägen 1', postalCode: '75320', city: 'Uppsala' }] } };
}
const approve = approval => Object.assign(approval, { status: 'approved', approvedHash: approval.snapshot.hash, approvedAt: '2026-10-10T09:15:00.000Z', approvedMethod: 'manual_id_demo', approvedBy: 'Kajsa' });
const attest = approval => Object.assign(approve(approval), { status: 'attested', attestedAt: '2026-10-10T09:30:00.000Z', attestedBy: 'Anna', attestedUserId: 'anna' });
const expectError = (status, code) => error => error instanceof DocumentError && error.status === status && error.code === code;
async function serviceFixture(run) {
  return archiveFixture(async ({ repository, instance }) => {
    const sources = businessSources(), rendered = [];
    const options = { repository, sourceProvider: async () => structuredClone(sources), renderPdf: async snapshot => { rendered.push(snapshot); return pdfBytes; }, now: () => new Date('2026-10-10T10:00:00.000Z') };
    await run({ sources, rendered, repository, instance, options, service: createDocumentService(options) });
  });
}

test('preliminary settlement uses the frozen review rather than mutable customer/card fields and masks private payment identity', async () => serviceFixture(async ({ service, sources }) => {
  sources.office.cards[0].rows[0].weight = 999;
  sources.office.cards[0].reference = 'Changed after customer review';
  sources.office.customers[0].name = 'Changed live customer';
  const { document } = await service.generateSettlement(3010, {}, admin);
  const archived = await service.download(document.id, admin);
  assert.equal(document.stage, 'preliminary');
  assert.equal(archived.snapshot.customer.name, 'Testkunden');
  assert.equal(archived.snapshot.customer.number, '');
  assert.equal(archived.snapshot.rows[0].weight, 10);
  assert.equal(archived.snapshot.reference, 'Kundens referens');
  assert.equal(archived.snapshot.payment.maskedAccount, '•••• 7890');
  assert.equal(JSON.stringify(archived.snapshot).includes('1234567890'), false);
  assert.equal(archived.snapshot.approval, undefined);
  assert.equal(archived.snapshot.attest, undefined);
}));

test('customer approval and internal attest are distinct, server-enforced PDF stages', async () => serviceFixture(async ({ service, sources }) => {
  await assert.rejects(() => service.generateSettlement(3010, { stage: 'reviewed' }, admin), expectError(409, 'approval_required'));
  await assert.rejects(() => service.generateSettlement(3010, { stage: 'final' }, admin), expectError(409, 'approval_required'));
  approve(sources.approvals[0]);
  const reviewed = await service.generateSettlement(3010, {}, admin);
  assert.equal(reviewed.document.stage, 'reviewed');
  assert.equal((await service.download(reviewed.document.id, admin)).snapshot.approval.method, 'manual_id_demo');
  await assert.rejects(() => service.generateSettlement(3010, { stage: 'final' }, admin), expectError(409, 'approval_required'));
  attest(sources.approvals[0]);
  const final = await service.generateSettlement(3010, {}, admin);
  assert.equal(final.document.stage, 'final');
  assert.notEqual(final.document.id, reviewed.document.id);
  assert.equal((await service.download(final.document.id, admin)).snapshot.attest.name, 'Anna');
  sources.approvals = [];
  await assert.rejects(() => service.generateSettlement(3010, { stage: 'final' }, admin), expectError(409, 'approval_required'));
}));

test('a server-backed preliminary preview before customer approval remains provisional and validates current saved inputs', async () => serviceFixture(async ({ service, sources }) => {
  sources.approvals = [];
  sources.office.cards[0].status = 'new';
  const first = (await service.generateSettlement(3010, {}, admin)).document;
  const snapshot = (await service.download(first.id, admin)).snapshot;
  assert.equal(first.stage, 'preliminary');
  assert.equal(snapshot.approval, undefined);
  assert.equal(snapshot.attest, undefined);
  sources.office.cards[0].rows[0].weight = 11;
  const edited = (await service.generateSettlement(3010, {}, admin)).document;
  assert.notEqual(edited.id, first.id);
  assert.equal((await service.download(first.id, admin)).snapshot.rows[0].weight, 10);
  assert.equal((await service.download(edited.id, admin)).snapshot.rows[0].weight, 11);
  sources.office.cards[0].financialPending = true;
  await assert.rejects(() => service.generateSettlement(3010, {}, admin), expectError(409, 'prices_required'));
  delete sources.office.cards[0].financialPending;
  sources.office.cards[0].origin = '';
  await assert.rejects(() => service.generateSettlement(3010, {}, admin), expectError(422, 'draft_incomplete'));
}));

test('missing or mismatching version-bound approval proof cannot create reviewed or final documents', async () => serviceFixture(async ({ service, sources }) => {
  for (const approvedHash of [undefined, digest('different version')]) {
    attest(sources.approvals[0]);
    sources.approvals[0].approvedHash = approvedHash;
    for (const stage of ['reviewed', 'final']) await assert.rejects(() => service.generateSettlement(3010, { stage }, admin), expectError(409, 'approval_required'));
  }
  assert.equal((await service.list({ kind: 'settlement', sourceId: '3010' }, admin)).documents.every(document => document.stage === 'preliminary'), true);
}));

test('automatic archival adds each milestone once and keeps the approved file stable after restart', async () => serviceFixture(async ({ service, sources, options, instance }) => {
  const first = await service.ensureApproval(sources.approvals[0]);
  assert.deepEqual(first.map(document => document.stage), ['preliminary']);
  approve(sources.approvals[0]);
  const approved = await service.ensureApproval(sources.approvals[0]);
  assert.deepEqual(approved.map(document => document.stage), ['preliminary', 'reviewed']);
  assert.equal(approved[0].id, first[0].id);
  attest(sources.approvals[0]);
  const completed = await service.ensureApproval(sources.approvals[0]);
  assert.deepEqual(completed.map(document => document.stage), ['preliminary', 'reviewed', 'final']);
  const reopened = createDocumentService({ ...options, repository: await instance() });
  const repeated = await reopened.ensureApproval(sources.approvals[0]);
  assert.deepEqual(repeated.map(document => document.id), completed.map(document => document.id));
  const final = await reopened.download(completed[2].id, admin);
  assert.equal(final.pdfHash, documentHash(final.pdf));
}));

test('a corrected review version creates a separate file and leaves the earlier frozen version untouched', async () => serviceFixture(async ({ service, sources }) => {
  const old = (await service.generateSettlement(3010, {}, admin)).document;
  const next = structuredClone(sources.approvals[0]);
  next.id = 'approval-2'; next.version = 2;
  next.snapshot.customer.name = 'Corrected customer';
  next.snapshot.rows[0].weight = 12; next.snapshot.rows[0].amount = 48;
  next.snapshot.gross = next.snapshot.net = 48;
  next.snapshot.hash = digest('trusted frozen approval v2');
  sources.approvals[0].status = 'cancelled';
  sources.approvals.push(next);
  const current = (await service.generateSettlement(3010, {}, admin)).document;
  assert.notEqual(current.id, old.id);
  assert.equal(current.sourceVersion, 2);
  assert.equal((await service.download(old.id, admin)).snapshot.customer.name, 'Testkunden');
  assert.equal((await service.download(current.id, admin)).snapshot.customer.name, 'Corrected customer');
}));

test('later settlement stages retain the company and site identity from the customer review document', async () => serviceFixture(async ({ service, sources }) => {
  const preliminary = (await service.generateSettlement(3010, {}, admin)).document;
  const original = (await service.download(preliminary.id, admin)).snapshot;
  sources.company.name = 'New live company name';
  sources.sites[0].address = 'A changed live site address';
  attest(sources.approvals[0]);
  const final = (await service.generateSettlement(3010, {}, admin)).document;
  const issued = (await service.download(final.id, admin)).snapshot;
  assert.equal(issued.company.name, original.company.name);
  assert.equal(issued.site.address, original.site.address);
}));

test('site, financial visibility, revoked accounts and authentication are checked on generation and download', async () => serviceFixture(async ({ service }) => {
  const document = (await service.generateSettlement(3010, {}, admin)).document;
  const wrongSite = worker(['view', 'reports'], ['rimbo']);
  const noMoney = worker(['view', 'prices', 'priceA'], ['norrtalje']);
  await assert.rejects(() => service.generateSettlement(3010, {}, wrongSite), expectError(403, 'site_forbidden'));
  await assert.rejects(() => service.download(document.id, wrongSite), expectError(403, 'site_forbidden'));
  await assert.rejects(() => service.generateSettlement(3010, {}, noMoney), expectError(403, 'financial_visibility_required'));
  await assert.rejects(() => service.download(document.id, noMoney), expectError(403, 'financial_visibility_required'));
  await assert.rejects(() => service.download(document.id, undefined), expectError(401, 'authentication_required'));
  await assert.rejects(() => service.download(document.id, { ...admin, actor: { ...admin.actor, active: false } }), expectError(401, 'authentication_required'));
  assert.equal((await service.transport('AO-1042', worker(['transportRead'], ['norrtalje']))).draft.siteId, 'norrtalje');
  await assert.rejects(() => service.transport('AO-1042', worker(['transportRead'], ['rimbo'])), expectError(403, 'site_forbidden'));
  await assert.rejects(() => service.transport('AO-1042', worker([])), expectError(403, 'forbidden'));
}));

function transportInput(draft, changes = {}) {
  return { expectedVersion: draft.version, siteId: draft.siteId, direction: draft.direction,
    sender: draft.sender, receiver: draft.receiver, carrier: draft.carrier,
    driver: draft.driver, registration: draft.registration, startAt: draft.startAt,
    requestedAt: draft.requestedAt, handling: draft.handling, reference: draft.reference,
    rows: draft.rows, ...changes };
}

test('transport document prefills trusted order/party data but requires actual weight instead of pretending the planned job was weighed', async () => serviceFixture(async ({ service, sources }) => {
  const { draft } = await service.transport('AO-1042', admin);
  assert.equal(draft.version, 0);
  assert.equal(draft.sender.name, sources.office.customers[0].name);
  assert.equal(draft.sender.address, 'Testgatan 12');
  assert.equal(draft.receiver.name, 'JEROC Återvinning AB');
  assert.equal(draft.carrier.name, 'Exempelåkeriet AB');
  assert.equal(draft.driver, 'Extern förare');
  assert.equal(draft.registration, 'ABC123');
  assert.equal(draft.requestedAt, '2026-10-12');
  assert.equal(draft.rows[0].weight, null);
  assert.ok(draft.missing.includes('Rad 1: faktisk vikt'));
  assert.ok(draft.missing.includes('Rad 1: avfallskod'));
  await assert.rejects(() => service.generateTransport('AO-1042', admin), expectError(409, 'draft_required'));
}));

test('transport revisions reject a stale concurrent editor and generating draft PDF never modifies orders, inventory, approvals or payments', async () => serviceFixture(async ({ service, sources }) => {
  const before = structuredClone(sources);
  const { draft: initial } = await service.transport('AO-1042', admin);
  const saved = await service.saveTransport('AO-1042', transportInput(initial, { rows: [{ name: 'Blybatterier', wasteCode: '16 06 01*', weight: 10 }] }), admin);
  assert.equal(saved.draft.version, 1);
  await assert.rejects(() => service.saveTransport('AO-1042', transportInput(initial, { driver: 'Competing driver' }), admin), expectError(409, 'version_conflict'));
  const repeated = await service.saveTransport('AO-1042', transportInput(saved.draft), admin);
  assert.equal(repeated.draft.version, 1);
  const generated = await service.generateTransport('AO-1042', admin);
  const record = await service.download(generated.document.id, admin);
  assert.equal(record.stage, 'draft');
  assert.equal(record.snapshot.status, 'draft');
  assert.deepEqual(record.snapshot.transport.signatures, []);
  assert.equal(record.snapshot.rows[0].wasteCode, '160601');
  assert.equal(record.snapshot.totalWeight, 10);
  assert.equal((await service.generateTransport('AO-1042', admin)).document.id, generated.document.id);
  assert.deepEqual(sources, before);
}));

test('invalid renderer output cannot create a PDF archive record', async () => serviceFixture(async ({ sources, options, repository }) => {
  const broken = createDocumentService({ ...options, renderPdf: async () => Buffer.from('<html>not a pdf</html>') });
  await assert.rejects(() => broken.generateSettlement(3010, {}, admin), expectError(503, 'pdf_generation_failed'));
  assert.deepEqual(await repository.transact(db => db.documents('settlement', String(sources.approvals[0].cardId))), []);
}));

test('payment receipts require a recorded journal entry and an attested source; the archived receipt does not register another payment', async () => serviceFixture(async ({ service, sources }) => {
  await assert.rejects(() => service.generateReceipt('payment-1', admin), expectError(404, 'source_not_found'));
  sources.office.payments.push({ id: 'payment-1', cardId: 3010, date: '2026-10-10T09:45:00.000Z', actor: 'Anna', amount: 40, method: 'cash', reference: 'MANUAL-001' });
  await assert.rejects(() => service.generateReceipt('payment-1', admin), expectError(409, 'attest_required'));
  attest(sources.approvals[0]);
  const before = structuredClone(sources);
  const first = (await service.generateReceipt('payment-1', admin)).document;
  const second = (await service.generateReceipt('payment-1', admin)).document;
  assert.equal(first.id, second.id);
  const record = await service.download(first.id, admin);
  assert.equal(record.kind, 'receipt');
  assert.equal(record.snapshot.type, 'receipt');
  assert.equal(record.snapshot.payment.reference, 'MANUAL-001');
  assert.equal(record.snapshot.payment.amount, 40);
  assert.deepEqual(sources, before);
}));

test('a stored PDF with a wrong checksum is rejected without rewriting the archived original', async () => serviceFixture(async ({ service, repository }) => {
  const record = original({ pdfHash: digest('different bytes'), siteId: 'norrtalje' });
  await repository.transact(db => db.insertDocument(record, pdfBytes));
  await assert.rejects(() => service.download(record.id, admin), expectError(503, 'file_integrity_error'));
  assert.deepEqual((await repository.transact(db => db.document(record.id, true))).pdf, pdfBytes);
}));

async function httpFixture(run) {
  await serviceFixture(async context => {
    const identities = new Map([['admin', structuredClone(admin)], ['limited', worker(['view'])]]);
    const resolved = [];
    const api = createDocumentsApi({ ...context.options, resolvePrincipal: async req => {
      resolved.push(req.url);
      const principal = identities.get(req.headers['x-test-account']);
      if (!principal) throw new DocumentError('Authentication required.', 401, 'authentication_required');
      return principal;
    } });
    const server = createServer((req, res) => void api(req, res, new URL(req.url, 'http://localhost')).then(handled => {
      if (!handled) { res.writeHead(404); res.end(); }
    }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options = {}) => fetch(baseUrl + path, { ...options, headers: { 'x-test-account': 'admin', ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
    try { await run({ ...context, api, identities, resolved, request }); }
    finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test('document HTTP downloads require fresh authenticated permissions and expose PDF hash with private no-store headers', async () => httpFixture(async ({ request, identities, resolved }) => {
  const generated = await request('/api/documents/settlements/3010/generate', { method: 'POST', body: '{}' });
  assert.equal(generated.status, 201);
  const { document } = await generated.json();
  const download = await request(document.downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('referrer-policy'), 'no-referrer');
  assert.match(download.headers.get('content-disposition'), /^inline; filename="JEROC-settlement-/);
  assert.equal(download.headers.get('x-document-hash'), document.pdfHash);
  assert.equal(Number(download.headers.get('content-length')), pdfBytes.length);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdfBytes);
  const head = await request(document.downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), pdfBytes.length);
  const anonymous = await request(document.downloadUrl, { headers: { 'x-test-account': '' } });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'authentication_required');
  const limited = await request(document.downloadUrl, { headers: { 'x-test-account': 'limited' } });
  assert.equal(limited.status, 403);
  assert.equal((await limited.json()).code, 'financial_visibility_required');
  identities.get('admin').user.active = false;
  const revoked = await request(document.downloadUrl);
  assert.equal(revoked.status, 401);
  assert.equal(resolved.filter(path => path === document.downloadUrl).length, 5);
}));

test('cross-origin requests and stale transport updates fail through the HTTP API without creating a new draft or archive', async () => httpFixture(async ({ request }) => {
  const crossOrigin = await request('/api/documents/settlements/3010/generate', { method: 'POST', headers: { origin: 'https://another-site.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, 'origin_forbidden');
  const initial = await (await request('/api/documents/transport/AO-1042')).json();
  const input = transportInput(initial.draft);
  const saved = await request('/api/documents/transport/AO-1042', { method: 'PUT', body: JSON.stringify(input) });
  assert.equal(saved.status, 200);
  const competing = await request('/api/documents/transport/AO-1042', { method: 'PUT', body: JSON.stringify({ ...input, driver: 'Another driver' }) });
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).code, 'version_conflict');
  const latest = await (await request('/api/documents/transport/AO-1042')).json();
  assert.equal(latest.draft.version, 1);
  assert.equal(latest.draft.driver, initial.draft.driver);
  assert.deepEqual(latest.documents, []);
}));
