import { test, expect, type Page, type Request } from '@playwright/test';
import { AddressAssistanceError, addressFromGooglePlace, addressSelectionFailure, parseAddressConfig, parseAddressValidation } from '../src/address-assistance/client';
import { seedDemo, type DemoData } from '../src/model';
import { emptyEmployeeFleet } from './helpers/employee-fleet';

const confirmedAddress = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };
const validation = { address: confirmedAddress, verdict: { addressComplete: true, hasUnconfirmedComponents: false, hasInferredComponents: false, hasReplacedComponents: false, requiresConfirmation: true } };

test('adresskontrakt behåller bara svenska strukturerade fält och kräver aktiv bekräftelse', () => {
  expect(parseAddressConfig({ configured: false, browserConfigured: true, validationConfigured: false, countryCode: 'SE', browserApiKey: 'must-not-leak' })).toEqual({ configured: false, browserConfigured: true, validationConfigured: false, countryCode: 'SE' });
  expect(() => parseAddressConfig({ configured: true, validationConfigured: false, countryCode: 'SE', browserApiKey: 'browser-key' })).toThrow();
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

async function customerAddress(page: Page, options: { configured?: boolean; deferValidation?: boolean; validationError?: { status: number; message: string; code: string }; detailsFailure?: boolean } = {}) {
  const personId = 'address-assistance-person';
  const data: DemoData = { ...seedDemo(), customers: [], drafts: [{ id: 'address-draft', number: 9103, siteId: 'norrtalje', createdAt: '2026-10-20T08:00:00.000Z', updatedAt: '2026-10-20T08:00:00.000Z', mode: 'direct', status: 'draft', rows: [], reference: '', origin: '' }] };
  const validations: Request[] = [];
  let releaseValidation: () => void = () => {};
  const validationGate = options.deferValidation ? new Promise<void>(resolve => { releaseValidation = resolve; }) : Promise.resolve();
  await page.addInitScript(({ personId, data, detailsFailure }) => {
    const key = `jeroc.mobile.demo.v1.employee.${personId}`;
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(`${key}.postgres-imported`, 'yes');
    const place = {
      addressComponents: [
        { types: ['route'], longText: 'Testgatan' }, { types: ['street_number'], longText: '12' },
        { types: ['postal_code'], longText: '761 41' }, { types: ['postal_town'], longText: 'Norrtälje' },
        { types: ['country'], longText: 'Sverige', shortText: 'SE' },
      ],
      fetchFields: async () => { if (detailsFailure) throw new Error('SDK request failed: key=RAW-SECRET-MUST-NOT-SHOW'); return {}; },
    };
    Object.assign(window, { google: { maps: { importLibrary: async () => ({
      AutocompleteSessionToken: class {},
      AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [{ placePrediction: { text: { toString: () => 'Testgatan 12, Norrtälje, Sverige' }, toPlace: () => place } }] }) },
    }) } } });
  }, { personId, data, detailsFailure: options.detailsFailure });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/address-assistance/config') return route.fulfill({ json: options.configured === false
      ? { configured: false, validationConfigured: false, countryCode: 'SE' }
      : { configured: true, browserApiKey: 'public-browser-key', validationConfigured: true, countryCode: 'SE' } });
    if (path === '/api/address-assistance/validate') { validations.push(request); await validationGate; return options.validationError ? route.fulfill({ status: options.validationError.status, json: { error: options.validationError.message, code: options.validationError.code } }) : route.fulfill({ json: validation }); }
    if (path === '/api/employee/fleet') return route.fulfill({ json: emptyEmployeeFleet(personId) });
    if (path.startsWith('/api/employee/')) return route.fulfill({ json: {
      person: { id: personId, name: 'Testmedarbetare', role: 'Invägare', team: 'Gården', siteIds: ['norrtalje'] },
      capabilities: { yardWork: true, employeeTime: true, assignedOrders: false, paymentDetails: true }, activeSiteId: 'norrtalje',
      sites: [{ id: 'norrtalje', name: 'Norrtälje', active: true }], today: '2026-10-20', month: '2026-10', date: '2026-10-20',
      gate: { blocked: false }, days: [], orders: [], selectedDay: { schedules: [], absences: [], entries: [], orders: [] },
    } });
    if (path === '/api/application/mobile') return route.fulfill({ json: { data, revision: 1 } });
    return route.fulfill({ json: { revision: 1 } });
  });
  await page.goto('/#/weigh/address-draft/customer/new');
  await expect(page.getByRole('heading', { name: 'Ny kund', exact: true })).toBeVisible();
  return { validations, releaseValidation };
}

test('adressförslag fyller inga fält innan serverkontroll och användarens uttryckliga bekräftelse', async ({ page }) => {
  const fixture = await customerAddress(page);
  await page.getByRole('button', { name: 'Sök och komplettera adress', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sök adress', exact: true }).fill('Testgatan');
  await page.getByRole('listbox', { name: 'Adressförslag' }).getByRole('option').click();
  await expect(page.getByText('Stämmer adressen?', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue('');
  expect(fixture.validations).toHaveLength(1);
  expect(fixture.validations[0].postDataJSON()).toEqual({ address: confirmedAddress });
  expect(fixture.validations[0].headers()).toMatchObject({ 'x-employee-company': 'jeroc-demo', 'x-employee-person': 'address-assistance-person' });
  await page.getByRole('button', { name: 'Adressen stämmer – använd adressen', exact: true }).click();
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue(confirmedAddress.address);
  await expect(page.getByLabel('Postnummer (valfritt)', { exact: true })).toHaveValue(confirmedAddress.postalCode);
  await expect(page.getByLabel('Ort (valfritt)', { exact: true })).toHaveValue(confirmedAddress.city);
});

test('manuell adressändring medan Googlekontroll pågår förkastar det gamla förslaget', async ({ page }) => {
  const fixture = await customerAddress(page, { deferValidation: true });
  await page.getByRole('button', { name: 'Sök och komplettera adress', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sök adress', exact: true }).fill('Testgatan');
  await page.getByRole('listbox', { name: 'Adressförslag' }).getByRole('option').click();
  await expect.poll(() => fixture.validations.length).toBe(1);
  await page.getByLabel('Gatuadress (valfritt)', { exact: true }).fill('Min manuella adress 8');
  fixture.releaseValidation();
  await expect(page.getByRole('combobox', { name: 'Sök adress', exact: true })).toHaveValue('');
  await expect(page.getByText('Stämmer adressen?', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('Min manuella adress 8');
});

test('saknad Googlekonfiguration lämnar manuella adressfält tillgängliga', async ({ page }) => {
  await customerAddress(page, { configured: false });
  await page.getByRole('button', { name: 'Sök och komplettera adress', exact: true }).click();
  await expect(page.getByText('Adresshjälpen är inte aktiverad ännu. Du kan fylla i adressen i fälten nedan.', { exact: true })).toBeVisible();
  await page.getByLabel('Gatuadress (valfritt)', { exact: true }).fill('Skogsvägen bakom ladan');
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('Skogsvägen bakom ladan');
  await expect(page.getByRole('combobox', { name: 'Sök adress', exact: true })).toHaveCount(0);
});


test('nekad servernyckel visas som anslutningsfel utan att skuldbelägga adressen eller fylla fälten', async ({ page }) => {
  const message = 'Google nekade serverns adresskontroll. Kontrollera servernyckeln, API-begränsningen och Render-IP-adresserna.';
  await customerAddress(page, { validationError: { status: 403, message, code: 'address_validation_credentials_rejected' } });
  await page.getByRole('button', { name: 'Sök och komplettera adress', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sök adress', exact: true }).fill('Testgatan');
  await page.getByRole('listbox', { name: 'Adressförslag' }).getByRole('option').click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Gatuadress (valfritt)', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Adressen stämmer – använd adressen', exact: true })).toHaveCount(0);
});

test('rått Google-SDK-fel visas inte och blandas inte ihop med servervalidering', async ({ page }) => {
  const fixture = await customerAddress(page, { detailsFailure: true });
  await page.getByRole('button', { name: 'Sök och komplettera adress', exact: true }).click();
  await page.getByRole('combobox', { name: 'Sök adress', exact: true }).fill('Testgatan');
  await page.getByRole('listbox', { name: 'Adressförslag' }).getByRole('option').click();
  await expect(page.getByText('Adressens detaljer kunde inte hämtas från Google. Försök igen eller fyll i adressen manuellt.', { exact: true })).toBeVisible();
  await expect(page.getByText('RAW-SECRET-MUST-NOT-SHOW', { exact: false })).toHaveCount(0);
  expect(fixture.validations).toHaveLength(0);
});

test('endast egna sanerade adressfel lämnas vidare till gränssnittet', () => {
  expect(addressSelectionFailure(new AddressAssistanceError('Google nekade servernyckeln.', 'address_validation_credentials_rejected', 503), 'validation')).toBe('Google nekade servernyckeln.');
  expect(addressSelectionFailure(new Error('URL med key=PRIVATE'), 'details')).not.toContain('PRIVATE');
  expect(addressSelectionFailure(new Error('URL med key=PRIVATE'), 'validation')).toContain('Serverns adresskontroll');
});
