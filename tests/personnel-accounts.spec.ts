import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { OfficeUser } from '../src/office/model';
import type { PersonnelResponse } from '../src/office/personnel/types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.describe.configure({ mode: 'serial' });

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function personnel(request: APIRequestContext): Promise<PersonnelResponse> {
  const response = await request.get('/api/application/personnel', { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function users(request: APIRequestContext): Promise<OfficeUser[]> {
  const response = await request.get('/api/pricing/state', { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).users;
}
async function office(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.locator('.office-sidebar').getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
}
async function createPerson(page: Page, name: string) {
  await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  await dialog.getByLabel('Namn *', { exact: true }).fill(name);
  return dialog;
}

test('ny personal får ett enda kopplat konto och behörigheter sparas på personkortet', async ({ page, request }) => {
  await office(page);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Användare', exact: true })).toHaveCount(0);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Personal', exact: true })).toHaveCount(1);
  const name = `Kontor ${randomUUID().slice(0, 8)}`;
  const before = await users(request);
  const dialog = await createPerson(page, name);
  await expect(dialog.getByRole('checkbox', { name: 'Skapa inloggning', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inloggning & behörigheter', exact: true })).toBeVisible();
  const person = (await personnel(request)).data.people.find(value => value.name === name)!;
  expect(person.userId).toBeTruthy();
  const createdUsers = await users(request);
  expect(createdUsers).toHaveLength(before.length + 1);
  expect(createdUsers.filter(value => value.name === name)).toHaveLength(1);
  expect(createdUsers.find(value => value.id === person.userId)).toMatchObject({ name, level: 'Medarbetare', maxAttest: 0, ownAttest: false });
  await page.getByLabel('Skapa och ändra personalprofiler', { exact: true }).check();
  await expect(page.getByLabel('Läsa personalregistret', { exact: true })).toBeChecked();
  await page.getByLabel('Maxbelopp för attest (kr)', { exact: true }).fill('15000');
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect.poll(async () => (await users(request)).find(value => value.id === person.userId)?.maxAttest).toBe(15000);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Inloggning & behörigheter', exact: true })).toBeVisible();
  await expect(page.getByLabel('Skapa och ändra personalprofiler', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Läsa personalregistret', { exact: true })).toBeChecked();
  expect((await personnel(request)).data.people.find(value => value.id === person.id)?.userId).toBe(person.userId);
  expect((await users(request)).filter(value => value.name === name)).toHaveLength(1);
  await page.getByLabel('Aktivt inloggningskonto', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect.poll(async () => (await users(request)).find(value => value.id === person.userId)?.active).toBe(false);
  expect((await personnel(request)).data.people.find(value => value.id === person.id)).toMatchObject({ name, userId: person.userId, active: true });
});

test('personal utan inloggning kan kopplas till befintligt konto utan att skapa en dublett', async ({ page, request }) => {
  const existing: OfficeUser = { id: `link-${randomUUID()}`, name: `Befintligt ${randomUUID().slice(0, 8)}`, level: 'Medarbetare', permissions: ['view'], siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false, active: true };
  const originalUsers = await users(request);
  expect((await request.post('/api/pricing/users', { headers: admin, data: { users: [...originalUsers, existing] } })).ok()).toBe(true);
  await office(page);
  const name = `Utan konto ${randomUUID().slice(0, 8)}`;
  const dialog = await createPerson(page, name);
  await dialog.getByRole('checkbox', { name: 'Skapa inloggning', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const created = (await personnel(request)).data.people.find(value => value.name === name)!;
  expect(created.userId).toBeUndefined();
  expect(await users(request)).toHaveLength(originalUsers.length + 1);
  await page.getByRole('navigation', { name: 'Personalkortets flikar', exact: true }).getByRole('button', { name: 'Inloggning & behörigheter', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa eller koppla konto', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Redigera person', exact: true });
  await edit.getByLabel('Befintligt användarkonto', { exact: true }).selectOption(existing.id);
  await edit.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inloggning & behörigheter', exact: true })).toBeVisible();
  expect((await personnel(request)).data.people.find(value => value.id === created.id)?.userId).toBe(existing.id);
  expect(await users(request)).toHaveLength(originalUsers.length + 1);
  await page.reload();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(existing.name);
  expect((await personnel(request)).data.people.filter(value => value.userId === existing.id)).toHaveLength(1);
});

test('fristående administratörskonton finns under Personal och gamla användarlänkar fungerar', async ({ page }) => {
  await office(page);
  await page.getByRole('navigation', { name: 'Personal', exact: true }).getByRole('button', { name: 'Konton', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Konton & behörigheter', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Systemadmin Systemadmin', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Systemadmin');
  await page.goto('/kontor#/users?user=admin');
  await expect(page.getByRole('heading', { name: 'Konton & behörigheter', exact: true })).toBeVisible();
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Personal', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Användare', exact: true })).toHaveCount(0);
});

test('extern personal får chaufförsinloggning vid skapandet; återställning och spärr avslutar sessioner', async ({ page, browser, request }) => {
  await office(page);
  const suffix = randomUUID().slice(0, 8);
  const name = `Extern ${suffix}`;
  const username = `extern.${suffix}`;
  const password = `Demo-${randomUUID()}`;
  const nextPassword = `Ny-${randomUUID()}`;
  const dialog = await createPerson(page, name);
  await dialog.getByLabel('Persontyp', { exact: true }).selectOption('external');
  await dialog.getByLabel('Åkeri *', { exact: true }).selectOption('carrier-roslagen');
  await dialog.getByLabel('Ordinarie fordon', { exact: true }).selectOption('vehicle-oskar');
  await expect(dialog.getByRole('checkbox', { name: 'Skapa inloggning', exact: true })).toBeChecked();
  await dialog.getByLabel('Användarnamn *', { exact: true }).fill(username);
  await dialog.getByLabel('Lösenord *', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const state = await personnel(request);
  const person = state.data.people.find(value => value.name === name)!;
  expect(state.data.externalAccounts.find(value => value.personId === person.id)).toMatchObject({ username, active: true });
  expect(person.userId).toBeUndefined();
  expect((await users(request)).some(value => value.name === name)).toBe(false);
  const origin = new URL(page.url()).origin;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const driver = await context.newPage();
    await driver.goto(`${origin}/chauffor`);
    await driver.getByLabel('Inloggningsnamn', { exact: true }).fill(username);
    await driver.getByLabel('Lösenord', { exact: true }).fill(password);
    await driver.getByRole('button', { name: 'Logga in', exact: true }).click();
    await expect(driver.getByRole('heading', { name: 'Hej, Extern', exact: true })).toBeVisible();
    await expect(driver.locator('.driver-order-number')).toHaveCount(0);
    const foreignOrder = state.transport.orders.find(value => value.driverId)!;
    expect((await driver.request.post(`${origin}/api/driver/orders/${foreignOrder.id}/status`, { data: { status: 'on_way' } })).status()).toBe(403);
    expect([401, 403]).toContain((await driver.request.get(`${origin}/api/application/personnel`)).status());
    await page.getByRole('button', { name: 'Hantera inloggning', exact: true }).click();
    let account = page.getByRole('dialog', { name: 'Extern chaufför · användarkonto', exact: true });
    await account.getByLabel(/Nytt lösenord/).fill(nextPassword);
    await account.getByRole('button', { name: 'Spara konto', exact: true }).click();
    await expect(account).toContainText('Kontot är sparat. Lösenordet visas inte igen.');
    expect((await driver.request.get(`${origin}/api/driver/session`)).status()).toBe(401);
    expect((await driver.request.post(`${origin}/api/driver/login`, { data: { username, password } })).status()).toBe(401);
    expect((await driver.request.post(`${origin}/api/driver/login`, { data: { username, password: nextPassword } })).ok()).toBe(true);
    await account.getByRole('button', { name: 'Stäng', exact: true }).click();
    await page.getByRole('button', { name: 'Hantera inloggning', exact: true }).click();
    account = page.getByRole('dialog', { name: 'Extern chaufför · användarkonto', exact: true });
    await account.getByRole('checkbox', { name: 'Konto aktivt', exact: true }).uncheck();
    await account.getByRole('button', { name: 'Spara konto', exact: true }).click();
    await expect(account).toContainText('Kontot är sparat. Lösenordet visas inte igen.');
    expect((await driver.request.get(`${origin}/api/driver/session`)).status()).toBe(401);
    expect((await driver.request.post(`${origin}/api/driver/login`, { data: { username, password: nextPassword } })).status()).toBe(401);
    expect(JSON.stringify((await personnel(request)).data.externalAccounts)).not.toContain(nextPassword);
    expect(await driver.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(password);
  } finally { await context.close(); }
});
