import { expect, test, type Page, type Request } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { seedTransport } from '../src/office/transport/model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { Person, PersonnelCommand, PersonnelResponse } from '../src/office/personnel/types';

const token = 'aB09_-'.repeat(7) + 'x';
const password = 'Min personliga trygga lösenfras 2026!';
const inviteEmail = 'alma@example.test';
test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function publicActivation(page: Page, options: { failFirst?: boolean; invalid?: boolean; malformed?: boolean; gate?: Promise<void> } = {}) {
  const requests: Request[] = [], nonPublic: string[] = [];
  let sessionReads = 0, confirmations = 0;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(request);
    if (path === '/api/platform/session') {
      sessionReads++;
      return route.fulfill({ status: 401, json: { error: 'En gammal inloggning ska inte påverka inbjudan.' } });
    }
    if (path === '/api/platform/staff-invitations/confirm') {
      confirmations++;
      if (options.failFirst && confirmations === 1) return route.abort('failed');
      await options.gate;
      return route.fulfill({ status: options.invalid ? 422 : 200, json: options.invalid
        ? { error: 'Inbjudningslänken är ogiltig eller har gått ut. Be din administratör skicka en ny.', code: 'staff_invitation_invalid' }
        : options.malformed ? { ok: false } : { ok: true } });
    }
    nonPublic.push(path);
    return route.fulfill({ status: 503, json: { error: 'Detta anrop ingår inte i aktiveringsprovet.' } });
  });
  return { requests, nonPublic, sessionReads: () => sessionReads, confirmations: () => confirmations };
}

async function openActivation(page: Page) {
  await page.goto(`/kontor/#/activate-account?token=${token}`);
  await expect(page.getByRole('heading', { name: 'Välj ditt lösenord', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/activate-account$/);
}
async function fillActivation(page: Page, confirmation = password) {
  await page.getByLabel('Nytt lösenord', { exact: true }).fill(password);
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill(confirmation);
}

test('personalinbjudan öppnas publikt utan sessionskontroll och förbrukas aldrig genom att länken öppnas', async ({ page }) => {
  const f = await publicActivation(page);
  await openActivation(page);
  expect(f.sessionReads()).toBe(0); expect(f.nonPublic).toEqual([]); expect(f.confirmations()).toBe(0);
  expect(f.requests).toHaveLength(0);
  await expect(page.locator('body')).not.toContainText(token);
});

test('lösenord bekräftas före aktivering och engångslänken skickas enbart i JSON utan automatisk inloggning', async ({ page }) => {
  const f = await publicActivation(page);
  await openActivation(page); await fillActivation(page, 'Ett helt annat långt lösenord!');
  await page.getByRole('button', { name: 'Aktivera konto', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('stämmer inte överens');
  expect(f.confirmations()).toBe(0);
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Aktivera konto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kontot är aktiverat', exact: true })).toBeVisible();
  expect(f.confirmations()).toBe(1); expect(f.sessionReads()).toBe(0); expect(f.nonPublic).toEqual([]);
  const confirmation = f.requests.find(request => request.url().endsWith('/staff-invitations/confirm'))!;
  expect(confirmation.method()).toBe('POST');
  expect(confirmation.postDataJSON()).toEqual({ token, newPassword: password, confirmPassword: password });
  expect(f.requests.every(request => !request.url().includes(token))).toBe(true);
  await expect(page.getByLabel('Nytt lösenord', { exact: true })).toHaveCount(0);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(token); expect(storage).not.toContain(password);
  await expect(page).toHaveURL(/#\/activate-account$/);
});

test('saknad eller dubblerad inbjudningstoken ger inget lösenordsformulär eller serveranrop', async ({ page }) => {
  const f = await publicActivation(page);
  for (const fragment of ['#/activate-account', '#/activate-account?token=fel', `#/activate-account?token=${token}&token=${token}`]) {
    await page.goto(`/kontor/${fragment}`);
    await expect(page.getByRole('alert')).toContainText('Länken saknas eller är ogiltig');
    await expect(page.getByLabel('Nytt lösenord', { exact: true })).toHaveCount(0);
  }
  expect(f.confirmations()).toBe(0); expect(f.sessionReads()).toBe(0); expect(f.nonPublic).toEqual([]);
});

test('utgången eller förbrukad inbjudan visas som fel och får aldrig visas som aktiverad', async ({ page }) => {
  const f = await publicActivation(page, { invalid: true });
  await openActivation(page); await fillActivation(page);
  await page.getByRole('button', { name: 'Aktivera konto', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ogiltig eller har gått ut');
  await expect(page.getByRole('heading', { name: 'Kontot är aktiverat', exact: true })).toHaveCount(0);
  expect(f.confirmations()).toBe(1);
});

test('nätfel tillåter nytt försök med samma inbjudan och samtidiga submit gör bara ett anrop', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await publicActivation(page, { failFirst: true, gate });
  await openActivation(page); await fillActivation(page);
  await page.getByRole('button', { name: 'Aktivera konto', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Kontrollera anslutningen');
  await page.locator('form').evaluate(form => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(f.confirmations).toBe(2);
  await expect(page.locator('form button[type="submit"]')).toBeDisabled();
  release();
  await expect(page.getByRole('heading', { name: 'Kontot är aktiverat', exact: true })).toBeVisible();
  expect(f.confirmations()).toBe(2);
});

test('ofullständigt aktiveringssvar ger fel i stället för ett falskt framgångsbesked', async ({ page }) => {
  await publicActivation(page, { malformed: true });
  await openActivation(page); await fillActivation(page);
  await page.getByRole('button', { name: 'Aktivera konto', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('resultat kunde inte bekräftas');
  await expect(page.getByRole('heading', { name: 'Kontot är aktiverat', exact: true })).toHaveCount(0);
});

async function personnelFixture(page: Page, options: { saveGate?: Promise<void>; failFirstSend?: boolean; failSave?: boolean } = {}) {
  const office = seedOffice(), admin = office.users.find(user => user.id === 'admin')!;
  office.users = [admin];
  const company = { id: 'invitation-company', name: 'Inbjudningsprov AB', organisationNumber: '5593593626', status: 'active' as const };
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'inviter-platform-actor', name: admin.name, username: 'admin', platformAdmin: true }, actualUser: admin, user: admin,
    company, organisationId: company.id, effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false,
    csrfToken: 'staff-invitation-csrf', generation: 13, companies: [company] };
  const personnel: PersonnelResponse = { data: { version: 1, revision: 1, people: [], companies: [], employment: [], salaries: [],
    schedules: [], absences: [], competencies: [], staffingTasks: [], externalAccounts: [], audit: [] }, revision: 1,
    storage: 'database', demo: true, capabilities: ['personnelRead', 'personnelWrite', 'users'],
    sites: [{ id: 'norrtalje', name: 'Norrtälje' }], transport: seedTransport('2026-10-20'), users: office.users };
  const personWrites: PersonnelCommand[] = [], invitationWrites: Request[] = [], manualWrites: Request[] = [], events: string[] = [];
  let committed = false, invitationStatus = 'not_invited';
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path === '/api/application/personnel') {
      if (request.method() === 'POST') {
        const command = request.postDataJSON() as PersonnelCommand;
        personWrites.push(command); events.push('person.save.started'); await options.saveGate;
        if (options.failSave) return route.fulfill({ status: 422, json: { error: 'Personen kunde inte sparas i provet.' } });
        if (command.action !== 'person.save') throw new Error('Provet stöder bara person.save.');
        const person: Person = { active: true, role: '', team: '', siteIds: ['norrtalje'], phone: '', email: '', address: '',
          canDrive: false, revision: 1, ...command.person, id: command.person.id ?? 'invited-person',
          ...(command.createAccount?.kind === 'staff' ? { userId: 'invited-staff-user' } : {}) };
        personnel.data.people = [person];
        if (person.userId) {
          const account: OfficeUser = { id: person.userId, name: person.name, level: 'Medarbetare', permissions: ['view'],
            siteIds: ['norrtalje'], active: true, maxAttest: 0, ownAttest: false };
          office.users = [admin, account]; personnel.users = office.users;
        }
        personnel.revision++; personnel.data.revision++;
        committed = true; events.push('person.save.committed');
      }
      return route.fulfill({ json: personnel });
    }
    if (path === '/api/platform/staff-invitations') {
      const person = personnel.data.people[0];
      if (request.method() === 'POST') {
        expect(committed).toBe(true); invitationWrites.push(request); events.push('invitation.send');
        if (options.failFirstSend && invitationWrites.length === 1) return route.fulfill({ status: 503,
          json: { error: 'Mejltjänsten nekade personalinbjudan. Försök igen.', code: 'system_email_rejected' } });
        invitationStatus = 'sent';
        return route.fulfill({ json: { ok: true, personId: person.id, status: 'sent', email: person.email, expiresAt: '2026-10-21T10:00:00.000Z' } });
      }
      return route.fulfill({ json: { personId: url.searchParams.get('personId'), status: invitationStatus,
        email: person?.email ?? inviteEmail, ...(invitationStatus === 'sent' ? { expiresAt: '2026-10-21T10:00:00.000Z' } : {}) } });
    }
    if (path === '/api/platform/staff-invitations/temporary-password') {
      expect(committed).toBe(true); manualWrites.push(request); events.push('manual.setup');
      invitationStatus = 'temporary_password';
      return route.fulfill({ json: { ok: true, personId: personnel.data.people[0].id, status: 'temporary_password', email: personnel.data.people[0].email,
        username: personnel.data.people[0].email, mustChangePassword: true } });
    }
    const value = path === '/api/platform/session' ? session
      : path === '/api/company-settings/defaults' ? { companyId: company.id, version: 1, profile: { name: company.name }, defaults: { paymentTermsDays: null } }
      : path === '/api/application/office' ? { data: office, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin,
        csrfToken: 'invitation-environment-csrf', expiresAt: '2099-01-01T00:00:00.000Z', sites: personnel.sites }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id,
        sites: personnel.sites, terminals: [], approvals: [], defaults: [] }
      : path === '/api/terminal-demo/events' ? undefined
      : path === '/api/personnel/vehicles' ? { vehicles: personnel.transport.vehicles, capabilities: { vehicleRead: true, vehicleWrite: true } }
      : path === '/api/pricing/state' ? { version: 'invitation-fixture', memoryOnly: false, revision: 1, asOfDate: '2026-10-20',
        metals: [], articles: [], customers: office.customers, users: office.users, customerPrices: [], audit: [] } : undefined;
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    return route.fulfill({ status: value ? 200 : 503, json: value ?? { error: 'Tjänsten ingår inte i personalinbjudningsprovet.' } });
  });
  await page.goto('/kontor/#/personnel');
  await expect(page.getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
  return { personWrites, invitationWrites, manualWrites, events, personnel };
}

async function newStaffForm(page: Page) {
  await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  await dialog.getByLabel('Namn *', { exact: true }).fill('Alma Testperson');
  await dialog.getByLabel('E-post', { exact: true }).fill(inviteEmail);
  return dialog;
}

test('ny medarbetare får förvalt mejlinbjudan först efter lyckad sparning av person och konto', async ({ page }) => {
  let release!: () => void;
  const saveGate = new Promise<void>(resolve => { release = resolve; });
  const f = await personnelFixture(page, { saveGate });
  const dialog = await newStaffForm(page);
  await expect(dialog.getByRole('checkbox', { name: 'Skapa inloggning', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Inloggningssätt', { exact: true })).toHaveValue('email');
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect.poll(() => f.personWrites.length).toBe(1);
  expect(f.invitationWrites).toHaveLength(0); expect(f.manualWrites).toHaveLength(0);
  release();
  await expect.poll(() => f.invitationWrites.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Inbjudan skickad', { exact: true })).toBeVisible();
  expect(f.events).toEqual(['person.save.started', 'person.save.committed', 'invitation.send']);
  const sent = f.invitationWrites[0];
  expect(sent.postDataJSON()).toEqual({ personId: f.personnel.data.people[0].id, requestId: expect.any(String) });
  expect(sent.headers()['x-platform-csrf']).toBe('staff-invitation-csrf');
  expect(sent.headers()['x-platform-organisation-id']).toBe('invitation-company');
  expect(f.personWrites).toHaveLength(1); expect(f.manualWrites).toHaveLength(0);
});

test('manuellt tillfälligt lösenord väljs uttryckligt och skickar inget inbjudningsmejl', async ({ page }) => {
  const f = await personnelFixture(page);
  const dialog = await newStaffForm(page);
  await dialog.getByLabel('Inloggningssätt', { exact: true }).selectOption({ label: 'Ange tillfälligt lösenord' });
  await dialog.getByLabel('Tillfälligt lösenord', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect.poll(() => f.manualWrites.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Inväntar första lösenordsbytet', { exact: true })).toBeVisible();
  expect(f.invitationWrites).toHaveLength(0); expect(f.personWrites).toHaveLength(1);
  expect(f.manualWrites[0].postDataJSON()).toEqual({ personId: f.personnel.data.people[0].id, requestId: expect.any(String), password });
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(stored).not.toContain(password);
});

test('misslyckad personsparning skickar varken mejl eller kontots tillfälliga lösenord', async ({ page }) => {
  const f = await personnelFixture(page, { failSave: true });
  const dialog = await newStaffForm(page);
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Personen kunde inte sparas');
  expect(f.personWrites).toHaveLength(1); expect(f.invitationWrites).toHaveLength(0); expect(f.manualWrites).toHaveLength(0);
});

test('misslyckat mejl lämnar sparad person kvar och nytt försök görs från personkortet utan dublett', async ({ page }) => {
  const f = await personnelFixture(page, { failFirstSend: true });
  const dialog = await newStaffForm(page);
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect.poll(() => f.invitationWrites.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Alma Testperson', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Skicka inbjudan', exact: true }).click();
  await expect.poll(() => f.invitationWrites.length).toBe(2);
  expect(f.personWrites).toHaveLength(1); expect(f.personnel.data.people).toHaveLength(1);
  expect(f.invitationWrites.map(value => value.postDataJSON().personId)).toEqual([f.personnel.data.people[0].id, f.personnel.data.people[0].id]);
});
