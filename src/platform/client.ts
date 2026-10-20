import { platformRequestHeaders } from './session';
import type { AuthenticatedPlatformSession, CompanyCreated, PlatformCompany, PlatformCompanyUser, PlatformProfile, PlatformSession, PlatformCommunicationsConfig, PlatformTestEmailResult, PlatformTestSmsResult } from './types';

export class PlatformRequestError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message); this.name = 'PlatformRequestError';
  }
}

const recoverySignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
async function recoveryRequest(path: string, data: unknown, signal?: AbortSignal): Promise<{ ok: true }> {
  const result = await request<{ ok?: unknown }>(path, data, recoverySignal(signal));
  if (result?.ok !== true) throw new PlatformRequestError('Åtgärdens resultat kunde inte bekräftas. Försök igen.', 'platform_response_invalid', 502);
  return { ok: true };
}

async function profileRequest(data?: { expectedVersion: number; email: string; currentPassword: string }, signal?: AbortSignal): Promise<PlatformProfile> {
  const result = await request<Partial<PlatformProfile>>('profile', data, recoverySignal(signal));
  if (!result || typeof result.id !== 'string' || !result.id || result.id.length > 100
    || typeof result.name !== 'string' || result.name.length > 200
    || typeof result.username !== 'string' || !result.username || result.username.length > 254
    || typeof result.email !== 'string' || result.email.length > 254 || /[\u0000-\u001f\u007f]/.test(result.email)
    || !Number.isInteger(result.version) || Number(result.version) < 0)
    throw new PlatformRequestError('Profilen gav ett ofullständigt svar. Försök igen.', 'platform_response_invalid', 502);
  return { id: result.id, name: result.name, username: result.username, email: result.email, version: Number(result.version) };
}

async function request<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/platform/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', signal,
    headers: { ...(['session', 'login', 'staff-invitations/confirm'].includes(path) || path.startsWith('password-reset/') ? {} : platformRequestHeaders()), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
  profile: (signal?: AbortSignal) => profileRequest(undefined, signal),
  updateProfile: (data: { expectedVersion: number; email: string; currentPassword: string }, signal?: AbortSignal) => profileRequest(data, signal),
  requestPasswordReset: (email: string, signal?: AbortSignal, username?: string) => recoveryRequest('password-reset/request', { email, ...(username?.trim() ? { username: username.trim() } : {}) }, signal),
  confirmPasswordReset: (data: { token: string; newPassword: string; confirmPassword: string }, signal?: AbortSignal) => recoveryRequest('password-reset/confirm', data, signal),
  confirmStaffInvitation: (data: { token: string; newPassword: string; confirmPassword: string }, signal?: AbortSignal) => recoveryRequest('staff-invitations/confirm', data, signal),
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
