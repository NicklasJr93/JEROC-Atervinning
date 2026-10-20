import { platformRequestHeaders } from './session';
import type { AuthenticatedPlatformSession, CompanyCreated, PlatformCompany, PlatformCompanyUser, PlatformSession, PlatformCommunicationsConfig, PlatformTestEmailResult, PlatformTestSmsResult } from './types';

export class PlatformRequestError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message); this.name = 'PlatformRequestError';
  }
}

async function request<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/platform/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: { ...(['session', 'login'].includes(path) ? {} : platformRequestHeaders()), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message;
    throw new PlatformRequestError(typeof message === 'string' ? message : 'Åtgärden kunde inte slutföras. Försök igen.',
      typeof body?.code === 'string' ? body.code : undefined, response.status);
  }
  return body as T;
}

export const platformApi = {
  session: (signal?: AbortSignal) => request<PlatformSession>('session', undefined, signal),
  login: (username: string, password: string) => request<AuthenticatedPlatformSession>('login', { username: username.trim(), password }),
  changePassword: (currentPassword: string, newPassword: string) => request<AuthenticatedPlatformSession>('change-password', { currentPassword, newPassword }),
  logout: () => request<{ ok: boolean }>('logout', {}),
  openAdministration: () => request<AuthenticatedPlatformSession>('open-administration', {}),
  companies: (signal?: AbortSignal) => request<{ companies: PlatformCompany[] }>('companies', undefined, signal),
  companyUsers: (id: string, signal?: AbortSignal) => request<{ users: PlatformCompanyUser[] }>(`companies/${encodeURIComponent(id)}/users`, undefined, signal),
  createCompany: (data: { requestId: string; name: string; organisationNumber: string; vdName: string; vdEmail: string }) => request<CompanyCreated>('companies', data),
  resetInitialPassword: (id: string, requestId: string) => request<CompanyCreated>(`companies/${encodeURIComponent(id)}/reset-initial-password`, { requestId }),
  communications: (signal?: AbortSignal) => request<PlatformCommunicationsConfig>('communications', undefined, signal),
  sendTestEmail: (data: { requestId: string; to: string }, signal?: AbortSignal) => request<PlatformTestEmailResult>('communications/test-email', data, signal),
  sendTestSms: (data: { requestId: string; to: string }, signal?: AbortSignal) => request<PlatformTestSmsResult>('communications/test-sms', data, signal),
  reviewTestSms: (data: { requestId: string; to: string }, signal?: AbortSignal) => request<{ reviewed: true }>('communications/review-sms', data, signal),
  switchCompany: (organisationId: string, effectiveUserId?: string) => request<AuthenticatedPlatformSession>('switch', {
    organisationId, ...(effectiveUserId ? { effectiveUserId } : {}),
  }),
};
