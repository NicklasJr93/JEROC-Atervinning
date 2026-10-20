import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { PlatformError } from './platform-auth.mjs';

const HOUR = 3_600_000, WINDOW = 15 * 60_000, LIFE = 30 * 60_000;
const generic = () => ({ ok: true, message: 'Om adressen är kopplad till ett aktivt konto skickar vi en återställningslänk.' });
const digest = value => createHash('sha256').update(value).digest('hex');
const emailSchema = z.string().trim().max(254).email().transform(value => value.normalize('NFKC').toLowerCase());
const requestSchema = z.object({ email: emailSchema,
  username: z.string().trim().min(1).max(254).transform(value => value.normalize('NFKC').toLowerCase()).optional() }).strict();
const confirmationSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  newPassword: z.string().min(12).max(200), confirmPassword: z.string().min(12).max(200) }).strict();
const registry = state => state.passwordRecovery ??= { requests: [], attempts: [] };
const fail = (message, status, code) => { throw new PlatformError(message, status, code); };
const invalid = () => fail('Återställningslänken är ogiltig eller har gått ut. Begär en ny länk.', 422, 'password_reset_invalid');
function prune(data, time) {
  data.requests = data.requests.filter(record => Date.parse(record.expiresAt) > time - HOUR);
  data.attempts = data.attempts.filter(attempt => attempt.at > time - HOUR);
}

/** Recovery remains in control-plane storage; recipient selection never takes
 * a tenant ID or company contact address from the browser. Provider I/O is
 * outside transactions. Durable state contains hashes, never bearer links.
 */
export function createPlatformPasswordReset({ auth, repository = auth?.repository, email, env = process.env,
  now = () => new Date(), minResponseMs = 9000 } = {}) {
  if (!auth?.initialize || !auth?.passwordRecoveryCandidate || !auth?.completePasswordRecovery
    || !repository?.transact || !email || !Number.isInteger(minResponseMs) || minResponseMs < 0 || minResponseMs > 15_000)
    throw new TypeError('Lösenordsåterställningen saknar autentisering, lagring eller mejltjänst.');
  let app;
  try {
    app = new URL(env.APP_URL || 'https://app.scrapplanner.com');
    if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash) throw new Error();
  } catch { throw new TypeError('APP_URL måste vara en giltig HTTPS-adress utan sökväg.'); }
  const at = () => Number(new Date(now()));
  // Untrusted forwarding headers never grant extra attempts. Shared Render
  // peers may share this conservative limit; the per-address/global limits
  // remain durable across restarts and horizontally scaled instances.
  const addressHash = req => digest(req.socket?.remoteAddress ?? 'unknown');
  const audit = (state, action, values) => state.audit.push({ id: randomUUID(), at: new Date(now()).toISOString(), action, ...values });

  async function request(input, req) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) fail('Ange en giltig e-postadress.', 422, 'password_reset_email_invalid');
    if (!email.configured || typeof email.sendPasswordReset !== 'function')
      fail('Lösenordsåterställning via mejl är inte tillgänglig just nu. Kontakta systemadministratören.', 503, 'password_reset_unavailable');
    const started = performance.now();
    try {
      await auth.initialize();
      const time = at(), recipientHash = digest(parsed.data.email), ipHash = addressHash(req);
      const token = randomBytes(32).toString('base64url'), tokenHash = digest(token), requestId = randomUUID();
      const reservation = await repository.transact(state => {
        const data = registry(state); prune(data, time);
        const attempts = data.attempts.filter(attempt => attempt.purpose === 'request');
        if (attempts.length >= 100 || attempts.filter(attempt => attempt.ipHash === ipHash).length >= 20
          || attempts.filter(attempt => attempt.recipientHash === recipientHash && attempt.at > time - WINDOW).length >= 3
          || attempts.some(attempt => attempt.recipientHash === recipientHash && attempt.at > time - 60_000)) return undefined;
        data.attempts.push({ purpose: 'request', recipientHash, ipHash, at: time });
        const candidate = auth.passwordRecoveryCandidate(state, parsed.data.email, parsed.data.username);
        if (!candidate || data.requests.length >= 1000) return undefined;
        for (const previous of data.requests) if (previous.userId === candidate.userId) previous.status = 'superseded';
        const record = { requestId, userId: candidate.userId, fingerprint: candidate.fingerprint, recipientHash,
          tokenHash, status: 'sending', createdAt: new Date(time).toISOString(), expiresAt: new Date(time + LIFE).toISOString() };
        data.requests.push(record);
        audit(state, 'platform.password_recovery_requested', { actorId: candidate.userId, requestId });
        return { ...record, to: candidate.recipient };
      });
      if (!reservation) return generic();
      const resetUrl = new URL('/kontor/', app.origin);
      resetUrl.hash = `/reset-password?token=${token}`;
      let sent = false;
      try {
        await email.sendPasswordReset({ to: reservation.to, requestId, createdAt: reservation.createdAt,
          expiresAt: reservation.expiresAt, resetUrl: resetUrl.href });
        sent = true;
      } catch { /* Same response for provider failure and unknown accounts. */ }
      await repository.transact(state => {
        const record = registry(state).requests.find(item => item.requestId === requestId);
        if (!record || record.status !== 'sending') return;
        const current = auth.passwordRecoveryCandidate(state, parsed.data.email, parsed.data.username);
        record.status = sent && current?.userId === record.userId && current.fingerprint === record.fingerprint
          && Date.parse(record.expiresAt) > at() ? 'sent' : 'failed';
        audit(state, record.status === 'sent' ? 'platform.password_recovery_email_sent' : 'platform.password_recovery_email_failed',
          { actorId: record.userId, requestId });
      });
      return generic();
    } finally {
      // Resend has an 8s timeout. Equal latency avoids revealing a registered
      // address through the difference between a provider call and a no-op.
      await wait(Math.max(0, minResponseMs - (performance.now() - started)));
    }
  }

  async function confirm(input, req) {
    await auth.initialize();
    const ipHash = addressHash(req), time = at();
    const allowed = await repository.transact(state => {
      const data = registry(state); prune(data, time);
      const attempts = data.attempts.filter(attempt => attempt.purpose === 'confirm');
      if (attempts.length >= 200 || attempts.filter(attempt => attempt.ipHash === ipHash).length >= 30) return false;
      data.attempts.push({ purpose: 'confirm', ipHash, at: time }); return true;
    });
    if (!allowed) fail('För många försök. Vänta en stund innan du försöker igen.', 429, 'password_reset_rate_limit');
    const parsed = confirmationSchema.safeParse(input);
    if (!parsed.success) {
      if (typeof input?.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) return invalid();
      fail('Använd minst 12 och högst 200 tecken och bekräfta det nya lösenordet.', 422, 'password_reset_password_invalid');
    }
    return auth.completePasswordRecovery({ tokenHash: digest(parsed.data.token), newPassword: parsed.data.newPassword, confirmPassword: parsed.data.confirmPassword });
  }
  return { request, confirm };
}
