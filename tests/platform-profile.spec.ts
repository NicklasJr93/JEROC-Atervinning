import { expect, test, type Page, type Request } from '@playwright/test';
import { seedOffice } from '../src/office/model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
const actorUser = seedOffice().users.find(user => user.id === 'admin')!;
const savedEmail = 'nicklas@endorgroup.se';
const confirmedPassword = 'Private-Profile-Current-2026!';

async function fixture(page: Page, options: { support?: boolean; conflict?: boolean; deferredRead?: boolean; startAtAdmin?: boolean; vd?: boolean } = {}) {
  const company = { id: 'profile-company', name: 'Kundbolaget AB', organisationNumber: '5593593626', status: 'active' };
  const actor = { id: options.vd ? 'owner-account' : 'platform-admin', name: options.vd ? 'Bolagets VD' : 'Systemadmin',
    username: options.vd ? 'vd@example.test' : 'admin', platformAdmin: !options.vd };
  let session = { enabled: true, authenticated: true, actor, actualUser: { ...actorUser, id: options.vd ? actor.id : '__platform-admin', name: actor.name },
    user: options.support ? { ...actorUser, id: 'impersonated-vd', name: 'Vald bolagsanvändare' } : { ...actorUser, id: options.vd ? actor.id : '__platform-admin', name: actor.name },
    isSupportSession: options.support === true, mustChangePassword: false, csrfToken: 'profile-csrf', generation: 11,
    ...(options.support || options.vd ? { company, organisationId: company.id } : {}), companies: options.support || options.vd ? [company] : [] };
  let value = { id: actor.id, name: actor.name, username: actor.username, email: savedEmail, version: 4 };
  const writes: Request[] = [], switches: Request[] = [];
  const initialGeneration = String(session.generation);
  const readGenerations: string[] = [];
  let reads = 0, deferredReads = 0, settledDeferredReads = 0, releaseRead = () => {};
  const oldGenerationReads = options.deferredRead ? new Promise<void>(resolve => { releaseRead = resolve; }) : Promise.resolve();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/platform/profile') {
      if (request.method() === 'GET') {
        reads++;
        const generation = request.headers()['x-platform-generation'];
        readGenerations.push(generation);
        const snapshot = structuredClone(value);
        const deferred = options.deferredRead && generation === initialGeneration;
        if (deferred) { deferredReads++; await oldGenerationReads; }
        await route.fulfill({ json: snapshot }).catch(() => {});
        if (deferred) settledDeferredReads++;
        return;
      }
      writes.push(request);
      if (options.conflict) {
        value = { ...value, email: 'already-changed@example.test', version: 5 };
        return route.fulfill({ status: 409, json: { error: 'Profilen har ändrats i en annan session. Hämta den senaste profilen.', code: 'platform_profile_conflict' } });
      }
      const command = request.postDataJSON();
      value = { ...value, email: command.email.trim().toLowerCase(), version: value.version + 1 };
      return route.fulfill({ json: value });
    }
    if (path === '/api/platform/switch') { switches.push(request); return route.fulfill({ status: 403, json: { error: 'Ingen växling ingår i profilprovet.' } }); }
    if (path === '/api/platform/companies') return route.fulfill({ json: { companies: session.companies } });
    if (path === '/api/platform/communications') return route.fulfill({ json: { email: { configured: false, provider: 'resend', from: 'ScrapPlanner <noreply@scrapplanner.com>' }, sms: { configured: false } } });
    if (path === '/api/company-settings/defaults') return route.fulfill({ json: { companyId: company.id, version: 0, profile: { name: company.name }, defaults: { paymentTermsDays: null } } });
    return route.fulfill({ status: 503, json: { error: 'Denna tjänst ingår inte i profilprovet.' } });
  });
  await page.goto(`/kontor#/${options.startAtAdmin ? 'platform-admin' : 'profile'}`);
  return { writes, switches, reads: () => reads, readGenerations, deferredReads: () => deferredReads,
    settledDeferredReads: () => settledDeferredReads, releaseRead, current: () => value, changeGeneration: () => {
    session = { ...session, generation: session.generation + 1 };
    value = { ...value, email: 'latest-profile@example.test', version: value.version + 1 };
  } };
}

test('Min profil öppnas från systemadmin och visar sparad e-post utan att spara eller byta bolag', async ({ page }) => {
  const f = await fixture(page, { startAtAdmin: true });
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Min profil', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Min profil', exact: true })).toBeVisible();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(savedEmail);
  await expect(page.getByLabel('Namn', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Användarnamn', { exact: true })).toHaveValue('admin');
  await expect(page.getByRole('button', { name: 'Spara e-postadress', exact: true })).toBeDisabled();
  expect(f.writes).toHaveLength(0); expect(f.switches).toHaveLength(0);
});

for (const vd of [false, true]) test(`${vd ? 'VD' : 'systemadmin'} sparar sin egen e-post med lösenordsbekräftelse och aktuellt sessionsskydd`, async ({ page }) => {
  const f = await fixture(page, { vd });
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(savedEmail);
  await page.getByLabel('E-postadress', { exact: true }).fill('  New-Recovery@Example.test  ');
  await page.getByRole('button', { name: 'Spara e-postadress', exact: true }).click();
  expect(f.writes).toHaveLength(0);
  await page.getByLabel('Nuvarande lösenord', { exact: true }).fill(confirmedPassword);
  await page.getByRole('button', { name: 'Spara e-postadress', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('E-postadressen är sparad');
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('new-recovery@example.test');
  await expect(page.getByLabel('Nuvarande lösenord', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Användarnamn', { exact: true })).toHaveValue(vd ? 'vd@example.test' : 'admin');
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].postDataJSON()).toEqual({ expectedVersion: 4, email: 'New-Recovery@Example.test', currentPassword: confirmedPassword });
  expect(f.writes[0].headers()).toMatchObject({ 'x-platform-csrf': 'profile-csrf', 'x-platform-generation': '11' });
  expect(f.switches).toHaveLength(0);
});

test('osparade profiländringar och lösenord försvinner när formuläret lämnas', async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(savedEmail);
  await page.getByLabel('E-postadress', { exact: true }).fill('draft@example.test');
  await page.getByLabel('Nuvarande lösenord', { exact: true }).fill(confirmedPassword);
  await page.getByRole('link', { name: 'Tillbaka till systemadmin', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Min profil', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(savedEmail);
  await expect(page.getByLabel('Nuvarande lösenord', { exact: true })).toHaveValue('');
  expect(f.writes).toHaveLength(0);
});

test('versionskonflikt behåller adressutkastet och kräver aktiv omläsning', async ({ page }) => {
  const f = await fixture(page, { conflict: true });
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(savedEmail);
  await page.getByLabel('E-postadress', { exact: true }).fill('my-draft@example.test');
  await page.getByLabel('Nuvarande lösenord', { exact: true }).fill(confirmedPassword);
  await page.getByRole('button', { name: 'Spara e-postadress', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Profilen har ändrats');
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('my-draft@example.test');
  await expect(page.getByRole('button', { name: 'Spara e-postadress', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Hämta senaste profilen', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('already-changed@example.test');
  await expect(page.getByLabel('Nuvarande lösenord', { exact: true })).toHaveValue('');
  expect(f.writes).toHaveLength(1);
});

test('Min profil avser inloggad systemadmin även i en supportsession som annan användare', async ({ page }) => {
  const f = await fixture(page, { support: true });
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Systemadmin');
  await expect(page.getByLabel('Användarnamn', { exact: true })).toHaveValue('admin');
  await expect(page.getByText('Du ändrar ditt eget konto, Systemadmin, även när du arbetar som en användare hos ett bolag.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tillbaka till kontoret', exact: true })).toBeVisible();
  expect(f.switches).toHaveLength(0); expect(f.writes).toHaveLength(0);
});

test('ett sent profilsvar från en gammal session kan inte ersätta nästa sessions profil', async ({ page }) => {
  const f = await fixture(page, { deferredRead: true });
  await expect(page.getByText('Hämtar din profil…', { exact: true })).toBeVisible();
  await expect.poll(f.deferredReads).toBeGreaterThanOrEqual(1);
  f.changeGeneration();
  await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session')));
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('latest-profile@example.test');
  expect(f.readGenerations).toContain('12');
  f.releaseRead();
  await expect.poll(() => f.deferredReads() - f.settledDeferredReads()).toBe(0);
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('latest-profile@example.test');
  expect(f.writes).toHaveLength(0);
});
