import { useEffect, useId, useRef, useState } from 'react';
import { BadgeCheck, Check, ChevronDown, ClipboardCheck, ShieldCheck } from 'lucide-react';
import type { SpirisAttestAction } from './booking-client';
import './office-payment-workflow.css';
import { money } from '../model';
import { amount, can, type OfficeCard, type OfficeUser } from './model';
import type { TerminalApproval } from './terminal-demo-types';
import ElectricFocusBorder from './ElectricFocusBorder';

type Props = {
  card: OfficeCard;
  user: OfficeUser;
  actualUser: OfficeUser;
  users: OfficeUser[];
  approval?: TerminalApproval;
  busy: boolean;
  guidance?: 'focus' | 'muted';
  blocked: boolean;
  receiptStatus?: 'checking' | 'required' | 'confirmed' | 'not-required';
  onAttest: (action: SpirisAttestAction) => Promise<void>;
  onReturn: () => Promise<void>;
};

export default function OfficeCardAttest({ card, user, actualUser, users, approval, busy, blocked, guidance, receiptStatus, onAttest, onReturn }: Props) {
  const [action, setAction] = useState<SpirisAttestAction>('draft'), [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null), menuId = useId();
  const canBook = can(user, 'bookSpiris') && can(actualUser, 'bookSpiris');
  useEffect(() => { setAction('draft'); setMenuOpen(false); }, [card.id, user.id, actualUser.id]);
  useEffect(() => { if (!canBook) { setAction('draft'); setMenuOpen(false); } }, [canBook]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !splitRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenuOpen(false); splitRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  const finished = ['ready', 'paid', 'balance'].includes(card.status);
  const approved = card.customerApproval
    ? (approval ? approval.id === card.customerApproval.id && approval.status === 'approved' : card.customerApproval.status === 'approved')
    : card.status === 'attest'; // Previously prepared demo cards retain their existing attest flow.
  const ownBlocked = !user.ownAttest && (card.preparedBy === user.id || Boolean(approval && approval.actualUserId === actualUser.id));
  const overLimit = !card.financialPending && amount(card) > user.maxAttest;
  const permitted = can(user, 'attest') && can(actualUser, 'attest');
  const receiptPending = receiptStatus === 'required' || receiptStatus === 'checking';
  const ready = card.status === 'attest' && approved && !receiptPending && !card.financialPending;
  const reason = finished
    ? `Attesterat av ${approval?.attestedBy ?? users.find(person => person.id === card.approvedBy)?.name ?? card.approvedBy ?? 'JEROC'}.`
    : !approved ? 'Kunden behöver godkänna den aktuella avräkningen innan intern attest.'
    : receiptStatus === 'checking' ? 'Mottagningsuppgifterna kontrolleras före attest.'
    : receiptStatus === 'required' ? 'Bekräfta mottagningen av farligt avfall innan intern attest.'
    : card.financialPending ? 'Prisunderlaget måste läsas in före attest.'
    : !permitted ? 'Kortet väntar på en användare med attestbehörighet.'
    : overLimit ? 'Beloppet överstiger din attestgräns. En användare med högre gräns behöver attestera.'
    : ownBlocked ? 'Du får inte attestera ett kort du själv förberett.'
    : 'Kundgodkännandet är klart. Granska underlaget och attestera här.';

  return <section className={`office-panel office-card-attest${finished ? ' is-attested' : ''}${guidance ? ` office-guidance-${guidance}` : ''}`} aria-labelledby="office-card-attest-title">
    <ElectricFocusBorder active={guidance === 'focus'} />
    <div className="office-attest-info"><ShieldCheck size={28} aria-hidden="true" /><div><h2 id="office-card-attest-title">Attest</h2><p>{reason}</p></div></div>
    {permitted && !finished && <div className="office-attest-limit"><BadgeCheck size={20} aria-hidden="true" /><div><small>Din attestgräns</small><strong>{money(user.maxAttest)} kr</strong></div></div>}
    <span className={`office-attest-status${ready && permitted && !overLimit && !ownBlocked ? ' ready' : ''}`}><ClipboardCheck size={16} aria-hidden="true" />{finished ? 'JEROC-attesterad' : !approved ? 'Inväntar kundgodkännande' : receiptPending ? 'Inväntar mottagning' : ready && (overLimit || ownBlocked) ? 'Attest spärrad' : ready ? 'Redo för attest' : 'Inväntar prisunderlag'}</span>
    {permitted && !finished && <div className="office-attest-action">
      {card.status === 'attest' && (!card.customerApproval || can(user, 'prepare')) && <button className="office-link" disabled={busy || blocked} onClick={() => void onReturn()}>Returnera för komplettering</button>}
      <div className="office-attest-split" ref={splitRef}>
        <button className="office-btn office-attest-primary" disabled={busy || blocked || !ready || overLimit || ownBlocked} onClick={() => { setMenuOpen(false); void onAttest(action); }}><Check size={18} />{busy ? 'Attesterar…' : action === 'book' ? 'Attestera & bokför' : 'Attestera · skapa utkast'}</button>
        {canBook && <button type="button" className="office-btn office-attest-dropdown" aria-label="Välj atteståtgärd" aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} disabled={busy || blocked || !ready || overLimit || ownBlocked} onClick={() => setMenuOpen(open => !open)}><ChevronDown size={17} /></button>}
        {menuOpen && canBook && <div id={menuId} className="office-attest-menu" role="menu" aria-label="Atteståtgärd">
          <button type="button" role="menuitemradio" aria-checked={action === 'draft'} onClick={() => { setAction('draft'); setMenuOpen(false); }}><span>Attestera · skapa utkast<small>Granska och bokför sedan i Spiris.</small></span>{action === 'draft' && <Check size={16} />}</button>
          <button type="button" role="menuitemradio" aria-checked={action === 'book'} onClick={() => { setAction('book'); setMenuOpen(false); }}><span>Attestera & bokför<small>Bokför underlaget i Spiris i bakgrunden.</small></span>{action === 'book' && <Check size={16} />}</button>
        </div>}
      </div>
    </div>}
  </section>;
}
