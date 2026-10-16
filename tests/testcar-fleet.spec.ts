import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
// @ts-expect-error The browser fixture exercises the real plain-ESM lab model.
import { createTestCar } from '../server/telematics/testcar-model.mjs';
import type { AuthenticatedPlatformSession } from '../src/platform/types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });
test.describe.configure({ mode: 'serial' });
function platform(organisationId = 'fleet-lab-company', name = 'Laboratoriebolaget'): AuthenticatedPlatformSession {
  const user = { id: 'fleet-lab-admin', name: 'Testadministratör', level: 'Systemadmin' as const, permissions: [], maxAttest: 0, ownAttest: false, active: true };
  return { enabled: true, authenticated: true, actor: { id: 'platform-fleet-admin', name: 'Plattformsadmin', username: 'localtest', platformAdmin: true }, actualUser: user, user,
    organisationId, company: { id: organisationId, name, organisationNumber: '5560000167', status: 'active' },
    isSupportSession: false, mustChangePassword: false, csrfToken: `platform-csrf-${organisationId}`, generation: 8, companies: [] };
}
type Bridge = { companyName: string; devices: { id: string; name: string; vehicleId: string | null; status: string }[];
  link?: { deviceId: string; status: 'connected' | 'error'; lastSentAt: string | null; error?: string } };
async function fixture(page: Page) {
  const model = createTestCar({ now: () => Date.parse('2026-10-16T12:00:00Z') });
  const session = { value: platform(), public: false, holdBridge: undefined as Promise<void> | undefined, failAfterConnect: false, keepErrorAfterConnect: false, waitDisconnect: false, holdWrite: undefined as Promise<void> | undefined };
  const state: Bridge = { companyName: 'Laboratoriebolaget', devices: [{ id: 'registered-simulator', name: 'Bolagets virtuella FMC003', vehicleId: null, status: 'assigned' }] };
  const writes: { body: { action: string; deviceId?: string }; headers: Record<string, string> }[] = [], reads: string[] = [], unexpected: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('close', () => model.close());
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64') });
    if (url.pathname === '/api/testcar/session') return route.fulfill({ json: { csrfToken: 'testcar-bridge-csrf', car: model.snapshot() } });
    if (url.pathname === '/api/testcar/state') return route.fulfill({ json: { car: model.snapshot() } });
    if (url.pathname === '/api/testcar/command') return route.fulfill({ json: { car: model.command(request.postDataJSON()) } });
    if (url.pathname === '/api/platform/session') return session.public ? route.fulfill({ status: 401, json: { error: 'Public visitor' } }) : route.fulfill({ json: session.value });
    if (url.pathname === '/api/testcar/fleet') {
      if (request.method() === 'GET') {
        reads.push(request.headers()['x-platform-organisation-id']);
        const captured = structuredClone(state), held = session.holdBridge; session.holdBridge = undefined;
        if (held) await held;
        return route.fulfill({ json: captured }).catch(() => undefined);
      }
      writes.push({ body: request.postDataJSON(), headers: request.headers() });
      if (session.holdWrite) await session.holdWrite;
      expect(model.snapshot().engineOn).toBe(false);
      const body = writes.at(-1)!.body;
      expect(Object.keys(body).sort()).toEqual(body.action === 'connect' ? ['action', 'deviceId'] : ['action']);
      if (body.action === 'connect') {
        expect(body.deviceId).toBe(state.devices[0].id); state.link = session.keepErrorAfterConnect ? { deviceId: body.deviceId!, status: 'error', lastSentAt: '2026-10-16T12:00:00Z', error: 'Väntar på mottagarens kvittens för slutpaketet.' } : { deviceId: body.deviceId!, status: 'connected', lastSentAt: '2026-10-16T12:00:00Z' };
        if (session.failAfterConnect) return route.fulfill({ status: 503, json: { error: 'Svaret kunde inte bekräftas. Uppdatera statusen.' } });
      } else { if (session.waitDisconnect) return route.fulfill({ status: 409, json: { error: 'Slutpaketet väntar på kvittens före frånkoppling.', code: 'testcar_fleet_pending' } }); delete state.link; }
      return route.fulfill({ json: state });
    }
    if (url.pathname.startsWith('/api/') || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      unexpected.push(`${request.method()} ${url.hostname}${url.pathname}`); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return { session, state, writes, reads, unexpected, errors };
}
const widget = (page: Page) => page.locator('details.testcar-fleet-link');
const expand = async (page: Page) => { await widget(page).locator('summary').click(); };

test('publik och behörighetsbegränsad testbil fortsätter fungera utan bolagskort eller bolagsanrop', async ({ page }) => {
  const f = await fixture(page); f.session.public = true;
  await page.goto('/testbil1'); await expect(page.getByRole('button', { name: 'Starta bilen', exact: true })).toBeEnabled();
  await expect(widget(page)).toHaveCount(0); await page.getByRole('button', { name: 'Starta bilen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Motor på', exact: true })).toBeDisabled();
  f.session.public = false; f.session.value = { ...platform(), actualUser: { ...platform().actualUser, siteIds: ['norrtalje'] } };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(widget(page)).toHaveCount(0); expect(f.reads).toEqual([]); expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('bolagskoppling kräver motor av, frysta CSRF-identiteter och statuskontroll efter oklart sparutfall', async ({ page }) => {
  const f = await fixture(page); f.session.failAfterConnect = true;
  await page.goto('/testbil1'); await expect(widget(page)).toBeVisible(); await expand(page);
  await expect(page.getByRole('combobox', { name: 'Tilldelad simulator' })).toHaveValue('registered-simulator'); expect(f.writes).toHaveLength(0);
  let release!: () => void; f.session.holdWrite = new Promise<void>(resolve => { release = resolve; });
  await widget(page).getByRole('button', { name: 'Koppla testbilen', exact: true }).dblclick();
  await expect.poll(() => f.writes.length).toBe(1); await expect(page.getByRole('button', { name: 'Starta bilen', exact: true })).toBeDisabled();
  release(); f.session.holdWrite = undefined;
  await expect(widget(page).getByRole('alert')).toContainText('Uppdatera statusen');
  await expect(widget(page).getByRole('button', { name: 'Koppla testbilen', exact: true })).toBeDisabled();
  expect(f.writes[0].headers['x-platform-csrf']).toBe('platform-csrf-fleet-lab-company'); expect(f.writes[0].headers['x-platform-generation']).toBe('8');
  expect(f.writes[0].headers['x-platform-organisation-id']).toBe('fleet-lab-company'); expect(f.writes[0].headers['x-testcar-csrf']).toBe('testcar-bridge-csrf');
  await widget(page).getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(widget(page).getByText('Kopplad till Laboratoriebolaget', { exact: true })).toBeVisible(); expect(f.writes).toHaveLength(1);
  await expect(widget(page).getByRole('link', { name: 'Koppla simulator till fordon' })).toHaveAttribute('href', '/kontor#/fleet?tab=devices');
  await page.getByRole('button', { name: 'Starta bilen', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true })).toBeDisabled();
  await expect(widget(page).getByText('Stäng av testbilen innan du ändrar bolagskopplingen.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stäng av', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true })).toBeEnabled();
  await mkdir('/tmp/jeroc-fleet-mobile-review', { recursive: true });
  await widget(page).screenshot({ path: '/tmp/jeroc-fleet-mobile-review/testcar-company-link-390.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Koppla testbilen', exact: true })).toBeEnabled(); expect(f.writes).toHaveLength(2);
  expect(f.writes[1].body).toEqual({ action: 'disconnect' }); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('sen bolagsrespons ignoreras efter att plattformssessionen har bytt bolag', async ({ page }) => {
  const f = await fixture(page); let release!: () => void;
  f.session.holdBridge = new Promise<void>(resolve => { release = resolve; });
  await page.goto('/testbil1'); await expect.poll(() => f.reads.length).toBe(1);
  f.session.value = platform('another-company', 'Andra bolaget'); f.state.companyName = 'Andra bolaget';
  f.state.devices = [{ id: 'other-simulator', name: 'Andra bolagets simulator', vehicleId: 'another-vehicle', status: 'assigned' }];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => f.reads.length).toBe(2); release();
  await expect(widget(page)).toContainText('Andra bolaget'); await expand(page);
  await expect(page.getByRole('combobox', { name: 'Tilldelad simulator' })).toHaveValue('other-simulator');
  await expect(widget(page)).not.toContainText('Bolagets virtuella FMC003'); await expect(widget(page)).not.toContainText('Laboratoriebolaget');
  expect(f.writes).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('felaktig företagskoppling återansluts uttryckligen med ny inloggning till samma simulator och inväntar verklig kvittens', async ({ page }) => {
  const f = await fixture(page); f.session.keepErrorAfterConnect = true;
  f.state.link = { deviceId: 'registered-simulator', status: 'error', lastSentAt: '2026-10-16T12:00:00Z', error: 'Inloggningen för bolagskopplingen har gått ut.' };
  await page.goto('/testbil1'); await expect(widget(page)).toBeVisible(); await expand(page);
  await expect(widget(page).getByRole('button', { name: 'Återanslut företagskopplingen', exact: true })).toBeEnabled();
  expect(f.writes).toEqual([]);
  // An office re-login changes only the platform authentication. The old lab
  // session and exact simulator must remain selected until explicit recovery.
  f.session.value = { ...platform(), generation: 9, csrfToken: 'fresh-platform-csrf-after-login' };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => f.reads.length).toBe(2); await expand(page);
  await expect(widget(page).getByText('Inloggningen för bolagskopplingen har gått ut.', { exact: true })).toBeVisible();
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: 'Starta bilen', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Återanslut företagskopplingen', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stäng av', exact: true }).click();
  await widget(page).getByRole('button', { name: 'Återanslut företagskopplingen', exact: true }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].body).toEqual({ action: 'connect', deviceId: 'registered-simulator' });
  expect(f.writes[0].headers['x-platform-csrf']).toBe('fresh-platform-csrf-after-login');
  expect(f.writes[0].headers['x-platform-generation']).toBe('9');
  expect(f.writes[0].headers['x-platform-organisation-id']).toBe('fleet-lab-company');
  expect(f.writes[0].headers['x-testcar-csrf']).toBe('testcar-bridge-csrf');
  await expect(widget(page).getByRole('alert')).toContainText('Väntar på mottagarens kvittens');
  await expect(widget(page).getByRole('button', { name: 'Återanslut företagskopplingen', exact: true })).toBeDisabled();
  await expect(widget(page).getByText('Kopplad till Laboratoriebolaget', { exact: true })).toHaveCount(0);
  f.state.link = { ...f.state.link!, status: 'connected', error: undefined };
  await widget(page).getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(widget(page).getByText('Kopplad till Laboratoriebolaget', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  f.session.waitDisconnect = true;
  await widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true }).click();
  await expect(widget(page).getByRole('alert')).toContainText('Slutpaketet väntar på kvittens');
  await expect(widget(page)).toBeVisible();
  await expect(widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true })).toBeDisabled();
  await widget(page).getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(widget(page).getByRole('button', { name: 'Koppla från bolaget', exact: true })).toBeEnabled();
  expect(f.writes).toHaveLength(2); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});
