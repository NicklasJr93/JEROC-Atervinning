import { z } from 'zod';
import { currentPlatformSession } from './session';
import type { AuthenticatedPlatformSession, PlatformSession } from './types';

const count = z.number().int().nonnegative().safe();
const totalsSchema = z.object({ providerCalls: count, billableCount: count, reviewCount: count, reservedCount: count,
  notDispatchedCount: count, success: count, notFound: count, rejected: count, failed: count, unknown: count,
  costMinor: count, salesMinor: count, reviewSalesMinor: count });
const serviceSchema = totalsSchema.extend({ service: z.string().min(1).max(120), channel: z.string().min(1).max(120),
  unitCostMinor: count, unitSalesMinor: count });
export const platformUsageSchema = z.object({ month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/), currency: z.literal('SEK'),
  pricing: z.object({ roaringLookupSalesMinor: count, roaringLookupCostMinor: count, pricesExcludeVat: z.literal(true) }),
  companies: z.array(z.object({ companyId: z.string().min(1), companyName: z.string().min(1), services: z.array(serviceSchema), totals: totalsSchema })),
  totals: totalsSchema, availableCompanies: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })) });
export type PlatformUsageData = z.infer<typeof platformUsageSchema>;
export type PlatformUsageService = z.infer<typeof serviceSchema>;
export type PlatformUsageFilter = { month: string; companyId: string };

export class PlatformUsageError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message); }
}

export function platformUsageScopeKey(session: PlatformSession | undefined = currentPlatformSession()) {
  return JSON.stringify(session?.authenticated ? [session.actor.id, session.actor.platformAdmin, session.actualUser.id,
    session.user.id, session.generation, session.organisationId, session.isSupportSession, session.mustChangePassword] : 'signed-out');
}
export function platformUsageScope(session: AuthenticatedPlatformSession) {
  return { key: platformUsageScopeKey(session), allowed: session.actor.platformAdmin && !session.isSupportSession && !session.mustChangePassword,
    headers: Object.freeze({ 'X-Platform-CSRF': session.csrfToken, 'X-Platform-Generation': String(session.generation),
      ...(session.organisationId ? { 'X-Platform-Organisation-Id': session.organisationId } : {}) }) };
}
export type PlatformUsageScope = ReturnType<typeof platformUsageScope>;

export function stockholmUsageMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit' }).formatToParts(now);
  return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`;
}
const filterQuery = ({ month, companyId }: PlatformUsageFilter) => {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new PlatformUsageError('Välj en giltig månad.', 422);
  return new URLSearchParams({ month, ...(companyId ? { companyId } : {}) }).toString();
};
function demandCurrent(scope: PlatformUsageScope) {
  if (!scope.allowed) throw new PlatformUsageError('Förbrukningsunderlaget kräver ditt eget systemadminkonto.', 403);
  if (scope.key !== platformUsageScopeKey()) throw new PlatformUsageError('Din session har ändrats. Öppna systemadministrationen igen.', 409, 'platform_context_changed');
}
async function fetchUsage(scope: PlatformUsageScope, filters: PlatformUsageFilter, csv: boolean, signal: AbortSignal) {
  demandCurrent(scope);
  const response = await fetch(`/api/platform/usage${csv ? '/export' : ''}?${filterQuery(filters)}`, {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { ...scope.headers, Accept: csv ? 'text/csv' : 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  demandCurrent(scope);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new PlatformUsageError(typeof body?.error === 'string' ? body.error : 'Förbrukningsunderlaget kunde inte hämtas.', response.status,
      typeof body?.code === 'string' ? body.code : undefined);
  }
  return response;
}
export async function readPlatformUsage(scope: PlatformUsageScope, filters: PlatformUsageFilter, signal: AbortSignal) {
  const response = await fetchUsage(scope, filters, false, signal);
  const parsed = platformUsageSchema.safeParse(await response.json());
  demandCurrent(scope); signal.throwIfAborted();
  if (!parsed.success || parsed.data.month !== filters.month || filters.companyId && parsed.data.companies.some(company => company.companyId !== filters.companyId))
    throw new PlatformUsageError('Förbrukningsunderlaget gav ett ofullständigt svar. Uppdatera och försök igen.', 502, 'platform_usage_response_invalid');
  return parsed.data;
}
export async function exportPlatformUsage(scope: PlatformUsageScope, filters: PlatformUsageFilter, signal: AbortSignal) {
  const response = await fetchUsage(scope, filters, true, signal);
  if (!/^text\/csv(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
    throw new PlatformUsageError('CSV-underlaget kunde inte verifieras. Uppdatera och försök igen.', 502);
  const blob = await response.blob(); demandCurrent(scope); signal.throwIfAborted();
  if (!blob.size) throw new PlatformUsageError('CSV-underlaget var tomt. Uppdatera och försök igen.', 502);
  return blob;
}
