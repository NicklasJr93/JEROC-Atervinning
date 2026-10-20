import type { TransportOrder } from '../office/transport/types';
import type { LogisticsOrderDetail } from '../office/logistics/types';
import type { WorkSchedule, Absence } from '../office/personnel/types';
import type { PresencePerson } from '../office/personnel/presence-types';
import type { AuthenticatedPlatformSession, PlatformCompany } from '../platform/types';

export interface EmployeeAdminSession {
  kind: 'platform-admin';
  platformSession: AuthenticatedPlatformSession;
  companies: PlatformCompany[];
}
export interface EmployeeAdminSupport {
  kind: 'platform-admin';
  csrfToken: string;
  generation: string | number;
  organisationId: string;
  actorName: string;
  platformSession: AuthenticatedPlatformSession;
}

export interface EmployeePerson {
  id: string; name: string; kind?: 'employee' | 'external'; role: string; team: string;
  phone: string; email: string; siteIds: string[]; employeeNumber?: string;
  userId?: string; driverId?: string; username?: string; managerName?: string;
}
export interface EmployeeCapabilities {
  yardWork: boolean; assignedOrders: boolean; employeeTime: boolean; manageTimeRequirements: boolean;
  manageEmployeeAccounts?: boolean;
  paymentDetails?: boolean;
}
export interface EmployeeRequirement {
  enabled: boolean; mode: 'schedule' | 'fixed'; dailyMinutes?: number;
  effectiveFrom: string; enforcementFrom: string; revision: number; weekdays?: number[];
  timeSource?: 'workorder' | 'clock';
}
export interface EmployeeClockBreak { startedAt: string; endedAt: string | null }
export interface EmployeeClockSession {
  id: string; revision: number; startedAt: string; endedAt: string | null;
  siteId?: string;
  breaks: EmployeeClockBreak[]; workSeconds: number; breakSeconds: number;
  dayWorkSeconds?: number; dayBreakSeconds?: number; correctedAt?: string; correctionReason?: string;
  provisional?: boolean; requiresCorrection?: boolean;
}
export interface EmployeeClock {
  enabled: boolean; source: 'workorder' | 'clock'; revision: number;
  status: 'working' | 'break' | 'out' | 'off'; serverNow: string;
  activeSession: EmployeeClockSession | null; workSeconds: number; breakSeconds: number;
  requiresCorrection?: boolean;
}
export interface EmployeeClockAction {
  action: 'clock.in' | 'clock.pause' | 'clock.resume' | 'clock.out';
  requestId: string; revision: number; sessionId?: string;
}
export interface EmployeeClockCorrection {
  action: 'clock.correct'; requestId: string; revision: number; sessionId?: string;
  startedAt: string; endedAt: string; breaks: { startedAt: string; endedAt: string }[]; reason: string;
}
export interface EmployeeTimeGate {
  blocked: boolean; date?: string; expectedMinutes: number; recordedMinutes: number; missingMinutes: number;
  timeSource?: 'workorder' | 'clock';
}
export interface EmployeeTimeEntry {
  id: string; revision: number; source: 'manual' | 'order'; date: string;
  startMinute: number; endMinute: number; breakMinutes: number; minutes: number;
  activity: string; note: string; orderId?: string; siteId?: string;
  orderName?: string; siteName?: string;
}
export interface EmployeeTimeDraft {
  id?: string; revision?: number; date: string; startMinute: number; endMinute: number;
  breakMinutes: number; activity: string; note: string; orderId?: string; siteId?: string;
}
export interface EmployeeDay {
  reviewLocked?: boolean;
  reviewStatus?: 'draft' | 'submitted' | 'returned' | 'approved' | 'reopened';
  date: string; expectedMinutes: number; recordedMinutes: number; missingMinutes: number;
  automaticMinutes: number; manualMinutes: number; absenceMinutes: number; jobsCount: number;
  status: 'empty' | 'partial' | 'complete' | 'not_required';
  timeSource?: 'workorder' | 'clock'; clockMinutes?: number; breakMinutes?: number;
  allocatedMinutes?: number; unallocatedMinutes?: number;
}
export type EmployeeOrder = TransportOrder & { detail?: LogisticsOrderDetail };
export interface EmployeeLeaveRequest {
  id: string; revision: number; kind: string; fromDate: string; toDate: string;
  note: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}
export interface EmployeeLeaveDraft { kind: string; fromDate: string; toDate: string; note: string }
export interface EmployeeSession {
  support?: EmployeeAdminSupport;
  companyId?: string; companyName?: string;
  activeSiteId?: string;
  person: EmployeePerson; capabilities: EmployeeCapabilities;
  sites: { id: string; name: string; active?: boolean }[];
}
export interface EmployeeOverview extends EmployeeSession {
  sickness?: import('./sickness-types').EmployeeSicknessResponse;
  upcomingOrders?: EmployeeOrder[];
  homeActivity?: { date: string; siteId: string; completedWeighings: number; weighedKg: number };
  monthLoaded?: boolean;
  revision: number; today: string; month: string; date: string;
  requirement: EmployeeRequirement; gate: EmployeeTimeGate; days: EmployeeDay[];
  selectedDay: EmployeeDay & { entries: EmployeeTimeEntry[]; schedules: WorkSchedule[]; absences: Absence[]; orders: EmployeeOrder[]; clockSessions?: EmployeeClockSession[] };
  clock?: EmployeeClock;
  presence?: PresencePerson;
  orders: EmployeeOrder[]; activeWork?: { id: string; orderId: string; startedAt: string; personId: string } | null;
  leaveRequests: EmployeeLeaveRequest[];
  summary: { expectedMinutes: number; recordedMinutes: number; missingMinutes: number };
  balances: { available: boolean; holidayDays?: number; flexMinutes?: number; compMinutes?: number };
}
export interface EmployeeRequirementPerson {
  id: string; name: string; role?: string; requirement: EmployeeRequirement; canEdit: boolean;
}
export interface EmployeeAccountPerson {
  id: string; name: string; active: boolean;
  account?: { username: string; active: boolean; lastLoginAt?: string };
}
