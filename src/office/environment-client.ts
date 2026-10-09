import type { EnvironmentalReceipt, EnvironmentalReceiptInput, EnvironmentSessionState, EnvironmentState, WasteClassification } from './environment-types';

let csrfToken = '';
export class EnvironmentApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function environmentRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/environment${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(method !== 'GET' && csrfToken ? { 'X-Environment-CSRF': csrfToken } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string; csrfToken?: string };
  if (!response.ok) throw new EnvironmentApiError(result.message ?? result.error ?? 'Miljötjänsten kunde inte nås.', result.code ?? 'request_failed', response.status);
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result as T;
}
export const environmentApi = {
  login: (userId: string, password: string, effectiveUserId: string) => environmentRequest<EnvironmentSessionState>('/login', 'POST', { userId, password, effectiveUserId }),
  session: (signal?: AbortSignal) => environmentRequest<EnvironmentSessionState>('/session', 'GET', undefined, signal),
  logout: async () => { await environmentRequest('/logout', 'POST', {}); csrfToken = ''; },
  forgetSession: () => { csrfToken = ''; },
  state: (signal?: AbortSignal, siteId?: string) => environmentRequest<EnvironmentState>(`/state${siteId && siteId !== 'all' ? `?siteId=${encodeURIComponent(siteId)}` : ''}`, 'GET', undefined, signal),
  classify: (articleId: string, value: Omit<WasteClassification, 'articleId' | 'version' | 'updatedAt' | 'updatedBy'> & { expectedVersion: number }) => environmentRequest<WasteClassification>(`/classifications/${encodeURIComponent(articleId)}`, 'PUT', value),
  receive: (value: EnvironmentalReceiptInput) => environmentRequest<EnvironmentalReceipt>('/receipts', 'POST', value),
};
