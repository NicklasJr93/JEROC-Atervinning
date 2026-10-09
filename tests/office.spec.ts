import { test, expect, type Page } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
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

test('granskning och prishistorik följs av kundgodkännande, intern attest och manuell demoutbetalning', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 32_000_000 + randomInt(1_000_000);
  fixture.cards.push({ ...fixture.cards.find(card => card.id === 2051)!, id: cardId, sourceId: randomUUID() });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
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
    await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
    await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
    await page.getByLabel('Kontonummer', { exact: true }).fill('1234567890');
    await page.getByLabel('Kontohavare', { exact: true }).fill('Bygg & Riv AB');
    await page.getByRole('button', { name: 'Spara betalningsuppgift' }).click();
    await page.getByLabel('Ursprungsadress', { exact: true }).fill('Ängsvägen 19');
    await page
      .getByRole('button', { name: 'Spara referens & ursprung', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Ändra pris', exact: true })
      .first()
      .click();
    await page.getByLabel('Prisalternativ').selectOption('Eget');
    await page.getByLabel('Engångspris kr/kg').fill('50');
    await page.getByRole('button', { name: 'Spara pris', exact: true }).click();
    await expect(page.locator('.office-audit').first()).toContainText(
      'ändrat från Eget 84,00 till Eget 50,00',
    );
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
  }
});

test('attestgräns stoppar ekonomi, VD får attestera och får inte ändra systemadmin', async ({
  page, request,
}) => {
  const fixture = migrateOffice(seedOffice());
  const cardId = 34_000_000 + randomInt(1_000_000);
  fixture.cards.push({
    ...fixture.cards.find(card => card.id === 2052)!, id: cardId, sourceId: randomUUID(),
    rows: [{ articleId: 'copper-1', weight: 1000, tier: 'A', price: 82 }],
    paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' },
  });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
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
    .getByRole('button', { name: 'Användare', exact: true })
    .click();
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
  page,
}) => {
  const fixture = migrateOffice(seedOffice());
  const ownId = 35_000_000 + randomInt(1_000_000);
  const lockedId = ownId + 1;
  const approvedAt = '2026-10-09T10:00:00Z';
  const original = fixture.cards.find(card => card.id === 2052)!;
  fixture.cards.push({ ...original, id: ownId, sourceId: randomUUID(), status: 'attest', preparedBy: 'kajsa',
    customerApproval: { id: randomUUID(), version: 1, status: 'approved', updatedAt: approvedAt, approvedAt, approvedBy: 'Personal · UI-test' } });
  fixture.cards.push({ ...original, id: lockedId, sourceId: randomUUID(), status: 'ready', preparedBy: 'kajsa', approvedBy: 'anna',
    customerApproval: { id: randomUUID(), version: 1, status: 'attested', updatedAt: approvedAt, approvedAt, approvedBy: 'Personal · UI-test', attestedBy: 'Anna Nilsson', attestedAt: approvedAt } });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, migrateOffice(fixture));
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
  await expect(page.getByText(/Behörigheterna har sparats/)).toBeVisible();
  await changeUser(page, 'Kajsa Nilsson');
  await page
    .getByRole('button', { name: `Öppna viktkort ${ownId}`, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Attestera', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Du får inte attestera ett kort du själv förberett.'),
  ).toBeVisible();
  await page.goto(`/kontor#/weighings/${lockedId}`);
  const frozenOriginal = await page.evaluate((id) =>
    JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find(
      (c: { id: number }) => c.id === id,
    ),
    lockedId,
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
  expect(saved.cards.find((c: { id: number }) => c.id === lockedId)).toEqual(
    frozenOriginal,
  );
  expect(saved.corrections[0]).toMatchObject({
    cardId: lockedId,
    customerId: 'customer-build',
    weightDelta: -100,
  });
});
