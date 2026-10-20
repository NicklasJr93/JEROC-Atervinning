import { test, expect, type Page, type Request } from '@playwright/test';
import { seedDemo, type DemoData } from '../src/model';
import { seedOffice } from '../src/office/model';
import { emptyEmployeeFleet } from './helpers/employee-fleet';
import type { CompanyRegisterCompany } from '../src/company-register/client';

const company: CompanyRegisterCompany = {
  organisationNumber: '5593593626', name: 'Registerträff AB',
  address: 'Registergatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE',
  phone: '+46812345678', email: 'foretaget@example.test',
  source: 'SCB', fetchedAt: '2026-10-20T08:00:00.000Z', vatRegistered: true, fTaxRegistered: false,
};

async function mobileCustomer(page: Page, registeredCompany: CompanyRegisterCompany = company) {
  const personId = 'company-lookup-person';
  let data: DemoData = { ...seedDemo(), customers: [], drafts: [{
    id: 'company-lookup-draft', number: 9102, siteId: 'norrtalje',
    createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z',
    mode: 'direct', status: 'draft', rows: [], reference: '', origin: '',
  }] };
  let posts = 0;
  const lookups: Request[] = [];
  await page.addInitScript(({ personId, data }) => {
    const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(`${key}.postgres-imported`, 'yes');
  }, { personId, data });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.includes('company-register')) {
      lookups.push(request);
      return route.fulfill({ json: { company: registeredCompany } });
    }
    if (path === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: {
      person: { id: personId, name: 'Testmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['norrtalje'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true },
      activeSiteId: 'norrtalje', sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }],
      today: '2026-10-20', month: '2026-10', date: '2026-10-20', gate: { blocked: false },
      days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] },
    } });
    if (path === '/api/application/mobile') {
      if (request.method() === 'POST') {
        posts++;
        const command = request.postDataJSON();
        for (const field of ['customers', 'drafts'] as const) for (const change of command[field] || []) {
          data = { ...data, [field]: [...data[field].filter(record => record.id !== change.id), ...(change.next ? [change.next] : [])] };
        }
      }
      return route.fulfill({ json: { data, revision: posts + 1 } });
    }
    return route.fulfill({ json: { revision: posts + 1 } });
  });
  await page.goto('/#/weigh/company-lookup-draft/customer/new');
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  return { data: () => data, posts: () => posts, lookups };
}

test('mobilens SCB-träff fyller känd momsstatus efter aktivt val och lämnar kontakt- och betalningsuppgifter oförändrade', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Manuellt företagsnamn');
  await page.getByLabel('Telefon (valfritt)', { exact: true }).fill('0722002220');
  await page.getByLabel('E-post (valfritt)', { exact: true }).fill('kontakt@example.test');
  await page.getByLabel('Momsregistrerad', { exact: true }).selectOption('no');
  await page.getByLabel('Lägg till betalningsuppgifter', { exact: true }).check();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('00123456789');
  await page.getByLabel('Kontohavare', { exact: true }).fill('Godkänd mottagare');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559359-3626');
  await expect(page.getByText(company.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Momsregistrerad: Ja', { exact: true })).toBeVisible();
  await expect(page.getByText('Godkänd för F-skatt: Nej', { exact: true })).toBeVisible();
  if (process.env.SCB_LOOKUP_SCREENSHOTS) {
    await page.getByRole('region', { name: 'Företagsuppslag', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/scb-lookup-mobile.png' });
  }
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue('Manuellt företagsnamn');
  expect(fixture.posts()).toBe(0);
  await page.getByRole('button', { name: /Använd.*uppgifter/ }).click();
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(company.name);
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue(company.organisationNumber);
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue(company.address);
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue(company.postalCode);
  await expect(page.getByLabel('Ort (valfritt)', { exact: true })).toHaveValue(company.city);
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue('0722002220');
  await expect(page.getByLabel('E-post (valfritt)', { exact: true })).toHaveValue('kontakt@example.test');
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveValue('yes');
  await expect(page.getByText('Godkänd för F-skatt: Nej', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kontohavare', { exact: true })).toHaveValue('Godkänd mottagare');
  expect(fixture.posts()).toBe(0);
  expect(fixture.lookups).toHaveLength(1);
  expect(fixture.lookups[0].headers()).toMatchObject({ 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'company-lookup-person' });
  await page.getByLabel('Momsregistrerad', { exact: true }).selectOption('no');
  await page.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect.poll(() => fixture.data().customers.length).toBe(1);
  expect(fixture.data().customers[0]).toMatchObject({
    name: company.name, number: company.organisationNumber, address: company.address, postalCode: company.postalCode, city: company.city,
    phone: '+46722002220', email: 'kontakt@example.test', vatRegistered: false,
    paymentProfile: { holder: 'Godkänd mottagare', clearing: '8327', account: '00123456789' },
  });
});

test('mobilen fyller SCB:s telefon och e-post först efter aktivt val och behåller senare kontaktändringar', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect(page.getByText(company.name, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('E-post (valfritt)', { exact: true })).toHaveValue('');
  // Typing while a result is visible must preserve the operator's newer input.
  await page.getByLabel('E-post (valfritt)', { exact: true }).fill('vald-kontakt@example.test');
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue(company.phone!);
  await expect(page.getByLabel('E-post (valfritt)', { exact: true })).toHaveValue('vald-kontakt@example.test');
  expect(fixture.posts()).toBe(0);
});

test('mobilen fyller enbart tom e-post när telefon redan är påbörjad', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.getByLabel('Telefon (valfritt)', { exact: true }).fill('0722');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue('0722');
  await expect(page.getByLabel('E-post (valfritt)', { exact: true })).toHaveValue(company.email!);
  expect(fixture.posts()).toBe(0);
});

test('mobilen föreslår kundtyp först för giltigt nummer och låter enskild firma behålla manuellt val', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  const type = page.getByLabel('Kundtyp', { exact: true });
  await expect(page.locator('form input').first()).toHaveAccessibleName('Organisations-/personnummer');
  await number.fill('19900101');
  await expect(type).toHaveValue('automatic');
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toBeVisible();
  await number.fill('19900101-0017');
  await expect(page.getByLabel('Namn', { exact: true })).toBeVisible();
  await type.selectOption('Företag');
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toBeVisible();
  await number.fill('19900101-001');
  await number.fill('19900101-0017');
  await expect(type).toHaveValue('Företag');
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toBeVisible();
  expect(fixture.lookups).toHaveLength(0);
  expect(fixture.posts()).toBe(0);
});

test('privatpersonnummer lämnar inte mobilformuläret till företagsregistret', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.getByLabel('Kundtyp', { exact: true }).selectOption('Privatperson');
  await page.getByLabel('Namn', { exact: true }).fill('Privat testkund');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('19900101-0017');
  await page.getByLabel('Telefon (valfritt)', { exact: true }).focus();
  await expect(page.getByText('SCB', { exact: true })).toHaveCount(0);
  expect(fixture.lookups).toHaveLength(0);
  expect(fixture.posts()).toBe(0);
});

test('ofullständigt organisationsnummer och fel kontrollsiffra söks inte; komplett giltigt nummer söks en gång', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.clock.install();
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  const lookup = page.getByRole('region', { name: 'Företagsuppslag', exact: true });
  await number.fill('559359362');
  await page.clock.fastForward(500);
  await expect(lookup.getByRole('status')).toContainText('Skriv hela organisationsnumret');
  expect(fixture.lookups).toHaveLength(0);
  await number.fill('5593593625');
  await page.clock.fastForward(500);
  await expect(lookup.getByRole('status')).toContainText('kontrollsiffra');
  expect(fixture.lookups).toHaveLength(0);
  await number.fill(company.organisationNumber);
  await page.clock.fastForward(500);
  await expect(lookup.getByText(company.name, { exact: true })).toBeVisible();
  expect(fixture.lookups).toHaveLength(1);
  expect(fixture.lookups[0].postDataJSON()).toEqual({ organisationNumber: company.organisationNumber });
  await number.fill(`16${company.organisationNumber}`);
  await page.clock.fastForward(500);
  await expect(lookup.getByText(company.name, { exact: true })).toBeVisible();
  expect(fixture.lookups).toHaveLength(1);
  expect(fixture.posts()).toBe(0);
});

test('SCB utan aktiverad API-nyckel ger begriplig status och stoppar inte manuell kundregistrering', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  await page.route('**/api/company-register/lookup', route => route.fulfill({ status: 503, json: {
    code: 'company_lookup_not_configured', error: 'Företagsuppslaget är inte aktiverat ännu.',
  } }));
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Manuellt registrerad kund AB');
  await page.getByLabel('Gatuadress (valfritt)', { exact: true }).fill('Manuella gatan 9');
  await page.getByLabel('Postnummer (valfritt)', { exact: true }).fill('761 41');
  await page.getByLabel('Ort (valfritt)', { exact: true }).fill('Norrtälje');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559359-3626');
  const lookup = page.getByRole('region', { name: 'Företagsuppslag', exact: true });
  await expect(lookup.getByRole('status')).toContainText('Företagsuppslag är inte aktiverat ännu. Du kan fylla i uppgifterna manuellt.');
  await expect(lookup.getByRole('button', { name: 'Använd företagsuppgifter', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect.poll(() => fixture.data().customers.length).toBe(1);
  expect(fixture.data().customers[0]).toMatchObject({
    name: 'Manuellt registrerad kund AB', number: company.organisationNumber,
    address: 'Manuella gatan 9', postalCode: '76141', city: 'Norrtälje',
  });
});

test('en SCB-träff utan adress eller momsstatus behåller mobilkundens manuellt ifyllda uppgifter', async ({ page }) => {
  const fixture = await mobileCustomer(page, { ...company, address: '', postalCode: '', city: '', vatRegistered: undefined });
  await page.getByLabel('Momsregistrerad', { exact: true }).selectOption('no');
  await page.getByLabel('Gatuadress (valfritt)', { exact: true }).fill('Manuella vägen 7');
  await page.getByLabel('Postnummer (valfritt)', { exact: true }).fill('762 51');
  await page.getByLabel('Ort (valfritt)', { exact: true }).fill('Rimbo');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(company.name);
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('Manuella vägen 7');
  await expect(page.getByText('Momsregistrerad: Uppgift saknas', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue('762 51');
  await expect(page.getByLabel('Ort (valfritt)', { exact: true })).toHaveValue('Rimbo');
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveValue('no');
  expect(fixture.posts()).toBe(0);
});

test('SCB:s uttryckliga nej till momsregistrering fylls i och sparas utan krav på F-skatt', async ({ page }) => {
  const fixture = await mobileCustomer(page, { ...company, vatRegistered: false });
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveValue('yes');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true }).click();
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveValue('no');
  await page.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect.poll(() => fixture.data().customers.length).toBe(1);
  expect(fixture.data().customers[0]).toMatchObject({ name: company.name, vatRegistered: false });
});

test('mobilens pågående SCB-sökning får inte skriva över en senare manuell ändring', async ({ page }) => {
  const fixture = await mobileCustomer(page);
  let requests = 0, responses = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/company-register/lookup', async route => {
    requests++;
    await ready;
    await route.fulfill({ json: { company } });
    responses++;
  });
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(company.organisationNumber);
  await expect.poll(() => requests).toBe(1);
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Senare manuellt namn AB');
  release();
  await expect.poll(() => responses).toBe(1);
  await expect(page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue('Senare manuellt namn AB');
  await page.getByRole('button', { name: 'Sök igen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true })).toBeVisible();
  expect(requests).toBe(2);
  expect(fixture.posts()).toBe(0);
});

test('systemadmin kan fylla nytt bolag från SCB utan att skapa bolaget eller ändra VD-kontot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const admin = seedOffice().users.find(user => user.id === 'admin')!;
  const auth = { enabled: true, authenticated: true,
    actor: { id: 'global-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: admin, user: admin, isSupportSession: false, mustChangePassword: false,
    csrfToken: 'test-csrf', generation: 1, companies: [],
  };
  const lookups: Request[] = [];
  let companyPosts = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.includes('company-register')) { lookups.push(request); return route.fulfill({ json: { company } }); }
    if (path === '/api/platform/session') return route.fulfill({ json: auth });
    if (path === '/api/platform/companies') {
      if (request.method() === 'POST') companyPosts++;
      return route.fulfill({ json: { companies: [] } });
    }
    return route.fulfill({ status: 404, json: { error: 'Den här testvyn har inga fler uppgifter.' } });
  });
  await page.goto('/kontor#/platform-admin');
  await page.getByRole('button', { name: 'Skapa bolag', exact: true }).click();
  await page.getByLabel('Bolagsnamn', { exact: true }).fill('Manuellt namn AB');
  await page.getByLabel('VD:s namn', { exact: true }).fill('Vald VD');
  await page.getByLabel('VD:s e-post', { exact: true }).fill('vd@example.test');
  await page.getByLabel('Bolagets organisationsnummer', { exact: true }).fill('559359-3626');
  await expect(page.getByText(company.name, { exact: true })).toBeVisible();
  if (process.env.SCB_LOOKUP_SCREENSHOTS) await page.screenshot({ path: '/tmp/scb-lookup-platform.png' });
  await expect(page.getByLabel('Bolagsnamn', { exact: true })).toHaveValue('Manuellt namn AB');
  await page.getByRole('button', { name: /Använd/ }).click();
  await expect(page.getByLabel('Bolagsnamn', { exact: true })).toHaveValue(company.name);
  await expect(page.getByLabel('Bolagets organisationsnummer', { exact: true })).toHaveValue(company.organisationNumber);
  await expect(page.getByLabel('VD:s namn', { exact: true })).toHaveValue('Vald VD');
  await expect(page.getByLabel('VD:s e-post', { exact: true })).toHaveValue('vd@example.test');
  expect(companyPosts).toBe(0);
  expect(lookups).toHaveLength(1);
  expect(lookups[0].headers()).toMatchObject({ 'x-platform-generation': '1' });
});
