import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error Node loads this plain ESM server module; it has no generated declarations.
import { initialApplicationState } from '../server/application.mjs';
// @ts-expect-error Node loads this plain ESM server module; it has no generated declarations.
import { ensurePersonnel, personnelCommand, personnelProjection } from '../server/personnel.mjs';
// @ts-expect-error Node loads this plain ESM server module; it has no generated declarations.
import { migratePersonnelFacilityAccess, syncPersonnelFacilityAccess } from '../server/facility-access.mjs';
// @ts-expect-error Node loads this plain ESM server module; it has no generated declarations.
import { createPricingStore } from '../server/pricing.mjs';
// @ts-expect-error Node loads this plain ESM server module; it has no generated declarations.
import { vehicleRegistryCommand, vehicleRegistryProjection } from '../server/personnel-vehicles.mjs';
import type { PersonnelCommand, Person } from '../src/office/personnel/types';
import type { OfficeUser } from '../src/office/model';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
test.setTimeout(45_000);

const siteCatalog = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const personId = 'person-kalle', userId = 'facility-worker', personName = 'Behörighet Testperson';

async function setup(page: Page, options: { conflict?: boolean; inactive?: boolean } = {}) {
  let state = initialApplicationState();
  ensurePersonnel(state, siteCatalog);
  const target = state.personnel.people.find((value: Person) => value.id === personId);
  Object.assign(target, { name: personName, userId, siteIds: ['norrtalje'] });
  state.pricing.users.push({ id: userId, name: personName, level: 'Medarbetare', permissions: ['view','prepare'],
    maxAttest: 0, ownAttest: false, active: true, siteIds: options.conflict ? ['norrtalje','rimbo'] : ['norrtalje'] });
  migratePersonnelFacilityAccess(state, { siteCatalog });
  const currentVehicle = state.transport.vehicles.find((value: { id: string }) => value.id === target.vehicleId);
  if (options.inactive) currentVehicle.active = false;
  state.office.users = structuredClone(state.pricing.users);
  const statistics = { personnel: [] as PersonnelCommand[], pricing: [] as { users: OfficeUser[]; allSiteUserIds?: string[] }[],
    vehicles: [] as { action: string; vehicle: { id?: string; name: string; active: boolean }; requestId?: string }[], pageErrors: [] as string[] };
  page.on('pageerror', error => statistics.pageErrors.push(error.message));
  const principal = () => { const admin = state.pricing.users.find((value: OfficeUser) => value.id === 'admin'); return { actor: admin, user: admin }; };
  const priceState = () => { const store = createPricingStore({ initialState: state.pricing }); return store.read(store.principal('admin')); };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      if (path === '/api/application/personnel') {
        if (request.method() === 'POST') {
          const command = request.postDataJSON() as PersonnelCommand; statistics.personnel.push(command);
          const next = structuredClone(state); personnelCommand(next, principal(), command, [], siteCatalog); state = next;
        }
        return route.fulfill({ json: personnelProjection(state, principal(), false, siteCatalog) });
      }
      if (path === '/api/pricing/users') {
        const input = request.postDataJSON(); statistics.pricing.push(input);
        const pricing = createPricingStore({ initialState: state.pricing });
        pricing.saveUsers(input, pricing.principal('admin')); state.pricing = pricing.exportState();
        state.office.users = structuredClone(state.pricing.users); syncPersonnelFacilityAccess(state, { siteCatalog });
        return route.fulfill({ json: priceState() });
      }
      if (path === '/api/personnel/vehicles') {
        if (request.method() === 'POST') {
          const command = request.postDataJSON(); statistics.vehicles.push(command);
          const next = structuredClone(state), result = vehicleRegistryCommand(next, principal(), command, []); state = next;
          return route.fulfill({ json: result });
        }
        return route.fulfill({ json: vehicleRegistryProjection(state, principal()) });
      }
      const admin = principal().user;
      const response = path === '/api/platform/session' ? { enabled: true, authenticated: true,
        actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser: admin, user: admin,
        company: { id: 'jeroc-demo', name: 'Isolerat personaltest', organisationNumber: '5593593626', status: 'active' },
        organisationId: 'jeroc-demo', effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false,
        csrfToken: 'facility-browser-fixture', generation: 5, companies: [] }
        : path === '/api/application/office' ? { data: state.office, revision: state.personnel.revision + state.pricing.revision }
        : path === '/api/application/revision' ? { revision: state.personnel.revision + state.pricing.revision }
        : path === '/api/pricing/state' ? priceState()
        : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin,
          csrfToken: 'facility-environment-fixture', expiresAt: '2099-01-01T00:00:00Z' }
        : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
        : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id,
          sites: siteCatalog, terminals: [], approvals: [], defaults: [] }
        : path === '/api/mail/state' ? { organisationId: 'jeroc-demo', configuration: { ready: false, missing: [], issues: [] },
          connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: true, canManage: true }, mode: 'live' } : undefined;
      return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Endast isolerade personaltjänster ingår i provet.' } });
    } catch (error) {
      return route.fulfill({ status: (error as { status?: number }).status ?? 503, json: { error: (error as Error).message } });
    }
  });
  await page.goto(`/kontor#/personnel/${personId}/overview`);
  await expect(page.getByRole('heading', { name: personName, exact: true })).toBeVisible({ timeout: 15_000 });
  return { statistics, state: () => state, currentVehicle,
    concurrentProfileUpdate: () => { state.personnel.people.find((value: Person) => value.id === personId).revision++; state.personnel.revision++; } };
}
async function account(page: Page) {
  await page.getByRole('navigation', { name: 'Personalkortets flikar', exact: true }).getByRole('button', { name: 'Inloggning & behörigheter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inloggning & behörigheter', exact: true })).toBeVisible();
  return page.getByRole('group', { name: 'Anläggningsåtkomst', exact: true });
}

test('kopplad person har endast kontots anläggningsval och profilredigering skickar inga nya rättigheter', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Redigera', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Redigera person', exact: true });
  await expect(dialog.getByText('Anläggningsåtkomst: Norrtälje', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Norrtälje', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'Rimbo', exact: true })).toHaveCount(0);
  await dialog.getByLabel('Team', { exact: true }).fill('Nytt team');
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const command = fixture.statistics.personnel.find(value => value.action === 'person.save')!;
  expect(command).not.toHaveProperty('person.siteIds');
  expect(fixture.state().personnel.people.find((value: Person) => value.id === personId).siteIds).toEqual(['norrtalje']);
  expect(fixture.statistics.pageErrors).toEqual([]);
});

test('kontots gemensamma val uppdaterar personkortet direkt och obegränsad åtkomst skickas uttryckligen', async ({ page }) => {
  const fixture = await setup(page); const access = await account(page);
  await access.getByRole('checkbox', { name: 'Rimbo', exact: true }).check();
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect.poll(() => fixture.statistics.pricing.length).toBe(1);
  await expect.poll(() => fixture.state().personnel.people.find((value: Person) => value.id === personId).siteIds).toEqual(['norrtalje','rimbo']);
  await page.getByRole('navigation', { name: 'Personalkortets flikar', exact: true }).getByRole('button', { name: 'Översikt', exact: true }).click();
  await expect(page.locator('.hr-person-header')).toContainText('Norrtälje, Rimbo');
  const all = await account(page);
  await all.getByRole('checkbox', { name: 'Alla anläggningar, även nya', exact: true }).check();
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect.poll(() => fixture.statistics.pricing.length).toBe(2);
  expect(fixture.statistics.pricing[1].allSiteUserIds).toEqual([userId]);
  expect(fixture.statistics.pricing[1].users.find(value => value.id === userId)).not.toHaveProperty('siteIds');
  await expect.poll(() => fixture.state().pricing.users.find((value: OfficeUser) => value.id === userId).siteIds).toBeUndefined();
  expect(fixture.statistics.pageErrors).toEqual([]);
});

test('migreringsskillnaden visar bevarad åtkomst och bekräftas med konto- och personrevision', async ({ page }) => {
  const fixture = await setup(page, { conflict: true }); await account(page);
  await expect(page.getByText('Tidigare anläggningsval skilde sig åt', { exact: true })).toBeVisible();
  const before = structuredClone(fixture.state().pricing.users.find((value: OfficeUser) => value.id === userId));
  const revision = fixture.state().personnel.people.find((value: Person) => value.id === personId).revision;
  await page.getByRole('button', { name: 'Bekräfta gemensam åtkomst', exact: true }).click();
  await expect(page.getByText('Tidigare anläggningsval skilde sig åt', { exact: true })).toHaveCount(0);
  const confirm = fixture.statistics.personnel.find(value => value.action === 'facilityAccess.confirm');
  expect(confirm).toMatchObject({ personId, expectedRevision: revision, expectedSiteIds: ['norrtalje'] });
  expect(fixture.state().pricing.users.find((value: OfficeUser) => value.id === userId)).toEqual(before);
  expect(fixture.statistics.pageErrors).toEqual([]);
});

test('en samtidig ändring stoppar gammal migreringsbekräftelse och ny uppladdning bevarar den aktuella åtkomsten', async ({ page }) => {
  const fixture = await setup(page, { conflict: true }); await account(page);
  fixture.concurrentProfileUpdate();
  await page.getByRole('button', { name: 'Bekräfta gemensam åtkomst', exact: true }).click();
  await expect(page.getByText('Anläggningsåtkomsten ändrades. Ladda om före bekräftelse.', { exact: true })).toBeVisible();
  expect(fixture.state().metadata.facilityAccess.conflicts.find((value: { personId: string }) => value.personId === personId).resolvedAt).toBeUndefined();
  await page.reload(); await expect(page.getByRole('button', { name: 'Bekräfta gemensam åtkomst', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bekräfta gemensam åtkomst', exact: true }).click();
  await expect(page.getByText('Tidigare anläggningsval skilde sig åt', { exact: true })).toHaveCount(0);
  expect(fixture.statistics.personnel.filter(value => value.action === 'facilityAccess.confirm')).toHaveLength(2);
  expect(fixture.statistics.pageErrors).toEqual([]);
});

test('fordon skapas inne i personalformuläret utan att osparade personuppgifter försvinner', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto('/kontor#/personnel');
  await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  const name = `Inline Förare ${randomUUID().slice(0,8)}`;
  await dialog.getByLabel('Namn *', { exact: true }).fill(name);
  await dialog.getByLabel('Team', { exact: true }).fill('Osparat team');
  await dialog.getByLabel('Telefon', { exact: true }).fill('070-000 56 78');
  await dialog.getByRole('checkbox', { name: 'Kan bokas som förare', exact: true }).check();
  await dialog.getByRole('button', { name: 'Skapa nytt fordon', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Spara person', exact: true })).toBeDisabled();
  await dialog.getByLabel('Fordonsnamn *', { exact: true }).fill('Nytt inlinefordon');
  await dialog.getByLabel('Registreringsnummer *', { exact: true }).fill('UIT 119');
  await dialog.getByRole('button', { name: 'Spara fordon', exact: true }).click();
  await expect(dialog.getByLabel('Namn *', { exact: true })).toHaveValue(name);
  await expect(dialog.getByLabel('Team', { exact: true })).toHaveValue('Osparat team');
  await expect(dialog.getByLabel('Telefon', { exact: true })).toHaveValue('070-000 56 78');
  const vehicle = fixture.state().transport.vehicles.find((value: { name: string }) => value.name === 'Nytt inlinefordon');
  expect(vehicle.active).toBe(true); await expect(dialog.getByLabel('Ordinarie fordon', { exact: true })).toHaveValue(vehicle.id);
  await dialog.getByRole('button', { name: 'Spara person', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const saved = fixture.state().personnel.people.find((value: Person) => value.name === name);
  expect(saved).toMatchObject({ team: 'Osparat team', phone: '+46700005678', vehicleId: vehicle.id, canDrive: true });
  expect(fixture.statistics.vehicles).toHaveLength(1); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('den gemensamma fordonseditorn skapar en maskin med inventarienummer utan registrering eller kärlkapacitet', async ({ page }) => {
  const fixture = await setup(page);
  await page.goto('/kontor#/personnel');
  await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  await dialog.getByLabel('Namn *', { exact: true }).fill('Maskinförare för test');
  await dialog.getByRole('checkbox', { name: 'Kan bokas som förare', exact: true }).check();
  await dialog.getByRole('button', { name: 'Skapa nytt fordon', exact: true }).click();
  await dialog.getByLabel('Fordonsnamn *', { exact: true }).fill('Grävmaskin för test');
  await dialog.getByLabel('Fordonstyp', { exact: true }).selectOption('machine');
  await dialog.getByLabel('Inventarienummer', { exact: true }).fill('MASKIN-11');
  await dialog.getByRole('checkbox', { name: 'Container', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Spara fordon', exact: true }).click();
  await expect(dialog.getByLabel('Fordonsnamn *', { exact: true })).toHaveCount(0);
  const machine = fixture.state().transport.vehicles.find((vehicle: { assetTag?: string }) => vehicle.assetTag === 'MASKIN-11');
  expect(machine).toMatchObject({ registration: '', category: 'machine', types: [], active: true });
  await expect(dialog.getByLabel('Ordinarie fordon', { exact: true })).toHaveValue(machine.id);
  await expect(dialog.getByLabel('Namn *', { exact: true })).toHaveValue('Maskinförare för test');
  expect(fixture.statistics.vehicles).toHaveLength(1); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('personaldialogen länkar till samma fullständiga fordonsregister utan en parallell editor', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: 'Hantera fordon', exact: true }).click();
  const registry = page.getByRole('dialog', { name: 'Fordonsregister', exact: true });
  await expect(registry.getByRole('link', { name: 'Öppna Fordon och maskiner', exact: true })).toHaveAttribute('href', '#/fleet');
  await expect(registry.getByRole('table')).toHaveCount(0);
  await expect(registry.getByRole('button', { name: /Skapa nytt|Redigera/ })).toHaveCount(0);
  expect(fixture.statistics.vehicles).toHaveLength(0);
});

test('inaktiverade fordon bevarar nuvarande koppling och bokningar men kan inte väljas för nya personer', async ({ page }) => {
  const fixture = await setup(page, { inactive: true });
  const orders = structuredClone(fixture.state().transport.orders);
  await page.getByRole('button', { name: 'Redigera förare & fordon', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Redigera person', exact: true });
  const select = edit.getByLabel('Ordinarie fordon', { exact: true });
  await expect(select).toHaveValue(fixture.currentVehicle.id);
  await expect(select.locator(`option[value="${fixture.currentVehicle.id}"]`)).toHaveJSProperty('disabled', true);
  await edit.getByLabel('Team', { exact: true }).fill('Historik bevarad');
  await edit.getByRole('button', { name: 'Spara person', exact: true }).click(); await expect(edit).toHaveCount(0);
  expect(fixture.state().personnel.people.find((value: Person) => value.id === personId).vehicleId).toBe(fixture.currentVehicle.id);
  expect(fixture.state().transport.orders).toEqual(orders);
  await page.goto('/kontor#/personnel'); await page.getByRole('button', { name: 'Lägg till person', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Lägg till person', exact: true });
  await create.getByRole('checkbox', { name: 'Kan bokas som förare', exact: true }).check();
  await expect(create.getByLabel('Ordinarie fordon', { exact: true }).locator(`option[value="${fixture.currentVehicle.id}"]`)).toHaveCount(0);
  expect(fixture.statistics.pageErrors).toEqual([]);
});
