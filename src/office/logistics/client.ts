import type { LogisticsOfficeCommand, LogisticsOfficeState } from './types';

export async function logisticsRequest(actorId: string, userId: string, command?: LogisticsOfficeCommand, signal?: AbortSignal): Promise<LogisticsOfficeState> {
  const response = await fetch('/api/logistics/office', {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'X-Demo-Actor': actorId, 'X-Demo-User': userId, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Arbetsordrarna kunde inte hämtas. Försök igen.');
  return value;
}
