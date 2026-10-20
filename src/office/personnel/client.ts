import type { PersonnelCommand, PersonnelResponse } from './types';
import type { OfficeUser } from '../model';
import { currentPlatformSession, platformRequestHeaders } from '../../platform/session';

const platformKey = () => { const session = currentPlatformSession(); return JSON.stringify(session?.authenticated ? [session.organisationId, session.generation] : 'legacy'); };
export interface PersonnelClientScope { key: string; platformKey: string; headers: Readonly<Record<string, string>> }
export function personnelClientScope(user: OfficeUser, actualUser: OfficeUser): PersonnelClientScope {
  const identity = (person: OfficeUser) => [person.id, person.level, person.active !== false, [...person.permissions].sort(), person.siteIds ? [...person.siteIds].sort() : 'all', person.maxAttest, person.ownAttest];
  const platform = platformKey();
  return { key: JSON.stringify([platform, identity(actualUser), identity(user)]), platformKey: platform,
    headers: Object.freeze({ ...platformRequestHeaders(), 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }) };
}
export class PersonnelApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export interface PersonnelRequestOptions { scope?: PersonnelClientScope; signal?: AbortSignal }
async function request(actorId: string, userId: string, command?: PersonnelCommand, planning = false, options?: PersonnelRequestOptions): Promise<PersonnelResponse> {
  const capturedPlatform = options?.scope?.platformKey ?? platformKey();
  const headers = options?.scope?.headers ?? Object.freeze({ ...platformRequestHeaders(), 'X-Demo-Actor': actorId, 'X-Demo-User': userId });
  const controller = new AbortController(), abort = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Personalregistret svarade inte i tid. Uppdatera för att kontrollera vad som sparats.', 'TimeoutError')), 35000);
  try {
    const response = await fetch(`/api/application/personnel${planning ? '?view=planning' : ''}`, { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...headers, ...(command ? {'Content-Type':'application/json'} : {}) }, ...(command ? {body: JSON.stringify(command)} : {}) });
    const result = await response.json().catch(() => { if (controller.signal.aborted) throw controller.signal.reason; if (response.ok) throw new PersonnelApiError('Personalregistret gav ett ofullständigt svar. Försök igen.', 502); return {}; });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (capturedPlatform !== platformKey()) throw new PersonnelApiError('Inloggningen eller företaget har ändrats. Hämta aktuella uppgifter.', 409, 'PRINCIPAL_CHANGED');
    if (!response.ok) throw new PersonnelApiError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Personalregistret kunde inte nås.', response.status, result.code);
    if (!Array.isArray(result.data?.people) || !Array.isArray(result.capabilities) || !Array.isArray(result.sites)) throw new PersonnelApiError('Personalregistret gav ett ofullständigt svar. Försök igen.', 502);
    return result;
  } finally { window.clearTimeout(timeout); options?.signal?.removeEventListener('abort', abort); }
}
export const readPersonnel = (actorId: string, userId = actorId, options?: PersonnelRequestOptions) => request(actorId, userId, undefined, false, options);
export const readPersonnelAvailability = (actorId: string, userId = actorId, options?: PersonnelRequestOptions) => request(actorId, userId, undefined, true, options);
export const updatePersonnel = (command: PersonnelCommand, actorId: string, userId = actorId, options?: PersonnelRequestOptions) => request(actorId, userId, command, false, options);
