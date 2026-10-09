import { randomInt, randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { EnvironmentSite, EnvironmentState, WasteClassification } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);

async function login(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect.poll(async () => (await page.request.get('/api/environment/session')).ok()).toBe(true);
}
async function shared(page: Page): Promise<EnvironmentState> {
  const response = await page.request.get('/api/environment/state');
  expect(response.ok()).toBe(true); return response.json();
}
async function headers(page: Page) {
  return { 'X-Environment-CSRF': (await (await page.request.get('/api/environment/session')).json()).csrfToken };
}
async function site(page: Page, name: string): Promise<EnvironmentSite> {
  const response = await page.request.put(`/api/environment/sites/e2e-${randomUUID().slice(0, 8)}`, { headers: await headers(page), data: {
    expectedVersion: 0, name, address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188', active: true, permitReference: 'TEST – inget verkligt tillstånd', permitNotes: '',
  } });
  expect(response.ok()).toBe(true); return response.json();
}
async function saveClassification(page: Page, current: WasteClassification, storageRules: WasteClassification['storageRules']) {
  const response = await page.request.put('/api/environment/classifications/lead-battery', { headers: await headers(page), data: {
    expectedVersion: current.version, hazardous: current.hazardous, wasteCode: current.wasteCode, wasteDescription: current.wasteDescription,
    handlingInstructions: current.handlingInstructions, adrRequired: current.adrRequired, storageRules,
  } });
  expect(response.ok()).toBe(true);
}

test('ny anläggning sparas med policy och blir valbar för terminaler och huvudfilter', async ({ page }) => {
  await login(page);
  await page.goto('/kontor#/facilities');
  await expect(page.getByRole('heading', { name: 'Anläggningar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Ny anläggning', exact: true }).click();
  const name = `Lager E2E ${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Anläggningsnamn', { exact: true }).fill(name);
  await page.getByLabel('Anläggningens gatuadress', { exact: true }).fill('Testgatan 12');
  await page.getByLabel('Anläggningens postnummer', { exact: true }).fill('761 41');
  await page.getByLabel('Anläggningens ort', { exact: true }).fill('Norrtälje');
  await page.getByLabel('Anläggningens kommunkod', { exact: true }).fill('0188');
  await page.getByLabel('Tillståndsreferens', { exact: true }).fill('TEST – inget verkligt tillstånd');
  await page.getByRole('button', { name: 'Spara anläggning', exact: true }).click();
  const policy = page.getByRole('region', { name: `Lagringsregler för ${name}`, exact: true });
  await expect(policy).toBeVisible();
  await policy.getByLabel('Max registrerat lager (kg)', { exact: true }).fill('40');
  await policy.getByRole('button', { name: 'Lägg till avfallskod', exact: true }).click();
  await policy.getByLabel('Avfallskod rad 1', { exact: true }).fill('16 06 01');
  await policy.getByLabel('Tillåt avfallskod rad 1', { exact: true }).check();
  await policy.getByLabel('Max lager rad 1', { exact: true }).fill('25,5');
  await policy.getByRole('button', { name: 'Spara lagringsregler', exact: true }).click();
  await expect(policy).toContainText('Version 1');
  const created = (await shared(page)).sites.find(item => item.name === name)!;
  expect(created.permitReference).toContain('TEST');
  expect((await shared(page)).storagePolicies.find(item => item.siteId === created.id)).toMatchObject({ totalMaxKg: 40, rules: [{ wasteCode: '160601', allowed: true, maxKg: 25.5 }] });
  await expect(page.getByLabel('Anläggning', { exact: true }).locator(`option[value="${created.id}"]`)).toHaveText(name);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByLabel('Tillståndsreferens', { exact: true })).toHaveValue('TEST – inget verkligt tillstånd');
  await page.goto('/kontor#/terminals');
  await expect(page.getByLabel('Anläggning', { exact: true }).last().locator(`option[value="${created.id}"]`)).toHaveText(name);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('artikelns egna platsregler sparar decimaler och nollgräns utan att ändra klassificeringen', async ({ page }) => {
  await login(page);
  const created = await site(page, `Artikelplats ${randomUUID().slice(0, 8)}`);
  await page.goto('/kontor#/prices');
  await page.getByRole('button', { name: 'Redigera Blybatterier', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Miljöklassificering för Blybatterier', exact: true });
  const before = (await shared(page)).classifications.find(item => item.articleId === 'lead-battery')!;
  if (await panel.getByRole('button', { name: 'Ange lagringsregler', exact: true }).count()) await panel.getByRole('button', { name: 'Ange lagringsregler', exact: true }).click();
  await panel.getByLabel('Tillåt lagring på Norrtälje', { exact: true }).check();
  await panel.getByLabel('Max artikelns lager på Norrtälje', { exact: true }).fill('12,5');
  await panel.getByLabel(`Tillåt lagring på ${created.name}`, { exact: true }).check();
  await panel.getByLabel(`Max artikelns lager på ${created.name}`, { exact: true }).fill('0');
  await panel.getByRole('button', { name: 'Spara miljöklassificering', exact: true }).click();
  await expect.poll(async () => (await shared(page)).classifications.find(item => item.articleId === 'lead-battery')?.version).toBe(before.version + 1);
  const after = (await shared(page)).classifications.find(item => item.articleId === 'lead-battery')!;
  expect(after).toMatchObject({ hazardous: before.hazardous, wasteCode: before.wasteCode });
  expect(after.storageRules).toContainEqual({ siteId: 'norrtalje', allowed: true, maxKg: 12.5 });
  expect(after.storageRules).toContainEqual({ siteId: created.id, allowed: true, maxKg: 0 });
  await page.reload();
  await page.getByRole('button', { name: 'Redigera Blybatterier', exact: true }).click();
  await expect(panel.getByLabel(`Max artikelns lager på ${created.name}`, { exact: true })).toHaveValue('0');
});

test('mottagningskortet visar befintligt lager och blockerar överskridande, sedan sparas kontrollen i snapshot', async ({ page }) => {
  const data = migrateOffice(seedOffice());
  const sourceId = randomUUID(), cardId = 58_000_000 + randomInt(1_000_000);
  await login(page);
  const created = await site(page, `Kapacitetsplats ${randomUUID().slice(0, 8)}`);
  let state = await shared(page);
  let classification = state.classifications.find(item => item.articleId === 'lead-battery')!;
  const rules = state.sites.map(item => ({ siteId: item.id, allowed: true, maxKg: item.id === created.id ? 25 : null }));
  await saveClassification(page, classification, rules);
  const savePolicy = async (expectedVersion: number, maxKg: number) => {
    const response = await page.request.put(`/api/environment/storage/policies/${created.id}`, { headers: await headers(page), data: { expectedVersion, totalMaxKg: 50, rules: [{ wasteCode: '160601', allowed: true, maxKg }] } });
    expect(response.ok()).toBe(true);
  };
  await savePolicy(0, 25);
  const place = { address: created.address, postalCode: created.postalCode, city: created.city, municipalityCode: created.municipalityCode };
  const stockResponse = await page.request.post('/api/environment/receipts', { headers: await headers(page), data: {
    sourceId: randomUUID(), cardId: cardId + 1, siteId: created.id, receivedAt: '2026-10-09T10:00:00+02:00', rows: [{ articleId: 'lead-battery', weight: 6 }],
    previousHolder: { name: 'Testbolaget', number: '5560000167', contactName: '', email: '', phone: '' }, lastPlace: place, nextPlace: place, transportMode: 'road', incomingDocument: { status: 'unknown' }, idempotencyKey: randomUUID(),
  } });
  expect(stockResponse.ok()).toBe(true);
  const base = data.cards.find(item => item.id === 2050)!;
  data.cards.push({ ...base, id: cardId, sourceId, siteId: created.id, yard: created.name, origin: 'Industrivägen 8, 761 41 Norrtälje', rows: [{ ...base.rows.find(row => row.articleId === 'lead-battery')!, weight: 20 }] });
  await page.evaluate(value => localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value)), data);
  await page.goto(`/kontor?storage-test=${sourceId}#/weighings/${cardId}`);
  const panel = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
  await expect(panel.getByRole('region', { name: 'Lagringskontroll', exact: true })).toContainText('Mottagningen ryms inte');
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel).toContainText('Registrerat 6 kg');
  await expect(panel).toContainText('Efter 26 kg');
  await panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('överskrider 25 kg');
  expect((await shared(page)).receipts.some(item => item.sourceId === sourceId)).toBe(false);
  await savePolicy(1, 50);
  state = await shared(page); classification = state.classifications.find(item => item.articleId === 'lead-battery')!;
  await saveClassification(page, classification, classification.storageRules!.map(rule => rule.siteId === created.id ? { ...rule, maxKg: 50 } : rule));
  await page.reload();
  await panel.getByRole('button', { name: 'Visa mottagningsuppgifter', exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Lagringskontroll', exact: true })).toContainText('Inom angivna lagringsgränser');
  await expect(panel).toContainText('Norrtälje · 0188');
  await panel.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bekräfta mottagning', exact: true });
  await dialog.getByRole('button', { name: 'Bekräfta mottagning', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await shared(page)).receipts.find(item => item.sourceId === sourceId)?.snapshot.storageAssessment?.canReceive).toBe(true);
  await expect(panel).toContainText('Kontroll vid registrering');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
