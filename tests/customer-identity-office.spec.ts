import { test, expect, type Page, type Request } from '@playwright/test';
import type { CompanyRegisterCompany } from '../src/company-register/client';
import { migrateOffice } from '../src/office/customer-model';
import { seedOffice, type OfficeCustomer } from '../src/office/model';
import { testPersonalNumber } from './helpers/customer-identity';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

const company: CompanyRegisterCompany = {
  organisationNumber: '5593593626', name: 'Registerkontakt AB',
  address: 'Registergatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE',
  phone: '+46812345678', email: 'Info@example.test',
  source: 'SCB', fetchedAt: '2026-10-20T08:00:00.000Z', vatRegistered: true,
};

/** Every request stays in this browser fixture; no company/customer data is persisted. */
async function officeCustomer(page: Page, options: { quick?: boolean; delayedLookup?: boolean; existing?: Partial<OfficeCustomer> } = {}) {
  const office = migrateOffice(seedOffice());
  const user = office.users.find(candidate => candidate.id === 'admin')!;
  const customer = { ...office.customers[0], ...options.existing, id: 'identity-existing' };
  if (options.existing) office.customers = [customer];
  const template = office.cards.find(card => card.id === 2051)!;
  const cardId = 63187;
  office.cards = [{ ...structuredClone(template), id: cardId, sourceId: '91006b91-85e2-4c12-b44d-42cb9ec3fd9d',
    status: 'complement', customerId: undefined, customerSnapshot: undefined, customerApproval: undefined }];
  const tenant = { id: 'identity-company', name: 'Isolerat kundprov AB', organisationNumber: '5593593626', status: 'active' };
  const session = { enabled: true, authenticated: true,
    actor: { id: 'identity-actor', name: user.name, username: 'admin', platformAdmin: false },
    actualUser: user, user, company: tenant, organisationId: tenant.id, effectiveUserId: user.id,
    isSupportSession: false, mustChangePassword: false, csrfToken: 'identity-csrf', generation: 7, companies: [tenant] };
  const lookups: Request[] = [], writes: Request[] = [];
  let releaseLookup!: () => void;
  const ready = options.delayedLookup ? new Promise<void>(resolve => { releaseLookup = resolve; }) : Promise.resolve();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && ['/api/pricing/customers', '/api/application/office'].includes(path)) writes.push(request);
    if (path === '/api/company-register/lookup') {
      lookups.push(request);
      await ready;
      return route.fulfill({ json: { company } });
    }
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
    if (path === '/api/pricing/state') return route.fulfill({ json: {
      version: 'identity-fixture', revision: 1, memoryOnly: true, asOfDate: '2026-10-20', metals: [], articles: [], customers: [],
    } });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: user.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: {
      configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id,
      sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [],
    } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    if (path.includes('/accounting/cards/')) return route.fulfill({ json: { export: null } });
    return route.fulfill({ status: 503, json: { error: 'Valfri tjänst ingår inte i detta isolerade kundprov.' } });
  });
  await page.goto(`/kontor#${options.quick ? `/weighings/${cardId}` : options.existing ? `/customers/${customer.id}?tab=details` : '/customers/new'}`);
  if (options.quick) {
    await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Ny kund', exact: true })).toBeVisible();
  } else await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeVisible();
  return { lookups, writes, releaseLookup: () => releaseLookup?.() };
}

test('full kundregistrering börjar med nummer och föreslår bara giltig kundtyp med manuellt undantag för enskild firma och BRF', async ({ page }) => {
  const fixture = await officeCustomer(page);
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  const type = page.getByLabel('Kundtyp', { exact: true });
  await expect(page.locator('form input').first()).toHaveAccessibleName('Organisations-/personnummer');
  await number.fill('559359362');
  await expect(type).toHaveValue('automatic');
  await expect(page.getByRole('group', { name: 'Momsregistrerad', exact: true })).toBeVisible();
  await number.fill(company.organisationNumber);
  await expect(type.locator('option:checked')).toHaveText('Automatiskt – Företag');
  await expect.poll(() => fixture.lookups.length).toBe(1);
  const personalNumber = testPersonalNumber();
  await number.fill(personalNumber);
  await expect(type.locator('option:checked')).toHaveText('Automatiskt – Privatperson');
  await expect(page.getByRole('group', { name: 'Momsregistrerad', exact: true })).toHaveCount(0);
  await type.selectOption('Företag');
  await number.fill(personalNumber.slice(0, -1));
  await number.fill(personalNumber);
  await expect(type).toHaveValue('Företag');
  await expect(page.getByRole('group', { name: 'Momsregistrerad', exact: true })).toBeVisible();
  await type.selectOption('BRF');
  await number.fill(company.organisationNumber);
  await expect(type).toHaveValue('BRF');
  expect(fixture.writes).toHaveLength(0);
  // Personal numbers are not sent to the company register, including sole traders.
  expect(fixture.lookups.every(request => request.postDataJSON().organisationNumber === company.organisationNumber)).toBe(true);
});

test('snabbkundens manuella kundtyp och nummer följer med till fullständigt formulär', async ({ page }) => {
  const fixture = await officeCustomer(page, { quick: true });
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await expect(dialog.locator('input').first()).toHaveAccessibleName('Organisations-/personnummer');
  await dialog.getByLabel('Kundtyp', { exact: true }).selectOption('Företag');
  const personalNumber = testPersonalNumber();
  await dialog.getByLabel('Organisations-/personnummer', { exact: true }).fill(personalNumber);
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill('Enskild verksamhet');
  await dialog.getByRole('button', { name: 'Öppna fullständigt kundformulär', exact: true }).click();
  await expect(page.getByLabel('Kundtyp', { exact: true })).toHaveValue('Företag');
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue(personalNumber);
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Enskild verksamhet');
  await page.getByLabel('Kundtyp', { exact: true }).selectOption('BRF');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect(page.getByLabel('Kundtyp', { exact: true })).toHaveValue('BRF');
  expect(fixture.writes).toHaveLength(0);
});

test('befintlig kund behåller vald kundtyp när kundkortet öppnas och redigeras', async ({ page }) => {
  const fixture = await officeCustomer(page, { existing: {
    number: testPersonalNumber(), type: 'Företag', name: 'Befintlig enskild firma',
  } });
  const type = page.getByLabel('Kundtyp', { exact: true });
  await expect(type).toBeDisabled();
  await expect(type).toHaveValue('Företag');
  await page.getByRole('button', { name: 'Redigera kund', exact: true }).click();
  await expect(type).toBeEnabled();
  await expect(type).toHaveValue('Företag');
  await expect(page.getByRole('group', { name: 'Momsregistrerad', exact: true })).toBeVisible();
  expect(fixture.lookups).toHaveLength(0);
  expect(fixture.writes).toHaveLength(0);
});

test('kontorets SCB-träff fyller tomma företagskontakter först efter uttryckligt val utan att spara', async ({ page }) => {
  const fixture = await officeCustomer(page);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect(page.getByText(company.name, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('E-post', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue(company.phone!);
  await expect(page.getByLabel('E-post', { exact: true })).toHaveValue(company.email!);
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('');
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.lookups[0].headers()).toMatchObject({
    'x-demo-actor': 'admin', 'x-demo-user': 'admin', 'x-platform-generation': '7',
  });
});

test('full kundregistrering bevarar e-post som skrivs medan SCB-sökning pågår och fyller bara telefon', async ({ page }) => {
  const fixture = await officeCustomer(page, { delayedLookup: true });
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect.poll(() => fixture.lookups.length).toBe(1);
  await page.getByLabel('E-post', { exact: true }).fill('påbörjad@');
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Vald kontaktperson');
  fixture.releaseLookup();
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue(company.phone!);
  await expect(page.getByLabel('E-post', { exact: true })).toHaveValue('påbörjad@');
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('Vald kontaktperson');
  expect(fixture.writes).toHaveLength(0);
});

test('snabbkund bevarar påbörjad telefon från väntande SCB-sökning och fyller bara tom e-post', async ({ page }) => {
  const fixture = await officeCustomer(page, { quick: true, delayedLookup: true });
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect.poll(() => fixture.lookups.length).toBe(1);
  await dialog.getByLabel('Telefon', { exact: true }).fill('0722');
  fixture.releaseLookup();
  await dialog.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(dialog.getByLabel('Telefon', { exact: true })).toHaveValue('0722');
  await expect(dialog.getByLabel('E-post', { exact: true })).toHaveValue(company.email!);
  expect(fixture.writes).toHaveLength(0);
});
