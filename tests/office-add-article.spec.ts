import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { approveCurrentOfficeCard } from './helpers/customer-approval';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(60_000);
const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function articlePermission(page: Page, enabled: boolean) {
  const response = await page.request.get('/api/pricing/state', { headers: admin });
  expect(response.ok()).toBe(true);
  const { users } = await response.json() as { users: OfficeUser[] };
  const user = users.find(user => user.id === 'kajsa')!;
  user.permissions = user.permissions.filter(right => right !== 'weighingAddArticle');
  if (enabled) user.permissions.push('weighingAddArticle');
  const saved = await page.request.post('/api/pricing/users', { headers: admin, data: { users } });
  expect(saved.ok(), await saved.text()).toBe(true);
}
async function card(page: Page, id: number): Promise<OfficeCard> {
  const response = await page.request.get('/api/application/office', { headers: admin });
  expect(response.ok()).toBe(true);
  return (await response.json()).data.cards.find((card: OfficeCard) => card.id === id);
}
async function open(page: Page, permission = true, date?: string, rows?: OfficeCard['rows']) {
  await articlePermission(page, permission);
  const data = migrateOffice(seedOffice());
  const id = 67_000_000 + randomInt(1_000_000);
  data.cards = [{ ...data.cards.find(card => card.id === 2053)!, id, sourceId: randomUUID(),
    ...(date ? { date } : {}), ...(rows ? { rows } : {}), origin: 'Testgatan 4, 761 41 Norrtälje',
    paymentDetails: { method: 'cash' }, customerApproval: undefined, audit: [] }];
  await page.addInitScript(data => { if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data)); }, data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  const imported = await page.request.post('/api/application/office', { headers: admin, data: { kind: 'import', data } });
  expect(imported.ok(), await imported.text()).toBe(true);
  // Reload reads the imported canonical card and its current server revision.
  await page.goto(`/kontor#/weighings/${id}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: `Invägning #${id}`, exact: true })).toBeVisible();
  return id;
}

test('lägg till artikel sparar en separat batterirad, uppdaterar priser och visar miljökortet', async ({ page }) => {
  const id = await open(page);
  // A manual override must be saved through the authorized UI, not fabricated
  // in localStorage before the server's canonical card has been loaded.
  await page.getByRole('button', { name: 'Ändra pris', exact: true }).click();
  await page.getByLabel('Prisalternativ').selectOption('Eget');
  await page.getByLabel('Engångspris kr/kg').fill('99');
  await page.getByRole('button', { name: 'Spara pris', exact: true }).click();
  await expect.poll(async () => (await card(page, id)).rows[0].price).toBe(99);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption({ label: 'Blybatterier' });
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('12,5');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.office-card-material')).toContainText('Blybatterier');
  await expect.poll(async () => (await card(page, id)).rows.length).toBe(2);
  const saved = await card(page, id);
  expect(saved.rows[1].weight).toBe(12.5);
  expect(saved.rows[0].price).toBe(99);
  expect(saved.rows[0].manualOverride).toBe(true);
  expect(saved.rows[1].articleName).toBe('Blybatterier');
  expect(saved.rows[1].price).toBeGreaterThan(0);
  expect(saved.audit.at(-1)!.text).toContain('Artikel tillagd: Blybatterier');
  await expect(page.getByRole('region', { name: 'Miljö och mottagning', exact: true })).toContainText('16 06 01*');
  await page.reload();
  await expect(page.locator('.office-card-material')).toContainText('Blybatterier');
});

test('ogiltig vikt och avbryt skapar ingen materialrad', async ({ page }) => {
  const id = await open(page);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption({ label: 'Blybatterier' });
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('större än 0');
  await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
  expect((await card(page, id)).rows).toHaveLength(1);
});

test('återkallad artikelbehörighet och låst attestkort döljer artikelknappen', async ({ page }) => {
  const id = await open(page, false);
  try {
    await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
    await articlePermission(page, true);
    await page.reload();
    await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toBeEnabled();
    await approveCurrentOfficeCard(page, id);
    await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(async () => (await card(page, id)).status).toBe('attest');
    await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
  } finally { await articlePermission(page, true); }
});

test('menyikoner behåller storleken och nollkort ger ingen markör', async ({ page }) => {
  await open(page);
  await page.evaluate(() => sessionStorage.setItem('jeroc.office.user', 'admin'));
  await page.reload();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  const nav = page.locator('.office-sidebar nav');
  const counts = await nav.getByRole('button', { name: /^Invägningar/ }).locator('.office-nav-count').innerText();
  const response = await page.request.get('/api/application/office', { headers: admin });
  expect(response.ok()).toBe(true);
  expect(Number(counts)).toBe((await response.json()).data.cards.filter((card: OfficeCard) => ['new', 'complement'].includes(card.status)).length);
  expect(await nav.getByRole('button', { name: /^Kundgodkännande/ }).locator('svg').evaluate(svg => svg.getBoundingClientRect().width)).toBe(19);
  // Other tests legitimately leave shared approvals and attest cards behind.
  // Verify zero markers against a genuinely empty, separately created facility.
  await expect.poll(async () => (await (await page.request.get('/api/environment/session')).json()).actualUserId).toBe('admin');
  const session = await (await page.request.get('/api/environment/session')).json();
  const siteId = `empty-${randomUUID().slice(0, 8)}`;
  const created = await page.request.put(`/api/environment/sites/${siteId}`, { headers: { 'X-Environment-CSRF': session.csrfToken }, data: {
    expectedVersion: 0, name: `Tom testanläggning ${siteId}`, address: 'Testgatan 4', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188',
    active: true, permitReference: 'TEST', permitNotes: '',
  } });
  expect(created.ok(), await created.text()).toBe(true);
  await page.reload();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Anläggning', { exact: true }).selectOption(siteId);
  for (const name of [/^Invägningar/, /^Kundgodkännande/, /^Attest/, /^Utbetalningar/])
    await expect(nav.getByRole('button', { name }).locator('.office-nav-count')).toHaveCount(0);
});

test('artikel från serverregistret får beständigt namn och spärras för kundgodkännande när pris saknas', async ({ page }) => {
  const articleId = `custom-unpriced-${randomUUID().slice(0, 8)}`;
  const response = await page.request.get('/api/pricing/state', { headers: admin });
  expect(response.ok()).toBe(true);
  const state = await response.json();
  const registered = await page.request.post('/api/pricing/articles', { headers: admin, data: {
    ...state.articleHistory[0], id: articleId, name: 'Ny registerartikel', active: true,
    base: { type: 'lme', metal: 'copper' }, effectiveFrom: '2024-01-01',
  } });
  expect(registered.ok(), await registered.text()).toBe(true);
  const pricedArticleId = `custom-priced-${randomUUID().slice(0, 8)}`;
  const priced = await page.request.post('/api/pricing/articles', { headers: admin, data: {
    ...state.articleHistory[0], id: pricedArticleId, name: 'Befintlig prisrad', active: true,
    base: { type: 'manual', price: 82 }, effectiveFrom: '2024-01-01',
  } });
  expect(priced.ok(), await priced.text()).toBe(true);
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  // Both articles exist on the weighing date, but LME reference rates only
  // start in 2025. Missing historical LME must leave the new row unpriced.
  const id = await open(page, true, '2024-12-31T10:41:00Z', [
    { articleId: pricedArticleId, articleName: 'Befintlig prisrad', weight: 72, tier: 'B', price: 82 },
  ]);
  await page.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till artikel', exact: true });
  await dialog.getByLabel('Artikel', { exact: true }).selectOption(articleId);
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Lägg till artikel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.office-card-material')).toContainText('Ny registerartikel');
  await expect.poll(async () => (await card(page, id)).rows.length).toBe(2);
  const saved = await card(page, id);
  expect(saved.financialPending).toBe(true);
  expect(saved.rows[1].pricePending).toBe(true);
  // Preparation normally recalculates pending mobile/office rows. Missing
  // historical rates must be rejected by that real snapshot operation.
  const frozen = await page.request.post('/api/pricing/snapshots', { headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' }, data: {
    cardId: String(id), customerId: saved.customerId, deliveredAt: saved.date,
    rows: saved.rows.map(row => ({ articleId: row.articleId, weight: row.weight })),
  } });
  expect(frozen.status()).toBe(422);
  expect((await frozen.json()).error).toContain('LME-pris saknas');
  await page.reload();
  await expect(page.locator('.office-card-material')).toContainText('Ny registerartikel');
  expect(failures).toEqual([]);
});
