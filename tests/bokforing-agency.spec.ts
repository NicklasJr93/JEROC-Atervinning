import { expect, test, type Page } from '@playwright/test';

// These scenarios exercise the intentionally unauthenticated LOCAL demo.
// Selecting a demoperson is not identity verification or production login.
const directoryKey = 'endor-bokforing-agency-v1';
const akeKey = 'scrapplanner-bokforing-suite-v2';
const bjorkKey = 'endor-bokforing-company-company-bjork-v1';
const jenny = '20900303-0039';
type Invitation = { id: string; companyId: string; recipientId: string; status: string; permissions: string[] };
type Directory = { invitations: Invitation[] };

test.use({ viewport: { width: 1440, height: 1000 } });
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  // Never spend model credits or depend on the external AI provider in tests.
  await page.route('**/api/bokforing/ande/**', route => route.fulfill({ json: {
    configured: false, authenticated: true, available: false,
    reason: 'AI är avstängd i detta automatiska prov.',
  } }));
});
test.afterEach(({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

const directory = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"invitations":[]}') as Directory, directoryKey);
const rawBook = (page: Page, key = akeKey) => page.evaluate(storageKey => localStorage.getItem(storageKey), key);
const invitationCard = (page: Page, id: string) => page.locator(`[data-agency-invitation="${id}"]`);

async function agency(page: Page) {
  await page.evaluate(() => { location.hash = '#agency'; });
  await expect(page.locator('#suite-main h1')).toHaveText('Byrå & behörigheter');
}
async function open(page: Page) {
  await page.goto('/bokforing/index.html#agency');
  await expect(page.locator('#suite-main h1')).toHaveText('Byrå & behörigheter');
  await expect(page.locator('.agency-demo-banner')).toContainText('Inga inloggningar eller inbjudningsmejl skickas');
}
async function profile(page: Page, id: string) {
  await page.locator('#agency-demo-profile').selectOption(id);
  await expect(page.locator('#agency-demo-profile')).toHaveValue(id);
  await agency(page);
}
async function invite(page: Page, permissions: string[] = [], personalNumber = jenny) {
  const before = (await directory(page)).invitations.length;
  const form = page.locator('[data-agency-form="invite"]');
  await form.locator('[name="personalNumber"]').fill(personalNumber);
  for (const value of ['bookkeeping', 'payroll', 'closing', 'payments', 'export']) {
    await form.locator(`[name="permissions"][value="${value}"]`).setChecked(permissions.includes(value));
  }
  await form.locator('button[type="submit"]').click();
  await expect.poll(async () => (await directory(page)).invitations.length).toBe(before + 1);
  const item = (await directory(page)).invitations.at(-1)!;
  expect(item.status).toBe('pending');
  return item;
}
async function accept(page: Page, id: string) {
  await invitationCard(page, id).locator('[data-agency-action="accept"]').click();
  await expect.poll(async () => (await directory(page)).invitations.find(item => item.id === id)?.status).toBe('accepted');
}
async function work(page: Page, companyId: string) {
  await agency(page);
  const button = page.locator(`[data-agency-action="work"][data-id="${companyId}"]`);
  if (await button.isEnabled()) await button.click();
  else await page.evaluate(() => { location.hash = '#overview'; });
  await expect(page).toHaveURL(/#overview$/);
  await expect(page.locator('#suite-main')).not.toContainText('Vyn kunde inte öppnas');
}

test('AGENCY-UI-001 invitation waits for the matching recipient, readonly is enforced, and revocation removes access', async ({ page }) => {
  await open(page);
  const item = await invite(page);
  await profile(page, 'user-jenny');
  await expect(page.locator('[data-agency-company="company-ake"]')).toHaveCount(0);
  await expect(invitationCard(page, item.id)).toContainText('Väntar på svar');
  await profile(page, 'user-anki');
  await expect(invitationCard(page, item.id)).toHaveCount(0);
  await expect(page.locator('[data-agency-action="accept"]')).toHaveCount(0);
  await profile(page, 'user-jenny');
  await accept(page, item.id);
  await work(page, 'company-ake');
  await expect(page.locator('#company-name')).toContainText('Åkes Hantverk');
  await page.evaluate(() => { location.hash = '#sales'; });
  await expect(page.locator('#suite-main [data-action="new-invoice"]')).toBeDisabled();
  await page.evaluate(() => { location.hash = '#payroll-v2'; });
  await expect(page.locator('[data-feature-form="payroll-v2"]')).toHaveCount(0);
  await expect(page.locator('#suite-main')).not.toContainText('Individuell lönehantering');
  await profile(page, 'user-ake');
  await invitationCard(page, item.id).locator('[data-agency-action="revoke"]').click();
  await expect.poll(async () => (await directory(page)).invitations.find(invitation => invitation.id === item.id)?.status).toBe('revoked');
  await profile(page, 'user-jenny');
  await expect(page.locator('[data-agency-company="company-ake"]')).toHaveCount(0);
  await expect(invitationCard(page, item.id)).toContainText('Återkallad');
  await page.evaluate(() => { location.hash = '#sales'; });
  await expect(page.locator('#suite-main [data-action="new-invoice"]')).toHaveCount(0);
});

test('AGENCY-UI-002 bookkeeping delegation records the real actor and does not include payment permission', async ({ page }) => {
  await open(page);
  const item = await invite(page, ['bookkeeping']);
  await profile(page, 'user-jenny');
  await accept(page, item.id);
  await work(page, 'company-ake');
  await page.evaluate(() => { location.hash = '#projects'; });
  await page.locator('#suite-main [data-action="new-customer"]').click();
  const form = page.locator('#suite-dialog form[data-form="customer"]');
  await form.locator('[name="name"]').fill('Byråkund · fiktivt prov');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).toBeHidden();
  const state = JSON.parse((await rawBook(page))!);
  expect(state.customers.some((customer: { name: string }) => customer.name === 'Byråkund · fiktivt prov')).toBe(true);
  const event = state.activity.at(-1);
  expect(event.actorId).toBe('user-jenny');
  expect(event.actingCompanyId).toBe('company-ake');
  expect(event.actor).toMatch(/Jenny.*Lexratio/);
  await page.evaluate(() => { location.hash = '#bank'; });
  await expect(page.locator('#suite-main [data-action="new-bank"]')).toBeDisabled();
  await page.reload();
  await expect(page.locator('#agency-demo-profile')).toHaveValue('user-jenny');
  expect(JSON.parse((await rawBook(page))!).activity.at(-1).actorId).toBe('user-jenny');
});

test('AGENCY-UI-003 two accepted client companies have separate books and no carried invoice editor', async ({ page }) => {
  await open(page);
  const ake = await invite(page, ['bookkeeping']);
  await profile(page, 'user-bjork');
  const bjork = await invite(page, ['bookkeeping']);
  await profile(page, 'user-jenny');
  await accept(page, ake.id);
  await accept(page, bjork.id);
  await expect(page.locator('[data-agency-company]')).toHaveCount(2);
  await work(page, 'company-ake');
  await page.evaluate(() => { location.hash = '#projects'; });
  await page.locator('#suite-main [data-action="new-customer"]').click();
  const form = page.locator('#suite-dialog form[data-form="customer"]');
  await form.locator('[name="name"]').fill('Endast Åkes kund');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).toBeHidden();
  const original = await rawBook(page);
  await work(page, 'company-bjork');
  await expect(page.locator('#company-name')).toContainText('Björks El');
  await page.evaluate(() => { location.hash = '#sales'; });
  await expect(page.locator('#suite-main')).not.toContainText('Kontorsrenovering');
  await page.evaluate(() => { location.hash = '#projects'; });
  await expect(page.locator('#suite-main')).not.toContainText('Endast Åkes kund');
  await page.locator('#suite-main [data-action="new-customer"]').click();
  const otherForm = page.locator('#suite-dialog form[data-form="customer"]');
  await otherForm.locator('[name="name"]').fill('Endast Björks kund');
  await otherForm.locator('button[type="submit"]').click();
  await expect(page.locator('#suite-dialog')).toBeHidden();
  expect(await rawBook(page)).toBe(original);
  const other = JSON.parse((await rawBook(page, bjorkKey))!);
  expect(other.invoices).toHaveLength(0);
  expect(other.customers.map((customer: { name: string }) => customer.name)).toContain('Endast Björks kund');
  expect(other.customers.map((customer: { name: string }) => customer.name)).not.toContain('Endast Åkes kund');
  await page.evaluate(() => { location.hash = '#sales/new'; });
  await expect(page.locator('#invoice-page-form')).toBeVisible();
  await work(page, 'company-ake');
  await expect(page.locator('#invoice-page-form')).toHaveCount(0);
  await expect(page.locator('#company-name')).toContainText('Åkes Hantverk');
});

test('AGENCY-UI-004 owner permission changes persist and update the same accepted invitation', async ({ page }) => {
  await open(page);
  const item = await invite(page);
  await profile(page, 'user-jenny');
  await accept(page, item.id);
  await profile(page, 'user-ake');
  const card = invitationCard(page, item.id);
  await card.locator('summary').click();
  const form = card.locator('[data-agency-form="permissions"]');
  await form.locator('[name="permissions"][value="bookkeeping"]').check();
  await form.locator('[name="permissions"][value="export"]').check();
  await form.locator('button[type="submit"]').click();
  await expect.poll(async () => (await directory(page)).invitations.find(invitation => invitation.id === item.id)?.permissions).toEqual(['read', 'bookkeeping', 'export']);
  await page.reload();
  const saved = (await directory(page)).invitations;
  expect(saved).toHaveLength(1);
  expect(saved[0].status).toBe('accepted');
  await profile(page, 'user-jenny');
  await work(page, 'company-ake');
  await page.evaluate(() => { location.hash = '#projects'; });
  await expect(page.locator('#suite-main [data-action="new-customer"]')).toBeEnabled();
  await page.evaluate(() => { location.hash = '#payroll-v2'; });
  await expect(page.locator('[data-feature-form="payroll-v2"]')).toHaveCount(0);
});

test('AGENCY-UI-005 a forged customer form cannot bypass readonly at save time', async ({ page }) => {
  await open(page);
  const item = await invite(page);
  await profile(page, 'user-jenny');
  await accept(page, item.id);
  await work(page, 'company-ake');
  const before = await rawBook(page);
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.dataset.form = 'customer';
    for (const [name, value] of Object.entries({ name: 'Ska inte kunna sparas', email: '', address: '', postalCode: '', city: '', vatNumber: '' })) {
      const input = document.createElement('input'); input.name = name; input.value = value; form.append(input);
    }
    document.querySelector('#suite-main')!.append(form);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#suite-toast')).toBeVisible();
  expect(await rawBook(page)).toBe(before);
  expect((await directory(page)).invitations[0].permissions).toEqual(['read']);
});

test('AGENCY-UI-006 owner invitation and recipient acceptance fit on a mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const item = await invite(page, ['bookkeeping']);
  await profile(page, 'user-jenny');
  await accept(page, item.id);
  await expect(page.locator('[data-agency-company="company-ake"]')).toBeVisible();
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 1);
  await work(page, 'company-ake');
  await expect(page.locator('#company-name')).toContainText('Åkes Hantverk');
});

test('AGENCY-UI-007 client switch resets Ande history and sends only the newly selected book', async ({ page }) => {
  const requests: { question: string; history: unknown[]; context: { overview: { invoiceDrafts: number; journalEntries: number } } }[] = [];
  await page.unroute('**/api/bokforing/ande/**');
  await page.route('**/api/bokforing/ande/**', route => {
    if (route.request().url().endsWith('/status')) return route.fulfill({ json: {
      configured: true, authenticated: true, available: true, model: 'test-model', csrfToken: 'test-csrf', sessionGeneration: 'agency-test',
    } });
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { text: 'Fiktivt testsvar från aktuell bok.' } });
  });
  await open(page);
  const ake = await invite(page, ['bookkeeping']);
  await profile(page, 'user-bjork');
  const bjork = await invite(page, ['bookkeeping']);
  await profile(page, 'user-jenny');
  await accept(page, ake.id); await accept(page, bjork.id);
  await work(page, 'company-ake');
  await page.locator('.ande-launcher').click();
  await expect(page.locator('#assistant-input')).toBeEnabled();
  await page.locator('#assistant-input').fill('Åkes första fråga');
  await page.locator('#ande-send').click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator('.ande-message-text').last()).toContainText('Fiktivt testsvar');
  expect(requests[0].context.overview.journalEntries).toBeGreaterThan(0);
  await page.locator('#suite-assistant [data-action="toggle-assistant"]').click();
  await work(page, 'company-bjork');
  await expect(page.locator('#assistant-messages')).not.toContainText('Åkes första fråga');
  await expect(page.locator('#assistant-input')).toHaveValue('');
  await page.locator('.ande-launcher').click();
  await expect(page.locator('#assistant-input')).toBeEnabled();
  await page.locator('#assistant-input').fill('Björks första fråga');
  await page.locator('#ande-send').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].history).toEqual([]);
  expect(requests[1].context.overview.journalEntries).toBe(0);
  expect(requests[1].context.overview.invoiceDrafts).toBe(0);
  expect(JSON.stringify(requests[1])).not.toContain('20900303');
});

test('AGENCY-UI-008 revocation in the owner tab clears an already open client workspace', async ({ page, context }) => {
  await open(page);
  const item = await invite(page, ['bookkeeping']);
  const recipient = await context.newPage();
  await recipient.goto('/bokforing/index.html#agency');
  await profile(recipient, 'user-jenny');
  await accept(recipient, item.id);
  await work(recipient, 'company-ake');
  await recipient.evaluate(() => { location.hash = '#sales'; });
  await expect(recipient.locator('#suite-main h1')).toHaveText('Kundfakturor');
  // The first tab reads the now-accepted grant before revoking it.
  await page.reload();
  await invitationCard(page, item.id).locator('[data-agency-action="revoke"]').click();
  await expect.poll(async () => (await directory(page)).invitations.find(invitation => invitation.id === item.id)?.status).toBe('revoked');
  await expect(recipient.locator('#suite-main')).not.toContainText('Kontorsrenovering');
  await expect(recipient.locator('#suite-main [data-action="new-invoice"]')).toHaveCount(0);
  await agency(recipient);
  await expect(recipient.locator('[data-agency-company="company-ake"]')).toHaveCount(0);
  await expect(invitationCard(recipient, item.id)).toContainText('Återkallad');
  await recipient.close();
});

test('AGENCY-UI-009 document inboxes stay separate and a reading delegate cannot upload', async ({ page }) => {
  const pdf = (name: string, marker: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.7\n${marker}\n%%EOF\n`) });
  const inbox = async () => {
    await page.evaluate(() => { location.hash = '#purchases/inbox'; });
    await expect(page.locator('#suite-main h1')).toHaveText('Inkomna underlag');
  };
  const upload = () => page.locator('[data-document-upload][data-source="file"]').first();
  await open(page);
  const ake = await invite(page, ['export']);
  await inbox();
  await upload().setInputFiles(pdf('Endast-Akes-underlag.pdf', 'AKES FIKTIVA ORIGINAL'));
  await expect(page.locator('.purchase-inbox-card h2')).toHaveText('Endast-Akes-underlag.pdf');
  await profile(page, 'user-bjork');
  const bjork = await invite(page, ['export']);
  await inbox();
  await expect(page.locator('.purchase-inbox-card')).toHaveCount(0);
  await upload().setInputFiles(pdf('Endast-Bjorks-underlag.pdf', 'BJORKS FIKTIVA ORIGINAL'));
  await expect(page.locator('.purchase-inbox-card h2')).toHaveText('Endast-Bjorks-underlag.pdf');
  await profile(page, 'user-jenny');
  await accept(page, ake.id); await accept(page, bjork.id);
  await work(page, 'company-ake');
  await inbox();
  await expect(page.locator('.purchase-inbox-card h2')).toHaveText('Endast-Akes-underlag.pdf');
  await expect(page.locator('#suite-main')).not.toContainText('Endast-Bjorks-underlag.pdf');
  // A DOM-dispatched change must still fail at the mutation guard, regardless
  // of whether the ordinary upload control is hidden or disabled for readers.
  await upload().evaluate(input => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.7\nMUST NOT SAVE'], 'Otillaten-uppladdning.pdf', { type: 'application/pdf' }));
    (input as HTMLInputElement).files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#suite-toast')).toBeVisible();
  await page.reload();
  await expect(page.locator('.purchase-inbox-card h2')).toHaveText('Endast-Akes-underlag.pdf');
  await work(page, 'company-bjork');
  await inbox();
  await expect(page.locator('.purchase-inbox-card h2')).toHaveText('Endast-Bjorks-underlag.pdf');
  await expect(page.locator('#suite-main')).not.toContainText('Endast-Akes-underlag.pdf');
  await expect(page.locator('#suite-main')).not.toContainText('Otillaten-uppladdning.pdf');
});
