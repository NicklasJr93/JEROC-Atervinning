import { can, type OfficeCard, type OfficeUser } from './model';

export type WorkflowSection = 'weighings' | 'customer-approvals' | 'attest' | 'payments';
export const workflowSections = ['weighings', 'customer-approvals', 'attest', 'payments'];
export function safeAuditText(user: OfficeUser, text: string) {
  if (
    text.startsWith('Pris för') &&
    !(
      ['priceA', 'priceB', 'priceC', 'customerPrices', 'changePrice'] as const
    ).every((right) => can(user, right))
  )
    return 'Materialets pris ändrat. Detaljer kräver prisbehörighet.';
  // Full recipient details remain in the locked journal, not in the general feed.
  if (text.startsWith('Demoutbetalning'))
    return 'Demoutbetalning registrerad. Se betalningsjournal och kvitto.';
  if (
    text.startsWith('Rättelsen attesterad:') &&
    !can(user, 'reports') &&
    !can(user, 'attest') &&
    !can(user, 'pay')
  )
    return 'Rättelsen attesterad. Originalkortet bevarat.';
  return text;
}
export function inQueue(card: OfficeCard, section: string, history: boolean) {
  if (section === 'customer-approvals') return Boolean(card.customerApproval) && (history
    ? ['approved', 'attested', 'cancelled'].includes(card.customerApproval!.status)
    : ['waiting', 'id_requested', 'change_requested', 'expired'].includes(card.customerApproval!.status));
  if (section === 'weighings')
    return history || ['new', 'complement'].includes(card.status);
  if (section === 'attest')
    return history
      ? ['ready', 'paid', 'balance'].includes(card.status) ||
          (card.status === 'complement' && Boolean(card.preparedBy))
      : card.status === 'attest';
  return history
    ? ['paid', 'balance'].includes(card.status)
    : card.status === 'ready';
}
export function cardRoute(card: OfficeCard, user: OfficeUser) {
  if (card.status === 'customer' && can(user, 'customerApprovalRead')) return `/customer-approvals/${card.id}`;
  if (card.status === 'attest' && can(user, 'attest'))
    return `/attest/${card.id}`;
  if (['ready', 'paid', 'balance'].includes(card.status) && can(user, 'pay'))
    return `/payments/${card.id}${card.status === 'ready' ? '' : '?tab=history'}`;
  return `/weighings/${card.id}${['new', 'complement'].includes(card.status) ? '' : '?tab=history'}`;
}
