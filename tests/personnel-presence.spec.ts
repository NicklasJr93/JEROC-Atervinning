import { expect, test, type Page, type Route } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { seedTransport } from '../src/office/transport/model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { PersonnelPresenceResponse, PresencePerson } from '../src/office/personnel/presence-types';
import type { Person, PersonnelResponse } from '../src/office/personnel/types';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

const today = '2026-10-13', serverNow = `${today}T08:30:00.000Z`;
const sites = [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'stockholm', name: 'Stockholm' }];
function presence(personId: string, name: string, patch: Partial<PresencePerson>): PresencePerson {
  return { personId, name, team: 'Gården', siteIds: ['norrtalje'], timeSource: 'clock', clockEnabled: true,
    clockStatus: 'out', isClockedIn: false, isOnBreak: false, isWorkingNow: false, workStateSource: 'unknown',
    clockSessionId: null, clockedInAt: null, breakStartedAt: null, workSeconds: 0, breakSeconds: 0,
    lastClockEventAt: null, statusSince: null, isRunning: false, requiresCorrection: false,
    hasActiveOrder: false, isScheduledNow: true, isAbsentNow: false, isEmploymentActive: true,
    availabilityStatus: 'not_clocked_in', isAvailableNow: false, reasonCodes: [], ...patch };
}
const people = [
  presence('presence-working', 'Lovisa Arbetande', { clockStatus: 'working', isClockedIn: true, isWorkingNow: true,
    workStateSource: 'clock', clockSessionId: 'working-pass', clockedInAt: `${today}T07:20:00.000Z`,
    clockSiteId: 'norrtalje', lastClockEventAt: `${today}T07:30:00.000Z`, statusSince: `${today}T07:30:00.000Z`,
    workSeconds: 3600, breakSeconds: 600, isRunning: true, availabilityStatus: 'available', isAvailableNow: true }),
  presence('presence-break', 'Bosse Rastande', { team: 'Transport', siteIds: ['stockholm'], clockStatus: 'break',
    isClockedIn: true, isOnBreak: true, workStateSource: 'clock', clockSessionId: 'break-pass',
    clockedInAt: `${today}T07:55:00.000Z`, breakStartedAt: `${today}T08:25:00.000Z`,
    lastClockEventAt: `${today}T08:25:00.000Z`, statusSince: `${today}T08:25:00.000Z`,
    workSeconds: 1800, breakSeconds: 300, isRunning: true, availabilityStatus: 'on_break' }),
  presence('presence-out', 'Olle Utstämplad', { siteIds: ['stockholm'], workSeconds: 2700, breakSeconds: 180,
    lastClockEventAt: `${today}T08:00:00.000Z`, statusSince: `${today}T08:00:00.000Z` }),
  presence('presence-disabled', 'Disa Arbetsordertid', { timeSource: 'workorder', clockEnabled: false, clockStatus: 'disabled',
    isWorkingNow: true, workStateSource: 'order', hasActiveOrder: true, activeOrderId: 'AO-presence-private', availabilityStatus: 'busy' }),
  presence('presence-off', 'Sven Ledig', { clockStatus: 'off', isScheduledNow: false, availabilityStatus: 'absent', reasonCodes: ['outside_schedule'] }),
];

async function setup(page: Page, options: { withoutEmployment?: 'actual' | 'effective' } = {}) {
  const data = migrateOffice(seedOffice()), base = data.users.find(user => user.id === 'admin')!;
  const actualUser: OfficeUser = structuredClone(base), user: OfficeUser = structuredClone(base);
  if (options.withoutEmployment) {
    user.id = 'presence-effective'; user.name = 'Vald arbetsledare';
    // VD's inherited generic employmentRead must not open sensitive time data.
    Object.assign(options.withoutEmployment === 'actual' ? actualUser : user, {
      level: 'VD', permissions: ['view', 'personnelRead', 'personnelPresenceRead'],
    });
  }
  data.users = [...data.users.filter(value => ![actualUser.id, user.id].includes(value.id)), actualUser,
    ...(actualUser.id !== user.id ? [user] : [])];
  const personnel: PersonnelResponse = { data: { version: 1, revision: 1, people: people.map(value => ({
    id: value.personId, name: value.name, kind: 'employee', active: true, role: 'Medarbetare', team: value.team,
    siteIds: value.siteIds, phone: '', email: '', address: '', canDrive: false, revision: 1,
  } satisfies Person)), companies: [], employment: [], salaries: [], schedules: [], absences: [], competencies: [],
    staffingTasks: [], externalAccounts: [], audit: [] }, revision: 1, storage: 'database', demo: true,
    capabilities: ['personnelRead'], sites, transport: seedTransport(today), users: data.users };
  const response: PersonnelPresenceResponse = { serverNow, revision: 3, people: structuredClone(people), sites,
    summary: { total: 5, clockedIn: 2, working: 1, onBreak: 1, clockedOut: 2, clockDisabled: 1, needsReview: 0, available: 1 } };
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user,
    company: { id: 'jeroc-demo', name: 'Närvaro testbolag', organisationNumber: '5593593626', status: 'active' },
    organisationId: 'jeroc-demo', effectiveUserId: user.id, isSupportSession: user.id !== actualUser.id,
    mustChangePassword: false, csrfToken: 'presence-fixture', generation: 5, companies: [] };
  const statistics = { reads: [] as { query: Record<string, string>; headers: Record<string, string> }[], timeReads: 0, timePersonIds: [] as string[],
    denied: false, privatePosts: 0 };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/application/personnel-presence') {
      statistics.reads.push({ query: Object.fromEntries(url.searchParams), headers: request.headers() });
      if (url.searchParams.get('siteId') === 'all') return route.fulfill({ status: 404, json: { error: 'Alla är inget anläggnings-ID.' } });
      if (statistics.denied) return route.fulfill({ status: 403, json: { error: 'Din åtkomst till närvarouppgifterna har återkallats.' } });
      return route.fulfill({ json: response });
    }
    if (path === '/api/application/personnel-time') {
      statistics.timeReads++;
      statistics.timePersonIds.push(url.searchParams.get('personId') ?? '');
      const selectedPerson = personnel.data.people.find(value => value.id === url.searchParams.get('personId'))!;
      const date = url.searchParams.get('date') ?? today, month = url.searchParams.get('month') ?? today.slice(0, 7);
      const requirement = { enabled: true, mode: 'schedule', timeSource: 'clock', revision: 1, effectiveFrom: today, enforcementFrom: today };
      const day = { date, expectedMinutes: 480, recordedMinutes: 60, missingMinutes: 420, automaticMinutes: 0,
        manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'partial', timeSource: 'clock' };
      return route.fulfill({ json: { person: { id: selectedPerson.id, name: selectedPerson.name },
        capabilities: { manageTimeSettings: true, correctClock: true }, sites, revision: 1, today, date, month,
        requirement, configuredRequirement: requirement, timeSourceChange: { earliestEffectiveFrom: today, hasRecordedToday: false },
        gate: { blocked: true, expectedMinutes: 480, recordedMinutes: 60, missingMinutes: 420 }, days: [day],
        selectedDay: { ...day, entries: [], orders: [], schedules: [], absences: [], clockSessions: [] }, clockHistory: [],
        summary: { expectedMinutes: 480, recordedMinutes: 60, missingMinutes: 420 }, orders: [], activeWork: null,
        leaveRequests: [], balances: { available: false } } });
    }
    if (request.method() !== 'GET' && path.startsWith('/api/application/')) statistics.privatePosts++;
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/personnel' ? personnel
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: user.id, user,
        csrfToken: 'environment-presence-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: user.id,
        sites, terminals: [], approvals: [], defaults: [] }
      : path === '/api/pricing/state' ? { version: 'presence-fixture', memoryOnly: false, revision: 1, asOfDate: today,
        metals: [], articles: [], customers: data.customers, users: data.users, customerPrices: [], audit: [] } : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { error: 'Tjänsten ingår inte i det lokala närvarotestet.' } });
  });
  await page.goto('/kontor#/personnel/presence');
  await expect(page.getByRole('heading', { name: 'Närvaro', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Öppna Lovisa Arbetande', exact: true })).toBeVisible();
  return { statistics };
}

test('status, summering och filter följer servern medan sekundräknare tickar lokalt utan nya anrop', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(serverNow) });
  const { statistics } = await setup(page);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  const working = page.getByRole('row', { name: 'Öppna Lovisa Arbetande', exact: true });
  const resting = page.getByRole('row', { name: 'Öppna Bosse Rastande', exact: true });
  const out = page.getByRole('row', { name: 'Öppna Olle Utstämplad', exact: true });
  const disabled = page.getByRole('row', { name: 'Öppna Disa Arbetsordertid', exact: true });
  await expect(working).toContainText('Instämplad');
  await expect(working).toContainText('Tillgänglig');
  await expect(resting).toContainText('På rast');
  await expect(out).toContainText('Utstämplad');
  await expect(disabled).toContainText('Stämpelklocka av');
  await expect(disabled).toContainText('Uppdrag pågår');
  await expect(disabled.locator('.hr-presence-duration')).toHaveText(['—', '—']);
  await expect(page.getByRole('row', { name: 'Öppna Sven Ledig', exact: true })).toContainText('Ingen schemalagd tid');
  const metrics = page.locator('.hr-presence-metrics .hr-metric');
  await expect(metrics.nth(0).locator('strong')).toHaveText('2');
  await expect(metrics.nth(1).locator('strong')).toHaveText('1');
  await expect(metrics.nth(2).locator('strong')).toHaveText('2');
  await expect(metrics.nth(3).locator('strong')).toHaveText('0');
  const seconds = (value: string) => value.match(/\d{2}:\d{2}:\d{2}/)![0].split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  const workAtPause = seconds(await working.locator('.hr-presence-duration').nth(0).innerText());
  const breakAtPause = seconds(await resting.locator('.hr-presence-duration').nth(1).innerText());
  const initialReads = statistics.reads.length;
  await page.clock.runFor(3000);
  await expect.poll(async () => seconds(await working.locator('.hr-presence-duration').nth(0).innerText())).toBe(workAtPause + 3);
  await expect(working.locator('.hr-presence-duration').nth(1)).toHaveText('00:10:00');
  await expect(resting.locator('.hr-presence-duration').nth(0)).toContainText('00:30:00');
  await expect.poll(async () => seconds(await resting.locator('.hr-presence-duration').nth(1).innerText())).toBe(breakAtPause + 3);
  await expect(out.locator('.hr-presence-duration').nth(0)).toContainText('00:45:00');
  expect(statistics.reads).toHaveLength(initialReads);
  expect(statistics.reads[0].query).toEqual({});
  expect(statistics.reads[0].headers).toMatchObject({ 'x-platform-csrf': 'presence-fixture',
    'x-platform-generation': '5', 'x-platform-organisation-id': 'jeroc-demo', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  await page.clock.resume();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath('personnel-presence-1440.png') });
  await page.getByRole('combobox', { name: 'Närvarons anläggning', exact: true }).selectOption('stockholm');
  await page.getByRole('combobox', { name: 'Närvarostatus', exact: true }).selectOption('break');
  await expect(page.locator('.hr-presence-table tbody tr')).toHaveCount(1);
  await expect(resting).toBeVisible();
  await page.getByRole('textbox', { name: 'Sök i närvaro', exact: true }).fill('Lovisa');
  await expect(page.getByText('Ingen person matchar filtret.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Närvarons anläggning', exact: true }).selectOption('all');
  await page.getByRole('combobox', { name: 'Närvarostatus', exact: true }).selectOption('all');
  await expect(page.locator('.hr-presence-table tbody tr')).toHaveCount(1);
  await working.click();
  await expect(page).toHaveURL(/#\/personnel\/presence-working\/time$/);
  await expect(page.getByRole('heading', { name: 'Lovisa Arbetande', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timkrav & timkälla', exact: true })).toBeVisible();
  expect(statistics.timeReads).toBeGreaterThan(0);
  expect(new Set(statistics.timePersonIds)).toEqual(new Set(['presence-working']));
  expect(statistics.privatePosts).toBe(0);
  expect(errors).toEqual([]);
});

test('personraden öppnar översikten när någon principal saknar explicit anställningsbehörighet', async ({ browser }) => {
  for (const withoutEmployment of ['actual', 'effective'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage();
    const { statistics } = await setup(page, { withoutEmployment });
    const row = page.getByRole('row', { name: 'Öppna Lovisa Arbetande', exact: true });
    await row.focus();
    await row.press('Enter');
    await expect(page).toHaveURL(/#\/personnel\/presence-working\/overview$/);
    await expect(page.getByRole('heading', { name: 'Lovisa Arbetande', exact: true })).toBeVisible();
    expect(statistics.timeReads).toBe(0);
    expect(statistics.privatePosts).toBe(0);
    await context.close();
  }
});

test('nekad uppdatering rensar privata närvarorader och summering utan att visa äldre data', async ({ page }) => {
  const { statistics } = await setup(page);
  await expect(page.locator('.hr-presence-metrics')).toBeVisible();
  const initialReads = statistics.reads.length;
  statistics.denied = true;
  await page.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Din åtkomst till närvarouppgifterna har återkallats.');
  await expect(page.locator('.hr-presence-table')).toHaveCount(0);
  await expect(page.locator('.hr-presence-metrics')).toHaveCount(0);
  await expect(page.getByText('Lovisa Arbetande', { exact: true })).toHaveCount(0);
  await expect(page.locator('.hr-presence-freshness')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Närvarons anläggning', exact: true }).getByRole('option', { name: 'Norrtälje', exact: true })).toHaveCount(0);
  expect(statistics.reads).toHaveLength(initialReads + 1);
  expect(statistics.privatePosts).toBe(0);
});
