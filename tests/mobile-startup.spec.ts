import { test, expect, type Page } from '@playwright/test';
import type { EmployeeOverview } from '../src/employee/types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function startupFixture(page: Page, hangSession = false) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const requests: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseFull!: () => void, releaseSession!: () => void;
  const fullReady = new Promise<void>(done => { releaseFull = done; });
  const sessionReady = new Promise<void>(done => { releaseSession = done; });
  const day = (date: string, recordedMinutes = 0) => ({ date, expectedMinutes: 480, recordedMinutes, missingMinutes: 0,
    automaticMinutes: 0, manualMinutes: recordedMinutes, absenceMinutes: 0, jobsCount: 0,
    status: 'not_required' as const, timeSource: 'workorder' as const });
  const lean: EmployeeOverview = {
    revision: 1, companyId: 'startup-fixture-company', companyName: 'Starttest AB', today, month: today.slice(0, 7), date: today, monthLoaded: false,
    person: { id: 'startup-person', userId: 'startup-user', name: 'Niklas Starttest', kind: 'employee', username: 'niklas', role: 'Invägare',
      team: 'Gården', phone: '', email: '', siteIds: ['norrtalje'] },
    activeSiteId: 'norrtalje', sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }],
    capabilities: { yardWork: true, assignedOrders: false, employeeTime: true, manageTimeRequirements: false },
    requirement: { enabled: false, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 1, timeSource: 'workorder' },
    gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day(today)],
    selectedDay: { ...day(today), entries: [], schedules: [], absences: [], orders: [], clockSessions: [] },
    clock: { enabled: false, source: 'workorder', status: 'out', revision: 0, serverNow: new Date().toISOString(), activeSession: null, workSeconds: 0, breakSeconds: 0 },
    orders: [], activeWork: null, leaveRequests: [], summary: { expectedMinutes: 480, recordedMinutes: 0, missingMinutes: 0 }, balances: { available: false },
  };
  const last = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  const full: EmployeeOverview = { ...lean, revision: 2, monthLoaded: true,
    days: Array.from({ length: last.getUTCDate() }, (_, index) => {
      const date = `${today.slice(0, 7)}-${String(index + 1).padStart(2, '0')}`; return day(date, date === today ? 240 : 0);
    }), selectedDay: { ...lean.selectedDay, recordedMinutes: 240, manualMinutes: 240 },
    summary: { expectedMinutes: 9600, recordedMinutes: 240, missingMinutes: 0 },
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => undefined);
    if (url.pathname === '/api/employee/session') {
      if (hangSession) await sessionReady;
      return send(lean);
    }
    if (url.pathname === '/api/employee/overview') {
      if (url.searchParams.get('view') === 'bootstrap') return send(lean);
      await fullReady; return send(full);
    }
    if (url.pathname === '/api/employee/logout') return send({ ok: true });
    if (url.pathname === '/api/employee/demo-config') return send({ enabled: false, companyName: 'Starttest AB' });
    if (url.pathname === '/api/platform/tenant-context') return send({ companyId: 'startup-fixture-company', companyName: 'Starttest AB' });
    if (url.pathname === '/api/application/mobile') return send({ data: { version: 1, drafts: [], customers: [] }, revision: 0 });
    if (url.pathname === '/api/application/revision') return send({ revision: 0 });
    return send({ error: 'Unused local startup test endpoint' }, 404);
  });
  return { requests, errors, releaseFull, releaseSession,
    fullRequests: () => requests.filter(value => value.includes('/api/employee/overview') && !value.includes('view=bootstrap')) };
}

test('home opens from the lean session and loads a delayed full month only when entering Tid', async ({ page }) => {
  const fixture = await startupFixture(page);
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Hej, Niklas!', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Din dag', exact: true })).toBeVisible();
    expect(fixture.requests.filter(value => value.includes('/api/employee/session')).every(value => value.includes('view=bootstrap'))).toBe(true);
    expect(fixture.fullRequests()).toHaveLength(0);
    await page.getByRole('button', { name: 'Tid', exact: true }).click();
    await expect.poll(() => fixture.fullRequests().length).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
    await expect(page.getByText('Hämtar månadens registrerade tider…', { exact: true })).toBeVisible();
    fixture.releaseFull();
    await expect(page.locator('.employee-hours-total')).toContainText('4 h registrerat');
    await expect(page.getByText('Hämtar månadens registrerade tider…', { exact: true })).toHaveCount(0);
    expect(fixture.errors).toEqual([]);
  } finally { fixture.releaseFull(); fixture.releaseSession(); }
});

test('a stalled session times out into a usable login screen and its late response cannot restore the old boot', async ({ page }) => {
  const fixture = await startupFixture(page, true);
  try {
    await page.clock.install();
    await page.goto('/');
    await expect(page.getByText('Öppnar appen…', { exact: true })).toBeVisible();
    await expect.poll(() => fixture.requests.some(value => value.includes('/api/employee/session'))).toBe(true);
    await page.clock.fastForward(15100);
    await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
    await expect(page.getByText('Servern svarade inte i tid. Kontrollera anslutningen och försök igen.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeEnabled();
    fixture.releaseSession();
    await page.clock.fastForward(1000);
    await expect(page.getByRole('heading', { name: 'Hej, Niklas!', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
    expect(fixture.fullRequests()).toHaveLength(0); expect(fixture.errors).toEqual([]);
  } finally { fixture.releaseFull(); fixture.releaseSession(); }
});

test('a pending month response from the previous session cannot reopen the employee after logout', async ({ page }) => {
  const fixture = await startupFixture(page);
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Hej, Niklas!', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tid', exact: true }).click();
    await expect.poll(() => fixture.fullRequests().length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Profil', exact: true }).click();
    await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
    const lateMonth = page.waitForResponse(response => response.url().includes('/api/employee/overview') && !response.url().includes('view=bootstrap'));
    fixture.releaseFull();
    await (await lateMonth).finished();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(page.getByRole('heading', { name: 'Hej, Niklas!', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
    expect(fixture.errors).toEqual([]);
  } finally { fixture.releaseFull(); fixture.releaseSession(); }
});
