import { test, expect } from '@playwright/test';
import { officeSchema, seedOffice } from '../src/office/model';
import { applyCompanyLookupToCustomer, cleanCustomerDraft, createCustomerDraft, customerDraftError, customerDraftForSave } from '../src/office/customer-form';
import type { CompanyRegisterCompany } from '../src/company-register/client';
import { testOrganisationNumber, testPersonalNumber } from './helpers/customer-identity';

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
  expect(customerDraftError(duplicate, data.customers, { allowDuplicate: true })).toBe('');
  expect(customerDraftError({ ...duplicate, number: '' }, data.customers)).toContain('10 siffror');
});

test('personnummer på tio och tolv siffror identifierar samma kund utan att läcka i feltext', () => {
  const data = seedOffice();
  const existing = {
    ...createCustomerDraft(data),
    type: 'Privatperson' as const,
    name: 'Testperson',
    number: testPersonalNumber(),
  };
  const duplicate = {
    ...createCustomerDraft(data),
    type: 'Privatperson' as const,
    name: 'Testperson två',
    number: existing.number.slice(2),
  };
  const error = customerDraftError(duplicate, [existing]);
  expect(error).toContain('finns redan');
  expect(error).not.toContain('800101');
  expect(cleanCustomerDraft(existing).number).toBe(existing.number);
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
  const data = seedOffice(), draft = { ...createCustomerDraft(data), name: 'Villkorskund', number: testOrganisationNumber() };
  for (const paymentTermDays of [undefined, 0, 1, 10, 30, 45, 3650]) {
    expect(customerDraftError({ ...draft, paymentTermDays }, [])).toBe('');
    expect(officeSchema.shape.customers.removeDefault().element.safeParse({ ...draft, paymentTermDays }).success).toBe(true);
  }
  for (const paymentTermDays of [-1, 3651, 1.5, Number.NaN]) {
    expect(customerDraftError({ ...draft, paymentTermDays }, [])).toContain('0 och 3650');
    expect(officeSchema.shape.customers.removeDefault().element.safeParse({ ...draft, paymentTermDays }).success).toBe(false);
  }
});

test('kundsparande använder kanoniskt nummer, telefon och uppdelad adress utan att mutera utkastet', () => {
  const data = seedOffice(), number = testOrganisationNumber();
  const draft = { ...createCustomerDraft(data), name: 'Formatkund', number: `${number.slice(0, 6)}-${number.slice(6)}`,
    phone: '072 200 22 20', address: 'Storgatan 12, 761 41 Norrtälje', postalCode: '', city: '' };
  expect(customerDraftError(draft, [])).toBe('');
  expect(customerDraftForSave(draft)).toMatchObject({ number, phone: '+46722002220', address: 'Storgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE' });
  expect(draft.number).toContain('-');
  expect(draft.address).toContain('761 41');
  expect(customerDraftError({ ...draft, number: `${number}1` }, [])).toContain('10 siffror');
  expect(customerDraftError({ ...draft, phone: 'ABC123' }, [])).toContain('telefonnummer');
});

const registerCompany = (number: string): CompanyRegisterCompany => ({
  organisationNumber: number,
  name: 'Registerföretaget AB',
  address: 'Registergatan 1',
  postalCode: '76130',
  city: 'Norrtälje',
  countryCode: 'SE',
  source: 'SCB',
  fetchedAt: '2026-10-20T12:00:00.000Z',
});

test('företagsuppslag kompletterar identitet utan att ändra kontakt, villkor eller betalningsprofil', () => {
  const number = testOrganisationNumber();
  const customer = {
    ...createCustomerDraft(seedOffice()),
    number: `${number.slice(0, 6)}-${number.slice(6)}`,
    name: 'Manuellt namn',
    email: 'kontakt@example.test',
    phone: '+46722002220',
    contactPerson: 'Kundens kontaktperson',
    origins: ['Arbetsplatsen 1'],
    references: ['Projekt A'],
    paymentTermDays: 45,
    vatRegistered: false,
    paymentProfile: { method: 'swish' as const, phone: '+46722002220', recipient: 'Mottagaren' },
  };
  const result = applyCompanyLookupToCustomer(customer, { ...registerCompany(number), vatRegistered: true });
  expect(result).toMatchObject({
    number, name: 'Registerföretaget AB', address: 'Registergatan 1', postalCode: '76130', city: 'Norrtälje',
    email: customer.email, phone: customer.phone, contactPerson: customer.contactPerson,
    paymentTermDays: 45, vatRegistered: true, paymentProfile: customer.paymentProfile,
    origins: customer.origins, references: customer.references,
  });
  expect(customer.name).toBe('Manuellt namn');
  expect(customer.number).toContain('-');
});

test('ett gammalt företagsuppslag kan inte fylla i en annan identitet eller en privatkund', () => {
  const number = testOrganisationNumber();
  const customer = { ...createCustomerDraft(seedOffice()), number };
  let otherNumber = testOrganisationNumber();
  while (otherNumber === number) otherNumber = testOrganisationNumber();
  const staleCompany = { ...registerCompany(number), organisationNumber: otherNumber };
  expect(applyCompanyLookupToCustomer(customer, staleCompany)).toBe(customer);
  const privateCustomer = { ...customer, type: 'Privatperson' as const };
  expect(applyCompanyLookupToCustomer(privateCustomer, registerCompany(number))).toBe(privateCustomer);
});

test('saknad registeradress tömmer inte manuella uppgifter och känt momsbesked fyller i momsvalet', () => {
  const number = testOrganisationNumber();
  const customer = { ...createCustomerDraft(seedOffice()), number: `16${number}`, address: 'Manuell gata 2', postalCode: '12345', city: 'Rimbo' };
  const company = { ...registerCompany(number), address: '', postalCode: '', city: '' };
  const result = applyCompanyLookupToCustomer(customer, company);
  expect(result).toMatchObject({ number, address: 'Manuell gata 2', postalCode: '12345', city: 'Rimbo', vatRegistered: true });
  expect(applyCompanyLookupToCustomer(customer, { ...company, vatRegistered: false }).vatRegistered).toBe(false);
  expect(applyCompanyLookupToCustomer({ ...customer, vatRegistered: undefined }, { ...company, vatRegistered: true }).vatRegistered).toBe(true);
  expect(applyCompanyLookupToCustomer({ ...customer, vatRegistered: false }, company).vatRegistered).toBe(false);
  expect(applyCompanyLookupToCustomer({ ...customer, vatRegistered: undefined }, company).vatRegistered).toBeUndefined();
});

test('F-skatt styr inte momsvalet och ett ifyllt momsval kan ändras manuellt före sparande', () => {
  const number = testOrganisationNumber();
  const customer = { ...createCustomerDraft(seedOffice()), number, vatRegistered: false };
  const result = applyCompanyLookupToCustomer(customer, { ...registerCompany(number), vatRegistered: true, fTaxRegistered: false });
  expect(result.vatRegistered).toBe(true);
  expect(customerDraftForSave({ ...result, vatRegistered: false }).vatRegistered).toBe(false);
  expect(applyCompanyLookupToCustomer(customer, { ...registerCompany(number), fTaxRegistered: true }).vatRegistered).toBe(false);
});

test('registeradress bevarar både c/o-mottagare och gatuadress i kundkortets adressfält', () => {
  const number = testOrganisationNumber();
  const customer = { ...createCustomerDraft(seedOffice()), number };
  const result = applyCompanyLookupToCustomer(customer, { ...registerCompany(number), careOf: 'c/o Registerförvaltaren AB' });
  expect(result.address).toContain('Registerförvaltaren AB');
  expect(result.address).toContain('Registergatan 1');
  expect(result.postalCode).toBe('76130');
});
