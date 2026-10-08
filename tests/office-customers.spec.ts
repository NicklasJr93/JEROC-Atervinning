import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { customerStats } from '../src/office/customer-model';

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

async function openBuildCustomer(page: Page, tab = 'overview') {
  await page.goto(`/kontor#/customers/customer-build?tab=${tab}`);
  await expect(
    page.getByRole('heading', { name: 'Bygg & Riv AB', exact: true }),
  ).toBeVisible();
}

test('kundregistret kan sökas på registreringsnummer och alla fem flikar behåller kundmenyn', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await page.goto('/kontor#/customers');
  await page.getByLabel('Sök kunder', { exact: true }).fill('ABC123');
  const list = page.locator('.office-main');
  await expect(
    list.getByText('Bygg & Riv AB', { exact: true }).first(),
  ).toBeVisible();
  await expect(list.getByText('Erik Johansson', { exact: true })).toHaveCount(
    0,
  );
  await openBuildCustomer(page);
  for (const name of [
    'Översikt',
    'Vägningar',
    'Priser',
    'Uppgifter & betalning',
    'Rättelser & saldo',
  ]) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page
        .locator('.office-sidebar')
        .getByRole('button', { name: 'Kunder', exact: true }),
    ).toHaveClass(/active/);
    await expect(
      page.getByRole('heading', { name: 'Bygg & Riv AB', exact: true }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Rättelser & saldo', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('nya kunder och ändrade kontaktuppgifter sparas vid omladdning', async ({
  page,
}) => {
  await login(page, 'Kajsa Nilsson');
  await page.goto('/kontor#/customers');
  await page.getByRole('button', { name: 'Skapa kund', exact: true }).click();
  await page.getByLabel('Kundtyp', { exact: true }).selectOption('Företag');
  await page.getByLabel('Namn', { exact: true }).fill('Regression Återbruk AB');
  await page
    .getByLabel('Organisations-/personnummer', { exact: true })
    .fill('559911-8899');
  await page.getByLabel('Telefon', { exact: true }).fill('0701234567');
  await page.getByLabel('E-post', { exact: true }).fill('kontor@example.test');
  await page.getByLabel('Adress', { exact: true }).fill('Testgatan 12');
  await page.getByLabel('Postnummer', { exact: true }).fill('76130');
  await page.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await page
    .getByRole('button', { name: 'Spara kunduppgifter', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Regression Återbruk AB', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('tab', { name: 'Uppgifter & betalning', exact: true })
    .click();
  await expect(page.getByLabel('Adress', { exact: true })).toHaveValue(
    'Testgatan 12',
  );
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue(
    '0701234567',
  );
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Kajsa Test');
  await page
    .getByRole('button', { name: 'Spara kunduppgifter', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Kunduppgifterna är sparade.' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue(
    'Kajsa Test',
  );
  const customer = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).customers.find(
      (entry: { name: string }) => entry.name === 'Regression Återbruk AB',
    ),
  );
  expect(customer).toMatchObject({
    type: 'Företag',
    number: '559911-8899',
    contactPerson: 'Kajsa Test',
  });
  expect(customer.audit.length).toBeGreaterThan(0);
});

test('sparad Swishprofil fylls på ett nytt kort utan att skriva om redan attesterade kort', async ({
  page,
}) => {
  await login(page, 'Kajsa Nilsson');
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (entry: { id: number }) => entry.id === 2041,
    ),
  );
  await openBuildCustomer(page, 'details');
  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('0701234567');
  await page.getByLabel('Mottagare', { exact: true }).fill('Bygg & Riv AB');
  await page
    .getByRole('button', { name: 'Spara betalningsprofil', exact: true })
    .click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Betalningsuppgifterna är sparade.' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue(
    '0701234567',
  );
  await page.goto('/kontor#/weighings/1412');
  await page
    .getByLabel('Kund på vägningen', { exact: true })
    .selectOption('customer-build');
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue(
    '0701234567',
  );
  await expect(page.getByLabel('Mottagare', { exact: true })).toHaveValue(
    'Bygg & Riv AB',
  );
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (entry: { id: number }) => entry.id === 2041,
    ),
  );
  expect(after).toEqual(original);
});

test('betalningsmetoder bevarar inmatning och validerar bara den valda metoden', async ({
  page,
}) => {
  await login(page, 'Kajsa Nilsson');
  await page.goto('/kontor#/weighings/1412');
  await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('1234567890');
  await page.getByLabel('Kontohavare', { exact: true }).fill('Testkund');
  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('123');
  await page.getByLabel('Mottagare', { exact: true }).fill('Testkund');
  await page
    .getByRole('button', { name: 'Spara betalningsuppgift', exact: true })
    .click();
  await expect(
    page.getByLabel('Telefonnummer', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
  await expect(page.getByLabel('Clearingnummer', { exact: true })).toHaveValue(
    '8327',
  );
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveValue(
    '1234567890',
  );
  await page
    .getByRole('button', { name: 'Spara betalningsuppgift', exact: true })
    .click();
  const payment = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
        (entry: { id: number }) => entry.id === 1412,
      ).paymentDetails,
  );
  expect(payment).toMatchObject({
    method: 'bank',
    clearing: '8327',
    account: '1234567890',
    holder: 'Testkund',
  });
  await page.getByRole('button', { name: 'Kontant', exact: true }).click();
  await expect(page.getByLabel('Clearingnummer', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole('button', { name: 'Spara betalningsuppgift', exact: true })
    .click();
  const cash = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
        (entry: { id: number }) => entry.id === 1412,
      ).paymentDetails,
  );
  expect(cash.method).toBe('cash');
});

test('kundkort utan pris- eller betalningsbehörighet visar inte ekonomiska uppgifter eller ändringsformulär', async ({
  page,
}) => {
  const fixture = seedOffice();
  fixture.users.find((user) => user.id === 'kajsa')!.permissions = ['view'];
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await login(page, 'Kajsa Nilsson');
  await openBuildCustomer(page, 'prices');
  await expect(
    page.getByRole('button', { name: /Spara kundpris|Lägg till kundpris/ }),
  ).toHaveCount(0);
  await expect(page.getByText('84,00', { exact: false })).toHaveCount(0);
  await page
    .getByRole('tab', { name: 'Uppgifter & betalning', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Spara betalningsprofil', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
});

test('spara på saldo efter attest skapar ingen utbetalning och senare kontantutbetalning registreras separat', async ({
  page,
}) => {
  const fixture = seedOffice();
  const card = fixture.cards.find((entry) => entry.id === 1418)!;
  Object.assign(card, {
    status: 'attest',
    idVerified: true,
    preparedBy: 'kajsa',
    payment: 'Spara på saldo',
    paymentDetails: { method: 'balance' },
  });
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await login(page, 'Anna Nilsson');
  await page.goto('/kontor#/attest/1418');
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText('Sparat på saldo');
  const held = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(held.payments).toEqual([]);
  expect(
    held.cards.find((entry: { id: number }) => entry.id === 1418).status,
  ).toBe('balance');
  await page
    .locator('.office-sidebar')
    .getByRole('button', { name: 'Utbetalningar', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Öppna viktkort 1418', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await page
    .getByRole('button', { name: 'Öppna viktkort 1418', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Betala ut från saldo', exact: true })
    .click();
  await page.getByRole('button', { name: 'Kontant', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page
    .getByRole('button', { name: 'Registrera utbetalning', exact: true })
    .click();
  await expect(page.locator('.office-title')).toContainText('Demoutbetald');
  const paid = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(paid.payments).toHaveLength(1);
  expect(paid.payments[0]).toMatchObject({ cardId: 1418, method: 'cash' });
  expect(
    paid.cards.find((entry: { id: number }) => entry.id === 1418)
      .paymentDetails,
  ).toEqual({ method: 'balance' });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Betala ut från saldo', exact: true }),
  ).toHaveCount(0);
});

test('rättelser går via granskning till kundens saldo och pluskort utan att det betalda originalet ändras', async ({
  page,
}) => {
  await login(page, 'Lars Andersson');
  await page.goto('/kontor#/payments/2038?tab=history');
  const original = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (card: { id: number }) => card.id === 2038,
    ),
  );

  async function createAndApprove(delta: string, document: string) {
    await page.goto('/kontor#/payments/2038?tab=history');
    await page.getByLabel('Viktändring, kg', { exact: true }).fill(delta);
    await page
      .getByLabel('Orsak / rättelseunderlag', { exact: true })
      .fill('Kontrollerad felregistrering');
    await page.getByLabel('Rättelseunderlag', { exact: true }).fill(document);
    await page
      .getByRole('button', { name: 'Skapa rättelseutkast', exact: true })
      .click();
    const row = page.getByRole('row').filter({ hasText: document });
    await expect(row).toContainText('Utkast');
    await row
      .getByRole('button', { name: 'Skicka rättelse för attest', exact: true })
      .click();
    await expect(row).toContainText('Väntar på attest');
    await row
      .getByRole('button', { name: 'Godkänn rättelse', exact: true })
      .click();
    await expect
      .poll(async () =>
        page.evaluate(
          (reference) =>
            JSON.parse(
              localStorage.getItem('jeroc.office.demo.v1')!,
            ).corrections.find(
              (correction: { document: string }) =>
                correction.document === reference,
            )?.status,
          document,
        ),
      )
      .toBe('approved');
  }

  await createAndApprove('-10', 'RU-TEST-MINUS');
  await page.goto('/kontor#/customers/customer-erik?tab=balance');
  await expect(
    page.getByRole('heading', { name: 'Erik Johansson', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Rättelse R-1' }),
  ).toContainText(/[-−]19,20/);
  let saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(saved.cards.find((card: { id: number }) => card.id === 2038)).toEqual(
    original,
  );
  expect(
    customerStats(saved, 'customer-erik', '2026-10-08T12:00:00Z'),
  ).toMatchObject({ totalKg: 114, totalValue: 218.88 });

  await createAndApprove('5', 'RU-TEST-PLUS');
  saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  const correction = saved.corrections.find(
    (entry: { document: string }) => entry.document === 'RU-TEST-PLUS',
  );
  const child = saved.cards.find(
    (card: { sourceCorrectionId?: number }) =>
      card.sourceCorrectionId === correction.id,
  );
  expect(child).toMatchObject({
    status: 'ready',
    kind: 'correction',
    customerId: 'customer-erik',
    pricingTotal: 9.6,
  });
  expect(saved.cards.find((card: { id: number }) => card.id === 2038)).toEqual(
    original,
  );
  expect(
    customerStats(saved, 'customer-erik', '2026-10-08T12:00:00Z'),
  ).toMatchObject({
    totalKg: 119,
    totalValue: 228.48,
    weighingCount: 1,
    balance: -9.6,
  });
  await page.goto('/kontor#/customers/customer-erik?tab=balance');
  await page.getByRole('button', { name: /R-2 · Järnskrot/ }).click();
  await page
    .getByRole('button', { name: 'Öppna utbetalningskort', exact: true })
    .click();
  await expect(page.locator('.office-title')).toContainText(
    `Invägning #${child.id}`,
  );
  await expect(
    page
      .locator('.office-sidebar')
      .getByRole('button', { name: 'Utbetalningar', exact: true }),
  ).toHaveClass(/active/);
});
