import type { EmployeeClockSession, EmployeeRequirement } from '../../employee/types';

export type TimeReviewStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'reopened';
export interface TimeReviewIssue { code: string; severity: 'warning' | 'blocking'; date?: string }
export interface TimeReviewSummary {
  expectedMinutes: number; recordedMinutes: number; missingMinutes: number; absenceMinutes: number;
  automaticMinutes: number; manualMinutes: number; clockMinutes: number; breakMinutes: number;
  allocatedMinutes: number; unallocatedMinutes: number;
}
export interface TimeReview {
  id: string; personId: string; month: string; status: TimeReviewStatus; revision: number; version: number;
  submittedAt: string | null; approvedAt: string | null; returnedAt: string | null; reopenedAt: string | null;
  reason: string | null; snapshotHash: string | null; stale: boolean;
}
export interface TimeReviewCapabilities {
  canSubmit: boolean; canWithdraw: boolean; canApprove: boolean; canReturn: boolean; canReopen: boolean; canExport: boolean;
  canExportHistory?: boolean; approvalReasonRequired?: boolean;
}
export interface TimeReviewEntry {
  id: string; source: 'manual' | 'order'; revision: number; activity: string;
  startMinute: number; endMinute: number; breakMinutes: number; minutes: number;
  orderId?: string; siteId?: string; startedAt?: string; endedAt?: string;
}
export interface TimeReviewDay {
  date: string; timeSource: 'clock' | 'workorder'; status: 'empty' | 'partial' | 'complete' | 'not_required';
  expectedMinutes: number; recordedMinutes: number; missingMinutes: number; absenceMinutes: number;
  automaticMinutes: number; manualMinutes: number; clockMinutes: number; breakMinutes: number;
  allocatedMinutes: number; unallocatedMinutes: number; jobsCount?: number;
  requirement: EmployeeRequirement; entries: TimeReviewEntry[]; clockSessions: Omit<EmployeeClockSession, 'correctionReason'>[];
}
export interface TimeReviewPeriod {
  month: string; isClosed: boolean; source: 'live' | 'submitted' | 'approved'; sourceHash: string;
  calculatedAt: string; days: TimeReviewDay[]; summary: TimeReviewSummary; issues: TimeReviewIssue[];
}
export interface TimeReviewHistory {
  id: string; action: string; at: string; actualUserId: string; effectiveUserId: string;
  reason: string | null; fromStatus: TimeReviewStatus; toStatus: TimeReviewStatus; version: number; snapshotHash: string | null;
}
export interface TimeReviewVersion {
  version: number; sourceHash: string; calculatedAt: string; submittedAt: string; approvedAt: string | null; summary: TimeReviewSummary;
}
export interface TimeReviewPerson {
  personId: string; name: string; team: string; siteIds: string[];
  review: TimeReview; summary: TimeReviewSummary; issues: TimeReviewIssue[]; capabilities: TimeReviewCapabilities;
}
export interface TimeReviewOverview {
  serverNow: string; today: string; month: string;
  people: TimeReviewPerson[];
  summary: { total: number; draft: number; submitted: number; returned: number; approved: number; reopened: number };
  sites: { id: string; name: string }[]; capabilities: { canRead: boolean; canApprove: boolean; canExport: boolean };
}
export interface TimeReviewDetail {
  serverNow: string; today: string; month: string; person: { id: string; name: string; team: string; siteIds: string[] };
  review: TimeReview; period: TimeReviewPeriod; history: TimeReviewHistory[]; versions: TimeReviewVersion[]; capabilities: TimeReviewCapabilities;
}
export interface TimeReviewCommand {
  action: 'review.approve' | 'review.return' | 'review.reopen'; personId: string; month: string;
  revision: number; requestId: string; reason?: string;
}
export const timeReviewStatusLabels: Record<TimeReviewStatus, string> = {
  draft: 'Utkast', submitted: 'Inlämnad', returned: 'Återlämnad', approved: 'Godkänd', reopened: 'Återöppnad',
};
