import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  bankRecipientType, bankRecipientError, ibanNumberError, ocrNumberError,
  normalizePaymentDetails, normalizeCustomerDetails, validateCustomerDetails,
  paymentDetailsSchema, officeSchema, storeSchema, validPaymentDetails,
} from '../dist-server/domain-models.mjs';

const payment = fields => ({ method: 'bank', holder: 'Testmottagare', ...fields });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('legacy bank recipients keep their exact shape and proof hash on read', () => {
  const frozen = payment({ bank: 'Demobank', clearing: '8327', account: '00123456789' });
  const before = hash(frozen);
  assert.equal(bankRecipientType(frozen), 'account');
  assert.equal(bankRecipientError(frozen), null);
  assert.equal(validPaymentDetails(frozen), true);
  assert.deepEqual(paymentDetailsSchema.parse(frozen), frozen);
  assert.equal(hash(frozen), before);
  assert.equal(Object.hasOwn(frozen, 'bankType'), false);
});

test('saving bank recipients keeps leading zeroes and removes inactive subtype account fields', () => {
  const dirty = payment({ bankType: 'bankgiro', bankgiro: ' 123-4566 ', clearing: '8327', account: '00123456789',
    plusgiro: '123455', iban: 'SE4550000000058398257466', bic: ' swed se ss ', bankCountry: ' se ' });
  const frozen = structuredClone(dirty);
  const normalized = normalizePaymentDetails(dirty);
  assert.deepEqual(normalized, payment({ bankType: 'bankgiro', bankgiro: '1234566', bic: 'SWEDSESS', bankCountry: 'SE' }));
  assert.deepEqual(dirty, frozen);
  const account = normalizePaymentDetails(payment({ bankType: 'account', clearing: ' 8 327-1 ', account: '0000-1234 567', bankgiro: '1234566' }));
  assert.equal(account.clearing, '83271'); assert.equal(account.account, '00001234567'); assert.equal(account.bankgiro, undefined);
});

test('giro checks validate canonical numeric format and checksum without an ownership claim', () => {
  assert.equal(bankRecipientError(payment({ bankType: 'bankgiro', bankgiro: '123-4566' })), null);
  assert.equal(bankRecipientError(payment({ bankType: 'plusgiro', plusgiro: '12345-5' })), null);
  assert.match(bankRecipientError(payment({ bankType: 'bankgiro', bankgiro: '1234567' })), /kontrollsiffra/);
  assert.match(bankRecipientError(payment({ bankType: 'bankgiro', bankgiro: '123455' })), /längd/);
  assert.match(bankRecipientError(payment({ bankType: 'plusgiro', plusgiro: '123456789' })), /längd/);
  assert.match(bankRecipientError(payment({ bankType: 'plusgiro', plusgiro: '00000000' })), /format/);
  assert.match(bankRecipientError(payment({ bankType: 'bankgiro', bankgiro: '1234566', holder: '' })), /namn/);
});

test('IBAN validates country length, country account format and mod97 independently of currency', () => {
  for (const iban of ['SE45 5000 0000 0583 9825 7466', 'de89370400440532013000', 'GB82WEST12345698765432', 'NL91ABNA0417164300']) {
    assert.equal(ibanNumberError(iban), null, iban);
    assert.equal(validPaymentDetails(payment({ bankType: 'iban', iban })), true);
  }
  assert.match(ibanNumberError('SE4550000000058398257467'), /kontrollsiffror/);
  assert.match(ibanNumberError('SE455000000005839825746'), /längd/);
  assert.match(ibanNumberError('ZZ4550000000058398257466'), /längd/);
  assert.match(ibanNumberError('SE45A0000000058398257466'), /kontonummerformat/);
  assert.match(bankRecipientError(payment({ bankType: 'iban', iban: 'DE89370400440532013000', bankCountry: 'SE' })), /Banklandet/);
  assert.deepEqual(normalizePaymentDetails(payment({ bankType: 'iban', iban: ' se45 5000 0000 0583 9825 7466 ', bic: 'swedsessxxx' })),
    payment({ bankType: 'iban', iban: 'SE4550000000058398257466', bic: 'SWEDSESSXXX' }));
});

test('bank-dependent extra requirements and OCR are conditional and never inferred from seller origin', () => {
  const value = payment({ bankType: 'iban', iban: 'SE4550000000058398257466' });
  assert.equal(bankRecipientError(value), null);
  assert.match(bankRecipientError(value, { requireBic: true }), /kräver BIC/);
  assert.match(bankRecipientError(value, { requireAddress: true }), /mottagaradress/);
  assert.match(bankRecipientError(value, { requireCountry: true }), /bankland/);
  assert.match(bankRecipientError({ ...value, bic: 'BAD' }), /8 eller 11/);
  assert.equal(bankRecipientError({ ...value, bic: 'SWEDSESS', bankCountry: 'SE', beneficiaryAddress: 'Testgatan 1', ocr: '12345-5' },
    { requireBic: true, requireAddress: true, requireCountry: true }), null);
  assert.equal(ocrNumberError('123455'), null); assert.match(ocrNumberError('123456'), /kontrollsiffra/);
  assert.equal(bankRecipientError({ ...value, ocr: '' }), null);
});

test('office and optional mobile customer input schemas retain typed bank fields without defaults', () => {
  const profile = payment({ bankType: 'plusgiro', plusgiro: '123455', bankCountry: 'SE', beneficiaryAddress: 'Testgatan 1', ocr: '123455' });
  const customer = { id: 'format-test', name: 'Test', type: 'Privatperson', number: '', phone: '', email: '', references: [], origins: [], paymentProfile: profile };
  assert.deepEqual(storeSchema.parse({ version: 1, drafts: [], customers: [customer] }).customers[0].paymentProfile, profile);
  assert.deepEqual(officeSchema.shape.customers.removeDefault().element.parse({ ...customer, customerNumber: 'K-1' }).paymentProfile, profile);
  assert.equal(paymentDetailsSchema.safeParse({ ...profile, bankType: 'unknown' }).success, false);
});

test('changed bank customer profiles are validated while unchanged legacy errors remain editable', () => {
  const legacy = { type: 'Privatperson', name: 'Test', number: '', phone: '', address: '', paymentProfile: payment({ bankgiro: '1234567', bankType: 'bankgiro' }) };
  const before = hash(legacy);
  assert.equal(validateCustomerDetails({ ...legacy, name: 'Nytt namn' }, legacy), null);
  assert.match(validateCustomerDetails(legacy), /kontrollsiffra/);
  const updated = normalizeCustomerDetails({ ...legacy, paymentProfile: payment({ bankType: 'bankgiro', bankgiro: '123-4566' }) });
  assert.equal(validateCustomerDetails(updated, legacy), null);
  assert.equal(updated.paymentProfile.bankgiro, '1234566'); assert.equal(hash(legacy), before);
});
