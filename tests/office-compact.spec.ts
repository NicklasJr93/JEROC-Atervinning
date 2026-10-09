import { test, expect, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeData } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { randomInt, randomUUID } from 'node:crypto';
import { approveCustomerCard } from './helpers/customer-approval';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function login(page: Page, name = 'Kajsa Nilsson') {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
}

const actor = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function officeData(page: Page): Promise<OfficeData> {
  const response = await page.request.get('/api/application/office', { headers: actor });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}
async function createCard(page: Page, templateId = 2051, patch: Partial<OfficeCard> = {}) {
  const fixture = migrateOffice(seedOffice());
  const card: OfficeCard = { ...fixture.cards.find(value => value.id === templateId)!, ...patch,
    id: 37_000_000 + randomInt(1_000_000), sourceId: randomUUID(), status: 'complement' };
  fixture.cards = [card];
  const imported = await page.request.post('/api/application/office', { headers: actor, data: { kind: 'import', data: fixture } });
  expect(imported.ok(), await imported.text()).toBe(true);
  expect((await officeData(page)).cards.some(value => value.id === card.id)).toBe(true);
  return card;
}

test('snabbkund sparas och kopplas till rätt invägning utan att ändra ett låst kort', async ({ page, request }) => {
  const customerName = `Snabb Återbruk AB ${randomUUID().slice(0, 8)}`;
  const customerNumber = `55${randomInt(1000, 10000)}-${randomInt(1000, 10000)}`;
  await login(page);
  const locked = await createCard(page, 2052);
  const approval = await approveCustomerCard(request, locked);
  const attested = await request.post(`/api/terminal-demo/approvals/${approval.id}/attest`, { data: {} });
  expect(attested.ok(), await attested.text()).toBe(true);
  const card = await createCard(page);
  await page.goto(`/kontor#/weighings/${card.id}`);
  const originalLockedCard = (await officeData(page)).cards.find(value => value.id === locked.id);
  expect(originalLockedCard?.status).toBe('ready');
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Företagsnamn', { exact: true })).toBeFocused();
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill(customerName);
  await dialog.getByLabel('Organisationsnummer', { exact: true }).fill(customerNumber);
  await dialog.getByLabel('Telefon', { exact: true }).fill('0701234567');
  await dialog.getByLabel('E-post', { exact: true }).fill('snabb@example.invalid');
  await dialog.getByLabel('Gatuadress', { exact: true }).fill('Testgatan 12');
  await dialog.getByLabel('Postnummer', { exact: true }).fill('76130');
  await dialog.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await dialog.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/weighings/${card.id}$`));
  const saved = await officeData(page);
  const customer = saved.customers.find(item => item.name === customerName);
  expect(customer).toMatchObject({ type: 'Företag', number: customerNumber, address: 'Testgatan 12', city: 'Norrtälje' });
  expect(saved.cards.find(value => value.id === card.id)?.customerId).toBe(customer!.id);
  expect(saved.cards.find(value => value.id === locked.id)).toEqual(originalLockedCard);
  await page.reload();
  await expect(page.getByLabel('Kund på vägningen', { exact: true })).toHaveValue(customer!.id);
  await expect(page.locator('.office-card-customer')).toContainText(customerName);
});

test('fullständigt kundformulär behåller popupens uppgifter och återgår med vald kund', async ({ page }) => {
  const customerName = `Elin Test ${randomUUID().slice(0, 8)}`;
  const customerNumber = `19800101-${randomInt(1000, 10000)}`;
  await login(page);
  const card = await createCard(page);
  await page.goto(`/kontor#/weighings/${card.id}`);
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByRole('button', { name: 'Privatperson', exact: true }).click();
  await dialog.getByLabel('Namn', { exact: true }).fill(customerName);
  await dialog.getByLabel('Personnummer', { exact: true }).fill(customerNumber);
  await dialog.getByLabel('Telefon', { exact: true }).fill('0701122334');
  await dialog.getByLabel('Gatuadress', { exact: true }).fill('Björkgatan 8');
  await dialog.getByRole('button', { name: 'Öppna fullständigt kundformulär', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Kundtyp', { exact: true })).toHaveValue('Privatperson');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(customerName);
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue(customerNumber);
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('0701122334');
  await expect(page.getByLabel('Adress', { exact: true })).toHaveValue('Björkgatan 8');
  await page.getByLabel('Postnummer', { exact: true }).fill('76130');
  await page.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/weighings/${card.id}$`));
  await expect(page.locator('.office-card-customer')).toContainText(customerName);
  const saved = await officeData(page);
  const customer = saved.customers.find(item => item.name === customerName);
  expect(customer).toMatchObject({ type: 'Privatperson', address: 'Björkgatan 8', postalCode: '76130', city: 'Norrtälje' });
  expect(saved.cards.find(value => value.id === card.id)?.customerId).toBe(customer!.id);
});

test('ett lämnat kundformulär återkopplar inte senare vanlig kundregistrering till den gamla invägningen', async ({ page }) => {
  const customerName = `Fristående registrering AB ${randomUUID().slice(0, 8)}`;
  await login(page);
  const card = await createCard(page);
  await page.goto(`/kontor#/weighings/${card.id}`);
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill('Lämnat utkast AB');
  await dialog.getByRole('button', { name: 'Öppna fullständigt kundformulär', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Lämnat utkast AB');
  await page.locator('.office-sidebar').getByRole('button', { name: 'Kunder', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa kund', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await page.getByLabel('Namn', { exact: true }).fill(customerName);
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/customers\/customer-[^?]+\?tab=details$/);
  expect((await officeData(page)).cards.find(value => value.id === card.id)?.customerId).toBeUndefined();
});

test('profilen ligger i vänstermenyn och Jobba som följer den valda personens rättigheter', async ({ page, request }) => {
  await login(page, 'Systemadmin');
  const card = await createCard(page, 2052, { rows: [{ articleId: 'copper-1', weight: 1000, tier: 'A', price: 82 }] });
  await approveCustomerCard(request, card);
  const profile = page.locator('.office-sidebar-profile');
  await expect(profile).toContainText('Systemadmin');
  await expect(page.locator('.office-topbar')).not.toContainText('Systemadmin');
  const box = await profile.boundingBox();
  expect(box!.y).toBeGreaterThan(600);
  await expect(page.getByLabel('Jobba som', { exact: true })).toBeHidden();
  await profile.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('anna');
  await expect(profile).toContainText('Anna Nilsson');
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Användare', exact: true })).toHaveCount(0);
  await page.goto(`/kontor#/weighings/${card.id}`);
  await expect(page.locator('.office-card-attest').getByRole('button', { name: 'Attestera', exact: true })).toBeDisabled();
  await expect(page.locator('.office-card-attest')).toContainText(/överstiger din attestgräns/);
});

test('spårbarhet behåller lodräta händelser över full bredd och kan scrollas långt ned', async ({ page }) => {
  const audit = Array.from({ length: 25 }, (_, index) => ({
    at: `2026-10-09T10:${String(index).padStart(2, '0')}:00Z`, actor: 'Kajsa Nilsson · Norrtälje', text: `Spårhändelse ${index + 1}`,
  }));
  await login(page);
  const card = await createCard(page, 2052, { audit });
  await page.goto(`/kontor#/weighings/${card.id}`);
  const rows = page.locator('.office-card-audit .office-audit li');
  await expect(rows).toHaveCount(25);
  await expect(rows.first()).toContainText('Spårhändelse 25');
  for (const width of [1440, 2056]) {
    await page.setViewportSize({ width, height: 1000 });
    const panel = await page.locator('.office-card-audit').boundingBox();
    const above = await page.locator('.office-card-summary').boundingBox();
    expect(Math.abs(panel!.x - above!.x)).toBeLessThan(1);
    expect(Math.abs(panel!.width - above!.width)).toBeLessThan(1);
    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    expect(Math.abs(first!.x - second!.x)).toBeLessThan(1);
    expect(second!.y).toBeGreaterThanOrEqual(first!.y + first!.height);
  }
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});
