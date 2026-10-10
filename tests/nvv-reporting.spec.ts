import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { OfficeCustomer, OfficeUser } from '../src/office/model';
import type {
  EnvironmentalCorrectionInput, EnvironmentalReceipt, EnvironmentalReceiptInput,
  EnvironmentSessionState, EnvironmentState, NvvIntegrationStatus, NvvReportDetail,
} from '../src/office/environment-types';
import { approveCustomerCard } from './helpers/customer-approval';
import { createOfficeCard, readOffice, saveOffice } from './helpers/financial-card';
import { changeOfficeCard } from './helpers/office-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(90_000);
test.describe.configure({ mode: 'serial' });

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function api<T>(request: APIRequestContext, path: string, method = 'GET', data?: unknown, headers?: Record<string, string>): Promise<T> {
  const response = await request.fetch(path, { method, data, headers });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.json();
}
const state = (request: APIRequestContext) => api<EnvironmentState>(request, '/api/environment/state');
const status = (request: APIRequestContext) => api<NvvIntegrationStatus>(request, '/api/environment/nvv/status');
const detail = (request: APIRequestContext, id: string) => api<NvvReportDetail>(request, `/api/environment/nvv/reports/${encodeURIComponent(id)}`);
async function session(request: APIRequestContext) {
  return api<EnvironmentSessionState>(request, '/api/environment/session');
}
function mutationHeaders(value: EnvironmentSessionState) {
  return { 'X-Environment-CSRF': value.csrfToken, 'X-Environment-Actual-User': value.actualUserId, 'X-Environment-Effective-User': value.effectiveUserId };
}
async function office(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await api(page.request, '/api/environment/demo-session', 'POST', { userId: 'admin', effectiveUserId: 'admin' });
  const configured = await status(page.request);
  test.skip(configured.mode !== 'mock', 'Run this mock-only integration with server NVV_ENVIRONMENT=mock. No NVV credentials or live network are used.');
}
async function receiptFixture(page: Page, siteId = 'norrtalje') {
  const before = await readOffice(page.request), suffix = randomUUID().slice(0, 8);
  const customer: OfficeCustomer = { ...structuredClone(before.customers.find(value => value.type === 'Företag')!),
    id: `nvv-customer-${suffix}`, customerNumber: `NVV-${suffix}`, name: `NVV testkund ${suffix}`,
    number: '5560000167', email: `${suffix}@example.test`, phone: '0101234567', address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje' };
  const fixture = await createOfficeCard(page.request, { customer, date: new Date().toISOString(), rows: [{ articleId: 'lead-battery', weight: 100, price: 4.5, tier: 'A' }] });
  const environment = await state(page.request), site = environment.sites.find(value => value.id === siteId)!;
  if (siteId !== fixture.card.siteId) {
    const base = await readOffice(page.request), next = structuredClone(base);
    const card = next.cards.find(value => value.id === fixture.cardId)!;
    card.siteId = site.id; card.yard = site.name;
    await saveOffice(page.request, base, next); fixture.card = card;
  }
  // Receive a genuinely reviewed card through the same durable APIs as the app.
  await approveCustomerCard(page.request, fixture.card, { customer, siteId: site.id, siteName: site.name });
  const input: EnvironmentalReceiptInput = {
    sourceId: fixture.card.sourceId!, cardId: fixture.cardId, siteId: site.id,
    receivedAt: new Date().toISOString(), materialScope: 'hazardous', originAddress: fixture.card.origin,
    rows: [{ articleId: 'lead-battery', weight: 100 }],
    previousHolder: { name: customer.name, number: customer.number, contactName: 'Test Person', email: customer.email, phone: customer.phone },
    lastPlace: { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
    nextPlace: { address: site.address || 'Testvägen 1', postalCode: site.postalCode || '76231', city: site.city, municipalityCode: site.municipalityCode },
    transportMode: 'road', incomingDocument: { status: 'provided', reference: `TD-${suffix}` }, idempotencyKey: randomUUID(),
  };
  const received = await api<EnvironmentalReceipt>(page.request, '/api/environment/receipts', 'POST', input, mutationHeaders(await session(page.request)));
  const report = (await state(page.request)).reports.find(value => value.receiptId === received.id)!;
  return { ...fixture, input, received, report };
}
async function openReport(page: Page, cardId: number) {
  await page.goto('/kontor#/environment');
  await page.getByRole('button', { name: `Visa miljöunderlag för INV-${cardId}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Miljöunderlag INV-${cardId}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function openSettings(page: Page, inspectPlanned = false) {
  await page.goto('/kontor#/integrations');
  await expect(page.getByRole('heading', { name: 'Integrationer', exact: true })).toBeVisible();
  const nvvCard = page.getByRole('button', { name: 'Naturvårdsverket', exact: true });
  await expect(nvvCard).toBeVisible();
  await expect(page.locator('.integration-grid > button')).toHaveCount(8);
  await page.screenshot({ path: test.info().outputPath('integrations-grid-1440.png'), fullPage: true });
  if (inspectPlanned) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath('integrations-grid-390.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Spiris / Visma eEkonomi', exact: true }).click();
    await expect(page.locator('.integration-planned')).toContainText('Planerad integration');
    await expect(page.getByRole('button', { name: /^(Anslut|Koppla)/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Alla integrationer', exact: true }).click();
  }
  await nvvCard.click();
  await expect(page).toHaveURL(/#\/integrations\?service=nvv$/);
  const settings = page.getByRole('region', { name: 'NVV-inställningar', exact: true });
  await expect(settings.getByLabel('Organisationsnamn', { exact: true })).toBeVisible();
  return settings;
}

test('simulerad NVV-rapport visar tydlig testkvittens och rättelse bevarar båda rapportversionerna', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await office(page);
  const fixture = await receiptFixture(page);
  const settings = await openSettings(page, true);
  const reporterName = `NVV Testorganisation ${randomUUID().slice(0, 8)}`;
  await settings.getByLabel('Organisationsnamn', { exact: true }).fill(reporterName);
  await settings.getByLabel('Organisationsnummer', { exact: true }).fill('5560000167');
  await settings.getByLabel('Kontaktperson', { exact: true }).fill('Test Person');
  await settings.getByLabel('E-post', { exact: true }).fill('nvv-test@example.test');
  await settings.getByLabel('Telefon', { exact: true }).fill('0101234567');
  await settings.getByRole('button', { name: 'Spara testorganisation', exact: true }).click();
  await expect.poll(async () => (await status(page.request)).reporter?.name).toBe(reporterName);
  await settings.getByRole('button', { name: 'Prova simulerad anslutning', exact: true }).click();
  await expect.poll(async () => (await status(page.request)).connected).toBe(true);
  expect(await status(page.request)).toMatchObject({ mode: 'mock', productionEnabled: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('nvv-settings-1440.png'), fullPage: true });

  let dialog = await openReport(page, fixture.cardId);
  let reporting = dialog.getByRole('region', { name: 'NVV-rapportering', exact: true });
  await reporting.getByRole('button', { name: 'Simulera rapportering', exact: true }).click();
  await expect.poll(async () => (await detail(page.request, fixture.report.id)).status).toBe('simulated');
  const original = await detail(page.request, fixture.report.id);
  expect(original).toMatchObject({ mode: 'mock', status: 'simulated', receiptVersion: 1 });
  expect(original.avfallId).toMatch(/^SIM-/);
  expect(original.versions).toHaveLength(1);
  expect(original.versions[0]).toMatchObject({ method: 'POST', receiptVersion: 1, weight: 100 });
  await expect(reporting).toContainText('Simulerad – ej skickad till NVV');
  await expect(reporting).toContainText(original.avfallId!);
  await dialog.getByRole('button', { name: 'Stäng miljöunderlag', exact: true }).click();
  await expect(page.getByRole('button', { name: `Visa miljöunderlag för INV-${fixture.cardId}`, exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /^Historik/ }).click();
  await expect(page.getByRole('button', { name: `Visa miljöhistorik för INV-${fixture.cardId} version 1`, exact: true })).toBeVisible();

  // A changed real weight is reviewed again before correcting the physical
  // receipt. Never inject a fabricated customer-approved browser state.
  await changeOfficeCard(page, fixture.cardId, card => { card.rows[0].weight = 95; });
  const card = (await readOffice(page.request)).cards.find(value => value.id === fixture.cardId)!;
  await approveCustomerCard(page.request, card, { customer: fixture.customer });
  const correction: EnvironmentalCorrectionInput = { ...fixture.input, rows: [{ articleId: 'lead-battery', weight: 95 }],
    expectedVersion: fixture.received.version, reason: 'Kontrollvägning: fem kilo emballage ska dras av.', idempotencyKey: randomUUID() };
  const corrected = await api<EnvironmentalReceipt>(page.request, `/api/environment/receipts/${fixture.received.id}/corrections`, 'POST', correction, mutationHeaders(await session(page.request)));
  expect(corrected).toMatchObject({ version: 2, originalHash: fixture.received.hash });
  await page.reload();
  dialog = await openReport(page, fixture.cardId);
  reporting = dialog.getByRole('region', { name: 'NVV-rapportering', exact: true });
  await expect(reporting).toContainText(/Rättelse/);
  await reporting.getByRole('button', { name: 'Simulera rättelse', exact: true }).click();
  await expect.poll(async () => (await detail(page.request, fixture.report.id)).status).toBe('simulated');
  const updated = await detail(page.request, fixture.report.id);
  expect(updated.avfallId).toMatch(/^SIM-/);
  expect(updated.avfallId).not.toBe(original.avfallId);
  expect(updated.versions).toHaveLength(2);
  expect(updated.versions.find(value => value.receiptVersion === 1)).toEqual(original.versions[0]);
  expect(updated.versions.find(value => value.receiptVersion === 2)).toMatchObject({ method: 'PUT', weight: 95, previousAvfallId: original.avfallId });
  expect(updated.attempts.map(value => value.avfallId)).toEqual(expect.arrayContaining([original.avfallId, updated.avfallId]));
  await dialog.locator('summary').filter({ hasText: 'Rapportversioner och skickat underlag' }).click();
  await expect(dialog).toContainText(original.avfallId!);
  await expect(dialog).toContainText(updated.avfallId!);
  await expect(reporting).toContainText('Simulerad – ej skickad till NVV');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('nvv-report-history-1440.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('anläggningsbegränsad läsbehörighet får granska underlag men kan inte skicka eller ändra NVV-inställningar', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await office(page);
  const own = await receiptFixture(page), foreign = await receiptFixture(page, 'rimbo');
  const before = await readOffice(page.request);
  const reader: OfficeUser = { id: `nvv-reader-${randomUUID().slice(0, 8)}`, name: 'NVV Läsare', level: 'Medarbetare',
    permissions: ['view', 'environmentRead', 'integrationsRead'], siteIds: ['norrtalje'], maxAttest: 0, ownAttest: false, active: true };
  await api(page.request, '/api/pricing/users', 'POST', { users: [...before.users, reader] }, admin);
  await page.reload();
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption(reader.id);
  await page.goto('/kontor#/environment');
  await expect.poll(async () => {
    const response = await page.request.get('/api/environment/session');
    if (response.status() === 401) return undefined; // The previous identity is revoked before replacement.
    expect(response.ok()).toBe(true);
    return (await response.json()).effectiveUserId;
  }).toBe(reader.id);
  const scoped = await state(page.request);
  expect(scoped.sites.map(value => value.id)).toEqual(['norrtalje']);
  expect(scoped.reports.some(value => value.id === own.report.id)).toBe(true);
  expect(scoped.reports.some(value => value.id === foreign.report.id)).toBe(false);
  await expect(page.getByRole('button', { name: `Visa miljöunderlag för INV-${foreign.cardId}`, exact: true })).toHaveCount(0);
  const dialog = await openReport(page, own.cardId);
  await expect(dialog.getByRole('button', { name: 'Simulera rapportering', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Stäng miljöunderlag', exact: true }).click();
  const settings = await openSettings(page);
  await expect(settings.getByLabel('Organisationsnamn', { exact: true })).toBeDisabled();
  await expect(settings.getByRole('button', { name: 'Spara testorganisation', exact: true })).toHaveCount(0);
  const identity = await session(page.request), headers = mutationHeaders(identity);
  const deniedSend = await page.request.post(`/api/environment/nvv/reports/${encodeURIComponent(own.report.id)}/send`, { headers,
    data: { receiptVersion: own.received.version, idempotencyKey: randomUUID() } });
  expect(deniedSend.status()).toBe(403);
  const current = await status(page.request);
  const reporter = current.reporter!;
  const deniedSettings = await page.request.put('/api/environment/nvv/reporter', { headers,
    data: { name: reporter.name, number: reporter.number, contactName: reporter.contactName,
      email: reporter.email, phone: reporter.phone, certificateOrganisationNumber: reporter.certificateOrganisationNumber,
      testIdentityConfirmed: reporter.testIdentityConfirmed, expectedVersion: current.reporterVersion } });
  expect(deniedSettings.status()).toBe(403);
  expect((await page.request.post('/api/environment/nvv/check', { headers, data: {} })).status()).toBe(403);
  expect([403, 404]).toContain((await page.request.get(`/api/environment/nvv/reports/${encodeURIComponent(foreign.report.id)}`)).status());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
