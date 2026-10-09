import type { OfficeCustomer, OfficeData } from './model';

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
    number: '',
    customerNumber: `K-${Math.max(1000, ...data.customers.map((customer) => Number(customer.customerNumber.replace(/\D/g, '')) || 0)) + 1}`,
    phone: '',
    email: '',
    address: '',
    postalCode: '',
    city: '',
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

function identityNumber(customer: OfficeCustomer): string {
  const number = customer.number.replace(/[\s-]/g, '').toLocaleLowerCase('sv');
  // Both customary lengths identify the same person. Keep the original value in
  // the draft and never place it in the duplicate error, URL or browser storage.
  return customer.type === 'Privatperson' && /^\d{12}$/.test(number)
    ? number.slice(2)
    : number;
}

export function customerDraftError(
  draft: OfficeCustomer,
  customers: OfficeCustomer[],
): string {
  if (!draft.name.trim()) return 'Ange kundens namn.';
  const number = identityNumber(draft);
  if (number && customers.some((customer) =>
    customer.id !== draft.id && identityNumber(customer) === number,
  )) return 'En kund med samma organisations- eller personnummer finns redan. Välj den befintliga kunden.';
  return '';
}
