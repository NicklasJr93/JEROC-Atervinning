import { expect, test, type Page, type Request } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { EnvironmentSite, EnvironmentSiteInput } from '../src/office/environment-types';

test.use({ viewport: { width: 1440, height: 1100 }, isMobile: false, hasTouch: false });

async function facilityFixture(page: Page, options: { conflict?: boolean; readOnly?: boolean } = {}) {
  const data = migrateOffice(seedOffice()), admin = data.users.find(value => value.id === 'admin')!;
  const user = options.readOnly ? { ...admin, id: 'facility-reader', name: 'Läsare', level: 'Medarbetare' as const, permissions: ['environmentRead' as const] } : admin;
  if (user.id !== admin.id) data.users.push(user);
  let site: EnvironmentSite = { id: 'facility-test', name: 'Testanläggning', address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje',
    municipalityCode: '0188', active: true, version: 1, permitReference: '', permitNotes: '' };
  const writes: Request[] = [];
  const company = { id: 'facility-company', name: 'Isolerat anläggningsprov AB', organisationNumber: '5593593626', status: 'active' };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/environment/sites/facility-test' && request.method() === 'PUT') {
      writes.push(request);
      if (options.conflict) { site = { ...site, name: 'Kollegans namn', version: 2 }; return route.fulfill({ status: 409, json: { error: 'Anläggningen har ändrats.', code: 'version_conflict' } }); }
      const { expectedVersion, ...fields } = request.postDataJSON() as EnvironmentSiteInput;
      site = { ...site, ...fields, version: expectedVersion + 1 };
      return route.fulfill({ json: site });
    }
    const result = path === '/api/platform/session' ? {
      enabled: true, authenticated: true, actor: { id: 'facility-platform-actor', name: admin.name, username: 'admin', platformAdmin: true },
      actualUser: admin, user, company, organisationId: company.id, effectiveUserId: user.id, isSupportSession: user.id !== admin.id,
      mustChangePassword: false, csrfToken: 'facility-platform-csrf', generation: 1, companies: [company],
    } : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
        : path === '/api/environment/session' ? { demo: true, actualUserId: admin.id, effectiveUserId: user.id, user, csrfToken: 'facility-environment-csrf', expiresAt: '2099-01-01T00:00:00Z' }
          : path === '/api/environment/state' ? { demo: true, mode: 'prepared-only', revision: site.version, actualUserId: admin.id, effectiveUserId: user.id,
            sites: [site], municipalities: [{ code: '0188', name: 'Norrtälje' }], classifications: [], receipts: [], storagePolicies: [],
            inventory: [], reports: [], drafts: [], corrections: [], reportHistory: [] }
            : path === '/api/terminal-demo/staff-session' ? { actualUserId: admin.id, effectiveUserId: user.id }
              : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: admin.id, effectiveUserId: user.id, sites: [], terminals: [], approvals: [], defaults: [] }
                : undefined;
    return route.fulfill({ status: result ? 200 : 503, json: result ?? { error: 'Valfri tjänst ingår inte i anläggningsprovet.' } });
  });
  await page.goto('/kontor#/facilities');
  await expect(page.getByRole('heading', { name: 'Anläggningsuppgifter', exact: true })).toBeVisible();
  return { writes, site: () => site };
}

test('anläggningen har inga påhittade öppettider och sparar lokala kontakter, flera perioder och en avvikande dag', async ({ page }) => {
  const fixture = await facilityFixture(page);
  await expect(page.getByLabel('Måndag öppetstatus')).toHaveValue('unset');
  await expect(page.getByText('Öppettider är inte angivna. Det betyder inte att anläggningen är stängd.', { exact: true })).toBeVisible();
  await page.getByLabel('Anläggningens telefon').fill('0101234567');
  await page.getByLabel('Anläggningens e-post').fill('norrtalje@example.test');
  await page.getByLabel('Måndag öppetstatus').selectOption('open');
  await page.getByLabel('Måndag öppnar 1').fill('07:00');
  await page.getByLabel('Måndag stänger 1').fill('12:00');
  await page.getByRole('button', { name: 'Lägg till period', exact: true }).click();
  await page.getByLabel('Måndag öppnar 2').fill('13:00');
  await page.getByLabel('Måndag stänger 2').fill('16:00');
  await page.getByLabel('Lördag öppetstatus').selectOption('closed');
  await page.getByRole('button', { name: 'Lägg till avvikande dag', exact: true }).click();
  await page.getByLabel('Avvikelse 1 datum').fill('2026-12-24');
  await page.getByLabel('Avvikelse 1 beskrivning').fill('Julafton');
  await page.getByRole('button', { name: 'Spara anläggning', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  const saved = fixture.writes[0].postDataJSON();
  expect(saved).toMatchObject({ expectedVersion: 1, phone: '0101234567', email: 'norrtalje@example.test', municipalityCode: '0188', openingHours: {
    week: { mon: [{ open: '07:00', close: '12:00' }, { open: '13:00', close: '16:00' }], tue: null, sat: [] },
    exceptions: [{ date: '2026-12-24', label: 'Julafton', closed: true, intervals: [] }],
  } });
  await expect(page.getByRole('button', { name: 'Spara anläggning', exact: true })).toBeDisabled();
});

test('versionskonflikt bevarar osparade öppettider tills användaren hämtar senaste anläggningen', async ({ page }) => {
  await facilityFixture(page, { conflict: true });
  await page.getByLabel('Måndag öppetstatus').selectOption('closed');
  await page.getByLabel('Anläggningsnamn').fill('Mitt osparade namn');
  await page.getByRole('button', { name: 'Spara anläggning', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Ditt utkast finns kvar');
  await expect(page.getByLabel('Måndag öppetstatus')).toHaveValue('closed');
  await expect(page.getByLabel('Anläggningsnamn')).toHaveValue('Mitt osparade namn');
  await expect(page.getByRole('button', { name: 'Spara anläggning', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Hämta senaste version', exact: true }).click();
  await expect(page.getByLabel('Anläggningsnamn')).toHaveValue('Kollegans namn');
  await expect(page.getByLabel('Måndag öppetstatus')).toHaveValue('unset');
});

test('läsbehörighet visar anläggningens öppettider utan att erbjuda ändringar', async ({ page }) => {
  const fixture = await facilityFixture(page, { readOnly: true });
  await expect(page.getByLabel('Anläggningens telefon')).toBeDisabled();
  await expect(page.getByLabel('Måndag öppetstatus')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Spara anläggning', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lägg till avvikande dag', exact: true })).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
});
