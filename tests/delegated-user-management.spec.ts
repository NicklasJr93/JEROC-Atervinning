import { expect, test, type Page } from '@playwright/test';
import { permissionNames, type OfficeUser, type Permission } from '../src/office/model';
// @ts-expect-error Server ESM factories are intentionally tested without generated declarations.
import { initialApplicationState } from '../server/application.mjs';
// @ts-expect-error Real pricing policy handles isolated mocked writes.
import { createPricingStore } from '../server/pricing.mjs';
// @ts-expect-error Server ESM factories are intentionally tested without generated declarations.
import { ensurePersonnel, personnelCommand, personnelProjection } from '../server/personnel.mjs';
// @ts-expect-error Real facility synchronization keeps the fixture's person/account scope consistent.
import { syncPersonnelFacilityAccess } from '../server/facility-access.mjs';
import type { PersonnelCommand } from '../src/office/personnel/types';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
test.setTimeout(60_000);

const sites = [{ id: 'norrtalje', name: 'Norrtälje', active: true }, { id: 'rimbo', name: 'Rimbo', active: true }];
const normalId = 'delegation-normal';
const delegatePermissions: Permission[] = ['view', 'prepare', 'customers', 'personnelRead', 'personnelWrite', 'attest', 'users'];
const user = (id: string, name: string, level: OfficeUser['level'], permissions: Permission[],
  extra: Partial<OfficeUser> = {}): OfficeUser => ({ id, name, level, permissions, maxAttest: 100,
    ownAttest: false, active: true, siteIds: ['norrtalje'], ...extra });

/** No real account or tenant is contacted. Browser commands use the actual
 * account policy, while the catalog intentionally includes protected targets
 * to verify that UI affordances remain safe even with a broad projection. */
async function fixture(page: Page, options: { owner?: 'VD' | 'Systemadmin'; boundedSupport?: boolean } = {}) {
  let state = initialApplicationState();
  const admin = user('admin', 'Testets systemadministratör', 'Systemadmin', Object.keys(permissionNames) as Permission[],
    { siteIds: options.boundedSupport ? ['norrtalje'] : undefined, maxAttest: options.boundedSupport ? 250 : 1_000_000 });
  const vd = user('delegation-vd', 'Testets VD', 'VD', ['view', 'personnelRead', 'personnelWrite'],
    { siteIds: undefined, maxAttest: 100_000 });
  const delegate = user('delegation-manager', 'Delegerad kontorist', 'Medarbetare', delegatePermissions,
    { siteIds: options.boundedSupport ? ['norrtalje', 'rimbo'] : ['norrtalje'], maxAttest: 1000 });
  state.pricing.users = [admin, vd, delegate,
    user(normalId, 'Vanlig medarbetare', 'Medarbetare', ['view']),
    user('delegation-peer', 'Annan användaradministratör', 'Medarbetare', ['view', 'users']),
    user('delegation-strong', 'Starkare medarbetare', 'Medarbetare', ['view', 'personnelRead', 'salaryRead']),
    user('delegation-other-site', 'Medarbetare vid annan anläggning', 'Medarbetare', ['view'], { siteIds: ['rimbo'] }),
    user('delegation-high-attest', 'Medarbetare med högre attest', 'Medarbetare', ['view'], { maxAttest: 1001 }),
    user('delegation-own-attest', 'Medarbetare med egen attest', 'Medarbetare', ['view'], { ownAttest: true })];
  state.office.users = structuredClone(state.pricing.users);
  ensurePersonnel(state, sites);
  state.personnel.people.push({ id: 'delegation-unlinked-person', name: 'Person utan konto', kind: 'employee', active: true,
    role: '', team: '', siteIds: ['norrtalje'], phone: '', email: '', address: '', canDrive: false, revision: 1 });
  const actorId = options.owner === 'VD' ? vd.id : options.owner === 'Systemadmin' || options.boundedSupport ? admin.id : delegate.id;
  const effectiveId = options.owner ? actorId : delegate.id;
  const principal = () => ({ actor: state.pricing.users.find((value: OfficeUser) => value.id === actorId)!,
    user: state.pricing.users.find((value: OfficeUser) => value.id === effectiveId)! });
  const pricingState = () => createPricingStore({ initialState: state.pricing }).read(principal());
  const writes: { users: OfficeUser[]; allSiteUserIds?: string[]; userManagementDelegationVersion?: number }[] = [], personnelWrites: PersonnelCommand[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      if (path === '/api/pricing/users') {
        expect(request.headers()['x-platform-csrf']).toBe('delegation-browser-csrf');
        expect(request.headers()['x-platform-generation']).toBe('19');
        const input = request.postDataJSON(); writes.push(input);
        const pricing = createPricingStore({ initialState: state.pricing });
        pricing.saveUsers(input, principal()); state.pricing = pricing.exportState();
        state.office.users = structuredClone(state.pricing.users); syncPersonnelFacilityAccess(state, { siteCatalog: sites });
        return route.fulfill({ json: pricingState() });
      }
      if (path === '/api/application/personnel') {
        if (request.method() === 'POST') {
          const command = request.postDataJSON() as PersonnelCommand; personnelWrites.push(command);
          const next = structuredClone(state); personnelCommand(next, principal(), command, [], sites); state = next;
        }
        return route.fulfill({ json: personnelProjection(state, principal(), false, sites) });
      }
      const p = principal();
      const body = path === '/api/platform/session' ? { enabled: true, authenticated: true,
        actor: { id: `platform-${actorId}`, name: p.actor.name, username: 'fixture-only', platformAdmin: p.actor.level === 'Systemadmin' },
        actualUser: p.actor, user: p.user, company: { id: 'delegation-fixture-company', name: 'Isolerat delegeringstest',
          organisationNumber: '5560000167', status: 'active' }, organisationId: 'delegation-fixture-company',
        effectiveUserId: effectiveId, isSupportSession: actorId !== effectiveId, mustChangePassword: false,
        csrfToken: 'delegation-browser-csrf', generation: 19, companies: [] }
        : path === '/api/application/office' ? { data: state.office, revision: state.pricing.revision }
        : path === '/api/application/revision' ? { revision: state.pricing.revision }
        : path === '/api/pricing/state' ? pricingState()
        : path === '/api/environment/session' ? { demo: true, actualUserId: actorId, effectiveUserId: effectiveId, user: p.user,
          csrfToken: 'delegation-environment-fixture', expiresAt: '2099-01-01T00:00:00Z' }
        : path === '/api/terminal-demo/staff-session' ? { actualUserId: actorId, effectiveUserId: effectiveId }
        : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actorId, effectiveUserId: effectiveId,
          sites, terminals: [], approvals: [], defaults: [] }
        : path === '/api/mail/state' ? { organisationId: 'delegation-fixture-company', configuration: { ready: false, missing: [], issues: [] },
          connections: [], mailboxes: [], totalUnread: 0, capabilities: { canRead: false, canManage: false }, mode: 'live' }
        : undefined;
      return route.fulfill({ status: body ? 200 : 503, json: body ?? { error: 'API-vägen ingår inte i denna isolerade testfixtur.' } });
    } catch (error) {
      return route.fulfill({ status: (error as { status?: number }).status ?? 503, json: { error: (error as Error).message } });
    }
  });
  return { writes, personnelWrites, errors, state: () => state,
    promoteTarget: () => { state.pricing.users.find((value: OfficeUser) => value.id === normalId).level = 'VD';
      state.office.users = structuredClone(state.pricing.users); state.pricing.revision++; } };
}
async function openAccount(page: Page, id = normalId) {
  await page.goto(`/kontor#/personnel/accounts?user=${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { name: 'Konton & behörigheter', exact: true })).toBeVisible();
  await expect(page.locator('.office-main')).toHaveAttribute('aria-busy', 'false');
}

for (const owner of ['VD', 'Systemadmin'] as const) test(`${owner} väljer uttryckligen Hantera användare för en medarbetare och sparar den verkliga rättigheten`, async ({ page }) => {
  const f = await fixture(page, { owner }); await openAccount(page);
  const delegatedRight = page.getByRole('checkbox', { name: 'Hantera användare', exact: true });
  await expect(delegatedRight).not.toBeChecked(); await expect(delegatedRight).toBeEnabled();
  await delegatedRight.check();
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kontot och den gemensamma anläggningsåtkomsten har sparats.' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({ userManagementDelegationVersion: 1 });
  expect(f.state().pricing.users.find((value: OfficeUser) => value.id === normalId).permissions).toContain('users');
  await expect(delegatedRight).toBeChecked(); expect(f.errors).toEqual([]);
});

test('delegerad kontorist hanterar en vanlig medarbetare inom båda principalernas rättighets-, anläggnings- och attestgränser', async ({ page }) => {
  const f = await fixture(page, { boundedSupport: true }); await openAccount(page);
  const level = page.getByRole('combobox', { name: 'Kontonivå', exact: true });
  await expect(level).toHaveValue('Medarbetare'); await expect(level).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Hantera användare', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Läsa löneuppgifter', exact: true })).toBeDisabled();
  const prepare = page.getByRole('checkbox', { name: 'Granska och komplettera', exact: true });
  await expect(prepare).toBeEnabled(); await prepare.check();
  const access = page.getByRole('group', { name: 'Anläggningsåtkomst', exact: true });
  await expect(access.getByRole('checkbox', { name: 'Norrtälje', exact: true })).toBeEnabled();
  await expect(access.getByRole('checkbox', { name: 'Rimbo', exact: true })).toBeDisabled();
  await expect(access.getByRole('checkbox', { name: 'Alla anläggningar, även nya', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Får attestera egna förberedda kort', exact: true })).toBeDisabled();
  const amount = page.getByLabel('Maxbelopp för attest (kr)', { exact: true });
  await expect(amount).toHaveAttribute('max', '250'); await amount.fill('250');
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kontot och den gemensamma anläggningsåtkomsten har sparats.' })).toBeVisible();
  expect(f.writes).toHaveLength(1);
  expect(f.state().pricing.users.find((value: OfficeUser) => value.id === normalId)).toMatchObject({
    level: 'Medarbetare', permissions: ['view', 'prepare'], siteIds: ['norrtalje'], maxAttest: 250, ownAttest: false });
  expect(f.errors).toEqual([]);
});

test('delegerad kontorist får inga skrivkontroller för eget konto, andra delegater, ledning eller konton över den egna nivån', async ({ page }) => {
  const f = await fixture(page);
  for (const id of ['delegation-manager', 'delegation-peer', 'delegation-vd', 'admin', 'delegation-strong',
    'delegation-other-site', 'delegation-high-attest', 'delegation-own-attest']) {
    await openAccount(page, id);
    await expect(page.locator('.office-main')).toContainText(/Du kan inte|Endast Systemadmin|Delegerad användarhantering|utanför|kan inte visas/);
    await expect(page.getByRole('button', { name: 'Spara behörigheter', exact: true }).and(page.locator(':enabled'))).toHaveCount(0);
    const name = page.getByLabel('Namn', { exact: true });
    if (await name.count()) await expect(name).toBeDisabled();
  }
  expect(f.writes).toHaveLength(0); expect(f.errors).toEqual([]);
});

test('ett kontos nya privilegier stänger redan öppnad delegerad redigering innan ett gammalt formulär kan sparas', async ({ page }) => {
  const f = await fixture(page); await openAccount(page);
  const save = page.getByRole('button', { name: 'Spara behörigheter', exact: true });
  await expect(save).toBeEnabled();
  await page.getByLabel('Namn', { exact: true }).fill('Osparat namn');
  f.promoteTarget();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(save).toBeDisabled();
  await expect(page.locator('.office-main')).toContainText(/Delegerad användarhantering|kan inte visas/);
  expect(f.writes).toHaveLength(0); expect(f.errors).toEqual([]);
});

test('personkortets befintliga kontoval visar endast hanterbara vanliga medarbetarkonton för en delegat', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('/kontor#/personnel/delegation-unlinked-person/overview');
  await expect(page.getByRole('heading', { name: 'Person utan konto', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redigera', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Redigera person', exact: true });
  const accounts = dialog.getByLabel('Befintligt användarkonto', { exact: true });
  await expect(accounts.getByRole('option', { name: 'Vanlig medarbetare', exact: true })).toHaveCount(1);
  for (const name of ['Delegerad kontorist', 'Annan användaradministratör', 'Testets VD', 'Testets systemadministratör',
    'Starkare medarbetare', 'Medarbetare vid annan anläggning', 'Medarbetare med högre attest', 'Medarbetare med egen attest'])
    await expect(accounts.getByRole('option', { name, exact: true })).toHaveCount(0);
  expect(f.writes).toHaveLength(0); expect(f.personnelWrites).toHaveLength(0); expect(f.errors).toEqual([]);
});
