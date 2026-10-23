import { expect, test, type Page } from '@playwright/test';

const storageKey = 'scrapplanner-bokforing-suite-v2';
const demo = '/bokforing/index.html#settlements';
test.setTimeout(45_000);
test.use({ viewport: { width: 1440, height: 1100 } });

async function seed(page: Page, side: 'customer' | 'supplier') {
  await page.goto('/bokforing/index.html');
  const id = await page.evaluate(async ({ key, side }) => {
    const corePath = '/bokforing/suite/core.js', salesPath = '/bokforing/suite/sales.js', purchasePath = '/bokforing/suite/operations.js';
    const core = await import(corePath), sales = await import(salesPath), purchase = await import(purchasePath);
    let state = core.createEmptyState();
    let id: string;
    if (side === 'customer') {
      state = sales.createCustomer(state, {address:'Fiktivgatan 1',postalCode:'12345',city:'Demostaden',country:'SE',vatNumber:'SE559900123601', name: 'Testkund AB' });
      state = sales.createInvoice(state, {details:{performance:{mode:'invoice-date',confirmed:true}}, customerId: state.customers[0].id, date: '2026-10-01', dueDate: '2026-10-31',
        lines: [{ description: 'Målning', kind: 'labor', quantity: 1, unitCents: 10000, vatRate: 25 }] });
      id = state.invoices[0].id;
      state = sales.issueInvoice(state, id);
      state = sales.receivePayment(state, id, { date: '2026-10-02', amountCents: 12500, reference: 'BANK-1' });
    } else {
      state = purchase.createBill(state, { supplier: 'Testverkstaden AB', number: 'TEST-81', date: '2026-10-01', dueDate: '2026-10-31', lines: [
        { description: 'Material', netCents: 10000, account: '4010', vatMode: 'standard', vatRate: 25, deductibleBps: 10000 },
        { description: 'Frakt', netCents: 5000, account: '6991', vatMode: 'no-vat', vatRate: 0, deductibleBps: 10000 },
      ] });
      id = state.bills[0].id;
      state = purchase.bookBill(state, id);
      state = purchase.payBill(state, id, { date: '2026-10-02', amountCents: 17500 });
    }
    localStorage.setItem(key, JSON.stringify(state));
    return id;
  }, { key: storageKey, side });
  await page.goto(demo);
  // A hash-only navigation keeps the old in-memory app state. Reload so the
  // coordinated storage reads the synthetic fixture we have just installed.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kreditera, återbetala och kvitta' })).toBeVisible();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  return id;
}

test('settlements: betald kundfaktura kan delkrediteras och återbetalas utan att originalet skrivs om', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = await seed(page, 'customer');
  const original = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).invoices[0].bookingSnapshot, storageKey);
  const form = page.locator('form[data-feature-form="settlements"][data-action="credit"]');
  await form.locator('[name="line-0"]').fill('40,00');
  await form.locator('[name="date"]').fill('2026-10-10');
  await form.locator('[name="reference"]').fill('KREDIT-UI-1');
  await form.locator('[name="reason"]').fill('Avtalad prisjustering');
  await form.getByRole('button', { name: 'Bokför kreditnota' }).click();
  const refund = page.locator('form[data-action="refund"]');
  await expect(refund).toBeVisible();
  await expect(refund.locator('[name="amount"]')).toHaveValue('50,00');
  await refund.locator('[name="date"]').fill('2026-10-11');
  await refund.locator('[name="reference"]').fill('REFUND-UI-1');
  await refund.getByRole('button', { name: 'Bokför återbetalning' }).click();
  await expect(refund).toHaveCount(0);
  const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(state.invoices[0].id).toBe(id);
  expect(state.invoices[0].bookingSnapshot).toBe(original);
  expect(state.settlements.map((record: { kind: string }) => record.kind)).toEqual(['credit', 'refund']);
  expect(state.invoices[0].settlementCreditCents).toBe(5000);
  expect(state.invoices[0].settlementRefundCents).toBe(5000);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kreditera, återbetala och kvitta' })).toBeVisible();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  expect(errors).toEqual([]);
});

test('settlements: blandad leverantörsfaktura krediterar vald rad och stoppar för stor kredit', async ({ page }) => {
  await seed(page, 'supplier');
  const form = page.locator('form[data-action="credit"]');
  await form.locator('[name="line-0"]').fill('100,01');
  await form.locator('[name="date"]').fill('2026-10-10');
  await form.locator('[name="reference"]').fill('TOO-MUCH');
  await form.locator('[name="reason"]').fill('Test av beloppsgräns');
  await form.getByRole('button', { name: 'Bokför kreditnota' }).click();
  await expect(form.locator('[name="line-0"]')).toHaveValue('100,01');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).settlements ?? [], storageKey)).toEqual([]);
  await form.locator('[name="line-0"]').fill('0');
  await form.locator('[name="line-1"]').fill('50');
  await form.locator('[name="reference"]').fill('FRI-FRAKT');
  await form.getByRole('button', { name: 'Bokför kreditnota' }).click();
  await expect(page.locator('form[data-action="refund"]')).toBeVisible();
  const state = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(state.settlements[0].amountCents).toBe(5000);
  expect(state.settlements[0].lines).toEqual([{ index: 1, netCents: 5000 }]);
  const entry = state.entries.find((entry: { id: string }) => entry.id === state.settlements[0].entryId);
  expect(entry.rows.some((row: { account: string }) => row.account === '2641')).toBe(false);
});

test('settlements: mobil arbetsyta kan användas utan horisontellt sidöverflöde', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 'customer');
  await expect(page.locator('form[data-action="credit"] button[type="submit"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
