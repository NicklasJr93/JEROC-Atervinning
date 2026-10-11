import { environmentRequest } from './environment-client';
import type { NvvJsonObject } from './environment-types';

export type VismaOperation = 'company' | 'fiscalYears' | 'accounts' | 'paymentTerms' | 'vatCodes' | 'costCenters' | 'projects' | 'suppliers' | 'supplier' | 'draft' | 'createSupplier' | 'createDraft';
export type VismaParameters = { fiscalYearId?: string; resourceId?: string };
export type VismaCardReference = { cardId: number; approvalId: string; version: number; hash: string };
export type VismaAttestedCard = VismaCardReference & { customerName: string; customerType: string; siteName: string; attestedAt: string; attestedBy: string; gross: number; offset: number; net: number };
export type VismaCardPrefill = { source: VismaAttestedCard & { number: string; reference: string; origin: string; deliveredAt: string;
  paymentMethod: string; paymentRecipient: string; rows: { articleId: string; name: string; weight: number; price: number; amount: number }[] };
  supplier: NvvJsonObject; draft: NvvJsonObject; notes: string[] };
export type VismaSandboxRequest = {
  requestId: string;
  idempotencyKey: string;
  operation: VismaOperation;
  parameters?: VismaParameters;
  payload?: NvvJsonObject;
  source?: VismaCardReference;
};
export type VismaSandboxRun = {
  id: string;
  status: 'in_flight' | 'accepted' | 'rejected' | 'unknown';
  operation: VismaOperation;
  method: 'GET' | 'POST';
  path: string;
  parameters?: VismaParameters;
  payload?: NvvJsonObject;
  source?: VismaCardReference;
  startedAt: string;
  finishedAt?: string | null;
  httpStatus?: number | null;
  response?: unknown;
  error?: { code: string; message: string };
  trackingId: string;
  resourceId?: string;
};
export type VismaSandboxStatus = {
  mode: 'sandbox' | 'disabled';
  configured: boolean;
  connected: boolean;
  companyVerified: boolean;
  expectedCompanyId: string | null;
  company: { id: string; name: string; number: string } | null;
  missing: string[];
  scopes: string[];
  redirectUri: string | null;
  localCallbackRelay: boolean;
  operations: { id: VismaOperation; label: string; method: 'GET' | 'POST'; path: string; write: boolean; parameters?: string[] }[];
  templates: { createSupplier: NvvJsonObject; createDraft: NvvJsonObject };
  runs: VismaSandboxRun[];
};

export const vismaSandboxApi = {
  status: (signal?: AbortSignal) => environmentRequest<VismaSandboxStatus>('/visma/status', 'GET', undefined, signal),
  attestedCards: (signal?: AbortSignal) => environmentRequest<{ cards: VismaAttestedCard[] }>('/visma/attested-cards', 'GET', undefined, signal),
  prefill: (cardId: number, signal?: AbortSignal) => environmentRequest<VismaCardPrefill>(`/visma/attested-cards/${cardId}`, 'GET', undefined, signal),
  startOAuth: (signal?: AbortSignal) => environmentRequest<{ authorizationUrl: string }>('/visma/oauth/start', 'POST', {}, signal),
  completeOAuth: (signal?: AbortSignal) => environmentRequest<VismaSandboxStatus>('/visma/oauth/complete', 'POST', {}, signal),
  disconnect: (signal?: AbortSignal) => environmentRequest<VismaSandboxStatus>('/visma/disconnect', 'POST', {}, signal),
  run: (request: VismaSandboxRequest, signal?: AbortSignal) => environmentRequest<VismaSandboxRun>('/visma/sandbox', 'POST', request, signal),
  historyRun: (id: string, signal?: AbortSignal) => environmentRequest<VismaSandboxRun>(`/visma/sandbox/runs/${encodeURIComponent(id)}`, 'GET', undefined, signal),
};
