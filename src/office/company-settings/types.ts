export interface CompanyProfile {
  name: string;
  address: string;
  postalCode: string;
  city: string;
  countryCode: 'SE';
  phone: string;
  email: string;
  invoiceEmail: string;
  contactPerson: string;
  website: string;
}
export interface CompanyDocumentSettings { footerText: string; logoId?: string }
export interface CompanyDefaults { paymentTermsDays: number | null }
export interface CompanyNotifications {
  customerInquiries: string[];
  bookings: string[];
  integrationErrors: string[];
  weighedDocumentEmail: { enabled: boolean; recipients: string[] };
}
export interface CompanySettings {
  companyId: string;
  organisationNumber: string;
  version: number;
  profile: CompanyProfile;
  documents: CompanyDocumentSettings;
  defaults: CompanyDefaults;
  notifications: CompanyNotifications;
  updatedAt?: string;
  capabilities: { canManage: boolean };
}
export type CompanySettingsDraft = Pick<CompanySettings, 'profile' | 'documents' | 'defaults' | 'notifications'>;
export type CompanySettingsInput = CompanySettingsDraft & { expectedVersion: number };
export interface CompanyLogo { logoId: string; url: string }
