import { randomInt, randomUUID } from 'node:crypto';
import { expect, test, request as apiRequest, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard } from '../src/office/model';
import { approveCurrentOfficeCard } from './helpers/customer-approval';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function openCard(page: Page, status: OfficeCard['status'] = 'new') {
  const data = migrateOffice(seedOffice());
  const id = 26_000_000 + randomInt(1_000_000);
  data.cards.push({ ...data.cards.find(card => card.id === 2053)!, id,
    sourceId: randomUUID(), status, origin: '', reference: '', payment: '',
    paymentDetails: undefined, customerApproval: undefined, customerSnapshot: undefined,
    preparedBy: undefined, approvedBy: undefined, audit: [] });
  await page.addInitScript(data => {
    if (!localStorage.getItem('jeroc.office.demo.v1')) localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
  }, data);
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  const imported = await page.request.post('/api/application/office', { headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' }, data: { kind: 'import', data } });
  expect(imported.ok()).toBe(true);
  await page.goto(`/kontor#/weighings/${id}`);
  await expect(page.getByRole('heading', { name: `Invägning #${id}`, exact: true })).toBeVisible();
  return id;
}

test('visuell guidning följer sparade uppgifter och lämnar övriga kort klickbara', async ({ page }) => {
  await openCard(page);
  const customer = page.locator('.office-card-customer');
  const payment = page.locator('.office-card-payment');
  const approval = page.locator('.approval-controls');
  const focus = page.locator('.office-guidance-focus');

  await expect(customer).toHaveClass(/office-guidance-focus/);
  await expect(focus).toHaveCount(1);
  await expect(payment).toHaveClass(/office-guidance-muted/);
  // A muted panel remains usable before its turn in the guide.
  await payment.getByRole('button', { name: 'Kontant', exact: true }).click();
  await expect(payment).toContainText('Kontant betalning vald');
  await expect(customer).toHaveClass(/office-guidance-focus/);

  await page.getByLabel('Ursprungsadress', { exact: true }).fill('Testgatan 4, 761 41 Norrtälje');
  await expect(customer).toHaveClass(/office-guidance-focus/);
  await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
  await expect(payment).toHaveClass(/office-guidance-focus/);
  await expect(focus).toHaveCount(1);
  await payment.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  await expect(approval).toHaveClass(/office-guidance-focus/);
  await expect(focus).toHaveCount(1);
  await expect(page.locator('.office-card-material')).not.toHaveClass(/office-guidance-/);
  await expect(page.getByText(/^(Börja här|Starta här|Nästa steg)$/)).toHaveCount(0);
});

test('guidningen respekterar minskad rörelse och visar inget nästa steg på avslutade kort', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const id = await openCard(page);
  const focused = page.locator('.office-guidance-focus');
  await expect(focused).toHaveCount(1);
  expect(await focused.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.getByLabel('Ursprungsadress', { exact: true }).fill('Testgatan 4, 761 41 Norrtälje');
  await page.getByRole('button', { name: 'Spara referens & ursprung', exact: true }).click();
  await page.locator('.office-card-payment').getByRole('button', { name: 'Kontant', exact: true }).click();
  await page.getByRole('button', { name: 'Spara betalningsuppgift', exact: true }).click();
  const approval = await approveCurrentOfficeCard(page, id);
  const office = await apiRequest.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const session = await office.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } });
    expect(session.ok()).toBe(true);
    const attested = await office.post(`/api/terminal-demo/approvals/${approval.id}/attest`, { data: {} });
    expect(attested.ok()).toBe(true);
    expect((await attested.json()).status).toBe('attested');
  } finally { await office.dispose(); }
  await page.reload();
  await expect(page.locator('.office-guidance-focus')).toHaveCount(0);
  await expect(page.locator('.office-guidance-muted')).toHaveCount(0);
});
