import { z } from 'zod';
import type { TimeReviewDetail, TimeReviewDay } from '../office/personnel/review-types';

type EmployeeReviewDay = Pick<TimeReviewDay, 'date' | 'timeSource' | 'status' | 'expectedMinutes' | 'recordedMinutes' | 'missingMinutes'
  | 'absenceMinutes' | 'automaticMinutes' | 'manualMinutes' | 'clockMinutes' | 'breakMinutes' | 'allocatedMinutes' | 'unallocatedMinutes'>;
export type EmployeeTimeReview = Omit<TimeReviewDetail, 'period'> & {
  period: Omit<TimeReviewDetail['period'], 'days'> & { days: EmployeeReviewDay[] };
};
export interface EmployeeReviewCommand {
  action: 'review.submit' | 'review.withdraw'; month: string; revision: number; requestId: string;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T12:00:00Z`)));
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)));
const status = z.enum(['draft', 'submitted', 'returned', 'approved', 'reopened']);
const minutes = z.number().finite().nonnegative();
const summary = z.object({ expectedMinutes: minutes, recordedMinutes: minutes, missingMinutes: minutes, absenceMinutes: minutes,
  automaticMinutes: minutes, manualMinutes: minutes, clockMinutes: minutes, breakMinutes: minutes,
  allocatedMinutes: minutes, unallocatedMinutes: minutes }).passthrough();
// Validate the fields rendered by this view. Entry details remain server-owned
// and are opened through the existing own-day view rather than raw JSON.
const response = z.object({
  serverNow: instant, today: date, month,
  person: z.object({ id: z.string(), name: z.string(), team: z.string(), siteIds: z.array(z.string()) }),
  review: z.object({ id: z.string(), personId: z.string(), month, status, revision: z.number().int().nonnegative(), version: z.number().int().nonnegative(),
    submittedAt: instant.nullable(), approvedAt: instant.nullable(), returnedAt: instant.nullable(), reopenedAt: instant.nullable(),
    reason: z.string().nullable(), snapshotHash: z.string().nullable(), stale: z.boolean() }).passthrough(),
  period: z.object({ month, isClosed: z.boolean(), source: z.enum(['live', 'submitted', 'approved']), sourceHash: z.string(), calculatedAt: instant,
    summary, days: z.array(z.object({ date, timeSource: z.enum(['clock', 'workorder']), status: z.enum(['empty', 'partial', 'complete', 'not_required']),
      expectedMinutes: minutes, recordedMinutes: minutes, missingMinutes: minutes, absenceMinutes: minutes,
      automaticMinutes: minutes, manualMinutes: minutes, clockMinutes: minutes, breakMinutes: minutes,
      allocatedMinutes: minutes, unallocatedMinutes: minutes }).passthrough()),
    issues: z.array(z.object({ code: z.string(), severity: z.enum(['warning', 'blocking']), date: date.optional() })) }).passthrough(),
  history: z.array(z.object({ id: z.string(), action: z.string(), at: instant, actualUserId: z.string(), effectiveUserId: z.string(),
    reason: z.string().nullable(), fromStatus: status, toStatus: status, version: z.number().int().nonnegative(), snapshotHash: z.string().nullable() }).passthrough()),
  versions: z.array(z.object({ version: z.number().int().nonnegative(), sourceHash: z.string(), calculatedAt: instant,
    submittedAt: instant, approvedAt: instant.nullable(), summary }).passthrough()),
  capabilities: z.object({ canSubmit: z.boolean(), canWithdraw: z.boolean(), canApprove: z.boolean(), canReturn: z.boolean(), canReopen: z.boolean(), canExport: z.boolean() }),
}).passthrough();

export function parseEmployeeTimeReview(value: unknown): EmployeeTimeReview {
  const result = response.safeParse(value);
  if (!result.success) throw new Error('Månadsrapporten gav ett ofullständigt svar. Hämta rapporten igen.');
  return result.data;
}
