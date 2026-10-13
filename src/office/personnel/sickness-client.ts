import { can, type OfficeUser } from '../model';
import { personnelPresenceScope, type PersonnelPresenceScope } from './presence-client';
import { z } from 'zod';
import type { SicknessManagementResponse } from '../../employee/sickness-types';

export const mayReadSickness = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person =>
  person.active !== false && can(person, 'personnelRead') && can(person, 'absenceRead'));
export const sicknessScope = personnelPresenceScope;
export type SicknessScope = PersonnelPresenceScope;

export class SicknessApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const nonnegative = z.number().finite().nonnegative(), revision = nonnegative.int(), amount = nonnegative.nullable();
const forecast = z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }), z.object({ kind: z.literal('date'), date: z.string() })]);
const profile = z.object({ personId: z.string(), revision, effectiveFrom: z.string(), hourlyBase: nonnegative, averageWeeklyHours: nonnegative, sickPayRate: nonnegative, confirmed: z.boolean(), source: z.string() });
const managementResponse = z.object({
  revision, today: z.string(),
  policy: z.object({ revision, dailyContact: z.boolean(), contactByMinute: nonnegative, agreement: z.enum(['unknown', 'statutory', 'collective']), agreementName: z.string(), calculationConfirmed: z.boolean(), effectiveFrom: z.string() }),
  people: z.array(z.object({ id: z.string(), name: z.string(), siteIds: z.array(z.string()), active: z.boolean() })),
  cases: z.array(z.object({ id: z.string(), personId: z.string(), personName: z.string().optional(), revision, status: z.enum(['open', 'recovered']), fromDate: z.string(), startMinute: nonnegative.optional(),
    lastSickDate: z.string().optional(), recoveredAt: z.string().optional(), recoveryMinute: nonnegative.optional(), extent: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]), forecast,
    declared: z.boolean(), declaredAt: z.string().optional(), reportedAt: z.string(), cycleId: z.string(), relapse: z.boolean(), lastContactDate: z.string(),
    contacts: z.array(z.object({ date: z.string(), at: z.string(), extent: nonnegative })), certificate: z.object({ received: z.boolean(), fromDate: z.string().optional(), toDate: z.string().optional(),
      receivedAt: z.string().optional(), reference: z.string(), firstDayRequired: z.boolean().optional(), firstDayReason: z.string().optional() }),
    followup: z.object({ certificateRequired: z.boolean(), certificateDueDate: z.string(), insurerReportDue: z.boolean(), insurerReportDeadline: z.string(), insurerReportedAt: z.string().optional(),
      rehabilitationPlanDue: z.boolean(), rehabilitationPlanAt: z.string().optional(), contactOverdue: z.boolean(), reviewRequired: z.boolean(), messages: z.array(z.string()) }),
    timeIssue: z.boolean(), days: z.array(z.object({ date: z.string(), extent: nonnegative, startMinute: nonnegative.optional(), endMinute: nonnegative.optional(), absenceId: z.string(), scheduledMinutes: nonnegative,
      lostMinutes: nonnegative, sourceRevision: revision, timeLocked: z.boolean() })),
  })),
  events: z.array(z.object({ id: z.string(), caseId: z.string().optional(), personId: z.string().optional(), action: z.string(), at: z.string(), actualUserId: z.string(), effectiveUserId: z.string(), text: z.string(), reason: z.string().optional() })),
  profiles: z.array(profile), highRiskDecisions: z.array(z.object({ id: z.string(), personId: z.string(), fromDate: z.string(), toDate: z.string(), kind: z.enum(['frequent', 'long']), reference: z.string(), revision })),
  deductionImports: z.array(z.object({ id: z.string(), personId: z.string(), date: z.string(), source: z.string() })),
  underlay: z.object({ available: z.boolean(), generatedAt: z.string(), currency: z.literal('SEK'), calculationStatus: z.enum(['calculated', 'missing_basis', 'review_required']), messages: z.array(z.string()),
    rows: z.array(z.object({ caseId: z.string(), cycleId: z.string(), date: z.string(), employerDay: nonnegative, lostMinutes: nonnegative, salaryLoss: amount, grossSickPay: amount, karensDeduction: amount, payableSickPay: amount,
      status: z.enum(['calculated', 'missing_basis', 'outside_employer_period', 'review_required']), messages: z.array(z.string()) })),
    cycles: z.array(z.object({ id: z.string(), firstDate: z.string(), caseIds: z.array(z.string()), relapse: z.boolean(), deductionExemption: z.enum(['none', 'general_high_risk', 'special_high_risk']),
      deductionTarget: amount, deductionTaken: amount, deductionRemaining: amount, basis: profile.optional() })), totalSalaryLoss: amount, totalGrossSickPay: amount, totalDeduction: amount, totalPayableSickPay: amount,
  }).optional(), capabilities: z.array(z.string()), notificationCount: nonnegative,
});
export function validSicknessManagementResponse(value: unknown): value is SicknessManagementResponse { return managementResponse.safeParse(value).success; }

/** Capture the initiating company and both principals before asynchronous work.
 * An uncertain write is never automatically repeated; its caller reads status. */
export async function sicknessRequest<T>(scope: SicknessScope, selection: { personId?: string; siteId?: string }, command?: unknown, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams();
  if (selection.personId) query.set('personId', selection.personId);
  if (selection.siteId && selection.siteId !== 'all') query.set('siteId', selection.siteId);
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Sjukfrånvaron svarade inte i tid. Uppdatera för att kontrollera vad som sparats.', 'TimeoutError')), 35000);
  try {
    const response = await fetch(`/api/personnel/sickness${query.size ? `?${query}` : ''}`, {
      method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const result = await response.json().catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new SicknessApiError('Sjukfrånvaron gav ett ofullständigt svar. Uppdatera för att kontrollera status.', response.ok ? 502 : response.status, 'invalid_response');
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new SicknessApiError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Sjukfrånvaron kunde inte hämtas.', response.status, result.code);
    if (!result || typeof result !== 'object') throw new SicknessApiError('Sjukfrånvaron gav ett ofullständigt svar. Försök uppdatera igen.', 502, 'invalid_response');
    return result as T;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export interface SicknessFile { id: string; name: string; contentType: string; size: number; uploadedAt: string; caseId: string }

export async function sicknessFilesRequest(scope: SicknessScope, selection: { personId: string; caseId: string }, file?: File, signal?: AbortSignal): Promise<{ files: SicknessFile[] } | { file: SicknessFile }> {
  if (file && (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0))
    throw new SicknessApiError('Välj en PDF, JPG eller PNG på högst 5 MB.', 400, 'invalid_file');
  const query = new URLSearchParams(selection), controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Intygsfilen svarade inte i tid. Uppdatera fillistan innan du försöker igen.', 'TimeoutError')), 35000);
  try {
    const response = await fetch(`/api/personnel/sickness/files?${query}`, {
      method: file ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(file ? { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) } : {}) },
      ...(file ? { body: file } : {}),
    });
    const result = await response.json().catch(() => { throw new SicknessApiError('Intygsfilen gav ett ofullständigt svar. Uppdatera fillistan för att kontrollera status.', 502, 'invalid_response'); });
    if (!response.ok) throw new SicknessApiError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Intygsfilen kunde inte hanteras.', response.status, result.code);
    if (file ? !result.file?.id : !Array.isArray(result.files)) throw new SicknessApiError('Intygsfilen gav ett ofullständigt svar.', 502, 'invalid_response');
    return result;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export async function downloadSicknessFile(scope: SicknessScope, file: SicknessFile, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`/api/personnel/sickness/files/${encodeURIComponent(file.id)}`, {
    credentials: 'same-origin', cache: 'no-store', headers: { ...scope.headers }, signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new SicknessApiError(error.message ?? (typeof error.error === 'string' ? error.error : error.error?.message) ?? 'Intyget kunde inte hämtas.', response.status, error.code);
  }
  return response.blob();
}

export async function downloadSicknessCsv(scope: SicknessScope, selection: { personId: string; siteId?: string }, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({ personId: selection.personId, format: 'csv' });
  if (selection.siteId && selection.siteId !== 'all') query.set('siteId', selection.siteId);
  const response = await fetch(`/api/personnel/sickness?${query}`, {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/csv', ...scope.headers }, signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new SicknessApiError(error.message ?? (typeof error.error === 'string' ? error.error : error.error?.message) ?? 'Sjuklöneunderlaget kunde inte exporteras.', response.status, error.code);
  }
  if (!response.headers.get('Content-Type')?.toLocaleLowerCase().includes('text/csv')) throw new SicknessApiError('Servern gav ingen CSV-fil. Uppdatera och försök igen.', 502, 'invalid_response');
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const filename = /filename="?([^";]+)"?/.exec(disposition)?.[1] ?? `sjukloneunderlag-${selection.personId.replace(/[^a-zA-Z0-9_-]/g, '')}.csv`;
  return { blob: await response.blob(), filename };
}
