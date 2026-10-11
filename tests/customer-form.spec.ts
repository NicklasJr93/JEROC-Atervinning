import { test, expect } from '@playwright/test';
import { officeSchema, seedOffice } from '../src/office/model';
import { cleanCustomerDraft, createCustomerDraft, customerDraftError, customerDraftForSave } from '../src/office/customer-form';

test('kunddubbletter stoppas även när organisationsnumret har olika formatering', () => {
  const data = seedOffice();
  const existing = data.customers.find((customer) => customer.type === 'Företag')!;
  const duplicate = {
    ...createCustomerDraft(data),
    name: 'Samma företag, nytt namn',
    number: existing.number.replace(/[\s-]/g, ''),
  };
  expect(customerDraftError(duplicate, data.customers)).toContain('finns redan');
  expect(customerDraftError(existing, data.customers)).toBe('');
  expect(customerDraftError({ ...duplicate, number: '' }, data.customers)).toBe('');
});

test('personnummer på tio och tolv siffror identifierar samma kund utan att läcka i feltext', () => {
  const data = seedOffice();
  const existing = {
    ...createCustomerDraft(data),
    type: 'Privatperson' as const,
    name: 'Testperson',
    number: '19800101-1234',
  };
  const duplicate = {
    ...createCustomerDraft(data),
    type: 'Privatperson' as const,
    name: 'Testperson två',
    number: '8001011234',
  };
  const error = customerDraftError(duplicate, [existing]);
  expect(error).toContain('finns redan');
  expect(error).not.toContain('800101');
  expect(cleanCustomerDraft(existing).number).toBe('19800101-1234');
});

test('grundkundens draft kan flyttas till hela kundformuläret utan att mutera eller tappa uppgifter', () => {
  const data = seedOffice();
  const initial = {
    ...createCustomerDraft(data),
    name: ' Ny Kund AB ',
    phone: ' 070-123 45 67 ',
    email: ' kontakt@example.test ',
    address: ' Testgatan 12 ',
    postalCode: ' 761 30 ',
    city: ' Norrtälje ',
    references: ['Projekt A'],
    vatRegistered: false,
    paymentTermDays: 45,
  };
  const transferred = createCustomerDraft(data, cleanCustomerDraft(initial));
  expect(transferred).toMatchObject({
    id: initial.id, name: 'Ny Kund AB', phone: '070-123 45 67',
    email: 'kontakt@example.test', address: 'Testgatan 12',
    postalCode: '761 30', city: 'Norrtälje', references: ['Projekt A'], vatRegistered: false, paymentTermDays: 45,
  });
  transferred.references.push('Projekt B');
  expect(initial.references).toEqual(['Projekt A']);
  expect(initial.name).toBe(' Ny Kund AB ');
});

test('momsval finns på nya företagskunder och äldre kunders saknade uppgift lämnas orörd', () => {
  const data = seedOffice(), draft = createCustomerDraft(data);
  expect(draft.vatRegistered).toBe(true);
  expect(draft.paymentTermDays).toBeUndefined();
  const historical = createCustomerDraft(data, data.customers[0]);
  expect(historical.vatRegistered).toBeUndefined();
  expect(officeSchema.parse(data).customers[0].vatRegistered).toBeUndefined();
  const privateDraft = { ...draft, name: 'Testperson', type: 'Privatperson' as const };
  const transferred = createCustomerDraft(data, cleanCustomerDraft(privateDraft));
  expect(transferred.vatRegistered).toBe(true);
  expect(customerDraftForSave(transferred).vatRegistered).toBe(false);
  expect(transferred.vatRegistered).toBe(true);
  expect(customerDraftForSave({ ...historical, type: 'Privatperson' }).vatRegistered).toBeUndefined();
});

test('betalningsdagar valideras som heltal och integrationens standard förblir valfri', () => {
  const data = seedOffice(), draft = { ...createCustomerDraft(data), name: 'Villkorskund' };
  for (const paymentTermDays of [undefined, 0, 1, 10, 30, 45, 3650]) {
    expect(customerDraftError({ ...draft, paymentTermDays }, [])).toBe('');
    expect(officeSchema.shape.customers.removeDefault().element.safeParse({ ...draft, paymentTermDays }).success).toBe(true);
  }
  for (const paymentTermDays of [-1, 3651, 1.5, Number.NaN]) {
    expect(customerDraftError({ ...draft, paymentTermDays }, [])).toContain('0 och 3650');
    expect(officeSchema.shape.customers.removeDefault().element.safeParse({ ...draft, paymentTermDays }).success).toBe(false);
  }
});
