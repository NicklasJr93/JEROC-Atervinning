import { expect, test } from '@playwright/test';

test('mobilens sparningar skickar bara ändrade poster och kundpriser hämtas först när kunden visas i prislistan', async ({ page }) => {
  const writes: Record<string, unknown>[] = [], reads: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/application/mobile') {
      if (request.method() === 'POST') writes.push(request.postDataJSON());
      else reads.push(url.search);
    }
  });
  const login = await page.request.post('/api/employee/login', { data: { username: 'niklas', password: 'Demo123!' } });
  expect(login.ok(), await login.text()).toBe(true);
  await page.goto('/mobil#/yard');
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  expect(reads.every(query => new URLSearchParams(query).get('prices') === 'none')).toBe(true);
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar klass 1' }).click();
  await page.getByRole('button', { name: 'Välj Koppar klass 1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('25');
  await page.getByRole('button', { name: /Färdigvägt/ }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('25 kg');
  await expect.poll(() => writes.filter(write => write.kind === 'records').length).toBeGreaterThan(1);
  for (const write of writes.filter(write => write.kind === 'records')) {
    expect(write.base).toBeUndefined(); expect(write.next).toBeUndefined();
    expect((write.drafts as unknown[]).length).toBeLessThanOrEqual(1);
    expect(write.customers).toEqual([]);
  }
  const priceResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/application/mobile-prices' && response.ok());
  await page.goto('/mobil#/prices?customer=customer-build');
  const result = await (await priceResponse).json();
  expect(Object.keys(result.customerPrices)).toEqual(['customer-build']);
  expect(result.catalog).toBeUndefined(); expect(result.data).toBeUndefined();
  const quote = result.customerPrices['customer-build']['copper-1'];
  await expect(page.getByRole('button', { name: 'Visa priser för Koppar klass 1', exact: true }).locator('.customer-price-value strong'))
    .toHaveText(new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(quote.price));
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Ta bort vald kund', exact: true }).click();
  await page.getByRole('button', { name: 'Lägg till kund', exact: true }).click();
  await page.locator('.customer-choice').filter({ hasText: 'Bygg & Riv AB' }).click();
  await expect(page.getByRole('button', { name: 'Visa priser för Koppar klass 1', exact: true }).locator('.customer-price-value strong'))
    .toHaveText(new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(quote.price));
});
