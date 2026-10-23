import { expect, test, type Page } from '@playwright/test';

const key = 'scrapplanner-bokforing-suite-v2';
test.use({ viewport: { width: 1450, height: 1050 }, isMobile: false, hasTouch: false });
test.setTimeout(90_000);
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const errors: string[] = []; pageErrors.set(page, errors); page.on('pageerror', error => errors.push(error.message)); });
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });
const form = (page: Page, action: string) => page.locator(`form[data-feature-form="commercial"][data-action="${action}"]`).first();
const saved = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
async function open(page: Page) {
  await page.goto('/bokforing/index.html#commercial');
  await expect(page.getByRole('heading', { name: 'Artiklar, avtal och intäkter', exact: true })).toBeVisible();
}
async function article(page: Page) {
  const f = form(page, 'save-article');
  await f.locator('[name="number"]').fill('WEB-100');
  await f.locator('[name="name"]').fill('Faktureringstest');
  await f.locator('[name="unitCents"]').fill('500');
  await f.getByRole('button', { name: 'Lägg till artikel' }).click();
  await expect.poll(async () => (await saved(page))?.commercialArticles?.length).toBe(1);
}

test('article and customer price produce a persistent invoice draft without changing the catalog price', async ({ page }) => {
  await open(page); await article(page);
  const price = form(page, 'save-price');
  await price.locator('[name="unitCents"]').fill('450');
  await price.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect.poll(async () => (await saved(page))?.commercialPrices?.length).toBe(1);
  const f = form(page, 'article-invoice');
  const state = await saved(page);
  await f.locator('[name="article1"]').selectOption(state.commercialArticles[0].id);
  await f.locator('[name="quantity1"]').fill('2');
  await f.getByRole('button', { name: 'Skapa fakturautkast' }).click();
  await expect.poll(async () => (await saved(page))?.commercialInvoiceOrigins?.length).toBe(1);
  const next = await saved(page);
  const invoice = next.invoices.find((item: { id: string }) => item.id === next.commercialInvoiceOrigins[0].invoiceId);
  expect(invoice.lines[0].unitCents).toBe(45000);
  expect(next.commercialArticles[0].unitCents).toBe(50000);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Öppna utkast', exact: true })).toBeVisible();
});

test('recurring UI creates one draft per period and repeated generation has no duplicates', async ({ page }) => {
  await open(page); await article(page);
  const f = form(page, 'create-recurring');
  const state = await saved(page);
  await f.locator('[name="name"]').fill('Service månadsvis');
  await f.locator('[name="article1"]').selectOption(state.commercialArticles[0].id);
  await f.locator('[name="startDate"]').fill('2026-10-01');
  await f.getByRole('button', { name: 'Skapa plan' }).click();
  await expect.poll(async () => (await saved(page))?.recurringPlans?.length).toBe(1);
  const generate = form(page, 'generate-recurring');
  await generate.locator('[name="asOf"]').fill('2026-11-01');
  await generate.getByRole('button', { name: 'Skapa utkast' }).click();
  await expect.poll(async () => (await saved(page))?.recurringPlans?.[0]?.generated?.length).toBe(2);
  await form(page, 'generate-recurring').locator('[name="asOf"]').fill('2026-11-01');
  await form(page, 'generate-recurring').getByRole('button', { name: 'Skapa utkast' }).click();
  await expect(form(page, 'generate-recurring').getByRole('button', { name: 'Skapa utkast' })).toBeEnabled({ timeout: 15_000 });
  expect((await saved(page)).recurringPlans[0].generated).toHaveLength(2);
});

test('revenue schedule UI preserves invoice VAT and creates sequential recognition', async ({ page }) => {
  await open(page);
  const f = form(page, 'create-revenue');
  await f.locator('[name="name"]').fill('Service under hösten');
  await f.locator('[name="amountCents"]').fill('1000');
  await f.locator('[name="months"]').fill('3');
  await f.getByRole('button', { name: 'Bokför omföring och skapa plan' }).click();
  await expect.poll(async () => (await saved(page))?.revenueSchedules?.length).toBe(1);
  const before = await saved(page);
  const invoiceEntry = before.entries.find((entry: { sourceType: string }) => entry.sourceType === 'invoice');
  const recognize = form(page, 'recognize-revenue');
  await recognize.locator('[name="date"]').fill('2026-10-31');
  await recognize.getByRole('button', { name: 'Bokför månad' }).click();
  await expect.poll(async () => (await saved(page))?.revenueSchedules?.[0]?.postings?.length).toBe(1);
  const after = await saved(page);
  expect(after.entries.find((entry: { id: string }) => entry.id === invoiceEntry.id)).toEqual(invoiceEntry);
  expect(after.revenueSchedules[0].postings[0].amountCents).toBe(33333);
});

test('project material form makes one stock withdrawal and the matching project row', async ({ page }) => {
  await open(page);
  await page.evaluate(async key => {
    const seedPath = '/bokforing/suite/seed.js'; const inventoryPath = '/bokforing/suite/inventory.js';
    const seed = await import(seedPath); const inventory = await import(inventoryPath);
    let state = seed.createSuiteState();
    state = inventory.createStockItem(state, { name: 'Provskruv', unit: 'st', unitCostCents: 100 });
    state = inventory.recordStockMovement(state, state.inventoryItems[0].id, { date: '2026-10-23', kind: 'in', quantity: 8, reason: 'Testinleverans' });
    localStorage.setItem(key, JSON.stringify(state));
  }, key);
  await page.reload();
  const f = form(page, 'project-stock');
  await f.locator('[name="quantity"]').fill('2');
  await f.locator('[name="unitCents"]').fill('10');
  await f.locator('[name="reason"]').fill('Montering i provprojekt');
  await f.getByRole('button', { name: 'Registrera uttag och projektmaterial' }).click();
  await expect.poll(async () => (await saved(page))?.projectStockLinks?.length).toBe(1);
  const state = await saved(page);
  expect(state.inventoryItems[0].quantity).toBe(6);
  const link = state.projectStockLinks[0];
  expect(state.projects[0].items.find((item: { id: string }) => item.id === link.projectItemId).quantity).toBe(2);
  expect(link.costCents).toBe(200);
});

test('commercial workspace remains usable on mobile without page overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page); await article(page);
  await expect(page.locator('.commercial-workspace')).toBeVisible();
  const width = await page.evaluate(() => ({ full: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(width.full).toBeLessThanOrEqual(width.view + 1);
  await page.getByRole('link', { name: 'Återkommande', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Artiklar, avtal och intäkter', exact: true })).toBeVisible();
});
