import type { TransportOrder } from '../office/transport/types';
import type { LogisticsOrderDetail } from '../office/logistics/types';
import type { WorkSchedule, Absence } from '../office/personnel/types';

export interface EmployeePerson {
  id: string; name: string; kind?: 'employee' | 'external'; role: string; team: string;
  phone: string; email: string; siteIds: string[]; employeeNumber?: string;
  userId?: string; driverId?: string; username?: string; managerName?: string;
}
export interface EmployeeCapabilities {
  yardWork: boolean; assignedOrders: boolean; employeeTime: boolean; manageTimeRequirements: boolean;
  manageEmployeeAccounts?: boolean;
}
export interface EmployeeRequirement {
  enabled: boolean; mode: 'schedule' | 'fixed'; dailyMinutes?: number;
  effectiveFrom: string; enforcementFrom: string; revision: number; weekdays?: number[];
}
export interface EmployeeTimeGate {
  blocked: boolean; date?: string; expectedMinutes: number; recordedMinutes: number; missingMinutes: number;
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
  date: string; expectedMinutes: number; recordedMinutes: number; missingMinutes: number;
  automaticMinutes: number; manualMinutes: number; absenceMinutes: number; jobsCount: number;
  status: 'empty' | 'partial' | 'complete' | 'not_required';
}
export type EmployeeOrder = TransportOrder & { detail?: LogisticsOrderDetail };
export interface EmployeeLeaveRequest {
  id: string; revision: number; kind: string; fromDate: string; toDate: string;
  note: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}
export interface EmployeeLeaveDraft { kind: string; fromDate: string; toDate: string; note: string }
export interface EmployeeSession {
  person: EmployeePerson; capabilities: EmployeeCapabilities;
  sites: { id: string; name: string; active?: boolean }[];
}
export interface EmployeeOverview extends EmployeeSession {
  revision: number; today: string; month: string; date: string;
  requirement: EmployeeRequirement; gate: EmployeeTimeGate; days: EmployeeDay[];
  selectedDay: EmployeeDay & { entries: EmployeeTimeEntry[]; schedules: WorkSchedule[]; absences: Absence[]; orders: EmployeeOrder[] };
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
