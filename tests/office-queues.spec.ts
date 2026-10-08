import { test, expect, type Page } from '@playwright/test';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});

async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('heading', { name: 'Kontorsöversikt', exact: true }),
  ).toBeVisible();
}

function menu(page: Page, name: string) {
  return page
    .locator('.office-sidebar')
    .getByRole('button', { name: new RegExp(`^${name}(?: \\d+)?$`) });
}

async function expectQueue(page: Page, present: number[], absent: number[]) {
  for (const id of present)
    await expect(
      page
        .getByRole('button', { name: `Öppna viktkort ${id}`, exact: true })
        .first(),
    ).toBeVisible();
  for (const id of absent)
    await expect(
      page.getByRole('button', { name: `Öppna viktkort ${id}`, exact: true }),
    ).toHaveCount(0);
}

test('arbetsköerna visar bara sina aktiva kort och kortdetaljer behåller rätt huvudmeny', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await menu(page, 'Invägningar').click();
  await expectQueue(page, [1412, 1416, 1418], [2039, 2040, 2041, 2038]);

  await menu(page, 'Attest').click();
  await expectQueue(page, [2039, 2040], [1412, 1416, 1418, 2041, 2038]);
  await page
    .getByRole('button', { name: 'Öppna viktkort 2039', exact: true })
    .click();
  await expect(menu(page, 'Attest')).toHaveClass(/active/);
  await expect(menu(page, 'Invägningar')).not.toHaveClass(/active/);
  await page.getByRole('button', { name: 'Till attest', exact: true }).click();
  await expectQueue(page, [2039, 2040], [2041]);

  await menu(page, 'Utbetalningar').click();
  await expectQueue(page, [2041], [1412, 2039, 2040, 2038]);
  await page
    .getByRole('button', { name: 'Öppna viktkort 2041', exact: true })
    .click();
  await expect(menu(page, 'Utbetalningar')).toHaveClass(/active/);
  await expect(menu(page, 'Invägningar')).not.toHaveClass(/active/);
  await page
    .getByRole('button', { name: 'Till utbetalningar', exact: true })
    .click();
  await expectQueue(page, [2041], [2039]);
});

test('attest flyttar kortet till utbetalningskön och kontorets historik visar spårbar status utan extra rättigheter', async ({
  page,
}) => {
  await login(page, 'Anna Nilsson');
  await menu(page, 'Attest').click();
  await page
    .getByRole('button', { name: 'Öppna viktkort 2039', exact: true })
    .click();
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(menu(page, 'Utbetalningar')).toHaveClass(/active/);
  await menu(page, 'Attest').click();
  await expectQueue(page, [2040], [2039]);
  await menu(page, 'Utbetalningar').click();
  await expectQueue(page, [2039, 2041], [2040]);

  await page
    .getByRole('button', { name: 'Byt demokonto', exact: true })
    .click();
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await menu(page, 'Invägningar').click();
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await expectQueue(page, [2039, 2038], []);
  await page
    .getByRole('button', { name: 'Öppna viktkort 2039', exact: true })
    .click();
  await expect(menu(page, 'Invägningar')).toHaveClass(/active/);
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(page.locator('.office-audit')).toContainText('Anna Nilsson');
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Registrera demoutbetalning',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Ändra pris', exact: true }),
  ).toHaveCount(0);
});

test('historikens filter bevaras när ett kort öppnas och återbesöks', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await menu(page, 'Utbetalningar').click();
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await expectQueue(page, [2038], [2039, 2041]);
  await page
    .getByLabel('Filtrera status', { exact: true })
    .selectOption('paid');
  await page.getByLabel('Sök i kön', { exact: true }).fill('2038');
  const before = page.url();
  await page
    .getByRole('button', { name: 'Öppna viktkort 2038', exact: true })
    .click();
  await expect(menu(page, 'Utbetalningar')).toHaveClass(/active/);
  await page
    .getByRole('button', { name: 'Till utbetalningar', exact: true })
    .click();
  await expect(page).toHaveURL(before);
  await expect(page.getByLabel('Filtrera status', { exact: true })).toHaveValue(
    'paid',
  );
  await expect(page.getByLabel('Sök i kön', { exact: true })).toHaveValue(
    '2038',
  );
  await expect(
    page.getByRole('tab', { name: 'Historik', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expectQueue(page, [2038], [2041]);
});
