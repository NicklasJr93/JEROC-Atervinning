import { currentPlatformSession, platformRequestHeaders } from '../../platform/session';
import { z } from 'zod';
import { can, type OfficeUser } from '../model';
import type { PersonnelPresenceResponse } from './presence-types';

export interface PersonnelPresenceScope { key: string; headers: Readonly<Record<string, string>> }

export const mayReadPersonnelPresence = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person =>
  person.active !== false && can(person, 'personnelRead') && (person.level === 'Systemadmin' || person.permissions.includes('personnelPresenceRead')));

export function personnelPresenceScope(user: OfficeUser, actualUser: OfficeUser): PersonnelPresenceScope {
  const platform = currentPlatformSession();
  const identity = (person: OfficeUser) => [person.id, person.level, person.active !== false, [...person.permissions].sort(), person.siteIds ? [...person.siteIds].sort() : 'all'];
  return {
    key: JSON.stringify([platform?.authenticated ? [platform.organisationId, platform.generation] : 'legacy', identity(actualUser), identity(user)]),
    headers: Object.freeze({ ...platformRequestHeaders(), 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }),
  };
}

export class PersonnelPresenceError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const seconds = z.number().finite().nonnegative();
const presenceResponseSchema = z.object({
  serverNow: z.string().refine(value => Number.isFinite(Date.parse(value))), revision: z.number().int().nonnegative(),
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
  summary: z.object({ total: seconds, clockedIn: seconds, working: seconds, onBreak: seconds, clockedOut: seconds, clockDisabled: seconds, needsReview: seconds, available: seconds }),
  people: z.array(z.object({
    personId: z.string(), name: z.string(), team: z.string(), siteIds: z.array(z.string()), timeSource: z.enum(['workorder', 'clock']),
    clockEnabled: z.boolean(), clockStatus: z.enum(['working', 'break', 'out', 'off', 'disabled']), isClockedIn: z.boolean(), isOnBreak: z.boolean(), isWorkingNow: z.boolean(),
    workStateSource: z.enum(['clock', 'order', 'unknown']), clockSessionId: z.string().nullable(), clockedInAt: z.string().nullable(), breakStartedAt: z.string().nullable(),
    clockSiteId: z.string().optional(), workSeconds: seconds, breakSeconds: seconds, lastClockEventAt: z.string().nullable(), statusSince: z.string().nullable(), isRunning: z.boolean(),
    requiresCorrection: z.boolean(), hasActiveOrder: z.boolean(), activeOrderId: z.string().optional(),
    isScheduledNow: z.boolean().nullable(), isAbsentNow: z.boolean(), isEmploymentActive: z.boolean(),
    availabilityStatus: z.enum(['available', 'on_break', 'busy', 'absent', 'not_clocked_in', 'unknown', 'needs_review']), isAvailableNow: z.boolean().nullable(), reasonCodes: z.array(z.string()),
  })),
});

export async function readPersonnelPresence(scope: PersonnelPresenceScope, siteId = 'all', signal?: AbortSignal): Promise<PersonnelPresenceResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Närvaroöversikten svarade inte i tid.', 'TimeoutError')), 35000);
  try {
    const query = siteId && siteId !== 'all' ? `?${new URLSearchParams({ siteId })}` : '';
    const response = await fetch(`/api/application/personnel-presence${query}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers },
    });
    const result = await response.json().catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.ok) throw new PersonnelPresenceError('Närvaroöversikten gav ett ofullständigt svar. Försök uppdatera igen.', 502, 'invalid_response');
      return {};
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new PersonnelPresenceError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Närvaroöversikten kunde inte hämtas.', response.status, result.code);
    const parsed = presenceResponseSchema.safeParse(result);
    if (!parsed.success) throw new PersonnelPresenceError('Närvaroöversikten gav ett ofullständigt svar. Försök uppdatera igen.', 502, 'invalid_response');
    return parsed.data;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
