import { environmentRequest } from './environment-client';
import type { PaymentDetails } from './model';
import type { ArchivedDocument } from './documents/client';

export interface BankPaymentSource {
  cardId: number; approvalId: string; version: number; hash: string;
  siteId: string; customerId: string; customerName: string; customerType: string;
}
export type BankPaymentStatus = 'queued' | 'in_flight' | 'awaiting_authorization' | 'pending' | 'unknown' | 'simulated_paid' | 'rejected' | 'failed' | 'blocked';
export type BankBookkeepingStatus = 'pending' | 'registered' | 'waiting_booked' | 'paused' | 'unknown' | 'failed' | 'blocked' | 'not_requested';
export interface BankPaymentEvent {
  id?: string; action?: string; type?: string; at?: string; text?: string; message?: string; actor?: string;
  actualUserId?: string; effectiveUserId?: string; status?: string; error?: { code?: string; message?: string } | null;
}
export interface BankPaymentJob {
  id: string; kind: 'card' | 'sandbox'; source?: BankPaymentSource; amount: number; amountCents: number; currency: 'SEK';
  mode: 'sandbox'; simulation: true; paymentDetails: PaymentDetails; originalPaymentDetails?: PaymentDetails;
  status: BankPaymentStatus; bookkeepingStatus: BankBookkeepingStatus; reason?: string;
  createdAt: string; updatedAt: string; verifiedAt?: string; providerPaymentReference?: string; providerPaymentId?: string;
  authorisationUrl?: string | null; providerStatus?: string | null;
  canAuthorise?: boolean; canResume?: boolean; preflightStatus?: 'ready' | 'blocked'; preflightCheckedAt?: string;
  reservedBy?: { actualUserId?: string; effectiveUserId?: string; actualUserName?: string; effectiveUserName?: string };
  error?: { code?: string; message?: string } | string | null; events?: BankPaymentEvent[];
  bookkeeping?: { reason?: string | null; paymentVoucherNumber?: string | null; paymentVoucherId?: string | null };
  request?: unknown; response?: { httpStatus?: number | null; data?: unknown };
  documentRevision?: ArchivedDocument | { document?: ArchivedDocument; documentId?: string; version?: number } | null;
  paymentConfirmationDocument?: ArchivedDocument | { document?: ArchivedDocument; documentId?: string; version?: number } | null;
  paymentDocumentStatus?: 'pending' | 'archived' | 'failed';
}
export interface BankPaymentPreparation {
  cardId: number; source: BankPaymentSource; sourceSnapshotHash?: string; amount: number; amountCents: number; currency: 'SEK';
  customer: { id: string; name: string; type: string; number: string };
  paymentDetails: PaymentDetails; originalPaymentDetails?: PaymentDetails;
  canStart: boolean; canInitiate?: boolean; issues: string[]; existingJob: BankPaymentJob | null;
  settings: { enabled: boolean; spirisBankAccountId?: string; connectionId?: string; debtorAccountId?: string };
  configuration: { ready: boolean; issues?: string[] }; simulation: true; mode: 'sandbox';
}
export interface BankPaymentStart {
  cardId: number; source: Pick<BankPaymentSource, 'approvalId' | 'version' | 'hash'>;
  paymentDetails: PaymentDetails; reason?: string; retryOf?: string;
}
export const bankPaymentsApi = {
  prepare: (cardId: number, signal?: AbortSignal) => environmentRequest<BankPaymentPreparation>(`/bank/payments/cards/${encodeURIComponent(cardId)}/prepare`, 'GET', undefined, signal),
  jobs: (cardId: number, signal?: AbortSignal) => environmentRequest<BankPaymentJob[] | { jobs: BankPaymentJob[] }>(`/bank/payments/cards/${encodeURIComponent(cardId)}`, 'GET', undefined, signal)
    .then(value => Array.isArray(value) ? value : value.jobs),
  start: (value: BankPaymentStart) => environmentRequest<BankPaymentJob>('/bank/payments', 'POST', value),
  job: (id: string, signal?: AbortSignal) => environmentRequest<BankPaymentJob>(`/bank/payments/${encodeURIComponent(id)}`, 'GET', undefined, signal),
  refresh: (id: string, signal?: AbortSignal) => environmentRequest<BankPaymentJob>(`/bank/payments/${encodeURIComponent(id)}/refresh`, 'POST', {}, signal),
  authorise: (id: string, signal?: AbortSignal) => environmentRequest<BankPaymentJob>(`/bank/payments/${encodeURIComponent(id)}/authorise`, 'POST', {}, signal),
  resume: (id: string, signal?: AbortSignal) => environmentRequest<BankPaymentJob>(`/bank/payments/${encodeURIComponent(id)}/resume`, 'POST', {}, signal),
};
export const bankPaymentStatusNames: Record<BankPaymentStatus, string> = {
  queued: 'Banktestet är köat', in_flight: 'Skickar till testbanken', awaiting_authorization: 'Inväntar godkännande i testbanken',
  pending: 'Inväntar bankens slutstatus', unknown: 'Bankens resultat behöver kontrolleras',
  simulated_paid: 'Banken har bekräftat testutbetalningen', rejected: 'Banken avvisade testutbetalningen',
  failed: 'Banktestet kunde inte slutföras', blocked: 'Banktestet behöver kompletteras',
};
export const bankBookkeepingStatusNames: Record<BankBookkeepingStatus, string> = {
  pending: 'Registrering i Spiris sandbox inväntas', registered: 'Testbetalningen är registrerad i Spiris sandbox',
  waiting_booked: 'Inväntar bokförd leverantörsfaktura i Spiris', paused: 'Spiris-registreringen är pausad',
  unknown: 'Spiris-resultatet behöver kontrolleras', failed: 'Spiris-registreringen kunde inte slutföras',
  blocked: 'Spiris-inställningarna behöver kompletteras', not_requested: 'Registrering i Spiris sandbox är inte aktiverad',
};
export const bankPaymentRunning = (job: BankPaymentJob) => ['queued', 'in_flight', 'awaiting_authorization', 'pending'].includes(job.status);
export const bankBookkeepingRunning = (job: BankPaymentJob) => job.status === 'simulated_paid' && ['pending', 'waiting_booked'].includes(job.bookkeepingStatus);
export const bankFailureMessage = (error: BankPaymentJob['error']) => typeof error === 'string' ? error : error?.message;
export const bankPaymentChanged = (cardId: number, actualUserId: string, effectiveUserId: string) => window.dispatchEvent(new CustomEvent('scrappilot:bank-payment-change', {
  detail: { cardId, identity: `${actualUserId}/${effectiveUserId}` },
}));

/** Signing URLs are returned and allowlisted by the server; never accept relative or executable schemes. */
export function bankAuthorisationLink(value: string | null | undefined): string | undefined {
  if (!value || value.length > 4096) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

/** Keep support diagnostics shareable without exposing credentials, signing links or recipient details. */
export function bankDiagnostic(value: unknown, key = '', depth = 0): unknown {
  if (/secret|token|authorization|authorisation|signature|password|certificate|private.?key|redirect|href|url/i.test(key)) return '[borttaget]';
  if (/ssn|personal.?number|personnummer|phone|mobile|alias|clearing|account|iban|bankgiro|plusgiro|beneficiary|holder|address/i.test(key)) {
    return typeof value === 'string' || typeof value === 'number' ? `••••${String(value).replace(/\s/g, '').slice(-4)}` : '[maskerat]';
  }
  if (depth > 8) return '[förkortat]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => bankDiagnostic(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50).map(([name, item]) => [name, bankDiagnostic(item, name, depth + 1)]));
  if (typeof value === 'string') return value.slice(0, 2000).replace(/Bearer\s+\S+/gi, '[borttaget]')
    .replace(/https?:\/\/\S+/gi, '[länk borttagen]')
    .replace(/(?<![\w])\+?\d(?:[ -]?\d){9,15}(?![\w])/g, match => `••••${match.replace(/\D/g, '').slice(-4)}`);
  return value;
}
