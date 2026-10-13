import { expect, test, type Page } from '@playwright/test';
import type { EmployeeOverview } from '../src/employee/types';
import type { EmployeeReviewCommand } from '../src/employee/employee-time-review-types';
import type { TimeReviewDetail, TimeReviewStatus } from '../src/office/personnel/review-types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

async function setup(page: Page, initialStatus: TimeReviewStatus = 'draft') {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' }), month = today.slice(0, 7);
  const prior = new Date(`${month}-01T12:00:00Z`); prior.setUTCMonth(prior.getUTCMonth() - 1);
  const closedMonth = prior.toISOString().slice(0, 7), first = `${closedMonth}-01`, second = `${closedMonth}-02`;
  const companyId = 'employee-review-company';
  const controls = { personId: 'review-person-a', name: 'Mira Månadsrapport', denied: false,
    status: initialStatus, revision: initialStatus === 'draft' ? 0 : 3, version: initialStatus === 'draft' ? 0 : 1,
    approvedVersion: initialStatus === 'reopened' || initialStatus === 'approved' ? 1 : 0,
    holdRead: undefined as { ready: () => void; gate: Promise<void>; finished: boolean } | undefined };
  const writes: { command: EmployeeReviewCommand; company: string | undefined; month: string | null }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const requirement = { enabled: true, mode: 'fixed' as const, dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5],
    effectiveFrom: first, enforcementFrom: first, timeSource: 'clock' as const, revision: 1 };
  const timeDay = (date: string) => ({ date, expectedMinutes: 480, recordedMinutes: 480, missingMinutes: 0,
    automaticMinutes: 0, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'complete' as const,
    timeSource: 'clock' as const, clockMinutes: 480, breakMinutes: 30, allocatedMinutes: 300, unallocatedMinutes: 180 });
  function overview(url: URL): EmployeeOverview {
    const date = url.searchParams.get('date') ?? today, bootstrap = url.pathname.endsWith('/session') || url.searchParams.get('view') === 'bootstrap';
    const day = { ...timeDay(date), timeSource: date === first ? 'clock' as const : 'workorder' as const,
      reviewLocked: controls.personId === 'review-person-a' && date.startsWith(closedMonth) && ['submitted', 'approved'].includes(controls.status),
      ...(date.startsWith(closedMonth) ? { reviewStatus: controls.status } : {}) };
    return { person: { id: controls.personId, name: controls.name, kind: 'employee', userId: `${controls.personId}-user`,
      role: 'Medarbetare', team: 'Gården', siteIds: ['norrtalje'], phone: '', email: '' }, companyId, companyName: 'Tidreview testbolag',
      today, date, month: url.searchParams.get('month') ?? date.slice(0, 7), monthLoaded: !bootstrap, revision: 100,
      capabilities: { employeeTime: true, assignedOrders: false, yardWork: false, manageTimeRequirements: false },
      sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], activeSiteId: 'norrtalje', requirement,
      gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day],
      selectedDay: { ...day, entries: date === second ? [{ id: 'manual-review-entry', revision: 1, source: 'manual', date,
        startMinute: 480, endMinute: 960, breakMinutes: 0, minutes: 480, activity: 'Administration', note: '' }] : [],
        schedules: [], absences: [], orders: [], clockSessions: [] },
      clock: { enabled: false, source: 'workorder', revision: 0, status: 'off', serverNow: new Date().toISOString(),
        activeSession: null, workSeconds: 0, breakSeconds: 0 },
      orders: [], activeWork: null, leaveRequests: [], summary: { expectedMinutes: 480, recordedMinutes: 480, missingMinutes: 0 },
      balances: { available: false } };
  }
  function detail(selectedMonth: string): TimeReviewDetail {
    const isClosed = selectedMonth === closedMonth, ownOther = controls.personId !== 'review-person-a';
    const status = isClosed && !ownOther ? controls.status : 'draft';
    const version = isClosed && !ownOther ? controls.version : 0, revision = isClosed && !ownOther ? controls.revision : 0;
    const summary = { expectedMinutes: 960, recordedMinutes: ownOther ? 120 : 960, missingMinutes: ownOther ? 840 : 0,
      absenceMinutes: 0, automaticMinutes: 0, manualMinutes: 480, clockMinutes: 480, breakMinutes: 30,
      allocatedMinutes: 300, unallocatedMinutes: 180 };
    const calculatedAt = `${today}T09:00:00.000Z`, submittedAt = `${today}T08:00:00.000Z`, approvedAt = `${today}T08:15:00.000Z`;
    const history: TimeReviewDetail['history'] = [];
    if (version > 0) history.push({ id: 'history-submit', action: 'review.submit', at: submittedAt, actualUserId: 'employee-a', effectiveUserId: 'employee-a',
      reason: '', fromStatus: 'draft', toStatus: 'submitted', version: 1, snapshotHash: 'snapshot-v1' });
    if (controls.approvedVersion && !ownOther) history.push({ id: 'history-approve', action: 'review.approve', at: approvedAt, actualUserId: 'manager', effectiveUserId: 'manager',
      reason: '', fromStatus: 'submitted', toStatus: 'approved', version: controls.approvedVersion, snapshotHash: `snapshot-v${controls.approvedVersion}` });
    if (!ownOther && (initialStatus === 'reopened' || initialStatus === 'returned')) history.push({ id: 'history-return', action: initialStatus === 'reopened' ? 'review.reopen' : 'review.return',
      at: `${today}T08:30:00.000Z`, actualUserId: 'manager', effectiveUserId: 'manager',
      reason: 'Kontrollera första dagens registrering och skicka igen.', fromStatus: initialStatus === 'reopened' ? 'approved' : 'submitted',
      toStatus: initialStatus, version: 1, snapshotHash: 'snapshot-v1' });
    if (version > 1) history.push({ id: 'history-resubmit', action: 'review.submit', at: calculatedAt, actualUserId: 'employee-a', effectiveUserId: 'employee-a',
      reason: '', fromStatus: initialStatus, toStatus: 'submitted', version, snapshotHash: `snapshot-v${version}` });
    return { serverNow: calculatedAt, today, month: selectedMonth,
      person: { id: controls.personId, name: controls.name, team: 'Gården', siteIds: ['norrtalje'] },
      review: { id: `review-${controls.personId}-${selectedMonth}`, personId: controls.personId, month: selectedMonth, status, revision, version,
        submittedAt: version ? submittedAt : null, approvedAt: status === 'approved' ? approvedAt : null,
        returnedAt: status === 'returned' ? calculatedAt : null, reopenedAt: status === 'reopened' ? calculatedAt : null,
        reason: status === 'returned' || status === 'reopened' ? 'Kontrollera första dagens registrering och skicka igen.' : null,
        snapshotHash: version ? `snapshot-v${version}` : null, stale: false },
      period: { month: selectedMonth, isClosed, source: status === 'approved' ? 'approved' : status === 'submitted' ? 'submitted' : 'live',
        sourceHash: 'snapshot-v1', calculatedAt, summary,
        days: [
          { ...timeDay(`${selectedMonth}-01`), requirement, entries: [], clockSessions: [] },
          { ...timeDay(`${selectedMonth}-02`), timeSource: 'workorder', clockMinutes: 0, manualMinutes: 480, breakMinutes: 0,
            allocatedMinutes: 0, unallocatedMinutes: 0, requirement: { ...requirement, timeSource: 'workorder' }, entries: [], clockSessions: [] },
        ], issues: isClosed ? [] : [{ code: 'period_not_closed', severity: 'blocking' }] }, history,
      versions: Array.from({ length: version }, (_, index) => ({ version: index + 1, sourceHash: `snapshot-v${index + 1}`, calculatedAt,
        submittedAt, approvedAt: index + 1 === controls.approvedVersion ? approvedAt : null, summary })),
      capabilities: { canSubmit: isClosed && ['draft', 'returned', 'reopened'].includes(status), canWithdraw: status === 'submitted',
        canApprove: false, canReturn: false, canReopen: false, canExport: false } };
  }
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/employee/time-review') {
      if (controls.denied) return route.fulfill({ status: 403, json: { error: 'Din åtkomst till månadsrapporten har återkallats.' } });
      const selectedMonth = url.searchParams.get('month') ?? month;
      if (request.method() === 'POST') {
        const command = request.postDataJSON() as EmployeeReviewCommand;
        writes.push({ command, company: request.headers()['x-employee-company'], month: url.searchParams.get('month') });
        expect(command.revision).toBe(controls.revision);
        controls.revision++;
        if (command.action === 'review.submit') { controls.status = 'submitted'; controls.version++; }
        else controls.status = 'draft';
      }
      const result = detail(selectedMonth), held = request.method() === 'GET' ? controls.holdRead : undefined;
      if (held) { controls.holdRead = undefined; held.ready(); await held.gate; }
      return route.fulfill({ json: result }).catch(error => { if (!/cancel|abort|closed|interception/i.test(String(error))) throw error; }).finally(() => { if (held) held.finished = true; });
    }
    if (['/api/employee/session', '/api/employee/overview'].includes(url.pathname)) return route.fulfill({ json: overview(url) });
    if (url.pathname === '/api/platform/tenant-context') return route.fulfill({ json: { companyId, companyName: 'Tidreview testbolag' } });
    if (url.pathname === '/api/application/mobile') return route.fulfill({ json: { data: { version: 1, drafts: [], customers: [] }, revision: 0 } });
    if (url.pathname === '/api/application/revision') return route.fulfill({ json: { revision: 0 } });
    return route.fulfill({ status: 404, json: { error: 'Anropet ingår inte i det lokala testet.' } });
  });
  return { controls, writes, errors, today, month, closedMonth, first, second };
}

test('egen månadsrapport visar pågående preview och skickar eller återtar bara explicit vald avslutad månad', async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto('/#/time');
  await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Min månadsrapport/ }).click();
  await expect(page.getByRole('heading', { name: 'Min månadsrapport', exact: true })).toBeVisible();
  await expect(page.getByText(/Pågående månad · förhandsvisning/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skicka till chef', exact: true })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  await page.getByLabel('Månad', { exact: true }).fill(fixture.closedMonth);
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toContainText('16 h');
  await expect(page.getByRole('region', { name: 'Dagar i månadsrapporten', exact: true })).toContainText('Stämpelklocka');
  await expect(page.getByRole('region', { name: 'Dagar i månadsrapporten', exact: true })).toContainText('Arbetsorder och manuell tid');
  const submit = page.getByRole('button', { name: 'Skicka till chef', exact: true });
  await submit.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByText('Din månadsrapport är skickad till chef.', { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({ command: { action: 'review.submit', month: fixture.closedMonth, revision: 0 },
    company: 'employee-review-company', month: fixture.closedMonth });
  expect(Object.keys(fixture.writes[0].command).sort()).toEqual(['action', 'month', 'requestId', 'revision']);
  expect(fixture.writes[0].command.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText(/Dina tidsregistreringar är låsta/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Öppna dagen', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Återta för rättelse', exact: true }).click();
  await expect(page.getByText('Rapporten är återtagen för rättelse.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skicka till chef', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Återta för rättelse', exact: true })).toBeVisible();
  fixture.controls.status = 'approved'; fixture.controls.approvedVersion = fixture.controls.version; fixture.controls.revision++;
  await page.getByRole('button', { name: 'Uppdatera min månadsrapport', exact: true }).click();
  await expect(page.getByText('Godkänd av chef', { exact: true })).toBeVisible();
  await expect(page.getByText(/Den godkända perioden är låst/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Återta för rättelse', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Skicka till chef', exact: true })).toHaveCount(0);
  expect(fixture.writes.map(value => value.command.action)).toEqual(['review.submit', 'review.withdraw', 'review.submit']);
  await page.screenshot({ path: info.outputPath('employee-review-approved-390.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`/#/time?date=${fixture.second}&register=1`);
  await expect(page.getByRole('heading', { name: 'Låst tidrapport', exact: true })).toBeVisible();
  await expect(page.getByLabel('Från', { exact: true })).toHaveCount(0);
  await page.goto(`/#/time?date=${fixture.first}&clock=new`);
  await expect(page.getByRole('heading', { name: 'Låst tidrapport', exact: true })).toBeVisible();
  await expect(page.getByLabel('Instämpling', { exact: true })).toHaveCount(0);
  await page.goto(`/#/time?date=${fixture.second}`);
  await expect(page.getByText(/Månadsrapporten är godkänd/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ändra tid / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Registrera tid', exact: true })).toHaveCount(0);
  await page.goto(`/#/time?date=${fixture.first}`);
  await expect(page.getByText(/Månadsrapporten är godkänd/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Komplettera stämpling', exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('egen månadsrapport visar chefkommentar och rättelselänk för återlämnad eller återöppnad version', async ({ browser }, info) => {
  for (const status of ['returned', 'reopened'] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });
    const page = await context.newPage(), fixture = await setup(page, status);
    await page.goto(`/#/time/review?month=${fixture.closedMonth}`);
    await expect(page.getByText('Chefens kommentar', { exact: true })).toBeVisible();
    await expect(page.getByText('Kontrollera första dagens registrering och skicka igen.', { exact: true }).first()).toBeVisible();
    if (status === 'reopened') await expect(page.getByText(/Öppnad för rättelse. Det tidigare godkännandet/)).toBeVisible();
    await page.getByRole('button', { name: 'Öppna dag för rättelse', exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`#/time\\?date=${fixture.first}$`));
    await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
    await page.goBack();
    await page.getByRole('button', { name: 'Skicka igen till chef', exact: true }).click();
    await expect(page.getByText('Din månadsrapport är skickad till chef.', { exact: true })).toBeVisible();
    await page.getByText('Granskningshistorik', { exact: true }).click();
    await expect(page.locator('.employee-review-history')).toContainText('Version 2');
    if (status === 'reopened') {
      await expect(page.locator('.employee-review-history')).toContainText('Godkänd av chef · Version 1');
      await expect(page.locator('.employee-review-history')).toContainText('Öppnad för rättelse · Version 1');
      await page.screenshot({ path: info.outputPath('employee-review-history-390.png') });
    }
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0].command).toMatchObject({ action: 'review.submit', revision: 3, month: fixture.closedMonth });
    expect(fixture.errors).toEqual([]);
    await context.close();
  }
});

test('egen månadsrapport rensar nekad åtkomst och ignorerar tidigare kontos sena privata svar', async ({ page }) => {
  const fixture = await setup(page, 'returned');
  await page.goto(`/#/time/review?month=${fixture.closedMonth}`);
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toContainText('Mira Månadsrapport');
  fixture.controls.denied = true;
  await page.getByRole('button', { name: 'Uppdatera min månadsrapport', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Din åtkomst till månadsrapporten har återkallats.');
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Dagar i månadsrapporten', exact: true })).toHaveCount(0);
  await expect(page.getByText('Chefens kommentar', { exact: true })).toHaveCount(0);
  fixture.controls.denied = false;
  await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toBeVisible();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const held = { ready, gate, finished: false }; fixture.controls.holdRead = held;
  await page.getByRole('button', { name: 'Uppdatera min månadsrapport', exact: true }).click();
  await started;
  fixture.controls.personId = 'review-person-b'; fixture.controls.name = 'Nya Personens Rapport';
  await page.evaluate(() => window.dispatchEvent(new Event('jeroc:employee-session-check')));
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toContainText('Nya Personens Rapport');
  await expect(page.getByText('Mira Månadsrapport', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Chefens kommentar', { exact: true })).toHaveCount(0);
  release(); await expect.poll(() => held.finished).toBe(true);
  await expect(page.getByRole('region', { name: 'Månadens sammanställning', exact: true })).toContainText('Nya Personens Rapport');
  await expect(page.getByText('Chefens kommentar', { exact: true })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.errors).toEqual([]);
});
