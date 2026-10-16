import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();

/** Only the authenticated gateway installs this request context. Aliases are
 * comparison-only: never use them for role, site, or account access grants. */
export function withBusinessIdentity(context, operation) {
  const identity = context?.platformAdmin === true && context.organisationId === 'jeroc-demo'
    && context.actualUser?.id === '__platform-admin' && typeof context.user?.id === 'string'
    && typeof context.credentialBusinessId === 'string' && context.credentialBusinessId
    ? Object.freeze({ actorId: context.actualUser.id, userId: context.user.id, credentialBusinessId: context.credentialBusinessId }) : undefined;
  return requests.run(identity, operation);
}

/** Preserve self-approval prohibitions across the platform/staff identity split.
 * Direct matches work normally; only the current trusted principal gets aliases. */
export function principalOwnsUser(principal, userId) {
  if (typeof userId !== 'string' || !userId) return false;
  if (principal?.actor?.id === userId || principal?.user?.id === userId) return true;
  const identity = requests.getStore();
  return Boolean(identity && principal?.actor?.id === identity.actorId && principal?.user?.id === identity.userId
    && userId === identity.credentialBusinessId);
}
