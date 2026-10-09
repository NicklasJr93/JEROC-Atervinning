import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
async function open(page: Page, permission = true, status: 'new' | 'attest' = 'new', manualPrice = false) {
  const data = migrateOffice(seedOffice());
  data.users.find(user => user.id === 'kajsa')!.permissions = data.users.find(user => user.id === 'kajsa')!.permissions.filter(right => permission || right !== 'weighingAddArticle');
  data.cards.find(card => card.id === 2053)!.status = status;
  if (manualPrice) Object.assign(data.cards.find(card => card.id === 2053)!.rows[0], { manualOverride: true, tier: 'Eget', price: 99 });
  await page.addInitScript(data => { if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data)); }, data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await page.goto('/kontor#/weighings/2053');
  return data;
}

test('lägg till artikel sparar en separat batterirad, uppdaterar priser och visar miljökortet', async ({ page }) => {
  await open(page, true, 'new', true);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption({ label: 'Blybatterier' });
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('12,5');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.office-card-material')).toContainText('Blybatterier');
  const card = await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === 2053));
  expect(card.rows).toHaveLength(2);
  expect(card.rows[1].weight).toBe(12.5);
  expect(card.rows[0].price).toBe(99);
  expect(card.rows[0].manualOverride).toBe(true);
  expect(card.rows[1].articleName).toBe('Blybatterier');
  expect(card.rows[1].price).toBeGreaterThan(0);
  expect(card.audit.at(-1).text).toContain('Artikel tillagd: Blybatterier');
  await expect(page.getByRole('region', { name: 'Miljö och mottagning', exact: true })).toContainText('16 06 01*');
  await page.reload();
  await expect(page.locator('.office-card-material')).toContainText('Blybatterier');
});

test('ogiltig vikt och avbryt skapar ingen materialrad', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption({ label: 'Blybatterier' });
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('större än 0');
  await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === 2053).rows.length)).toBe(1);
});

test('återkallad artikelbehörighet och låst attestkort döljer artikelknappen', async ({ page }) => {
  await open(page, false);
  await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
  await page.evaluate(() => { const data = JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!); data.users.find((user: {id: string}) => user.id === 'kajsa').permissions.push('weighingAddArticle'); data.cards.find((card: {id: number}) => card.id === 2053).status = 'attest'; localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data)); });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
});

test('menyikoner behåller storleken och nollkort ger ingen markör', async ({ page }) => {
  await open(page);
  await page.evaluate(() => sessionStorage.setItem('jeroc.office.user', 'admin'));
  await page.reload();
  const nav = page.locator('.office-sidebar nav');
  await expect(nav.getByRole('button', { name: /^Kundgodkännande/ }).locator('.office-nav-count')).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /^Attest/ }).locator('.office-nav-count')).toHaveCount(0);
  const counts = await nav.getByRole('button', { name: /^Invägningar/ }).locator('.office-nav-count').innerText();
  expect(Number(counts)).toBe(await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.filter((card: {status: string}) => ['new', 'complement'].includes(card.status)).length));
  expect(await nav.getByRole('button', { name: /^Kundgodkännande/ }).locator('svg').evaluate(svg => svg.getBoundingClientRect().width)).toBe(19);
});

test('artikel från serverregistret får beständigt namn och spärras för kundgodkännande när pris saknas', async ({ page }) => {
  await page.route('**/api/pricing/state**', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.articles.push({ ...state.articles[0], id: 'custom-unpriced', name: 'Ny registerartikel', active: true });
    await route.fulfill({ response, json: state });
  });
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await open(page);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption('custom-unpriced');
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.office-card-material')).toContainText('Ny registerartikel');
  const card = await page.evaluate(() => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: {id: number}) => card.id === 2053));
  expect(card.financialPending).toBe(true);
  expect(card.rows[1].pricePending).toBe(true);
  await page.reload();
  await expect(page.locator('.office-card-material')).toContainText('Ny registerartikel');
  expect(failures).toEqual([]);
});
