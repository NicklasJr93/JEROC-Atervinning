import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { initialApplicationState } from '../server/application.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { ensurePersonnel } from '../server/personnel.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { createPricingStore } from '../server/pricing.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { ensureFleet, fleetProjection, fleetCommand } from '../server/fleet.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { applyFleetDeviceAssignment, fleetTelematicsProjection, fleetTelematicsCommand, ingestFleetTelemetry } from '../server/fleet-telematics.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { vehicleRegistryCommand, vehicleRegistryProjection } from '../server/personnel-vehicles.mjs';
// @ts-expect-error Node loads this plain ESM server module without generated declarations.
import { fleetExportSelection, renderFleetCsv, renderFleetPdf } from '../server/fleet-export.mjs';
import type { FleetAction, FleetFile, FleetReadFilters } from '../src/office/fleet/types';
import type { OfficeUser } from '../src/office/model';
import type { TransportVehicle, VehicleSaveCommand } from '../src/office/transport/types';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
test.setTimeout(45_000);
const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const vehicleId = 'vehicle-kalle', targetVehicleId = 'vehicle-maria';

async function setup(page: Page) {
  let state = initialApplicationState(); ensurePersonnel(state, sites); ensureFleet(state);
  state.metadata.organisation = { id: 'jeroc-demo', name: 'Isolerat fordonsprov' };
  state.transport.vehicles = state.transport.vehicles.filter((value: TransportVehicle) => [vehicleId, targetVehicleId].includes(value.id));
  state.fleet.profiles = { [vehicleId]: { siteId: 'norrtalje', defaultDriverId: 'person-kalle', revision: 0, odometerKm: 1234, odometerSource: 'manual' },
    [targetVehicleId]: { siteId: 'norrtalje', defaultDriverId: 'person-oskar', revision: 0 } };
  state.fleet.trips = Array.from({ length: 14 }, (_, index) => ({ id: `office-trip-${index}`, vehicleId,
    personId: 'person-kalle', driverSource: 'default', startAt: new Date(Date.UTC(2026, 9, 15, 6, index * 10)).toISOString(),
    endAt: new Date(Date.UTC(2026, 9, 15, 6, index * 10 + 5)).toISOString(), distanceKm: 2,
    startOdometerKm: 1200 + index * 2, endOdometerKm: 1202 + index * 2,
    classification: index === 13 ? 'private' : 'business', purpose: index === 13 ? 'PRIVATE-FLEET-PURPOSE' : 'Hämtning av återvinningsmaterial',
    fromLabel: index === 13 ? 'PRIVATE-FLEET-HOME' : 'Testkontoret', toLabel: index === 13 ? 'PRIVATE-FLEET-DOCTOR' : 'Testmottagningen',
    positions: index === 13 ? [{ at: '2026-10-15T08:10:00Z', lat: 66.12345, lng: 19.12345 }] : [],
    revision: 1, source: 'simulator', quality: 'good' }));
  const assignment = new Date(Date.now() - 120_000).toISOString(), observation = new Date(Date.now() - 60_000).toISOString();
  applyFleetDeviceAssignment(state, { id: 'fixture-device', name: 'Testpucken', organisationId: 'jeroc-demo', source: 'simulator', active: true }, { organisationId: 'jeroc-demo', now: assignment });
  ingestFleetTelemetry(state, { deviceId: 'fixture-device', source: 'simulator', records: [{ id: 'initial-off', at: observation, ignition: false }] }, { organisationId: 'jeroc-demo', now: observation });
  const statistics = { commands: [] as FleetAction[], vehicles: [] as VehicleSaveCommand[], reads: [] as URL[], exports: [] as URL[],
    uploads: [] as { vehicleId: string; kind: string; name: string; contentType: string; length: number }[], pageErrors: [] as string[] };
  let failCommittedLink = false, unblock = true;
  const files: FleetFile[] = [];
  page.on('pageerror', error => statistics.pageErrors.push(error.message));
  const principal = () => { const user = state.pricing.users.find((value: OfficeUser) => value.id === 'admin'); return { actor: user, user }; };
  const pricing = () => { const store = createPricingStore({ initialState: state.pricing }); return store.read(store.principal('admin')); };
  const options = () => ({ organisationId: 'jeroc-demo', siteCatalog: sites, now: new Date().toISOString() });
  const projection = (url?: URL) => {
    const filters: FleetReadFilters = {};
    for (const [key, value] of url?.searchParams ?? []) Object.assign(filters, { [key]: ['offset', 'limit'].includes(key) ? Number(value) : value });
    const result = fleetProjection(state, principal(), { ...options(), ...filters });
    return { ...result, capabilities: { ...result.capabilities, unblock }, telematics: fleetTelematicsProjection(state, principal(), options()), sites, positions: [] };
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    try {
      if (path === '/api/fleet') { statistics.reads.push(url); return route.fulfill({ json: projection(url) }); }
      if (path === '/api/fleet/actions') {
        const command = request.postDataJSON() as FleetAction; statistics.commands.push(command);
        const next = structuredClone(state);
        if (command.action.startsWith('device.')) fleetTelematicsCommand(next, principal(), command, [], options());
        else fleetCommand(next, principal(), command, [], options());
        state = next;
        if (failCommittedLink && command.action === 'device.link') { failCommittedLink = false; return route.fulfill({ status: 503, json: { error: 'Svaret försvann efter lagring. Försök samma koppling igen.' } }); }
        return route.fulfill({ json: projection() });
      }
      if (path === '/api/personnel/vehicles') {
        if (request.method() === 'POST') { const command = request.postDataJSON() as VehicleSaveCommand; statistics.vehicles.push(command);
          const next = structuredClone(state), result = vehicleRegistryCommand(next, principal(), command); state = next; return route.fulfill({ json: result }); }
        return route.fulfill({ json: vehicleRegistryProjection(state, principal()) });
      }
      if (path === '/api/fleet/export') {
        statistics.exports.push(url); const filters = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'format'));
        const selection = fleetExportSelection(fleetProjection(state, principal(), { ...options(), ...filters, limit: 1000 }), filters);
        return route.fulfill(url.searchParams.get('format') === 'pdf'
          ? { contentType: 'application/pdf', body: await renderFleetPdf(selection, { companyName: 'Isolerat fordonsprov', actorName: 'Systemadmin' }) }
          : { contentType: 'text/csv; charset=utf-8', body: renderFleetCsv(selection) });
      }
      if (path === '/api/fleet/files') {
        const target = url.searchParams.get('vehicleId')!;
        if (request.method() === 'POST') {
          const name = decodeURIComponent(request.headers()['x-file-name']), contentType = request.headers()['content-type'];
          statistics.uploads.push({ vehicleId: target, kind: url.searchParams.get('kind')!, name, contentType, length: request.postDataBuffer()!.length });
          const file: FleetFile = { id: randomUUID(), vehicleId: target, kind: url.searchParams.get('kind') as FleetFile['kind'], name, contentType, uploadedAt: new Date().toISOString(), url: '' };
          file.url = `/api/fleet/files/${file.id}`; files.push(file); return route.fulfill({ json: { file } });
        }
        return route.fulfill({ json: { files: files.filter(file => file.vehicleId === target) } });
      }
      if (path.startsWith('/api/fleet/files/')) return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.4\n%Isolated fixture\n%%EOF' });
      const admin = principal().user;
      const response = path === '/api/platform/session' ? { enabled: true, authenticated: true,
        actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser: admin, user: admin,
        company: { id: 'jeroc-demo', name: 'Isolerat fordonsprov', organisationNumber: '5593593626', status: 'active' },
        organisationId: 'jeroc-demo', effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false,
        csrfToken: 'fleet-office-fixture', generation: 5, companies: [] }
        : path === '/api/application/office' ? { data: state.office, revision: 1 }
        : path === '/api/application/revision' ? { revision: 1 }
        : path === '/api/pricing/state' ? pricing()
        : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin,
          csrfToken: 'fleet-environment-fixture', expiresAt: '2099-01-01T00:00:00Z' }
        : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
        : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites, terminals: [], approvals: [], defaults: [] }
        : path === '/api/mail/state' ? { organisationId: 'jeroc-demo', configuration: { ready: false, missing: [], issues: [] }, connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: true, canManage: true }, mode: 'live' } : undefined;
      return route.fulfill({ status: response ? 200 : 503, json: response ?? { error: 'Endast isolerade fordonstjänster ingår i provet.' } });
    } catch (error) { return route.fulfill({ status: (error as { status?: number }).status ?? 503, json: { error: (error as Error).message } }); }
  });
  await page.goto('/kontor#/fleet');
  await expect(page.getByRole('heading', { name: 'Fordon & maskiner', exact: true })).toBeVisible({ timeout: 20_000 });
  return { state: () => state, statistics, failNextCommittedLink: () => { failCommittedLink = true; }, setUnblock: (value: boolean) => { unblock = value; },
    observeOff: () => { const now = new Date().toISOString(); ingestFleetTelemetry(state, { deviceId: 'fixture-device', source: 'simulator', records: [{ id: `off-${randomUUID()}`, at: now, ignition: false }] }, { organisationId: 'jeroc-demo', now }); } };
}
const dialogByTitle = (page: Page, title: string) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
const tabs = (page: Page, detail = false) => page.getByRole('navigation', { name: detail ? 'Fordonskortets flikar' : 'Fordon & maskiner', exact: true });

test('new fleet navigation opens the existing canonical vehicle and keeps historical references', async ({ page }, testInfo) => {
  const fixture = await setup(page), ids = fixture.state().transport.vehicles.map((value: TransportVehicle) => value.id);
  await expect(page.locator('.office-sidebar').getByRole('button', { name: 'Fordon & maskiner', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Öppna ABC 123', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`vehicle=${vehicleId}`));
  await expect(page.getByRole('heading', { name: 'ABC 123 · Lastväxlare', exact: true })).toBeVisible();
  await expect(page.getByText('Kalle Nilsson', { exact: true }).first()).toBeVisible();
  expect(fixture.state().transport.vehicles.map((value: TransportVehicle) => value.id)).toEqual(ids);
  expect(fixture.statistics.vehicles).toHaveLength(0); expect(fixture.statistics.pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('fleet-desktop.png'), fullPage: true });
});

test('machine creation and editing use the shared registry and preserve its canonical ID', async ({ page }) => {
  const fixture = await setup(page), originalCount = fixture.state().transport.vehicles.length;
  await page.getByRole('button', { name: 'Nytt fordon', exact: true }).click();
  const dialog = dialogByTitle(page, 'Nytt fordon');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Fordonstyp', exact: true }).selectOption('machine');
  await dialog.getByLabel('Fordonsnamn *', { exact: true }).fill('Grävmaskin QA');
  await dialog.getByLabel('Inventarienummer', { exact: true }).fill('MASKIN-QA-1');
  await dialog.getByRole('button', { name: 'Spara fordon', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByRole('heading', { name: /MASKIN-QA-1 · Grävmaskin QA/ })).toBeVisible();
  const saved = fixture.state().transport.vehicles.find((value: TransportVehicle) => value.assetTag === 'MASKIN-QA-1');
  expect(saved.id).toBeTruthy(); expect(saved.category).toBe('machine'); expect(saved.registration).toBe('');
  await page.getByRole('button', { name: 'Redigera grunduppgifter', exact: true }).click();
  const edit = dialogByTitle(page, 'Redigera fordon');
  await edit.getByLabel('Fordonsnamn *', { exact: true }).fill('Grävmaskin QA redigerad');
  await edit.getByRole('button', { name: 'Spara fordon', exact: true }).click();
  await expect(edit).toHaveCount(0);
  expect(fixture.statistics.vehicles).toHaveLength(2); expect(fixture.statistics.vehicles[1].vehicle.id).toBe(saved.id);
  expect(fixture.state().transport.vehicles.length).toBe(originalCount + 1);
  expect(fixture.statistics.commands.some(value => value.action === 'profile.save')).toBe(false); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('profile/default-driver edits preserve historic trips and explicit drift block respects the separate unblock capability', async ({ page }) => {
  const fixture = await setup(page), historical = structuredClone(fixture.state().fleet.trips);
  await page.getByRole('button', { name: 'Öppna ABC 123', exact: true }).click();
  await page.getByRole('button', { name: 'Redigera profil', exact: true }).click();
  const profile = dialogByTitle(page, 'Fordonsprofil');
  await profile.getByRole('combobox', { name: /^Standardförare/ }).selectOption('person-oskar');
  await profile.getByLabel('Anteckning', { exact: true }).fill('Kontrollera hydrauliken före nästa körning.');
  await profile.getByRole('button', { name: 'Spara fordonsprofil', exact: true }).click(); await expect(profile).toHaveCount(0);
  expect(fixture.state().fleet.profiles[vehicleId].defaultDriverId).toBe('person-oskar'); expect(fixture.state().fleet.trips).toEqual(historical);
  await page.getByRole('button', { name: 'Driftspärra fordon', exact: true }).click();
  const block = dialogByTitle(page, 'Driftspärra fordon');
  await block.getByLabel('Anledning *', { exact: true }).fill('Hydraulikläckage ska kontrolleras.');
  await block.getByRole('button', { name: 'Bekräfta driftspärr', exact: true }).click(); await expect(block).toHaveCount(0);
  expect(fixture.state().fleet.profiles[vehicleId].blocked).toBe(true);
  fixture.setUnblock(false); await page.getByRole('button', { name: 'Uppdatera fordonsvyn', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Häv driftspärr', exact: true })).toHaveCount(0);
  fixture.setUnblock(true); await page.getByRole('button', { name: 'Uppdatera fordonsvyn', exact: true }).click();
  await page.getByRole('button', { name: 'Häv driftspärr', exact: true }).click();
  const unblock = dialogByTitle(page, 'Häv driftspärr');
  await unblock.getByLabel('Anledning *', { exact: true }).fill('Kontrollerat och godkänt för drift.');
  await unblock.getByRole('button', { name: 'Bekräfta hävning', exact: true }).click(); await expect(unblock).toHaveCount(0);
  expect(fixture.state().fleet.profiles[vehicleId].blocked).toBe(false); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('journal pagination and private detail stay scoped, and export sends the complete actual filters', async ({ page }) => {
  const fixture = await setup(page); await tabs(page).getByRole('button', { name: 'Körjournal', exact: true }).click();
  await expect(page.locator('.fleet-pagination')).toContainText('1–12 av 14');
  await page.getByRole('button', { name: 'Nästa sida i körjournal', exact: true }).click();
  await expect(page.locator('.fleet-pagination')).toContainText('13–14 av 14');
  expect(fixture.statistics.reads.some(url => url.searchParams.get('offset') === '12' && url.searchParams.get('limit') === '12')).toBe(true);
  await page.getByRole('combobox', { name: 'Klassificering', exact: true }).selectOption('private');
  await expect(page.locator('.fleet-pagination')).toContainText('1–1 av 1');
  await page.locator('.fleet-journal tbody .fleet-open-row').click();
  await expect(page.getByText('Adresser och rutt är skyddade.', { exact: true })).toBeVisible();
  await expect(page.locator('.fleet-workspace')).not.toContainText('PRIVATE-FLEET');
  const detail = page.locator('.fleet-trip-detail');
  await expect(detail.getByRole('button', { name: 'Spara resa', exact: true })).toHaveCount(0);
  await expect(detail.getByRole('combobox', { name: 'Klassificering', exact: true })).toHaveCount(0);
  await expect(detail.locator('textarea')).toHaveCount(0);
  await page.getByLabel('Från datum', { exact: true }).fill('2026-10-15');
  await page.getByLabel('Till datum', { exact: true }).fill('2026-10-15');
  await page.getByRole('combobox', { name: 'Fordon', exact: true }).selectOption(vehicleId);
  await page.getByRole('combobox', { name: 'Förare', exact: true }).selectOption('person-kalle');
  await page.getByRole('button', { name: 'Klara', exact: true }).click();
  await expect(page.locator('.fleet-pagination')).toContainText('1–1 av 1');
  await page.getByRole('button', { name: 'Exportera körjournal', exact: true }).click();
  const dialog = dialogByTitle(page, 'Exportera körjournal');
  await dialog.getByRole('radio', { name: /CSV/ }).check();
  const download = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Hämta CSV', exact: true }).click(); await download;
  expect(Object.fromEntries(fixture.statistics.exports.at(-1)!.searchParams)).toMatchObject({ format: 'csv', from: '2026-10-15', to: '2026-10-15', vehicleId, personId: 'person-kalle', classification: 'private', status: 'complete' });
  expect(fixture.statistics.exports.at(-1)!.searchParams.has('offset')).toBe(false); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('device first link retries its committed request safely and a two-step transfer survives reload before confirmation', async ({ page }) => {
  const fixture = await setup(page); await tabs(page).getByRole('button', { name: 'GPS-enheter', exact: true }).click();
  await page.getByLabel('Välj fordon för Testpucken', { exact: true }).selectOption(vehicleId);
  await page.getByRole('button', { name: 'Koppla', exact: true }).click();
  const dialog = dialogByTitle(page, 'Koppla GPS-enhet');
  fixture.failNextCommittedLink(); await dialog.getByRole('button', { name: 'Bekräfta koppling', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Svaret försvann efter lagring');
  await dialog.getByRole('button', { name: 'Bekräfta koppling', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const links = fixture.statistics.commands.filter(value => value.action === 'device.link');
  expect(links).toHaveLength(2); expect(links[1].requestId).toBe(links[0].requestId); expect(fixture.state().fleet.bindings).toHaveLength(1);
  await page.getByLabel('Välj fordon för Testpucken', { exact: true }).selectOption(targetVehicleId);
  await page.getByRole('button', { name: 'Byt fordon', exact: true }).click();
  const start = dialogByTitle(page, 'Påbörja fordonsbyte');
  await start.getByRole('button', { name: 'Påbörja flytt', exact: true }).click(); await expect(start).toHaveCount(0);
  const transferId = fixture.state().fleet.transfers[0].id;
  await page.reload(); await expect(page.getByRole('heading', { name: 'Pågående fordonsbyten', exact: true })).toBeVisible();
  expect(fixture.state().fleet.transfers[0].id).toBe(transferId); expect(fixture.state().fleet.transfers[0].status).toBe('pending');
  fixture.observeOff(); await page.getByRole('button', { name: 'Uppdatera fordonsvyn', exact: true }).click();
  await page.getByRole('button', { name: 'Bekräfta installation', exact: true }).click();
  const confirm = dialogByTitle(page, 'Bekräfta installation');
  await confirm.getByRole('button', { name: 'Bekräfta installation', exact: true }).click(); await expect(confirm).toHaveCount(0);
  expect(fixture.state().fleet.transfers[0].status).toBe('confirmed'); expect(fixture.state().fleet.bindings.filter((value: { endAt: string | null }) => !value.endAt)).toHaveLength(1);
  expect(fixture.state().fleet.bindings.at(-1).vehicleId).toBe(targetVehicleId); expect(fixture.statistics.pageErrors).toEqual([]);
});

test('vehicle document upload sends the original file with a scoped vehicle reference', async ({ page }) => {
  const fixture = await setup(page); await page.getByRole('button', { name: 'Öppna ABC 123', exact: true }).click();
  await tabs(page, true).getByRole('button', { name: 'Dokument', exact: true }).click();
  const buffer = Buffer.from('%PDF-1.4\n%Syntetiskt testprotokoll\n%%EOF');
  await page.getByLabel('Välj fordonsdokument', { exact: true }).setInputFiles({ name: 'besiktning-åäö.pdf', mimeType: 'application/pdf', buffer });
  await expect(page.getByText('besiktning-åäö.pdf', { exact: true })).toBeVisible();
  expect(fixture.statistics.uploads).toEqual([{ vehicleId, kind: 'document', name: 'besiktning-åäö.pdf', contentType: 'application/pdf', length: buffer.length }]);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Hämta', exact: true }).click(); await download;
  expect(fixture.statistics.pageErrors).toEqual([]);
});

test('fleet remains usable without page-level horizontal overflow on a 390px screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); const fixture = await setup(page);
  await expect(page.getByRole('heading', { name: 'Fordon & maskiner', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fordon & maskiner', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('fleet-mobile-390.png'), fullPage: true });
  await tabs(page).getByRole('button', { name: 'GPS-enheter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Våra GPS-enheter', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(fixture.statistics.pageErrors).toEqual([]);
});
