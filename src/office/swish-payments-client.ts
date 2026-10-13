import { environmentRequest } from './environment-client';
import type { PaymentDetails } from './model';
import type { ArchivedDocument } from './documents/client';
import type { NvvJsonObject } from './environment-types';

export interface SwishPaymentSource {
  cardId: number; approvalId: string; version: number; hash: string;
  siteId: string; customerId: string; customerName: string; customerType: string;
}
export type SwishPaymentDetails = PaymentDetails & { personalNumber?: string };
export type SwishPaymentStatus = 'queued' | 'in_flight' | 'pending' | 'unknown' | 'simulated_paid' | 'rejected' | 'failed' | 'blocked';
export type SwishBookkeepingStatus = 'pending' | 'registered' | 'waiting_booked' | 'paused' | 'unknown' | 'failed' | 'blocked' | 'not_requested';
export interface SwishPaymentJob {
  id: string; kind: 'card' | 'sandbox'; source?: SwishPaymentSource; sourceSnapshotHash?: string;
  amount: number; amountCents: number; currency: 'SEK'; mode: 'mss'; simulation: true;
  paymentDetails: SwishPaymentDetails; originalPaymentDetails?: PaymentDetails;
  reason?: string; recipient?: unknown; status: SwishPaymentStatus; bookkeepingStatus: SwishBookkeepingStatus;
  providerInstructionUUID?: string; createdAt: string; updatedAt: string; verifiedAt?: string;
  providerPaymentReference?: string;
  reservedBy?: { actualUserId?: string; effectiveUserId?: string; actualUserName?: string; effectiveUserName?: string };
  error?: { code?: string; message?: string; details?: { provider?: string; field?: string; valueType?: string } } | string | null;
  canResume?: boolean;
  preflightStatus?: 'ready' | 'blocked';
  preflightCheckedAt?: string;
  bookkeepingError?: { code?: string; message?: string } | string;
  bookkeeping?: { status?: string; reason?: string | null; paymentId?: string; voucherId?: string; invoiceId?: string | null; bankTransactionId?: string | null;
    paymentVoucherId?: string | null; paymentVoucherNumber?: string | null; paymentDate?: string; updatedAt?: string };
  bookkeepingEnabled?: boolean;
  events?: { id?: string; action?: string; at?: string; text?: string; message?: string; type?: string; actor?: string;
    actualUserId?: string; effectiveUserId?: string; status?: string; error?: { code?: string; message?: string } | null }[];
  request?: { method: string; path: string; payload?: NvvJsonObject };
  response?: { httpStatus?: number | null; data?: unknown };
  documentRevision?: ArchivedDocument | { id?: string; title?: string; documentId?: string; version?: number; originalDocumentId?: string; document?: ArchivedDocument; status?: string } | null;
  paymentConfirmationDocument?: ArchivedDocument | { id?: string; title?: string; documentId?: string; version?: number; originalDocumentId?: string; document?: ArchivedDocument } | null;
  paymentDocumentStatus?: 'pending' | 'archived' | 'failed';
  paymentDocumentError?: string | null;
}
export interface SwishPaymentPreparation {
  cardId: number; source: SwishPaymentSource; sourceSnapshotHash: string;
  amount: number; amountCents: number; currency: 'SEK';
  originalPaymentDetails?: PaymentDetails; paymentDetails: SwishPaymentDetails;
  customer: { id: string; name: string; type: string; number: string };
  canStart: boolean; canInitiate?: boolean; issues: string[]; simulation: true; mode: 'mss'; existingJob: SwishPaymentJob | null;
  settings: { enabled: boolean; spirisBankAccountId?: string };
  configuration: { ready: boolean; mode: string; issues?: string[] };
}
export interface SwishPaymentStart {
  cardId: number; source?: Pick<SwishPaymentSource, 'approvalId' | 'version' | 'hash'>;
  paymentDetails: SwishPaymentDetails; reason?: string; spirisBankAccountId?: string; retryOf?: string;
}
export const swishPaymentsApi = {
  prepare: (cardId: number, signal?: AbortSignal) => environmentRequest<SwishPaymentPreparation>(`/payments/cards/${encodeURIComponent(cardId)}/prepare`, 'GET', undefined, signal),
  jobs: (cardId: number, signal?: AbortSignal) => environmentRequest<SwishPaymentJob[] | { jobs: SwishPaymentJob[] }>(`/payments/cards/${encodeURIComponent(cardId)}`, 'GET', undefined, signal)
    .then(result => Array.isArray(result) ? result : result.jobs),
  start: (value: SwishPaymentStart) => environmentRequest<SwishPaymentJob>('/payments', 'POST', value),
  job: (jobId: string, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>(`/payments/${encodeURIComponent(jobId)}`, 'GET', undefined, signal),
  refresh: (jobId: string, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>(`/payments/${encodeURIComponent(jobId)}/refresh`, 'POST', {}, signal),
  resume: (jobId: string, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>(`/payments/${encodeURIComponent(jobId)}/resume`, 'POST', {}, signal),
};
export const swishPaymentStatusNames: Record<SwishPaymentStatus, string> = {
  queued: 'Testet är köat', in_flight: 'Kontaktar Swish MSS', pending: 'Inväntar Swishs slutstatus',
  unknown: 'Resultatet är oklart', simulated_paid: 'Swish MSS har bekräftat testutbetalningen',
  rejected: 'Swish MSS avvisade testet', failed: 'Testet kunde inte slutföras', blocked: 'Testet behöver kompletteras',
};
export const swishBookkeepingStatusNames: Record<SwishBookkeepingStatus, string> = {
  pending: 'Registrering i Spiris sandbox inväntas', registered: 'Betalningen är registrerad i Spiris sandbox',
  not_requested: 'Registrering i Spiris sandbox är inte aktiverad för detta test',
  waiting_booked: 'Inväntar bokförd leverantörsfaktura i Spiris', paused: 'Spiris-registreringen är pausad',
  unknown: 'Spiris-resultatet behöver kontrolleras', failed: 'Spiris-registreringen kunde inte slutföras',
  blocked: 'Spiris-inställningarna behöver kompletteras',
};
export const swishPaymentRunning = (job: SwishPaymentJob) => ['queued', 'in_flight', 'pending'].includes(job.status);
export const swishBookkeepingRunning = (job: SwishPaymentJob) => job.status === 'simulated_paid' && ['pending', 'waiting_booked'].includes(job.bookkeepingStatus);
export const swishFailureMessage = (failure: SwishPaymentJob['error']) => typeof failure === 'string' ? failure : failure?.message;
export const swishPaymentChanged = (cardId: number, actualUserId: string, effectiveUserId: string) => window.dispatchEvent(new CustomEvent('scrappilot:payment-change', {
  detail: { cardId, identity: `${actualUserId}/${effectiveUserId}` },
}));
