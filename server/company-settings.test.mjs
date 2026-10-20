import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { createCompanySettingsService, parseCompanySettingsInput, CompanySettingsError } from './company-settings.mjs';

const legal = { id: 'company-a', name: 'Exempelbolag A AB', organisationNumber: '5593593626', vat: 'SE559359362601' };
const principal = { companyId: legal.id, actorId: 'actual-a', userId: 'effective-a', scopeKey: 'company-a/session-a/generation-a', canManage: true };
const frozenDocument = { id: 'old-document', companySnapshot: { id: legal.id, name: 'Ursprunglig PDF-identitet', number: legal.organisationNumber }, hash: 'unchanged-proof' };
const seed = () => ({ metadata: { organisation: { id: legal.id }, retained: 'existing-metadata' }, office: { documents: [structuredClone(frozenDocument)] }, pricing: { users: [] }, mobile: { drafts: [] }, imports: [] });
const hasStatus = (status, code) => error => error instanceof CompanySettingsError && error.status === status && (!code || error.code === code);
const inputOf = value => ({ expectedVersion: value.version, profile: structuredClone(value.profile), documents: structuredClone(value.documents),
  defaults: structuredClone(value.defaults), notifications: structuredClone(value.notifications) });

async function fixture(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-company-settings-'));
  const repositories = [];
  async function create(name = 'a', company = legal, extra = {}) {
    const repository = await createApplicationRepository({ env: {}, filename: join(directory, `${name}.sqlite`), seed });
    repositories.push(repository);
    const service = createCompanySettingsService({ organisationId: company.id, company, getRepository: async () => repository,
      now: () => new Date('2026-10-20T10:00:00.000Z'), ...options, ...extra });
    return { repository, service, save: value => service.save(value, principal, { reauthorize: async () => principal }) };
  }
  try { await run({ ...await create(), create }); }
  finally { for (const repository of repositories) await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('initial scoped company settings are read-only defaults, without copied contacts or writes', () => fixture(async f => {
  const before = await f.repository.read((state, revision) => ({ state, revision }));
  const value = await f.service.get();
  assert.equal(value.companyId, legal.id); assert.equal(value.organisationNumber, legal.organisationNumber); assert.equal(value.version, 0);
  assert.equal(value.profile.name, legal.name); assert.equal(value.profile.phone, ''); assert.equal(value.profile.invoiceEmail, '');
  assert.deepEqual(value.notifications, { customerInquiries: [], bookings: [], integrationErrors: [], weighedDocumentEmail: { enabled: false, recipients: [] } });
  assert.deepEqual(value.defaults, { paymentTermsDays: null }); assert.equal(value.capabilities.canManage, false);
  assert.deepEqual(await f.repository.read((state, revision) => ({ state, revision })), before);
}));

test('save normalizes the editable profile and records one versioned audit without changing legal identity or frozen documents', () => fixture(async f => {
  const input = inputOf(await f.service.get());
  input.profile = { ...input.profile, name: ' Nytt visningsnamn ', phone: '072-200 22 20', email: ' info@example.test ',
    invoiceEmail: ' ekonomi@example.test ', address: ' Storgatan 12 ', postalCode: '761 41', city: ' Norrtälje ', website: 'https://example.test' };
  input.documents.footerText = ' Tack för besöket!\r\nSpara ditt underlag. ';
  input.defaults.paymentTermsDays = 30;
  input.notifications.customerInquiries = ['INFO@example.test', 'info@example.test'];
  const saved = await f.save(input);
  assert.equal(saved.version, 1); assert.equal(saved.organisationNumber, legal.organisationNumber);
  assert.equal(saved.profile.name, 'Nytt visningsnamn'); assert.equal(saved.profile.phone, '+46722002220');
  assert.equal(saved.profile.postalCode, '76141'); assert.equal(saved.profile.website, 'https://example.test/');
  assert.equal(saved.documents.footerText, 'Tack för besöket!\nSpara ditt underlag.');
  assert.deepEqual(saved.notifications.customerInquiries, ['info@example.test']);
  assert.equal(saved.capabilities.canManage, true);
  const stored = await f.repository.read(state => state);
  assert.equal(stored.metadata.retained, 'existing-metadata'); assert.deepEqual(stored.office.documents, [frozenDocument]);
  assert.equal(stored.metadata.companySettingsAudit.length, 1);
  assert.deepEqual(stored.metadata.companySettingsAudit[0].changedFields, ['profile', 'documents', 'defaults', 'notifications']);
  assert.equal(stored.metadata.companySettingsAudit[0].actorId, principal.actorId);
  assert.equal(stored.metadata.companySettingsAudit[0].userId, principal.userId);
  assert.ok(!JSON.stringify(stored.metadata.companySettingsAudit).includes('ekonomi@example.test'));
  assert.deepEqual(await f.service.documentProfile(), { id: legal.id, ...saved.profile, number: legal.organisationNumber, vat: legal.vat, footerText: saved.documents.footerText });
}));

test('only the known form fields are accepted and malformed contacts, addresses, websites, logos or defaults cannot be saved', () => fixture(async f => {
  const base = inputOf(await f.service.get());
  const candidates = [null, [], { ...base, companyId: 'company-b' }, { ...base, organisationNumber: 'another-id' },
    { ...base, profile: { ...base.profile, countryCode: 'DK' } }, { ...base, profile: { ...base.profile, name: '' } },
    { ...base, profile: { ...base.profile, email: 'invalid-email' } }, { ...base, profile: { ...base.profile, invoiceEmail: 'invalid-email' } },
    { ...base, profile: { ...base.profile, phone: 'hello-123' } }, { ...base, profile: { ...base.profile, postalCode: '1234' } },
    { ...base, profile: { ...base.profile, address: 'Storgatan 12, 12345 Stockholm', postalCode: '76141' } },
    { ...base, profile: { ...base.profile, website: 'javascript:alert(1)' } },
    { ...base, profile: { ...base.profile, website: 'https://name:secret@example.test' } },
    { ...base, profile: { ...base.profile, website: 'example.test' } },
    { ...base, documents: { ...base.documents, logoId: '../foreign-image' } },
    { ...base, defaults: { paymentTermsDays: -1 } }, { ...base, defaults: { paymentTermsDays: 366 } },
    { ...base, defaults: { paymentTermsDays: 2.5 } },
    { ...base, notifications: { ...base.notifications, integrationErrors: ['invalid-email'] } },
    { ...base, notifications: { ...base.notifications, bookings: Array(11).fill('info@example.test') } },
    { ...base, profile: { ...base.profile, name: 'Hidden\u0000Name' } }];
  for (const input of candidates) await assert.rejects(f.save(input), hasStatus(422));
  assert.equal((await f.service.get()).version, 0);
  assert.equal(await f.repository.read(state => state.metadata.companySettings), undefined);
}));

test('concurrent saves use compare-and-swap and preserve the winning changes', () => fixture(async f => {
  const base = inputOf(await f.service.get());
  const results = await Promise.allSettled([f.save({ ...base, profile: { ...base.profile, contactPerson: 'Person A' } }),
    f.save({ ...base, profile: { ...base.profile, contactPerson: 'Person B' } })]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const rejected = results.find(value => value.status === 'rejected');
  assert.ok(hasStatus(409, 'company_settings_version_conflict')(rejected.reason));
  const saved = await f.service.get(); assert.equal(saved.version, 1); assert.equal(saved.profile.contactPerson, 'Person A');
  assert.equal(await f.repository.read(state => state.metadata.companySettingsAudit.length), 1);
}));

test('a read-only or wrong-company principal cannot write and session or permission changes during logo lookup abort the transaction', async () => {
  let fresh = principal;
  await fixture(async f => {
    const value = inputOf(await f.service.get());
    await assert.rejects(f.service.save(value, { ...principal, canManage: false }, { reauthorize: async () => principal }), hasStatus(403));
    await assert.rejects(f.service.save(value, { ...principal, companyId: 'company-b' }, { reauthorize: async () => principal }), hasStatus(403));
    await assert.rejects(f.service.save(value, principal), hasStatus(403));
    for (const change of [{ ...principal, canManage: false }, { ...principal, scopeKey: 'rotated-session' }, { ...principal, userId: 'other-user' }]) {
      fresh = principal;
      const save = f.service.save({ ...value, documents: { ...value.documents, logoId: randomUUID() } }, principal,
        { reauthorize: async () => fresh });
      fresh = change;
      await assert.rejects(save, change.canManage === false ? hasStatus(403) : hasStatus(409, 'company_settings_scope_changed'));
    }
    assert.equal((await f.service.get()).version, 0);
    assert.equal(await f.repository.read(state => state.metadata.companySettings), undefined);
  }, { validateLogo: async () => { await Promise.resolve(); return true; } });
});

test('new logos must be owned by this tenant, removed logos remain usable by immutable older snapshots', () => fixture(async f => {
  const logoId = logoIdForFixture;
  const input = inputOf(await f.service.get());
  await assert.rejects(f.save({ ...input, documents: { ...input.documents, logoId: randomUUID() } }), hasStatus(422, 'company_settings_logo_invalid'));
  const saved = await f.save({ ...input, documents: { ...input.documents, logoId } });
  assert.equal(saved.documents.logoId, logoId);
  assert.equal((await f.service.basicSettings()).logoUrl, `/api/company-settings/logos/${logoId}`);
  const oldSnapshot = await f.service.documentProfile();
  await f.save({ ...inputOf(saved), documents: { footerText: 'Ny sidfot' } });
  assert.equal((await f.service.get()).documents.logoId, undefined);
  assert.equal(oldSnapshot.logoId, logoId); assert.equal(oldSnapshot.footerText, '');
}, { validateLogo: async id => typeof id === 'string' && id === logoIdForFixture }));

// Shared constant makes fixture ownership deterministic without reading assets.
const logoIdForFixture = '22222222-2222-4222-8222-222222222222';

test('basic settings expose only default values and company display identity, and changes persist after reopening storage', () => fixture(async f => {
  const input = inputOf(await f.service.get());
  input.profile.invoiceEmail = 'private-invoices@example.test'; input.profile.contactPerson = 'Private Contact';
  input.notifications.integrationErrors = ['private-alerts@example.test']; input.defaults.paymentTermsDays = 14;
  await f.save(input);
  const basic = await f.service.basicSettings();
  assert.deepEqual(Object.keys(basic).sort(), ['companyId', 'defaults', 'profile', 'version']);
  assert.deepEqual(basic, { companyId: legal.id, version: 1, defaults: { paymentTermsDays: 14 }, profile: { name: legal.name } });
  assert.ok(!JSON.stringify(basic).includes('private'));
  const reopened = await f.create(); assert.equal((await reopened.service.get()).profile.invoiceEmail, 'private-invoices@example.test');
  const other = await f.create('b', { ...legal, id: 'company-b', name: 'Bolag B' });
  assert.equal((await other.service.get()).profile.name, 'Bolag B'); assert.equal((await other.service.get()).profile.invoiceEmail, '');
  await assert.rejects(other.service.save(input, principal, { reauthorize: async () => principal }), hasStatus(403));
}));

test('foreign or corrupt persisted company settings fail closed and audit storage remains bounded', () => fixture(async f => {
  const saved = await f.save({ ...inputOf(await f.service.get()), profile: { ...(await f.service.get()).profile, contactPerson: 'First' } });
  await f.repository.transact(state => {
    state.metadata.companySettingsAudit = Array.from({ length: 1200 }, (_, index) => ({ id: index }));
  });
  await f.save({ ...inputOf(saved), profile: { ...saved.profile, contactPerson: 'Second' } });
  assert.equal(await f.repository.read(state => state.metadata.companySettingsAudit.length), 1000);
  await f.repository.transact(state => { state.metadata.companySettings.companyId = 'company-b'; });
  await assert.rejects(f.service.get(), hasStatus(503, 'company_settings_unavailable'));
  await assert.rejects(f.service.documentProfile(), hasStatus(503, 'company_settings_unavailable'));
}));

test('standalone parser preserves explicit null default and does not accept read-only identity projections', () => {
  const value = { expectedVersion: 0,
    profile: { name: 'Bolag', address: '', postalCode: '', city: '', countryCode: 'SE', phone: '', email: '', invoiceEmail: '', contactPerson: '', website: '' },
    documents: { footerText: '' }, defaults: { paymentTermsDays: null }, notifications: { customerInquiries: [], bookings: [], integrationErrors: [] } };
  assert.equal(parseCompanySettingsInput(value).defaults.paymentTermsDays, null);
  assert.throws(() => parseCompanySettingsInput({ ...value, version: 0 }), hasStatus(422));
});

test('weighed-document email is opt-in, requires recipients, normalizes them and keeps disabled recipients without altering documents', () => fixture(async f => {
  const base = inputOf(await f.service.get());
  assert.deepEqual(await f.service.weighedDocumentEmail(), { enabled: false, recipients: [] });
  for (const invalid of [{ enabled: true, recipients: [] }, { enabled: 'true', recipients: ['office@example.test'] },
    { enabled: true, recipients: ['invalid-email'] }, { enabled: true, recipients: Array(11).fill('office@example.test') },
    { enabled: true, recipients: ['office@example.test'], from: 'injected@example.test' }])
    await assert.rejects(f.save({ ...base, notifications: { ...base.notifications, weighedDocumentEmail: invalid } }), hasStatus(422));
  const saved = await f.save({ ...base, notifications: { ...base.notifications,
    weighedDocumentEmail: { enabled: true, recipients: [' Office@Example.test ', 'office@example.test', 'second@example.test'] } } });
  assert.deepEqual(saved.notifications.weighedDocumentEmail, { enabled: true, recipients: ['office@example.test', 'second@example.test'] });
  assert.deepEqual(await f.service.weighedDocumentEmail(), saved.notifications.weighedDocumentEmail);
  const disabled = await f.save({ ...inputOf(saved), notifications: { ...saved.notifications,
    weighedDocumentEmail: { ...saved.notifications.weighedDocumentEmail, enabled: false } } });
  assert.equal(disabled.notifications.weighedDocumentEmail.enabled, false);
  assert.deepEqual(disabled.notifications.weighedDocumentEmail.recipients, ['office@example.test', 'second@example.test']);
  assert.deepEqual(await f.repository.read(state => state.office.documents), [frozenDocument]);
  assert.ok(!JSON.stringify(await f.repository.read(state => state.metadata.companySettingsAudit)).includes('office@example.test'));
}));

test('older stored settings gain disabled email defaults without a write and older client payloads remain accepted', () => fixture(async f => {
  const saved = await f.save({ ...inputOf(await f.service.get()), profile: { ...(await f.service.get()).profile, contactPerson: 'Legacy' } });
  await f.repository.transact(state => { delete state.metadata.companySettings.notifications.weighedDocumentEmail; });
  const before = await f.repository.read((state, revision) => ({ state, revision }));
  const loaded = await f.service.get();
  assert.deepEqual(loaded.notifications.weighedDocumentEmail, { enabled: false, recipients: [] });
  assert.deepEqual(await f.repository.read((state, revision) => ({ state, revision })), before);
  const oldInput = inputOf(loaded); delete oldInput.notifications.weighedDocumentEmail;
  oldInput.profile.contactPerson = 'Legacy edited';
  const updated = await f.save(oldInput);
  assert.equal(updated.version, saved.version + 1);
  assert.deepEqual(updated.notifications.weighedDocumentEmail, { enabled: false, recipients: [] });
}));

test('only an off-to-on transition records an internal activation time for new attested PDF copies', async () => {
  let time = new Date('2026-10-20T10:00:00.000Z');
  await fixture(async f => {
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), undefined);
    let saved = await f.save({ ...inputOf(await f.service.get()), notifications: { ...(await f.service.get()).notifications,
      weighedDocumentEmail: { enabled: true, recipients: ['office@example.test'] } } });
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), time.toISOString());
    assert.equal(saved.weighedDocumentEmailEnabledAt, undefined);
    time = new Date('2026-10-20T11:00:00.000Z');
    saved = await f.save({ ...inputOf(saved), notifications: { ...saved.notifications,
      weighedDocumentEmail: { enabled: true, recipients: ['new-office@example.test'] } } });
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), '2026-10-20T10:00:00.000Z');
    saved = await f.save({ ...inputOf(saved), notifications: { ...saved.notifications,
      weighedDocumentEmail: { ...saved.notifications.weighedDocumentEmail, enabled: false } } });
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), undefined);
    time = new Date('2026-10-20T12:00:00.000Z');
    await f.save({ ...inputOf(saved), notifications: { ...saved.notifications,
      weighedDocumentEmail: { ...saved.notifications.weighedDocumentEmail, enabled: true } } });
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), time.toISOString());
  }, { now: () => time });
});

test('a still-open older client cannot disable an enabled PDF subscription while saving unrelated contact fields', async () => {
  let time = new Date('2026-10-20T10:00:00.000Z');
  await fixture(async f => {
    const first = await f.service.get();
    const enabled = await f.save({ ...inputOf(first), notifications: { ...first.notifications,
      weighedDocumentEmail: { enabled: true, recipients: ['office@example.test'] } } });
    const enabledAt = await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt);
    time = new Date('2026-10-20T11:00:00.000Z');
    const oldInput = inputOf(enabled); delete oldInput.notifications.weighedDocumentEmail;
    oldInput.profile.contactPerson = 'Older client contact edit';
    const saved = await f.save(oldInput);
    assert.equal(saved.version, enabled.version + 1);
    assert.equal(saved.profile.contactPerson, 'Older client contact edit');
    assert.deepEqual(saved.notifications.weighedDocumentEmail, { enabled: true, recipients: ['office@example.test'] });
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), enabledAt);
    assert.deepEqual(await f.service.weighedDocumentEmail(), enabled.notifications.weighedDocumentEmail);
    assert.deepEqual(await f.repository.read(state => state.metadata.companySettingsAudit.at(-1).changedFields), ['profile']);
    const explicitlyDisabled = await f.save({ ...inputOf(saved), notifications: { ...saved.notifications,
      weighedDocumentEmail: { ...saved.notifications.weighedDocumentEmail, enabled: false } } });
    assert.equal(explicitlyDisabled.notifications.weighedDocumentEmail.enabled, false);
    assert.equal(await f.repository.read(state => state.metadata.weighedDocumentEmailEnabledAt), undefined);
  }, { now: () => time });
});
