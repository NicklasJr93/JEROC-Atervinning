import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { PriceArticle, PricingState } from '../src/office/pricing-client';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };

test('article editor defaults to review and persists the accountant category in history and mobile catalog', async ({ page, request }) => {
  const name = `Momsklassificering ${randomUUID().slice(0, 8)}`;
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto('/kontor#/prices');
  await page.getByRole('button', { name: 'Ny artikel', exact: true }).click();
  const category = page.getByLabel('Momshantering vid inköp', { exact: true });
  await expect(category).toHaveValue('review');
  await expect(page.locator('.office-pricing-tax-panel')).toContainText('Ekonomi behöver bedöma');
  await page.getByLabel('Artikelnamn', { exact: true }).fill(name);
  await category.selectOption('standard_25');
  await page.getByRole('button', { name: 'Spara artikel', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Artiklar & priser', exact: true })).toBeVisible();
  const stateResponse = await request.get('/api/pricing/state', { headers: admin });
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json() as PricingState;
  const article = state.articles.find(item => item.name === name)!;
  expect(article.taxCategory).toBe('standard_25');
  expect(state.articleHistory?.find(item => item.id === article.id)?.taxCategory).toBe('standard_25');
  await page.getByLabel('Sök artikel', { exact: true }).fill(name);
  await page.getByRole('button', { name: `Redigera ${name}`, exact: true }).click();
  await expect(category).toHaveValue('standard_25');
  await page.getByText(/Artikelhistorik \(/).click();
  await expect(page.locator('.office-pricing-history')).toContainText('Vanlig moms, 25 %');
  const mobileResponse = await request.get('/api/application/mobile', { headers: { 'X-Demo-Mobile': 'niklas' } });
  expect(mobileResponse.ok()).toBeTruthy();
  const mobile = await mobileResponse.json() as { catalog: PriceArticle[] };
  expect(mobile.catalog.find(item => item.id === article.id)?.taxCategory).toBe('standard_25');
});
