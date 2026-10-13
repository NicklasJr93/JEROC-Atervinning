import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { SwishPaymentJob } from '../src/office/swish-payments-client';

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
async function fixture(page: Page, options: { lostStartResponse?: boolean; restricted?: boolean } = {}) {
  const office = migrateOffice(seedOffice()), cardId = 61200;
  const baseUser = office.users.find(user => user.id === 'admin')!;
  const user: OfficeUser = options.restricted ? { ...baseUser, level: 'Medarbetare', permissions: ['view'], maxAttest: 0 } : baseUser;
  const customer = { ...office.customers.find(value => value.type === 'Privatperson')!, name: 'Utbetalningstest', number: '199001011239' };
  const card: OfficeCard = { ...structuredClone(office.cards[0]), id: cardId, status: 'ready', siteId: 'norrtalje', customerId: customer.id,
    customerSnapshot: customer, paymentDetails: { method: 'bank', bank: 'Testbank', clearing: '8327', account: '1234567890', holder: customer.name }, payment: 'Bankkonto',
    customerApproval: { id: 'payment-approval', version: 1, status: 'attested', updatedAt: '2026-10-13T08:00:00Z', attestedAt: '2026-10-13T08:00:00Z' }, audit: [] };
  office.cards = [card]; office.users = [user]; office.customers = [customer];
  const company = { id: 'payment-company', name: 'Betaltest AB', organisationNumber: '5560000000', status: 'active' };
  const auth = { enabled: true, authenticated: true, actor: { id: 'payment-actor', name: user.name, username: user.id, platformAdmin: false }, actualUser: user, user,
    company, organisationId: company.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'payment-csrf', generation: 1, companies: [company] };
  const source = { cardId, approvalId: 'payment-approval', version: 1, hash: 'payment-source-hash', siteId: 'norrtalje', customerId: customer.id, customerName: customer.name, customerType: customer.type };
  let job: SwishPaymentJob | undefined, starts = 0;
  const requests: string[] = [], startsPayload: Record<string, unknown>[] = [];
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(path);
    let body: unknown = {}, status = 200;
    if (path === '/api/platform/session') body = auth;
    else if (path === '/api/application/office') body = { data: office, revision: 1 };
    else if (path === '/api/environment/session' || path === '/api/environment/demo-session') body = { csrfToken: 'env-csrf', actualUserId: user.id, effectiveUserId: user.id };
    else if (path.includes('/environment/sources/')) body = { sourceId: String(cardId), revision: 1, sites: [], classifications: [], storagePolicies: [], reports: [], reportHistory: [], inventory: [] };
    else if (path.endsWith(`/payments/cards/${cardId}/prepare`)) body = { cardId, source, sourceSnapshotHash: source.hash, amount: 125, amountCents: 12500, currency: 'SEK', originalPaymentDetails: card.paymentDetails,
      paymentDetails: { ...card.paymentDetails, personalNumber: customer.number }, customer, canStart: false, canInitiate: true, issues: ['Välj Swish för testet.'], simulation: true, mode: 'mss', existingJob: job ?? null, settings: { enabled: true }, configuration: { ready: true, mode: 'mss' } };
    else if (path.endsWith(`/payments/cards/${cardId}`)) body = job ? [job] : [];
    else if (path === '/api/environment/payments' && request.method() === 'POST') {
      starts += 1;
      const input = request.postDataJSON() as { paymentDetails: SwishPaymentJob['paymentDetails']; reason?: string }; startsPayload.push(input);
      job = { id: starts === 1 ? 'test-payout-job' : 'test-payout-job-2', kind: 'card', source, sourceSnapshotHash: source.hash, amount: 125, amountCents: 12500, currency: 'SEK', mode: 'mss', simulation: true,
        status: 'pending', bookkeepingStatus: 'pending', paymentDetails: input.paymentDetails, originalPaymentDetails: card.paymentDetails, reason: input.reason,
        createdAt: '2026-10-13T08:01:00Z', updatedAt: '2026-10-13T08:01:00Z', providerInstructionUUID: 'test-instruction', events: [],
        request: { method: 'POST', path: '/payouts', payload: { amount: '125.00', payeeAlias: '46701234567' } }, response: { httpStatus: 201, data: { status: 'ACCEPTED' } } };
      if (options.lostStartResponse) return route.abort('failed');
      body = job;
    } else if (path.includes('/payments/test-payout-job')) body = job;
    else if (path === '/api/terminal-demo/state') body = { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] };
    else if (path === '/api/terminal-demo/staff-session') body = { authenticated: true };
    else if (path === '/api/terminal-demo/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    else if (path === '/api/pricing/state') body = { version: 'test', revision: 1, memoryOnly: true, asOfDate: '2026-10-13', metals: [], articles: [], customers: [] };
    else if (path.endsWith('/summary')) body = { workOrders: 0, warehouse: 0, vessels: 0 };
    else if (path.includes('/accounting/cards/')) body = { export: null };
    else { status = 503; body = { error: 'Optional service unavailable in payout UI fixture' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { cardId, starts: () => starts, startsPayload, requests, reject: () => {
    if (job) job = { ...job, status: 'rejected', updatedAt: '2026-10-13T08:02:00Z', response: { httpStatus: 400, data: { errorCode: 'RF07' } } };
  }, unknown: () => { if (job) job = { ...job, status: 'unknown', updatedAt: '2026-10-13T08:02:00Z' }; }, confirm: () => {
    if (job) job = { ...job, status: 'simulated_paid', bookkeepingStatus: 'registered', verifiedAt: '2026-10-13T08:02:00Z', updatedAt: '2026-10-13T08:02:00Z', response: { httpStatus: 200, data: { status: 'PAID' } } };
  } };
}

async function fillPayout(page: Page) {
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  const dialog = page.locator('.swish-payout-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Swish', exact: true }).click();
  await dialog.getByLabel('Telefonnummer', { exact: true }).fill('0701234567');
  await expect(dialog.getByLabel('Mottagarens personnummer')).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toBeDisabled();
  await dialog.getByLabel('Orsak till ändrade betalningsuppgifter').fill('Kunden vill använda Swish i detta test.');
  return dialog;
}

test('attesterat belopp och kundidentitet låses; ändring kräver orsak och HTTP 201 blir inte betaldstatus', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await expect(dialog).toContainText('125,00');
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).dblclick();
  await expect(page.locator('.nvv-check-dialog')).toBeVisible();
  await expect(page.locator('.nvv-check-dialog')).toContainText('HTTP 201');
  await expect(page.locator('.nvv-check-dialog')).toHaveClass(/is-running/);
  expect(state.starts()).toBe(1);
  expect(state.startsPayload[0]).toMatchObject({ source: { approvalId: 'payment-approval', version: 1, hash: 'payment-source-hash' }, paymentDetails: { method: 'swish', phone: '+46701234567', personalNumber: '199001011239' }, reason: 'Kunden vill använda Swish i detta test.' });
  state.confirm();
  await expect(page.locator('.nvv-check-dialog')).toHaveClass(/is-success/);
  await page.locator('.nvv-check-dialog').getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.locator('.swish-payment-panel')).toContainText('Swish MSS har bekräftat testutbetalningen');
  await expect(page.locator('.swish-payment-panel')).toContainText('Betalningen är registrerad i Spiris sandbox');
  expect(state.starts()).toBe(1);
});

test('förlorat startsvar ger återläsning av sparat jobb, aldrig automatisk dubbelsändning', async ({ page }) => {
  const state = await fixture(page, { lostStartResponse: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  await expect(dialog).toContainText('Testet kan ha sparats');
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toHaveCount(0);
  state.unknown();
  await dialog.getByRole('button', { name: 'Kontrollera sparat test', exact: true }).click();
  await expect(page.locator('.nvv-check-dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rätta uppgifter och gör nytt test', exact: true })).toHaveCount(0);
  expect(state.starts()).toBe(1);
});

test('en definitiv avvisning kan rättas med ett uttryckligt nytt försök kopplat till det tidigare jobbet', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  state.reject();
  await page.getByRole('button', { name: 'Rätta uppgifter och gör nytt test', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Telefonnummer', { exact: true }).fill('0707654321');
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  await expect(page.locator('.nvv-check-dialog')).toBeVisible();
  expect(state.starts()).toBe(2);
  expect(state.startsPayload[1]).toMatchObject({ retryOf: 'test-payout-job', paymentDetails: { phone: '+46707654321' } });
});

test('användare utan utbetalningsbehörighet ser inga betalningsåtgärder eller jobbuppgifter', async ({ page }) => {
  const state = await fixture(page, { restricted: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await expect(page.getByRole('heading', { name: `Invägning #${state.cardId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true })).toHaveCount(0);
  await expect(page.locator('.swish-payment-panel')).toHaveCount(0);
  expect(state.requests.filter(path => path.startsWith('/api/environment/payments'))).toHaveLength(0);
});
