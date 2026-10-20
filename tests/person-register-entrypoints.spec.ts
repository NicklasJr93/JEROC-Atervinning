import { test, expect, type Page, type Request } from '@playwright/test';
import { seedDemo, type DemoData } from '../src/model';
import { seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';
import type { PersonRegisterPerson } from '../src/person-register/client';
import type { TerminalSessionState } from '../src/office/terminal-demo-types';
import { emptyEmployeeFleet } from './helpers/employee-fleet';
import { testPersonalNumber } from './helpers/customer-identity';
import { inspectCustomerIdentifier } from '../src/customer-identity';

test.use({ viewport: { width: 1440, height: 1050 }, isMobile: false, hasTouch: false, locale: 'sv-SE' });
// Synthetic identities and completely intercepted HTTP: these tests never query
// Roaring, meter a real operation, send messages or persist business data.
const person: PersonRegisterPerson = { personalNumber: testPersonalNumber(), name: 'Syntetisk Registerperson',
  address: 'Exempelvägen 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE', source: 'Roaring', fetchedAt: '2026-10-20T10:00:00.000Z' };
let otherNumber = testPersonalNumber();
while (otherNumber === person.personalNumber) otherNumber = testPersonalNumber();
const otherPerson: PersonRegisterPerson = { ...person, personalNumber: otherNumber, name: 'Syntetisk Andraperson',
  address: 'Andra Exempelvägen 34', postalCode: '76231', city: 'Rimbo' };
const privateCanary = 'PRIVATE_PROVIDER_FIELD_NEVER_DISPLAY';
const token = 'p'.repeat(43), publicPath = '/api/public/customer-intake';
const expiresAt = () => new Date(Date.now() + 30 * 60_000).toISOString();
const result = (value: PersonRegisterPerson = person) => ({ existing: false, person: { ...value, phone: privateCanary, email: privateCanary, privateProviderField: privateCanary } });
const matchingResult = (request: Request) => {
  const personalNumber = request.postDataJSON().personalNumber;
  return result(personalNumber === otherPerson.personalNumber ? otherPerson : { ...person, personalNumber });
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function syntheticAmbiguousFullNumber() {
  for (let suffix = 0; suffix < 1000; suffix++) {
    const firstEleven = `19010101${String(suffix).padStart(3, '0')}`;
    const sum = [...firstEleven.slice(2)].reduce((total, digit, index) => { const product = Number(digit) * (index % 2 === 0 ? 2 : 1); return total + (product > 9 ? product - 9 : product); }, 0);
    const full = firstEleven + String((10 - sum % 10) % 10);
    if (inspectCustomerIdentifier(full.slice(0, 10)).kind === 'person') return full;
  }
  throw new Error('The synthetic prefix fixture could not be constructed.');
}

async function officeFixture(page: Page, { quick = false, existing = false } = {}) {
  const office = migrateOffice(seedOffice()), user = office.users.find(value => value.id === 'admin')!;
  const customer = { ...office.customers[0], id: 'person-existing', type: 'Privatperson' as const, number: person.personalNumber.slice(2),
    name: 'Befintlig kund', phone: '+46722002220', email: 'befintlig@example.test' };
  office.customers = existing ? [customer] : [];
  const template = office.cards.find(card => card.id === 2051)!;
  office.cards = [{ ...structuredClone(template), id: 63187, sourceId: '91006b91-85e2-4c12-b44d-42cb9ec3fd9d',
    status: 'complement', customerId: undefined, customerSnapshot: undefined, customerApproval: undefined }];
  const company = { id: 'person-ui-company', name: 'Personuppslag test AB', organisationNumber: '5593593626', status: 'active' };
  const session = { enabled: true, authenticated: true, actor: { id: 'person-ui-actor', name: user.name, username: 'admin', platformAdmin: false },
    actualUser: user, user, company, organisationId: company.id, effectiveUserId: user.id, isSupportSession: false,
    mustChangePassword: false, csrfToken: 'person-ui-csrf', generation: 8, companies: [company] };
  const lookups: Request[] = [], companyLookups: Request[] = [], writes: Request[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && ['/api/application/office', '/api/pricing/customers'].includes(path)) writes.push(request);
    if (path === '/api/person-register/lookup') { lookups.push(request); return route.fulfill({ json: matchingResult(request) }); }
    if (path === '/api/company-register/lookup') { companyLookups.push(request); return route.fulfill({ status: 503, json: { error: 'Inget SCB-uppslag ska behövas för personnumret.' } }); }
    if (path === '/api/platform/session') return route.fulfill({ json: session });
    if (path === '/api/application/office') return route.fulfill({ json: { data: office, revision: 1 } });
    if (path === '/api/application/revision') return route.fulfill({ json: { revision: 1 } });
    if (path === '/api/pricing/state') return route.fulfill({ json: { version: 'person-ui-fixture', revision: 1, memoryOnly: true, asOfDate: '2026-10-20', metals: [], articles: [], customers: [] } });
    if (path === '/api/terminal-demo/staff-session') return route.fulfill({ json: { actualUserId: user.id, effectiveUserId: user.id } });
    if (path === '/api/terminal-demo/state') return route.fulfill({ json: { configured: true, revision: 1, actualUserId: user.id, effectiveUserId: user.id,
      sites: [{ id: 'norrtalje', name: 'Norrtälje' }], terminals: [], approvals: [], defaults: [] } });
    if (path === '/api/terminal-demo/events') return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
    if (path.endsWith('/summary')) return route.fulfill({ json: { workOrders: 0, warehouse: 0, vessels: 0 } });
    if (path.includes('/accounting/cards/')) return route.fulfill({ json: { export: null } });
    return route.fulfill({ status: 503, json: { error: 'Tjänsten ingår inte i det isolerade personuppslagsprovet.' } });
  });
  await page.goto(`/kontor#${quick ? '/weighings/63187' : existing ? `/customers/${customer.id}?tab=details` : '/customers/new'}`);
  if (quick) await page.getByRole('button', { name: 'Ny kund', exact: true }).click();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeVisible();
  return { lookups, companyLookups, writes, errors };
}

for (const quick of [false, true]) test(`${quick ? 'snabbkund för enskild firma' : 'full nykund för privatperson'} kompletterar tio siffror efter paus och fyller Roaring-träffen endast efter aktivt val`, async ({ page }) => {
  const f = await officeFixture(page, { quick });
  const form = quick ? page.getByRole('dialog', { name: 'Ny kund', exact: true }) : page.locator('body');
  if (quick) await page.getByLabel('Kundtyp', { exact: true }).selectOption('Företag');
  const nameLabel = quick ? 'Företagsnamn' : 'Namn';
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await page.clock.install();
  await number.fill(person.personalNumber.slice(2));
  await expect(page.getByRole('region', { name: 'Personuppslag', exact: true })).toContainText('12 siffror');
  await page.clock.fastForward(600); expect(f.lookups).toHaveLength(0); await expect(number).toHaveValue(person.personalNumber.slice(2));
  await page.clock.fastForward(150); await expect(number).toHaveValue(person.personalNumber);
  expect(await number.evaluate(element => { const input = element as HTMLInputElement; return [input.selectionStart, input.selectionEnd]; })).toEqual([12, 12]);
  await page.clock.fastForward(400);
  const lookup = page.getByRole('region', { name: 'Personuppslag', exact: true });
  await expect(lookup.getByText(person.name, { exact: true })).toBeVisible();
  await expect(page.getByLabel(nameLabel, { exact: true })).toHaveValue('');
  await page.getByLabel('Telefon', { exact: true }).fill('0722002220');
  // An edit invalidates the visible preview; the cached safe result can be
  // offered again, while applying it must still preserve this contact value.
  await expect(lookup.getByRole('button', { name: 'Använd personuppgifter', exact: true })).toBeVisible();
  await lookup.getByRole('button', { name: 'Använd personuppgifter', exact: true }).click();
  await expect(page.getByLabel(nameLabel, { exact: true })).toHaveValue(person.name);
  if (quick) await expect(page.getByLabel('Kundtyp', { exact: true })).toHaveValue('Företag');
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('0722002220');
  await expect(page.getByLabel('E-post', { exact: true })).toHaveValue('');
  await expect(form).not.toContainText(privateCanary);
  expect(f.lookups).toHaveLength(1); expect(f.lookups[0].postDataJSON()).toEqual({ personalNumber: person.personalNumber, requestId: expect.stringMatching(uuid) });
  expect(f.lookups[0].headers()).toMatchObject({ 'x-demo-actor': 'admin', 'x-demo-user': 'admin', 'x-platform-generation': '8', 'x-platform-csrf': 'person-ui-csrf' });
  expect(f.companyLookups).toHaveLength(0); expect(f.writes).toHaveLength(0); expect(f.errors).toEqual([]);
});

for (const quick of [false, true]) test(`${quick ? 'snabbkund' : 'full nykund'} rensar automatfält från person A vid byte till B och behåller manuell telefon och e-post`, async ({ page }) => {
  const f = await officeFixture(page, { quick });
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  const lookup = page.getByRole('region', { name: 'Personuppslag', exact: true });
  const name = page.getByLabel('Namn', { exact: true });
  const address = page.getByLabel(quick ? 'Gatuadress' : 'Adress', { exact: true });
  await number.fill(person.personalNumber);
  await lookup.getByRole('button', { name: 'Använd personuppgifter', exact: true }).click();
  await expect(name).toHaveValue(person.name); await expect(address).toHaveValue(person.address);
  await expect(page.getByLabel('Postnummer', { exact: true })).toHaveValue(person.postalCode);
  await expect(page.getByLabel('Ort', { exact: true })).toHaveValue(person.city);
  await page.getByLabel('Telefon', { exact: true }).fill('0722002220');
  await page.getByLabel('E-post', { exact: true }).fill('manuell@example.test');
  await number.fill(otherPerson.personalNumber);
  await expect(name).toHaveValue(''); await expect(address).toHaveValue('');
  await expect(page.getByLabel('Postnummer', { exact: true })).toHaveValue(''); await expect(page.getByLabel('Ort', { exact: true })).toHaveValue('');
  await expect(lookup.getByText(otherPerson.name, { exact: true })).toBeVisible();
  await expect(name).toHaveValue(''); // The second preview must still need an explicit apply.
  await lookup.getByRole('button', { name: 'Använd personuppgifter', exact: true }).click();
  await expect(name).toHaveValue(otherPerson.name); await expect(address).toHaveValue(otherPerson.address);
  await expect(page.getByLabel('Postnummer', { exact: true })).toHaveValue(otherPerson.postalCode); await expect(page.getByLabel('Ort', { exact: true })).toHaveValue(otherPerson.city);
  await expect(page.getByLabel('Telefon', { exact: true })).toHaveValue('0722002220'); await expect(page.getByLabel('E-post', { exact: true })).toHaveValue('manuell@example.test');
  expect(f.lookups).toHaveLength(2); expect(f.lookups.map(request => request.postDataJSON().personalNumber)).toEqual([person.personalNumber, otherPerson.personalNumber]);
  expect(f.lookups[0].postDataJSON().requestId).not.toBe(f.lookups[1].postDataJSON().requestId);
  expect(f.writes).toHaveLength(0); expect(f.errors).toEqual([]);
});

for (const pause of [0, 1000]) test(`${pause ? 'en paus i ett tvetydigt tioprefix' : 'snabb tolvsiffrig inmatning'} ändrar inte ett uttryckligt äldre födelseår eller skapar dubbla uppslag`, async ({ page }) => {
  const f = await officeFixture(page), full = syntheticAmbiguousFullNumber();
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await page.clock.install();
  expect(inspectCustomerIdentifier(full.slice(0, 10)).kind).toBe('person');
  await number.pressSequentially(full.slice(0, 10), { delay: 5 });
  if (pause) {
    await page.clock.fastForward(pause);
    await expect(number).toHaveValue(full.slice(0, 10)); expect(f.lookups).toHaveLength(0);
  }
  await number.pressSequentially(full.slice(10), { delay: 5 }); await page.clock.fastForward(400);
  await expect(number).toHaveValue(full);
  await expect(page.getByRole('button', { name: 'Använd personuppgifter', exact: true })).toBeVisible();
  expect(f.lookups).toHaveLength(1); expect(f.lookups[0].postDataJSON().personalNumber).toBe(full);
  await page.clock.fastForward(1500); await expect(number).toHaveValue(full);
  expect(f.lookups).toHaveLength(1); expect(f.companyLookups).toHaveLength(0); expect(f.writes).toHaveLength(0);
});

test('blur kompletterar nya kundens personnummer direkt före 700 ms utan extra uppslag', async ({ page }) => {
  const f = await officeFixture(page), number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await page.clock.install(); await number.fill(person.personalNumber.slice(2)); await page.clock.fastForward(100);
  await expect(number).toHaveValue(person.personalNumber.slice(2)); expect(f.lookups).toHaveLength(0);
  await number.press('Tab'); await expect(number).toHaveValue(person.personalNumber);
  await page.clock.fastForward(400); await expect(page.getByRole('button', { name: 'Använd personuppgifter', exact: true })).toBeVisible();
  expect(f.lookups).toHaveLength(1); expect(f.lookups[0].postDataJSON().personalNumber).toBe(person.personalNumber);
});

test('befintligt kundkort gör inget personuppslag vid öppning eller redigering', async ({ page }) => {
  const f = await officeFixture(page, { existing: true });
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Befintlig kund');
  await page.getByRole('button', { name: 'Redigera kund', exact: true }).click();
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toBeEnabled();
  await page.clock.install(); await page.clock.fastForward(1500);
  await expect(page.getByLabel('Organisations-/personnummer', { exact: true })).toHaveValue(person.personalNumber.slice(2));
  await expect(page.getByRole('region', { name: 'Personuppslag', exact: true })).toHaveCount(0);
  expect(f.lookups).toHaveLength(0); expect(f.writes).toHaveLength(0);
});

test('mobilens nya privatkund förhandsvisar personuppgifter med medarbetarens fångade bolag och person', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const personId = 'person-register-employee', companyId = 'person-register-company';
  const data: DemoData = { ...seedDemo(), customers: [], drafts: [{ id: 'person-register-draft', number: 9102, siteId: 'norrtalje',
    createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', mode: 'direct', status: 'draft', rows: [], reference: '', origin: '' }] };
  const lookups: Request[] = [], writes: Request[] = [];
  await page.addInitScript(({ personId, data }) => { const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(data)); localStorage.setItem(`${key}.postgres-imported`, 'yes'); }, { personId, data });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/person-register/lookup') { lookups.push(request); return route.fulfill({ json: matchingResult(request) }); }
    if (path === '/api/platform/tenant-context') return route.fulfill({ json: { companyId, companyName: 'Mobilprov AB' } });
    if (path === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: { companyId, companyName: 'Mobilprov AB',
      person: { id: personId, name: 'Testmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['norrtalje'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true }, activeSiteId: 'norrtalje', sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }],
      today: '2026-10-20', month: '2026-10', date: '2026-10-20', gate: { blocked: false }, days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] } } });
    if (path === '/api/application/mobile') { if (request.method() === 'POST') writes.push(request); return route.fulfill({ json: { data, revision: 1 } }); }
    return route.fulfill({ json: { revision: 1 } });
  });
  await page.goto('/#/weigh/person-register-draft/customer/new');
  await page.clock.install();
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await number.fill(person.personalNumber.slice(2)); await page.clock.fastForward(600); expect(lookups).toHaveLength(0);
  await page.clock.fastForward(150); await expect(number).toHaveValue(person.personalNumber); await page.clock.fastForward(400);
  await expect(page.getByRole('button', { name: 'Använd personuppgifter', exact: true })).toBeVisible();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Använd personuppgifter', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(person.name);
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue(person.address);
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue('');
  expect(lookups).toHaveLength(1); expect(lookups[0].headers()).toMatchObject({ 'x-employee-company': companyId, 'x-employee-person': personId });
  expect(lookups[0].postDataJSON()).toEqual({ personalNumber: person.personalNumber, requestId: expect.stringMatching(uuid) }); expect(writes).toHaveLength(0);
  await page.getByLabel('Telefon (valfritt)', { exact: true }).fill('0722002220');
  await page.getByLabel('E-post (valfritt)', { exact: true }).fill('mobil-manuell@example.test');
  await page.getByLabel('Organisations-/personnummer', { exact: true }).fill(otherPerson.personalNumber);
  await page.clock.fastForward(400);
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue(''); await expect(page.getByLabel('Ort (valfritt)', { exact: true })).toHaveValue('');
  await expect(page.getByText(otherPerson.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Använd personuppgifter', exact: true }).click();
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(otherPerson.name);
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue(otherPerson.address);
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue(otherPerson.postalCode); await expect(page.getByLabel('Ort (valfritt)', { exact: true })).toHaveValue(otherPerson.city);
  await expect(page.getByLabel('Telefon (valfritt)', { exact: true })).toHaveValue('0722002220');
  await expect(page.getByLabel('E-post (valfritt)', { exact: true })).toHaveValue('mobil-manuell@example.test');
  expect(lookups).toHaveLength(2); expect(lookups[1].postDataJSON().personalNumber).toBe(otherPerson.personalNumber); expect(writes).toHaveLength(0);
});

test('SMS-guiden återanvänder samma sök-ID och skyddar manuellt namn när ett sent Roaring-svar fyller adressen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const lookups: Request[] = [], submissions: Request[] = [];
  let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.context().addCookies([{ name: 'jeroc_platform', value: 'private-unrelated-session', url: String(test.info().project.use.baseURL) }]);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === `${publicPath}/person-lookup`) {
      lookups.push(request); expect(request.headers().authorization).toBe(`Bearer ${token}`); expect(request.headers().cookie).toBeUndefined();
      if (lookups.length === 1) return route.fulfill({ status: 503, json: { code: 'person_lookup_unavailable', error: 'Sökningens resultat är osäkert.' } });
      await gate; return route.fulfill({ json: result() }).catch(() => undefined);
    }
    if (path === publicPath || path === `${publicPath}/submit`) {
      if (path.endsWith('/submit')) submissions.push(request);
      expect(request.headers().authorization).toBe(`Bearer ${token}`); expect(request.headers().cookie).toBeUndefined();
      return route.fulfill({ json: { company: { name: 'SMS-prov AB' }, intake: { id: 'sms-person-intake', status: path.endsWith('/submit') ? 'submitted' : 'waiting', expiresAt: expiresAt() } } });
    }
    return route.fulfill({ status: 401, json: { error: 'Endast den smala kundlänken får användas.' } });
  });
  await page.goto(`/kunduppgifter/#token=${token}`); await page.clock.install();
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await number.fill(person.personalNumber.slice(2)); await page.clock.fastForward(600); expect(lookups).toHaveLength(0);
  await page.clock.fastForward(150); await expect(number).toHaveValue(person.personalNumber); await page.clock.fastForward(400);
  await expect(page.getByRole('button', { name: 'Sök igen', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sök igen', exact: true }).click(); await page.clock.fastForward(10);
  await expect.poll(() => lookups.length).toBe(2); await page.getByLabel('Namn', { exact: true }).fill('Manuellt namn före svar'); release();
  await expect(page.getByLabel('Postadress', { exact: true })).toHaveValue(person.address);
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue('Manuellt namn före svar');
  expect(lookups[1].postDataJSON()).toEqual(lookups[0].postDataJSON());
  expect(lookups[0].postDataJSON()).toEqual({ personalNumber: person.personalNumber, requestId: expect.stringMatching(uuid) });
  await page.getByRole('button', { name: 'Fortsätt', exact: true }).click();
  await expect(page.getByLabel('Telefonnummer', { exact: true })).toHaveValue(''); await expect(page.getByLabel('E-postadress', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Hoppa över kontaktuppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Hoppa över bankuppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Skicka mina uppgifter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1); expect(submissions[0].postDataJSON().customer).toMatchObject({ name: 'Manuellt namn före svar', address: person.address, phone: '', email: '' });
  expect(JSON.stringify(submissions[0].postDataJSON())).not.toContain(privateCanary); expect(page.url()).not.toContain(token); expect(lookups).toHaveLength(2);
});

test('Enter i SMS-guiden kompletterar synkront före nästa steg och skickar fullständigt personnummer', async ({ page }) => {
  const lookups: Request[] = [], submissions: Request[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === `${publicPath}/person-lookup`) { lookups.push(request); return route.fulfill({ json: matchingResult(request) }); }
    if (path === publicPath || path === `${publicPath}/submit`) {
      if (path.endsWith('/submit')) submissions.push(request);
      return route.fulfill({ json: { company: { name: 'Syntetiskt Enter-prov AB' }, intake: { id: 'enter-person-intake', status: path.endsWith('/submit') ? 'submitted' : 'waiting', expiresAt: expiresAt() } } });
    }
    return route.fulfill({ status: 401, json: { error: 'Det här testet använder endast kundlänken.' } });
  });
  await page.goto(`/kunduppgifter/#token=${token}`); await page.clock.install();
  await page.getByLabel('Namn', { exact: true }).fill('Manuellt namn före Enter');
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await number.fill(person.personalNumber.slice(2)); await number.press('Enter');
  await expect(page.getByText('Steg 2 av 4', { exact: true })).toBeVisible();
  // Less than 700 ms has elapsed: this request proves the submit capture flushed
  // the twelve-digit identity rather than relying on the later idle timer.
  await page.clock.fastForward(400); await expect.poll(() => lookups.length).toBe(1);
  expect(lookups[0].postDataJSON().personalNumber).toBe(person.personalNumber);
  await page.getByRole('button', { name: 'Hoppa över kontaktuppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Hoppa över bankuppgifter', exact: true }).click();
  await page.getByRole('button', { name: 'Hoppa över och skicka', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tack! Dina uppgifter är skickade', exact: true })).toBeVisible();
  expect(submissions).toHaveLength(1); expect(submissions[0].postDataJSON().customer.number).toBe(person.personalNumber); expect(lookups).toHaveLength(1);
});

test('kundterminalens automatiska personuppslag använder bara den aktuella parkopplade reservationen', async ({ page }) => {
  await page.addInitScript(() => {
    class Stream extends EventTarget { static OPEN = 1; readyState = 1; onmessage = null; onerror = null; close() { this.readyState = 2; } }
    Object.defineProperty(window, 'EventSource', { value: Stream });
  });
  const intakeId = 'terminal-person-intake', companyId = 'terminal-person-company';
  const session: TerminalSessionState = { terminal: { id: 'person-terminal', name: 'Kassan', username: 'kassan', siteId: 'main', active: true, online: true,
    busy: true, busyKind: 'intake', activeIntakeId: intakeId }, approval: null, revision: 1, connectionId: 'person-terminal-epoch' };
  const lookups: Request[] = [], protectedRequests: Request[] = [];
  await page.context().addCookies([{ name: 'jeroc_terminal', value: 'paired-device-fixture', url: String(test.info().project.use.baseURL) }]);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/person-register/lookup') { protectedRequests.push(request); return route.fulfill({ status: 403, json: {} }); }
    if (path === '/api/platform/tenant-context') return route.fulfill({ json: { companyId, companyName: 'Terminalprov AB' } });
    if (path === '/api/terminal-demo/session') return route.fulfill({ json: session });
    if (path === '/api/terminal-demo/heartbeat') return route.fulfill({ json: { alive: true, revision: 1 } });
    if (path === '/api/terminal-demo/customer-intake/person-lookup') { lookups.push(request); return route.fulfill({ json: result() }); }
    if (path === '/api/terminal-demo/customer-intake') return route.fulfill({ json: { company: { name: 'Terminalprov AB' }, intake: { id: intakeId, status: 'waiting', expiresAt: expiresAt() } } });
    return route.fulfill({ status: 404, json: { error: 'Endast terminalens eget formulär ingår.' } });
  });
  await page.goto('/terminal'); await expect(page.getByRole('heading', { name: 'Fyll i dina uppgifter', exact: true })).toBeVisible(); await page.clock.install();
  const number = page.getByLabel('Organisations-/personnummer', { exact: true });
  await number.fill(person.personalNumber.slice(2)); await page.clock.fastForward(600); expect(lookups).toHaveLength(0);
  await page.clock.fastForward(150); await expect(number).toHaveValue(person.personalNumber); await page.clock.fastForward(400);
  await expect(page.getByLabel('Namn', { exact: true })).toHaveValue(person.name);
  await expect(page.getByLabel('Postadress', { exact: true })).toHaveValue(person.address);
  await expect(page.getByRole('button', { name: 'Använd personuppgifter', exact: true })).toHaveCount(0);
  expect(lookups).toHaveLength(1); expect(lookups[0].postDataJSON()).toEqual({ id: intakeId, personalNumber: person.personalNumber, requestId: expect.stringMatching(uuid) });
  expect(lookups[0].headers()['x-client-company']).toBe(companyId); expect(lookups[0].headers().cookie).toContain('jeroc_terminal=paired-device-fixture');
  expect(lookups[0].headers().authorization).toBeUndefined(); expect(protectedRequests).toHaveLength(0);
});
