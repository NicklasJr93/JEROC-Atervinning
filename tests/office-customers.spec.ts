import { test, expect, type Page } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { seedOffice, type OfficeCard, type OfficeData } from '../src/office/model';
import { customerStats } from '../src/office/customer-model';
import type { TerminalApproval } from '../src/office/terminal-demo-types';

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

function completedTestCard(data: OfficeData, id: number, customerId = 'customer-erik'): OfficeCard {
  const customer = data.customers.find((entry) => entry.id === customerId)!;
  return {
    ...structuredClone(data.cards.find((card) => card.id === 2052)!),
    id, sourceId: randomUUID(), customerId, customerSnapshot: structuredClone(customer),
    date: '2026-10-07T08:41:00Z', status: 'paid',
    idVerified: true, preparedBy: 'kajsa', approvedBy: 'anna', paidAt: '2026-10-07T09:05:00Z',
    payment: 'Kontant', paymentDetails: { method: 'cash' },
    rows: [{ articleId: 'iron', weight: 124, tier: 'C', price: 1.92 }],
    customerApproval: {
      id: `completed-test-${id}`, version: 1, status: 'attested',
      updatedAt: '2026-10-07T09:00:00Z',
      approvedBy: 'Kajsa Nilsson', approvedAt: '2026-10-07T08:50:00Z',
      attestedBy: 'Anna Nilsson', attestedAt: '2026-10-07T09:00:00Z',
    },
    audit: [],
  };
}

async function approveBalanceTestCard(page: Page, data: OfficeData) {
  const password = 'TerminalDemo123!';
  const username = `balance-${randomUUID().slice(0, 8)}`;
  const staff = async (id: string) => expect((await page.request.post('/api/terminal-demo/staff-session', {
    data: { actualUserId: id, effectiveUserId: id },
  })).ok()).toBeTruthy();
  await staff('admin');
  const created = await page.request.post('/api/terminal-demo/terminals', {
    data: { name: username, username, password, siteId: 'norrtalje' },
  });
  expect(created.ok()).toBeTruthy();
  const terminal = await created.json();
  expect((await page.request.post('/api/terminal-demo/login', { data: { username, password } })).ok()).toBeTruthy();
  await staff('kajsa');
  const customer = {
    ...structuredClone(data.customers.find((item) => item.id === 'customer-erik')!),
    id: `balance-customer-${randomUUID()}`,
  };
  data.customers.push(customer);
  expect((await page.request.post('/api/pricing/customers', {
    headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' },
    data: { id: customer.id, name: customer.name },
  })).ok()).toBeTruthy();
  const card: OfficeCard = {
    ...structuredClone(data.cards.find((item) => item.id === 2053)!),
    id: 48_000_000 + randomInt(1_000_000), sourceId: randomUUID(), customerId: customer.id,
    origin: 'Testgatan 12, Norrtälje', payment: 'Spara på saldo',
    paymentDetails: { method: 'balance' },
  };
  const frozen = await page.request.post('/api/pricing/snapshots', {
    headers: { 'X-Demo-Actor': 'kajsa', 'X-Demo-User': 'kajsa' },
    data: {
      cardId: String(card.id), customerId: customer.id, deliveredAt: card.date,
      rows: card.rows.map((row) => ({ articleId: row.articleId, weight: row.weight, override: { price: row.price, tier: row.tier, reason: 'Kontrollerat saldo-test' } })),
    },
  });
  expect(frozen.ok()).toBeTruthy();
  const snapshot = await frozen.json();
  card.pricingSnapshotId = snapshot.id;
  const sent = await page.request.post('/api/terminal-demo/approvals', {
    data: {
      card, customer, terminalId: terminal.id, siteId: 'norrtalje',
      rows: card.rows.map((row) => ({ articleId: row.articleId, name: 'Koppar klass 1', weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
      offset: 0, correctionIds: [], idempotencyKey: `balance-${randomUUID()}`,
    },
  });
  expect(sent.ok()).toBeTruthy();
  const approval = await sent.json() as TerminalApproval;
  expect((await page.request.post(`/api/terminal-demo/approvals/${approval.id}/respond`, {
    data: { action: 'id_requested', termsAccepted: true },
  })).ok()).toBeTruthy();
  const approvedResponse = await page.request.post(`/api/terminal-demo/approvals/${approval.id}/confirm-id`, { data: {} });
  expect(approvedResponse.ok()).toBeTruthy();
  const approved = await approvedResponse.json() as TerminalApproval;
  data.cards.push({
    ...approved.snapshot.card,
    customerSnapshot: approved.snapshot.customer,
    customerApproval: {
      id: approved.id, version: approved.version, status: approved.status, updatedAt: approved.updatedAt,
      approvedBy: approved.approvedBy, approvedAt: approved.approvedAt,
    },
  });
  return { cardId: card.id, terminalId: terminal.id };
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
  const data = seedOffice();
  data.cards.push({ ...completedTestCard(data, 2041, 'customer-build'), status: 'ready' });
  await page.addInitScript((value) => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, data);
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
  await page.goto('/kontor#/weighings/2051');
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
  await page.goto('/kontor#/weighings/2051');
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
        (entry: { id: number }) => entry.id === 2051,
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
        (entry: { id: number }) => entry.id === 2051,
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
  const { cardId, terminalId } = await approveBalanceTestCard(page, fixture);
  try {
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1'))
      localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await login(page, 'Anna Nilsson');
  await page.goto(`/kontor#/attest/${cardId}`);
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText('Sparat på saldo');
  const held = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(held.payments).toEqual([]);
  expect(
    held.cards.find((entry: { id: number }) => entry.id === cardId).status,
  ).toBe('balance');
  await page
    .locator('.office-sidebar')
    .getByRole('button', { name: 'Utbetalningar', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true }),
  ).toHaveCount(0);
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await page
    .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
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
  expect(paid.payments[0]).toMatchObject({ cardId, method: 'cash' });
  expect(
    paid.cards.find((entry: { id: number }) => entry.id === cardId)
      .paymentDetails,
  ).toEqual({ method: 'balance' });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Betala ut från saldo', exact: true }),
  ).toHaveCount(0);
  } finally {
    // Never leave a failed test reserving a terminal. Completed reviews stay in history.
    await page.request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } });
    const response = await page.request.get('/api/terminal-demo/state');
    if (response.ok()) {
      const state = await response.json();
      for (const approval of state.approvals as TerminalApproval[]) {
        if (approval.cardId === cardId && !['attested', 'cancelled'].includes(approval.status)) {
          await page.request.post(`/api/terminal-demo/approvals/${approval.id}/cancel`, { data: {} });
        }
      }
    }
    expect((await page.request.patch(`/api/terminal-demo/terminals/${terminalId}`, { data: { active: false } })).ok()).toBeTruthy();
  }
});

test('rättelser går via granskning till kundens saldo och pluskort utan att det betalda originalet ändras', async ({
  page,
}) => {
  const fixture = seedOffice();
  const customer = {
    ...structuredClone(fixture.customers.find((entry) => entry.id === 'customer-erik')!),
    id: `correction-customer-${randomUUID()}`,
  };
  const cardId = 49_000_000 + randomInt(1_000_000);
  fixture.customers.push(customer);
  fixture.cards = [completedTestCard(fixture, cardId, customer.id)];
  expect((await page.request.post('/api/pricing/customers', {
    headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' },
    data: { id: customer.id, name: customer.name },
  })).ok()).toBeTruthy();
  await page.addInitScript((data) => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, fixture);
  await login(page, 'Lars Andersson');
  await page.goto(`/kontor#/payments/${cardId}?tab=history`);
  const original = await page.evaluate((id) =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (card: { id: number }) => card.id === id,
    ),
    cardId,
  );

  async function createAndApprove(delta: string, document: string) {
    await page.goto(`/kontor#/payments/${cardId}?tab=history`);
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
  await page.goto(`/kontor#/customers/${customer.id}?tab=balance`);
  await expect(
    page.getByRole('heading', { name: 'Erik Johansson', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Rättelse R-1' }),
  ).toContainText(/[-−]19,20/);
  let saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!),
  );
  expect(saved.cards.find((card: { id: number }) => card.id === cardId)).toEqual(
    original,
  );
  expect(
    customerStats(saved, customer.id, '2026-10-08T12:00:00Z'),
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
    customerId: customer.id,
    pricingTotal: 9.6,
  });
  expect(saved.cards.find((card: { id: number }) => card.id === cardId)).toEqual(
    original,
  );
  expect(
    customerStats(saved, customer.id, '2026-10-08T12:00:00Z'),
  ).toMatchObject({
    totalKg: 119,
    totalValue: 228.48,
    weighingCount: 1,
    balance: -9.6,
  });
  await page.goto(`/kontor#/customers/${customer.id}?tab=balance`);
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
