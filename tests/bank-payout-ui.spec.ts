import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { BankPaymentJob } from '../src/office/bank-payments-client';

test.use({ viewport: { width: 1280, height: 900 } });

async function fixture(page: Page, options: { booked?: boolean; lostStart?: boolean; restricted?: boolean; unsafeSignLink?: boolean; queuedStart?: boolean } = {}) {
  const office = migrateOffice(seedOffice()), cardId = 61800;
  const originalUser = office.users.find(user => user.id === 'admin')!;
  const user: OfficeUser = options.restricted ? { ...originalUser, level: 'Medarbetare', permissions: ['view'], maxAttest: 0 } : originalUser;
  const customer = { ...office.customers.find(value => value.type === 'Privatperson')!, name: 'Banktestkund', number: '199001011239' };
  const payment = { method: 'bank' as const, bankType: 'account' as const, clearing: '8327', account: '1234567890', holder: customer.name, bank: 'Testbank' };
  const card: OfficeCard = { ...structuredClone(office.cards[0]), id: cardId, status: 'ready', siteId: 'norrtalje', customerId: customer.id,
    customerSnapshot: customer, paymentDetails: payment, payment: 'Banköverföring',
    customerApproval: { id: 'bank-approval', version: 1, status: 'attested', updatedAt: '2026-10-13T08:00:00Z', attestedAt: '2026-10-13T08:00:00Z' }, audit: [] };
  office.cards = [card]; office.users = [user]; office.customers = [customer];
  const company = { id: 'bank-ui-company', name: 'Banktest AB', organisationNumber: '5560000000', status: 'active' };
  const auth = { enabled: true, authenticated: true, actor: { id: 'bank-ui-actor', name: user.name, username: user.id, platformAdmin: false }, actualUser: user, user,
    company, organisationId: company.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'bank-ui-csrf', generation: 1, companies: [company] };
  const source = { cardId, approvalId: 'bank-approval', version: 1, hash: 'bank-source-proof', siteId: 'norrtalje', customerId: customer.id, customerName: customer.name, customerType: customer.type };
  let job: BankPaymentJob | undefined, starts = 0, authorisations = 0, refreshes = 0;
  const requests: { path: string; method: string }[] = [], payloads: unknown[] = [];
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push({ path, method: request.method() });
    let body: unknown = {}, status = 200;
    if (path === '/api/platform/session') body = auth;
    else if (path === '/api/application/office') body = { data: office, revision: 1 };
    else if (path === '/api/environment/session' || path === '/api/environment/demo-session') body = { csrfToken: 'bank-env-csrf', actualUserId: user.id, effectiveUserId: user.id };
    else if (path.includes('/environment/sources/')) body = { sourceId: String(cardId), revision: 1, sites: [], classifications: [], storagePolicies: [], reports: [], reportHistory: [], inventory: [] };
    else if (path.endsWith(`/bank/payments/cards/${cardId}/prepare`)) body = {
      cardId, source, amount: 240, amountCents: 24000, currency: 'SEK', originalPaymentDetails: payment, paymentDetails: payment,
      customer, canStart: options.booked !== false, canInitiate: options.booked !== false, issues: options.booked === false ? ['Bokför underlaget i Spiris före utbetalning.'] : [],
      existingJob: job ?? null, settings: { enabled: true }, configuration: { ready: true }, mode: 'sandbox', simulation: true,
    };
    else if (path.endsWith(`/bank/payments/cards/${cardId}`)) body = job ? [job] : [];
    else if (path === '/api/environment/bank/payments' && request.method() === 'POST') {
      starts += 1; const input = request.postDataJSON() as { paymentDetails: BankPaymentJob['paymentDetails']; reason?: string }; payloads.push(input);
      job = { id: 'bank-ui-job', kind: 'card', source, amount: 240, amountCents: 24000, currency: 'SEK', mode: 'sandbox', simulation: true,
        paymentDetails: input.paymentDetails, originalPaymentDetails: payment, reason: input.reason, status: options.queuedStart ? 'queued' : 'awaiting_authorization', bookkeepingStatus: 'not_requested',
        createdAt: '2026-10-13T08:01:00Z', updatedAt: '2026-10-13T08:01:00Z', canAuthorise: !options.queuedStart, error: null,
        request: { method: 'POST', path: '/payments/domestic', payload: { creditorAccount: { iban: 'SE4550000000058398257466' }, creditorName: customer.name, token: 'never-share-this' } }, response: { httpStatus: 201, data: { transactionStatus: 'RCVD' } }, events: [] };
      if (options.lostStart) return route.abort('failed');
      body = job;
    } else if (path.endsWith('/bank/payments/bank-ui-job/authorise') && request.method() === 'POST') {
      authorisations += 1;
      if (job) job = { ...job, authorisationUrl: options.unsafeSignLink ? 'javascript:alert("unsafe")' : 'https://sandbox.openpayments.io/sign/test', canAuthorise: false, updatedAt: '2026-10-13T08:02:00Z' };
      body = job;
    } else if (path.endsWith('/bank/payments/bank-ui-job/refresh') && request.method() === 'POST') { refreshes += 1; body = job; }
    else if (path.endsWith('/bank/payments/bank-ui-job')) body = job;
    else if (path.includes('/environment/payments/cards/')) body = [];
    else if (path === '/api/terminal-demo/state') body = { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] };
    else if (path === '/api/terminal-demo/staff-session') body = { authenticated: true };
    else if (path === '/api/terminal-demo/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    else if (path === '/api/pricing/state') body = { version: 'test', revision: 1, memoryOnly: true, asOfDate: '2026-10-13', metals: [], articles: [], customers: [] };
    else if (path.endsWith('/summary')) body = { workOrders: 0, warehouse: 0, vessels: 0 };
    else if (path.includes('/accounting/cards/') && path.endsWith('/booking')) body = { cardId, status: options.booked === false ? 'draft' : 'booked', invoiceId: 'bank-ui-invoice', voucherNumber: options.booked === false ? undefined : 'A2', canBook: options.booked === false, canRefresh: true };
    else if (path.includes('/accounting/cards/')) body = { export: null };
    else { status = 503; body = { error: 'Optional service unavailable in bank UI fixture' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { cardId, requests, payloads, starts: () => starts, authorisations: () => authorisations, refreshes: () => refreshes,
    holdDispatch: () => { if (job) job = { ...job, status: 'in_flight', canAuthorise: false, updatedAt: '2026-10-13T08:01:10Z' }; },
    awaitAuthorisation: () => { if (job) job = { ...job, status: 'awaiting_authorization', canAuthorise: true, updatedAt: '2026-10-13T08:01:20Z' }; },
    confirm: () => { if (job) job = { ...job, status: 'simulated_paid', bookkeepingStatus: 'registered', error: null,
      verifiedAt: '2026-10-13T08:03:00Z', updatedAt: '2026-10-13T08:03:00Z', providerPaymentReference: 'BANK-TEST-240' }; } };
}

test('bankknappen kräver bekräftad bokföring och läsning skickar ingen betalning', async ({ page }) => {
  const state = await fixture(page, { booked: false });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await expect(page.locator('.bank-payment-panel')).toContainText('Bokför underlaget i Spiris före utbetalningen.');
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true }).first()).toBeDisabled();
  expect(state.starts()).toBe(0);
  expect(state.requests.filter(request => request.method !== 'GET' && request.path.startsWith('/api/environment/bank/payments'))).toHaveLength(0);
});

test('låst bankmottagare kan redigeras med orsak; godkännande och ACSC-bekräftelse är separata steg', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  const dialog = page.locator('.bank-payout-dialog');
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('240,00');
  await expect(dialog.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Redigera', exact: true }).click();
  await dialog.getByLabel('Kontonummer', { exact: true }).fill('1234567801');
  await expect(dialog.getByRole('button', { name: 'Testa bankutbetalning', exact: true })).toBeDisabled();
  await dialog.getByLabel('Orsak till ändrade betalningsuppgifter').fill('Rättat mottagarkonto efter kontroll.');
  await dialog.getByRole('button', { name: 'Testa bankutbetalning', exact: true }).dblclick();
  await expect(dialog).toContainText('Inväntar godkännande i testbanken');
  await expect(dialog).not.toHaveClass(/is-success/);
  expect(state.starts()).toBe(1); expect(state.authorisations()).toBe(0);
  await dialog.getByText('Avancerat', { exact: true }).click();
  await expect(dialog.locator('pre')).toContainText('201');
  await expect(dialog.locator('pre')).not.toContainText('never-share-this');
  await expect(dialog.locator('pre')).not.toContainText('SE4550000000058398257466');
  await dialog.getByRole('button', { name: 'Uppdatera betalstatus', exact: true }).click();
  expect(state.authorisations()).toBe(0); expect(state.starts()).toBe(1);
  await dialog.getByRole('button', { name: 'Förbered bankens godkännande', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Öppna testbankens godkännande', exact: true })).toHaveAttribute('href', 'https://sandbox.openpayments.io/sign/test');
  expect(state.authorisations()).toBe(1);
  state.confirm(); await expect(dialog).toHaveClass(/is-success/);
  await expect(dialog).toContainText('Testbetalningen är registrerad i Spiris sandbox');
  expect(state.starts()).toBe(1); expect(errors).toEqual([]);
  expect(state.payloads[0]).toMatchObject({ source: { approvalId: 'bank-approval', version: 1, hash: 'bank-source-proof' }, reason: 'Rättat mottagarkonto efter kontroll.' });
});

test('förlorat startsvar återhämtar befintlig bankinstruktion utan dubbelsändning och exekverbara länkar visas inte', async ({ page }) => {
  const state = await fixture(page, { lostStart: true, unsafeSignLink: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  const dialog = page.locator('.bank-payout-dialog');
  await dialog.getByRole('button', { name: 'Testa bankutbetalning', exact: true }).click();
  await expect(dialog).toContainText('Betalningen kan ha sparats');
  await dialog.getByRole('button', { name: 'Kontrollera sparad instruktion', exact: true }).click();
  await expect(dialog).toContainText('Inväntar godkännande i testbanken');
  await dialog.getByRole('button', { name: 'Förbered bankens godkännande', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Öppna testbankens godkännande', exact: true })).toHaveCount(0);
  expect(state.starts()).toBe(1);
});

test('användare utan utbetalningsbehörighet läser inga bankinstruktioner', async ({ page }) => {
  const state = await fixture(page, { restricted: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await expect(page.getByRole('heading', { name: `Invägning #${state.cardId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true })).toHaveCount(0);
  expect(state.requests.filter(request => request.path.startsWith('/api/environment/bank/payments'))).toHaveLength(0);
});

test('in_flight från arbetaren fortsätter visas och pollas utan ny instruktion före bankens godkännande', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const state = await fixture(page, { queuedStart: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  const dialog = page.locator('.bank-payout-dialog');
  await dialog.getByRole('button', { name: 'Testa bankutbetalning', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Banktestet är köat', exact: true })).toBeVisible();
  state.holdDispatch();
  await expect(dialog.getByRole('heading', { name: 'Skickar till testbanken', exact: true })).toBeVisible();
  await expect(dialog).toHaveClass(/is-running/);
  await expect(dialog.getByRole('button', { name: 'Testa bankutbetalning', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Rätta uppgifter och gör nytt test', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Förbered bankens godkännande', exact: true })).toHaveCount(0);
  await expect(dialog.locator('.bank-payout-steps li').nth(1)).not.toHaveClass(/is-complete/);
  state.awaitAuthorisation();
  await expect(dialog.getByRole('heading', { name: 'Inväntar godkännande i testbanken', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Förbered bankens godkännande', exact: true })).toBeEnabled();
  expect(state.starts()).toBe(1); expect(state.authorisations()).toBe(0); expect(errors).toEqual([]);
});
