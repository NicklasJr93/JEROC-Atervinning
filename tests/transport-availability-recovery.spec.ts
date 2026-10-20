import { test, expect, type Page, type Request, type Route } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import { seedTransport } from '../src/office/transport/model';

test.use({ viewport: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false });

async function fixture(page: Page) {
  const office = migrateOffice(seedOffice()), user = office.users.find(person => person.id === 'admin')!;
  const transport = seedTransport('2026-10-09'); transport.events = [];
  const company = { id: 'transport-availability-company', name: 'Transportprov AB', organisationNumber: '5593593626', status: 'active' };
  const session = { enabled: true, authenticated: true, actor: { id: 'transport-test-actor', name: user.name, username: 'admin', platformAdmin: false },
    actualUser: user, user, company, organisationId: company.id, effectiveUserId: user.id, isSupportSession: false,
    mustChangePassword: false, csrfToken: 'transport-availability-csrf', generation: 12, companies: [company] };
  const personnel = { data: { version: 1, revision: 1, people: [], companies: [], employment: [], salaries: [], schedules: [], absences: [], competencies: [], staffingTasks: [], externalAccounts: [], audit: [] },
    transport, revision: 1, storage: 'database', demo: true, capabilities: [], sites: [{ id: 'norrtalje', name: 'Norrtälje' }] };
  let mode: 'ready' | 'failure' | 'offline' | 'pending' | 'denied' = 'ready', reads = 0, held: Route | undefined;
  const writes: Request[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/application/personnel') {
      reads++;
      if (mode === 'offline') return route.abort('failed');
      if (mode === 'failure') return route.fulfill({ status: 500, json: { error: 'Tillfälligt tillgänglighetsfel.' } });
      if (mode === 'denied') return route.fulfill({ status: 403, json: { error: 'Planeringsåtkomsten har återkallats.', code: 'forbidden' } });
      if (mode === 'pending') { held = route; return; }
      return route.fulfill({ json: personnel });
    }
    if (request.method() !== 'GET') writes.push(request);
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
    if (path === '/api/application/transport') return route.fulfill({ json: { data: transport, revision: 1 } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
    if (path === '/api/pricing/state') return route.fulfill({ json: { version: 'availability-fixture', revision: 1, memoryOnly: true, metals: [], articles: [], customers: [] } });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: user.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id,
      sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    return route.fulfill({ status: 503, json: { error: 'Tjänsten ingår inte i det isolerade planeringsprovet.' } });
  });
  // Install before React mounts so the real availability interval is owned by
  // the controllable clock rather than an earlier native timer.
  await page.clock.install();
  await page.goto('/kontor#/transport');
  await expect(page.getByTestId('transport-workspace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Nytt uppdrag', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Ny arbetsorder', exact: true });
  await editor.getByLabel('Kundnamn', { exact: true }).fill('Kvarvarande formulärkund');
  await editor.getByRole('textbox', { name: 'Instruktioner', exact: true }).fill('Det här utkastet ska finnas kvar efter pollfelet.');
  await editor.getByLabel('Planera preliminär bokning', { exact: true }).check();
  await editor.getByLabel('Datum', { exact: true }).fill('2026-10-12');
  await editor.getByLabel('Starttid', { exact: true }).fill('11:15');
  await editor.getByRole('combobox', { name: 'Förare', exact: true }).selectOption(transport.drivers[1].id);
  const vehicle = transport.vehicles.find(value => value.active !== false)!;
  await editor.getByRole('combobox', { name: 'Fordon', exact: true }).selectOption(vehicle.id);
  return { editor, vehicleId: vehicle.id, driverId: transport.drivers[1].id, writes, errors,
    reads: () => reads, mode: (next: typeof mode) => { mode = next; },
    release: async () => { expect(held).toBeDefined(); const route = held!; held = undefined; await route.fulfill({ json: personnel }); } };
}

for (const failure of ['failure', 'offline'] as const) test(`tillfälligt ${failure === 'failure' ? '500-svar' : 'nätfel'} bevarar transportutkast och blockerar sparande tills tillgängligheten hämtats igen`, async ({ page }) => {
  const f = await fixture(page), before = f.reads();
  f.mode(failure);
  await page.clock.fastForward(15_001);
  await expect.poll(f.reads).toBeGreaterThan(before);
  await expect(page.getByRole('alert').filter({ hasText: 'Ett öppet formulär' })).toBeVisible();
  await expect(f.editor).toBeVisible();
  const save = f.editor.getByRole('button', { name: 'Spara arbetsorder', exact: true });
  await expect(save).toBeDisabled();
  await expect(f.editor.getByLabel('Kundnamn', { exact: true })).toHaveValue('Kvarvarande formulärkund');
  await expect(f.editor.getByRole('textbox', { name: 'Instruktioner', exact: true })).toHaveValue('Det här utkastet ska finnas kvar efter pollfelet.');
  await expect(f.editor.getByLabel('Datum', { exact: true })).toHaveValue('2026-10-12');
  await expect(f.editor.getByLabel('Starttid', { exact: true })).toHaveValue('11:15');
  await expect(f.editor.getByRole('combobox', { name: 'Förare', exact: true })).toHaveValue(f.driverId);
  await expect(f.editor.getByRole('combobox', { name: 'Fordon', exact: true })).toHaveValue(f.vehicleId);
  const pendingReads = f.reads(); f.mode('pending');
  await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
  await expect.poll(f.reads).toBeGreaterThan(pendingReads);
  await expect(save).toBeDisabled();
  await f.release();
  await expect(save).toBeEnabled();
  await expect(page.getByRole('alert').filter({ hasText: 'Ett öppet formulär' })).toHaveCount(0);
  await expect(f.editor.getByRole('textbox', { name: 'Instruktioner', exact: true })).toHaveValue('Det här utkastet ska finnas kvar efter pollfelet.');
  expect(f.writes.filter(request => request.url().includes('/api/application/transport'))).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('serverbekräftad indragen planeringsåtkomst stänger editorn i stället för att återanvända gammal tillgänglighet', async ({ page }) => {
  const f = await fixture(page), before = f.reads();
  f.mode('denied');
  await page.clock.fastForward(15_001);
  await expect.poll(f.reads).toBeGreaterThan(before);
  await expect(page.getByRole('alert').filter({ hasText: 'Planeringsåtkomsten har återkallats' })).toBeVisible();
  await expect(f.editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nytt uppdrag', exact: true })).toHaveCount(0);
  expect(f.writes.filter(request => request.url().includes('/api/application/transport'))).toHaveLength(0);
  expect(f.errors).toEqual([]);
});
