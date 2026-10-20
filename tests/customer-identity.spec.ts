import { test, expect } from '@playwright/test';
import { customerTypeFromIdentifier, inspectCustomerIdentifier } from '../src/customer-identity';
import { customerIdentifierError, customerIdentityKey, normalizeCustomerDetails, normalizeOrganisationNumber } from '../src/data-format';

// Synthetic identities avoid relying on a real customer's personal data.
function withCheckDigit(firstNine: string): string {
  const sum = [...firstNine].reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + (product > 9 ? product - 9 : product);
  }, 0);
  return firstNine + String((10 - sum % 10) % 10);
}
const organisation = withCheckDigit('269123456');
const person = withCheckDigit('900101123');
const coordination = withCheckDigit('900161123');

test('tomma, ofullständiga och felaktiga nummer föreslår ingen kundtyp', () => {
  expect(inspectCustomerIdentifier('  ')).toEqual({ kind: 'empty', normalized: '' });
  for (const value of ['5', '269123', '19900101123']) {
    expect(inspectCustomerIdentifier(value).kind).toBe('incomplete');
    expect(customerTypeFromIdentifier(value)).toBeUndefined();
  }
  for (const value of ['SE26912345601', 'abc', '++', '2691234560123', `${organisation.slice(0, -1)}${(Number(organisation.at(-1)) + 1) % 10}`]) {
    expect(inspectCustomerIdentifier(value).kind).toBe('invalid');
    expect(customerTypeFromIdentifier(value)).toBeUndefined();
  }
});

test('organisationsnummer behöver inte börja med 5 och prefix 16 normaliseras separat', () => {
  for (const value of [organisation, `${organisation.slice(0, 6)}-${organisation.slice(6)}`, `16${organisation}`, ` 16 ${organisation.slice(0, 6)}-${organisation.slice(6)} `]) {
    expect(inspectCustomerIdentifier(value)).toEqual({ kind: 'organisation', normalized: organisation });
    expect(customerTypeFromIdentifier(value)).toBe('Företag');
    expect(normalizeOrganisationNumber(value)).toBe(organisation);
    expect(customerIdentifierError('Företag', value)).toBeNull();
    expect(customerIdentifierError('BRF', value)).toBeNull();
    expect(customerIdentityKey('Företag', value)).toBe(organisation);
    expect(normalizeCustomerDetails({ type: 'Företag', number: value }).number).toBe(organisation);
    expect(normalizeCustomerDetails({ type: 'BRF', number: value }).number).toBe(organisation);
  }
  expect(inspectCustomerIdentifier(`${organisation.slice(0, 6)}+${organisation.slice(6)}`).kind).toBe('invalid');
});

test('personnummer på tio eller tolv siffror behåller angiven längd utan gissat sekel', () => {
  for (const value of [person, `${person.slice(0, 6)}-${person.slice(6)}`, `${person.slice(0, 6)}+${person.slice(6)}`]) {
    expect(inspectCustomerIdentifier(value)).toEqual({ kind: 'person', normalized: person });
    expect(customerTypeFromIdentifier(value)).toBe('Privatperson');
  }
  expect(inspectCustomerIdentifier(`19${person.slice(0, 6)}-${person.slice(6)}`)).toEqual({ kind: 'person', normalized: `19${person}` });
  expect(customerIdentifierError('Företag', `19${person}`)).toBeNull();
  expect(customerIdentityKey('Företag', `19${person}`)).toBe(person);
  expect(normalizeOrganisationNumber(`19${person}`)).toBe(`19${person}`);
  expect(normalizeCustomerDetails({ type: 'Företag', number: `19${person}` }).number).toBe(`19${person}`);
  expect(normalizeCustomerDetails({ type: 'Privatperson', number: person }).number).toBe(person);
});

test('samordningsnummer validerar födelsedagen minus 60 men kontrollsiffran för originalnumret', () => {
  expect(inspectCustomerIdentifier(coordination)).toEqual({ kind: 'coordination', normalized: coordination });
  expect(inspectCustomerIdentifier(`19${coordination}`)).toEqual({ kind: 'coordination', normalized: `19${coordination}` });
  expect(customerTypeFromIdentifier(coordination)).toBe('Privatperson');
  const februaryThirty = withCheckDigit('900290123');
  expect(inspectCustomerIdentifier(februaryThirty).kind).toBe('invalid');
  expect(inspectCustomerIdentifier(withCheckDigit('900160123')).kind).toBe('invalid');
});

test('kontrollsiffra räcker inte för ogiltiga månader, datum eller explicit felaktigt sekel', () => {
  for (const nine of ['901301123', '900230123', '900100123', '900132123', '900192123']) {
    const result = inspectCustomerIdentifier(withCheckDigit(nine));
    expect(result.kind).toBe('invalid');
    expect(result.error).toContain('datum');
  }
  const leapDay = withCheckDigit('000229123');
  expect(inspectCustomerIdentifier(leapDay)).toEqual({ kind: 'person', normalized: leapDay });
  expect(inspectCustomerIdentifier(`20${leapDay}`).kind).toBe('person');
  expect(inspectCustomerIdentifier(`19${leapDay}`).kind).toBe('invalid');
  expect(inspectCustomerIdentifier(`17${person}`).kind).toBe('invalid');
  expect(inspectCustomerIdentifier(`${person.slice(0, 3)}+${person.slice(3)}`).kind).toBe('invalid');
});
