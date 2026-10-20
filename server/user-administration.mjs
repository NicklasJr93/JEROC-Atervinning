import { isDeepStrictEqual } from 'node:util';
import { can as officeCan } from '../dist-server/domain-models.mjs';

const ownerRole = user => ['VD', 'Systemadmin'].includes(user?.level);
export const canManageStaffUsers = user => Boolean(user?.id) && user.active !== false
  && (ownerRole(user) || user.level === 'Medarbetare' && user.permissions?.includes('users'));
export const canDelegateUserManagement = principal => [principal?.actor, principal?.user]
  .every(user => Boolean(user?.id) && user.active !== false && ownerRole(user));

function deny(ErrorType, message) {
  const error = new ErrorType(message, 403);
  error.status = 403;
  error.code = 'user_administration_forbidden';
  throw error;
}
export function assertStaffUserManagement(principal, { ErrorType = Error } = {}) {
  if (![principal?.actor, principal?.user].every(canManageStaffUsers))
    deny(ErrorType, 'Både faktiskt och effektivt konto behöver behörighet att hantera användare.');
}
const privilegeSnapshot = user => user && ({
  id: user.id, level: user.level, permissions: [...new Set(user.permissions ?? [])].sort(),
  siteIds: Array.isArray(user.siteIds) ? [...new Set(user.siteIds)].sort() : undefined,
  maxAttest: user.maxAttest ?? 0, ownAttest: user.ownAttest === true, active: user.active !== false,
});

/** Shared by account writes, account linkage and invitation/credential actions.
 * Owner-role callers retain the existing caller-specific VD/Systemadmin rules.
 * A delegated administrator must fit BOTH current principals' entire scope,
 * before and after the change. Null next means deletion; undefined previous
 * means creation. Only the pricing name editor may opt into a self name change.
 */
export function assertStaffUserTarget(principal, previous, next = previous,
  { ErrorType = Error, allowSelfNameChange = false } = {}) {
  assertStaffUserManagement(principal, { ErrorType });
  const targets = [previous, next].filter(Boolean);
  if (targets.some(target => target.level === 'Systemadmin')
    && ![principal.actor, principal.user].every(user => user.level === 'Systemadmin'))
    deny(ErrorType, 'Både faktiskt och effektivt konto måste vara Systemadmin för att hantera Systemadmin-konton.');
  if (canDelegateUserManagement(principal)) {
    const sitesChanged = !previous || !isDeepStrictEqual(privilegeSnapshot(previous)?.siteIds, privilegeSnapshot(next)?.siteIds);
    for (const owner of [principal.actor, principal.user].filter(user => user.level === 'VD')) {
      if (next && next.level !== 'Systemadmin' && (!previous || previous.maxAttest !== next.maxAttest)
        && (next.maxAttest ?? 0) > (owner.maxAttest ?? 0))
        deny(ErrorType, 'VD får inte ge en högre attestgräns än sin egen.');
      if (next && sitesChanged && Array.isArray(owner.siteIds) && (!Array.isArray(next.siteIds)
        || next.siteIds.some(siteId => !owner.siteIds.includes(siteId))))
        deny(ErrorType, 'VD får inte ge åtkomst till en anläggning utanför sin egen behörighet.');
    }
    return;
  }
  if (!targets.length) deny(ErrorType, 'Välj ett giltigt personalkonto.');
  if (targets.some(target => [principal.actor.id, principal.user.id].includes(target.id))) {
    if (allowSelfNameChange && previous && next && isDeepStrictEqual(privilegeSnapshot(previous), privilegeSnapshot(next))) return;
    deny(ErrorType, 'Ändra inte ditt eget kontos behörighet eller inloggning. Be en annan administratör om hjälp.');
  }
  for (const target of targets) {
    if (target.level !== 'Medarbetare' || target.permissions?.includes('users'))
      deny(ErrorType, 'Delegerad användarhantering gäller vanliga medarbetare. VD, Systemadmin och andra användaradministratörer hanteras av VD eller Systemadmin.');
    for (const administrator of [principal.actor, principal.user]) {
      if ((target.permissions ?? []).some(right => !officeCan(administrator, right)))
        deny(ErrorType, 'Du får bara hantera konton inom både faktiskt och effektivt kontos egna behörigheter.');
      if (Array.isArray(administrator.siteIds) && (!Array.isArray(target.siteIds)
        || target.siteIds.some(siteId => !administrator.siteIds.includes(siteId))))
        deny(ErrorType, 'Kontots anläggningar måste ligga inom både faktiskt och effektivt kontos åtkomst.');
      if (!Number.isFinite(target.maxAttest ?? 0) || (target.maxAttest ?? 0) < 0
        || (target.maxAttest ?? 0) > (administrator.maxAttest ?? 0))
        deny(ErrorType, 'Kontots attestgräns får inte överstiga faktiskt eller effektivt kontos egen gräns.');
      if (target.ownAttest === true && administrator.ownAttest !== true)
        deny(ErrorType, 'Du får inte ge rätt till egen attest när faktiskt eller effektivt konto saknar den rätten.');
    }
  }
}
