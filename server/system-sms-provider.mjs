import { z } from 'zod';
import { normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';

export const SYSTEM_SMS_FROM = 'ScrapPlan';
export const SYSTEM_SMS_TEST_MESSAGE = 'Test från ScrapPlanner. En systemadministratör har begärt detta test-SMS till ditt nummer. Du behöver inte svara.';
export const ELKS_SMS_URL = 'https://api.46elks.com/a1/sms';
const MAX_RESPONSE_BYTES = 16 * 1024;
const commandSchema = z.object({
  to: z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
    .refine(value => phoneNumberError(value, { required: true }) === null).transform(value => normalizePhoneNumber(value)),
  requestId: z.string().uuid().toLowerCase(),
}).strict();
const customerApprovalSchema = commandSchema.extend({
  companyName: z.string().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
    .transform(value => value.normalize('NFKC').trim().replace(/\s+/g, ' ')).pipe(z.string().min(1).max(200)),
  approvalUrl: z.string().min(1).max(2048).refine(value => !/[\u0000-\u0020\u007f]/.test(value)),
  createdAt: z.string().max(40).datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  expiresAt: z.string().max(40).datetime({ offset: true }).transform(value => new Date(value).toISOString()),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt)
  && Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= 24 * 60 * 60_000);
const customerIntakeSchema = z.object({
  to: commandSchema.shape.to,
  requestId: commandSchema.shape.requestId,
  companyName: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  intakeUrl: z.string().min(1).max(2048),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().refine(value => Date.parse(value.expiresAt) > Date.parse(value.createdAt)
  && Date.parse(value.expiresAt) - Date.parse(value.createdAt) <= 24 * 60 * 60_000);
const receiptSchema = z.object({ id: z.string().regex(/^s[a-f0-9]{32}$/), status: z.enum(['created', 'sent', 'delivered', 'failed']) });

export class SystemSmsError extends Error {
  constructor(status, code, message, outcome) {
    super(message); this.name = 'SystemSmsError'; this.status = status; this.code = code; this.outcome = outcome;
  }
}
const fail = (status, code, message, outcome = 'not_sent') => { throw new SystemSmsError(status, code, message, outcome); };
const unknownOutcome = (purpose = 'test') => fail(503, 'system_sms_outcome_unknown', purpose === 'customer-intake'
  ? 'SMS-utskicket med kundformuläret kunde inte bekräftas. Kontrollera utskicksloggen hos 46elks innan du gör ett nytt försök.' : purpose === 'customer-approval'
  ? 'Kundgodkännandets SMS-utskick kunde inte bekräftas. Kontrollera utskicksloggen hos 46elks innan du gör ett nytt försök.'
  : 'SMS-testets resultat kunde inte bekräftas. Kontrollera utskicksloggen hos 46elks innan du gör ett nytt försök.', 'unknown');

function customerApprovalLink(value, configuredAppUrl, pathname = '/godkann/') {
  try {
    const app = new URL(configuredAppUrl ?? 'https://app.scrapplanner.com'), link = new URL(value);
    if (app.protocol !== 'https:' || app.username || app.password || app.pathname !== '/' || app.search || app.hash
      || link.protocol !== 'https:' || link.origin !== app.origin || link.username || link.password
      || link.pathname !== pathname || link.search || !/^#token=[A-Za-z0-9_-]{43}$/.test(link.hash)) return undefined;
    return link.href;
  } catch { return undefined; }
}
function customerApprovalMessage(companyName, approvalUrl, purpose = 'customer-approval') {
  // Keep this fixed template GSM-friendly. Company names are presentation only;
  // the full original name is shown on the authenticated approval page.
  const company = companyName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 &.,'-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 32).trim() || 'Foretaget';
  return `${company}: ${purpose === 'customer-intake' ? 'Fyll i dina kunduppgifter' : 'Godkann underlaget'}: ${approvalUrl} /ScrapPlanner`;
}

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

function providerFailure(status, purpose = 'test') {
  const subject = purpose === 'customer-intake' ? 'kundformulärets SMS' : purpose === 'customer-approval' ? 'kundgodkännandets SMS' : 'SMS-testet';
  if ([401, 403].includes(status))
    fail(503, 'system_sms_credentials_rejected', `46elks nekade ${subject}. Kontrollera ELKS_API_USERNAME, ELKS_API_PASSWORD och kontots utskicksbehörighet.`);
  if (status === 402)
    fail(503, 'system_sms_balance_required', `46elks nekade ${subject}. Kontrollera kontots saldo och betalningsmetod.`);
  if (status === 429)
    fail(429, 'system_sms_rate_limited', purpose === 'customer-approval'
      ? '46elks begränsar utskicken för kundgodkännande just nu. Vänta innan du försöker igen.'
      : '46elks begränsar utskicken just nu. Vänta innan du provar SMS-testet igen.');
  if (status >= 400 && status < 500 && ![408, 409].includes(status))
    fail(503, 'system_sms_rejected', `46elks nekade ${subject}. Kontrollera mottagarnummer, avsändarregler och kontots inställningar.`);
  unknownOutcome(purpose);
}

/** Fixed-template 46elks adapter. There is no documented provider idempotency
 * parameter for this API: the caller must persist the send reservation before
 * calling and must not retry an unknown outcome. This adapter never retries.
 */
export function createSystemSmsProvider({ env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000)
    throw new TypeError('Invalid system SMS configuration.');
  const apiUsername = typeof env.ELKS_API_USERNAME === 'string' ? env.ELKS_API_USERNAME.trim() : '';
  const apiPassword = typeof env.ELKS_API_PASSWORD === 'string' ? env.ELKS_API_PASSWORD.trim() : '';
  const configured = Boolean(apiUsername && apiPassword);
  async function send(to, message, purpose, callerSignal) {
    if (!configured) fail(503, 'system_sms_not_configured', purpose === 'customer-approval'
      ? 'SMS-utskick för kundgodkännande är inte konfigurerade. Kontakta systemadministratören.'
      : 'SMS-testet är inte konfigurerat. Spara ELKS_API_USERNAME och ELKS_API_PASSWORD i appserverns miljöinställningar.');
    if (callerSignal?.aborted) fail(499, 'system_sms_cancelled', purpose === 'customer-approval'
      ? 'Kundgodkännandets SMS-utskick avbröts innan utskicket påbörjades.' : 'SMS-testet avbröts innan utskicket påbörjades.');
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    try {
      signal.throwIfAborted();
      const response = await withSignal(fetchImpl(ELKS_SMS_URL, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Basic ${Buffer.from(`${apiUsername}:${apiPassword}`, 'utf8').toString('base64')}`,
          Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ from: SYSTEM_SMS_FROM, to, message, dontlog: 'message' }).toString(),
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        providerFailure(response.status, purpose);
      }
      const receipt = receiptSchema.safeParse(await readJson(response, signal));
      if (!receipt.success) unknownOutcome(purpose);
      if (receipt.data.status === 'failed') fail(502, 'system_sms_delivery_failed', purpose === 'customer-approval'
        ? '46elks meddelar att kundgodkännandets SMS inte kunde levereras. Kontrollera numret och utskicksloggen.'
        : '46elks meddelar att SMS-testet inte kunde levereras. Kontrollera numret och utskicksloggen.');
      return { providerId: receipt.data.id, providerStatus: receipt.data.status };
    } catch (error) {
      if (error instanceof SystemSmsError) throw error;
      unknownOutcome(purpose);
    }
  }
  async function sendTest(input, { signal } = {}) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) fail(422, 'system_sms_invalid', 'Ange ett giltigt telefonnummer och test-ID.');
    return send(parsed.data.to, SYSTEM_SMS_TEST_MESSAGE, 'test', signal);
  }
  async function sendCustomerApproval(input, { signal } = {}) {
    const parsed = customerApprovalSchema.safeParse(input);
    const approvalUrl = parsed.success && customerApprovalLink(parsed.data.approvalUrl, env.APP_URL);
    if (!parsed.success || !approvalUrl) fail(422, 'system_sms_invalid', 'Utskicket för kundgodkännande innehåller ogiltiga uppgifter.');
    return send(parsed.data.to, customerApprovalMessage(parsed.data.companyName, approvalUrl), 'customer-approval', signal);
  }
  async function sendCustomerIntake(input, { signal } = {}) {
    const parsed = customerIntakeSchema.safeParse(input);
    const intakeUrl = parsed.success && customerApprovalLink(parsed.data.intakeUrl, env.APP_URL, '/kunduppgifter/');
    if (!parsed.success || !intakeUrl) fail(422, 'system_sms_invalid', 'Utskicket med kundformuläret innehåller ogiltiga uppgifter.');
    return send(parsed.data.to, customerApprovalMessage(parsed.data.companyName, intakeUrl, 'customer-intake'), 'customer-intake', signal);
  }
  return Object.freeze({ configured, sendTest, sendCustomerApproval, sendCustomerIntake });
}
