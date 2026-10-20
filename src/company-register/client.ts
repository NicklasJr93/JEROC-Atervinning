import { z } from 'zod';
import { customerIdentifierError, normalizeOrganisationNumber, normalizePhoneNumber, phoneNumberError } from '../data-format';
import { currentPlatformSession, platformRequestHeaders } from '../platform/session';

export interface CompanyRegisterCompany {
  organisationNumber: string;
  name: string;
  address: string;
  careOf?: string;
  postalCode: string;
  city: string;
  countryCode: 'SE';
  source: 'SCB';
  fetchedAt: string;
  vatRegistered?: boolean;
  fTaxRegistered?: boolean;
  phone?: string;
  email?: string;
}

const contactEmailSchema = z.string().trim().email().max(254);
function companyContactPhone(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return undefined;
  const normalized = normalizePhoneNumber(value);
  return normalized && !phoneNumberError(normalized) ? normalized : undefined;
}

/** SCB uses 16 + the ten-digit organisation number; editable customer data uses ten digits. */
export function normalizeCompanyLookupNumber(value: string): string {
  const compact = normalizeOrganisationNumber(value);
  return /^16\d{10}$/.test(compact) ? compact.slice(2) : compact;
}

/** The customer model has one postal address line. Keep SCB's optional c/o
 * recipient together with its street/box line instead of dropping it.
 */
export function formatCompanyRegisterAddress(company: Pick<CompanyRegisterCompany, 'address' | 'careOf'>): string {
  const careOf = company.careOf?.trim() ?? '';
  const recipient = careOf && !/^c\s*\/\s*o(?:\s|:|$)/i.test(careOf) ? `c/o ${careOf}` : careOf;
  return [recipient, company.address.trim()].filter(Boolean).join(', ');
}

/** A sole trader's personal number must never be sent to the company-only endpoint. */
export function companyLookupNumberError(value: string): string | null {
  const number = normalizeCompanyLookupNumber(value);
  if (!/^\d{10}$/.test(number)) return 'Ange ett organisationsnummer med 10 siffror, med eller utan bindestreck.';
  if (Number(number[2]) < 2) return 'Personnummer söks inte i företagsregistret. Fyll i uppgifterna manuellt.';
  return customerIdentifierError('Företag', number);
}

const platformIdentity = () => {
  const session = currentPlatformSession();
  return JSON.stringify(session?.authenticated
    ? [session.actor.id, session.organisationId, session.effectiveUserId, session.generation]
    : 'no-platform-session');
};

export interface CompanyLookupScope {
  key: string;
  platformKey: string;
  headers: Readonly<Record<string, string>>;
}

/** Capture the initiating principal; a later tenant switch cannot redirect an existing request. */
export function companyLookupScope(requestHeaders: Readonly<Record<string, string>> = {}): CompanyLookupScope {
  const platformKey = platformIdentity();
  const headers = Object.freeze({ ...platformRequestHeaders(), ...requestHeaders });
  const identity = Object.entries(headers).sort(([first], [second]) => first.localeCompare(second));
  return { key: JSON.stringify([platformKey, identity]), platformKey, headers };
}

export class CompanyLookupError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); }
}

function parseCompany(value: unknown, expectedNumber: string): CompanyRegisterCompany {
  const company = value as Partial<CompanyRegisterCompany> | null;
  if (!company || typeof company !== 'object' || company.organisationNumber !== expectedNumber
    || typeof company.name !== 'string' || !company.name.trim()
    || !['address', 'postalCode', 'city'].every(field => typeof company[field as keyof CompanyRegisterCompany] === 'string')
    || company.countryCode !== 'SE' || company.source !== 'SCB'
    || typeof company.fetchedAt !== 'string' || Number.isNaN(Date.parse(company.fetchedAt)))
    throw new CompanyLookupError('Företagsregistret gav ett ofullständigt svar. Fyll i uppgifterna manuellt eller försök igen.', 'company_lookup_response_invalid', 502);
  const phone = companyContactPhone(company.phone), email = contactEmailSchema.safeParse(company.email);
  return {
    organisationNumber: expectedNumber, name: company.name,
    address: company.address!, postalCode: company.postalCode!, city: company.city!,
    countryCode: 'SE', source: 'SCB', fetchedAt: company.fetchedAt,
    ...(typeof company.careOf === 'string' && company.careOf.trim() ? { careOf: company.careOf.trim() } : {}),
    ...(typeof company.vatRegistered === 'boolean' ? { vatRegistered: company.vatRegistered } : {}),
    ...(typeof company.fTaxRegistered === 'boolean' ? { fTaxRegistered: company.fTaxRegistered } : {}),
    ...(phone === undefined ? {} : { phone }),
    ...(email.success ? { email: email.data } : {}),
  };
}

export async function lookupCompany(organisationNumber: string, options: { scope?: CompanyLookupScope; signal?: AbortSignal } = {}): Promise<CompanyRegisterCompany> {
  const number = normalizeCompanyLookupNumber(organisationNumber), validationError = companyLookupNumberError(number);
  if (validationError) throw new CompanyLookupError(validationError, 'company_lookup_invalid', 422);
  const scope = options.scope ?? companyLookupScope();
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const response = await fetch('/api/company-register/lookup', {
      method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...scope.headers },
      body: JSON.stringify({ organisationNumber: number }),
    });
    const result = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (scope.platformKey !== platformIdentity())
      throw new CompanyLookupError('Inloggningen eller bolaget har ändrats. Sök igen i den aktuella vyn.', 'company_selection_changed', 409);
    if (!response.ok) {
      const code = typeof result?.code === 'string' ? result.code : response.status === 404 ? 'company_lookup_not_found' : 'company_lookup_unavailable';
      const message = typeof result?.error === 'string' ? result.error : typeof result?.message === 'string' ? result.message : 'Företagsuppgifterna kunde inte hämtas.';
      throw new CompanyLookupError(message, code, response.status);
    }
    return parseCompany(result?.company, number);
  } catch (error) {
    if (timedOut) throw new CompanyLookupError('Företagsregistret svarade inte i tid. Du kan fylla i uppgifterna manuellt eller söka igen.', 'company_lookup_unavailable');
    if (controller.signal.aborted || error instanceof CompanyLookupError) throw error;
    throw new CompanyLookupError('Företagsregistret kunde inte nås. Du kan fylla i uppgifterna manuellt eller söka igen.', 'company_lookup_unavailable');
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
