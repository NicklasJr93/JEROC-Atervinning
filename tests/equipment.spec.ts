import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { EquipmentCommand, EquipmentResponse, EmployeeEquipmentResponse, EquipmentItem } from '../src/office/personnel/equipment-types';
import type { EmployeeOverview } from '../src/employee/types';
import type { EmployeeFleetSnapshot } from '../src/employee/employee-fleet-types';

const screenshots = '/tmp/jeroc-personnel-tools-review';
const at = '2026-10-13T07:15:00.000Z';
test.describe.configure({ mode: 'serial' });
test.setTimeout(45_000);

async function fulfill(route: Route, json: unknown) {
  try { await route.fulfill({ json }); }
  catch (error) { if (!/cancel|abort|closed|interception|handled/i.test(String(error))) throw error; }
}
async function officeFixture(page: Page) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(person => person.id === 'admin')!;
  const response: EquipmentResponse = { data: { version: 1, revision: 0, items: [], assignments: [], events: [] }, revision: 0,
    people: [{ id: 'equipment-worker', name: 'Niklas Rosén', role: 'Gårdsarbete', team: 'Gården', siteIds: ['norrtalje'], active: true }],
    sites: [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }], storage: 'database', capabilities: ['equipmentRead', 'equipmentWrite'] };
  const writes: { body: EquipmentCommand; headers: Record<string, string> }[] = [];
  const options: { readStatus?: number; writeStatus?: number } = {};
  const session = { enabled: true, authenticated: true, actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser: admin, user: admin,
    company: { id: 'jeroc-demo', name: 'Utrustning testbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo', effectiveUserId: admin.id,
    isSupportSession: false, mustChangePassword: false, csrfToken: 'equipment-platform-fixture', generation: 1, companies: [] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/application/equipment') {
      const denied = request.method() === 'POST' ? options.writeStatus : options.readStatus;
      if (denied) return route.fulfill({ status: denied, json: { code: 'equipment_access_denied', error: 'Du saknar behörighet att läsa eller ändra utrustningen.' } });
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as EquipmentCommand;
        writes.push({ body, headers: request.headers() });
        if (body.action === 'item.save') {
          const item: EquipmentItem = { ...body.item, id: 'equipment-1', inventoryNumber: body.item.inventoryNumber.toUpperCase(), serialNumber: body.item.serialNumber ?? '', description: body.item.description ?? '',
            status: body.item.status ?? 'available', revision: 1, createdAt: at, updatedAt: at };
          response.data.items.push(item);
          response.data.events.push({ id: 'event-save', action: 'item.save', itemId: item.id, at, actor: 'Systemadmin', text: `${item.inventoryNumber} · ${item.name} registrerades.` });
        } else {
          const item = response.data.items.find(value => value.id === body.id)!;
          if (!item || body.revision !== item.revision) return route.fulfill({ status: 409, json: { code: 'equipment_revision_conflict', error: 'Utrustningen har ändrats. Uppdatera och försök igen.' } });
          item.revision++; item.updatedAt = at;
          if (body.action === 'item.issue') {
            item.status = 'issued'; response.data.assignments.push({ id: 'assignment-1', itemId: item.id, personId: body.personId, siteId: item.siteId, itemName: item.name,
              inventoryNumber: item.inventoryNumber, issuedAt: at, issuedBy: 'admin', issueNote: body.note ?? '' });
            response.data.events.push({ id: 'event-issue', action: 'item.issue', itemId: item.id, personId: body.personId, assignmentId: 'assignment-1', at, actor: 'Systemadmin', text: `${item.name} lämnades ut till Niklas Rosén.`, note: body.note });
          } else {
            item.status = body.condition ?? 'available'; const assignment = response.data.assignments.find(value => value.itemId === item.id && !value.returnedAt)!;
            Object.assign(assignment, { returnedAt: '2026-10-13T14:05:00.000Z', returnCondition: body.condition ?? 'available', returnNote: body.note ?? '' });
            response.data.events.push({ id: 'event-return', action: 'item.return', itemId: item.id, personId: assignment.personId, assignmentId: assignment.id,
              at: assignment.returnedAt!, actor: 'Systemadmin', text: `${item.name} återlämnades.`, note: body.note });
          }
        }
        response.revision++; response.data.revision = response.revision;
      }
      return fulfill(route, response);
    }
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin, csrfToken: 'equipment-environment-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/mail/state' ? { organisationId: 'jeroc-demo', configuration: { ready: false, missing: [], issues: [] }, connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: true, canManage: true }, mode: 'live' }
      : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { code: 'equipment_fixture_only', error: 'Tjänsten ingår inte i utrustningstestet.' } });
  });
  return { response, writes, options };
}

function mobileOverview(): EmployeeOverview {
  return { companyId: 'jeroc-demo', companyName: 'Utrustning testbolag', activeSiteId: 'norrtalje', revision: 1,
    person: { id: 'equipment-worker', userId: 'equipment-account', username: 'niklas.fixture', name: 'Niklas Rosén', role: 'Gårdsarbete', team: 'Gården', phone: '0700000000', email: 'niklas@example.test', siteIds: ['norrtalje'] },
    capabilities: { yardWork: false, assignedOrders: false, employeeTime: false, manageTimeRequirements: false, manageEmployeeAccounts: false },
    sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], today: '2026-10-13', date: '2026-10-13', month: '2026-10',
    requirement: { enabled: false, mode: 'schedule', effectiveFrom: '2026-01-01', enforcementFrom: '2026-01-01', revision: 1 }, gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [],
    selectedDay: { date: '2026-10-13', expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0, automaticMinutes: 0, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'not_required', entries: [], schedules: [], absences: [], orders: [] },
    orders: [], leaveRequests: [], summary: { expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, balances: { available: false } };
}
async function mobileFixture(page: Page) {
  const overview = mobileOverview();
  const fleet: EmployeeFleetSnapshot = { revision: 0, personId: overview.person.id, vehicles: [], profiles: {},
    services: [], issues: [], inspections: [], trips: [], pendingTrips: [], workOrders: [],
    gate: { blocked: false, count: 0, pendingTrips: [], safeToInteract: true },
    capabilities: { read: true, write: false, vehicleWrite: false, export: false } };
  const equipment: EmployeeEquipmentResponse = { revision: 3,
    items: [{ id: 'equipment-1', inventoryNumber: 'UTR-001', name: 'Arbetstelefon', category: 'phone', siteId: 'norrtalje', serialNumber: 'SN-10023', description: 'Telefon med skyddsfodral.', status: 'issued', revision: 2, createdAt: at, updatedAt: at }],
    assignments: [
      { id: 'assignment-current', itemId: 'equipment-1', personId: 'equipment-worker', siteId: 'norrtalje', itemName: 'Arbetstelefon', inventoryNumber: 'UTR-001', issuedAt: at, issueNote: 'Utlämnad med laddare.' },
      { id: 'assignment-returned', itemId: 'equipment-returned', personId: 'equipment-worker', siteId: 'norrtalje', itemName: 'Skyddsskor', inventoryNumber: 'PPE-005', issuedAt: '2026-09-10T07:00:00.000Z', issueNote: '', returnedAt: '2026-10-10T13:30:00.000Z', returnCondition: 'maintenance', returnNote: 'Lämnade för kontroll.' },
    ], events: [] };
  const options: { nextEquipmentGate?: Promise<void>; equipmentStatus?: number } = {};
  const statistics = { equipmentReads: 0, writes: 0, overviewReads: 0 };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') statistics.writes++;
    if (path === '/api/employee/equipment') {
      if (options.equipmentStatus) return route.fulfill({ status: options.equipmentStatus, json: { code: 'equipment_access_denied', error: 'Du har inte längre åtkomst till utrustningen.' } });
      statistics.equipmentReads++; const snapshot = structuredClone(equipment), gate = options.nextEquipmentGate; options.nextEquipmentGate = undefined;
      await gate; return fulfill(route, snapshot);
    }
    if (path === '/api/employee/session' || path === '/api/employee/overview') { if (path.endsWith('/overview')) statistics.overviewReads++; return fulfill(route, overview); }
    if (path === '/api/employee/fleet') return fulfill(route, fleet);
    if (path === '/api/platform/tenant-context') return fulfill(route, { companyId: 'jeroc-demo', companyName: 'Utrustning testbolag' });
    if (path === '/api/employee/demo-config') return fulfill(route, { enabled: false, accounts: {} });
    return route.fulfill({ status: 503, json: { code: 'equipment_fixture_only', error: 'Tjänsten ingår inte i utrustningstestet.' } });
  });
  return { overview, equipment, options, statistics };
}

test('office equipment creates an asset, issues it, returns it and preserves visible history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const { response, writes } = await officeFixture(page);
  await page.goto('/kontor#/equipment');
  await expect(page.getByRole('heading', { name: 'Utrustning', exact: true, level: 1 })).toBeVisible();
  const filters = page.locator('.equipment-filters');
  await expect.poll(async () => (await filters.boundingBox())!.height).toBeLessThan(60);
  const search = page.getByRole('textbox', { name: 'Sök utrustning', exact: true });
  const category = page.getByRole('combobox', { name: 'Kategori', exact: true });
  expect(Math.abs((await search.boundingBox())!.y - (await category.boundingBox())!.y)).toBeLessThan(5);
  await page.getByRole('button', { name: 'Registrera utrustning', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Registrera utrustning', exact: true });
  await create.getByLabel('Inventarienummer', { exact: true }).fill('utr-001');
  await create.getByLabel('Namn', { exact: true }).fill('Arbetstelefon');
  await create.getByRole('combobox', { name: 'Kategori', exact: true }).selectOption('phone');
  await create.getByRole('combobox', { name: 'Anläggning', exact: true }).selectOption('norrtalje');
  await create.getByLabel('Serienummer · valfritt', { exact: true }).fill('SN-10023');
  await create.getByRole('button', { name: 'Spara utrustning', exact: true }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByText('UTR-001 · SN-10023', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Lämna ut UTR-001', exact: true }).click();
  const issue = page.getByRole('dialog', { name: 'Lämna ut utrustning', exact: true });
  await issue.getByRole('combobox', { name: 'Person', exact: true }).selectOption('equipment-worker');
  await issue.getByLabel('Notering · valfritt', { exact: true }).fill('Utlämnad med laddare.');
  await issue.getByRole('button', { name: 'Lämna ut utrustning', exact: true }).click();
  await expect(issue).toHaveCount(0);
  const row = page.locator('.equipment-table tbody tr').filter({ hasText: 'Arbetstelefon' });
  await expect(row).toContainText('Utlämnad'); await expect(row).toContainText('Niklas Rosén');
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/equipment-office.png`, fullPage: true });
  await page.getByRole('button', { name: 'Återlämna UTR-001', exact: true }).click();
  const returned = page.getByRole('dialog', { name: 'Återlämna utrustning', exact: true });
  await returned.getByRole('combobox', { name: 'Skick vid återlämning', exact: true }).selectOption('maintenance');
  await returned.getByLabel('Notering · valfritt', { exact: true }).fill('Skärmen behöver kontrolleras.');
  await returned.getByRole('button', { name: 'Registrera återlämning', exact: true }).click();
  await expect(returned).toHaveCount(0); await expect(row).toContainText('Service / kontroll');
  await row.click();
  const detail = page.getByRole('dialog', { name: 'Arbetstelefon', exact: true });
  await expect(detail).toContainText('lämnades ut till Niklas Rosén');
  await expect(detail).toContainText('återlämnades');
  await expect(detail).toContainText('Skärmen behöver kontrolleras.');
  await expect(detail).toContainText('Systemadmin');
  await page.screenshot({ path: `${screenshots}/equipment-office-history.png`, fullPage: true });
  expect(writes.map(write => write.body.action)).toEqual(['item.save', 'item.issue', 'item.return']);
  for (const write of writes) {
    expect(write.body.requestId).toMatch(/^[\da-f-]{36}$/i);
    expect(write.headers['x-demo-actor']).toBe('admin'); expect(write.headers['x-demo-user']).toBe('admin');
    expect(write.headers['x-platform-organisation-id']).toBe('jeroc-demo');
  }
  expect(response.data.assignments[0].returnedAt).toBeTruthy();
});

test('mobile profile shows current own equipment and snapshot history without mutation controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { statistics } = await mobileFixture(page);
  await page.goto('/#/profile');
  await expect(page.getByRole('heading', { name: 'Profil', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Min utrustning/ }).click();
  await expect(page.getByRole('heading', { name: 'Min utrustning', exact: true })).toBeVisible();
  await expect(page.locator('.employee-equipment-card')).toContainText('Arbetstelefon');
  await expect(page.locator('.employee-equipment-card')).toContainText('UTR-001');
  await expect(page.locator('.employee-equipment-history')).toContainText('Återlämnad · Skyddsskor');
  await expect(page.locator('.employee-equipment-history')).toContainText('PPE-005');
  await expect(page.getByRole('button', { name: /Lämna ut|Återlämna|Spara utrustning/ })).toHaveCount(0);
  expect(statistics.writes).toBe(0);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: `${screenshots}/equipment-mobile.png`, fullPage: true });
});

test('known site-access changes immediately hide cached equipment and discard a late old-site response', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mobileFixture(page);
  await page.goto('/#/profile/equipment');
  await expect(page.locator('.employee-equipment-card')).toContainText('Arbetstelefon');
  const before = fixture.statistics.equipmentReads;
  let releaseOld!: () => void, releaseNew!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; }), newGate = new Promise<void>(resolve => { releaseNew = resolve; });
  try {
    fixture.options.nextEquipmentGate = oldGate;
    await page.getByRole('button', { name: 'Uppdatera min utrustning', exact: true }).click();
    await expect.poll(() => fixture.statistics.equipmentReads).toBeGreaterThan(before);
    fixture.overview.revision++; fixture.overview.person.siteIds = []; fixture.overview.sites = [];
    fixture.equipment.items = []; fixture.equipment.assignments = []; fixture.equipment.events = [];
    fixture.options.nextEquipmentGate = newGate;
    await page.evaluate(() => window.dispatchEvent(new Event('jeroc:employee-session-check')));
    await expect.poll(() => fixture.statistics.overviewReads).toBeGreaterThan(0);
    await expect(page.locator('.employee-equipment-page')).not.toContainText('Arbetstelefon');
    await expect(page.getByText('Hämtar din utrustning…', { exact: true })).toBeVisible();
    releaseOld();
    await expect(page.locator('.employee-equipment-page')).not.toContainText('Arbetstelefon');
    releaseNew();
    await expect(page.getByText('Ingen utrustning är utlämnad till dig.', { exact: true })).toBeVisible();
    expect(fixture.statistics.writes).toBe(0);
  } finally { releaseOld(); releaseNew(); }
});

test('office access denial clears private equipment and closes an open mutation dialog', async ({ page }) => {
  const fixture = await officeFixture(page);
  fixture.response.data.items.push({ id: 'equipment-1', inventoryNumber: 'UTR-001', name: 'Arbetstelefon', category: 'phone', siteId: 'norrtalje', serialNumber: 'SN-10023', description: '', status: 'available', revision: 1, createdAt: at, updatedAt: at });
  await page.goto('/kontor#/equipment');
  await page.getByRole('button', { name: 'Lämna ut UTR-001', exact: true }).click();
  const issue = page.getByRole('dialog', { name: 'Lämna ut utrustning', exact: true });
  await issue.getByRole('combobox', { name: 'Person', exact: true }).selectOption('equipment-worker');
  fixture.options.writeStatus = 403;
  await issue.getByRole('button', { name: 'Lämna ut utrustning', exact: true }).click();
  await expect(issue).toHaveCount(0);
  await expect(page.locator('.equipment-workspace')).not.toContainText('Arbetstelefon');
  await expect(page.locator('.equipment-workspace')).not.toContainText('SN-10023');
  await expect(page.getByText('Du saknar behörighet att läsa eller ändra utrustningen.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrera utrustning', exact: true })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
});

test('mobile access denial immediately removes loaded equipment and own history', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mobileFixture(page);
  await page.goto('/#/profile/equipment');
  await expect(page.locator('.employee-equipment-card')).toContainText('Arbetstelefon');
  await expect(page.locator('.employee-equipment-history')).toContainText('Skyddsskor');
  fixture.options.equipmentStatus = 403;
  await page.getByRole('button', { name: 'Uppdatera min utrustning', exact: true }).click();
  const equipmentPage = page.locator('.employee-equipment-page');
  await expect(equipmentPage).not.toContainText('Arbetstelefon');
  await expect(equipmentPage).not.toContainText('SN-10023');
  await expect(equipmentPage).not.toContainText('Skyddsskor');
  await expect(page.getByRole('alert')).toContainText('Du har inte längre åtkomst till utrustningen.');
  await expect.poll(() => fixture.statistics.overviewReads).toBeGreaterThan(0);
  expect(fixture.statistics.writes).toBe(0);
  fixture.options.equipmentStatus = undefined;
  await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
  await expect(page.locator('.employee-equipment-card')).toContainText('Arbetstelefon');
});
