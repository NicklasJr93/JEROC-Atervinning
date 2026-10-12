import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

type Backend = { origin: string; database: string };
const admin = { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' };
const password = 'Employee-Browser-Test-2026!';
const test = base.extend<{ employeeBackend: Backend }>({
  employeeBackend: async ({}, use) => {
    // Every case owns all its data. Browser requests still exercise the actual
    // application service, authentication and durable SQLite repository; no
    // live PostgreSQL, external integrations or shared demo data are touched.
    const directory = await mkdtemp(join(tmpdir(), 'jeroc-employee-browser-'));
    const database = join(directory, 'application.sqlite');
    let output = '';
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, DATABASE_URL: '', RENDER: '', PORT: '0', EXPO_GO_ENABLED: 'false',
        JEROC_APPLICATION_DB_PATH: database,
        JEROC_ENVIRONMENT_DB_PATH: join(directory, 'environment.sqlite'),
        JEROC_TERMINAL_DB_PATH: join(directory, 'terminal.sqlite'),
        JEROC_ARTICLE_MEDIA_DB_PATH: join(directory, 'media.sqlite'),
        JEROC_DOCUMENT_DB_PATH: join(directory, 'documents.sqlite'),
      },
    });
    try {
      const origin = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Employee test server did not start: ${output}`)), 12_000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`Employee test server exited (${code}): ${output}`)); });
        child.stderr?.on('data', chunk => { output += chunk; });
        child.stdout?.on('data', chunk => {
          output += chunk;
          const match = output.match(/lyssnar på port (\d+)/);
          if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
        });
      });
      await use({ origin, database });
    } finally {
      await stop(child);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit');
  child.kill('SIGTERM');
  await ended;
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(75_000);

test.beforeEach(async ({ page, employeeBackend }) => {
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { ...request.headers() };
    if (headers.origin) headers.origin = employeeBackend.origin;
    const response = await route.fetch({ url: `${employeeBackend.origin}${url.pathname}${url.search}`, headers });
    await route.fulfill({ response });
  });
});

async function post(request: APIRequestContext, backend: Backend, path: string, data: unknown) {
  const response = await request.post(`${backend.origin}${path}`, { headers: admin, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function dateInStockholm() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function createEmployee(request: APIRequestContext, backend: Backend, canDrive = false) {
  const suffix = randomUUID().slice(0, 8), personId = `employee-browser-${suffix}`, username = `employee.${suffix}`;
  const created = await post(request, backend, '/api/application/personnel', {
    action: 'person.save', person: {
      id: personId, name: `Testmedarbetare ${suffix}`, kind: 'employee',
      siteIds: ['norrtalje'], canDrive, phone: '0700000000', email: `${suffix}@example.invalid`,
      ...(canDrive ? { vehicleId: 'vehicle-kalle' } : {}),
    }, createAccount: { kind: 'staff', permissions: ['view', 'prepare', 'customers', 'weighingAddArticle', 'weighingEditWeight', 'weighingRemoveArticle'] },
  });
  const person = created.data.people.find((value: { id: string }) => value.id === personId);
  expect(person?.userId).toBeTruthy();
  await post(request, backend, '/api/application/personnel', {
    action: 'employeeAccount.save', personId, username, password, active: true,
  });
  return { person, personId, username };
}

async function login(page: Page, username: string, secret = password) {
  await page.goto('/');
  await page.getByLabel('Användarnamn', { exact: true }).fill(username);
  await page.getByLabel('Lösenord', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
}

async function overview(page: Page, backend: Backend, date = dateInStockholm()) {
  const response = await page.request.get(`${backend.origin}/api/employee/overview?date=${date}&month=${date.slice(0, 7)}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

function modifyIsolatedFixture(backend: Backend, change: (state: any) => void) {
  const database = new DatabaseSync(backend.database);
  try {
    database.exec('BEGIN IMMEDIATE');
    const row = database.prepare('SELECT document FROM application WHERE id=1').get() as { document: string };
    const state = JSON.parse(row.document);
    change(state);
    database.prepare('UPDATE application SET document=?,revision=revision+1 WHERE id=1').run(JSON.stringify(state));
    database.exec('COMMIT');
  } finally { database.close(); }
}

async function fillTime(page: Page, date: string, from: string, to: string, pause = '0') {
  await page.getByLabel('Datum', { exact: true }).fill(date);
  await page.getByLabel('Från', { exact: true }).fill(from);
  await page.getByLabel('Till', { exact: true }).fill(to);
  await page.getByLabel('Rast (minuter)', { exact: true }).fill(pause);
}

test('riktig inloggning ger fyra kompakta huvudvyer och befintlig invägning fungerar', async ({ page, employeeBackend }) => {
  const { username } = await createEmployee(page.request, employeeBackend);
  // The old browser-only demo marker cannot authenticate a real account.
  await page.addInitScript(() => sessionStorage.setItem('jeroc.demo.login', 'yes'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka' })).toBeVisible();
  await page.getByLabel('Användarnamn', { exact: true }).fill(username);
  await page.getByLabel('Lösenord', { exact: true }).fill('Wrong-Password!');
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Fel inloggning');
  await page.getByLabel('Lösenord', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Huvudmeny', exact: true });
  await expect(navigation.getByRole('button')).toHaveText(['Hem', 'Schema', 'Tid', 'Profil']);
  await expect(page.getByRole('img', { name: 'JEROC Återvinning', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  for (const [name, heading] of [['Schema', 'Mitt schema'], ['Tid', 'Tidrapportering'], ['Profil', 'Profil'], ['Hem', /^Hej,/]] as const) {
    await navigation.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: typeof heading === 'string' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('.company-logo')).toHaveCount(0);
  }
  await page.getByRole('button', { name: /^Gårdsarbete/ }).click();
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar' }).click();
  await page.locator('.material-choice').filter({ hasText: 'Koppar klass 1' }).click();
  await page.getByRole('button', { name: 'Välj Koppar klass 1', exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg' }).fill('42');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  const sourceId = new URL(page.url()).hash.match(/\/weigh\/([^/]+)/)![1];
  await page.getByRole('button', { name: 'Spara färdig vägning', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vägningen är sparad' })).toBeVisible();
  const mobile = await page.request.get(`${employeeBackend.origin}/api/application/mobile`);
  expect(mobile.ok(), await mobile.text()).toBe(true);
  expect((await mobile.json()).data.drafts.find((draft: { id: string }) => draft.id === sourceId)).toMatchObject({ status: 'ready' });
  await page.goto('/#/profile');
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka' })).toBeVisible();
  expect((await page.request.get(`${employeeBackend.origin}/api/employee/session`)).status()).toBe(401);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(password);
});

test('manuell tid räknar av rast, består efter omladdning och avvisar överlapp', async ({ page, employeeBackend }) => {
  const { username } = await createEmployee(page.request, employeeBackend);
  const date = addDays(dateInStockholm(), -1);
  await login(page, username);
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  await page.goto(`/#/time?date=${date}&register=1`);
  await expect(page.getByRole('heading', { name: 'Registrera tid', exact: true })).toBeVisible();
  await fillTime(page, date, '07:00', '16:00', '60');
  await page.getByRole('combobox', { name: 'Aktivitet', exact: true }).selectOption('Gårdsarbete');
  await page.getByLabel('Anteckning (valfritt)', { exact: true }).fill('Sortering mellan uppdrag');
  await page.getByRole('button', { name: 'Spara tid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
  let data = await overview(page, employeeBackend, date);
  expect(data.selectedDay).toMatchObject({ recordedMinutes: 480, manualMinutes: 480, automaticMinutes: 0 });
  expect(data.selectedDay.entries).toHaveLength(1);
  expect(data.selectedDay.entries[0]).toMatchObject({ source: 'manual', startMinute: 420, endMinute: 960, breakMinutes: 60, activity: 'Gårdsarbete', note: 'Sortering mellan uppdrag' });
  await page.reload();
  await expect(page.locator('.employee-time-entry')).toContainText('8 h');
  await expect(page.getByRole('region', { name: 'Kalender för registrerad tid', exact: true }).getByRole('button', { name: /8 timmar registrerat/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Registrera tid', exact: true }).click();
  await fillTime(page, date, '09:00', '10:00');
  await page.getByRole('button', { name: 'Spara tid', exact: true }).click();
  await expect(page.getByRole('alert').last()).toContainText('överlappar');
  await expect(page.getByRole('heading', { name: 'Registrera tid', exact: true })).toBeVisible();
  data = await overview(page, employeeBackend, date);
  expect(data.selectedDay.recordedMinutes).toBe(480);
  expect(data.selectedDay.entries).toHaveLength(1);
});

test('saknad gårdagstid spärrar arbete och nätfel kan inte upphäva spärren', async ({ page, employeeBackend }) => {
  const { username, personId } = await createEmployee(page.request, employeeBackend);
  const date = addDays(dateInStockholm(), -1);
  await login(page, username);
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  modifyIsolatedFixture(employeeBackend, state => {
    const requirement = { personId, enabled: true, mode: 'fixed', dailyMinutes: 480, weekdays: [1, 2, 3, 4, 5, 6, 7], effectiveFrom: date, enforcementFrom: date, revision: 2 };
    state.employeeTime.settings = state.employeeTime.settings.filter((item: { personId: string }) => item.personId !== personId).concat(requirement);
    state.employeeTime.requirementHistory = state.employeeTime.requirementHistory.filter((item: { personId: string }) => item.personId !== personId).concat(requirement);
  });
  await page.reload();
  const gate = page.getByRole('dialog', { name: /^Tid saknas för/ });
  await expect(gate).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(gate).toBeVisible();
  expect((await overview(page, employeeBackend, date)).gate).toMatchObject({ blocked: true, date, missingMinutes: 480 });
  const refused = await page.request.post(`${employeeBackend.origin}/api/application/mobile`, { data: { kind: 'import', data: { version: 1, drafts: [], customers: [] } } });
  expect(refused.status()).toBe(423);
  await page.goto('/#/new');
  await expect(page.getByRole('heading', { name: 'Registrera tid', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Materialvåg/ })).toHaveCount(0);
  await fillTime(page, date, '07:00', '16:00', '60');
  let failedSave = false;
  await page.route('**/api/employee/time/save?*', async route => {
    if (!failedSave) {
      failedSave = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tillfälligt nätfel i testet. Försök igen.' }) });
    } else await route.fallback();
  });
  await page.getByRole('button', { name: 'Spara tid', exact: true }).click();
  await expect(page.getByRole('alert').last()).toContainText('Tillfälligt nätfel');
  expect((await overview(page, employeeBackend, date)).gate.blocked).toBe(true);
  await page.goto('/#/');
  await expect(gate).toBeVisible();
  await gate.getByRole('button', { name: 'Registrera tid', exact: true }).click();
  await fillTime(page, date, '07:00', '16:00', '60');
  await page.getByRole('button', { name: 'Spara tid', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tidrapportering', exact: true })).toBeVisible();
  const saved = await overview(page, employeeBackend, date);
  expect(saved.gate.blocked).toBe(false);
  expect(saved.selectedDay.recordedMinutes).toBe(480);
  await page.reload();
  await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Hem', exact: true }).click();
  await expect(gate).toHaveCount(0);
  await page.getByRole('button', { name: /^Gårdsarbete/ }).click();
  await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toBeVisible();
});

test('kalendern visar valda dagens uppdrag och bara verklig start/stopp ger arbetad tid', async ({ page, employeeBackend }) => {
  const { username, person } = await createEmployee(page.request, employeeBackend, true);
  const date = dateInStockholm(), tomorrow = addDays(date, 1), orderId = `AO-EMP-${randomUUID().slice(0, 8)}`;
  modifyIsolatedFixture(employeeBackend, state => {
    const template = state.transport.orders.find((order: { status: string }) => order.status === 'booked');
    const assigned = { ...template, id: orderId, customerName: 'Kalendertest AB', driverId: person.driverId, siteId: 'norrtalje', vehicleId: 'vehicle-kalle', date, startMinute: 480, durationMinutes: 120, audit: [] };
    state.transport.orders.push(assigned, { ...assigned, id: `${orderId}-future`, customerName: 'Morgondagens uppdrag', date: tomorrow });
  });
  await login(page, username);
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  const planned = await overview(page, employeeBackend, date);
  expect(planned.selectedDay.orders).toHaveLength(1);
  expect(planned.selectedDay.recordedMinutes).toBe(0);
  await page.getByRole('navigation', { name: 'Huvudmeny' }).getByRole('button', { name: 'Schema', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mitt schema', exact: true })).toBeVisible();
  const day = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Stockholm' }).format(new Date(`${date}T12:00:00Z`));
  await page.getByRole('region', { name: 'Schemakalender', exact: true }).getByRole('button', { name: new RegExp(`^${day}, 1 jobb$`, 'i') }).click();
  const agenda = page.getByRole('region', { name: 'Jobb för vald dag', exact: true });
  await expect(agenda).toContainText('Kalendertest AB');
  await expect(agenda).not.toContainText('Morgondagens uppdrag');
  await agenda.getByRole('button').filter({ hasText: 'Kalendertest AB' }).click();
  await expect(page.getByRole('heading', { name: 'Mina uppdrag', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Starta arbetstid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avsluta arbetstid', exact: true })).toBeVisible();
  expect((await overview(page, employeeBackend, date)).activeWork).toMatchObject({ orderId });
  // Move only this isolated fixture's genuine started session backwards. A
  // one-hour interval tests duration without waiting an hour or treating the
  // planned two-hour job as worked time.
  modifyIsolatedFixture(employeeBackend, state => {
    state.employeeTime.orderSessions.find((session: { orderId: string; endedAt?: string }) => session.orderId === orderId && !session.endedAt).startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  });
  await page.getByRole('button', { name: 'Avsluta arbetstid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starta arbetstid', exact: true })).toBeVisible();
  const actual = await overview(page, employeeBackend, date);
  expect(actual.activeWork).toBeUndefined();
  const previousDay = await overview(page, employeeBackend, addDays(date, -1));
  const total = actual.selectedDay.recordedMinutes + previousDay.selectedDay.recordedMinutes;
  expect(total).toBe(60);
  expect((await overview(page, employeeBackend, tomorrow)).selectedDay.recordedMinutes).toBe(0);
  expect(actual.selectedDay.entries.every((entry: { source: string }) => entry.source === 'order')).toBe(true);
});

test('admin sparar timkrav och skapar personalkonto utan att ge arbetaren administratörsrättigheter', async ({ page, employeeBackend }) => {
  await login(page, 'admin', 'JerocDemo2026!');
  await expect(page.getByRole('heading', { name: /^Hej,/ })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Huvudmeny', exact: true });
  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await page.getByRole('button', { name: /^Timkrav för personal/ }).click();
  await expect(page.getByRole('heading', { name: 'Timkrav för personal', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('person-kalle');
  await page.getByRole('checkbox', { name: 'Kräv komplett tidrapport före fortsatt arbete', exact: true }).check();
  await page.getByRole('combobox', { name: 'Beräkna timkrav', exact: true }).selectOption('fixed');
  await page.getByRole('spinbutton', { name: 'Timmar per arbetsdag', exact: true }).fill('6.5');
  await page.getByRole('button', { name: 'Spara timkrav', exact: true }).click();
  await expect(page.getByText('Timkravet är sparat.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('person-kalle');
  await expect(page.getByRole('combobox', { name: 'Beräkna timkrav', exact: true })).toHaveValue('fixed');
  await expect(page.getByRole('spinbutton', { name: 'Timmar per arbetsdag', exact: true })).toHaveValue('6.5');
  const policies = await page.request.get(`${employeeBackend.origin}/api/employee/requirements`);
  expect(policies.ok(), await policies.text()).toBe(true);
  expect((await policies.json()).people.find((person: { id: string }) => person.id === 'person-kalle').requirement).toMatchObject({ enabled: true, mode: 'fixed', dailyMinutes: 390 });

  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await page.getByRole('button', { name: /^Personalkonton/ }).click();
  await expect(page.getByRole('heading', { name: 'Personalkonton', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('person-kalle');
  await expect(page.getByLabel('Lösenord för nytt konto', { exact: true })).toBeVisible();
  const username = `kalle.browser.${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Inloggningsnamn', { exact: true }).fill(username);
  await page.getByLabel('Lösenord för nytt konto', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Spara personalkonto', exact: true }).click();
  await expect(page.getByText('Personalkontot är sparat. Personen kan använda samma inloggning i appen.', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Person', exact: true }).selectOption('person-kalle');
  await expect(page.getByLabel('Inloggningsnamn', { exact: true })).toHaveValue(username);
  await expect(page.getByLabel('Nytt lösenord (valfritt)', { exact: true })).toHaveValue('');
  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await page.getByRole('button', { name: 'Logga ut', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await login(page, username);
  await expect(page.getByRole('heading', { name: 'Hej, Kalle!', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Gårdsarbete/ })).toHaveCount(0);
  const worker = await overview(page, employeeBackend);
  expect(worker.person).toMatchObject({ id: 'person-kalle', driverId: 'kalle' });
  expect(worker.capabilities).toMatchObject({ yardWork: false, assignedOrders: true, manageEmployeeAccounts: false, manageTimeRequirements: false });
  expect(worker.requirement).toMatchObject({ enabled: true, mode: 'fixed', dailyMinutes: 390 });
  expect(worker.orders.every((order: { driverId: string }) => order.driverId === 'kalle')).toBe(true);
  await navigation.getByRole('button', { name: 'Schema', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mitt schema', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Personalkonton/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Timkrav för personal/ })).toHaveCount(0);
  // Genuine employee credentials must win over forged demo admin headers.
  expect((await page.request.get(`${employeeBackend.origin}/api/employee/accounts`, { headers: admin })).status()).toBe(403);
  expect((await page.request.get(`${employeeBackend.origin}/api/employee/requirements`, { headers: admin })).status()).toBe(403);
  await page.goto('/#/yard');
  await expect(page.getByRole('heading', { name: 'Hej, Kalle!', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Starta invägning/ })).toHaveCount(0);
});
