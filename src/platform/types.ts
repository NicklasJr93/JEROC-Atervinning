import type { OfficeUser } from '../office/model';

export type PlatformCompany = {
  id: string;
  name: string;
  organisationNumber: string;
  status: 'provisioning' | 'active' | 'failed' | 'inactive';
  createdAt?: string;
  ownerPasswordChangePending?: boolean;
};

export type AuthenticatedPlatformSession = {
  enabled: true;
  authenticated: true;
  actor: { id: string; name: string; username: string; platformAdmin: boolean };
  actualUser: OfficeUser;
  user: OfficeUser;
  company?: PlatformCompany;
  organisationId?: string;
  effectiveUserId?: string;
  selfBusinessUserIds?: string[];
  isSupportSession: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
  generation: string | number;
  companies: PlatformCompany[];
};

export type PlatformSession = AuthenticatedPlatformSession | {
  enabled: true;
  authenticated: false;
};

export type PlatformCompanyUser = Pick<OfficeUser, 'id' | 'name' | 'level' | 'active'>;
export type CompanyCreated = {
  company: PlatformCompany;
  user: PlatformCompanyUser;
  temporaryCredentials?: { username: string; password: string; mustChangePassword: true };
  credentialsRevealed: boolean;
};

export type PlatformCommunicationsConfig = {
  email: { configured: boolean; provider: 'resend'; from: string };
  sms: { configured: boolean; provider?: '46elks'; from?: string; useCases?: { id: string; label: string; state: 'prepared' }[] };
};

export type PlatformTestEmailResult = {
  requestId: string;
  to: string;
  from: string;
  provider: 'resend';
  status: 'accepted';
  providerId: string;
  acceptedAt: string;
};

export type PlatformTestSmsResult = {
  requestId: string;
  to: string;
  from: 'ScrapPlan';
  provider: '46elks';
  status: 'accepted';
  providerStatus: 'created' | 'sent' | 'delivered';
  providerId: string;
  acceptedAt: string;
};
