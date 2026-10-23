import { expect, test, type Page } from '@playwright/test';

const key = 'scrapplanner-bokforing-suite-v2';
test.setTimeout(90_000);
const stored = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
const form = (page: Page, action: string) => page.locator(`form[data-feature-form="year-end"][data-action="${action}"]`);

async function start(page: Page, ready = false) {
  await page.goto('/bokforing/index.html');
  await page.evaluate(async ({ key, ready }) => {
    const corePath = '/bokforing/suite/core.js', financePath = '/bokforing/suite/finance.js';
    const core = await import(corePath), finance = await import(financePath);
    let state = core.transact(core.createEmptyState(), (draft: { [key: string]: unknown }) => core.appendEntry(draft, { date: '2026-01-01', description: 'Ingående balanser', sourceType: 'opening', sourceId: 'opening-2026',
      rows: [{ account: '1930', debitCents: 2_500_000, creditCents: 0 }, { account: '2081', debitCents: 0, creditCents: 2_500_000 }] }));
    state = finance.updateCompany(state, { vatPeriod: 'year' });
    if (ready) {
      state = finance.fileVatPeriod(state, { from: '2026-01-01', to: '2026-12-31', date: '2026-12-31' });
      for (let month = 1; month <= 12; month++) state = finance.lockPeriod(state, `2026-${String(month).padStart(2, '0')}`);
    }
    localStorage.setItem(key, JSON.stringify(state));
  }, { key, ready });
  await page.reload();
  await page.goto('/bokforing/index.html#year-end');
  await expect(page.getByRole('heading', { name: 'Från avstämning till nästa år', exact: true })).toBeVisible();
}

test('year workspace saves reviewed workpapers and preserves revision history after reload', async ({ page }) => {
  await start(page);
  await page.getByText('Ny bokslutsbilaga', { exact: true }).click();
  const f = form(page, 'save-workpaper');
  await f.locator('[name="title"]').fill('Bankavstämning december');
  await f.locator('[name="account"]').selectOption('1930');
  await f.locator('[name="status"]').selectOption('reviewed');
  await f.locator('[name="preparedBy"]').fill('Åke');
  await f.locator('[name="reviewedBy"]').fill('Jenny');
  await f.locator('[name="evidence"]').fill('Kontoutdrag DEMO-2026-12');
  await f.locator('[name="note"]').fill('Avstämt mot utgående saldo.');
  await f.getByRole('button', { name: 'Skapa bokslutsbilaga' }).click();
  await expect.poll(async () => (await stored(page)).yearWorkpapers?.length).toBe(1);
  await expect(page.getByText('Bankavstämning december', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  await page.getByText('Bankavstämning december', { exact: true }).click();
  const saved = form(page, 'save-workpaper').first();
  await saved.locator('[name="note"]').fill('Kompletterad med kontroll av bankavgifter.');
  await saved.getByRole('button', { name: 'Spara ny version av bilagan' }).click();
  await expect.poll(async () => (await stored(page)).yearWorkpapers?.[0]?.revisions?.length).toBe(2);
  expect((await stored(page)).yearWorkpapers[0].revisions[0].note).toBe('Avstämt mot utgående saldo.');
});

test('year workspace closes the year and opens the next year with retained archive and reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page, true);
  const original = await stored(page);
  await form(page, 'close-year').locator('[name="confirmed"]').check();
  await form(page, 'close-year').getByRole('button', { name: 'Bokför årets resultat och avsluta' }).click();
  await expect(form(page, 'open-next-year')).toBeVisible();
  await form(page, 'open-next-year').locator('[name="confirmed"]').check();
  await form(page, 'open-next-year').getByRole('button', { name: 'Öppna nästa år' }).click();
  await expect.poll(async () => (await stored(page)).company.fiscalYearStart).toBe('2027-01-01');
  const next = await stored(page);
  expect(next.entries).toEqual(original.entries);
  expect(next.fiscalYears[0].snapshot.entries).toEqual(original.entries);
  expect(next.fiscalYears[0].status).toBe('closed');
  expect(next.fiscalYears[1].status).toBe('open');
  await page.reload();
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  await expect(page.locator('.year-label')).toHaveText('2027');
  await expect(form(page, 'close-year')).toBeVisible();
  expect(errors).toEqual([]);
});

test('year workspace exports draft review material and fits a mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const downloadPromise = page.waitForEvent('download');
  await form(page, 'export-annual').getByRole('button', { name: 'Hämta årsredovisningsunderlag' }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('arsredovisningsunderlag-utkast.json');
  await expect(page.locator('#suite-storage-notice')).toBeHidden();
  const state = await stored(page); expect(state.entries).toHaveLength(1);
});
