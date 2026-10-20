import { customerIdentifierError, normalizePersonalNumber } from '../dist-server/domain-models.mjs';

/** A registration lookup may suppress provider cost for an existing customer,
 * but this boolean never authenticates the person or exposes the customer.
 * Legacy ten-digit records are deliberately conservative; the staff matching
 * flow resolves them rather than guessing a century in the paid provider. */
export function hasExistingPersonLookupCustomer(state, personalNumber) {
  const requested = normalizePersonalNumber(personalNumber);
  if (!/^\d{12}$/.test(requested) || customerIdentifierError('Privatperson', requested)) return false;
  return (state.office?.customers ?? []).some(customer => {
    const number = normalizePersonalNumber(customer.number ?? '');
    if (!/^(?:\d{10}|\d{12})$/.test(number) || customerIdentifierError('Privatperson', number)) return false;
    return number.length === 12 ? number === requested : number === requested.slice(-10);
  });
}
