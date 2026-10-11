import type { AccountingSettings } from './accounting-types';

type SiteSettings = AccountingSettings['sites'][number];
type SettingsObject = Record<string, unknown>;

const isObject = (value: unknown): value is SettingsObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => equal(left[key], right[key]));
}

/** Untouched fields follow the latest settings; local edits win a conflict. */
function mergeValue(base: unknown, local: unknown, remote: unknown): unknown {
  if (equal(local, base)) return structuredClone(remote);
  if (!isObject(local) || !isObject(remote)) return structuredClone(local);
  const previous = isObject(base) ? base : {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(remote), ...Object.keys(local)]);
  const merged: SettingsObject = {};
  for (const key of keys) {
    const value = mergeValue(previous[key], local[key], remote[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeSite(base: SiteSettings | undefined, local: SiteSettings | undefined, remote: SiteSettings | undefined): SiteSettings | undefined {
  // A new JEROC site receives this mapping automatically before the user edits
  // it. It must not replace a mapping another administrator has since saved.
  const previous = base ?? (local && remote ? { siteId: local.siteId, useDefaults: true } : undefined);
  const merged = mergeValue(previous, local, remote) as SiteSettings | undefined;
  if (!merged) return undefined;
  if (local && (!equal(local.useDefaults, previous?.useDefaults) || !equal(local.accountOverrides, previous?.accountOverrides))) {
    merged.useDefaults = local.useDefaults;
  }
  if (merged.useDefaults) delete merged.accountOverrides;
  return merged;
}

export function mergeSpirisSettings(base: AccountingSettings, local: AccountingSettings, remote: AccountingSettings): AccountingSettings {
  const merged = mergeValue(base, local, remote) as AccountingSettings;
  const baseSites = new Map(base.sites.map(site => [site.siteId, site]));
  const localSites = new Map(local.sites.map(site => [site.siteId, site]));
  const remoteSites = new Map(remote.sites.map(site => [site.siteId, site]));
  const siteIds = new Set([...remoteSites.keys(), ...localSites.keys(), ...baseSites.keys()]);
  merged.sites = [...siteIds].flatMap(siteId => {
    const site = mergeSite(baseSites.get(siteId), localSites.get(siteId), remoteSites.get(siteId));
    return site ? [site] : [];
  });

  // The selected provider term and its day count describe one choice.
  const termChanged = local.paymentTermsId !== base.paymentTermsId || local.paymentTermDays !== base.paymentTermDays;
  const term = termChanged ? local : remote;
  merged.paymentTermDays = term.paymentTermDays;
  if (term.paymentTermsId === undefined) delete merged.paymentTermsId;
  else merged.paymentTermsId = term.paymentTermsId;
  merged.revision = remote.revision;
  return merged;
}
