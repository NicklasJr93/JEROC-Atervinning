import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { NvvJsonObject, NvvSandboxRequest, NvvSandboxRun, NvvSandboxState } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

const testPage = '/kontor/integration/systemadminintegrationtest.html';
const sandboxPath = '/api/environment/nvv/sandbox';
const prepareLabel = 'Förbered Testbolag 1 utan ombud';
const sendLabel = 'Skicka till NVV · TEST';
const preset = 'testbolag1-own-2026-10-16';
const legacyPreset = 'support-2026-10-16';
const at = '2026-10-16T09:00:00.000Z';
const certificateIssue = 'Testet kräver ett verifierat certifikat för verksamhetsutövare 5560000167.';
type OwnRequest = Omit<NvvSandboxRequest, 'preset'> & { preset?: typeof preset };
type OwnRun = Omit<NvvSandboxRun, 'preset'> & { preset?: typeof preset };
type OwnState = NvvSandboxState & { ownTest: { ready: boolean; issues: string[]; template: NvvJsonObject } };

function payload(): NvvJsonObject {
  return {
    tidpunkt: at, verksamhetsutovare: '5593593626', verksamhetensNamn: 'Lokalt testbolag',
    verksamhetensKontaktpersonNamn: 'Testkontakt', verksamhetensKontaktpersonEpost: 'test@example.invalid',
    verksamhetensKontaktpersonTelefonnummer: '0100000000', referens: 'LOKAL-GRUND-MALL',
    avfall: { kod: '160601', mangd: 10 }, transportsatt: 'R', mottagningsDatum: at, tidigareInnehavare: '5560000167',
    senasteHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Testgatan 12', postnummer: '76141' } },
    kommandeHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Ängsvägen 19', postnummer: '76141' } },
  };
}

function expectOwnPayload(value: NvvJsonObject) {
  expect(value).toMatchObject({ verksamhetsutovare: '5560000167', verksamhetensNamn: 'Testbolag 1', tidigareInnehavare: '5560000167' });
  expect(Object.keys(value).filter(key => /^ombud/i.test(key))).toEqual([]);
}

function runFor(request: OwnRequest, status: 'rejected' | 'unknown' = 'rejected'): OwnRun {
  return {
    id: request.requestId, preset: request.preset, status, method: 'POST', path: '/insamlingar',
    payload: structuredClone(request.payload), startedAt: at, finishedAt: at,
    httpStatus: status === 'rejected' ? 400 : null, outcome: status, trackingId: 'local-own-preset-trace',
    response: status === 'rejected' ? { fel: [{ felkod: '1023', feltext: 'Lokalt provsvar från NVV:s testmiljö.' }] } : null,
    error: { code: status === 'rejected' ? 'NVV_REJECTED' : 'NVV_UNKNOWN_OUTCOME',
      message: status === 'rejected' ? 'NVV avvisade det lokala testet.' : 'Slutresultatet är okänt. Kontrollera historiken före ny sändning.' },
  };
}

/** Every API request is fulfilled here; no server DB, credentials or provider is used. */
async function setup(page: Page, options: { ownReady?: boolean; presetQuery?: typeof preset | typeof legacyPreset; scopedEffective?: boolean; onPost?: (request: OwnRequest) => Promise<OwnRun> } = {}) {
  const data = migrateOffice(seedOffice()), legacyAdmin = data.users.find(user => user.id === 'admin')!;
  legacyAdmin.siteIds = ['norrtalje', 'rimbo'];
  const { siteIds: _legacySites, ...unscopedAdmin } = structuredClone(legacyAdmin);
  const actualUser = { ...unscopedAdmin, id: '__platform-admin', name: 'Systemadmin' };
  const user = options.scopedEffective ? legacyAdmin : actualUser;
  data.users.push(actualUser);
  const ownTemplate: NvvJsonObject = { ...payload(), verksamhetsutovare: '5560000167', verksamhetensNamn: 'Testbolag 1',
    tidigareInnehavare: '5560000167', referens: 'NVV-OWN-2026-10-16-LOKAL' };
  const previous = runFor({ requestId: 'previous-local-run', idempotencyKey: 'previous-local-key', payload: payload() });
  previous.trackingId = 'previous-history-trace';
  const state: OwnState = { mode: 'test', ready: true, missing: [], template: payload(), runs: [previous],
    certificate: { configured: true, validated: true, metadataAvailable: true, organisationName: 'Testbolag 1',
      organisationNumber: options.ownReady === false ? '5593593626' : '5560000167',
      issuer: null, validFrom: null, validTo: null, fingerprint256: null },
    ownTest: { ready: options.ownReady !== false, issues: options.ownReady === false ? [certificateIssue] : [], template: ownTemplate } };
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user,
    company: { id: 'jeroc-demo', name: 'Lokalt NVV-testbolag', organisationNumber: '5593593626', status: 'active' },
    organisationId: 'jeroc-demo', effectiveUserId: user.id, isSupportSession: actualUser.id !== user.id, mustChangePassword: false,
    csrfToken: 'local-platform-fixture', generation: 1, companies: [] };
  const requests: OwnRequest[] = [], businessWrites: string[] = [], externalRequests: string[] = [], errors: string[] = [];
  let reads = 0;
  page.on('pageerror', error => errors.push(error.message));
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:5173').origin;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { externalRequests.push(url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === sandboxPath && method === 'GET') { reads++; return route.fulfill({ json: state }); }
    if (path === sandboxPath && method === 'POST') {
      const submitted = request.postDataJSON() as OwnRequest;
      requests.push(submitted);
      const run = await (options.onPost?.(submitted) ?? Promise.resolve(runFor(submitted)));
      state.runs = [run, ...state.runs.filter(previousRun => previousRun.id !== run.id)];
      return route.fulfill({ json: run });
    }
    if (path.startsWith(`${sandboxPath}/runs/`) && method === 'GET') {
      reads++;
      const run = state.runs.find(item => item.id === decodeURIComponent(path.slice(`${sandboxPath}/runs/`.length)));
      return route.fulfill({ status: run ? 200 : 404, json: run ?? { error: 'Det lokala testet saknas.' } });
    }
    if (!['GET', 'HEAD'].includes(method) && path !== '/api/terminal-demo/staff-session') businessWrites.push(path);
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local fixture\n\n' });
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: user.id, user,
        csrfToken: 'local-environment-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: user.id,
        sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/pricing/state' ? { version: 'local-nvv-fixture', memoryOnly: false, revision: 1, asOfDate: '2026-10-16',
        metals: [], articles: [], customers: data.customers, users: data.users, customerPrices: [], audit: [] }
      : path === '/api/logistics/summary' ? { active: 0, total: 0 }
      : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { error: 'Detta API ingår inte i den lokala testfixturen.' } });
  });
  await page.goto(testPage + (options.presetQuery ? `?preset=${options.presetQuery}` : ''));
  if (options.scopedEffective) {
    await expect(page.getByRole('heading', { name: 'NVV-testet kräver systemadmins egen behörighet', exact: true })).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.getByRole('heading', { name: 'NVV · systemadminstest', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: prepareLabel, exact: true })).toBeVisible();
  }
  return { state, requests, businessWrites, externalRequests, errors, reads: () => reads };
}

test('vanliga testsidan förifyller egen rapportering och explicit test bevarar payload, råsvar och historik', async ({ page }) => {
  const fixture = await setup(page);
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  await expect(page.getByLabel('Verksamhetens namn', { exact: true })).toHaveValue('Testbolag 1');
  await expect(page.getByText('Testbolag 1 utan ombud är valt', { exact: true })).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Utgående testpayload', exact: true }).locator('pre');
  const initial = JSON.parse(await preview.innerText());
  expectOwnPayload(initial);
  expect(fixture.requests).toHaveLength(0);
  await page.getByRole('button', { name: prepareLabel, exact: true }).click();
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  await expect(page.getByLabel('Ombud · organisationsnummer', { exact: true })).toHaveCount(0);
  const prepared = JSON.parse(await preview.innerText());
  expectOwnPayload(prepared);
  const { tidpunkt: _time, mottagningsDatum: _received, referens: oldReference, ...ownFields } = fixture.state.ownTest.template;
  expect(prepared).toMatchObject(ownFields);
  expect(prepared.referens).not.toBe(oldReference);
  expect(prepared.referens).not.toBe(initial.referens);
  expect(prepared.referens.length).toBeLessThanOrEqual(40);
  expect(Number.isFinite(Date.parse(prepared.tidpunkt))).toBe(true);
  expect(prepared.mottagningsDatum).toBe(prepared.tidpunkt);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const screenshot = test.info().outputPath('nvv-own-preset-desktop.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await test.info().attach('Förberett prov utan ombud på dator', { path: screenshot, contentType: 'image/png' });

  await page.getByRole('button', { name: sendLabel, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'NVV avvisade testet', exact: true });
  await expect(dialog).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({ preset, payload: prepared });
  expectOwnPayload(fixture.requests[0].payload);
  expect(fixture.requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(fixture.requests[0].idempotencyKey).toBeTruthy();
  const frozen = JSON.parse(await dialog.getByRole('region', { name: 'Payload för detta test', exact: true }).locator('pre').innerText());
  expect(frozen).toEqual(prepared);
  await expect(dialog).toContainText('HTTP 400');
  await expect(dialog.getByRole('region', { name: 'NVV:s råsvar', exact: true })).toContainText('1023');
  await expect(dialog).toContainText('local-own-preset-trace');
  await dialog.getByRole('button', { name: 'Stäng', exact: true }).click();
  await expect(page.getByRole('region', { name: 'NVV:s testhistorik', exact: true })).toContainText('previous-history-trace');
  await page.getByLabel('Mängd (kg)', { exact: true }).fill('99');
  await page.getByRole('button', { name: 'Visa anrop och svar', exact: true }).first().click();
  expect(JSON.parse(await dialog.getByRole('region', { name: 'Payload för detta test', exact: true }).locator('pre').innerText())).toEqual(frozen);
  const beforeReads = fixture.reads();
  await dialog.getByRole('button', { name: 'Kontrollera testhistorik', exact: true }).click();
  await expect.poll(fixture.reads).toBeGreaterThan(beforeReads);
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.businessWrites).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('dubbelklick skickar ett prov utan ombud och okänt slutresultat blockerar ny sändning', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const fixture = await setup(page, { onPost: async request => { await pending; return runFor(request, 'unknown'); } });
  try {
    await page.getByRole('button', { name: prepareLabel, exact: true }).click();
    await page.getByRole('button', { name: sendLabel, exact: true }).evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect.poll(() => fixture.requests.length).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Skickar test till NVV', exact: true })).toBeVisible();
    await expect(page.locator('.nvv-sandbox-submit button')).toBeDisabled();
    expect(fixture.requests[0].preset).toBe(preset);
    expectOwnPayload(fixture.requests[0].payload);
    release();
    const dialog = page.getByRole('dialog', { name: 'Testets resultat är oklart', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Stäng', exact: true }).click();
    await expect(page.getByRole('button', { name: sendLabel, exact: true })).toBeDisabled();
    const beforeReads = fixture.reads();
    await page.getByRole('button', { name: 'Kontrollera testhistorik', exact: true }).click();
    await expect.poll(fixture.reads).toBeGreaterThan(beforeReads);
    await expect(page.getByRole('button', { name: sendLabel, exact: true })).toBeDisabled();
    await page.getByRole('form', { name: 'NVV:s testformulär', exact: true }).evaluate(form => (form as HTMLFormElement).requestSubmit());
    await page.reload();
    await expect(page.getByRole('button', { name: prepareLabel, exact: true })).toBeDisabled();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.businessWrites).toEqual([]);
    expect(fixture.externalRequests).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally { release(); }
});

test('fel certifikatorganisation spärrar egen rapportering och visar orsaken', async ({ page }) => {
  const fixture = await setup(page, { ownReady: false });
  await expect(page.getByRole('button', { name: prepareLabel, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: sendLabel, exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Testbolag 1 utan ombud', exact: true }).getByText(certificateIssue, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('nya direktlänken förifyller egen rapportering och väntar på uttrycklig sändning', async ({ page }) => {
  const fixture = await setup(page, { presetQuery: preset });
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  await expect(page.getByLabel('Verksamhetens namn', { exact: true })).toHaveValue('Testbolag 1');
  await expect(page.getByLabel('Ombud · organisationsnummer', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Testbolag 1 utan ombud är valt', { exact: true })).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const prepared = JSON.parse(await page.getByRole('complementary', { name: 'Utgående testpayload', exact: true }).locator('pre').innerText());
  expectOwnPayload(prepared);
  await page.getByRole('button', { name: sendLabel, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'NVV avvisade testet', exact: true })).toBeVisible();
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]).toMatchObject({ preset, payload: prepared });
  expectOwnPayload(fixture.requests[0].payload);
  expect(fixture.businessWrites).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('gamla supportlänken förifyller utan ombud även i JSON och återställning väljer manuell mall utan POST', async ({ page }) => {
  const fixture = await setup(page, { presetQuery: legacyPreset });
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  await expect(page.getByLabel('Verksamhetens namn', { exact: true })).toHaveValue('Testbolag 1');
  await expect(page.getByLabel('Tidigare innehavare · organisationsnummer', { exact: true })).toHaveValue('5560000167');
  for (const label of ['Ombud · organisationsnummer', 'Ombudets namn', 'Ombudets kontaktperson', 'Ombudets e-post', 'Ombudets telefon'])
    await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Testbolag 1 utan ombud är valt', { exact: true })).toBeVisible();
  const preview = page.getByRole('complementary', { name: 'Utgående testpayload', exact: true }).locator('pre');
  const prepared = JSON.parse(await preview.innerText());
  expectOwnPayload(prepared);
  await page.getByRole('tab', { name: 'Avancerad JSON', exact: true }).click();
  const advanced = JSON.parse(await page.getByRole('textbox', { name: 'JSON-payload', exact: true }).inputValue());
  expect(advanced).toEqual(prepared);
  expectOwnPayload(advanced);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Återställ testmall', exact: true }).click();
  await page.getByRole('tab', { name: 'Formulär', exact: true }).click();
  await expect(page.getByLabel('Verksamhetsutövare · organisationsnummer', { exact: true })).toHaveValue('5593593626');
  await expect(page.getByLabel('Verksamhetens namn', { exact: true })).toHaveValue('Lokalt testbolag');
  await expect(page.getByText('Testbolag 1 utan ombud är valt', { exact: true })).toHaveCount(0);
  expect(JSON.parse(await preview.innerText())).toEqual(fixture.state.template);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('platsbegränsat effektivt systemadminkonto nekas även via direktlänken utan NVV-anrop', async ({ page }) => {
  const fixture = await setup(page, { scopedEffective: true, presetQuery: preset });
  const denial = page.getByRole('heading', { name: 'NVV-testet kräver systemadmins egen behörighet', exact: true }).locator('..');
  await expect(denial).toContainText('Jobba som bolag');
  await expect(page.getByRole('button', { name: prepareLabel, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: sendLabel, exact: true })).toHaveCount(0);
  expect(fixture.reads()).toBe(0);
  expect(fixture.requests).toHaveLength(0);
  expect(fixture.businessWrites).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
