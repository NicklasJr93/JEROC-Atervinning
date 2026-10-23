import { expect, test, type Page } from '@playwright/test';

test.setTimeout(60_000);

async function harness(page: Page) {
  await page.goto('/bokforing/suite/payroll-workspace.js');
  await page.setContent('<link rel="stylesheet" href="/bokforing/suite/styles.css"><link rel="stylesheet" href="/bokforing/suite/payroll-workspace.css"><main id="workspace"></main><p role="alert"></p>');
  await page.evaluate(async () => {
    const corePath = '/bokforing/suite/core.js', financePath = '/bokforing/suite/finance.js', enginePath = '/bokforing/suite/payroll-engine.js', viewPath = '/bokforing/suite/payroll-workspace.js';
    const { createEmptyState } = await import(corePath), { createEmployee } = await import(financePath), engine = await import(enginePath), view = await import(viewPath);
    let state = createEmployee(createEmptyState(), { name: 'Fiktiv Semesterperson', payType: 'monthly', baseCents: 3_200_000 });
    state = engine.savePayrollProfile(state, { employeeId: state.employees[0].id, date: '2026-10-01', birthYear: 1985, taxMode: 'table', table: 32, column: 1, weeklyHoursHundredths: 4000, deductionHourlyCents: 20000, vacationMethod: 'same-pay', vacationSupplementBps: 43, vacationPercentBps: 1200, paidVacationDays: 25, agreementNote: 'Granskat fiktivt semesterunderlag', reviewed: true, domesticOrdinary: true });
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

async function createSalary(page: Page) {
  const form = page.locator('form[data-action="create"]');
  await form.locator('[name="date"]').fill('2026-10-25');
  await form.locator('[name^="include:"]').check();
  return form;
}

test('payroll completion: earned vacation balance is reserved in the real salary form', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await harness(page);
  await page.getByText('Beräkna och fastställ semesterår', { exact: true }).click();
  const year = page.locator('form[data-action="vacation-year"]');
  await year.locator('[name="employeeId"]').selectOption({ label: 'Fiktiv Semesterperson' });
  await year.locator('[name="date"]').fill('2026-10-01');
  await year.locator('[name="reference"]').fill('Granskat semesterår 2025/2026');
  await year.locator('[name="qualifyingAbsenceReviewed"]').check();
  await year.locator('[name="reviewed"]').check();
  await year.getByRole('button', { name: 'Fastställ semesterår' }).click();
  await expect(page.locator('.payroll-vacation-balance')).toContainText('25 + 0');
  const form = await createSalary(page);
  await form.locator('details > summary').click();
  await form.locator('[name^="vacationYear:"]').selectOption({ index: 1 });
  await form.locator('[name^="vacationDays:"]').fill('2');
  await form.getByRole('button', { name: 'Beräkna individuella lönebesked' }).click();
  await expect(page.locator('.payroll-vacation-balance')).toContainText('23');
  await expect(page.locator('.payroll-slip')).toContainText('275,20');
  const post = page.locator('form[data-action="post"]');
  await post.locator('[name="reviewed"]').check();
  await post.getByRole('button', { name: 'Bokför granskad lön' }).click();
  await expect(page.locator('.payroll-batch-header')).toContainText('Bokförd');
  await expect(page.locator('[role="alert"]')).toBeEmpty();
  expect(errors).toEqual([]);
});

test('payroll completion: paid salary can be reclaimed and collected without deleting original salary', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await harness(page);
  const form = await createSalary(page);
  await form.getByRole('button', { name: 'Beräkna individuella lönebesked' }).click();
  await page.locator('form[data-action="post"] [name="reviewed"]').check();
  await page.getByRole('button', { name: 'Bokför granskad lön' }).click();
  await page.getByRole('button', { name: 'Registrera nettolöneutbetalning' }).click();
  await page.getByText('Rätta utbetald lön genom bruttolöneåterkrav', { exact: true }).click();
  const recovery = page.locator('form[data-action="recovery"]');
  await recovery.locator('[name="date"]').fill('2026-10-28');
  await recovery.locator('[name="gross"]').fill('1000');
  await recovery.locator('[name="reason"]').fill('Överbetald fiktiv lön');
  await recovery.locator('[name="reference"]').fill('KRAV-01');
  await recovery.locator('[name="reviewed"]').check();
  await recovery.locator('[name="agiCorrectionConfirmed"]').check();
  await recovery.getByRole('button', { name: 'Bokför separat bruttolöneåterkrav' }).click();
  await expect(page.locator('.payroll-recovery-card')).toContainText('Fordran kvarstår');
  await expect(page.locator('.payroll-batch-header')).toContainText('Utbetald');
  await page.getByText('Rättat AGI-underlag 2026-10', { exact: true }).click();
  await expect(page.locator('.payroll-recoveries table')).toContainText('31 000,00');
  await expect(page.locator('.payroll-recoveries table')).toContainText('6 190,00');
  const payment = page.locator('form[data-action="recovery-payment"]');
  await payment.locator('[name="date"]').fill('2026-10-29');
  await payment.locator('[name="amount"]').fill('1000,01');
  await payment.locator('[name="reference"]').fill('BANK-01');
  await payment.getByRole('button', { name: 'Registrera mottagen återbetalning' }).click();
  await expect(page.locator('[role="alert"]')).toContainText('överstiger');
  await payment.locator('[name="amount"]').fill('1000');
  await payment.getByRole('button', { name: 'Registrera mottagen återbetalning' }).click();
  await expect(page.locator('.payroll-recovery-card')).toContainText('Återbetalt');
  await expect(page.locator('.payroll-batch-header')).toContainText('Utbetald');
  await expect(page.locator('[role="alert"]')).toBeEmpty();
  expect(errors).toEqual([]);
});
