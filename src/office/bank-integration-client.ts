import { environmentRequest, EnvironmentApiError } from './environment-client';
import { can, type OfficeUser } from './model';

export interface BankProviderConfiguration {
  ready: boolean; mode?: 'sandbox' | 'disabled'; missing: string[]; issues: string[]; redirectUri?: string | null;
}
export interface BankSettings {
  enabled: boolean; bankId?: string | null; corporateId?: string | null; psuId?: string | null;
  debtorAccountId?: string | null; bookkeepingEnabled: boolean; spirisCompanyId?: string | null;
  spirisBankAccountId?: string | null; revision: number; updatedAt?: string;
}
export type BankSettingsInput = Pick<BankSettings, 'enabled' | 'bankId' | 'corporateId' | 'psuId' | 'debtorAccountId' | 'bookkeepingEnabled' | 'spirisCompanyId' | 'spirisBankAccountId'>;
export interface BankConsent {
  id: string; status: string; bankId?: string; scaStatus?: string; authorisationUrl?: string | null;
  error?: { code?: string; message: string } | null;
  canReauthorise?: boolean;
  authorisationDiagnostics?: BankAuthorisationDiagnostics;
}
export interface BankAuthorisationDiagnostics {
  stage: string; checkedAt?: string; ok: boolean; httpStatus?: number | null;
  errorCode?: string | null; providerCodes?: string[]; journal?: BankJournal[];
}
export interface BankAccount {
  id: string; name?: string; currency?: string; iban?: string; bban?: string; clearingNumber?: string; accountNumber?: string;
}
export interface BankJournal {
  at?: string; name?: string; operation?: string; text?: string;
  request?: { method?: 'GET' | 'POST'; path?: string; payload?: Record<string, unknown> };
  response?: { httpStatus?: number | null; data?: unknown } | unknown;
  httpStatus?: number | null; statusCode?: number | null; method?: 'GET' | 'POST'; path?: string; data?: unknown; requestId?: string;
}
export interface BankConnectionResult {
  ok: boolean; checkedAt?: string; journal?: BankJournal[] | BankJournal; message?: string; bankCount?: number;
  error?: { code?: string; message: string } | null;
}
export interface BankIntegrationState {
  settings: BankSettings; configuration: BankProviderConfiguration; mode: 'sandbox'; simulation: true;
  consent?: BankConsent | null; accounts: BankAccount[]; lastTest?: BankConnectionResult | null;
}
export interface BankDefinition { id: string; name: string; countryCode?: string; paymentProducts?: string[] }
export interface BankList { banks: BankDefinition[]; configuration?: BankProviderConfiguration; simulation: true }
export interface BankAccountsResult { consent?: BankConsent | null; accounts: BankAccount[]; simulation: true }
export interface BankBalancesResult { accountId: string; data: unknown; journal?: BankJournal[] | BankJournal; simulation: true; ok?: boolean; error?: { code?: string; message: string } | null }
export interface BankBookkeepingChoices {
  companyId: string; companyName?: string;
  bankAccounts: { id: string; name: string; ledgerAccountNumber?: number; active?: boolean; currency?: string; type?: string | number }[];
}

/** Company credentials and tokens never enter this browser API projection. */
export const mayManageBank = (user: OfficeUser, actualUser: OfficeUser) =>
  [user, actualUser].every(person => !person.siteIds && can(person, 'integrationsRead') && can(person, 'integrationsManage'));

export const bankAccountLabel = (account: BankAccount) => [account.name || 'Bankkonto', account.currency, account.iban || account.bban || [account.clearingNumber, account.accountNumber].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
export const bankConsentLabel = (consent?: BankConsent | null) => !consent ? 'Banken är inte ansluten'
  : consent.status === 'valid' ? 'Bankens medgivande är klart'
    : ['rejected', 'revokedByPsu', 'expired', 'terminatedByTpp', 'failed'].includes(consent.status) ? 'Bankens medgivande behöver förnyas' : consent.status === 'unknown' ? 'Bankmedgivandets status behöver kontrolleras' : 'Inväntar godkännande hos banken';
export const bankConsentActionLabel = (consent?: BankConsent | null) => consent?.canReauthorise ? 'Prova bankgodkännandet igen'
  : consent && consent.status !== 'valid' && (consent.authorisationDiagnostics && !consent.authorisationDiagnostics.ok
    || ['bank_authorisation_activation_failed', 'bank_authorisation_activation_unknown'].includes(consent.error?.code ?? '')) ? 'Kontrollera och försök igen'
    : consent ? 'Förnya bankmedgivande' : 'Anslut testbanken';

// Bound reference reads and connection diagnostics. A timed-out bank payment or
// consent write must instead be reconciled by its durable server workflow.
async function bankRead<T>(path: string, signal?: AbortSignal, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 35_000);
  try { return await environmentRequest<T>(path, method, body, controller.signal); }
  catch (failure) {
    if (controller.signal.aborted && !signal?.aborted) throw new EnvironmentApiError('Hämtningen från banktjänsten tog för lång tid. Försök igen; tidigare uppgifter har behållits.', 'bank_integration_timeout', 408);
    throw failure;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export const bankIntegrationApi = {
  settings: (signal?: AbortSignal) => bankRead<BankIntegrationState>('/bank/settings', signal),
  saveSettings: (value: BankSettingsInput, signal?: AbortSignal) => environmentRequest<BankIntegrationState>('/bank/settings', 'POST', value, signal),
  banks: (signal?: AbortSignal) => bankRead<BankList>('/bank/banks', signal),
  choices: (signal?: AbortSignal) => bankRead<BankBookkeepingChoices>('/bank/choices', signal),
  test: (signal?: AbortSignal) => bankRead<BankConnectionResult>('/bank/test', signal, 'POST', {}),
  consent: (signal?: AbortSignal) => environmentRequest<BankConsent>('/bank/consent', 'POST', {}, signal),
  accounts: (signal?: AbortSignal) => bankRead<BankAccountsResult>('/bank/accounts', signal),
  balances: (signal?: AbortSignal) => bankRead<BankBalancesResult>('/bank/balances', signal),
};

export const bankJournalEntries = (value?: BankJournal[] | BankJournal) => !value ? [] : Array.isArray(value) ? value : [value];
export function bankDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(bankDiagnosticValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:token|secret|authorization|certificate|password|private.?key)/i.test(key) ? '[borttaget]' : bankDiagnosticValue(item)]));
  return value;
}
