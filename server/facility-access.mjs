import { isDeepStrictEqual } from 'node:util';

const copy = value => structuredClone(value);
const ids = value => [...new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : [])];
const sameIds = (a, b) => isDeepStrictEqual([...ids(a)].sort(), [...ids(b)].sort());
const key = value => JSON.stringify([value.kind, value.personId, value.userId ?? null]);
const timestamp = now => (typeof now === 'function' ? now() : now ?? new Date()).toISOString();

function accessState(state) {
  state.metadata ??= {};
  state.metadata.facilityAccess ??= { version: 1, links: [], conflicts: [] };
  state.metadata.facilityAccess.links ??= [];
  state.metadata.facilityAccess.conflicts ??= [];
  return state.metadata.facilityAccess;
}
function linkedAccounts(state) {
  const users = new Map((state.pricing?.users ?? []).map(user => [user.id, user]));
  const external = new Map((state.personnelAuth?.accounts ?? []).map(account => [account.personId, account]));
  return (state.personnel?.people ?? []).flatMap(person => {
    if (person.kind === 'employee' && person.userId)
      return [{ person, account: users.get(person.userId), source: 'pricing', kind: 'staff', personId: person.id, userId: person.userId }];
    if (person.kind === 'employee' && external.has(person.id))
      return [{ person, account: external.get(person.id), source: 'credentials', kind: 'staff', personId: person.id }];
    if (person.kind === 'external' && external.has(person.id))
      return [{ person, account: external.get(person.id), source: 'credentials', kind: 'external', personId: person.id }];
    return [];
  });
}

/** Migrate only previously unregistered links. The former effective intersection
 * becomes the account scope, never a union or an implicit new grant. */
export function migratePersonnelFacilityAccess(state, { siteCatalog, now } = {}) {
  if (!state.personnel) return;
  const access = accessState(state), registered = new Set(access.links.map(key));
  const at = timestamp(now);
  let changedUsers = false;
  for (const link of linkedAccounts(state)) {
    if (registered.has(key(link))) continue;
    const previousPersonSiteIds = ids(link.person.siteIds);
    const previousAccountSiteIds = Array.isArray(link.account?.siteIds) ? ids(link.account.siteIds) : null;
    const effectiveSiteIds = !link.account ? [] : previousAccountSiteIds === null ? previousPersonSiteIds
      : previousPersonSiteIds.filter(id => previousAccountSiteIds.includes(id));
    if (link.account) {
      if (link.source === 'pricing' && (previousAccountSiteIds === null || !sameIds(link.account.siteIds, effectiveSiteIds))) changedUsers = true;
      link.account.siteIds = [...effectiveSiteIds];
    }
    if (!link.account || previousAccountSiteIds === null && link.kind === 'staff'
      || previousAccountSiteIds !== null && (!sameIds(previousPersonSiteIds, previousAccountSiteIds))) {
      access.conflicts.push({ id: key(link), kind: link.kind, personId: link.personId,
        ...(link.userId ? { userId: link.userId } : {}), previousPersonSiteIds, previousAccountSiteIds,
        effectiveSiteIds: [...effectiveSiteIds], createdAt: at });
    }
    const record = { kind: link.kind, personId: link.personId, ...(link.userId ? { userId: link.userId } : {}) };
    access.links.push(record); registered.add(key(link));
  }
  if (changedUsers) {
    state.pricing.revision = (state.pricing.revision ?? 0) + 1;
    if (state.office) state.office.users = copy(state.pricing.users);
  }
  syncPersonnelFacilityAccess(state, { siteCatalog });
}

/** Use after an authorised account/link write, and on read copies after startup
 * migration. It deliberately never intersects with stale personnel membership. */
export function syncPersonnelFacilityAccess(state, { siteCatalog,
  confirmedUserIds = [], confirmedExternalPersonIds = [], now } = {}) {
  if (!state.personnel) return;
  const access = accessState(state), registered = new Set(access.links.map(key));
  if (Array.isArray(siteCatalog)) access.siteIds = ids(siteCatalog.map(site => site.id));
  const allSiteIds = access.siteIds;
  const staffConfirmed = new Set(confirmedUserIds), externalConfirmed = new Set(confirmedExternalPersonIds);
  const at = timestamp(now);
  let changedPeople = false;
  for (const link of linkedAccounts(state)) {
    // Removing an office-account link must not turn its surviving credentials
    // into an unrestricted account. Preserve the last materialised safe scope.
    if (link.source === 'credentials' && !Array.isArray(link.account?.siteIds)) link.account.siteIds = ids(link.person.siteIds);
    const scope = !link.account ? [] : Array.isArray(link.account.siteIds) ? ids(link.account.siteIds)
      : allSiteIds ?? ids(link.person.siteIds);
    if (!sameIds(link.person.siteIds, scope)) {
      link.person.siteIds = [...scope]; link.person.revision = (link.person.revision ?? 0) + 1; changedPeople = true;
    }
    if (!registered.has(key(link))) {
      access.links.push({ kind: link.kind, personId: link.personId, ...(link.userId ? { userId: link.userId } : {}) });
      registered.add(key(link));
    }
    if (link.kind === 'staff' ? staffConfirmed.has(link.userId) : externalConfirmed.has(link.personId)) {
      const conflict = access.conflicts.find(item => item.id === key(link) && !item.resolvedAt);
      if (conflict) conflict.resolvedAt = at;
    }
  }
  if (changedPeople) state.personnel.revision = (state.personnel.revision ?? 0) + 1;
  if (state.personnelAuth && state.personnel.externalAccounts)
    state.personnel.externalAccounts = state.personnelAuth.accounts.map(({ password, ...account }) => copy(account));
}

/** Current permission scope, independent of organisational/personnel membership.
 * Missing linked accounts fail closed. External credentials retain own-job ACLs. */
export function personnelFacilityScope(state, person, siteCatalog) {
  const pricingLinked = person.kind === 'employee' && person.userId;
  const account = pricingLinked ? state.pricing?.users?.find(user => user.id === person.userId)
    : state.personnelAuth?.accounts?.find(account => account.personId === person.id);
  if (!pricingLinked && account && !Array.isArray(account.siteIds))
    return ids(state.personnel?.people?.find(saved => saved.id === person.id)?.siteIds ?? person.siteIds);
  if (pricingLinked || account)
    return account ? (Array.isArray(account.siteIds) ? ids(account.siteIds)
      : Array.isArray(siteCatalog) ? ids(siteCatalog.map(site => site.id)) : state.metadata?.facilityAccess?.siteIds ?? ids(person.siteIds)) : [];
  return ids(person.siteIds);
}
