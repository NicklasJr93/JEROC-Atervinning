import { expect, test, type Page } from '@playwright/test';

const portals = [
  { path: '/chauffor', realm: 'driver', label: 'Demochaufför från servern' },
  { path: '/akeri', realm: 'carrier', label: 'Demoåkeri från servern' },
  { path: '/kund', realm: 'customer', label: 'Demokund från servern' },
] as const;
type Portal = typeof portals[number];
type ConfigMode = 'enabled' | 'disabled' | 'unavailable' | 'wrong-company';
type LoginPayload = { username: string; password: string };
type DemoFetch = { credentials: RequestCredentials | undefined; cache: RequestCache | undefined };
const companyId = 'selected-portal-demo';
const companyName = 'Valt demobolag';
const loginError = 'Lokalt testsvar: kontrollera inloggningen.';

/** All APIs are local fixtures; unexpected APIs and cross-origin traffic cannot reach a server. */
async function setup(page: Page, portal: Portal, mode: ConfigMode = 'enabled') {
  const api = `/api/${portal.realm}`;
  const accounts = [
    { id: `${portal.realm}-one`, label: portal.label, username: `${portal.realm}-demo-one`, password: 'Local-Demo-One!' },
    { id: `${portal.realm}-two`, label: `${portal.label} · alternativ`, username: `${portal.realm}-demo-two`, password: 'Local-Demo-Two!' },
  ];
  const logins: LoginPayload[] = [], writes: string[] = [], unexpectedApis: string[] = [], externalRequests: string[] = [], errors: string[] = [];
  const portalRequests: { path: string; company: string | undefined }[] = [];
  let contexts = 0;
  let releaseLogin!: () => void;
  const pendingLogin = new Promise<void>(resolve => { releaseLogin = resolve; });
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:5173').origin;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const host = window as typeof window & { portalDemoFetches: { credentials: RequestCredentials | undefined; cache: RequestCache | undefined }[] };
    host.portalDemoFetches = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (/^\/api\/(driver|carrier|customer)\/demo-config$/.test(url.pathname)) {
        host.portalDemoFetches.push({
          credentials: init?.credentials ?? (input instanceof Request ? input.credentials : undefined),
          cache: init?.cache ?? (input instanceof Request ? input.cache : undefined),
        });
      }
      return originalFetch(input, init);
    };
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (url.origin !== origin) { externalRequests.push(url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD'].includes(method)) writes.push(path);
    if (path === '/api/platform/tenant-context' && method === 'GET') {
      contexts++;
      return route.fulfill({ json: { companyId, companyName } });
    }
    if (path.startsWith(`${api}/`)) portalRequests.push({ path, company: request.headers()['x-client-company'] });
    if (path === `${api}/session` && method === 'GET') return route.fulfill({ status: 401, json: { error: 'Logga in' } });
    if (path === `${api}/demo-config` && method === 'GET') {
      if (mode === 'unavailable') return route.fulfill({ status: 503, json: { error: 'Demokonfigurationen är tillfälligt otillgänglig.' } });
      return route.fulfill({ json: { enabled: mode !== 'disabled', accounts,
        companyId: mode === 'wrong-company' ? 'another-demo-company' : companyId, companyName } });
    }
    if (path === `${api}/login` && method === 'POST') {
      logins.push(request.postDataJSON() as LoginPayload);
      await pendingLogin;
      return route.fulfill({ status: 401, json: { error: loginError } });
    }
    unexpectedApis.push(`${method} ${path}`);
    return route.fulfill({ status: 503, json: { error: 'Detta API ingår inte i den lokala testfixturen.' } });
  });
  const configResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${api}/demo-config`);
  await page.goto(`${portal.path}?company=${companyId}`);
  await expect(page.getByLabel('Inloggningsnamn', { exact: true })).toBeVisible();
  await (await configResponse).finished();
  // Let fetch continuations and React's render finish before checking an absent section.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return { api, accounts, logins, writes, portalRequests, unexpectedApis, externalRequests, errors, releaseLogin, contexts: () => contexts };
}

async function expectFixtureIsolation(page: Page, fixture: Awaited<ReturnType<typeof setup>>) {
  expect(fixture.contexts()).toBe(1);
  expect(fixture.portalRequests.some(request => request.path.endsWith('/demo-config'))).toBe(true);
  expect(fixture.portalRequests.every(request => request.company === companyId)).toBe(true);
  expect(fixture.unexpectedApis).toEqual([]);
  expect(fixture.externalRequests).toEqual([]);
  expect(fixture.errors).toEqual([]);
  const fetches = await page.evaluate(() => (window as typeof window & { portalDemoFetches: DemoFetch[] }).portalDemoFetches);
  expect(fetches.length).toBeGreaterThan(0);
  expect(fetches.every(request => request.credentials === 'same-origin' && request.cache === 'no-store')).toBe(true);
}

for (const portal of portals) {
  test(`${portal.path} prefills server demo accounts without logging in and disables shortcuts during explicit login`, async ({ page }) => {
    const fixture = await setup(page, portal);
    try {
      const username = page.getByLabel('Inloggningsnamn', { exact: true }), password = page.getByLabel('Lösenord', { exact: true });
      const demo = page.getByRole('region', { name: 'Demoinloggning', exact: true });
      await expect(demo).toBeVisible();
      await expect(demo.getByText('Prova demon', { exact: true })).toBeVisible();
      await expect(username).toHaveValue('');
      await expect(password).toHaveValue('');
      await expect(demo.getByRole('button')).toHaveCount(fixture.accounts.length);
      expect(fixture.writes).toEqual([]);
      for (const account of fixture.accounts) {
        const shortcut = demo.getByRole('button', { name: account.label, exact: true });
        await expect(shortcut).toHaveAttribute('type', 'button');
        await shortcut.click();
        await expect(username).toHaveValue(account.username);
        await expect(password).toHaveValue(account.password);
        expect(fixture.logins).toEqual([]);
        expect(fixture.writes).toEqual([]);
      }
      const screenshot = test.info().outputPath(`${portal.realm}-demo-login.png`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: screenshot, fullPage: true });
      await test.info().attach(`${portal.realm} demo login before submission`, { path: screenshot, contentType: 'image/png' });
      await page.getByRole('button', { name: 'Logga in', exact: true }).click();
      await expect.poll(() => fixture.logins.length).toBe(1);
      const account = fixture.accounts[1];
      expect(fixture.logins).toEqual([{ username: account.username, password: account.password }]);
      await expect(page.getByRole('button', { name: 'Loggar in…', exact: true })).toBeDisabled();
      await expect(username).toBeDisabled();
      await expect(password).toBeDisabled();
      for (const account of fixture.accounts) await expect(demo.getByRole('button', { name: account.label, exact: true })).toBeDisabled();
      expect(fixture.writes).toEqual([`${fixture.api}/login`]);
      fixture.releaseLogin();
      await expect(page.getByRole('alert')).toHaveText(loginError);
      for (const account of fixture.accounts) await expect(demo.getByRole('button', { name: account.label, exact: true })).toBeEnabled();
      await expectFixtureIsolation(page, fixture);
    } finally { fixture.releaseLogin(); }
  });

  for (const mode of ['disabled', 'unavailable'] as const) {
    test(`${portal.path} hides ${mode} demo config and keeps manual login usable`, async ({ page }) => {
      const fixture = await setup(page, portal, mode);
      try {
        await expect(page.getByRole('region', { name: 'Demoinloggning', exact: true })).toHaveCount(0);
        const username = page.getByLabel('Inloggningsnamn', { exact: true }), password = page.getByLabel('Lösenord', { exact: true });
        await expect(username).toHaveValue('');
        await expect(password).toHaveValue('');
        await expect(page.getByRole('alert')).toHaveCount(0);
        expect(fixture.writes).toEqual([]);
        await username.fill('manual-portal-user');
        await password.fill('Local-Manual-Password!');
        await page.getByRole('button', { name: 'Logga in', exact: true }).click();
        await expect.poll(() => fixture.logins.length).toBe(1);
        expect(fixture.logins).toEqual([{ username: 'manual-portal-user', password: 'Local-Manual-Password!' }]);
        expect(fixture.writes).toEqual([`${fixture.api}/login`]);
        fixture.releaseLogin();
        await expect(page.getByRole('alert')).toHaveText(loginError);
        await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeEnabled();
        await expectFixtureIsolation(page, fixture);
      } finally { fixture.releaseLogin(); }
    });
  }
}

test('demo credentials for another company never appear in the selected portal login', async ({ page }) => {
  const fixture = await setup(page, portals[0], 'wrong-company');
  try {
    await expect(page.getByRole('region', { name: 'Demoinloggning', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Inloggningsnamn', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Lösenord', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Logga in', exact: true })).toBeEnabled();
    expect(fixture.logins).toEqual([]);
    expect(fixture.writes).toEqual([]);
    await expectFixtureIsolation(page, fixture);
  } finally { fixture.releaseLogin(); }
});
