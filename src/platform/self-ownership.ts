import type { OfficeUser } from '../office/model';
import { isSelfOwned } from '../office/self-ownership';
import { currentPlatformSession } from './session';

/** These server-projected aliases may tighten deny-self checks only. */
export function currentSelfBusinessUserIds(): readonly string[] | undefined {
  const session = currentPlatformSession();
  return session?.authenticated && session.actor.platformAdmin && session.organisationId === 'jeroc-demo'
    ? session.selfBusinessUserIds : undefined;
}

export function isCurrentUserSelfOwned(recordedUserIds: readonly (string | undefined)[], user: OfficeUser, actualUser?: OfficeUser): boolean {
  return isSelfOwned(recordedUserIds, [user.id, actualUser?.id], currentSelfBusinessUserIds());
}
