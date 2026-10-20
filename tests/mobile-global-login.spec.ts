import { expect, test } from '@playwright/test';
import type { EmployeeOverview } from '../src/employee/types';
import { emptyEmployeeFleet } from './helpers/employee-fleet';

test('ren Live mobilstart loggar in direkt med e-post utan företag eller demoväljare och binder följande läsningar till svaret', async ({ page }) => {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const personId = 'live-login-person', companyId = 'live-login-company';
  const day = { date: today, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0, automaticMinutes: 0,
    manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'not_required' as const };
  const overview: EmployeeOverview = { revision: 1, companyId, companyName: 'Liveinloggning AB',
    person: { id: personId, name: 'Anna Direkt', username: 'anna.direkt', email: 'anna@example.invalid',
      phone: '', role: 'Medarbetare', team: '', kind: 'employee', siteIds: ['site-live'] },
    capabilities: { yardWork: false, assignedOrders: false, employeeTime: false, manageTimeRequirements: false },
    sites: [{ id: 'site-live', name: 'Liveanläggningen', active: true }], activeSiteId: 'site-live',
    today, date: today, month: today.slice(0, 7), monthLoaded: false,
    requirement: { enabled: false, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 0 },
    gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day],
    selectedDay: { ...day, entries: [], schedules: [], absences: [], orders: [] },
    orders: [], leaveRequests: [], activeWork: null, summary: { expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 },
    balances: { available: false } };
  const requests: { path: string; company?: string; person?: string; body?: unknown }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let authenticated = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), headers = request.headers();
    requests.push({ path: url.pathname, company: headers['x-employee-company'], person: headers['x-employee-person'],
      ...(request.method() === 'POST' ? { body: request.postDataJSON() } : {}) });
    if (url.pathname === '/api/employee/demo-config') return route.fulfill({ json: { enabled: false, accounts: { niklas: false, admin: false } } });
    if (url.pathname === '/api/employee/session') return route.fulfill({ status: authenticated ? 200 : 401,
      json: authenticated ? overview : { error: 'Logga in på ditt personalkonto.' } });
    if (url.pathname === '/api/employee/login') {
      expect(url.searchParams.get('view')).toBe('bootstrap');
      expect(request.postDataJSON()).toEqual({ username: 'anna@example.invalid', password: 'Private-Browser-Fixture-Only!' });
      expect(headers['x-client-company']).toBeUndefined(); expect(headers['x-employee-company']).toBeUndefined();
      authenticated = true; return route.fulfill({ json: overview });
    }
    if (url.pathname === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (url.pathname === '/api/employee/overview') return route.fulfill({ json: overview });
    if (url.pathname === '/api/employee/sickness') return route.fulfill({ status: 403, json: { error: 'Inte aktiverat i testfixturen.' } });
    return route.fulfill({ status: 404, json: { error: 'Använd ingen annan API-väg i denna fixtur.' } });
  });
  await page.goto('/mobil/');
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka' })).toBeVisible();
  await expect(page.getByText('Logga in med ditt användarnamn eller din e-postadress.', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Demoinloggning' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Logga in som/ })).toHaveCount(0);
  await page.getByLabel('Användarnamn', { exact: true }).fill('anna@example.invalid');
  await page.getByLabel('Lösenord', { exact: true }).fill('Private-Browser-Fixture-Only!');
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),/ })).toBeVisible();
  await expect(page.getByText('Anna', { exact: true })).toBeVisible();
  await expect(page.getByText('Liveanläggningen', { exact: true })).toBeVisible();
  expect(requests.filter(request => request.path === '/api/employee/login')).toHaveLength(1);
  expect(requests.some(request => request.path === '/api/platform/tenant-context')).toBe(false);
  await expect.poll(() => requests.filter(request => request.path === '/api/employee/fleet').length).toBeGreaterThan(0);
  for (const request of requests.filter(request => request.path === '/api/employee/fleet')) {
    expect(request.company).toBe(companyId); expect(request.person).toBe(personId);
  }
  expect(errors).toEqual([]);
});
