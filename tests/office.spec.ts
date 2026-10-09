import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { seedOffice, type OfficeCard, type OfficeData } from '../src/office/model';
import { money } from '../src/model';
import { migrateOffice } from '../src/office/customer-model';
test.use({
  viewport: { width: 1440, height: 1000 },
  isMobile: false,
  hasTouch: false,
});
test.setTimeout(75_000);
const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
async function officeData(request: APIRequestContext): Promise<OfficeData> {
  const response = await request.get('/api/application/office', { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
}
async function importCards(page: Page, request: APIRequestContext, cards: OfficeCard[]) {
  const fixture = migrateOffice(seedOffice());
  fixture.cards = cards;
  const response = await request.post('/api/application/office', { headers: admin, data: { kind: 'import', data: fixture } });
  expect(response.ok(), await response.text()).toBe(true);
  const canonical = (await response.json()).data;
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
    localStorage.setItem('jeroc.office.demo.v1.postgres-imported', 'yes');
  }, canonical);
}
async function saved(page: Page) {
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('jeroc.office.demo.v1.server-pending.'))
    .every(key => JSON.parse(localStorage.getItem(key) ?? '[]').length === 0))).toBe(true);
}
async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(
    page.getByRole('heading', { name: 'Kontorsöversikt', exact: true }),
  ).toBeVisible();
  await saved(page);
}
async function changeUser(page: Page, name: string) {
  await saved(page);
  await page.getByRole('button', { name: 'Byt demokonto' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await saved(page);
}

test('granskning och prishistorik följs av kundgodkännande, intern attest och manuell demoutbetalning', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 32_000_000 + randomInt(1_000_000);
  const card = { ...fixture.cards.find(card => card.id === 2051)!, id: cardId, sourceId: randomUUID() };
  await importCards(page, request, [card]);
  const previousKajsa = (await officeData(request)).users.find(user => user.id === 'kajsa')!;
  const users = (await officeData(request)).users.map(user => user.id === 'kajsa' ? fixture.users.find(seed => seed.id === 'kajsa')! : user);
  expect((await request.post('/api/pricing/users', { headers: admin, data: { users } })).ok()).toBeTruthy();
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `office-flow-${randomUUID().slice(0, 8)}`;
  const terminalResponse = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(terminalResponse.ok()).toBeTruthy();
  const terminal = await terminalResponse.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
    const external: string[] = [];
    page.on('request', (r) => {
      if (
        r.method() !== 'GET' &&
        r.method() !== 'HEAD' &&
        new URL(r.url()).origin !== 'http://127.0.0.1:5173'
      )
        external.push(r.url());
    });
    await login(page, 'Kajsa Nilsson');
    await page
      .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Visa på kundterminal', exact: true }),
    ).toBeDisabled();
    await page.getByLabel('Kund på vägningen').selectOption('customer-build');
    await expect.poll(async () => (await officeData(request)).cards.find(value => value.id === cardId)?.customerId).toBe('customer-build');
    await saved(page);
    await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
    await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
    await page.getByLabel('Kontonummer', { exact: true }).fill('1234567890');
    await page.getByLabel('Kontohavare', { exact: true }).fill('Bygg & Riv AB');
    await page.getByRole('button', { name: 'Spara betalningsuppgift' }).click();
    await saved(page);
    await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await saved(page);
    const previousPrice = (await officeData(request)).cards.find(value => value.id === cardId)!.rows[0];
    await page
      .getByRole('button', { name: 'Ändra pris', exact: true })
      .first()
      .click();
    await page.getByLabel('Prisalternativ').selectOption('Eget');
    await page.getByLabel('Engångspris kr/kg').fill('50');
    await page.getByRole('button', { name: 'Spara pris', exact: true }).click();
    await expect(page.locator('.office-audit').first()).toContainText(
      `ändrat från ${previousPrice.tier} ${money(previousPrice.price)} till Eget 50,00`,
    );
    await saved(page);
    await expect.poll(async () => (await officeData(request)).cards.find(value => value.id === cardId)?.rows[0].price).toBe(50);
    await page.getByRole('button', { name: 'Visa på kundterminal', exact: true }).click();
    await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminal.id);
    await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
    await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
    const approvals = await (await request.get('/api/terminal-demo/state')).json();
    const approval = approvals.approvals.find((item: { cardId: number }) => item.cardId === cardId);
    expect(approval.snapshot.rows[0].price).toBe(50);
    expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/respond`, { data: { action: 'id_requested', termsAccepted: true } })).ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Bekräfta legitimation & godkännande', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Bekräfta kontroll & godkännande', exact: true }).click();
    await expect(page.locator('.approval-controls')).toContainText('Godkänd av kund');
    await expect(
      page.getByRole('button', { name: 'Attestera', exact: true }),
    ).toHaveCount(0);
    await changeUser(page, 'Anna Nilsson');
    await page
      .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
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
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
    const current = await officeData(request);
    expect((await request.post('/api/pricing/users', { headers: admin, data: { users: current.users.map(user => user.id === 'kajsa' ? previousKajsa : user) } })).ok()).toBeTruthy();
  }
});

test('attestgräns stoppar ekonomi, VD får attestera och får inte ändra systemadmin', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 34_000_000 + randomInt(1_000_000);
  await importCards(page, request, [{
    ...fixture.cards.find(card => card.id === 2052)!, id: cardId, sourceId: randomUUID(),
    rows: [{ articleId: 'copper-1', weight: 1000, tier: 'A', price: 82 }],
    paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' },
  }]);
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `attest-limit-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(response.ok()).toBeTruthy();
  const terminal = await response.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
  await login(page, 'Kajsa Nilsson');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await page.getByRole('button', { name: 'Visa på kundterminal', exact: true }).click();
  await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminal.id);
  await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
  await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
  const state = await (await request.get('/api/terminal-demo/state')).json();
  const approval = state.approvals.find((item: { cardId: number }) => item.cardId === cardId);
  expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/respond`, { data: { action: 'id_requested', termsAccepted: true } })).ok()).toBeTruthy();
  expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/confirm-id`, { data: {} })).ok()).toBeTruthy();
  await changeUser(page, 'Anna Nilsson');
  await page
    .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.office-card-attest')).toContainText(
    'överstiger din attestgräns',
  );
  await page.goto('/kontor#/users');
  await expect(
    page.getByRole('heading', { name: 'Behörighet saknas' }),
  ).toBeVisible();
  await changeUser(page, 'Lars Andersson');
  await page
    .getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Attestera', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(
    'Klar för utbetalning',
  );
  await page
    .locator('.office-sidebar')
    .getByRole('button', { name: 'Personal', exact: true })
    .click();
  await page.getByRole('navigation', { name: 'Personal', exact: true })
    .getByRole('button', { name: 'Konton', exact: true }).click();
  await page
    .getByRole('button', { name: 'Systemadmin Systemadmin', exact: true })
    .click();
  await expect(page.getByLabel('Namn', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Spara behörigheter', exact: true }),
  ).toBeDisabled();
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
  }
});

test('behörigheter och egen attest styrs av VD och rättelseutkast bevarar låst original', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const ownId = 35_000_000 + randomInt(1_000_000);
  const lockedId = ownId + 1;
  const original = fixture.cards.find(card => card.id === 2052)!;
  const cards = [ownId, lockedId].map(id => ({ ...original, id, sourceId: randomUUID(), status: 'complement' as const,
    paymentDetails: { method: 'cash' as const, recipient: 'Bygg & Riv AB' } }));
  await importCards(page, request, cards);
  const previousKajsa = (await officeData(request)).users.find(user => user.id === 'kajsa')!;
  expect((await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
  const username = `own-attest-${randomUUID().slice(0, 8)}`;
  const response = await request.post('/api/terminal-demo/terminals', { data: { name: username, username, password: 'TerminalDemo123!', siteId: 'norrtalje' } });
  expect(response.ok()).toBeTruthy();
  const terminal = await response.json();
  expect((await request.post('/api/terminal-demo/login', { data: { username, password: 'TerminalDemo123!' } })).ok()).toBeTruthy();
  try {
    await login(page, 'Lars Andersson');
    await page.goto('/kontor#/users?user=kajsa');
    await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Kajsa Nilsson');
    await page.getByLabel('Attestera', { exact: true }).check();
    await page.getByLabel('Får attestera egna förberedda kort', { exact: true }).uncheck();
    await page.getByLabel('Maxbelopp för attest (kr)', { exact: true }).fill('100000');
    await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
    await expect(page.getByText(/Kontot och behörigheterna har sparats/)).toBeVisible();
    await saved(page);
    expect((await officeData(request)).users.find(user => user.id === 'kajsa')).toMatchObject({ maxAttest: 100000, ownAttest: false });
    await changeUser(page, 'Kajsa Nilsson');
    // Prepare and approve both versions through the actual terminal workflow;
    // a fabricated imported approval is deliberately rejected by the server.
    for (const card of cards) {
      await page.goto(`/kontor#/weighings/${card.id}`);
      await saved(page);
      await page.getByRole('button', { name: 'Visa på kundterminal', exact: true }).click();
      await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminal.id);
      await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
      await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
      const state = await (await request.get('/api/terminal-demo/state')).json();
      const approval = state.approvals.find((item: { cardId: number }) => item.cardId === card.id);
      expect(approval.effectiveUserId).toBe('kajsa');
      expect((await request.post(`/api/terminal-demo/approvals/${approval.id}/respond`, { data: { action: 'id_requested', termsAccepted: true } })).ok()).toBeTruthy();
      await page.getByRole('button', { name: 'Bekräfta legitimation & godkännande', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Bekräfta kontroll & godkännande', exact: true }).click();
      await expect(page.locator('.approval-controls')).toContainText('Godkänd av kund');
      await saved(page);
    }
    await page.goto(`/kontor#/weighings/${ownId}`);
    await expect(page.getByRole('button', { name: 'Attestera', exact: true })).toBeDisabled();
    await expect(page.getByText('Du får inte attestera ett kort du själv förberett.')).toBeVisible();
    await changeUser(page, 'Anna Nilsson');
    await page.goto(`/kontor#/weighings/${lockedId}`);
    await saved(page);
    await page.getByRole('button', { name: 'Attestera', exact: true }).click();
    await expect(page.locator('.office-title')).toContainText('Klar för utbetalning');
    await saved(page);
    const frozenOriginal = (await officeData(request)).cards.find(card => card.id === lockedId)!;
    expect(frozenOriginal.status).toBe('ready');
    await changeUser(page, 'Kajsa Nilsson');
    await page.goto(`/kontor#/weighings/${lockedId}`);
    await page.getByLabel('Viktändring, kg', { exact: true }).fill('-100');
    await page.getByLabel('Orsak / rättelseunderlag', { exact: true }).fill('Fel vikt · underlag Y');
    await page.getByRole('button', { name: 'Skapa rättelseutkast', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Rättelseutkast', exact: true })).toBeVisible();
    await saved(page);
    const savedData = await officeData(request);
    expect(savedData.cards.find(card => card.id === lockedId)).toEqual(frozenOriginal);
    expect(savedData.corrections.find(correction => correction.cardId === lockedId)).toMatchObject({
      cardId: lockedId, customerId: 'customer-build', weightDelta: -100, status: 'draft',
    });
  } finally {
    await request.patch(`/api/terminal-demo/terminals/${terminal.id}`, { data: { active: false } });
    const current = await officeData(request);
    expect((await request.post('/api/pricing/users', { headers: admin, data: { users: current.users.map(user => user.id === 'kajsa' ? previousKajsa : user) } })).ok()).toBeTruthy();
  }
});
