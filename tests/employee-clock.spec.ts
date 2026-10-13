import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { EmployeeOverview, EmployeeClockSession, EmployeeClockAction } from '../src/employee/types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
test.describe.configure({ mode: 'serial' });

/** UI-only transport fixtures. Real cookie, tenant isolation, server timestamps
 * and idempotence are separately exercised by personnel-tools-api.test.mjs. */
async function clockFixture(page: Page, initial = { enabled: true, blocked: false }) {
  const controls = { ...initial };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const previous = new Date(`${date}T12:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1);
  const missingDate = previous.toISOString().slice(0, 10);
  const queries: string[] = [], mutations: EmployeeClockAction[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let status: 'working' | 'break' | 'out' = 'out', revision = 0, session: EmployeeClockSession | null = null;
  const person = { id: 'clock-ui-person', userId: 'clock-ui-user', name: 'Niklas Test', kind: 'employee' as const,
    role: 'Gårdsarbetare', team: 'Gården', phone: '', email: '', siteIds: ['norrtalje'], username: 'niklas' };
  const problematic: EmployeeClockSession = { id: 'clock-missing-out', revision: 1, startedAt: `${missingDate}T05:00:00.000Z`,
    endedAt: null, breaks: [], workSeconds: 0, breakSeconds: 0, dayWorkSeconds: 0, dayBreakSeconds: 0, requiresCorrection: true };
  function overview(url: URL): EmployeeOverview {
    const selectedDate = url.searchParams.get('date') ?? date, source = controls.enabled ? 'clock' as const : 'workorder' as const;
    const current = controls.blocked ? problematic : session, currentStatus = controls.blocked ? 'working' as const : status;
    const completed = !controls.blocked && session?.endedAt ? [session] : controls.blocked && selectedDate === missingDate ? [problematic] : [];
    const day = { date: selectedDate, expectedMinutes: 480, recordedMinutes: completed.length && !controls.blocked ? 60 : 0,
      missingMinutes: controls.blocked ? 480 : 0, automaticMinutes: 0, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0,
      status: controls.blocked ? 'empty' as const : 'not_required' as const, timeSource: source, clockMinutes: completed.length && !controls.blocked ? 60 : 0,
      breakMinutes: completed.length && !controls.blocked ? 5 : 0, allocatedMinutes: 0, unallocatedMinutes: completed.length && !controls.blocked ? 60 : 0 };
    return { revision, companyId: 'clock-ui-company', companyName: 'JEROC Återvinning AB', person, today: date,
      month: url.searchParams.get('month') ?? selectedDate.slice(0, 7), date: selectedDate, activeSiteId: 'norrtalje',
      capabilities: { yardWork: true, assignedOrders: false, employeeTime: true, manageTimeRequirements: false },
      sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }],
      requirement: { enabled: true, mode: 'schedule', effectiveFrom: missingDate, enforcementFrom: missingDate, revision: 1, timeSource: source },
      gate: { blocked: controls.blocked, ...(controls.blocked ? { date: missingDate, timeSource: 'clock' as const } : {}),
        expectedMinutes: controls.blocked ? 480 : 0, recordedMinutes: 0, missingMinutes: controls.blocked ? 480 : 0 },
      days: [day], selectedDay: { ...day, entries: [], schedules: [{ id: 'clock-ui-schedule', personId: person.id, weekdays: [1, 2, 3, 4, 5],
        startMinute: 420, endMinute: 960, effectiveFrom: missingDate, revision: 1 }], absences: [], orders: [], clockSessions: completed },
      clock: { enabled: controls.enabled, source, revision, status: currentStatus, serverNow: new Date().toISOString(),
        activeSession: current && !current.endedAt ? current : null, workSeconds: current?.workSeconds ?? 0,
        breakSeconds: current?.breakSeconds ?? 0, requiresCorrection: controls.blocked },
      orders: [], leaveRequests: [], activeWork: null, summary: { expectedMinutes: 480, recordedMinutes: day.recordedMinutes, missingMinutes: day.missingMinutes },
      balances: { available: false } };
  }
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const send = (body: unknown, statusCode = 200) => route.fulfill({ status: statusCode, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.startsWith('/api/employee/')) {
      queries.push(`${request.method()} ${url.pathname}`);
      if (url.pathname === '/api/employee/clock' && request.method() === 'POST') {
        const value = request.postDataJSON() as EmployeeClockAction;
        mutations.push(value);
        expect(value.revision).toBe(revision); expect(value.requestId).toMatch(/^[a-f0-9-]{36}$/);
        expect(Object.keys(value).every(key => ['action', 'revision', 'requestId', 'sessionId'].includes(key))).toBe(true);
        revision++;
        if (value.action === 'clock.in') {
          status = 'working'; session = { id: 'clock-ui-session', revision: 1, startedAt: new Date(Date.now() - 3600000).toISOString(),
            endedAt: null, breaks: [], workSeconds: 3600, breakSeconds: 0, dayWorkSeconds: 3600, dayBreakSeconds: 0 };
        } else if (session && value.action === 'clock.pause') {
          status = 'break'; session = { ...session, revision: session.revision + 1, workSeconds: 3600, breakSeconds: 300,
            breaks: [{ startedAt: new Date(Date.now() - 300000).toISOString(), endedAt: null }] };
        } else if (session && value.action === 'clock.resume') {
          status = 'working'; session = { ...session, revision: session.revision + 1,
            breaks: session.breaks.map(pause => ({ ...pause, endedAt: new Date().toISOString() })) };
        } else if (session && value.action === 'clock.out') {
          status = 'out'; session = { ...session, revision: session.revision + 1, endedAt: new Date().toISOString(), dayBreakSeconds: 300 };
        }
        return send(overview(url));
      }
      if (['/api/employee/session', '/api/employee/overview'].includes(url.pathname)) return send(overview(url));
      if (url.pathname === '/api/employee/equipment') return send({ items: [], assignments: [], events: [], revision: 0 });
      return send({ error: 'Unused employee test endpoint' }, 404);
    }
    if (url.pathname === '/api/application/mobile') return send({ data: { version: 1, drafts: [], customers: [] }, revision: 0 });
    if (url.pathname === '/api/application/revision') return send({ revision: 0 });
    if (url.pathname === '/api/platform/tenant-context') return send({ companyId: 'clock-ui-company', companyName: 'JEROC Återvinning AB' });
    return send({ error: 'Unused test endpoint' }, 404);
  });
  return { controls, queries, mutations, errors, date, missingDate };
}

test('home clock starts, pauses with orange live break, resumes and closes into Tid history without second-by-second fetches', async ({ page }) => {
  const fixture = await clockFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hej, Niklas!' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Stämpelklocka', exact: true });
  await card.getByRole('button', { name: 'Stämpla in', exact: true }).click();
  const strip = page.getByRole('button', { name: 'Stämpelklocka: Instämplad. Öppna Tid', exact: true });
  await expect(strip).toBeVisible(); await expect(card.getByText('Instämplad', { exact: true })).toBeVisible();
  await mkdir('/tmp/jeroc-personnel-tools-review', { recursive: true });
  await page.screenshot({ path: '/tmp/jeroc-personnel-tools-review/employee-clock-active-390.png', fullPage: true });
  const beforeTime = await strip.locator('.employee-clock-strip-duration').innerText(), requestsBefore = fixture.queries.length;
  const workingColour = await strip.evaluate(element => getComputedStyle(element).backgroundColor);
  await expect.poll(() => strip.locator('.employee-clock-strip-duration').innerText()).not.toBe(beforeTime);
  expect(fixture.queries).toHaveLength(requestsBefore);
  await card.getByRole('button', { name: 'Ta rast', exact: true }).click();
  const paused = page.getByRole('button', { name: 'Stämpelklocka: På rast. Öppna Tid', exact: true });
  await expect(paused).toBeVisible(); await expect(paused).toHaveClass(/break/);
  await expect(card.getByText('På rast', { exact: true })).toBeVisible();
  const colour = await paused.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(colour).not.toBe(workingColour);
  await page.screenshot({ path: '/tmp/jeroc-personnel-tools-review/employee-clock-paused-390.png', fullPage: true });
  await card.getByRole('button', { name: 'Återuppta arbete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stämpelklocka: Instämplad. Öppna Tid', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Stämpla ut', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Stämpla in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Tid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
  const history = page.getByRole('region', { name: 'Stämplade pass', exact: true });
  await expect(history.locator('.employee-clock-session')).toHaveCount(1);
  await expect(history).toContainText('01:00:00'); await expect(history).toContainText('Rast 00:05:00');
  expect(fixture.mutations.map(value => value.action)).toEqual(['clock.in', 'clock.pause', 'clock.resume', 'clock.out']);
  expect(new Set(fixture.mutations.map(value => value.requestId)).size).toBe(4); expect(fixture.errors).toEqual([]);
});

test('disabled clock stays hidden, while a missing clock day opens Tid and the existing pass correction', async ({ page }) => {
  const fixture = await clockFixture(page, { enabled: false, blocked: false });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hej, Niklas!' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stämpelklocka', exact: true })).toHaveCount(0);
  await expect(page.locator('.employee-clock-strip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stämpla in', exact: true })).toHaveCount(0);
  fixture.controls.enabled = true; fixture.controls.blocked = true;
  await page.reload();
  const gate = page.getByRole('dialog');
  await expect(gate).toBeVisible(); await expect(gate).toContainText('Tid saknas');
  await gate.getByRole('button', { name: 'Komplettera stämpling', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/time\\?date=${fixture.missingDate}$`));
  await expect(gate).toHaveCount(0);
  const history = page.getByRole('region', { name: 'Stämplade pass', exact: true });
  await expect(history).toContainText('Passet behöver rättas');
  await history.getByRole('button', { name: /Ändra stämplat pass/ }).click();
  await expect(page.getByRole('heading', { name: 'Rätta stämplat pass', exact: true })).toBeVisible();
  await expect(page.getByLabel('Instämpling', { exact: true })).not.toHaveValue('');
  await expect(page.getByLabel('Utstämpling', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Anledning till rättelse', { exact: true })).toBeVisible();
  expect(fixture.mutations).toHaveLength(0); expect(fixture.errors).toEqual([]);
});
