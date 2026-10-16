import { expect, test } from '@playwright/test';
import { seedOffice, type OfficeUser } from '../src/office/model';
import { approveCorrection } from '../src/office/customer-model';
import { isSelfOwned } from '../src/office/self-ownership';
import { currentSelfBusinessUserIds, isCurrentUserSelfOwned } from '../src/platform/self-ownership';
import { setCurrentPlatformSession } from '../src/platform/session';
import type { AuthenticatedPlatformSession } from '../src/platform/types';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

function session(organisationId = 'jeroc-demo'): AuthenticatedPlatformSession {
  const user: OfficeUser = { ...seedOffice().users.find(value => value.id === 'admin')!, id: '__platform-admin',
    name: 'Systemadmin', ownAttest: false, maxAttest: 1_000_000 };
  delete user.siteIds;
  return { enabled: true, authenticated: true,
    actor: { id: 'platform-human', name: 'Systemadmin', username: 'admin', platformAdmin: true },
    actualUser: user, user, company: { id: organisationId, name: 'Lokalt testbolag', organisationNumber: '5593593626', status: 'active' },
    organisationId, effectiveUserId: user.id, isSupportSession: false, mustChangePassword: false,
    csrfToken: 'local-self-check', generation: 1, companies: [], selfBusinessUserIds: ['__platform-admin', 'admin'] };
}

test.afterEach(() => setCurrentPlatformSession(undefined));

test('deny-self jämför båda aliasriktningarna, verklig aktör och inga saknade identiteter', () => {
  const value = session();
  setCurrentPlatformSession(value);
  expect(isCurrentUserSelfOwned(['admin'], value.user, value.actualUser)).toBe(true);
  expect(isCurrentUserSelfOwned(['__platform-admin'], { ...value.user, id: 'admin' })).toBe(true);
  expect(isCurrentUserSelfOwned(['admin'], { ...value.user, id: 'anna' }, value.actualUser)).toBe(true);
  expect(isCurrentUserSelfOwned(['kajsa'], value.user, value.actualUser)).toBe(false);
  expect(isSelfOwned([undefined, ''], [undefined, ''], ['admin', '__platform-admin'])).toBe(false);
  expect(isSelfOwned(['admin'], ['__platform-admin'])).toBe(false);
});

test('sessionalias gäller bara autentiserad JEROC-plattformsadmin och ger inga andra bolag självägarskap', () => {
  const value = session('another-company');
  setCurrentPlatformSession(value);
  expect(currentSelfBusinessUserIds()).toBeUndefined();
  expect(isCurrentUserSelfOwned(['admin'], value.user)).toBe(false);
  expect(isCurrentUserSelfOwned(['__platform-admin'], value.user)).toBe(true);
  setCurrentPlatformSession({ ...value, organisationId: 'jeroc-demo', actor: { ...value.actor, platformAdmin: false } });
  expect(isCurrentUserSelfOwned(['admin'], value.user)).toBe(false);
  setCurrentPlatformSession({ enabled: true, authenticated: false });
  expect(isCurrentUserSelfOwned(['admin'], value.user)).toBe(false);
});

test('rättelsemodellen spärrar äldre adminägarskap och verklig skapare utan att ändra ownAttest', () => {
  const data = seedOffice(), value = session();
  const card = { ...data.cards[0], status: 'paid' as const, financialPending: false,
    rows: [{ articleId: 'iron', weight: 100, tier: 'C' as const, price: 2 }] };
  data.cards = [card];
  data.corrections = [{ id: 9001, cardId: card.id, customerId: card.customerId!, articleId: 'iron', weightDelta: -1,
    reason: 'Felregistrerad vikt', document: 'Lokalt underlag', actor: 'Systemadmin', at: '2026-10-16T10:00:00Z',
    status: 'attest', submittedBy: 'admin', effectiveUserId: 'admin', actualUserId: 'admin' }];
  setCurrentPlatformSession(value);
  const context = { user: value.user, actualUser: value.actualUser, selfBusinessUserIds: currentSelfBusinessUserIds() };
  expect(() => approveCorrection(data, 9001, context)).toThrow('Du får inte attestera din egen rättelse.');
  expect(approveCorrection(data, 9001, { ...context, user: { ...value.user, ownAttest: true } }).corrections[0].status).toBe('approved');
  data.corrections[0] = { ...data.corrections[0], submittedBy: 'kajsa', effectiveUserId: 'kajsa', actualUserId: '__platform-admin' };
  expect(() => approveCorrection(data, 9001, { ...context, user: { ...value.user, id: 'anna' } })).toThrow('Du får inte attestera din egen rättelse.');
  data.corrections[0] = { ...data.corrections[0], submittedBy: 'admin', effectiveUserId: 'admin', actualUserId: 'admin' };
  setCurrentPlatformSession(session('another-company'));
  expect(approveCorrection(data, 9001, { ...context, selfBusinessUserIds: currentSelfBusinessUserIds() }).corrections[0].status).toBe('approved');
});

test('äldre adminförberett kort visar spärrad attest för virtuell JEROC-admin men använder inte alias i annat bolag', async ({ page }) => {
  let value = session();
  const data = seedOffice();
  const card = { ...data.cards[0], status: 'attest' as const, preparedBy: 'admin', financialPending: false,
    customerApproval: undefined, rows: [{ articleId: 'iron', weight: 100, tier: 'C' as const, price: 2 }] };
  data.cards = [card]; data.corrections = []; data.users.push(value.user);
  const errors: string[] = [], writes: string[] = [], external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:5173').origin;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (url.origin !== origin) { external.push(url.origin); return route.abort('blockedbyclient'); }
    if (!path.startsWith('/api/')) return route.continue();
    if (!['GET', 'HEAD'].includes(request.method()) && path !== '/api/terminal-demo/staff-session') writes.push(path);
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': local\n\n' });
    const identity = { actualUserId: value.actualUser.id, effectiveUserId: value.user.id };
    const emptyEnvironment = { demo: true, mode: 'prepared-only', revision: 1, ...identity,
      sites: [], municipalities: [], classifications: [], receipts: [], storagePolicies: [], inventory: [], reports: [], drafts: [], corrections: [], reportHistory: [] };
    const body = path === '/api/platform/session' ? value
      : path === '/api/application/office' ? { data, revision: 1 }
      : path === '/api/application/revision' ? { revision: 1 }
      : path === '/api/environment/session' ? { demo: true, ...identity, user: value.user, csrfToken: 'local-environment', expiresAt: '2099-01-01T00:00:00Z' }
      : path === '/api/environment/state' ? emptyEnvironment
      : path.startsWith('/api/environment/sources/') ? { ...emptyEnvironment, sourceId: card.sourceId, receipt: null, draft: null }
      : path === '/api/terminal-demo/staff-session' ? identity
      : path === '/api/terminal-demo/state' ? { configured: true, revision: 1, ...identity, sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] }
      : path === '/api/pricing/state' ? { version: 'self-check', memoryOnly: false, revision: 1, asOfDate: '2026-10-16', metals: [], articles: [], customers: data.customers, users: data.users, customerPrices: [], audit: [] }
      : path === '/api/logistics/summary' ? { active: 0, total: 0 } : undefined;
    return route.fulfill({ status: body ? 200 : 503, json: body ?? { error: 'Endast lokala fixtureanrop tillåts.' } });
  });
  await page.goto(`/kontor#/attest/${card.id}`);
  const attest = page.locator('.office-card-attest');
  await expect(attest.getByText('Du får inte attestera ett kort du själv förberett.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(attest.getByRole('button', { name: 'Attestera · skapa utkast', exact: true })).toBeDisabled();
  value = session('another-company');
  await page.reload();
  await expect(attest.getByRole('button', { name: 'Attestera · skapa utkast', exact: true })).toBeEnabled({ timeout: 15_000 });
  expect(writes).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
