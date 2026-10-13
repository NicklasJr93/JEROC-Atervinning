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
const paymentRevisionJob = (sources, changes = {}) => ({
  id: randomUUID(), mode: 'mss', simulation: true, createdAt: '2026-10-13T08:45:00.000Z',
  source: { cardId: sources.approvals[0].cardId, approvalId: sources.approvals[0].id, version: sources.approvals[0].version,
    siteId: sources.approvals[0].siteId, hash: sources.approvals[0].snapshot.hash },
  sourceSnapshotHash: sources.approvals[0].snapshot.hash, sourceSnapshot: structuredClone(sources.approvals[0].snapshot),
  originalPaymentDetails: structuredClone(sources.approvals[0].snapshot.card.paymentDetails),
  paymentDetails: { method: 'swish', phone: '+46711111132', recipient: 'Testkunden', personalNumber: '197709306828' },
  reason: 'Kunden önskar Swish i stället för bankkonto.',
  revisionActor: { actualUserId: 'admin', effectiveUserId: 'anna', name: 'Anna', actualName: 'Systemadmin' }, ...changes,
});
const paymentConfirmationJob = sources => {
  const job = paymentRevisionJob(sources);
  job.kind = 'card'; job.status = 'simulated_paid'; job.amountCents = 4000;
  job.source.customerId = sources.approvals[0].snapshot.customer.id;
  job.paymentDetails.personalNumber = sources.approvals[0].snapshot.customer.number;
  job.verifiedAt = '2026-10-13T08:47:01.000Z'; job.providerInstructionUUID = randomUUID();
  job.providerPaymentReference = 'SWISH-MSS-CONFIRMATION-001';
  job.request = { payload: { payoutInstructionUUID: job.providerInstructionUUID, payerPaymentReference: 'SP-PDF-TEST-001',
    payerAlias: '1234679304', payeeAlias: job.paymentDetails.phone.slice(1), payeeSSN: job.paymentDetails.personalNumber,
    amount: '40.00', currency: 'SEK', payoutType: 'PAYOUT', instructionDate: job.createdAt } };
  job.providerResult = { ...job.request.payload, status: 'PAID', datePaid: '2026-10-13T08:47:00.000Z', paymentReference: job.providerPaymentReference };
  return job;
};
async function serviceFixture(run) {
  return archiveFixture(async ({ repository, instance }) => {
    const sources = businessSources(), rendered = [];
    const options = { repository, sourceProvider: async () => structuredClone(sources), renderPdf: async snapshot => { rendered.push(snapshot); return pdfBytes; }, now: () => new Date('2026-10-10T10:00:00.000Z') };
    await run({ sources, rendered, repository, instance, options, service: createDocumentService(options) });
  });
}

test('settlement list reads existing archive metadata and signals pending milestones without rendering or writing', async () => serviceFixture(async ({ service, options, sources, rendered, repository }) => {
  attest(sources.approvals[0]);
  const requests = [];
  const readOnly = createDocumentService({ ...options,
    sourceProvider: async request => { requests.push(request); return structuredClone(sources); },
    repository: { ...repository, transact: () => { throw new Error('A list GET must not open an archive write transaction'); } },
  });
  const pending = await readOnly.list({ kind: 'settlement', sourceId: '3010' }, admin);
  assert.equal(pending.pending, true); assert.deepEqual(pending.documents, []); assert.equal(rendered.length, 0);
  assert.deepEqual(requests[0], { kind: 'settlement', sourceId: '3010' });
  await service.ensureApproval(sources.approvals[0]);
  const completed = await readOnly.list({ kind: 'settlement', sourceId: '3010' }, admin);
  assert.equal(completed.pending, false); assert.equal(completed.documents.length, 3); assert.equal(rendered.length, 3);
}));

test('durable PDF job uses its frozen facility and approval without rereading mutable business stores', async () => serviceFixture(async ({ options, sources, repository }) => {
  const frozen = structuredClone(sources.approvals[0]);
  const job = { stage: 'preliminary', sourceHash: frozen.snapshot.hash, siteSnapshot: structuredClone(sources.sites[0]) };
  sources.office.cards[0].rows[0].weight = 999;
  sources.sites[0].name = 'Changed live facility';
  const service = createDocumentService({ ...options, sourceProvider: () => { throw new Error('A current durable PDF job needs no source reread'); } });
  const document = await service.archiveApprovalJob(frozen, job);
  const saved = await repository.read(database => database.document(document.id));
  assert.equal(saved.snapshot.rows[0].weight, frozen.snapshot.rows[0].weight);
  assert.equal(saved.snapshot.site.name, 'Norrtälje');
}));

test('two company PDF jobs with identical source IDs retain their own buyer and transport identity', async () => {
  for (const company of [{ id: 'company-a', name: 'Återbruk A AB', number: '5593593626' }, { id: 'company-b', name: 'Metall B AB', number: '5560000167' }]) {
    await serviceFixture(async ({ options, sources, repository }) => {
      sources.company = structuredClone(company);
      const frozen = structuredClone(sources.approvals[0]);
      const job = { stage: 'preliminary', sourceHash: frozen.snapshot.hash, siteSnapshot: structuredClone(sources.sites[0]), companySnapshot: structuredClone(company) };
      const noReread = createDocumentService({ ...options, sourceProvider: () => { throw new Error('Frozen PDF jobs must not reread a mutable company'); } });
      const document = await noReread.archiveApprovalJob(frozen, job);
      const saved = await repository.read(database => database.document(document.id));
      assert.equal(saved.sourceId, '3010');
      assert.equal(saved.snapshot.company.id, company.id);
      assert.equal(saved.snapshot.company.name, company.name);
      assert.equal(saved.snapshot.company.number, company.number);
      assert.doesNotMatch(JSON.stringify(saved.snapshot.company), /JEROC/);
      const service = createDocumentService(options);
      sources.transport.drivers[0].companyId = undefined;
      const transport = await service.transport('AO-1042', admin);
      assert.equal(transport.draft.receiver.name, company.name);
      assert.equal(transport.draft.carrier.number, company.number);
    });
  }
});

test('legacy priced rows without articleName resolve only their missing human names for a current draft', async () => serviceFixture(async ({ options, sources, repository }) => {
  sources.approvals = []; sources.office.cards[0].status = 'new';
  delete sources.office.cards[0].rows[0].articleName;
  const requests = [];
  const service = createDocumentService({ ...options, sourceProvider: async request => {
    requests.push(request);
    return request.kind === 'article-names'
      ? { pricing: { articles: [{ id: sources.office.cards[0].rows[0].articleId, name: 'Koppar klass 1' }] } } : structuredClone(sources);
  } });
  const { document } = await service.generateSettlement(3010, { stage: 'preliminary' }, admin);
  const saved = await repository.read(database => database.document(document.id));
  assert.equal(saved.snapshot.rows[0].name, 'Koppar klass 1');
  assert.deepEqual(requests.filter(request => request.kind === 'article-names'), [{ kind: 'article-names', articleIds: [sources.office.cards[0].rows[0].articleId] }]);
  const count = requests.length;
  await service.list({ kind: 'settlement', sourceId: '3010' }, admin);
  assert.ok(requests.slice(count).every(request => request.kind !== 'article-names'), 'Opening an archive list must not fetch rendering-only names');
}));

test('simultaneous generation of the same immutable version shares one render and retains one original', async () => serviceFixture(async ({ options, sources, repository }) => {
  let renders = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createDocumentService({ ...options, renderPdf: async () => { renders++; await gate; return pdfBytes; } });
  const pending = Array.from({ length: 5 }, () => service.generateSettlement(3010, {}, admin));
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const documents = await Promise.all(pending);
  assert.equal(renders, 1); assert.equal(new Set(documents.map(value => value.document.id)).size, 1);
  assert.equal((await repository.read(database => database.documents('settlement', sources.approvals[0].cardId))).length, 1);
}));

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

test('payment PDF revision preserves the original settlement, financial snapshot and company and becomes the default PDF', async () => serviceFixture(async ({ service, sources, repository }) => {
  attest(sources.approvals[0]);
  const originalDocument = (await service.generateSettlement(3010, { stage: 'final' }, admin)).document;
  const originalRecord = await service.download(originalDocument.id, admin);
  sources.company.name = 'Ny profil som inte får ändra originalet';
  sources.sites[0].address = 'En senare anläggningsadress';
  const job = paymentRevisionJob(sources), before = structuredClone(sources);
  const revised = await service.archivePaymentRevision(job);
  assert.equal(revised.version, 2);
  assert.equal(revised.originalDocumentId, originalDocument.id);
  const record = await service.download(revised.documentId, admin);
  assert.equal(record.snapshot.id, originalRecord.snapshot.id);
  assert.equal(record.sourceVersion, originalRecord.sourceVersion);
  for (const field of ['company', 'site', 'customer', 'rows', 'gross', 'offset', 'net', 'tax', 'issuedAt', 'receivedAt', 'reference', 'approval', 'attest', 'selfBilling'])
    assert.deepEqual(record.snapshot[field], originalRecord.snapshot[field], field);
  assert.equal(record.snapshot.payment.method, 'swish');
  assert.equal(record.snapshot.payment.maskedAccount, '•••• 1132');
  assert.equal(record.snapshot.payment.recipient, 'Testkunden');
  assert.equal(record.snapshot.paymentRevision.actor.name, 'Anna');
  assert.equal(record.snapshot.paymentRevision.replacesDocumentId, originalDocument.id);
  assert.equal(record.snapshot.paymentRevision.simulation, true);
  assert.equal('paidAt' in record.snapshot.payment, false);
  assert.equal('personalNumber' in record.snapshot.payment, false);
  assert.deepEqual(await service.download(originalDocument.id, admin), originalRecord);
  assert.deepEqual(sources, before, 'No invoice, payment or frozen business record is mutated.');
  assert.equal((await service.generateSettlement(3010, { stage: 'final' }, admin)).document.id, revised.documentId);
  const listed = await service.list({ kind: 'settlement', sourceId: '3010' }, admin);
  assert.equal(listed.documents.length, 2);
  assert.equal(listed.documents.find(doc => doc.id === revised.documentId).pdfVersion, 2);
  assert.equal((await repository.read(db => db.documents('settlement', '3010'))).length, 2);
}));

test('one committed payment job archives one PDF under repeated concurrent delivery; later changed instructions retain revision history', async () => serviceFixture(async ({ service, sources }) => {
  attest(sources.approvals[0]);
  const job = paymentRevisionJob(sources);
  const revisions = await Promise.all(Array.from({ length: 5 }, () => service.archivePaymentRevision(structuredClone(job))));
  assert.equal(new Set(revisions.map(revision => revision.documentId)).size, 1);
  assert.equal(revisions[0].version, 2);
  const another = await service.archivePaymentRevision(paymentRevisionJob(sources, { paymentDetails: { ...job.paymentDetails, phone: '+46711111134' }, reason: 'Rättat Swish-nummer.' }));
  assert.equal(another.version, 3);
  assert.equal(another.originalDocumentId, revisions[0].originalDocumentId);
  assert.equal((await service.download(another.documentId, admin)).snapshot.paymentRevision.replacesDocumentId, revisions[0].documentId);
  assert.equal((await service.list({ kind: 'settlement', sourceId: '3010' }, admin)).documents.length, 3);
  await assert.rejects(() => service.archivePaymentRevision({ ...job, paymentDetails: { ...job.paymentDetails, phone: '+46711111135' } }), expectError(409, 'payment_revision_conflict'));
}));

test('payment PDF revisions require a matching attested snapshot and an override reason; unchanged payment creates no revision', async () => serviceFixture(async ({ service, sources, rendered }) => {
  attest(sources.approvals[0]);
  const job = paymentRevisionJob(sources);
  assert.equal(await service.archivePaymentRevision({ ...job, paymentDetails: job.originalPaymentDetails }), null);
  assert.equal(rendered.length, 0);
  await assert.rejects(() => service.archivePaymentRevision({ ...job, reason: '' }), expectError(422, 'payment_revision_reason_required'));
  await assert.rejects(() => service.archivePaymentRevision({ ...job, sourceSnapshot: { ...job.sourceSnapshot, net: 4000 } }), expectError(409, 'payment_revision_source_changed'));
  await assert.rejects(() => service.archivePaymentRevision({ ...job, source: { ...job.source, siteId: 'other-tenant-site' } }), expectError(409, 'payment_revision_source_changed'));
  await assert.rejects(() => service.archivePaymentRevision({ ...job, revisionActor: undefined }), expectError(409, 'payment_revision_source_missing'));
  sources.approvals[0].status = 'cancelled';
  await assert.rejects(() => service.archivePaymentRevision(job), expectError(409, 'payment_revision_source_changed'));
  assert.equal(rendered.length, 0);
}));

test('revised payment PDFs retain fresh financial and facility access checks', async () => serviceFixture(async ({ service, sources }) => {
  attest(sources.approvals[0]);
  const result = await service.archivePaymentRevision(paymentRevisionJob(sources));
  await assert.rejects(() => service.download(result.documentId, worker(['view'])), expectError(403, 'financial_visibility_required'));
  await assert.rejects(() => service.download(result.documentId, worker(['view', 'pay'], ['rimbo'])), expectError(403, 'site_forbidden'));
  assert.equal((await service.download(result.documentId, worker(['view', 'pay'], ['norrtalje']))).id, result.documentId);
}));

test('verified Swish confirmation creates immutable PDF after instructions and preserves financial data and all archived originals', async () => serviceFixture(async ({ service, sources, repository }) => {
  attest(sources.approvals[0]);
  const job = paymentConfirmationJob(sources), before = structuredClone(sources);
  const revision = await service.archivePaymentRevision(job);
  const original = await service.download(revision.originalDocumentId, admin);
  const instructions = await service.download(revision.documentId, admin);
  sources.company.name = 'Muterad profil som inte får bli källan';
  sources.sites[0].address = 'Ny adress efter attest';
  const confirmed = await service.archivePaymentConfirmation(job);
  assert.equal(confirmed.version, 3);
  const record = await service.download(confirmed.documentId, admin), snapshot = record.snapshot;
  for (const field of ['id', 'company', 'site', 'customer', 'rows', 'gross', 'offset', 'net', 'tax', 'issuedAt', 'receivedAt', 'reference', 'approval', 'attest', 'selfBilling'])
    assert.deepEqual(snapshot[field], original.snapshot[field], field);
  assert.deepEqual(snapshot.paymentRevision, instructions.snapshot.paymentRevision);
  assert.equal(snapshot.paymentConfirmation.replacesDocumentId, instructions.id);
  assert.equal(snapshot.paymentConfirmation.actualPaidAt, job.providerResult.datePaid);
  assert.equal(snapshot.paymentConfirmation.verifiedAt, job.verifiedAt);
  assert.equal(snapshot.paymentConfirmation.providerRef, job.providerPaymentReference);
  assert.equal(snapshot.paymentConfirmation.maskedPhone, '•••• 1132');
  assert.equal(snapshot.paymentConfirmation.maskedPersonalNumber, '•••• 1234');
  assert.equal(snapshot.paymentConfirmation.amountCents, 4000);
  assert.equal(snapshot.paymentConfirmation.simulation, true);
  assert.equal(snapshot.paymentConfirmation.mode, 'mss');
  assert.doesNotMatch(JSON.stringify(snapshot), /198001011234|46711111132/);
  assert.deepEqual(await service.download(original.id, admin), original);
  assert.deepEqual(await service.download(instructions.id, admin), instructions);
  assert.deepEqual(sources.office, before.office, 'No card financial state, invoice or real payment journal is touched.');
  assert.deepEqual(sources.approvals, before.approvals);
  assert.equal((await service.generateSettlement(3010, { stage: 'final' }, admin)).document.id, confirmed.documentId);
  const listed = await service.list({ kind: 'settlement', sourceId: '3010' }, admin);
  assert.equal(listed.documents.length, 3);
  const metadata = listed.documents.find(value => value.id === confirmed.documentId);
  assert.equal(metadata.paymentConfirmation, true);
  assert.equal(metadata.paymentRevision, undefined);
  assert.equal(metadata.pdfVersion, 3);
  assert.match(metadata.title, /betalningsbekräftelse/);
  assert.equal((await repository.read(db => db.documents('settlement', '3010'))).length, 3);
}));

test('unchanged payment instructions still get one confirmation PDF under concurrent retries, without Spiris bookkeeping success', async () => serviceFixture(async ({ service, sources }) => {
  attest(sources.approvals[0]);
  const details = { method: 'swish', phone: '+46711111132', recipient: 'Testkunden', personalNumber: sources.approvals[0].snapshot.customer.number };
  sources.approvals[0].snapshot.card.paymentDetails = structuredClone(details);
  sources.approvals[0].snapshot.paymentMethod = 'swish';
  const job = paymentConfirmationJob(sources); job.paymentDetails = structuredClone(details);
  job.bookkeeping = { status: 'waiting_booked' };
  assert.equal(await service.archivePaymentRevision(job), null);
  const results = await Promise.all(Array.from({ length: 5 }, () => service.archivePaymentConfirmation(structuredClone(job))));
  assert.equal(new Set(results.map(value => value.documentId)).size, 1);
  assert.equal(results[0].version, 2);
  assert.equal((await service.list({ kind: 'settlement', sourceId: '3010' }, admin)).documents.length, 2);
  job.bookkeeping = { status: 'failed', error: 'Spiris tillfälligt otillgängligt' };
  assert.equal((await service.archivePaymentConfirmation(job)).documentId, results[0].documentId);
  await assert.rejects(() => service.archivePaymentConfirmation({ ...job, verifiedAt: '2026-10-13T08:48:00Z' }), expectError(409, 'payment_confirmation_conflict'));
}));

test('confirmation rejects pending, mismatched, malformed and non-MSS proof before any source IO, rendering or archive writes', async () => serviceFixture(async ({ sources, options, repository, rendered }) => {
  attest(sources.approvals[0]);
  const job = paymentConfirmationJob(sources); let sourceReads = 0;
  const service = createDocumentService({ ...options, sourceProvider: async () => { sourceReads++; return structuredClone(sources); } });
  const bad = [
    { ...job, status: 'pending' }, { ...job, mode: 'production' }, { ...job, kind: 'sandbox' },
    { ...job, verifiedAt: null }, { ...job, amountCents: 5000 },
    { ...job, providerResult: { ...job.providerResult, status: 'CREATED' } },
    { ...job, providerResult: { ...job.providerResult, payeeSSN: '197709306828' } },
    { ...job, providerResult: { ...job.providerResult, datePaid: 'not-a-date' } },
    { ...job, providerResult: { ...job.providerResult, datePaid: '2026-10-14T08:47:00Z' } },
    { ...job, paymentDetails: { ...job.paymentDetails, phone: '+46711111133' } },
  ];
  for (const value of bad) await assert.rejects(() => service.archivePaymentConfirmation(value), expectError(409, 'payment_confirmation_unverified'));
  assert.equal(sourceReads, 0); assert.equal(rendered.length, 0);
  assert.equal((await repository.read(db => db.documents('settlement', '3010'))).length, 0);
}));

test('confirmation verifies frozen approval, customer identity, amount and site before rendering', async () => serviceFixture(async ({ service, sources, rendered }) => {
  attest(sources.approvals[0]); const job = paymentConfirmationJob(sources);
  for (const source of [{ ...job.source, hash: 'another-hash' }, { ...job.source, siteId: 'other-company-site' }, { ...job.source, customerId: 'other-customer' }])
    await assert.rejects(() => service.archivePaymentConfirmation({ ...job, source }), error => ['payment_confirmation_source_missing', 'payment_confirmation_source_changed'].includes(error.code));
  await assert.rejects(() => service.archivePaymentConfirmation({ ...job, sourceSnapshot: { ...job.sourceSnapshot, net: 5000 } }), expectError(409, 'payment_confirmation_source_changed'));
  sources.approvals[0].snapshot.customer.number = '197709306828';
  await assert.rejects(() => service.archivePaymentConfirmation(job), expectError(409, 'payment_confirmation_source_changed'));
  assert.equal(rendered.length, 0);
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
