import { z } from 'zod';
import { PersonRegisterError, normalizePersonLookupNumber } from './roaring-person-register.mjs';

const inputSchema = z.object({ personalNumber: z.string().max(40), requestId: z.string().uuid() }).strict();
const SERVICE = 'roaring.person.lookup';
class ExistingCustomer extends Error { constructor() { super('Existing customer'); this.status = 409; } }
const processed = () => new PersonRegisterError('Uppslaget har redan behandlats. Fyll i uppgifterna manuellt eller be personalen kontrollera det tidigare försöket.', 409, 'person_lookup_already_processed', 'rejected');

function createLookupBudget(now) {
  const companies = new Map(), callers = new Map(); let global = [];
  return (companyId, callerKey) => {
    const at = new Date(now()).getTime();
    for (const map of [companies, callers]) for (const [key, times] of map) {
      const recent = times.filter(time => time > at - 60_000);
      if (recent.length) map.set(key, recent); else map.delete(key);
    }
    global = global.filter(time => time > at - 1000);
    const company = companies.get(companyId) ?? [], caller = callers.get(callerKey) ?? [];
    if (company.length >= 30 || caller.length >= 10 || global.length >= 4
      || callers.size >= 10_000 && !callers.has(callerKey))
      throw new PersonRegisterError('För många personuppslag just nu. Fyll i uppgifterna manuellt eller försök igen senare.', 429, 'person_lookup_rate_limited', 'rejected');
    companies.set(companyId, [...company, at]); callers.set(callerKey, [...caller, at]); global.push(at);
  };
}

/** An intake/office route supplies ONLY its server-resolved company and fresh
 * authorization closure. Platform usage stores the HMAC and attempt metadata,
 * never this person's identifier, name, address, raw response or error text. */
export function createPersonLookup({ register, usage, findExisting, now = () => new Date() } = {}) {
  if (typeof register?.lookup !== 'function' || typeof usage?.execute !== 'function'
    || typeof usage?.fingerprint !== 'function' || typeof findExisting !== 'function')
    throw new TypeError('Person lookup requires a register, durable usage ledger and company-scoped existing-customer check.');
  // One instance is shared by all five entry points. This application budget
  // supplements the durable exactly-once claim; it is not a Roaring tariff or
  // vendor-rate guarantee and deliberately caps paid-query bursts.
  const consume = createLookupBudget(now);
  return async (input, { organisationId, channel = 'customer_registration', actorId, rateKey, signal, revalidate } = {}) => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new PersonRegisterError('Ange personnummer och ett giltigt uppslags-ID.', 422, 'person_lookup_invalid', 'rejected');
    const personalNumber = normalizePersonLookupNumber(parsed.data.personalNumber, now());
    if (typeof organisationId !== 'string' || !organisationId || organisationId.length > 100)
      throw new PersonRegisterError('Välj rätt bolag innan du gör personuppslaget.', 403, 'person_lookup_forbidden', 'rejected');
    const context = { organisationId, personalNumber };
    await revalidate?.();
    if (await findExisting(context)) return { existing: true, person: null };
    if (register.configured === false)
      throw new PersonRegisterError('Personuppslaget är inte aktiverat. Fyll i uppgifterna manuellt.', 503, 'person_lookup_not_configured', 'rejected');
    const fingerprint = await usage.fingerprint({ organisationId, service: SERVICE, value: personalNumber });
    let failure;
    const execution = await usage.execute({ organisationId, operationId: parsed.data.requestId,
      service: SERVICE, channel, ...(actorId ? { actorId } : {}), fingerprint }, async ({ beforeDispatch }) => {
      try {
        const person = await register.lookup(personalNumber, { signal, beforeDispatch: async () => {
          // OAuth may take time. Recheck access and a newly created customer
          // before the metering claim and before exposing a billable GET.
          await revalidate?.();
          if (await findExisting(context)) throw new ExistingCustomer();
          signal?.throwIfAborted();
          consume(organisationId, JSON.stringify([organisationId, rateKey ?? actorId ?? 'registration']));
          await beforeDispatch();
        } });
        return { status: 'success', result: { existing: false, person } };
      } catch (error) {
        if (error instanceof ExistingCustomer) return { status: 'rejected', result: { existing: true, person: null } };
        failure = error;
        if (error instanceof PersonRegisterError)
          return { status: error.outcome, ...(error.billableConfirmed ? { billableConfirmed: true } : {}) };
        // Authorization and ledger errors before dispatch cannot be charged.
        // execute() independently knows whether beforeDispatch actually ran.
        return { status: Number.isInteger(error?.status) && error.status < 500 ? 'rejected' : 'unknown' };
      }
    });
    if (execution.replayed) throw processed();
    if (execution.result) return execution.result;
    if (failure instanceof PersonRegisterError || Number.isInteger(failure?.status) && failure.status >= 400 && failure.status < 500) throw failure;
    throw new PersonRegisterError('Personuppslaget kunde inte genomföras. Fyll i uppgifterna manuellt.', 503, 'person_lookup_unavailable', 'unknown');
  };
}
