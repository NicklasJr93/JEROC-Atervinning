import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SystemEmailError, MAX_SYSTEM_EMAIL_PDF_BYTES } from './system-email.mjs';

const HOUR = 3_600_000, RETRY_WINDOW = 23 * HOUR, LEASE = 90_000;
const MAX_PENDING_JOBS = 100_000, BATCH = 10;
const BACKOFF = [30_000, 5 * 60_000, 15 * 60_000];
const uuid = z.string().uuid(), emailAddress = z.string().max(254).email();
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeText = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

export class WeighedDocumentEmailError extends Error {
  constructor(code, message = 'Det vägda underlagets mejlkopia kunde inte behandlas säkert.') {
    super(message); this.name = 'WeighedDocumentEmailError'; this.status = 503; this.code = code;
  }
}
const fail = code => { throw new WeighedDocumentEmailError(code); };
const pendingJob = job => !job.requiresReview && (['queued', 'sending'].includes(job.status)
  || ['failed', 'unknown'].includes(job.status) && job.retryable === true);
const registry = state => {
  state.metadata ??= {};
  const value = state.metadata.weighedDocumentEmailOutbox ??= { decisions: [], jobs: [], audit: [] };
  if (!Array.isArray(value.decisions) || !Array.isArray(value.jobs) || !Array.isArray(value.audit)) fail('weighed_email_storage_invalid');
  return value;
};

/** Tenant-owned durable outbox. No HTTP entry point accepts recipients, PDFs or
 * document IDs. Only the trusted final-approval archive hook creates decisions.
 * Provider calls always run after database locks have been released.
 */
export function createWeighedDocumentEmail({ organisationId, getRepository, readDocument, email, now = () => new Date() } = {}) {
  if (typeof organisationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(organisationId)
    || typeof getRepository !== 'function' || typeof readDocument !== 'function' || typeof email?.sendWeighedDocument !== 'function')
    throw new TypeError('Vägt underlag behöver bolagsbunden lagring, dokumentarkiv och mejlleverantör.');
  const at = () => new Date(now()).toISOString();
  let closed = false, flight, activeController;

  function settings(state) {
    const owner = state.metadata?.organisation?.id, value = state.metadata?.companySettings;
    if (owner !== undefined && owner !== organisationId || value && value.companyId !== organisationId) fail('weighed_email_tenant_mismatch');
    const config = value?.notifications?.weighedDocumentEmail;
    if (!config) return { enabled: false, recipients: [], version: value?.version ?? 0, enabledAt: undefined };
    if (typeof config.enabled !== 'boolean' || !Array.isArray(config.recipients) || config.recipients.length > 10
      || config.recipients.some(to => typeof to !== 'string' || !emailAddress.safeParse(to).success || /[\u0000-\u001f\u007f]/.test(to))) fail('weighed_email_settings_invalid');
    const recipients = [...new Set(config.recipients.map(to => to.trim().toLowerCase()))];
    const enabledAt = state.metadata?.weighedDocumentEmailEnabledAt;
    return { enabled: config.enabled && recipients.length > 0 && validTime(enabledAt), recipients, version: value.version, enabledAt };
  }
  function audit(data, action, record, stamp) {
    data.audit.push({ id: randomUUID(), at: stamp, action, organisationId,
      ...(record.requestId && { requestId: record.requestId }), ...(record.documentId && { documentId: record.documentId }),
      ...(record.to && { recipientHash: hash(record.to) }), ...(record.errorCode && { code: record.errorCode }) });
    data.audit = data.audit.slice(-1000);
  }
  function documentMatches(record, expected) {
    if (!record || record.id !== expected.documentId || record.kind !== 'settlement' || record.stage !== 'final'
      || String(record.sourceId) !== expected.cardNumber || record.sourceVersion !== expected.sourceVersion
      || record.sourceHash !== expected.sourceHash || record.pdfHash !== expected.pdfHash
      || record.snapshot?.company?.id !== organisationId || record.snapshot.company.name !== expected.companyName
      || record.snapshot.type !== 'settlement' || record.snapshot.status !== 'final'
      || String(record.snapshot.sourceId) !== expected.cardNumber || record.snapshot.sourceHash !== expected.sourceHash
      || record.snapshot.approval?.version !== expected.sourceVersion || record.snapshot.attest?.at !== expected.attestedAt
      || record.snapshot.paymentRevision || record.snapshot.paymentConfirmation || record.paymentRevision || record.paymentConfirmation
      || record.originalDocumentId || record.pdfVersion !== undefined && record.pdfVersion !== 1
      || !Buffer.isBuffer(record.pdf) || record.pdf.length < 15 || record.pdf.length > MAX_SYSTEM_EMAIL_PDF_BYTES
      || !record.pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || hash(record.pdf) !== expected.pdfHash)
      fail('weighed_email_document_mismatch');
    return record;
  }
  async function enqueue(approval, document) {
    if (closed) fail('weighed_email_closed');
    if (approval?.status !== 'attested' || !validTime(approval.attestedAt) || !validTime(approval.approvedAt)
      || !approval.approvedMethod || !validHash(approval.snapshot?.hash) || approval.approvedHash !== approval.snapshot.hash
      || typeof approval.id !== 'string' || !approval.id || approval.id.length > 100
      || !Number.isSafeInteger(approval.cardId) || approval.cardId <= 0 || approval.snapshot.card?.id !== approval.cardId
      || !Number.isSafeInteger(approval.version) || approval.version < 1
      || !uuid.safeParse(document?.id).success || document.kind !== 'settlement' || document.stage !== 'final'
      || String(document.sourceId) !== String(approval.cardId) || document.sourceVersion !== approval.version
      || document.sourceHash !== approval.snapshot.hash || !validHash(document.pdfHash)
      || document.paymentRevision || document.paymentConfirmation || document.originalDocumentId
      || document.pdfVersion !== undefined && document.pdfVersion !== 1) fail('weighed_email_invalid_source');
    const repository = await getRepository();
    const initialConfig = await repository.read(settings, { domains: ['metadata'] });
    if (!initialConfig.enabled || Date.parse(approval.attestedAt) < Date.parse(initialConfig.enabledAt))
      return { status: 'skipped', documentId: document.id, queued: 0 };
    const stored = await readDocument(document.id);
    if (!safeText(stored?.snapshot?.company?.name, 200)) fail('weighed_email_document_mismatch');
    const source = { documentId: document.id, pdfHash: document.pdfHash, sourceHash: document.sourceHash,
      sourceVersion: document.sourceVersion, cardNumber: String(approval.cardId), companyName: stored.snapshot.company.name, attestedAt: approval.attestedAt };
    documentMatches(stored, source);
    return repository.transact(state => {
      const config = settings(state), stamp = at();
      if (!config.enabled || Date.parse(approval.attestedAt) < Date.parse(config.enabledAt))
        return { status: 'skipped', documentId: document.id, queued: 0 };
      const data = registry(state);
      const key = `${approval.id}:${approval.version}:${approval.snapshot.hash}`;
      const previous = data.decisions.find(item => item.key === key || item.documentId === document.id);
      if (previous) return { status: previous.status, documentId: previous.documentId, queued: 0 };
      // Historical delivery/deduplication records must never exhaust the active
      // queue or prevent a later PDF milestone from completing. Keep their keys
      // permanently; only outstanding send work counts toward the queue bound.
      if (data.jobs.filter(pendingJob).length + config.recipients.length > MAX_PENDING_JOBS) fail('weighed_email_registry_full');
      const eligible = config.enabled && Date.parse(approval.attestedAt) >= Date.parse(config.enabledAt);
      const decision = { key, ...source, organisationId, status: eligible ? 'queued' : 'skipped', createdAt: stamp,
        ...(eligible ? { settingsVersion: config.version, enabledAt: config.enabledAt } : { reason: config.enabled ? 'before_activation' : 'disabled' }) };
      data.decisions.push(decision);
      if (eligible) for (const to of config.recipients) {
        const job = { ...source, decisionKey: key, organisationId, to, requestId: randomUUID(), status: 'queued',
          createdAt: stamp, enabledAt: config.enabledAt, settingsVersion: config.version, attempts: 0, nextAttemptAt: stamp };
        data.jobs.push(job); audit(data, 'weighed_email.queued', job, stamp);
      }
      else audit(data, 'weighed_email.skipped', decision, stamp);
      return { status: decision.status, documentId: document.id, queued: eligible ? config.recipients.length : 0 };
    });
  }
  const allowed = (config, job) => config.enabled && config.enabledAt === job.enabledAt && config.recipients.includes(job.to);
  function cancel(data, job, stamp) {
    job.status = 'cancelled'; job.nextAttemptAt = null; job.leaseUntil = 0;
    audit(data, 'weighed_email.cancelled', job, stamp);
  }
  function stopUnknown(data, job, stamp) {
    job.status = 'unknown'; job.requiresReview = true; job.nextAttemptAt = null; job.leaseUntil = 0;
    job.errorCode = 'weighed_email_retry_window_expired'; audit(data, 'weighed_email.review_required', job, stamp);
  }
  async function claim(repository) {
    return repository.transact(state => {
      const config = settings(state), data = registry(state), stamp = at(), time = Date.parse(stamp);
      for (const job of data.jobs) {
        if (job.organisationId !== organisationId) fail('weighed_email_tenant_mismatch');
        if (['sent', 'cancelled'].includes(job.status) || job.requiresReview || job.status === 'failed' && !job.retryable) continue;
        if (job.status === 'sending' && job.leaseUntil > time) continue;
        if (!allowed(config, job)) { cancel(data, job, stamp); continue; }
        if (job.firstAttemptAt && time >= Date.parse(job.firstAttemptAt) + RETRY_WINDOW) { stopUnknown(data, job, stamp); continue; }
        if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > time) continue;
        if (!['queued', 'failed', 'unknown', 'sending'].includes(job.status)) continue;
        job.status = 'sending'; job.attemptId = randomUUID(); job.attempts++; job.leaseUntil = time + LEASE;
        delete job.errorCode; delete job.retryable;
        return clone(job);
      }
    });
  }
  async function beforeSend(repository, reservation) {
    return repository.transact(state => {
      const config = settings(state), data = registry(state), stamp = at(), time = Date.parse(stamp);
      const job = data.jobs.find(item => item.requestId === reservation.requestId);
      if (!job || job.attemptId !== reservation.attemptId || job.status !== 'sending' || job.leaseUntil <= time) return;
      if (!allowed(config, job)) { cancel(data, job, stamp); return; }
      if (job.firstAttemptAt && time >= Date.parse(job.firstAttemptAt) + RETRY_WINDOW) { stopUnknown(data, job, stamp); return; }
      job.firstAttemptAt ??= stamp;
      return clone(job);
    });
  }
  async function acknowledge(repository, reservation, result, error) {
    return repository.transact(state => {
      settings(state);
      const data = registry(state), job = data.jobs.find(item => item.requestId === reservation.requestId), stamp = at();
      if (!job || job.attemptId !== reservation.attemptId || job.status !== 'sending') return;
      job.leaseUntil = 0;
      if (!error) {
        job.status = 'sent'; job.providerId = result.providerId; job.sentAt = stamp; job.nextAttemptAt = null;
        audit(data, 'weighed_email.sent', job, stamp); return 'sent';
      }
      const code = error instanceof SystemEmailError || error instanceof WeighedDocumentEmailError ? error.code : 'system_email_outcome_unknown';
      const retryable = ['system_email_not_configured', 'system_email_rate_limited'].includes(code);
      const uncertain = !(error instanceof SystemEmailError || error instanceof WeighedDocumentEmailError)
        || ['system_email_outcome_unknown', 'system_email_idempotency_conflict'].includes(code);
      job.errorCode = code;
      job.status = uncertain ? 'unknown' : 'failed'; job.retryable = retryable || uncertain;
      if (code === 'system_email_idempotency_conflict') { job.requiresReview = true; job.retryable = false; }
      job.nextAttemptAt = job.retryable ? new Date(Date.parse(stamp) + BACKOFF[Math.min(job.attempts - 1, BACKOFF.length - 1)]).toISOString() : null;
      audit(data, uncertain ? 'weighed_email.unknown' : 'weighed_email.failed', job, stamp);
      return job.status;
    });
  }
  async function drain() {
    const repository = await getRepository(), result = { processed: 0, sent: 0, failed: 0, unknown: 0 };
    // A tenant with the feature off or an empty/completed queue needs only the
    // small metadata projection, not a write lock over all business history.
    const pending = await repository.read(state => {
      settings(state);
      return (state.metadata?.weighedDocumentEmailOutbox?.jobs ?? []).some(pendingJob);
    }, { domains: ['metadata'] });
    if (!pending) return result;
    for (let index = 0; index < BATCH && !closed; index++) {
      const reservation = await claim(repository); if (!reservation) break;
      result.processed++;
      activeController = new AbortController();
      let outcome, error;
      try {
        if (!email.configured) throw new SystemEmailError(503, 'system_email_not_configured', 'Systemutskick är inte konfigurerade.');
        const record = documentMatches(await readDocument(reservation.documentId), reservation);
        const current = await beforeSend(repository, reservation); if (!current) continue;
        activeController.signal.throwIfAborted();
        outcome = await email.sendWeighedDocument({ to: current.to, requestId: current.requestId, createdAt: current.createdAt,
          companyName: current.companyName, cardNumber: current.cardNumber, documentId: current.documentId, pdf: Buffer.from(record.pdf) }, { signal: activeController.signal });
        if (!uuid.safeParse(outcome?.providerId).success) throw new Error('provider_acceptance_unconfirmed');
      } catch (failure) { error = failure; }
      finally { activeController = undefined; }
      const status = await acknowledge(repository, reservation, outcome, error);
      if (status) result[status]++;
    }
    return result;
  }
  function processQueuedWeighedDocumentEmails() {
    if (closed) return Promise.resolve({ processed: 0, sent: 0, failed: 0, unknown: 0 });
    if (flight) return flight;
    flight = drain().finally(() => { flight = undefined; });
    return flight;
  }
  async function status() {
    const repository = await getRepository();
    return repository.read(state => {
      settings(state);
      const data = state.metadata?.weighedDocumentEmailOutbox;
      const counts = Object.fromEntries(['queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled', 'skipped'].map(key => [key, 0]));
      for (const job of data?.jobs ?? []) counts[job.status] = (counts[job.status] ?? 0) + 1;
      counts.skipped = (data?.decisions ?? []).filter(item => item.status === 'skipped').length;
      return { ...counts, requiresReview: (data?.jobs ?? []).filter(item => item.requiresReview).length, decisions: data?.decisions?.length ?? 0 };
    }, { domains: ['metadata'] });
  }
  async function close() { closed = true; activeController?.abort(); await flight; }
  return Object.freeze({ enqueue, processQueuedWeighedDocumentEmails, status, close });
}
