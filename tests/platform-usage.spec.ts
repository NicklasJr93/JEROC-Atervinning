import { test, expect, type Page, type Request } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { seedOffice } from '../src/office/model';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
const admin = seedOffice().users.find(user => user.id === 'admin')!;
const companies = [{ id: 'usage-a', name: 'Alfa testbolag AB', organisationNumber: '5593593626', status: 'active' as const },
  { id: 'usage-b', name: 'Beta testbolag AB', organisationNumber: '5560360793', status: 'active' as const }];
const emptyTotals = () => ({ providerCalls: 0, billableCount: 0, reviewCount: 0, reservedCount: 0, notDispatchedCount: 0,
  success: 0, notFound: 0, rejected: 0, failed: 0, unknown: 0, costMinor: 0, salesMinor: 0, reviewSalesMinor: 0 });
function usage(month: string, companyId = '') {
  const companyRows = month === '2026-09' ? [] : companies.filter(company => !companyId || company.id === companyId).map(company => {
    const totals = company.id === 'usage-a'
      ? { ...emptyTotals(), providerCalls: 5, billableCount: 3, reviewCount: 2, success: 2, notFound: 1, failed: 1, unknown: 1, costMinor: 1000, salesMinor: 600, reviewSalesMinor: 400 }
      : { ...emptyTotals(), providerCalls: 1, billableCount: 1, success: 1, costMinor: 200, salesMinor: 200 };
    return { companyId: company.id, companyName: company.name, totals, services: [{ ...totals, service: 'roaring.person.lookup', channel: 'customer_registration', unitSalesMinor: 200, unitCostMinor: 200 }] };
  });
  const totals = emptyTotals();
  for (const company of companyRows) for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += company.totals[key];
  return { month, currency: 'SEK', pricing: { roaringLookupSalesMinor: 200, roaringLookupCostMinor: 200, pricesExcludeVat: true },
    companies: companyRows, totals, availableCompanies: companies.map(({ id, name }) => ({ id, name })) };
}
async function fixture(page: Page, { support = false, malformed = false } = {}) {
  let session = { enabled: true, authenticated: true, actor: { id: 'usage-admin', name: 'Förbrukningsadministratör', username: 'usage-admin', platformAdmin: true },
    actualUser: admin, user: admin, companies, generation: 4, csrfToken: 'usage-csrf', isSupportSession: support, mustChangePassword: false,
    ...(support ? { company: companies[0], organisationId: companies[0].id } : {}) };
  const requests: Request[] = [], external: string[] = [], errors: string[] = [];
  let holdA = false, release = () => {};
  let gate = Promise.resolve();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== 'http://127.0.0.1:5173' && !['data:', 'blob:'].includes(url.protocol)) { external.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/platform/companies') return route.fulfill({ json: { companies } });
    if (path.endsWith('/users')) return route.fulfill({ json: { users: [admin] } });
    if (path === '/api/platform/communications') return route.fulfill({ json: { email: { configured: false, provider: 'resend', from: 'ScrapPlanner <noreply@example.test>' }, sms: { configured: false } } });
    if (path === '/api/platform/telematics') return route.fulfill({ json: { revision: 0, devices: [], events: [], requests: [] } });
    if (path.startsWith('/api/platform/usage')) {
      requests.push(request);
      if (path.endsWith('/export')) return route.fulfill({ contentType: 'text/csv; charset=utf-8', body: '\uFEFFMånad;Bolag;Tjänst;Antal;À-pris exkl moms;Belopp exkl moms\r\n2026-10;Alfa testbolag AB;Personuppslag Roaring;3;2,00;6,00\r\n' });
      if (holdA && url.searchParams.get('companyId') === 'usage-a') await gate;
      return route.fulfill({ json: malformed ? { month: url.searchParams.get('month'), totals: {} } : usage(url.searchParams.get('month')!, url.searchParams.get('companyId') ?? '') }).catch(() => undefined);
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/kontor#/platform-admin');
  return { requests, external, errors,
    holdCompanyA: () => { holdA = true; gate = new Promise<void>(resolve => { release = resolve; }); },
    release: () => release(),
    revoke: async () => { session = { ...session, isSupportSession: true, generation: 5 }; await page.evaluate(() => window.dispatchEvent(new Event('scrappilot:check-platform-session'))); },
  };
}
const panel = (page: Page) => page.getByRole('region', { name: 'Förbrukning och fakturaunderlag', exact: true });

test('systemadmin sees real monthly counts and keeps uncertain charges out of invoice lines', async ({ page }) => {
  const f = await fixture(page), usagePanel = panel(page);
  await expect(usagePanel.getByLabel('Förbrukningsmånad', { exact: true })).toHaveValue(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit' }).format(new Date()));
  await usagePanel.getByLabel('Förbrukningsmånad', { exact: true }).fill('2026-10');
  await expect(usagePanel.locator('.platform-usage-stat').filter({ hasText: 'Utgående försök' }).locator('strong')).toHaveText('6');
  await expect(usagePanel.locator('.platform-usage-stat').filter({ hasText: 'Bekräftat debiterbara' }).locator('strong')).toHaveText('4');
  await expect(usagePanel.locator('.platform-usage-stat.total strong')).toHaveText(/8,00\s*kr/);
  await expect(usagePanel).toContainText(/Att granska: 2 uppslag · 4,00\s*kr/);
  await expect(usagePanel.getByLabel('Utfall för vald månad', { exact: true })).toContainText('Okänt utfall: 1');
  const invoice = usagePanel.getByRole('region', { name: 'Månadens fakturaunderlag', exact: true });
  await expect(invoice.locator('tbody tr')).toHaveCount(2);
  await expect(invoice.locator('tbody tr').filter({ hasText: companies[0].name })).toContainText(/6,00\s*kr/);
  await expect(invoice).not.toContainText('SMS'); await expect(invoice).not.toContainText('Mejl');
  expect(f.requests.every(request => request.method() === 'GET')).toBe(true);
  expect(f.requests[0].headers()).toMatchObject({ 'x-platform-csrf': 'usage-csrf', 'x-platform-generation': '4' });
  expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
});

test('company and month filters change the full selection and an empty month displays confirmed zeroes', async ({ page }) => {
  const f = await fixture(page), usagePanel = panel(page);
  await usagePanel.getByLabel('Förbrukningsmånad', { exact: true }).fill('2026-10');
  await usagePanel.getByLabel('Filtrera förbrukning efter bolag', { exact: true }).selectOption('usage-b');
  await expect(usagePanel.locator('.platform-usage-stat.total strong')).toHaveText(/2,00\s*kr/);
  await expect(usagePanel.getByRole('region', { name: 'Förbrukning per bolag', exact: true }).locator('tbody tr')).toHaveCount(1);
  expect(f.requests.some(request => new URL(request.url()).searchParams.get('companyId') === 'usage-b')).toBe(true);
  await usagePanel.getByLabel('Förbrukningsmånad', { exact: true }).fill('2026-09');
  await expect(usagePanel.locator('.platform-usage-stat.total strong')).toHaveText(/0,00\s*kr/);
  await expect(usagePanel).toContainText('Ingen registrerad förbrukning för vald månad och bolag.');
  await expect(usagePanel.getByRole('region', { name: 'Månadens fakturaunderlag', exact: true }).locator('tbody tr')).toHaveCount(0);
  expect(f.errors).toEqual([]);
});

test('CSV is an explicit authenticated GET for the current month and company, without invoice mutations', async ({ page }) => {
  const f = await fixture(page), usagePanel = panel(page);
  await usagePanel.getByLabel('Förbrukningsmånad', { exact: true }).fill('2026-10');
  await usagePanel.getByLabel('Filtrera förbrukning efter bolag', { exact: true }).selectOption('usage-a');
  const button = usagePanel.getByRole('button', { name: 'Ladda ner CSV', exact: true }); await expect(button).toBeEnabled();
  expect(f.requests.filter(request => new URL(request.url()).pathname.endsWith('/export'))).toHaveLength(0);
  const downloadPromise = page.waitForEvent('download'); await button.click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('fakturaunderlag-2026-10-valt-bolag.csv');
  const downloadedPath = await download.path(); expect(downloadedPath).toBeTruthy(); expect(await readFile(downloadedPath!, 'utf8')).toContain('Personuppslag Roaring;3;2,00;6,00');
  const request = f.requests.find(request => new URL(request.url()).pathname.endsWith('/export'))!;
  expect(request.method()).toBe('GET'); expect(request.postData()).toBeNull(); expect(new URL(request.url()).searchParams.get('companyId')).toBe('usage-a');
  expect(request.headers()).toMatchObject({ 'x-platform-csrf': 'usage-csrf', 'x-platform-generation': '4' });
  expect(f.requests.every(request => request.method() === 'GET')).toBe(true); expect(f.errors).toEqual([]);
});

test('a late previous-company response cannot restore totals after another company is selected', async ({ page }) => {
  const f = await fixture(page), usagePanel = panel(page);
  await usagePanel.getByLabel('Förbrukningsmånad', { exact: true }).fill('2026-10'); f.holdCompanyA();
  await usagePanel.getByLabel('Filtrera förbrukning efter bolag', { exact: true }).selectOption('usage-a');
  await expect.poll(() => f.requests.some(request => new URL(request.url()).searchParams.get('companyId') === 'usage-a')).toBe(true);
  await usagePanel.getByLabel('Filtrera förbrukning efter bolag', { exact: true }).selectOption('usage-b');
  await expect(usagePanel.locator('.platform-usage-stat.total strong')).toHaveText(/2,00\s*kr/); f.release();
  await expect(usagePanel.getByRole('region', { name: 'Förbrukning per bolag', exact: true }).locator('tbody')).not.toContainText(companies[0].name);
  expect(f.errors).toEqual([]);
});

test('support sessions cannot request usage and revocation removes an already loaded aggregate', async ({ page }) => {
  const f = await fixture(page), usagePanel = panel(page);
  await expect(usagePanel.locator('.platform-usage-stat.total')).toBeVisible(); await f.revoke();
  await expect(usagePanel).toHaveCount(0);
  await page.unroute('**/*'); await page.goto('about:blank');
  const support = await fixture(page, { support: true }); await expect(panel(page)).toHaveCount(0); expect(support.requests).toHaveLength(0);
});

test('malformed accounting aggregates show an error without invented zeroes or an enabled export', async ({ page }) => {
  const f = await fixture(page, { malformed: true }), usagePanel = panel(page);
  await expect(usagePanel.getByRole('alert')).toContainText('ofullständigt svar');
  await expect(usagePanel.locator('.platform-usage-stat')).toHaveCount(0);
  await expect(usagePanel.getByRole('button', { name: 'Ladda ner CSV', exact: true })).toBeDisabled(); expect(f.errors).toEqual([]);
});
