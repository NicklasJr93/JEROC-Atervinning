import { expect, test } from '@playwright/test';
import { AddressAssistanceError, selectionFromGooglePlace, type GooglePlace } from '../src/address-assistance/client';

type Components = NonNullable<GooglePlace['addressComponents']>;
const component = (type: string, longText: string, shortText?: string) => ({ types: [type], longText, ...(shortText === undefined ? {} : { shortText }) });
const country = component('country', 'Sverige', 'SE');
const street = () => [component('route', 'Ängsvägen'), component('postal_town', 'Rimbo'), country];

test('en svensk gatuträff kan väljas före husnummer och postnummer utan gissade fält', () => {
  expect(selectionFromGooglePlace({ addressComponents: street() })).toEqual({
    address: { address: 'Ängsvägen', postalCode: '', city: 'Rimbo', countryCode: 'SE' },
    hasHouseNumber: false, complete: false,
  });
  expect(selectionFromGooglePlace({ addressComponents: [component('route', 'Väg 77'), country] })).toEqual({
    address: { address: 'Väg 77', postalCode: '', city: '', countryCode: 'SE' },
    hasHouseNumber: false, complete: false,
  });
});

test('komplett svensk adress normaliseras till endast gata, nummer, postnummer och postort', () => {
  const addressComponents = [...street(), component('street_number', ' 19 A '), component('postal_code', '762\u00a031')];
  const selected = selectionFromGooglePlace({ addressComponents });
  expect(selected).toEqual({ address: { address: 'Ängsvägen 19 A', postalCode: '76231', city: 'Rimbo', countryCode: 'SE' },
    hasHouseNumber: true, complete: true });
  expect(Object.keys(selected.address).sort()).toEqual(['address', 'city', 'countryCode', 'postalCode']);
});

test('postort prioriteras framför ort och saknade postnummer ersätts inte av ett prefix', () => {
  expect(selectionFromGooglePlace({ addressComponents: [...street(), component('locality', 'Annan ort')] }).address.city).toBe('Rimbo');
  const noTown = street().filter(value => !value.types.includes('postal_town'));
  expect(selectionFromGooglePlace({ addressComponents: [...noTown, component('locality', 'Rimbo')] }).address.city).toBe('Rimbo');
  expect(selectionFromGooglePlace({ addressComponents: [...noTown, component('administrative_area_level_2', 'Norrtälje kommun')] }).address.city).toBe('');
  for (const postcode of ['762', '7623x', '762311']) {
    const selected = selectionFromGooglePlace({ addressComponents: [...street(), component('street_number', '19'),
      component('postal_code', postcode), component('postal_code_prefix', '762')] });
    expect(selected.address.postalCode).toBe(''); expect(selected.complete).toBe(false);
  }
});

test('komplett kräver ett faktiskt husnummer även om gatan redan har postnummer', () => {
  const selected = selectionFromGooglePlace({ addressComponents: [...street(), component('postal_code', '762 31')] });
  expect(selected.hasHouseNumber).toBe(false); expect(selected.complete).toBe(false);
  expect(selected.address.address).toBe('Ängsvägen');
});

test('främmande, tomma och felaktiga Google-komponenter ger säkra fel utan rådata', () => {
  const secret = 'PRIVATE-PROVIDER-CONTENT';
  const invalid: unknown[] = [null, {}, { addressComponents: null }, { addressComponents: {} }, { addressComponents: [] },
    { addressComponents: [country] },
    { addressComponents: [component('route', 'Street'), component('country', 'Norge', 'NO')] },
    { addressComponents: [component('route', 'Street')] },
    { addressComponents: [component('route', ' '), country] },
    { addressComponents: [component('route', `${secret}\nInjected`), country] },
    { addressComponents: [component('route', 'x'.repeat(301)), country] },
    { addressComponents: [component('route', 'Vägen'), component('street_number', '1'.repeat(41)), country] },
    { addressComponents: [component('route', 'Vägen'), component('postal_town', 'x'.repeat(201)), country] },
    { addressComponents: [null, country] },
    { addressComponents: [{ longText: secret, types: 'route' }, country] },
    { addressComponents: [{ longText: secret, types: [1] }, country] },
    { addressComponents: [{ longText: secret, types: [] }, country] },
    { addressComponents: [{ longText: secret, types: ['route'], shortText: {} }, country] },
    { addressComponents: [...street(), ...Array.from({ length: 65 }, () => component('political', 'X'))] },
  ];
  for (const input of invalid) {
    let caught: unknown;
    try { selectionFromGooglePlace(input as Pick<GooglePlace, 'addressComponents'>); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AddressAssistanceError);
    const error = caught as AddressAssistanceError;
    expect(error.code).toBe('address_incomplete');
    expect(error.message).not.toContain(secret); expect(JSON.stringify(error)).not.toContain(secret);
  }
});

test('komponenttext tvättas utan att originalsvaret ändras', () => {
  const addressComponents: Components = [component('route', '  Ängsvägen\u00a0 '), component('street_number', '１９'),
    component('postal_town', '  Rimbo  '), component('postal_code', '７６２ ３１'), country];
  const original = structuredClone(addressComponents);
  expect(selectionFromGooglePlace({ addressComponents }).address).toEqual({ address: 'Ängsvägen 19', postalCode: '76231', city: 'Rimbo', countryCode: 'SE' });
  expect(addressComponents).toEqual(original);
});
