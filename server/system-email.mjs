import { z } from 'zod';

export const SYSTEM_EMAIL_FROM = 'ScrapPlanner <noreply@scrapplanner.com>';
export const RESEND_EMAIL_URL = 'https://api.resend.com/emails';
const MAX_RESPONSE_BYTES = 16 * 1024;
const commandSchema = z.object({
  to: z.string().trim().min(1).max(254).email().refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  createdAt: z.string().max(40).datetime({ offset: true }).transform(value => new Date(value).toISOString()),
}).strict();
const providerIdSchema = z.string().uuid();

export class SystemEmailError extends Error {
  constructor(status, code, message) {
    super(message); this.name = 'SystemEmailError'; this.status = status; this.code = code;
  }
}
const fail = (status, code, message) => { throw new SystemEmailError(status, code, message); };
const unknownOutcome = () => fail(503, 'system_email_outcome_unknown', 'Utskickets resultat kunde inte bekräftas. Kontrollera testets status innan ett nytt test skapas.');

function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

async function readJson(response, signal) {
  const length = response.headers?.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {}); throw new Error('provider_response_too_large');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('provider_response_missing');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await withSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function providerFailure(status, data) {
  if ([400, 401, 403, 422].includes(status))
    fail(503, 'system_email_rejected', 'Resend nekade testmejlet. Kontrollera API-nyckelns utskicksbehörighet och att scrapplanner.com är verifierad för utskick.');
  if (status === 429)
    fail(429, 'system_email_rate_limited', 'Resend begränsar utskicken just nu. Vänta en stund innan samma test provas igen.');
  if (status === 409 && data?.name === 'invalid_idempotent_request')
    fail(409, 'system_email_idempotency_conflict', 'Testets utskicks-ID har redan använts med ett annat innehåll. Kontrollera testets status innan ett nytt test skapas.');
  if (status === 409 || status >= 500) unknownOutcome();
  fail(503, 'system_email_unavailable', 'Systemets mejltjänst kan inte användas just nu. Försök igen senare.');
}

function testMessage({ to, requestId, createdAt }) {
  return {
    from: SYSTEM_EMAIL_FROM, to: [to], subject: 'Testmejl från ScrapPlanner',
    text: `Det här är ett test av ScrapPlanners systemutskick.\n\nDu får mejlet eftersom en systemadministratör begärde ett test till den här adressen.\n\nTest-ID: ${requestId}\nBegärt (UTC): ${createdAt}\n\nDu behöver inte svara på mejlet.\n\nScrapPlanner – en produkt av EndorGroup`,
    html: `<html lang="sv"><body style="margin:0;background:#f5f7fa;color:#16334e;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #dde6ee;border-radius:12px"><p style="margin:0 0 24px;font-size:24px;font-weight:bold;color:#16334e">ScrapPlanner<span style="color:#288557">.</span></p><h1 style="font-size:22px;line-height:1.3">Test av systemutskick</h1><p>Det här är ett test av ScrapPlanners systemutskick.</p><p>Du får mejlet eftersom en systemadministratör begärde ett test till den här adressen.</p><p style="font-size:13px;line-height:1.6;color:#5c6f80">Test-ID: ${requestId}<br>Begärt (UTC): ${createdAt}</p><p>Du behöver inte svara på mejlet.</p><hr style="border:0;border-top:1px solid #dde6ee;margin:24px 0"><p style="font-size:12px;color:#5c6f80">ScrapPlanner – en produkt av EndorGroup</p></div></body></html>`,
  };
}

/** Fixed-template system email adapter. The caller owns authorization, durable
 * request IDs and rate limits. Resend retains idempotency keys for only 24h;
 * callers must not retry uncertain sends beyond that window. No automatic retry.
 */
export function createSystemEmail({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new TypeError('Invalid system email configuration.');
  const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  const configured = Boolean(apiKey);
  async function sendTest(input, { signal: callerSignal } = {}) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) fail(422, 'system_email_invalid', 'Ange en giltig e-postadress och ett giltigt test-ID.');
    if (!configured) fail(503, 'system_email_not_configured', 'Systemutskick är inte konfigurerade. Lägg till RESEND_API_KEY i appserverns miljöinställningar.');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      signal.throwIfAborted();
      const response = await withSignal(fetchImpl(RESEND_EMAIL_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'Idempotency-Key': `platform-test-email/${parsed.data.requestId}` },
        body: JSON.stringify(testMessage(parsed.data)),
      }), signal);
      let data;
      try { data = await readJson(response, signal); }
      catch { if (!response.ok) providerFailure(response.status); throw new Error('provider_acceptance_unconfirmed'); }
      if (!response.ok) providerFailure(response.status, data);
      const id = providerIdSchema.safeParse(data?.id);
      if (!id.success) unknownOutcome();
      return { providerId: id.data };
    } catch (error) {
      if (error instanceof SystemEmailError) throw error;
      unknownOutcome();
    }
  }
  return Object.freeze({ configured, sendTest });
}
