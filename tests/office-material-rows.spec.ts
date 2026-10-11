import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { OfficeCard, OfficeUser, Permission } from '../src/office/model';
import type { TerminalDemoState } from '../src/office/terminal-demo-types';
import { createOfficeCard, readOffice } from './helpers/financial-card';
import { approveCurrentOfficeCard } from './helpers/customer-approval';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
const materialRights: Permission[] = ['weighingAddArticle', 'weighingEditWeight', 'weighingRemoveArticle'];

async function materialPermissions(page: Page, enabled: Permission[]) {
  const response = await page.request.get('/api/pricing/state', { headers: admin });
  expect(response.ok(), await response.text()).toBe(true);
  const { users } = await response.json() as { users: OfficeUser[] };
  const user = users.find(person => person.id === 'kajsa')!;
  const original = [...user.permissions];
  user.permissions = [...user.permissions.filter(permission => !materialRights.includes(permission)), ...enabled];
  const saved = await page.request.post('/api/pricing/users', { headers: admin, data: { users } });
  expect(saved.ok(), await saved.text()).toBe(true);
  return async () => {
    const current = await page.request.get('/api/pricing/state', { headers: admin, timeout: 5000 });
    const state = await current.json() as { users: OfficeUser[] };
    state.users.find(person => person.id === 'kajsa')!.permissions = original;
    const restored = await page.request.post('/api/pricing/users', { headers: admin, data: { users: state.users }, timeout: 5000 });
    expect(restored.ok(), await restored.text()).toBe(true);
  };
}

async function openCard(page: Page, rows: OfficeCard['rows'], userName = 'Kajsa Nilsson') {
  const { cardId } = await createOfficeCard(page.request, { customerId: 'customer-build', rows });
  await page.goto('/kontor');
  await page.getByRole('button', { name: new RegExp(userName) }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  await page.goto(`/kontor#/weighings/${cardId}`);
  await expect(page.getByRole('heading', { name: `Invägning #${cardId}`, exact: true })).toBeVisible();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  return cardId;
}

async function storedCard(page: Page, id: number) {
  return (await readOffice(page.request)).cards.find(card => card.id === id)!;
}

function materialRow(page: Page, name: string) {
  return page.locator('.office-card-material tbody tr').filter({ hasText: name });
}

async function editWeight(page: Page, name: string, value: string) {
  await materialRow(page, name).getByRole('button', { name: 'Ändra vikt', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ändra vikt', exact: true });
  await dialog.getByLabel('Vikt (kg)', { exact: true }).fill(value);
  return dialog;
}

test('viktbehörighet ändrar kg och belopp beständigt men tillåter inte borttagning med noll', async ({ page }) => {
  const restore = await materialPermissions(page, ['weighingEditWeight']);
  try {
    const id = await openCard(page, [{ articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 }]);
    await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toHaveCount(0);
    await expect(materialRow(page, 'Koppar klass 1').getByRole('button', { name: 'Ta bort artikel Koppar klass 1', exact: true })).toHaveCount(0);
    const dialog = await editWeight(page, 'Koppar klass 1', '-1');
    await dialog.getByRole('button', { name: 'Spara vikt', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('0');
    await dialog.getByRole('button', { name: 'Spara vikt', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/behörighet.*ta bort|ta bort.*behörighet/i);
    expect((await storedCard(page, id)).rows[0].weight).toBe(72);
    await dialog.getByLabel('Vikt (kg)', { exact: true }).fill('80,125');
    await dialog.getByRole('button', { name: 'Spara vikt', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await storedCard(page, id)).rows[0].weight).toBe(80.125);
    const saved = await storedCard(page, id);
    expect(saved.pricingTotal).toBe(Math.round(80.125 * saved.rows[0].price * 100) / 100);
    expect(saved.rows[0].price).toBeGreaterThan(0);
    expect(saved.audit.at(-1)!.text).toMatch(/vikt.*ändrad|ändrad.*vikt/i);
    await page.reload();
    await expect(materialRow(page, 'Koppar klass 1')).toContainText('80,125 kg');
  } finally { await restore(); }
});

test('borttagningsbehörighet kräver bekräftelse och ger inte rätt att ändra vikt', async ({ page }) => {
  const restore = await materialPermissions(page, ['weighingRemoveArticle']);
  try {
    const id = await openCard(page, [
      { articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 },
      { articleId: 'iron', weight: 10, tier: 'C', price: 1.92 },
    ]);
    const copper = materialRow(page, 'Koppar klass 1');
    await expect(copper.getByRole('button', { name: 'Ändra vikt', exact: true })).toHaveCount(0);
    await copper.getByRole('button', { name: 'Ta bort artikel Koppar klass 1', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Ta bort artikel', exact: true });
    await expect(dialog).toContainText('Koppar klass 1');
    await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
    expect((await storedCard(page, id)).rows).toHaveLength(2);
    await copper.getByRole('button', { name: 'Ta bort artikel Koppar klass 1', exact: true }).click();
    await dialog.getByRole('button', { name: 'Ta bort artikel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await storedCard(page, id)).rows.length).toBe(1);
    const saved = await storedCard(page, id);
    expect(saved.rows[0].articleId).toBe('iron');
    expect(saved.pricingTotal).toBe(Math.round(saved.rows[0].weight * saved.rows[0].price * 100) / 100);
    expect(saved.audit.at(-1)!.text).toContain('Koppar klass 1');
    await page.reload();
    await expect(materialRow(page, 'Koppar klass 1')).toHaveCount(0);
  } finally { await restore(); }
});

test('noll vikt tar bort den farliga artikeln och miljökortet, sista raden kan också tas bort', async ({ page }) => {
  const restore = await materialPermissions(page, ['weighingEditWeight', 'weighingRemoveArticle']);
  try {
    const id = await openCard(page, [
      { articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 },
      { articleId: 'lead-battery', weight: 10, tier: 'C', price: 3.6 },
    ]);
    const environment = page.getByRole('region', { name: 'Miljö och mottagning', exact: true });
    await expect(environment).toBeVisible();
    let dialog = await editWeight(page, 'Blybatterier', '0');
    await dialog.getByRole('button', { name: 'Spara och ta bort artikel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await storedCard(page, id)).rows.length).toBe(1);
    await expect(materialRow(page, 'Blybatterier')).toHaveCount(0);
    await expect(environment).toHaveCount(0);
    await page.reload();
    await expect(environment).toHaveCount(0);
    dialog = await editWeight(page, 'Koppar klass 1', '0');
    await dialog.getByRole('button', { name: 'Spara och ta bort artikel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await storedCard(page, id)).rows.length).toBe(0);
    await expect(page.getByRole('button', { name: 'Visa på kundterminal', exact: true })).toBeDisabled();
  } finally { await restore(); }
});

test('ändrad vikt avbryter väntande kundgranskning och frigör terminalen', async ({ page }) => {
  const restore = await materialPermissions(page, ['weighingEditWeight']);
  let terminalId: string | undefined;
  try {
    const id = await openCard(page, [{ articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 }]);
    const username = `material-${randomUUID().slice(0, 10)}`;
    const staff = await page.request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' } });
    expect(staff.ok(), await staff.text()).toBe(true);
    const create = await page.request.post('/api/terminal-demo/terminals', { data: {
      name: username, username, password: 'local-material-test', siteId: 'norrtalje',
    } });
    expect(create.ok(), await create.text()).toBe(true);
    terminalId = (await create.json()).id;
    const login = await page.request.post('/api/terminal-demo/login', { data: { username, password: 'local-material-test' } });
    expect(login.ok(), await login.text()).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: /^Visa (på kundterminal|ny version på kundterminal)$/ }).click();
    await page.getByLabel('Terminal för kundgodkännande', { exact: true }).selectOption(terminalId!);
    await page.getByRole('button', { name: 'Visa på terminal', exact: true }).click();
    await expect(page.locator('.approval-controls')).toContainText('Inväntar kund');
    const before = await storedCard(page, id);
    const approvalId = before.customerApproval!.id;
    const dialog = await editWeight(page, 'Koppar klass 1', '80');
    await dialog.getByRole('button', { name: 'Spara vikt', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await storedCard(page, id)).rows[0].weight).toBe(80);
    const terminalState = await page.request.get('/api/terminal-demo/state');
    const state = await terminalState.json() as TerminalDemoState;
    expect(state.approvals.find(approval => approval.id === approvalId)?.status).toBe('cancelled');
    expect(state.terminals.find(terminal => terminal.id === terminalId)?.busy).toBe(false);
    expect((await storedCard(page, id)).idVerified).toBe(false);
    await expect(page.locator('.approval-controls')).not.toContainText('Inväntar kund');
  } finally {
    if (terminalId) {
      await page.request.post('/api/terminal-demo/staff-session', { data: { actualUserId: 'admin', effectiveUserId: 'admin' }, timeout: 3000 }).catch(() => {});
      await page.request.patch(`/api/terminal-demo/terminals/${terminalId}`, { data: { active: false }, timeout: 3000 }).catch(() => {});
    }
    await restore();
  }
});

test('Attestera ligger till höger om Returnera och attesterade kort saknar materialåtgärder', async ({ page }) => {
  const id = await openCard(page, [{ articleId: 'copper-1', weight: 72, tier: 'B', price: 73.8 }], 'Systemadmin');
  const approval = await approveCurrentOfficeCard(page, id);
  const panel = page.locator('.office-card-attest');
  const attest = panel.getByRole('button', { name: 'Attestera', exact: true });
  const returnButton = panel.getByRole('button', { name: 'Returnera för komplettering', exact: true });
  await expect(attest).toBeEnabled();
  const positions = await Promise.all([returnButton.boundingBox(), attest.boundingBox()]);
  expect(positions[1]!.x).toBeGreaterThanOrEqual(positions[0]!.x + positions[0]!.width);
  await attest.click();
  await expect.poll(async () => (await storedCard(page, id)).status).toBe('ready');
  for (const name of [/^Lägg till artikel$/, /^Ändra vikt$/, /^Ta bort artikel /])
    await expect(page.locator('.office-card-material').getByRole('button', { name })).toHaveCount(0);
  const state = await page.request.get('/api/terminal-demo/state');
  expect((await state.json() as TerminalDemoState).approvals.find(item => item.id === approval.id)?.status).toBe('attested');
});
