import { expect, test, type Page } from '@playwright/test';
import type { EmployeeOverview, EmployeeOrder, EmployeeClockAction, EmployeeClockSession } from '../src/employee/types';

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
    clockError: false, holdClock: undefined as { ready: () => void; gate: Promise<void> } | undefined };
  const reads: string[] = [], clockWrites: { command: EmployeeClockAction; company?: string }[] = [], siteWrites: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let revision = 10;
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
      sites: minimal ? [{ id: 'norrtalje', name: 'Norrtälje', active: true }] : [
        { id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }],
      requirement: { enabled: true, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 1, timeSource: day.timeSource },
      gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day],
      selectedDay: { ...day, entries: [], schedules: [{ id: 'home-schedule', personId: person.id,
        startMinute: 420, endMinute: 960, weekdays: [1, 2, 3, 4, 5], effectiveFrom: today, revision: 1 }],
        absences: [], orders: minimal ? [] : ownOrders.filter(item => item.date === date), clockSessions: [] },
      clock: { enabled: controls.clockEnabled, source: day.timeSource, status: controls.clockStatus, revision,
        serverNow: new Date().toISOString(), activeSession, workSeconds: activeSession?.workSeconds ?? 0,
        breakSeconds: activeSession?.breakSeconds ?? 0 }, orders: minimal ? [] : ownOrders,
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
  return { controls, reads, clockWrites, siteWrites, errors, today,
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

test('startsidan visar egna pågående dagsuppdrag och verklig dagsstatistik utan att ladda full månad', async ({ page, browser }, info) => {
  const fixture = await homeFixture(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Din dag', exact: true })).toBeVisible();
  const contribution = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Din insats idag', exact: true }) });
  await expect(contribution).toContainText('Invägningar');
  await expect(contribution).toContainText('Invägt');
  await expect(contribution).toContainText('4');
  await expect(contribution).toContainText(/1[\s\u00a0]285 kg/);
  await expect(page.getByText('3 uppdrag idag', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mina uppdrag', exact: true })).toContainText('2 kvar');
  const next = page.getByRole('button', { name: 'Öppna nästa uppdrag', exact: true });
  await expect(next).toBeVisible();
  await expect(next).toContainText('Nästa kund AB');
  await expect(next).toContainText('Hämtning');
  await expect(next).toContainText('10:30');
  await expect(next).toContainText('Norrtälje');
  for (const hidden of ['Avbokad kund', 'Redan avslutad kund', 'Morgondagens kund']) await expect(page.getByText(hidden, { exact: false })).toHaveCount(0);
  expect(fixture.reads.filter(value => value.startsWith('/api/employee/session')).every(value => value.includes('view=bootstrap'))).toBe(true);
  expect(fixture.fullReads()).toHaveLength(0);
  await geometry(page);
  await page.screenshot({ path: info.outputPath('employee-home-clock-390.png') });
  const readsBeforeNotification = fixture.reads.length;
  fixture.controls.activity = { date: fixture.today, siteId: 'norrtalje', completedWeighings: 5, weighedKg: 1327 };
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', { detail: { companyId: 'other-company', personId: 'home-person' } }));
    window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', { detail: { companyId: 'home-fixture-company', personId: 'other-person' } }));
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(fixture.reads).toHaveLength(readsBeforeNotification);
  await expect(contribution.locator('strong')).toHaveText(['4', /1[\s\u00a0]285 kg/]);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('jeroc:mobile-weighing-submitted', { detail: { companyId: 'home-fixture-company', personId: 'home-person' } })));
  await expect(contribution.locator('strong')).toHaveText(['5', /1[\s\u00a0]327 kg/]);
  await expect.poll(() => fixture.reads.length).toBe(readsBeforeNotification + 1);
  expect(fixture.fullReads()).toHaveLength(0);
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'sv-SE' });
  try {
    const desktopPage = await desktop.newPage(), desktopFixture = await homeFixture(desktopPage);
    await desktopPage.goto('/');
    await expect(desktopPage.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/ })).toBeVisible();
    await geometry(desktopPage);
    expect(desktopFixture.fullReads()).toHaveLength(0); expect(desktopFixture.errors).toEqual([]);
  } finally { await desktop.close(); }
  await page.getByRole('button', { name: 'Byt anläggning, Norrtälje', exact: true }).click();
  await expect(page.getByRole('listbox', { name: 'Anläggning', exact: true })).toBeVisible();
  await expect(page.getByRole('option')).toHaveText(['Norrtälje', 'Rimbo']);
  await page.getByRole('option', { name: 'Rimbo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Byt anläggning, Rimbo', exact: true })).toBeVisible();
  expect(fixture.siteWrites).toEqual(['rimbo']);
  await expect(page.getByRole('heading', { name: 'Din insats idag', exact: true })).toHaveCount(0);
  expect(fixture.fullReads()).toHaveLength(0);
  await page.getByRole('button', { name: 'Väg in', exact: true }).click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.getByRole('button', { name: /Materialvåg/ })).toBeVisible();
  await page.goBack(); // The existing mode chooser intentionally has no bottom navigation.
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).click();
  await expect(page).toHaveURL(/#\/yard$/);
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Huvudmeny', exact: true }).getByRole('button', { name: 'Hem', exact: true }).click();
  await next.click();
  await expect(page).toHaveURL(/#\/assignments\?order=AO-home-next$/);
  expect(fixture.errors).toEqual([]);
});

test('320 px minimal roll visar endast behöriga genvägar och saknad eller gammal statistik blir aldrig påhittade nollor', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const fixture = await homeFixture(page, true);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^God (morgon|eftermiddag|kväll|natt),\s*Niklas!?$/, exact: true })).toBeVisible();
  await expect(page.getByLabel('Aktiv anläggning: Norrtälje', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Byt anläggning/ })).toHaveCount(0);
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
  await page.reload();
  await expect(page.getByRole('button', { name: 'Väg in', exact: true })).toBeVisible();
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
