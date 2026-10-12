/** Canonical input rules shared by web, mobile and the authoritative server.
 * Normalizers never invent missing data. Validation is separate so legacy and
 * immutable snapshots can still be read without changing their original proof.
 */
export type AddressDetails = { address: string; postalCode: string; city: string; countryCode: string };
export type AddressInput = string | { address?: string; postalCode?: string; city?: string; countryCode?: string };
type CustomerFields = {
  type?: string; number?: string; phone?: string; address?: string; postalCode?: string;
  city?: string; countryCode?: string; origins?: string[];
  paymentProfile?: { method?: string; phone?: string; clearing?: string; account?: string };
};
type PhoneOptions = { swish?: boolean; required?: boolean };
const clean = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const compactIdentifier = (value: string) => clean(value).replace(/[\s-]/g, '');
export const normalizeOrganisationNumber = (value: string) => compactIdentifier(value);
export const normalizePersonalNumber = (value: string) => compactIdentifier(value).replace(/\+/g, '');

export function validLuhnNumber(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const sum = [...value].reduce((total, digit, index) => {
    const product = Number(digit) * (index % 2 === 0 ? 2 : 1);
    return total + (product > 9 ? product - 9 : product);
  }, 0);
  return sum % 10 === 0;
}
function personalNumberError(value: string): string | null {
  const number = normalizePersonalNumber(value);
  if (!/^(?:\d{10}|\d{12})$/.test(number)) return 'Personnumret ska innehålla 10 eller 12 siffror, med eller utan bindestreck.';
  const ten = number.slice(-10), year = number.length === 12 ? Number(number.slice(0, 4)) : 2000 + Number(ten.slice(0, 2));
  const month = Number(ten.slice(2, 4)), rawDay = Number(ten.slice(4, 6)), day = rawDay > 60 ? rawDay - 60 : rawDay;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1800 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31
    || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return 'Personnumret innehåller ett ogiltigt födelsedatum eller samordningsdatum.';
  return validLuhnNumber(ten) ? null : 'Personnumrets kontrollsiffra stämmer inte. Kontrollera numret.';
}
export function customerIdentifierError(type: string | undefined, value: string): string | null {
  if (type === 'Privatperson') return clean(value) ? personalNumberError(value) : null;
  const number = normalizeOrganisationNumber(value);
  // A sole trader uses a personal or coordination number. Do not treat their
  // valid identity as a juridical person's organisation number.
  const personal = normalizePersonalNumber(value);
  if (type === 'Företag' && (/^\d{12}$/.test(personal) || /^\d{2}[01]\d{7}$/.test(personal))) return personalNumberError(value);
  if (!/^\d{10}$/.test(number)) return 'Organisationsnumret ska innehålla exakt 10 siffror, med eller utan bindestreck.';
  if (Number(number[2]) < 2) return 'Organisationsnumret har ett ogiltigt format. Kontrollera numret.';
  return validLuhnNumber(number) ? null : 'Organisationsnumrets kontrollsiffra stämmer inte. Kontrollera numret.';
}
/** Matching key only, never changes the stored century-bearing identity. */
export function customerIdentityKey(type: string | undefined, value: string): string {
  const normalized = normalizePersonalNumber(value);
  if (type === 'Privatperson' || type === 'Företag' && (/^\d{12}$/.test(normalized) || /^\d{2}[01]\d{7}$/.test(normalized))) return normalized.slice(-10);
  return normalizeOrganisationNumber(value);
}

export function normalizePhoneNumber(value: string, options: PhoneOptions = {}): string {
  const number = clean(value).replace(/(?:\+46|0046)\s*\(0\)/, '+46').replace(/[\s().-]/g, '');
  if (options.swish && /^123\d{7}$/.test(number)) return number;
  if (/^00[1-9]\d+$/.test(number)) return `+${number.slice(2)}`;
  if (/^0[1-9]\d+$/.test(number)) return `+46${number.slice(1)}`;
  if (/^46[1-9]\d{6,9}$/.test(number)) return `+${number}`;
  return number;
}
export function phoneNumberError(value: string, options: PhoneOptions = {}): string | null {
  const number = normalizePhoneNumber(value, options);
  if (!number) return options.required ? 'Ange ett telefonnummer.' : null;
  if (options.swish) return /^(?:\+467[02369]\d{7}|123\d{7})$/.test(number) ? null
    : 'Ange ett svenskt mobilnummer för Swish eller ett företags-Swishnummer som börjar med 123.';
  return /^\+[1-9]\d{6,14}$/.test(number) && (!number.startsWith('+46') || /^\+46[1-9]\d{6,9}$/.test(number)) ? null
    : 'Ange ett giltigt telefonnummer, exempelvis 0722002220 eller +46722002220.';
}

const trimSeparators = (value: string) => value.replace(/^[\s,;]+|[\s,;]+$/g, '').trim();
function parseAddressLine(value: string): AddressDetails {
  const line = clean(value).replace(/[,;]?\s+(?:Sverige|Sweden)$/i, '').trim();
  const matches = [...line.matchAll(/(?:^|[\s,;])(\d{3}\s?\d{2})(?=$|[\s,;])/g)];
  // More than one postcode is ambiguous; never silently choose one.
  if (matches.length === 1) {
    const match = matches[0], start = match.index! + match[0].indexOf(match[1]);
    const street = trimSeparators(line.slice(0, start)), city = trimSeparators(line.slice(start + match[1].length));
    // A five-digit building/reference number alone is not a postal address.
    if (street && city && /\p{L}/u.test(city) && !/[\d;]/.test(city)) return {
      address: street, postalCode: match[1].replace(/\s/g, ''), city, countryCode: 'SE',
    };
  }
  return { address: line, postalCode: '', city: '', countryCode: 'SE' };
}
export function normalizeAddress(input: AddressInput): AddressDetails {
  if (typeof input === 'string') return parseAddressLine(input);
  const parsed = parseAddressLine(input.address ?? ''), postalCode = clean(input.postalCode).replace(/\s/g, ''), city = clean(input.city);
  // Remove a legacy embedded postcode/city only when it agrees with the
  // explicitly structured fields. Conflicting fields are preserved for review.
  const agrees = (!postalCode || parsed.postalCode === postalCode) && (!city || parsed.city.toLocaleLowerCase('sv-SE') === city.toLocaleLowerCase('sv-SE'));
  let street = agrees ? parsed.address : clean(input.address);
  // A separately supplied city is authoritative enough to remove its exact
  // repeated suffix even when a legacy combined line has no postcode.
  if (!parsed.city && city) {
    const parts = street.split(/[,;]/).map(part => part.trim()).filter(Boolean);
    if (parts.length > 1 && parts.at(-1)!.toLocaleLowerCase('sv-SE') === city.toLocaleLowerCase('sv-SE')) street = parts.slice(0, -1).join(', ');
  }
  return {
    address: street,
    postalCode: postalCode || (agrees ? parsed.postalCode : ''),
    city: city || (agrees ? parsed.city : ''),
    countryCode: clean(input.countryCode).toUpperCase() || 'SE',
  };
}
export function addressError(input: AddressInput): string | null {
  const value = normalizeAddress(input);
  if (value.countryCode === 'SE' && value.postalCode && !/^\d{5}$/.test(value.postalCode)) return 'Postnumret ska innehålla fem siffror.';
  if (value.countryCode && !/^[A-Z]{2}$/.test(value.countryCode)) return 'Ange landets tvåbokstavskod, exempelvis SE.';
  if (typeof input !== 'string') {
    const parsed = parseAddressLine(input.address ?? '');
    if (parsed.postalCode && input.postalCode && parsed.postalCode !== clean(input.postalCode).replace(/\s/g, '')) return 'Adressen och postnummerfältet anger olika postnummer. Kontrollera adressen.';
    if (parsed.city && input.city && parsed.city.toLocaleLowerCase('sv-SE') !== clean(input.city).toLocaleLowerCase('sv-SE')) return 'Adressen och ortfältet anger olika orter. Kontrollera adressen.';
  }
  return null;
}
export function formatAddress(input: AddressInput): string {
  const value = normalizeAddress(input), locality = [value.postalCode, value.city].filter(Boolean).join(' ');
  return [value.address, locality].filter(Boolean).join(', ');
}
export const normalizeOriginAddress = (value: string) => formatAddress(value);

export function normalizePaymentDetails<T extends { method?: string; phone?: string; clearing?: string; account?: string }>(details: T): T {
  return { ...details,
    ...(details.phone === undefined ? {} : { phone: normalizePhoneNumber(details.phone, { swish: details.method === 'swish' }) }),
    ...(details.clearing === undefined ? {} : { clearing: compactIdentifier(details.clearing) }),
    ...(details.account === undefined ? {} : { account: compactIdentifier(details.account) }),
  };
}
export function normalizeCustomerDetails<T extends CustomerFields>(customer: T): T & AddressDetails {
  const address = normalizeAddress(customer);
  const number = customer.number === undefined ? undefined : normalizePersonalNumber(customer.number);
  const personal = customer.type === 'Privatperson' || customer.type === 'Företag' && number !== undefined && (/^\d{12}$/.test(number) || /^\d{2}[01]\d{7}$/.test(number));
  return { ...customer, ...address,
    ...(customer.number === undefined ? {} : { number: personal ? normalizePersonalNumber(customer.number) : normalizeOrganisationNumber(customer.number) }),
    ...(customer.phone === undefined ? {} : { phone: normalizePhoneNumber(customer.phone) }),
    ...(customer.origins === undefined ? {} : { origins: customer.origins.map(normalizeOriginAddress) }),
    ...(customer.paymentProfile === undefined ? {} : { paymentProfile: normalizePaymentDetails(customer.paymentProfile) }),
  };
}
export function validateCustomerDetails(customer: CustomerFields, previous?: CustomerFields): string | null {
  const normalized = normalizeCustomerDetails(customer), old = previous && normalizeCustomerDetails(previous);
  if (!old || normalized.number !== old.number || customer.type !== previous?.type) {
    const error = customerIdentifierError(customer.type, customer.number ?? '');
    if (error) return error;
  }
  if (!old || normalized.phone !== old.phone) {
    const error = phoneNumberError(customer.phone ?? '');
    if (error) return error;
  }
  if (!old || ['address', 'postalCode', 'city', 'countryCode'].some(field => normalized[field as keyof AddressDetails] !== old[field as keyof AddressDetails])) {
    const error = addressError(customer);
    if (error) return error;
  }
  if (customer.paymentProfile?.method === 'swish' && (!old || old.paymentProfile?.method !== 'swish' || old.paymentProfile.phone !== normalized.paymentProfile?.phone)) {
    const error = phoneNumberError(customer.paymentProfile.phone ?? '', { required: true, swish: true });
    if (error) return error;
  }
  return null;
}
