import { getPlatformContext } from './platform-auth.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const transactionAuthorization = new AsyncLocalStorage();
export const withMobileSupportAuthorization = async (authorize, operation) => {
  const scope = { authorize, active: true };
  try { return await transactionAuthorization.run(scope, operation); }
  finally { scope.active = false; }
};
export const assertMobileSupportTransaction = async () => {
  const scope = transactionAuthorization.getStore();
  // Persisted background jobs use their own authorization after dispatch. A
  // copied async context must not depend on an already finished browser request.
  if (scope?.active) await scope.authorize();
};

const supportIdentity = Symbol('mobile.platform.support');
export function attachMobileSupport(req, context, platformSession) {
  if (!context?.platformAdmin || context.user?.id !== '__platform-admin' || context.actualUser?.id !== '__platform-admin'
    || platformSession?.actor?.platformAdmin !== true || platformSession.mustChangePassword || context.organisationId !== platformSession.organisationId) return false;
  Object.defineProperty(req, supportIdentity, { value: { context, platformSession }, configurable: true });
  return true;
}
export function mobileSupportIdentity(req) {
  const value = req[supportIdentity];
  return value && getPlatformContext(req) === value.context ? value : undefined;
}

/** No personnel, employment or credential row is provisioned for support. The
 * current registered platform principal supplies the operational permissions. */
export function mobileSupportPrincipal(state, req) {
  const support = mobileSupportIdentity(req);
  if (!support) return undefined;
  const current = state.pricing?.users?.find(user => user.id === '__platform-admin' && user.active !== false && user.level === 'Systemadmin');
  if (!current) return undefined;
  const siteIds = (state.logistics?.sites ?? []).filter(site => site.active !== false && (!current.siteIds || current.siteIds.includes(site.id))).map(site => site.id);
  return { support,
    session: { tokenHash: support.context.sessionKey, expiresAt: support.context.expiresAt },
    account: { username: support.platformSession.actor.username },
    person: { id: '__platform-admin', userId: '__platform-admin', name: support.platformSession.actor.name,
      kind: 'external', role: 'Systemadmin', team: 'Systemadministration', phone: '', email: '', active: true, siteIds },
    principal: { actor: { ...current, name: support.platformSession.actor.name }, user: { ...current, name: support.platformSession.actor.name } } };
}
