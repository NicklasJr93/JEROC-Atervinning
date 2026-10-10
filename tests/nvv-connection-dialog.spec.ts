import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { EnvironmentSessionState, NvvIntegrationStatus } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

const checkPath = '/api/environment/nvv/check';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function setup(page: Page) {
  await page.goto('/kontor');
  await page.getByRole('button', { name: /Systemadmin/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  const login = await page.request.post('/api/environment/demo-session', { data: { userId: 'admin', effectiveUserId: 'admin' } });
  expect(login.ok(), await login.text()).toBe(true);
  const session = await login.json() as EnvironmentSessionState;
  const response = await page.request.get('/api/environment/nvv/status');
  expect(response.ok(), await response.text()).toBe(true);
  const status = await response.json() as NvvIntegrationStatus;
  test.skip(status.mode !== 'mock', 'Run with local NVV_ENVIRONMENT=mock; no NVV credentials or external HTTP are used.');
  // A new reporter version makes every test start without a previous check.
  const saved = await page.request.put('/api/environment/nvv/reporter', {
    headers: { 'X-Environment-CSRF': session.csrfToken }, data: {
      expectedVersion: status.reporterVersion, name: `Dialogtest ${randomUUID().slice(0, 8)}`, number: '5560000167',
      contactName: 'Lokal testperson', email: 'dialog@example.test', phone: '0101234567',
      certificateOrganisationNumber: '', testIdentityConfirmed: false,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  return saved.json() as Promise<NvvIntegrationStatus>;
}
async function settings(page: Page) {
  await page.goto('/kontor#/integrations?service=nvv');
  const panel = page.getByRole('region', { name: 'NVV-inställningar', exact: true });
  await expect(panel.getByLabel('Organisationsnamn', { exact: true })).toBeVisible();
  return panel;
}
async function screenshot(page: Page, info: TestInfo, filename: string) {
  const path = info.outputPath(filename);
  await page.locator('dialog').evaluate(async element => {
    const finite = element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path });
  await info.attach(filename, { path, contentType: 'image/png' });
}

test('anslutningsdialogen inväntar det verkliga mocksvaret och visar ärliga antal utan myndighetsanrop', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  const delayed = gate(); let requests = 0, result: NvvIntegrationStatus | undefined;
  await page.route(`**${checkPath}`, async route => {
    requests++;
    const response = await route.fetch(); result = await response.json() as NvvIntegrationStatus;
    await delayed.promise;
    await route.fulfill({ response, json: result });
  });
  try {
    const panel = await settings(page);
    await panel.getByRole('button', { name: 'Prova simulerad anslutning', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provar simulerad anslutning', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Dölj anslutningskontrollen', exact: true })).toBeFocused();
    await expect(dialog.getByRole('status')).toContainText('Serverns svar inväntas');
    await expect(dialog.getByRole('region', { name: 'Anrop och svar', exact: true })).toContainText('Anrop och svar visas när servern har svarat.');
    await expect(panel.getByRole('button', { name: 'Kontrollerar…', exact: true })).toBeDisabled();
    await expect.poll(() => result?.lastCheck?.connected).toBe(true);
    expect(requests).toBe(1);
    await screenshot(page, info, 'nvv-check-pending-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
    await screenshot(page, info, 'nvv-check-pending-390.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    delayed.release();
    const success = page.getByRole('dialog', { name: 'Simuleringen fungerar', exact: true });
    await expect(success).toBeVisible();
    expect(result!.lastCheck!.diagnostics ?? []).toEqual([]);
    await expect(success.locator('.nvv-check-results > div').nth(0).locator('strong')).toHaveText(String(result!.lastCheck!.wasteCodes.length));
    await expect(success.locator('.nvv-check-results > div').nth(1).locator('strong')).toHaveText(String(result!.lastCheck!.transportModes.length));
    await expect(success.getByRole('region', { name: 'Anrop och svar', exact: true })).toContainText('Simuleringsläge · inga anrop till NVV.');
    await screenshot(page, info, 'nvv-check-success-mock-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(page, info, 'nvv-check-success-mock-390.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await success.getByRole('button', { name: 'Klart', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Prova simulerad anslutning', exact: true })).toBeFocused();
    await expect(panel.locator('.nvv-connection-summary')).toContainText('Simulerad anslutning');
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally { delayed.release(); }
});

test('testfixtur för fel och återförsök visar serverns GET-, HTTP- och svarssammanfattning utan dubbla kontroller', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const base = await setup(page), retried = gate();
  let requests = 0;
  // Rendering fixtures only. Both routes are intercepted, so these TEST-mode
  // examples never contact NVV or certify a real connection.
  let fixture: NvvIntegrationStatus = { ...base, mode: 'test', configured: true, connected: false, missing: [], lastCheck: null };
  await page.route('**/api/environment/nvv/status', route => route.fulfill({ json: fixture }));
  await page.route(`**${checkPath}`, async route => {
    requests++;
    if (requests === 1) {
      fixture = { ...fixture, connected: false, lastCheck: { mode: 'test', connected: false, checkedAt: new Date().toISOString(),
        wasteCodes: [], transportModes: [], error: { code: 'NVV_ACCESS', message: 'Testfixtur: åtkomst nekad till kodlistan.' },
        diagnostics: [{ method: 'GET', path: '/avfallstyper', httpStatus: 403, outcome: 'rejected',
          trackingId: 'fixture-denied-request', response: { message: 'Testfixtur: behörighet saknas.' } }] } };
    } else {
      fixture = { ...fixture, connected: true, lastCheck: { mode: 'test', connected: true, checkedAt: new Date().toISOString(),
        wasteCodes: [{ code: '160601', description: 'Blybatterier', hazardous: true },
          { code: '170401', description: 'Koppar', hazardous: false }, { code: '170405', description: 'Järn', hazardous: false }],
        transportModes: [{ code: 'R', description: 'Vägtransport' }, { code: 'T', description: 'Testtransport' }],
        diagnostics: [{ method: 'GET', path: '/avfallstyper', httpStatus: 200, outcome: 'accepted', trackingId: 'fixture-codes-request',
          response: { summary: 'Testfixtur: sammanfattat utdrag ur kodlistan.', count: 3, sixDigitCodes: 3,
            fixtureNotice: 'Det här är ett lokalt renderingsexempel för dialogens utfällbara svar, utan externa anrop eller verifierad myndighetsanslutning.',
            example: { kod: '160601', beskrivning: 'Blybatterier', farligt: true } } },
        { method: 'GET', path: '/transportsatt', httpStatus: 200, outcome: 'accepted', trackingId: 'fixture-transport-request',
          response: { summary: 'Testfixtur: transportsätt.', count: 2, items: [{ transportsatt: 'R', beskrivning: 'Vägtransport' }] } }] } };
      await retried.promise;
    }
    await route.fulfill({ json: fixture });
  });
  try {
    const panel = await settings(page);
    await panel.getByRole('button', { name: 'Kontrollera testanslutning', exact: true }).click();
    const failed = page.getByRole('dialog', { name: 'Anslutningen kunde inte bekräftas', exact: true });
    await expect(failed.getByRole('alert')).toHaveText('Testfixtur: åtkomst nekad till kodlistan.');
    const diagnostics = failed.getByRole('region', { name: 'Anrop och svar', exact: true });
    await expect(diagnostics).toContainText('GET');
    await expect(diagnostics).toContainText('/avfallstyper');
    await expect(diagnostics).toContainText('HTTP 403');
    await expect(diagnostics).toContainText('Testfixtur: behörighet saknas.');
    expect(requests).toBe(1);
    await screenshot(page, info, 'nvv-check-error-fixture-1440.png');
    await failed.getByRole('button', { name: 'Försök igen', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Kontrollerar NVV-anslutningen', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Kontrollerar…', exact: true })).toBeDisabled();
    await expect.poll(() => requests).toBe(2);
    retried.release();
    const success = page.getByRole('dialog', { name: 'Testanslutningen fungerar', exact: true });
    await expect(success).toBeVisible();
    await expect(success.locator('.nvv-check-results > div').nth(0).locator('strong')).toHaveText('3');
    await expect(success.locator('.nvv-check-results > div').nth(1).locator('strong')).toHaveText('2');
    const sent = success.getByRole('region', { name: 'Anrop och svar', exact: true });
    await expect(sent.locator('li')).toHaveCount(2);
    await expect(sent).toContainText('HTTP 200');
    await expect(sent).toContainText('/transportsatt');
    const summary = sent.locator('summary', { hasText: 'Visa hela sammanfattningen' }).first();
    await summary.click();
    await expect(sent.locator('pre').first()).toContainText('"kod": "160601"');
    await expect(sent).toContainText('fixture-codes-request');
    await summary.click();
    await screenshot(page, info, 'nvv-check-success-diagnostics-fixture-1440.png');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await success.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await screenshot(page, info, 'nvv-check-success-diagnostics-fixture-390.png');
    await success.getByRole('button', { name: 'Klart', exact: true }).click();
    await expect(panel.locator('.nvv-connection-summary')).toContainText('3 avfallskoder · 2 transportsätt');
    expect(requests).toBe(2);
    expect(errors).toEqual([]);
  } finally { retried.release(); }
});

test('dold pågående kontroll uppdaterar föräldervyn när svaret kommer och öppnar inte dialogen igen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  const delayed = gate(); let requests = 0;
  await page.route(`**${checkPath}`, async route => {
    requests++; const response = await route.fetch();
    await delayed.promise;
    await route.fulfill({ response });
  });
  try {
    const panel = await settings(page);
    await panel.getByRole('button', { name: 'Prova simulerad anslutning', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Provar simulerad anslutning', exact: true });
    await dialog.getByRole('button', { name: 'Kör i bakgrunden', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Kontrollerar…', exact: true })).toBeDisabled();
    delayed.release();
    await expect(panel.locator('.nvv-connection-summary')).toContainText('Simulerad anslutning');
    await expect(panel.getByRole('button', { name: 'Prova simulerad anslutning', exact: true })).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const response = await page.request.get('/api/environment/nvv/status');
    expect((await response.json()).connected).toBe(true);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally { delayed.release(); }
});
