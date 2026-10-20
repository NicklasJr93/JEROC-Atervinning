import { test, expect, type Page, type Request } from '@playwright/test';
import { seedOffice } from '../src/office/model';

test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });
const admin = seedOffice().users.find(user => user.id === 'admin')!;
const own = { enabled: true, authenticated: true, actor: { id: 'global-admin', name: 'Systemadmin', username: 'admin', platformAdmin: true },
  actualUser: admin, user: admin, isSupportSession: false, mustChangePassword: false,
  csrfToken: 'communications-csrf', generation: 1, companies: [] };
const from = 'ScrapPlanner <noreply@scrapplanner.com>';
const config = { email: { configured: true, provider: 'resend', from }, sms: { configured: false } };
const accepted = (body: { requestId: string; to: string }) => ({ ...body, from, provider: 'resend', status: 'accepted',
  providerId: '6b15ec84-6868-41b9-bd02-2d550e5e231e', acceptedAt: '2026-10-20T12:00:00.000Z' });

async function fixture(page: Page, options: { configured?: boolean; failFirst?: boolean; defer?: boolean; support?: boolean; malformed?: boolean;
  smsConfigured?: boolean; smsUnknown?: boolean; smsDelivered?: boolean } = {}) {
  const sends: Request[] = [], configRequests: Request[] = [], returns: Request[] = [], smsSends: Request[] = [], smsReviews: Request[] = [];
  const company = { id: 'test-company', name: 'Testbolaget', organisationNumber: '5593593626', status: 'active' };
  let current: Record<string, unknown> = options.support
    ? { ...own, company, organisationId: company.id, isSupportSession: true, companies: [company] } : own;
  let release: () => void = () => {};
  const gate = options.defer ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/session') return route.fulfill({ json: current });
    if (path === '/api/platform/companies') return route.fulfill({ json: { companies: options.support ? [company] : [] } });
    if (path.endsWith('/users')) return route.fulfill({ json: { users: [admin] } });
    if (path === '/api/platform/telematics') return route.fulfill({ json: { version: 1, revision: 0, devices: [], events: [], requests: [] } });
    if (path === '/api/platform/communications') {
      configRequests.push(request);
      return route.fulfill({ json: options.malformed ? {} : { ...config, email: { ...config.email, configured: options.configured !== false },
        sms: { configured: options.smsConfigured === true, provider: '46elks', from: 'ScrapPlan' } } });
    }
    if (path === '/api/platform/communications/test-email') {
      sends.push(request); await gate;
      if (options.failFirst && sends.length === 1)
        return route.fulfill({ status: 503, json: { error: 'Utskickets resultat är osäkert. Prova igen med samma mottagare.', code: 'system_email_outcome_unknown' } });
      return route.fulfill({ json: accepted(request.postDataJSON()) }).catch(() => {});
    }
    if (path === '/api/platform/open-administration') {
      returns.push(request); current = { ...own, generation: 2, csrfToken: 'new-csrf' };
      return route.fulfill({ json: current });
    }
    if (path === '/api/platform/communications/test-sms') {
      smsSends.push(request); await gate;
      if (options.smsUnknown && smsReviews.length === 0)
        return route.fulfill({ status: 503, json: { error: 'SMS-testets resultat är osäkert. Kontrollera utskicksloggen hos 46elks.', code: 'system_sms_outcome_unknown' } });
      return route.fulfill({ json: { ...request.postDataJSON(), from: 'ScrapPlan', provider: '46elks', status: 'accepted',
        providerId: 's70df59406a1b4643b96f3f91e0bfb7b0', providerStatus: options.smsDelivered ? 'delivered' : 'created',
        acceptedAt: '2026-10-20T12:00:00.000Z' } }).catch(() => {});
    }
    if (path === '/api/platform/communications/review-sms') {
      smsReviews.push(request); return route.fulfill({ json: { reviewed: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/kontor#/platform-admin');
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
  return { sends, configRequests, returns, release, smsSends, smsReviews };
}

test('systemadmin sends one explicit fixed-sender test with CSRF and sees provider acceptance', async ({ page }) => {
  const f = await fixture(page, { defer: true });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await expect(panel).toContainText(from);
  expect(f.sends).toHaveLength(0);
  await panel.getByRole('button', { name: 'Testa mejlutskick', exact: true }).click();
  await panel.getByLabel('Mottagarens e-postadress', { exact: true }).fill('recipient@example.test');
  expect(f.sends).toHaveLength(0);
  await panel.getByRole('button', { name: 'Skicka testmejl', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Skickar…', exact: true })).toBeDisabled();
  expect(f.sends).toHaveLength(1);
  const request = f.sends[0];
  expect(request.headers()).toMatchObject({ 'x-platform-csrf': 'communications-csrf', 'x-platform-generation': '1' });
  expect(request.postDataJSON()).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), to: 'recipient@example.test' });
  f.release();
  await expect(panel.getByRole('status')).toContainText('Resend har tagit emot testmejlet');
  await expect(panel).toContainText('Leveransen till inkorgen är ännu inte bekräftad');
});

test('uncertain failure keeps the same test identity on explicit retry', async ({ page }) => {
  const f = await fixture(page, { failFirst: true });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await panel.getByRole('button', { name: 'Testa mejlutskick', exact: true }).click();
  await panel.getByLabel('Mottagarens e-postadress', { exact: true }).fill('recipient@example.test');
  await panel.getByRole('button', { name: 'Skicka testmejl', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('osäkert');
  expect(f.sends).toHaveLength(1);
  await panel.getByRole('button', { name: 'Skicka testmejl', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Resend har tagit emot');
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1].postDataJSON()).toEqual(f.sends[0].postDataJSON());
});

test('missing configuration or malformed status does not allow a send or break the page', async ({ page }) => {
  const f = await fixture(page, { configured: false });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await expect(panel).toContainText('RESEND_API_KEY');
  await expect(panel.getByRole('button', { name: 'Testa mejlutskick', exact: true })).toBeDisabled();
  expect(f.sends).toHaveLength(0);
  await page.unroute('**/api/**');
  await page.goto('about:blank');
  await fixture(page, { malformed: true });
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bolag', exact: true })).toBeVisible();
});

test('support context cannot see email test; returning to own systemadmin enables it', async ({ page }) => {
  const f = await fixture(page, { support: true });
  await expect(page.getByRole('region', { name: 'Systemutskick', exact: true })).toHaveCount(0);
  expect(f.configRequests).toHaveLength(0); expect(f.sends).toHaveLength(0);
  await page.getByRole('button', { name: 'Avsluta Jobba som', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Systemutskick', exact: true })).toBeVisible();
  expect(f.returns).toHaveLength(1);
  expect(f.returns[0].postDataJSON()).toEqual({});
  expect(f.returns[0].headers()['x-platform-csrf']).toBe('communications-csrf');
  expect(f.sends).toHaveLength(0);
});

test('SMS button is beside email test and sends one explicit normalized SMS with session protection', async ({ page }) => {
  const f = await fixture(page, { smsConfigured: true, defer: true });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  const emailToggle = panel.getByRole('button', { name: 'Testa mejlutskick', exact: true });
  const smsToggle = panel.getByRole('button', { name: 'Testa SMS-utskick', exact: true });
  await expect(smsToggle).toBeVisible();
  expect(await smsToggle.evaluate(element => element.parentElement?.querySelectorAll('button').length)).toBe(2);
  await expect(emailToggle).toBeVisible(); expect(f.smsSends).toHaveLength(0);
  await smsToggle.click();
  await panel.getByLabel('Mottagarens telefonnummer', { exact: true }).fill('070 123 45 67');
  expect(f.smsSends).toHaveLength(0);
  await panel.getByRole('button', { name: 'Skicka test-SMS', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Skickar SMS…', exact: true })).toBeDisabled();
  await expect(emailToggle).toBeDisabled();
  expect(f.smsSends).toHaveLength(1);
  expect(f.smsSends[0].postDataJSON()).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), to: '+46701234567' });
  expect(f.smsSends[0].headers()).toMatchObject({ 'x-platform-csrf': 'communications-csrf', 'x-platform-generation': '1' });
  f.release();
  await expect(panel.getByRole('status')).toContainText('46elks har tagit emot test-SMS:et');
  await expect(panel).toContainText('Leveransen till telefonen är ännu inte bekräftad');
  expect(f.sends).toHaveLength(0);
});

test('SMS missing credentials disables only SMS and leaves email usable', async ({ page }) => {
  const f = await fixture(page);
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await expect(panel.getByRole('button', { name: 'Testa SMS-utskick', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Testa mejlutskick', exact: true })).toBeEnabled();
  await expect(panel).toContainText('ELKS_API_USERNAME och ELKS_API_PASSWORD');
  expect(f.smsSends).toHaveLength(0);
});

test('uncertain SMS result requires explicit provider log review and never sends during review', async ({ page }) => {
  const f = await fixture(page, { smsConfigured: true, smsUnknown: true });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await panel.getByRole('button', { name: 'Testa SMS-utskick', exact: true }).click();
  await panel.getByLabel('Mottagarens telefonnummer', { exact: true }).fill('070 123 45 67');
  await panel.getByRole('button', { name: 'Skicka test-SMS', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('osäkert');
  await expect(panel.getByRole('button', { name: 'Skicka test-SMS', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Tillåt ett nytt SMS-test', exact: true })).toBeDisabled();
  expect(f.smsSends).toHaveLength(1); expect(f.smsReviews).toHaveLength(0);
  await panel.getByLabel('Jag har kontrollerat utskicksloggen', { exact: true }).check();
  await panel.getByRole('button', { name: 'Tillåt ett nytt SMS-test', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Inget SMS skickades');
  expect(f.smsSends).toHaveLength(1); expect(f.smsReviews).toHaveLength(1);
  expect(f.smsReviews[0].headers()['x-platform-csrf']).toBe('communications-csrf');
  await panel.getByRole('button', { name: 'Skicka test-SMS', exact: true }).click();
  await expect(panel.getByText(/46elks har tagit emot test-SMS:et/)).toBeVisible();
  expect(f.smsSends).toHaveLength(2);
  expect(f.smsSends[1].postDataJSON().requestId).not.toBe(f.smsSends[0].postDataJSON().requestId);
});

test('delivery is reported only when the provider explicitly confirms delivered', async ({ page }) => {
  await fixture(page, { smsConfigured: true, smsDelivered: true });
  const panel = page.getByRole('region', { name: 'Systemutskick', exact: true });
  await panel.getByRole('button', { name: 'Testa SMS-utskick', exact: true }).click();
  await panel.getByLabel('Mottagarens telefonnummer', { exact: true }).fill('+46701234567');
  await panel.getByRole('button', { name: 'Skicka test-SMS', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('46elks rapporterar att test-SMS:et');
  await expect(panel.getByRole('status')).toContainText('är levererat');
});
