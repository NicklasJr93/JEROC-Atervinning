import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false });

async function setup(page: Page, restricted = false) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(person => person.id === 'admin')!;
  if (restricted) { admin.permissions = admin.permissions.filter(permission => permission !== 'integrationsManage'); admin.level = 'Medarbetare'; }
  const accounts = [{ id: 'account-test-1', name: 'Företagskonto', currency: 'SEK', iban: 'SE4550000000058398257466' }];
  const state = { settings: { enabled: false, bankId: 'SWEDSESS', corporateId: '5500000000', psuId: 'test-user', debtorAccountId: null as string | null, bookkeepingEnabled: false,
      spirisCompanyId: null as string | null, spirisBankAccountId: null as string | null, revision: 0 },
    configuration: { ready: true, mode: 'sandbox', missing: [], issues: [], redirectUri: 'https://jeroc-atervinning.onrender.com/api/integrations/openpayments/callback' },
    mode: 'sandbox', simulation: true, consent: { id: 'consent-test-1', status: 'valid', bankId: 'SWEDSESS', scaStatus: 'finalised' }, accounts,
    lastTest: null as Record<string, unknown> | null };
  const statistics = { bankCalls: 0, tests: 0, payments: 0, saved: undefined as Record<string, unknown> | undefined, balances: 0 };
  const session = { enabled: true, authenticated: true, actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: admin, user: admin, company: { id: 'jeroc-demo', name: 'Bank testbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo',
    effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'platform-test', generation: 1, companies: [] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.startsWith('/api/environment/bank/')) statistics.bankCalls++;
    if (path === '/api/environment/bank/settings') {
      if (request.method() === 'POST') { statistics.saved = request.postDataJSON(); Object.assign(state.settings, statistics.saved); state.settings.revision++; }
      return route.fulfill({ json: state });
    }
    if (path === '/api/environment/bank/banks') return route.fulfill({ json: { banks: [{ id: 'SWEDSESS', name: 'Swedbank & Sparbankerna', countryCode: 'SE', paymentProducts: ['domestic', 'swedish-giro'] }], simulation: true } });
    if (path === '/api/environment/bank/choices') return route.fulfill({ json: { companyId: 'bc39303b-caf5-405a-9dfe-e7f930bd0281', companyName: 'Spiris testbolag', bankAccounts: [
      { id: 'f6920500-6a06-4207-af91-5ac1f7a75c56', name: 'Företagskonto', ledgerAccountNumber: 1930, currency: 'SEK', active: true }] } });
    if (path === '/api/environment/bank/test') {
      statistics.tests++;
      state.lastTest = { ok: true, bankCount: 15, checkedAt: new Date().toISOString(), journal: { method: 'GET', path: '/psd2/aspspinformation/v1/aspsps', statusCode: 200,
        response: { aspsps: [{ bicFi: 'SWEDSESS', name: 'Swedbank' }], access_token: 'secret-fixture-must-not-render' }, requestId: 'bank-request-1' } };
      return route.fulfill({ json: state.lastTest });
    }
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
