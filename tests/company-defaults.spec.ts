import { test, expect, type Page } from '@playwright/test';
import { applyInitialPaymentTerms, loadCompanyDefaults, type CompanyDefaultsSnapshot } from '../src/company-settings-defaults';
import { companyLookupScope } from '../src/company-register/client';
import { setCurrentPlatformSession } from '../src/platform/session';
import { seedOffice } from '../src/office/model';
import { createCustomerDraft } from '../src/office/customer-form';
import type { AuthenticatedPlatformSession } from '../src/platform/types';
import { migrateOffice } from '../src/office/customer-model';

const companyId = 'defaults-company-a';
const snapshot: CompanyDefaultsSnapshot = {
  companyId, version: 3, defaults: { paymentTermsDays: 45 }, profile: { name: 'Bolag A' },
};
function platformSession(id = companyId, generation = 1): AuthenticatedPlatformSession {
  const user = seedOffice().users.find(value => value.id === 'admin')!;
  return {
    enabled: true, authenticated: true, actor: { id: 'defaults-actor', name: 'Admin', username: 'admin', platformAdmin: false },
    actualUser: user, user, organisationId: id, effectiveUserId: user.id, generation,
    isSupportSession: false, mustChangePassword: false, csrfToken: 'defaults-csrf', companies: [],
  };
}
async function fakeDefaults(reply: unknown, callback: () => Promise<unknown>, beforeReply?: (options?: RequestInit) => void, expectedPlatformCompany: string | null = companyId) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    expect(input).toBe('/api/company-settings/defaults');
    expect(options?.method).toBe('GET');
    expect(options?.cache).toBe('no-store');
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).get('X-Platform-Organisation-Id')).toBe(expectedPlatformCompany);
    beforeReply?.(options);
    return new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } });
  };
  try { return await callback(); }
  finally { globalThis.fetch = originalFetch; setCurrentPlatformSession(undefined); }
}
test.afterEach(() => setCurrentPlatformSession(undefined));

test('minimal company defaults use the captured authenticated company and discard administrative fields', async () => {
  setCurrentPlatformSession(platformSession());
  const result = await fakeDefaults({ ...snapshot, notifications: { integrationErrors: ['private@example.test'] },
    profile: { name: snapshot.profile.name, invoiceEmail: 'private@example.test' }, documents: { footerText: 'Internt' } },
  () => loadCompanyDefaults());
  expect(result).toEqual(snapshot);
});

test('employee defaults carry the captured person and company without requiring a platform session', async () => {
  const scope = companyLookupScope({ 'X-Employee-Company': companyId, 'X-Employee-Person': 'defaults-person' });
  const result = await fakeDefaults(snapshot, () => loadCompanyDefaults({ scope }), options => {
    const headers = new Headers(options?.headers);
    expect(headers.get('X-Employee-Company')).toBe(companyId);
    expect(headers.get('X-Employee-Person')).toBe('defaults-person');
  }, null);
  expect(result).toEqual(snapshot);
});

test('defaults for another company or a superseded platform generation cannot populate a draft', async () => {
  setCurrentPlatformSession(platformSession());
  await expect(fakeDefaults({ ...snapshot, companyId: 'defaults-company-b' }, () => loadCompanyDefaults()))
    .rejects.toMatchObject({ code: 'company_settings_scope_changed', status: 409 });
  setCurrentPlatformSession(platformSession());
  const scope = companyLookupScope();
  await expect(fakeDefaults(snapshot, () => loadCompanyDefaults({ scope }), () => setCurrentPlatformSession(platformSession(companyId, 2))))
    .rejects.toMatchObject({ code: 'company_settings_scope_changed', status: 409 });
});

test('malformed defaults do not silently become valid customer terms', async () => {
  for (const days of [-1, 1.5, 366, '30', undefined]) {
    setCurrentPlatformSession(platformSession());
    await expect(fakeDefaults({ ...snapshot, defaults: { paymentTermsDays: days } }, () => loadCompanyDefaults()))
      .rejects.toMatchObject({ code: 'company_settings_invalid_response', status: 502 });
  }
});

test('late company defaults fill an untouched fresh draft without mutating it or resetting other fields', () => {
  const draft = { ...createCustomerDraft(seedOffice()), name: 'Manuellt ifyllt namn', phone: '+46722002220' };
  const result = applyInitialPaymentTerms(draft, snapshot.defaults, { fresh: true });
  expect(result).toMatchObject({ name: draft.name, phone: draft.phone, paymentTermDays: 45 });
  expect(draft.paymentTermDays).toBeUndefined();
  expect(applyInitialPaymentTerms(draft, { paymentTermsDays: 0 }, { fresh: true }).paymentTermDays).toBe(0);
  expect(applyInitialPaymentTerms(draft, { paymentTermsDays: null }, { fresh: true })).toBe(draft);
});

test('existing records and transferred drafts preserve explicit terms and integration standard', () => {
  const draft = createCustomerDraft(seedOffice());
  expect(applyInitialPaymentTerms(draft, snapshot.defaults, { fresh: false })).toBe(draft);
  expect(applyInitialPaymentTerms(draft, snapshot.defaults, { fresh: true, transferred: true })).toBe(draft);
  expect(applyInitialPaymentTerms(draft, snapshot.defaults, { fresh: true, initialValue: 10 })).toBe(draft);
  const entered = { ...draft, paymentTermDays: 10 };
  expect(applyInitialPaymentTerms(entered, snapshot.defaults, { fresh: true })).toBe(entered);
});

test('choosing integration standard after another value stays explicit when a delayed default arrives', () => {
  const draft = createCustomerDraft(seedOffice());
  // A user can change 10 -> undefined, returning to the initial value. Value
  // comparison alone would lose that choice; the form's dirty flag preserves it.
  const typed = { ...draft, paymentTermDays: 10 };
  const cleared = { ...typed, paymentTermDays: undefined };
  expect(applyInitialPaymentTerms(cleared, snapshot.defaults, { fresh: true, dirty: true })).toBe(cleared);
  expect(cleared.paymentTermDays).toBeUndefined();
});

test.describe('company payment defaults in customer forms', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

  async function openCustomer(page: Page, options: { delayed?: boolean; existing?: boolean } = {}) {
    const office = migrateOffice(seedOffice());
    office.customers[0].paymentTermDays = 10;
    const session = platformSession();
    const company = { id: companyId, name: snapshot.profile.name, organisationNumber: '5593593626', status: 'active' };
    const auth = { ...session, company, companies: [company] };
    let release!: () => void;
    const ready = options.delayed ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    let defaultsReplies = 0;
    const writes: string[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET' && ['/api/application/office', '/api/pricing/customers'].includes(path)) writes.push(path);
      if (path === '/api/platform/session') return route.fulfill({ json: auth });
      if (path === '/api/company-settings/defaults') {
        await ready;
        defaultsReplies += 1;
        return route.fulfill({ json: snapshot });
      }
      if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
      if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
      if (path === '/api/pricing/state') return route.fulfill({ json: {
        version: 'defaults-fixture', revision: 1, memoryOnly: true, asOfDate: '2026-10-20', metals: [], articles: [], customers: [],
      } });
      if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: session.user.id, effectiveUserId: session.user.id } });
      if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision: 1,
        actualUserId: session.user.id, effectiveUserId: session.user.id, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [],
      } });
      if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
      if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
      return route.fulfill({ status: 503, json: { error: 'Valfri tjänst används inte i detta isolerade prov.' } });
    });
    await page.goto(`/kontor#/customers/${options.existing ? `${office.customers[0].id}?tab=details` : 'new'}`);
    await expect(page.getByLabel('Betalningsvillkor', { exact: true })).toBeVisible();
    return { release: () => release?.(), replies: () => defaultsReplies, writes };
  }

  test('new customer receives company terms while other manually entered fields remain unchanged', async ({ page }) => {
    const fixture = await openCustomer(page, { delayed: true });
    await page.getByLabel('Namn', { exact: true }).fill('Mitt manuella kundnamn');
    fixture.release();
    await expect(page.getByLabel('Betalningsvillkor', { exact: true })).toHaveValue('custom');
    await expect(page.getByLabel('Antal betalningsdagar', { exact: true })).toHaveValue('45');
    await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Mitt manuella kundnamn');
    expect(fixture.writes).toEqual([]);
  });

  test('a delayed default cannot replace an explicit return to integration standard', async ({ page }) => {
    const fixture = await openCustomer(page, { delayed: true });
    const terms = page.getByLabel('Betalningsvillkor', { exact: true });
    await terms.selectOption('10');
    await terms.selectOption('default');
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/company-settings/defaults'
      && response.request().headers()['x-demo-actor'] === 'admin');
    fixture.release();
    await (await received).finished();
    await expect.poll(fixture.replies).toBeGreaterThan(0);
    await expect(terms).toHaveValue('default');
    await expect(page.getByLabel('Antal betalningsdagar', { exact: true })).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
  });

  test('opening and editing an existing customer preserves its saved terms', async ({ page }) => {
    const fixture = await openCustomer(page, { existing: true });
    const terms = page.getByLabel('Betalningsvillkor', { exact: true });
    await expect(terms).toHaveValue('10');
    await page.getByRole('button', { name: 'Redigera kund', exact: true }).click();
    await expect(terms).toBeEnabled();
    await expect(terms).toHaveValue('10');
    expect(fixture.writes).toEqual([]);
  });
});
