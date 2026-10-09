import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { customerStats } from '../src/office/customer-model';
import type { TerminalApproval } from '../src/office/terminal-demo-types';
import { approveCustomerCard } from './helpers/customer-approval';
import { completedOfficeCard, createOfficeCard, readOffice } from './helpers/financial-card';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function ready(page: Page) {
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
}
async function login(page: Page, name: string) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await ready(page);
}
async function openBuildCustomer(page: Page, tab = 'overview') {
  await page.goto(`/kontor#/customers/customer-build?tab=${tab}`);
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Bygg & Riv AB', exact: true })).toBeVisible();
}

test('kundregistret kan sökas på registreringsnummer och alla fem flikar behåller kundmenyn', async ({ page }) => {
  await login(page, 'Lars Andersson');
  await page.goto('/kontor#/customers');
  await page.getByLabel('Sök kunder', { exact: true }).fill('ABC123');
  const list = page.locator('.office-main');
  await expect(list.getByText('Bygg & Riv AB', { exact: true }).first()).toBeVisible();
  await expect(list.getByText('Erik Johansson', { exact: true })).toHaveCount(0);
  await openBuildCustomer(page);
  for (const name of ['Översikt', 'Vägningar', 'Priser', 'Uppgifter & betalning', 'Rättelser & saldo']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Kunder', exact: true })).toHaveClass(/active/);
    await expect(page.getByRole('heading', { name: 'Bygg & Riv AB', exact: true })).toBeVisible();
  }
  await page.reload();
  await ready(page);
  await expect(page.getByRole('tab', { name: 'Rättelser & saldo', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('nya kunder och ändrade kontaktuppgifter sparas vid omladdning', async ({ page, request }) => {
  const name = `Regression Återbruk ${randomUUID().slice(0, 8)} AB`;
  await login(page, 'Kajsa Nilsson');
  await page.goto('/kontor#/customers');
  await page.getByRole('button', { name: 'Skapa kund', exact: true }).click();
  await page.getByLabel('Kundtyp', { exact: true }).selectOption('Företag');
  await page.getByLabel('Namn', { exact: true }).fill(name);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559911-8899');
  await page.getByLabel('Telefon', { exact: true }).fill('0701234567');
  await page.getByLabel('E-post', { exact: true }).fill('kontor@example.test');
  await page.getByLabel('Adress', { exact: true }).fill('Testgatan 12');
  await page.getByLabel('Postnummer', { exact: true }).fill('76130');
  await page.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect.poll(async () => (await readOffice(request)).customers.some(c => c.name === name)).toBe(true);
  await page.reload();
  await ready(page);
  await page.getByRole('tab', { name: 'Uppgifter & betalning', exact: true }).click();
  await expect(page.getByLabel('Adress', { exact: true })).toHaveValue('Testgatan 12');
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('0701234567');
  await page.getByLabel('Kontaktperson', { exact: true }).fill('Kajsa Test');
  await page.getByRole('button', { name: 'Spara kunduppgifter', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kunduppgifterna är sparade.' })).toBeVisible();
  await expect.poll(async () => (await readOffice(request)).customers.find(c => c.name === name)?.contactPerson).toBe('Kajsa Test');
  await page.reload();
  await ready(page);
  await expect(page.getByLabel('Kontaktperson', { exact: true })).toHaveValue('Kajsa Test');
  const customer = (await readOffice(request)).customers.find(c => c.name === name)!;
  expect(customer).toMatchObject({ type: 'Företag', number: '559911-8899', contactPerson: 'Kajsa Test' });
  expect(customer.audit!.length).toBeGreaterThan(0);
});

test('sparad Swishprofil fylls på ett nytt kort utan att skriva om redan attesterade kort', async ({ page, request }) => {
  const base = await readOffice(request), source = base.customers.find(c => c.id === 'customer-build')!;
  const customer = { ...structuredClone(source), id: `swish-${randomUUID()}`, number: `TEST-${randomUUID()}`, customerNumber: `TEST-${randomUUID().slice(0, 8)}`, name: `Swish Kund ${randomUUID().slice(0, 8)}` };
  delete customer.paymentProfile;
  const originalFixture = await completedOfficeCard(request, { customer, pay: false });
  const editable = await createOfficeCard(request, { customerId: 'customer-erik' });
  const original = (await readOffice(request)).cards.find(c => c.id === originalFixture.cardId)!;
  await login(page, 'Kajsa Nilsson');
  await page.goto(`/kontor#/customers/${customer.id}?tab=details`);
  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('0701234567');
  await page.getByLabel('Mottagare', { exact: true }).fill(customer.name);
  await page.getByRole('button', { name: 'Spara betalningsprofil', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Betalningsuppgifterna är sparade.' })).toBeVisible();
  await expect.poll(async () => (await readOffice(request)).customers.find(c => c.id === customer.id)?.paymentProfile?.method).toBe('swish');
  await page.reload();
  await ready(page);
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue('0701234567');
  await page.goto(`/kontor#/weighings/${editable.cardId}`);
  await page.getByLabel('Kund på vägningen', { exact: true }).selectOption(customer.id);
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue('0701234567');
  await expect(page.getByLabel('Mottagare', { exact: true })).toHaveValue(customer.name);
  expect((await readOffice(request)).cards.find(c => c.id === originalFixture.cardId)).toEqual(original);
});

test('betalningsmetoder bevarar inmatning och validerar bara den valda metoden', async ({ page, request }) => {
  const { cardId } = await createOfficeCard(request);
  await login(page, 'Kajsa Nilsson');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('1234567890');
  await page.getByLabel('Kontohavare', { exact: true }).fill('Testkund');
  await page.getByRole('button', { name: 'Swish', exact: true }).click();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('123');
  await page.getByLabel('Mottagare', { exact: true }).fill('Testkund');
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Bankkonto', exact: true }).click();
  await expect(page.getByLabel('Clearingnummer', { exact: true })).toHaveValue('8327');
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveValue('1234567890');
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).cards.find(c => c.id === cardId)?.paymentDetails).toMatchObject({ method: 'bank', clearing: '8327', account: '1234567890', holder: 'Testkund' });
  await page.getByRole('button', { name: 'Kontant', exact: true }).click();
  await expect(page.getByLabel('Clearingnummer', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect.poll(async () => (await readOffice(request)).cards.find(c => c.id === cardId)?.paymentDetails?.method).toBe('cash');
});

test('kundkort utan pris- eller betalningsbehörighet visar inte ekonomiska uppgifter eller ändringsformulär', async ({ page, request }) => {
  const base = await readOffice(request), name = `Kundläsare ${randomUUID().slice(0, 8)}`;
  const user = { ...base.users.find(u => u.id === 'kajsa')!, id: `customer-reader-${randomUUID()}`, name, level: 'Medarbetare' as const, permissions: ['view'] as ('view')[], ownAttest: false };
  const response = await request.post('/api/pricing/users', { headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' }, data: { users: [...base.users, user] } });
  expect(response.ok(), await response.text()).toBeTruthy();
  // The unauthenticated demo picker contains its four bootstrap accounts.
  // Read the shared user catalog through an existing admin session first.
  await login(page, 'Systemadmin');
  await page.getByRole('button', { name: 'Byt demokonto', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await ready(page);
  await openBuildCustomer(page, 'prices');
  await expect(page.getByRole('button', { name: /Spara kundpris|Lägg till kundpris/ })).toHaveCount(0);
  await expect(page.getByText('84,00', { exact: false })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Uppgifter & betalning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Spara kunduppgifter', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Spara betalningsprofil', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
});

test('spara på saldo efter attest skapar ingen utbetalning och senare kontantutbetalning registreras separat', async ({ page, request }) => {
  const fixture = await createOfficeCard(request, { paymentDetails: { method: 'balance' } });
  const { cardId } = fixture, approval = await approveCustomerCard(request, fixture.card, { customer: fixture.customer });
  try {
    await login(page, 'Anna Nilsson');
    await page.goto(`/kontor#/attest/${cardId}`);
    await page.getByRole('button', { name: 'Attestera', exact: true }).click();
    await expect(page.locator('.office-title')).toContainText('Sparat på saldo');
    await expect.poll(async () => (await readOffice(request)).cards.find(c => c.id === cardId)?.status).toBe('balance');
    const held = await readOffice(request);
    expect(held.payments.filter(p => p.cardId === cardId)).toHaveLength(0);
    await page.locator('.office-sidebar').getByRole('button', { name: 'Utbetalningar', exact: true }).click();
    await expect(page.getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Historik', exact: true }).click();
    await page.getByRole('button', { name: `Öppna viktkort ${cardId}`, exact: true }).click();
    await page.getByRole('button', { name: 'Betala ut från saldo', exact: true }).click();
    await page.getByRole('button', { name: 'Kontant', exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Registrera utbetalning', exact: true }).click();
    await expect(page.locator('.office-title')).toContainText('Demoutbetald');
    await expect.poll(async () => (await readOffice(request)).cards.find(c => c.id === cardId)?.status).toBe('paid');
    const paid = await readOffice(request), journal = paid.payments.filter(p => p.cardId === cardId);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ cardId, method: 'cash' });
    expect(paid.cards.find(c => c.id === cardId)?.paymentDetails).toEqual({ method: 'balance' });
    await page.reload();
    await ready(page);
    await expect(page.getByRole('button', { name: 'Betala ut från saldo', exact: true })).toHaveCount(0);
  } finally {
    await request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } });
    const response = await request.get('/api/terminal-demo/state');
    if (response.ok()) for (const item of (await response.json()).approvals as TerminalApproval[]) {
      if (item.cardId === cardId && !['attested', 'cancelled'].includes(item.status)) await request.post(`/api/terminal-demo/approvals/${item.id}/cancel`, { data: {} });
    }
    const closed = await request.patch(`/api/terminal-demo/terminals/${approval.terminalId}`, { data: { active: false } });
    expect(closed.ok(), await closed.text()).toBeTruthy();
  }
});

test('rättelser går via granskning till kundens saldo och pluskort utan att det betalda originalet ändras', async ({ page, request }) => {
  const { cardId, customer } = await completedOfficeCard(request);
  await login(page, 'Lars Andersson');
  const original = (await readOffice(request)).cards.find(c => c.id === cardId)!;
  async function createAndApprove(delta: string, document: string) {
    await page.goto(`/kontor#/payments/${cardId}?tab=history`);
    await page.getByLabel('Viktändring, kg', { exact: true }).fill(delta);
    await page.getByLabel('Orsak / rättelseunderlag', { exact: true }).fill('Kontrollerad felregistrering');
    await page.getByLabel('Rättelseunderlag', { exact: true }).fill(document);
    await page.getByRole('button', { name: 'Skapa rättelseutkast', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: document });
    await expect(row).toContainText('Utkast');
    await expect.poll(async () => (await readOffice(request)).corrections.find(c => c.document === document)?.status).toBe('draft');
    await row.getByRole('button', { name: 'Skicka rättelse för attest', exact: true }).click();
    await expect(row).toContainText('Väntar på attest');
    await expect.poll(async () => (await readOffice(request)).corrections.find(c => c.document === document)?.status).toBe('attest');
    await row.getByRole('button', { name: 'Godkänn rättelse', exact: true }).click();
    await expect.poll(async () => (await readOffice(request)).corrections.find(c => c.document === document)?.status).toBe('approved');
    return (await readOffice(request)).corrections.find(c => c.document === document)!;
  }
  const suffix = randomUUID().slice(0, 8), minus = await createAndApprove('-10', `RU-TEST-MINUS-${suffix}`);
  await page.goto(`/kontor#/customers/${customer.id}?tab=balance`);
  await expect(page.getByRole('heading', { name: customer.name, exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: `Rättelse R-${minus.id}` })).toContainText(/[-−]19,20/);
  let saved = await readOffice(request);
  expect(saved.cards.find(c => c.id === cardId)).toEqual(original);
  const asOf = new Date(Date.now() + 86_400_000).toISOString();
  expect(customerStats(saved, customer.id, asOf)).toMatchObject({ totalKg: 114, totalValue: 218.88 });
  const plus = await createAndApprove('5', `RU-TEST-PLUS-${suffix}`);
  saved = await readOffice(request);
  const child = saved.cards.find(c => c.sourceCorrectionId === plus.id)!;
  expect(child).toMatchObject({ status: 'ready', kind: 'correction', customerId: customer.id, pricingTotal: 9.6 });
  expect(saved.cards.find(c => c.id === cardId)).toEqual(original);
  expect(customerStats(saved, customer.id, asOf)).toMatchObject({ totalKg: 119, totalValue: 228.48, weighingCount: 1, balance: -9.6 });
  await page.goto(`/kontor#/customers/${customer.id}?tab=balance`);
  await page.getByRole('button', { name: new RegExp(`R-${plus.id} · Järnskrot`) }).click();
  await page.getByRole('button', { name: 'Öppna utbetalningskort', exact: true }).click();
  await expect(page.locator('.office-title')).toContainText(`Invägning #${child.id}`);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Utbetalningar', exact: true })).toHaveClass(/active/);
});
