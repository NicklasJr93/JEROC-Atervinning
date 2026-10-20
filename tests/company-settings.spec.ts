import { test, expect, type Page, type Request } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import type { CompanySettings } from '../src/office/company-settings/types';
import { companySettingsApi, CompanySettingsError, parseCompanySettings } from '../src/office/company-settings/client';
import { companyLookupScope } from '../src/company-register/client';
import { setCurrentPlatformSession } from '../src/platform/session';

const logoId = 'f2a62368-c10c-42d2-984c-e299a27d728a';
const stored: CompanySettings = {
  companyId: 'settings-company', organisationNumber: '5593593626', version: 3,
  profile: { name: 'Inställningsprov AB', address: 'Provvägen 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE',
    phone: '+46101234567', email: 'info@example.test', invoiceEmail: 'ekonomi@example.test', contactPerson: 'Vald kontakt', website: 'https://example.test' },
  documents: { footerText: 'Bolagets sparade sidfot' }, defaults: { paymentTermsDays: null },
  notifications: { customerInquiries: [], bookings: [], integrationErrors: [], weighedDocumentEmail: { enabled: false, recipients: [] } }, capabilities: { canManage: true }, updatedAt: '2026-10-20T09:00:00.000Z',
};

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function fixture(page: Page, options: { readOnly?: boolean; siteLimited?: boolean; conflict?: boolean; failRead?: boolean;
  logo?: boolean; platformAdmin?: boolean; basicOnly?: boolean; brokenLogo?: boolean } = {}) {
  const office = seedOffice();
  const user = { ...office.users.find(value => value.id === 'admin')!, level: options.readOnly ? 'Medarbetare' as const : 'VD' as const,
    permissions: options.basicOnly ? ['view'] as typeof office.users[number]['permissions'] : options.readOnly ? ['view', 'companySettingsRead'] as typeof office.users[number]['permissions'] : office.users.find(value => value.id === 'admin')!.permissions,
    siteIds: options.siteLimited ? ['norrtalje'] : undefined };
  office.users = [user];
  const company = { id: stored.companyId, name: stored.profile.name, organisationNumber: stored.organisationNumber, status: 'active' };
  const session = { enabled: true, authenticated: true, actor: { id: 'settings-actor', name: user.name, username: 'vd@example.test', platformAdmin: options.platformAdmin ?? false },
    actualUser: user, user, company, organisationId: company.id, effectiveUserId: user.id, isSupportSession: false,
    mustChangePassword: false, csrfToken: 'settings-csrf', generation: 11, companies: [company] };
  let value = structuredClone({ ...stored, documents: { ...stored.documents, ...(options.logo ? { logoId } : {}) }, capabilities: { canManage: !options.readOnly } });
  const writes: Request[] = [], uploads: Request[] = [];
  let reads = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/company-settings/defaults') return route.fulfill({ json: { companyId: value.companyId, version: value.version,
      profile: { name: value.profile.name }, defaults: value.defaults, ...(value.documents.logoId ? { logoUrl: `/api/company-settings/logos/${value.documents.logoId}` } : {}) } });
    if (path === '/api/company-settings') {
      if (request.method() === 'GET') { reads++; return options.failRead ? route.fulfill({ status: 503, json: { error: 'Tillfälligt anslutningsfel.' } }) : route.fulfill({ json: value }); }
      writes.push(request);
      if (options.conflict) return route.fulfill({ status: 409, json: { error: 'Versionen har ändrats.', code: 'company_settings_version_conflict' } });
      const { expectedVersion, ...draft } = request.postDataJSON();
      if (expectedVersion !== value.version) return route.fulfill({ status: 409, json: { error: 'Fel version.' } });
      value = { ...value, ...draft, version: value.version + 1, updatedAt: '2026-10-20T10:00:00.000Z' };
      return route.fulfill({ json: value });
    }
    if (path === '/api/company-settings/logo') { uploads.push(request); return route.fulfill({ json: { logoId, url: `/api/company-settings/logos/${logoId}` } }); }
    if (path === `/api/company-settings/logos/${logoId}`) return options.brokenLogo ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6fYAAAAASUVORK5CYII=', 'base64') });
    if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
    if (path === '/api/pricing/state') return route.fulfill({ json: { version: 'company-settings-test', revision: 1, memoryOnly: true, asOfDate: '2026-10-20', metals: [], articles: [], customers: [] } });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: user.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    return route.fulfill({ status: 503, json: { error: 'Denna tjänst ingår inte i det isolerade formulärprovet.' } });
  });
  await page.goto(options.basicOnly ? '/kontor#/dashboard' : '/kontor#/company-settings');
  if (options.basicOnly) await expect(page.locator('.office-sidebar')).toBeVisible();
  else await expect(page.getByRole('heading', { name: 'Företagsinställningar', exact: true })).toBeVisible();
  return { writes, uploads, value: () => value, reads: () => reads, changeCompany: () => {
    const next = { ...company, id: 'next-settings-company', name: 'Nästa bolag AB' };
    session.company = next; session.companies = [next]; session.organisationId = next.id; session.generation++;
    value = { ...value, companyId: next.id, profile: { ...value.profile, name: next.name }, documents: { footerText: '' } };
  } };
}

test('företagsuppgifter sparas uttryckligt med rätt version och oförändrad juridisk identitet', async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByLabel('Organisationsnummer', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Organisationsnummer', { exact: true })).toHaveValue(stored.organisationNumber);
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toBeDisabled();
  await page.getByLabel('Telefon', { exact: true }).fill('010-765 43 21');
  await page.getByLabel('E-post till kunder', { exact: true }).fill('kundservice@example.test');
  expect(f.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].postDataJSON()).toMatchObject({ expectedVersion: 3, profile: { phone: '+46107654321', email: 'kundservice@example.test' } });
  expect(f.writes[0].postDataJSON()).not.toHaveProperty('organisationNumber');
  expect(f.writes[0].headers()).toMatchObject({ 'x-platform-generation': '11', 'x-platform-csrf': 'settings-csrf', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toBeDisabled();
});

test('Avbryt återställer alla flikar och dokumentförhandsvisningen utan att spara', async ({ page }) => {
  const f = await fixture(page);
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Osparat företagsnamn');
  await page.getByRole('tab', { name: 'Logga & dokument', exact: true }).click();
  await page.getByLabel('Sidfot på nya dokument', { exact: true }).fill('Osparad sidfot');
  await expect(page.getByRole('complementary').getByText('Osparat företagsnamn', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await expect(page.getByLabel('Sidfot på nya dokument', { exact: true })).toHaveValue(stored.documents.footerText);
  await page.getByRole('tab', { name: 'Företaget', exact: true }).click();
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(stored.profile.name);
  expect(f.writes).toHaveLength(0);
});

test('versionskonflikt behåller utkastet och kräver aktiv hämtning av senaste version', async ({ page }) => {
  const f = await fixture(page, { conflict: true });
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Mitt kvarvarande utkast');
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ditt utkast finns kvar');
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('Mitt kvarvarande utkast');
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toBeDisabled();
  expect(f.writes).toHaveLength(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Hämta senaste version', exact: true }).click();
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue(stored.profile.contactPerson);
});

test('läsbehörighet visar uppgifterna utan skrivkontroller eller uppladdning', async ({ page }) => {
  const f = await fixture(page, { readOnly: true });
  await expect(page.getByLabel('Telefon', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logga & dokument', exact: true }).click();
  await expect(page.getByLabel('Sidfot på nya dokument', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Ladda upp logga', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Aviseringar', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Skicka vägt underlag till e-post', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Vägt underlag – mottagare', { exact: true })).toBeDisabled();
  expect(f.writes).toHaveLength(0); expect(f.uploads).toHaveLength(0);
});

test('loggauppladdning ändrar bara utkastet tills företagsinställningarna sparas', async ({ page }) => {
  const f = await fixture(page);
  const sidebarCaption = page.locator('.office-sidebar > .office-eyebrow');
  await expect(sidebarCaption).toHaveText(stored.profile.name);
  await expect(page.getByText('KONTORSÖVERSIKT', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logga & dokument', exact: true }).click();
  await page.getByLabel('Ladda upp logga', { exact: true }).setInputFiles({ name: 'logga.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6fYAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByRole('img', { name: 'Företagets logga', exact: true })).toBeVisible();
  expect(f.uploads).toHaveLength(1); expect(f.writes).toHaveLength(0);
  expect(f.value().documents.logoId).toBeUndefined();
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
  await expect(sidebarCaption).toHaveText(stored.profile.name);
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.value().documents.logoId).toBe(logoId);
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', `/api/company-settings/logos/${logoId}`);
  await expect(sidebarCaption).toHaveCount(0);
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ta bort logga', exact: true }).click();
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', `/api/company-settings/logos/${logoId}`);
  await expect(sidebarCaption).toHaveCount(0);
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
  await expect(sidebarCaption).toHaveText(stored.profile.name);
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
});

test('systemadmin behåller produktloggan ovanför bolagets sparade logga', async ({ page }) => {
  await fixture(page, { logo: true, platformAdmin: true });
  await expect(page.locator('.platform-topbar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', `/api/company-settings/logos/${logoId}`);
  await expect(page.locator('.office-sidebar > .office-eyebrow')).toHaveCount(0);
  await expect(page.getByText('KONTORSÖVERSIKT', { exact: true })).toHaveCount(0);
});

test('vanlig medarbetare får företagets logga via minimala uppgifter utan att läsa företagsinställningar', async ({ page }) => {
  const f = await fixture(page, { logo: true, readOnly: true, basicOnly: true });
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', `/api/company-settings/logos/${logoId}`);
  expect(f.reads()).toBe(0);
});

test('saknad loggafil visar produktloggan utan en trasig bild', async ({ page }) => {
  await fixture(page, { logo: true, brokenLogo: true });
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await expect(page.locator('.office-sidebar > .office-eyebrow')).toHaveText(stored.profile.name);
});

test('bolagsbyte visar aldrig det förra bolagets logga medan nästa profil hämtas', async ({ page }) => {
  const f = await fixture(page, { logo: true });
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', `/api/company-settings/logos/${logoId}`);
  await expect(page.locator('.office-sidebar > .office-eyebrow')).toHaveCount(0);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/company-settings/defaults', async route => {
    await pending;
    await route.fulfill({ json: { companyId: f.value().companyId, version: f.value().version,
      profile: { name: f.value().profile.name }, defaults: f.value().defaults } });
  });
  f.changeCompany();
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session')));
    await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
    await expect(page.locator('.platform-topbar')).toHaveCount(0);
    await expect(page.locator('.office-sidebar > .office-eyebrow')).toHaveText('Nästa bolag AB');
  } finally { release(); }
  await expect(page.locator('.office-sidebar').getByText('Nästa bolag AB', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.office-sidebar > img')).toHaveAttribute('src', '/images/scrapplanner-logo.png');
});

test('mottagarlistor och kunders standardvillkor sparas tillsammans utan att skicka e-post', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('tab', { name: 'Standardval', exact: true }).click();
  await page.getByLabel('Betalningsvillkor för nya kunder', { exact: true }).selectOption('30');
  await page.getByRole('tab', { name: 'Aviseringar', exact: true }).click();
  await page.getByLabel('Kundförfrågningar – mottagare', { exact: true }).fill('service@example.test\nvd@example.test');
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].postDataJSON()).toMatchObject({ defaults: { paymentTermsDays: 30 }, notifications: { customerInquiries: ['service@example.test', 'vd@example.test'] } });
});

test('mejlkopia av vägt underlag är avstängd från början och kräver kontorets mottagare innan den sparas', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('tab', { name: 'Aviseringar', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Skicka vägt underlag till e-post', exact: true });
  const recipients = page.getByLabel('Vägt underlag – mottagare', { exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(recipients).toBeDisabled();
  await expect(page.getByText('Skickar en PDF-kopia till kontoret efter attest. Avser nya attesterade underlag.', { exact: true })).toBeVisible();
  await checkbox.check();
  await expect(recipients).toBeEnabled();
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  expect(f.writes).toHaveLength(0);
  await recipients.fill('kontoret@example.test\nekonomi@example.test\nkontoret@example.test');
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].postDataJSON()).toMatchObject({ expectedVersion: 3,
    notifications: { weighedDocumentEmail: { enabled: true, recipients: ['kontoret@example.test', 'ekonomi@example.test'] } } });
  await expect(checkbox).toBeChecked();
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toBeDisabled();
});

test('avstängd PDF-kopia behåller kontorets adress men kräver uttrycklig sparning innan inställningen ändras', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('tab', { name: 'Aviseringar', exact: true }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Skicka vägt underlag till e-post', exact: true });
  const recipients = page.getByLabel('Vägt underlag – mottagare', { exact: true });
  await checkbox.check();
  await recipients.fill('kontoret@example.test');
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  await checkbox.uncheck();
  await expect(recipients).toBeDisabled();
  await expect(recipients).toHaveValue('kontoret@example.test');
  expect(f.value().notifications.weighedDocumentEmail.enabled).toBe(true);
  await page.getByRole('button', { name: 'Spara ändringar', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(2);
  expect(f.writes[1].postDataJSON()).toMatchObject({ expectedVersion: 4,
    notifications: { weighedDocumentEmail: { enabled: false, recipients: ['kontoret@example.test'] } } });
  await checkbox.check();
  await expect(recipients).toHaveValue('kontoret@example.test');
  expect(f.writes).toHaveLength(2);
});

test('klienten avvisar ett sent svar efter ändrad plattformsidentitet', async () => {
  const oldFetch = globalThis.fetch;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  setCurrentPlatformSession(undefined);
  const scope = companyLookupScope();
  globalThis.fetch = async () => { await pending; return new Response(JSON.stringify(stored), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const result = companySettingsApi.read(scope);
    setCurrentPlatformSession({ enabled: true, authenticated: true, actor: { id: 'other-actor', name: 'Annan', username: 'other', platformAdmin: false },
      user: seedOffice().users[0], actualUser: seedOffice().users[0], organisationId: 'other-company', effectiveUserId: 'other-user',
      isSupportSession: false, mustChangePassword: false, csrfToken: 'other-csrf', generation: 99, companies: [] });
    release();
    await expect(result).rejects.toMatchObject({ status: 409, code: 'company_settings_scope_changed' });
  } finally { globalThis.fetch = oldFetch; setCurrentPlatformSession(undefined); }
});

test('ofullständiga inställningssvar kan inte förifylla ett annat bolags formulär', () => {
  expect(() => parseCompanySettings({ ...stored, profile: { name: 'Ofullständig' } })).toThrow(CompanySettingsError);
});

test('äldre inställningssvar får avstängd mejlkopia utan att påhittade mottagare läggs till', () => {
  const { weighedDocumentEmail: _copy, ...notifications } = stored.notifications;
  expect(parseCompanySettings({ ...stored, notifications }).notifications.weighedDocumentEmail).toEqual({ enabled: false, recipients: [] });
});


test('anläggningsbegränsat konto kan inte ändra hela företagets profil även om tidigare svar gav ändringsrätt', async ({ page }) => {
  const f = await fixture(page, { siteLimited: true });
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Spara ändringar', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Logga & dokument', exact: true }).click();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(f.writes).toHaveLength(0); expect(f.uploads).toHaveLength(0);
});
