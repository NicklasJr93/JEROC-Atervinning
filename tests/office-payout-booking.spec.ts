import { expect, test, type Page } from '@playwright/test';
import { seedOffice, type OfficeCard } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { TerminalApproval } from '../src/office/terminal-demo-types';
import type { SpirisCardBooking } from '../src/office/booking-client';
import type { SwishPaymentJob } from '../src/office/swish-payments-client';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
async function fixture(page: Page, options: { status?: 'ready' | 'attest'; bookingPermission?: boolean } = {}) {
  const office = migrateOffice(seedOffice()), cardId = 61207;
  const user = { ...office.users.find(value => value.id === 'admin')!, level: options.bookingPermission === false ? 'VD' as const : 'Systemadmin' as const,
    permissions: office.users.find(value => value.id === 'admin')!.permissions.filter(value => options.bookingPermission !== false || value !== 'bookSpiris') };
  const customer = { ...office.customers.find(value => value.type === 'Privatperson')!, name: 'Bokföringstest', number: '199001011239' };
  const card: OfficeCard = { ...structuredClone(office.cards[0]), id: cardId, status: options.status ?? 'ready', siteId: 'norrtalje', customerId: customer.id,
    customerSnapshot: customer, origin: 'Testgatan 1, 761 41 Norrtälje', paymentDetails: { method: 'bank', bank: 'Originalbank', clearing: '8327', account: '1234567890', holder: customer.name }, payment: 'Bankkonto',
    preparedBy: 'another-user', approvedBy: options.status === 'attest' ? undefined : user.id,
    customerApproval: { id: 'booking-approval', version: 1, status: options.status === 'attest' ? 'approved' : 'attested', updatedAt: '2026-10-13T08:00:00Z' }, audit: [] };
  let approval: TerminalApproval = { id: 'booking-approval', cardId, siteId: 'norrtalje', terminalId: 'test-terminal', version: 1,
    status: options.status === 'attest' ? 'approved' : 'attested', createdAt: '2026-10-13T08:00:00Z', updatedAt: '2026-10-13T08:00:00Z', sentBy: 'Test', actualUserId: 'another-user', effectiveUserId: 'another-user',
    snapshot: { card: structuredClone(card), customer, rows: card.rows.map(row => ({ articleId: row.articleId, name: row.articleName ?? 'Koppar', weight: row.weight, price: row.price, amount: row.weight * row.price })),
      gross: 125, offset: 0, net: 125, paymentMethod: 'bank', reference: '', origin: card.origin, deliveredAt: card.date, termsVersion: '1', hash: 'booking-source-hash' } };
  office.cards = [card]; office.users = [user]; office.customers = [customer];
  const company = { id: 'booking-company', name: 'Boktest AB', organisationNumber: '5560000000', status: 'active' };
  const auth = { enabled: true, authenticated: true, actor: { id: 'booking-actor', name: user.name, username: user.id, platformAdmin: false }, actualUser: user, user,
    company, organisationId: company.id, isSupportSession: false, mustChangePassword: false, csrfToken: 'booking-csrf', generation: 1, companies: [company] };
  let booking: SpirisCardBooking = { cardId, status: 'draft', draftId: 'existing-draft', reason: null, canBook: options.bookingPermission !== false, canRefresh: true };
  let bookPosts = 0, refreshPosts = 0;
  const jobs: SwishPaymentJob[] = [];
  const attestBodies: unknown[] = [];
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body: unknown = {}, status = 200;
    if (path === '/api/platform/session') body = auth;
    else if (path === '/api/application/office') body = { data: office, revision: 1 };
    else if (path === '/api/environment/session' || path === '/api/environment/demo-session') body = { csrfToken: 'env-csrf', actualUserId: user.id, effectiveUserId: user.id };
    else if (path.includes('/environment/sources/')) body = { sourceId: card.sourceId, revision: 1, sites: [], classifications: [], storagePolicies: [], reports: [], reportHistory: [], inventory: [] };
    else if (path.endsWith(`/accounting/cards/${cardId}/booking/refresh`)) { refreshPosts += 1; booking = { ...booking, status: 'booked', invoiceId: 'booked-invoice', voucherNumber: 'A7', canBook: false }; body = booking; }
    else if (path.endsWith(`/accounting/cards/${cardId}/booking`)) {
      if (request.method() === 'POST') { bookPosts += 1; booking = { ...booking, status: 'booking', canBook: false }; }
      body = booking;
    }
    else if (path.endsWith(`/payments/cards/${cardId}`)) body = jobs;
    else if (path === '/api/terminal-demo/state') body = { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [approval], defaults: [] };
    else if (path === '/api/terminal-demo/staff-session') body = { authenticated: true };
    else if (path.endsWith('/booking-approval/attest')) {
      attestBodies.push(request.postDataJSON());
      approval = { ...approval, status: 'attested', attestedBy: user.name, attestedAt: '2026-10-13T08:01:00Z',
        snapshot: { ...approval.snapshot, card: { ...approval.snapshot.card, status: 'ready', approvedBy: user.id } } };
      office.cards = [approval.snapshot.card]; body = approval;
    }
    else if (path === '/api/terminal-demo/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    else if (path === '/api/pricing/state') body = { version: 'test', revision: 1, memoryOnly: true, asOfDate: '2026-10-13', metals: [], articles: [], customers: [] };
    else if (path.endsWith('/summary')) body = { workOrders: 0, warehouse: 0, vessels: 0 };
    else if (path.includes('/accounting/cards/')) body = { export: null };
    else { status = 503; body = { error: 'Optional service unavailable in booking fixture' }; }
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { cardId, bookPosts: () => bookPosts, refreshPosts: () => refreshPosts, attestBodies, confirmPayment: () => {
    jobs.push({ id: 'confirmed-payout', kind: 'card', source: { cardId, approvalId: approval.id, version: 1, hash: approval.snapshot.hash, siteId: 'norrtalje', customerId: customer.id, customerName: customer.name, customerType: customer.type }, amount: 125, amountCents: 12500,
      currency: 'SEK', mode: 'mss', simulation: true, status: 'simulated_paid', bookkeepingStatus: 'failed', paymentDetails: { method: 'swish', phone: '+46701234567', recipient: customer.name },
      createdAt: '2026-10-13T08:02:00Z', updatedAt: '2026-10-13T08:03:00Z', bookkeeping: { reason: 'Betalningsregistreringen behöver åtgärdas.' } });
  } };
}

test('separat utbetalningskort behåller originaluppgifter och spärrar betalning tills bokföringen har verifierats', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const payment = page.locator('.office-card-payment'), payout = page.locator('.office-card-payout');
  await expect(payment.getByRole('heading', { name: 'Betalningsuppgifter', exact: true })).toBeVisible();
  await expect(payment).toContainText('Originalbank');
  await expect(payment.locator('input')).toHaveCount(0);
  await expect(payout).toContainText('Utkast skapat · behöver bokföras');
  await expect(payout.locator('.office-electric-focus-border')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true })).toHaveCount(2);
  for (const button of await page.getByRole('button', { name: 'Betala ut', exact: true }).all()) await expect(button).toBeDisabled();
  expect(await payout.evaluate(element => element.previousElementSibling?.classList.contains('office-card-attest'))).toBe(true);
  await payout.getByRole('button', { name: 'Bokför i Spiris', exact: true }).click();
  await expect(payout).toContainText('Bokföring i Spiris pågår');
  expect(state.bookPosts()).toBe(1);
  await expect(payout.getByRole('button', { name: 'Betala ut', exact: true })).toBeDisabled();
  await payout.getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(payout).toContainText('Bokförd i Spiris · klar för utbetalning');
  await expect(payout).toContainText('Verifikation A7');
  for (const button of await page.getByRole('button', { name: 'Betala ut', exact: true }).all()) await expect(button).toBeEnabled();
  expect(state.refreshPosts()).toBe(1);
  await expect(payment).toContainText('Originalbank');
});

test('delad attestknapp visar valt alternativ och skickar bokföringsvalet utan att invänta Spiris', async ({ page }) => {
  const state = await fixture(page, { status: 'attest' });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const attest = page.locator('.office-card-attest');
  await expect(attest.getByRole('button', { name: 'Attestera · skapa utkast', exact: true })).toBeEnabled();
  await expect(page.locator('.office-card-payout')).toHaveCount(0);
  await attest.getByRole('button', { name: 'Välj atteståtgärd', exact: true }).click();
  await attest.getByRole('menuitemradio', { name: /Attestera & bokför/ }).click();
  await attest.getByRole('button', { name: 'Attestera & bokför', exact: true }).click();
  await expect.poll(() => state.attestBodies.length).toBe(1);
  expect(state.attestBodies[0]).toEqual({ spirisAction: 'book' });
  await expect(page.locator('.office-card-payout')).toBeVisible();
  await expect(attest).toContainText('JEROC-attesterad');
});

test('bokföringsvalet kräver separat behörighet för en användare som får attestera', async ({ page }) => {
  const state = await fixture(page, { status: 'attest', bookingPermission: false });
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const attest = page.locator('.office-card-attest');
  await expect(attest.getByRole('button', { name: 'Attestera · skapa utkast', exact: true })).toBeEnabled();
  await expect(attest.getByRole('button', { name: 'Välj atteståtgärd', exact: true })).toHaveCount(0);
  await expect(attest.getByRole('button', { name: 'Attestera & bokför', exact: true })).toHaveCount(0);
});


test('bekräftad testutbetalning behålls när betalningsbokföringen behöver åtgärdas och erbjuder ingen ny betalning', async ({ page }) => {
  const state = await fixture(page);
  await page.goto(`/kontor#/weighings/${state.cardId}`);
  const payout = page.locator('.office-card-payout');
  await expect(payout).toContainText('Utkast skapat');
  await payout.getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(payout.getByRole('button', { name: 'Betala ut', exact: true })).toBeEnabled();
  state.confirmPayment();
  await page.evaluate(cardId => window.dispatchEvent(new CustomEvent('scrappilot:payment-change', { detail: { cardId, identity: 'admin/admin' } })), state.cardId);
  await expect(payout).toContainText('Swish MSS har bekräftat testutbetalningen');
  await expect(payout).toContainText('Spiris-registreringen kunde inte slutföras');
  await expect(payout).toContainText('inga pengar skickas igen');
  await expect(page.getByRole('button', { name: 'Betala ut', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Visa utbetalning', exact: true })).toHaveCount(2);
  await expect(payout.locator('.office-electric-focus-border')).toHaveCount(0);
  await expect(page.locator('.office-card-payment')).toContainText('Originalbank');
});
