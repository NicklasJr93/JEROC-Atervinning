import { expect, test, type Page, type Request } from '@playwright/test';
import { seedOffice, type OfficeCard } from '../src/office/model';
import type { PublicApproval, TerminalApproval } from '../src/office/terminal-demo-types';
// @ts-expect-error Server pricing seed is JavaScript without declaration files.
import { createPricingStore } from '../server/pricing.mjs';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

const token = 'a'.repeat(43);
const publicPath = '/api/public/customer-approval';
const terms = 'Jag har granskat avräkningen och bekräftar intygandet.';

/** Real office + public page components, isolated from external deliveries.
 * Provider acknowledgements and the server ID gate are explicit HTTP fixtures;
 * no browser storage pretends a customer is approved. Core tests cover tokens. */
async function fixture(page: Page, options: { unavailable?: boolean; staleOnRespond?: boolean } = {}) {
  await page.context().addCookies([{ name: 'jeroc_platform', value: 'private-office-session', url: String(test.info().project.use.baseURL) }]);
  const data = seedOffice(), user = data.users.find(value => value.id === 'admin')!;
  const company = { id: 'approval-company', name: 'Återvinningsbolaget AB', organisationNumber: '5560000167', status: 'active' };
  const card: OfficeCard = { ...data.cards.find(value => value.id === 2052)!,
    status: 'complement', origin: 'Industrivägen 8, 761 41 Norrtälje', reference: 'Referens för kundens granskning',
    paymentDetails: { method: 'cash', recipient: 'Bygg & Riv AB' }, payment: 'Kontant · Bygg & Riv AB' };
  data.cards = [card];
  const customer = data.customers.find(value => value.id === card.customerId)!;
  customer.email = 'kund@example.test'; customer.phone = '+46701234567';
  const pricing = createPricingStore().read({ actor: user, user });
  const session = { enabled: true, authenticated: true, actor: { id: 'cashier-actor', name: user.name,
    username: 'cashier@example.test', platformAdmin: false }, actualUser: user, user, company,
    organisationId: company.id, effectiveUserId: user.id, isSupportSession: false, mustChangePassword: false,
    csrfToken: 'approval-csrf', generation: 4, companies: [company] };
  let approval: TerminalApproval | undefined;
  let unavailable = options.unavailable ?? false;
  let revision = 1;
  const sends: Request[] = [], responses: Request[] = [], confirmations: Request[] = [], reads: Request[] = [];
  const publicApproval = (): PublicApproval => ({ id: approval?.id ?? 'remote-approval', version: 1,
    status: approval?.status ?? 'waiting', updatedAt: approval?.updatedAt ?? '2026-10-20T10:00:00Z',
    snapshot: { cardId: card.id, version: 1, customerName: customer.name, siteName: card.yard,
      rows: [{ articleId: 'iron', name: 'Järnskrot', weight: 830, price: 2.4, amount: 1992 }],
      gross: 1992, offset: 0, net: 1992, paymentMethod: 'cash', reference: card.reference, origin: card.origin,
      deliveredAt: card.date, termsVersion: 'seller-v1', hash: 'b'.repeat(64) } });
  function project() {
    if (!approval) return;
    card.status = approval.status === 'approved' ? 'attest' : 'customer';
    card.idVerified = approval.status === 'approved';
    card.customerApproval = { id: approval.id, version: approval.version, status: approval.status,
      updatedAt: approval.updatedAt, approvedAt: approval.approvedAt, approvedBy: approval.approvedBy };
    approval.snapshot.card = structuredClone(card);
  }
  await page.context().route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === publicPath || path === `${publicPath}/respond`) {
      reads.push(request);
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      expect(request.headers().cookie).toBeUndefined();
      expect(request.url()).not.toContain(token);
      if (unavailable || path.endsWith('/respond') && options.staleOnRespond)
        return route.fulfill({ status: 410, json: { error: 'Länken har gått ut eller ersatts.', code: 'customer_approval_expired' } });
      if (path.endsWith('/respond')) {
        responses.push(request);
        const command = request.postDataJSON();
        if (!approval) approval = makeApproval('email', customer.email);
        approval.status = command.action;
        approval.updatedAt = '2026-10-20T10:01:00Z'; revision++; project();
      }
      return route.fulfill({ json: { companyName: company.name, approval: publicApproval() } });
    }
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/company-settings/defaults') return route.fulfill({ json: { companyId: company.id, version: 1,
      profile: { name: company.name }, defaults: { paymentTermsDays: null } } });
    if (path === '/api/application/office') return route.fulfill({ json: { data, revision } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision } });
    if (path === '/api/pricing/state') return route.fulfill({ json: pricing });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: user.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision, actualUserId: user.id,
      effectiveUserId: user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: approval ? [approval] : [], defaults: [] } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path === '/api/application/customer-review') {
      sends.push(request);
      const command = request.postDataJSON();
      approval = makeApproval(command.channel, command.recipient); revision++; project();
      return route.fulfill({ json: { approval, cardProjection: card, revision } });
    }
    if (path.endsWith('/confirm-id')) {
      confirmations.push(request);
      expect(request.postDataJSON()).toEqual({ idChecked: true });
      expect(approval?.status).toBe('id_requested');
      approval!.status = 'approved'; approval!.approvedBy = user.name; approval!.approvedAt = '2026-10-20T10:02:00Z';
      approval!.updatedAt = approval!.approvedAt; revision++; project(); unavailable = true;
      return route.fulfill({ json: approval });
    }
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    return route.fulfill({ status: 503, json: { error: 'Tjänsten ingår inte i detta avgränsade gränssnittsprov.' } });
  });
  function makeApproval(channel: string, recipient: string): TerminalApproval {
    const publicValue = publicApproval();
    return { id: publicValue.id, cardId: card.id, siteId: 'norrtalje', version: 1, channel, recipient,
      delivery: { status: 'sent', sentAt: '2026-10-20T10:00:00Z' }, status: 'waiting',
      createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z', sentBy: user.name,
      actualUserId: user.id, effectiveUserId: user.id, snapshot: { card: structuredClone(card), customer,
        ...publicValue.snapshot, origin: card.origin } } as TerminalApproval;
  }
  return { card, company, customer, sends, responses, confirmations, reads, approval: () => approval,
    invalidate: () => { unavailable = true; } };
}

for (const channel of ['email', 'sms'] as const) {
  test(`${channel}: kontoret skickar utan terminal, kunden svarar och endast personalens ID-kontroll godkänner`, async ({ page, context }) => {
    const f = await fixture(page);
    await page.goto(`/kontor/#/weighings/${f.card.id}`);
    const controls = page.locator('.approval-controls');
    await expect(controls.getByRole('button', { name: 'Visa på kundterminal', exact: true })).toBeDisabled();
    const label = channel === 'email' ? 'Skicka via e-post' : 'Skicka via SMS';
    const recipientLabel = channel === 'email' ? 'Mottagarens e-postadress' : 'Mobilnummer';
    const recipient = channel === 'email' ? 'annan-kund@example.test' : '+46707654321';
    await controls.getByRole('button', { name: label, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(recipientLabel, { exact: true })).toHaveValue(channel === 'email' ? f.customer.email : f.customer.phone);
    await dialog.getByLabel(recipientLabel, { exact: true }).fill(recipient);
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => f.sends.length).toBe(1);
    expect(f.sends[0].postDataJSON()).toMatchObject({ channel, recipient, cardId: f.card.id, siteId: 'norrtalje' });
    expect(f.sends[0].postDataJSON().terminalId).toBeUndefined();
    expect(f.sends[0].headers()).toMatchObject({ 'x-platform-csrf': 'approval-csrf', 'x-platform-generation': '4' });
    await expect(controls).toContainText('Inväntar kund');
    expect(f.approval()?.status).toBe('waiting');
    await expect(controls.getByRole('button', { name: 'Bekräfta legitimation & godkännande', exact: true })).toHaveCount(0);

    const customerPage = await context.newPage();
    await customerPage.setViewportSize({ width: 390, height: 844 });
    await customerPage.goto(`/godkann/#token=${token}`);
    await expect(customerPage.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toBeVisible();
    await expect(customerPage.getByText(f.company.name, { exact: true }).first()).toBeVisible();
    await expect(customerPage.getByRole('button', { name: /BankID/ })).toHaveCount(0);
    await expect(customerPage.getByRole('textbox', { name: /lösenord|inloggningsnamn/i })).toHaveCount(0);
    const approve = customerPage.getByRole('button', { name: 'Godkänn', exact: true });
    await expect(approve).toBeDisabled();
    expect(f.responses).toHaveLength(0);
    await customerPage.getByRole('checkbox', { name: terms, exact: true }).check();
    await approve.click();
    await expect(customerPage.getByRole('dialog', { name: 'Visa din legitimation', exact: true })).toContainText('Inväntar ID-kontroll');
    expect(f.responses).toHaveLength(1);
    expect(f.responses[0].postDataJSON()).toEqual({ action: 'id_requested', termsAccepted: true });
    expect(f.approval()?.status).toBe('id_requested');
    expect(f.card.idVerified).toBe(false);
    expect(f.confirmations).toHaveLength(0);
    expect(f.reads.every(request => request.url().includes('/api/public/customer-approval'))).toBe(true);
    expect(customerPage.url()).not.toContain(token);

    await page.reload();
    await controls.getByRole('button', { name: 'Bekräfta legitimation & godkännande', exact: true }).click();
    const confirm = page.getByRole('dialog');
    const confirmButton = confirm.getByRole('button', { name: 'Bekräfta kontroll & godkännande', exact: true });
    await expect(confirmButton).toBeDisabled();
    await confirm.getByRole('checkbox', { name: 'Jag har kontrollerat kundens legitimation på plats', exact: true }).check();
    await confirmButton.click();
    await expect(controls).toContainText('Godkänd av kund');
    expect(f.confirmations).toHaveLength(1);
    expect(f.approval()?.status).toBe('approved');
    expect(f.card.idVerified).toBe(true);
    expect(f.card.status).toBe('attest');
    await customerPage.close();
  });
}

test('utgången eller ersatt länk visar inga kund- eller avräkningsuppgifter och erbjuder ingen inloggning', async ({ page }) => {
  await fixture(page, { unavailable: true });
  await page.goto(`/godkann/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Länken kan inte användas', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-material-table')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Godkänn', exact: true })).toHaveCount(0);
  await expect(page.getByText('Bygg & Riv AB', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(page.url()).not.toContain(token);
});

test('en länk som ersatts medan kunden granskar rensar underlaget om servern avvisar svaret', async ({ page }) => {
  const f = await fixture(page, { staleOnRespond: true });
  await page.goto(`/godkann/#token=${token}`);
  await expect(page.locator('.terminal-material-table')).toContainText('Järnskrot');
  await page.getByRole('checkbox', { name: terms, exact: true }).check();
  await page.getByRole('button', { name: 'Godkänn', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Länken kan inte användas', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-material-table')).toHaveCount(0);
  await expect(page.getByText(f.card.reference, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(f.confirmations).toHaveLength(0);
});

test('kundens ändringsbegäran kräver beskrivning och blir aldrig ett godkännande', async ({ page }) => {
  const f = await fixture(page);
  await page.goto(`/godkann/#token=${token}`);
  await page.getByRole('button', { name: 'Begär ändring', exact: true }).click();
  const send = page.getByRole('button', { name: 'Skicka begäran', exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole('textbox', { name: /Beskriv/ }).fill('Vikten behöver kontrolleras igen.');
  await send.click();
  await expect.poll(() => f.responses.length).toBe(1);
  expect(f.responses[0].postDataJSON()).toMatchObject({ action: 'change_requested', termsAccepted: false,
    comment: expect.stringContaining('Vikten behöver kontrolleras igen.') });
  expect(f.approval()?.status).toBe('change_requested');
  expect(f.card.idVerified).toBe(false);
  expect(f.confirmations).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Godkänn', exact: true })).toHaveCount(0);
});
