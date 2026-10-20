import { expect, test, type Page, type Route } from '@playwright/test';
import type { Article } from '../src/data';
import type { DemoData } from '../src/model';
import type { EmployeeOverview } from '../src/employee/types';
import type { AuthenticatedPlatformSession, PlatformCompany } from '../src/platform/types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const companies: PlatformCompany[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Supportbolag A AB', organisationNumber: '5560000019', status: 'active' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Supportbolag B AB', organisationNumber: '5560000027', status: 'active' },
];
const personId = '__platform-admin';
const loginName = 'admin@example.invalid';
const fixturePassword = 'Private-Mobile-Admin-Fixture-2026!';
const companyMarker = (company: PlatformCompany) => company.id === companies[0].id ? 'A' : 'B';
const customerName = (company: PlatformCompany) => `Kund endast ${companyMarker(company)}`;
const articleName = (company: PlatformCompany) => `Provkoppar endast ${companyMarker(company)}`;
const deferred = () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
};

type RecordedRequest = { path: string; method: string; headers: Record<string, string>; body?: any };

/** Isolated API projection: no real platform account, employee record, tenant
 * database or delivery provider is accessed by these browser scenarios. */
async function supportFixture(page: Page, options: { authenticated?: boolean; mustChangePassword?: boolean; denyLogin?: boolean } = {}) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const requests: RecordedRequest[] = [], errors: string[] = [];
  const staleReads = deferred(), companyList = deferred();
  let authenticated = options.authenticated ?? false, selected: PlatformCompany | undefined;
  let generation = 1, mustChangePassword = options.mustChangePassword ?? false, revoked = false;
  let holdOldReads = false, holdCompanyList = false;
  let staleOverviewReads = 0, staleMobileReads = 0, releasedOldReads = 0;
  const records = new Map<string, DemoData>(companies.map((company, index) => [company.id, {
    version: 1,
    customers: [{ id: `customer-${index}`, name: customerName(company), type: 'Företag', number: company.organisationNumber,
      phone: '', email: '', references: [], origins: [] }],
    drafts: [{ id: `draft-${index}`, number: 800 + index, siteId: `site-${companyMarker(company)}`, mode: 'direct', status: 'draft',
      createdAt: `${today}T07:00:00.000Z`, updatedAt: `${today}T07:00:00.000Z`, rows: [],
      customerId: `customer-${index}`, reference: '', origin: '' }],
  }]));
  const user = { id: personId, name: 'Testadministratör', level: 'Systemadmin' as const,
    permissions: ['view', 'prepare', 'customers', 'weighingAddArticle', 'weighingEditWeight', 'weighingRemoveArticle'] as AuthenticatedPlatformSession['user']['permissions'],
    maxAttest: 1_000_000, ownAttest: true, active: true };
  function platformSession(): AuthenticatedPlatformSession {
    return { enabled: true, authenticated: true,
      actor: { id: 'platform-fixture-admin', name: 'Testadministratör', username: loginName, platformAdmin: true },
      actualUser: user, user, companies, mustChangePassword, isSupportSession: Boolean(selected),
      csrfToken: `browser-admin-csrf-${generation}`, generation,
      ...(selected ? { company: selected, organisationId: selected.id } : {}) };
  }
  function picker() { return { kind: 'platform-admin', platformSession: platformSession(), companies }; }
  function overview(company: PlatformCompany) {
    const siteId = `site-${companyMarker(company)}`;
    const day = { date: today, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0,
      automaticMinutes: 0, manualMinutes: 0, absenceMinutes: 0, jobsCount: 0, status: 'not_required' as const };
    return { revision: 1, companyId: company.id, companyName: company.name,
      person: { id: personId, userId: personId, name: 'Testadministratör', username: loginName, role: 'Systemadmin',
        kind: 'external' as const, team: '', phone: '', email: '', siteIds: [siteId] },
      capabilities: { yardWork: true, assignedOrders: false, employeeTime: false, manageTimeRequirements: false, manageEmployeeAccounts: false },
      sites: [{ id: siteId, name: `Anläggning endast ${companyMarker(company)}`, active: true }], activeSiteId: siteId,
      today, date: today, month: today.slice(0, 7), monthLoaded: false,
      requirement: { enabled: false, mode: 'schedule' as const, effectiveFrom: today, enforcementFrom: today, revision: 0 },
      gate: { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, days: [day],
      selectedDay: { ...day, entries: [], schedules: [], absences: [], orders: [] }, orders: [], leaveRequests: [], activeWork: null,
      summary: { expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 }, balances: { available: false },
      support: { kind: 'platform-admin', csrfToken: `browser-admin-csrf-${generation}`, generation,
        organisationId: company.id, actorName: 'Testadministratör', platformSession: platformSession() },
    } satisfies EmployeeOverview & { support: unknown };
  }
  function mobile(company: PlatformCompany) {
    const marker = companyMarker(company);
    const catalog: Article[] = [{ id: `article-${marker}`, category: `group-${marker}`, name: articleName(company),
      description: `Materialbeskrivning endast ${marker}`, includes: 'Ren koppar.', excludes: 'Järn.', photos: [],
      active: true, taxCategory: 'scrap_reverse', prices: [42, 40, 40] }];
    return { data: structuredClone(records.get(company.id)!), revision: 1, catalog, customerPrices: {},
      groups: [{ id: `group-${marker}`, name: `Material ${marker}`, description: '', photo: null, sortOrder: 0, active: true, revision: 1 }] };
  }
  const send = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body }).catch(() => undefined);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
    requests.push({ path, method: request.method(), headers: request.headers(), ...(body === undefined ? {} : { body }) });
    if (path === '/api/employee/demo-config') return send(route, { enabled: false, accounts: { niklas: false, admin: false } });
    if (path === '/api/employee/login') {
      expect(body).toEqual({ username: loginName, password: fixturePassword });
      if (options.denyLogin) return send(route, { error: 'Kontot är inte aktivt.', code: 'invalid_login' }, 401);
      authenticated = true; return send(route, picker());
    }
    if (path === '/api/employee/logout') { authenticated = false; selected = undefined; return send(route, { ok: true }); }
    if (!authenticated || revoked) return send(route, { error: 'Logga in igen.', code: 'session_expired' }, 401);
    if (path === '/api/platform/change-password') {
      expect(body).toEqual({ currentPassword: fixturePassword, newPassword: 'Changed-Private-Mobile-Fixture-2026!' });
      mustChangePassword = false; generation++;
      return send(route, platformSession());
    }
    if (path === '/api/employee/session') return send(route, selected ? overview(selected) : picker());
    if (path === '/api/employee/companies') {
      selected = undefined;
      if (holdCompanyList) await companyList.ready;
      return send(route, picker());
    }
    if (path === '/api/employee/company') {
      expect(body).toEqual({ companyId: expect.any(String) });
      selected = companies.find(company => company.id === body.companyId);
      expect(selected).toBeDefined(); generation++;
      return send(route, overview(selected!));
    }
    const company = selected;
    if (!company) return send(route, { error: 'Välj bolag först.' }, 409);
    if (path === '/api/employee/overview') {
      const projection = overview(company);
      if (holdOldReads && company.id === companies[0].id) {
        staleOverviewReads++; await staleReads.ready; releasedOldReads++;
      }
      return send(route, projection);
    }
    // A support identity has no employee/driver association. Mirror the real
    // endpoint instead of inventing an empty own-person fleet that hides errors.
    if (/^\/api\/employee\/fleet(?:\/|$)/.test(path)) return send(route,
      { error: 'Din systemadminsession har ingen egen körjournal i bolaget.', code: 'mobile_support_personal_unavailable' }, 403);
    if (path === '/api/application/mobile') {
      if (request.method() === 'POST') {
        const previous = records.get(company.id)!;
        if (body.kind === 'records') {
          const merge = <T extends { id: string }>(old: T[], changes: { id: string; next?: T }[]) => {
            const next = new Map(old.map(record => [record.id, record]));
            for (const change of changes) { if (change.next) next.set(change.id, change.next); else next.delete(change.id); }
            return [...next.values()];
          };
          records.set(company.id, { version: 1, drafts: merge(previous.drafts, body.drafts), customers: merge(previous.customers, body.customers) });
        } else if (body.kind === 'update') records.set(company.id, body.next);
        else throw new Error(`Unexpected fixture mutation kind: ${body.kind}`);
      }
      const projection = mobile(company);
      if (request.method() === 'GET' && holdOldReads && company.id === companies[0].id) {
        staleMobileReads++; await staleReads.ready; releasedOldReads++;
      }
      return send(route, projection);
    }
    if (path === '/api/application/revision') return send(route, { revision: 1 });
    return send(route, { error: 'API-vägen ingår inte i denna isolerade testfixtur.' }, 404);
  });
  return { requests, errors, records,
    holdOldReads: () => { holdOldReads = true; },
    holdCompanyList: () => { holdCompanyList = true; },
    releaseOldReads: staleReads.release, releaseCompanyList: companyList.release,
    staleReads: () => ({ overview: staleOverviewReads, mobile: staleMobileReads, released: releasedOldReads }),
    revoke: () => { revoked = true; },
  };
}

async function login(page: Page) {
  await page.goto('/mobil/');
  await page.getByLabel('Användarnamn', { exact: true }).fill(loginName);
  await page.getByLabel('Lösenord', { exact: true }).fill(fixturePassword);
  await page.getByRole('button', { name: 'Logga in', exact: true }).click();
}
async function chooseCompany(page: Page, company = companies[0]) {
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Bolag', exact: true }).selectOption(company.id);
  await page.getByRole('button', { name: 'Öppna bolag', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Administrationsläge', exact: true })).toContainText(`Systemadmin · ${company.name}`);
  await expect(page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first()).toBeVisible();
}
function operationalRequests(requests: RecordedRequest[]) {
  return requests.filter(request => request.path.startsWith('/api/application/') || ['/api/employee/fleet', '/api/employee/overview'].includes(request.path));
}

test('systemadmin loggar in utan personalpost, väljer bolag och kan spara en riktig operativ vägning utan egen HR', async ({ page }) => {
  const fixture = await supportFixture(page);
  await login(page);
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toBeVisible();
  expect(operationalRequests(fixture.requests)).toEqual([]);
  expect(fixture.requests.some(request => request.path === '/api/platform/tenant-context')).toBe(false);
  await chooseCompany(page);
  await expect(page.getByRole('dialog', { name: 'Komplettera din resa', exact: true })).toHaveCount(0);
  expect(fixture.requests.some(request => /^\/api\/employee\/fleet(?:\/|$)/.test(request.path))).toBe(false);
  const selection = fixture.requests.find(request => request.path === '/api/employee/company')!;
  expect(selection.headers).toMatchObject({ 'x-platform-csrf': 'browser-admin-csrf-1', 'x-platform-generation': '1' });
  const navigation = page.getByRole('navigation', { name: 'Huvudmeny', exact: true });
  await expect(navigation.getByRole('button')).toHaveText(['Hem', 'Gårdsarbete', 'Profil']);
  await expect(page.getByRole('button', { name: 'Stämpla in', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Starta invägning/ })).toBeEnabled();
  await page.getByRole('button', { name: /Starta invägning/ }).click();
  await page.getByRole('button', { name: /Materialvåg/ }).click();
  await page.locator('.material-choice').filter({ hasText: 'Material A' }).click();
  await page.locator('.material-choice').filter({ hasText: articleName(companies[0]) }).click();
  await page.getByRole('button', { name: `Välj ${articleName(companies[0])}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg', exact: true }).fill('42');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  await expect.poll(() => fixture.records.get(companies[0].id)!.drafts.some(draft => draft.rows.some(row => row.method === 'direct' && row.weight === 42))).toBe(true);
  const writes = fixture.requests.filter(request => request.path === '/api/application/mobile' && request.method === 'POST');
  expect(writes.length).toBeGreaterThan(0);
  for (const write of writes) expect(write.headers).toMatchObject({ 'x-employee-company': companies[0].id,
    'x-platform-csrf': 'browser-admin-csrf-2', 'x-platform-generation': '2' });
  await page.getByRole('button', { name: 'Spara utkast', exact: true }).click();
  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await expect(page.getByText('Testadministratör', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Kontaktuppgifter|Byt lösenord|Min utrustning|Timkrav/ })).toHaveCount(0);
  expect(fixture.requests.some(request => /^\/api\/employee\/(time|clock|sickness|equipment|requirements|accounts)(?:\/|$)/.test(request.path))).toBe(false);
  expect(fixture.requests.some(request => /^\/api\/employee\/fleet(?:\/|$)/.test(request.path))).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Komplettera din resa', exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('systemadminens egna fordonslänkar och återanslutning öppnar inga förarresor eller personspärrar', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true });
  await page.goto('/mobil/');
  await chooseCompany(page);
  for (const route of ['/my-vehicle', '/my-trips']) {
    await page.evaluate(path => { window.location.hash = path; }, route);
    await expect(page).toHaveURL(/\/mobil\/#\/$/);
    await expect(page.getByRole('region', { name: 'Administrationsläge', exact: true })).toContainText(companies[0].name);
    await expect(page.getByRole('dialog', { name: 'Komplettera din resa', exact: true })).toHaveCount(0);
  }
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('jeroc:employee-fleet-changed'));
  });
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /Starta invägning/ })).toBeEnabled();
  expect(fixture.requests.some(request => /^\/api\/employee\/fleet(?:\/|$)/.test(request.path))).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Komplettera din resa', exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('systemadminens huvudmeny markerar exakt en del för hem, gårdsarbete, priser, utkast och profil', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true });
  await page.goto('/mobil/');
  await chooseCompany(page);
  const navigation = page.getByRole('navigation', { name: 'Huvudmeny', exact: true });
  async function selected(name: string) {
    await expect(navigation.locator('button.active')).toHaveCount(1);
    await expect(navigation.locator('button.active')).toHaveText(name);
    await expect(navigation.locator('button[aria-current="page"]')).toHaveCount(1);
    await expect(navigation.locator('button[aria-current="page"]')).toHaveText(name);
  }
  await selected('Hem');
  await navigation.getByRole('button', { name: 'Gårdsarbete', exact: true }).click();
  await expect(page).toHaveURL(/#\/yard$/); await selected('Gårdsarbete');
  await page.getByRole('button', { name: /^Prislista/ }).click();
  await expect(page).toHaveURL(/#\/prices$/); await selected('Gårdsarbete');
  await page.getByRole('button', { name: `Visa priser för ${articleName(companies[0])}`, exact: true }).click();
  await expect(page).toHaveURL(/#\/prices\/article-A$/); await selected('Gårdsarbete');
  await navigation.getByRole('button', { name: 'Gårdsarbete', exact: true }).click();
  await page.getByRole('button', { name: /^Vägningshistorik/ }).click();
  await expect(page).toHaveURL(/#\/drafts$/); await selected('Gårdsarbete');
  await navigation.getByRole('button', { name: 'Profil', exact: true }).click();
  await expect(page).toHaveURL(/#\/profile$/); await selected('Profil');
  await navigation.getByRole('button', { name: 'Hem', exact: true }).click();
  await expect(page).toHaveURL(/#\/$/); await selected('Hem');
  expect(fixture.errors).toEqual([]);
});

test('bolagsbyte stänger A direkt och försenade A-svar kan inte ersätta B:s kunder, anläggning eller artikelregister', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true });
  try {
    await page.goto('/mobil/');
    await chooseCompany(page);
    await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
    await expect(page.getByText(customerName(companies[0]), { exact: true })).toBeVisible();
    fixture.holdOldReads(); fixture.holdCompanyList();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => fixture.staleReads().overview).toBeGreaterThan(0);
    await expect.poll(() => fixture.staleReads().mobile).toBeGreaterThan(0);
    await page.getByRole('region', { name: 'Administrationsläge', exact: true }).getByRole('button', { name: 'Byt bolag', exact: true }).click();
    await expect(page.getByText(customerName(companies[0]), { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Gårdsarbete', exact: true })).toHaveCount(0);
    fixture.releaseCompanyList();
    await chooseCompany(page, companies[1]);
    await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
    await expect(page.getByText(customerName(companies[1]), { exact: true })).toBeVisible();
    fixture.releaseOldReads();
    await expect.poll(() => fixture.staleReads().released).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect(page.getByRole('region', { name: 'Administrationsläge', exact: true })).toContainText(`Systemadmin · ${companies[1].name}`);
    await expect(page.getByText(customerName(companies[0]), { exact: true })).toHaveCount(0);
    await expect(page.getByText('Anläggning endast A', { exact: true })).toHaveCount(0);
    await expect(page.getByText(customerName(companies[1]), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Prislista/ }).click();
    await expect(page.getByRole('button', { name: `Visa priser för ${articleName(companies[1])}`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `Visa priser för ${articleName(companies[0])}`, exact: true })).toHaveCount(0);
    const selections = fixture.requests.filter(request => request.path === '/api/employee/company');
    expect(selections.map(request => request.body)).toEqual(companies.map(company => ({ companyId: company.id })));
    expect(selections[1].headers).toMatchObject({ 'x-platform-csrf': 'browser-admin-csrf-2', 'x-platform-generation': '2' });
    expect(fixture.errors).toEqual([]);
  } finally { fixture.releaseOldReads(); fixture.releaseCompanyList(); }
});

test('utloggning lämnar en vanlig inloggning och gamla supportdata kan inte öppnas igen via bakåtlänk', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true });
  await page.goto('/mobil/');
  await chooseCompany(page);
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Administrationsläge', exact: true }).getByRole('button', { name: 'Logga ut', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Administrationsläge', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toHaveCount(0);
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toHaveCount(0);
  const logout = fixture.requests.find(request => request.path === '/api/employee/logout')!;
  expect(logout.headers).toMatchObject({ 'x-platform-csrf': 'browser-admin-csrf-2', 'x-platform-generation': '2' });
  await page.evaluate(() => { window.location.hash = '/yard'; });
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('en återkallad systemadminsession rensar bolagsvyn vid 401 och tillåter inga fortsatta verksamhetsval', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true });
  await page.goto('/mobil/');
  await chooseCompany(page);
  await page.getByRole('button', { name: 'Gårdsarbete', exact: true }).first().click();
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toBeVisible();
  fixture.revoke();
  await page.evaluate(() => window.dispatchEvent(new Event('jeroc:employee-session-check')));
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Administrationsläge', exact: true })).toHaveCount(0);
  await expect(page.getByText(customerName(companies[0]), { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Starta invägning/ })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test('ett inaktivt adminkonto får inloggningsfel utan bolagsväljare eller verksamhetsläsning', async ({ page }) => {
  const fixture = await supportFixture(page, { denyLogin: true });
  await login(page);
  await expect(page.getByRole('alert')).toContainText('Kontot är inte aktivt.');
  await expect(page.getByRole('heading', { name: 'Välkommen tillbaka', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toHaveCount(0);
  expect(operationalRequests(fixture.requests)).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test('tvingat lösenordsbyte sker före bolagsval med CSRF och roterad generation', async ({ page }) => {
  const fixture = await supportFixture(page, { authenticated: true, mustChangePassword: true });
  await page.goto('/mobil/');
  await expect(page.getByRole('heading', { name: 'Välj nytt lösenord', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toHaveCount(0);
  expect(operationalRequests(fixture.requests)).toEqual([]);
  await page.getByLabel('Nuvarande lösenord', { exact: true }).fill(fixturePassword);
  await page.getByLabel('Nytt lösenord', { exact: true }).fill('Changed-Private-Mobile-Fixture-2026!');
  await page.getByLabel('Upprepa nytt lösenord', { exact: true }).fill('Different-Private-Mobile-Fixture-2026!');
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/stämmer inte|matchar inte/i);
  expect(fixture.requests.some(request => request.path === '/api/platform/change-password')).toBe(false);
  await page.getByLabel('Upprepa nytt lösenord', { exact: true }).fill('Changed-Private-Mobile-Fixture-2026!');
  await page.getByRole('button', { name: 'Spara nytt lösenord', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Välj bolag', exact: true })).toBeVisible();
  const passwordChange = fixture.requests.find(request => request.path === '/api/platform/change-password')!;
  expect(passwordChange.headers).toMatchObject({ 'x-platform-csrf': 'browser-admin-csrf-1', 'x-platform-generation': '1' });
  await chooseCompany(page);
  const selection = fixture.requests.find(request => request.path === '/api/employee/company')!;
  expect(selection.headers).toMatchObject({ 'x-platform-csrf': 'browser-admin-csrf-2', 'x-platform-generation': '2' });
  expect(fixture.errors).toEqual([]);
});
