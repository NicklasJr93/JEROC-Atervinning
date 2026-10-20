import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { createWeighedDocumentEmail, WeighedDocumentEmailError } from './weighed-document-email.mjs';
import { SystemEmailError } from './system-email.mjs';

const COMPANY = 'office-company-a', AT = '2026-10-20T09:00:00.000Z';
const hash = value => createHash('sha256').update(value).digest('hex');
const pdf = Buffer.from('%PDF-1.4\nFROZEN_FINAL_ORIGINAL\n%%EOF\n');
const sourceHash = hash('approved-financial-version');
const failure = code => error => error instanceof WeighedDocumentEmailError && error.code === code;
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
function source(cardId = 3001) {
  const approval = { id: randomUUID(), cardId, version: 1, status: 'attested', attestedAt: AT, approvedAt: AT,
    approvedMethod: 'staff_checked_id', approvedHash: sourceHash, snapshot: { hash: sourceHash, card: { id: cardId } } };
  const record = { id: randomUUID(), kind: 'settlement', sourceId: String(cardId), sourceVersion: 1, stage: 'final',
    sourceHash, pdfHash: hash(pdf), pdf: Buffer.from(pdf), snapshot: { type: 'settlement', status: 'final', sourceId: String(cardId),
      sourceHash, company: { id: COMPANY, name: 'Företaget AB' }, approval: { version: 1 }, attest: { at: AT } } };
  const { pdf: _pdf, snapshot: _snapshot, ...document } = record;
  return { approval, record, document };
}
async function fixture(run, { enabled = true, recipients = ['office@example.test'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'weighed-document-email-')), filename = join(dir, 'application.sqlite');
  let repository, time = new Date(AT), locked = false;
  const records = new Map(), sends = [], services = [];
  const initial = () => ({ metadata: { organisation: { id: COMPANY }, companySettings: { companyId: COMPANY, version: 1,
    profile: { name: 'Företaget AB' }, notifications: { weighedDocumentEmail: { enabled, recipients } } },
    weighedDocumentEmailEnabledAt: AT }, imports: [] });
  async function open() {
    repository = await createApplicationRepository({ env: {}, filename, seed: initial });
    const transact = repository.transact.bind(repository);
    repository.transact = operation => transact(async state => { locked = true; try { return await operation(state); } finally { locked = false; } });
  }
  await open();
  const email = { configured: true, async sendWeighedDocument(command) {
    assert.equal(locked, false, 'provider calls never run under database locks'); sends.push(command); return { providerId: randomUUID() };
  } };
  const make = (overrides = {}) => {
    const service = createWeighedDocumentEmail({ organisationId: COMPANY, getRepository: async () => repository,
      readDocument: async id => { assert.equal(locked, false); const record = records.get(id); return record && { ...structuredClone(record), pdf: Buffer.from(record.pdf) }; },
      email, now: () => time, ...overrides });
    services.push(service); return service;
  };
  const add = (cardId = 3001) => { const value = source(cardId); records.set(value.document.id, value.record); return value; };
  const change = async command => repository.transact(state => command(state.metadata));
  try {
    await run({ service: make(), make, add, records, sends, email, change,
      get repository() { return repository; }, advance: milliseconds => { time = new Date(+time + milliseconds); },
      reopen: async () => { for (const service of services) await service.close(); await repository.close(); await open(); return make(); },
    });
  } finally { for (const service of services) await service.close(); await repository.close(); await rm(dir, { recursive: true, force: true }); }
}

test('attested original queues per recipient once, persists restart, sends the archived PDF and never sends under a DB lock', () => fixture(async f => {
  const value = f.add();
  assert.deepEqual(await f.service.enqueue(value.approval, value.document), { status: 'queued', documentId: value.document.id, queued: 1 });
  assert.equal((await f.service.enqueue(value.approval, value.document)).queued, 0);
  const queued = await f.repository.read(state => structuredClone(state.metadata.weighedDocumentEmailOutbox.jobs[0]));
  const resumed = await f.reopen();
  assert.deepEqual(await resumed.processQueuedWeighedDocumentEmails(), { processed: 1, sent: 1, failed: 0, unknown: 0 });
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0], { to: 'office@example.test', requestId: queued.requestId, createdAt: AT, companyName: 'Företaget AB',
    cardNumber: '3001', documentId: value.document.id, pdf });
  assert.equal((await resumed.status()).sent, 1);
  assert.equal((await resumed.enqueue(value.approval, value.document)).queued, 0);
  assert.equal((await resumed.processQueuedWeighedDocumentEmails()).processed, 0);
  const audit = await f.repository.read(state => JSON.stringify(state.metadata.weighedDocumentEmailOutbox.audit));
  assert.ok(!audit.includes('office@example.test')); assert.ok(!audit.includes('FROZEN_FINAL_ORIGINAL'));
}));

test('off records nothing; the activation cutoff prevents backfill of old attested records', () => fixture(async f => {
  const old = f.add();
  assert.equal((await f.service.enqueue(old.approval, old.document)).status, 'skipped');
  await f.change(metadata => { metadata.companySettings.notifications.weighedDocumentEmail.enabled = true; metadata.weighedDocumentEmailEnabledAt = '2026-10-20T09:00:01.000Z'; });
  assert.equal((await f.service.enqueue(old.approval, old.document)).status, 'skipped');
  const historic = f.add(3002); historic.approval.attestedAt = '2026-10-19T09:00:00.000Z';
  assert.equal((await f.service.enqueue(historic.approval, historic.document)).status, 'skipped');
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal(f.sends.length, 0);
  assert.equal((await f.service.status()).decisions, 0);
}, { enabled: false }));

test('turning off cancels queued jobs; removing a recipient cannot redirect its frozen copy to a new address', () => fixture(async f => {
  const first = f.add(); await f.service.enqueue(first.approval, first.document);
  await f.change(metadata => { metadata.companySettings.notifications.weighedDocumentEmail.enabled = false; });
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal((await f.service.status()).cancelled, 1);
  await f.change(metadata => { metadata.companySettings.notifications.weighedDocumentEmail = { enabled: true, recipients: ['office@example.test'] }; });
  const next = f.add(3002); await f.service.enqueue(next.approval, next.document);
  await f.change(metadata => { metadata.companySettings.notifications.weighedDocumentEmail.recipients = ['different@example.test']; });
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal((await f.service.status()).cancelled, 2); assert.equal(f.sends.length, 0);
}));

test('only original final attested documents with matching proof and tenant may enqueue; archived bytes must match checksum', () => fixture(async f => {
  for (const update of [
    value => { value.approval.status = 'approved'; }, value => { value.approval.approvedHash = hash('different'); },
    value => { value.document.stage = 'reviewed'; }, value => { value.document.sourceId = '9999'; },
    value => { value.document.sourceVersion = 2; }, value => { value.document.paymentRevision = true; },
    value => { value.record.snapshot.approval.version = 2; }, value => { value.record.snapshot.attest.at = '2026-10-19T09:00:00.000Z'; },
    value => { value.record.snapshot.paymentConfirmation = { version: 2 }; }, value => { value.record.snapshot.company.id = 'foreign-company'; },
    value => { value.record.pdf = Buffer.from('%PDF-1.4\nMODIFIED\n%%EOF\n'); },
  ]) {
    const value = f.add(); update(value);
    await assert.rejects(f.service.enqueue(value.approval, value.document), error => error instanceof WeighedDocumentEmailError);
  }
  assert.equal((await f.service.status()).decisions, 0); assert.equal(f.sends.length, 0);
  const value = f.add();
  await f.change(metadata => { metadata.companySettings.companyId = 'foreign-company'; });
  await assert.rejects(f.service.enqueue(value.approval, value.document), failure('weighed_email_tenant_mismatch'));
}));

test('parallel workers cannot claim the same active durable lease', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  const release = gate(), entered = gate();
  f.email.sendWeighedDocument = async command => { f.sends.push(command); entered.release(); await release.promise; return { providerId: randomUUID() }; };
  const second = f.make();
  const active = f.service.processQueuedWeighedDocumentEmails(); await entered.promise;
  assert.equal((await second.processQueuedWeighedDocumentEmails()).processed, 0);
  release.release(); await active;
  assert.equal(f.sends.length, 1);
}));

test('each recipient gets its own idempotency identity and archived copy', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).sent, 2);
  assert.deepEqual(new Set(f.sends.map(value => value.to)), new Set(['office@example.test', 'finance@example.test']));
  assert.equal(new Set(f.sends.map(value => value.requestId)).size, 2);
}, { recipients: ['office@example.test', 'finance@example.test'] }));

test('unknown provider outcome retries the same identity/body with backoff, then stops before the provider deduplication window ends', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  f.email.sendWeighedDocument = async command => { f.sends.push(command); throw new SystemEmailError(503, 'system_email_outcome_unknown', 'unknown'); };
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).unknown, 1);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  f.advance(30_001);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).unknown, 1);
  assert.deepEqual(f.sends[1], f.sends[0]);
  f.advance(23 * 3_600_000);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  const status = await f.service.status(); assert.equal(status.unknown, 1); assert.equal(status.requiresReview, 1);
  assert.equal(f.sends.length, 2);
}));

test('known safe missing configuration or provider rate limit retries; rejected credentials remain a visible failed job', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  f.email.configured = false;
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).failed, 1); assert.equal(f.sends.length, 0);
  f.email.configured = true; f.advance(30_001);
  let attempts = 0;
  f.email.sendWeighedDocument = async command => { f.sends.push(command); if (++attempts === 1) throw new SystemEmailError(429, 'system_email_rate_limited', 'throttled'); return { providerId: randomUUID() }; };
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).failed, 1);
  f.advance(5 * 60_000 + 1);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).sent, 1);
  assert.deepEqual(f.sends[1], f.sends[0]);
  const next = f.add(3002); await f.service.enqueue(next.approval, next.document);
  f.email.sendWeighedDocument = async () => { throw new SystemEmailError(503, 'system_email_rejected', 'credentials rejected'); };
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).failed, 1);
  f.advance(16 * 60_000);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal((await f.service.status()).failed, 1);
}));

test('tampered PDF after enqueue cannot be delivered; provider is never called', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  value.record.pdf = Buffer.from('%PDF-1.4\nALTERED AFTER QUEUE\n%%EOF\n');
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).failed, 1);
  assert.equal(f.sends.length, 0); assert.equal((await f.service.status()).failed, 1);
}));

test('an expired lease retries the same send identity while a late worker cannot overwrite the newer acknowledgement', () => fixture(async f => {
  const value = f.add(); await f.service.enqueue(value.approval, value.document);
  const release = gate(), entered = gate(), oldId = randomUUID(), winnerId = randomUUID();
  f.email.sendWeighedDocument = async command => {
    f.sends.push(command); if (f.sends.length === 1) { entered.release(); await release.promise; return { providerId: oldId }; }
    return { providerId: winnerId };
  };
  const active = f.service.processQueuedWeighedDocumentEmails(); await entered.promise;
  f.advance(90_001);
  const second = f.make(); assert.equal((await second.processQueuedWeighedDocumentEmails()).sent, 1);
  release.release(); await active;
  assert.deepEqual(f.sends[0], f.sends[1]);
  const job = await f.repository.read(state => state.metadata.weighedDocumentEmailOutbox.jobs[0]);
  assert.equal(job.status, 'sent'); assert.equal(job.providerId, winnerId);
}));

test('batch is bounded and close aborts/awaits the active provider operation', () => fixture(async f => {
  for (let card = 3001; card <= 3012; card++) { const value = f.add(card); await f.service.enqueue(value.approval, value.document); }
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 10);
  const entered = gate();
  f.email.sendWeighedDocument = async (_command, { signal }) => { entered.release(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const active = f.service.processQueuedWeighedDocumentEmails(); await entered.promise;
  await f.service.close(); await active;
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal((await f.service.status()).unknown, 1);
}));

test('disabled and completed queues use metadata reads without locking the full application aggregate', () => fixture(async f => {
  const transact = f.repository.transact.bind(f.repository); let writes = 0;
  f.repository.transact = (...args) => { writes++; return transact(...args); };
  const value = f.add();
  for (let index = 0; index < 30; index++) assert.equal((await f.service.enqueue(value.approval, value.document)).status, 'skipped');
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal(writes, 0); assert.equal((await f.service.status()).decisions, 0);
  await f.change(metadata => { metadata.companySettings.notifications.weighedDocumentEmail.enabled = true; });
  await f.service.enqueue(value.approval, value.document);
  await f.service.processQueuedWeighedDocumentEmails();
  writes = 0;
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).processed, 0);
  assert.equal(writes, 0);
}, { enabled: false }));

test('large completed history cannot block a new attested copy and permanent deduplication keys remain intact', () => fixture(async f => {
  const old = f.add(3000);
  await f.service.enqueue(old.approval, old.document);
  await f.service.processQueuedWeighedDocumentEmails();
  const oldRequestId = f.sends[0].requestId;
  await f.change(metadata => {
    const data = metadata.weighedDocumentEmailOutbox;
    data.decisions.push(...Array.from({ length: 10_000 }, (_, index) => ({ key: `past-decision-${index}`, documentId: `past-document-${index}`, status: 'queued' })));
    data.jobs.push(...Array.from({ length: 100_000 }, (_, index) => ({ requestId: `past-job-${index}`, organisationId: COMPANY, status: 'sent' })));
  });
  const next = f.add();
  assert.equal((await f.service.enqueue(next.approval, next.document)).queued, 1);
  assert.equal((await f.service.processQueuedWeighedDocumentEmails()).sent, 1);
  assert.equal((await f.service.enqueue(old.approval, old.document)).queued, 0);
  const retained = await f.repository.read(state => ({ decisions: state.metadata.weighedDocumentEmailOutbox.decisions.length,
    jobs: state.metadata.weighedDocumentEmailOutbox.jobs.length, firstRequestId: state.metadata.weighedDocumentEmailOutbox.jobs[0].requestId }));
  assert.deepEqual(retained, { decisions: 10_002, jobs: 100_002, firstRequestId: oldRequestId });
  assert.equal(f.sends.length, 2);
}));
