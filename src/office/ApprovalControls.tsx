import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CheckCircle2, Clock3, FileText, Mail, MessageSquare, Monitor, Send, ShieldCheck, Users, X } from 'lucide-react';
import { normalizePhoneNumber, phoneNumberError } from '../data-format';
import { terminalDemoApi, type TerminalStaffIdentity } from './terminal-demo-client';
import ElectricFocusBorder from './ElectricFocusBorder';
import { approvalLabels, type ApprovalChannel, type ApprovalTarget, type TerminalApproval, type TerminalDemoState } from './terminal-demo-types';
import './terminals.css';

export type ApprovalControlsProps = {
  approval?: TerminalApproval; state?: TerminalDemoState; siteId: string; terminalId: string; cardId?: number;
  customerEmail?: string; customerPhone?: string;
  canSend: boolean; canConfirmId: boolean; canCancel: boolean; canSeeMoney?: boolean;
  guidance?: 'focus' | 'muted'; disabledReason?: string; onPreview?: () => void;
  onSend: (target: ApprovalTarget) => Promise<void | boolean>;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
  onConfirmed?: (approval: TerminalApproval) => void; onBeforeAction?: () => Promise<void>;
  principal?: TerminalStaffIdentity;
};
const channelLabel = (channel: ApprovalChannel) => channel === 'email' ? 'e-post' : channel === 'sms' ? 'SMS' : 'kundterminal';
const deliveryText = (status?: TerminalApproval['delivery']) => status?.status === 'sent' ? 'Utskicket är bekräftat av mejl- eller SMS-tjänsten.'
  : status?.status === 'failed' ? 'Utskicket nekades. Ingen leverans har bekräftats. Avsluta kundgodkännandet innan du skickar en ny länk.'
    : status?.status === 'unknown' ? 'Utskickets resultat är okänt. Kontrollera status innan ett nytt utskick skapas.'
      : 'Utskicket väntar på bekräftelse.';

export default function ApprovalControls({ approval, state, siteId, terminalId, cardId, customerEmail, customerPhone,
  canSend, canConfirmId, canCancel, canSeeMoney = true, guidance, disabledReason, onPreview, onSend, onRefresh,
  onConfirmed, onBeforeAction, onNotice, principal }: ApprovalControlsProps) {
  const scopeKey = `${cardId ?? ''}/${principal?.actualUserId ?? ''}/${principal?.effectiveUserId ?? ''}`;
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const approvalIdentity = `${approval?.id ?? ''}/${approval?.version ?? ''}`;
  const approvalRef = useRef(approvalIdentity); approvalRef.current = approvalIdentity;
  const alive = useRef(true), pending = useRef(false);
  const [panel, setPanel] = useState(false), [channel, setChannel] = useState<ApprovalChannel>('terminal');
  const [selectedTerminal, setSelectedTerminal] = useState(''), [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<'id' | 'cancel'>(), [idChecked, setIdChecked] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { pending.current = false; setPanel(false); setConfirmAction(undefined); setIdChecked(false); setError(''); setBusy(false); }, [scopeKey]);
  useEffect(() => { setPanel(false); setConfirmAction(undefined); setIdChecked(false); setError(''); }, [approval?.id]);
  useEffect(() => { if (approval?.status !== 'id_requested') { setConfirmAction(undefined); setIdChecked(false); } }, [approval?.status]);
  const terminals = state?.terminals.filter(terminal => terminal.active && terminal.siteId === siteId) ?? [];
  const availableTerminals = terminals.filter(terminal => terminal.online && !terminal.busy);
  const terminalUnavailableReason = !state ? 'Terminaltjänsten behöver vara ansluten.'
    : !terminals.length ? 'Ingen aktiv terminal finns på den här anläggningen.'
      : !availableTerminals.length ? 'En terminal behöver vara online och ledig.' : '';
  const baseDisabledReason = !canSend ? disabledReason || 'Komplettera kund, ursprungsadress, betalningsuppgifter och priser först.' : '';
  const sendDisabledReason = baseDisabledReason || (channel === 'terminal' ? terminalUnavailableReason : '');
  const open = (nextChannel: ApprovalChannel) => {
    if (!canSend || pending.current || nextChannel === 'terminal' && terminalUnavailableReason) return;
    setChannel(nextChannel);
    setSelectedTerminal(availableTerminals.some(terminal => terminal.id === terminalId) ? terminalId : availableTerminals.length === 1 ? availableTerminals[0].id : '');
    setRecipient(nextChannel === 'email' ? customerEmail?.trim() ?? '' : nextChannel === 'sms' ? customerPhone?.trim() ?? '' : '');
    setError(''); setPanel(true);
  };
  async function send() {
    if (!canSend || pending.current) return;
    if (channel === 'terminal' && !availableTerminals.some(terminal => terminal.id === selectedTerminal)) return;
    const address = recipient.trim();
    if (channel === 'email' && !z.string().email().max(254).safeParse(address).success) { setError('Ange en giltig e-postadress.'); return; }
    if (channel === 'sms' && phoneNumberError(address, { required: true })) { setError('Ange ett giltigt mobilnummer med landskod, exempelvis +46701234567.'); return; }
    pending.current = true; setBusy(true); setError('');
    const actionScope = scopeKey, current = () => alive.current && scopeRef.current === actionScope;
    try {
      const result = await onSend({ channel, siteId, ...(channel === 'terminal' ? { terminalId: selectedTerminal }
        : { recipient: channel === 'sms' ? normalizePhoneNumber(address) : address }) });
      if (!current()) return;
      if (result === false) setError('Kundgodkännandet kunde inte startas. Kontrollera underlaget och försök igen.');
      else setPanel(false);
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Kundgodkännandet kunde inte startas.'); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }
  async function act() {
    if (!approval || !confirmAction || pending.current || confirmAction === 'id' && !idChecked) return;
    pending.current = true; setBusy(true); setError('');
    const actionScope = scopeKey, actionApproval = approvalIdentity, action = confirmAction;
    const current = () => alive.current && scopeRef.current === actionScope && approvalRef.current === actionApproval;
    try {
      await onBeforeAction?.(); if (!current()) return;
      const confirmed = action === 'id' ? await terminalDemoApi.confirmId(approval.id, principal) : await terminalDemoApi.cancel(approval.id, principal);
      if (!current()) return;
      onConfirmed?.(confirmed); setConfirmAction(undefined); setIdChecked(false);
      if (!onConfirmed) void onRefresh();
      onNotice(action === 'id' ? 'Legitimationen är kontrollerad och kundgodkännandet registrerat. Kortet går vidare till intern attest.' : 'Kundgodkännandet har avslutats.');
    } catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'Åtgärden kunde inte utföras.'); }
    finally { if (alive.current && scopeRef.current === actionScope) { pending.current = false; setBusy(false); } }
  }
  const active = approval && ['waiting', 'id_requested'].includes(approval.status);
  const approved = approval?.status === 'approved' || approval?.status === 'attested';
  const approvalChannel = approval?.channel ?? 'terminal', remote = approvalChannel !== 'terminal';
  const targetName = remote ? `${channelLabel(approvalChannel)}${approval?.recipient ? ` · ${approval.recipient}` : ''}`
    : state?.terminals.find(terminal => terminal.id === approval?.terminalId)?.name ?? 'Kundterminal';
  const approvedTime = approval?.approvedAt ? new Date(approval.approvedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const description = approval?.status === 'waiting' ? remote ? 'Länken gäller den aktuella avräkningen. Legitimationen kontrolleras på plats.'
    : approval.displayedAt ? 'Kunden granskar avräkningen före intern attest.' : 'Avräkningen är skickad. Inväntar kundterminalens bekräftelse.'
      : approval?.status === 'id_requested' ? 'Kunden vill godkänna. Kontrollera legitimationen på plats innan godkännandet bekräftas.'
        : approval?.status === 'change_requested' ? 'Komplettera kortet och skicka en ny version till kunden.'
          : approved ? `Granskningsversion ${approval.version} · ${targetName}` : 'Låt kunden granska avräkningen innan den går vidare till intern attest.';
  return <section className={`office-panel approval-controls${approved ? ' approval-controls-approved' : ''}${guidance ? ` office-guidance-${guidance}` : ''}`}>
    <ElectricFocusBorder active={guidance === 'focus'} />
    <div className="approval-controls-heading">
      <span className={`approval-heading-icon${approved ? ' approved' : ''}`}>{approved ? <CheckCircle2 size={25} /> : <Users size={24} />}</span>
      <div className="approval-heading-copy"><h2>Kundgodkännande</h2><p>{description}</p>{approved && approval.approvedBy && <p className="approval-approved-line">Fysisk legitimation bekräftad av {approval.approvedBy}{approvedTime && ` · ${approvedTime}`}</p>}</div>
      <span className={`approval-status ${approval ? `approval-${approved ? 'approved' : approval.status}` : 'approval-not-sent'}`}>{approved && <CheckCircle2 size={13} />}{approval ? approved ? 'Godkänd av kund' : approvalLabels[approval.status] : 'Ej skickad'}</span>
      {approved && onPreview && <button type="button" className="office-btn outline approval-preview" onClick={onPreview}><FileText size={16} />Granska avräkning</button>}
    </div>
    {approval && !approved && <div className="approval-version-facts"><span>Avräkning · version {approval.version}</span>{canSeeMoney && <strong>{approval.snapshot.net.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong>}<small>{targetName} · skickad av {approval.sentBy}</small>{onPreview && <button type="button" className="office-link" onClick={onPreview}><FileText size={14} />Granska avräkning</button>}</div>}
    {approval?.status === 'waiting' && <p className="approval-info-line" role="status"><Clock3 size={15} />{remote ? deliveryText(approval.delivery)
      : approval.displayedAt ? `Kundvisningen är aktiv på ${targetName}.` : `Skickad till ${targetName}. Inväntar terminalens bekräftelse.`}</p>}
    {approval?.status === 'change_requested' && <div className="approval-change-request"><strong><MessageSquare size={15} />Kunden begär ändring</strong><p>{approval.comment}</p><small>En ny version behöver granskas och godkännas innan intern attest.</small></div>}
    {!active && !approved && <div className="approval-channel-tiles">
      <button type="button" className="approval-channel-tile" disabled={!!baseDisabledReason || !!terminalUnavailableReason || busy} onClick={() => open('terminal')} title={baseDisabledReason || terminalUnavailableReason || 'Välj en ledig kundterminal'} aria-label={approval ? 'Visa ny version på kundterminal' : 'Visa på kundterminal'}><Monitor size={24} /><span><strong>{approval ? 'Visa ny version på kundterminal' : 'Visa på kundterminal'}</strong><small>{baseDisabledReason || terminalUnavailableReason || 'Välj terminal och visa avräkningen för kunden'}</small></span></button>
      <button type="button" className="approval-channel-tile" disabled={!!baseDisabledReason || busy} onClick={() => open('sms')} aria-label="Skicka via SMS" title={baseDisabledReason || 'Skicka en personlig länk till kunden'}><MessageSquare size={24} /><span><strong>Skicka via SMS</strong><small>{baseDisabledReason || 'Kunden öppnar avräkningen på sin mobil'}</small></span></button>
      <button type="button" className="approval-channel-tile" disabled={!!baseDisabledReason || busy} onClick={() => open('email')} aria-label="Skicka via e-post" title={baseDisabledReason || 'Skicka en personlig länk till kunden'}><Mail size={24} /><span><strong>Skicka via e-post</strong><small>{baseDisabledReason || 'Skicka avräkningen till kundens e-postadress'}</small></span></button>
    </div>}
    <div className="approval-controls-actions">{approval?.status === 'id_requested' && canConfirmId && <button type="button" className="office-btn" disabled={busy} onClick={() => { setConfirmAction('id'); setIdChecked(false); setError(''); }}><ShieldCheck size={15} />Bekräfta legitimation & godkännande</button>}{active && canCancel && <button type="button" className="office-btn outline" disabled={busy} onClick={() => { setConfirmAction('cancel'); setIdChecked(false); setError(''); }}><X size={14} />{remote ? 'Avsluta kundgodkännande' : 'Avsluta kundvisning'}</button>}</div>
    {error && !panel && !confirmAction && <div className="terminal-error" role="alert">{error}</div>}
    {panel && <div className="terminal-modal-backdrop"><div className="terminal-dialog approval-send-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-send-title">
      <div className="terminal-dialog-heading"><h2 id="approval-send-title">{channel === 'terminal' ? 'Visa avräkning för kunden' : `Skicka kundgodkännande via ${channelLabel(channel)}`}</h2><button type="button" className="terminal-icon-button" aria-label="Stäng kundvisning" disabled={busy} onClick={() => setPanel(false)}><X size={18} /></button></div>
      <p>{channel === 'terminal' ? 'Terminalen visar den låsta version som kunden ska granska och godkänna.' : 'Kunden får en personlig länk till den låsta avräkningen. Legitimationen kontrolleras av kontoret på plats.'}</p>
      {channel === 'terminal' ? <label>Kundterminal<select aria-label="Terminal för kundgodkännande" value={selectedTerminal} disabled={busy} onChange={event => setSelectedTerminal(event.target.value)}><option value="">Välj en ledig terminal</option>{terminals.map(terminal => <option key={terminal.id} value={terminal.id} disabled={!terminal.online || terminal.busy}>{terminal.name} · {terminal.busy ? 'Upptagen' : terminal.online ? 'Ledig' : 'Offline'}</option>)}</select></label>
        : <label>{channel === 'email' ? 'Mottagarens e-postadress' : 'Mobilnummer'}<input aria-label={channel === 'email' ? 'Mottagarens e-postadress' : 'Mobilnummer'} type={channel === 'email' ? 'email' : 'tel'} autoComplete={channel === 'email' ? 'email' : 'tel'} maxLength={channel === 'email' ? 254 : 40} value={recipient} disabled={busy} onChange={event => { setRecipient(event.target.value); setError(''); }} /></label>}
      {sendDisabledReason && <p className="approval-requirements">{sendDisabledReason}</p>}{error && <div className="terminal-error" role="alert">{error}</div>}
      <div className="terminal-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setPanel(false)}>Avbryt</button><button type="button" className="office-btn" disabled={!canSend || busy || (channel === 'terminal' ? !availableTerminals.some(terminal => terminal.id === selectedTerminal) : !recipient.trim())} onClick={() => void send()}><Send size={14} />{busy ? channel === 'terminal' ? 'Visar…' : 'Skickar…' : channel === 'terminal' ? 'Visa på terminal' : `Skicka via ${channelLabel(channel)}`}</button></div>
    </div></div>}
    {confirmAction && <div className="terminal-modal-backdrop"><div className="terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-confirm-title"><h2 id="approval-confirm-title">{confirmAction === 'id' ? 'Bekräfta kundens godkännande' : 'Avsluta kundgodkännandet?'}</h2><p>{confirmAction === 'id' ? 'Kontrollera kundens fysiska legitimation och att kunden godkänner den aktuella avräkningen. Kontrollen sparas med ditt namn och denna version.' : 'Kundvisningen eller länken slutar att gälla. Kortet kan kompletteras och skickas till kunden igen.'}</p>
      {confirmAction === 'id' && <label className="office-checkbox"><input type="checkbox" checked={idChecked} disabled={busy} onChange={event => setIdChecked(event.target.checked)} />Jag har kontrollerat kundens legitimation på plats</label>}
      {error && <div className="terminal-error" role="alert">{error}</div>}<div className="terminal-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setConfirmAction(undefined)}>Avbryt</button><button type="button" className="office-btn" disabled={busy || confirmAction === 'id' && !idChecked} onClick={() => void act()}>{busy ? 'Sparar…' : confirmAction === 'id' ? 'Bekräfta kontroll & godkännande' : 'Avsluta visningen'}</button></div></div></div>}
  </section>;
}
