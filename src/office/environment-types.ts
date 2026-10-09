export interface EnvironmentSite {
  id: string; name: string; address: string; postalCode: string; city: string; municipalityCode: string;
}
export interface EnvironmentSessionState {
  demo: true; actualUserId: string; effectiveUserId: string;
  user: { id: string; name: string; level: string; permissions: string[]; siteIds?: string[] };
  csrfToken: string; expiresAt: string;
}
export interface WasteClassification {
  articleId: string; version: number; hazardous: boolean; wasteCode: string;
  wasteDescription: string; handlingInstructions: string; adrRequired: boolean;
  updatedAt?: string; updatedBy?: string;
}
export interface EnvironmentalParty { name: string; number: string; contactName: string; email: string; phone: string }
export interface EnvironmentalPlace { address: string; postalCode: string; city: string; municipalityCode: string }
export type EnvironmentalTransportMode = 'road' | 'rail' | 'sea' | 'air';
export interface IncomingEnvironmentalDocument { reference?: string; missingReason?: string }
export interface EnvironmentalReceiptInput {
  sourceId: string; cardId: number; siteId: string; receivedAt: string;
  rows: { articleId: string; weight: number }[];
  previousHolder: EnvironmentalParty; lastPlace: EnvironmentalPlace; nextPlace: EnvironmentalPlace;
  transportMode: EnvironmentalTransportMode; incomingDocument: IncomingEnvironmentalDocument;
  idempotencyKey: string;
}
export interface EnvironmentalReceipt {
  id: string; sourceId: string; cardId: number; siteId: string; receivedAt: string;
  createdAt: string; createdBy: string; version: 1; hash: string; status: 'recorded';
  snapshot: Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'rows'> & {
    version: 1; rows: { articleId: string; weight: number; classification: WasteClassification }[];
  };
  deviations: { code: string; message: string }[]; reportIds: string[]; inventoryIds: string[];
}
export interface EnvironmentalReport {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; wasteDescription: string; weight: number;
  status: 'ready' | 'incomplete'; missingFields: string[]; noteDueDate: string;
  reportDueDate: string; createdAt: string; mode: 'prepared-only';
}
export interface EnvironmentalInventory {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; weight: number; receivedAt: string; kind: 'receipt';
}
export interface EnvironmentState {
  demo: true; mode: 'prepared-only'; revision: number; sites: EnvironmentSite[];
  classifications: WasteClassification[]; receipts: EnvironmentalReceipt[];
  inventory: EnvironmentalInventory[]; reports: EnvironmentalReport[];
}
export const emptyClassification = (articleId: string): WasteClassification => ({
  articleId, version: 0, hazardous: false, wasteCode: '', wasteDescription: '', handlingInstructions: '', adrRequired: false,
});
export const transportModeNames: Record<EnvironmentalTransportMode, string> = {
  road: 'Vägtransport', rail: 'Järnväg', sea: 'Sjötransport', air: 'Flygtransport',
};
export const formatWasteCode = (code: string, hazardous = true) => `${code.replace(/\D/g, '').replace(/(\d{2})(\d{2})(\d{2})/, '$1 $2 $3')}${hazardous && code ? '*' : ''}`;
export const environmentTime = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const environmentWeight = (value: number) => `${value.toLocaleString('sv-SE', { maximumFractionDigits: 3 })} kg`;
