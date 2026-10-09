import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { EnvironmentState } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(60_000);

async function openReceipt(page: Page, origin = 'Industrivägen 8, 761 41 Norrtälje') {
  const data = migrateOffice(seedOffice());
  const cardId = 61_000_000 + randomInt(1_000_000), sourceId = randomUUID();
  data.cards.push({ ...data.cards.find(card => card.id === 2050)!, id: cardId, sourceId, origin });
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await page.goto(`/kontor#/weighings/${cardId}`);
  const panel = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
  await expect(panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true })).toBeEnabled();
  return { panel, sourceId };
}
async function state(page: Page): Promise<EnvironmentState> {
  const response = await page.request.get('/api/environment/state');
  expect(response.ok()).toBe(true); return response.json();
}

test('kundbyte uppdaterar dokumentförval, manuellt nummer bevaras och hopfälld mottagning kan bekräftas', async ({ page }) => {
  const { panel, sourceId } = await openReceipt(page);
  const initial = await state(page);
  const headers = { 'X-Environment-CSRF': (await (await page.request.get('/api/environment/session')).json()).csrfToken };
  const policy = await page.request.put('/api/environment/storage/policies/norrtalje', { headers, data: {
    expectedVersion: initial.storagePolicies.find(item => item.siteId === 'norrtalje')?.version ?? 0,
    totalMaxKg: 1_000_000, rules: [{ wasteCode: '160601', allowed: true, maxKg: 999_999_999 }],
  } });
  expect(policy.ok()).toBe(true);
  const classification = initial.classifications.find(item => item.articleId === 'lead-battery')!;
  const classified = await page.request.put('/api/environment/classifications/lead-battery', { headers, data: {
    expectedVersion: classification.version, hazardous: classification.hazardous, wasteCode: classification.wasteCode,
    wasteDescription: classification.wasteDescription, handlingInstructions: classification.handlingInstructions, adrRequired: classification.adrRequired,
    storageRules: [{ siteId: 'norrtalje', allowed: true, maxKg: 2000 }],
  } });
  expect(classified.ok()).toBe(true);
  await page.reload();
  const confirm = panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm).not.toHaveClass(/needs-details/);
  await confirm.click();
  const dialog = page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true });
  await expect(dialog).toContainText('Blybatterier');
  await expect(dialog).not.toContainText('Koppar');
  await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await expect(panel.locator('.environment-receipt-editor')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  const storage = panel.getByRole('region', { name: 'Lagringskontroll', exact: true });
  await expect(storage.locator('li')).toHaveCount(2);
  await expect(storage).toContainText('Blybatterier');
  await expect(storage).not.toContainText('Avfallskod');
  await expect(storage).toContainText('/ 2 000 kg');
  const documentStatus = panel.getByLabel('Dokumentstatus', { exact: true });
  await expect(documentStatus).toHaveValue('not_shown');
  await expect(panel.locator('.environment-document-notice')).toBeVisible();
  await page.getByLabel('Kund på vägningen', { exact: true }).selectOption('customer-erik');
  await expect(documentStatus).toHaveValue('not_required');
  await expect(panel.locator('.environment-document-notice')).toHaveCount(0);
  await page.getByLabel('Kund på vägningen', { exact: true }).selectOption('customer-build');
  await expect(documentStatus).toHaveValue('not_shown');
  await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(async () => (await state(page)).drafts.find(item => item.sourceId === sourceId)?.input.incomingDocument).toMatchObject({ status: 'not_shown', selection: 'automatic' });
  await page.reload();
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(documentStatus).toHaveValue('not_shown');
  await panel.getByLabel('Inkommande transportdokument', { exact: true }).fill('TD-123');
  await expect(documentStatus).toHaveValue('provided');
  await page.getByLabel('Kund på vägningen', { exact: true }).selectOption('customer-erik');
  await expect(documentStatus).toHaveValue('provided');
  await expect(panel.getByLabel('Inkommande transportdokument', { exact: true })).toHaveValue('TD-123');
  await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(async () => (await state(page)).drafts.find(item => item.sourceId === sourceId)?.input.incomingDocument).toMatchObject({ status: 'provided', selection: 'manual', reference: 'TD-123' });
  // Selecting another customer clears the weight card's origin in the existing office flow.
  await page.getByLabel('Ursprungsadress', { exact: true }).fill('Industrivägen 8, 761 41 Norrtälje');
  await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
  await expect(confirm).not.toHaveClass(/needs-details/);
  await panel.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await expect.poll(async () => (await state(page)).drafts.find(item => item.sourceId === sourceId)?.input.originAddress).toBe('Industrivägen 8, 761 41 Norrtälje');
  await page.reload();
  await expect(confirm).not.toHaveClass(/needs-details/);
  await confirm.click();
  await dialog.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect.poll(async () => (await state(page)).receipts.find(item => item.sourceId === sourceId)?.snapshot.incomingDocument).toMatchObject({ status: 'provided', selection: 'manual', reference: 'TD-123' });
  await expect(panel.locator('.environment-receipt-editor')).toHaveCount(0);
});

test('saknad kommun förklaras från hopfällt kort och expanderad mottagning bekräftas direkt utan dokumentnummer', async ({ page }) => {
  await page.route('**/api/environment/address/resolve', async route => {
    const input = route.request().postDataJSON();
    await route.fulfill({ json: { originAddress: input.originAddress, status: input.municipalityCode ? 'resolved' : 'needs_municipality', provider: 'explicit-browser-test', municipalityConfirmed: Boolean(input.municipalityCode),
      place: { address: 'Testvägen 4', postalCode: '12345', city: 'Testort', municipalityCode: input.municipalityCode ?? '' }, missingFields: input.municipalityCode ? [] : ['municipalityCode'], candidates: [] } });
  });
  const { panel, sourceId } = await openReceipt(page, 'Testvägen 4, 123 45 Testort');
  const confirm = panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true });
  await expect(panel.getByRole('region', { name: 'Lagringskontroll', exact: true })).toHaveAttribute('aria-busy', 'false');
  await expect(confirm).toHaveClass(/needs-details/);
  await confirm.click();
  await expect(panel.getByRole('alert')).toContainText(/ursprungsadress|kommun|kontrollen av ursprungsadressen/);
  const municipality = panel.getByLabel('Kommun för ursprungsadressen', { exact: true });
  await expect(municipality).toBeVisible();
  await municipality.selectOption('0188');
  await expect(confirm).not.toHaveClass(/needs-details/);
  await expect(panel.getByLabel('Dokumentstatus', { exact: true })).toHaveValue('not_shown');
  await confirm.click();
  await expect.poll(async () => (await state(page)).receipts.find(item => item.sourceId === sourceId)?.snapshot.incomingDocument).toMatchObject({ status: 'not_shown', reference: '' });
  await expect(page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true })).toHaveCount(0);
  await expect(panel.locator('.environment-receipt-editor')).toHaveCount(0);
});
