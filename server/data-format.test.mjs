import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrganisationNumber, normalizePersonalNumber, customerIdentifierError, customerIdentityKey,
  normalizePhoneNumber, phoneNumberError, normalizeAddress, addressError, formatAddress, normalizeOriginAddress,
  normalizePaymentDetails, normalizeCustomerDetails, validateCustomerDetails, validPaymentDetails,
} from '../dist-server/domain-models.mjs';

test('organisations use the same ten digit database identity with or without separators', () => {
  for (const input of ['5593593626', '559359-3626', ' 559359 - 3626 ']) {
    assert.equal(normalizeOrganisationNumber(input), '5593593626');
    assert.equal(customerIdentifierError('Företag', input), null);
  }
  assert.match(customerIdentifierError('Företag', '55935936261'), /exakt 10/);
  assert.match(customerIdentifierError('Företag', '5593593627'), /kontrollsiffra/);
  assert.match(customerIdentifierError('Företag', 'SE559359362601'), /exakt 10/);
});

test('optional personal and sole trader identities validate dates and checksum without inventing century', () => {
  assert.equal(customerIdentifierError('Privatperson', ''), null);
  for (const input of ['19900101-0009', '900101-0009', '900101+0009']) assert.equal(customerIdentifierError('Privatperson', input), null);
  assert.equal(normalizePersonalNumber('900101-0009'), '9001010009');
  assert.equal(normalizePersonalNumber('19900101-0009'), '199001010009');
  assert.equal(customerIdentifierError('Företag', '19900101-0009'), null);
  assert.equal(customerIdentityKey('Företag', '19900101-0009'), customerIdentityKey('Företag', '900101-0009'));
  assert.match(customerIdentifierError('Privatperson', '19900230-0000'), /datum/);
  assert.match(customerIdentifierError('BRF', '900101-0009'), /format/);
});

test('Swedish phone formats become E164 while international contact numbers retain their country', () => {
  for (const input of ['0722002220', '072-200 22 20', '+46 72 200 22 20', '0046722002220', '46722002220', '+46 (0)72 200 22 20']) {
    assert.equal(normalizePhoneNumber(input), '+46722002220');
    assert.equal(phoneNumberError(input), null);
  }
  assert.equal(normalizePhoneNumber('0176-12 34 56'), '+46176123456');
  assert.equal(phoneNumberError('+44 20 7946 0958'), null);
  assert.equal(phoneNumberError(''), null);
  assert.match(phoneNumberError('72hello2002220'), /giltigt/);
  assert.match(phoneNumberError('+460722002220'), /giltigt/);
});

test('Swish separates Swedish mobiles from 123 business numbers and rejects foreign and landline recipients', () => {
  assert.equal(normalizePhoneNumber('123-456 78 90', { swish: true }), '1234567890');
  for (const input of ['0722002220', '+46722002220', '0046722002220', '1234567890']) {
    assert.equal(phoneNumberError(input, { swish: true, required: true }), null);
    assert.equal(validPaymentDetails({ method: 'swish', phone: input, recipient: 'Mottagare' }), true);
  }
  for (const input of ['0176123456', '+447700900123', '+461234567890', '']) {
    assert.ok(phoneNumberError(input, { swish: true, required: true }));
    assert.equal(validPaymentDetails({ method: 'swish', phone: input, recipient: 'Mottagare' }), false);
  }
  assert.deepEqual(normalizePaymentDetails({ method: 'swish', phone: '0722002220', recipient: 'Kund' }), { method: 'swish', phone: '+46722002220', recipient: 'Kund' });
});

test('full origin addresses and structured customer addresses share one lossless database representation', () => {
  const details = { address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' };
  assert.deepEqual(normalizeAddress(' Storgatan 12, 761 41 Norrtälje, Sverige '), details);
  assert.deepEqual(normalizeAddress({ address: 'Storgatan 12, 761 41 Norrtälje', postalCode: '76141', city: 'Norrtälje' }), details);
  assert.deepEqual(normalizeAddress({ address: 'Storgatan 12, Norrtälje', postalCode: '761 41', city: 'Norrtälje' }), details);
  assert.equal(formatAddress(details), 'Storgatan 12, 76141 Norrtälje');
  assert.equal(normalizeOriginAddress(formatAddress(details)), formatAddress(details));
});

test('ambiguous address input is preserved and conflicting structured fields need a correction', () => {
  assert.deepEqual(normalizeAddress('Grusvägen 12, bakom ladan'), { address: 'Grusvägen 12, bakom ladan', postalCode: '', city: '', countryCode: 'SE' });
  assert.equal(normalizeOriginAddress('Storgatan 12345'), 'Storgatan 12345');
  assert.match(addressError({ address: 'Storgatan 12, 76141 Norrtälje', postalCode: '76251', city: 'Norrtälje' }), /olika postnummer/);
  assert.match(addressError({ address: 'Storgatan 12', postalCode: '7614', city: 'Norrtälje' }), /fem siffror/);
});

test('legacy invalid identifiers remain readable and can be edited without changing a frozen proof', () => {
  const legacy = { type: 'Företag', name: 'Legacy', number: '55935936261', phone: '0701234567', address: '' };
  const proof = structuredClone(legacy);
  assert.equal(validateCustomerDetails({ ...legacy, name: 'Nytt namn' }, legacy), null);
  assert.match(validateCustomerDetails(legacy), /exakt 10/);
  const corrected = normalizeCustomerDetails({ ...legacy, number: '559359-3626', phone: '0722002220', address: 'Storgatan 12, 761 41 Norrtälje' });
  assert.equal(validateCustomerDetails(corrected, legacy), null);
  assert.equal(corrected.number, '5593593626');
  assert.equal(corrected.phone, '+46722002220');
  assert.equal(corrected.address, 'Storgatan 12');
  assert.equal(corrected.postalCode, '76141');
  assert.deepEqual(legacy, proof);
});
