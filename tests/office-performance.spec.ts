import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeData } from '../src/office/model';
import type { PricingState } from '../src/office/pricing-client';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

async function fixture(page: Page) {
  const office = seedOffice();
  const response = await page.request.get('/api/pricing/state', { headers: { 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' } });
  expect(response.ok()).toBe(true);
  const pricing = await response.json() as PricingState;
  const requests: { path: string; user?: string; site?: string }[] = [];
  await page.addInitScript((data: OfficeData) => {
    localStorage.setItem('jeroc.office.demo.v1', JSON.stringify(data));
    localStorage.setItem('jeroc.office.demo.v1.postgres-imported', 'yes');
    sessionStorage.setItem('jeroc.office.user', 'admin');
  }, office);
  await page.route('**/api/application/office', route => route.fulfill({ json: { data: office, revision: 1 } }));
  await page.route('**/api/terminal-demo/staff-session', route => route.fulfill({ json: {} }));
  await page.route('**/api/terminal-demo/state', route => route.fulfill({ json: {
    configured: true, revision: 1,
    actualUserId: route.request().headers()['x-terminal-actual-user'],
    effectiveUserId: route.request().headers()['x-terminal-effective-user'],
    sites: [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }],
    approvals: [], terminals: [], defaults: [],
  } }));
  await page.route('**/api/terminal-demo/events', route => route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }));
  await page.route('**/api/logistics/summary*', async route => {
    const request = route.request(), url = new URL(request.url());
    requests.push({ path: url.pathname, user: request.headers()['x-demo-user'], site: url.searchParams.get('siteId') ?? 'all' });
    await route.fulfill({ json: { workOrders: url.searchParams.get('siteId') === 'rimbo' ? 2 : 7, revision: 1 } });
  });
  await page.route('**/api/pricing/state*', async route => {
    requests.push({ path: new URL(route.request().url()).pathname, user: route.request().headers()['x-demo-user'] });
    await new Promise(resolve => setTimeout(resolve, 50));
    await route.fulfill({ json: pricing });
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/logistics/office') requests.push({ path: '/api/logistics/office' });
  });
  return { office, pricing, requests };
}

function workOrderCount(page: Page) { return page.locator('#office-nav-count-work-orders'); }

test('integrationer hämtar ingen full arbetsorderlista eller prislista; antal uppdateras samlat och per anläggning', async ({ page }) => {
  const { requests } = await fixture(page);
  await page.clock.install();
  await page.goto('/kontor#/integrations');
  await expect(page.getByRole('heading', { name: 'Integrationer', exact: true })).toBeVisible();
  await expect(workOrderCount(page)).toHaveText('7');
  await page.clock.fastForward(12_000);
  expect(requests.filter(request => request.path === '/api/logistics/office')).toHaveLength(0);
  expect(requests.filter(request => request.path === '/api/pricing/state')).toHaveLength(0);
  expect(requests.filter(request => request.path === '/api/logistics/summary')).toHaveLength(1);

  await page.evaluate(() => {
    for (let index = 0; index < 8; index++) window.dispatchEvent(new CustomEvent('jeroc:business-change', {
      detail: { identity: 'admin/admin', domain: 'application', revision: index + 2 },
    }));
  });
  await page.clock.fastForward(200);
  await expect.poll(() => requests.filter(request => request.path === '/api/logistics/summary').length).toBe(2);
  await page.getByLabel('Anläggning', { exact: true }).selectOption('rimbo');
  await expect(workOrderCount(page)).toHaveText('2');
  expect(requests.at(-1)).toEqual({ path: '/api/logistics/summary', user: 'admin', site: 'rimbo' });
});

test('viktkort hämtar artikelunderlaget vid behov och artikelvyn gör bara en egen kataloghämtning', async ({ page }) => {
  const { requests, office } = await fixture(page);
  await page.goto('/kontor#/weighings');
  await expect(page.getByRole('heading', { name: 'Invägningar', exact: true })).toBeVisible();
  expect(requests.filter(request => request.path === '/api/pricing/state')).toHaveLength(0);
  const card = office.cards.find(card => card.id === 2053)!;
  await page.getByRole('button', { name: `Öppna viktkort ${card.id}`, exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Lägg till artikel', exact: true })).toBeEnabled();
  expect(requests.filter(request => request.path === '/api/pricing/state')).toHaveLength(1);
  await page.locator('.office-sidebar nav').getByRole('button', { name: 'Artiklar & priser', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Artiklar & priser', exact: true })).toBeVisible();
  await expect.poll(() => requests.filter(request => request.path === '/api/pricing/state').length).toBe(2);
});

test('samtidiga katalogläsningar delar ett anrop men inte redigerbara objekt eller behörighetsscope', async ({ page }) => {
  const { office, requests } = await fixture(page);
  await page.goto('/kontor#/integrations');
  await expect(page.getByRole('heading', { name: 'Integrationer', exact: true })).toBeVisible();
  const result = await page.evaluate(async ({ actor, user }) => {
    const path = '/src/office/pricing-client.ts';
    const { pricingRequest } = await import(/* @vite-ignore */ path);
    const [first, second] = await Promise.all([
      pricingRequest('state', user, actor), pricingRequest('state', user, actor),
    ]);
    const original = second.articles[0].name;
    first.articles[0].name = 'Redigerad lokalt';
    await Promise.all([
      pricingRequest('state', user, actor),
      pricingRequest('state', { ...user, siteIds: ['rimbo'] }, actor),
    ]);
    return { original, unmodified: second.articles[0].name };
  }, { actor: office.users.find(user => user.id === 'admin')!, user: office.users.find(user => user.id === 'admin')! });
  expect(result.unmodified).toBe(result.original);
  expect(requests.filter(request => request.path === '/api/pricing/state')).toHaveLength(3);
});

test('byte till en roll utan arbetsorderbehörighet tar bort gammal markör och ignorerar försenade svar', async ({ page }) => {
  const { requests } = await fixture(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/logistics/summary*', async route => {
    requests.push({ path: '/api/logistics/summary', user: route.request().headers()['x-demo-user'], site: 'all' });
    await held;
    await route.fulfill({ json: { workOrders: 99, revision: 1 } }).catch(() => {});
  });
  await page.goto('/kontor#/integrations');
  await expect(page.getByRole('heading', { name: 'Integrationer', exact: true })).toBeVisible();
  await expect.poll(() => requests.filter(request => request.path === '/api/logistics/summary').length).toBe(1);
  await page.getByLabel('Öppna profilmeny', { exact: true }).click();
  await page.getByLabel('Jobba som', { exact: true }).selectOption('kajsa');
  await expect(page.locator('.office-sidebar-profile strong').first()).toHaveText('Kajsa Nilsson');
  release();
  await expect(page.locator('.office-sidebar nav').getByRole('button', { name: /^Arbetsorder/ })).toHaveCount(0);
  await expect(workOrderCount(page)).toHaveCount(0);
  expect(requests.filter(request => request.path === '/api/logistics/summary')).toHaveLength(1);
  expect(requests.filter(request => request.path === '/api/pricing/state')).toHaveLength(0);
});
