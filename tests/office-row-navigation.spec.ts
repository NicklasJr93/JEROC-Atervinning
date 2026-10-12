import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { TerminalApproval, TerminalDemoState } from '../src/office/terminal-demo-types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

const ids = { new: 61000, attest: 61001, ready: 61002, paid: 61003, approval: 61004 };
async function mockOffice(page: Page, restricted = false) {
  const office = migrateOffice(seedOffice());
  const user: OfficeUser = restricted ? { ...office.users.find(candidate => candidate.id === 'kajsa')!, id: 'row-reader', level: 'Medarbetare', permissions: ['view', 'customerApprovalRead'], maxAttest: 0, ownAttest: false } : office.users.find(candidate => candidate.id === 'admin')!;
  const template = office.cards.find(card => card.id === 2050)!;
  const customer = office.customers.find(candidate => candidate.id === template.customerId) ?? office.customers[0];
  const makeCard = (id: number, status: OfficeCard['status']): OfficeCard => ({ ...structuredClone(template), id, status, siteId: 'norrtalje',
    customerId: customer.id, customerSnapshot: { ...customer, name: `Testkund ${id}` }, origin: 'Provvägen 7, 761 41 Norrtälje', reference: 'Row fixture', registration: 'ABC123', customerApproval: undefined,
    rows: ['Koppar', 'Aluminium', 'Järn', 'Mässing', 'Rostfritt'].map((name, index) => ({ ...template.rows[0], articleName: name, weight: 100 + index, ...(restricted ? { price: 0, pricePending: true } : {}) })),
    financialPending: restricted, audit: [] });
  office.cards = [makeCard(ids.new, 'new'), makeCard(ids.attest, 'attest'), makeCard(ids.ready, 'ready'), makeCard(ids.paid, 'paid'), makeCard(ids.approval, 'customer'), ...Array.from({ length: 32 }, (_, index) => makeCard(61100 + index, 'new'))];
  office.users = [user];
  const approvalCard = office.cards.find(card => card.id === ids.approval)!;
  const approval: TerminalApproval = {
    id: 'row-approval', cardId: approvalCard.id, siteId: 'norrtalje', terminalId: 'row-terminal', version: 2, status: 'waiting',
    createdAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-12T08:00:00Z', sentBy: 'Testhandläggare', actualUserId: user.id, effectiveUserId: user.id,
    snapshot: { card: structuredClone(approvalCard), customer: approvalCard.customerSnapshot!, rows: approvalCard.rows.map(row => ({ articleId: row.articleId, name: row.articleName!, weight: row.weight, price: row.price, amount: row.weight * row.price })),
      gross: restricted ? 0 : 999999, offset: 0, net: restricted ? 0 : 999999, paymentMethod: 'bank', reference: approvalCard.reference, origin: approvalCard.origin, deliveredAt: approvalCard.date, termsVersion: 'test-terms', hash: 'row-snapshot' },
  };
  approvalCard.customerApproval = { id: approval.id, version: approval.version, status: approval.status, updatedAt: approval.updatedAt };
  const terminal: TerminalDemoState = { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id,
    sites: [{ id: 'norrtalje', name: 'Norrtälje' }, { id: 'rimbo', name: 'Rimbo' }], terminals: [{ id: 'row-terminal', name: 'Testterminal', username: 'row-terminal', siteId: 'norrtalje', active: true, online: true, busy: true }], approvals: [approval], defaults: [] };
  const company = { id: 'row-company', name: 'Radtest AB', organisationNumber: '5560000000', status: 'active' };
  const auth = { enabled: true, authenticated: true, actor: { id: 'row-actor', name: user.name, username: user.id, platformAdmin: false }, actualUser: user, user,
    company, organisationId: company.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'row-csrf', generation: 1, companies: [company] };
  const requests: string[] = [];
  await page.context().route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    let body: unknown = {}, status = 200;
    if (path === '/api/platform/session') body = auth;
    else if (path === '/api/application/office') body = { data: office, revision: 1 };
    else if (path === '/api/terminal-demo/state') body = terminal;
    else if (path === '/api/terminal-demo/staff-session') body = { authenticated: true };
    else if (path === '/api/terminal-demo/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    else if (path === '/api/pricing/state') body = { version: 'test', revision: 1, memoryOnly: true, asOfDate: '2026-10-12', metals: [], articles: [], customers: [] };
    else if (path.endsWith('/summary')) body = { workOrders: 0, warehouse: 0, vessels: 0 };
    else if (path.includes('/accounting/cards/')) body = { export: null };
    else { status = 503; body = { error: 'Optional service unavailable in this focused UI fixture' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { requests, customerId: customer.id, customerName: customer.name };
}

const rowFor = (page: Page, id: number) => page.locator('.office-weight-card-row').filter({ has: page.getByRole('link', { name: `Öppna viktkort ${id}`, exact: true }) });

test('hela rader öppnar kort i arbetsköer, historik och översikt, utan separat Visa-kolumn', async ({ page }) => {
  await mockOffice(page);
  for (const [path, id] of [['/weighings', ids.new], ['/attest', ids.attest], ['/payments', ids.ready], ['/weighings?tab=history', ids.paid], ['/dashboard', ids.new]] as const) {
    await page.goto(`/kontor#${path}`);
    const row = rowFor(page, id);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: /Visa|Förhandsvisa|Öppna/ })).toHaveCount(0);
    await expect(page.locator('.office-card-preview')).toHaveCount(0);
    await row.locator('td').nth(1).click();
    await expect(page.getByRole('heading', { name: `Invägning #${id}`, exact: true })).toBeVisible();
    if (path === '/dashboard') {
      await page.getByRole('button', { name: 'Till översikten', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Kontorsöversikt', exact: true })).toBeVisible();
    }
  }
});

test('kortlänken fungerar i ny flik och både raden och länken går att använda med tangentbord', async ({ page, context }) => {
  await mockOffice(page);
  await page.goto('/kontor#/weighings?tab=history&status=new');
  const row = rowFor(page, ids.new), link = row.getByRole('link', { name: `Öppna viktkort ${ids.new}`, exact: true });
  await expect(link).toHaveAttribute('href', `#/weighings/${ids.new}?tab=history&status=new`);
  const opened = context.waitForEvent('page');
  await link.click({ button: 'middle' });
  const newPage = await opened;
  await expect(newPage.getByRole('heading', { name: `Invägning #${ids.new}`, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/weighings\?tab=history&status=new$/);
  await newPage.close();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `Invägning #${ids.new}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Till invägningar', exact: true }).click();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: `Invägning #${ids.new}`, exact: true })).toBeVisible();
});

test('kompakt förhandsvisning dröjer, ryms i vyn och försvinner vid Escape, lämnad rad och navigation', async ({ page }) => {
  const { requests } = await mockOffice(page);
  await page.goto('/kontor#/weighings');
  const row = rowFor(page, 61131);
  await expect(row).toBeVisible();
  await page.waitForTimeout(500);
  const count = requests.length;
  await row.hover();
  await page.waitForTimeout(180);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const preview = page.getByRole('tooltip');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('Provvägen 7');
  await expect(preview).toContainText('Row fixture');
  await expect(preview).toContainText('Nästa steg');
  await expect(preview.getByRole('listitem')).toHaveCount(3);
  await expect(preview).toContainText('+ 2 material till');
  const box = await preview.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
  expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
  await preview.hover();
  await page.waitForTimeout(250);
  await expect(preview).toBeVisible();
  await row.locator('td').nth(2).hover();
  expect(requests.length).toBe(count);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await page.mouse.move(5, 5);
  await row.hover();
  await expect(preview).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(preview).toHaveCount(0);
  await row.hover();
  await expect(preview).toBeVisible();
  await row.locator('td').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Invägning #61131', exact: true })).toBeVisible();
  await expect(preview).toHaveCount(0);
});

test('kundgodkännanden öppnas från raden medan versionsgranskningen behåller sin egen åtgärd och filtren återkommer', async ({ page }) => {
  await mockOffice(page);
  await page.goto('/kontor#/customer-approvals');
  await page.getByLabel('Sök kundgodkännanden', { exact: true }).fill('Row fixture');
  await page.getByLabel('Filtrera godkännandestatus', { exact: true }).selectOption('waiting');
  await page.getByLabel('Utskick från datum', { exact: true }).fill('2026-10-01');
  const row = rowFor(page, ids.approval);
  const review = row.getByRole('button', { name: `Granska avräkningsversion 2 för invägning ${ids.approval}`, exact: true });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/#\/customer-approvals\?/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(review).toBeFocused();
  await row.locator('td').nth(1).click();
  await expect(page.getByRole('heading', { name: `Invägning #${ids.approval}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Till kundgodkännanden', exact: true }).click();
  await expect(page.getByLabel('Sök kundgodkännanden', { exact: true })).toHaveValue('Row fixture');
  await expect(page.getByLabel('Filtrera godkännandestatus', { exact: true })).toHaveValue('waiting');
  await expect(page.getByLabel('Utskick från datum', { exact: true })).toHaveValue('2026-10-01');
});

test('listans sökning, filter och scroll återställs när kortet stängs och när webbläsaren går tillbaka', async ({ page }) => {
  await mockOffice(page);
  await page.goto('/kontor#/weighings?tab=history&status=new');
  await page.getByLabel('Sök i kön', { exact: true }).fill('Row fixture');
  const row = rowFor(page, 61112);
  await row.scrollIntoViewIfNeeded();
  const previous = await page.evaluate(() => window.scrollY);
  expect(previous).toBeGreaterThan(100);
  await row.locator('td').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Invägning #61112', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Till invägningar', exact: true }).click();
  await expect(page.getByLabel('Sök i kön', { exact: true })).toHaveValue('Row fixture');
  await expect(page.getByLabel('Filtrera status', { exact: true })).toHaveValue('new');
  await expect(page.getByRole('tab', { name: 'Historik', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(previous, 0);
  await row.locator('td').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Invägning #61112', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('Sök i kön', { exact: true })).toHaveValue('Row fixture');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(previous, 0);
});

test('en läsare får bara de synliga underlagsfälten i förhandsvisningen', async ({ page }) => {
  await mockOffice(page, true);
  await page.goto('/kontor#/customer-approvals');
  const row = rowFor(page, ids.approval);
  await row.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('Koppar');
  await expect(page.getByRole('tooltip')).toContainText('Provvägen 7');
  await expect(page.getByRole('tooltip')).not.toContainText(/999|kr|SEK|Pris|Belopp/);
  await expect(page.getByRole('columnheader', { name: 'Belopp', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: /Granska avräkningsversion/ })).toHaveCount(0);
});

test('kundens viktkort har riktiga länkar och kompakt förhandsvisning samt återgår med kundens filter', async ({ page }) => {
  const { customerId, customerName } = await mockOffice(page);
  await page.goto(`/kontor#/customers/${encodeURIComponent(customerId)}?tab=weighings`);
  await page.getByLabel('Sök kundens vägningar', { exact: true }).fill('Row fixture');
  await page.getByLabel('Filtrera kundens vägningar', { exact: true }).selectOption('new');
  const row = rowFor(page, 61131);
  await expect(row.getByRole('link', { name: 'Öppna viktkort 61131', exact: true })).toHaveAttribute('href', '#/weighings/61131');
  await expect(row.locator('td')).toHaveCount(5);
  await row.hover();
  await expect(page.getByRole('tooltip')).toContainText('Provvägen 7');
  await expect(page.getByRole('tooltip')).toContainText('Koppar');
  await row.locator('td').nth(1).click();
  await expect(page.getByRole('heading', { name: 'Invägning #61131', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Till kunden', exact: true }).click();
  await expect(page.getByRole('heading', { name: customerName, exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Vägningar', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Sök kundens vägningar', { exact: true })).toHaveValue('Row fixture');
  await expect(page.getByLabel('Filtrera kundens vägningar', { exact: true })).toHaveValue('new');
  await expect(row).toBeVisible();
});

test.describe('pekstyrning', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('ett tryck på raden öppnar direkt utan någon hoverförhandsvisning', async ({ page }) => {
    await mockOffice(page);
    await page.goto('/kontor#/weighings');
    const row = rowFor(page, 61131);
    await expect(row).toBeVisible();
    await row.hover();
    await page.waitForTimeout(500);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await row.locator('td').nth(1).tap();
    await expect(page.getByRole('heading', { name: 'Invägning #61131', exact: true })).toBeVisible();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });
});
