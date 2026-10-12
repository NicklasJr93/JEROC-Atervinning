import { randomUUID } from 'node:crypto';
import { EnvironmentError } from './environment-storage.mjs';

const DAY = 86400000;
export const TRACKING_LABELS = Object.freeze({
  queued: 'Överföring till Spiris köad', started: 'Överföring till Spiris påbörjad',
  draft_created: 'Fakturautkast skapat i Spiris', draft_recreated: 'Fakturautkast återskapat i Spiris',
  local_blocked: 'Överföring till Spiris stoppad', remote_rejected: 'Spiris avvisade överföringen',
  response_unknown: 'Svar från Spiris behöver kontrolleras', booked: 'Bokförd i Spiris',
  draft_missing: 'Underlag saknas i Spiris', tracking_expired: 'Bokföringsbekräftelse saknas – kontrollera',
});
const fail = (message, code = 'visma_tracking_unverified') => { throw new EnvironmentError(message, 409, code); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value !== '00000000-0000-0000-0000-000000000000';
export function addSpirisEvent(job, type, at, actor, detail) {
  job.events ??= [];
  job.events.push({ id: randomUUID(), type, at, actor, text: TRACKING_LABELS[type] ?? type, ...(detail ? { detail } : {}) });
}
export function trackingInterval(job, now) {
  const age = now.getTime() - Date.parse(job.finishedAt ?? job.createdAt);
  return age < DAY ? 5 : age < 7 * DAY ? 60 : 1440;
}
export function initialTracking(job, maxDays = 30) {
  const started = job.finishedAt ?? job.createdAt;
  return { state: 'pending', startedAt: started, deadlineAt: new Date(Date.parse(started) + maxDays * DAY).toISOString(),
    intervalMinutes: 5, nextCheckAt: new Date(Date.parse(started) + 300000).toISOString(), lastCheckedAt: null, failureCount: 0, missingCount: 0 };
}
export function publicSpirisEvents(job) {
  return (job.events ?? []).map((event, index) => {
    const legacyType = event.text === 'Attesterad version köad för Spiris.' ? 'queued'
      : event.text === 'Leverantörsfakturautkast skapat i Spiris.' ? 'draft_created' : undefined;
    return { ...event, ...(legacyType && !event.type ? { type: legacyType, text: TRACKING_LABELS[legacyType] } : {}), id: event.id ?? `${job.id}:legacy:${index}` };
  });
}
function checkIdentity(record, job) {
  if (record.SupplierId !== job.supplierId || record.InvoiceNumber !== job.draft.InvoiceNumber ||
    record.CurrencyCode !== undefined && record.CurrencyCode !== job.draft.CurrencyCode ||
    typeof record.TotalAmount !== 'number' || Math.round(record.TotalAmount * 100) !== Math.round(job.draft.TotalAmount * 100))
    fail('Spiris-underlaget har andra leverantörs-, referens- eller beloppsuppgifter än den attesterade versionen. Granska kopplingen.', 'visma_tracking_identity_conflict');
}
async function read(send, operation, parameters) {
  const requestId = randomUUID(); return send({ requestId, idempotencyKey: requestId, operation, parameters });
}
/** Only a complete, verified company batch may prove absence. Neither a 404
 * alone nor an unverified/truncated invoice list can enable recreation. */
export async function observeSpirisDraft(job, send) {
  if (!uuid(job.draftId) || !uuid(job.supplierId)) fail('Överföringen saknar verifierbara Spiris-referenser.');
  const draft = await read(send, 'draft', { resourceId: job.draftId });
  if (draft.status === 'accepted') {
    if (draft.response?.Id !== job.draftId) fail('Spiris svarade med ett annat fakturautkast.');
    checkIdentity(draft.response, job); return { kind: 'draft_exists' };
  }
  if (draft.httpStatus !== 404) fail('Fakturautkastet kunde inte kontrolleras. Senaste bekräftade status behålls.',
    draft.httpStatus === 401 || draft.httpStatus === 403 ? 'visma_tracking_access' : 'visma_tracking_unavailable');
  const invoices = [];
  for (let page = 1; page <= 100; page++) {
    const run = await read(send, 'invoices', { page, pageSize: 1000 }), body = run.response;
    if (run.status !== 'accepted' || !Array.isArray(body?.Data) || body.Data.some(record => !uuid(record?.Id)) ||
      !Number.isInteger(body.Meta?.TotalNumberOfPages) || body.Meta.TotalNumberOfPages < 0 || body.Meta.TotalNumberOfPages > 100 ||
      body.Meta.CurrentPage !== page || !Number.isInteger(body.Meta.TotalNumberOfResults) || body.Meta.TotalNumberOfResults < 0)
      fail('Spiris gav inte en komplett och verifierbar fakturalista. Underlaget får inte återskapas.', 'visma_tracking_incomplete');
    invoices.push(...body.Data);
    if (body.Meta.TotalNumberOfPages <= page) {
      if (body.Meta.TotalNumberOfResults !== invoices.length || new Set(invoices.map(invoice => invoice.Id)).size !== invoices.length)
        fail('Alla Spiris-fakturor kunde inte kontrolleras. Underlaget får inte återskapas.', 'visma_tracking_incomplete');
      const exact = invoices.filter(invoice => invoice.CreatedFromDraftId === job.draftId);
      const ambiguous = invoices.filter(invoice => invoice.CreatedFromDraftId !== job.draftId && invoice.SupplierId === job.supplierId && invoice.InvoiceNumber === job.draft.InvoiceNumber);
      if (exact.length > 1 || ambiguous.length) fail('En annan Spiris-faktura har samma leverantör och referens. Granska underlaget före fortsatt arbete.', 'visma_tracking_ambiguous');
      if (!exact.length) return { kind: 'missing' };
      // Fetch the final record separately, so bookkeeping is confirmed from its
      // current status rather than treating a disappearing draft as booked.
      const invoice = await read(send, 'invoice', { resourceId: exact[0].Id });
      if (invoice.status !== 'accepted' || invoice.response?.Id !== exact[0].Id || invoice.response.CreatedFromDraftId !== job.draftId)
        fail('Den slutliga Spiris-fakturan kunde inte verifieras.', 'visma_tracking_incomplete');
      const record = invoice.response; checkIdentity(record, job);
      if (record.Status !== 1 || !uuid(record.VoucherId) || typeof record.VoucherNumber !== 'string' || !record.VoucherNumber.trim())
        fail('Spiris-fakturan saknar en bekräftad bokföring med verifikationsreferens. Granska i Spiris.', 'visma_tracking_accounting_unknown');
      return { kind: 'booked', invoiceId: record.Id, invoiceNumber: record.NumberSeries && Number.isInteger(record.Number)
        ? `${record.NumberSeries}${record.Number}` : record.InvoiceNumber, voucherId: record.VoucherId, voucherNumber: record.VoucherNumber };
    }
  }
  fail('Spiris-fakturalistan överstiger kontrollens gräns. Granska i Spiris.', 'visma_tracking_incomplete');
}
