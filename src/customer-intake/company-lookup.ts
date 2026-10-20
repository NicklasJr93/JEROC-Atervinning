import { z } from 'zod';
import { CompanyLookupError, companyLookupNumberError, formatCompanyRegisterAddress, normalizeCompanyLookupNumber, type CompanyRegisterCompany } from '../company-register/client';
import { normalizePhoneNumber, phoneNumberError } from '../data-format';
import { tenantPublicHeaders } from '../tenant-public-context';

export type CustomerIntakeCompanyLookup = (organisationNumber: string, signal: AbortSignal) => Promise<CompanyRegisterCompany>;

const companySchema = z.object({ organisationNumber: z.string(), name: z.string().trim().min(1).max(200),
  address: z.string().max(300), careOf: z.string().max(300).optional(), postalCode: z.string().max(20), city: z.string().max(200),
  countryCode: z.literal('SE'), source: z.literal('SCB'), fetchedAt: z.string().refine(value => !Number.isNaN(Date.parse(value))),
  phone: z.string().max(80).optional(), email: z.string().max(254).optional(),
});

/** The lookup uses only the current intake capability. It never calls the
 * staff lookup endpoint or inherits an authenticated staff session on SMS. */
async function request(organisationNumber: string, signal: AbortSignal, context: { token: string } | { intakeId: string }): Promise<CompanyRegisterCompany> {
  const number = normalizeCompanyLookupNumber(organisationNumber), invalid = companyLookupNumberError(number);
  if (invalid) throw new CompanyLookupError(invalid, 'company_lookup_invalid', 422);
  const anonymous = 'token' in context;
  const controller = new AbortController(), abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
  try {
    const headers = anonymous ? { Authorization: `Bearer ${context.token}` } : await tenantPublicHeaders();
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetch(anonymous ? '/api/public/customer-intake/company-lookup' : '/api/terminal-demo/customer-intake/company-lookup', {
      method: 'POST', credentials: anonymous ? 'omit' : 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers }, signal: controller.signal,
      body: JSON.stringify({ organisationNumber: number, ...(anonymous ? {} : { id: context.intakeId }) }),
    });
    const value = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!response.ok) throw new CompanyLookupError(typeof value?.error === 'string' ? value.error : 'Företagsuppgifterna kunde inte hämtas.',
      typeof value?.code === 'string' ? value.code : 'company_lookup_unavailable', response.status);
    const parsed = companySchema.safeParse(value?.company);
    if (!parsed.success || parsed.data.organisationNumber !== number)
      throw new CompanyLookupError('Företagsregistret gav ett ofullständigt svar. Fyll i uppgifterna manuellt.', 'company_lookup_response_invalid', 502);
    const company = parsed.data;
    if (formatCompanyRegisterAddress(company).length > 300 || company.name.normalize('NFKC').trim().length > 200)
      throw new CompanyLookupError('Företagsuppgifterna behöver fyllas i manuellt för den här adressen eller företagsnamnet.', 'company_lookup_response_invalid', 502);
    const phone = company.phone ? normalizePhoneNumber(company.phone) : '';
    const email = z.string().trim().email().max(200).safeParse(company.email);
    return { ...company, phone: phone && !phoneNumberError(phone) ? phone : undefined, email: email.success ? email.data : undefined };
  } catch (error) {
    if (timedOut) throw new CompanyLookupError('Företagsregistret svarade inte i tid. Du kan fylla i uppgifterna manuellt.', 'company_lookup_unavailable');
    if (signal.aborted || error instanceof CompanyLookupError) throw error;
    throw new CompanyLookupError('Företagsregistret kunde inte nås. Du kan fylla i uppgifterna manuellt.', 'company_lookup_unavailable');
  } finally { window.clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

export const lookupPublicIntakeCompany = (token: string, organisationNumber: string, signal: AbortSignal) => request(organisationNumber, signal, { token });
export const lookupTerminalIntakeCompany = (intakeId: string, organisationNumber: string, signal: AbortSignal) => request(organisationNumber, signal, { intakeId });
