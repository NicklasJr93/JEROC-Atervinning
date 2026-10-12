import { test, expect, type Page } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { testOrganisationNumber } from './helpers/customer-identity';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
const admin = seedOffice().users.find(user => user.id === 'admin')!;
const auth = {
  enabled: true, authenticated: true, actor: { id: 'global-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
  actualUser: admin, user: admin, isSupportSession: false, mustChangePassword: false, csrfToken: 'test-csrf', generation: 1, companies: [],
};
async function json(page: Page, path: string, body: unknown) {
  await page.route(`**/api/platform/${path}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
}

test('kontoret visar riktig inloggning och hämtar inga verksamhetsuppgifter före autentisering', async ({ page }) => {
  const businessRequests: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path !== '/api/platform/session') businessRequests.push(path);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: true, authenticated: false }) });
  });
  await page.goto('/kontor');
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await expect(page.getByLabel('Användarnamn eller e-post', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Kajsa Nilsson|Lars Andersson|Systemadmin/ })).toHaveCount(0);
  expect(businessRequests).toEqual([]);
});

test('tillfälligt lösenord måste bytas och platformmutation skickar sessionens CSRF och generation', async ({ page }) => {
  await json(page, 'session', { ...auth, mustChangePassword: true });
  await json(page, 'companies', { companies: [] });
  let change: { body: unknown; csrf?: string; generation?: string } | undefined;
  await page.route('**/api/platform/change-password', route => {
    change = { body: route.request().postDataJSON(), csrf: route.request().headers()['x-platform-csrf'], generation: route.request().headers()['x-platform-generation'] };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...auth, csrfToken: 'rotated-csrf', generation: 2 }) });
  });
  await page.goto('/kontor');
  await expect(page.getByRole('heading', { name: 'Välj ditt eget lösenord', exact: true })).toBeVisible();
  await page.getByLabel('Tillfälligt lösenord', { exact: true }).fill('TemporaryTestPassword!');
  await page.getByLabel('Nytt lösenord', { exact: true }).fill('MyNewTestPassword123!');
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill('DifferentPassword123!');
  await page.getByRole('button', { name: 'Spara lösenord och fortsätt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('stämmer inte överens');
  expect(change).toBeUndefined();
  await page.getByLabel('Bekräfta nytt lösenord', { exact: true }).fill('MyNewTestPassword123!');
  await page.getByRole('button', { name: 'Spara lösenord och fortsätt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  expect(change).toEqual({ body: { currentPassword: 'TemporaryTestPassword!', newPassword: 'MyNewTestPassword123!' }, csrf: 'test-csrf', generation: '1' });
});

test('systemadmin skapar bolag och VD-konto, visar engångslösenord och kan välja bolagets användare', async ({ page }) => {
  const number = testOrganisationNumber();
  const company = { id: 'company-test', name: 'Teståterbruk AB', organisationNumber: number, status: 'active', ownerPasswordChangePending: true };
  const vd = { ...admin, id: 'test-vd', name: 'VD Test', level: 'VD', active: true };
  let companies: typeof company[] = [], created: Record<string, unknown> | undefined;
  await json(page, 'session', auth);
  await page.route('**/api/platform/companies', route => {
    if (route.request().method() === 'POST') {
      created = route.request().postDataJSON(); companies = [company];
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ company, user: vd, credentialsRevealed: true,
        temporaryCredentials: { username: 'vd@example.test', password: 'OneTimeTestPassword123!', mustChangePassword: true } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ companies }) });
  });
  await json(page, 'companies/company-test/users', { users: [vd] });
  await page.goto('/kontor#/platform-admin');
  await page.getByRole('button', { name: 'Skapa bolag', exact: true }).click();
  await page.getByLabel('Bolagsnamn', { exact: true }).fill(company.name);
  await page.getByLabel('Bolagets organisationsnummer', { exact: true }).fill(`${number.slice(0, 6)}-${number.slice(6)}`);
  await page.getByLabel('VD:s namn', { exact: true }).fill('VD Test');
  await page.getByLabel('VD:s e-post', { exact: true }).fill('vd@example.test');
  await page.getByRole('button', { name: 'Skapa bolag och VD-konto', exact: true }).click();
  await expect(page.getByLabel('VD-kontots användarnamn', { exact: true })).toHaveValue('vd@example.test');
  await expect(page.getByLabel('VD-kontots tillfälliga lösenord', { exact: true })).toHaveAttribute('type', 'password');
  expect(created).toMatchObject({ name: company.name, organisationNumber: number, vdName: 'VD Test', vdEmail: 'vd@example.test' });
  expect(created?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('row').filter({ hasText: company.name })).toContainText('Aktivt');
  await page.getByText('Bolagets länkar', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Mobilappen', exact: true })).toHaveAttribute('href', /\/mobil\?company=company-test$/);
  await page.getByRole('button', { name: 'Stäng tillfälliga inloggningsuppgifter', exact: true }).click();
  await expect(page.getByLabel('VD-kontots tillfälliga lösenord', { exact: true })).toHaveCount(0);
  await page.getByLabel('Jobba som bolag', { exact: true }).selectOption(company.id);
  await expect(page.getByLabel('Jobba som användare', { exact: true })).toContainText('VD Test · VD');
});

test('ett borttappat första VD-lösenord kan återutfärdas aktivt utan att göra om bolaget', async ({ page }) => {
  const company = { id: 'pending-company', name: 'Pending AB', organisationNumber: testOrganisationNumber(), status: 'active', ownerPasswordChangePending: true };
  await json(page, 'session', auth);
  await json(page, 'companies', { companies: [company] });
  let requestId: string | undefined;
  await page.route('**/api/platform/companies/pending-company/reset-initial-password', route => {
    requestId = route.request().postDataJSON().requestId;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ company, user: { id: 'pending-vd', name: 'VD Pending', level: 'VD' }, credentialsRevealed: true,
      temporaryCredentials: { username: 'pending@example.test', password: 'ReissuedInitialPassword123!', mustChangePassword: true } }) });
  });
  await page.goto('/kontor#/platform-admin');
  await page.getByRole('button', { name: 'Nytt tillfälligt lösenord', exact: true }).click();
  await expect(page.getByLabel('VD-kontots tillfälliga lösenord', { exact: true })).toHaveValue('ReissuedInitialPassword123!');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Nytt tillfälligt lösenord', exact: true })).toBeVisible();
});

test('bolagslänk byter auktoriserad kontext en gång före kontoret och rensar company-parametern', async ({ page }) => {
  await json(page, 'session', { ...auth, organisationId: 'old-company' });
  await json(page, 'companies', { companies: [] });
  let switches = 0;
  await page.route('**/api/platform/switch', route => {
    switches += 1;
    expect(route.request().postDataJSON()).toEqual({ organisationId: 'requested-company' });
    expect(route.request().headers()['x-platform-generation']).toBe('1');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...auth, organisationId: 'requested-company', generation: 2, csrfToken: 'new-csrf' }) });
  });
  await page.goto('/kontor?company=requested-company#/platform-admin');
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  expect(switches).toBe(1);
  expect(new URL(page.url()).searchParams.has('company')).toBe(false);
});

test('fetchskydd bevarar gammal generation, läcker inga token till andra adresser och öppnar login vid utgången session', async ({ page }) => {
  let active = true;
  await page.route('**/api/platform/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(active ? auth : { enabled: true, authenticated: false }) }));
  await json(page, 'companies', { companies: [] });
  const received = new Map<string, Record<string, string>>();
  for (const address of ['**/api/guard-check', '**/outside-api', 'https://example.invalid/guard']) await page.route(address, route => {
    received.set(new URL(route.request().url()).pathname + new URL(route.request().url()).hostname, route.request().headers());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  await page.goto('/kontor#/platform-admin');
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await fetch('/api/guard-check', { method: 'POST', headers: { 'X-Platform-Generation': 'old-generation' } });
    await fetch('/outside-api', { method: 'POST' });
    await fetch('https://example.invalid/guard', { method: 'POST' });
  });
  expect(received.get('/api/guard-check127.0.0.1')).toMatchObject({ 'x-platform-generation': 'old-generation', 'x-platform-csrf': 'test-csrf' });
  expect(received.get('/outside-api127.0.0.1')?.['x-platform-csrf']).toBeUndefined();
  expect(received.get('/guardexample.invalid')?.['x-platform-csrf']).toBeUndefined();
  expect(received.get('/guardexample.invalid')?.['x-platform-generation']).toBeUndefined();
  active = false;
  await page.route('**/api/expired-test', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => fetch('/api/expired-test'));
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
});
