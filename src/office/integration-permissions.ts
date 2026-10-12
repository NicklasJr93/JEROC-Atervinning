import type { OfficeUser } from './model';

/** Mirrors the Spiris service's explicit company permission check. A VD role
 * alone never grants integration access, including when working as someone. */
const managesSpiris = (user: OfficeUser | undefined) => user?.level === 'Systemadmin' ||
  user?.level === 'VD' && ['integrationsRead', 'integrationsManage'].every(right => user.permissions.includes(right as 'integrationsRead' | 'integrationsManage'));

export const mayManageSpiris = (user: OfficeUser | undefined, actualUser: OfficeUser | undefined) =>
  Boolean(managesSpiris(user) && managesSpiris(actualUser) && !user?.siteIds && !actualUser?.siteIds);
