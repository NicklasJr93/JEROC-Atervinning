import { test, expect, type Page } from '@playwright/test';
import { seedDemo, type DemoData } from '../src/model';

test('demoknappar fyller bara formuläret och döljs när servern stänger demon', async ({ page }) => {
  let enabled = true, logins = 0;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/employee/demo-config') return route.fulfill({ json: { enabled, accounts: { niklas: enabled, admin: enabled } } });
    if (path === '/api/employee/login') logins++;
    return route.fulfill({ status: 401, json: { error: 'Logga in igen.' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Logga in som Niklas', exact: true }).click();
  await expect(page.getByLabel('Användarnamn', { exact: true })).toHaveValue('niklas');
  await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('Demo123!');
  await page.getByRole('button', { name: 'Logga in som chef/admin', exact: true }).click();
  await expect(page.getByLabel('Användarnamn', { exact: true })).toHaveValue('admin');
  await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('JerocDemo2026!');
  expect(logins).toBe(0);
  enabled = false;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Demoinloggning' })).toHaveCount(0);
});

async function customerFixture(page: Page) {
  let data: DemoData = { ...seedDemo(), customers: [], drafts: [{
    id: 'mobile-settings-build', number: 9001, createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z',
    mode: 'direct', status: 'draft', rows: [], reference: '', origin: '',
  }] };
  let posts = 0;
  const personId = 'mobile-settings-person';
  await page.addInitScript(({ personId, data }) => {
    const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(`${key}.postgres-imported`, 'yes');
  }, { personId, data });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: {
      person: { id: personId, name: 'Testmedarbetare', role: 'Invägare', team: 'Gårdsplan', siteIds: ['norrtalje'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false }, sites: [],
      today: '2026-10-12', month: '2026-10', date: '2026-10-12', gate: { blocked: false },
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
  await page.goto('/#/weigh/mobile-settings-build/customer/new');
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  return { data: () => data, posts: () => posts };
}

test('mobilkund sparar momsval, strukturerad adress och normaliserad telefon; ursprung kopieras bara efter val', async ({ page }) => {
  const fixture = await customerFixture(page);
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveValue('yes');
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Testbolag UI');
  await page.getByLabel('Organisationsnummer', { exact: true }).fill('55935936261');
  await page.getByLabel('Telefon (valfritt)').fill('0722002220');
  await expect(page.getByRole('alert')).toContainText('exakt 10 siffror');
  expect(fixture.posts()).toBe(0);
  await page.getByLabel('Organisationsnummer', { exact: true }).fill('559359-3626');
  await page.getByLabel('Momsregistrerad', { exact: true }).selectOption('no');
  await page.getByLabel('Gatuadress (valfritt)').fill('Storgatan 12');
  await page.getByLabel('Postnummer (valfritt)').fill('761 41');
  await page.getByLabel('Ort (valfritt)').fill('Norrtälje');
  await page.getByRole('button', { name: 'Spara och välj kund' }).click();
  await expect.poll(() => fixture.data().customers.length).toBe(1);
  expect(fixture.data().customers[0]).toMatchObject({
    number: '5593593626', phone: '+46722002220', vatRegistered: false,
    address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE',
  });
  await page.getByRole('button', { name: /Referens & ursprung/ }).click();
  const origin = page.getByLabel('Materialets ursprungsadress (valfritt)');
  const copy = page.getByRole('checkbox', { name: /Använd kundens adress som ursprungsadress/ });
  await expect(copy).not.toBeChecked();
  await expect(origin).toHaveValue('');
  await copy.check();
  await expect(origin).toHaveValue('Storgatan 12, 76141 Norrtälje');
  await origin.fill('Annan gata 4, 762 51 Rimbo');
  await expect(copy).not.toBeChecked();
  await page.getByLabel('Referens (valfritt)', { exact: true }).fill('Projekt UI');
  await page.getByRole('button', { name: 'Spara uppgifter' }).click();
  await expect.poll(() => fixture.data().drafts[0].origin).toBe('Annan gata 4, 76251 Rimbo');
  expect(fixture.data().drafts[0].customerSelectionsSavedAt).toBeTruthy();
});

test('privatkund kan skapas utan personnummer och är alltid utan momsregistrering', async ({ page }) => {
  const fixture = await customerFixture(page);
  await page.getByRole('button', { name: 'Privatperson', exact: true }).click();
  await expect(page.getByLabel('Momsregistrerad', { exact: true })).toHaveCount(0);
  await page.getByLabel('Namn', { exact: true }).fill('Privat testkund');
  await page.getByRole('button', { name: 'Spara och välj kund' }).click();
  await expect.poll(() => fixture.data().customers.length).toBe(1);
  expect(fixture.data().customers[0]).toMatchObject({ type: 'Privatperson', number: '', vatRegistered: false });
});
