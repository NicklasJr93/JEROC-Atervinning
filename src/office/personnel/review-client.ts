import { can, type OfficeUser } from '../model';
import { z } from 'zod';
import { personnelPresenceScope, type PersonnelPresenceScope } from './presence-client';
import type { TimeReviewCommand, TimeReviewDetail, TimeReviewOverview } from './review-types';

export type TimeReviewScope = PersonnelPresenceScope;
export const timeReviewScope = personnelPresenceScope;
export const mayReadTimeReview = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person =>
  person.active !== false && can(person, 'personnelRead') && (person.level === 'Systemadmin' || person.permissions.includes('personnelTimeReviewRead')));
export const mayApproveTimeReview = (user: OfficeUser, actualUser: OfficeUser) => mayReadTimeReview(user, actualUser) && [actualUser, user].every(person =>
  person.level === 'Systemadmin' || person.permissions.includes('personnelTimeApprove'));

export class TimeReviewError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

const status = z.enum(['draft', 'submitted', 'returned', 'approved', 'reopened']);
const minutes = z.number().finite().nonnegative();
const summary = z.object({ expectedMinutes: minutes, recordedMinutes: minutes, missingMinutes: minutes, absenceMinutes: minutes, automaticMinutes: minutes, manualMinutes: minutes, clockMinutes: minutes, breakMinutes: minutes, allocatedMinutes: minutes, unallocatedMinutes: minutes });
const capabilities = z.object({ canSubmit: z.boolean(), canWithdraw: z.boolean(), canApprove: z.boolean(), canReturn: z.boolean(), canReopen: z.boolean(), canExport: z.boolean(), canExportHistory: z.boolean().optional(), approvalReasonRequired: z.boolean().optional() });
const review = z.object({ id: z.string(), personId: z.string(), month: z.string(), status, revision: z.number().int().nonnegative(), version: z.number().int().nonnegative(), submittedAt: z.string().nullable(), approvedAt: z.string().nullable(), returnedAt: z.string().nullable(), reopenedAt: z.string().nullable(), reason: z.string().nullable(), snapshotHash: z.string().nullable(), stale: z.boolean() });
const issue = z.object({ code: z.string(), severity: z.enum(['warning', 'blocking']), date: z.string().optional() });
const base = { serverNow: z.string().refine(value => Number.isFinite(Date.parse(value))), today: z.string(), month: z.string() };
const person = { name: z.string(), team: z.string(), siteIds: z.array(z.string()) };
const entry = z.object({ id: z.string(), source: z.enum(['manual', 'order']), revision: z.number(), activity: z.string(), startMinute: minutes, endMinute: minutes, breakMinutes: minutes, minutes, orderId: z.string().optional(), siteId: z.string().optional(), startedAt: z.string().optional(), endedAt: z.string().optional() });
const clock = z.object({ id: z.string(), startedAt: z.string(), endedAt: z.string().nullable(), breaks: z.array(z.object({ startedAt: z.string(), endedAt: z.string().nullable() })), workSeconds: minutes, breakSeconds: minutes, dayWorkSeconds: minutes.optional(), dayBreakSeconds: minutes.optional(), requiresCorrection: z.boolean().optional() }).passthrough();
const overviewSchema = z.object({ ...base, people: z.array(z.object({ ...person, personId: z.string(), review, summary, issues: z.array(issue), capabilities })), sites: z.array(z.object({ id: z.string(), name: z.string() })), capabilities: z.object({ canRead: z.boolean(), canApprove: z.boolean(), canExport: z.boolean() }),
  summary: z.object({ total: minutes, draft: minutes, submitted: minutes, returned: minutes, approved: minutes, reopened: minutes }) });
const detailSchema = z.object({ ...base, person: z.object({ ...person, id: z.string() }), review, capabilities,
  period: z.object({ month: z.string(), isClosed: z.boolean(), source: z.enum(['live', 'submitted', 'approved']), sourceHash: z.string(), calculatedAt: z.string(), summary, issues: z.array(issue), days: z.array(z.object({ date: z.string(), timeSource: z.enum(['clock', 'workorder']), status: z.enum(['empty', 'partial', 'complete', 'not_required']), ...summary.shape, entries: z.array(entry), clockSessions: z.array(clock) }).passthrough()) }),
  versions: z.array(z.object({ version: z.number(), sourceHash: z.string(), calculatedAt: z.string(), submittedAt: z.string(), approvedAt: z.string().nullable(), summary })),
  history: z.array(z.object({ id: z.string(), action: z.string(), at: z.string(), actualUserId: z.string(), effectiveUserId: z.string(), reason: z.string().nullable(), fromStatus: status, toStatus: status, version: z.number(), snapshotHash: z.string().nullable() })),
});

async function request<T>(scope: TimeReviewScope, query: URLSearchParams, command?: TimeReviewCommand, signal?: AbortSignal, detail = false): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Månadsgranskningen svarade inte i tid.', 'TimeoutError')), 45000);
  try {
    const response = await fetch(`/api/application/personnel-time-review?${query}`, {
      method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const result = await response.json().catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (response.ok) throw new TimeReviewError('Månadsgranskningen gav ett ofullständigt svar. Försök uppdatera igen.', 502, 'invalid_response');
      return {};
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new TimeReviewError(result.message ?? (typeof result.error === 'string' ? result.error : result.error?.message) ?? 'Månadsgranskningen kunde inte hämtas.', response.status, result.code);
    if (!(detail ? detailSchema : overviewSchema).safeParse(result).success) throw new TimeReviewError('Månadsgranskningen gav ett ofullständigt svar. Försök uppdatera igen.', 502, 'invalid_response');
    return result as T;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

const selection = (month: string, siteId?: string, personId?: string) => {
  const query = new URLSearchParams({ month });
  if (siteId && siteId !== 'all') query.set('siteId', siteId);
  if (personId) query.set('personId', personId);
  return query;
};

export const readTimeReviewOverview = (scope: TimeReviewScope, month: string, siteId?: string, signal?: AbortSignal) => request<TimeReviewOverview>(scope, selection(month, siteId), undefined, signal);
export const readTimeReviewDetail = (scope: TimeReviewScope, personId: string, month: string, siteId?: string, signal?: AbortSignal) => request<TimeReviewDetail>(scope, selection(month, siteId, personId), undefined, signal, true);
export const updateTimeReview = (scope: TimeReviewScope, command: TimeReviewCommand, siteId?: string, signal?: AbortSignal) => request<TimeReviewDetail>(scope, selection(command.month, siteId, command.personId), command, signal, true);

export async function downloadTimeReviewCsv(scope: TimeReviewScope, selected: { month: string; personId?: string; siteId?: string; version?: number }, signal?: AbortSignal): Promise<{ blob: Blob; filename: string }> {
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('CSV-filen svarade inte i tid.', 'TimeoutError')), 45000);
  try {
    const query = selection(selected.month, selected.siteId, selected.personId); query.set('format', 'csv');
    if (selected.version && selected.personId) query.set('version', String(selected.version));
    const response = await fetch(`/api/application/personnel-time-review?${query}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'text/csv', ...scope.headers },
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new TimeReviewError(error.message ?? (typeof error.error === 'string' ? error.error : error.error?.message) ?? 'CSV-filen kunde inte hämtas.', response.status, error.code);
    }
    if (!response.headers.get('Content-Type')?.toLocaleLowerCase().includes('text/csv')) throw new TimeReviewError('Servern gav ingen CSV-fil. Försök hämta den igen.', 502, 'invalid_response');
    const blob = await response.blob();
    if (controller.signal.aborted) throw controller.signal.reason;
    const filename = `tidrapport-${selected.month}${selected.personId ? `-${selected.personId.replace(/[^a-zA-Z0-9_-]/g, '')}` : '-godkanda'}${selected.version ? `-v${selected.version}` : ''}.csv`;
    return { blob, filename };
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
