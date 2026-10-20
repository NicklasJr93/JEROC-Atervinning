import { test, expect, type Page, type Request } from '@playwright/test';
import { AddressAssistanceError, addressFromGooglePlace, addressSelectionFailure, parseAddressConfig, parseAddressValidation } from '../src/address-assistance/client';
import { seedDemo, type DemoData } from '../src/model';
import { emptyEmployeeFleet } from './helpers/employee-fleet';

const confirmedAddress = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };
const validation = { address: confirmedAddress, verdict: { addressComplete: true, hasUnconfirmedComponents: false, hasInferredComponents: false, hasReplacedComponents: false, requiresConfirmation: true } };

test('adresskontrakt behåller bara svenska strukturerade fält och kräver aktiv bekräftelse', () => {
  expect(parseAddressConfig({ configured: false, browserConfigured: true, validationConfigured: false, countryCode: 'SE', browserApiKey: 'must-not-leak' })).toEqual({ configured: false, browserConfigured: true, validationConfigured: false, countryCode: 'SE' });
  expect(parseAddressConfig({ configured: true, browserConfigured: true, validationConfigured: false, countryCode: 'SE', browserApiKey: 'browser-key' })).toEqual({ configured: true, browserConfigured: true, validationConfigured: false, countryCode: 'SE', browserApiKey: 'browser-key' });
  expect(parseAddressValidation({ ...validation, address: { ...confirmedAddress, postalCode: '761 41', lat: 59, lng: 18 }, raw: { secret: true } })).toEqual(validation);
  expect(() => parseAddressValidation({ ...validation, verdict: { ...validation.verdict, requiresConfirmation: false } })).toThrow();
  expect(() => parseAddressValidation({ ...validation, address: { ...confirmedAddress, postalCode: '1234' } })).toThrow();
  expect(() => parseAddressValidation({ ...validation, address: { ...confirmedAddress, countryCode: 'NO' } })).toThrow();
});

test('Google-träff måste innehålla svensk gata, postnummer och postort utan att koordinater importeras', () => {
  const addressComponents = [
    { types: ['route'], longText: 'Testgatan' }, { types: ['street_number'], longText: '12' },
    { types: ['postal_code'], longText: '761 41' }, { types: ['postal_town'], longText: 'Norrtälje' },
    { types: ['country'], longText: 'Sverige', shortText: 'SE' },
  ];
  expect(addressFromGooglePlace({ addressComponents })).toEqual(confirmedAddress);
  expect(() => addressFromGooglePlace({ addressComponents: addressComponents.filter(component => !component.types.includes('postal_code')) })).toThrow();
  expect(() => addressFromGooglePlace({ addressComponents: addressComponents.map(component => component.types.includes('country') ? { ...component, shortText: 'US' } : component) })).toThrow();
});

interface AddressFixtureOptions {
  configured?: boolean;
  validationConfigured?: boolean;
  deferValidation?: boolean;
  validationError?: { status: number; message: string; code: string };
  detailsFailure?: boolean;
  streetFirst?: boolean;
  missingPostcode?: boolean;
}

async function customerAddress(page: Page, options: AddressFixtureOptions = {}) {
  const personId = 'address-assistance-person';
  const data: DemoData = { ...seedDemo(), customers: [], drafts: [{ id: 'address-draft', number: 9103, siteId: 'norrtalje', createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', mode: 'direct', status: 'draft', rows: [], reference: '', origin: '' }] };
  const validations: Request[] = [];
  const stats = { validationReplies: 0, customerWrites: 0 };
  let releaseValidation: () => void = () => {};
  const validationGate = options.deferValidation ? new Promise<void>(resolve => { releaseValidation = resolve; }) : Promise.resolve();
  await page.addInitScript(({ personId, data, options }) => {
    const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(`${key}.postgres-imported`, 'yes');
    const queries: string[] = [];
    const makePlace = (streetOnly: boolean) => ({
      addressComponents: [
        { types: ['route'], longText: 'Testgatan' },
        ...(!streetOnly ? [{ types: ['street_number'], longText: '12' }] : []),
        ...(!streetOnly && !options.missingPostcode ? [{ types: ['postal_code'], longText: '761 41' }] : []),
        { types: ['postal_town'], longText: 'Norrtälje' },
        { types: ['country'], longText: 'Sverige', shortText: 'SE' },
      ],
      fetchFields: async () => { if (options.detailsFailure) throw new Error('SDK request failed: key=RAW-SECRET-MUST-NOT-SHOW'); return {}; },
    });
    Object.assign(window, { __addressQueries: queries, google: { maps: { importLibrary: async () => ({
      AutocompleteSessionToken: class {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async ({ input }: { input: string }) => {
        queries.push(input);
        const streetOnly = Boolean(options.streetFirst && !input.includes('12'));
        return { suggestions: [{ placePrediction: {
          text: { toString: () => streetOnly ? 'Testgatan, Norrtälje, Sverige' : 'Testgatan 12, Norrtälje, Sverige' },
          toPlace: () => makePlace(streetOnly),
        } }] };
      } },
    }) } } });
  }, { personId, data, options });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/address-assistance/config') return route.fulfill({ json: options.configured === false
      ? { configured: false, validationConfigured: false, countryCode: 'SE' }
      : { configured: true, browserApiKey: 'public-browser-key', validationConfigured: options.validationConfigured !== false, countryCode: 'SE' } });
    if (path === '/api/address-assistance/validate') {
      validations.push(request);
      await validationGate;
      await (options.validationError
        ? route.fulfill({ status: options.validationError.status, json: { error: options.validationError.message, code: options.validationError.code } })
        : route.fulfill({ json: validation }));
      stats.validationReplies++;
      return;
    }
    if (path === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: {
      person: { id: personId, name: 'Testmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['norrtalje'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true }, activeSiteId: 'norrtalje',
      sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], today: '2026-10-20', month: '2026-10', date: '2026-10-20',
      gate: { blocked: false }, days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] },
    } });
    if (path === '/api/application/mobile') {
      if (request.method() !== 'GET') {
        const payload = request.postDataJSON();
        if (payload?.data?.customers?.length) stats.customerWrites++;
        return route.fulfill({ json: { revision: 1 } });
      }
      return route.fulfill({ json: { data, revision: 1 } });
    }
    return route.fulfill({ json: { revision: 1 } });
  });
  await page.goto('/#/weigh/address-draft/customer/new');
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  const street = page.getByRole('combobox', { name: 'Gatuadress (valfritt)', exact: true });
  const postcode = page.getByLabel('Postnummer (valfritt)', { exact: true });
  const city = page.getByLabel('Ort (valfritt)', { exact: true });
  const suggestions = page.getByRole('listbox', { name: 'Adressförslag', exact: true });
  return { street, postcode, city, suggestions, validations, stats, releaseValidation };
}

test('komplett Places-adress fyller alla vanliga adressfält direkt utan separat servervalidering', async ({ page }) => {
  // A blocked/unavailable validation service cannot delay usable Places details.
  const fixture = await customerAddress(page, { deferValidation: true });
  await fixture.street.fill('Testgatan');
  await fixture.suggestions.getByRole('option').click();
  await expect(fixture.street).toHaveValue(confirmedAddress.address);
  await expect(fixture.postcode).toHaveValue(confirmedAddress.postalCode);
  await expect(fixture.city).toHaveValue(confirmedAddress.city);
  expect(fixture.validations).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Sök och komplettera adress', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Adressen stämmer – använd adressen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  expect(fixture.stats.customerWrites).toBe(0);
});

for (const validationConfigured of [false, true]) test(`komplett Places-adress fungerar när Address Validation ${validationConfigured ? 'nekas av Google' : 'saknar servernyckel'}`, async ({ page }) => {
  const fixture = await customerAddress(page, { validationConfigured,
    validationError: { status: 503, code: 'address_validation_api_disabled', message: 'Address Validation API är inte aktiverat.' } });
  await fixture.street.fill('Testgatan 12');
  await fixture.suggestions.getByRole('option').click();
  await expect(fixture.street).toHaveValue('Testgatan 12');
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations).toHaveLength(0);
  // Keep manual corrections; no optional async validation may overwrite them.
  await fixture.postcode.fill('99999');
  await fixture.city.fill('Min postort');
  await expect(fixture.postcode).toHaveValue('99999');
  await expect(fixture.city).toHaveValue('Min postort');
  expect(fixture.stats.customerWrites).toBe(0);
});

test('val av gata behåller fokus för husnummer och gissar inte postnummer från den förra adressen', async ({ page }) => {
  const fixture = await customerAddress(page, { streetFirst: true });
  await fixture.postcode.fill('11122');
  await fixture.city.fill('Gammal ort');
  await fixture.street.fill('Testgatan');
  await fixture.suggestions.getByRole('option', { name: 'Testgatan, Norrtälje, Sverige', exact: true }).click();
  await expect(fixture.street).toHaveValue('Testgatan');
  await expect(fixture.street).toBeFocused();
  await expect(fixture.postcode).toHaveValue('');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations).toHaveLength(0);
  // The user can continue directly at the caret after the selected street.
  await fixture.street.pressSequentially('12');
  await expect(fixture.street).toHaveValue('Testgatan 12');
  await fixture.suggestions.getByRole('option', { name: 'Testgatan 12, Norrtälje, Sverige', exact: true }).click();
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations).toHaveLength(0);
  expect(await page.evaluate(() => (window as Window & { __addressQueries?: string[] }).__addressQueries)).toContain('Testgatan 12, Norrtälje');
});

test('husnummer efter vald gata kontrolleras även när användaren tabbar vidare utan att välja ett andra förslag', async ({ page }) => {
  const fixture = await customerAddress(page, { streetFirst: true });
  await fixture.street.fill('Testgatan');
  await fixture.suggestions.getByRole('option', { name: 'Testgatan, Norrtälje, Sverige', exact: true }).click();
  await expect(fixture.street).toBeFocused();
  await fixture.street.pressSequentially('12');
  await fixture.street.press('Tab');
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations).toHaveLength(1);
  expect(fixture.validations[0].postDataJSON()).toEqual({ address: { ...confirmedAddress, postalCode: '' } });
});

test('numrerad Googleträff utan postnummer går vidare till servern som kompletterar fälten', async ({ page }) => {
  const fixture = await customerAddress(page, { missingPostcode: true });
  await fixture.street.fill('Testgatan 12');
  await fixture.suggestions.getByRole('option').click();
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations[0].postDataJSON()).toEqual({ address: { ...confirmedAddress, postalCode: '' } });
  expect(fixture.validations[0].headers()).toMatchObject({ 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'address-assistance-person' });
});

test('ofullständig Places-träff behåller kända fält utan att anropa en okonfigurerad validerare', async ({ page }) => {
  const fixture = await customerAddress(page, { missingPostcode: true, validationConfigured: false });
  await fixture.street.fill('Testgatan 12');
  await fixture.suggestions.getByRole('option').click();
  await expect(fixture.street).toHaveValue('Testgatan 12');
  await expect(fixture.postcode).toHaveValue('');
  await expect(fixture.city).toHaveValue('Norrtälje');
  expect(fixture.validations).toHaveLength(0);
});

test('tangentbordets piltangent och Enter väljer adressen utan att skicka kundformuläret', async ({ page }) => {
  const fixture = await customerAddress(page);
  await fixture.street.fill('Testgatan');
  await expect(fixture.suggestions.getByRole('option')).toBeVisible();
  await fixture.street.press('ArrowDown');
  await expect(fixture.suggestions.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  await fixture.street.press('Enter');
  await expect(fixture.street).toHaveValue('Testgatan 12');
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  await expect(page.getByText('Ange kundens namn eller företagsnamn.', { exact: true })).toHaveCount(0);
  expect(fixture.stats.customerWrites).toBe(0);
});

for (const changedField of ['street', 'postcode'] as const) {
  test(`manuell ändring av ${changedField === 'street' ? 'gatuadress' : 'postnummer'} förkastar ett sent kontrollsvar`, async ({ page }) => {
    const fixture = await customerAddress(page, { deferValidation: true, missingPostcode: true });
    await fixture.street.fill('Testgatan');
    await fixture.suggestions.getByRole('option').click();
    await expect.poll(() => fixture.validations.length).toBe(1);
    if (changedField === 'street') await fixture.street.fill('Min manuella adress 8');
    else await fixture.postcode.fill('99999');
    fixture.releaseValidation();
    await expect.poll(() => fixture.stats.validationReplies).toBe(1);
    await expect(fixture.street).toHaveValue(changedField === 'street' ? 'Min manuella adress 8' : 'Testgatan');
    await expect(fixture.postcode).toHaveValue(changedField === 'postcode' ? '99999' : '');
    await expect(fixture.city).toHaveValue('');
  });
}

test('Escape stänger förslagen och lämnar adressen fri för manuell inmatning', async ({ page }) => {
  const fixture = await customerAddress(page);
  await fixture.street.fill('Testgatan');
  await expect(fixture.suggestions).toBeVisible();
  await fixture.street.press('Escape');
  await expect(fixture.suggestions).toHaveCount(0);
  await fixture.street.fill('Skogsvägen bakom ladan');
  await fixture.street.press('Escape');
  await expect(fixture.street).toHaveValue('Skogsvägen bakom ladan');
  expect(fixture.validations).toHaveLength(0);
});

test('saknad Googlekonfiguration lämnar det vanliga adressfältet tillgängligt', async ({ page }) => {
  const fixture = await customerAddress(page, { configured: false });
  await fixture.street.focus();
  await expect(page.getByText('Adressförslag är inte tillgängliga. Du kan fylla i adressen manuellt.', { exact: true })).toBeVisible();
  await fixture.street.fill('Skogsvägen bakom ladan');
  await fixture.postcode.fill('76141');
  await fixture.city.fill('Norrtälje');
  await expect(fixture.street).toHaveValue('Skogsvägen bakom ladan');
  await expect(fixture.postcode).toHaveValue('76141');
  await expect(fixture.suggestions).toHaveCount(0);
});

test('saknat postnummer gissas inte när den separata adresskontrollen nekas', async ({ page }) => {
  const message = 'Google nekade serverns adresskontroll. Kontrollera servernyckeln, API-begränsningen och Render-IP-adresserna.';
  const fixture = await customerAddress(page, { missingPostcode: true, validationError: { status: 403, message, code: 'address_validation_credentials_rejected' } });
  await fixture.street.fill('Testgatan');
  await fixture.suggestions.getByRole('option').click();
  await expect(fixture.street).toHaveValue('Testgatan 12');
  await expect(fixture.postcode).toHaveValue('');
  await expect(fixture.city).toHaveValue('Norrtälje');
  await expect(page.getByText('Gatuadressen är ifylld. Google-träffen saknar postnummer eller ort och kunde inte kompletteras. Fyll i de tomma fälten manuellt.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adressen stämmer – använd adressen', exact: true })).toHaveCount(0);
});

test('rått Google-SDK-fel visas inte och blandas inte ihop med servervalidering', async ({ page }) => {
  const fixture = await customerAddress(page, { detailsFailure: true });
  await fixture.street.fill('Testgatan');
  await fixture.suggestions.getByRole('option').click();
  await expect(page.getByText('Adressens detaljer kunde inte hämtas från Google. Försök igen eller fyll i adressen manuellt.', { exact: true })).toBeVisible();
  await expect(page.getByText('RAW-SECRET-MUST-NOT-SHOW', { exact: false })).toHaveCount(0);
  expect(fixture.validations).toHaveLength(0);
});

test('endast egna sanerade adressfel lämnas vidare till gränssnittet', () => {
  expect(addressSelectionFailure(new AddressAssistanceError('Google nekade servernyckeln.', 'address_validation_credentials_rejected', 503), 'validation')).toBe('Google nekade servernyckeln.');
  expect(addressSelectionFailure(new Error('URL med key=PRIVATE'), 'details')).not.toContain('PRIVATE');
  expect(addressSelectionFailure(new Error('URL med key=PRIVATE'), 'validation')).toContain('Serverns adresskontroll');
});
