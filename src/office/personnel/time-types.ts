import type { EmployeeClockCorrection, EmployeeOverview, EmployeeRequirement } from '../../employee/types';

export interface PersonnelClockHistory {
  id: string;
  action: string;
  at: string;
  actorId?: string;
  actualUserId?: string;
  effectiveUserId?: string;
  reason?: string;
  text?: string;
  before?: unknown;
  after?: unknown;
}

export type PersonnelTimeOverview = Omit<EmployeeOverview, 'person' | 'capabilities'> & {
  person: { id: string; name: string };
  capabilities: { manageTimeSettings: boolean; correctClock: boolean };
  configuredRequirement?: EmployeeRequirement;
  timeSourceChange: { earliestEffectiveFrom: string; hasRecordedToday: boolean };
  clockHistory: PersonnelClockHistory[];
};

export type PersonnelTimeRequirement = Pick<EmployeeRequirement, 'enabled' | 'mode' | 'dailyMinutes' | 'weekdays' | 'revision'> & {
  timeSource: 'workorder' | 'clock';
  effectiveFrom: string;
};

export type PersonnelTimeCommand =
  | { action: 'requirement.save'; personId: string; requirement: PersonnelTimeRequirement }
  | (EmployeeClockCorrection & { personId: string });
