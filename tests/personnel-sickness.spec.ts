import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { SicknessManagementCommand, SicknessManagementResponse } from '../src/employee/sickness-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false, locale: 'sv-SE', timezoneId: 'America/New_York' });
const personId = 'sickness-worker', today = '2026-10-13';
function sicknessFixture(): SicknessManagementResponse {
  return { revision: 4, today, policy: { revision: 2, dailyContact: true, contactByMinute: 480, agreement: 'unknown', agreementName: '', calculationConfirmed: false, effectiveFrom: '2026-01-01' },
    people: [{ id: personId, name: 'Lovisa Sjuktest', siteIds: ['norrtalje'], active: true }],
    cases: [{ id: 'sick-case-1', personId, personName: 'Lovisa Sjuktest', revision: 3, status: 'open', fromDate: '2026-10-12', extent: 100,
      forecast: { kind: 'unknown' }, declared: true, declaredAt: '2026-10-12T05:00:00Z', reportedAt: '2026-10-12T05:00:00Z', cycleId: 'sick-cycle-1', relapse: false,
      lastContactDate: '2026-10-12', contacts: [{ date: '2026-10-12', at: '2026-10-12T05:00:00Z', extent: 100 }], certificate: { received: false, reference: '' },
      followup: { certificateRequired: false, certificateDueDate: '2026-10-19', insurerReportDue: false, insurerReportDeadline: '2026-11-01', rehabilitationPlanDue: false,
        contactOverdue: true, reviewRequired: true, messages: [] }, timeIssue: false,
      days: [{ date: '2026-10-12', extent: 100, absenceId: 'absence-1', scheduledMinutes: 480, lostMinutes: 480, sourceRevision: 3, timeLocked: false }] }],
    events: [{ id: 'event-1', caseId: 'sick-case-1', personId, action: 'sickness.report', at: '2026-10-12T05:00:00Z', actualUserId: 'worker-user', effectiveUserId: 'worker-user', text: 'Sjukanmälan registrerad.' }],
    profiles: [], highRiskDecisions: [], deductionImports: [], capabilities: ['absenceRead', 'absenceWrite', 'salaryRead', 'salaryWrite', 'policyWrite'], notificationCount: 1,
    underlay: { available: false, generatedAt: `${today}T09:00:00Z`, currency: 'SEK', calculationStatus: 'missing_basis', messages: ['Löneunderlag behöver bekräftas.'],
      rows: [], cycles: [], totalSalaryLoss: null, totalGrossSickPay: null, totalDeduction: null, totalPayableSickPay: null } };
}
async function setup(page: Page, options: { actualNoRead?: boolean; noSalary?: boolean } = {}) {
  const data = migrateOffice(seedOffice()), admin = structuredClone(data.users.find(user => user.id === 'admin')!);
  const actualUser: OfficeUser = options.actualNoRead ? { ...admin, id: 'readonly-actor', level: 'Medarbetare', permissions: ['view', 'personnelRead'] } : admin;
  const user = options.noSalary ? { ...admin, level: 'Medarbetare' as const, permissions: ['view', 'personnelRead', 'absenceRead', 'absenceWrite'] as OfficeUser['permissions'] } : admin;
  const state = { sickness: sicknessFixture(), reads: 0, commands: [] as { command: SicknessManagementCommand; headers: Record<string, string> }[],
    denyRead: false, denyCsv: false, uncertainWrite: false, uploads: [] as { headers: Record<string, string>; body: Buffer | null }[], files: [] as { id: string; name: string; contentType: string; size: number; uploadedAt: string; caseId: string }[] };
  if (options.noSalary) state.sickness.capabilities = ['absenceRead', 'absenceWrite'];
  const session = { enabled: true, authenticated: true, actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user,
    company: { id: 'jeroc-demo', name: 'Sjuktestbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo', effectiveUserId: user.id,
    isSupportSession: actualUser.id !== user.id, mustChangePassword: false, csrfToken: 'sickness-fixture', generation: 9, companies: [] };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/personnel/sickness') {
      if (url.searchParams.get('format') === 'csv') return route.fulfill(state.denyCsv ? { status: 403, json: { error: 'Lönebehörigheten har återkallats.' } } : { contentType: 'text/csv', headers: { 'Content-Disposition': 'attachment; filename="sjuktest.csv"' }, body: 'Datum;Karensavdrag\r\n2026-10-12;640.00' });
      if (request.method() === 'POST') {
        const command = request.postDataJSON() as SicknessManagementCommand; state.commands.push({ command, headers: request.headers() });
        if (state.uncertainWrite) return route.abort('failed');
        const illness = state.sickness.cases[0];
        if (command.action === 'sickness.forecast') { illness.forecast = command.forecast; illness.revision++; }
        if (command.action === 'certificate.save') { illness.certificate = command.certificate; illness.revision++; }
        if (command.action === 'sickness.recover') { illness.status = 'recovered'; illness.lastSickDate = command.lastSickDate; illness.recoveryMinute = command.recoveryMinute; illness.revision++; }
        if (command.action === 'sickness.recovery.schedule') { illness.recoveryPlan = { healthyFromDate: command.healthyFromDate, registeredAt: `${today}T16:00:00Z` }; illness.revision++; }
        if (command.action === 'sickness.recovery.cancel') { delete illness.recoveryPlan; illness.revision++; }
        if (command.action === 'payprofile.save') state.sickness.profiles = [{ ...command.profile, revision: 1 }];
      } else state.reads++;
      if (state.denyRead) return route.fulfill({ status: 403, json: { error: 'Åtkomst till sjukfrånvaron har återkallats.' } });
      return route.fulfill({ json: state.sickness });
    }
    if (path === '/api/personnel/sickness/files') {
      if (request.method() === 'POST') {
        state.uploads.push({ headers: request.headers(), body: request.postDataBuffer() });
        const file = { id: 'private-certificate', name: decodeURIComponent(request.headers()['x-file-name']), contentType: request.headers()['content-type'], size: request.postDataBuffer()!.length, uploadedAt: `${today}T09:00:00Z`, caseId: 'sick-case-1' };
        state.files.push(file); return route.fulfill({ json: { file } });
      }
      return route.fulfill({ json: { files: state.files } });
    }
    const response = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: user.id, user, csrfToken: 'environment-sickness', expiresAt: '2099-01-01T00:00:00Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/mail/state' ? { organisationId: 'jeroc-demo', configuration: { ready: false, missing: [], issues: [] }, connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: true, canManage: true }, mode: 'live' }
      : undefined;
    return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Endast isolerade testanrop tillåts.' } });
  });
  await page.goto('/kontor#/personnel/sickness');
  return state;
}
async function openCase(page: Page) {
  const row = page.getByRole('row', { name: 'Öppna sjukärende för Lovisa Sjuktest' });
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Sjukärendet', exact: true })).toBeVisible();
}

test('prognos är separat från friskanmälan och skrivningen behåller företagets säkerhetsscope', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await setup(page); await openCase(page);
  await page.getByRole('button', { name: 'Ändra prognos', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uppdatera prognos', exact: true });
  await dialog.getByRole('combobox', { name: 'Uppskattad återkomst', exact: true }).selectOption('date');
  await dialog.getByLabel('Uppskattat datum', { exact: true }).fill('2026-10-15');
  await dialog.getByRole('button', { name: 'Spara', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(dialog).toHaveCount(0); expect(state.commands).toHaveLength(1);
  expect(state.commands[0].command).toMatchObject({ action: 'sickness.forecast', personId, id: 'sick-case-1', revision: 3, forecast: { kind: 'date', date: '2026-10-15' } });
  expect(state.commands[0].command).not.toHaveProperty('reason');
  expect(state.commands[0].headers).toMatchObject({ 'x-platform-csrf': 'sickness-fixture', 'x-platform-generation': '9', 'x-platform-organisation-id': 'jeroc-demo', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' });
  await expect(page.getByText('Pågående sjukfrånvaro', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('löneunderlag visar saknade belopp och kräver verifierad grund utan gissad månadslön', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: 'Sjuklön & karens', exact: true }).click();
  await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption(personId);
  await expect(page.getByText('Underlag saknas', { exact: true })).toBeVisible();
  await expect(page.getByText('Ej beräknat', { exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: 'Beräkningsunderlag', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Beräkningsunderlag för sjuklön', exact: true });
  await expect(dialog.getByLabel('Verifierad sjuklönegrund per timme (kr)', { exact: true })).toHaveValue('');
  await dialog.getByLabel('Verifierad sjuklönegrund per timme (kr)', { exact: true }).fill('100');
  await dialog.getByLabel('Genomsnittlig normal veckoarbetstid', { exact: true }).fill('40');
  await dialog.getByLabel('Källa och tillämplig avtalsregel', { exact: true }).fill('Verifierad timlön och schema enligt löneunderlag 2026.');
  await dialog.getByLabel('Jag har verifierat lönegrunden och tillämpliga avtalsregler').check();
  await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(state.commands[0].command).toMatchObject({ action: 'payprofile.save', profile: { personId, hourlyBase: 100, averageWeeklyHours: 40, sickPayRate: .8, confirmed: true, revision: 0 } });
  state.denyCsv = true;
  await page.getByRole('button', { name: 'Exportera CSV', exact: true }).click();
  await expect(page.getByText('Lönebehörigheten har återkallats.', { exact: true })).toBeVisible();
  await expect(page.getByText('Verifierad timlön och schema enligt löneunderlag 2026.', { exact: true })).toHaveCount(0);
});

test('intygsfiler laddas upp privat och giltighetsdatum registreras separat', async ({ page }) => {
  const state = await setup(page); await openCase(page);
  await page.getByLabel('Välj intygsfil', { exact: true }).setInputFiles({ name: 'läkarintyg.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nprivate fixture\n%%EOF') });
  await expect(page.getByText('läkarintyg.pdf', { exact: true })).toBeVisible();
  expect(state.uploads).toHaveLength(1); expect(state.uploads[0].headers).toMatchObject({ 'content-type': 'application/pdf', 'x-platform-csrf': 'sickness-fixture', 'x-platform-generation': '9' });
  expect(state.uploads[0].body?.toString()).toContain('%PDF');
  await page.getByRole('button', { name: 'Registrera intyg', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrera läkarintyg', exact: true });
  await dialog.getByLabel('Läkarintyget är mottaget').check();
  await dialog.getByLabel('Intyget gäller från', { exact: true }).fill('2026-10-12');
  await dialog.getByLabel('Intyget gäller till', { exact: true }).fill('2026-10-20');
  await dialog.getByLabel('Referens till skyddat intyg', { exact: true }).fill('läkarintyg.pdf');
  await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(dialog).toHaveCount(0); expect(state.commands[0].command).toMatchObject({ action: 'certificate.save', personId, certificate: { received: true, fromDate: '2026-10-12', toDate: '2026-10-20', reference: 'läkarintyg.pdf' } });
  expect(state.commands[0].command).not.toHaveProperty('reason');
  await expect(page.locator('a[href*="sickness/files"]')).toHaveCount(0);
});

test('löneuppgifter är separata och faktisk användare måste också ha sjukfrånvaroåtkomst', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
  await setup(page, { noSalary: true }); await expect(page.getByRole('heading', { name: 'Sjukfrånvaro', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sjuklön & karens', exact: true })).toHaveCount(0);
  await expect(page.getByText('100,00 kr', { exact: true })).toHaveCount(0); await context.close();
  const deniedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), deniedPage = await deniedContext.newPage();
  const denied = await setup(deniedPage, { actualNoRead: true });
  await expect(deniedPage.getByText(/Du saknar behörighet att läsa sjukfrånvaro/)).toBeVisible();
  expect(denied.reads).toBe(0); await expect(deniedPage.getByText('Lovisa Sjuktest', { exact: true })).toHaveCount(0); await deniedContext.close();
});

test('osäker skrivning gör inget automatiskt nytt försök och kräver statuskontroll', async ({ page }) => {
  const state = await setup(page); await openCase(page); state.uncertainWrite = true;
  await page.getByRole('button', { name: 'Ändra prognos', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uppdatera prognos', exact: true });
  await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(page.getByText(/Det är osäkert om senaste ändringen sparades/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Spara', exact: true })).toBeDisabled(); expect(state.commands).toHaveLength(1);
  state.uncertainWrite = false; await dialog.getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.getByRole('button', { name: 'Kontrollera status', exact: true }).click();
  await expect(page.getByText(/Det är osäkert om senaste ändringen sparades/)).toHaveCount(0); expect(state.commands).toHaveLength(1);
});

test('återkallad läsrätt tar bort tidigare hämtade privata ärenden', async ({ page }) => {
  const state = await setup(page); await openCase(page); state.denyRead = true;
  await page.getByRole('button', { name: 'Uppdatera', exact: true }).click();
  await expect(page.getByText('Åtkomst till sjukfrånvaron har återkallats.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sjukärendet', exact: true })).toHaveCount(0);
  await expect(page.getByText('Lovisa Sjuktest', { exact: true })).toHaveCount(0);
});

test('HR kan registrera och återkalla framtida friskanmälan med bibehållen dagens frånvaro', async ({ page }) => {
  const state = await setup(page); await openCase(page);
  await page.getByRole('button', { name: 'Friskanmäl', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrera friskanmälan', exact: true });
  await dialog.getByRole('combobox', { name: 'När är personen frisk?', exact: true }).selectOption('date');
  await dialog.getByLabel('Frisk från datum', { exact: true }).fill('2026-10-17');
  await expect(dialog.getByLabel('Sista faktiska sjukdag', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.commands[0].command).toMatchObject({ action: 'sickness.recovery.schedule', personId, id: 'sick-case-1', revision: 3, healthyFromDate: '2026-10-17' });
  expect(state.sickness.cases[0].status).toBe('open'); expect(state.sickness.cases[0].lastSickDate).toBeUndefined();
  await expect(page.getByText('Friskanmälan registrerad – frisk från', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Ändra friskanmälan', exact: true }).click();
  await expect(dialog.getByLabel('Frisk från datum', { exact: true })).toHaveValue('2026-10-17');
  await dialog.getByRole('button', { name: 'Avbryt', exact: true }).click();
  await page.getByRole('button', { name: 'Återkalla friskanmälan', exact: true }).click();
  const cancel = page.getByRole('dialog', { name: 'Återkalla friskanmälan', exact: true });
  await expect(cancel.getByText('Sjukfrånvaron fortsätter', { exact: false })).toBeVisible();
  await cancel.getByRole('button', { name: 'Spara', exact: true }).click();
  await expect(cancel).toHaveCount(0); expect(state.commands).toHaveLength(2);
  expect(state.commands[1].command).toMatchObject({ action: 'sickness.recovery.cancel', personId, id: 'sick-case-1', revision: 4 });
  expect(state.sickness.cases[0].status).toBe('open'); expect(state.sickness.cases[0].recoveryPlan).toBeUndefined();
  expect(state.commands[1].headers).toMatchObject({ 'x-platform-csrf': 'sickness-fixture', 'x-platform-generation': '9', 'x-platform-organisation-id': 'jeroc-demo' });
  await expect(page.getByRole('button', { name: 'Friskanmäl', exact: true })).toBeVisible();
});
