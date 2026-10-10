import type { TransportData, TransportOrder } from '../transport/types';
import type { OfficeUser, Permission } from '../model';

export type PersonnelPermission = 'personnelRead' | 'personnelWrite' | 'employmentRead' | 'employmentWrite' | 'salaryRead' | 'salaryWrite' | 'absenceRead' | 'absenceWrite' | 'competenciesWrite' | 'staffingWrite' | 'externalAccounts';
export interface Person {
  id: string; name: string; kind: 'employee' | 'external'; active: boolean;
  role: string; team: string; siteIds: string[]; managerId?: string; companyId?: string;
  employeeNumber?: string; phone: string; email: string; address: string;
  userId?: string; driverId?: string; vehicleId?: string; canDrive: boolean; revision: number;
}
export interface PersonnelCompany { id: string; name: string; number: string; contact: string; phone: string; email: string }
export interface Employment { personId: string; form: 'permanent' | 'temporary' | 'probation' | 'hourly'; startDate: string; endDate?: string; percentage: number; hoursPerWeek: number; revision: number }
export interface Salary { personId: string; kind: 'monthly' | 'hourly'; amount: number; effectiveFrom: string; nextReview?: string; note: string; revision: number }
export interface WorkSchedule { id: string; personId: string; weekdays: number[]; startMinute: number; endMinute: number; lunchStart?: number; lunchEnd?: number; effectiveFrom: string; effectiveTo?: string; revision: number }
export type AbsenceKind = 'sick' | 'holiday' | 'vab' | 'leave' | 'training';
export interface Absence { id: string; personId: string; kind?: AbsenceKind; fromDate: string; toDate: string; allDay: boolean; startMinute?: number; endMinute?: number; managerId?: string; status: 'registered' | 'cancelled'; createdAt: string; createdBy: string; revision: number }
export interface Competency { id: string; personId: string; type: 'license' | 'ykb' | 'adr' | 'employer' | 'other'; name: string; codes: string[]; scope: string; validFrom: string; validTo?: string; verified: boolean; verifiedBy?: string; verifiedAt?: string; revision: number }
export interface StaffingTask { id: string; absenceId: string; personId: string; orderId: string; managerId?: string; date: string; startMinute: number; durationMinutes: number; status: 'open' | 'resolved'; replacementPersonId?: string; resolvedBy?: string; resolvedAt?: string }
export interface ExternalAccount { personId: string; username: string; active: boolean; createdAt: string; updatedAt: string; lastLoginAt?: string }
export interface PersonnelAudit { id: string; action: string; at: string; actualUserId: string; effectiveUserId: string; personId?: string; text: string }
export interface PersonnelData { version: 1; revision: number; people: Person[]; companies: PersonnelCompany[]; employment: Employment[]; salaries: Salary[]; schedules: WorkSchedule[]; absences: Absence[]; competencies: Competency[]; staffingTasks: StaffingTask[]; externalAccounts: ExternalAccount[]; audit: PersonnelAudit[] }
export interface ReplacementCandidate { personId: string; name: string; available: boolean; issues: string[] }
export interface PersonnelPreview { affectedOrders?: TransportOrder[]; candidates?: ReplacementCandidate[] }
export interface PersonnelResponse { data: PersonnelData; revision: number; storage: 'database'; demo: true; capabilities: (PersonnelPermission | 'users')[]; sites: {id: string; name: string}[]; transport: TransportData; users?: OfficeUser[]; preview?: PersonnelPreview }
export type PersonAccountCreation =
  | { kind: 'staff'; level?: OfficeUser['level']; permissions?: Permission[]; maxAttest?: number; ownAttest?: boolean }
  | { kind: 'external'; username: string; password: string };
export type PersonnelCommand =
  | { action: 'person.save'; person: Partial<Person> & Pick<Person, 'name' | 'kind'>; clearFields?: ('managerId' | 'companyId' | 'userId' | 'vehicleId')[]; createAccount?: PersonAccountCreation }
  | { action: 'company.save'; company: Partial<PersonnelCompany> & Pick<PersonnelCompany, 'name'> }
  | { action: 'employment.save'; employment: Employment }
  | { action: 'salary.save'; salary: Salary }
  | { action: 'schedule.save'; schedule: Omit<WorkSchedule, 'id' | 'revision'> & {id?: string; revision?: number} }
  | { action: 'competency.save'; competency: Omit<Competency, 'id' | 'revision'> & {id?: string; revision?: number} }
  | { action: 'absence.preview' | 'absence.save'; absence: Omit<Absence, 'id' | 'createdAt' | 'createdBy' | 'status' | 'revision'> & {id?: string; revision?: number} }
  | { action: 'absence.cancel'; absenceId: string; revision: number }
  | { action: 'replacement.preview'; taskIds: string[] }
  | { action: 'staffing.assign'; taskIds: string[]; replacementPersonId: string }
  | { action: 'externalAccount.save'; personId: string; username: string; active: boolean; password?: string }
  | { action: 'driverAccount.save'; personId: string; username: string; active: boolean; password?: string };
