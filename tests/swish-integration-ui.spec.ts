import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function setup(page: Page, lostResponse = false) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(person => person.id === 'admin')!;
  const state = { settings: { enabled: false, bookkeepingEnabled: false, revision: 0 },
    configuration: { ready: true, mode: 'mss', missing: [], issues: [], merchantAlias: '1234679304' }, mode: 'mss', simulation: true,
    defaults: { amount: '10.00', paymentDetails: { method: 'swish', phone: '+46711111132', personalNumber: '197709306828', recipient: 'Swish MSS testmottagare' }, message: 'ScrapPilot MSS-test' } };
  const statistics = { sends: 0, reads: 0, businessWrites: 0, saved: undefined as Record<string, unknown> | undefined };
  let job: Record<string, unknown> | undefined;
  const session = { enabled: true, authenticated: true, actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: admin, user: admin, company: { id: 'jeroc-demo', name: 'Swish testbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo',
    effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'platform-test', generation: 1, companies: [] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/environment/swish/settings') {
      if (request.method() === 'POST') { statistics.saved = request.postDataJSON(); Object.assign(state.settings, statistics.saved); state.settings.revision++; }
      return route.fulfill({ json: state });
    }
    if (path === '/api/environment/swish/choices') return route.fulfill({ json: { companyId: 'bc39303b-caf5-405a-9dfe-e7f930bd0281', generation: 1,
      bankAccounts: [{ id: 'f6920500-6a06-4207-af91-5ac1f7a75c56', name: 'Testbank', ledgerAccountNumber: 1930, currency: 'SEK', active: true, type: 1 }] } });
    if (path === '/api/environment/swish/sandbox') {
      statistics.sends++; const body = request.postDataJSON();
      job = { id: body.idempotencyKey, kind: 'sandbox', mode: 'mss', simulation: true, status: 'pending', amount: body.amount,
        amountCents: 1000, currency: 'SEK', paymentDetails: body.paymentDetails, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        request: { method: 'POST', path: '/api/v1/payouts', payload: { amount: body.amount, payeeAlias: body.paymentDetails.phone.slice(1), payeeSSN: body.paymentDetails.personalNumber, message: body.message } },
        response: { httpStatus: 201, data: null }, events: [{ at: new Date().toISOString(), action: 'payment_reserved', text: 'Fristående Swish MSS-prov reserverat.' }], bookkeepingStatus: 'none' };
      if (lostResponse) return route.abort('failed');
      return route.fulfill({ json: job });
    }
    if (path.startsWith('/api/environment/swish/jobs/')) {
      statistics.reads++; if (!job) return route.fulfill({ status: 404, json: { message: 'Testet saknas.' } });
      job = { ...job, status: 'simulated_paid', response: { httpStatus: 200, data: { status: 'PAID', amount: '10.00' } }, updatedAt: new Date().toISOString() };
      return route.fulfill({ json: job });
    }
    if (request.method() !== 'GET' && !/(?:\/|-)session$/.test(path)) statistics.businessWrites++;
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin, csrfToken: 'environment-test', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/environment/integrations/catalog' ? { version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: true }, providers: [{ id: 'swish', name: 'Swish Utbetalning', category: 'payments', description: 'Testutbetalningar', mode: 'test', status: 'not-verified', implemented: true, configured: true, connected: false,
        requiredSetup: [], links: {}, capabilities: { canView: true, canConfigure: true, canCheck: true, canConnect: false } }] } : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { code: 'test_fixture', message: 'Tjänsten ingår inte i Swish-testet.' } });
  });
  return { state, statistics };
}

test('company Swish settings select a real sandbox bank choice and standalone MSS popup never changes invoices', async ({ page }) => {
  const { statistics } = await setup(page);
  await page.goto('/kontor#/integrations?service=swish');
  await page.getByLabel('Aktivera Swish MSS för bolaget', { exact: false }).check();
  await page.getByLabel('Registrera testbetalningen i Spiris sandbox', { exact: false }).check();
  await page.getByRole('button', { name: 'Hämta från Spiris', exact: true }).click();
  await page.getByLabel('Betalkonto i Spiris', { exact: true }).selectOption({ label: 'Testbank · 1930' });
  await page.getByRole('button', { name: 'Spara inställningar', exact: true }).click();
  await expect.poll(() => statistics.saved?.spirisBankAccountId).toBe('f6920500-6a06-4207-af91-5ac1f7a75c56');
  expect(statistics.saved?.spirisCompanyId).toBe('bc39303b-caf5-405a-9dfe-e7f930bd0281');
  expect(statistics.saved?.bookkeepingEnabled).toBe(true);
  await page.getByRole('link', { name: 'Öppna Swish-testsidan', exact: true }).click();
  await expect(page.getByLabel('Swish-nummer', { exact: false })).toHaveValue('+46711111132');
  await page.getByRole('button', { name: 'Skicka Swish-test', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('SWISH MSS · SIMULERING', { exact: true })).toBeVisible();
  await expect(dialog.locator('pre').filter({ hasText: 'payeeSSN' })).toContainText('197709306828');
  await expect(dialog.getByRole('heading', { name: 'Swish har svarat', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(dialog.locator('pre').filter({ hasText: 'PAID' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.getByText('Simulerad utbetalning bekräftad', { exact: true })).toBeVisible();
  expect(statistics.sends).toBe(1); expect(statistics.businessWrites).toBe(0);
});

test('lost MSS POST response blocks another send and reload only retrieves the saved instruction', async ({ page }) => {
  const { state, statistics } = await setup(page, true); state.settings.enabled = true;
  await page.goto('/kontor#/integrations/swish-test');
  await page.getByRole('button', { name: 'Skicka Swish-test', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Testets resultat är oklart', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stäng Swish-testet', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Skicka Swish-test', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByText('Simulerad utbetalning bekräftad', { exact: true })).toBeVisible();
  expect(statistics.sends).toBe(1); expect(statistics.reads).toBeGreaterThan(0); expect(statistics.businessWrites).toBe(0);
});
