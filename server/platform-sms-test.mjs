import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';
import { PlatformError } from './platform-auth.mjs';
import { SYSTEM_SMS_FROM, SystemSmsError } from './system-sms-provider.mjs';

const HOUR = 3_600_000, RETENTION = 48 * HOUR, ACTIVE_MS = 30_000;
const schema = z.object({ requestId: z.string().uuid().toLowerCase(),
  to: z.string().trim().max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value) && phoneNumberError(value, { required: true }) === null)
    .transform(value => normalizePhoneNumber(value)),
}).strict();
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };
const digest = value => createHash('sha256').update(value).digest('hex');
const registry = state => state.systemSmsTests ??= { requests: [], attempts: [], expiredRequestIds: [] };
const uncertain = record => ['sending', 'unknown'].includes(record.status);
const result = (record, to) => ({ requestId: record.requestId, to, from: SYSTEM_SMS_FROM, provider: '46elks',
  status: 'accepted', providerId: record.providerId, providerStatus: record.providerStatus, acceptedAt: record.acceptedAt });
const parse = input => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail('Ange ett giltigt telefonnummer till en mottagare.', 422, 'system_sms_invalid');
  return parsed.data;
};

/** No provider-side idempotency is assumed. An uncertain send blocks both its
 * UUID and its recipient, across reloads, actors and deployments, until an
 * administrator explicitly reviews the provider log. Review never sends SMS.
 */
export function createPlatformSmsTest({ auth, sms, repository = auth?.repository, now = () => new Date() } = {}) {
  if (!auth?.withPlatformAdminTransaction || !repository?.transact || typeof sms?.sendTest !== 'function')
    throw new TypeError('SMS-test kräver plattformsautentisering, lagring och leverantör.');
  const authorize = (req, operation, write = false) => auth.withPlatformAdminTransaction(req, operation, { write, purpose: 'communications' });
  const at = () => Number(new Date(now()));
  function audit(state, actorId, action, record) {
    state.audit.push({ id: randomUUID(), at: new Date(now()).toISOString(), actorId, action,
      channel: 'sms', purpose: 'platform_test', requestId: record.requestId, recipientHash: record.recipientHash,
      ...(record.providerId && { providerId: record.providerId }), ...(record.errorCode && { code: record.errorCode }) });
  }
  function prune(data, time) {
    const expired = new Set(data.expiredRequestIds);
    data.requests = data.requests.filter(record => {
      if (uncertain(record) || Date.parse(record.createdAt) > time - RETENTION) return true;
      expired.add(digest(record.requestId)); return false;
    });
    data.expiredRequestIds = [...expired];
    data.attempts = data.attempts.filter(attempt => attempt.at > time - HOUR);
  }
  async function sendTest(input, req) {
    await authorize(req, () => true, true);
    const command = parse(input), recipientHash = digest(command.to);
    if (!sms.configured) fail('Spara ELKS_API_USERNAME och ELKS_API_PASSWORD i Render och deploya för att aktivera SMS-testet.', 503, 'system_sms_not_configured');
    const reservation = await authorize(req, (state, actor) => {
      const data = registry(state), time = at(); prune(data, time);
      if (data.expiredRequestIds.includes(digest(command.requestId)))
        fail('Det gamla SMS-testet har gått ut. Skapa ett nytt test efter kontroll av utskicksloggen.', 409, 'system_sms_request_expired');
      let record = data.requests.find(record => record.requestId === command.requestId);
      if (record && (record.actorId !== actor.actorId || record.recipientHash !== recipientHash))
        fail('SMS-testets mottagare har ändrats. Starta ett nytt test.', 409, 'system_sms_request_conflict');
      if (record?.status === 'accepted') return { completed: result(record, command.to) };
      if (record?.status === 'reviewed')
        fail('Det tidigare SMS-testet har granskats. Starta ett nytt test med ett nytt test-ID.', 409, 'system_sms_reviewed');
      const blocked = data.requests.find(item => item.recipientHash === recipientHash && uncertain(item));
      if (blocked) {
        if (blocked.status === 'sending' && Date.parse(blocked.startedAt ?? blocked.createdAt) + ACTIVE_MS > time)
          fail('Ett SMS-test till numret behandlas redan. Vänta en stund och uppdatera status.', 409, 'system_sms_in_progress');
        fail('Ett tidigare SMS-test till numret har osäkert resultat. Kontrollera utskicksloggen hos 46elks och bekräfta granskningen före ett nytt test.', 409, 'system_sms_recipient_blocked');
      }
      if (data.attempts.filter(item => item.actorId === actor.actorId).length >= 10
        || data.attempts.filter(item => item.recipientHash === recipientHash).length >= 3 || data.attempts.length >= 50)
        fail('Gränsen för test-SMS är nådd. Vänta innan du provar igen.', 429, 'system_sms_test_rate_limited');
      if (!record) {
        if (data.requests.length + data.expiredRequestIds.length >= 10000)
          fail('Registret för SMS-tester är fullt och behöver ses över.', 503, 'system_sms_registry_full');
        record = { requestId: command.requestId, recipientHash, actorId: actor.actorId, createdAt: new Date(time).toISOString() };
        data.requests.push(record);
      }
      record.status = 'sending'; record.startedAt = new Date(time).toISOString(); record.attemptId = randomUUID(); delete record.errorCode;
      data.attempts.push({ actorId: actor.actorId, recipientHash, at: time });
      audit(state, actor.actorId, 'platform.test_sms_requested', record);
      return structuredClone(record);
    }, true);
    if (reservation.completed) return reservation.completed;
    let sent, contacted = false;
    try {
      await authorize(req, () => true, true);
      contacted = true; sent = await sms.sendTest(command);
    } catch (error) {
      const expected = error instanceof SystemSmsError;
      const notSent = !contacted || expected && error.outcome === 'not_sent';
      await repository.transact(state => {
        const record = registry(state).requests.find(item => item.requestId === command.requestId);
        if (!record || record.attemptId !== reservation.attemptId || ['accepted', 'reviewed'].includes(record.status)) return;
        record.status = notSent ? 'failed' : 'unknown';
        record.errorCode = expected || error instanceof PlatformError ? error.code : 'system_sms_outcome_unknown';
        audit(state, reservation.actorId, 'platform.test_sms_failed', record);
      });
      if (error instanceof PlatformError) throw error;
      if (expected) throw new PlatformError(error.message, error.status, error.code);
      fail('SMS-testets resultat är osäkert. Kontrollera utskicksloggen hos 46elks innan ett nytt test görs.', 503, 'system_sms_outcome_unknown');
    }
    const accepted = await repository.transact(state => {
      const record = registry(state).requests.find(item => item.requestId === command.requestId);
      if (!record || record.attemptId !== reservation.attemptId || !['sending', 'unknown', 'reviewed'].includes(record.status))
        fail('SMS-testets resultat behöver kontrolleras hos 46elks före ett nytt test.', 503, 'system_sms_outcome_unknown');
      record.status = 'accepted'; record.providerId = sent.providerId; record.providerStatus = sent.providerStatus;
      record.acceptedAt = new Date(now()).toISOString(); delete record.errorCode;
      audit(state, reservation.actorId, 'platform.test_sms_accepted', record);
      return result(record, command.to);
    });
    return authorize(req, () => accepted, true);
  }
  async function review(input, req) {
    await authorize(req, () => true, true);
    const command = parse(input), recipientHash = digest(command.to);
    return authorize(req, (state, actor) => {
      const data = registry(state), time = at();
      const blocked = data.requests.filter(item => item.recipientHash === recipientHash && uncertain(item));
      if (blocked.some(item => item.status === 'sending' && Date.parse(item.startedAt ?? item.createdAt) + ACTIVE_MS > time))
        fail('SMS-testet behandlas fortfarande. Vänta innan du bekräftar granskningen.', 409, 'system_sms_in_progress');
      for (const record of blocked) {
        record.status = 'reviewed'; record.reviewedAt = new Date(time).toISOString(); record.reviewedBy = actor.actorId;
        audit(state, actor.actorId, 'platform.test_sms_reviewed', record);
      }
      return { reviewed: true };
    }, true);
  }
  return { sendTest, review };
}
