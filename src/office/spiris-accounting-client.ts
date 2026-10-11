import type { AccountingSettings, AccountingDraftRow, AccountingDraft, AccountingSnapshot } from './accounting-types';
import { environmentRequest } from './environment-client';
import type { VismaCardReference } from './visma-sandbox-client';

export interface SpirisChoices {
  companyId: string;
  fetchedAt: string;
  fiscalYears: { id: string; startDate: string; endDate: string; locked: boolean }[];
  accounts: { number: number; name: string; fiscalYearId: string; active: boolean; vatCodeId?: string | null;
    firstCostCenterMandatory?: boolean; costCenterAllowed?: boolean; projectAllowed?: boolean;
    blockedForManualBooking?: boolean; transactionTextAllowed?: boolean }[];
  vatCodes: { id: string; code: string; name: string; rate: number }[];
  paymentTerms: { id: string; name: string; days: number; availableForPurchase: boolean }[];
  costCenters: { id: string; name: string; number: number; active: boolean;
    items: { id: string; name: string; shortName: string; active: boolean }[] }[];
  projects: { id: string; name: string; number: string; status: number | string }[];
}

export interface SpirisAccountingState {
  settings: AccountingSettings;
  company: { id: string; name: string; number: string } | null;
  companyVerified: boolean;
  sites: { id: string; name: string }[];
  choices: SpirisChoices | null;
  suggestedPaymentTermsId?: string;
  capabilities: { canConfigure: boolean; canExport: boolean; automationEnabled: boolean };
  issues: string[];
}

export type SpirisExample = 'private' | 'reverse_scrap' | 'standard_25' | 'non_vat_business';
export interface SpirisSamplePreview {
  accounting?: { baseTotal?: number; sellerVat?: number; reverseVat?: number; invoiceTotal?: number; net?: number };
  draft?: { Rows: AccountingDraftRow[]; DueDate?: string; TotalAmount?: number; Vat?: number };
  rows?: AccountingDraftRow[];
  issues: (string | { code: string; message: string })[];
}

export interface SpirisExport {
  id: string;
  source: VismaCardReference;
  companyId: string;
  customerId: string;
  status: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
  supplierId?: string;
  draftId?: string;
  error?: { code: string; message: string };
  runs: { supplierRequestId?: string; draftRequestId?: string };
  settingsRevision: number;
  trigger: 'manual' | 'after_attest';
}

export interface SpirisCardPreview {
  source: VismaCardReference;
  eligible: boolean;
  issues: (string | { code: string; message: string })[];
  supplier?: unknown;
  draft?: AccountingDraft;
  accounting?: AccountingSnapshot;
  mapping?: unknown;
  export?: SpirisExport | null;
}

export const spirisAccountingApi = {
  settings: (signal?: AbortSignal) => environmentRequest<SpirisAccountingState>('/visma/accounting/settings', 'GET', undefined, signal),
  saveSettings: (settings: AccountingSettings, expectedRevision: number, signal?: AbortSignal) =>
    environmentRequest<SpirisAccountingState>('/visma/accounting/settings', 'POST', { expectedRevision, settings }, signal),
  lookupChoices: (signal?: AbortSignal) => environmentRequest<SpirisAccountingState>('/visma/accounting/choices', 'POST', {}, signal),
  samplePreview: (request: { settings: AccountingSettings; siteId: string; example: SpirisExample; amount: number; date: string }, signal?: AbortSignal) =>
    environmentRequest<SpirisSamplePreview>('/visma/accounting/preview', 'POST', request, signal),
  preview: (cardId: number, signal?: AbortSignal) => environmentRequest<SpirisCardPreview>('/visma/accounting/preview', 'POST', { cardId }, signal),
  exports: (signal?: AbortSignal, cardId?: number) => environmentRequest<{ exports: SpirisExport[] }>(`/visma/accounting/exports${cardId === undefined ? '' : `?cardId=${cardId}`}`, 'GET', undefined, signal),
  sendExport: (cardId: number, source?: VismaCardReference, signal?: AbortSignal) =>
    environmentRequest<SpirisExport>('/visma/accounting/exports', 'POST', { cardId, ...(source ? { source } : {}) }, signal),
};
