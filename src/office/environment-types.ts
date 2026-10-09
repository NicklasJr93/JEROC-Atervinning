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
export interface EnvironmentalMunicipality { code: string; name: string }
export interface EnvironmentalAddressResolution {
  originAddress: string;
  status: 'resolved' | 'needs_address' | 'needs_municipality';
  provider: string;
  resolvedAt?: string;
  municipalityConfirmed?: boolean;
}
export interface EnvironmentalAddressResult extends EnvironmentalAddressResolution {
  place: EnvironmentalPlace;
  missingFields: string[];
  candidates?: EnvironmentalMunicipality[];
}
export type EnvironmentalTransportMode = 'road' | 'rail' | 'sea' | 'air';
export interface IncomingEnvironmentalDocument {
  status?: 'provided' | 'not_required' | 'missing' | 'unknown';
  reference?: string;
  missingReason?: string;
  exemptionReason?: string;
}
export interface EnvironmentalReceiptInput {
  sourceId: string; cardId: number; siteId: string; receivedAt: string;
  originAddress?: string;
  addressResolution?: EnvironmentalAddressResolution;
  rows: { articleId: string; weight: number }[];
  previousHolder: EnvironmentalParty; lastPlace: EnvironmentalPlace; nextPlace: EnvironmentalPlace;
  transportMode: EnvironmentalTransportMode; incomingDocument: IncomingEnvironmentalDocument;
  idempotencyKey: string;
  expectedDraftVersion?: number;
}
export type EnvironmentalDraftInput = Partial<Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'expectedDraftVersion'>> & {
  sourceId: string; cardId: number; siteId: string; originAddress: string;
};
export interface EnvironmentalDraft {
  id: string; sourceId: string; cardId: number; siteId: string; version: number;
  updatedAt: string; updatedBy: string; actualUserId: string; effectiveUserId: string;
  input: EnvironmentalDraftInput;
}
export type EnvironmentalReceiptSnapshot = Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'rows' | 'expectedDraftVersion'> & {
  version: number;
  rows: { articleId: string; weight: number; classification: WasteClassification }[];
};
export interface EnvironmentalCorrection {
  id: string; receiptId: string; sourceId: string; siteId: string; version: number;
  reason: string; previousHash: string; hash: string; snapshot: EnvironmentalReceiptSnapshot;
  createdAt: string; createdBy: string; actualUserId: string; effectiveUserId: string;
  inventoryMovements: EnvironmentalInventory[];
}
export type EnvironmentalCorrectionInput = Omit<EnvironmentalReceiptInput, 'expectedDraftVersion'> & {
  expectedVersion: number; reason: string;
};
export interface EnvironmentalReceipt {
  id: string; sourceId: string; cardId: number; siteId: string; receivedAt: string;
  createdAt: string; createdBy: string; version: number; hash: string; status: 'recorded';
  snapshot: EnvironmentalReceiptSnapshot;
  originalSnapshot?: EnvironmentalReceiptSnapshot;
  originalHash?: string;
  correctionHistory?: EnvironmentalCorrection[];
  deviations: { code: string; message: string }[]; reportIds: string[]; inventoryIds: string[];
}
export interface EnvironmentalReport {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; wasteDescription: string; weight: number;
  status: 'ready' | 'incomplete'; missingFields: string[]; noteDueDate: string;
  reportDueDate: string; createdAt: string; mode: 'prepared-only';
  version?: number;
}
export interface EnvironmentalReportHistory extends Omit<EnvironmentalReport, 'status'> {
  status: 'superseded'; version: number;
}
export interface EnvironmentalInventory {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; weight: number; receivedAt: string; kind: 'receipt' | 'correction';
  classification?: WasteClassification;
  correctionId?: string;
}
export interface EnvironmentState {
  demo: true; mode: 'prepared-only'; revision: number; sites: EnvironmentSite[];
  actualUserId: string; effectiveUserId: string;
  municipalities: EnvironmentalMunicipality[];
  classifications: WasteClassification[]; receipts: EnvironmentalReceipt[];
  inventory: EnvironmentalInventory[]; reports: EnvironmentalReport[];
  drafts: EnvironmentalDraft[]; corrections: EnvironmentalCorrection[];
  reportHistory: EnvironmentalReportHistory[];
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
