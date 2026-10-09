import { test, expect } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { randomInt, randomUUID } from 'node:crypto';
import { migrateOffice } from '../src/office/customer-model';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});
test.describe.configure({ mode: 'serial' });

test('full prisbehörighet kan färdigställa ett tidigare dolt pris utan prisändringsrätt och servern ersätter det gamla värdet', async ({ page, request }) => {
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const before = await request.get('/api/pricing/state', { headers });
  expect(before.ok()).toBeTruthy();
  const originalUsers = (await before.json()).users;
  const preparer = {
    id: 'review-preparer-without-price-edit', name: 'Granskare utan prisändring', level: 'Medarbetare' as const,
    permissions: ['view', 'prepare', 'customers', 'prices', 'priceA', 'priceB', 'priceC', 'customerPrices', 'verifyId', 'paymentDetails', 'customerApprovalRead'] as const,
    maxAttest: 0, ownAttest: false,
  };
  const users = [...originalUsers, preparer];
  expect((await request.post('/api/pricing/users', { headers, data: { users } })).ok()).toBeTruthy();
  const data = migrateOffice(seedOffice());
  data.users = users;
  const cardId = 41_000_000 + randomInt(1_000_000);
  data.cards.push({
    ...data.cards.find(card => card.id === 2053)!, id: cardId, sourceId: randomUUID(), customerId: 'customer-build', origin: 'Testgatan 12, Norrtälje',
    payment: 'Kontant', paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' },
    rows: [{ articleId: 'copper-1', weight: 72, tier: 'C', price: 1, pricePending: true }],
    financialPending: true, pricingRowsPending: true, audit: [],
  });
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, data);
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `pending-price-${randomUUID().slice(0, 8)}`;
  const created = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(created.ok()).toBeTruthy();
  const terminal = await created.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
    await page.goto('/kontor');
    await page.getByRole('button', { name: /Granskare utan prisändring/ }).click();
    await page.goto(`/kontor#/weighings/${cardId}`);
    await expect(page.getByRole('button', { name: 'Ändra pris', exact: true })).toHaveCount(0);
    const show = page.getByRole('button', { name: 'Visa på kundterminal', exact: true });
    await expect(show).toBeEnabled();
    await show.click();
    await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminal.id);
    await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
    await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
    const state = await (await request.get('/api/terminal-demo/state')).json();
    const approval = state.approvals.find((item: { cardId: number }) => item.cardId === cardId);
    expect(approval.snapshot.rows[0].price).toBe(84);
    expect(approval.snapshot.gross).toBe(6048);
    const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === id), cardId);
    expect(saved).toMatchObject({ status: 'customer', financialPending: false, pricingRowsPending: false });
    expect(saved.rows[0]).toMatchObject({ price: 84, pricePending: false });
  } finally {
    const state = await (await request.get('/api/terminal-demo/state')).json();
    const approval = state.approvals.find((item: { cardId: number }) => item.cardId === cardId);
    if (approval) await request.post(`/api/terminal-demo/approvals/${approval.id}/cancel`, { data: {} });
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
    expect((await request.post('/api/pricing/users', { headers, data: { users: originalUsers } })).ok()).toBeTruthy();
  }
});

test('servern bevarar dolt kundpris men begränsad kontorist kan inte visa ekonomin för kunden', async ({
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
    await page.goto('/kontor#/weighings/2053');
    await page
      .getByLabel('Kund på vägningen', { exact: true })
      .selectOption('customer-build');
    await expect(
      page.getByLabel('Kund på vägningen', { exact: true }),
    ).toHaveValue('customer-build');
    await expect(page.getByText('Dolt pris', { exact: true })).toBeVisible();
    await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Visa på kundterminal', exact: true })).toBeDisabled();
    await expect(page.locator('.approval-controls')).toContainText(/behörighet/);
    const locked = await page.request.post('/api/pricing/snapshots', {
      headers: { 'X-Demo-Actor': preparer.id, 'X-Demo-User': preparer.id },
      data: { cardId: '2053', customerId: 'customer-build', deliveredAt: '2026-10-09T08:41:00Z', excludeCardId: '2053', rows: [{ articleId: 'copper-1', weight: 72 }] },
    });
    expect(locked.ok()).toBeTruthy();

    const authoritative = await page.request.get(
      '/api/pricing/snapshots?cardId=2053',
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
    await page.goto('/kontor#/weighings/2053');
    await expect(page.getByRole('button', { name: 'Attestera', exact: true })).toBeDisabled();
    // A valid price snapshot alone never substitutes for customer approval.
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
