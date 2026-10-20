import { z } from 'zod';
import { inspectCustomerIdentifier } from '../customer-identity';
import { companyLookupScope, type CompanyLookupScope } from '../company-register/client';

export interface PersonRegisterPerson {
  personalNumber: string;
  name: string;
  address: string;
  careOf?: string;
  postalCode: string;
  city: string;
  countryCode: 'SE';
  source: 'Roaring';
  fetchedAt: string;
}
export type PersonRegisterLookupResult = { existing: true; person: null } | { existing: false; person: PersonRegisterPerson };

export class PersonLookupError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); }
}

/** Keep the supplied century. Ten digits must never silently become twelve. */
export function normalizePersonLookupNumber(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s+-]/g, '');
}
export function personLookupNumberError(value: string): string | null {
  const inspected = inspectCustomerIdentifier(value), number = normalizePersonLookupNumber(value);
  if (inspected.kind === 'coordination') return 'Samordningsnummer fylls i manuellt tills vidare.';
  if (!/^\d{12}$/.test(number)) return 'Ange personnumret med 12 siffror, inklusive födelseår med fyra siffror, för att hämta uppgifter. Du kan också fylla i uppgifterna manuellt.';
  if (inspected.kind !== 'person') return inspected.error || 'Ange ett giltigt personnummer eller fyll i uppgifterna manuellt.';
  const birth = `${number.slice(0, 4)}-${number.slice(4, 6)}-${number.slice(6, 8)}`;
  if (birth > new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })) return 'Födelsedatumet kan inte ligga i framtiden.';
  return null;
}
export function formatPersonRegisterAddress(person: Pick<PersonRegisterPerson, 'address' | 'careOf'>): string {
  const careOf = person.careOf?.trim() ?? '';
  return [careOf && !/^c\s*\/\s*o(?:\s|:|$)/i.test(careOf) ? `c/o ${careOf}` : careOf, person.address.trim()].filter(Boolean).join(', ');
}

/** Optional assistance may fill empty fields; it never overwrites saved contacts or payment data. */
export function applyPersonLookupToCustomer<T extends { number: string; name: string; address?: string; postalCode?: string; city?: string; countryCode?: string }>(current: T, person: PersonRegisterPerson): T {
  if (normalizePersonLookupNumber(current.number) !== person.personalNumber || personLookupNumberError(current.number)) return current;
  const next = { ...current };
  if (!current.name.trim()) next.name = person.name;
  // Treat an address as one unit instead of combining two different addresses.
  if (![current.address, current.postalCode, current.city].some(value => value?.trim())) {
    next.address = formatPersonRegisterAddress(person); next.postalCode = person.postalCode; next.city = person.city;
    if ('countryCode' in current) next.countryCode = 'SE';
  }
  return next;
}

const personSchema = z.object({
  personalNumber: z.string().regex(/^\d{12}$/), name: z.string().trim().min(1).max(200),
  address: z.string().max(300), careOf: z.string().max(300).optional(), postalCode: z.string().max(20), city: z.string().max(200),
  countryCode: z.literal('SE'), source: z.literal('Roaring'), fetchedAt: z.string().refine(value => !Number.isNaN(Date.parse(value))),
});
export function parsePersonLookupResult(value: unknown, expectedNumber: string): PersonRegisterLookupResult {
  const result = value as { existing?: unknown; person?: unknown } | null;
  if (result?.existing === true && result.person === null) return { existing: true, person: null };
  const parsed = personSchema.safeParse(result?.person);
  if (result?.existing !== false || !parsed.success || parsed.data.personalNumber !== expectedNumber
    || formatPersonRegisterAddress(parsed.data).length > 300 || parsed.data.name.normalize('NFKC').trim().length > 200)
    throw new PersonLookupError('Personuppslaget gav ett ofullständigt svar. Fyll i uppgifterna manuellt.', 'person_lookup_response_invalid', 502);
  return { existing: false, person: parsed.data };
}

type PersonLookupEndpoint = '/api/person-register/lookup' | '/api/public/customer-intake/person-lookup' | '/api/terminal-demo/customer-intake/person-lookup';
/** Shared transport; each caller supplies only its own captured staff or intake capability. */
export async function requestPersonLookup(endpoint: PersonLookupEndpoint, personalNumber: string, options: {
  requestId: string; signal?: AbortSignal; headers: Readonly<Record<string, string>>; credentials: RequestCredentials; intakeId?: string;
}): Promise<PersonRegisterLookupResult> {
  const number = normalizePersonLookupNumber(personalNumber), invalid = personLookupNumberError(personalNumber);
  if (invalid) throw new PersonLookupError(invalid, number.length === 10 ? 'person_lookup_century_required' : 'person_lookup_invalid', 422);
  if (!z.string().uuid().safeParse(options.requestId).success) throw new PersonLookupError('Sökningen behöver startas om från formuläret.', 'person_lookup_invalid', 422);
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', credentials: options.credentials, cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify({ personalNumber: number, requestId: options.requestId, ...(options.intakeId ? { id: options.intakeId } : {}) }),
    });
    const value = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new PersonLookupError(typeof value?.error === 'string' ? value.error : 'Personuppgifterna kunde inte hämtas.',
      typeof value?.code === 'string' ? value.code : 'person_lookup_unavailable', response.status);
    return parsePersonLookupResult(value, number);
  } catch (error) {
    if (timedOut) throw new PersonLookupError('Personuppslaget svarade inte i tid. Fyll i uppgifterna manuellt eller försök igen.', 'person_lookup_unavailable');
    if (controller.signal.aborted || error instanceof PersonLookupError) throw error;
    throw new PersonLookupError('Personuppslaget kunde inte nås. Fyll i uppgifterna manuellt eller försök igen.', 'person_lookup_unavailable');
  } finally { globalThis.clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

export async function lookupPerson(personalNumber: string, options: { requestId: string; scope?: CompanyLookupScope; signal?: AbortSignal }): Promise<PersonRegisterLookupResult> {
  const scope = options.scope ?? companyLookupScope();
  const result = await requestPersonLookup('/api/person-register/lookup', personalNumber, { ...options, headers: scope.headers, credentials: 'include' });
  if (scope.platformKey !== companyLookupScope().platformKey)
    throw new PersonLookupError('Inloggningen eller bolaget har ändrats. Öppna formuläret igen.', 'company_selection_changed', 409);
  return result;
}

export function personLookupFailure(error: unknown): string {
  if (error instanceof PersonLookupError) {
    if (error.code === 'person_lookup_not_found') return 'Ingen träff i personregistret. Kontrollera personnumret eller fyll i uppgifterna manuellt.';
    if (error.code === 'person_lookup_already_processed') return 'Sökningen har redan behandlats. Fyll i uppgifterna manuellt; ingen ny sökning har gjorts.';
    if (error.code === 'person_lookup_manual_required') return 'Uppgifterna behöver fyllas i manuellt för det här personnumret.';
    if (error.code === 'person_lookup_not_configured') return 'Personuppslag är inte aktiverat ännu. Fyll i uppgifterna manuellt.';
    if (error.status === 429) return 'För många sökningar just nu. Vänta en stund eller fyll i uppgifterna manuellt.';
    if (error.code === 'company_selection_changed') return 'Inloggningen eller bolaget har ändrats. Öppna formuläret igen.';
    if (error.status === 401 || error.status === 403) return 'Personuppslag är inte tillgängligt med den aktuella inloggningen. Fyll i uppgifterna manuellt.';
  }
  return 'Personuppgifterna kunde inte hämtas. Fyll i uppgifterna manuellt eller försök igen.';
}
