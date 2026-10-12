import type { LogisticsOfficeCommand, LogisticsOfficeState } from './types';
import { notifyBusinessChange } from '../../shared-data';
import { invalidateOfficeReads, sharedOfficeRead } from '../shared-read';

export type LogisticsSummary = { workOrders: number; revision?: number };

export async function logisticsSummaryRequest(actorId: string, userId: string, siteId: string, signal?: AbortSignal, permissionScope = ''): Promise<LogisticsSummary> {
  const query = siteId === 'all' ? '' : `?siteId=${encodeURIComponent(siteId)}`;
  return sharedOfficeRead(`logistics:${actorId}/${userId}:${permissionScope}:summary:${siteId}`, async readSignal => {
    const response = await fetch(`/api/logistics/summary${query}`, {
      credentials: 'same-origin', cache: 'no-store', signal: readSignal,
      headers: { 'X-Demo-Actor': actorId, 'X-Demo-User': userId },
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error ?? 'Arbetsordrarnas antal kunde inte hämtas.');
    return value;
  }, signal);
}

export async function logisticsRequest(actorId: string, userId: string, command?: LogisticsOfficeCommand, signal?: AbortSignal): Promise<LogisticsOfficeState> {
  if (command) invalidateOfficeReads(`logistics:${actorId}/${userId}:`);
  const response = await fetch('/api/logistics/office', {
    method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'X-Demo-Actor': actorId, 'X-Demo-User': userId, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'Arbetsordrarna kunde inte hämtas. Försök igen.');
  if (command) {
    invalidateOfficeReads(`logistics:${actorId}/${userId}:`);
    notifyBusinessChange({ identity: `${actorId}/${userId}`, domain: 'application' });
  }
  return value;
}
