export interface EnvironmentSite {
  id: string; name: string; address: string; postalCode: string; city: string; municipalityCode: string;
  version: number; active: boolean; permitReference: string; permitNotes: string;
}
export interface EnvironmentSiteInput {
  expectedVersion: number; name: string; address: string; postalCode: string; city: string; municipalityCode: string;
  active: boolean; permitReference: string; permitNotes: string;
}
export interface EnvironmentalStorageRule { siteId: string; allowed: boolean; maxKg: number | null }
export interface EnvironmentalStoragePolicy {
  id: string; siteId: string; version: number; totalMaxKg: number | null;
  rules: { wasteCode: string; allowed: boolean; maxKg: number | null }[];
  updatedAt: string; updatedBy: string;
}
export interface EnvironmentalStoragePolicyInput {
  expectedVersion: number; totalMaxKg: number | null;
  rules: { wasteCode: string; allowed: boolean; maxKg: number | null }[];
}
export interface EnvironmentalStorageAssessment {
  siteId: string; canReceive: boolean; checkedAt: string;
  checks: { code: string; severity: 'ok' | 'warning' | 'blocked'; message: string; articleId?: string; wasteCode?: string;
    currentKg: number; incomingKg: number; projectedKg: number; maxKg?: number | null }[];
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
  storageRules?: EnvironmentalStorageRule[];
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
  status?: 'provided' | 'not_required' | 'not_shown' | 'missing' | 'unknown';
  selection?: 'automatic' | 'manual';
  reference?: string;
  missingReason?: string;
  exemptionReason?: string;
}
export interface EnvironmentalReceiptInput {
  sourceId: string; cardId: number; siteId: string; receivedAt: string;
  materialScope?: 'hazardous';
  originAddress?: string;
  addressResolution?: EnvironmentalAddressResolution;
  rows: { articleId: string; weight: number }[];
  previousHolder: EnvironmentalParty; lastPlace: EnvironmentalPlace; nextPlace: EnvironmentalPlace;
  transportMode: EnvironmentalTransportMode; incomingDocument: IncomingEnvironmentalDocument;
  idempotencyKey: string;
  expectedDraftVersion?: number;
  approvalExceptionReason?: string;
}
export type EnvironmentalDraftInput = Partial<Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'expectedDraftVersion'>> & {
  sourceId: string; cardId: number; siteId: string; originAddress: string;
};
export interface EnvironmentalDraft {
  id: string; sourceId: string; cardId: number; siteId: string; version: number;
  updatedAt: string; updatedBy: string; actualUserId: string; effectiveUserId: string;
  input: EnvironmentalDraftInput;
  environmentPatch?: EnvironmentalSourceProjection;
}
export type EnvironmentalReceiptSnapshot = Omit<EnvironmentalReceiptInput, 'idempotencyKey' | 'rows' | 'expectedDraftVersion'> & {
  version: number;
  storageAssessment?: EnvironmentalStorageAssessment;
  customerApproval?: { id: string; version: number; hash: string; status: string; approvedAt?: string; exceptionReason?: string };
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
  environmentPatch?: EnvironmentalSourceProjection;
}
export interface EnvironmentalReport {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; wasteDescription: string; weight: number;
  status: NvvReportStatus; missingFields: string[]; noteDueDate: string;
  reportDueDate: string; createdAt: string; mode: 'prepared-only' | NvvMode;
  version?: number;
  nvv?: {
    status: NvvReportStatus; mode: 'prepared-only' | NvvMode; avfallId?: string; versionId?: string;
    receiptVersion: number; configuredMode?: NvvMode; missingFields?: string[]; error?: { code?: string; message: string };
  };
}
export interface EnvironmentalReportHistory extends Omit<EnvironmentalReport, 'status'> {
  status: 'superseded'; version: number;
}
export interface EnvironmentalInventory {
  id: string; receiptId: string; sourceId: string; cardId: number; siteId: string;
  articleId: string; wasteCode: string; weight: number; receivedAt: string; kind: 'receipt' | 'correction' | 'outbound';
  classification?: WasteClassification;
  correctionId?: string;
}
export interface EnvironmentState {
  demo: true; mode: 'prepared-only'; revision: number; sites: EnvironmentSite[];
  actualUserId: string; effectiveUserId: string;
  municipalities: EnvironmentalMunicipality[];
  classifications: WasteClassification[]; receipts: EnvironmentalReceipt[];
  storagePolicies: EnvironmentalStoragePolicy[];
  inventory: EnvironmentalInventory[]; reports: EnvironmentalReport[];
  drafts: EnvironmentalDraft[]; corrections: EnvironmentalCorrection[];
  reportHistory: EnvironmentalReportHistory[];
}
export interface EnvironmentalSourceProjection {
  demo?: true; revision: number; sourceId: string;
  receipt: EnvironmentalReceipt | null; draft: EnvironmentalDraft | null;
  classifications: WasteClassification[]; sites: EnvironmentSite[]; storagePolicies: EnvironmentalStoragePolicy[];
  municipalities?: EnvironmentalMunicipality[];
  reports: EnvironmentalReport[]; reportHistory: EnvironmentalReportHistory[]; inventory: EnvironmentalInventory[];
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

export type NvvMode = 'disabled' | 'mock' | 'test';
export type NvvReportStatus = 'ready' | 'incomplete' | 'sending' | 'reported' | 'simulated' | 'error' | 'unknown' | 'correction_required';
export interface NvvReporterInput {
  name: string; number: string; contactName: string; email: string; phone: string;
  certificateOrganisationNumber: string; testIdentityConfirmed: boolean;
  expectedVersion: number;
}
export interface NvvReporter extends Omit<NvvReporterInput, 'expectedVersion'> {
  version: number; updatedAt: string; updatedBy: string;
}
export interface NvvCheckDiagnostic {
  method: 'GET' | 'POST'; path: string; httpStatus: number | null;
  trackingId?: string; outcome: 'accepted' | 'rejected' | 'unknown';
  response: Record<string, unknown> | string | null;
}
export interface NvvConnectionCheck {
  mode: NvvMode; connected: boolean; checkedAt: string;
  wasteCodes: { code: string; description: string; hazardous: boolean }[];
  transportModes: { code: string; description: string }[];
  diagnostics?: NvvCheckDiagnostic[];
  error?: { code?: string; message: string };
}
export interface NvvIntegrationStatus {
  mode: NvvMode; configured: boolean; connected: boolean; missing: string[];
  reporter: NvvReporter | null; reporterVersion: number; lastCheck: NvvConnectionCheck | null;
  enabled?: boolean; productionEnabled?: false;
  certificate?: {
    configured: boolean; validated: boolean; metadataAvailable: boolean;
    freshHandshake?: boolean;
    organisationName: string | null; organisationNumber: string | null;
    issuer: string | null; validFrom: string | null; validTo: string | null; fingerprint256: string | null;
  };
}
export type NvvJsonValue = string | number | boolean | null | NvvJsonObject | NvvJsonValue[];
export interface NvvJsonObject { [key: string]: NvvJsonValue }
export interface NvvSandboxRun {
  id: string; status: 'in_flight' | 'accepted' | 'rejected' | 'unknown';
  method: 'POST'; path: '/insamlingar'; payload: NvvJsonObject;
  startedAt: string; finishedAt?: string; httpStatus: number | null; response: NvvJsonValue;
  trackingId: string; outcome?: 'accepted' | 'rejected' | 'unknown'; avfallId?: string;
  error?: { code?: string; message: string };
  clientCertificate?: NonNullable<NvvIntegrationStatus['certificate']>;
}
export interface NvvSandboxState {
  mode: NvvMode; ready: boolean; missing: string[];
  certificate: NonNullable<NvvIntegrationStatus['certificate']> | null;
  template: NvvJsonObject; runs: NvvSandboxRun[];
}
export interface NvvSandboxRequest {
  requestId: string; idempotencyKey: string; payload: NvvJsonObject;
}
export interface NvvReportVersion {
  id: string; reportId: string; sourceReportIds: string[]; receiptId: string; receiptVersion: number;
  siteId: string; wasteCode: string; weight: number; mode: NvvMode;
  method: 'POST' | 'PUT'; path: string; payload: unknown; payloadHash: string;
  reporterVersion: number; previousAvfallId?: string; createdAt: string; createdBy: string;
  clientCertificate?: NvvIntegrationStatus['certificate'];
}
export interface NvvAttempt {
  id: string; versionId: string; trackingId: string; kind: 'submit' | 'read';
  startedAt: string; finishedAt: string; outcome: 'accepted' | 'rejected' | 'unknown';
  httpStatus: number | null; avfallId?: string; response: unknown;
  error?: { code: string; message: string; details?: unknown }; mode: NvvMode;
  clientCertificate?: NvvIntegrationStatus['certificate'];
}
export interface NvvReportDetail {
  reportId: string; receiptVersion: number; status: NvvReportStatus; mode: 'prepared-only' | NvvMode;
  avfallId?: string; missingFields: string[]; versions: NvvReportVersion[]; attempts: NvvAttempt[];
  job?: {
    id: string; versionId: string; status: 'queued' | 'in_flight' | 'accepted' | 'rejected' | 'unknown';
    avfallId?: string; lastError?: { code?: string; message: string }; updatedAt: string;
  };
}
