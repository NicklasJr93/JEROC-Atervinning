import { z } from 'zod';
import { customerIdentifierError, normalizeOrganisationNumber } from '../dist-server/domain-models.mjs';
import { ScbCompanyRegisterError } from './scb-company-register.mjs';

const invalid = () => new ScbCompanyRegisterError('Ange ett giltigt organisationsnummer med tio siffror. Personnummer och enskild firma omfattas inte av företagsuppslaget.', 422, 'company_lookup_invalid');
const unavailable = () => new ScbCompanyRegisterError('Företagsuppslaget kunde inte genomföras. Fyll i uppgifterna manuellt eller försök igen senare.', 503, 'company_lookup_unavailable');
const inputSchema = z.object({ organisationNumber: z.string().max(40) }).strict();
// Intakes receive public company contact data only, never customer matches,
// financial settings, tax flags, internal registration fields or provider data.
const companySchema = z.object({
  organisationNumber: z.string().regex(/^\d{10}$/), name: z.string().trim().min(1).max(200),
  address: z.string().max(512), postalCode: z.string().max(5), city: z.string().max(200),
  careOf: z.string().max(256).optional(), phone: z.string().max(64).optional(), email: z.string().email().max(254).optional(),
  countryCode: z.literal('SE'), source: z.literal('SCB'), fetchedAt: z.string().datetime({ offset: true }),
});

/** Provider access has no repository/tenant-selection API. Routes must prove a
 * current intake before and after awaiting this function, outside DB locks. */
export function createCustomerIntakeCompanyLookup({ register, limiter } = {}) {
  if (typeof register?.lookup !== 'function' || typeof limiter?.consume !== 'function')
    throw new TypeError('A company register and its shared request limiter are required.');
  return async (input, { rateKey, signal } = {}) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const number = normalizeOrganisationNumber(parsed.data.organisationNumber);
    if (customerIdentifierError('BRF', number)) throw invalid();
    if (typeof rateKey !== 'string' || !rateKey || rateKey.length > 500) throw unavailable();
    limiter.consume(rateKey);
    try {
      const company = companySchema.safeParse(await register.lookup(number, { signal }));
      if (!company.success || company.data.organisationNumber !== number)
        throw new ScbCompanyRegisterError('Företagsregistret gav ett oväntat svar. Fyll i uppgifterna manuellt eller försök igen senare.', 502, 'company_lookup_response_invalid');
      return company.data;
    } catch (error) {
      if (error instanceof ScbCompanyRegisterError) throw error;
      throw unavailable();
    }
  };
}
