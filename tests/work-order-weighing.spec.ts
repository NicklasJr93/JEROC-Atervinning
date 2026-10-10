import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import type { OfficeCustomer } from '../src/office/model';
import type { EnvironmentState } from '../src/office/environment-types';
import type { LogisticsOfficeCommand, LogisticsOfficeState, LogisticsVessel } from '../src/office/logistics/types';
import { readOffice, saveOffice } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.describe.configure({ mode: 'serial' });

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function logistics(request: APIRequestContext, data?: LogisticsOfficeCommand): Promise<LogisticsOfficeState> {
  const response = data ? await request.post('/api/logistics/office', { headers: admin, data })
    : await request.get('/api/logistics/office', { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function environment(request: APIRequestContext): Promise<EnvironmentState> {
  const response = await request.get('/api/environment/state');
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(request: APIRequestContext) {
  const suffix = randomUUID().slice(0, 8), base = await readOffice(request);
  const customer: OfficeCustomer = { ...structuredClone(base.customers.find(value => value.type === 'Företag')!),
    id: `ao-weighing-customer-${suffix}`, name: `Vägningskund ${suffix}`, customerNumber: `AO-E2E-${suffix}`,
    address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', email: `${suffix}@example.invalid` };
  const next = structuredClone(base); next.customers.push(customer); await saveOffice(request, base, next);
  const session = await request.post('/api/environment/demo-session', { data: { userId: 'admin', effectiveUserId: 'admin' } });
  expect(session.ok(), await session.text()).toBe(true);
  return { customer, suffix };
}
async function office(page: Page, route: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto(`/kontor#/${route}`);
}
async function clickCommand(page: Page, name: string, action: LogisticsOfficeCommand['action']) {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/logistics/office') &&
    response.request().method() === 'POST' && response.request().postDataJSON()?.action === action);
  await page.getByRole('button', { name, exact: true }).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<LogisticsOfficeState>;
}
const stock = (state: LogisticsOfficeState, articleId: string) => state.stock.find(value =>
  value.siteId === 'norrtalje' && value.articleId === articleId)?.onHandKg ?? 0;
async function expectNoPhysicalReceipt(request: APIRequestContext, sourceId: string) {
  const state = await environment(request);
  expect(state.receipts.filter(value => value.sourceId === sourceId)).toHaveLength(0);
  expect(state.inventory.filter(value => value.sourceId === sourceId)).toHaveLength(0);
  expect(state.reports.filter(value => value.sourceId === sourceId)).toHaveLength(0);
}
async function screenshot(page: Page, testInfo: TestInfo, filename: string) {
  const path = testInfo.outputPath(filename);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename, { path, contentType: 'image/png' });
}

test('helsidesformulär behåller ett förberett utkast och skapar ett invägningskort först med verkliga vikter', async ({ page, request }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { customer } = await fixture(request), before = await logistics(request);
  await office(page, 'work-orders');
  await page.getByRole('button', { name: 'Ny arbetsorder', exact: true }).click();
  await expect(page).toHaveURL(/#\/work-orders\/new$/);
  await expect(page.getByRole('heading', { name: 'Ny arbetsorder', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ny arbetsorder', exact: true })).toBeVisible();
  await page.getByLabel('Kund för arbetsorder', { exact: true }).selectOption(customer.id);
  await page.getByLabel('Anläggning för arbetsorder', { exact: true }).selectOption('norrtalje');
  await page.getByRole('button', { name: 'Lägg till material', exact: true }).click();
  await page.getByLabel('Artikel 1', { exact: true }).selectOption('lead-battery');
  await page.getByLabel('Planerad mängd 1', { exact: true }).fill('100');
  await screenshot(page, testInfo, 'new-work-order-1440.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await screenshot(page, testInfo, 'new-work-order-390.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const created = await clickCommand(page, 'Spara arbetsorder', 'order.create');
  const orderId = created.result!.orderId!, prepared = created.orders.find(value => value.id === orderId)!.detail.weighing!;
  await expect(page).toHaveURL(new RegExp(`#/work-orders/${orderId}$`));
  expect(prepared).toMatchObject({ status: 'prepared', workOrderId: orderId, customerId: customer.id,
    rows: [{ articleId: 'lead-battery', plannedKg: 100, hazardous: true }],
    environmentPreparation: { status: 'prepared', rows: [{ articleId: 'lead-battery', wasteCode: '160601' }] } });
  expect(prepared.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(prepared.cardId).toBeUndefined();
  expect(prepared.rows[0].weight).toBeUndefined();

  await page.getByRole('button', { name: 'Redigera', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/work-orders/${orderId}/edit$`));
  await page.reload();
  await expect(page.getByRole('heading', { name: `Redigera ${orderId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Artikel 1', { exact: true })).toHaveValue('lead-battery');
  await page.getByRole('button', { name: 'Lägg till material', exact: true }).click();
  await page.getByLabel('Artikel 2', { exact: true }).selectOption('copper-1');
  await page.getByLabel('Planerad mängd 2', { exact: true }).fill('250');
  const edited = await clickCommand(page, 'Spara arbetsorder', 'order.edit');
  const same = edited.orders.find(value => value.id === orderId)!.detail.weighing!;
  expect(same.id).toBe(prepared.id);
  expect(same.rows.map(value => value.articleId)).toEqual(['lead-battery', 'copper-1']);
  expect(same.environmentPreparation!.rows.map(value => value.articleId)).toEqual(['lead-battery']);
  expect((await readOffice(request)).cards.filter(value => value.workOrderId === orderId || value.sourceId === prepared.id)).toHaveLength(0);
  expect(stock(edited, 'lead-battery')).toBe(stock(before, 'lead-battery'));
  expect(stock(edited, 'copper-1')).toBe(stock(before, 'copper-1'));
  expect(edited.inventoryMovements).toEqual(before.inventoryMovements);
  await expectNoPhysicalReceipt(request, prepared.id);
  await screenshot(page, testInfo, 'prepared-weighing-1440.png');

  await clickCommand(page, 'Starta vägning', 'order.weighing.start');
  await expect(page.getByLabel('Verklig vikt 1', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Verklig vikt 2', { exact: true })).toHaveValue('');
  await page.getByLabel('Verklig vikt 1', { exact: true }).fill('7');
  await page.getByLabel('Verklig vikt 2', { exact: true }).fill('42');
  await page.getByLabel('Referens för vägning', { exact: true }).fill('Verkligt invägt – inte planerade mängder');
  const saved = await clickCommand(page, 'Spara vägning', 'order.weighing.save');
  expect(saved.orders.find(value => value.id === orderId)!.detail.weighing).toMatchObject({ id: prepared.id,
    status: 'started', rows: [{ weight: 7 }, { weight: 42 }] });
  await page.reload();
  await page.getByRole('button', { name: 'Öppna vägning', exact: true }).click();
  await expect(page.getByLabel('Verklig vikt 1', { exact: true })).toHaveValue('7');
  await expect(page.getByLabel('Verklig vikt 2', { exact: true })).toHaveValue('42');
  const completed = await clickCommand(page, 'Färdigställ vägning', 'order.weighing.complete');
  const cardId = completed.result!.cardId!, complete = completed.orders.find(value => value.id === orderId)!.detail.weighing!;
  expect(complete).toMatchObject({ id: prepared.id, status: 'completed', cardId });
  expect(Number.isInteger(cardId)).toBe(true);
  let cards = (await readOffice(request)).cards.filter(value => value.workOrderId === orderId);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ id: cardId, sourceId: prepared.id, workOrderId: orderId, status: 'new',
    customerId: customer.id, siteId: 'norrtalje', origin: prepared.origin,
    rows: [{ articleId: 'lead-battery', weight: 7 }, { articleId: 'copper-1', weight: 42 }] });
  expect(stock(completed, 'copper-1')).toBe(stock(before, 'copper-1') + 42);
  expect(stock(completed, 'lead-battery')).toBe(stock(before, 'lead-battery'));
  await expectNoPhysicalReceipt(request, prepared.id);
  await screenshot(page, testInfo, 'completed-weighing-1440.png');
  await page.reload();
  await page.getByRole('button', { name: 'Öppna invägning', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/weighings/${cardId}$`));
  await page.getByRole('button', { name: `Arbetsorder ${orderId}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/work-orders/${orderId}$`));
  cards = (await readOffice(request)).cards.filter(value => value.workOrderId === orderId);
  expect(cards).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('kärlets förval följer helsidesformuläret och avbruten oanvänd arbetsorder tar bort vägningsutkastet', async ({ page, request }) => {
  const { customer, suffix } = await fixture(request);
  const vessel: LogisticsVessel = { id: `K-AO-${suffix}`, name: `AO-testkärl ${suffix}`, type: 'battery', size: '600 l',
    siteId: 'norrtalje', active: true, customerId: customer.id, status: 'placed', materialArticleId: 'lead-battery', version: 0,
    place: { name: customer.name, number: customer.number, address: customer.address!, postalCode: customer.postalCode!, city: customer.city! } };
  await logistics(request, { action: 'vessel.save', vessel, expectedVersion: 0 });
  const before = await logistics(request);
  await office(page, 'vessels');
  const card = page.locator('article.vessels-card').filter({ has: page.getByRole('heading', { name: vessel.name, exact: true }) });
  await card.getByRole('button', { name: 'Skapa arbetsorder', exact: true }).click();
  await expect(page).toHaveURL(/#\/work-orders\/new$/);
  await page.reload();
  await expect(page.getByLabel('Kund för arbetsorder', { exact: true })).toHaveValue(customer.id);
  await expect(page.getByLabel('Kärl för arbetsorder', { exact: true })).toHaveValue(vessel.id);
  await expect(page.getByLabel('Anläggning för arbetsorder', { exact: true })).toHaveValue(vessel.siteId);
  if (await page.getByLabel('Artikel 1', { exact: true }).count() === 0) await page.getByRole('button', { name: 'Lägg till material', exact: true }).click();
  await page.getByLabel('Artikel 1', { exact: true }).selectOption('lead-battery');
  const created = await clickCommand(page, 'Spara arbetsorder', 'order.create');
  const orderId = created.result!.orderId!, prepared = created.orders.find(value => value.id === orderId)!.detail.weighing!;
  expect(prepared.status).toBe('prepared');
  expect(prepared.cardId).toBeUndefined();
  await page.getByRole('button', { name: 'Avbryt arbetsorder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Avbryt arbetsorder', exact: true });
  await dialog.getByLabel('Orsak *', { exact: true }).fill('Beställningen behövs inte längre – ingen fysisk mottagning har skett.');
  const pending = page.waitForResponse(response => response.url().endsWith('/api/logistics/office') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Avbryt arbetsorder', exact: true }).click();
  const response = await pending; expect(response.ok(), await response.text()).toBe(true);
  const cancelled = await logistics(request);
  expect(cancelled.orders.find(value => value.id === orderId)).toMatchObject({ status: 'cancelled' });
  expect(cancelled.orders.find(value => value.id === orderId)!.detail.weighing).toBeUndefined();
  expect((await readOffice(request)).cards.filter(value => value.workOrderId === orderId || value.sourceId === prepared.id)).toHaveLength(0);
  expect(cancelled.inventoryMovements).toEqual(before.inventoryMovements);
  await expectNoPhysicalReceipt(request, prepared.id);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Starta vägning', exact: true })).toHaveCount(0);
});

test('lagerförvald utleverans reserverar mängden utan inkommande vägning eller fysiskt lageruttag', async ({ page, request }) => {
  const { customer } = await fixture(request);
  await logistics(request, { action: 'inventory.adjust', siteId: 'norrtalje', articleId: 'copper-1', kg: 100,
    reason: 'Räknat vanligt kopparlager för browserkontroll av utleveransreservation.', idempotencyKey: randomUUID() });
  const before = await logistics(request), baseline = before.stock.find(value => value.siteId === 'norrtalje' && value.articleId === 'copper-1')!;
  await office(page, 'warehouse');
  await page.getByLabel('Anläggning för lager', { exact: true }).selectOption('norrtalje');
  const material = page.locator('article.warehouse-material').filter({ has: page.getByRole('heading', { name: 'Koppar klass 1', exact: true }) });
  await material.getByRole('button', { name: 'Boka utleverans', exact: true }).click();
  await expect(page).toHaveURL(/#\/work-orders\/new$/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Utleverans', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Artikel 1', { exact: true })).toHaveValue('copper-1');
  await expect(page.getByLabel('Planerad mängd 1', { exact: true })).toHaveValue(String(baseline.availableKg));
  await page.getByLabel('Kund för arbetsorder', { exact: true }).selectOption(customer.id);
  await page.getByLabel('Planerad mängd 1', { exact: true }).fill('30');
  const created = await clickCommand(page, 'Spara arbetsorder', 'order.create');
  const orderId = created.result!.orderId!, order = created.orders.find(value => value.id === orderId)!;
  expect(order.action).toBe('outbound');
  expect(order.detail.weighing).toBeUndefined();
  const reserved = created.stock.find(value => value.siteId === 'norrtalje' && value.articleId === 'copper-1')!;
  expect(reserved).toMatchObject({ onHandKg: baseline.onHandKg, reservedKg: baseline.reservedKg + 30,
    availableKg: baseline.availableKg - 30 });
  expect(created.inventoryMovements).toEqual(before.inventoryMovements);
  expect((await readOffice(request)).cards.filter(value => value.workOrderId === orderId)).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'Förberedd vägning', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Starta vägning', exact: true })).toHaveCount(0);
});
