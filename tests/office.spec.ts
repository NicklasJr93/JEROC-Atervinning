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
async function changeUser(page: Page, name: string) {
  await page.getByRole('button', { name: 'Byt demokonto' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('kontorets granskning, prishistorik, attest och demoutbetalning fungerar utan externa överföringar', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') external.push(r.url());
  });
  await login(page, 'Kajsa Nilsson');
  await page
    .getByRole('button', { name: 'Öppna viktkort 1412', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: /Skicka för attest/ }),
  ).toBeDisabled();
  await page.getByLabel('Kund på vägningen').selectOption('customer-build');
  await page
    .getByLabel('Betalningsuppgift (demo)', { exact: true })
    .fill('Bankkonto · demo 8327 / ****7890');
  await page.getByRole('button', { name: 'Spara betalningsuppgift' }).click();
  await page.getByRole('button', { name: 'Verifiera ID', exact: true }).click();
  await page
    .getByRole('button', { name: 'Ändra pris', exact: true })
    .first()
    .click();
  await page.getByLabel('Prisalternativ').selectOption('Eget');
  await page.getByLabel('Engångspris kr/kg').fill('80');
  await page.getByRole('button', { name: 'Spara pris', exact: true }).click();
  await expect(page.locator('.office-audit').first()).toContainText(
    'ändrat från A 82,00 till Eget 80,00',
  );
  await page.getByRole('button', { name: /Skicka för attest/ }).click();
  await expect(page.getByRole('status')).toContainText('väntar nu på attest');
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toHaveCount(0);
  await changeUser(page, 'Anna Nilsson');
  await page
    .getByRole('button', { name: 'Öppna viktkort 1412', exact: true })
    .click();
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(
    page.getByRole('button', { name: 'Ändra pris', exact: true }),
  ).toHaveCount(0);
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('button', { name: 'Registrera demoutbetalning', exact: true })
    .click();
  await expect(page.locator('.office-title')).toContainText('Demoutbetald');
  await page.reload();
  await expect(page.locator('.office-title')).toContainText('Demoutbetald');
  expect(external).toEqual([]);
});

test('attestgräns stoppar ekonomi, VD får attestera och får inte ändra systemadmin', async ({
  page,
}) => {
  await login(page, 'Anna Nilsson');
  await page
    .getByRole('button', { name: 'Öppna viktkort 2040', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.office-alert')).toContainText(
    'överstiger din attestgräns',
  );
  await page.goto('/kontor#/users');
  await expect(
    page.getByRole('heading', { name: 'Behörighet saknas' }),
  ).toBeVisible();
  await changeUser(page, 'Lars Andersson');
  await page
    .getByRole('button', { name: 'Öppna viktkort 2040', exact: true })
    .click();
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await page
    .locator('.office-sidebar')
    .getByRole('button', { name: 'Användare', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Systemadmin Systemadmin', exact: true })
    .click();
  await expect(page.getByLabel('Namn', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Spara behörigheter', exact: true }),
  ).toBeDisabled();
});

test('behörigheter och egen attest styrs av VD och rättelseutkast bevarar låst original', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await page
    .locator('.office-sidebar')
    .getByRole('button', { name: 'Användare', exact: true })
    .click();
  await page.getByLabel('Attestera', { exact: true }).check();
  await page
    .getByLabel('Maxbelopp för attest (kr)', { exact: true })
    .fill('100000');
  await page
    .getByRole('button', { name: 'Spara behörigheter', exact: true })
    .click();
  await changeUser(page, 'Kajsa Nilsson');
  await page
    .getByRole('button', { name: 'Öppna viktkort 2039', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Du får inte attestera ett kort du själv förberett.'),
  ).toBeVisible();
  await page.goto('/kontor#/weighings/2041');
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (c: { id: number }) => c.id === 2041,
    ),
  );
  await page.getByLabel('Viktändring, kg', { exact: true }).fill('-100');
  await page
    .getByLabel('Orsak / rättelseunderlag', { exact: true })
    .fill('Fel vikt · underlag Y');
  await page
    .getByRole('button', { name: 'Skapa rättelseutkast', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Rättelseutkast', exact: true }),
  ).toBeVisible();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(saved.cards.find((c: { id: number }) => c.id === 2041)).toEqual(
    original,
  );
  expect(saved.corrections[0]).toMatchObject({
    cardId: 2041,
    customerId: 'customer-build',
    weightDelta: -100,
  });
});
