import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { seedOffice } from '../src/office/model';
import { createOfficeCard, readOffice, saveOffice } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

test('kundadress och Swishnummer kopieras bara efter aktivt val, sparas kanoniskt och manuella val blir kundförslag', async ({ page, request }) => {
  const customer = {
    ...structuredClone(seedOffice().customers.find(item => item.id === 'customer-build')!),
    id: `copy-customer-${randomUUID()}`, customerNumber: `TEST-${randomUUID().slice(0, 8)}`,
    number: '559359-3626', phone: '0722002220',
    address: 'Storgatan 12, 761 41 Norrtälje', postalCode: '761 41', city: 'Norrtälje',
    origins: [], references: [],
  };
  const { cardId } = await createOfficeCard(request, { customer });
  const base = await readOffice(request), next = structuredClone(base);
  Object.assign(next.cards.find(item => item.id === cardId)!, { origin: '', reference: '' });
  await saveOffice(request, base, next);

  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto(`/kontor#/weighings/${cardId}`);
  const origin = page.getByLabel('Ursprungsadress', { exact: true });
  const addressCopy = page.getByRole('checkbox', { name: 'Använd kundens adress som ursprungsadress', exact: true });
  await expect(origin).toHaveValue('');
  await expect(addressCopy).not.toBeChecked();
  await addressCopy.check();
  await expect(origin).toHaveValue('Storgatan 12, 76141 Norrtälje');
  await origin.fill('Testgatan 17, 761 41 Norrtälje');
  await expect(addressCopy).not.toBeChecked();
  await page.getByLabel('Referens', { exact: true }).fill('Projekt kopieringsprov');
  await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).cards.find(item => item.id === cardId)?.origin)
    .toBe('Testgatan 17, 76141 Norrtälje');
  const updated = (await readOffice(request)).customers.find(item => item.id === customer.id)!;
  expect(updated.origins).toContain('Testgatan 17, 76141 Norrtälje');
  expect(updated.references).toContain('Projekt kopieringsprov');

  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  const phone = page.locator('.office-card-payment').getByLabel('Telefonnummer', { exact: true });
  const phoneCopy = page.getByRole('checkbox', { name: 'Använd kundens telefonnummer', exact: true });
  await expect(phone).toHaveValue('');
  await expect(phoneCopy).not.toBeChecked();
  await phoneCopy.check();
  await expect(phone).toHaveValue('+46722002220');
  await phone.fill('0722341234');
  await expect(phoneCopy).not.toBeChecked();
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).cards.find(item => item.id === cardId)?.paymentDetails?.phone)
    .toBe('+46722341234');
  await expect(phoneCopy).toHaveCount(0);
  await page.reload();
  await expect(origin).toHaveValue('Testgatan 17, 76141 Norrtälje');
  await expect(addressCopy).not.toBeChecked();
  await expect(phone).toHaveValue('+46722341234');
});

test('befintligt Swishnummer ersätts inte med kundens kontakttelefon', async ({ page, request }) => {
  const customer = {
    ...structuredClone(seedOffice().customers.find(item => item.id === 'customer-build')!),
    id: `copy-existing-${randomUUID()}`, customerNumber: `TEST-${randomUUID().slice(0, 8)}`,
    number: '5593593626', phone: '+46722002220',
  };
  const { cardId } = await createOfficeCard(request, { customer,
    paymentDetails: { method: 'swish', phone: '+46722341234', recipient: customer.name } });
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-card-payment').getByLabel('Telefonnummer', { exact: true })).toHaveValue('+46722341234');
  await expect(page.getByRole('checkbox', { name: 'Använd kundens telefonnummer', exact: true })).toHaveCount(0);
});
