import { expect, test, type Page } from '@playwright/test';
import type { EmployeeOverview, EmployeeOrder, EmployeeClockAction, EmployeeClockSession } from '../src/employee/types';
import type { EmployeeSicknessCommand, EmployeeSicknessResponse, SicknessCase } from '../src/employee/sickness-types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });
test.describe.configure({ mode: 'serial' });

/** Own-session UI fixtures only. The server separately projects assignments and
 * counts from the authenticated employee; no other employee or live company is read. */
async function homeFixture(page: Page, minimal = false) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const later = new Date(`${today}T12:00:00Z`); later.setUTCDate(later.getUTCDate() + 1);
  const tomorrow = later.toISOString().slice(0, 10);
  const controls = { yardWork: !minimal, assignedOrders: !minimal, activeSiteId: 'norrtalje',
    activity: minimal ? undefined : { date: today, siteId: 'norrtalje', completedWeighings: 4, weighedKg: 1285 },
    clockEnabled: !minimal, clockStatus: (minimal ? 'off' : 'working') as 'working' | 'break' | 'out' | 'off',
    clockError: false, gateBlocked: false, noSites: false, futureOnly: false, sicknessError: false, sicknessCommitError: false,
    holdSickness: undefined as { ready: () => void; gate: Promise<void> } | undefined,
    holdClock: undefined as { ready: () => void; gate: Promise<void> } | undefined };
  const reads: string[] = [], clockWrites: { command: EmployeeClockAction; company?: string }[] = [], siteWrites: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let revision = 10;
  const sickness: EmployeeSicknessResponse = { revision: 0, today, policy: { revision: 0, dailyContact: true, contactByMinute: 480,
    agreement: 'statutory', agreementName: '', calculationConfirmed: false, effectiveFrom: today }, activeCase: null, cases: [], events: [],
    canReport: true, activeClock: !minimal, activeWork: false, notification: '' };
  const sicknessWrites: { command: EmployeeSicknessCommand; person?: string; company?: string }[] = [];
  const certificateUploads: { caseId: string | null; person?: string; company?: string; contentType?: string; bytes: number }[] = [];
  const sicknessIds = new Set<string>();
  let activeSession: EmployeeClockSession | null = minimal ? null : { id: 'home-clock-session', revision: 1,
    startedAt: `${today}T05:00:00.000Z`, endedAt: null, breaks: [], workSeconds: 7200, breakSeconds: 900,
    dayWorkSeconds: 7200, dayBreakSeconds: 900 };
  const person = { id: 'home-person', userId: 'home-user', driverId: 'home-driver', name: 'Niklas Hemtest',
    kind: 'employee' as const, username: 'hemtest', role: 'Gårdsarbetare', team: 'Gården', phone: '', email: '',
    siteIds: minimal ? ['norrtalje'] : ['norrtalje', 'rimbo'] };
  function order(id: string, customerName: string, status: EmployeeOrder['status'], date = today, startMinute = 630): EmployeeOrder {
    return { id, customerName, status, date, startMinute, siteId: 'norrtalje', driverId: person.driverId,
      address: 'Industrivägen 8', city: 'Norrtälje', contact: '', phone: '', action: 'pickup', vesselType: 'container',
      material: 'Koppar', vesselSize: '10 m³', pickupVessel: '', replacementVessel: '', notes: '', lat: 0, lng: 0,
      durationMinutes: 45, audit: [], updatedAt: `${today}T07:00:00.000Z`, bookingVersion: 1 };
  }
  const ownOrders = [order('AO-home-cancelled', 'Avbokad kund', 'cancelled', today, 400),
    order('AO-home-done', 'Redan avslutad kund', 'done', today, 420),
    order('AO-home-next', 'Nästa kund AB', 'booked'), order('AO-home-later', 'Senare kund AB', 'booked', today, 840),
    order('AO-home-tomorrow', 'Morgondagens kund', 'booked', tomorrow, 360)];
  function overview(url: URL): EmployeeOverview {
    const date = url.searchParams.get('date') ?? today;
    const lean = url.pathname.endsWith('/session') || url.searchParams.get('view') === 'bootstrap';
    const day = { date, expectedMinutes: 480, recordedMinutes: 120, missingMinutes: 0, automaticMinutes: 0,
      manualMinutes: 0, absenceMinutes: 0, jobsCount: minimal ? 0 : 3, status: 'not_required' as const,
      timeSource: controls.clockEnabled ? 'clock' as const : 'workorder' as const, clockMinutes: 120,
      breakMinutes: 15, allocatedMinutes: 0, unallocatedMinutes: 120 };
    return { revision, companyId: 'home-fixture-company', companyName: 'Hemtest AB', person, today, date,
      month: url.searchParams.get('month') ?? date.slice(0, 7), monthLoaded: !lean, activeSiteId: controls.activeSiteId,
      capabilities: { yardWork: controls.yardWork, assignedOrders: controls.assignedOrders, employeeTime: true, manageTimeRequirements: false },
      sites: controls.noSites ? [] : minimal ? [{ id: 'norrtalje', name: 'Norrtälje', active: true }] : [
        { id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }],
      requirement: { enabled: true, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 1, timeSource: day.timeSource },
      gate: { blocked: controls.gateBlocked, ...(controls.gateBlocked ? { date: today } : {}), expectedMinutes: 480, recordedMinutes: 120, missingMinutes: controls.gateBlocked ? 360 : 0 }, days: [day],
      selectedDay: { ...day, entries: [], schedules: [{ id: 'home-schedule', personId: person.id,
        startMinute: 420, endMinute: 960, weekdays: [1, 2, 3, 4, 5], effectiveFrom: today, revision: 1 }],
        absences: [], orders: minimal ? [] : ownOrders.filter(item => item.date === date), clockSessions: [] },
      clock: { enabled: controls.clockEnabled, source: day.timeSource, status: controls.clockStatus, revision,
        serverNow: new Date().toISOString(), activeSession, workSeconds: activeSession?.workSeconds ?? 0,
        breakSeconds: activeSession?.breakSeconds ?? 0 }, orders: minimal ? [] : ownOrders,
      upcomingOrders: minimal ? [] : ownOrders.filter(item => item.status !== 'done' && item.status !== 'cancelled' && (!controls.futureOnly || item.date === tomorrow)),
      sickness: { ...structuredClone(sickness), activeClock: Boolean(activeSession) },
      activeWork: null, leaveRequests: [], summary: { expectedMinutes: 480, recordedMinutes: 120, missingMinutes: 0 },
      balances: { available: false }, ...(controls.activity ? { homeActivity: controls.activity } : {}) };
  }
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const send = (json: unknown, status = 200) => route.fulfill({ status, json });
    if (['/api/employee/session', '/api/employee/overview'].includes(url.pathname)) {
      reads.push(`${url.pathname}${url.search}`); return send(overview(url));
    }
    if (url.pathname === '/api/employee/orders') return controls.assignedOrders ? send({ orders: ownOrders }) : send({ error: 'Uppdragsåtkomst saknas' }, 403);
    if (url.pathname === '/api/employee/active-site') {
      const siteId = request.postDataJSON().siteId; siteWrites.push(siteId); controls.activeSiteId = siteId; revision++;
      return send(overview(url));
    }
    if (url.pathname === '/api/employee/sickness/files') {
      certificateUploads.push({ caseId: url.searchParams.get('caseId'), person: request.headers()['x-employee-person'],
        company: request.headers()['x-employee-company'], contentType: request.headers()['content-type'], bytes: request.postDataBuffer()?.length ?? 0 });
      return send({ file: { id: 'own-private-file', caseId: url.searchParams.get('caseId'), name: 'intyg.pdf', contentType: 'application/pdf', size: certificateUploads.at(-1)!.bytes, uploadedAt: new Date().toISOString() } });
    }
    if (url.pathname === '/api/employee/sickness') {
      if (request.method() === 'GET') return send({ ...sickness, activeClock: Boolean(activeSession) });
      const command = request.postDataJSON() as EmployeeSicknessCommand;
      sicknessWrites.push({ command, person: request.headers()['x-employee-person'], company: request.headers()['x-employee-company'] });
      const held = controls.holdSickness; controls.holdSickness = undefined;
      if (held) { held.ready(); await held.gate; }
      if (controls.sicknessError) return send({ error: 'Tillfälligt okänt sparutfall' }, 503);
      if (!sicknessIds.has(command.requestId)) {
        sicknessIds.add(command.requestId); sickness.revision++; revision++;
        if (command.action === 'sickness.report') {
          expect(command.declared).toBe(true);
          const item: SicknessCase = { id: 'own-sickness-case', personId: person.id, revision: 1, status: 'open', fromDate: command.fromDate,
            startMinute: command.startMinute, extent: command.extent, forecast: command.forecast, declared: command.declared,
            reportedAt: new Date().toISOString(), cycleId: 'own-sick-cycle', relapse: false, lastContactDate: today, contacts: [],
            certificate: { received: false, reference: '' }, days: [], timeIssue: false,
            followup: { certificateRequired: false, certificateDueDate: today, insurerReportDue: false, insurerReportDeadline: today,
              rehabilitationPlanDue: false, contactOverdue: false, reviewRequired: false, messages: [] } };
          sickness.activeCase = item; sickness.cases = [item]; sickness.canReport = false;
          if (command.clockOut) { activeSession = null; controls.clockStatus = 'out'; sickness.activeClock = false; }
        } else if (command.action === 'sickness.recover' && sickness.activeCase) {
          sickness.activeCase.status = 'recovered'; sickness.activeCase.lastSickDate = command.lastSickDate;
          sickness.activeCase = null; sickness.canReport = true;
        } else if (command.action === 'sickness.recovery.schedule' && sickness.activeCase) {
          sickness.activeCase.recoveryPlan = { healthyFromDate: command.healthyFromDate, registeredAt: new Date().toISOString() };
          sickness.activeCase.revision++;
        } else if (command.action === 'sickness.recovery.cancel' && sickness.activeCase) {
          delete sickness.activeCase.recoveryPlan; sickness.activeCase.revision++;
        } else if (command.action === 'sickness.forecast' && sickness.activeCase) {
          sickness.activeCase.forecast = command.forecast; sickness.activeCase.revision++;
        } else if (command.action === 'sickness.confirm' && sickness.activeCase) {
          sickness.activeCase.extent = command.extent; sickness.activeCase.lastContactDate = today;
          if (command.forecast) sickness.activeCase.forecast = command.forecast;
          sickness.activeCase.revision++;
        }
      }
      if (controls.sicknessCommitError) return send({ error: 'Tillfälligt okänt sparutfall' }, 503);
      return send(sickness);
    }
    if (url.pathname === '/api/employee/clock') {
      const command = request.postDataJSON() as EmployeeClockAction;
      clockWrites.push({ command, company: request.headers()['x-employee-company'] });
      const held = controls.holdClock; controls.holdClock = undefined;
      if (held) { held.ready(); await held.gate; }
      if (controls.clockError) return send({ error: 'Stämplingen kunde inte sparas. Försök igen.' }, 503);
      expect(command.revision).toBe(revision); revision++;
      if (command.action === 'clock.pause') {
        controls.clockStatus = 'break'; activeSession = { ...activeSession!, breaks: [{ startedAt: new Date().toISOString(), endedAt: null }] };
      } else if (command.action === 'clock.resume') controls.clockStatus = 'working';
      else if (command.action === 'clock.out') { controls.clockStatus = 'out'; activeSession = null; }
      return send(overview(url));
    }
    if (url.pathname === '/api/application/mobile') return send({ data: { version: 1, drafts: [], customers: [] }, revision: 0 });
    if (url.pathname === '/api/application/revision') return send({ revision: 0 });
    if (url.pathname === '/api/platform/tenant-context') return send({ companyId: 'home-fixture-company', companyName: 'Hemtest AB' });
    if (url.pathname === '/api/employee/equipment') return send({ items: [], assignments: [], events: [], revision: 0 });
    return send({ error: 'Endpoint outside isolated Home fixture' }, 404);
  });
  return { controls, reads, clockWrites, siteWrites, errors, today, sicknessWrites, sickness, ownOrders, certificateUploads,
    fullReads: () => reads.filter(value => value.includes('/overview') && !value.includes('view=bootstrap')) };
}

async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const nav = page.getByRole('navigation', { name: 'Huvudmeny', exact: true });
  await expect(nav.getByRole('button')).toHaveText(['Hem', 'Schema', 'Tid', 'Profil']);
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) + 1);
  for (const item of await nav.getByRole('button').all()) await expect(item).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const lastAction = await page.getByRole('main').getByRole('button').last().boundingBox();
  const navAtBottom = await nav.boundingBox();
  if (lastAction && navAtBottom) expect(lastAction.y + lastAction.height).toBeLessThanOrEqual(navAtBottom.y + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
}

test('Hem visar nästa eget uppdrag och Gårdsarbete visar verifierad statistik under Starta invägning', async ({ page, browser }, info) => {
  const fixture = await homeFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Din dag', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  await expect(page.getByText('3 uppdrag idag', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mina uppdrag', exact: true })).toContainText('2 kvar');
  const next = page.getByRole('button', { name: 'Öppna nästa uppdrag', exact: true });
  await expect(next).toContainText('Nästa kund AB'); await expect(next).toContainText('Idag · 10:30');
  for (const hidden of ['Avbokad kund', 'Redan avslutad kund', 'Morgondagens kund']) await expect(page.getByText(hidden, { exact: false })).toHaveCount(0);
  expect(fixture.fullReads()).toHaveLength(0);
  await geometry(page);
  await page.screenshot({ path: info.outputPath('employee-home-clock-390.png') });
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).click();
  await expect(page).toHaveURL(/#\/yard$/);
  const contribution = page.getByRole('region', { name: 'Din insats idag', exact: true });
  await expect(contribution).toContainText('Invägt');
  await expect(contribution.locator('strong')).toHaveText(['4', /1[\s\u00a0]285 kg/]);
  const start = await page.getByRole('button', { name: 'Starta invägning Materialvåg eller fordonsvåg' }).boundingBox();
  const stats = await contribution.boundingBox();
  const ongoing = await page.getByRole('heading', { name: 'Pågående vägningar', exact: true }).boundingBox();
  expect(start!.y + start!.height).toBeLessThan(stats!.y); expect(stats!.y + stats!.height).toBeLessThan(ongoing!.y);
  const readsBefore = fixture.reads.length;
  fixture.controls.activity = { date: fixture.today, siteId: 'norrtalje', completedWeighings: 5, weighedKg: 1327 };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', { detail: { companyId: 'other-company', personId: 'home-person' } })));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(fixture.reads).toHaveLength(readsBefore);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', { detail: { companyId: 'home-fixture-company', personId: 'home-person' } })));
  await expect(contribution.locator('strong')).toHaveText(['5', /1[\s\u00a0]327 kg/]);
  await page.getByRole('button', { name: 'Byt anläggning, Norrtälje', exact: true }).click();
  await expect(page.getByRole('option')).toHaveText(['Norrtälje', 'Rimbo']);
  await page.getByRole('option', { name: 'Rimbo', exact: true }).click();
  expect(fixture.siteWrites).toEqual(['rimbo']); await expect(contribution).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Huvudmeny', exact: true }).getByRole('button', { name: 'Hem', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  await next.click(); await expect(page).toHaveURL(/#\/assignments\?order=AO-home-next$/);
  expect(fixture.fullReads()).toHaveLength(0); expect(fixture.errors).toEqual([]);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'sv-SE' });
  try {
    const desktopPage = await desktop.newPage(), desktopFixture = await homeFixture(desktopPage);
    await desktopPage.goto('/'); await expect(desktopPage.getByRole('heading', { name: 'Din dag', exact: true })).toBeVisible();
    await geometry(desktopPage); expect(desktopFixture.fullReads()).toHaveLength(0); expect(desktopFixture.errors).toEqual([]);
  } finally { await desktop.close(); }
});

test('320 px minimal roll visar endast behöriga genvägar och saknad eller gammal statistik blir aldrig påhittade nollor', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const fixture = await homeFixture(page, true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Byt anläggning, Norrtälje', exact: true }).click();
  await expect(page.getByText('Du är tilldelad Norrtälje.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(fixture.siteWrites).toEqual([]);
  for (const name of ['Väg in', 'Gårdsarbete', 'Mina uppdrag', 'Stämpla in', 'Ta rast', 'Stämpla ut'])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Stämpelklocka', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  await geometry(page);
  await page.screenshot({ path: info.outputPath('employee-home-minimal-320.png'), fullPage: true });
  await page.goto('/#/new');
  await expect(page).toHaveURL(/#\/?$/);
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/ })).toBeVisible();
  expect(fixture.fullReads()).toHaveLength(0);
  // Even a supplied valid activity DTO must never bypass the yard capability.
  fixture.controls.activity = { date: fixture.today, siteId: 'norrtalje', completedWeighings: 4, weighedKg: 1285 };
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  fixture.controls.yardWork = true;
  fixture.controls.activity = undefined;
  await page.goto('/#/yard');
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  fixture.controls.activity = { date: '2000-01-01', siteId: 'norrtalje', completedWeighings: 4, weighedKg: 1285 };
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  fixture.controls.activity = { date: fixture.today, siteId: 'rimbo', completedWeighings: 4, weighedKg: 1285 };
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  fixture.controls.activeSiteId = 'rimbo'; // Matching data is still outside this person's only authorized site.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('inbäddad klocka skickar en stämpling vid dubbeltryck och behåller synligt serverfel utan falsk status', async ({ page }) => {
  const fixture = await homeFixture(page);
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Stämpelklocka', exact: true });
  await expect(card.getByText('Instämplad', { exact: true })).toBeVisible();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  fixture.controls.holdClock = { ready, gate };
  const pause = card.getByRole('button', { name: 'Ta rast', exact: true });
  await pause.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await started;
  expect(fixture.clockWrites).toHaveLength(1);
  await expect(card.getByRole('button', { name: 'Startar rast…', exact: true })).toBeDisabled();
  release();
  await expect(card.getByText('På rast', { exact: true })).toBeVisible();
  expect(fixture.clockWrites[0]).toMatchObject({ command: { action: 'clock.pause', revision: 10, sessionId: 'home-clock-session' }, company: 'home-fixture-company' });
  expect(fixture.clockWrites[0].command.requestId).toMatch(/^[a-f0-9-]{36}$/);
  fixture.controls.clockError = true;
  await card.getByRole('button', { name: 'Återuppta arbete', exact: true }).click();
  await expect(card.getByRole('alert')).toHaveText('Stämplingen kunde inte sparas. Försök igen.');
  await expect(card.getByText('På rast', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Återuppta arbete', exact: true })).toBeEnabled();
  expect(fixture.clockWrites.map(value => value.command.action)).toEqual(['clock.pause', 'clock.resume']);
  expect(fixture.fullReads()).toHaveLength(0); expect(fixture.errors).toEqual([]);
});

test('nästa uppdrag använder en rullande vecka och noll anläggningar förklaras utan att starta vägning', async ({ page }) => {
  const fixture = await homeFixture(page);
  fixture.controls.futureOnly = true;
  await page.goto('/');
  const next = page.getByRole('button', { name: 'Öppna nästa uppdrag', exact: true });
  await expect(next).toContainText('Morgondagens kund'); await expect(next).toContainText('Imorgon · 06:00');
  await expect(page.getByText('3 uppdrag idag', { exact: true })).toBeVisible();
  fixture.ownOrders.find(item => item.id === 'AO-home-tomorrow')!.startMinute = undefined;
  await page.reload(); await expect(next).toContainText('Imorgon · Tid ej bokad');
  await page.setViewportSize({ width: 320, height: 740 });
  fixture.controls.noSites = true;
  await page.reload();
  await page.getByRole('button', { name: 'Byt anläggning, Ingen anläggning tilldelad', exact: true }).click();
  await expect(page.getByText('Du har ingen aktiv anläggning tilldelad.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Väg in', exact: true })).toBeDisabled();
  expect(fixture.siteWrites).toEqual([]); expect(fixture.fullReads()).toHaveLength(0);
  await geometry(page); expect(fixture.errors).toEqual([]);
});

test('sjukanmälan avslutar aktivt pass atomiskt vid dubbeltryck och behåller redan arbetade timmar', async ({ page }) => {
  const fixture = await homeFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Stämpla ut och sjukanmäl', exact: true }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText('Redan arbetad tid behålls.', { exact: false })).toBeVisible();
  await modal.getByLabel('Sjukfrånvarons omfattning').selectOption('50');
  await modal.getByRole('checkbox').check();
  let ready!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  fixture.controls.holdSickness = { ready, gate };
  await modal.getByRole('button', { name: 'Avsluta pass och sjukanmäl', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await started;
  expect(fixture.sicknessWrites).toHaveLength(1); expect(fixture.clockWrites).toHaveLength(0);
  await expect(modal.getByRole('button', { name: 'Sparar…', exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Stämpelklocka', exact: true }).getByText('02:00:00', { exact: true })).toBeVisible();
  expect(fixture.sicknessWrites[0]).toMatchObject({ command: { action: 'sickness.report', fromDate: fixture.today, extent: 50,
    declared: true, clockOut: true, forecast: { kind: 'unknown' } }, person: 'home-person', company: 'home-fixture-company' });
  expect(fixture.errors).toEqual([]);
});

test('okänt sjukutfall ger ingen falsk bekräftelse och samma requestId återanvänds uttryckligen', async ({ page }) => {
  const fixture = await homeFixture(page, true);
  fixture.controls.sicknessError = true;
  await page.goto('/');
  await page.getByRole('button', { name: 'Sjukanmälan', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera sjukanmälan', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Svaret kunde inte bekräftas');
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sjukanmälan', exact: true })).toBeDisabled();
  expect(fixture.sicknessWrites).toHaveLength(1);
  await page.getByRole('button', { name: 'Kontrollera registreringen', exact: true }).click();
  await expect(page.getByText('Utfallet är ännu inte bekräftat.', { exact: false })).toBeVisible();
  fixture.controls.sicknessError = false;
  await page.getByRole('button', { name: 'Skicka samma försök', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld', exact: true })).toBeVisible();
  expect(fixture.sicknessWrites).toHaveLength(2);
  expect(fixture.sicknessWrites[1].command.requestId).toBe(fixture.sicknessWrites[0].command.requestId);
  expect(fixture.sickness.cases).toHaveLength(1); expect(fixture.errors).toEqual([]);
});

test('äldre saknad tid hindrar inte vägen till sjukanmälan men tidsspärren finns kvar', async ({ page }) => {
  const fixture = await homeFixture(page, true);
  fixture.controls.gateBlocked = true;
  await page.goto('/');
  const gate = page.getByRole('dialog');
  await expect(gate.getByRole('heading', { name: /^Tid saknas/ })).toBeVisible();
  await gate.getByRole('button', { name: 'Sjukanmälan / friskanmälan', exact: true }).click();
  await expect(page).toHaveURL(/#\/time\/sickness$/);
  await expect(page.getByText('Tid saknas för', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sjukanmälan', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera sjukanmälan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld', exact: true })).toBeVisible();
  expect(fixture.controls.gateBlocked).toBe(true);
  await expect(page.getByText('Tid saknas för', { exact: false })).toBeVisible();
  expect(fixture.errors).toEqual([]);
});

test('prognos, fortsatt sjukfrånvaro, privat intyg och faktisk friskanmälan är separata åtgärder', async ({ page }) => {
  const fixture = await homeFixture(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sjukanmälan', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera sjukanmälan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld' })).toBeVisible();
  await page.getByRole('button', { name: 'Ändra uppskattad återgång', exact: true }).click();
  const tomorrow = new Date(`${fixture.today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await page.getByRole('dialog').getByLabel('När tror du att du kan arbeta igen?').selectOption('date');
  await page.getByRole('dialog').getByLabel('Uppskattad återgång', { exact: true }).fill(tomorrow.toISOString().slice(0, 10));
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Du är sjukanmäld' })).toBeVisible();
  expect(fixture.sickness.activeCase?.status).toBe('open');
  await page.getByRole('button', { name: 'Jag är fortfarande sjuk', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Sjukfrånvarons omfattning').selectOption('75');
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByText(/Från .*75 %/)).toBeVisible();
  fixture.sickness.activeCase!.followup.certificateRequired = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ladda upp läkarintyg', exact: true })).toBeVisible();
  const file = Buffer.from('%PDF-1.4\nOnly fictional test data\n%%EOF');
  await page.getByLabel('Välj läkarintyg', { exact: true }).setInputFiles({ name: 'intyg.pdf', mimeType: 'application/pdf', buffer: file });
  await expect(page.getByText('Intyget är uppladdat.', { exact: false })).toBeVisible();
  expect(fixture.certificateUploads).toEqual([{ caseId: 'own-sickness-case', person: 'home-person', company: 'home-fixture-company', contentType: 'application/pdf', bytes: file.length }]);
  expect(fixture.sickness.activeCase!.certificate.received, 'Uploading a file does not verify medical coverage.').toBe(false);
  await page.getByRole('button', { name: 'Friskanmäl mig', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera friskanmälan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sjukanmälan', exact: true })).toBeVisible();
  expect(fixture.sickness.activeCase).toBeNull(); expect(fixture.clockWrites).toHaveLength(0);
  expect(fixture.sicknessWrites.map(item => item.command.action)).toEqual(['sickness.report', 'sickness.forecast', 'sickness.confirm', 'sickness.recover']);
  expect(fixture.errors).toEqual([]);
});

test('framtida friskanmälan kan ändras över helgen och återkallas utan att avsluta dagens sjukfrånvaro', async ({ page }) => {
  const fixture = await homeFixture(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sjukanmälan', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera sjukanmälan', exact: true }).click();
  await page.getByRole('button', { name: 'Friskanmäl mig', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'När är du frisk?', exact: true }).selectOption('tomorrow');
  await expect(page.getByRole('dialog').getByText('Datumet gäller när du är frisk', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera friskanmälan', exact: true }).click();
  const next = new Date(`${fixture.today}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  await expect(page.getByText('Du är fortfarande sjukanmäld fram till dess.', { exact: false })).toBeVisible();
  expect(fixture.sicknessWrites.at(-1)!.command).toMatchObject({ action: 'sickness.recovery.schedule', healthyFromDate: next.toISOString().slice(0, 10), id: 'own-sickness-case' });
  expect(fixture.sickness.activeCase?.status).toBe('open'); expect(fixture.sickness.activeCase?.lastSickDate).toBeUndefined();
  await page.getByRole('button', { name: 'Ändra friskanmälan', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'När är du frisk?', exact: true })).toHaveValue('date');
  const saturday = new Date(next); saturday.setUTCDate(saturday.getUTCDate() + (6 - saturday.getUTCDay() + 7) % 7);
  const healthyDate = saturday.toISOString().slice(0, 10);
  await page.getByRole('dialog').getByLabel('Frisk från datum', { exact: true }).fill(healthyDate);
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera friskanmälan', exact: true }).click();
  await expect(page.getByText('Friskanmälan registrerad – frisk från lördag', { exact: false })).toBeVisible();
  expect(fixture.sickness.activeCase?.recoveryPlan?.healthyFromDate).toBe(healthyDate);
  await page.getByRole('button', { name: 'Jag är fortfarande sjuk', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('behålls.', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(fixture.sickness.activeCase?.recoveryPlan?.healthyFromDate).toBe(healthyDate);
  await page.getByRole('button', { name: 'Återkalla friskanmälan', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Din sjukfrånvaro fortsätter', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Återkalla friskanmälan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Friskanmäl mig', exact: true })).toBeVisible();
  expect(fixture.sickness.activeCase?.status).toBe('open'); expect(fixture.sickness.activeCase?.recoveryPlan).toBeUndefined();
  expect(fixture.clockWrites).toHaveLength(0); expect(fixture.errors).toEqual([]);
});

test('osäkert framtida friskdatum bekräftas bara när serverns datum matchar och skickas inte på nytt', async ({ page }) => {
  const fixture = await homeFixture(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sjukanmälan', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera sjukanmälan', exact: true }).click();
  fixture.controls.sicknessCommitError = true;
  await page.getByRole('button', { name: 'Friskanmäl mig', exact: true }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'När är du frisk?', exact: true }).selectOption('tomorrow');
  await page.getByRole('dialog').getByRole('button', { name: 'Registrera friskanmälan', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Svaret kunde inte bekräftas.', { exact: false })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Stäng', exact: true }).click();
  const confirmedPlan = structuredClone(fixture.sickness.activeCase!.recoveryPlan!);
  const different = new Date(`${confirmedPlan.healthyFromDate}T12:00:00Z`); different.setUTCDate(different.getUTCDate() + 1);
  fixture.sickness.activeCase!.recoveryPlan!.healthyFromDate = different.toISOString().slice(0, 10);
  fixture.controls.sicknessCommitError = false;
  await page.getByRole('button', { name: 'Kontrollera registreringen', exact: true }).click();
  await expect(page.getByText('Utfallet är ännu inte bekräftat.', { exact: false })).toBeVisible();
  expect(fixture.sicknessWrites).toHaveLength(2);
  fixture.sickness.activeCase!.recoveryPlan = confirmedPlan;
  await page.getByRole('button', { name: 'Kontrollera registreringen', exact: true }).click();
  await expect(page.getByText('Serverns registrering har bekräftats.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kontrollera registreringen', exact: true })).toHaveCount(0);
  expect(fixture.sicknessWrites).toHaveLength(2); expect(fixture.clockWrites).toHaveLength(0); expect(fixture.errors).toEqual([]);
});
