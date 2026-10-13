import { currentPlatformSession, platformRequestHeaders } from '../../platform/session';
import type { OfficeUser } from '../model';
import type { EquipmentCommand, EquipmentResponse } from './equipment-types';

export class EquipmentApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export function equipmentScope(actualUser: OfficeUser, user: OfficeUser) {
  const platform = currentPlatformSession();
  const userScope = (person: OfficeUser) => [person.id, person.level, [...person.permissions].sort(), person.siteIds ? [...person.siteIds].sort() : null];
  return JSON.stringify([platform?.authenticated ? [platform.organisationId, platform.generation] : 'legacy', userScope(actualUser), userScope(user)]);
}
async function request(actualUserId: string, userId: string, command?: EquipmentCommand, signal?: AbortSignal): Promise<EquipmentResponse> {
  // Capture both principals and the initiating company before asynchronous work.
  const headers = { Accept: 'application/json', ...platformRequestHeaders(), 'X-Demo-Actor': actualUserId, 'X-Demo-User': userId,
    ...(command ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch('/api/application/equipment', { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers, signal, ...(command ? { body: JSON.stringify(command) } : {}) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new EquipmentApiError(result.error ?? result.message ?? 'Utrustningsregistret kunde inte nås.', result.code ?? 'equipment_request_failed', response.status);
  return result as EquipmentResponse;
}
export const equipmentApi = {
  read: (actualUserId: string, userId: string, signal?: AbortSignal) => request(actualUserId, userId, undefined, signal),
  command: (command: EquipmentCommand, actualUserId: string, userId: string, signal?: AbortSignal) => request(actualUserId, userId, command, signal),
};
