import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { seedOffice } from '../src/office/model';
import { createOfficeCard, readOffice } from './helpers/financial-card';
import { testOrganisationNumber } from './helpers/customer-identity';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function login(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
}

test('kundkort öppnas låst och Avbryt återställer kontakt, betalningsprofil och sparade val', async ({ page, request }) => {
  const customer = { ...structuredClone(seedOffice().customers.find(row => row.id === 'customer-build')!),
    id: `edit-mode-${randomUUID()}`, name: `Läsläge ${randomUUID().slice(0, 8)}`, number: testOrganisationNumber(),
    phone: '+46722002220', paymentProfile: { method: 'cash' as const }, references: ['Projekt A'], origins: ['Storgatan 12, 76141 Norrtälje'] };
  await createOfficeCard(request, { customer });
  await login(page);
  await page.goto(`/kontor#/customers/${customer.id}?tab=details`);
  await expect(page.getByLabel('Namn', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Telefon', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Spara kunduppgifter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lägg till referens', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redigera kund', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redigera kund', exact: true })).toHaveCount(0);
  await expect(page.locator('.customer-profile-title').getByRole('button', { name: 'Spara kunduppgifter', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Spara betalningsprofil', exact: true })).toHaveCount(0);
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Osparad kontakt');
  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('0722002220');
  await page.getByLabel('Ny referens', { exact: true }).fill('Osparad referens');
  await page.getByRole('button', { name: 'Lägg till referens', exact: true }).click();
  await page.locator('.customer-profile-title').getByRole('button', { name: 'Avbryt', exact: true }).click();
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue(customer.contactPerson);
  await expect(page.locator('.office-payment-readonly')).toContainText('Kontant betalning vald');
  await expect(page.getByText('Osparad referens', { exact: true })).toHaveCount(0);
  const saved = (await readOffice(request)).customers.find(row => row.id === customer.id)!;
  expect(saved.contactPerson).toBe(customer.contactPerson);
  expect(saved.paymentProfile).toEqual({ method: 'cash' });
  expect(saved.references).toEqual(['Projekt A']);
});

test('felaktigt nummer stoppas lokalt och misslyckat sparande behåller utkast tills ett lyckat sparande låser kortet', async ({ page, request }) => {
  const customer = { ...structuredClone(seedOffice().customers.find(row => row.id === 'customer-build')!),
    id: `edit-save-${randomUUID()}`, name: `Spara test ${randomUUID().slice(0, 8)}`, number: testOrganisationNumber(), paymentProfile: { method: 'cash' as const } };
  await createOfficeCard(request, { customer });
  await login(page);
  await page.goto(`/kontor#/customers/${customer.id}?tab=details`);
  await page.getByRole('button', { name: 'Redigera kund', exact: true }).click();
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(customer.number + '1');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.locator('.customer-error')).toContainText('10 siffror');
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(customer.number);
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Sparad kontakt');
  await page.getByLabel('Telefon', { exact: true }).fill('072 200 22 20');
  await page.route('**/api/pricing/customers', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tillfälligt fel' }) }));
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.locator('.customer-error')).toContainText('kunde inte sparas');
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('Sparad kontakt');
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toBeEnabled();
  await page.unroute('**/api/pricing/customers');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redigera kund', exact: true })).toBeVisible();
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toBeDisabled();
  await expect.poll(async () => (await readOffice(request)).customers.find(row => row.id === customer.id)?.phone).toBe('+46722002220');
  await page.reload();
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('Sparad kontakt');
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toBeDisabled();
});

test('snabbkund visar formatfel och kan välja en befintlig kund utan att skriva om kundregistret', async ({ page, request }) => {
  const { cardId } = await createOfficeCard(request), office = await readOffice(request);
  const existing = office.customers.find(row => row.id === 'customer-build')!;
  const name = `Ogiltig snabbkund ${randomUUID().slice(0, 8)}`;
  await login(page);
  await page.goto(`/kontor#/weighings/${cardId}`);
  await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ny kund', exact: true });
  await dialog.getByLabel('Företagsnamn', { exact: true }).fill(name);
  await dialog.getByLabel('Organisations-/personnummer', { exact: true }).fill(existing.number + '1');
  await dialog.getByRole('button', { name: 'Spara och välj kund', exact: true }).click();
  await expect(dialog.getByLabel('Organisations-/personnummer', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.quick-customer-error')).toContainText('10 siffror');
  await dialog.getByLabel('Organisations-/personnummer', { exact: true }).fill(existing.number);
  const duplicate = dialog.locator('.quick-customer-duplicate > div').filter({ hasText: existing.customerNumber });
  await expect(duplicate).toContainText(existing.name);
  await duplicate.getByRole('button', { name: 'Välj befintlig kund', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await readOffice(request)).cards.find(row => row.id === cardId)?.customerId).toBe(existing.id);
  const after = await readOffice(request);
  expect(after.customers.find(row => row.id === existing.id)).toEqual(existing);
  expect(after.customers.some(row => row.name === name)).toBe(false);
});
