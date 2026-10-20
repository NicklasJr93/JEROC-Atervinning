/** Before delegation existed, a Medarbetare could store the users checkbox
 * without ever receiving the capability. Clear those inert historical bits
 * once, before resolving any principal. A later explicit owner grant survives
 * restarts because the migration is recorded in the same tenant transaction. */
export function migrateUserManagementDelegation(state, { now = () => new Date() } = {}) {
  state.metadata ??= {};
  if (state.metadata.userManagementDelegationVersion === 1) return false;
  let removedLegacyGrants = 0;
  for (const user of state.pricing?.users ?? []) {
    if (user.level === 'Medarbetare' && user.permissions?.includes('users')) {
      user.permissions = user.permissions.filter(right => right !== 'users');
      removedLegacyGrants++;
    }
  }
  for (const user of state.office?.users ?? [])
    if (user.level === 'Medarbetare' && user.permissions?.includes('users'))
      user.permissions = user.permissions.filter(right => right !== 'users');
  state.metadata.userManagementDelegationVersion = 1;
  state.metadata.userManagementDelegationMigration = { at: new Date(now()).toISOString(), removedLegacyGrants };
  return true;
}
