import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { employeeRecoveryKey } from '../src/employee/cache';
import type { AuthenticatedPlatformSession } from '../src/platform/types';

const mobileCache = employeeRecoveryKey('jeroc-demo', 'person-mobile-demo');
const initialAdminPassword = 'Browser-Isolation-Initial-2026!';
const administratorPassword = 'Changed-Shared-Browser-Administrator-2026!';

async function login(page: Page) {
  const authenticated = await page.request.post('/api/employee/login', { data: { username: 'niklas', password: 'Demo123!' } });
  expect(authenticated.ok(), await authenticated.text()).toBe(true);
  await page.goto('/mobil#/yard');
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(`${key}.postgres-imported`), mobileCache)).toBe('yes');
}

async function loginOffice(context: BrowserContext) {
  // The office has its own genuine platform session. Demo actor headers do not
  // grant this browser access to an employee's company or replace authentication.
  const authenticated = await context.request.post('/api/platform/login', {
    data: { username: 'admin', password: initialAdminPassword },
  });
  expect(authenticated.ok(), await authenticated.text()).toBe(true);
  const initial: AuthenticatedPlatformSession = await authenticated.json();
  expect(initial.mustChangePassword).toBe(true);
  const changed = await context.request.post('/api/platform/change-password', {
    headers: { 'X-Platform-CSRF': initial.csrfToken, 'X-Platform-Generation': String(initial.generation) },
    data: { currentPassword: initialAdminPassword, newPassword: administratorPassword },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const session: AuthenticatedPlatformSession = await changed.json();
  expect(session.authenticated).toBe(true);
  expect(session.mustChangePassword).toBe(false);
  expect(session.organisationId).toBe('jeroc-demo');
  return {
    'X-Platform-CSRF': session.csrfToken,
    'X-Platform-Generation': String(session.generation),
    'X-Platform-Organisation-Id': session.organisationId!,
  };
}

test('mobilens färdiga vägning visas på kontoret och återläses från servern', async ({ page, browser }) => {
  await login(page);
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar klass 1' }).click();
  await page.getByRole('button', { name: 'Välj Koppar klass 1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('17');
  await page.getByRole('button', { name: /Färdigvägt/ }).click();
  await page.getByRole('button', { name: /Lägg till kund/ }).click();
  await page.locator('.customer-choice').filter({ hasText: 'Bygg & Riv AB' }).click();
  await page.getByRole('button', { name: /Referens & ursprung/ }).click();
  await page.getByLabel('Materialets ursprungsadress (valfritt)').fill('Testgatan 17, 761 41 Norrtälje');
  await page.getByRole('button', { name: 'Spara uppgifter' }).click();
  await page.getByRole('button', { name: 'Spara färdig vägning' }).click();
  await expect(page.getByRole('heading', { name: 'Vägningen är sparad' })).toBeVisible();
  const id = await page.evaluate(() => location.hash.split('/')[2]);
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 1440, height: 1000 } });
  try {
    const headers = await loginOffice(context);
    const readOffice = async () => {
      const response = await context.request.get('/api/application/office', { headers });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    await expect.poll(async () => (await readOffice()).data.cards.filter((card: { sourceId: string }) => card.sourceId === id).length).toBe(1);
    const card = (await readOffice()).data.cards.find((value: { sourceId: string }) => value.sourceId === id);
    const office = await context.newPage();
    await office.goto(`/kontor#/weighings/${card.id}`);
    await expect(office.locator('.office-title')).toContainText(`Invägning #${card.id}`);
    await expect(office.getByLabel('Ursprungsadress', { exact: true })).toHaveValue('Testgatan 17, 76141 Norrtälje');

    // Remove the optional read cache: the saved weight must come back from the
    // real employee endpoint, rather than only from optimistic browser state.
    await page.evaluate(key => localStorage.removeItem(key), mobileCache);
    const fetched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/application/mobile' && response.request().method() === 'GET');
    await page.reload();
    const response = await fetched;
    expect(response.ok(), await response.text()).toBe(true);
    expect((await response.json()).data.drafts).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: 'ready' })]));
    await expect(page.getByTestId('total-weight')).toHaveText('17 kg');
  } finally {
    await context.close();
  }
});

test('oläsbar lokal cache bevaras och serveruppgifterna kan ändå öppnas', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, '{invalid legacy cache'), mobileCache);
  const archived = page.waitForResponse(response => new URL(response.url()).pathname === '/api/application/mobile'
    && response.request().method() === 'POST' && response.request().postDataJSON()?.kind === 'archive');
  await login(page);
  const response = await archived;
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON().data.raw).toBe('{invalid legacy cache');
  expect(await page.evaluate(key => localStorage.getItem(`${key}.legacy-before-postgres`), mobileCache)).toBe('{invalid legacy cache');
  await expect(page.getByRole('button', { name: /Starta invägning/ })).toBeVisible();
});
