import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Mail, MessageSquare, Monitor, Send, ShieldCheck, X } from 'lucide-react';
import { terminalDemoApi } from './terminal-demo-client';
import { approvalLabels, type TerminalApproval, type TerminalDemoState } from './terminal-demo-types';
import './terminals.css';

export type ApprovalControlsProps = {
  approval?: TerminalApproval; state?: TerminalDemoState; siteId: string; terminalId: string;
  canSend: boolean; canConfirmId: boolean; canCancel: boolean; canSeeMoney?: boolean;
  onSend: (terminalId: string, siteId: string) => Promise<void | boolean>;
  onRefresh: () => Promise<void>; onNotice: (message: string) => void;
};
export default function ApprovalControls({ approval, state, siteId, terminalId, canSend, canConfirmId, canCancel, canSeeMoney = true, onSend, onRefresh, onNotice }: ApprovalControlsProps) {
  const [panel, setPanel] = useState(false);
  const [selectedTerminal, setSelectedTerminal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmAction, setConfirmAction] = useState<'id' | 'cancel'>();
  const terminals = state?.terminals.filter(terminal => terminal.active && terminal.siteId === siteId) ?? [];
  const open = () => {
    const choices = terminals.filter(terminal => terminal.online && !terminal.busy);
    setSelectedTerminal(choices.some(terminal => terminal.id === terminalId) ? terminalId : choices.length === 1 ? choices[0].id : '');
    setError(''); setPanel(true);
  };
  useEffect(() => { setPanel(false); setConfirmAction(undefined); setError(''); }, [approval?.id]);
  async function send() {
    if (!selectedTerminal || busy) return;
    setBusy(true); setError('');
    try { const result = await onSend(selectedTerminal, siteId); if (result !== false) setPanel(false); }
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
  return <section className="office-panel approval-controls">
    <div className="office-panel-heading"><h2>Kundgodkännande</h2><Monitor size={17} /></div>
    {approval ? <><span className={`approval-status approval-${approval.status}`}>{approvalLabels[approval.status]}</span><div className="approval-version-facts"><span>Avräkning · version {approval.version}</span>{canSeeMoney && <strong>{approval.snapshot.net.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong>}<small>{state?.terminals.find(terminal => terminal.id === approval.terminalId)?.name ?? 'Kundterminal'} · skickad av {approval.sentBy}</small></div>
      {approval.status === 'waiting' && <p className="approval-info-line"><Clock3 size={15} />Kunden granskar avräkningen före JEROC:s attest.</p>}
      {approval.status === 'id_requested' && <><p>Kunden vill godkänna med fysisk legitimation. Kontrollera legitimationen på plats innan du bekräftar.</p>{canConfirmId && <button className="office-btn" disabled={busy} onClick={() => { setConfirmAction('id'); setError(''); }}><ShieldCheck size={15} />Bekräfta legitimation & godkännande</button>}</>}
      {approval.status === 'change_requested' && <div className="approval-change-request"><strong><MessageSquare size={15} />Kunden begär ändring</strong><p>{approval.comment}</p><small>Komplettera kortet och skicka en ny version för kundens granskning.</small></div>}
      {(approval.status === 'approved' || approval.status === 'attested') && <p className="approval-info-line approval-approved-line"><CheckCircle2 size={16} />{approval.approvedBy ? `ID kontrollerat av ${approval.approvedBy}.` : 'Kunden har godkänt denna version.'} Intern attest är ett separat steg.</p>}
    </> : <p>Visa avräkningen för kunden innan den skickas till intern attest.</p>}
    <div className="approval-controls-actions">{canSend && !active && <button className="office-btn" disabled={!state || busy} onClick={open}><Send size={14} />{approval ? 'Visa ny version för kund' : 'Visa för kund'}</button>}{active && canCancel && <button className="office-btn outline" disabled={busy} onClick={() => { setConfirmAction('cancel'); setError(''); }}><X size={14} />Avsluta kundvisning</button>}</div>
    {error && !panel && !confirmAction && <div className="terminal-error" role="alert">{error}</div>}
    {panel && <div className="approval-send-panel"><div className="terminal-dialog-heading"><h2>Visa avräkning för kunden</h2><button type="button" className="terminal-icon-button" aria-label="Stäng kundvisning" disabled={busy} onClick={() => setPanel(false)}><X size={18} /></button></div><div className="approval-channel-options"><span className="selected"><Monitor size={15} />Kundterminal</span><button disabled title="E-post är en visuell förberedelse i denna demo"><Mail size={15} />E-post <small>Kommer senare</small></button><button disabled title="SMS är en visuell förberedelse i denna demo"><MessageSquare size={15} />SMS <small>Kommer senare</small></button></div><label>Kundterminal<select aria-label="Terminal för kundgodkännande" value={selectedTerminal} onChange={event => setSelectedTerminal(event.target.value)}><option value="">Välj en ledig terminal</option>{terminals.map(terminal => <option key={terminal.id} value={terminal.id} disabled={!terminal.online || terminal.busy}>{terminal.name} · {terminal.busy ? 'Upptagen' : terminal.online ? 'Ledig' : 'Offline'}</option>)}</select></label>{!terminals.length && <p>Ingen aktiv terminal finns på den här anläggningen. Systemadmin kan skapa en under Terminaler.</p>}{terminals.length > 0 && !terminals.some(terminal => terminal.online && !terminal.busy) && <p>Logga in på /terminal från mobilen eller en iPad. En terminal behöver vara online och ledig.</p>}{error && <div className="terminal-error" role="alert">{error}</div>}<button className="office-btn" disabled={!selectedTerminal || busy} onClick={() => void send()}><Send size={14} />{busy ? 'Visar…' : 'Visa på terminal'}</button></div>}
    {confirmAction && <div className="terminal-modal-backdrop"><div className="terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-confirm-title"><h2 id="approval-confirm-title">{confirmAction === 'id' ? 'Bekräfta kundens godkännande' : 'Avsluta kundvisningen?'}</h2><p>{confirmAction === 'id' ? 'Jag har kontrollerat kundens fysiska legitimation på plats och kunden godkänner den avräkning som visas. Kontrollen sparas med mitt namn och denna version.' : 'Terminalen återgår till välkomstskärmen. Kortet kan kompletteras och visas för kunden igen.'}</p>{error && <div className="terminal-error" role="alert">{error}</div>}<div className="terminal-dialog-actions"><button className="office-btn outline" disabled={busy} onClick={() => setConfirmAction(undefined)}>Avbryt</button><button className="office-btn" disabled={busy} onClick={() => void act()}>{busy ? 'Sparar…' : confirmAction === 'id' ? 'Bekräfta kontroll & godkännande' : 'Avsluta visningen'}</button></div></div></div>}
  </section>;
}
