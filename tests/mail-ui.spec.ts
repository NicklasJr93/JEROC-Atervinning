import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import type { MailCustomerMatch, MailMailboxInput, MailMessage, MailMessageDetail, MailState } from '../src/office/mail-client';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false });
test.setTimeout(45_000);
test.describe.configure({ mode: 'serial' });

type Options = {
  readDenied?: 'actual' | 'effective';
  manageDenied?: 'actual' | 'effective';
  unconfigured?: boolean;
  oldBodyGate?: Promise<void>;
};

async function setup(page: Page, options: Options = {}) {
  const data = migrateOffice(seedOffice()), base = data.users.find(user => user.id === 'admin')!;
  const actualUser: OfficeUser = structuredClone(base), user: OfficeUser = structuredClone(base);
  if (options.readDenied || options.manageDenied) {
    user.id = 'mail-acting-user'; user.name = 'Vald mejlanvändare';
    const denied = (options.readDenied ?? options.manageDenied) === 'actual' ? actualUser : user;
    denied.level = 'Medarbetare';
    denied.permissions = denied.permissions.filter(permission => permission !== (options.readDenied ? 'mailRead' : 'integrationsManage'));
  }
  data.users = [...data.users.filter(value => ![actualUser.id, user.id].includes(value.id)), actualUser, ...(user.id !== actualUser.id ? [user] : [])];
  const reader: OfficeUser = { id: 'mail-reader', name: 'Mejlhandläggare', level: 'Medarbetare', permissions: ['view', 'mailRead'], maxAttest: 0, ownAttest: false, active: true };
  data.users.push(reader);
  const customer = structuredClone(data.customers.find(value => value.type === 'Företag')!);
  Object.assign(customer, { name: 'Mailkund AB', customerNumber: 'MAIL-100', email: 'kund@example.test', phone: '0701112233',
    address: 'Industrivägen 12', postalCode: '76141', city: 'Norrtälje' });
  const second = { ...structuredClone(customer), id: 'mail-second-customer', name: 'Andra Mailkunden AB', customerNumber: 'MAIL-200' };
  data.customers = [...data.customers.filter(value => value.id !== customer.id), customer, second];
  const match = (value: typeof customer): MailCustomerMatch => ({ id: value.id, name: value.name, type: value.type, customerNumber: value.customerNumber,
    email: value.email, phone: value.phone, address: value.address, postalCode: value.postalCode, city: value.city });
  const state: MailState = { organisationId: 'jeroc-demo', configuration: { ready: !options.unconfigured,
      missing: options.unconfigured ? ['MICROSOFT_CLIENT_SECRET'] : [], issues: [], redirectUri: 'https://scrappilot.example.test/api/mail/microsoft/callback' },
    mode: 'live', capabilities: { canRead: true, canManage: true },
    connections: options.unconfigured ? [] : [{ id: 'connection-1', provider: 'microsoft', address: 'kontor@example.test', displayName: 'Kontoret', status: 'connected' }],
    mailboxes: options.unconfigured ? [] : [
      { id: 'primary', connectionId: 'connection-1', address: 'kontor@example.test', displayName: 'Kontoret', type: 'primary', enabled: true, allowedUserIds: ['admin'], unreadCount: 2 },
      { id: 'shared', connectionId: 'connection-1', address: 'service@example.test', displayName: 'Kundtjänst', type: 'shared', enabled: true, allowedUserIds: ['admin'], unreadCount: 1 },
    ], totalUnread: options.unconfigured ? 0 : 3 };
  const message = (id: string, subject: string, mailboxId = 'primary', isRead = false): MailMessage => ({ id, mailboxId, subject, isRead,
    from: { name: 'Kontakt hos Mailkund', address: 'kund@example.test' }, receivedAt: '2026-10-13T08:15:00.000Z',
    bodyPreview: `Meddelande om ${subject}`, hasAttachments: false });
  const messages = [message('matched', 'Hämtning av batterier', 'shared'), message('multiple', 'Gemensam e-postadress'),
    message('none', 'Okänd avsändare', 'primary', true), message('old', 'Gammalt svar som ska ignoreras')];
  const attack = '<img src=x onerror="window.__mailAttack=1">\n<script>window.__mailAttack=2</script>\nVanlig läsbar text.';
  const detail = (id: string): MailMessageDetail => ({
    message: { ...messages.find(value => value.id === id)!, bodyText: id === 'none' ? attack : id === 'old' ? 'HEMLIG GAMMAL MEDDELANDETEXT' : 'Hej! Vi vill boka hämtning av blybatterier. Ring gärna vår kontaktperson.',
      to: [{ address: 'kontor@example.test' }], attachments: [], webLink: id === 'none' ? 'javascript:window.__mailAttack=3' : 'https://outlook.office.com/mail/inbox/id/local-fixture' },
    matches: id === 'matched' ? [match(customer)] : id === 'multiple' ? [match(customer), match(second)] : [],
    matchStatus: id === 'matched' ? 'matched' : id === 'multiple' ? 'multiple' : 'none',
  });
  const session: AuthenticatedPlatformSession = { enabled: true, authenticated: true,
    actor: { id: 'platform-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true }, actualUser, user,
    company: { id: 'jeroc-demo', name: 'Mail testbolag', organisationNumber: '5593593626', status: 'active' }, organisationId: 'jeroc-demo',
    effectiveUserId: user.id, isSupportSession: actualUser.id !== user.id, mustChangePassword: false,
    csrfToken: 'platform-mail-fixture', generation: 1, companies: [] };
  const statistics = { mailCalls: [] as { path: string; method: string }[], lists: [] as Record<string, string>[],
    details: [] as string[], writes: [] as { path: string; method: string; body: unknown }[], businessWrites: 0,
    authorizationUrl: 'javascript:window.__mailAttack=4', externalAuthorizations: 0, oldReadFinished: false };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (path.startsWith('/api/mail/')) {
      statistics.mailCalls.push({ path, method });
      if (method !== 'GET') statistics.writes.push({ path, method, body: request.postDataJSON() });
      if (path === '/api/mail/state') return route.fulfill({ json: state });
      if (path === '/api/mail/messages') {
        const filter = Object.fromEntries(url.searchParams); statistics.lists.push(filter);
        return route.fulfill({ json: { messages: messages.filter(value => (!filter.mailboxId || value.mailboxId === filter.mailboxId)
          && (filter.unreadOnly !== 'true' || !value.isRead)
          && (!filter.search || `${value.subject} ${value.from.address}`.toLowerCase().includes(filter.search.toLowerCase()))),
          hasMore: false, nextCursor: null, totalUnread: state.totalUnread } });
      }
      const selected = path.match(/^\/api\/mail\/mailboxes\/([^/]+)\/messages\/([^/]+)$/);
      if (selected) {
        const id = decodeURIComponent(selected[2]); statistics.details.push(id);
        if (id === 'old') await options.oldBodyGate;
        return route.fulfill({ json: detail(id) }).catch(error => {
          if (!/cancel|abort|closed|interception/i.test(String(error))) throw error;
        }).finally(() => { if (id === 'old') statistics.oldReadFinished = true; });
      }
      if (path === '/api/mail/microsoft/connect') return route.fulfill({ json: { authorizationUrl: statistics.authorizationUrl } });
      if (path === '/api/mail/mailboxes' && method === 'POST') {
        const input = request.postDataJSON() as MailMailboxInput;
        state.mailboxes.push({ ...input, id: 'shared-new', displayName: input.displayName ?? input.address, allowedUserIds: input.allowedUserIds ?? [],
          type: 'shared', enabled: true, unreadCount: 0 });
        return route.fulfill({ json: state });
      }
      const update = path.match(/^\/api\/mail\/mailboxes\/([^/]+)$/);
      if (update && method === 'PUT') {
        Object.assign(state.mailboxes.find(value => value.id === decodeURIComponent(update[1]))!, request.postDataJSON());
        return route.fulfill({ json: state });
      }
      if (path === '/api/mail/sync' || path.endsWith('/disconnect')) return route.fulfill({ json: state });
      return route.fulfill({ status: 405, json: { code: 'mail_fixture_only', message: 'Detta mailanrop ingår inte i testet.' } });
    }
    if (method !== 'GET' && ['/api/application/office', '/api/pricing/customers', '/api/environment/receipts'].includes(path)) statistics.businessWrites++;
    const body = path === '/api/platform/session' ? session
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, actualUserId: actualUser.id, effectiveUserId: user.id, user,
        csrfToken: 'environment-mail-fixture', expiresAt: '2099-01-01T00:00:00.000Z' }
      : path === '/api/terminal-demo/staff-session' ? { actualUserId: actualUser.id, effectiveUserId: user.id }
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, actualUserId: actualUser.id, effectiveUserId: user.id,
        sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/environment/integrations/catalog' ? { version: 1, organisationId: 'jeroc-demo', capabilities: { canManage: true },
        providers: [{ id: 'microsoft365', name: 'Microsoft 365', category: 'productivity', description: 'Företagets inkomna mejl', mode: 'production',
          status: options.unconfigured ? 'not-configured' : 'connected', implemented: true, configured: !options.unconfigured, connected: !options.unconfigured,
          requiredSetup: [], links: {}, capabilities: { canView: true, canConfigure: true, canCheck: false, canConnect: true } }] }
      : path === '/api/pricing/state' ? { version: 'mail-fixture', memoryOnly: false, revision: 1, asOfDate: '2026-10-13', metals: [], articles: [],
        customers: data.customers, users: data.users, customerPrices: [], audit: [] }
      : path === '/api/pricing/customer-preview' ? { rows: [] } : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { code: 'mail_fixture_only', message: 'Tjänsten ingår inte i mailtestet.' } });
  });
  await page.route('https://login.microsoftonline.com/**', async route => {
    statistics.externalAuthorizations++;
    await route.fulfill({ contentType: 'text/html', body: '<h1>Lokal OAuth-fixtur</h1>' });
  });
  return { data, customer, second, reader, state, messages, detail, statistics };
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(name);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('inkorgsfilter kombineras och exakt kundmatchning öppnar samma befintliga kundkort', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { customer, statistics } = await setup(page);
  await page.goto('/kontor#/mail');
  await expect(page.getByRole('heading', { name: 'Inkomna mejl', exact: true })).toBeVisible();
  await page.getByRole('complementary', { name: 'Inkorgar', exact: true }).getByRole('button', { name: /Kundtjänst/ }).click();
  await page.getByRole('button', { name: /^Olästa/ }).click();
  await page.getByRole('textbox', { name: 'Sök avsändare eller ämne', exact: true }).fill('batterier');
  await expect.poll(() => statistics.lists.some(filter => filter.mailboxId === 'shared' && filter.unreadOnly === 'true' && filter.search === 'batterier')).toBe(true);
  await page.getByRole('button', { name: 'Öppna mejl: Hämtning av batterier', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Matchad kund', exact: true });
  await expect(summary).toContainText(customer.name);
  await expect(summary).toContainText(customer.phone);
  await expect(summary).toContainText(customer.address);
  await expect(summary.getByRole('link', { name: 'Öppna kundkort', exact: true })).toHaveAttribute('href', `#/customers/${customer.id}?tab=overview`);
  await screenshot(page, info, 'mail-matched-customer-1440.png');
  await summary.getByRole('link', { name: 'Öppna kundkort', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/customers/${customer.id}\\?tab=overview$`));
  await expect(page.getByRole('heading', { name: customer.name, exact: true, level: 1 })).toBeVisible();
  expect(statistics.writes).toEqual([]); expect(statistics.businessWrites).toBe(0); expect(errors).toEqual([]);
});

test('flera kundmatchningar kräver val och mejltext återges säkert utan att ett gammalt svar ersätter det valda mejlet', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const oldBodyGate = new Promise<void>(resolve => { release = resolve; });
  const { second, statistics } = await setup(page, { oldBodyGate });
  try {
    await page.goto('/kontor#/mail');
    await page.getByRole('button', { name: 'Öppna mejl: Gemensam e-postadress', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Matchad kund', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Välj matchad kund', { exact: true })).toHaveValue('');
    await page.getByLabel('Välj matchad kund', { exact: true }).selectOption(second.id);
    await expect(page.getByRole('region', { name: 'Matchad kund', exact: true })).toContainText(second.name);
    await page.getByRole('button', { name: 'Till inkorgen', exact: true }).click();
    await page.getByRole('button', { name: 'Öppna mejl: Gammalt svar som ska ignoreras', exact: true }).click();
    await expect.poll(() => statistics.details.includes('old')).toBe(true);
    await page.getByRole('button', { name: 'Till inkorgen', exact: true }).click();
    await page.getByRole('button', { name: 'Öppna mejl: Okänd avsändare', exact: true }).click();
    const body = page.getByRole('article', { name: 'Mejlinnehåll', exact: true });
    await expect(body).toContainText('<script>window.__mailAttack=2</script>');
    await expect(page.getByRole('heading', { name: 'Ingen kund matchad', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Matchad kund', exact: true })).toHaveCount(0);
    await expect(body.locator('img,script,iframe')).toHaveCount(0);
    await expect(body.getByRole('link', { name: 'Öppna i Outlook', exact: true })).toHaveCount(0);
    release();
    await expect.poll(() => statistics.oldReadFinished).toBe(true);
    await expect(body).not.toContainText('HEMLIG GAMMAL MEDDELANDETEXT');
    expect(await page.evaluate(() => (window as unknown as { __mailAttack?: number }).__mailAttack)).toBeUndefined();
    expect(statistics.writes).toEqual([]); expect(statistics.businessWrites).toBe(0); expect(errors).toEqual([]);
  } finally { release(); }
});

test('återkallad inkorgsåtkomst i samma session döljer tidigare ämne, mejltext och kundkort', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { customer, state, statistics } = await setup(page);
  await page.goto('/kontor#/mail');
  await page.getByRole('button', { name: 'Öppna mejl: Hämtning av batterier', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Hämtning av batterier', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Mejlinnehåll', exact: true })).toContainText('Hej! Vi vill boka hämtning av blybatterier.');
  await expect(page.getByRole('region', { name: 'Matchad kund', exact: true })).toContainText(customer.name);
  const stateReads = statistics.mailCalls.filter(call => call.path === '/api/mail/state').length;

  // Same organisation, generation and people: an access change must hide the
  // old projection without relying on a logout, account switch or page reload.
  state.mailboxes.find(mailbox => mailbox.id === 'shared')!.enabled = false;
  await page.evaluate(({ event, organisationId }) => {
    window.dispatchEvent(new CustomEvent(event, { detail: { organisationId, generation: 1 } }));
  }, { event: 'scrappilot:mail-updated', organisationId: state.organisationId });
  await expect.poll(() => statistics.mailCalls.filter(call => call.path === '/api/mail/state').length).toBeGreaterThan(stateReads);
  await expect(page.getByRole('heading', { name: 'Mejlet är inte tillgängligt', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Läs mejl', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hämtning av batterier', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: 'Mejlinnehåll', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Matchad kund', exact: true })).toHaveCount(0);
  await expect(page.locator('.mail-workspace')).not.toContainText('Hej! Vi vill boka hämtning av blybatterier.');
  await expect(page.locator('.mail-workspace')).not.toContainText(customer.name);
  expect(statistics.writes).toEqual([]); expect(statistics.businessWrites).toBe(0); expect(errors).toEqual([]);
});

test('båda identiteterna behöver mejlläsning respektive integrationsbehörighet före privata anrop och ändringar', async ({ context }) => {
  for (const principal of ['actual', 'effective'] as const) {
    const page = await context.newPage();
    try {
      const { statistics } = await setup(page, { readDenied: principal });
      await page.goto('/kontor#/mail');
      await expect(page.locator('.office-main')).toContainText(/Behörighet saknas|Du saknar behörighet att läsa företagets mejl/);
      expect(statistics.mailCalls).toEqual([]);
    } finally { await page.close(); }
  }
  for (const principal of ['actual', 'effective'] as const) {
    const page = await context.newPage();
    try {
      const { statistics } = await setup(page, { manageDenied: principal });
      await page.goto('/kontor#/integrations?service=microsoft365');
      await expect(page.getByText('Du behöver behörighet att hantera bolagets integrationer för att ansluta och hantera inkorgar.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Lägg till inkorg', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Anslut (Microsoft 365|ytterligare konto)/ })).toHaveCount(0);
      expect(statistics.writes).toEqual([]);
    } finally { await page.close(); }
  }
});

test('saknad serverkonfiguration leder till integrationer och startar ingen automatisk synkning eller inloggning', async ({ page }) => {
  const { statistics } = await setup(page, { unconfigured: true });
  await page.goto('/kontor#/mail');
  await expect(page.getByRole('heading', { name: 'Anslut företagets första inkorg', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Mejlinställningar', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/integrations\?service=microsoft365$/);
  await expect(page.getByText('MICROSOFT_CLIENT_SECRET', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anslut Microsoft 365', exact: true })).toBeDisabled();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  expect(statistics.writes).toEqual([]); expect(statistics.businessWrites).toBe(0);
});

test('delad inkorg får valda läsare och Microsoft-anslutning accepterar endast säker inloggningsadress', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { reader, state, statistics } = await setup(page);
  await page.goto('/kontor#/integrations?service=microsoft365');
  await page.getByRole('button', { name: 'Lägg till inkorg', exact: true }).click();
  await page.getByRole('combobox', { name: 'Microsoft-konto', exact: true }).selectOption('connection-1');
  await page.getByLabel('Inkorgens adress', { exact: true }).fill('extra@example.test');
  await page.getByLabel('Visningsnamn', { exact: true }).fill('Extra inkorg');
  await page.getByRole('checkbox', { name: reader.name, exact: true }).check();
  await page.getByRole('button', { name: 'Lägg till delad inkorg', exact: true }).click();
  await expect.poll(() => statistics.writes.filter(write => write.path === '/api/mail/mailboxes' && write.method === 'POST').length).toBe(1);
  expect(statistics.writes.find(write => write.path === '/api/mail/mailboxes')!.body).toEqual({
    connectionId: 'connection-1', address: 'extra@example.test', displayName: 'Extra inkorg', allowedUserIds: [reader.id],
  });
  await page.getByRole('button', { name: 'Hantera extra@example.test', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: reader.name, exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: reader.name, exact: true }).uncheck();
  await page.getByRole('button', { name: 'Spara behörigheter', exact: true }).click();
  await expect.poll(() => statistics.writes.filter(write => write.path === '/api/mail/mailboxes/shared-new' && write.method === 'PUT').length).toBe(1);
  expect(state.mailboxes.find(mailbox => mailbox.id === 'shared-new')!.allowedUserIds).toEqual([]);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByLabel(/Client Secret|API-nyckel/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Anslut ytterligare konto', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Microsofts inloggningsadress kunde inte verifieras.');
  expect(await page.evaluate(() => (window as unknown as { __mailAttack?: number }).__mailAttack)).toBeUndefined();
  expect(statistics.externalAuthorizations).toBe(0);
  expect(statistics.writes.filter(write => write.path === '/api/mail/sync')).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, info, 'mail-integration-1440.png');
  statistics.authorizationUrl = 'https://login.microsoftonline.com/mail-fixture/oauth2/v2.0/authorize?client_id=local-fixture';
  await page.getByRole('button', { name: 'Anslut ytterligare konto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lokal OAuth-fixtur', exact: true })).toBeVisible();
  expect(statistics.externalAuthorizations).toBe(1);
  expect(statistics.writes.filter(write => write.path === '/api/mail/microsoft/connect')).toHaveLength(2);
  expect(statistics.businessWrites).toBe(0); expect(errors).toEqual([]);
});
