import { expect, test, type Page, type Request } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import type { AuthenticatedPlatformSession, PlatformCompany } from '../src/platform/types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

/** Exercise the actual shell/office/profile components with a server-selected
 * session. No browser storage or demo login determines platform authority. */
async function fixture(page: Page, options: {
  level?: OfficeUser['level']; platformAdmin?: boolean; multipleCompanies?: boolean;
} = {}) {
  const office = seedOffice(), template = office.users.find(user => user.id === 'admin')!;
  const level = options.level ?? 'VD';
  const user: OfficeUser = { ...template, id: 'company-user', name: `Bolagets ${level}`, level,
    permissions: level === 'Medarbetare' ? ['view'] : template.permissions };
  const actualUser: OfficeUser = options.platformAdmin
    ? { ...template, id: '__platform-admin', name: 'Plattformens administratör' } : user;
  office.users = actualUser.id === user.id ? [user] : [actualUser, user];
  const company: PlatformCompany = { id: 'header-company', name: 'Kundbolaget AB', organisationNumber: '5560000167', status: 'active' };
  const other: PlatformCompany = { id: 'header-other-company', name: 'Andra kundbolaget AB', organisationNumber: '5593593626', status: 'active' };
  const inactive: PlatformCompany = { id: 'header-inactive-company', name: 'Avstängt bolag AB', organisationNumber: '5555555555', status: 'inactive' };
  let session: AuthenticatedPlatformSession = {
    enabled: true, authenticated: true,
    actor: { id: options.platformAdmin ? 'platform-actor' : 'company-actor', name: actualUser.name,
      username: options.platformAdmin ? 'platform@example.test' : 'company@example.test', platformAdmin: options.platformAdmin === true },
    actualUser, user, company, organisationId: company.id, effectiveUserId: user.id,
    isSupportSession: options.platformAdmin === true, mustChangePassword: false,
    csrfToken: 'header-csrf', generation: 7, companies: options.multipleCompanies ? [company, other, inactive] : [company],
  };
  const profileReads: Request[] = [], switches: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/platform/profile') {
      profileReads.push(request);
      return route.fulfill({ json: { id: session.actor.id, name: session.actor.name,
        username: session.actor.username, email: 'saved-profile@example.test', version: 1 } });
    }
    if (path === '/api/platform/switch') {
      switches.push(request);
      const command = request.postDataJSON();
      if (command.organisationId !== other.id || command.effectiveUserId !== undefined)
        return route.fulfill({ status: 403, json: { error: 'Endast medlemsbolaget ingår i detta prov.' } });
      session = { ...session, company: other, organisationId: other.id, generation: 8 };
      return route.fulfill({ json: session });
    }
    if (path === '/api/company-settings/defaults') return route.fulfill({ json: { companyId: session.company!.id,
      version: 1, profile: { name: session.company!.name }, defaults: { paymentTermsDays: null } } });
    if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
    if (path === '/api/pricing/state') return route.fulfill({ json: { version: 'header-test', revision: 1,
      memoryOnly: true, asOfDate: '2026-10-20', metals: [], articles: [], customers: [] } });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: actualUser.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision: 1,
      actualUserId: actualUser.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    return route.fulfill({ status: 503, json: { error: 'Tjänsten ingår inte i detta avgränsade skalprov.' } });
  });
  await page.goto('/kontor/#/dashboard');
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await expect(page.locator('.office-sidebar')).toBeVisible();
  return { profileReads, switches, user, actor: session.actor, company, other };
}

async function expectZeroHeaderSpace(page: Page) {
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await expect(page.locator('.platform-support-strip')).toHaveCount(0);
  await expect(page.locator('.platform-shell')).toHaveCSS('--platform-header-height', '0px');
  await expect(page.locator('.platform-shell')).toHaveCSS('--platform-topbar-height', '0px');
  await expect(page.locator('.office-sticky-shell')).toHaveCSS('top', '0px');
}

for (const level of ['VD', 'Medarbetare', 'Systemadmin'] as const) {
  test(`${level} i kundbolaget har ingen plattformslist eller reserverad höjd när aktören inte är plattformsadmin`, async ({ page }) => {
    await fixture(page, { level });
    await expectZeroHeaderSpace(page);
    await expect(page.locator('.office-sidebar')).toHaveCSS('top', '0px');
    await expect(page.locator('.office-sidebar')).toHaveCSS('height', '1000px');
    const body = await page.locator('.platform-office-body').boundingBox();
    expect(body).not.toBeNull(); expect(body!.y).toBeCloseTo(0, 0);
    const shell = await page.locator('.office-sticky-shell').boundingBox();
    expect(shell).not.toBeNull(); expect(shell!.y).toBeCloseTo(0, 0);
    await expect(page.getByRole('button', { name: 'Systemadmin', exact: true })).toHaveCount(0);
  });
}

test('Min profil nås från sidomenyn och återgår till kontoret utan någon dold plattformslist', async ({ page }) => {
  const f = await fixture(page);
  const sidebar = page.locator('.office-sidebar');
  await sidebar.getByLabel('Öppna profilmeny', { exact: true }).click();
  const open = sidebar.getByRole('button', { name: 'Min profil', exact: true });
  await expect(open).toHaveAttribute('title', `Profil för ${f.actor.name}`);
  await open.click();
  await expect(page.getByRole('heading', { name: 'Min profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('saved-profile@example.test');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(f.actor.name);
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  expect(f.profileReads.length).toBeGreaterThan(0);
  expect(f.profileReads[0].headers()).toMatchObject({ 'x-platform-generation': '7', 'x-platform-csrf': 'header-csrf' });
  await page.getByRole('link', { name: 'Tillbaka till kontoret', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await expectZeroHeaderSpace(page);
  expect(f.switches).toHaveLength(0);
});

test('vanlig flerbolagsanvändare byter medlemsbolag från sidomenyn med sitt sessionsskydd', async ({ page }) => {
  const f = await fixture(page, { multipleCompanies: true });
  const sidebar = page.locator('.office-sidebar');
  await sidebar.getByLabel('Öppna profilmeny', { exact: true }).click();
  const chooser = sidebar.getByLabel('Byt bolag', { exact: true });
  await expect(chooser).toHaveValue(f.company.id);
  await expect(chooser.getByRole('option')).toHaveCount(2);
  await expect(chooser.getByRole('option', { name: 'Avstängt bolag AB', exact: true })).toHaveCount(0);
  await expect(sidebar.getByLabel('Jobba som bolag', { exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Bolagsadministration', exact: true })).toHaveCount(0);
  await chooser.selectOption(f.other.id);
  await expect.poll(() => f.switches.length).toBe(1);
  expect(f.switches[0].postDataJSON()).toEqual({ organisationId: f.other.id });
  expect(f.switches[0].headers()).toMatchObject({ 'x-platform-generation': '7', 'x-platform-csrf': 'header-csrf',
    'x-platform-organisation-id': f.company.id });
  await expect(page.locator('.office-sidebar > .office-eyebrow')).toHaveText(f.other.name);
  await expectZeroHeaderSpace(page);
});

for (const level of ['VD', 'Medarbetare'] as const) {
  test(`äkta plattformsadmin behåller list och supportremsa även när vald bolagsanvändare är ${level}`, async ({ page }) => {
    const f = await fixture(page, { platformAdmin: true, level });
    const bar = page.locator('.platform-topbar'), strip = page.locator('.platform-support-strip');
    await expect(bar).toBeVisible(); await expect(strip).toBeVisible();
    await expect(bar.getByRole('img', { name: 'ScrapPlanner', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Systemadmin', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Jobba som bolag', exact: true })).toBeVisible();
    await expect(strip).toContainText(f.actor.name); await expect(strip).toContainText(f.user.name);
    await expect.poll(async () => {
      const banner = await strip.boundingBox(), sidebar = await page.locator('.office-sidebar').boundingBox();
      return banner && sidebar ? Math.abs(sidebar.y - banner.y - banner.height) : Number.POSITIVE_INFINITY;
    }).toBeLessThan(2);
    await page.locator('.office-sidebar').getByLabel('Öppna profilmeny', { exact: true }).click();
    const profile = page.locator('.office-sidebar').getByRole('button', { name: 'Min profil', exact: true });
    await expect(profile).toHaveAttribute('title', `Profil för ${f.actor.name}`);
    await profile.click();
    await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(f.actor.name);
    await expect(bar).toBeVisible();
  });
}

test('smal vy behåller sidomenyns profilväg och återgång utan plattformslist', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await fixture(page, { level: 'Medarbetare' });
  await expectZeroHeaderSpace(page);
  const sidebar = page.locator('.office-sidebar');
  await sidebar.getByLabel('Öppna profilmeny', { exact: true }).click();
  await sidebar.getByRole('button', { name: 'Min profil', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Min profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('saved-profile@example.test');
  await expect(page.locator('.platform-topbar')).toHaveCount(0);
  await page.getByRole('link', { name: 'Tillbaka till kontoret', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
  await expectZeroHeaderSpace(page);
});
