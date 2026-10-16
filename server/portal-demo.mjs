import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { migrateOffice, seedOffice, seedTransport } from '../dist-server/domain-models.mjs';

const marker = 'portal-demo-v1';
const originalCustomer = migrateOffice(seedOffice()).customers.find(value => value.id === 'customer-build');
const originalDriver = seedTransport().drivers.find(value => value.id === 'oskar');
const originalCarrier = { id: 'carrier-roslagen', name: 'Roslagens Åkeri AB', number: '559123-7890',
  contact: 'Maria Lind', phone: '070-222 33 44', email: 'transport@roslagensakeri.example' };
const sameFields = (value, original, fields) => Boolean(value && original && fields.every(key => value[key] === original[key]));
const customerIdentity = ['id', 'name', 'type', 'customerNumber', 'email'];
const fixtures = {
  driver: { id: 'portal-demo-driver-v1', label: 'Demo · Chaufför Oskar', username: 'demo.chauffor', password: 'ChaufforDemo2026!', personId: 'person-oskar' },
  carrier: { id: 'portal-demo-carrier-v1', label: 'Demo · Roslagens Åkeri', username: 'demo.akeri', password: 'AkeriDemo2026!', subjectId: 'carrier-roslagen' },
  customer: { id: 'portal-demo-customer-v1', label: 'Demo · Bygg & Riv', username: 'demo.kund', password: 'KundDemo2026!', subjectId: 'customer-build' },
};
const companyId = (state, env) => env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? state.metadata?.organisation?.id ?? 'jeroc-demo';
function demoEnabled(state, env) {
  return env.JEROC_DEMO_AUTO_SESSION !== 'false' && companyId(state, env) === 'jeroc-demo'
    && (!env.JEROC_TENANT_ID || env.JEROC_TENANT_ID === 'jeroc-demo')
    && (!state.metadata?.organisation?.id || state.metadata.organisation.id === 'jeroc-demo')
    && state.metadata?.pricingSeed?.users?.some(user => user.id === 'admin' && user.name === 'Systemadmin' && user.level === 'Systemadmin')
    && sameFields(state.metadata?.transportSeed?.drivers?.find(value => value.id === 'oskar'), originalDriver, ['id', 'name', 'vehicleId'])
    && sameFields(state.metadata?.officeSeed?.customers?.find(value => value.id === 'customer-build'), originalCustomer, customerIdentity);
}
const accountsFor = (state, kind) => (kind === 'driver' ? state.personnelAuth : state.logisticsAuth)?.accounts ?? [];
function originalSubject(state, kind) {
  if (kind === 'customer') return sameFields(state.office?.customers?.find(value => value.id === 'customer-build'), originalCustomer, customerIdentity);
  if (!sameFields(state.personnel?.companies?.find(value => value.id === 'carrier-roslagen'), originalCarrier, ['id', 'name', 'email'])) return false;
  if (kind === 'carrier') return true;
  const person = state.personnel?.people?.find(value => value.id === 'person-oskar');
  const driver = state.transport?.drivers?.find(value => value.id === 'oskar');
  return Boolean(person?.active === true && person.kind === 'external' && person.name === 'Oskar Lind'
    && person.userId === undefined && person.companyId === 'carrier-roslagen' && person.driverId === 'oskar' && person.canDrive === true
    && person.email === 'oskar@roslagensakeri.example' && Array.isArray(person.siteIds) && person.siteIds.length > 0
    && person.siteIds.every(id => state.logistics?.sites?.some(site => site.id === id && site.active !== false))
    && driver?.id === 'oskar' && driver.active !== false && driver.personId === person.id && driver.companyId === person.companyId);
}
function matchesAccount(account, kind) {
  const fixture = fixtures[kind];
  return Boolean(fixture && account?.demoFixture === marker && account.id === fixture.id && account.username === fixture.username
    && (kind === 'driver' ? account.personId === fixture.personId : account.kind === kind && account.subjectId === fixture.subjectId));
}
function passwordValid(password, stored) {
  if (typeof stored?.salt !== 'string' || typeof stored?.digest !== 'string') return false;
  try { const actual = scryptSync(password, stored.salt, 64), expected = Buffer.from(stored.digest, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected); } catch { return false; }
}

/** Normal private accounts keep their login rules. Marked public fixtures are
 * disabled with demo mode, including when their password has been rotated. */
export function portalDemoAccountAllowed(state, kind, account, env = process.env) {
  return account?.demoFixture !== marker || Boolean(demoEnabled(state, env) && matchesAccount(account, kind) && originalSubject(state, kind));
}

// Account editors may change credentials and status, but cannot remove trusted
// fixture provenance while retaining a previously published password.
export const portalDemoAccountMetadata = account => account?.demoFixture === marker ? { id: account.id, demoFixture: marker } : {};

/** Called only in the existing startup transaction. One durable attempt also
 * records skipped/colliding fixtures so deletion or rotation is never reset. */
export function ensurePortalDemoAccounts(state, env = process.env) {
  if (!demoEnabled(state, env) || state.metadata.portalDemoSeedVersion >= 1) return;
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const accounts = accountsFor(state, kind);
    if (!originalSubject(state, kind) || accounts.some(account => account.id === fixture.id || account.username === fixture.username
      || (kind === 'driver' ? account.personId === fixture.personId : account.kind === kind && account.subjectId === fixture.subjectId))) continue;
    const salt = randomBytes(24).toString('hex'), at = new Date().toISOString();
    accounts.push({ id: fixture.id, demoFixture: marker, username: fixture.username, active: true,
      ...(kind === 'driver' ? { personId: fixture.personId, siteIds: [...state.personnel.people.find(person => person.id === fixture.personId).siteIds] } : { kind, subjectId: fixture.subjectId }),
      createdAt: at, updatedAt: at, password: { salt, digest: scryptSync(fixture.password, salt, 64).toString('hex') } });
  }
  state.personnel.externalAccounts = state.personnelAuth.accounts.map(({ password, ...account }) => account);
  state.metadata.portalDemoSeedVersion = 1;
}

/** A read-only allowlist projection; no stored credential or arbitrary account
 * is ever returned. Only the published fixture password is compared and sent. */
export function portalDemoConfig(state, kind, env = process.env) {
  const fixture = fixtures[kind], accounts = accountsFor(state, kind), account = accounts.find(value => matchesAccount(value, kind));
  const available = Boolean(fixture && state.metadata?.portalDemoSeedVersion >= 1 && demoEnabled(state, env) && account?.active === true
    && accounts.filter(value => value.username === fixture.username).length === 1 && portalDemoAccountAllowed(state, kind, account, env)
    && passwordValid(fixture.password, account.password));
  const id = companyId(state, env);
  return { companyId: id, companyName: state.metadata?.organisation?.name ?? (id === 'jeroc-demo' ? 'JEROC Återvinning AB' : ''),
    enabled: available, accounts: available ? [Object.fromEntries(['id', 'label', 'username', 'password'].map(key => [key, fixture[key]]))] : [] };
}
