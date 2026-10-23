import { expect, test, type Page } from '@playwright/test';

const wiki = '/bokforing/wiki/';
const bookKey = 'scrapplanner-bokforing-suite-v2';
const pageErrors = new WeakMap<Page, string[]>();
test.use({ viewport: { width: 1440, height: 1000 }, locale: 'sv-SE' });
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

async function open(page: Page, hash = '') {
  await page.goto(`${wiki}${hash}`);
  await expect(page.locator('#wiki-main')).toBeVisible();
}

async function search(page: Page, query: string) {
  const mainForm = page.locator('#wiki-main form[data-wiki-search]');
  const form = await mainForm.count() ? mainForm.first() : page.locator('form[data-wiki-search]').first();
  await form.locator('[name="q"]').fill(query);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/#sok(?:\?|$)/);
}

async function resultAddresses(page: Page) {
  return page.locator('.result-card[href^="#artikel/"]').evaluateAll(links =>
    [...new Set(links.map(link => link.getAttribute('href')!))].sort());
}

test('wikin läser dokumentationen utan åtkomst till besökarens bokföring eller produktions-API', async ({ page }) => {
  await page.addInitScript(({ key }) => {
    const marker = '{"privateCustomer":"Privatkund-989","privateAmount":987654321}';
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    const clear = Storage.prototype.clear;
    const audit = { reads: [] as string[], writes: [] as string[], databases: [] as string[] };
    set.call(localStorage, key, marker);
    Storage.prototype.getItem = function (name: string) { audit.reads.push(name); return get.call(this, name); };
    Storage.prototype.setItem = function (name: string, value: string) { audit.writes.push(name); return set.call(this, name, value); };
    Storage.prototype.removeItem = function (name: string) { audit.writes.push(name); return remove.call(this, name); };
    Storage.prototype.clear = function () { audit.writes.push('*'); return clear.call(this); };
    const openDatabase = indexedDB.open.bind(indexedDB);
    indexedDB.open = function (name: string, version?: number) {
      audit.databases.push(name);
      return version === undefined ? openDatabase(name) : openDatabase(name, version);
    };
    Object.assign(window, { wikiStorageAudit: audit, wikiStoredMarker: () => get.call(localStorage, key) });
  }, { key: bookKey });
  const productionRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) productionRequests.push(request.url()); });
  await open(page);
  await expect(page.locator('#wiki-main')).not.toContainText('Privatkund-989');
  await search(page, 'verifikation');
  await page.locator('.result-card[href^="#artikel/"]').first().click();
  await expect(page).toHaveURL(/#artikel\//);
  const audit = await page.evaluate(() => {
    const current = window as typeof window & {
      wikiStorageAudit: { reads: string[]; writes: string[]; databases: string[] };
      wikiStoredMarker: () => string | null;
    };
    return { ...current.wikiStorageAudit, stored: current.wikiStoredMarker() };
  });
  expect(audit.reads.filter(key => key.startsWith('scrapplanner-'))).toEqual([]);
  expect(audit.writes).toEqual([]);
  expect(audit.databases).toEqual([]);
  expect(audit.stored).toBe('{"privateCustomer":"Privatkund-989","privateAmount":987654321}');
  expect(productionRequests).toEqual([]);
});

test('svensk fulltextsökning hittar samma artiklar utan accenter och stöder delbara adresser', async ({ page }) => {
  await open(page);
  await search(page, 'leverantör');
  await expect(page.locator('.result-card').first()).toBeVisible();
  const accented = await resultAddresses(page);
  expect(accented.length).toBeGreaterThan(0);
  await search(page, 'leverantor');
  await expect.poll(() => resultAddresses(page)).toEqual(accented);
  const resultsUrl = page.url();
  const selected = page.locator('.result-card[href^="#artikel/"]').first();
  const articleAddress = await selected.getAttribute('href');
  await selected.click();
  expect(page.url().endsWith(articleAddress!)).toBe(true);
  await expect(page.locator('.article-body')).toBeVisible();
  const title = await page.locator('#wiki-main h1').innerText();
  await page.reload();
  await expect(page.locator('#wiki-main h1')).toHaveText(title);
  await page.goBack();
  await expect(page).toHaveURL(resultsUrl);
  await expect.poll(() => resultAddresses(page)).toEqual(accented);
  await page.goForward();
  await expect(page.locator('#wiki-main h1')).toHaveText(title);
});

test('kategorifilter avgränsar sökträffar och en okänd sökfras hanteras som text', async ({ page }) => {
  await open(page);
  await search(page, '');
  const category = await page.evaluate(async () => {
    const source = '/bokforing/wiki/content.js';
    const { articles, categories } = await import(source);
    const chosen = categories.find((item: { id: string }) => articles.some((article: { category: string }) => article.category === item.id));
    return { id: chosen.id as string, addresses: articles.filter((article: { category: string }) => article.category === chosen.id).map((article: { id: string }) => `#artikel/${article.id}`).sort() as string[] };
  });
  await page.locator(`[data-category-filter="${category.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`kategori=${encodeURIComponent(category.id)}`));
  await expect.poll(() => resultAddresses(page)).toEqual(category.addresses);
  const unsafeQuery = '<img data-wiki-test-payload src=x onerror="window.wikiInjected=true">ingen-träff-9827';
  await search(page, unsafeQuery);
  await expect(page.locator('.empty-state')).toBeVisible();
  await expect(page.locator('[data-wiki-test-payload]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { wikiInjected?: boolean }).wikiInjected)).toBeUndefined();
});

test('planerade funktioner hålls isär från testad demo och verifieringsartikeln länkar till versionsbundna bevis', async ({ page }) => {
  await open(page);
  const plannedId = await page.evaluate(async () => {
    const source = '/bokforing/wiki/content.js';
    const { articles } = await import(source);
    return articles.find((article: { status: string }) => article.status === 'planned')?.id as string | undefined;
  });
  expect(plannedId).toBeTruthy();
  await page.goto(`${wiki}#artikel/${plannedId}`);
  await expect(page.locator('#wiki-main .status-pill').first()).toContainText('Planerat');
  await expect(page.locator('.article-body')).toBeVisible();
  await page.goto(`${wiki}#artikel/verifiering`);
  const metadata = await page.evaluate(async () => {
    const path = '/bokforing/wiki/content.js';
    return (await import(path)).wikiMeta;
  });
  await expect(page.locator('#wiki-main')).toContainText(new Intl.NumberFormat('sv-SE').format(metadata.verification.model));
  await expect(page.locator('#wiki-main')).toContainText(String(metadata.verification.browser));
  await expect(page.locator('#wiki-main')).toContainText(metadata.version);
  const sources = await page.locator('.sources-card a').evaluateAll(links => links.map(link => ({ href: link.getAttribute('href')!, target: link.getAttribute('target'), rel: link.getAttribute('rel') || '' })));
  expect(sources.some(source => source.href.includes('github.com/NicklasJr93/JEROC-Atervinning/') && source.href.includes(metadata.version))).toBe(true);
  for (const source of sources) {
    expect(source.href.startsWith('https://') || source.href.startsWith('/bokforing/')).toBe(true);
    if (source.target === '_blank') expect(source.rel.split(/\s+/)).toContain('noopener');
  }
});

test('revisorns guide leder från kontroller till källor och den körbara demon', async ({ page }) => {
  await open(page, '#artikel/for-revisorn');
  await expect(page.locator('#wiki-main h1')).toContainText(/revisor|gransk/i);
  expect(await page.locator('.article-body ol li').count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.article-body')).toContainText(/begränsning/i);
  await expect(page.locator('.topbar-actions a[href="/bokforing/"]')).toBeVisible();
  const related = page.locator('#wiki-main a[href^="#artikel/"]').filter({ hasText: /kontroll|verifier|begräns/i }).first();
  await expect(related).toBeVisible();
  await related.click();
  await expect(page.locator('.article-body')).toBeVisible();
});

test('mobilmenyn öppnar en läsbar artikel utan horisontellt sidöverflöde', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.locator('#wiki-menu').click();
  await expect(page.locator('#wiki-menu')).toHaveAttribute('aria-expanded', 'true');
  const link = page.locator('#wiki-sidebar a[href="#artikel/for-revisorn"]');
  const group = link.locator('xpath=ancestor::details');
  if (await group.getAttribute('open') === null) await group.locator('summary').click();
  await link.click();
  await expect(page.locator('#wiki-menu')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.article-body')).toBeVisible();
  const width = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  expect(width.page).toBeLessThanOrEqual(width.viewport);
});
