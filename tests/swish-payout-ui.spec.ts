import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { SwishPaymentJob } from '../src/office/swish-payments-client';

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
async function fixture(page: Page, options: { lostStartResponse?: boolean; restricted?: boolean; blockedStart?: boolean } = {}) {
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
  let job: SwishPaymentJob | undefined, starts = 0, resumes = 0;
  let previousJobs: SwishPaymentJob[] = [], spirisTrace = false;
  const paymentWrites: string[] = [], bankWrites: string[] = [];
  const requests: string[] = [], startsPayload: Record<string, unknown>[] = [];
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    requests.push(path);
    if (request.method() === 'POST' && path.startsWith('/api/environment/payments')) paymentWrites.push(path);
    if (request.method() === 'POST' && path.startsWith('/api/environment/bank/payments')) bankWrites.push(path);
    let body: unknown = {}, status = 200;
    if (path === '/api/platform/session') body = auth;
    else if (path === '/api/application/office') body = { data: office, revision: 1 };
    else if (path === '/api/environment/session' || path === '/api/environment/demo-session') body = { csrfToken: 'env-csrf', actualUserId: user.id, effectiveUserId: user.id };
    else if (path.includes('/environment/sources/')) body = { sourceId: String(cardId), revision: 1, sites: [], classifications: [], storagePolicies: [], reports: [], reportHistory: [], inventory: [] };
    else if (path.endsWith(`/bank/payments/cards/${cardId}/prepare`)) body = { cardId, source, amount: 125, amountCents: 12500, currency: 'SEK', originalPaymentDetails: card.paymentDetails,
      paymentDetails: card.paymentDetails, customer, canStart: false, canInitiate: false, issues: ['Bankkopplingen är inte aktiverad.'], simulation: true, mode: 'sandbox', existingJob: null, settings: { enabled: false }, configuration: { ready: false } };
    else if (path.startsWith('/api/environment/bank/payments')) body = [];
    else if (path.endsWith(`/payments/cards/${cardId}/prepare`)) body = { cardId, source, sourceSnapshotHash: source.hash, amount: 125, amountCents: 12500, currency: 'SEK', originalPaymentDetails: card.paymentDetails,
      paymentDetails: { ...card.paymentDetails, personalNumber: customer.number }, customer, canStart: false, canInitiate: true, issues: ['Välj Swish för testet.'], simulation: true, mode: 'mss', existingJob: job ?? null, settings: { enabled: true }, configuration: { ready: true, mode: 'mss' } };
    else if (path.endsWith(`/payments/cards/${cardId}`)) body = job ? [job, ...previousJobs] : [];
    else if (path === '/api/environment/payments' && request.method() === 'POST') {
      starts += 1;
      const input = request.postDataJSON() as { paymentDetails: SwishPaymentJob['paymentDetails']; reason?: string }; startsPayload.push(input);
      job = { id: starts === 1 ? 'test-payout-job' : 'test-payout-job-2', kind: 'card', source, sourceSnapshotHash: source.hash, amount: 125, amountCents: 12500, currency: 'SEK', mode: 'mss', simulation: true,
        status: 'pending', bookkeepingStatus: 'pending', paymentDetails: input.paymentDetails, originalPaymentDetails: card.paymentDetails, reason: input.reason,
        createdAt: '2026-10-13T08:01:00Z', updatedAt: '2026-10-13T08:01:00Z', providerInstructionUUID: 'test-instruction', events: [],
        request: { method: 'POST', path: '/payouts', payload: { amount: '125.00', payeeAlias: '46701234567', payeeSSN: customer.number, signature: 'signature-for-test' } }, response: { httpStatus: 201, data: { status: 'ACCEPTED' } } };
      if (options.lostStartResponse) return route.abort('failed');
      if (options.blockedStart) job = { ...job, status: 'blocked', canResume: false, response: undefined,
        error: { code: 'accounting_amount_invalid', message: 'Beloppsfältet Rows[1].CreditAmount i Spiris kunde inte kontrolleras.',
          details: { provider: 'spiris', field: 'Rows[1].CreditAmount', valueType: 'number' } } };
      body = job;
    } else if (path.endsWith('/payments/test-payout-job/refresh') && request.method() === 'POST') {
      if (job?.status === 'blocked') job = { ...job, canResume: true, preflightStatus: 'ready', error: null,
        preflightCheckedAt: '2026-10-13T08:02:00Z', updatedAt: '2026-10-13T08:02:00Z' };
      body = job;
    } else if (path.endsWith('/payments/test-payout-job/resume') && request.method() === 'POST') {
      resumes += 1;
      if (job) job = { ...job, status: 'pending', canResume: false, preflightStatus: undefined, updatedAt: '2026-10-13T08:03:00Z' };
      body = job;
    } else if (path.includes('/payments/test-payout-job')) body = job;
    else if (path === '/api/terminal-demo/state') body = { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] };
    else if (path === '/api/terminal-demo/staff-session') body = { authenticated: true };
    else if (path === '/api/terminal-demo/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    else if (path === '/api/pricing/state') body = { version: 'test', revision: 1, memoryOnly: true, asOfDate: '2026-10-13', metals: [], articles: [], customers: [] };
    else if (path.endsWith('/summary')) body = { workOrders: 0, warehouse: 0, vessels: 0 };
    else if (path.includes('/accounting/cards/') && path.endsWith('/booking')) body = { cardId, status: 'booked', invoiceId: 'booked-invoice', voucherNumber: 'A1', canBook: false, canRefresh: true };
    else if (path.includes('/accounting/cards/')) body = { export: spirisTrace ? {
      id: 'trace-spiris-export', cardId, approvalId: source.approvalId, version: 1, status: 'accepted',
      tracking: { state: 'booked', invoiceId: 'trace-invoice', voucherNumber: 'A1' },
      events: [{ id: 'draft-created', type: 'draft_created', at: '2026-10-13T07:59:00Z', text: 'Fakturautkast skapat i Spiris' },
        { id: 'booked', type: 'booked', at: '2026-10-13T08:00:00Z', text: 'Bokförd i Spiris' }],
    } : null };
    else { status = 503; body = { error: 'Optional service unavailable in payout UI fixture' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { cardId, starts: () => starts, resumes: () => resumes, startsPayload, requests, paymentWrites, bankWrites,
    originalPayment: () => structuredClone(card.paymentDetails),
    seedPaymentHistory: () => {
      spirisTrace = true;
      const saved: SwishPaymentJob = { id: 'trace-latest', kind: 'card', source, amount: 125, amountCents: 12500,
        currency: 'SEK', mode: 'mss', simulation: true, status: 'simulated_paid', bookkeepingStatus: 'registered', error: null,
        paymentDetails: { method: 'swish', phone: '+46701234567', recipient: customer.name },
        createdAt: '2026-10-13T08:04:00Z', updatedAt: '2026-10-13T08:07:00Z', providerPaymentReference: 'SWISH-TRACE-125',
        reservedBy: { actualUserId: 'historic-finance', effectiveUserId: 'historic-finance', actualUserName: 'Historisk ekonom', effectiveUserName: 'Historisk ekonom' },
        events: [
          { id: 'reserved-2', action: 'payment_reserved', at: '2026-10-13T08:04:00Z', actualUserId: 'historic-finance', effectiveUserId: 'historic-finance' },
          { id: 'blocked-2', action: 'payment_blocked', at: '2026-10-13T08:04:10Z', actualUserId: 'service:swish',
            error: { message: 'Den ursprungliga kontrollen stoppade försöket.' } },
          { id: 'resumed-2', action: 'payment_resumed', at: '2026-10-13T08:04:30Z', actualUserId: 'historic-finance', effectiveUserId: 'historic-finance' },
          { id: 'sent-2', action: 'payment_sent', at: '2026-10-13T08:05:00Z', actualUserId: 'service:swish' },
          { id: 'unknown-2', action: 'payment_outcome_unknown', at: '2026-10-13T08:05:30Z', actualUserId: 'service:swish', text: 'Slutresultatet kunde ännu inte bekräftas.' },
          { id: 'paid-2', action: 'payment_simulated_paid', at: '2026-10-13T08:06:00Z', actualUserId: 'service:swish' },
          { id: 'registered-2', action: 'payment_bookkeeping_updated', status: 'registered', at: '2026-10-13T08:07:00Z', actualUserId: 'service:swish' },
        ] };
      const rejection = { id: 'rejected-1', action: 'payment_rejected', at: '2026-10-13T08:03:00Z', actualUserId: 'service:swish', text: 'Testmottagaren avvisades av Swish.' };
      previousJobs = [{ ...saved, id: 'trace-earlier', status: 'rejected', bookkeepingStatus: 'not_requested', providerPaymentReference: undefined,
        createdAt: '2026-10-13T08:01:00Z', updatedAt: '2026-10-13T08:03:00Z', events: [
          { action: 'payment_reserved', at: '2026-10-13T08:01:00Z', actualUserId: 'historic-finance', effectiveUserId: 'historic-finance' },
          { id: 'sent-1', action: 'payment_sent', at: '2026-10-13T08:02:00Z', actualUserId: 'service:swish' },
          rejection, { ...rejection },
        ] }];
      job = saved;
    }, reject: () => {
    if (job) job = { ...job, status: 'rejected', updatedAt: '2026-10-13T08:02:00Z', response: { httpStatus: 400, data: { errorCode: 'RF07' } } };
  }, unknown: () => { if (job) job = { ...job, status: 'unknown', updatedAt: '2026-10-13T08:02:00Z' }; }, confirm: (bookkeepingStatus: SwishPaymentJob['bookkeepingStatus'] = 'registered') => {
    if (job) job = { ...job, status: 'simulated_paid', bookkeepingStatus, verifiedAt: '2026-10-13T08:02:00Z', updatedAt: '2026-10-13T08:02:00Z', response: { httpStatus: 200, data: { status: 'PAID' } } };
  } };
}

async function fillPayout(page: Page) {
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  await expect(page.locator('.bank-payout-dialog')).toBeVisible();
  await page.locator('.bank-payout-dialog').getByRole('button', { name: 'Byt till Swish', exact: true }).click();
  const dialog = page.locator('.swish-payout-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Telefonnummer', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Redigera', exact: true }).click();
  await dialog.getByRole('button', { name: 'Swish', exact: true }).click();
  await dialog.getByLabel('Telefonnummer', { exact: true }).fill('0701234567');
  await expect(dialog.getByLabel('Mottagarens personnummer')).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toBeDisabled();
  await dialog.getByLabel('Orsak till ändrade betalningsuppgifter').fill('Kunden vill använda Swish i detta test.');
  return dialog;
}

test('ett bankvalt attestoriginal kan uttryckligen betalas med Swish med orsak utan att bankinstruktion eller attestoriginal ändras', async ({ page }) => {
  const state = await fixture(page), original = state.originalPayment();
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await page.getByRole('button', { name: 'Betala ut', exact: true }).first().click();
  const bankDialog = page.locator('.bank-payout-dialog');
  await expect(bankDialog).toBeVisible();
  await expect(bankDialog).toContainText('Bankkopplingen är inte aktiverad.');
  await bankDialog.getByRole('button', { name: 'Byt till Swish', exact: true }).click();
  const dialog = page.locator('.swish-payout-dialog'); await expect(dialog).toBeVisible();
  await expect(dialog.locator('.swish-payout-locked-details')).toContainText('1234567890');
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Redigera', exact: true }).click();
  await dialog.getByRole('button', { name: 'Swish', exact: true }).click();
  await dialog.getByLabel('Telefonnummer', { exact: true }).fill('0701234567');
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toBeDisabled();
  expect(state.starts()).toBe(0); expect(state.bankWrites).toEqual([]); expect(state.originalPayment()).toEqual(original);
  await dialog.getByLabel('Orsak till ändrade betalningsuppgifter').fill('Kunden önskar Swish istället för banköverföring.');
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  const progress = page.locator('.swish-payout-progress-dialog'); await expect(progress).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Byt till banköverföring', exact: true })).toHaveCount(0);
  expect(state.starts()).toBe(1); expect(state.bankWrites).toEqual([]); expect(state.originalPayment()).toEqual(original);
  expect(state.startsPayload[0]).toMatchObject({ source: { approvalId: 'payment-approval', version: 1, hash: 'payment-source-hash' },
    paymentDetails: { method: 'swish', phone: '+46701234567' }, reason: 'Kunden önskar Swish istället för banköverföring.' });
});

test('attesterat belopp och kundidentitet låses; ändring kräver orsak och HTTP 201 blir inte betaldstatus', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await expect(dialog).toContainText('125,00');
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).dblclick();
  const progress = page.locator('.swish-payout-progress-dialog');
  await expect(progress).toBeVisible();
  await expect(progress).toHaveClass(/is-running/);
  await expect(progress.getByRole('heading', { name: 'Väntar på bekräftelse', exact: true })).toBeVisible();
  await expect(progress.locator('pre')).not.toBeVisible();
  await progress.getByText('Avancerat', { exact: true }).click();
  await expect(progress.locator('pre')).toContainText('201');
  await expect(progress.locator('pre')).not.toContainText('46701234567');
  await expect(progress.locator('pre')).not.toContainText('199001011239');
  await expect(progress.locator('pre')).not.toContainText('signature-for-test');
  expect(state.starts()).toBe(1);
  expect(state.startsPayload[0]).toMatchObject({ source: { approvalId: 'payment-approval', version: 1, hash: 'payment-source-hash' }, paymentDetails: { method: 'swish', phone: '+46701234567', personalNumber: '199001011239' }, reason: 'Kunden vill använda Swish i detta test.' });
  state.confirm();
  await expect(progress).toHaveClass(/is-success/);
  await progress.getByRole('button', { name: 'Klart', exact: true }).click();
  await expect(page.locator('.swish-payment-panel')).toContainText('Swish MSS har bekräftat testutbetalningen');
  await expect(page.locator('.swish-payment-panel')).toContainText('Betalningen är registrerad i Spiris sandbox');
  expect(state.starts()).toBe(1);
});

test('förlorat startsvar ger återläsning av sparat jobb, aldrig automatisk dubbelsändning', async ({ page }) => {
  const state = await fixture(page, { lostStartResponse: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  const progress = page.locator('.swish-payout-progress-dialog');
  await expect(progress).toContainText('Testet kan ha sparats');
  await expect(progress.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toHaveCount(0);
  state.unknown();
  await progress.getByRole('button', { name: 'Kontrollera sparat test', exact: true }).click();
  await expect(progress).toBeVisible();
  await expect(progress).toHaveClass(/is-unknown/);
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
  await dialog.getByRole('button', { name: 'Redigera', exact: true }).click();
  await dialog.getByLabel('Telefonnummer', { exact: true }).fill('0707654321');
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  await expect(page.locator('.swish-payout-progress-dialog')).toBeVisible();
  expect(state.starts()).toBe(2);
  expect(state.startsPayload[1]).toMatchObject({ retryOf: 'test-payout-job', paymentDetails: { phone: '+46707654321' } });
});

test('uppgifterna börjar låsta och avbruten redigering återställer förberedda uppgifter utan att skicka', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Avbryt redigering', exact: true }).click();
  await expect(dialog.locator('.swish-payout-locked-details')).toContainText('Testbank');
  await expect(dialog.locator('.swish-payout-locked-details')).toContainText('1234567890');
  await expect(dialog.getByRole('button', { name: 'Swish', exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Orsak till ändrade betalningsuppgifter')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true })).toBeDisabled();
  expect(state.starts()).toBe(0);
});

test('blockerat test får detaljerad diagnos och statuskontroll kräver separat fortsättknapp', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const state = await fixture(page, { blockedStart: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  const progress = page.locator('.swish-payout-progress-dialog');
  await expect(progress).toContainText('Rows[1].CreditAmount');
  await progress.getByText('Avancerat', { exact: true }).click();
  await expect(progress.locator('pre')).toContainText('"provider": "spiris"');
  await expect(progress.getByRole('button', { name: 'Fortsätt testutbetalning', exact: true })).toHaveCount(0);
  await progress.getByRole('button', { name: 'Kontrollera status', exact: true }).click();
  await expect(progress.getByRole('heading', { name: 'Kontrollen är godkänd', exact: true })).toBeVisible();
  expect(state.resumes()).toBe(0); expect(state.starts()).toBe(1);
  await progress.getByRole('button', { name: 'Stäng', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: `Invägning #${state.cardId}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Visa utbetalning', exact: true }).first().click();
  await expect(progress.getByRole('heading', { name: 'Kontrollen är godkänd', exact: true })).toBeVisible();
  await progress.getByText('Avancerat', { exact: true }).click();
  await expect(progress.locator('pre')).toContainText('"code": null');
  await progress.getByRole('button', { name: 'Fortsätt testutbetalning', exact: true }).dblclick();
  await expect(progress.getByRole('heading', { name: 'Väntar på bekräftelse', exact: true })).toBeVisible();
  expect(state.resumes()).toBe(1); expect(state.starts()).toBe(1);
  await expect(progress.locator('pre')).toContainText('"paymentId": "test-payout-job"');
  expect(pageErrors).toEqual([]);
});

test('bekräftad Swish-betalning fortsätter visas som genomförd när separat bokföring behöver åtgärdas', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const dialog = await fillPayout(page);
  await dialog.getByRole('button', { name: 'Testa Swish-utbetalning', exact: true }).click();
  state.confirm('blocked');
  const progress = page.locator('.swish-payout-progress-dialog');
  await expect(progress).toHaveClass(/is-success/);
  await expect(progress.getByRole('heading', { name: 'Testutbetalning genomförd', exact: true })).toBeVisible();
  await expect(progress).toContainText('Endast bokföringen behöver följas upp');
  await expect(progress.getByRole('button', { name: 'Rätta uppgifter och gör nytt test', exact: true })).toHaveCount(0);
  expect(state.starts()).toBe(1);
});

test('användare utan utbetalningsbehörighet ser inga betalningsåtgärder eller jobbuppgifter', async ({ page }) => {
  const state = await fixture(page, { restricted: true });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  await expect(page.getByRole('heading', { name: `Invägning #${state.cardId}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true })).toHaveCount(0);
  await expect(page.locator('.swish-payment-panel')).toHaveCount(0);
  expect(state.requests.filter(path => path.startsWith('/api/environment/payments'))).toHaveLength(0);
});

test('spårbarhet visar sparade Swish-försök mellan Spiris-händelser utan nya betalningsanrop', async ({ page }) => {
  const state = await fixture(page); state.seedPaymentHistory();
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const trace = page.locator('.office-card-audit .office-audit');
  await expect(trace).toContainText('Testbetalning registrerad i Spiris sandbox');
  const titles = [
    'Testbetalning registrerad i Spiris sandbox', 'Testutbetalning genomförd · Swish MSS',
    'Utbetalningens resultat behöver kontrolleras', 'Utbetalning skickas till Swish MSS',
    'Samma testutbetalning återupptagen', 'Testutbetalning stoppad', 'Testutbetalning påbörjad · Swish MSS',
    'Swish MSS avvisade testutbetalningen', 'Utbetalning skickas till Swish MSS',
    'Testutbetalning påbörjad · Swish MSS', 'Bokförd i Spiris', 'Fakturautkast skapat i Spiris',
  ];
  await expect(trace.locator('li > div > strong')).toHaveText(titles);
  await expect(trace).toContainText('Historisk ekonom');
  await expect(trace).toContainText('SWISH-TRACE-125');
  await expect(trace).toContainText('Testmottagaren avvisades av Swish.');
  await expect(trace).toContainText('Den ursprungliga kontrollen stoppade försöket.');
  await trace.getByRole('button', { name: 'Visa utbetalningshistorik', exact: true }).first().click();
  await expect(page.locator('.swish-payment-history')).toHaveAttribute('open', '');
  await page.evaluate(cardId => window.dispatchEvent(new CustomEvent('scrappilot:payment-change', {
    detail: { cardId, identity: 'admin/admin' },
  })), state.cardId);
  await expect(trace.locator('li > div > strong')).toHaveText(titles);
  await page.reload();
  await expect(trace.locator('li > div > strong')).toHaveText(titles);
  expect(state.starts()).toBe(0); expect(state.resumes()).toBe(0); expect(state.paymentWrites).toEqual([]);
});
