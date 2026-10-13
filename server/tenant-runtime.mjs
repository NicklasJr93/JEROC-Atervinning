import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { officeSchema, seedOffice, personSchema } from '../dist-server/domain-models.mjs';
import { z } from 'zod';

const legacyOrganisation = 'jeroc-demo';
const tenantIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const storageSchemaPattern = /^jeroc_t_[a-z0-9]{16,48}$/;
const sharedVismaOptions = new Set(['VISMA_CLIENT_ID', 'VISMA_CLIENT_SECRET', 'VISMA_TOKEN_ENCRYPTION_KEY',
  'VISMA_REDIRECT_URI', 'VISMA_OAUTH_LOCAL_RELAY', 'VISMA_ENVIRONMENT']);
const databaseFiles = {
  JEROC_APPLICATION_DB_PATH: 'application.sqlite', JEROC_ENVIRONMENT_DB_PATH: 'environment.sqlite',
  JEROC_TERMINAL_DB_PATH: 'terminal-demo.sqlite', JEROC_DOCUMENT_DB_PATH: 'documents.sqlite',
  JEROC_ARTICLE_MEDIA_DB_PATH: 'article-media.sqlite',
  JEROC_SICKNESS_FILES_DB_PATH: 'sickness-files.sqlite',
};
const defaultDataRoot = fileURLToPath(new URL('../.data/', import.meta.url));
const copy = value => structuredClone(value);

function verifiedTenant(tenant) {
  if (!tenant || typeof tenant.id !== 'string' || !tenantIdPattern.test(tenant.id))
    throw new TypeError('Bolaget behöver ett giltigt servervalt ID.');
  return tenant;
}

/** Only call with a tenant record retrieved from the platform registry. This
 * function never reads a browser header, requested schema, or integration key.
 * Each module's pool receives the SAME URL/options so nested database commands
 * share one scoped transaction. An absent schema fails instead of using public.
 */
export function tenantRuntimeEnvironment(baseEnv, tenant) {
  verifiedTenant(tenant);
  const env = { ...baseEnv, JEROC_TENANT_ID: tenant.id, SCRAPPILOT_ORGANISATION_ID: tenant.id };
  if (tenant.id === legacyOrganisation) return env;
  env.JEROC_DEMO_AUTO_SESSION = 'false';
  delete env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD;
  for (const key of Object.keys(env)) {
    if (key.startsWith('NVV_') || key.startsWith('VISMA_') && !sharedVismaOptions.has(key)) delete env[key];
  }
  if (env.DATABASE_URL) {
    if (!storageSchemaPattern.test(tenant.storageSchema ?? ''))
      throw new TypeError('Bolaget saknar ett giltigt servervalt databasschema.');
    const database = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new TypeError('Bolagsdatabasen behöver PostgreSQL.');
    // Replace an inherited search_path/options in full. No comma/public fallback
    // and no externally supplied options can redirect unqualified repository SQL.
    database.searchParams.set('options', `-c search_path=${tenant.storageSchema}`);
    env.DATABASE_URL = database.toString();
  }
  const folder = join(resolve(baseEnv.JEROC_TENANT_DATA_DIR ?? defaultDataRoot), 'tenants', tenant.id);
  for (const [key, filename] of Object.entries(databaseFiles)) env[key] = join(folder, filename);
  return env;
}

/** An organisation starts with one real facility, without invented permit,
 * address, municipality, capacity or financial information. */
export function tenantInitialSites(tenant, suppliedSite) {
  verifiedTenant(tenant);
  const site = suppliedSite ?? tenant.site ?? {};
  const value = {
    id: site.id ?? 'main', name: site.name ?? tenant.name ?? 'Huvudanläggning',
    address: site.address ?? '', postalCode: site.postalCode ?? '', city: site.city ?? '',
    municipalityCode: site.municipalityCode ?? '', active: true,
  };
  if (!tenantIdPattern.test(value.id) || typeof value.name !== 'string' || !value.name.trim())
    throw new TypeError('Bolagets första anläggning behöver giltigt ID och namn.');
  return [value];
}

/** No demo customer/article/price/personnel/transport data is copied. The owner
 * hash is supplied by provisioning, never generated from a known demo password.
 * An initial temporary password cannot log into the mobile/driver APIs before
 * the platform's mandatory password-change callback activates this account.
 */
export function createTenantApplicationState({ tenant, owner, site, now = new Date() }) {
  verifiedTenant(tenant);
  if (tenant.id === legacyOrganisation) throw new TypeError('JEROC:s befintliga startvärden får inte ersättas med ett tomt bolag.');
  if (!owner || !tenantIdPattern.test(owner.id ?? '') || !tenantIdPattern.test(owner.personId ?? '')
    || typeof owner.name !== 'string' || !owner.name.trim()
    || typeof owner.username !== 'string' || owner.username.length < 3 || owner.username.length > 200
    || !(/^[a-zA-Z0-9._-]+$/.test(owner.username) && owner.username.length <= 80 || z.string().email().safeParse(owner.username).success)
    || !/^[a-f0-9]{48}$/i.test(owner.passwordHash?.salt ?? '') || !/^[a-f0-9]{128}$/i.test(owner.passwordHash?.digest ?? ''))
    throw new TypeError('Bolaget behöver en verklig VD-identitet med ett säkert lösenordshash.');
  const at = new Date(now).toISOString(), sites = tenantInitialSites(tenant, site);
  const user = officeSchema.shape.users.element.parse({ id: owner.id, name: owner.name, level: 'VD',
    permissions: owner.permissions ?? [...officeSchema.shape.users.element.shape.permissions.element.options],
    maxAttest: owner.maxAttest ?? 0, ownAttest: owner.ownAttest ?? false, active: true });
  const person = personSchema.parse({ id: owner.personId, userId: user.id, name: user.name, kind: 'employee', active: true,
    role: 'VD', team: '', siteIds: sites.map(value => value.id), phone: owner.phone ?? '', email: owner.email ?? '',
    address: '', canDrive: false, revision: 0 });
  // Retain current schema/migration markers without retaining any seeded row.
  // migrateOffice's old explicit demo-reset must not introduce fixture cards.
  const office = officeSchema.parse({ ...seedOffice(), users: [user], cards: [], customers: [], payments: [], corrections: [] });
  const pricing = { revision: 0, lme: [], articleHistory: [], groups: [], customerPrices: [], users: [copy(user)],
    customers: [], snapshots: [], ledger: [], audit: [] };
  const transport = { version: 1, revision: 0, orders: [], drivers: [], vehicles: [], preliminary: {}, events: [] };
  const account = { personId: person.id, username: owner.username.toLowerCase(), active: owner.mustChangePassword !== true,
    createdAt: at, updatedAt: at, password: copy(owner.passwordHash) };
  const { password, ...publicAccount } = account;
  return {
    metadata: { version: 1, nextCard: 3000, importedDomains: [], mobileEmployeeSeedVersion: 2,
      organisation: { id: tenant.id, name: tenant.name ?? '', number: tenant.organisationNumber ?? tenant.number ?? '' },
      pricingSeed: copy(pricing), officeSeed: copy(office), transportSeed: copy(transport) },
    pricing, office, transport, mobile: { version: 1, drafts: [], customers: [] },
    personnel: { version: 1, revision: 0, people: [person], companies: [], employment: [], salaries: [], schedules: [],
      absences: [], competencies: [], staffingTasks: [], externalAccounts: [publicAccount], audit: [] },
    personnelAuth: { accounts: [account], sessions: [], attempts: [] },
    employeeTime: { version: 1, revision: 0, settings: [], requirementHistory: [], normativeHistory: [], entries: [],
      orderSessions: [], leaveRequests: [], audit: [] },
    logistics: { version: 1, revision: 0, sites: copy(sites), classifications: [], vessels: [], agreements: [], requests: [],
      inventoryMovements: [], incomingProjection: {}, details: {}, deliveryOutbox: [], audit: [], idempotency: {} },
    logisticsAuth: { accounts: [], sessions: [], attempts: [] },
    workOrderWeighing: { version: 1, drafts: {} }, outbox: [], imports: [],
  };
}
