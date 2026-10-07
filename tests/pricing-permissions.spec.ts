import { test, expect } from '@playwright/test';
import { seedOffice } from '../src/office/model';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});
test.describe.configure({ mode: 'serial' });

test('dolt kundpris låses till serverns 84 kr och ekonomi ser rätt belopp före attest', async ({
  page,
}) => {
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const before = await page.request.get('/api/pricing/state', { headers });
  expect(before.ok()).toBeTruthy();
  const originalUsers = (await before.json()).users;
  const preparer = {
    id: 'hidden-price-preparer',
    name: 'Kontorist utan kundpriser',
    level: 'Medarbetare' as const,
    permissions: [
      'view',
      'prepare',
      'customers',
      'prices',
      'priceA',
      'priceB',
      'priceC',
      'verifyId',
      'paymentDetails',
    ] as const,
    maxAttest: 0,
    ownAttest: false,
  };
  const users = [...originalUsers, preparer];
  const configured = await page.request.post('/api/pricing/users', {
    headers,
    data: { users },
  });
  expect(configured.ok()).toBeTruthy();
  const fixture = seedOffice();
  fixture.users = users;
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  try {
    await page.goto('/kontor');
    await page
      .getByRole('button', { name: /Kontorist utan kundpriser/ })
      .click();
    await page.goto('/kontor#/weighings/1418');
    await page
      .getByLabel('Kund på vägningen', { exact: true })
      .selectOption('customer-build');
    await expect(
      page.getByLabel('Kund på vägningen', { exact: true }),
    ).toHaveValue('customer-build');
    await expect(page.getByText('Dolt pris', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Verifiera ID', exact: true })
      .click();
    await page.getByRole('button', { name: /Skicka för attest/ }).click();
    await expect(page.getByRole('status')).toContainText('väntar nu på attest');

    const authoritative = await page.request.get(
      '/api/pricing/snapshots?cardId=1418',
      { headers },
    );
    expect(authoritative.ok()).toBeTruthy();
    const latest = (await authoritative.json()).snapshots.at(-1);
    expect(latest.rows[0].price).toBe(84);
    expect(latest.total).toBe(6048);

    await page
      .getByRole('button', { name: 'Byt demokonto', exact: true })
      .click();
    await page.getByRole('button', { name: /Anna Nilsson/ }).click();
    await page.goto('/kontor#/weighings/1418');
    await expect(page.locator('.office-table tbody tr').first()).toContainText(
      '84,00',
    );
    await expect(page.locator('.office-total')).toContainText('6 048,00');
    await page.getByRole('button', { name: 'Attestera', exact: true }).click();
    await expect(page.locator('.office-title')).toContainText(
      'Klar för utbetalning',
    );
    await expect(page.locator('.office-total')).toContainText('6 048,00');
  } finally {
    const restored = await page.request.post('/api/pricing/users', {
      headers,
      data: { users: originalUsers },
    });
    expect(restored.ok()).toBeTruthy();
  }
});

test('kundprisets kalkylator använder vald kund och datumets historiska bas', async ({
  page,
}) => {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Lars Andersson/ }).click();
  await page.goto('/kontor#/prices?tab=customer-prices');
  await page
    .getByLabel('Filtrera kundpriser', { exact: true })
    .selectOption('customer-build');
  const calculator = page
    .locator('.office-panel')
    .filter({
      has: page.getByRole('heading', {
        name: 'Prova kundens pris',
        exact: true,
      }),
    });
  await expect(
    calculator.getByRole('combobox', { name: 'Kund', exact: true }),
  ).toHaveValue('customer-build');
  await calculator
    .getByRole('button', { name: 'Beräkna kundpris', exact: true })
    .click();
  await expect(calculator).toContainText('Kundens specialpris');
  await expect(calculator).toContainText('84,00 kr/kg');

  await page
    .getByRole('combobox', { name: 'Typ av specialpris', exact: true })
    .selectOption('tier-adjustment');
  await page
    .getByLabel('Kundregeln gäller från', { exact: true })
    .fill('2026-06-15');
  // June's copper base: 10 250 USD/t × 9.9 / 1 000; A = 82% plus 2 kr.
  await expect(page.locator('.office-pricing-conversion')).toContainText(
    '85,21',
  );
  await page
    .getByLabel('Kundregeln gäller från', { exact: true })
    .fill('2026-07-15');
  // July's base and currency differ; a current-date preview would miss this.
  await expect(page.locator('.office-pricing-conversion')).toContainText(
    '85,23',
  );
});
