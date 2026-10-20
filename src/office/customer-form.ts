import type { OfficeCustomer, OfficeData } from './model';
import { z } from 'zod';
import { companyLookupNumberError, formatCompanyRegisterAddress, normalizeCompanyLookupNumber, type CompanyRegisterCompany } from '../company-register/client';
import { customerIdentityKey, normalizeCustomerDetails, normalizePhoneNumber, phoneNumberError, validateCustomerDetails } from '../data-format';

const registerEmail = z.string().max(254).email();

/** Apply confirmed company details; only fill contact fields that are still blank. */
export function applyCompanyLookupToCustomer(
  customer: OfficeCustomer,
  company: CompanyRegisterCompany,
): OfficeCustomer {
  const number = normalizeCompanyLookupNumber(company.organisationNumber);
  if (customer.type === 'Privatperson' || companyLookupNumberError(number) ||
      normalizeCompanyLookupNumber(customer.number) !== number) return customer;
  const address = formatCompanyRegisterAddress(company);
  const phone = typeof company.phone === 'string' ? normalizePhoneNumber(company.phone) : '';
  const email = typeof company.email === 'string' ? company.email.trim() : '';
  return {
    ...customer,
    number,
    ...(company.name.trim() ? { name: company.name } : {}),
    ...(address ? { address } : {}),
    ...(company.postalCode.trim() ? { postalCode: company.postalCode } : {}),
    ...(company.city.trim() ? { city: company.city } : {}),
    countryCode: company.countryCode,
    ...(!customer.phone.trim() && phone && !phoneNumberError(phone) ? { phone } : {}),
    ...(!customer.email.trim() && registerEmail.safeParse(email).success ? { email } : {}),
    ...(typeof company.vatRegistered === 'boolean' ? { vatRegistered: company.vatRegistered } : {}),
  };
}

/** Drafts use the existing office customer model, including the same optional fields. */
export function createCustomerDraft(
  data: Pick<OfficeData, 'customers'>,
  initial?: OfficeCustomer,
): OfficeCustomer {
  if (initial) return structuredClone(initial);
  return {
    id: `customer-${crypto.randomUUID()}`,
    name: '',
    type: 'Företag',
    vatRegistered: true,
    number: '',
    customerNumber: `K-${Math.max(1000, ...data.customers.map((customer) => Number(customer.customerNumber.replace(/\D/g, '')) || 0)) + 1}`,
    phone: '',
    email: '',
    address: '',
    postalCode: '',
    city: '',
    countryCode: 'SE',
    contactPerson: '',
    references: [],
    origins: [],
    registrations: [],
    audit: [],
  };
}

export function cleanCustomerDraft(customer: OfficeCustomer): OfficeCustomer {
  const draft = structuredClone(customer);
  for (const key of [
    'name', 'number', 'phone', 'email', 'address', 'postalCode', 'city', 'contactPerson',
  ] as const) draft[key] = draft[key].trim();
  return draft;
}

/** Preserve the hidden business choice while editing; private customers save without VAT. */
export function customerDraftForSave(customer: OfficeCustomer): OfficeCustomer {
  const draft = normalizeCustomerDetails(cleanCustomerDraft(customer));
  if (draft.type === 'Privatperson' && draft.vatRegistered !== undefined) draft.vatRegistered = false;
  return draft;
}

function identityNumber(customer: OfficeCustomer): string {
  return customerIdentityKey(customer.type, customer.number);
}

/** A separate customer record may share a legal identity; choosing it is explicit. */
export function customerDraftDuplicates(draft: OfficeCustomer, customers: OfficeCustomer[]): OfficeCustomer[] {
  const number = identityNumber(draft);
  return number ? customers.filter(customer => customer.id !== draft.id && identityNumber(customer) === number) : [];
}

export function customerDraftError(
  draft: OfficeCustomer,
  customers: OfficeCustomer[],
  options: { allowDuplicate?: boolean; previous?: OfficeCustomer } = {},
): string {
  if (!draft.name.trim()) return 'Ange kundens namn.';
  const previous = options.previous ?? customers.find(customer => customer.id === draft.id);
  const formatError = validateCustomerDetails(draft, previous);
  if (formatError) return formatError;
  if (draft.paymentTermDays !== undefined && (
    !Number.isInteger(draft.paymentTermDays) || draft.paymentTermDays < 0 || draft.paymentTermDays > 3650
  )) return 'Ange ett helt antal betalningsdagar mellan 0 och 3650.';
  if (!options.allowDuplicate && customerDraftDuplicates(draft, customers).length &&
      (!previous || identityNumber(previous) !== identityNumber(draft)))
    return 'En kund med samma organisations- eller personnummer finns redan. Välj den befintliga kunden eller bekräfta att en separat kundpost ska skapas.';
  return '';
}
