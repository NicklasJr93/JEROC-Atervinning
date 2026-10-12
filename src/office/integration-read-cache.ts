import type { OfficeUser } from './model';
import type { EnvironmentSessionState } from './environment-types';

// Only authenticated projections live here, never credentials or persisted
// browser storage. A new session/permission/site scope cannot reuse a prior
// person's result. Server revisions remain authoritative for every save.
const cache = new Map<string, { value: unknown; savedAt: number }>();
const freshFor = 20_000;
const retainFor = 120_000;
const userScope = (user: OfficeUser) => [user.id, user.level, [...user.permissions].sort().join(','), user.siteIds ? [...user.siteIds].sort().join(',') : 'all'];

export function integrationReadScope(actualUser: OfficeUser, user: OfficeUser, session?: EnvironmentSessionState) {
  if (!session || session.actualUserId !== actualUser.id || session.effectiveUserId !== user.id) return '';
  return JSON.stringify([userScope(actualUser), userScope(user), session.csrfToken, session.expiresAt]);
}

export function cachedIntegrationRead<T>(resource: string, scope: string): { value: T; fresh: boolean } | undefined {
  if (!scope) return;
  const key = `${resource}:${scope}`, entry = cache.get(key);
  if (!entry) return;
  const age = Date.now() - entry.savedAt;
  if (age > retainFor || age < 0) { cache.delete(key); return; }
  return { value: structuredClone(entry.value) as T, fresh: age < freshFor };
}

export function cacheIntegrationRead<T>(resource: string, scope: string, value: T) {
  if (!scope) return;
  const key = `${resource}:${scope}`;
  cache.delete(key);
  cache.set(key, { value: structuredClone(value), savedAt: Date.now() });
  // The cached accounting projection includes its company and settings
  // revision together; choices can never be joined to another company's form.
  while (cache.size > 12) cache.delete(cache.keys().next().value!);
}

export function clearIntegrationReadCache(resource?: string) {
  if (!resource) { cache.clear(); return; }
  for (const key of cache.keys()) if (key.startsWith(`${resource}:`)) cache.delete(key);
}
