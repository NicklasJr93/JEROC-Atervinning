import { expect, test, type Page, type Route } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { seedTransport } from '../src/office/transport/model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { EmployeeRequirement } from '../src/employee/types';
import type { Person, PersonnelResponse } from '../src/office/personnel/types';
import type { PersonnelTimeCommand, PersonnelTimeOverview } from '../src/office/personnel/time-types';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE', timezoneId: 'America/New_York' });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

const person: Person = { id: 'time-settings-person', name: 'Tidrapport Testperson', kind: 'employee', active: true,
  role: 'Gårdsmedarbetare', team: 'Gården', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: false, revision: 1 };
const stockholmToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
function tomorrow(date: string) { return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10); }

async function setup(page: Page, options: { readonly?: 'actual' | 'effective'; historical?: boolean; writeGate?: Promise<void>; denyWrite?: 401 | 403; privateHistory?: boolean } = {}) {
  const data = migrateOffice(seedOffice()), base = data.users.find(user => user.id === 'admin')!;
  const user: OfficeUser = structuredClone(base), actualUser: OfficeUser = structuredClone(base);
  if (options.readonly) {
    user.id = 'time-settings-effective'; user.name = 'Vald ansvarig';
    Object.assign(options.readonly === 'actual' ? actualUser : user, {
      level: 'Medarbetare', permissions: ['view', 'personnelRead', 'employmentRead'],
    });
  }
  data.users = [...data.users.filter(value => ![user.id, actualUser.id].includes(value.id)), actualUser,
    ...(user.id !== actualUser.id ? [user] : [])];
  const today = stockholmToday(), future = tomorrow(today), canWrite = !options.readonly;
  const personnel: PersonnelResponse = { data: { version: 1, revision: 1, people: [person], companies: [], employment: [], salaries: [],
    schedules: [], absences: [], competencies: [], staffingTasks: [], externalAccounts: [], audit: [] }, revision: 1,
    storage: 'database', demo: true, capabilities: ['personnelRead', 'employmentRead', ...(canWrite ? ['employmentWrite' as const] : [])],
    sites: [{ id: 'norrtalje', name: 'Norrtälje' }], transport: seedTransport(today), users: data.users };
  let configured: EmployeeRequirement = { enabled: true, mode: 'fixed' as const, dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5],
    effectiveFrom: future, enforcementFrom: today, revision: 7, timeSource: 'clock' as 'clock' | 'workorder' };
  let corrected = false;
  const statistics = { reads: [] as Record<string, string>[], writes: [] as { command: PersonnelTimeCommand; query: Record<string, string>; headers: Record<string, string> }[] };
  const overview = (date: string, month: string): PersonnelTimeOverview => {
    const session = { id: 'clock-pass-1', revision: corrected ? 5 : 4, startedAt: corrected ? '2026-06-15T07:15:00.000Z' : '2026-06-15T06:00:00.000Z',
      endedAt: corrected ? '2026-06-15T14:30:00.000Z' : null,
      breaks: corrected ? [{ startedAt: '2026-06-15T10:00:00.000Z', endedAt: '2026-06-15T10:30:00.000Z' }] : [],
      workSeconds: corrected ? 24_300 : 400_000, breakSeconds: corrected ? 1800 : 0,
      dayWorkSeconds: corrected ? 24_300 : 48_000, dayBreakSeconds: corrected ? 1800 : 0,
      provisional: !corrected, requiresCorrection: !corrected,
      ...(corrected ? { correctedAt: `${today}T10:00:00.000Z`, correctionReason: 'Glömd utstämpling; kontrollerat med personen.' } : {}) };
    const recorded = corrected ? 405 : options.historical ? 0 : 120;
    const day = { date, expectedMinutes: 480, recordedMinutes: recorded, missingMinutes: 480 - recorded,
      automaticMinutes: 60, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'partial' as const,
      timeSource: 'clock' as const, clockMinutes: corrected ? 405 : 0, breakMinutes: corrected ? 30 : 0,
      allocatedMinutes: 60, unallocatedMinutes: corrected ? 345 : 0 };
    return { person: { id: person.id, name: person.name }, capabilities: { manageTimeSettings: canWrite, correctClock: canWrite },
      sites: personnel.sites, revision: 1, today, month, date,
      requirement: { ...configured, effectiveFrom: today, revision: 6, timeSource: 'clock' }, configuredRequirement: configured,
      timeSourceChange: { earliestEffectiveFrom: future, hasRecordedToday: true },
      gate: { blocked: true, expectedMinutes: 480, recordedMinutes: 0, missingMinutes: 480, timeSource: 'clock' },
      days: [day], selectedDay: { ...day, entries: [], schedules: [], absences: [], orders: [],
        clockSessions: options.historical && date === '2026-06-15' ? [session] : [] },
      clock: { enabled: true, source: 'clock', revision: corrected ? 12 : 11, status: options.historical && !corrected ? 'working' : 'out',
        serverNow: `${today}T10:00:00.000Z`, activeSession: options.historical && !corrected ? session : null,
        workSeconds: 7200, breakSeconds: 600, requiresCorrection: Boolean(options.historical && !corrected) },
      clockHistory: corrected ? [{ id: 'clock-event-1', action: 'clock.correct', at: `${today}T10:00:00.000Z`,
        reason: session.correctionReason, before: { startedAt: '2026-06-15T06:00:00.000Z', endedAt: null }, after: session }]
        : options.privateHistory ? [{ id: 'private-clock-event', action: 'clock.in', at: '2026-06-15T06:00:00.000Z', reason: 'Privat stämplingshistorik för testpersonen.' }] : [],
      orders: [], activeWork: null, leaveRequests: [], summary: { expectedMinutes: 480, recordedMinutes: day.recordedMinutes, missingMinutes: day.missingMinutes },
      balances: { available: false } };
  };
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user,
    company: { id: 'jeroc-demo', name: 'Tidrapport testbolag', organisationNumber: '5593593626', status: 'active' },
    organisationId: 'jeroc-demo', effectiveUserId: user.id, isSupportSession: user.id !== actualUser.id,
    mustChangePassword: false, csrfToken: 'personnel-time-fixture', generation: 4, companies: [] };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/application/personnel-time') {
      const query = Object.fromEntries(url.searchParams);
      if (request.method() === 'POST') {
        const command = request.postDataJSON() as PersonnelTimeCommand;
        statistics.writes.push({ command, query, headers: request.headers() });
        await options.writeGate;
        if (options.denyWrite) return route.fulfill({ status: options.denyWrite, json: { error: 'Din åtkomst till tidrapporteringen har återkallats.' } });
        if (!canWrite) return route.fulfill({ status: 403, json: { error: 'Du saknar behörighet att ändra tidrapporteringen.' } });
        if (command.action === 'requirement.save') configured = { ...configured, ...command.requirement, revision: configured.revision + 1 };
        else corrected = true;
      } else statistics.reads.push(query);
      return route.fulfill({ json: overview(query.date, query.month) });
    }
    const response = path === '/api/platform/session' ? session
      : path === '/api/application/personnel' ? personnel
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: user.id, user,
        csrfToken: 'environment-time-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: user.id,
        sites: personnel.sites, terminals: [], approvals: [], defaults: [] }
      : path === '/api/pricing/state' ? { version: 'time-fixture', memoryOnly: false, revision: 1, asOfDate: today,
        metals: [], articles: [], customers: data.customers, users: data.users, customerPrices: [], audit: [] } : undefined;
    return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Tjänsten ingår inte i det lokala tidrapporteringstestet.' } });
  });
  await page.goto(`/kontor#/personnel/${person.id}/time`);
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timkrav & timkälla', exact: true })).toBeVisible();
  return { statistics, today, future };
}

test('framtida timinställningar sparas från senaste konfigurationen utan att dagens timkälla ändras', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { statistics, future } = await setup(page);
  await expect(page.getByLabel('Gäller från', { exact: true })).toHaveValue(future);
  await expect(page.getByLabel('Gäller från', { exact: true })).toHaveAttribute('min', future);
  await page.getByRole('combobox', { name: 'Timkälla', exact: true }).selectOption('workorder');
  await page.getByLabel('Timkrav per dag (timmar)', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Spara timinställningar', exact: true }).click();
  await expect.poll(() => statistics.writes.length).toBe(1);
  const saved = statistics.writes[0];
  expect(saved.command).toMatchObject({ action: 'requirement.save', personId: person.id,
    requirement: { revision: 7, dailyMinutes: 540, timeSource: 'workorder', effectiveFrom: future } });
  expect(saved.query).toMatchObject({ personId: person.id, date: stockholmToday(), month: stockholmToday().slice(0, 7) });
  expect(saved.headers).toMatchObject({ 'x-platform-csrf': 'personnel-time-fixture', 'x-platform-generation': '4',
    'x-platform-organisation-id': 'jeroc-demo', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  await expect(page.getByText('Timkrav och timkälla är sparade från valt datum.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Timkälla', exact: true })).toHaveValue('workorder');
  await expect(page.getByLabel('Timkrav per dag (timmar)', { exact: true })).toHaveValue('9');
  await expect(page.getByRole('button', { name: 'Lägg till missat pass', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('personnel-time-settings-1440.png') });
  expect(errors).toEqual([]);
});

test('rättelse av ett öppet pass använder svensk faktisk tid och personrevision med ett enda sparförsök', async ({ page }) => {
  let release!: () => void;
  const writeGate = new Promise<void>(resolve => { release = resolve; });
  const { statistics } = await setup(page, { historical: true, writeGate });
  await page.getByLabel('Datum för tidrapport', { exact: true }).fill('2026-06-15');
  await expect(page.getByText('Arbetstid fastställs efter rättelse', { exact: true })).toBeVisible();
  await expect(page.getByText('Behöver rättas', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rätta pass', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rätta stämpling', exact: true });
  await expect(dialog.getByLabel('Instämpling', { exact: true })).toHaveValue('2026-06-15T08:00');
  await expect(dialog.getByLabel('Utstämpling', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Instämpling', { exact: true }).fill('2026-06-15T09:15');
  await dialog.getByLabel('Utstämpling', { exact: true }).fill('2026-06-15T16:30');
  await dialog.getByRole('button', { name: 'Lägg till rast', exact: true }).click();
  await dialog.getByLabel('Rast 1 från', { exact: true }).fill('2026-06-15T12:00');
  await dialog.getByLabel('Rast 1 till', { exact: true }).fill('2026-06-15T12:30');
  await dialog.getByLabel('Orsak till rättelsen', { exact: true }).fill('Glömd utstämpling; kontrollerat med personen.');
  const save = dialog.getByRole('button', { name: 'Spara rättelse', exact: true });
  await save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => statistics.writes.length).toBe(1);
  await expect(dialog.getByLabel('Instämpling', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Sparar…', exact: true })).toBeDisabled();
  expect(statistics.writes[0].command).toMatchObject({ action: 'clock.correct', personId: person.id,
    sessionId: 'clock-pass-1', revision: 11, startedAt: '2026-06-15T07:15:00.000Z', endedAt: '2026-06-15T14:30:00.000Z',
    breaks: [{ startedAt: '2026-06-15T10:00:00.000Z', endedAt: '2026-06-15T10:30:00.000Z' }], reason: 'Glömd utstämpling; kontrollerat med personen.' });
  expect(statistics.writes[0].command).toHaveProperty('requestId', expect.stringMatching(/^[0-9a-f-]{36}$/i));
  release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Rättad', { exact: true })).toBeVisible();
  await expect(page.locator('.hr-time-history')).toContainText('Glömd utstämpling; kontrollerat med personen.');
  await expect(page.locator('.hr-time-history')).toContainText('Före:');
  await expect(page.locator('.hr-time-history')).toContainText('Efter:');
  await expect(page.getByText('Behöver rättas', { exact: true })).toHaveCount(0);
  expect(statistics.writes).toHaveLength(1);
});

test('timinställningar och stämplingsrättelser kräver skrivbehörighet för både faktisk och vald användare', async ({ browser }) => {
  for (const readonly of ['actual', 'effective'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage();
    const { statistics } = await setup(page, { readonly, historical: true });
    await expect(page.getByRole('combobox', { name: 'Timkälla', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Spara timinställningar', exact: true })).toHaveCount(0);
    await page.getByLabel('Datum för tidrapport', { exact: true }).fill('2026-06-15');
    await expect(page.getByText('Arbetstid fastställs efter rättelse', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rätta pass', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lägg till missat pass', exact: true })).toHaveCount(0);
    expect(statistics.writes).toHaveLength(0);
    await context.close();
  }
});

test('återkallad åtkomst vid sparande rensar tidigare tidrapport, inställningar och privat historik', async ({ page }) => {
  const { statistics } = await setup(page, { historical: true, privateHistory: true, denyWrite: 403 });
  await expect(page.getByRole('heading', { name: 'Klockstatus just nu', exact: true })).toBeVisible();
  await expect(page.locator('.hr-time-history')).toContainText('Privat stämplingshistorik för testpersonen.');
  await expect(page.getByLabel('Timkrav per dag (timmar)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Spara timinställningar', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Din åtkomst till tidrapporteringen har återkallats.');
  await expect(page.getByRole('heading', { name: 'Timkrav & timkälla', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Klockstatus just nu', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Timkrav per dag (timmar)', { exact: true })).toHaveCount(0);
  await expect(page.locator('.hr-time-history')).toHaveCount(0);
  await expect(page.getByText('Privat stämplingshistorik för testpersonen.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toBeVisible();
  expect(statistics.writes).toHaveLength(1);
});
