import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { EmployeeOverview } from '../src/employee/types';
import type { EmployeeFleetCommand, EmployeeFleetSnapshot, EmployeeFleetTrip } from '../src/employee/employee-fleet-types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });
test.describe.configure({ mode: 'serial' });
type Command = EmployeeFleetCommand & { expectedRevision: number; requestId: string };
async function fixture(page: Page, queued = false) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
  const person = { id: 'fleet-own-person', name: 'Niklas Fordon', userId: 'fleet-own-user', driverId: 'fleet-own-driver',
    role: 'Förare', team: 'Transport', kind: 'employee' as const, siteIds: ['norrtalje'], phone: '', email: '' };
  const day = { date: today, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0, automaticMinutes: 0, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'not_required' as const };
  const overview: EmployeeOverview = { revision: 1, companyId: 'fleet-mobile-company', companyName: 'Fordonsprov AB', person,
    sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], activeSiteId: 'norrtalje',
    capabilities: { yardWork: false, assignedOrders: true, employeeTime: true, manageTimeRequirements: false },
    today, date: today, month: today.slice(0, 7), monthLoaded: false,
    requirement: { enabled: false, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 0 },
    gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day],
    selectedDay: { ...day, schedules: [], entries: [], absences: [], orders: [], clockSessions: [] },
    orders: [], upcomingOrders: [], activeWork: null, leaveRequests: [], balances: { available: false },
    summary: { expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 } };
  const trip = (id: string, hour: number): EmployeeFleetTrip => ({ id, personId: person.id, vehicleId: 'fleet-vehicle',
    driverSource: 'default', startAt: `${today}T${String(hour).padStart(2, '0')}:00:00Z`, endAt: `${today}T${String(hour).padStart(2, '0')}:30:00Z`,
    distanceKm: 18.5, startOdometerKm: 12000, endOdometerKm: 12018.5, fromLabel: `Start ${id}`, toLabel: `Mål ${id}`, revision: 1, source: 'device', quality: 'good' });
  const state: EmployeeFleetSnapshot = { revision: 10, personId: person.id,
    vehicles: [{ id: 'fleet-vehicle', registration: 'ABC123', name: 'Servicebil', category: 'van', types: [], active: true }],
    profiles: { 'fleet-vehicle': { vehicleId: 'fleet-vehicle', defaultDriverId: person.id, siteId: 'norrtalje', odometerKm: 12018.5, odometerSource: 'manual' } },
    services: [{ id: 'service-1', vehicleId: 'fleet-vehicle', title: 'Årsservice', dueDate: '2027-01-15', status: 'planned', revision: 1 }],
    issues: [], inspections: [], trips: queued ? [trip('older', 7), trip('newest', 10)] : [], pendingTrips: [],
    gate: { blocked: false, count: 0, pendingTrips: [], safeToInteract: true }, capabilities: { read: true, write: true, vehicleWrite: false, export: false },
    workOrders: [{ id: 'AO-own', customerName: 'Egen kund AB', driverId: person.driverId, vehicleId: 'fleet-vehicle', siteId: 'norrtalje' }] };
  const controls = { failRead: false, failWrite: false, deniedWrite: false, hold: undefined as Promise<void> | undefined };
  const commands: Command[] = [], uploads: { company: string; person: string; size: number; vehicle: string | null }[] = [], errors: string[] = [], unexpected: string[] = [];
  let reads = 0;
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = () => {
    state.pendingTrips = state.trips.filter(item => item.endAt && !item.classification).sort((a, b) => b.endAt!.localeCompare(a.endAt!));
    state.gate = { blocked: state.pendingTrips.length > 0, count: state.pendingTrips.length, pendingTrips: state.pendingTrips,
      safeToInteract: !state.trips.some(item => !item.endAt) };
    return structuredClone(state);
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), send = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (['/api/employee/session', '/api/employee/overview'].includes(url.pathname)) return send(overview);
    if (url.pathname === '/api/employee/orders') return send({ orders: [] });
    if (url.pathname === '/api/employee/fleet') {
      reads++; expect(request.headers()['x-employee-company']).toBe(overview.companyId); expect(request.headers()['x-employee-person']).toBe(person.id);
      return controls.failRead ? send({ error: 'Kunde inte verifiera resornas status.' }, 503) : send(snapshot());
    }
    if (url.pathname === '/api/employee/fleet/files') {
      uploads.push({ company: request.headers()['x-employee-company'], person: request.headers()['x-employee-person'], size: request.postDataBuffer()?.length ?? 0, vehicle: url.searchParams.get('vehicleId') });
      return send({ file: { id: 'fleet-photo', name: 'bil.png', vehicleId: 'fleet-vehicle', kind: 'photo', contentType: 'image/png', url: '/api/fleet/files/fleet-photo' } });
    }
    if (url.pathname === '/api/fleet/files/fleet-photo') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64') });
    if (url.pathname === '/api/employee/fleet/actions') {
      const input = request.postDataJSON() as Command; commands.push(input);
      expect(request.headers()['x-employee-person']).toBe(person.id); expect(request.headers()['x-employee-company']).toBe(overview.companyId);
      if (controls.hold) await controls.hold;
      if (controls.deniedWrite) return send({ error: 'Din fordonsåtkomst har återkallats.' }, 403);
      if (controls.failWrite) return send({ error: 'Tillfälligt nätfel. Försök igen.' }, 503);
      expect(input.expectedRevision).toBe(state.revision);
      if (input.action === 'trip.complete') {
        const own = state.trips.find(item => item.id === input.tripId)!; expect(own.personId).toBe(person.id);
        Object.assign(own, { classification: input.classification, revision: own.revision + 1, purpose: input.purpose, workOrderId: input.workOrderId });
      } else if (input.action === 'inspection.save') state.inspections.push({ id: 'inspection-own', vehicleId: input.vehicleId, checks: input.checks, comment: input.comment, photoUrls: input.photoUrls, personId: person.id, at: new Date().toISOString() });
      else if (input.action === 'issue.save') state.issues.push({ ...input.issue, id: 'issue-own', revision: 1 });
      else if (input.action === 'driver.select') state.profiles[input.vehicleId].nextDriver = { personId: person.id, source: 'app', selectedAt: new Date().toISOString() };
      state.revision++; return send(snapshot());
    }
    if (url.pathname === '/api/application/mobile') return send({ data: { version: 1, drafts: [], customers: [] }, revision: 0 });
    if (url.pathname === '/api/application/revision') return send({ revision: 0 });
    if (url.pathname === '/api/platform/tenant-context') return send({ companyId: overview.companyId, companyName: overview.companyName });
    unexpected.push(`${request.method()} ${url.pathname}`); return send({ error: 'Endpoint utanför isolerat fordonsprov' }, 404);
  });
  return { state, controls, commands, uploads, errors, unexpected, trip, reads: () => reads };
}
const refresh = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('jeroc:employee-fleet-changed')));

test('resespärr behåller vald resa och inmatning, spärrar dubbeltryck och återanvänder samma requestId efter nätfel', async ({ page }) => {
  const f = await fixture(page, true); f.controls.failWrite = true;
  await page.goto('/#/my-vehicle');
  const dialog = page.getByRole('dialog', { name: 'Komplettera din resa' });
  await expect(dialog).toBeVisible(); await expect(dialog.getByText('Start newest', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /stäng|senare|hoppa|tillbaka/i })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Tjänsteresa', exact: true }).click(); await dialog.getByLabel('Resans ärende', { exact: true }).fill('Hämtning hos kund');
  await dialog.getByLabel('Arbetsorder · valfri').selectOption('AO-own');
  await dialog.getByRole('button', { name: 'Privat resa', exact: true }).click();
  f.state.trips.push(f.trip('arrived-later', 12)); f.state.revision++; await refresh(page);
  await expect(dialog.getByText('3 avslutade resor behöver kompletteras innan du fortsätter.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Start newest', { exact: true })).toBeVisible();
  let release!: () => void; f.controls.hold = new Promise<void>(resolve => { release = resolve; });
  await dialog.getByRole('button', { name: 'Spara och fortsätt' }).dblclick();
  await expect.poll(() => f.commands.length).toBe(1); await expect(dialog.getByRole('button', { name: 'Sparar resan…' })).toBeDisabled();
  release(); f.controls.hold = undefined;
  await expect(dialog.getByRole('alert')).toContainText('Tillfälligt nätfel');
  await expect(dialog.getByRole('button', { name: 'Privat resa', exact: true })).toHaveAttribute('aria-pressed', 'true');
  f.controls.failWrite = false;
  await dialog.getByRole('button', { name: 'Försök spara igen' }).click();
  await expect(dialog.getByText('Start arrived-later', { exact: true })).toBeVisible();
  expect(f.commands[1].requestId).toBe(f.commands[0].requestId); expect(f.commands[0]).not.toHaveProperty('purpose'); expect(f.commands[0]).not.toHaveProperty('workOrderId');
  for (const name of ['arrived-later', 'older']) {
    await expect(dialog.getByText(`Start ${name}`, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Tjänsteresa', exact: true }).click();
    await dialog.getByLabel('Arbetsorder · valfri').selectOption('AO-own');
    await dialog.getByRole('button', { name: 'Spara och fortsätt' }).click();
  }
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Mitt fordon' })).toBeVisible();
  expect(f.commands).toHaveLength(4); expect(f.errors).toEqual([]); expect(f.unexpected).toEqual([]);
});

test('statusfel frigör inte spärren och pågående egen resa skjuter upp dialogen tills säker ankomst', async ({ page }) => {
  const f = await fixture(page, true); f.controls.failRead = true;
  f.state.trips.push({ ...f.trip('active', 13), endAt: undefined });
  await page.goto('/#/my-trips');
  const dialog = page.getByRole('dialog', { name: 'Komplettera din resa' });
  await expect(dialog.getByRole('alert')).toContainText('Kunde inte verifiera');
  await expect(dialog.getByRole('button', { name: 'Spara och fortsätt' })).toHaveCount(0);
  f.controls.failRead = false; await dialog.getByRole('button', { name: 'Försök hämta resor igen' }).click();
  await expect(dialog).not.toBeVisible(); await expect(page.getByRole('heading', { name: 'Mina resor' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Visa resor' }).selectOption('pending');
  await expect(page.locator('.employee-fleet-trip')).toHaveCount(2);
  f.state.trips.find(item => item.id === 'active')!.endAt = `${f.state.trips[0].startAt.slice(0, 10)}T13:30:00Z`; f.state.revision++;
  await refresh(page); await expect(dialog).toBeVisible(); await expect(dialog.getByText('Start active', { exact: true })).toBeVisible();
  await mkdir('/tmp/jeroc-fleet-mobile-review', { recursive: true });
  await page.screenshot({ path: '/tmp/jeroc-fleet-mobile-review/trip-gate-390.png' });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(f.commands).toEqual([]); expect(f.errors).toEqual([]); expect(f.unexpected).toEqual([]);
});

test('eget fordon sparar kontroll med foto och felanmälan; nekad skrivåtkomst rensar privata fordonsuppgifter', async ({ page }) => {
  const f = await fixture(page); await page.goto('/#/my-vehicle');
  await expect(page.getByText('ABC123', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Jag kör nästa resa' }).click();
  await expect(page.getByText('Du · vald i appen', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fordonskontroll Kontrollera före färd' }).click();
  for (const label of ['Däck och hjul', 'Belysning och signaler', 'Vätskor och synligt läckage', 'Säkerhetsutrustning', 'Skador och allmänt skick']) await page.getByRole('button', { name: `${label} · OK`, exact: true }).click();
  await page.getByLabel('Kommentar · valfri').fill('Kontrollerat före körning');
  await page.getByLabel('Bifoga foto', { exact: true }).setInputFiles({ name: 'bil.png', mimeType: 'image/png', buffer: Buffer.from('PNG fixture upload bytes') });
  await expect(page.getByRole('img', { name: 'Bifogat foto 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Spara fordonskontroll', exact: true }).click();
  await expect(page.getByText('Fordonskontrollen är sparad.', { exact: true })).toBeVisible();
  expect(f.uploads).toEqual([{ company: 'fleet-mobile-company', person: 'fleet-own-person', size: 24, vehicle: 'fleet-vehicle' }]);
  expect(f.state.inspections[0].photoUrls).toEqual(['/api/fleet/files/fleet-photo']);
  await page.getByRole('button', { name: 'Anmäl fel Skada eller brist' }).click();
  await page.getByLabel('Rubrik', { exact: true }).fill('Sprucken backspegel'); await page.getByLabel('Beskriv felet', { exact: true }).fill('Höger spegel behöver bytas.');
  await page.getByLabel('Allvarlighetsgrad').selectOption('high'); await page.getByRole('button', { name: 'Skicka felanmälan', exact: true }).click();
  await expect(page.locator('.employee-fleet-list-row').filter({ hasText: 'Sprucken backspegel' })).toContainText('Höger spegel behöver bytas.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('/tmp/jeroc-fleet-mobile-review', { recursive: true });
  await page.screenshot({ path: '/tmp/jeroc-fleet-mobile-review/my-vehicle-390.png', fullPage: true });
  f.controls.deniedWrite = true; f.controls.failRead = true;
  await page.getByRole('button', { name: 'Anmäl fel Skada eller brist' }).click();
  await page.getByLabel('Rubrik', { exact: true }).fill('Ny privat uppgift'); await page.getByLabel('Beskriv felet', { exact: true }).fill('Får inte ligga kvar efter återkallad åtkomst.');
  await page.getByRole('button', { name: 'Skicka felanmälan', exact: true }).click();
  await expect(page.getByText('ABC123', { exact: true })).toHaveCount(0); await expect(page.getByLabel('Rubrik', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Komplettera din resa' }).getByRole('alert')).toContainText('återkallats');
  expect(f.errors).toEqual([]); expect(f.unexpected).toEqual([]);
});
