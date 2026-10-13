import { EnvironmentError } from './environment-storage.mjs';

// Inspect both payment journals in the caller's existing repository transaction.
// No second transaction or provider call may occur between this check and the
// durable reservation. An unknown or blocked instruction still reserves a card.
export function findManagedPayment(state, cardId, { excludeDomain, excludeId } = {}) {
  for (const domain of ['swishPayments', 'bankPayments']) {
    if (domain === excludeDomain) continue;
    const job = Object.values(state[domain]?.jobs ?? {}).find(item => item.id !== excludeId
      && String(item.source?.cardId) === String(cardId)
      && !['rejected', 'failed', 'cancelled'].includes(item.status));
    if (job) return { domain, job };
  }
  return null;
}

export function assertNoCrossManagedPayment(state, cardId, excludeDomain) {
  if (findManagedPayment(state, cardId, { excludeDomain }))
    throw new EnvironmentError('Kortet har redan en reserverad eller genomförd betalning via en annan betalningsmetod. Kontrollera det befintliga försöket.', 409, 'payment_already_reserved');
}

export function assertNoManagedPaymentInState(state, cardId) {
  if (findManagedPayment(state, cardId))
    throw new EnvironmentError('Kortet har redan en reserverad eller genomförd integrationsbetalning. Den manuella utbetalningen är spärrad.', 409, 'payment_already_reserved');
}
