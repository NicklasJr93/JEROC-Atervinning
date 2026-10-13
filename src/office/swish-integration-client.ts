import { environmentRequest } from './environment-client';
import { can, type OfficeUser } from './model';
import type { NvvJsonObject } from './environment-types';

export type SwishPaymentStatus = 'queued' | 'in_flight' | 'pending' | 'unknown' | 'simulated_paid' | 'rejected' | 'failed' | 'blocked';
export interface SwishPaymentDetails {
  method: 'swish'; phone: string; personalNumber: string; recipient: string;
}
export interface SwishSettings {
  enabled: boolean; bookkeepingEnabled: boolean; spirisBankAccountId?: string | null; spirisCompanyId?: string | null;
  revision: number; updatedAt?: string;
}
export interface SwishIntegrationState {
  settings: SwishSettings;
  configuration: { ready: boolean; mode: 'mss' | 'disabled'; missing: string[]; issues: string[]; merchantAlias?: string };
  mode: 'mss'; simulation: true;
  defaults: { amount: string; paymentDetails: SwishPaymentDetails; message: string };
}
export interface SwishBankChoices {
  companyId: string; companyName?: string;
  bankAccounts: { id: string; name: string; ledgerAccountNumber?: number; active?: boolean; currency?: string; type?: string | number }[];
}
export interface SwishSandboxRequest {
  amount: string; paymentDetails: SwishPaymentDetails; message: string; idempotencyKey: string;
}
export interface SwishPaymentJob {
  id: string; kind: 'sandbox' | 'card'; mode: 'mss'; simulation: true; status: SwishPaymentStatus;
  amount?: string | number; amountCents: number; currency: string; paymentDetails: SwishPaymentDetails;
  providerInstructionUUID?: string; startedAt?: string; createdAt?: string; updatedAt?: string;
  request?: { method: 'POST' | 'GET'; path: string; payload?: NvvJsonObject };
  response?: { httpStatus?: number | null; data?: unknown };
  events: { at?: string; text?: string; message?: string; action?: string; type?: string }[];
  error?: { code?: string; message: string };
  bookkeepingStatus?: string;
}

/** Both identities must independently have the explicit company permission. */
export const mayManageSwish = (user: OfficeUser, actualUser: OfficeUser) =>
  [user, actualUser].every(person => !person.siteIds && can(person, 'integrationsRead') && can(person, 'integrationsManage'));

export const swishPaymentStatusLabel = (status: SwishPaymentStatus) => ({
  queued: 'Väntar på test', in_flight: 'Skickar till Swish MSS', pending: 'Inväntar Swish MSS',
  unknown: 'Resultatet behöver kontrolleras', simulated_paid: 'Simulerad utbetalning bekräftad',
  rejected: 'Swish avvisade testet', failed: 'Testet kunde inte slutföras', blocked: 'Testet behöver kompletteras',
}[status]);

export const swishIntegrationApi = {
  settings: (signal?: AbortSignal) => environmentRequest<SwishIntegrationState>('/swish/settings', 'GET', undefined, signal),
  saveSettings: (value: Pick<SwishSettings, 'enabled' | 'bookkeepingEnabled' | 'spirisBankAccountId' | 'spirisCompanyId'>, signal?: AbortSignal) =>
    environmentRequest<SwishIntegrationState>('/swish/settings', 'POST', value, signal),
  choices: (signal?: AbortSignal) => environmentRequest<SwishBankChoices>('/swish/choices', 'GET', undefined, signal),
  sandbox: (value: SwishSandboxRequest, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>('/swish/sandbox', 'POST', value, signal),
  job: (id: string, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>(`/swish/jobs/${encodeURIComponent(id)}`, 'GET', undefined, signal),
  refresh: (id: string, signal?: AbortSignal) => environmentRequest<SwishPaymentJob>(`/swish/jobs/${encodeURIComponent(id)}/refresh`, 'POST', {}, signal),
};
