export type PersonnelPresenceClockStatus = 'working' | 'break' | 'out' | 'off' | 'disabled';
export type PersonnelPresenceAvailability = 'available' | 'on_break' | 'busy' | 'absent' | 'not_clocked_in' | 'unknown' | 'needs_review';

export interface PresencePerson {
  personId: string;
  name: string;
  team: string;
  siteIds: string[];
  timeSource: 'workorder' | 'clock';
  clockEnabled: boolean;
  clockStatus: PersonnelPresenceClockStatus;
  isClockedIn: boolean;
  isOnBreak: boolean;
  isWorkingNow: boolean;
  workStateSource: 'clock' | 'order' | 'unknown';
  clockSessionId: string | null;
  clockedInAt: string | null;
  breakStartedAt: string | null;
  clockSiteId?: string;
  workSeconds: number;
  breakSeconds: number;
  lastClockEventAt: string | null;
  statusSince: string | null;
  isRunning: boolean;
  requiresCorrection: boolean;
  hasActiveOrder: boolean;
  activeOrderId?: string;
  isScheduledNow: boolean | null;
  isAbsentNow: boolean;
  isEmploymentActive: boolean;
  availabilityStatus: PersonnelPresenceAvailability;
  isAvailableNow: boolean | null;
  reasonCodes: string[];
}

export interface PersonnelPresenceResponse {
  serverNow: string;
  revision: number;
  people: PresencePerson[];
  summary: {
    total: number; clockedIn: number; working: number; onBreak: number;
    clockedOut: number; clockDisabled: number; needsReview: number; available: number;
  };
  sites: { id: string; name: string }[];
}
