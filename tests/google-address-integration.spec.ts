import { expect, test, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
const browserKey = 'SYNTHETIC-GOOGLE-BROWSER-KEY-NEVER-RENDER';

async function setup(page: Page, configured = true) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(user => user.id === 'admin')!;
  const stats = { config: 0, validation: 0, saves: 0 };
  await page.addInitScript(() => {
    const place = {
      addressComponents: [
        { longText: 'Registergatan', types: ['route'] }, { longText: '12', types: ['street_number'] },
        { longText: '761 41', types: ['postal_code'] }, { longText: 'Norrtälje', types: ['postal_town'] },
        { longText: 'Sverige', shortText: 'SE', types: ['country'] },
      ], fetchFields: async () => {},
    };
    Object.assign(window, { google: { maps: { importLibrary: async () => ({
      AutocompleteSessionToken: class {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [
        { placePrediction: { text: { toString: () => 'Registergatan 12, Norrtälje' }, toPlace: () => place } },
      ] }) },
    }) } } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/address-assistance/config') {
      stats.config++;
      return route.fulfill({ json: { configured, browserConfigured: true, validationConfigured: configured,
        ...(configured ? { browserApiKey: browserKey } : {}), countryCode: 'SE' } });
    }
    if (path === '/api/address-assistance/validate') {
      stats.validation++;
      expect(request.headers()['x-demo-actor']).toBe(admin.id);
      expect(request.headers()['x-demo-user']).toBe(admin.id);
      expect(request.postDataJSON()).toEqual({ address: { address: 'Registergatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' } });
      return route.fulfill({ json: { address: { address: 'Registergatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' },
        verdict: { addressComplete: true, hasUnconfirmedComponents: false, hasInferredComponents: false, hasReplacedComponents: false, requiresConfirmation: true } } });
    }
    if (path === '/api/application/office' && request.method() !== 'GET') stats.saves++;
    const result = path === '/api/platform/session' ? {
      enabled: true, authenticated: true, actor: { id: 'platform-google-test', name: 'Systemadmin', username: 'admin', platformAdmin: true },
      actualUser: admin, user: admin, company: { id: 'jeroc-demo', name: 'Adressprov AB', organisationNumber: '5593593626', status: 'active' },
      organisationId: 'jeroc-demo', effectiveUserId: admin.id, isSupportSession: false, mustChangePassword: false,
      csrfToken: 'platform-google-test', generation: 1, companies: [],
    } : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
        : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: admin.id, user: admin, csrfToken: 'environment-google-test', expiresAt: '2099-01-01T00:00:00.000Z' }
          : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: admin.id }
            : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: admin.id, sites: [], terminals: [], approvals: [], defaults: [] }
              : path === '/api/environment/integrations/catalog' ? { version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: true }, providers: [{
                id: 'google-maps', name: 'Google adresser', category: 'maps', description: 'Adressförslag och bekräftad postadress.', mode: 'production',
                status: configured ? 'not-verified' : 'not-configured', configured, connected: false, implemented: true, requiredSetup: [], links: {},
                capabilities: { canView: true, canConfigure: true, canCheck: false, canConnect: false },
              }] } : undefined;
    return route.fulfill({ status: result ? 200 : 503, json: result ?? { error: 'Tjänsten ingår inte i adressprovet.' } });
  });
  return stats;
}

test('Googlekortet visar konfiguration utan att påstå anslutning; adressval fyller provets vanliga fält och sparar ingen kund', async ({ page }) => {
  const stats = await setup(page);
  await page.goto('/kontor#/integrations');
  const card = page.getByRole('button', { name: 'Google adresser', exact: true });
  await expect(card).toContainText('Konfigurerad');
  expect(stats.config).toBe(0);
  await card.click();
  const panel = page.getByRole('article', { name: 'Google adressinställningar', exact: true });
  await expect(panel).toContainText('Webbläsarnyckel för adressförslag: Registrerad');
  await expect(panel).toContainText('Servernyckel för adresskontroll: Registrerad');
  await expect(panel).not.toContainText(browserKey);
  await expect(panel.getByText('Ansluten', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Testa adresshjälpen', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Sök och komplettera adress', exact: true })).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'Gatuadress', exact: true }).fill('Register');
  await panel.getByRole('listbox', { name: 'Adressförslag' }).getByRole('option', { name: 'Registergatan 12, Norrtälje', exact: true }).click();
  await expect(panel.getByLabel('Gatuadress', { exact: true })).toHaveValue('Registergatan 12');
  await expect(panel.getByLabel('Postnummer', { exact: true })).toHaveValue('76141');
  await expect(panel.getByLabel('Ort', { exact: true })).toHaveValue('Norrtälje');
  await expect(panel.getByRole('button', { name: 'Adressen stämmer – använd adressen', exact: true })).toHaveCount(0);
  await expect(panel.getByText('Adressfälten är ifyllda för provet. Inga kunduppgifter har sparats.', { exact: true })).toBeVisible();
  expect(stats.validation).toBe(1); expect(stats.saves).toBe(0);
  await expect(panel).not.toContainText(browserKey);

  // Applying a suggestion never locks the normal fields or saves the form.
  await panel.getByLabel('Postnummer', { exact: true }).fill('76142');
  await expect(panel.getByLabel('Postnummer', { exact: true })).toHaveValue('76142');
  await expect(panel.getByText('Adressfälten är ifyllda för provet. Inga kunduppgifter har sparats.', { exact: true })).toHaveCount(0);
  expect(stats.validation).toBe(1); expect(stats.saves).toBe(0);
});

test('Googlepanelen skiljer på saknad servernyckel och registrerad webbläsarnyckel', async ({ page }) => {
  const stats = await setup(page, false);
  await page.goto('/kontor#/integrations?service=google-maps');
  const panel = page.getByRole('article', { name: 'Google adressinställningar', exact: true });
  await expect(panel).toContainText('Webbläsarnyckel för adressförslag: Registrerad');
  await expect(panel).toContainText('Servernyckel för adresskontroll: Saknas');
  await expect(panel.getByRole('button', { name: 'Testa adresshjälpen', exact: true })).toBeDisabled();
  await expect(panel).toContainText('Kundkortens adressfält kan fyllas i manuellt');
  expect(stats.validation).toBe(0); expect(stats.saves).toBe(0);
});
