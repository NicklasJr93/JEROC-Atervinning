import { expect, test, type Page, type Request } from '@playwright/test';
import type { DemoData } from '../src/model';
import type { CustomerIntake, CustomerIntakeInput } from '../src/customer-intake/types';
import { emptyEmployeeFleet } from './helpers/employee-fleet';
import type { TerminalSessionState } from '../src/office/terminal-demo-types';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'sv-SE' });

const token = 'i'.repeat(43);
const publicPath = '/api/public/customer-intake';
const staffPath = '/api/employee/customer-intake';
const draftId = 'browser-intake-draft';
const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
const proposal = { type: 'Företag', name: 'Kundens inskickade företag AB', number: '5593593626',
  phone: '+46722002220', email: 'kund@example.test', address: 'Testgatan 1', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' } satisfies CustomerIntakeInput;

async function publicFixture(page: Page, { unavailable = false, staleOnSubmit = false, lostFirstSubmit = false } = {}) {
  const reads: Request[] = [], submissions: Request[] = [];
  let status = 'waiting';
  await page.context().addCookies([{ name: 'jeroc_platform', value: 'unrelated-private-staff-session', url: String(test.info().project.use.baseURL) }]);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === `${publicPath}/company-lookup`) {
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      expect(request.headers().cookie).toBeUndefined();
      return route.fulfill({ status: 503, json: { code: 'company_lookup_unavailable', error: 'Fyll i uppgifterna manuellt.' } });
    }
    if (url.pathname === `${publicPath}/person-lookup`) {
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      expect(request.headers().cookie).toBeUndefined();
      // SCB/wizard regressions keep the optional person provider unavailable;
      // its successful lookups and paid-retry behavior have separate fixtures.
      return route.fulfill({ status: 503, json: { code: 'person_lookup_not_configured', error: 'Fyll i uppgifterna manuellt.' } });
    }
    if (url.pathname === publicPath || url.pathname === `${publicPath}/submit`) {
      reads.push(request);
      expect(request.headers().authorization).toBe(`Bearer ${token}`);
      expect(request.headers().cookie).toBeUndefined();
      expect(request.url()).not.toContain(token);
      if (unavailable || staleOnSubmit && url.pathname.endsWith('/submit'))
        return route.fulfill({ status: 410, json: { error: 'Kundlänken har gått ut eller ersatts.', code: 'customer_intake_unavailable' } });
      if (url.pathname.endsWith('/submit')) {
        submissions.push(request);
        if (lostFirstSubmit && submissions.length === 1)
          return route.fulfill({ status: 503, json: { error: 'Det gick inte att bekräfta att uppgifterna kom fram.' } });
        status = 'submitted';
      }
      return route.fulfill({ json: { company: { name: 'Intagstest Återvinning AB' },
        intake: { id: 'public-intake', status, expiresAt: expiresAt() } } });
    }
    if (url.pathname === '/api/platform/tenant-context') return route.fulfill({ json: { companyId: 'unrelated-company', companyName: 'Ska inte styra kundlänken' } });
    return route.fulfill({ status: 401, json: { error: 'Detta anonyma formulär behöver inget annat API.' } });
  });
  return { reads, submissions };
}

async function fillContact(page: Page) {
  await expect(page.getByText('Steg 1 av 4', { exact: true })).toBeVisible();
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559359-3626');
  await page.getByLabel('Företagsnamn', { exact: true }).fill(proposal.name);
  await page.getByLabel('Postadress', { exact: true }).fill(proposal.address);
  await page.getByLabel('Postnummer', { exact: true }).fill('761 41');
  await page.getByLabel('Ort', { exact: true }).fill(proposal.city);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByText('Steg 2 av 4', { exact: true })).toBeVisible();
  await page.getByLabel('Telefonnummer', { exact: true }).fill('072 200 22 20');
  await page.getByLabel('E-postadress', { exact: true }).fill(proposal.email);
}

async function continueToBank(page: Page) {
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByText('Steg 3 av 4', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Utbetalning', exact: true })).toBeVisible();
}

async function skipBank(page: Page) {
  await continueToBank(page);
  await page.getByRole('button', { name: 'Hoppa över bankuppgifter', exact: true }).click();
  await expect(page.getByText('Steg 4 av 4', { exact: true })).toBeVisible();
}

test('SMS-länken visar endast kundformulär, förklarar e-post/bank och skickar bankuppgifter utan Swish eller inloggning', async ({ page }) => {
  const f = await publicFixture(page);
  await page.goto(`/kunduppgifter/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Dina kunduppgifter', exact: true })).toBeVisible();
  await expect(page.getByText('Intagstest Återvinning AB', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Steg 1 av 4', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('customer-step1.png'), fullPage: true });
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/organisations- eller personnummer/i);
  await fillContact(page);
  await expect(page.getByText(/ingen reklam/i)).toBeVisible();
  await page.getByLabel('E-postadress', { exact: true }).fill('ogiltig e-post');
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/e-postadress/i);
  await expect(page.getByText('Steg 2 av 4', { exact: true })).toBeVisible();
  await page.getByLabel('E-postadress', { exact: true }).fill(proposal.email);
  await continueToBank(page);
  await expect(page.getByText(/Sparas på ditt kundkort/)).toBeVisible();
  const swish = page.getByRole('button', { name: 'Swish – kommer snart', exact: true });
  await expect(swish).toBeDisabled();
  await swish.click({ force: true });
  await expect(page.getByRole('status').filter({ hasText: /^Kommer snart$/ })).toBeVisible();
  await expect(page.getByLabel('Swish-nummer', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /lösenord|användarnamn/i })).toHaveCount(0);
  await expect(page.locator('.terminal-material-table')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true }).check();
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText('Steg 3 av 4', { exact: true })).toBeVisible();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('00123456789');
  await page.getByLabel('Kontohavare', { exact: true }).fill(proposal.name);
  await expect(page.getByRole('option', { name: 'Swish', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByText('Steg 4 av 4', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Samma som postadressen', exact: true })).toBeChecked();
  await expect(page.getByLabel('Ursprungsadress', { exact: true })).toHaveValue(proposal.address);
  await expect(page.getByLabel('Ursprungets postnummer', { exact: true })).toHaveValue(/761\s?41/);
  await expect(page.getByLabel('Ursprungets ort', { exact: true })).toHaveValue(proposal.city);
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(page.getByText('Steg 3 av 4', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveValue('00123456789');
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await page.getByLabel('Referens (valfritt)', { exact: true }).fill('Projekt 42');
  await page.screenshot({ path: test.info().outputPath('customer-step4.png'), fullPage: true });
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0].postDataJSON()).toMatchObject({ requestId: expect.any(String), customer: { ...proposal, reference: 'Projekt 42',
    originDetails: { address: proposal.address, postalCode: proposal.postalCode, city: proposal.city, countryCode: 'SE' },
    paymentProfile: { method: 'bank', bankType: 'account', clearing: '8327', account: '00123456789', holder: proposal.name } } });
  expect(page.url()).not.toContain(token);
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('återkallad länk rensar kundens ifyllda formulär och visar inga uppgifter efter nekad inskickning', async ({ page }) => {
  const f = await publicFixture(page, { staleOnSubmit: true });
  await page.goto(`/kunduppgifter/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Dina kunduppgifter', exact: true })).toBeVisible();
  await fillContact(page);
  await skipBank(page);
  await page.getByRole('button', { name: 'Hoppa över och skicka', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Länken kan inte användas', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText(proposal.name, { exact: true })).toHaveCount(0);
  expect(f.submissions).toHaveLength(0); expect(page.url()).not.toContain(token);
});

test('SCB söker bara kompletta företagsnummer och sena svar skriver inte över manuella uppgifter eller ursprung', async ({ page }) => {
  const f = await publicFixture(page);
  await page.clock.install();
  const lookups: Request[] = [];
  let releaseStale = () => {};
  const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
  const company = { organisationNumber: proposal.number, name: 'Automatiskt registerföretag AB', address: 'Registergatan 7',
    postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', phone: '+46722002220', email: 'register@example.test',
    source: 'SCB', fetchedAt: new Date().toISOString() };
  await page.route(`**${publicPath}/company-lookup`, async route => {
    const request = route.request(); lookups.push(request);
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    expect(request.headers().cookie).toBeUndefined();
    const { organisationNumber } = request.postDataJSON();
    if (organisationNumber === '5560000167') {
      await staleGate;
      return route.fulfill({ json: { company: { ...company, organisationNumber, name: 'Föråldrat registersvar AB' } } });
    }
    if (organisationNumber === '5560360793')
      return route.fulfill({ status: 503, json: { code: 'company_lookup_unavailable', error: 'Fyll i uppgifterna manuellt.' } });
    return route.fulfill({ json: { company } });
  });
  await page.goto(`/kunduppgifter/#token=${token}`);
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  for (const incompleteOrPrivate of ['559359362', '5593593627', '19900101-0017']) {
    await number.fill(incompleteOrPrivate);
    await page.clock.fastForward(500);
    expect(lookups).toHaveLength(0);
  }
  await number.fill(proposal.number);
  await page.clock.fastForward(500);
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(company.name);
  expect(lookups).toHaveLength(1);
  expect(lookups[0].postDataJSON()).toEqual({ organisationNumber: proposal.number });
  await expect(page.getByRole('button', { name: 'Använd företagsuppgifter', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Postadress', { exact: true })).toHaveValue(company.address);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue(company.email);
  await page.getByLabel('E-postadress', { exact: true }).fill('manual@example.test');
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await expect(number).toBeFocused();
  await expect.poll(() => number.evaluate(element => {
    const input = element as HTMLInputElement;
    return [input.selectionStart, input.selectionEnd];
  })).toEqual([0, proposal.number.length]);
  await number.fill('5560000167');
  await page.clock.fastForward(500);
  await expect.poll(() => lookups.length).toBe(2);
  await page.getByLabel('Företagsnamn', { exact: true }).fill('Manuellt företag efter registerfel AB');
  await number.fill('5560360793');
  await page.clock.fastForward(500);
  await expect.poll(() => lookups.length).toBe(3);
  await expect(page.getByRole('status').filter({ hasText: /manuellt.*fortsätta/i }).first()).toBeVisible();
  releaseStale();
  await expect(number).toHaveValue('5560360793');
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue('Manuellt företag efter registerfel AB');
  await page.getByLabel('Postadress', { exact: true }).fill('Manuell postadress 8');
  await page.getByLabel('Postnummer', { exact: true }).fill('76141');
  await page.getByLabel('Ort', { exact: true }).fill('Norrtälje');
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('manual@example.test');
  await page.getByLabel('Telefonnummer', { exact: true }).fill('072 200 22 20');
  await skipBank(page);
  await expect(page.getByRole('checkbox', { name: 'Samma som postadressen', exact: true })).toBeChecked();
  await expect(page.getByLabel('Ursprungsadress', { exact: true })).toHaveValue('Manuell postadress 8');
  await page.getByRole('checkbox', { name: 'Samma som postadressen', exact: true }).uncheck();
  await page.getByLabel('Ursprungsadress', { exact: true }).fill('Byggplatsen 9');
  await page.getByLabel('Ursprungets postnummer', { exact: true }).fill('11122');
  await page.getByLabel('Ursprungets ort', { exact: true }).fill('Stockholm');
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await page.getByRole('button', { name: 'Tillbaka', exact: true }).click();
  await page.getByLabel('Postadress', { exact: true }).fill('Ändrad postadress 10');
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await skipBank(page);
  await expect(page.getByRole('checkbox', { name: 'Samma som postadressen', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Ursprungsadress', { exact: true })).toHaveValue('Byggplatsen 9');
  await page.getByLabel('Referens (valfritt)', { exact: true }).fill('Projekt efter registerfel');
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(f.submissions).toHaveLength(1);
  expect(f.submissions[0].postDataJSON().customer).toMatchObject({ number: '5560360793', name: 'Manuellt företag efter registerfel AB',
    email: 'manual@example.test', address: 'Ändrad postadress 10', reference: 'Projekt efter registerfel',
    originDetails: { address: 'Byggplatsen 9', postalCode: '11122', city: 'Stockholm', countryCode: 'SE' } });
  expect(f.submissions[0].postDataJSON().customer).not.toHaveProperty('paymentProfile');
});

test('förlorat slutsvar återanvänder exakt samma kunduppgifter och requestId utan ett nytt SCB-uppslag', async ({ page }) => {
  const f = await publicFixture(page, { lostFirstSubmit: true });
  await page.clock.install();
  let lookups = 0;
  const firstCompany = { organisationNumber: proposal.number, name: 'Första registerföretaget AB', address: 'Första registergatan 7',
    postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', phone: '+46722002220', email: 'first@example.test',
    source: 'SCB', fetchedAt: new Date().toISOString() };
  await page.route(`**${publicPath}/company-lookup`, async route => {
    lookups++;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers().cookie).toBeUndefined();
    return route.fulfill({ json: { company: lookups === 1 ? firstCompany : {
      ...firstCompany, name: 'Ändrat registerföretag efter slutsvar AB', address: 'Annan registergata 99',
    } } });
  });
  await page.goto(`/kunduppgifter/#token=${token}`);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(proposal.number);
  await page.clock.fastForward(500);
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(firstCompany.name);
  await expect(page.getByLabel('Postadress', { exact: true })).toHaveValue(firstCompany.address);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await skipBank(page);
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/samma uppgifter/i);
  expect(f.submissions).toHaveLength(1);
  const firstAttempt = f.submissions[0].postDataJSON();
  expect(firstAttempt.customer).toMatchObject({ name: firstCompany.name, email: firstCompany.email, address: firstCompany.address,
    originDetails: { address: firstCompany.address, postalCode: firstCompany.postalCode, city: firstCompany.city, countryCode: 'SE' } });
  // Let the former busy→idle lookup debounce elapse. A changing SCB response
  // must never alter an uncertain submission before its idempotent retry.
  await page.clock.fastForward(500);
  expect(lookups).toBe(1);
  await expect(page.getByLabel('Ursprungsadress', { exact: true })).toHaveValue(firstCompany.address);
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1].postDataJSON()).toEqual(firstAttempt);
  expect(lookups).toBe(1);
});

test('en avbruten SMS-länk hindrar inte en ny länk i samma öppna sida och nästa kund får ett tomt formulär', async ({ page }) => {
  const nextToken = 'n'.repeat(43), requests: Request[] = [];
  await page.context().addCookies([{ name: 'jeroc_platform', value: 'unrelated-private-staff-session', url: String(test.info().project.use.baseURL) }]);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === publicPath) {
      requests.push(request);
      const current = request.headers().authorization;
      expect(request.headers().cookie).toBeUndefined();
      if (current === `Bearer ${token}`)
        return route.fulfill({ status: 410, json: { error: 'Kundlänken har avslutats.', code: 'customer_intake_unavailable' } });
      expect([`Bearer ${token}`, `Bearer ${nextToken}`]).toContain(current);
      return route.fulfill({ json: { company: { name: 'Nya kundlänkar AB' },
        intake: { id: current === `Bearer ${token}` ? 'cancelled-old-intake' : 'fresh-intake', status: 'waiting', expiresAt: expiresAt() } } });
    }
    return route.fulfill({ status: 503, json: { code: 'company_lookup_unavailable', error: 'Fyll i uppgifterna manuellt.' } });
  });
  await page.goto(`/kunduppgifter/#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Länken kan inte användas', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  // A real fragment navigation can produce both popstate and hashchange. The
  // second event must not erase the freshly captured, immediately scrubbed token.
  await page.evaluate(value => { window.location.hash = `token=${value}`; }, nextToken);
  await expect(page.getByRole('heading', { name: 'Dina kunduppgifter', exact: true })).toBeVisible();
  await expect(page.getByText('Steg 1 av 4', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  expect(requests.some(request => request.headers().authorization === `Bearer ${nextToken}`)).toBe(true);
  expect(page.url()).not.toContain(token); expect(page.url()).not.toContain(nextToken);
});

async function mobileFixture(page: Page) {
  const personId = 'intake-mobile-person', companyId = 'intake-browser-company';
  let data: DemoData = { version: 1, customers: [], drafts: [{ id: draftId, number: 9010, siteId: 'main', mode: 'direct', status: 'draft',
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', reference: '', origin: '',
    rows: [{ id: 'original-row', articleId: 'copper-1', method: 'direct', weight: 10 }] }] };
  let intake: CustomerIntake | null = null, revision = 1, loseNextCreateResponse = false;
  const issued = new Map<string, CustomerIntake>();
  let writeGate: Promise<void> | undefined;
  const creates: Request[] = [], cancels: Request[] = [], applies: Request[] = [], mobileWrites: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/platform/tenant-context') return route.fulfill({ json: { companyId, companyName: 'Mobilintag AB' } });
    if (url.pathname === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (url.pathname === staffPath || url.pathname.startsWith(`${staffPath}/`)) {
      expect(request.headers()['x-employee-company']).toBe(companyId);
      expect(request.headers()['x-employee-person']).toBe(personId);
      if (request.method() === 'GET') return route.fulfill({ json: { intake, terminals: [{ id: 'terminal-1', name: 'Kassan', siteId: 'main', available: true }], smsConfigured: true } });
      if (url.pathname === staffPath) {
        creates.push(request);
        const requestId = request.postDataJSON().requestId;
        intake = issued.get(requestId) ?? { id: `mobile-intake-${creates.length}`, draftId, channel: 'sms', status: 'waiting', expiresAt: expiresAt(), recipientMasked: '+46••••4567' };
        issued.set(requestId, intake);
        if (loseNextCreateResponse) {
          loseNextCreateResponse = false;
          return route.fulfill({ status: 503, json: { error: 'Det gick inte att bekräfta utskicket. Uppdatera status.' } });
        }
        return route.fulfill({ json: { intake } });
      }
      if (url.pathname.endsWith('/cancel')) {
        cancels.push(request); expect(request.postDataJSON().id).toBe(intake?.id);
        intake = { ...intake!, status: 'cancelled' };
        for (const [key, value] of issued) if (value.id === intake.id) issued.set(key, intake);
        return route.fulfill({ json: { intake } });
      }
      if (url.pathname.endsWith('/apply')) {
        applies.push(request);
        const customer = { id: 'intake-created-customer', ...proposal, references: [], origins: [] };
        intake = { ...intake!, status: 'applied' }; revision++;
        const latest = data.drafts[0];
        const draftPatch = { id: draftId, customerId: customer.id, reference: latest.reference, origin: latest.origin, updatedAt: latest.updatedAt };
        data = { ...data, customers: [customer], drafts: data.drafts.map(draft => draft.id === draftId ? { ...draft, ...draftPatch } : draft) };
        return route.fulfill({ json: { intake, customer, draftPatch, revision } });
      }
      return route.fulfill({ status: 409, json: { error: 'Kommandot ingår inte i provet.' } });
    }
    if (url.pathname.startsWith('/api/employee/')) return route.fulfill({ json: { companyId, companyName: 'Mobilintag AB',
      person: { id: personId, name: 'Gårdsmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['main'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true },
      activeSiteId: 'main', sites: [{ id: 'main', name: 'Huvudanläggningen', active: true }],
      today: '2026-10-20', month: '2026-10', date: '2026-10-20', gate: { blocked: false },
      days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] } } });
    if (url.pathname === '/api/application/mobile') {
      if (request.method() === 'POST') {
        mobileWrites.push(request);
        const gate = writeGate; writeGate = undefined; await gate;
        const command = request.postDataJSON();
        for (const field of ['customers', 'drafts'] as const) for (const change of command[field] || [])
          data = { ...data, [field]: [...data[field].filter(value => value.id !== change.id), ...(change.next ? [change.next] : [])] };
        revision++;
      }
      return route.fulfill({ json: { data, revision, catalog: [{ id: 'copper-1', active: true, category: 'koppar', name: 'Testkoppar',
        description: '', includes: '', excludes: '', photos: [0], prices: [1, 1, 1] }], groups: [{ id: 'koppar', name: 'Koppar',
        description: '', photo: 0, sortOrder: 0, active: true, revision: 1 }] } });
    }
    return route.fulfill({ json: { revision } });
  });
  return { creates, cancels, applies, mobileWrites, data: () => data, intake: () => intake,
    loseNextCreateResponse: () => { loseNextCreateResponse = true; },
    holdWrite: () => { let release = () => {}; writeGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    submit: () => { intake = { ...intake!, status: 'submitted', proposal, hasPaymentProfile: true }; },
    changeWeight: () => { data = { ...data, drafts: data.drafts.map(draft => ({ ...draft,
      rows: [{ ...draft.rows[0], method: 'direct', weight: 37 }, { id: 'concurrent-row', articleId: 'copper-1', method: 'direct', weight: 5 }] })) }; revision++; } };
}

test('förlorat SMS-svar kan hämtas, avbrytas och skickas om med en ny förfrågan', async ({ page }) => {
  const f = await mobileFixture(page);
  f.loseNextCreateResponse();
  await page.goto(`/#/weigh/${draftId}/customer`);
  await page.getByRole('button', { name: 'Låt kunden fylla i', exact: true }).click();
  await page.getByRole('button', { name: 'SMS', exact: true }).click();
  await page.getByLabel('Kundens mobilnummer', { exact: true }).fill('0701234567');
  await page.getByRole('button', { name: 'Skicka formulär via SMS', exact: true }).click();
  await page.getByRole('button', { name: 'Uppdatera status', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inväntar kunduppgifter', exact: true })).toBeVisible();
  const oldId = f.intake()?.id;
  await page.getByRole('button', { name: 'Avbryt kundförfrågan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kundförfrågan avbruten', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Låt kunden fylla i', exact: true }).click();
  await page.getByRole('button', { name: 'SMS', exact: true }).click();
  await page.getByLabel('Kundens mobilnummer', { exact: true }).fill('0701234567');
  await page.getByRole('button', { name: 'Skicka formulär via SMS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inväntar kunduppgifter', exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(2); expect(f.cancels).toHaveLength(1);
  expect(f.creates[1].postDataJSON().requestId).not.toBe(f.creates[0].postDataJSON().requestId);
  expect(f.intake()?.id).not.toBe(oldId); expect(f.intake()?.status).toBe('waiting');
});

test('mobilen väntar på sparat utkast före SMS och behåller fortsatt vägning när kundförslaget används', async ({ page }) => {
  const f = await mobileFixture(page);
  await page.goto(`/#/weigh/${draftId}/summary`);
  await expect(page.getByRole('heading', { name: 'Sammanställning', exact: true })).toBeVisible();
  await expect(page.getByTestId('total-weight')).toHaveText('10 kg');
  const release = f.holdWrite();
  await page.getByRole('button', { name: 'Ändra Testkoppar', exact: true }).click();
  await page.getByRole('textbox', { name: 'Vikt i kg', exact: true }).fill('37');
  await page.getByRole('button', { name: 'Färdigvägt', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('37 kg');
  await page.getByRole('button', { name: /Lägg till kund/ }).click();
  await page.getByRole('button', { name: 'Låt kunden fylla i', exact: true }).click();
  await page.getByRole('button', { name: 'SMS', exact: true }).click();
  await page.getByLabel('Kundens mobilnummer', { exact: true }).fill('0701234567');
  await page.getByRole('button', { name: 'Skicka formulär via SMS', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Skickar förfrågan…', exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(0);
  release();
  await expect(page.getByRole('heading', { name: 'Inväntar kunduppgifter', exact: true })).toBeVisible();
  expect(f.creates).toHaveLength(1);
  expect(f.creates[0].postDataJSON()).toMatchObject({ draftId, channel: 'sms', phone: '0701234567', expectedCustomerId: null });
  expect(f.data().drafts[0].rows[0]).toMatchObject({ weight: 37 });
  await page.getByRole('button', { name: 'Fortsätt utan ändring', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Spara färdig vägning', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Lägg till material', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Spara utkast', exact: true })).toBeEnabled();
  f.changeWeight(); f.submit();
  await page.reload();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  await expect(page.getByRole('heading', { name: 'Kunduppgifter mottagna', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Granska kunduppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Granska kunduppgifter', exact: true }).click();
  await expect(page.getByText(proposal.name, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Använd kunduppgifterna', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vald kund', exact: true })).toBeVisible();
  expect(f.applies).toHaveLength(1);
  expect(f.data().drafts[0].rows).toHaveLength(2);
  expect(f.data().drafts[0].rows[0]).toMatchObject({ weight: 37 });
  expect(f.data().drafts[0].rows[1]).toMatchObject({ weight: 5 });
  await page.getByRole('button', { name: 'Klar', exact: true }).click();
  await expect(page.getByTestId('total-weight')).toHaveText('42 kg');
  await expect(page.getByRole('button', { name: 'Spara färdig vägning', exact: true })).toBeEnabled();
});

test('kundterminalen hämtar företagsuppgifter och rensar namn och bankfält innan nästa kund', async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as typeof window & { intakeStreams: EventTarget[] }; host.intakeStreams = [];
    class Stream extends EventTarget {
      static OPEN = 1; readyState = 1; onmessage = null; onerror = null;
      constructor() { super(); host.intakeStreams.push(this); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Stream });
  });
  let session: TerminalSessionState = { terminal: { id: 'intake-terminal', name: 'Kassan', username: 'kassan', siteId: 'main',
    active: true, online: true, busy: true, busyKind: 'intake', activeIntakeId: 'terminal-first-intake' },
    approval: null, revision: 1, connectionId: 'terminal-intake-epoch' };
  const submissions: Request[] = [], lookups: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/platform/tenant-context') return route.fulfill({ json: { companyId: 'intake-company', companyName: 'Terminalintag AB' } });
    if (path === '/api/terminal-demo/session') return route.fulfill({ json: session });
    if (path === '/api/terminal-demo/heartbeat') return route.fulfill({ json: { alive: true, revision: session.revision } });
    if (path === '/api/terminal-demo/customer-intake/company-lookup') {
      lookups.push(request);
      expect(request.postDataJSON()).toEqual({ id: 'terminal-first-intake', organisationNumber: proposal.number });
      return route.fulfill({ json: { company: { ...proposal, organisationNumber: proposal.number, source: 'SCB', fetchedAt: new Date().toISOString() } } });
    }
    if (path.startsWith('/api/terminal-demo/customer-intake')) {
      if (path.endsWith('/submit') && request.method() === 'POST') submissions.push(request);
      return route.fulfill({ json: { company: { name: 'Terminalintag AB' }, intake: { id: session.terminal.activeIntakeId,
        status: request.method() === 'POST' ? 'submitted' : 'waiting', expiresAt: expiresAt() } } });
    }
    return route.fulfill({ status: 404, json: { error: 'Endast terminalens eget formulär ingår.' } });
  });
  await page.goto('/terminal');
  await expect(page.getByRole('heading', { name: 'Fyll i dina uppgifter', exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Granska och godkänn din avräkning', exact: true })).toHaveCount(0);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(proposal.number);
  await expect(page.getByText('Hämtar företagsuppgifter från SCB…', { exact: true })).toBeVisible();
  // Reformatting the same identity must keep the pending lookup alive.
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('559359-3626');
  await expect(page.getByLabel('Företagsnamn', { exact: true })).toHaveValue(proposal.name);
  await expect(page.getByLabel('Postnummer', { exact: true })).toHaveValue(proposal.postalCode);
  expect(lookups).toHaveLength(1);
  await fillContact(page);
  await continueToBank(page);
  await page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true }).check();
  await page.getByLabel('Clearingnummer', { exact: true }).fill('8327');
  await page.getByLabel('Kontonummer', { exact: true }).fill('00123456789');
  await page.getByLabel('Kontohavare', { exact: true }).fill(proposal.name);
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByText('Steg 4 av 4', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack, uppgifterna är skickade', exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].postDataJSON()).toMatchObject({ id: 'terminal-first-intake', customer: { name: proposal.name } });
  await expect(page.getByRole('textbox')).toHaveCount(0);
  session = { ...session, revision: 2, terminal: { ...session.terminal, activeIntakeId: 'terminal-next-intake' } };
  await page.evaluate(value => {
    const host = window as typeof window & { intakeStreams: EventTarget[] };
    host.intakeStreams.at(-1)?.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(value) }));
  }, session);
  await expect(page.getByRole('heading', { name: 'Fyll i dina uppgifter', exact: true })).toBeVisible();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await expect(page.getByText('Steg 1 av 4', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
  await expect(page.getByText(proposal.name, { exact: true })).toHaveCount(0);
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill('19900101-0017');
  await page.getByLabel('Namn', { exact: true }).fill('Nästa kund');
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('');
  await continueToBank(page);
  await expect(page.getByRole('checkbox', { name: 'Lägg till bankuppgifter', exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Kontonummer', { exact: true })).toHaveCount(0);
});
