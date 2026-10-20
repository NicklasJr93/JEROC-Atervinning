import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeAddress, addressError, normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';

const clone = value => structuredClone(value);
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const clean = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const text = max => z.string().max(max).refine(value => !/[\u0000-\u001f\u007f]/.test(value)).transform(clean);
const email = z.string().max(254).trim().refine(value => !value || z.string().email().safeParse(value).success);
const recipients = z.array(z.string().trim().max(254).email()).max(10)
  .transform(values => [...new Set(values.map(value => value.toLowerCase()))]);
const profileSchema = z.object({
  name: text(200).refine(value => value.length > 0), address: text(300), postalCode: text(10), city: text(150),
  countryCode: z.literal('SE'), phone: text(64), email, invoiceEmail: email, contactPerson: text(200), website: text(300),
}).strict();
const documentsSchema = z.object({
  footerText: z.string().max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    .transform(value => value.normalize('NFKC').replace(/\r\n?/g, '\n').trim()),
  logoId: z.string().uuid().optional(),
}).strict();
const defaultsSchema = z.object({ paymentTermsDays: z.number().int().min(0).max(365).nullable() }).strict();
const notificationsSchema = z.object({ customerInquiries: recipients, bookings: recipients, integrationErrors: recipients }).strict();
const groupsSchema = z.object({ profile: profileSchema, documents: documentsSchema,
  defaults: defaultsSchema, notifications: notificationsSchema }).strict();
const saveSchema = groupsSchema.extend({ expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const storedSchema = groupsSchema.extend({ companyId: identifier, version: z.number().int().positive(),
  updatedAt: z.string().datetime(), updatedBy: z.object({ actorId: identifier, userId: identifier }).strict() }).strict();

export class CompanySettingsError extends Error {
  constructor(message, status = 422, code = 'company_settings_invalid') {
    super(message); this.name = 'CompanySettingsError'; this.status = status; this.code = code;
  }
}
const fail = (message, status, code) => { throw new CompanySettingsError(message, status, code); };

function normalizeGroups(groups) {
  const parsed = groupsSchema.safeParse(groups);
  if (!parsed.success) fail('Kontrollera företagets uppgifter, kontaktadresser och standardval.', 422);
  const value = parsed.data;
  const invalidAddress = addressError(value.profile);
  if (invalidAddress) fail(invalidAddress, 422);
  const invalidPhone = phoneNumberError(value.profile.phone);
  if (invalidPhone) fail(invalidPhone, 422);
  value.profile = { ...value.profile, ...normalizeAddress(value.profile), phone: normalizePhoneNumber(value.profile.phone) };
  if (value.profile.website) {
    let website;
    try { website = new URL(value.profile.website); } catch { fail('Ange en fullständig webbadress som börjar med https:// eller http://.', 422); }
    if (!['http:', 'https:'].includes(website.protocol) || website.username || website.password)
      fail('Ange en webbadress utan inloggningsuppgifter som börjar med https:// eller http://.', 422);
    value.profile.website = website.href;
    if (value.profile.website.length > 300) fail('Webbadressen är för lång.', 422);
  }
  return value;
}

/** JSON-only input. Company/session identities are always supplied by the server. */
export function parseCompanySettingsInput(input) {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) fail('Kontrollera företagets uppgifter, kontaktadresser och standardval.', 422);
  const { expectedVersion, ...groups } = parsed.data;
  return { expectedVersion, ...normalizeGroups(groups) };
}

/** The repository is already bound to the server-selected tenant. Neither a
 * request header nor a form field can select its schema, company or legal ID.
 * Writes use the repository's existing aggregate transaction, modifying only
 * metadata. The repository supports domain selection for reads, not writes.
 */
export function createCompanySettingsService({ organisationId, company, getRepository, validateLogo, now = () => new Date() } = {}) {
  if (!identifier.safeParse(organisationId).success || company?.id !== organisationId || !company.name?.trim()
    || typeof getRepository !== 'function') throw new TypeError('En servervald bolagsidentitet och dess databas krävs.');
  const legal = Object.freeze({ id: organisationId, name: company.name, number: company.organisationNumber ?? company.number ?? '', vat: company.vat ?? '' });
  const initial = () => ({ companyId: organisationId, version: 0,
    profile: { name: legal.name, address: company.address ?? '', postalCode: company.postalCode ?? '', city: company.city ?? '',
      countryCode: 'SE', phone: company.phone ?? '', email: company.email ?? '', invoiceEmail: company.invoiceEmail ?? '',
      contactPerson: company.contactPerson ?? '', website: company.website ?? '' },
    documents: { footerText: '' }, defaults: { paymentTermsDays: null },
    notifications: { customerInquiries: [], bookings: [], integrationErrors: [] } });
  function current(state) {
    const value = state.metadata?.companySettings;
    if (value === undefined) return initial();
    const parsed = storedSchema.safeParse(value);
    if (!parsed.success || parsed.data.companyId !== organisationId)
      fail('Företagsinställningarna kunde inte läsas för det valda bolaget.', 503, 'company_settings_unavailable');
    return parsed.data;
  }
  function response(value, canManage = false) {
    const { updatedBy: _updatedBy, ...safe } = value;
    return { ...clone(safe), organisationNumber: legal.number, capabilities: { canManage: canManage === true } };
  }
  function principalScope(principal) {
    if (!principal || principal.companyId !== organisationId || !identifier.safeParse(principal.actorId).success
      || !identifier.safeParse(principal.userId).success || typeof principal.scopeKey !== 'string' || !principal.scopeKey)
      fail('Du saknar behörighet för det valda bolaget.', 403, 'company_settings_forbidden');
    return principal;
  }
  async function get() {
    return (await getRepository()).read(state => response(current(state)), { domains: ['metadata'] });
  }
  async function save(input, principal, { reauthorize } = {}) {
    principalScope(principal);
    if (principal.canManage !== true || typeof reauthorize !== 'function')
      fail('Du saknar behörighet att ändra företagsinställningar.', 403, 'company_settings_forbidden');
    const { expectedVersion, ...groups } = parseCompanySettingsInput(input);
    const repository = await getRepository();
    return repository.transact(async (state, _revision, audit) => {
      const previous = current(state);
      if (previous.version !== expectedVersion)
        fail('Företagsinställningarna har ändrats av någon annan. Hämta den senaste versionen innan du sparar.', 409, 'company_settings_version_conflict');
      if (groups.documents.logoId && groups.documents.logoId !== previous.documents.logoId) {
        if (typeof validateLogo !== 'function' || !await validateLogo(groups.documents.logoId))
          fail('Logotypen finns inte i bolagets bildarkiv. Välj en uppladdad logotyp igen.', 422, 'company_settings_logo_invalid');
      }
      // This check intentionally occurs inside the locked mutation, after any
      // asynchronous asset lookup. Revoked/switching sessions cannot commit.
      const fresh = principalScope(await reauthorize());
      if (fresh.scopeKey !== principal.scopeKey || fresh.actorId !== principal.actorId || fresh.userId !== principal.userId)
        fail('Bolaget eller kontot har ändrats. Öppna företagsinställningarna igen.', 409, 'company_settings_scope_changed');
      if (fresh.canManage !== true)
        fail('Du saknar behörighet att ändra företagsinställningar.', 403, 'company_settings_forbidden');
      const at = new Date(now()).toISOString();
      const changedFields = Object.keys(groups).filter(key => JSON.stringify(groups[key]) !== JSON.stringify(previous[key]));
      if (!changedFields.length) return response(previous, true);
      if (previous.version >= Number.MAX_SAFE_INTEGER)
        fail('Företagsinställningarnas versionsnummer kan inte uppdateras.', 503, 'company_settings_unavailable');
      const next = { companyId: organisationId, version: previous.version + 1, ...groups,
        updatedAt: at, updatedBy: { actorId: principal.actorId, userId: principal.userId } };
      state.metadata ??= {};
      state.metadata.companySettings = clone(next);
      const event = { id: randomUUID(), at, companyId: organisationId, actorId: principal.actorId, userId: principal.userId,
        action: 'company.settings.saved', version: next.version, changedFields };
      state.metadata.companySettingsAudit = [...(Array.isArray(state.metadata.companySettingsAudit) ? state.metadata.companySettingsAudit : []), event].slice(-1000);
      if (Array.isArray(audit)) audit.push(clone(event));
      return response(next, true);
    });
  }
  async function basicSettings() {
    const value = await get();
    return { companyId: organisationId, version: value.version, defaults: value.defaults, profile: { name: value.profile.name },
      ...(value.documents.logoId ? { logoUrl: `/api/company-settings/logos/${value.documents.logoId}` } : {}) };
  }
  async function documentProfile() {
    const value = await get();
    return { id: organisationId, ...clone(value.profile), number: legal.number, vat: legal.vat,
      footerText: value.documents.footerText, ...(value.documents.logoId ? { logoId: value.documents.logoId } : {}) };
  }
  return Object.freeze({ organisationId, get, save, basicSettings, documentProfile });
}
