import { test, expect, type Page } from '@playwright/test';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});

test.describe.configure({ mode: 'serial' });

async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('heading', { name: 'Kontorsöversikt', exact: true }),
  ).toBeVisible();
}

test('Jobba som använder Annas attestgräns och sparar båda personerna i spårbarheten', async ({
  page,
}) => {
  await login(page, 'Systemadmin');
  await page.getByLabel('Jobba som', { exact: true }).selectOption('anna');
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.office-sidebar')
      .getByRole('button', { name: 'Användare', exact: true }),
  ).toHaveCount(0);

  await page.goto('/kontor#/weighings/2040');
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/överstiger din attestgräns/)).toBeVisible();

  await page.goto('/kontor#/lme');
  await expect(
    page.getByRole('heading', { name: 'Behörighet saknas', exact: true }),
  ).toBeVisible();
  const visiblePrices = await page.request.get('/api/pricing/state', {
    headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'anna' },
  });
  // Anna can read article prices, but cannot bypass her rights to change LME.
  expect(visiblePrices.ok()).toBeTruthy();
  const visibleState = await visiblePrices.json();
  expect(visibleState.lme).toEqual([]);
  expect(
    visibleState.articles.every(
      (article: { baseSekKg: number | null }) => article.baseSekKg === null,
    ),
  ).toBeTruthy();
  const writeDenied = await page.request.post('/api/pricing/lme', {
    headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'anna' },
    data: {
      metal: 'copper',
      cashUsdPerTonne: 999999,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
  });
  expect(writeDenied.status()).toBe(403);

  await page.goto('/kontor#/weighings/2039');
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(page.locator('.office-audit')).toContainText('Systemadmin');
  await expect(page.locator('.office-audit')).toContainText('Anna Nilsson');
  await page.reload();
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Avsluta Jobba som', exact: true })
    .click();
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.office-sidebar')
      .getByRole('button', { name: 'Användare', exact: true }),
  ).toBeVisible();
});

test('LME kan läsas av Kajsa men redigeringsformuläret och serverändringar är spärrade', async ({
  page,
}) => {
  await login(page, 'Kajsa Nilsson');
  await page.goto('/kontor#/lme');
  await expect(
    page.getByRole('heading', { name: 'LME Cash', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Koppar', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Spara Cash-pris', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Cash (USD/ton)', { exact: true })).toHaveCount(
    0,
  );

  const denied = await page.request.post('/api/pricing/lme', {
    headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' },
    data: {
      metal: 'copper',
      cashUsdPerTonne: 999999,
      usdSek: 10,
      effectiveFrom: '2026-10-07',
    },
  });
  expect(denied.status()).toBe(403);
});

test('manuellt Cash-pris räknar om artikelns förhandsvisning och lämnar attesterad vägning låst', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await page.goto('/kontor#/weighings/2041');
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (card: { id: number }) => card.id === 2041,
    ),
  );
  await expect(
    page.getByRole('button', { name: 'Ändra pris', exact: true }),
  ).toHaveCount(0);

  await page.goto('/kontor#/lme');
  const cash = page.getByLabel('Cash (USD/ton)', { exact: true });
  await expect(cash).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Metall', exact: true })
    .selectOption('copper');
  const previousCash = Number(await cash.inputValue());
  const previousUsdSek = Number(
    await page.getByLabel('USD/SEK', { exact: true }).inputValue(),
  );

  try {
    await cash.fill('11000');
    await page.getByLabel('USD/SEK', { exact: true }).fill('10');
    await page.getByLabel('Gäller från', { exact: true }).fill('2026-10-07');
    await page
      .getByLabel('Anteckning', { exact: true })
      .fill('Kontrollerad manuell Cash-kurs');
    await page
      .getByRole('button', { name: 'Spara Cash-pris', exact: true })
      .click();
    await expect(page.getByRole('status').first()).toContainText(
      /sparat|sparad|uppdaterat|uppdaterad/i,
    );

    await page.goto('/kontor#/prices');
    await expect(
      page.getByRole('row').filter({ hasText: 'Koppar klass 1' }).first(),
    ).toContainText('90,20');
    await page
      .getByRole('button', { name: 'Redigera Koppar klass 1', exact: true })
      .click();
    await page
      .getByLabel('Reglerna gäller från', { exact: true })
      .fill('2026-10-07');
    await expect(
      page.getByRole('heading', { name: 'Prisförhandsvisning', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/90,20/).first()).toBeVisible();

    await page.goto('/kontor#/weighings/2041');
    await page.reload();
    await expect(page.locator('.office-title')).toContainText(
      'Klar för utbetalning',
    );
    await expect(
      page.getByRole('button', { name: 'Ändra pris', exact: true }),
    ).toHaveCount(0);
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
        (card: { id: number }) => card.id === 2041,
      ),
    );
    expect(saved).toEqual(original);
  } finally {
    const restored = await page.request.post('/api/pricing/lme', {
      headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' },
      data: {
        metal: 'copper',
        cashUsdPerTonne: previousCash,
        usdSek: previousUsdSek,
        effectiveFrom: '2026-10-07',
        note: 'Återställt efter kontroll av gränssnittet',
      },
    });
    expect(restored.ok()).toBeTruthy();
  }
});

test('kontorist utan kundprisbehörighet kan förbereda ett kort med dolda volymuppgifter', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  const originalUsersResponse = await page.request.get('/api/pricing/state', {
    headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' },
  });
  expect(originalUsersResponse.ok()).toBeTruthy();
  const originalUsers = (await originalUsersResponse.json()).users;

  try {
    await page.goto('/kontor#/users');
    await page.getByLabel('Se kundpriser', { exact: true }).uncheck();
    await page
      .getByRole('button', { name: 'Spara behörigheter', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText(
      'Behörigheterna har sparats',
    );
    await page
      .getByRole('button', { name: 'Byt demokonto', exact: true })
      .click();
    await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
    await page.goto('/kontor#/weighings/1418');
    await page
      .getByLabel('Kund på vägningen', { exact: true })
      .selectOption('customer-brf');
    await expect(
      page.getByLabel('Kund på vägningen', { exact: true }),
    ).toHaveValue('customer-brf');
    await expect(
      page.getByText('Kundprisbehörighet krävs', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Verifiera ID', exact: true })
      .click();
    await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await page.getByRole('button', { name: /Skicka för attest/ }).click();
    await expect(page.getByRole('status')).toContainText('väntar nu på attest');
    const saved = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
        (card: { id: number }) => card.id === 1418,
      ),
    );
    expect(saved).toMatchObject({
      status: 'attest',
      customerId: 'customer-brf',
    });
    expect(saved.rows[0].volumeBefore).toBeUndefined();
    expect(saved.rows[0].volumeWithDelivery).toBeUndefined();
  } finally {
    const restored = await page.request.post('/api/pricing/users', {
      headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' },
      data: { users: originalUsers },
    });
    expect(restored.ok()).toBeTruthy();
  }
});
