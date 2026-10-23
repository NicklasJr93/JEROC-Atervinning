import { expect, test, type Page } from '@playwright/test';
test.setTimeout(60_000);

// The view/controller harness uses in-memory demo data; the integrated case
// uses its own browser-local storage. Neither sends a real payment or API call.
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => { const list: string[] = []; errors.set(page, list); page.on('pageerror', error => list.push(error.message)); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });
async function harness(page: Page) {
  await page.goto('/bokforing/suite/payroll-workspace.js');
  await page.setContent('<link rel="stylesheet" href="/bokforing/suite/styles.css"><link rel="stylesheet" href="/bokforing/suite/payroll-workspace.css"><main id="workspace"></main><p role="alert"></p>');
  await page.evaluate(async () => {
    const corePath = '/bokforing/suite/core.js';
    const financePath = '/bokforing/suite/finance.js';
    const viewPath = '/bokforing/suite/payroll-workspace.js';
    const { createEmptyState } = await import(corePath);
    const { createEmployee } = await import(financePath);
    const view = await import(viewPath);
    let state = createEmployee(createEmptyState(), { name: 'Fiktiv Testperson', payType: 'monthly', baseCents: 3_200_000 });
    const render = () => { document.querySelector('#workspace')!.innerHTML = view.renderWorkspace(state); };
    document.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement;
      if (!form.matches('[data-feature-form="payroll-v2"]')) return;
      event.preventDefault();
      try { state = view.handleAction(state, form.dataset.action, Object.fromEntries(new FormData(form))); render(); document.querySelector('[role="alert"]')!.textContent = ''; }
      catch (error) { document.querySelector('[role="alert"]')!.textContent = (error as Error).message; }
    });
    render();
  });
}

async function profile(page: Page) {
  await page.locator('.payroll-person-card > summary').first().click();
  const form = page.locator('[data-feature-form="payroll-v2"][data-action="profile"]').first();
  await form.locator('[name="birthYear"]').fill('1985');
  await form.locator('[name="agreementNote"]').fill('Granskat fiktivt anställningsavtal');
  await form.locator('[name="domesticOrdinary"]').check();
  await form.locator('[name="reviewed"]').check();
  await form.getByRole('button', { name: 'Spara granskad löneprofil' }).click();
  await expect(page.getByText('Granskad profil', { exact: true })).toBeVisible();
}

test('bokforing-payroll: individual review, official tax, posting and simulated payment', async ({ page }) => {
  await harness(page);
  await profile(page);
  const form = page.locator('[data-feature-form="payroll-v2"][data-action="create"]');
  await form.locator('[name="date"]').fill('2026-10-25');
  await form.getByRole('checkbox', { name: 'Fiktiv Testperson' }).check();
  await form.getByRole('button', { name: 'Beräkna individuella lönebesked' }).click();
  await expect(page.locator('.payroll-batch')).toContainText('6 190,00');
  await expect(page.locator('.payroll-batch')).toContainText('25 810,00');
  const post = page.locator('form[data-action="post"]');
  await post.locator('[name="reviewed"]').check();
  await post.getByRole('button', { name: 'Bokför granskad lön' }).click();
  await expect(page.locator('.payroll-batch-header')).toContainText('Bokförd');
  await page.locator('form[data-action="pay"]').getByRole('button', { name: 'Registrera nettolöneutbetalning' }).click();
  await expect(page.locator('.payroll-batch-header')).toContainText('Utbetald');
  await expect(page.getByRole('link', { name: 'Hämta granskningsunderlag CSV' })).toHaveAttribute('download', 'loneunderlag-2026-10.csv');
  await expect(page.locator('[role="alert"]')).toBeEmpty();
});

test('bokforing-payroll: mobile profile and unsupported tax year show actionable error', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await harness(page);
  await profile(page);
  const form = page.locator('[data-feature-form="payroll-v2"][data-action="create"]');
  await form.locator('[name="date"]').fill('2027-01-25');
  await form.getByRole('checkbox', { name: 'Fiktiv Testperson' }).check();
  await form.getByRole('button', { name: 'Beräkna individuella lönebesked' }).click();
  await expect(page.locator('[role="alert"]')).toContainText('räkenskapsåret');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
  await expect(page.locator('.payroll-batch')).toHaveCount(0);
});

test('bokforing-payroll: integrated app persists a reviewed payroll and its payment', async ({ page }) => {
  await page.goto('/bokforing/index.html#payroll-v2');
  await expect(page.getByRole('heading', { name: 'Individuell lönehantering' })).toBeVisible();
  await profile(page);
  await page.getByText('Omfattning, källor och tidigare demokörningar', { exact: true }).click();
  await page.getByRole('button', { name: 'Ta bort äldre obokfört utkast' }).click();
  const create = page.locator('[data-feature-form="payroll-v2"][data-action="create"]');
  await create.locator('[name="date"]').fill('2026-10-25');
  await create.locator('[name^="include:"]').first().check();
  await create.getByRole('button', { name: 'Beräkna individuella lönebesked' }).click();
  const post = page.locator('form[data-action="post"]');
  await expect(post).toBeVisible();
  await post.locator('[name="reviewed"]').check();
  await post.getByRole('button', { name: 'Bokför granskad lön' }).click();
  await expect(page.locator('.payroll-batch-header')).toContainText('Bokförd');
  await page.locator('form[data-action="pay"]').getByRole('button', { name: 'Registrera nettolöneutbetalning' }).click();
  await expect(page.locator('.payroll-batch-header')).toContainText('Utbetald');
  await page.reload();
  await expect(page.locator('.payroll-batch-header')).toContainText('Utbetald');
  await expect(page.locator('.payroll-batch')).toContainText('25 810,00');
});
