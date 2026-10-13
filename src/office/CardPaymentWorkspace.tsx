import { useEffect, useState } from 'react';
import { can, type OfficeCard, type OfficeUser } from './model';
import SwishPaymentPanel, { useCardSwishTracking } from './SwishPaymentPanel';
import BankPaymentPanel, { useCardBankTracking } from './BankPaymentPanel';
import SwishPayoutDialog from './SwishPayoutDialog';
import BankPayoutDialog from './BankPayoutDialog';

/** The frozen card decides the initial provider. An existing durable payment
 * remains in its own provider even after a recipient override; merely viewing
 * a card cannot transfer an in-flight instruction to another service. */
export default function CardPaymentWorkspace({ card, user, actualUser, onStart, onReview, open, onClose, onNotice, onChanged }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; onStart: () => void; onReview: () => void;
  open: boolean; onClose: () => void; onNotice: (value: string) => void; onChanged: () => void;
}) {
  const bank = useCardBankTracking(), swish = useCardSwishTracking();
  const [selectedProvider, setSelectedProvider] = useState<'bank' | 'swish'>();
  useEffect(() => { setSelectedProvider(undefined); }, [card.id, open]);
  const attempts = [...bank.jobs.map(job => ({ job, bank: true })), ...swish.jobs.map(job => ({ job, bank: false }))]
    .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt));
  const active = attempts.find(({ job }) => !['rejected', 'failed'].includes(job.status));
  const useBank = active?.bank ?? attempts[0]?.bank ?? card.paymentDetails?.method === 'bank';
  const permitted = can(user, 'pay') && can(actualUser, 'pay');
  const dialogBank = active?.bank ?? (selectedProvider ? selectedProvider === 'bank' : useBank);
  const methodSelector = !active ? <div className="office-payout-method-choice"><button type="button" className="office-text-button" onClick={() => setSelectedProvider(dialogBank ? 'swish' : 'bank')}>{dialogBank ? 'Byt till Swish' : 'Byt till banköverföring'}</button><small>Originalets betalningsuppgifter är låsta. Ändrade uppgifter kräver redigering och orsak före utbetalning.</small></div> : undefined;
  return <>
    {useBank ? <BankPaymentPanel card={card} user={user} actualUser={actualUser} onStart={onStart} onReview={onReview} />
      : <SwishPaymentPanel card={card} user={user} actualUser={actualUser} onStart={onStart} onReview={onReview} />}
    {open && permitted && (dialogBank
      ? <BankPayoutDialog card={card} user={user} actualUser={actualUser} open onClose={onClose} onNotice={onNotice} onChanged={onChanged} methodSelector={methodSelector} />
      : <SwishPayoutDialog card={card} user={user} actualUser={actualUser} open onClose={onClose} onNotice={onNotice} onChanged={onChanged} methodSelector={methodSelector} />)}
  </>;
}
