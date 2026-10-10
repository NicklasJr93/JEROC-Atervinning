import type {
  EnvironmentalAddressResult, EnvironmentalCorrectionInput, EnvironmentalDraft,
  EnvironmentalDraftInput, EnvironmentalReceipt, EnvironmentalReceiptInput,
  EnvironmentSessionState, EnvironmentState, WasteClassification,
  EnvironmentSite, EnvironmentSiteInput, EnvironmentalStorageAssessment, EnvironmentalStoragePolicy, EnvironmentalStoragePolicyInput,
  NvvIntegrationStatus, NvvReporterInput, NvvReportDetail,
  NvvSandboxState, NvvSandboxRequest, NvvSandboxRun,
  EnvironmentalSourceProjection,
} from './environment-types';

let csrfToken = '';
let sessionIdentity: { actualUserId: string; effectiveUserId: string } | undefined;
export class EnvironmentApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function environmentRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/environment${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method !== 'GET' && csrfToken ? { 'X-Environment-CSRF': csrfToken } : {}),
      ...(!['/session', '/login', '/demo-session'].includes(path) && sessionIdentity ? {
        'X-Environment-Actual-User': sessionIdentity.actualUserId,
        'X-Environment-Effective-User': sessionIdentity.effectiveUserId,
      } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string; csrfToken?: string };
  if (!response.ok) throw new EnvironmentApiError(result.message ?? result.error ?? 'Miljötjänsten kunde inte nås.', result.code ?? 'request_failed', response.status);
  return result as T;
}
export const environmentApi = {
  login: (userId: string, password: string, effectiveUserId: string) => environmentRequest<EnvironmentSessionState>('/login', 'POST', { userId, password, effectiveUserId }),
  demoSession: (userId: string, effectiveUserId: string) => environmentRequest<EnvironmentSessionState>('/demo-session', 'POST', { userId, effectiveUserId }),
  session: (signal?: AbortSignal) => environmentRequest<EnvironmentSessionState>('/session', 'GET', undefined, signal),
  adoptSession: (session: EnvironmentSessionState) => { csrfToken = session.csrfToken; sessionIdentity = { actualUserId: session.actualUserId, effectiveUserId: session.effectiveUserId }; },
  logout: async () => { await environmentRequest('/logout', 'POST', {}); csrfToken = ''; sessionIdentity = undefined; },
  forgetSession: () => { csrfToken = ''; sessionIdentity = undefined; },
  state: (signal?: AbortSignal, siteId?: string) => environmentRequest<EnvironmentState>(`/state${siteId && siteId !== 'all' ? `?siteId=${encodeURIComponent(siteId)}` : ''}`, 'GET', undefined, signal),
  source: (sourceId: string, signal?: AbortSignal) => environmentRequest<EnvironmentalSourceProjection>(`/sources/${encodeURIComponent(sourceId)}`, 'GET', undefined, signal),
  classify: (articleId: string, value: Omit<WasteClassification, 'articleId' | 'version' | 'updatedAt' | 'updatedBy'> & { expectedVersion: number }) => environmentRequest<WasteClassification>(`/classifications/${encodeURIComponent(articleId)}`, 'PUT', value),
  receive: (value: EnvironmentalReceiptInput) => environmentRequest<EnvironmentalReceipt>('/receipts', 'POST', value),
  draft: (sourceId: string, signal?: AbortSignal) => environmentRequest<EnvironmentalDraft | null>(`/drafts/${encodeURIComponent(sourceId)}`, 'GET', undefined, signal),
  saveDraft: (sourceId: string, value: { expectedVersion: number; input: EnvironmentalDraftInput }) => environmentRequest<EnvironmentalDraft>(`/drafts/${encodeURIComponent(sourceId)}`, 'PUT', value),
  resolveAddress: (value: { siteId: string; originAddress: string; municipalityCode?: string; municipalityName?: string }, signal?: AbortSignal) => environmentRequest<EnvironmentalAddressResult>('/address/resolve', 'POST', value, signal),
  correct: (receiptId: string, value: EnvironmentalCorrectionInput) => environmentRequest<EnvironmentalReceipt>(`/receipts/${encodeURIComponent(receiptId)}/corrections`, 'POST', value),
  saveSite: (siteId: string, value: EnvironmentSiteInput) => environmentRequest<EnvironmentSite>(`/sites/${encodeURIComponent(siteId)}`, 'PUT', value),
  saveStoragePolicy: (siteId: string, value: EnvironmentalStoragePolicyInput) => environmentRequest<EnvironmentalStoragePolicy>(`/storage/policies/${encodeURIComponent(siteId)}`, 'PUT', value),
  checkStorage: (value: { siteId: string; rows: { articleId: string; weight: number }[]; receiptId?: string; materialScope?: 'hazardous' }, signal?: AbortSignal) => environmentRequest<EnvironmentalStorageAssessment>('/storage/check', 'POST', value, signal),
  nvvStatus: (signal?: AbortSignal) => environmentRequest<NvvIntegrationStatus>('/nvv/status', 'GET', undefined, signal),
  saveNvvReporter: (value: NvvReporterInput) => environmentRequest<NvvIntegrationStatus>('/nvv/reporter', 'PUT', value),
  checkNvvConnection: () => environmentRequest<NvvIntegrationStatus>('/nvv/check', 'POST', {}),
  nvvReport: (reportId: string, signal?: AbortSignal) => environmentRequest<NvvReportDetail>(`/nvv/reports/${encodeURIComponent(reportId)}`, 'GET', undefined, signal),
  sendNvvReport: (reportId: string, value: { receiptVersion: number; idempotencyKey: string }) => environmentRequest<NvvReportDetail>(`/nvv/reports/${encodeURIComponent(reportId)}/send`, 'POST', value),
  reconcileNvvReport: (reportId: string) => environmentRequest<NvvReportDetail>(`/nvv/reports/${encodeURIComponent(reportId)}/reconcile`, 'POST', {}),
  nvvSandbox: (signal?: AbortSignal) => environmentRequest<NvvSandboxState>('/nvv/sandbox', 'GET', undefined, signal),
  sendNvvSandbox: (value: NvvSandboxRequest, signal?: AbortSignal) => environmentRequest<NvvSandboxRun>('/nvv/sandbox', 'POST', value, signal),
  nvvSandboxRun: (runId: string, signal?: AbortSignal) => environmentRequest<NvvSandboxRun>(`/nvv/sandbox/runs/${encodeURIComponent(runId)}`, 'GET', undefined, signal),
};
