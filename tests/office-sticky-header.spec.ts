import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { PricingState } from '../src/office/pricing-client';
// @ts-expect-error The server seed factory is JavaScript without a declaration file.
import { createPricingStore } from '../server/pricing.mjs';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function fixture(page: Page, support = false) {
  const data = migrateOffice(seedOffice());
  const admin = data.users.find(user => user.id === 'admin')!;
  const user = support ? { ...admin, id: 'support-colleague', name: 'Behörig kollega' } : admin;
  if (support) data.users.push(user);
  const template = data.cards.find(card => card.id === 2051)!;
  data.cards = Array.from({ length: 90 }, (_, index) => ({ ...template, id: 7200 + index, sourceId: randomUUID(), status: 'ready' as const }));
  const customer = data.customers[0];
  data.customers = Array.from({ length: 80 }, (_, index) => ({ ...customer, id: `sticky-customer-${index}`, name: `Kund ${index}` }));
  data.cards = data.cards.map(card => ({ ...card, customerId: data.customers[0].id }));
  const pricing = createPricingStore().read({ actor: admin, user }) as PricingState;
  const firstArticle = pricing.articles[0];
  pricing.articles = Array.from({ length: 75 }, (_, index) => ({ ...firstArticle, id: `sticky-article-${index}`, category: pricing.groups?.[0]?.id ?? firstArticle.category, name: index === 0 ? 'Ett långt materialnamn som bryts på mindre skärmar' : `Material ${index}` }));
  const session = {
    enabled: true, authenticated: true, actor: { id: 'global-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: admin, user, company: { id: 'jeroc-demo', name: 'Testbolaget', organisationNumber: '5560000000', status: 'active' },
    organisationId: 'jeroc-demo', effectiveUserId: user.id, isSupportSession: support,
    mustChangePassword: false, csrfToken: 'sticky-test', generation: 1, companies: [],
  };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/pricing/state' ? pricing
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: user.id, user, csrfToken: 'environment-test', expiresAt: '2099-01-01T00:00:00.000Z' }
      : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { error: 'Tjänsten ingår inte i layouttestet.', code: 'layout_fixture' } });
  });
  return { data, pricing };
}

async function scroll(page: Page, top: number) {
  await page.evaluate(value => window.scrollTo(0, value), top);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
}

async function expectBelowShell(page: Page) {
  const shell = (await page.locator('.office-sticky-shell').boundingBox())!;
  const heading = (await page.locator('.office-page-header').boundingBox())!;
  const platform = (await page.locator('.platform-topbar').boundingBox())!;
  const strip = page.locator('.platform-support-strip');
  const support = await strip.count() ? await strip.boundingBox() : null;
  expect(shell.y).toBeCloseTo((support ?? platform).y + (support ?? platform).height, 0);
  expect(heading.y).toBeCloseTo(shell.y + shell.height, 0);
}

test('article detail and new article keep title, breadcrumbs and back together while forms scroll', async ({ page }) => {
  await fixture(page);
  await page.goto('/kontor#/prices');
  await page.getByRole('button', { name: 'Redigera Ett långt materialnamn som bryts på mindre skärmar', exact: true }).click();
  const header = page.locator('.office-page-header');
  await expect(header.getByRole('navigation', { name: 'Artikelns sökväg' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Prisvyer' })).toHaveCount(0);
  await scroll(page, 250);
  const before = (await header.boundingBox())!;
  const formBefore = (await page.locator('.office-pricing-editor').boundingBox())!;
  await scroll(page, 900);
  expect((await header.boundingBox())!.y).toBeCloseTo(before.y, 0);
  expect((await page.locator('.office-pricing-editor').boundingBox())!.y).toBeLessThan(formBefore.y - 50);
  await expectBelowShell(page);
  await header.getByRole('button', { name: 'Till artikelöversikten', exact: true }).click();
  await page.getByRole('button', { name: 'Ny artikel', exact: true }).click();
  await scroll(page, 450);
  await expectBelowShell(page);
  await expect(header.getByRole('heading', { name: 'Ny artikel', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Till artikelöversikten', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Prisvyer' })).toHaveCount(0);
});

test('queue title, tabs and filters stay below both support banners, with summary cards scrolling beneath', async ({ page }) => {
  await fixture(page, true);
  await page.goto('/kontor#/attest?tab=history');
  await expect(page.getByRole('heading', { name: 'Attestöversikt', exact: true })).toBeVisible();
  await expect(page.locator('.office-acting-banner')).toBeVisible();
  await expect(page.locator('.platform-support-strip')).toBeVisible();
  await scroll(page, 300);
  const header = page.locator('.office-page-header');
  const before = (await header.boundingBox())!;
  const summary = page.locator('.office-queue-summary');
  const summaryBefore = (await summary.boundingBox())!;
  await scroll(page, 950);
  expect((await header.boundingBox())!.y).toBeCloseTo(before.y, 0);
  expect((await summary.boundingBox())!.y).toBeLessThan(summaryBefore.y - 100);
  await expectBelowShell(page);
  await expect(header.getByLabel('Sök i kön')).toBeVisible();
  await expect(header.getByLabel('Filtrera status')).toBeVisible();
  await expect(header.getByRole('tab', { name: 'Historik', exact: true })).toBeVisible();
});

test('customer overview fixes search and main actions while customer detail retains back and tabs', async ({ page }) => {
  const { data } = await fixture(page);
  await page.goto('/kontor#/customers');
  await expect(page.getByRole('heading', { name: 'Kunder', exact: true })).toBeVisible();
  await scroll(page, 500);
  await expectBelowShell(page);
  const header = page.locator('.office-page-header');
  await expect(header.getByLabel('Sök kunder', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Skapa kund', exact: true })).toBeVisible();
  await page.goto(`/kontor#/customers/${data.customers[0].id}?tab=weighings`);
  await expect(header.getByRole('heading', { name: data.customers[0].name, exact: true })).toBeVisible();
  await scroll(page, 450);
  await expectBelowShell(page);
  await expect(header.getByRole('button', { name: 'Till kundlistan', exact: true })).toBeVisible();
  await expect(header.locator('.customer-tabs')).toBeVisible();
});

test('short narrow screen keeps a wrapped article title reachable without overlapping the shell, and print releases the header', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 620 });
  await fixture(page);
  await page.goto('/kontor#/prices');
  await page.getByRole('button', { name: 'Redigera Ett långt materialnamn som bryts på mindre skärmar', exact: true }).click();
  await scroll(page, 900);
  await expectBelowShell(page);
  const header = page.locator('.office-page-header');
  await expect(header.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Till artikelöversikten', exact: true })).toBeVisible();
  const box = (await header.boundingBox())!;
  expect(box.height).toBeLessThan(620 * 0.4);
  expect(620 - box.y - box.height).toBeGreaterThan(160);
  await page.emulateMedia({ media: 'print' });
  await expect(header).toHaveCSS('position', 'static');
  await expect(page.locator('.office-sticky-shell')).toBeHidden();
});

test('article overview preserves its own list scrolling and table heading without a second sticky header', async ({ page }) => {
  await fixture(page);
  await page.goto('/kontor#/prices');
  await expect(page.getByRole('heading', { name: 'Artiklar & priser', exact: true })).toBeVisible();
  const controls = [page.locator('.office-page-header'), page.getByLabel('Sök artikel', { exact: true }), page.locator('.office-pricing-table th').first()];
  const before = await Promise.all(controls.map(locator => locator.boundingBox()));
  const list = page.locator('.office-pricing-article-panel .office-pricing-table-wrap');
  await list.evaluate(element => { element.scrollTop = 1000; });
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(600);
  const after = await Promise.all(controls.map(locator => locator.boundingBox()));
  before.forEach((box, index) => expect(Math.abs(after[index]!.y - box!.y)).toBeLessThan(2));
  await expect(page.locator('.office-page-header')).toHaveCSS('position', 'static');
});

test('article opened from a group keeps the group breadcrumb and return action in the shared header', async ({ page }) => {
  const { pricing } = await fixture(page);
  await page.goto('/kontor#/prices?tab=article-groups');
  await page.getByRole('button', { name: `Öppna artikelgrupp ${pricing.groups![0].name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Redigera Ett långt materialnamn som bryts på mindre skärmar', exact: true }).click();
  await scroll(page, 700);
  await expectBelowShell(page);
  const header = page.locator('.office-page-header');
  await expect(header.getByRole('navigation', { name: 'Artikelns sökväg' })).toContainText('Artikelgrupper');
  await expect(page.getByRole('navigation', { name: 'Prisvyer' })).toHaveCount(0);
  await header.getByRole('button', { name: 'Till artikelgrupper', exact: true }).click();
  await expect(header.getByRole('heading', { name: 'Artikelgrupper', exact: true })).toBeVisible();
  await expect(header.getByLabel('Sök artikelgrupp')).toBeVisible();
});

test('weight card detail keeps back, title and primary document/payment actions while its panels scroll', async ({ page }) => {
  const { data } = await fixture(page);
  await page.goto(`/kontor#/payments/${data.cards[0].id}`);
  const header = page.locator('.office-page-header');
  await expect(header.getByRole('heading', { name: `Invägning #${data.cards[0].id}`, exact: true })).toBeVisible();
  await scroll(page, 700);
  await expectBelowShell(page);
  await expect(header.getByRole('button', { name: 'Till utbetalningar', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Avräkningsnota', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Registrera demoutbetalning', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/jeroc-sticky-desktop.png' });
});
