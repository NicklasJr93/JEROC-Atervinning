import type { PersonnelCommand, PersonnelResponse } from './types';
async function request(actorId: string, userId: string, command?: PersonnelCommand, planning = false): Promise<PersonnelResponse> {
  const response = await fetch(`/api/application/personnel${planning ? '?view=planning' : ''}`, { method: command ? 'POST' : 'GET', headers: {'X-Demo-Actor': actorId, 'X-Demo-User': userId, ...(command ? {'Content-Type':'application/json'} : {})}, ...(command ? {body: JSON.stringify(command)} : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Personalregistret kunde inte nås.');
  return result;
}
export const readPersonnel = (actorId: string, userId = actorId) => request(actorId, userId);
export const readPersonnelAvailability = (actorId: string, userId = actorId) => request(actorId, userId, undefined, true);
export const updatePersonnel = (command: PersonnelCommand, actorId: string, userId = actorId) => request(actorId, userId, command);
