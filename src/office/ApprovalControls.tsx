import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, FileText, Mail, MessageSquare, Monitor, Send, ShieldCheck, Users, X } from 'lucide-react';
import { terminalDemoApi } from './terminal-demo-client';
import { approvalLabels, type TerminalApproval, type TerminalDemoState } from './terminal-demo-types';
import './terminals.css';

export type ApprovalControlsProps = {
  approval?: TerminalApproval; state?: TerminalDemoState; siteId: string; terminalId: string;
  canSend: boolean; canConfirmId: boolean; canCancel: boolean; canSeeMoney?: boolean;
  guidance?: 'focus' | 'muted';
  disabledReason?: string; onPreview?: () => void;
  onSend: (terminalId: string, siteId: string) => Promise<void | boolean>;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
};
export default function ApprovalControls({ approval, state, siteId, terminalId, canSend, canConfirmId, canCancel, canSeeMoney = true, guidance, disabledReason, onPreview, onSend, onRefresh, onNotice }: ApprovalControlsProps) {
  const [panel, setPanel] = useState(false);
  const [selectedTerminal, setSelectedTerminal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<'id' | 'cancel'>();
  const terminals = state?.terminals.filter(terminal => terminal.active && terminal.siteId === siteId) ?? [];
  const availableTerminals = terminals.filter(terminal => terminal.online && !terminal.busy);
  const terminalUnavailableReason = !state ? 'Terminaltjänsten behöver vara ansluten.'
    : !terminals.length ? 'Ingen aktiv terminal finns på den här anläggningen.'
      : !availableTerminals.length ? 'En terminal behöver vara online och ledig.' : '';
  const sendDisabledReason = !canSend ? disabledReason || 'Komplettera kund, ursprungsadress, betalningsuppgifter och priser först.' : terminalUnavailableReason;
  const open = () => {
    if (!canSend || sendDisabledReason || busy) return;
    const choices = availableTerminals;
    setSelectedTerminal(choices.some(terminal => terminal.id === terminalId) ? terminalId : choices.length === 1 ? choices[0].id : '');
    setError(''); setPanel(true);
  };
  useEffect(() => { setPanel(false); setConfirmAction(undefined); setError(''); }, [approval?.id]);
  async function send() {
    if (!canSend || !availableTerminals.some(terminal => terminal.id === selectedTerminal) || busy) return;
    setBusy(true); setError('');
    try {
      const result = await onSend(selectedTerminal, siteId);
      if (result === false) setError('Avräkningen kunde inte visas. Kontrollera underlaget och försök igen.');
      else setPanel(false);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Avräkningen kunde inte visas.'); }
    finally { setBusy(false); }
  }
  async function act() {
    if (!approval || !confirmAction || busy) return;
    setBusy(true); setError('');
    try {
      if (confirmAction === 'id') await terminalDemoApi.confirmId(approval.id);
      else await terminalDemoApi.cancel(approval.id);
      await onRefresh(); setConfirmAction(undefined);
      onNotice(confirmAction === 'id' ? 'Legitimationen är kontrollerad och kundgodkännandet registrerat. Kortet går vidare till intern attest.' : 'Kundvisningen har avslutats.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Åtgärden kunde inte utföras.'); }
    finally { setBusy(false); }
  }
  const active = approval && (approval.status === 'waiting' || approval.status === 'id_requested');
  const approved = approval?.status === 'approved' || approval?.status === 'attested';
  const terminalName = state?.terminals.find(terminal => terminal.id === approval?.terminalId)?.name ?? 'Kundterminal';
  const approvedTime = approval?.approvedAt ? new Date(approval.approvedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const description = approval?.status === 'waiting' ? 'Kunden granskar avräkningen före JEROC:s interna attest.'
    : approval?.status === 'id_requested' ? 'Kontrollera kundens legitimation på plats innan godkännandet bekräftas.'
      : approval?.status === 'change_requested' ? 'Komplettera kortet och visa en ny version för kunden.'
        : approved ? `Granskningsversion ${approval.version} · Kundterminal ${terminalName}`
          : 'Visa avräkningen för kunden innan den går vidare till intern attest.';
  return <section className={`office-panel approval-controls${approved ? ' approval-controls-approved' : ''}${guidance ? ` office-guidance-${guidance}` : ''}`}>
    <div className="approval-controls-heading">
      <span className={`approval-heading-icon${approved ? ' approved' : ''}`}>{approved ? <CheckCircle2 size={25} /> : <Users size={24} />}</span>
      <div className="approval-heading-copy"><h2>Kundgodkännande</h2><p>{description}</p>{approved && approval.approvedBy && <p className="approval-approved-line">Fysisk legitimation bekräftad av {approval.approvedBy}{approvedTime && ` · ${approvedTime}`}</p>}</div>
      <span className={`approval-status ${approval ? `approval-${approved ? 'approved' : approval.status}` : 'approval-not-sent'}`}>{approved && <CheckCircle2 size={13} />}{approval ? approved ? 'Godkänd av kund' : approvalLabels[approval.status] : 'Ej skickad'}</span>
      {approved && onPreview && <button type="button" className="office-btn outline approval-preview" onClick={onPreview}><FileText size={16} />Granska avräkning</button>}
    </div>
    {approval && !approved && <div className="approval-version-facts"><span>Avräkning · version {approval.version}</span>{canSeeMoney && <strong>{approval.snapshot.net.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong>}<small>{terminalName} · skickad av {approval.sentBy}</small>{onPreview && <button type="button" className="office-link" onClick={onPreview}><FileText size={14} />Granska avräkning</button>}</div>}
    {approval?.status === 'waiting' && <p className="approval-info-line"><Clock3 size={15} />Kundvisningen är aktiv på {terminalName}.</p>}
    {approval?.status === 'change_requested' && <div className="approval-change-request"><strong><MessageSquare size={15} />Kunden begär ändring</strong><p>{approval.comment}</p><small>En ny version behöver granskas och godkännas innan intern attest.</small></div>}
    {!active && !approved && <div className="approval-channel-tiles">
      <button type="button" className="approval-channel-tile" disabled={!!sendDisabledReason || busy} onClick={open} title={sendDisabledReason || 'Välj en ledig kundterminal'} aria-label={approval ? 'Visa ny version på kundterminal' : 'Visa på kundterminal'} aria-describedby={sendDisabledReason ? 'approval-send-disabled-reason' : undefined}><Monitor size={24} /><span><strong>{approval ? 'Visa ny version på kundterminal' : 'Visa på kundterminal'}</strong><small id="approval-send-disabled-reason">{sendDisabledReason || 'Välj terminal och visa avräkningen för kunden'}</small></span></button>
      <button type="button" className="approval-channel-tile" disabled aria-label="Skicka via SMS" title="SMS är en visuell förberedelse i denna demo"><MessageSquare size={24} /><span><strong>Skicka via SMS</strong><small>Kommer senare</small></span></button>
      <button type="button" className="approval-channel-tile" disabled aria-label="Skicka via e-post" title="E-post är en visuell förberedelse i denna demo"><Mail size={24} /><span><strong>Skicka via e-post</strong><small>Kommer senare</small></span></button>
    </div>}
    <div className="approval-controls-actions">{approval?.status === 'id_requested' && canConfirmId && <button type="button" className="office-btn" disabled={busy} onClick={() => { setConfirmAction('id'); setError(''); }}><ShieldCheck size={15} />Bekräfta legitimation & godkännande</button>}{active && canCancel && <button type="button" className="office-btn outline" disabled={busy} onClick={() => { setConfirmAction('cancel'); setError(''); }}><X size={14} />Avsluta kundvisning</button>}</div>
    {error && !panel && !confirmAction && <div className="terminal-error" role="alert">{error}</div>}
    {panel && <div className="terminal-modal-backdrop"><div className="terminal-dialog approval-send-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-send-title"><div className="terminal-dialog-heading"><h2 id="approval-send-title">Visa avräkning för kunden</h2><button type="button" className="terminal-icon-button" aria-label="Stäng kundvisning" disabled={busy} onClick={() => setPanel(false)}><X size={18} /></button></div><p>Terminalen visar den låsta version som kunden ska granska och godkänna.</p><label>Kundterminal<select aria-label="Terminal för kundgodkännande" value={selectedTerminal} onChange={event => setSelectedTerminal(event.target.value)}><option value="">Välj en ledig terminal</option>{terminals.map(terminal => <option key={terminal.id} value={terminal.id} disabled={!terminal.online || terminal.busy}>{terminal.name} · {terminal.busy ? 'Upptagen' : terminal.online ? 'Ledig' : 'Offline'}</option>)}</select></label>{sendDisabledReason && <p className="approval-requirements">{sendDisabledReason}</p>}{error && <div className="terminal-error" role="alert">{error}</div>}<div className="terminal-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setPanel(false)}>Avbryt</button><button type="button" className="office-btn" disabled={!canSend || !availableTerminals.some(terminal => terminal.id === selectedTerminal) || busy} onClick={() => void send()}><Send size={14} />{busy ? 'Visar…' : 'Visa på terminal'}</button></div></div></div>}
    {confirmAction && <div className="terminal-modal-backdrop"><div className="terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-confirm-title"><h2 id="approval-confirm-title">{confirmAction === 'id' ? 'Bekräfta kundens godkännande' : 'Avsluta kundvisningen?'}</h2><p>{confirmAction === 'id' ? 'Jag har kontrollerat kundens fysiska legitimation på plats och kunden godkänner den avräkning som visas. Kontrollen sparas med mitt namn och denna version.' : 'Terminalen återgår till välkomstskärmen. Kortet kan kompletteras och visas för kunden igen.'}</p>{error && <div className="terminal-error" role="alert">{error}</div>}<div className="terminal-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setConfirmAction(undefined)}>Avbryt</button><button type="button" className="office-btn" disabled={busy} onClick={() => void act()}>{busy ? 'Sparar…' : confirmAction === 'id' ? 'Bekräfta kontroll & godkännande' : 'Avsluta visningen'}</button></div></div></div>}
  </section>;
}
