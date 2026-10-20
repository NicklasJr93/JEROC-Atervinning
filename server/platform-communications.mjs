import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from './platform-auth.mjs';
import { SYSTEM_EMAIL_FROM, SystemEmailError } from './system-email.mjs';
import { SYSTEM_SMS_USE_CASES } from './system-sms.mjs';

const HOUR = 3_600_000, RETENTION = 48 * HOUR, RETRY_WINDOW = 23 * HOUR, LEASE = 30_000;
const commandSchema = z.object({ requestId: z.string().uuid().toLowerCase(), to: z.string().trim().max(254).email().toLowerCase() }).strict();
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };
const registry = state => state.systemCommunications ??= { requests: [], attempts: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
const publicResult = (record, to) => ({ requestId: record.requestId, to, from: SYSTEM_EMAIL_FROM, provider: 'resend',
  status: 'accepted', providerId: record.providerId, acceptedAt: record.acceptedAt });

/** Control-plane test sends only. Reservation, rate limits and acknowledgement
 * use platform storage; provider calls run outside its database transaction.
 * Raw recipient addresses/content are not stored in the platform registry.
 */
export function createPlatformCommunications({ auth, email, repository = auth?.repository, now = () => new Date() } = {}) {
  if (!auth?.withPlatformAdminTransaction || !repository?.transact || typeof email?.sendTest !== 'function')
    throw new TypeError('Systemutskick kräver plattformsautentisering, lagring och mejlleverantör.');
  const authorize = (req, operation, write = false) => auth.withPlatformAdminTransaction(req, operation, { write, purpose: 'communications' });
  function audit(state, actorId, action, record) {
    state.audit.push({ id: randomUUID(), at: new Date(now()).toISOString(), actorId, action,
      requestId: record.requestId, channel: 'email', purpose: 'platform_test', recipientHash: record.recipientHash,
      ...(record.providerId && { providerId: record.providerId }), ...(record.errorCode && { code: record.errorCode }) });
  }
  async function read(req) {
    return authorize(req, () => ({ email: { configured: email.configured, provider: 'resend', from: SYSTEM_EMAIL_FROM },
      sms: { configured: false, useCases: SYSTEM_SMS_USE_CASES } }));
  }
  async function sendTest(input, req) {
    await authorize(req, () => true, true);
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) fail('Ange en giltig mottagaradress för testmejlet.', 422, 'system_email_invalid');
    const command = parsed.data, recipientHash = digest(command.to);
    if (!email.configured) fail('Spara RESEND_API_KEY i Render och deploya appen för att aktivera mejltestet.', 503, 'system_email_not_configured');
    const reservation = await authorize(req, (state, actor) => {
      const data = registry(state), at = Number(new Date(now()));
      data.expiredRequestIds ??= [];
      const expired = new Set(data.expiredRequestIds);
      data.requests = data.requests.filter(record => {
        if (Date.parse(record.createdAt) > at - RETENTION) return true;
        expired.add(digest(record.requestId)); return false;
      });
      data.expiredRequestIds = [...expired];
      data.attempts = data.attempts.filter(attempt => attempt.at > at - HOUR);
      if (expired.has(digest(command.requestId)))
        fail('Det gamla testets resultat kan inte kontrolleras säkert längre. Kontrollera Resends utskickslogg innan du startar ett nytt test.', 409, 'system_email_retry_expired');
      let record = data.requests.find(record => record.requestId === command.requestId);
      if (record) {
        if (record.actorId !== actor.actorId || record.recipientHash !== recipientHash)
          fail('Testets mottagare har ändrats. Starta ett nytt mejltest.', 409, 'system_email_request_conflict');
        if (record.status === 'accepted') return { completed: publicResult(record, command.to) };
        if (Date.parse(record.createdAt) <= at - RETRY_WINDOW)
          fail('Det gamla testets resultat kan inte kontrolleras säkert längre. Kontrollera Resends utskickslogg innan du startar ett nytt test.', 409, 'system_email_retry_expired');
        if (record.leaseUntil > at)
          fail('Det här testmejlet behandlas redan. Vänta en stund och prova med samma mottagare.', 409, 'system_email_in_progress');
      }
      if (data.attempts.filter(attempt => attempt.actorId === actor.actorId).length >= 10
        || data.attempts.filter(attempt => attempt.recipientHash === recipientHash).length >= 3
        || data.attempts.length >= 50)
        fail('Gränsen för testmejl är nådd. Vänta en stund innan du provar igen.', 429, 'system_email_test_rate_limited');
      if (!record) {
        // Fail closed rather than evict an old ID and accidentally resend it
        // after Resend's own 24-hour deduplication window has ended.
        if (data.requests.length + expired.size >= 10000)
          fail('Registret för mejltester är fullt och behöver ses över innan fler tester skapas.', 503, 'system_email_registry_full');
        record = { requestId: command.requestId, actorId: actor.actorId, recipientHash, createdAt: new Date(at).toISOString() };
        data.requests.push(record);
      }
      record.status = 'sending'; record.leaseUntil = at + LEASE; record.attemptId = randomUUID();
      delete record.errorCode;
      data.attempts.push({ actorId: actor.actorId, recipientHash, at });
      audit(state, actor.actorId, 'platform.test_email_requested', record);
      return structuredClone(record);
    }, true);
    if (reservation.completed) return reservation.completed;
    let result;
    try {
      // Fresh session/CSRF/generation check immediately before contacting Resend.
      await authorize(req, () => true, true);
      result = await email.sendTest({ ...command, createdAt: reservation.createdAt });
    } catch (error) {
      const expected = error instanceof SystemEmailError;
      const code = expected ? error.code : error instanceof PlatformError ? error.code : 'system_email_outcome_unknown';
      await repository.transact(state => {
        const record = registry(state).requests.find(record => record.requestId === command.requestId);
        if (!record || record.attemptId !== reservation.attemptId || record.status === 'accepted') return;
        record.status = expected && !['system_email_outcome_unknown', 'system_email_idempotency_conflict'].includes(code) ? 'failed' : 'unknown';
        record.errorCode = code; record.leaseUntil = 0;
        audit(state, reservation.actorId, 'platform.test_email_failed', record);
      });
      if (error instanceof PlatformError) throw error;
      if (expected) throw new PlatformError(error.message, error.status, error.code);
      fail('Utskickets resultat är osäkert. Kontrollera Resend eller prova igen med samma mottagare för att undvika dubbla mejl.', 503, 'system_email_outcome_unknown');
    }
    // Persist the provider acknowledgement even if the browser changed context
    // during the request. Returning it still requires the original live scope.
    const saved = await repository.transact(state => {
      const record = registry(state).requests.find(record => record.requestId === command.requestId);
      if (!record || record.attemptId !== reservation.attemptId)
        fail('Mejltestets resultat väntar på kontroll. Prova igen med samma mottagare.', 503, 'system_email_outcome_unknown');
      record.status = 'accepted'; record.providerId = result.providerId; record.acceptedAt = new Date(now()).toISOString();
      record.leaseUntil = 0; delete record.errorCode;
      audit(state, reservation.actorId, 'platform.test_email_accepted', record);
      return publicResult(record, command.to);
    });
    return authorize(req, () => saved, true);
  }
  return { read, sendTest };
}
