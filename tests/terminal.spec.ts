import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { OfficeCard } from '../src/office/model';
import { createOfficeCard, readOffice, saveOffice } from './helpers/financial-card';
import type { DemoTerminal, TerminalApproval, TerminalDemoState } from '../src/office/terminal-demo-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(75_000);
test.beforeEach(async ({ page }) => page.setDefaultTimeout(15_000));

const service = '/api/terminal-demo';
const password = 'TerminalDemo123!';

async function fixture(request: APIRequestContext) {
  const prefix = `e2e-${randomUUID().slice(0, 8)}`;
  const ids: number[] = [];
  for (const index of [0, 1]) {
    const created = await createOfficeCard(request, { customerId: 'customer-build',
      paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' },
      rows: [{ articleId: 'iron', weight: 83 + index, tier: 'A', price: 2.4 }],
    });
    ids.push(created.cardId);
  }
  const data = await readOffice(request);
  const cards = ids.map(id => data.cards.find(card => card.id === id)!);
  cards.forEach((card, index) => {
    card.status = 'new';
    card.origin = `Testgatan ${index + 1}, 761 41 Norrtälje`;
    card.reference = `${prefix}-${index + 1}`;
    card.payment = 'Kontant · testmottagare';
  });
  return { cards, prefix };
}

async function installFixture(page: Page, cards: OfficeCard[]) {
  const base = await readOffice(page.request), next = structuredClone(base);
  for (const card of cards) next.cards[next.cards.findIndex(entry => entry.id === card.id)] = structuredClone(card);
  await saveOffice(page.request, base, next);
}

async function loginOffice(page: Page, name = 'Systemadmin') {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await expect(page.getByLabel('Anläggning', { exact: true })).toBeVisible();
  await expect.poll(async () => (await page.request.get(`${service}/state`)).status()).toBe(200);
}

async function createTerminal(page: Page, prefix: string, suffix: string) {
  await page.goto('/kontor#/terminals');
  await expect(page.getByRole('heading', { name: 'Kundterminaler', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skapa terminal', exact: true }).first().click();
  const form = page.locator('form.terminal-dialog');
  const username = `${prefix}-${suffix}`;
  const name = `${prefix} Kassa ${suffix}`;
  await form.getByLabel('Namn', { exact: true }).fill(name);
  await form.getByLabel('Inloggningsnamn', { exact: true }).fill(username);
  await form.getByLabel(/^Lösenord/).fill(password);
  await form.getByRole('combobox', { name: 'Anläggning', exact: true }).selectOption('norrtalje');
  await form.getByRole('button', { name: 'Skapa terminal', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const state = await stateOf(page);
  const terminal = state.terminals.find(item => item.username === username);
  expect(terminal).toBeDefined();
  return terminal!;
}

async function mobileTerminal(browser: Browser, baseURL: string, terminal: DemoTerminal) {
  const context = await browser.newContext({
    baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto('/terminal');
  await page.getByLabel('Inloggningsnamn', { exact: true }).fill(terminal.username);
  await page.getByLabel('Lösenord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Logga in terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
  return { page, context };
}

async function stateOf(page: Page): Promise<TerminalDemoState> {
  const response = await page.request.get(`${service}/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function approvalOf(page: Page, cardId: number): Promise<TerminalApproval> {
  const state = await stateOf(page);
  const latest = state.approvals.filter(approval => approval.cardId === cardId).sort((a, b) => b.version - a.version)[0];
  expect(latest).toBeDefined();
  return latest;
}

async function sendToTerminal(page: Page, cardId: number, terminal: DemoTerminal) {
  await page.goto(`/kontor#/weighings/${cardId}`);
  const before = page.url();
  const send = page.getByRole('button', { name: /^Visa (på kundterminal|ny version på kundterminal)$/ });
  await expect(send).toBeEnabled();
  await send.click();
  const picker = page.getByLabel('Terminal för kundgodkännande', { exact: true });
  await expect(picker.locator(`option[value="${terminal.id}"]`)).toBeEnabled();
  await picker.selectOption(terminal.id);
  await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
  await expect(page).toHaveURL(before);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: /^Invägningar(?: \d+ aktiva kort)?$/ })).toHaveClass(/active/);
  await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
  return approvalOf(page, cardId);
}

async function cleanup(page: Page, terminals: DemoTerminal[], cardIds: number[]) {
  // The shared server must not keep reservations from a failed browser test.
  const response = await page.request.get(`${service}/state`, { timeout: 5_000 }).catch(() => null);
  if (!response?.ok()) return;
  const state = await response.json() as TerminalDemoState;
  for (const approval of state.approvals) {
    if (cardIds.includes(approval.cardId) && !['attested', 'cancelled'].includes(approval.status))
      await page.request.post(`${service}/approvals/${approval.id}/cancel`, { data: {} });
  }
  for (const terminal of terminals)
    await page.request.patch(`${service}/terminals/${terminal.id}`, { data: { active: false } });
  for (const preference of state.defaults) {
    if (preference.userId === 'admin' && terminals.some(terminal => terminal.id === preference.terminalId))
      await page.request.put(`${service}/defaults`, { data: { siteId: preference.siteId, terminalId: null } });
  }
}

test('två terminaler visar egna frysta avräkningar och personalens kontroll föregår intern attest', async ({ page, browser, baseURL }) => {
  const { cards, prefix } = await fixture(page.request);
  const terminals: DemoTerminal[] = [];
  const contexts: BrowserContext[] = [];
  await installFixture(page, cards);
  try {
    await loginOffice(page);
    terminals.push(await createTerminal(page, prefix, '1'), await createTerminal(page, prefix, '2'));
    const first = await mobileTerminal(browser, baseURL!, terminals[0]);
    const second = await mobileTerminal(browser, baseURL!, terminals[1]);
    contexts.push(first.context, second.context);
    await page.getByLabel('Anläggning', { exact: true }).selectOption('norrtalje');
    await page.getByLabel('Förvald kundterminal', { exact: true }).selectOption(terminals[0].id);
    await expect.poll(async () => (await stateOf(page)).defaults.find(item => item.userId === 'admin' && item.siteId === 'norrtalje')?.terminalId).toBe(terminals[0].id);
    const sent = await sendToTerminal(page, cards[0].id, terminals[0]);
    await expect(first.page.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toBeVisible();
    await expect(first.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();
    await expect(first.page.locator('.terminal-material-table')).toContainText('83 kg');
    await expect(first.page.locator('.terminal-material-table')).toContainText(sent.snapshot.rows[0].name);
    await expect(first.page.getByRole('checkbox')).not.toBeChecked();
    await expect(second.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    await expect(second.page.getByText(new RegExp(`INV-${cards[0].id}`))).toHaveCount(0);

    const other = await sendToTerminal(page, cards[1].id, terminals[1]);
    await expect(second.page.getByText(`Invägningskort INV-${cards[1].id}`, { exact: true })).toBeVisible();
    await expect(first.page.getByText(new RegExp(`INV-${cards[1].id}`))).toHaveCount(0);
    const wrongTerminal = await second.page.request.post(`${service}/approvals/${sent.id}/respond`, {
      data: { action: 'id_requested', termsAccepted: true },
    });
    expect(wrongTerminal.status()).toBe(409);

    // A terminal's cookie cannot read the staff queue or leak bank information.
    expect((await first.page.request.get(`${service}/state`)).status()).toBe(401);
    const publicSession = await (await first.page.request.get(`${service}/session`)).json();
    expect(publicSession.approval.snapshot).not.toHaveProperty('card');
    expect(publicSession.approval.snapshot).not.toHaveProperty('paymentDetails');
    expect(publicSession.approval.snapshot.hash).toBe(sent.snapshot.hash);
    await first.page.reload();
    await expect(first.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();
    const cookie = (await first.context.cookies()).find(item => item.name === 'jeroc_terminal_demo_device');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict' });

    await first.page.getByRole('button', { name: 'Godkänn med BankID', exact: true }).click();
    await expect(first.page.getByRole('dialog', { name: 'BankID – demoläge' })).toContainText('BankID är inte anslutet');
    await first.page.getByRole('button', { name: 'Tillbaka till avräkningen', exact: true }).click();
    expect((await approvalOf(page, cards[0].id)).status).toBe('waiting');
    await first.page.getByRole('button', { name: 'Godkänn med legitimation', exact: true }).click();
    await expect(first.page.getByRole('alert')).toContainText('Bekräfta att du har granskat');
    await first.page.getByRole('checkbox').check();
    await first.page.getByRole('button', { name: 'Godkänn med legitimation', exact: true }).click();
    await first.page.getByRole('dialog', { name: 'Manuell verifiering' }).getByRole('button', { name: 'Okej', exact: true }).click();
    await expect(first.page.getByRole('heading', { name: 'Inväntar personalens bekräftelse', exact: true })).toBeVisible();
    expect((await page.request.post(`${service}/approvals/${sent.id}/attest`, { data: {} })).status()).toBe(409);

    // A second office browser reads the same server queue without the seeded local card.
    const colleague = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
    contexts.push(colleague);
    const colleaguePage = await colleague.newPage();
    await loginOffice(colleaguePage, 'Kajsa Nilsson');
    await colleaguePage.goto('/kontor#/customer-approvals');
    await colleaguePage.getByLabel('Sök kundgodkännanden', { exact: true }).fill(String(cards[0].id));
    await expect(colleaguePage.getByRole('button', { name: `Öppna invägning ${cards[0].id}`, exact: true })).toBeVisible();

    await page.goto(`/kontor#/customer-approvals/${cards[0].id}`);
    await page.getByRole('button', { name: 'Bekräfta legitimation & godkännande', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Bekräfta kontroll & godkännande', exact: true }).click();
    await expect(first.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    await expect(first.page.locator('.terminal-material-table')).toHaveCount(0);
    const approved = await approvalOf(page, cards[0].id);
    expect(approved).toMatchObject({ status: 'approved', approvedBy: 'Systemadmin' });
    expect(approved.snapshot.hash).toBe(sent.snapshot.hash);
    expect((await page.request.post(`${service}/approvals/${sent.id}/confirm-id`, { data: {} })).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Attestera', exact: true })).toBeEnabled();
    const beforeAttest = page.url();
    await page.getByRole('button', { name: 'Attestera', exact: true }).click();
    await expect(page).toHaveURL(beforeAttest);
    await expect(page.locator('.office-sidebar').getByRole('button', { name: /^Kundgodkännande(?: \d+ aktiva kort)?$/ })).toHaveClass(/active/);
    await expect(page.locator('.office-title')).toContainText('Klar för utbetalning');
    expect((await approvalOf(page, cards[0].id)).status).toBe('attested');
    expect((await page.request.post(`${service}/approvals/${sent.id}/attest`, { data: {} })).status()).toBe(200);
    expect((await approvalOf(page, cards[1].id)).id).toBe(other.id);
    await expect(second.page.getByText(`Invägningskort INV-${cards[1].id}`, { exact: true })).toBeVisible();
  } finally {
    await cleanup(page, terminals, cards.map(card => card.id));
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('avslutad kundvisning kan skickas igen oförändrad till samma terminal med en ny granskningsversion', async ({ page, browser, baseURL }) => {
  const { cards, prefix } = await fixture(page.request);
  // Both sends must use the same pricing request: an initial manual override
  // would create a different snapshot on resend and hide the idempotency bug.
  cards[0].rows[0].source = 'Volympris';
  const terminals: DemoTerminal[] = [];
  let mobile: Awaited<ReturnType<typeof mobileTerminal>> | undefined;
  await installFixture(page, cards);
  try {
    await loginOffice(page);
    terminals.push(await createTerminal(page, prefix, '1'));
    mobile = await mobileTerminal(browser, baseURL!, terminals[0]);
    const pricingRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/pricing/snapshots'));
    const original = await sendToTerminal(page, cards[0].id, terminals[0]);
    expect((await pricingRequest).postDataJSON().rows[0]).not.toHaveProperty('override');
    expect(original.snapshot.card.pricingSnapshotId).toBeTruthy();
    await expect(mobile.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Avsluta kundvisning', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Avsluta visningen', exact: true }).click();
    await expect(mobile.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Visa ny version på kundterminal', exact: true })).toBeEnabled();
    expect((await approvalOf(page, cards[0].id)).status).toBe('cancelled');

    const resent = await sendToTerminal(page, cards[0].id, terminals[0]);
    expect(resent.id).not.toBe(original.id);
    expect(resent.version).toBe(original.version + 1);
    expect(resent.snapshot.card.pricingSnapshotId).toBe(original.snapshot.card.pricingSnapshotId);
    expect(resent.snapshot.rows).toEqual(original.snapshot.rows);
    const state = await stateOf(page);
    expect(state.approvals.filter(approval => approval.cardId === cards[0].id)).toHaveLength(2);
    expect(state.approvals.find(approval => approval.id === original.id)?.status).toBe('cancelled');
    expect(state.terminals.find(terminal => terminal.id === terminals[0].id)?.activeApprovalId).toBe(resent.id);
    await expect(mobile.page.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toBeVisible();
    await expect(mobile.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();
    await expect(mobile.page.locator('.settlement-preliminary')).toContainText(`Version ${resent.version}`);
    await expect(mobile.page.locator('.terminal-material-table')).toContainText('83 kg');
    expect((await (await mobile.page.request.get(`${service}/session`)).json()).approval.id).toBe(resent.id);

    await page.goto('/kontor#/customer-approvals');
    await page.getByLabel('Sök kundgodkännanden', { exact: true }).fill(String(cards[0].id));
    await page.getByRole('tab', { name: /^Historik/ }).click();
    const historical = page.getByRole('row').filter({ has: page.getByRole('button', {
      name: `Granska avräkningsversion ${original.version} för invägning ${cards[0].id}`, exact: true,
    }) });
    await expect(historical).toContainText('Avbruten');
    await expect(historical).toContainText('Tidigare version');
  } finally {
    await cleanup(page, terminals, cards.map(card => card.id));
    await mobile?.context.close();
  }
});

test('misslyckade terminalutskick visar felet i den öppna dialogen och kan återförsökas utan dubbletter', async ({ page, browser, baseURL }) => {
  const { cards, prefix } = await fixture(page.request);
  cards[0].rows[0].source = 'Volympris';
  const terminals: DemoTerminal[] = [];
  let mobile: Awaited<ReturnType<typeof mobileTerminal>> | undefined;
  const sendKeys: string[] = [];
  const failureMessage = 'Terminal upptagen. Välj en annan terminal.';
  await installFixture(page, cards);
  try {
    await loginOffice(page);
    terminals.push(await createTerminal(page, prefix, '1'));
    mobile = await mobileTerminal(browser, baseURL!, terminals[0]);
    await page.goto(`/kontor#/weighings/${cards[0].id}`);
    await page.route('**/api/terminal-demo/approvals', async route => {
      sendKeys.push(route.request().postDataJSON().idempotencyKey);
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: failureMessage, code: 'terminal_busy' }) });
    });
    await expect(page.getByRole('button', { name: 'Visa på kundterminal', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Visa på kundterminal', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Visa avräkning för kunden', exact: true });
    await dialog.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminals[0].id);
    for (let attempt = 0; attempt < 2; attempt++) {
      await dialog.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
      await expect(dialog.getByRole('alert')).toHaveText(failureMessage);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Visa på terminal', exact: true })).toBeEnabled();
      await expect(page.getByText('Avräkningen visas på kundterminalen. Inväntar kundens svar.', { exact: true })).toHaveCount(0);
      expect((await stateOf(page)).approvals.filter(approval => approval.cardId === cards[0].id)).toHaveLength(0);
      await expect(mobile.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    }
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[1]).toBe(sendKeys[0]);

    await page.unroute('**/api/terminal-demo/approvals');
    await dialog.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
    const state = await stateOf(page);
    const approvals = state.approvals.filter(approval => approval.cardId === cards[0].id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: 'waiting', version: 1 });
    await expect(mobile.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();
  } finally {
    await cleanup(page, terminals, cards.map(card => card.id));
    await mobile?.context.close();
  }
});

test('ändringsbegäran kräver ny granskning och gamla terminalåtgärder kan inte godkänna en ny version', async ({ page, browser, baseURL }) => {
  const { cards, prefix } = await fixture(page.request);
  const terminals: DemoTerminal[] = [];
  let mobile: Awaited<ReturnType<typeof mobileTerminal>> | undefined;
  await installFixture(page, cards);
  try {
    await loginOffice(page);
    terminals.push(await createTerminal(page, prefix, '1'));
    mobile = await mobileTerminal(browser, baseURL!, terminals[0]);
    const original = await sendToTerminal(page, cards[0].id, terminals[0]);
    await expect(mobile.page.getByRole('button', { name: 'Begär ändring', exact: true })).toBeVisible();
    await mobile.page.getByRole('button', { name: 'Begär ändring', exact: true }).click();
    await expect(mobile.page.getByRole('button', { name: 'Skicka begäran', exact: true })).toBeDisabled();
    await mobile.page.getByRole('radio', { name: 'Fel vikt', exact: true }).check();
    await mobile.page.getByLabel('Beskrivning', { exact: true }).fill('Järnet vägde 84 kilo, kontrollera vågens avläsning.');
    await mobile.page.getByRole('button', { name: 'Skicka begäran', exact: true }).click();
    await expect(mobile.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    await expect(page.locator('.approval-change-request')).toContainText('kontrollera vågens avläsning');
    expect((await approvalOf(page, cards[0].id)).status).toBe('change_requested');
    expect((await page.request.post(`${service}/approvals/${original.id}/attest`, { data: {} })).status()).toBe(409);
    await expect(page.getByRole('button', { name: 'Attestera', exact: true })).toBeDisabled();

    await page.getByLabel('Referens', { exact: true }).fill(`${prefix} rättad referens`);
    await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
    const revised = await sendToTerminal(page, cards[0].id, terminals[0]);
    expect(revised.version).toBe(original.version + 1);
    expect(revised.snapshot.hash).not.toBe(original.snapshot.hash);
    await expect(mobile.page.getByText(`${prefix} rättad referens`, { exact: false })).toBeVisible();
    await expect(mobile.page.getByRole('checkbox')).not.toBeChecked();
    expect((await mobile.page.request.post(`${service}/approvals/${original.id}/respond`, {
      data: { action: 'id_requested', termsAccepted: true },
    })).status()).toBe(409);
    expect((await approvalOf(page, cards[0].id)).status).toBe('waiting');

    // History must show the immutable version the customer actually received,
    // rather than silently opening the revised card with today's reference.
    await page.goto('/kontor#/customer-approvals');
    await page.getByLabel('Sök kundgodkännanden', { exact: true }).fill(String(cards[0].id));
    await page.getByRole('tab', { name: /^Historik/ }).click();
    await page.getByRole('button', {
      name: `Granska avräkningsversion ${original.version} för invägning ${cards[0].id}`, exact: true,
    }).click();
    const originalPreview = page.getByRole('dialog', { name: `Avräkningsversion ${original.version} · INV-${cards[0].id}`, exact: true });
    await expect(originalPreview).toContainText(original.snapshot.reference);
    await expect(originalPreview).not.toContainText(`${prefix} rättad referens`);
    await expect(originalPreview.locator('.terminal-material-table')).toContainText('83 kg');
    await expect(originalPreview.getByRole('button', { name: 'Attestera', exact: true })).toHaveCount(0);
    await originalPreview.getByRole('button', { name: 'Stäng versionsgranskning', exact: true }).click();
    await page.getByRole('tab', { name: /^Aktiva/ }).click();
    await page.getByRole('button', {
      name: `Granska avräkningsversion ${revised.version} för invägning ${cards[0].id}`, exact: true,
    }).click();
    const revisedPreview = page.getByRole('dialog', { name: `Avräkningsversion ${revised.version} · INV-${cards[0].id}`, exact: true });
    await expect(revisedPreview).toContainText(`${prefix} rättad referens`);
    await expect(revisedPreview).not.toContainText(`Referens: ${original.snapshot.reference}`);
    await revisedPreview.getByRole('button', { name: 'Stäng versionsgranskning', exact: true }).click();
    await page.getByRole('button', { name: `Öppna invägning ${cards[0].id}`, exact: true }).click();

    await page.getByRole('button', { name: 'Avsluta kundvisning', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Avsluta visningen', exact: true }).click();
    await expect(mobile.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();
    await expect(mobile.page.getByText(new RegExp(`INV-${cards[0].id}`))).toHaveCount(0);
    expect((await (await mobile.page.request.get(`${service}/session`)).json()).approval).toBeNull();
  } finally {
    await cleanup(page, terminals, cards.map(card => card.id));
    await mobile?.context.close();
  }
});

test('en terminal tillåter en enhet åt gången och avaktivering tar bort kundvisningen', async ({ page, browser, baseURL }) => {
  const { cards, prefix } = await fixture(page.request);
  const terminals: DemoTerminal[] = [];
  const contexts: BrowserContext[] = [];
  await installFixture(page, cards);
  try {
    await loginOffice(page);
    terminals.push(await createTerminal(page, prefix, '1'));
    const original = await mobileTerminal(browser, baseURL!, terminals[0]);
    contexts.push(original.context);
    const duplicateContext = await browser.newContext({ baseURL });
    contexts.push(duplicateContext);
    const duplicate = await duplicateContext.newPage();
    await duplicate.goto('/terminal');
    await duplicate.getByLabel('Inloggningsnamn', { exact: true }).fill(terminals[0].username);
    await duplicate.getByLabel('Lösenord', { exact: true }).fill(password);
    await duplicate.getByRole('button', { name: 'Logga in terminal', exact: true }).click();
    await expect(duplicate.getByRole('alert')).toContainText('används redan på en annan enhet');
    await expect(original.page.getByRole('heading', { name: 'Invänta personal', exact: true })).toBeVisible();

    await sendToTerminal(page, cards[0].id, terminals[0]);
    await expect(original.page.getByText(`Invägningskort INV-${cards[0].id}`, { exact: true })).toBeVisible();
    await page.goto('/kontor#/terminals');
    const terminalCard = page.locator('.terminal-card').filter({ has: page.getByRole('heading', { name: terminals[0].name, exact: true }) });
    await terminalCard.getByRole('button', { name: 'Avaktivera', exact: true }).click();
    await page.locator('form.terminal-dialog').getByRole('button', { name: 'Bekräfta', exact: true }).click();
    await expect(terminalCard).toContainText('Avaktiverad');
    await expect(original.page.getByRole('button', { name: 'Logga in terminal', exact: true })).toBeVisible();
    await expect(original.page.locator('.terminal-material-table')).toHaveCount(0);
    expect((await approvalOf(page, cards[0].id)).status).toBe('cancelled');
    expect((await original.page.request.get(`${service}/session`)).status()).toBe(401);
    await duplicate.getByRole('button', { name: 'Logga in terminal', exact: true }).click();
    await expect(duplicate.getByRole('alert')).toContainText('Fel inloggningsnamn eller lösenord');
  } finally {
    await cleanup(page, terminals, cards.map(card => card.id));
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('attestbehörighet utan läsning av kundgodkännandekön kan attestera en verkligt godkänd version från samma kort', async ({ page, browser, baseURL, request }) => {
  const { cards, prefix } = await fixture(page.request);
  const headers = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
  const originalResponse = await request.get('/api/pricing/state', { headers });
  expect(originalResponse.ok()).toBeTruthy();
  const originalUsers = (await originalResponse.json()).users;
  const attester = { id: `${prefix}-attester`, name: `${prefix} Attesterare`, level: 'Medarbetare' as const,
    permissions: ['view', 'attest'] as const, maxAttest: 1000, ownAttest: false };
  expect((await request.post('/api/pricing/users', { headers, data: { users: [...originalUsers, attester] } })).ok()).toBeTruthy();
  await installFixture(page, cards);
  let terminal: DemoTerminal | undefined;
  let mobile: Awaited<ReturnType<typeof mobileTerminal>> | undefined;
  let approvalId: string | undefined;
  try {
    await loginOffice(page);
    terminal = await createTerminal(page, prefix, '1');
    mobile = await mobileTerminal(browser, baseURL!, terminal);
    const sent = await sendToTerminal(page, cards[0].id, terminal);
    approvalId = sent.id;
    expect((await mobile.page.request.post(`${service}/approvals/${sent.id}/respond`, { data: { action: 'id_requested', termsAccepted: true } })).ok()).toBeTruthy();
    expect((await page.request.post(`${service}/approvals/${sent.id}/confirm-id`, { data: {} })).ok()).toBeTruthy();
    await expect(page.locator('.approval-controls')).toContainText('Godkänd av kund');
    await expect.poll(async () => page.evaluate(id => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === id)?.customerApproval?.status, cards[0].id)).toBe('approved');
    await page.getByRole('button', { name: 'Byt demokonto', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(attester.name) }).click();
    await page.goto(`/kontor#/weighings/${cards[0].id}`);
    await expect.poll(async () => (await page.request.get(`${service}/state`)).status()).toBe(403);
    await expect(page.locator('.office-sidebar').getByRole('button', { name: /^Kundgodkännande/ })).toHaveCount(0);
    await expect(page.locator('.approval-controls')).toHaveCount(0);
    const button = page.locator('.office-card-attest').getByRole('button', { name: 'Attestera', exact: true });
    await expect(button).toBeEnabled();
    const before = page.url();
    await button.click();
    await expect(page.locator('.office-title')).toContainText('Klar för utbetalning');
    await expect(page).toHaveURL(before);
    await expect(page.locator('.office-sidebar').getByRole('button', { name: /^Invägningar(?: \d+ aktiva kort)?$/ })).toHaveClass(/active/);
    const cached = await page.evaluate(id => JSON.parse(localStorage.getItem('jeroc.office.demo.v1')!).cards.find((card: { id: number }) => card.id === id), cards[0].id);
    expect(cached).toMatchObject({ status: 'ready', approvedBy: attester.id, customerApproval: { id: sent.id, status: 'attested' } });
    await page.reload();
    await expect(page.locator('.office-title')).toContainText('Klar för utbetalning');
    await expect(page.locator('.office-card-attest')).toContainText('JEROC-attesterad');
  } finally {
    expect((await request.post(`${service}/staff-session`, { data: { actualUserId: 'admin', effectiveUserId: 'admin' } })).ok()).toBeTruthy();
    if (approvalId) {
      const state = await (await request.get(`${service}/state`)).json() as TerminalDemoState;
      const approval = state.approvals.find(item => item.id === approvalId);
      if (approval && approval.status !== 'attested') await request.post(`${service}/approvals/${approvalId}/cancel`, { data: {} });
    }
    if (terminal) await request.patch(`${service}/terminals/${terminal.id}`, { data: { active: false } });
    await mobile?.context.close();
    expect((await request.post('/api/pricing/users', { headers, data: { users: originalUsers } })).ok()).toBeTruthy();
  }
});
