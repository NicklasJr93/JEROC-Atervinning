import { test, expect } from '@playwright/test';
import { seedOffice } from '../src/office/model';
import { cleanCustomerDraft, createCustomerDraft, customerDraftError } from '../src/office/customer-form';

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
  };
  const transferred = createCustomerDraft(data, cleanCustomerDraft(initial));
  expect(transferred).toMatchObject({
    id: initial.id, name: 'Ny Kund AB', phone: '070-123 45 67',
    email: 'kontakt@example.test', address: 'Testgatan 12',
    postalCode: '761 30', city: 'Norrtälje', references: ['Projekt A'],
  });
  transferred.references.push('Projekt B');
  expect(initial.references).toEqual(['Projekt A']);
  expect(initial.name).toBe(' Ny Kund AB ');
});
