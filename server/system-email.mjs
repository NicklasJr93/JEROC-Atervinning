import { z } from 'zod';

export const SYSTEM_EMAIL_FROM = 'ScrapPlanner <noreply@scrapplanner.com>';
export const RESEND_EMAIL_URL = 'https://api.resend.com/emails';
const MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_SYSTEM_EMAIL_PDF_BYTES = 20 * 1024 * 1024;
const commandSchema = z.object({
  to: z.string().trim().min(1).max(254).email().refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  requestId: z.string().uuid().transform(value => value.toLowerCase()),
  createdAt: z.string().max(40).datetime({ offset: true }).transform(value => new Date(value).toISOString()),
}).strict();
const resetCommandSchema = commandSchema.extend({
  expiresAt: z.string().max(40).datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  resetUrl: z.string().min(1).max(2048).refine(value => !/[\u0000-\u0020\u007f]/.test(value)),
}).strict().refine(value => Date.parse(value.expiresAt) - Date.parse(value.createdAt) === 30 * 60_000);
const weighedDocumentSchema = commandSchema.extend({
  companyName: z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
    .transform(value => value.normalize('NFKC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(200)),
  cardNumber: z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d{0,15}$/)
    .refine(value => Number.isSafeInteger(Number(value)))]).transform(String),
  documentId: z.string().uuid().transform(value => value.toLowerCase()),
  pdf: z.custom(value => Buffer.isBuffer(value) && value.length >= 15 && value.length <= MAX_SYSTEM_EMAIL_PDF_BYTES
    && value.subarray(0, 5).equals(Buffer.from('%PDF-')) && /%%EOF[\t\n\f\r ]*$/.test(value.subarray(-1024).toString('latin1'))),
}).strict();
const providerIdSchema = z.string().uuid();

export class SystemEmailError extends Error {
  constructor(status, code, message) {
    super(message); this.name = 'SystemEmailError'; this.status = status; this.code = code;
  }
}
const fail = (status, code, message) => { throw new SystemEmailError(status, code, message); };
const unknownOutcome = (purpose = 'test') => fail(503, 'system_email_outcome_unknown', purpose === 'password-reset'
  ? 'Återställningsmejlets utskick kunde inte bekräftas. Försök begära en ny länk senare.'
  : purpose === 'weighed-document' ? 'Utskicket av det vägda underlaget kunde inte bekräftas. Kontrollera utskickets status innan det försöks igen.'
  : 'Utskickets resultat kunde inte bekräftas. Kontrollera testets status innan ett nytt test skapas.');

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

function providerFailure(status, data, purpose = 'test') {
  if ([400, 401, 403, 422].includes(status))
    fail(503, 'system_email_rejected', purpose === 'password-reset'
      ? 'Mejltjänsten nekade återställningsutskicket.'
      : purpose === 'weighed-document' ? 'Mejltjänsten nekade utskicket av det vägda underlaget.'
      : 'Resend nekade testmejlet. Kontrollera API-nyckelns utskicksbehörighet och att scrapplanner.com är verifierad för utskick.');
  if (status === 429)
    fail(429, 'system_email_rate_limited', purpose === 'password-reset'
      ? 'Mejltjänsten begränsar utskicken just nu. Försök igen senare.'
      : purpose === 'weighed-document' ? 'Mejltjänsten begränsar utskicken av underlag just nu. Försök igen senare.'
      : 'Resend begränsar utskicken just nu. Vänta en stund innan samma test provas igen.');
  if (status === 409 && data?.name === 'invalid_idempotent_request')
    fail(409, 'system_email_idempotency_conflict', purpose === 'password-reset'
      ? 'Återställningsutskickets ID har redan använts med annat innehåll.'
      : purpose === 'weighed-document' ? 'Utskicket av underlaget har redan begärts med ett annat innehåll. Kontrollera utskickets status.'
      : 'Testets utskicks-ID har redan använts med ett annat innehåll. Kontrollera testets status innan ett nytt test skapas.');
  if (status === 409 || status >= 500) unknownOutcome(purpose);
  fail(503, 'system_email_unavailable', 'Systemets mejltjänst kan inte användas just nu. Försök igen senare.');
}

function resetLink(value, configuredAppUrl) {
  try {
    const app = new URL(configuredAppUrl ?? 'https://app.scrapplanner.com');
    const link = new URL(value);
    if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash
      || link.protocol !== 'https:' || link.origin !== app.origin || link.username || link.password
      || link.pathname !== '/kontor/' || link.search || !/^#\/reset-password\?token=[A-Za-z0-9_-]{43}$/.test(link.hash)) return undefined;
    return link.href;
  } catch { return undefined; }
}
const escapeHtml = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function passwordResetMessage({ to, resetUrl }) {
  const link = escapeHtml(resetUrl);
  return {
    from: SYSTEM_EMAIL_FROM, to: [to], subject: 'Återställ ditt lösenord',
    text: `Du har begärt att återställa lösenordet till ditt ScrapPlanner-konto.\n\nÖppna länken nedan för att välja och bekräfta ett nytt lösenord:\n${resetUrl}\n\nLänken gäller i 30 minuter och kan bara användas en gång.\n\nOm du inte begärde detta kan du ignorera mejlet. Ditt lösenord ändras först när du väljer ett nytt via länken. Dela inte länken med någon annan.\n\nScrapPlanner – en produkt av EndorGroup`,
    html: `<html lang="sv"><body style="margin:0;background:#f5f7fa;color:#16334e;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #dde6ee;border-radius:12px"><p style="margin:0 0 24px;font-size:24px;font-weight:bold;color:#16334e">ScrapPlanner<span style="color:#288557">.</span></p><h1 style="font-size:22px;line-height:1.3">Återställ ditt lösenord</h1><p>Du har begärt att återställa lösenordet till ditt ScrapPlanner-konto.</p><p>Välj och bekräfta ett nytt lösenord via länken:</p><p style="margin:24px 0"><a href="${link}" style="display:inline-block;padding:12px 20px;background:#16334e;color:#fff;text-decoration:none;border-radius:7px">Välj nytt lösenord</a></p><p>Länken gäller i <strong>30 minuter</strong> och kan bara användas en gång.</p><p>Om du inte begärde detta kan du ignorera mejlet. Ditt lösenord ändras först när du väljer ett nytt via länken. Dela inte länken med någon annan.</p><p style="font-size:12px;overflow-wrap:anywhere">Om knappen inte fungerar, kopiera länken till webbläsaren:<br><a href="${link}">${link}</a></p><hr style="border:0;border-top:1px solid #dde6ee;margin:24px 0"><p style="font-size:12px;color:#5c6f80">ScrapPlanner – en produkt av EndorGroup</p></div></body></html>`,
  };
}

function testMessage({ to, requestId, createdAt }) {
  return {
    from: SYSTEM_EMAIL_FROM, to: [to], subject: 'Testmejl från ScrapPlanner',
    text: `Det här är ett test av ScrapPlanners systemutskick.\n\nDu får mejlet eftersom en systemadministratör begärde ett test till den här adressen.\n\nTest-ID: ${requestId}\nBegärt (UTC): ${createdAt}\n\nDu behöver inte svara på mejlet.\n\nScrapPlanner – en produkt av EndorGroup`,
    html: `<html lang="sv"><body style="margin:0;background:#f5f7fa;color:#16334e;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #dde6ee;border-radius:12px"><p style="margin:0 0 24px;font-size:24px;font-weight:bold;color:#16334e">ScrapPlanner<span style="color:#288557">.</span></p><h1 style="font-size:22px;line-height:1.3">Test av systemutskick</h1><p>Det här är ett test av ScrapPlanners systemutskick.</p><p>Du får mejlet eftersom en systemadministratör begärde ett test till den här adressen.</p><p style="font-size:13px;line-height:1.6;color:#5c6f80">Test-ID: ${requestId}<br>Begärt (UTC): ${createdAt}</p><p>Du behöver inte svara på mejlet.</p><hr style="border:0;border-top:1px solid #dde6ee;margin:24px 0"><p style="font-size:12px;color:#5c6f80">ScrapPlanner – en produkt av EndorGroup</p></div></body></html>`,
  };
}

function weighedDocumentMessage({ to, companyName, cardNumber, documentId, pdf }) {
  const company = escapeHtml(companyName);
  return {
    from: SYSTEM_EMAIL_FROM, to: [to], subject: `${companyName} · Vägt underlag ${cardNumber}`,
    text: `${companyName}\n\nHär kommer kontorets PDF-kopia av det attesterade vägda underlaget ${cardNumber}.\n\nPDF:en finns bifogad för kontorets hantering.\n\nSkickat via ScrapPlanner – en produkt av EndorGroup`,
    html: `<html lang="sv"><body style="margin:0;background:#f5f7fa;color:#16334e;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#ffffff;border:1px solid #dde6ee;border-radius:12px"><p style="margin:0 0 24px;font-size:24px;font-weight:bold;color:#16334e">${company}</p><h1 style="font-size:22px;line-height:1.3">Vägt underlag ${cardNumber}</h1><p>Här kommer kontorets PDF-kopia av det <strong>attesterade vägda underlaget</strong>.</p><p>PDF:en finns bifogad för kontorets hantering.</p><hr style="border:0;border-top:1px solid #dde6ee;margin:24px 0"><p style="font-size:12px;color:#5c6f80">Skickat via ScrapPlanner – en produkt av EndorGroup</p></div></body></html>`,
    attachments: [{ filename: `Vagt-underlag-${cardNumber}-${documentId}.pdf`, content: pdf.toString('base64'), content_type: 'application/pdf' }],
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
  async function send(message, idempotencyKey, purpose, callerSignal) {
    if (!configured) fail(503, 'system_email_not_configured', 'Systemutskick är inte konfigurerade. Lägg till RESEND_API_KEY i appserverns miljöinställningar.');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      signal.throwIfAborted();
      const response = await withSignal(fetchImpl(RESEND_EMAIL_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(message),
      }), signal);
      let data;
      try { data = await readJson(response, signal); }
      catch { if (!response.ok) providerFailure(response.status, undefined, purpose); throw new Error('provider_acceptance_unconfirmed'); }
      if (!response.ok) providerFailure(response.status, data, purpose);
      const id = providerIdSchema.safeParse(data?.id);
      if (!id.success) unknownOutcome(purpose);
      return { providerId: id.data };
    } catch (error) {
      if (error instanceof SystemEmailError) throw error;
      unknownOutcome(purpose);
    }
  }
  async function sendTest(input, { signal } = {}) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) fail(422, 'system_email_invalid', 'Ange en giltig e-postadress och ett giltigt test-ID.');
    return send(testMessage(parsed.data), `platform-test-email/${parsed.data.requestId}`, 'test', signal);
  }
  async function sendPasswordReset(input, { signal } = {}) {
    const parsed = resetCommandSchema.safeParse(input);
    const resetUrl = parsed.success && resetLink(parsed.data.resetUrl, env.APP_URL);
    if (!parsed.success || !resetUrl) fail(422, 'system_email_invalid', 'Återställningsutskicket innehåller ogiltiga uppgifter.');
    return send(passwordResetMessage({ ...parsed.data, resetUrl }), `password-reset/${parsed.data.requestId}`, 'password-reset', signal);
  }
  async function sendWeighedDocument(input, { signal } = {}) {
    const parsed = weighedDocumentSchema.safeParse(input);
    if (!parsed.success) fail(422, 'system_email_invalid', 'Underlagets utskick innehåller ogiltiga uppgifter eller en ogiltig PDF.');
    return send(weighedDocumentMessage(parsed.data), `weighed-document/${parsed.data.requestId}`, 'weighed-document', signal);
  }
  return Object.freeze({ configured, sendTest, sendPasswordReset, sendWeighedDocument });
}
