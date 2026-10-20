import { can, type OfficeUser, type Permission } from '../model';

const principals = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user];
export const mayDelegateUserManagement = (user: OfficeUser, actualUser: OfficeUser) =>
  principals(user, actualUser).every(value => value.active !== false && ['VD', 'Systemadmin'].includes(value.level) && can(value, 'users'));
export const hasDelegatedUserManagement = (user: OfficeUser, actualUser: OfficeUser) =>
  principals(user, actualUser).every(value => can(value, 'users')) && !mayDelegateUserManagement(user, actualUser);
export const mayGrantStaffPermission = (user: OfficeUser, actualUser: OfficeUser, permission: Permission) =>
  permission === 'users' ? mayDelegateUserManagement(user, actualUser)
    : mayDelegateUserManagement(user, actualUser) || principals(user, actualUser).every(value => can(value, permission));
export const mayGrantStaffSite = (user: OfficeUser, actualUser: OfficeUser, siteId: string) =>
  principals(user, actualUser).every(value => !value.siteIds || value.siteIds.includes(siteId));
export const staffAttestCeiling = (user: OfficeUser, actualUser: OfficeUser) => hasDelegatedUserManagement(user, actualUser)
  ? Math.min(user.maxAttest, actualUser.maxAttest)
  : Math.min(...principals(user, actualUser).map(value => value.level === 'Systemadmin' ? Infinity : value.maxAttest));
export const mayGrantStaffOwnAttest = (user: OfficeUser, actualUser: OfficeUser) =>
  mayDelegateUserManagement(user, actualUser) || principals(user, actualUser).every(value => value.ownAttest === true);

/** Presentation mirrors the server's target policy. The backend separately
 * checks the persisted account and the full proposed account on every write. */
export function staffAccountRestriction(user: OfficeUser, actualUser: OfficeUser, target: OfficeUser): string {
  if (!principals(user, actualUser).every(value => can(value, 'users')))
    return 'Du saknar behörighet att hantera användarkonton.';
  if (target.level === 'Systemadmin' && !principals(user, actualUser).every(value => value.level === 'Systemadmin'))
    return 'Endast Systemadmin kan ändra ett systemadminkonto.';
  if (principals(user, actualUser).some(value => value.siteIds && (!target.siteIds || target.siteIds.some(id => !value.siteIds!.includes(id)))))
    return 'Kontots anläggningsåtkomst ligger utanför din eller den faktiska användarens åtkomst.';
  if (!hasDelegatedUserManagement(user, actualUser)) return '';
  if (principals(user, actualUser).some(value => value.id === target.id))
    return 'Du kan inte ändra ditt eget kontos behörigheter. Be VD eller Systemadmin om hjälp.';
  if (target.level !== 'Medarbetare' || target.permissions.includes('users'))
    return 'Delegerad användarhantering gäller vanliga medarbetarkonton. VD, Systemadmin och andra användaradministratörer hanteras av VD eller Systemadmin.';
  if (target.permissions.some(right => !principals(user, actualUser).every(value => can(value, right)))
    || target.maxAttest > staffAttestCeiling(user, actualUser)
    || target.ownAttest && !mayGrantStaffOwnAttest(user, actualUser))
    return 'Kontots befintliga behörigheter eller attestvillkor ligger utanför din och den faktiska användarens gemensamma behörighet. Be VD eller Systemadmin hantera kontot.';
  return '';
}
