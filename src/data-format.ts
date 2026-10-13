/** Canonical input rules shared by web, mobile and the authoritative server.
 * Normalizers never invent missing data. Validation is separate so legacy and
 * immutable snapshots can still be read without changing their original proof.
 */
export type AddressDetails = { address: string; postalCode: string; city: string; countryCode: string };
export type AddressInput = string | { address?: string; postalCode?: string; city?: string; countryCode?: string };
type CustomerFields = {
  type?: string; number?: string; phone?: string; address?: string; postalCode?: string;
  city?: string; countryCode?: string; origins?: string[];
  paymentProfile?: BankRecipientInput;
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

export type BankRecipientType = 'account' | 'bankgiro' | 'plusgiro' | 'iban';
export type BankRecipientInput = {
  method?: string; bankType?: string; bank?: string; clearing?: string; account?: string;
  holder?: string; bankgiro?: string; plusgiro?: string; iban?: string; bic?: string;
  bankCountry?: string; beneficiaryAddress?: string; ocr?: string; phone?: string; recipient?: string;
};
export type BankRecipientRequirements = { requireBic?: boolean; requireCountry?: boolean; requireAddress?: boolean };

/** Interprets legacy bank recipients without mutating or defaulting a snapshot. */
export function bankRecipientType(details?: BankRecipientInput): BankRecipientType {
  return details?.bankType === 'bankgiro' || details?.bankType === 'plusgiro' || details?.bankType === 'iban' ? details.bankType : 'account';
}
const compactBankNumber = (value: string) => clean(value).replace(/[\s-]/g, '');
const compactBankCode = (value: string) => clean(value).replace(/\s/g, '').toUpperCase();
const luhnChecksum = (value: string) => /^\d+$/.test(value) && [...value].reverse().reduce((sum, digit, index) => {
  const product = Number(digit) * (index % 2 ? 2 : 1);
  return sum + (product > 9 ? product - 9 : product);
}, 0) % 10 === 0;

// ISO 13616 country lengths. A recognised length and checksum identify a valid
// format, not a real account, owner, bank agreement or supported payment route.
const ibanLengths: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22,
  IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19,
  MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31,
  SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23,
  TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};
// Numeric BBAN countries plus letter-bearing routes used by neighbouring
// banks. Unlisted recognised countries still obey their registered length,
// alphanumeric form and mod97 rather than a guessed local bank rule.
const numericIbanCountries = new Set(['AE', 'AT', 'BA', 'BE', 'BI', 'CR', 'CZ', 'DE', 'DJ', 'DK', 'EE', 'EG', 'ES', 'FI', 'FO', 'GL', 'HR', 'HU', 'IL', 'IS', 'LT', 'LY', 'ME', 'MN', 'MR', 'NO', 'PL', 'PT', 'RS', 'SD', 'SE', 'SI', 'SK', 'SO', 'ST', 'TL', 'TN', 'VA', 'XK']);
const ibanBbanPatterns: Readonly<Record<string, RegExp>> = {
  GB: /^[A-Z]{4}\d{14}$/, IE: /^[A-Z]{4}\d{14}$/, NL: /^[A-Z]{4}\d{10}$/,
  LV: /^[A-Z]{4}[A-Z0-9]{13}$/, IT: /^[A-Z]\d{10}[A-Z0-9]{12}$/, SM: /^[A-Z]\d{10}[A-Z0-9]{12}$/,
  AD: /^\d{8}[A-Z0-9]{12}$/, AL: /^\d{8}[A-Z0-9]{16}$/, AZ: /^[A-Z]{4}[A-Z0-9]{20}$/,
  BG: /^[A-Z]{4}\d{6}[A-Z0-9]{8}$/, BH: /^[A-Z]{4}[A-Z0-9]{14}$/, BR: /^\d{23}[A-Z][A-Z0-9]$/,
  BY: /^[A-Z0-9]{4}\d{4}[A-Z0-9]{16}$/, CH: /^\d{5}[A-Z0-9]{12}$/, CY: /^\d{8}[A-Z0-9]{16}$/,
  FK: /^[A-Z]{2}\d{12}$/, FR: /^\d{10}[A-Z0-9]{11}\d{2}$/, GE: /^[A-Z]{2}\d{16}$/,
  GI: /^[A-Z]{4}[A-Z0-9]{15}$/, GR: /^\d{7}[A-Z0-9]{16}$/, IQ: /^[A-Z]{4}\d{15}$/,
  JO: /^[A-Z]{4}\d{4}[A-Z0-9]{18}$/, KW: /^[A-Z]{4}[A-Z0-9]{22}$/, KZ: /^\d{3}[A-Z0-9]{13}$/,
  LB: /^\d{4}[A-Z0-9]{20}$/, LC: /^[A-Z]{4}[A-Z0-9]{24}$/, LI: /^\d{5}[A-Z0-9]{12}$/,
  LU: /^\d{3}[A-Z0-9]{13}$/, MC: /^\d{10}[A-Z0-9]{11}\d{2}$/, MD: /^[A-Z0-9]{2}[A-Z0-9]{18}$/,
  MK: /^\d{3}[A-Z0-9]{10}\d{2}$/, MT: /^[A-Z]{4}\d{5}[A-Z0-9]{18}$/, NI: /^[A-Z]{4}\d{20}$/,
  OM: /^\d{3}[A-Z0-9]{16}$/, PK: /^[A-Z]{4}[A-Z0-9]{16}$/, PS: /^[A-Z]{4}[A-Z0-9]{21}$/,
  QA: /^[A-Z]{4}[A-Z0-9]{21}$/, RO: /^[A-Z]{4}[A-Z0-9]{16}$/, RU: /^\d{9}[A-Z0-9]{20}$/,
  SA: /^\d{2}[A-Z0-9]{18}$/, TR: /^\d{5}\d[A-Z0-9]{16}$/, UA: /^\d{6}[A-Z0-9]{19}$/,
  VG: /^[A-Z]{4}\d{16}$/,
  DO: /^[A-Z0-9]{4}\d{20}$/, MU: /^[A-Z]{4}\d{19}[A-Z]{3}$/, SC: /^[A-Z]{4}\d{20}[A-Z]{3}$/,
  SV: /^[A-Z]{4}\d{20}$/,
};
export function ibanNumberError(value: string): string | null {
  const iban = compactBankCode(value), country = iban.slice(0, 2), expected = ibanLengths[country];
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || iban.length > 34) return 'Ange ett giltigt IBAN med landskod och kontrollsiffror.';
  if (!expected || iban.length !== expected) return 'IBAN har fel längd för det angivna banklandet.';
  const bban = iban.slice(4);
  if (numericIbanCountries.has(country) && !/^\d+$/.test(bban) || ibanBbanPatterns[country] && !ibanBbanPatterns[country].test(bban))
    return 'IBAN har fel kontonummerformat för det angivna banklandet.';
  let remainder = 0;
  for (const character of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1 ? null : 'IBAN:s kontrollsiffror stämmer inte. Kontrollera numret.';
}
export function ocrNumberError(value: string): string | null {
  const number = compactBankNumber(value);
  if (!/^\d{2,25}$/.test(number) || /^0+$/.test(number)) return 'OCR ska innehålla 2–25 siffror.';
  return luhnChecksum(number) ? null : 'OCR-numrets kontrollsiffra stämmer inte.';
}
export function bankRecipientError(details: BankRecipientInput, requirements: BankRecipientRequirements = {}): string | null {
  if (details.method && details.method !== 'bank') return 'Välj Banköverföring för bankmottagaren.';
  if (details.bankType && !['account', 'bankgiro', 'plusgiro', 'iban'].includes(details.bankType)) return 'Välj en giltig bankmottagartyp.';
  if (!clean(details.holder)) return 'Ange mottagarens namn.';
  const type = bankRecipientType(details);
  if (type === 'account') {
    const clearing = compactBankNumber(details.clearing ?? ''), account = compactBankNumber(details.account ?? '');
    if (!/^\d{4,5}$/.test(clearing) || /^0+$/.test(clearing) || clearing.length === 5 && !clearing.startsWith('8')) return 'Ange ett svenskt clearingnummer med fyra siffror, eller fem för Swedbank/Sparbankerna.';
    if (!/^\d{4,15}$/.test(account) || /^0+$/.test(account)) return 'Ange ett giltigt svenskt kontonummer med 4–15 siffror.';
  } else if (type === 'bankgiro' || type === 'plusgiro') {
    const number = compactBankNumber(details[type] ?? ''), pattern = type === 'bankgiro' ? /^\d{7,8}$/ : /^\d{2,8}$/;
    const title = type === 'bankgiro' ? 'Bankgiro' : 'Plusgiro';
    if (!pattern.test(number) || /^0+$/.test(number)) return `${title} har fel format eller längd.`;
    if (!luhnChecksum(number)) return `${title}ts kontrollsiffra stämmer inte. Kontrollera numret.`;
  } else {
    const error = ibanNumberError(details.iban ?? '');
    if (error) return error;
  }
  const country = compactBankCode(details.bankCountry ?? '');
  if (country && !/^[A-Z]{2}$/.test(country)) return 'Ange banklandets tvåbokstavskod, exempelvis SE.';
  if (requirements.requireCountry && !country) return 'Den valda banktjänsten kräver bankland.';
  if (country && (type === 'iban' ? country !== compactBankCode(details.iban ?? '').slice(0, 2) : country !== 'SE')) return 'Banklandet stämmer inte med mottagarens kontonummer.';
  const bic = compactBankCode(details.bic ?? '');
  if (bic && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(bic)) return 'BIC/SWIFT ska innehålla 8 eller 11 tecken i giltigt format.';
  if (requirements.requireBic && !bic) return 'Den valda banktjänsten kräver BIC/SWIFT.';
  if (requirements.requireAddress && !clean(details.beneficiaryAddress)) return 'Den valda banktjänsten kräver mottagaradress.';
  if (clean(details.ocr)) return ocrNumberError(details.ocr!);
  return null;
}

/** Called only when saving an editable instruction; never on immutable proofs. */
export function normalizePaymentDetails<T extends BankRecipientInput>(details: T): T {
  const result = { ...details,
    ...(details.phone === undefined ? {} : { phone: normalizePhoneNumber(details.phone, { swish: details.method === 'swish' }) }),
    ...(details.clearing === undefined ? {} : { clearing: compactIdentifier(details.clearing) }),
    ...(details.account === undefined ? {} : { account: compactIdentifier(details.account) }),
  };
  if (details.method === 'bank') {
    for (const field of ['bank', 'holder', 'beneficiaryAddress'] as const) if (details[field] !== undefined) Object.assign(result, { [field]: clean(details[field]) });
    for (const field of ['bankgiro', 'plusgiro', 'ocr'] as const) if (details[field] !== undefined) Object.assign(result, { [field]: compactBankNumber(details[field]!) });
    for (const field of ['iban', 'bic', 'bankCountry'] as const) if (details[field] !== undefined) Object.assign(result, { [field]: compactBankCode(details[field]!) });
    const type = bankRecipientType(details);
    const active = type === 'account' ? ['clearing', 'account'] : [type];
    for (const field of ['clearing', 'account', 'bankgiro', 'plusgiro', 'iban'] as const) if (!active.includes(field)) delete result[field];
  }
  return result;
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
  const profileChanged = !old || [...new Set([...Object.keys(normalized.paymentProfile ?? {}), ...Object.keys(old.paymentProfile ?? {})])]
    .some(field => normalized.paymentProfile?.[field as keyof BankRecipientInput] !== old.paymentProfile?.[field as keyof BankRecipientInput]);
  if (customer.paymentProfile?.method === 'bank' && profileChanged) {
    const error = bankRecipientError(customer.paymentProfile);
    if (error) return error;
  }
  return null;
}
