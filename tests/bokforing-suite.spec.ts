import { expect, test, type Page } from '@playwright/test';

// Public synthetic accounting only. No authentication, production API, payment
// provider or tax submission is used by these browser regressions.
const storageKey = 'scrapplanner-bokforing-suite-v2';
const oldStorageKey = 'scrapplanner-bokforing-demo-v1';
const demo = '/bokforing/index.html';
test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
// End-to-end accounting scenarios now validate additional linked workflows.
// Keep assertion timeouts strict while allowing the complete multi-step journey.
test.setTimeout(90_000);

async function open(page: Page, view = 'sales') {
  await page.goto(`${demo}#${view}`);
  await expect(page.locator('#suite-main')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#suite-main')).not.toContainText('Vyn kunde inte öppnas');
}
async function state(page: Page) {
  return page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, storageKey);
}
async function currentState(page: Page) {
  return await state(page) ?? page.evaluate(async () => {
    const path = '/bokforing/suite/seed.js';
    const module = await import(path);
    return module.createSuiteState();
  });
}
const modal = (page: Page) => page.locator('#suite-dialog');
const action = (page: Page, name: string) => page.locator(`#suite-main [data-action="${name}"]`);
const value = (page: Page, label: string) => page.locator('#suite-main .label-value').filter({ has: page.getByText(label, { exact: true }) }).locator('strong');
async function saveDialog(page: Page) {
  await modal(page).locator('button[type="submit"]').click();
  await expect(modal(page)).not.toBeVisible();
}
async function saveInvoicePage(page: Page) {
  await page.locator('#invoice-page-form [name="performance.confirmed"]').check();
  await page.locator('#invoice-page-form button[type="submit"]').click();
  await expect(page.locator('#invoice-page-form')).toHaveCount(0);
  await expect(page).toHaveURL(/#sales\/[^/]+$/);
}
async function reviewed(page: Page) {
  await modal(page).locator('[name="reviewed"]').check();
  await saveDialog(page);
}
async function selectRot(page: Page) {
  const s = await currentState(page);
  const invoice = s.invoices.find((item: { rot?: unknown }) => item.rot);
  await page.locator(`[data-select-invoice="${invoice.id}"]`).click();
  return invoice.id as string;
}
async function issueRot(page: Page) {
  const id = await selectRot(page);
  await action(page, 'issue-invoice').click();
  await reviewed(page);
  return id;
}
async function pay(page: Page, amount: string, payer = 'customer') {
  await action(page, 'invoice-payment').click();
  await modal(page).locator('[name="payer"]').selectOption(payer);
  await modal(page).locator('[name="amountCents"]').fill(amount);
  await saveDialog(page);
}
async function requestRot(page: Page) {
  await action(page, 'request-rot').click();
  await modal(page).locator('[name="workCompletedConfirmed"]').check();
  await modal(page).locator('[name="electronicPaymentConfirmed"]').check();
  await saveDialog(page);
}
async function decideRot(page: Page, amount: string, reason = '') {
  await action(page, 'decide-rot').click();
  await modal(page).locator('[name="approvedCents"]').fill(amount);
  if (reason) await modal(page).locator('[name="reason"]').fill(reason);
  await saveDialog(page);
}

test('ROT 33 000 → kund 26 400 + skattebetalning 6 600 följer samma huvudbok efter omladdning', async ({ page }) => {
  await open(page);
  const id = await issueRot(page);
  await expect(value(page, 'Fakturabelopp')).toHaveText(/33\s*000(?:,00)?\s*kr/);
  await expect(value(page, 'Planerat ROT-avdrag')).toHaveText(/6\s*600(?:,00)?\s*kr/);
  await expect(value(page, 'Kundens ursprungliga del')).toHaveText(/26\s*400(?:,00)?\s*kr/);
  await pay(page, '26400');
  await requestRot(page);
  await decideRot(page, '6600');
  await pay(page, '6600', 'tax');
  let saved = await state(page);
  let invoice = saved.invoices.find((item: { id: string }) => item.id === id);
  expect(invoice.payments.map((item: { amountCents: number }) => item.amountCents)).toEqual([2_640_000, 660_000]);
  expect(invoice.rot.status).toBe('settled');
  expect(saved.rotClaims[0].requestedCents).toBe(660_000);
  const related = saved.entries.filter((entry: { sourceId: string }) => entry.sourceId === id || invoice.payments.some((payment: { id: string }) => payment.id === entry.sourceId));
  expect(related.flatMap((entry: { rows: unknown[] }) => entry.rows).filter((row: { account: string }) => row.account === '1510')
    .reduce((sum: number, row: { debitCents: number; creditCents: number }) => sum + row.debitCents - row.creditCents, 0)).toBe(0);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`#sales/${id}$`));
  await expect(value(page, 'Kvar totalt')).toHaveText(/0(?:,00)?\s*kr/);
  saved = await state(page);
  invoice = saved.invoices.find((item: { id: string }) => item.id === id);
  expect(invoice.payments).toHaveLength(2);
  await expect(action(page, 'edit-invoice')).toHaveCount(0);
});

test('ROT-begäran stoppas utan intyganden och utan betald kundandel', async ({ page }) => {
  await open(page);
  await issueRot(page);
  const before = await state(page);
  await action(page, 'request-rot').click();
  await expect(modal(page).locator('[name="workCompletedConfirmed"]')).not.toBeChecked();
  await expect(modal(page).locator('[name="electronicPaymentConfirmed"]')).not.toBeChecked();
  expect(await modal(page).locator('form').evaluate(form => (form as HTMLFormElement).reportValidity())).toBe(false);
  await modal(page).locator('[name="workCompletedConfirmed"]').check();
  await modal(page).locator('[name="electronicPaymentConfirmed"]').check();
  await modal(page).locator('button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText('Kundens hela del måste vara betald');
  const after = await state(page);
  expect(after.rotClaims).toHaveLength(0);
  expect(after.entries).toEqual(before.entries);
});

test('avslag på ROT behåller fordran och låter kunden betala återstoden', async ({ page }) => {
  await open(page);
  const id = await issueRot(page);
  await pay(page, '26400');
  await requestRot(page);
  await decideRot(page, '0', 'Fiktivt avslag på grund av otillräckligt utrymme');
  await expect(value(page, 'Kvar totalt')).toHaveText(/6\s*600(?:,00)?\s*kr/);
  await action(page, 'invoice-payment').click();
  await expect(modal(page).locator('[name="payer"] option[value="tax"]')).toHaveCount(0);
  await expect(modal(page).locator('[name="amountCents"]')).toHaveValue('6600,00');
  await saveDialog(page);
  const saved = await state(page);
  const invoice = saved.invoices.find((item: { id: string }) => item.id === id);
  expect(invoice.payments.every((payment: { payer: string }) => payment.payer === 'customer')).toBe(true);
  expect(saved.rotClaims[0].status).toBe('denied');
  await expect(value(page, 'Kvar totalt')).toHaveText(/0(?:,00)?\s*kr/);
});

test('befintlig bankinbetalning används en gång och skapar ingen extra bankhändelse', async ({ page }) => {
  await open(page);
  const initial = await currentState(page);
  const invoice = initial.invoices.find((item: { rot?: unknown }) => !item.rot);
  const bank = initial.bankTransactions.find((item: { amountCents: number }) => item.amountCents === 1_000_000);
  await page.locator(`[data-select-invoice="${invoice.id}"]`).click();
  await action(page, 'invoice-payment').click();
  await modal(page).locator('[name="bankEventId"]').selectOption(bank.id);
  await expect(modal(page).locator('[name="date"]')).toHaveValue(bank.date);
  await expect(modal(page).locator('[name="amountCents"]')).toHaveValue('10000,00');
  await saveDialog(page);
  const saved = await state(page);
  expect(saved.bankTransactions).toHaveLength(initial.bankTransactions.length);
  const matching = saved.bankTransactions.find((item: { id: string }) => item.id === bank.id);
  expect(matching.matchedEntryId).toBeTruthy();
  expect(saved.invoices.find((item: { id: string }) => item.id === invoice.id).payments[0].bankEventId).toBe(bank.id);
  await action(page, 'invoice-payment').click();
  await expect(modal(page).locator(`[name="bankEventId"] option[value="${bank.id}"]`)).toHaveCount(0);
});

test('utfärdad faktura saknar redigering och rättas genom länkad kredit med bevarat original', async ({ page }) => {
  await open(page);
  const id = await issueRot(page);
  const before = await state(page);
  const original = before.entries.find((entry: { sourceId: string }) => entry.sourceId === id);
  await expect(action(page, 'edit-invoice')).toHaveCount(0);
  await action(page, 'credit-invoice').click();
  await modal(page).locator('[name="reason"]').fill('Fiktivt felaktig beställning');
  await reviewed(page);
  const after = await state(page);
  expect(after.entries.find((entry: { id: string }) => entry.id === original.id)).toEqual(original);
  expect(after.entries.at(-1).correctsEntryId).toBe(original.id);
  expect(after.invoices.find((item: { id: string }) => item.id === id).status).toBe('credited');
  await expect(action(page, 'credit-invoice')).toHaveCount(0);
  await expect(action(page, 'invoice-payment')).toHaveCount(0);
});

test('lönekörning bokförs, betalas och kan exporteras som tydligt AGI-demounderlag', async ({ page }) => {
  await open(page, 'payroll');
  const initial = await currentState(page);
  const runId = initial.payrollRuns[0].id;
  await action(page, 'post-payroll').click();
  await reviewed(page);
  await action(page, 'pay-payroll').click();
  await modal(page).locator('[name="date"]').fill('2026-10-25');
  await reviewed(page);
  const saved = await state(page);
  const run = saved.payrollRuns.find((item: { id: string }) => item.id === runId);
  expect(run.status).toBe('paid');
  expect(run.lines.reduce((sum: number, line: { netCents: number }) => sum + line.netCents, 0)).toBe(4_620_000);
  expect(saved.entries.filter((entry: { id: string }) => [run.entryId, run.paymentEntryId].includes(entry.id))).toHaveLength(2);
  const downloadPromise = page.waitForEvent('download');
  await action(page, 'export-agi').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('demounderlag');
  await page.goto(`${demo}#reports`);
  await expect(page.getByRole('heading', { name: 'Resultat och balans', exact: true })).toBeVisible();
  await expect(page.locator('#suite-main')).toContainText('Debet och kredit balanserar');
});

test('fastställd moms stoppar nya momsverifikationer i perioden', async ({ page }) => {
  await open(page, 'vat');
  await action(page, 'file-vat').click();
  await modal(page).locator('[name="from"]').fill('2026-01-01');
  await modal(page).locator('[name="to"]').fill('2026-03-31');
  await modal(page).locator('[name="date"]').fill('2026-03-31');
  await reviewed(page);
  expect((await state(page)).vatReturns).toHaveLength(1);
  await page.goto(`${demo}#sales`);
  await action(page, 'new-invoice').click();
  await page.locator('#invoice-page-form [name="date"]').fill('2026-02-15');
  await page.locator('#invoice-page-form [name="dueDate"]').fill('2026-03-15');
  await saveInvoicePage(page);
  await action(page, 'issue-invoice').click();
  await modal(page).locator('[name="reviewed"]').check();
  await modal(page).locator('button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText('Momsperioden är redan fastställd');
  const after = await state(page);
  expect(after.invoices.at(-1).status).toBe('draft');
  expect(after.vatReturns).toHaveLength(1);
});

test('två flikar stoppar gammal sparning och kan läsa in senaste utan dataförlust', async ({ page, context }) => {
  await open(page, 'projects');
  const second = await context.newPage();
  await open(second, 'projects');
  await action(second, 'new-customer').click();
  await modal(second).locator('[name="name"]').fill('Den gamla flikens kund');
  await page.bringToFront();
  await action(page, 'new-customer').click();
  await modal(page).locator('[name="name"]').fill('Kund från första fliken');
  await saveDialog(page);
  await second.bringToFront();
  await expect(second.locator('#suite-storage-notice')).toContainText('annan flik');
  await expect(modal(second).locator('button[type="submit"]')).toBeDisabled();
  await second.locator('[data-action="close-dialog"]').first().click();
  await second.locator('[data-action="reload"]').click();
  await expect(second.locator('#suite-storage-notice')).toBeHidden();
  const saved = await state(second);
  expect(saved.customers.some((customer: { name: string }) => customer.name === 'Kund från första fliken')).toBe(true);
  expect(saved.customers.some((customer: { name: string }) => customer.name === 'Den gamla flikens kund')).toBe(false);
  await action(second, 'new-customer').click();
  await expect(modal(second).locator('button[type="submit"]')).toBeEnabled();
  await second.close();
});

test('sparfel bekräftar ingen bokning och explicit reset bevarar den tidigare demonyckeln', async ({ page }) => {
  await page.addInitScript(({ key, oldKey }) => {
    localStorage.setItem(oldKey, 'previous-demo-untouched');
    const browser = window as typeof window & { failSuiteWrite: boolean };
    browser.failSuiteWrite = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && browser.failSuiteWrite) throw new DOMException('Simulated quota', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, { key: storageKey, oldKey: oldStorageKey });
  await open(page);
  await selectRot(page);
  await action(page, 'issue-invoice').click();
  await modal(page).locator('[name="reviewed"]').check();
  await modal(page).locator('button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText('kunde inte sparas');
  await expect(page.locator('#suite-storage-notice')).toContainText('kunde inte sparas');
  expect(await state(page)).toBeNull();
  await modal(page).locator('[data-action="close-dialog"]').first().click();
  await expect(page.locator('#suite-sidebar [data-action="reset"]')).toBeDisabled();
  await page.evaluate(() => { (window as typeof window & { failSuiteWrite: boolean }).failSuiteWrite = false; });
  await page.locator('[data-action="reload"]').click();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  await page.locator('#suite-sidebar [data-action="reset"]').click();
  await modal(page).locator('[name="confirmed"]').check();
  await saveDialog(page);
  expect((await state(page)).invoices.find((invoice: { rot?: unknown }) => invoice.rot).status).toBe('draft');
  expect(await page.evaluate(key => localStorage.getItem(key), oldStorageKey)).toBe('previous-demo-untouched');
});

test('mobil kan spara och utfärda fem fakturarader utan att Ande skymmer knappen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await selectRot(page);
  await action(page, 'edit-invoice').click();
  for (let count = 0; count < 2; count++) {
    await page.locator('#invoice-page-form [data-action="add-invoice-line"]').first().click();
    const row = page.locator('#invoice-page-form [data-invoice-line]').last();
    await row.locator('[data-line-field="kind"]').selectOption('material');
    await row.locator('[data-line-field="description"]').fill(`Extra material ${count + 1}`);
    await row.locator('[data-line-field="unitCents"]').fill('100');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth) + 1);
  await saveInvoicePage(page);
  expect((await state(page)).invoices.find((invoice: { rot?: unknown }) => invoice.rot).lines).toHaveLength(5);
  await action(page, 'issue-invoice').click();
  await reviewed(page);
  await expect(action(page, 'invoice-payment')).toBeVisible();
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(viewportWidth + 1);
  await page.reload();
  const saved = await state(page);
  expect(saved.invoices.find((invoice: { rot?: unknown }) => invoice.rot).status).toBe('issued');
});

test('materiallager: bokfört inköp kan värderas på 1460 och uttag över saldot stoppas', async ({ page }) => {
  await open(page, 'purchases');
  const initial = await currentState(page);
  const materialBill = initial.bills.find((bill: { status: string; account: string }) => bill.status === 'draft' && bill.account === '4010');
  await page.locator(`[data-select-bill="${materialBill.id}"]`).click();
  await action(page, 'book-bill').click();
  await reviewed(page);
  await page.goto(`${demo}#inventory`);
  await expect(page.getByRole('heading', { name: 'Materiallager och inventering', exact: true })).toBeVisible();
  await action(page, 'new-stock').click();
  await modal(page).locator('[name="name"]').fill('Gipsskiva · browserprov');
  await modal(page).locator('[name="unit"]').fill('st');
  await modal(page).locator('[name="unitCostCents"]').fill('100');
  await saveDialog(page);
  await action(page, 'stock-movement').click();
  await modal(page).locator('[name="quantity"]').fill('10');
  await modal(page).locator('[name="reason"]').fill('Fiktiv inleverans från bokfört inköp');
  await saveDialog(page);
  const afterIn = await state(page);
  expect(afterIn.inventoryItems[0].quantity).toBe(10);
  await action(page, 'stock-movement').click();
  await modal(page).locator('[name="kind"]').selectOption('out');
  await modal(page).locator('[name="quantity"]').fill('11');
  await modal(page).locator('[name="reason"]').fill('Försök till uttag över lagersaldo');
  await modal(page).locator('button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText(/negativt|lagersaldo|antal/i);
  expect((await state(page)).inventoryItems[0].quantity).toBe(10);
  expect((await state(page)).entries).toEqual(afterIn.entries);
  await modal(page).locator('[data-action="close-dialog"]').first().click();
  await action(page, 'value-stock').click();
  await reviewed(page);
  let saved = await state(page);
  expect(saved.inventoryValuations).toHaveLength(1);
  expect(saved.inventoryValuations[0].valueCents).toBe(100_000);
  const valuationEntry = saved.entries.find((entry: { id: string }) => entry.id === saved.inventoryValuations[0].entryId);
  expect(valuationEntry.rows).toEqual(expect.arrayContaining([
    { account: '1460', debitCents: 100_000, creditCents: 0 },
    { account: '4960', debitCents: 0, creditCents: 100_000 },
  ]));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Materiallager och inventering', exact: true })).toBeVisible();
  saved = await state(page);
  expect(saved.inventoryItems[0].quantity).toBe(10);
  expect(saved.inventoryItems[0].movements).toHaveLength(1);
  expect(saved.inventoryValuations[0].valueCents).toBe(100_000);
});

test('periodisering: bokförd IT-kostnad fördelas via 1790 och samma månad kan inte upprepas', async ({ page }) => {
  await open(page, 'purchases');
  await action(page, 'new-bill').click();
  const purchaseForm = page.locator('#purchase-page-form');
  await purchaseForm.locator('[name="supplier"]').fill('IT-leverantör · browserprov');
  await purchaseForm.locator('[name="number"]').fill('BROWSER-IT-001');
  await purchaseForm.locator('[name="netCents"]').fill('1200');
  await purchaseForm.locator('[name="account"]').selectOption('6540');
  await purchaseForm.locator('button[type="submit"]').click();
  await expect(purchaseForm).toHaveCount(0);
  await action(page, 'book-bill').click();
  await reviewed(page);
  await page.goto(`${demo}#accruals`);
  await expect(page.getByRole('heading', { name: 'Förutbetalda kostnader', exact: true })).toBeVisible();
  await action(page, 'new-accrual').click();
  await modal(page).locator('[name="name"]').fill('Licens · browserprov');
  await modal(page).locator('[name="amountCents"]').fill('1200');
  await modal(page).locator('[name="expenseAccount"]').selectOption('6540');
  await modal(page).locator('[name="startMonth"]').fill('2026-11');
  await modal(page).locator('[name="months"]').fill('2');
  await saveDialog(page);
  let saved = await state(page);
  const accrual = saved.accruals[0];
  const setupEntry = saved.entries.find((entry: { id: string }) => entry.id === accrual.entryId);
  expect(setupEntry.rows).toEqual(expect.arrayContaining([
    { account: '1790', debitCents: 120_000, creditCents: 0 },
    { account: '6540', debitCents: 0, creditCents: 120_000 },
  ]));
  await action(page, 'accrual-month').click();
  await expect(modal(page).locator('[name="date"]')).toHaveValue('2026-11-01');
  await reviewed(page);
  saved = await state(page);
  expect(saved.accruals[0].postings).toHaveLength(1);
  expect(saved.accruals[0].postings[0].amountCents).toBe(60_000);
  const entriesBeforeDuplicate = saved.entries.length;
  await action(page, 'accrual-month').click();
  await modal(page).locator('[name="date"]').fill('2026-11-01');
  await modal(page).locator('[name="reviewed"]').check();
  await modal(page).locator('button[type="submit"]').click();
  await expect(page.locator('#dialog-error')).toContainText('nästa planerade månad');
  expect((await state(page)).entries).toHaveLength(entriesBeforeDuplicate);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Förutbetalda kostnader', exact: true })).toBeVisible();
  saved = await state(page);
  expect(saved.accruals[0].postings).toHaveLength(1);
  const remaining = saved.entries.flatMap((entry: { rows: unknown[] }) => entry.rows)
    .filter((row: { account: string }) => row.account === '1790')
    .reduce((total: number, row: { debitCents: number; creditCents: number }) => total + row.debitCents - row.creditCents, 0);
  expect(remaining).toBe(60_000);
});
