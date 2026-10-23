import { expect, test, type Page } from '@playwright/test';

// The new invoice workspace must keep navigation, document history and amounts
// coherent without any account, real customer, sending service or backend API.
const demo = '/bokforing/index.html';
const storageKey = 'scrapplanner-bokforing-suite-v2';
test.use({ viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);

const editor = (page: Page) => page.locator('#invoice-page-form');
const action = (page: Page, name: string) => page.locator(`#suite-main [data-action="${name}"]`);
async function open(page: Page, route = 'sales') {
  await page.goto(`${demo}#${route}`);
  await expect(page.locator('#suite-main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#suite-main')).not.toContainText('Vyn kunde inte öppnas');
}
async function currentState(page: Page) {
  return page.evaluate(async key => {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
    const path = '/bokforing/suite/seed.js';
    return (await import(path)).createSuiteState();
  }, storageKey);
}
async function savedState(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}
async function save(page: Page) {
  await editor(page).locator('button[type="submit"]').click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(/#sales\/[^/]+$/);
}
async function issue(page: Page) {
  await action(page, 'issue-invoice').click();
  await page.locator('#suite-dialog [name="reviewed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
}

test('fakturalistan öppnar egen adress som klarar omladdning och bakåt/framåt', async ({ page }) => {
  await open(page);
  const initial = await currentState(page);
  const invoice = initial.invoices.find((item: { status: string }) => item.status === 'issued');
  await expect(page.locator('#suite-main')).not.toContainText('Fakturautkast ·');
  await page.locator(`[data-select-invoice="${invoice.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#sales/${invoice.id}$`));
  await expect(page.locator('#suite-main')).toContainText(invoice.number);
  await expect(page.locator('#suite-main [data-select-invoice]')).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#sales/${invoice.id}$`));
  await expect(page.locator('#suite-main')).toContainText(invoice.number);
  await page.goBack();
  await expect(page).toHaveURL(/#sales$/);
  await expect(page.locator(`[data-select-invoice="${invoice.id}"]`)).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#sales/${invoice.id}$`));
  await expect(page.locator('#suite-main')).toContainText(invoice.number);
});

test('ny faktura använder hela arbetsytan och behåller inmatning när ett belopp nekas', async ({ page }) => {
  await open(page);
  const before = await currentState(page);
  await action(page, 'new-invoice').click();
  await expect(page).toHaveURL(/#sales\/new$/);
  await expect(editor(page)).toBeVisible();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  const formBox = await editor(page).boundingBox();
  const mainBox = await page.locator('#suite-main').boundingBox();
  expect(formBox!.width).toBeGreaterThan(mainBox!.width * 0.85);
  await editor(page).locator('[name="ourReference"]').fill('Behåll den här referensen');
  await editor(page).locator('[data-line-field="description"]').first().fill('Min kvarvarande beskrivning');
  await editor(page).locator('[data-line-field="unitCents"]').first().fill('ogiltigt belopp');
  await editor(page).locator('button[type="submit"]').click();
  await expect(page.locator('#invoice-page-error')).toBeVisible();
  await expect(editor(page).locator('[name="ourReference"]')).toHaveValue('Behåll den här referensen');
  await expect(editor(page).locator('[data-line-field="description"]').first()).toHaveValue('Min kvarvarande beskrivning');
  await expect(page).toHaveURL(/#sales\/new$/);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect((await currentState(page)).entries).toHaveLength(before.entries.length);
});

test('osparad faktura kräver beslut innan användaren lämnar sidan', async ({ page }) => {
  await open(page, 'sales/new');
  await editor(page).locator('[name="ourReference"]').fill('Osparad referens');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-nav="overview"]').click();
  await expect(page).toHaveURL(/#sales\/new$/);
  await expect(editor(page).locator('[name="ourReference"]')).toHaveValue('Osparad referens');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-nav="overview"]').click();
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.getByRole('heading', { name: 'God morgon, Åke' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
});

test('sparad v2-faktura utan nya uppgifter öppnas utan reset eller ändrade original', async ({ page }) => {
  await open(page);
  const legacy = await page.evaluate(async key => {
    const path = '/bokforing/suite/seed.js';
    const state = (await import(path)).createSuiteState();
    for (const invoice of state.invoices) {
      delete invoice.details;
      delete invoice.invoiceDiscountBps;
      for (const line of invoice.lines) {
        for (const field of ['articleNumber', 'unit', 'discountBps', 'unitPriceIncludesVat', 'rotEligible', 'chargeType']) delete line[field];
      }
      if (invoice.status !== 'draft') {
        const rot = invoice.rot ? Object.fromEntries(['paymentYear', 'property', 'personId', 'eligibleConfirmed', 'availableCents', 'reservedCents', 'remainingCents'].map(field => [field, invoice.rot[field] ?? null])) : null;
        invoice.bookingSnapshot = JSON.stringify({
          id: invoice.id, number: invoice.number, kind: invoice.kind, originalInvoiceId: invoice.originalInvoiceId ?? null,
          customerId: invoice.customerId, projectId: invoice.projectId ?? null, date: invoice.date, dueDate: invoice.dueDate,
          vatMode: invoice.vatMode, buyerConstructionConfirmed: invoice.buyerConstructionConfirmed,
          lines: invoice.lines.map(({ description, kind, quantity, unitCents, vatRate }: { description: string; kind: string; quantity: number; unitCents: number; vatRate: number }) => ({ description, kind, quantity, unitCents, vatRate })),
          reason: invoice.reason ?? null, rot,
        });
      }
    }
    const invoice = state.invoices.find((item: { status: string }) => item.status === 'issued');
    const raw = JSON.stringify(state);
    localStorage.setItem(key, raw);
    return { id: invoice.id, number: invoice.number, raw };
  }, storageKey);
  await page.goto(`${demo}#sales/${legacy.id}`);
  await page.reload();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  await expect(page.locator('#suite-main')).toContainText(legacy.number);
  await expect(editor(page)).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(legacy.raw);
});

test('referenser, leverans, rabatter och avgifter följer fakturan, bokföringen och låst utskrift', async ({ page }) => {
  await open(page, 'sales/new');
  const form = editor(page);
  await form.locator('[name="ourReference"]').fill('Vår referens 42');
  await form.locator('[name="customerReference"]').fill('Beställare Lisa');
  await form.locator('[name="customerOrderNumber"]').fill('ORDER-2026-11');
  await form.locator('[name="costCenter"]').fill('Stockholm');
  await form.locator('[name="customer.name"]').fill('Fakturamottagare i fakturan');
  await form.locator('[name="customer.address"]').fill('Fakturaadress 12');
  await form.locator('[name="customer.postalCode"]').fill('12345');
  await form.locator('[name="customer.city"]').fill('Demostaden');
  await form.locator('[name="customer.email"]').fill('invoice@example.invalid');
  await form.locator('#invoice-delivery summary').click();
  await form.locator('[name="delivery.name"]').fill('Arbetsplats Solsidan');
  await form.locator('[name="delivery.address"]').fill('Leveransadress 98');
  await form.locator('[name="delivery.method"]').fill('Egen transport');
  await form.locator('[name="invoiceText"]').fill('Tack för beställningen. Referens P-14.');
  const line = form.locator('[data-invoice-line]').first();
  await line.locator('[data-line-field="articleNumber"]').fill('HANT-001');
  await line.locator('[data-line-field="description"]').fill('Arbete enligt beställning');
  await line.locator('[data-line-field="quantity"]').fill('2');
  await line.locator('[data-line-field="unit"]').fill('tim');
  await line.locator('[data-line-field="unitCents"]').fill('1000');
  await line.locator('[data-line-field="discountBps"]').fill('10');
  await form.locator('[name="invoiceDiscountBps"]').fill('5');
  await form.locator('[name="freightCents"]').fill('100');
  await form.locator('[name="invoiceFeeCents"]').fill('40');
  await expect(page.locator('#invoice-live-summary')).toContainText(/2\s*312,50/);
  await save(page);
  let saved = await savedState(page);
  const id = saved.invoices.at(-1).id;
  expect(saved.invoices.at(-1).details.customerOrderNumber).toBe('ORDER-2026-11');
  expect(saved.invoices.at(-1).details.delivery.address).toBe('Leveransadress 98');
  expect(saved.invoices.at(-1).lines).toHaveLength(3);
  await issue(page);
  saved = await savedState(page);
  const invoice = saved.invoices.find((item: { id: string }) => item.id === id);
  const entry = saved.entries.find((item: { id: string }) => item.id === invoice.entryId);
  expect(entry.rows).toEqual(expect.arrayContaining([
    { account: '1510', debitCents: 231_250, creditCents: 0 },
    { account: '3000', debitCents: 0, creditCents: 185_000 },
    { account: '2611', debitCents: 0, creditCents: 46_250 },
  ]));
  await expect(action(page, 'edit-invoice')).toHaveCount(0);
  await page.evaluate(() => { window.print = () => {}; });
  await action(page, 'print-invoice').click();
  const print = page.locator('#print-area');
  for (const value of ['Fakturamottagare i fakturan', 'Fakturaadress 12', 'Leveransadress 98', 'Vår referens 42', 'Beställare Lisa', 'ORDER-2026-11', 'HANT-001', 'Tack för beställningen. Referens P-14.']) {
    await expect(print).toContainText(value);
  }
  const originalSellerName = invoice.details.seller.name;
  await page.evaluate(({ key, customerId }) => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    saved.company.name = 'Ändrat bolagsnamn i registret';
    saved.customers.find((item: { id: string }) => item.id === customerId).name = 'Ändrat kundnamn i registret';
    localStorage.setItem(key, JSON.stringify(saved));
  }, { key: storageKey, customerId: invoice.customerId });
  await page.reload();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  await expect(page.locator('#suite-main')).toContainText('Fakturamottagare i fakturan');
  await page.evaluate(() => { window.print = () => {}; });
  await action(page, 'print-invoice').click();
  await expect(print).toContainText(originalSellerName);
  await expect(print).not.toContainText('Ändrat bolagsnamn i registret');
  await expect(print).not.toContainText('Ändrat kundnamn i registret');
});

test('byte till priser inklusive moms bevarar priset och ny bruttoinmatning räknas rätt', async ({ page }) => {
  await open(page, 'sales/new');
  const form = editor(page), line = form.locator('[data-invoice-line]').first();
  await line.locator('[data-line-field="unitCents"]').fill('100');
  await expect(page.locator('#invoice-live-summary')).toContainText('125,00');
  await form.locator('[name="pricesIncludeVat"]').check();
  await expect(line.locator('[data-line-field="unitCents"]')).toHaveValue('125,00');
  await expect(page.locator('#invoice-live-summary')).toContainText('125,00');
  await line.locator('[data-line-field="unitCents"]').fill('100');
  await save(page);
  const saved = await savedState(page), invoice = saved.invoices.at(-1);
  expect(invoice.details.pricesIncludeVat).toBe(true);
  expect(invoice.lines[0].unitPriceIncludesVat).toBe(true);
  expect(invoice.lines[0].unitCents).toBe(10_000);
  await issue(page);
  const after = await savedState(page);
  const entry = after.entries.find((item: { id: string }) => item.id === after.invoices.at(-1).entryId);
  expect(entry.rows).toEqual(expect.arrayContaining([
    { account: '1510', debitCents: 10_000, creditCents: 0 },
    { account: '3000', debitCents: 0, creditCents: 8_000 },
    { account: '2611', debitCents: 0, creditCents: 2_000 },
  ]));
});

test('arbetsrad utan ROT räknas bort och följer med till en självständig fakturakopia', async ({ page }) => {
  await open(page);
  const initial = await currentState(page);
  const originalId = initial.invoices.find((invoice: { rot?: unknown }) => invoice.rot).id;
  await page.locator(`[data-select-invoice="${originalId}"]`).click();
  await action(page, 'edit-invoice').click();
  await editor(page).locator('[data-action="add-invoice-line"]').first().click();
  const line = editor(page).locator('[data-invoice-line]').last();
  await line.locator('[data-line-field="description"]').fill('Arbete som inte är ROT-berättigat');
  await line.locator('[data-line-field="quantity"]').fill('2');
  await line.locator('[data-line-field="unitCents"]').fill('1000');
  await line.locator('[data-line-field="rotEligible"]').uncheck();
  await expect(page.locator('#invoice-live-summary .label-value').filter({ has: page.getByText('Planerat ROT-avdrag', { exact: true }) }).locator('strong')).toHaveText(/6\s*600,00/);
  await save(page);
  let saved = await savedState(page);
  const original = saved.invoices.find((invoice: { id: string }) => invoice.id === originalId);
  expect(original.lines.at(-1).rotEligible).toBe(false);
  await action(page, 'copy-invoice').click();
  await expect(editor(page)).toBeVisible();
  saved = await savedState(page);
  const copy = saved.invoices.at(-1);
  expect(copy.id).not.toBe(originalId);
  expect(copy.status).toBe('draft');
  expect(copy.number).toBe('');
  expect(copy.payments).toEqual([]);
  expect(copy.lines.at(-1).rotEligible).toBe(false);
  expect(saved.invoices.find((invoice: { id: string }) => invoice.id === originalId)).toEqual(original);
  expect(saved.rotClaims).toEqual([]);
});

test('återställning från osparad fakturasida rensar utkast och återgår till listan', async ({ page }) => {
  await open(page, 'sales/new');
  const reference = 'Referens som ska försvinna vid återställning';
  await editor(page).locator('[name="ourReference"]').fill(reference);
  await page.locator('#suite-sidebar [data-action="reset"]').click();
  await expect(page.locator('#suite-dialog')).toBeVisible();
  await page.locator('#suite-dialog [name="confirmed"]').check();
  await page.locator('#suite-dialog button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await expect(page).toHaveURL(/#sales$/);
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('#suite-main')).not.toContainText('Vyn kunde inte öppnas');
  await expect(page.locator('#suite-main [data-select-invoice]').first()).toBeVisible();
  await action(page, 'new-invoice').click();
  await expect(page).toHaveURL(/#sales\/new$/);
  await expect(editor(page).locator('[name="ourReference"]')).toHaveValue('');
  await expect(editor(page)).not.toContainText(reference);
});
