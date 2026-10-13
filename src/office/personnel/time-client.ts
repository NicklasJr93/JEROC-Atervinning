import { currentPlatformSession, platformRequestHeaders } from '../../platform/session';
import type { OfficeUser } from '../model';
import type { PersonnelTimeCommand, PersonnelTimeOverview } from './time-types';

export interface PersonnelTimeScope { key: string; headers: Readonly<Record<string, string>> }
export interface PersonnelTimeSelection { personId: string; date: string; month: string }

export const mayReadPersonnelTime = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person =>
  person.level === 'Systemadmin' || person.permissions.includes('employmentRead') || person.permissions.includes('employmentWrite'));
export const mayWritePersonnelTime = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person =>
  person.level === 'Systemadmin' || person.permissions.includes('employmentWrite'));

export function personnelTimeScope(user: OfficeUser, actualUser: OfficeUser): PersonnelTimeScope {
  const platform = currentPlatformSession();
  const identity = (person: OfficeUser) => [person.id, person.level, [...person.permissions].sort(), person.siteIds ? [...person.siteIds].sort() : 'all'];
  return {
    key: JSON.stringify([platform?.authenticated ? [platform.organisationId, platform.generation] : 'legacy', identity(actualUser), identity(user)]),
    headers: Object.freeze({ ...platformRequestHeaders(), 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }),
  };
}

export class PersonnelTimeError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function request(scope: PersonnelTimeScope, selected: PersonnelTimeSelection, command?: PersonnelTimeCommand, signal?: AbortSignal) {
  const query = new URLSearchParams({ personId: selected.personId, date: selected.date, month: selected.month });
  const response = await fetch(`/api/application/personnel-time?${query}`, {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...scope.headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PersonnelTimeError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Tidrapporten kunde inte hämtas.', response.status, result.code);
  return result as PersonnelTimeOverview;
}

export const readPersonnelTime = (scope: PersonnelTimeScope, selected: PersonnelTimeSelection, signal?: AbortSignal) => request(scope, selected, undefined, signal);
export const updatePersonnelTime = (scope: PersonnelTimeScope, selected: PersonnelTimeSelection, command: PersonnelTimeCommand, signal?: AbortSignal) => request(scope, selected, command, signal);
