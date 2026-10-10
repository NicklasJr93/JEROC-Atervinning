import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { EnvironmentSessionState, NvvSandboxRequest, NvvSandboxRun, NvvSandboxState } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

const testPage = '/kontor/integration/systemadminintegrationtest.html';
const sandbox = '/api/environment/nvv/sandbox';
const sendLabel = 'Skicka till NVV · TEST';

async function login(page: Page, user = 'admin', direct = false) {
  await page.goto(direct ? testPage : '/kontor');
  await page.getByRole('button', { name: user === 'admin' ? /Systemadmin/ : /Lars Andersson/ }).click();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
  const response = await page.request.post('/api/environment/demo-session', { data: { userId: user, effectiveUserId: user } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<EnvironmentSessionState>;
}

async function fixtureState(page: Page): Promise<NvvSandboxState> {
  const response = await page.request.get(sandbox);
  expect(response.ok(), await response.text()).toBe(true);
  const state = await response.json() as NvvSandboxState;
  test.skip(state.mode !== 'mock', 'Use an isolated local NVV_ENVIRONMENT=mock server. All sandbox POSTs in these rendering tests are intercepted.');
  // Keep the server's real OpenAPI template. Only the rendering readiness and
  // reply are fixtures; no credential, certificate or external call is used.
  return { ...state, mode: 'test', ready: true, missing: [], runs: [], certificate: {
    issuer: null, validFrom: null, validTo: null, fingerprint256: null,
    ...state.certificate, configured: true, validated: true, metadataAvailable: true,
    organisationName: 'Lokal browserfixtur', organisationNumber: '5560000167',
  } };
}

function rejected(request: NvvSandboxRequest): NvvSandboxRun {
  return { id: request.requestId, status: 'rejected', method: 'POST', path: '/insamlingar',
    payload: structuredClone(request.payload), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    httpStatus: 400, outcome: 'rejected', trackingId: 'browser-fixture-trace-400',
    response: { fel: [{ felkod: '1023', feltext: 'Lokal testfixtur: organisationen kunde inte verifieras.' }] },
    error: { code: 'NVV_REJECTED', message: 'Lokal testfixtur: NVV avvisade anropet.' } };
}

async function installFixture(page: Page, state: NvvSandboxState, onPost: (request: NvvSandboxRequest) => Promise<NvvSandboxRun>) {
  const requests: NvvSandboxRequest[] = [];
  let reads = 0;
  await page.route(`**${sandbox}**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === sandbox && route.request().method() === 'GET') {
      reads++;
      await route.fulfill({ json: state });
    } else if (path === sandbox && route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as NvvSandboxRequest;
      requests.push(request);
      const run = await onPost(request);
      state.runs = [run, ...state.runs.filter(previous => previous.id !== run.id)];
      await route.fulfill({ json: run });
    } else if (path.startsWith(`${sandbox}/runs/`) && route.request().method() === 'GET') {
      reads++;
      const id = decodeURIComponent(path.slice(`${sandbox}/runs/`.length));
      const run = state.runs.find(value => value.id === id);
      await route.fulfill({ status: run ? 200 : 404, json: run ?? { error: 'Lokal fixtur saknas.' } });
    } else {
      await route.fulfill({ status: 405, json: { error: 'Endast mockade sandboxanrop är tillåtna i detta test.' } });
    }
  });
  return { requests, reads: () => reads };
}

async function openForm(page: Page) {
  await page.goto(testPage);
  await expect(page.getByRole('heading', { name: 'NVV · systemadminstest', exact: true })).toBeVisible();
  await expect(page.getByLabel('Mängd (kg)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sendLabel, exact: true })).toBeEnabled();
}

async function snapshot(page: Page, info: TestInfo, name: string) {
  const dialog = page.locator('dialog[open]');
  if (await dialog.count()) {
    await dialog.evaluate(async element => {
      await Promise.all(element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})));
    });
  } else {
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.office-main')?.scrollTo(0, 0); });
  }
  const path = info.outputPath(name);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('separata testadressen kräver systemadmin även vid direkta API-anrop', async ({ page }) => {
  await page.goto(testPage);
  await expect(page.getByRole('heading', { name: 'Välkommen till kontoret', exact: true })).toBeVisible();
  expect((await page.request.get(sandbox)).status()).toBe(401);
  const session = await login(page, 'lars', true);
  await expect(page.getByRole('heading', { name: 'Behörighet saknas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: sendLabel, exact: true })).toHaveCount(0);
  expect((await page.request.get(sandbox)).status()).toBe(403);
  const forbidden = await page.request.post(sandbox, {
    headers: { 'X-Environment-CSRF': session.csrfToken },
    data: { requestId: randomUUID(), idempotencyKey: randomUUID(), payload: {} },
  });
  expect(forbidden.status()).toBe(403);
});

test('ändrade formulärvärden skickas och popupen visar fryst payload samt rått HTTP 400-svar', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const state = await fixtureState(page);
  const fixture = await installFixture(page, state, async request => rejected(request));
  await openForm(page);
  await page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true }).fill('5560000167');
  await page.getByLabel('Mängd (kg)', { exact: true }).fill('12.5');
  await page.getByRole('tab', { name: 'Avancerad JSON', exact: true }).click();
  const edited = JSON.parse(await page.getByRole('textbox', { name: 'JSON-payload', exact: true }).inputValue());
  expect(edited.verksamhetsutovare).toBe('5560000167');
  expect(edited.avfall.mangd).toBe(12.5);
  expect(fixture.requests).toHaveLength(0);
  await page.getByRole('tab', { name: 'Formulär', exact: true }).click();
  await snapshot(page, info, 'nvv-sandbox-form-1440.png');

  await page.getByRole('button', { name: sendLabel, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'NVV avvisade testet', exact: true });
  await expect(dialog).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0].payload).toEqual(edited);
  expect(fixture.requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(fixture.requests[0].idempotencyKey).toBeTruthy();
  const payload = dialog.getByRole('region', { name: 'Payload för detta test', exact: true });
  expect(JSON.parse(await payload.locator('pre').innerText())).toEqual(edited);
  const raw = dialog.getByRole('region', { name: 'NVV:s råsvar', exact: true });
  await expect(dialog).toContainText('HTTP 400');
  await expect(dialog).toContainText('Spårnings-ID: browser-fixture-trace-400');
  await expect(raw).toContainText('1023');
  await expect(raw).toContainText('Lokal testfixtur: organisationen kunde inte verifieras.');
  await snapshot(page, info, 'nvv-sandbox-response-1440.png');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await snapshot(page, info, 'nvv-sandbox-response-390.png');
  expect(errors).toEqual([]);
});

test('pågående test spärrar dubbla POST och historikkontroll skickar inte testet igen', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  const state = await fixtureState(page);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fixture = await installFixture(page, state, async request => { await hold; return rejected(request); });
  try {
    await openForm(page);
    await page.getByLabel('Mängd (kg)', { exact: true }).fill('25');
    expect(fixture.requests).toHaveLength(0);
    await page.getByRole('button', { name: sendLabel, exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    const pending = page.getByRole('dialog', { name: 'Skickar test till NVV', exact: true });
    await expect(pending).toBeVisible();
    await expect.poll(() => fixture.requests.length).toBe(1);
    await expect(page.locator('.nvv-sandbox-submit button')).toBeDisabled();
    await pending.getByRole('button', { name: 'Kör i bakgrunden', exact: true }).click();
    await page.getByLabel('Mängd (kg)', { exact: true }).fill('50');
    expect((fixture.requests[0].payload.avfall as { mangd: number }).mangd).toBe(25);
    expect(fixture.requests).toHaveLength(1);

    release();
    await expect(page.getByRole('button', { name: sendLabel, exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Visa anrop och svar', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'NVV avvisade testet', exact: true });
    await expect(dialog).toBeVisible();
    const frozen = JSON.parse(await dialog.getByRole('region', { name: 'Payload för detta test', exact: true }).locator('pre').innerText());
    expect(frozen.avfall.mangd).toBe(25);
    const beforeReads = fixture.reads();
    await dialog.getByRole('button', { name: 'Kontrollera testhistorik', exact: true }).click();
    await expect.poll(() => fixture.reads()).toBe(beforeReads + 1);
    expect(fixture.requests).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { release(); }
});
