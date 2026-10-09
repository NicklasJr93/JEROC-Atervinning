import { test, expect, type Page } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { seedOffice, type OfficeCard, type OfficeData } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { approveCustomerCard } from './helpers/customer-approval';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});

test.describe.configure({ mode: 'serial' });
test.setTimeout(75_000);
const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function officeData(page: Page): Promise<OfficeData> {
  const response = await page.request.get('/api/application/office', { headers: admin });
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}
async function importCards(page: Page, cards: OfficeCard[]) {
  const data = migrateOffice(seedOffice());
  data.cards = cards;
  const response = await page.request.post('/api/application/office', { headers: admin, data: { kind: 'import', data } });
  expect(response.ok(), await response.text()).toBe(true);
}

async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('heading', { name: 'Kontorsöversikt', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
}

test('Jobba som använder Annas attestgräns och sparar båda personerna i spårbarheten', async ({
  page, request,
}) => {
  const data = migrateOffice(seedOffice());
  const cardId = 63_000_000 + randomInt(1_000_000);
  const highId = cardId + 1;
  const base = data.cards.find(card => card.id === 2052)!;
  data.cards = [{ ...base, id: cardId, sourceId: randomUUID(), paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' } },
    { ...base, id: highId, sourceId: randomUUID(), status: 'complement', preparedBy: 'kajsa', paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' },
      rows: [{ articleId: 'copper-1', weight: 1000, price: 82, tier: 'A' }] }];
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, migrateOffice(data));
  await importCards(page, data.cards);
  await approveCustomerCard(request, data.cards.find(card => card.id === highId)!);
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `acting-attest-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(response.ok()).toBeTruthy();
  const terminal = await response.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
  await login(page, 'Kajsa Nilsson');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Visa på kundterminal', exact: true }).click();
  await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminal.id);
  await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
  await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
  const state = await (await request.get('/api/terminal-demo/state')).json();
  const approval = state.approvals.find((item: { cardId: number }) => item.cardId === cardId);
  expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/respond`, { data: { action: 'id_requested', termsAccepted: true } })).ok()).toBeTruthy();
  expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/confirm-id`, { data: {} })).ok()).toBeTruthy();
  await page.getByRole('button', { name: 'Byt demokonto', exact: true }).click();
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('anna');
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('.office-sidebar')
      .getByRole('button', { name: 'Personal', exact: true }),
  ).toHaveCount(0);

  await page.goto(`/kontor#/weighings/${highId}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
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

  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(page.locator('.office-audit')).toContainText('Systemadmin');
  await expect(page.locator('.office-audit')).toContainText('Anna Nilsson');
  await page.reload();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page
    .getByRole('button', { name: 'Avsluta Jobba som', exact: true })
    .click();
  await expect(
    page.getByText('Jobbar som Anna Nilsson', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.office-sidebar')
      .getByRole('button', { name: 'Personal', exact: true }),
  ).toBeVisible();
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
  }
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
  page, request,
}) => {
  const data = migrateOffice(seedOffice());
  const cardId = 64_000_000 + randomInt(1_000_000);
  data.cards = [{ ...data.cards.find(card => card.id === 2052)!, id: cardId, sourceId: randomUUID(), status: 'complement', preparedBy: 'kajsa',
    paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' } }];
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, migrateOffice(data));
  await importCards(page, data.cards);
  const approval = await approveCustomerCard(request, data.cards[0]);
  const attested = await request.post(`/api/terminal-demo/approvals/${approval.id}/attest`, { data: {} });
  expect(attested.ok(), await attested.text()).toBe(true);
  await login(page, 'Lars Andersson');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  const original = (await officeData(page)).cards.find(card => card.id === cardId);
  expect(original!.status).toBe('ready');
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

    await page.goto(`/kontor#/weighings/${cardId}`);
    await page.reload();
    await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.office-title')).toContainText(
      'Klar för utbetalning',
    );
    await expect(
      page.getByRole('button', { name: 'Ändra pris', exact: true }),
    ).toHaveCount(0);
    const saved = (await officeData(page)).cards.find(card => card.id === cardId);
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

test('kontorist utan kundprisbehörighet ser dolda volymuppgifter och kan inte starta kundvisning', async ({
  page,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 69_000_000 + randomInt(1_000_000);
  const card = { ...fixture.cards.find(card => card.id === 2053)!, id: cardId, sourceId: randomUUID() };
  await importCards(page, [card]);
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
      'Kontot och behörigheterna har sparats',
    );
    await page
      .getByRole('button', { name: 'Byt demokonto', exact: true })
      .click();
    await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
    await page.goto(`/kontor#/weighings/${cardId}`);
    await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
    await page
      .getByLabel('Kund på vägningen', { exact: true })
      .selectOption('customer-brf');
    await expect(
      page.getByLabel('Kund på vägningen', { exact: true }),
    ).toHaveValue('customer-brf');
    await expect(
      page.getByText('Kundprisbehörighet krävs', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Visa på kundterminal', exact: true })).toBeDisabled();
    await expect.poll(async () => (await officeData(page)).cards.find(card => card.id === cardId)?.customerId).toBe('customer-brf');
    const saved = (await officeData(page)).cards.find(card => card.id === cardId)!;
    expect(saved).toMatchObject({
      status: 'complement',
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
