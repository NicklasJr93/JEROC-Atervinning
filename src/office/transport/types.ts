export type ContainerType = 'container' | 'battery' | 'bin' | 'cage';
export type TransportAction = 'pickup' | 'exchange' | 'placement';
export type TransportStatus = 'unbooked' | 'booked' | 'on_way' | 'done' | 'cancelled';
export const vesselTypes: Record<ContainerType, { label: string; color: string }> = {
  container: { label: 'Container', color: '#1673ff' },
  battery: { label: 'Batterilåda', color: '#f58a12' },
  bin: { label: 'Tunna/kärl', color: '#20a354' },
  cage: { label: 'Bur', color: '#8438ec' },
};
export const actionLabels: Record<TransportAction, string> = {
  pickup: 'Hämtning', exchange: 'Byte', placement: 'Utställning',
};
export const transportStatusLabels: Record<TransportStatus, string> = {
  unbooked: 'Obokat', booked: 'Bokat', on_way: 'På väg', done: 'Klart', cancelled: 'Avbrutet',
};
export interface TransportAudit {
  at: string; actor: string; actualUserId: string; effectiveUserId: string; text: string;
}
export interface TransportDriver {
  id: string; name: string; color: string; vehicleId: string;
  /** Stable personnel/company links; driver IDs and historic bookings remain unchanged. */
  personId?: string; companyId?: string;
}
export interface TransportVehicle {
  id: string; registration: string; name: string; types: ContainerType[];
  requiredCompetencies?: string[];
}
export interface TransportOrder {
  id: string; customerId?: string; customerName: string; address: string; city: string;
  contact: string; phone: string; action: TransportAction; vesselType: ContainerType;
  material: string; vesselSize: string; pickupVessel: string; replacementVessel: string;
  notes: string; lat: number; lng: number; durationMinutes: number;
  status: TransportStatus; date?: string; startMinute?: number;
  driverId?: string; vehicleId?: string; requestedDate?: string;
  seriesId?: string; audit: TransportAudit[]; updatedAt: string;
  bookingVersion: number; confirmation?: TransportConfirmation;
  /** Explicit transport requirements; hazardous waste alone never implies ADR. */
  requiredCompetencies?: string[];
  /** Rendering projection only. The stored order remains unbooked until the group is committed. */
  preliminary?: boolean;
}
export interface TransportData {
  version: 1; revision: number; orders: TransportOrder[];
  drivers: TransportDriver[]; vehicles: TransportVehicle[];
  preliminary: Record<string, TransportPlan>; events: TransportIntegrationEvent[];
}
export interface TransportActor {
  canPlan: boolean; actor: string; actualUserId: string; effectiveUserId: string;
}
export type TransportDraft = Omit<TransportOrder, 'id' | 'audit' | 'updatedAt' | 'seriesId' | 'bookingVersion' | 'confirmation' | 'preliminary'>;
export interface TransportPlan {
  date: string; startMinute: number; durationMinutes: number; driverId: string; vehicleId: string;
}
export interface CalendarProposal {
  id: string; date: string; startMinute: number; durationMinutes: number; driverId: string;
  kind: 'book' | 'move' | 'resize';
}
export type TransportChange =
  | { type: 'create'; draft: TransportDraft; repeat?: 'none' | 'weekly' | 'biweekly' }
  | { type: 'edit'; id: string; patch: Partial<TransportDraft>; scope?: 'one' | 'series' }
  | { type: 'book' | 'reschedule'; id: string; plan: TransportPlan }
  | { type: 'unbook'; id: string }
  | { type: 'cancel'; id: string; reason: string }
  | { type: 'status'; id: string; status: 'on_way' | 'done' };
export interface TransportFocusRequest { id: string; nonce: number }

export type TransportEventType = 'work_order.created' | 'work_order.updated' | 'work_order.booked' |
  'work_order.rescheduled' | 'work_order.booking_cancelled' | 'work_order.cancelled' |
  'work_order.en_route' | 'work_order.completed' | 'work_order.confirmation_requested' |
  'work_order.confirmation_accepted' | 'work_order.confirmation_declined' | 'work_order.confirmation_expired';
/** Persisted outbox contract. Events are prepared locally; no notifications are sent by the demo. */
export interface TransportIntegrationEvent {
  id: string; type: TransportEventType; orderId: string; at: string; bookingVersion: number;
  customer: { id?: string; name: string };
  driver?: { id: string; name: string };
  beforePlan?: TransportPlan; afterPlan?: TransportPlan; reason?: string;
  actor: string; actualUserId: string; effectiveUserId: string;
  confirmationId?: string;
}
export interface TransportConfirmation {
  id: string; bookingVersion: number; status: 'requested' | 'accepted' | 'declined' | 'expired';
  requestedAt: string; expiresAt: string; respondedAt?: string;
}
