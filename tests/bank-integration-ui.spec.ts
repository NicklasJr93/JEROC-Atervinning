import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false });

type FixtureOptions = { banksGate?: Promise<void>; testGate?: Promise<void>; sessionError?: string; configurationReady?: boolean; noConsent?: boolean; noRedirect?: boolean; consentFailure?: boolean; settingsFailure?: { status: 401 | 403; message: string } };

async function setup(page: Page, restricted = false, options: FixtureOptions = {}) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(person => person.id === 'admin')!;
  if (restricted) { admin.permissions = admin.permissions.filter(permission => permission !== 'integrationsManage'); admin.level = 'Medarbetare'; }
  const accounts = [{ id: 'account-test-1', name: 'Företagskonto', currency: 'SEK', iban: 'SE4550000000058398257466' }];
  const state = { settings: { enabled: false, bankId: 'SWEDSESS', corporateId: '5500000000', psuId: 'test-user', debtorAccountId: null as string | null, bookkeepingEnabled: false,
      spirisCompanyId: null as string | null, spirisBankAccountId: null as string | null, revision: 0 },
    configuration: { ready: options.configurationReady !== false, mode: 'sandbox', missing: options.configurationReady === false ? ['OPENPAYMENTS_CLIENT_SECRET'] : [], issues: [], redirectUri: options.noRedirect ? null : 'https://jeroc-atervinning.onrender.com/api/integrations/openpayments/callback' },
    mode: 'sandbox', simulation: true, consent: options.noConsent ? null : { id: 'consent-test-1', status: options.consentFailure ? 'failed' : 'valid', bankId: 'SWEDSESS', scaStatus: 'finalised',
      authorisationUrl: null, canReauthorise: options.consentFailure,
      error: options.consentFailure ? { code: 'consent_activation_failed', message: 'Testbankens godkännande kunde inte aktiveras.' } : null,
      authorisationDiagnostics: options.consentFailure ? { stage: 'activation', ok: false, httpStatus: 500, checkedAt: '2026-10-13T05:00:00.000Z', providerCodes: ['CONSENT_ACTIVATION_FAILED'],
        journal: [{ method: 'POST', path: '/authorisations/test-consent', statusCode: 500, response: { code: 'CONSENT_ACTIVATION_FAILED', client_secret: 'consent-secret-must-not-render', access_token: 'consent-token-must-not-render' } }] } : undefined }, accounts,
    lastTest: null as Record<string, unknown> | null };
  const statistics = { bankCalls: 0, bankReads: 0, consentRequests: 0, sessionReads: 0, tests: 0, payments: 0, saved: undefined as Record<string, unknown> | undefined, balances: 0 };
  const session = { enabled: true, authenticated: true, actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: admin, user: admin, company: { id: 'jeroc-demo', name: 'Bank testbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo',
    effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'platform-test', generation: 1, companies: [] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.startsWith('/api/environment/bank/')) statistics.bankCalls++;
    if (path === '/api/environment/bank/settings') {
      if (request.method() === 'GET' && options.settingsFailure) return route.fulfill({ status: options.settingsFailure.status, json: { code: 'identity_mismatch', message: options.settingsFailure.message } });
      if (request.method() === 'POST') { statistics.saved = request.postDataJSON(); Object.assign(state.settings, statistics.saved); state.settings.revision++; }
      return route.fulfill({ json: state });
    }
    if (path === '/api/environment/bank/banks') { statistics.bankReads++; await options.banksGate; return route.fulfill({ json: { banks: [{ id: 'SWEDSESS', name: 'Swedbank & Sparbankerna', countryCode: 'SE', paymentProducts: ['domestic', 'swedish-giro'] }], simulation: true } }); }
    if (path === '/api/environment/bank/choices') return route.fulfill({ json: { companyId: 'bc39303b-caf5-405a-9dfe-e7f930bd0281', companyName: 'Spiris testbolag', bankAccounts: [
      { id: 'f6920500-6a06-4207-af91-5ac1f7a75c56', name: 'Företagskonto', ledgerAccountNumber: 1930, currency: 'SEK', active: true }] } });
    if (path === '/api/environment/bank/test') {
      statistics.tests++; await options.testGate;
      if (!state.configuration.ready) { state.lastTest = { ok: false, checkedAt: new Date().toISOString(), error: { code: 'bank_not_configured', message: 'Bankkopplingen saknar giltiga sandboxinställningar.' }, journal: [] }; return route.fulfill({ json: state.lastTest }); }
      state.lastTest = { ok: true, bankCount: 15, checkedAt: new Date().toISOString(), journal: { method: 'GET', path: '/psd2/aspspinformation/v1/aspsps', statusCode: 200,
        response: { aspsps: [{ bicFi: 'SWEDSESS', name: 'Swedbank' }], access_token: 'secret-fixture-must-not-render' }, requestId: 'bank-request-1' } };
      return route.fulfill({ json: state.lastTest });
    }
    if (path === '/api/environment/bank/consent') { statistics.consentRequests++; return route.fulfill({ json: state.consent }); }
    if (path === '/api/environment/session') { statistics.sessionReads++; if (options.sessionError) return route.fulfill({ status: 503, json: { code: 'session_fixture', message: options.sessionError } }); }
    if (path === '/api/environment/bank/accounts') return route.fulfill({ json: { consent: state.consent, accounts, simulation: true } });
    if (path === '/api/environment/bank/balances') { statistics.balances++; return route.fulfill({ json: { accountId: 'account-test-1', data: { balances: [{ balanceAmount: { currency: 'SEK', amount: '12500.00' }, balanceType: 'interimAvailable' }] }, simulation: true } }); }
    if (path.includes('/payments') || path.includes('/bank/sandbox')) statistics.payments++;
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin, csrfToken: 'environment-test', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/environment/integrations/catalog' ? { version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: !restricted }, providers: [{ id: 'bank', name: 'Bank · Open Payments', category: 'payments', description: 'Bankbetalningar i sandbox', mode: 'test', status: 'not-verified', implemented: true, configured: true, connected: false,
        requiredSetup: [], links: {}, capabilities: { canView: true, canConfigure: !restricted, canCheck: !restricted, canConnect: false } }] } : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { code: 'test_fixture', message: 'Tjänsten ingår inte i banktestet.' } });
  });
  return { state, statistics };
}

test('bank integration binds a bank-returned account and Spiris company without exposing credentials', async ({ page }) => {
  const { statistics } = await setup(page);
  await page.goto('/kontor#/integrations?service=bank');
  await expect(page.getByLabel('Bank i testmiljön', { exact: true })).toBeEnabled();
  await expect(page.getByText('https://jeroc-atervinning.onrender.com/api/integrations/openpayments/callback', { exact: true })).toBeVisible();
  await page.getByLabel('Konto för utbetalningar', { exact: false }).selectOption('account-test-1');
  await page.getByLabel('Aktivera bankutbetalningar i sandbox', { exact: false }).check();
  await page.getByLabel('Registrera testbetalningen i Spiris sandbox', { exact: false }).check();
  await page.getByRole('button', { name: 'Hämta från Spiris', exact: true }).click();
  await page.getByLabel('Betalkonto i Spiris', { exact: true }).selectOption({ label: 'Företagskonto · 1930' });
  await page.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect.poll(() => statistics.saved?.debtorAccountId).toBe('account-test-1');
  expect(statistics.saved?.spirisCompanyId).toBe('bc39303b-caf5-405a-9dfe-e7f930bd0281');
  expect(statistics.saved?.spirisBankAccountId).toBe('f6920500-6a06-4207-af91-5ac1f7a75c56');
  expect(statistics.saved?.enabled).toBe(true);
  expect(statistics.saved).not.toHaveProperty('debtorAccount');
  await expect(page.getByLabel('Client Secret', { exact: true })).toHaveCount(0);
  expect(statistics.payments).toBe(0);
});

test('connection test shows actual HTTP response and account balance reads never submit payments', async ({ page }) => {
  const { state, statistics } = await setup(page); state.settings.debtorAccountId = 'account-test-1';
  await page.goto('/kontor#/integrations/bank-test');
  await page.getByRole('button', { name: 'Testa anslutningen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Open Payments har svarat', exact: true })).toBeVisible();
  await expect(dialog.getByText('HTTP 200', { exact: true })).toBeVisible();
  await expect(dialog.locator('pre').filter({ hasText: 'aspsps' })).toContainText('Swedbank');
  await expect(dialog).not.toContainText('secret-fixture-must-not-render');
  await expect(dialog).toContainText('[borttaget]');
  await dialog.getByRole('button', { name: 'Klart', exact: true }).click();
  await page.getByRole('button', { name: 'Hämta konton', exact: true }).click();
  await expect(page.getByText(/Företagskonto · SEK · SE455/)).toBeVisible();
  await page.getByRole('button', { name: 'Hämta testsaldo', exact: true }).click();
  await expect(page.locator('pre')).toContainText('12500.00');
  expect(statistics.tests).toBe(1); expect(statistics.balances).toBe(1); expect(statistics.payments).toBe(0);
});

test('integration management permission is required by both bank pages before any bank request', async ({ page }) => {
  const { statistics } = await setup(page, true);
  await page.goto('/kontor#/integrations?service=bank');
  await expect(page.getByText('Du behöver behörighet att hantera bolagets integrationer för att visa bankinställningarna.', { exact: true })).toBeVisible();
  await page.goto('/kontor#/integrations/bank-test');
  await expect(page.getByRole('heading', { name: 'Behörighet saknas', exact: true })).toBeVisible();
  expect(statistics.bankCalls).toBe(0);
});


test('a slow bank-list read does not lock unrelated company settings', async ({ page }) => {
  let finishBanks!: () => void;
  const banksGate = new Promise<void>(resolve => { finishBanks = resolve; });
  const { statistics } = await setup(page, false, { banksGate });
  try {
    await page.goto('/kontor#/integrations?service=bank');
    await expect.poll(() => statistics.bankReads).toBeGreaterThan(0);
    await expect(page.getByLabel('Företags-ID hos testbanken', { exact: false })).toBeEnabled();
    await expect(page.getByLabel('Användar-ID hos testbanken', { exact: false })).toBeEnabled();
    await page.getByLabel('Företags-ID hos testbanken', { exact: false }).fill('5560160680');
    await expect(page.getByRole('button', { name: 'Spara inställningar', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
    await expect.poll(() => statistics.saved?.corporateId).toBe('5560160680');
    finishBanks();
    await expect(page.getByLabel('Företags-ID hos testbanken', { exact: false })).toHaveValue('5560160680');
    expect(statistics.tests).toBe(0); expect(statistics.payments).toBe(0);
  } finally { finishBanks(); }
});

for (const path of ['/integrations?service=bank', '/integrations/bank-test']) {
  test(`bank page ${path} shows a session failure and explicitly retries it`, async ({ page }) => {
    const options = { sessionError: 'Bolagets integrationssession kunde inte startas.' };
    const { statistics } = await setup(page, false, options);
    await page.goto(`/kontor#${path}`);
    await expect(page.getByText(options.sessionError, { exact: true })).toBeVisible();
    expect(statistics.bankCalls).toBe(0);
    options.sessionError = '';
    await page.getByRole('button', { name: 'Försök igen', exact: true }).click();
    await expect.poll(() => statistics.sessionReads).toBeGreaterThan(1);
    if (path.includes('bank-test')) await expect(page.getByRole('button', { name: 'Testa anslutningen', exact: true })).toBeEnabled();
    else await expect(page.getByLabel('Företags-ID hos testbanken', { exact: false })).toBeEnabled();
    expect(statistics.tests).toBe(0); expect(statistics.payments).toBe(0);
  });
}

for (const path of ['/integrations?service=bank', '/integrations/bank-test']) {
  test(`incomplete credentials on ${path} allow connection diagnostics while bank consent remains blocked`, async ({ page }) => {
    const { statistics } = await setup(page, false, { configurationReady: false, noConsent: true, noRedirect: true });
    await page.goto(`/kontor#${path}`);
    await expect(page.getByText('OPENPAYMENTS_CLIENT_SECRET', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Anslut testbanken', exact: true })).toBeDisabled();
    const button = page.getByRole('button', { name: 'Testa anslutningen', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole('dialog')).toContainText('Bankkopplingen saknar giltiga sandboxinställningar.');
    expect(statistics.tests).toBe(1); expect(statistics.consentRequests).toBe(0); expect(statistics.payments).toBe(0);
  });
}


test('a connection diagnostic times out, unlocks controls and can be explicitly retried', async ({ page }) => {
  await page.clock.install();
  let finishTest!: () => void;
  const options: FixtureOptions = { testGate: new Promise<void>(resolve => { finishTest = resolve; }) };
  const { statistics } = await setup(page, false, options);
  try {
    await page.goto('/kontor#/integrations/bank-test');
    const button = page.getByRole('button', { name: 'Testa anslutningen', exact: true });
    await button.click();
    await expect.poll(() => statistics.tests).toBe(1);
    await page.clock.fastForward(35_001);
    await expect(page.getByRole('dialog')).toContainText('Hämtningen från banktjänsten tog för lång tid.');
    await page.getByRole('button', { name: 'Stäng Open Payments-testet', exact: true }).click();
    await expect(button).toBeEnabled();
    options.testGate = undefined;
    await button.click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Open Payments har svarat', exact: true })).toBeVisible();
    expect(statistics.tests).toBe(2); expect(statistics.consentRequests).toBe(0); expect(statistics.payments).toBe(0);
  } finally { finishTest(); }
});


for (const path of ['/integrations?service=bank', '/integrations/bank-test']) {
  test(`failed bank approval on ${path} shows provider diagnostics without a stale approval link`, async ({ page }) => {
    const { statistics } = await setup(page, false, { consentFailure: true });
    await page.goto(`/kontor#${path}`);
    await expect(page.getByText('Testbankens godkännande kunde inte aktiveras.', { exact: true })).toBeVisible();
    await expect(page.getByText(/kunde inte aktiveras · HTTP 500/)).toBeVisible();
    await expect(page.getByText(/Bankens medgivande är klart/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Godkänn hos testbanken', exact: true })).toHaveCount(0);
    await page.getByText('Felsökningsinformation', { exact: true }).click();
    const diagnostic = page.locator('.bank-consent-diagnostics pre');
    await expect(diagnostic).toContainText('CONSENT_ACTIVATION_FAILED');
    await expect(diagnostic).toContainText('[borttaget]');
    await expect(diagnostic).not.toContainText('consent-secret-must-not-render');
    await expect(diagnostic).not.toContainText('consent-token-must-not-render');
    await page.getByRole('button', { name: 'Prova bankgodkännandet igen', exact: true }).click();
    await expect.poll(() => statistics.consentRequests).toBe(1);
    expect(statistics.payments).toBe(0);
  });
}

for (const { path, status } of [{ path: '/integrations?service=bank', status: 403 }, { path: '/integrations/bank-test', status: 401 }] as const) {
  test(`bank settings ${status} on ${path} require an explicit session retry without replaying writes`, async ({ page }) => {
    const message = 'Bankens integrationssession behöver verifieras igen.';
    const options: FixtureOptions = { settingsFailure: { status, message } };
    const { statistics } = await setup(page, false, options);
    await page.goto(`/kontor#${path}`);
    await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
    const retry = page.getByRole('button', { name: 'Försök igen', exact: true });
    await expect(retry).toBeVisible();
    expect(statistics.tests).toBe(0); expect(statistics.consentRequests).toBe(0); expect(statistics.saved).toBeUndefined();
    options.settingsFailure = undefined;
    await retry.click();
    await expect.poll(() => statistics.sessionReads).toBeGreaterThan(1);
    await expect(page.getByRole('button', { name: 'Testa anslutningen', exact: true })).toBeEnabled();
    expect(statistics.tests).toBe(0); expect(statistics.consentRequests).toBe(0); expect(statistics.saved).toBeUndefined(); expect(statistics.payments).toBe(0);
  });
}

test('a pending bank-list read on the test page does not block connection diagnostics', async ({ page }) => {
  let finishBanks!: () => void;
  const options: FixtureOptions = { banksGate: new Promise<void>(resolve => { finishBanks = resolve; }) };
  const { statistics } = await setup(page, false, options);
  try {
    await page.goto('/kontor#/integrations/bank-test');
    await page.getByRole('button', { name: 'Hämta testbanker', exact: true }).click();
    await expect.poll(() => statistics.bankReads).toBe(1);
    const button = page.getByRole('button', { name: 'Testa anslutningen', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Open Payments har svarat', exact: true })).toBeVisible();
    expect(statistics.tests).toBe(1); expect(statistics.consentRequests).toBe(0); expect(statistics.payments).toBe(0);
  } finally { finishBanks(); }
});

test('an older consumed approval without new diagnostics offers explicit recovery', async ({ page }) => {
  const { state, statistics } = await setup(page, false, { consentFailure: true });
  state.consent!.status = 'authorising'; state.consent!.scaStatus = 'started';
  state.consent!.canReauthorise = false; state.consent!.authorisationDiagnostics = undefined;
  state.consent!.error!.code = 'bank_authorisation_activation_failed';
  await page.goto('/kontor#/integrations/bank-test?bankAuth=error');
  await expect(page.getByRole('link', { name: 'Godkänn hos testbanken', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Kontrollera och försök igen', exact: true }).click();
  await expect.poll(() => statistics.consentRequests).toBe(1);
  expect(statistics.payments).toBe(0);
});
