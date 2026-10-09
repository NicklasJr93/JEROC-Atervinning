import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { randomInt, randomUUID } from 'node:crypto';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function login(page: Page, name = 'Kajsa Nilsson') {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
}

test('snabbkund sparas och kopplas till rätt invägning utan att ändra ett låst kort', async ({ page }) => {
  const fixture = migrateOffice(seedOffice());
  const lockedId = 36_000_000 + randomInt(1_000_000);
  const approvedAt = '2026-10-09T10:00:00Z';
  fixture.cards.push({ ...fixture.cards.find(card => card.id === 2052)!, id: lockedId, sourceId: randomUUID(), status: 'ready',
    customerSnapshot: fixture.customers.find(customer => customer.id === 'customer-build')!,
    preparedBy: 'kajsa', approvedBy: 'anna', customerApproval: { id: randomUUID(), version: 1, status: 'attested', updatedAt: approvedAt, approvedAt, approvedBy: 'Personal · UI-test', attestedAt: approvedAt, attestedBy: 'Anna Nilsson' } });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
  await login(page);
  await page.goto('/kontor#/weighings/2051');
  const originalLockedCard = await page.evaluate(id => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === id), lockedId);
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Företagsnamn', { exact: true })).toBeFocused();
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill('Snabb Återbruk AB');
  await dialog.getByLabel('Organisationsnummer', { exact: true }).fill('559988-1234');
  await dialog.getByLabel('Telefon', { exact: true }).fill('0701234567');
  await dialog.getByLabel('E-post', { exact: true }).fill('snabb@example.invalid');
  await dialog.getByLabel('Gatuadress', { exact: true }).fill('Testgatan 12');
  await dialog.getByLabel('Postnummer', { exact: true }).fill('76130');
  await dialog.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await dialog.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/weighings\/2051$/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!));
  const customer = saved.customers.find((item: { name: string }) => item.name === 'Snabb Återbruk AB');
  expect(customer).toMatchObject({ type: 'Företag', number: '559988-1234', address: 'Testgatan 12', city: 'Norrtälje' });
  expect(saved.cards.find((card: { id: number }) => card.id === 2051).customerId).toBe(customer.id);
  expect(saved.cards.find((card: { id: number }) => card.id === lockedId)).toEqual(originalLockedCard);
  await page.reload();
  await expect(page.getByLabel('Kund på vägningen', { exact: true })).toHaveValue(customer.id);
  await expect(page.locator('.office-card-customer')).toContainText('Snabb Återbruk AB');
});

test('fullständigt kundformulär behåller popupens uppgifter och återgår med vald kund', async ({ page }) => {
  await login(page);
  await page.goto('/kontor#/weighings/2051');
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByRole('button', { name: 'Privatperson', exact: true }).click();
  await dialog.getByLabel('Namn', { exact: true }).fill('Elin Test');
  await dialog.getByLabel('Personnummer', { exact: true }).fill('19800101-1234');
  await dialog.getByLabel('Telefon', { exact: true }).fill('0701122334');
  await dialog.getByLabel('Gatuadress', { exact: true }).fill('Björkgatan 8');
  await dialog.getByRole('button', { name: 'Öppna fullständigt kundformulär', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Kundtyp', { exact: true })).toHaveValue('Privatperson');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Elin Test');
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue('19800101-1234');
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('0701122334');
  await expect(page.getByLabel('Adress', { exact: true })).toHaveValue('Björkgatan 8');
  await page.getByLabel('Postnummer', { exact: true }).fill('76130');
  await page.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page).toHaveURL(/\/weighings\/2051$/);
  await expect(page.locator('.office-card-customer')).toContainText('Elin Test');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!));
  const customer = saved.customers.find((item: { name: string }) => item.name === 'Elin Test');
  expect(customer).toMatchObject({ type: 'Privatperson', address: 'Björkgatan 8', postalCode: '76130', city: 'Norrtälje' });
  expect(saved.cards.find((card: { id: number }) => card.id === 2051).customerId).toBe(customer.id);
});

test('ett lämnat kundformulär återkopplar inte senare vanlig kundregistrering till den gamla invägningen', async ({ page }) => {
  await login(page);
  await page.goto('/kontor#/weighings/2051');
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill('Lämnat utkast AB');
  await dialog.getByRole('button', { name: 'Öppna fullständigt kundformulär', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Lämnat utkast AB');
  await page.locator('.office-sidebar').getByRole('button', { name: 'Kunder', exact: true }).click();
  await page.getByRole('button', { name: 'Skapa kund', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await page.getByLabel('Namn', { exact: true }).fill('Fristående registrering AB');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fristående registrering AB', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/customers\/customer-[^?]+\?tab=details$/);
  const card = await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((item: { id: number }) => item.id === 2051));
  expect(card.customerId).toBeUndefined();
});

test('profilen ligger i vänstermenyn och Jobba som följer den valda personens rättigheter', async ({ page }) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 37_000_000 + randomInt(1_000_000);
  const approvedAt = '2026-10-09T10:00:00Z';
  fixture.cards.push({ ...fixture.cards.find(card => card.id === 2052)!, id: cardId, sourceId: randomUUID(), status: 'attest', preparedBy: 'kajsa',
    rows: [{ articleId: 'copper-1', weight: 1000, tier: 'A', price: 82 }],
    customerApproval: { id: randomUUID(), version: 1, status: 'approved', updatedAt: approvedAt, approvedAt, approvedBy: 'Personal · UI-test' } });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
  await login(page, 'Systemadmin');
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
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-card-attest').getByRole('button', { name: 'Attestera', exact: true })).toBeDisabled();
  await expect(page.locator('.office-card-attest')).toContainText(/överstiger din attestgräns/);
});

test('spårbarhet behåller lodräta händelser över full bredd och kan scrollas långt ned', async ({ page }) => {
  const fixture = migrateOffice(seedOffice());
  fixture.cards.find(card => card.id === 2052)!.audit = Array.from({ length: 25 }, (_, index) => ({
    at: `2026-10-09T10:${String(index).padStart(2, '0')}:00Z`, actor: 'Kajsa Nilsson · Norrtälje', text: `Spårhändelse ${index + 1}`,
  }));
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
  await login(page);
  await page.goto('/kontor#/weighings/2052');
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
