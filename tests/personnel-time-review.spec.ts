import { expect, test, type Page, type Route } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { seedTransport } from '../src/office/transport/model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { Person, PersonnelResponse } from '../src/office/personnel/types';
import type { TimeReviewCommand, TimeReviewDetail, TimeReviewOverview, TimeReviewStatus, TimeReviewSummary } from '../src/office/personnel/review-types';

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false, locale: 'sv-SE', timezoneId: 'America/New_York' });
test.setTimeout(45_000);

const month = '2026-09', today = '2026-10-13', serverNow = `${today}T08:30:00.000Z`;
const person: Person = { id: 'review-clock-person', name: 'Lovisa Månadsrapport', kind: 'employee', active: true,
  role: 'Gårdsmedarbetare', team: 'Gården', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: false, revision: 1 };
const sites = [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'stockholm', name: 'Stockholm' }];
// The clock day's three allocated hours belong inside its seven worked hours.
// The next day's workorder source contributes six worked hours plus two hours of absence.
const summary: TimeReviewSummary = { expectedMinutes: 960, recordedMinutes: 780, missingMinutes: 60, absenceMinutes: 120,
  automaticMinutes: 360, manualMinutes: 180, clockMinutes: 420, breakMinutes: 30, allocatedMinutes: 540, unallocatedMinutes: 240 };
const privateReason = 'Privat granskningskommentar från tidigare godkännande.';

function fixture(): TimeReviewDetail {
  return { serverNow, today, month, person: { id: person.id, name: person.name, team: person.team, siteIds: person.siteIds },
    review: { id: 'review-1', personId: person.id, month, status: 'submitted', revision: 7, version: 2,
      submittedAt: '2026-10-01T09:00:00.000Z', approvedAt: null, returnedAt: null, reopenedAt: null,
      reason: null, snapshotHash: 'submitted-source-v2', stale: false },
    capabilities: { canSubmit: false, canWithdraw: false, canApprove: true, canReturn: true, canReopen: false,
      canExport: false, canExportHistory: true, approvalReasonRequired: true },
    period: { month, isClosed: true, source: 'submitted', sourceHash: 'submitted-source-v2', calculatedAt: serverNow,
      summary: structuredClone(summary), issues: [{ code: 'missing_minutes', severity: 'warning', date: '2026-09-01' },
        { code: 'unallocated_minutes', severity: 'warning', date: '2026-09-01' }], days: [
        { date: '2026-09-01', timeSource: 'clock', status: 'partial', expectedMinutes: 480, recordedMinutes: 420,
          missingMinutes: 60, absenceMinutes: 0, automaticMinutes: 120, manualMinutes: 60, clockMinutes: 420,
          breakMinutes: 30, allocatedMinutes: 180, unallocatedMinutes: 240,
          requirement: { enabled: true, mode: 'fixed', dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5], revision: 3, timeSource: 'clock', effectiveFrom: '2026-09-01', enforcementFrom: '2026-09-01' },
          clockSessions: [{ id: 'review-clock-pass', revision: 4, startedAt: '2026-09-01T06:00:00.000Z', endedAt: '2026-09-01T13:30:00.000Z',
            breaks: [{ startedAt: '2026-09-01T10:00:00.000Z', endedAt: '2026-09-01T10:30:00.000Z' }],
            workSeconds: 25200, breakSeconds: 1800, dayWorkSeconds: 25200, dayBreakSeconds: 1800, requiresCorrection: false }],
          entries: [{ id: 'allocation-order', source: 'order', revision: 1, activity: 'Sortering koppar', startMinute: 480, endMinute: 600,
            breakMinutes: 0, minutes: 120, orderId: 'AO-review-private', siteId: 'norrtalje' },
          { id: 'allocation-manual', source: 'manual', revision: 2, activity: 'Underhåll maskin', startMinute: 780, endMinute: 840, breakMinutes: 0, minutes: 60 }] },
        { date: '2026-09-02', timeSource: 'workorder', status: 'complete', expectedMinutes: 480, recordedMinutes: 360,
          missingMinutes: 0, absenceMinutes: 120, automaticMinutes: 240, manualMinutes: 120, clockMinutes: 0,
          breakMinutes: 0, allocatedMinutes: 360, unallocatedMinutes: 0,
          requirement: { enabled: true, mode: 'fixed', dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5], revision: 4, timeSource: 'workorder', effectiveFrom: '2026-09-02', enforcementFrom: '2026-09-01' },
          clockSessions: [], entries: [{ id: 'workorder-day-two', source: 'order', revision: 1, activity: 'Lastning på arbetsorder',
            startMinute: 480, endMinute: 720, breakMinutes: 0, minutes: 240, orderId: 'AO-review-day-two' },
          { id: 'manual-day-two', source: 'manual', revision: 1, activity: 'Utbildning', startMinute: 780, endMinute: 900, breakMinutes: 0, minutes: 120 }] },
      ] },
    versions: [{ version: 1, sourceHash: 'approved-source-v1', calculatedAt: '2026-10-01T07:00:00.000Z',
      submittedAt: '2026-10-01T08:00:00.000Z', approvedAt: '2026-10-01T10:00:00.000Z', summary: { ...summary, recordedMinutes: 720 } }],
    history: [{ id: 'private-history', action: 'review.approve', at: '2026-10-01T10:00:00.000Z', actualUserId: 'admin', effectiveUserId: 'admin',
      reason: privateReason, fromStatus: 'submitted', toStatus: 'approved', version: 1, snapshotHash: 'approved-source-v1' }],
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function setup(page: Page, options: { detail?: boolean; writeGate?: Promise<void> } = {}) {
  const data = migrateOffice(seedOffice()), actualUser: OfficeUser = structuredClone(data.users.find(user => user.id === 'admin')!);
  const personnel: PersonnelResponse = { data: { version: 1, revision: 1, people: [person], companies: [], employment: [], salaries: [],
    schedules: [], absences: [], competencies: [], staffingTasks: [], externalAccounts: [], audit: [] }, revision: 1, storage: 'database', demo: true,
    capabilities: ['personnelRead'], sites, transport: seedTransport(today), users: data.users };
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user: actualUser,
    company: { id: 'jeroc-demo', name: 'Månadsgranskning testbolag', organisationNumber: '5593593626', status: 'active' },
    organisationId: 'jeroc-demo', effectiveUserId: actualUser.id, isSupportSession: false, mustChangePassword: false,
    csrfToken: 'review-fixture', generation: 6, companies: [] };
  const state = { detail: fixture(), session, denyCsv: false, readGate: undefined as Promise<void> | undefined,
    reads: [] as { query: Record<string, string>; headers: Record<string, string> }[],
    writes: [] as { command: TimeReviewCommand; query: Record<string, string>; headers: Record<string, string> }[],
    exports: [] as { query: Record<string, string>; headers: Record<string, string> }[], lateReadsCompleted: 0 };
  const overview = (selectedMonth: string, siteId: string | null): TimeReviewOverview => {
    const main = { personId: person.id, name: person.name, team: person.team, siteIds: person.siteIds,
      review: state.detail.review, summary: state.detail.period.summary, issues: state.detail.period.issues, capabilities: state.detail.capabilities };
    const others = [{ ...main, personId: 'review-approved-person', name: 'Bosse Godkänd', team: 'Transport', siteIds: ['stockholm'],
      review: { ...main.review, id: 'review-other', personId: 'review-approved-person', status: 'approved' as const }, issues: [] },
    { ...main, personId: 'review-draft-person', name: 'Disa Utkast', team: 'Gården',
      review: { ...main.review, id: 'review-draft', personId: 'review-draft-person', status: 'draft' as const }, issues: [] }];
    const people = [main, ...others].filter(value => !siteId || value.siteIds.includes(siteId));
    return { serverNow, today, month: selectedMonth, sites, people,
      capabilities: { canRead: true, canApprove: true, canExport: true },
      summary: { total: people.length, draft: people.filter(value => value.review.status === 'draft').length,
        submitted: people.filter(value => value.review.status === 'submitted').length, approved: people.filter(value => value.review.status === 'approved').length,
        returned: people.filter(value => value.review.status === 'returned').length, reopened: people.filter(value => value.review.status === 'reopened').length } };
  };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, query = Object.fromEntries(url.searchParams);
    if (path === '/api/application/personnel-time-review') {
      if (query.siteId === 'all') return route.fulfill({ status: 404, json: { error: 'Alla är inget anläggnings-ID.' } });
      if (query.format === 'csv') {
        state.exports.push({ query, headers: request.headers() });
        if (state.denyCsv) return route.fulfill({ status: 403, json: { error: 'Din åtkomst till månadsrapporterna har återkallats.' } });
        return route.fulfill({ contentType: 'text/csv; charset=utf-8', body: `person;month;version;recordedMinutes\n${person.id};${month};${query.version ?? state.detail.review.version};${query.version === '1' ? 720 : 780}\n` });
      }
      if (request.method() === 'POST') {
        const command = request.postDataJSON() as TimeReviewCommand;
        state.writes.push({ command, query, headers: request.headers() });
        await options.writeGate;
        const fromStatus = state.detail.review.status;
        const status: TimeReviewStatus = command.action === 'review.approve' ? 'approved' : command.action === 'review.return' ? 'returned' : 'reopened';
        state.detail.review = { ...state.detail.review, status, revision: state.detail.review.revision + 1, reason: command.reason ?? null,
          ...(status === 'approved' ? { approvedAt: serverNow } : status === 'returned' ? { returnedAt: serverNow } : { reopenedAt: serverNow }) };
        state.detail.period.source = status === 'approved' ? 'approved' : 'live';
        state.detail.capabilities = { ...state.detail.capabilities, canApprove: false, canReturn: false, canReopen: status === 'approved', canExport: status === 'approved' };
        if (status === 'approved') state.detail.versions.push({ version: 2, sourceHash: state.detail.period.sourceHash, calculatedAt: serverNow,
          submittedAt: state.detail.review.submittedAt!, approvedAt: serverNow, summary: structuredClone(state.detail.period.summary) });
        state.detail.history.push({ id: `review-event-${state.writes.length}`, action: command.action, at: serverNow,
          actualUserId: actualUser.id, effectiveUserId: actualUser.id, reason: command.reason ?? null, fromStatus, toStatus: status,
          version: state.detail.review.version, snapshotHash: state.detail.review.snapshotHash });
        return route.fulfill({ json: state.detail });
      }
      state.reads.push({ query, headers: request.headers() });
      const response = query.personId ? structuredClone(state.detail) : overview(query.month, url.searchParams.get('siteId'));
      if (state.readGate) { await state.readGate; state.lateReadsCompleted++; }
      return route.fulfill({ json: response });
    }
    const response = path === '/api/platform/session' ? state.session
      : path === '/api/application/personnel' ? personnel
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: actualUser.id, user: actualUser,
        csrfToken: 'review-environment-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: actualUser.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: actualUser.id,
        sites, terminals: [], approvals: [], defaults: [] }
      : path === '/api/pricing/state' ? { version: 'review-fixture', memoryOnly: false, revision: 1, asOfDate: today,
        metals: [], articles: [], customers: data.customers, users: data.users, customerPrices: [], audit: [] } : undefined;
    return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Tjänsten ingår inte i det lokala månadsgranskningstestet.' } });
  });
  await page.goto(`/kontor#/personnel/time-review?month=${month}${options.detail ? `&personId=${person.id}` : ''}`);
  await expect(page.getByRole('heading', { name: options.detail ? person.name : 'Månadsgranskning', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: options.detail ? 'Dagar i månaden' : 'Månadens tidrapporter', exact: true })).toBeVisible();
  return state;
}

test('månadslistan filtrerar personal och dagsunderlaget skiljer stämplad tid från fördelning, frånvaro och arbetsordertimmar', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await setup(page);
  expect(state.reads[0].query).toEqual({ month });
  expect(state.reads[0].headers).toMatchObject({ 'x-platform-csrf': 'review-fixture', 'x-platform-generation': '6',
    'x-platform-organisation-id': 'jeroc-demo', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  await expect(page.locator('.hr-review-table tbody tr')).toHaveCount(3);
  const row = page.getByRole('row', { name: `Öppna tidrapport för ${person.name}`, exact: true });
  await expect(row.getByRole('cell').nth(2)).toHaveText('13 h');
  await expect(row.getByRole('cell').nth(3)).toHaveText('2 h');
  await page.getByRole('combobox', { name: 'Tidrapportens status', exact: true }).selectOption('submitted');
  await expect(page.locator('.hr-review-table tbody tr')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'Tidrapportens status', exact: true }).selectOption('all');
  await page.getByRole('combobox', { name: 'Tidrapportens anläggning', exact: true }).selectOption('norrtalje');
  await expect.poll(() => state.reads.at(-1)?.query.siteId).toBe('norrtalje');
  await expect(page.locator('.hr-review-table tbody tr')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Sök tidrapporter', exact: true }).fill('Lovisa');
  await expect(page.locator('.hr-review-table tbody tr')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('personnel-time-review-list-1440x900.png') });
  await row.focus(); await row.press('Enter');
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toBeVisible();
  await expect.poll(() => state.reads.at(-1)?.query).toEqual({ month, siteId: 'norrtalje', personId: person.id });
  await expect(page.locator('.hr-review-kpis > div').nth(1).locator('strong')).toHaveText('13 h');
  await expect(page.locator('.hr-review-kpis > div').nth(2).locator('strong')).toHaveText('2 h');
  const firstDay = page.locator('.hr-review-day-table tbody tr').nth(0);
  await expect(firstDay.getByRole('cell').nth(2)).toHaveText('7 h');
  await expect(firstDay.getByRole('cell').nth(4)).toHaveText('1 h');
  await expect(firstDay.getByRole('cell').nth(5)).toHaveText('4 h');
  await expect(page.getByText('Stämpelklocka', { exact: true })).toBeVisible();
  await expect(page.locator('.hr-review-clock-list')).toContainText('08:00 – 15:30');
  await expect(page.locator('.hr-review-clock-list')).toContainText('Rast 12:00 – 12:30');
  await expect(page.locator('.hr-review-clock-list li > strong')).toHaveText('7 h');
  await expect(page.locator('.hr-review-allocation-list')).toContainText('Sortering koppar');
  await expect(page.getByText('Fördelad tid räknas inom stämplad arbetstid.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('personnel-time-review-detail-1440x900.png') });
  await page.locator('.hr-review-day-table tbody tr').nth(1).getByRole('button').click();
  await expect(page.locator('.hr-review-day-detail').getByText('Arbetsorder och manuell tid', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Inga stämplade pass för dagen.', { exact: true })).toBeVisible();
  await expect(page.locator('.hr-review-allocation-list')).toContainText('Lastning på arbetsorder');
  await expect(page.locator('.hr-review-day-table tbody tr').nth(1).getByRole('cell').nth(2)).toHaveText('6 h');
  await expect(page.locator('.hr-review-day-table tbody tr').nth(1).getByRole('cell').nth(3)).toHaveText('2 h');
  expect(state.writes).toHaveLength(0); expect(errors).toEqual([]);
});

test('godkännande kräver motivering vid saknade timmar och sparar en enda månads- och revisionsbunden version', async ({ page }) => {
  const gate = deferred(), state = await setup(page, { detail: true, writeGate: gate.promise });
  await page.getByRole('button', { name: 'Godkänn månad', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Godkänn månadsrapport', exact: true });
  const reason = dialog.getByLabel('Motivering till godkännande', { exact: true });
  const save = dialog.getByRole('button', { name: 'Godkänn och spara månad', exact: true });
  await expect(dialog).toContainText('Registrerad tid understiger timkravet.');
  await expect(reason).toHaveAttribute('required', ''); await expect(save).toBeDisabled();
  await reason.fill('  '); await expect(save).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  const explanation = 'Avtalad utbildning; timfördelningen är kontrollerad.';
  await reason.fill(`  ${explanation}  `);
  await save.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(dialog.getByRole('textbox', { name: 'Motivering till godkännande', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Sparar…', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Granskningsmånad', { exact: true })).toBeDisabled();
  const write = state.writes[0];
  expect(write.command).toEqual({ action: 'review.approve', personId: person.id, month, revision: 7, reason: explanation,
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
  expect(write.query).toEqual({ month, personId: person.id });
  expect(write.headers).toMatchObject({ 'x-platform-csrf': 'review-fixture', 'x-platform-generation': '6',
    'x-platform-organisation-id': 'jeroc-demo', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  gate.release();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Godkänd · version 2', exact: true })).toBeVisible();
  await expect(page.getByText('Godkänd och sparad version', { exact: true })).toBeVisible();
  await expect(page.locator('.hr-review-history')).toContainText(explanation);
  await expect(page.getByRole('button', { name: 'CSV version 2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Godkänn månad', exact: true })).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
});

test('återlämning och återöppning kräver skäl, CSV-versioner bevaras och återkallad eller ändrad åtkomst rensar privata data', async ({ page }) => {
  const state = await setup(page, { detail: true });
  await page.getByRole('button', { name: 'Återlämna', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Återlämna tidrapport', exact: true });
  await expect(dialog.getByRole('button', { name: 'Återlämna rapport', exact: true })).toBeDisabled();
  const returnReason = 'Komplettera den saknade arbetstimmen den första september.';
  await dialog.getByLabel('Kommentar till den anställde', { exact: true }).fill(returnReason);
  await dialog.getByRole('button', { name: 'Återlämna rapport', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Återlämnad · version 2', exact: true })).toBeVisible();
  await expect(page.locator('.hr-review-history')).toContainText(returnReason);
  expect(state.writes[0].command).toMatchObject({ action: 'review.return', reason: returnReason, month, personId: person.id, revision: 7 });

  // A fresh server response supplies the later approval before reopening.
  state.detail.review = { ...state.detail.review, status: 'approved', revision: 9, approvedAt: serverNow };
  state.detail.period.source = 'approved';
  state.detail.capabilities = { ...state.detail.capabilities, canReopen: true, canExport: true };
  state.detail.versions.push({ version: 2, sourceHash: 'submitted-source-v2', calculatedAt: serverNow,
    submittedAt: state.detail.review.submittedAt!, approvedAt: serverNow, summary: structuredClone(summary) });
  await page.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Godkänd · version 2', exact: true })).toBeVisible();
  const currentDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Godkänd CSV', exact: true }).click();
  expect((await currentDownload).suggestedFilename()).toBe(`tidrapport-${month}-${person.id}.csv`);
  expect(state.exports[0].query).toEqual({ month, personId: person.id, format: 'csv' });
  await page.getByRole('button', { name: 'Återöppna', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Återöppna godkänd månad', exact: true });
  await expect(dialog.getByRole('button', { name: 'Återöppna månad', exact: true })).toBeDisabled();
  const reopenReason = 'Ytterligare underlag har inkommit och måste granskas.';
  await dialog.getByLabel('Anledning till återöppning', { exact: true }).fill(reopenReason);
  await dialog.getByRole('button', { name: 'Återöppna månad', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Återöppnad · version 2', exact: true })).toBeVisible();
  await expect(page.locator('.hr-review-history')).toContainText(reopenReason);
  expect(state.writes[1].command).toMatchObject({ action: 'review.reopen', reason: reopenReason, month, personId: person.id, revision: 9 });
  await expect(page.getByRole('button', { name: 'Godkänd CSV', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV version 2', exact: true })).toBeVisible();
  const historicalDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV version 1', exact: true }).click();
  expect((await historicalDownload).suggestedFilename()).toBe(`tidrapport-${month}-${person.id}-v1.csv`);
  expect(state.exports[1].query).toEqual({ month, personId: person.id, format: 'csv', version: '1' });
  expect(state.exports[1].headers).toMatchObject({ 'x-platform-generation': '6', 'x-platform-organisation-id': 'jeroc-demo' });

  state.denyCsv = true;
  await page.getByRole('button', { name: 'CSV version 1', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Din åtkomst till månadsrapporterna har återkallats.');
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toHaveCount(0);
  await expect(page.locator('.hr-review-kpis')).toHaveCount(0);
  await expect(page.locator('.hr-review-history')).toHaveCount(0);
  await expect(page.locator('.hr-review-day-table')).toHaveCount(0);
  await expect(page.getByText(privateReason, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV version 1', exact: true })).toHaveCount(0);

  state.denyCsv = false;
  await page.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toBeVisible();
  const late = deferred(); state.readGate = late.promise;
  const reads = state.reads.length;
  await page.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect.poll(() => state.reads.length).toBe(reads + 1);
  const revoked: OfficeUser = { ...state.session.user, level: 'Medarbetare', permissions: ['view', 'personnelRead'] };
  state.session = { ...state.session, generation: 7, csrfToken: 'review-new-scope', user: revoked };
  await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session')));
  await expect(page.getByText('Du saknar behörighet att granska personalens månadsrapporter.', { exact: true })).toBeVisible();
  late.release();
  await expect.poll(() => state.lateReadsCompleted).toBe(1);
  await expect(page.getByRole('heading', { name: person.name, exact: true })).toHaveCount(0);
  await expect(page.locator('.hr-review-kpis')).toHaveCount(0);
  await expect(page.locator('.hr-review-history')).toHaveCount(0);
  await expect(page.getByText(privateReason, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
});
