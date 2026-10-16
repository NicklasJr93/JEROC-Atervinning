import { expect, test } from '@playwright/test';
import { STORE_KEY, seedDemo } from '../src/model';
import { employeeIdentity, employeeRecoveryKey, legacyEmployeeRecoveryKey } from '../src/employee/cache';
import { sharedBusinessCacheKey } from '../src/shared-data';
import { emptyEmployeeFleet } from './helpers/employee-fleet';

test('mobile recovery, price and pending keys remain company-specific even when person IDs collide', () => {
  const personId = 'shared-person-id';
  const a = employeeRecoveryKey('company-a', personId), b = employeeRecoveryKey('company-b', personId);
  expect(a).not.toBe(b);
  expect(sharedBusinessCacheKey(STORE_KEY, { employee: personId, companyId: 'company-a' })).toBe(a);
  expect(sharedBusinessCacheKey(STORE_KEY, { employee: personId, companyId: 'company-b' })).toBe(b);
  expect(`${a}.prices`).not.toBe(`${b}.prices`);
  expect(employeeIdentity('company-a', personId)).not.toBe(employeeIdentity('company-b', personId));
  expect(legacyEmployeeRecoveryKey('company-b', personId)).toBeUndefined();
  expect(legacyEmployeeRecoveryKey('jeroc-demo', personId)).toBe(`${STORE_KEY}.employee.${personId}`);
});

test('another company never imports old employee or Niklas recovery data and displays only its server register', async ({ page }) => {
  const personId = 'person-mobile-demo', companyId = 'company-b';
  const old = seedDemo();
  const writes: unknown[] = [];
  await page.addInitScript(({ personId, old }) => {
    localStorage.setItem('jeroc.mobile.demo.v1', JSON.stringify(old));
    localStorage.setItem(`jeroc.mobile.demo.v1.employee.${personId}`, JSON.stringify(old));
    localStorage.setItem(`jeroc.mobile.demo.v1.company.company-a.employee.${personId}`, JSON.stringify(old));
  }, { personId, old });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: {
      companyId, companyName: 'Bolag B',
      person: { id: personId, username: 'niklas', name: 'Medarbetare B', role: 'Invägare', team: '', siteIds: ['main'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false }, sites: [{ id: 'main', name: 'Bolag B' }],
      today: '2026-10-12', month: '2026-10', date: '2026-10-12', gate: { blocked: false },
      days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] },
    } });
    if (path === '/api/application/mobile') {
      expect(request.headers()['x-employee-company']).toBe(companyId);
      if (request.method() === 'POST') writes.push(request.postDataJSON());
      return route.fulfill({ json: { data: { version: 1, drafts: [], customers: [] }, catalog: [], groups: [], revision: 1 } });
    }
    return route.fulfill({ json: { revision: 1 } });
  });
  await page.goto('/mobil#/yard');
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(({ companyId, personId }) => JSON.parse(localStorage.getItem(`jeroc.mobile.demo.v1.company.${companyId}.employee.${personId}`) ?? 'null'), { companyId, personId }))
    .toEqual({ version: 1, drafts: [], customers: [] });
  expect(writes).toEqual([]);
  expect(await page.evaluate(({ personId }) => JSON.parse(localStorage.getItem(`jeroc.mobile.demo.v1.company.company-a.employee.${personId}`) ?? 'null'), { personId })).toEqual(old);
});
