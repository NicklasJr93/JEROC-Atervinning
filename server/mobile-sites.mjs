// A personnel session always uses the intersection of the person's facilities
// and the linked account's current scope. The tenant supplies the site catalog.
export const employeeSites = (siteCatalog, person, user) => siteCatalog.filter(site =>
  site.active !== false && person.siteIds.includes(site.id)
  && (!Array.isArray(user.siteIds) || user.siteIds.includes(site.id)));

export const employeeCompanyId = (env, state) => env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID
  ?? state.metadata?.organisation?.id ?? 'jeroc-demo';

export function employeeActiveSite(state, companyId, personId, sites) {
  const saved = state.metadata?.mobileEmployeeActiveSites?.find(value => value.companyId === companyId && value.personId === personId);
  return sites.some(site => site.id === saved?.siteId) ? saved.siteId : sites[0]?.id;
}

export function saveEmployeeActiveSite(state, companyId, personId, siteId) {
  state.metadata ??= {};
  // Records avoid arbitrary tenant/person IDs becoming object property names.
  state.metadata.mobileEmployeeActiveSites = (state.metadata.mobileEmployeeActiveSites ?? [])
    .filter(value => value.companyId !== companyId || value.personId !== personId)
    .concat({ companyId, personId, siteId });
}
