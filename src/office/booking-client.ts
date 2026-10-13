import { environmentRequest } from './environment-client';

export type SpirisAttestAction = 'draft' | 'book';
export type SpirisBookingStatus = 'not_configured' | 'awaiting_attest' | 'creating_draft' | 'draft' | 'booking' | 'booked' | 'failed' | 'unknown' | 'paused' | 'missing';
export interface SpirisCardBooking {
  cardId: number;
  status: SpirisBookingStatus;
  reason?: string | null;
  draftId?: string | null;
  invoiceId?: string | null;
  voucherNumber?: string | null;
  canBook: boolean;
  canRefresh: boolean;
}
const path = (cardId: number) => `/visma/accounting/cards/${encodeURIComponent(cardId)}/booking`;
export const spirisBookingApi = {
  read: (cardId: number, signal?: AbortSignal) => environmentRequest<SpirisCardBooking>(path(cardId), 'GET', undefined, signal),
  book: (cardId: number, signal?: AbortSignal) => environmentRequest<SpirisCardBooking>(path(cardId), 'POST', {}, signal),
  refresh: (cardId: number, signal?: AbortSignal) => environmentRequest<SpirisCardBooking>(`${path(cardId)}/refresh`, 'POST', {}, signal),
};
export const spirisBookingStatusNames: Record<SpirisBookingStatus, string> = {
  not_configured: 'Spiris-kopplingen behöver ställas in', awaiting_attest: 'Inväntar attest',
  creating_draft: 'Skapar utkast i Spiris', draft: 'Utkast skapat · behöver bokföras',
  booking: 'Bokföring i Spiris pågår', booked: 'Bokförd i Spiris · klar för utbetalning',
  failed: 'Bokföring behöver åtgärdas', unknown: 'Bokföringen behöver kontrolleras',
  paused: 'Spiris-kopplingen är pausad', missing: 'Underlaget saknas i Spiris',
};
export const spirisBookingChanged = (cardId: number, actualUserId: string, effectiveUserId: string) => window.dispatchEvent(new CustomEvent('scrappilot:booking-change', {
  detail: { cardId, identity: `${actualUserId}/${effectiveUserId}` },
}));
