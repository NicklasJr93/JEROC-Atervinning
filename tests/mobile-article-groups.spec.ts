import { test, expect, type Page } from '@playwright/test';
import { seedDemo, type DemoData } from '../src/model';
import type { Article } from '../src/data';
import type { ArticleGroup } from '../src/catalog-types';
import { employeeCompanyId, employeeRecoveryKey } from '../src/employee/cache';
import type { EmployeeOverview } from '../src/employee/types';
import { sharedBusinessCacheKey } from '../src/shared-data';

const mediaId = 'c6ff7e4a-c2ce-4aac-bce6-2c044c1e919d';
const api = '/api/application/mobile';

async function catalogFixture(page: Page, options: { groupPhoto?: ArticleGroup['photo']; articlePhoto?: Article['photos'][number] } = {}) {
  let data: DemoData = { ...seedDemo(), drafts: [] };
  const groups: ArticleGroup[] = [
    { id: 'koppar', name: 'Koppar', description: 'Grupp från kontorets register', photo: options.groupPhoto ?? mediaId, sortOrder: 0, active: true, revision: 1 },
    { id: 'ren-koppar', parentId: 'koppar', name: 'Ren koppar', description: 'Ren och sorterad', photo: 0, sortOrder: 0, active: true, revision: 1 },
    { id: 'inaktiv', name: 'Dold grupp', description: '', photo: null, sortOrder: 1, active: false, revision: 1 },
    { id: 'dold-undergrupp', parentId: 'inaktiv', name: 'Dold undergrupp', description: '', photo: null, sortOrder: 0, active: true, revision: 1 },
  ];
  const article = (id: string, category: string, name: string, photos: Article['photos'] = []): Article => ({
    id, category, name, photos, active: true, description: `Beskrivning för ${name}`,
    includes: 'Ren metall enligt kontorets instruktion.', excludes: 'Plast och föroreningar.', prices: [82, 74, 66],
  });
  const catalog: Article[] = [
    article('root-copper', 'koppar', 'Blandad koppar', [options.articlePhoto ?? 0]),
    article('clean-copper', 'ren-koppar', 'Koppar klass 1', [mediaId, 0]),
    article('other-article', '', 'Provartikel utan grupp'),
    article('legacy-article', 'legacy-missing', 'Äldre artikel utan grupp'),
    article('hidden-article', 'dold-undergrupp', 'Dold artikel'),
    { ...article('inactive-article', '', 'Avaktiverad artikel'), active: false },
    { ...article('missing-price', 'koppar', 'Artikel utan LME-pris'), prices: [null, null, null] },
  ];
  let reads = 0;
  const authenticated = await page.request.post('/api/employee/login', { data: { username: 'niklas', password: 'Demo123!' } });
  expect(authenticated.ok(), await authenticated.text()).toBe(true);
  const session = await authenticated.json() as EmployeeOverview;
  const companyId = employeeCompanyId(session.companyId), personId = session.person.id;
  const recoveryKey = employeeRecoveryKey(companyId, personId);
  const catalogCacheKey = sharedBusinessCacheKey('jeroc.mobile.article-catalog.v1', { companyId, employee: personId });
  await page.addInitScript(({ initial, recoveryKey }) => {
    localStorage.setItem(recoveryKey, JSON.stringify(initial));
    localStorage.setItem(`${recoveryKey}.postgres-imported`, 'yes');
  }, { initial: data, recoveryKey });
  const mergeRecords = <T extends { id: string }>(current: T[], changes: Array<{ id: string; next?: T }> = []): T[] => {
    const records = new Map(current.map(value => [value.id, value]));
    for (const change of changes) {
      if (change.next) records.set(change.id, change.next); else records.delete(change.id);
    }
    return [...records.values()];
  };
  await page.route(url => url.pathname === api, async route => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON();
      if (request.kind === 'update') data = request.next;
      else if (request.kind === 'records') data = { ...data,
        drafts: mergeRecords(data.drafts, request.drafts), customers: mergeRecords(data.customers, request.customers) };
    } else reads++;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, revision: reads, catalog, groups, customerPrices: {} }) });
  });
  await page.route(`**/api/article-media/${mediaId}?*`, route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh8kAAAAASUVORK5CYII=', 'base64') }));
  await page.goto('/#/yard');
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  return { groups, catalog, catalogCacheKey, reads: () => reads };
}

async function start(page: Page) {
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await expect(page.getByRole('heading', { name: 'Välj material' })).toBeVisible();
}

test('dynamiska grupper visar undergrupper, direktartiklar, egna bilder och Övrigt', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await catalogFixture(page);
  await start(page);
  await expect(page.locator('.material-choice').filter({ hasText: 'Dold grupp' })).toHaveCount(0);
  await expect(page.locator('.material-choice img')).toHaveAttribute('src', `/api/article-media/${mediaId}?variant=thumb`);
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await expect(page.locator('.material-choice').filter({ hasText: 'Ren koppar' })).toBeVisible();
  await expect(page.locator('.material-choice').filter({ hasText: 'Blandad koppar' })).toBeVisible();
  await expect(page.locator('.material-choice').filter({ hasText: 'Artikel utan LME-pris' })).toBeVisible();
  await page.locator('.material-choice').filter({ hasText: 'Ren koppar' }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar klass 1' }).click();
  const gallery = page.getByRole('region', { name: 'Materialets exempelbilder' });
  await expect(gallery.locator('img')).toHaveAttribute('src', `/api/article-media/${mediaId}?variant=full`);
  await expect(page.locator('.article-description')).toHaveText('Beskrivning för Koppar klass 1');
  await gallery.press('ArrowRight');
  await expect(gallery.getByRole('img', { name: 'Koppar klass 1, exempel 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ren koppar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Koppar', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await page.locator('.material-choice').filter({ hasText: 'Övrigt' }).click();
  await expect(page.locator('.material-choice').filter({ hasText: 'Äldre artikel utan grupp' })).toBeVisible();
  await expect(page.locator('.material-choice').filter({ hasText: 'Avaktiverad artikel' })).toHaveCount(0);
  await page.locator('.material-choice').filter({ hasText: 'Provartikel utan grupp' }).click();
  await expect(page.getByText('Referensbilder saknas för artikeln.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Förstora referensbild' })).toHaveCount(0);
  await page.getByRole('region', { name: 'Materialets exempelbilder' }).press('ArrowRight');
  await page.getByRole('button', { name: 'Välj Provartikel utan grupp', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Vikt i kg' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('serverändrade grupper och texter slår igenom utan omstart och dolda grupper är inte sökbara', async ({ page }) => {
  const fixture = await catalogFixture(page);
  await start(page);
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  fixture.groups[0].name = 'Koppar och kabel';
  fixture.groups[0].description = 'Ny text sparad på kontoret';
  fixture.groups[0].revision++;
  const reads = fixture.reads();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => fixture.reads()).toBeGreaterThan(reads);
  await expect(page.getByRole('heading', { name: 'Koppar och kabel', exact: true })).toBeVisible();
  await expect(page.getByText('Ny text sparad på kontoret')).toBeVisible();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Sök material eller artikel' }).fill('Dold');
  await expect(page.locator('.material-choice')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Sök material eller artikel' }).fill('klass 1');
  await expect(page.locator('.material-choice')).toHaveCount(1);
  await expect(page.locator('.material-choice')).toContainText('Koppar klass 1');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).groups[0].name, fixture.catalogCacheKey)).toBe('Koppar och kabel');
  await page.goto('/#/prices');
  const missing = page.getByRole('button', { name: 'Visa priser för Artikel utan LME-pris', exact: true });
  await expect(missing).toBeVisible();
  await expect(missing.locator('.price-value')).toHaveText(['—', '—', '—']);
  await missing.click();
  await expect(page.getByText('Pris saknas. Kontoret behöver komplettera prissättningen.')).toBeVisible();
});

test('utökade katalogbilder visas i materialgrupp, artikellista och fullstor referensbild', async ({ page }) => {
  await catalogFixture(page, { groupPhoto: 40, articlePhoto: 71 });
  const groupImage = page.waitForResponse(response => new URL(response.url()).pathname === '/images/catalog/40-thumb.webp');
  await start(page);
  const group = page.locator('.material-choice').filter({ hasText: 'Koppar' });
  await expect(group.locator('.material-photo')).not.toHaveClass(/material-photo-missing/);
  await expect(group.locator('.material-photo')).toHaveCSS('background-image', /\/images\/catalog\/40-thumb\.webp/);
  const loadedGroup = await groupImage;
  expect(loadedGroup.ok()).toBe(true);
  expect(loadedGroup.headers()['content-type']).toContain('image/webp');
  expect((await loadedGroup.body()).subarray(8, 12).toString()).toBe('WEBP');

  const articleImage = page.waitForResponse(response => new URL(response.url()).pathname === '/images/catalog/71-thumb.webp');
  await group.click();
  const article = page.locator('.material-choice').filter({ hasText: 'Blandad koppar' });
  await expect(article.locator('.material-photo')).not.toHaveClass(/material-photo-missing/);
  await expect(article.locator('.material-photo')).toHaveCSS('background-image', /\/images\/catalog\/71-thumb\.webp/);
  expect((await articleImage).ok()).toBe(true);

  const fullImage = page.waitForResponse(response => new URL(response.url()).pathname === '/images/catalog/71-full.webp');
  await article.click();
  const gallery = page.getByRole('region', { name: 'Materialets exempelbilder' });
  await expect(gallery.getByRole('img', { name: 'Blandad koppar, exempel 1', exact: true })).toHaveCSS('background-image', /\/images\/catalog\/71-full\.webp/);
  const loadedFull = await fullImage;
  expect(loadedFull.ok()).toBe(true);
  expect(loadedFull.headers()['content-type']).toContain('image/webp');
  expect((await loadedFull.body()).subarray(8, 12).toString()).toBe('WEBP');
  await page.getByRole('button', { name: 'Förstora referensbild', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img', { name: 'Blandad koppar', exact: true }))
    .toHaveCSS('background-image', /\/images\/catalog\/71-full\.webp/);
});
