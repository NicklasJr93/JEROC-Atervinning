import { test, expect, type Page } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { seedOffice, type OfficeCard, type OfficeData } from '../src/office/model';
import { migrateOffice, recordPayment } from '../src/office/customer-model';
import { approveCustomerCard } from './helpers/customer-approval';

test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});
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
function newCard(id = 68_000_000 + randomInt(1_000_000)): OfficeCard {
  return { ...seedOffice().cards.find(card => card.id === 2052)!, id, sourceId: randomUUID(), status: 'complement',
    preparedBy: 'kajsa', paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' } };
}

async function queueFixtures(page: Page) {
  const firstId = 68_000_000 + randomInt(1_000_000);
  const [openId, attestId, readyId, paidId] = [firstId, firstId + 1, firstId + 2, firstId + 3];
  const cards = [openId, attestId, readyId, paidId].map(id => newCard(id));
  await importCards(page, cards);
  // Historical financial states must originate in the shared workflow. A
  // browser-only "approved" fixture is deliberately archived by the server.
  for (const card of cards.slice(1)) {
    const approval = await approveCustomerCard(page.request, card);
    if (card.id !== attestId) {
      const attested = await page.request.post(`/api/terminal-demo/approvals/${approval.id}/attest`, { data: {} });
      expect(attested.ok(), await attested.text()).toBe(true);
    }
  }
  const base = await officeData(page), user = base.users.find(user => user.id === 'admin')!;
  const next = recordPayment(base, paidId, { actualUser: user, user }, { method: 'cash', recipient: 'Bygg & Riv AB' }, 'Lokal arbetskötest');
  const paid = await page.request.post('/api/application/office', { headers: admin, data: { base, next } });
  expect(paid.ok(), await paid.text()).toBe(true);
  return { openId, attestId, readyId, paidId };
}

async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('heading', { name: 'Kontorsöversikt', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
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
  const { openId, attestId, readyId, paidId } = await queueFixtures(page);
  const unexpectedUpdates: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/application/office' && request.postDataJSON()?.kind === 'update')
      unexpectedUpdates.push(request.url());
  });
  await login(page, 'Lars Andersson');
  await menu(page, 'Invägningar').click();
  await expectQueue(page, [openId], [attestId, readyId, paidId]);
  const search = await page.locator('.office-queue-search .office-search').boundingBox();
  const filter = await page.getByLabel('Filtrera status', { exact: true }).boundingBox();
  expect(Math.abs(search!.height - filter!.height)).toBeLessThan(1);

  await menu(page, 'Attest').click();
  await expectQueue(page, [attestId], [openId, readyId, paidId]);
  await page
    .getByRole('button', { name: `Öppna viktkort ${attestId}`, exact: true })
    .click();
  await expect(menu(page, 'Attest')).toHaveClass(/active/);
  await expect(menu(page, 'Invägningar')).not.toHaveClass(/active/);
  await page.getByRole('button', { name: 'Till attest', exact: true }).click();
  await expectQueue(page, [attestId], [readyId]);

  await menu(page, 'Utbetalningar').click();
  await expectQueue(page, [readyId], [openId, attestId, paidId]);
  await page
    .getByRole('button', { name: `Öppna viktkort ${readyId}`, exact: true })
    .click();
  await expect(menu(page, 'Utbetalningar')).toHaveClass(/active/);
  await expect(menu(page, 'Invägningar')).not.toHaveClass(/active/);
  await page
    .getByRole('button', { name: 'Till utbetalningar', exact: true })
    .click();
  await expectQueue(page, [readyId], [attestId]);
  // Reading terminal projections and navigating existing financial originals
  // must not write them back or enqueue unrelated card updates.
  expect(unexpectedUpdates).toEqual([]);
});

test('kundgodkännande, attest och sammanställning har full bredd under de tre översta panelerna', async ({ page }, testInfo) => {
  const card = newCard();
  await importCards(page, [card]);
  await login(page, 'Lars Andersson');
  await page.goto(`/kontor#/weighings/${card.id}`);
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  for (const width of [1440, 2056]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel('Anläggning', { exact: true })).toBeVisible();
    const header = await page.locator('.office-topbar').boundingBox();
    for (const label of await page.locator('.terminal-top-selector').all()) {
      const box = (await label.boundingBox())!, select = (await label.locator('select').boundingBox())!;
      expect(select.y).toBeGreaterThanOrEqual(box.y);
      expect(select.y + select.height).toBeLessThanOrEqual(box.y + box.height);
      expect(box.y + box.height).toBeLessThanOrEqual(header!.y + header!.height);
    }
    const customer = await page.locator('.office-card-customer').boundingBox();
    const material = await page.locator('.office-card-material').boundingBox();
    const payment = await page.locator('.office-card-payment').boundingBox();
    const approval = await page.locator('.approval-controls').boundingBox();
    const summary = await page.locator('.office-card-summary').boundingBox();
    const attest = await page.locator('.office-card-attest').boundingBox();
    expect(material && customer && payment && approval && attest && summary).toBeTruthy();
    expect(payment!.x).toBeGreaterThanOrEqual(customer!.x + customer!.width);
    for (const panel of [approval, attest, summary]) {
      expect(Math.abs(panel!.x - material!.x)).toBeLessThan(1);
      expect(Math.abs(panel!.x + panel!.width - payment!.x - payment!.width)).toBeLessThan(1);
    }
    expect(approval!.y).toBeGreaterThanOrEqual(Math.max(...[material, customer, payment].map(panel => panel!.y + panel!.height)));
    expect(attest!.y).toBeGreaterThanOrEqual(approval!.y + approval!.height);
    expect(summary!.y).toBeGreaterThanOrEqual(attest!.y + attest!.height);
  }
  await page.screenshot({ path: testInfo.outputPath('desktop-layout.png'), fullPage: true });
});

test('attest flyttar kortet till utbetalningskön och kontorets historik visar spårbar status utan extra rättigheter', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 62_000_000 + randomInt(1_000_000);
  fixture.cards = [{ ...fixture.cards.find(card => card.id === 2052)!, id: cardId, sourceId: randomUUID(),
    paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' } }];
  await page.addInitScript(value => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(value));
  }, migrateOffice(fixture));
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `queue-attest-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(response.ok()).toBeTruthy();
  const terminal = await response.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
  await login(page, 'Kajsa Nilsson');
  await importCards(page, fixture.cards);
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
  await page.getByRole('button', { name: /Anna Nilsson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await menu(page, 'Attest').click();
  await page
    .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
    .click();
  const before = page.url();
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page).toHaveURL(before);
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await expect(menu(page, 'Attest')).toHaveClass(/active/);
  await menu(page, 'Attest').click();
  await expectQueue(page, [], [cardId]);
  await menu(page, 'Utbetalningar').click();
  await expectQueue(page, [cardId], []);

  await page
    .getByRole('button', { name: 'Byt demokonto', exact: true })
    .click();
  await page.getByRole('button', { name: /Kajsa Nilsson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await menu(page, 'Invägningar').click();
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await expectQueue(page, [cardId], []);
  await page
    .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
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
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
  }
});

test('historikens filter bevaras när ett kort öppnas och återbesöks', async ({
  page,
}) => {
  const { attestId, readyId, paidId } = await queueFixtures(page);
  await login(page, 'Lars Andersson');
  await menu(page, 'Utbetalningar').click();
  await page.getByRole('tab', { name: 'Historik', exact: true }).click();
  await expectQueue(page, [paidId], [attestId, readyId]);
  await page
    .getByLabel('Filtrera status', { exact: true })
    .selectOption('paid');
  await page.getByLabel('Sök i kön', { exact: true }).fill(String(paidId));
  const before = page.url();
  await page
    .getByRole('button', { name: `Öppna viktkort ${paidId}`, exact: true })
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
    String(paidId),
  );
  await expect(
    page.getByRole('tab', { name: 'Historik', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expectQueue(page, [paidId], [readyId]);
});
