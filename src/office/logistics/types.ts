import type { ContainerType, TransportAction, TransportDriver, TransportOrder, TransportPlan, TransportVehicle } from '../transport/types';

export type LogisticsPermission = 'workOrdersRead' | 'workOrdersWrite' | 'vesselsRead' | 'vesselsWrite' | 'warehouseRead' | 'warehouseWrite' | 'customerAccounts' | 'carrierAccounts';
export interface LogisticsPlace { name: string; address: string; postalCode: string; city: string; number?: string; contact?: string; phone?: string }
export interface LogisticsWindow { date: string; from?: string; to?: string }
export interface LogisticsMaterial { articleId: string; name: string; plannedKg: number; actualKg?: number; hazardous: boolean; wasteCode: string }
export interface LogisticsSignature { role: 'sender' | 'carrier'; actorId: string; actorName: string; at: string; documentVersion: number; documentHash: string; method: 'demo_staff' | 'demo_account' }
export interface LogisticsDocument { version: number; hash: string; preparedAt: string; signatures: LogisticsSignature[]; status: 'draft' | 'prepared'; snapshot: { from: LogisticsPlace; to: LogisticsPlace; carrierId?: string; driverId?: string; vehicleId?: string; rows: LogisticsMaterial[]; handling: string } }
export interface LogisticsOrderDetail {
  orderId: string; version: number; siteId: string; operator: 'own' | 'external'; carrierId?: string;
  vesselId?: string; replacementVesselId?: string; agreementId?: string; source: 'office' | 'customer' | 'agreement' | 'warehouse';
  materialRows: LogisticsMaterial[]; from: LogisticsPlace; to: LogisticsPlace; requestedWindow?: LogisticsWindow; confirmedWindow?: LogisticsWindow;
  assignedDriverId?: string; assignedVehicleId?: string;
  carrierRequest: { status: 'draft' | 'sent' | 'accepted' | 'declined' | 'time_proposed'; version: number; sentAt?: string; respondedAt?: string; comment?: string; proposedWindow?: LogisticsWindow };
  execution: { stage: 'pending' | 'travelling_empty' | 'at_pickup' | 'loaded' | 'departed' | 'delivered'; officeCleared: boolean; departedAt?: string; deliveredAt?: string };
  document?: LogisticsDocument; priority: 'normal' | 'asap'; handling: string; updatedAt: string;
}
export interface LogisticsOrder extends TransportOrder { detail: LogisticsOrderDetail }
export interface LogisticsVessel { id: string; name: string; type: ContainerType; size: string; siteId: string; active: boolean; customerId?: string; agreementId?: string; place?: LogisticsPlace; status: 'available' | 'placed' | 'reserved' | 'maintenance'; fullness?: number; materialArticleId?: string; version: number }
export interface LogisticsAgreement { id: string; customerId: string; siteId: string; vesselId: string; active: boolean; action: 'pickup' | 'exchange'; intervalDays: number; nextDate: string; notes: string; version: number; kind?: 'rental' | 'rolling'; rentalStart?: string; rentalEnd?: string; allowedActions?: ('pickup' | 'exchange')[] }
export interface LogisticsCustomerRequest { id: string; customerId: string; vesselId: string; orderId: string; type: 'pickup' | 'exchange' | 'earlier'; requestedDate?: string; comment: string; status: 'pending' | 'accepted' | 'declined'; createdAt: string; respondedAt?: string; response?: string; version: number }
export interface LogisticsInventoryMovement { id: string; siteId: string; articleId: string; articleName: string; wasteCode: string; hazardous: boolean; kg: number; kind: 'receipt' | 'adjustment' | 'outbound'; sourceId: string; at: string; actorId: string; reason: string }
export interface LogisticsStock { siteId: string; articleId: string; articleName: string; wasteCode: string; hazardous: boolean; onHandKg: number; reservedKg: number; availableKg: number }
export interface LogisticsAccount { id: string; kind: 'customer' | 'carrier'; subjectId: string; username: string; active: boolean; createdAt: string; updatedAt: string; lastLoginAt?: string }
export interface LogisticsDeliveryPreview { id: string; orderId: string; requestVersion: number; carrierId: string; channel: 'email'; status: 'prepared' | 'superseded' | 'cancelled'; deliveryEnabled: false; recipient: string; createdAt: string; subject: string; text: string; portalPath: string }
export interface LogisticsCustomer { id: string; name: string; number: string; address: string; postalCode: string; city: string; phone: string; email: string; contactPerson: string }
export interface LogisticsCarrier { id: string; name: string; number: string; contact: string; phone: string; email: string; address?: string; postalCode?: string; city?: string }
export interface LogisticsSite { id: string; name: string; address: string; postalCode: string; city: string; active: boolean }
export interface LogisticsOfficeState {
  demo: true; revision: number; capabilities: LogisticsPermission[]; sites: LogisticsSite[]; orders: LogisticsOrder[];
  vessels: LogisticsVessel[]; agreements: LogisticsAgreement[]; requests: LogisticsCustomerRequest[];
  stock: LogisticsStock[]; inventoryMovements: LogisticsInventoryMovement[]; customers: LogisticsCustomer[];
  carriers: LogisticsCarrier[]; drivers: TransportDriver[]; vehicles: TransportVehicle[]; accounts: LogisticsAccount[];
  articles: { id: string; name: string; hazardous: boolean; wasteCode: string; handlingInstructions: string }[];
  result?: { orderId?: string; requestId?: string };
  deliveryOutbox?: LogisticsDeliveryPreview[];
}
export interface LogisticsOrderInput {
  siteId: string; action: TransportAction; customerId?: string; from: LogisticsPlace; to: LogisticsPlace;
  operator: 'own' | 'external'; carrierId?: string; vesselId?: string; replacementVesselId?: string; agreementId?: string;
  vesselType: ContainerType; vesselSize?: string; materialRows: { articleId: string; plannedKg: number }[];
  requestedWindow?: LogisticsWindow; priority?: 'normal' | 'asap'; durationMinutes?: number; handling?: string; notes?: string;
  assignedDriverId?: string; assignedVehicleId?: string;
  lat?: number; lng?: number;
}
export type LogisticsOfficeCommand =
  | { action: 'order.create'; input: LogisticsOrderInput; idempotencyKey: string }
  | { action: 'order.edit'; orderId: string; expectedVersion: number; input: LogisticsOrderInput }
  | { action: 'order.book'; orderId: string; expectedVersion: number; plan: TransportPlan }
  | { action: 'order.cancel'; orderId: string; expectedVersion: number; reason: string }
  | { action: 'order.send'; orderId: string; expectedVersion: number }
  | { action: 'order.confirmTime'; orderId: string; expectedVersion: number; window: LogisticsWindow }
  | { action: 'order.clearance'; orderId: string; expectedVersion: number; cleared: boolean }
  | { action: 'order.load'; orderId: string; expectedVersion: number; rows: { articleId: string; actualKg: number }[] }
  | { action: 'order.document'; orderId: string; expectedVersion: number }
  | { action: 'order.sign'; orderId: string; expectedVersion: number; role: 'sender' | 'carrier'; documentVersion: number }
  | { action: 'order.depart' | 'order.deliver'; orderId: string; expectedVersion: number }
  | { action: 'request.respond'; requestId: string; expectedVersion: number; accepted: boolean; comment?: string }
  | { action: 'vessel.save'; vessel: Partial<LogisticsVessel> & Pick<LogisticsVessel, 'id' | 'name' | 'type' | 'siteId'>; expectedVersion: number }
  | { action: 'agreement.save'; agreement: Omit<LogisticsAgreement, 'version'>; expectedVersion: number }
  | { action: 'inventory.adjust'; siteId: string; articleId: string; kg: number; reason: string; idempotencyKey: string }
  | { action: 'account.save'; account: { id?: string; kind: 'customer' | 'carrier'; subjectId: string; username: string; active: boolean; password?: string } };
export interface CustomerPortalState { demo: true; customer: { id: string; name: string }; vessels: LogisticsVessel[]; agreements: LogisticsAgreement[]; requests: LogisticsCustomerRequest[]; orders: LogisticsOrder[] }
export interface CustomerPortalRequest { vesselId: string; type: 'pickup' | 'exchange' | 'earlier'; requestedDate?: string; comment: string; existingOrderId?: string; idempotencyKey: string }
export interface CarrierPortalState { demo: true; company: LogisticsCarrier; orders: LogisticsOrder[]; drivers: { id: string; personId: string; name: string }[]; vehicles: TransportVehicle[] }
export type CarrierPortalCommand =
  | { action: 'request.respond'; orderId: string; expectedVersion: number; response: 'accept' | 'decline' | 'propose'; window?: LogisticsWindow; comment?: string }
  | { action: 'order.assign'; orderId: string; expectedVersion: number; driverId: string; vehicleId: string }
  | { action: 'order.sign'; orderId: string; expectedVersion: number; documentVersion: number };
export type LogisticsDriverCommand =
  | { action: 'travel.empty' | 'arrive' | 'depart' | 'deliver'; expectedVersion: number }
  | { action: 'load'; expectedVersion: number; rows: { articleId: string; actualKg: number }[] }
  | { action: 'sign'; expectedVersion: number; documentVersion: number };
