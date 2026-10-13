export type SicknessExtent = 25 | 50 | 75 | 100;
export interface SicknessForecast { kind: 'unknown' | 'date'; date?: string }
export interface SicknessPolicy {
  revision: number; dailyContact: boolean; contactByMinute: number;
  agreement: 'unknown' | 'statutory' | 'collective'; agreementName: string;
  calculationConfirmed: boolean; effectiveFrom: string;
}
export interface SicknessPayProfile {
  personId: string; revision: number; effectiveFrom: string;
  hourlyBase: number; averageWeeklyHours: number; sickPayRate: number;
  confirmed: boolean; source: string;
}
export interface SicknessHighRiskDecision {
  id: string; personId: string; fromDate: string; toDate: string;
  kind: 'frequent' | 'long'; reference: string; revision: number;
}
export interface SicknessCertificate {
  received: boolean; fromDate?: string; toDate?: string; receivedAt?: string;
  reference: string; firstDayRequired?: boolean; firstDayReason?: string;
}
export interface SicknessEvent {
  id: string; caseId?: string; personId?: string; action: string;
  at: string; actualUserId: string; effectiveUserId: string;
  text: string; reason?: string;
}
export interface SicknessDay {
  date: string; extent: SicknessExtent; startMinute?: number; endMinute?: number;
  absenceId: string; scheduledMinutes: number; lostMinutes: number;
  sourceRevision: number; timeLocked: boolean;
}
export interface SicknessCase {
  id: string; personId: string; personName?: string; revision: number;
  status: 'open' | 'recovered'; fromDate: string; startMinute?: number;
  lastSickDate?: string; recoveredAt?: string; recoveryMinute?: number;
  extent: SicknessExtent; forecast: SicknessForecast;
  declared: boolean; declaredAt?: string; reportedAt: string;
  cycleId: string; relapse: boolean; lastContactDate: string;
  contacts: { date: string; at: string; extent: SicknessExtent }[];
  certificate: SicknessCertificate;
  followup: { certificateRequired: boolean; certificateDueDate: string;
    insurerReportDue: boolean; insurerReportDeadline: string;
    insurerReportedAt?: string; rehabilitationPlanDue: boolean;
    rehabilitationPlanAt?: string; contactOverdue: boolean;
    reviewRequired: boolean; messages: string[] };
  timeIssue: boolean; days: SicknessDay[];
}
export interface SicknessUnderlayRow {
  caseId: string; cycleId: string; date: string; employerDay: number;
  lostMinutes: number; salaryLoss: number | null; grossSickPay: number | null;
  karensDeduction: number | null; payableSickPay: number | null;
  status: 'calculated' | 'missing_basis' | 'outside_employer_period' | 'review_required';
  messages: string[];
}
export interface SicknessCycleSummary {
  id: string; firstDate: string; caseIds: string[]; relapse: boolean;
  deductionExemption: 'none' | 'general_high_risk' | 'special_high_risk';
  deductionTarget: number | null; deductionTaken: number | null;
  deductionRemaining: number | null; basis?: SicknessPayProfile;
}
export interface SicknessUnderlay {
  ledgerId?: string; ledgerRevision?: number; contentHash?: string;
  available: boolean; generatedAt: string; currency: 'SEK';
  calculationStatus: 'calculated' | 'missing_basis' | 'review_required';
  messages: string[]; rows: SicknessUnderlayRow[]; cycles: SicknessCycleSummary[];
  totalSalaryLoss: number | null; totalGrossSickPay: number | null;
  totalDeduction: number | null; totalPayableSickPay: number | null;
}
export interface EmployeeSicknessResponse {
  revision: number; today: string; policy: SicknessPolicy;
  activeCase: SicknessCase | null; cases: SicknessCase[]; events: SicknessEvent[];
  canReport: boolean; activeClock: boolean; activeWork: boolean;
  notification: string;
}
export interface SicknessManagementResponse {
  revision: number; today: string; policy: SicknessPolicy;
  people: { id: string; name: string; siteIds: string[]; active: boolean }[];
  cases: SicknessCase[]; events: SicknessEvent[];
  profiles: SicknessPayProfile[]; highRiskDecisions: SicknessHighRiskDecision[];
  deductionImports: { id: string; personId: string; date: string; source: string }[];
  underlay?: SicknessUnderlay;
  capabilities: string[]; notificationCount: number;
}
export type EmployeeSicknessCommand =
  | { action: 'sickness.report'; requestId: string; fromDate: string; startMinute?: number;
      extent: SicknessExtent; forecast: SicknessForecast; declared: boolean; clockOut?: boolean }
  | { action: 'sickness.confirm'; requestId: string; id: string; revision: number; extent: SicknessExtent; forecast?: SicknessForecast }
  | { action: 'sickness.forecast'; requestId: string; id: string; revision: number; forecast: SicknessForecast }
  | { action: 'sickness.declare'; requestId: string; id: string; revision: number; declared: true }
  | { action: 'sickness.recover'; requestId: string; id: string; revision: number; lastSickDate: string; recoveryMinute?: number };
export type SicknessManagementCommand =
  | (EmployeeSicknessCommand & { personId: string; reason?: string })
  | { action: 'sickness.correct'; requestId: string; personId: string; id: string; revision: number;
      fromDate: string; startMinute?: number; extent: SicknessExtent; lastSickDate?: string;
      recoveryMinute?: number; reason: string }
  | { action: 'certificate.save'; requestId: string; personId: string; id: string; revision: number; certificate: SicknessCertificate }
  | { action: 'policy.save'; requestId: string; policy: SicknessPolicy }
  | { action: 'payprofile.save'; requestId: string; profile: SicknessPayProfile }
  | { action: 'highrisk.save'; requestId: string; decision: SicknessHighRiskDecision }
  | { action: 'deduction.import'; requestId: string; personId: string; date: string; source: string }
  | { action: 'case.review'; requestId: string; personId: string; id: string; revision: number;
      kind: 'insurer_reported' | 'rehabilitation_plan' | 'checked' | 'report_delay_exception' | 'return_work_verified' | 'employment_eligibility_verified'; reason: string };
