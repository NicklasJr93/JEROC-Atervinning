import type { PersonnelClientScope } from './client';
import { currentPlatformSession } from '../../platform/session';

export type StaffInvitationStatus = {
  personId: string;
  status: 'not_invited' | 'sent' | 'active' | 'failed' | 'expired' | 'temporary_password';
  email: string;
  expiresAt?: string;
};
export type StaffInvitationSent = StaffInvitationStatus & { ok: true; status: 'sent'; expiresAt: string };
export type StaffTemporaryPassword = StaffInvitationStatus & { ok: true; status: 'temporary_password'; username: string };
export type StaffProvisionResult = StaffInvitationSent | StaffTemporaryPassword;
export type StaffProvisionMethod = { method: 'email' } | { method: 'temporary'; password: string };

export class StaffInvitationError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}
const platformKey = () => {
  const session = currentPlatformSession();
  return JSON.stringify(session?.authenticated ? [session.organisationId, session.generation] : 'legacy');
};
const assertScope = (scope: PersonnelClientScope) => {
  if (scope.platformKey !== platformKey() || !currentPlatformSession()?.authenticated)
    throw new StaffInvitationError('Bolaget eller inloggningen har ändrats. Öppna personkortet igen.', 409, 'platform_context_changed');
};

async function request(personId: string, scope: PersonnelClientScope, signal?: AbortSignal, command?: { requestId: string; password?: string }): Promise<StaffInvitationStatus | StaffProvisionResult> {
  assertScope(scope);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Inbjudan kunde inte bekräftas. Kontrollera status eller försök igen.', 'TimeoutError')), 20_000);
  try {
    const response = await fetch(`/api/platform/staff-invitations${command?.password !== undefined ? '/temporary-password' : command ? '' : `?personId=${encodeURIComponent(personId)}`}`, {
      method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify({ personId, ...command }) } : {}),
    });
    const result = await response.json().catch(() => undefined);
    if (controller.signal.aborted) throw controller.signal.reason;
    assertScope(scope);
    if (!response.ok) throw new StaffInvitationError(typeof result?.error === 'string' ? result.error : 'Inbjudan kunde inte skickas. Försök igen.', response.status, result?.code);
    if (!result || result.personId !== personId || typeof result.email !== 'string'
      || !['not_invited', 'sent', 'active', 'failed', 'expired', 'temporary_password'].includes(result.status)
      || result.expiresAt !== undefined && (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt)))
      || command && (result.ok !== true || (command.password === undefined ? result.status !== 'sent' || !result.expiresAt
        : result.status !== 'temporary_password' || typeof result.username !== 'string' || !result.username)))
      throw new StaffInvitationError('Inbjudans status kunde inte bekräftas. Uppdatera personkortet.', 502, 'staff_invitation_response_invalid');
    return result;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export const readStaffInvitation = (personId: string, scope: PersonnelClientScope, signal?: AbortSignal) => request(personId, scope, signal) as Promise<StaffInvitationStatus>;
export const sendStaffInvitation = (personId: string, requestId: string, scope: PersonnelClientScope, signal?: AbortSignal) => request(personId, scope, signal, { requestId }) as Promise<StaffInvitationSent>;
export const setStaffTemporaryPassword = (personId: string, requestId: string, password: string, scope: PersonnelClientScope, signal?: AbortSignal) => request(personId, scope, signal, { requestId, password }) as Promise<StaffTemporaryPassword>;
