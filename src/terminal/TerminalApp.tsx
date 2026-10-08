import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, FileText, HelpCircle, IdCard, LoaderCircle, LockKeyhole, LogOut, Monitor, Printer, ShieldCheck, UserRound, WifiOff, X } from 'lucide-react';
import { TerminalDemoError, terminalDemoApi } from '../office/terminal-demo-client';
import type { PublicApproval, TerminalSessionState } from '../office/terminal-demo-types';
import { SettlementView } from './SettlementView';
import './terminal.css';

type Dialog = 'id' | 'bankid' | null;
const changeReasons = ['Fel vikt', 'Fel artikel', 'Fel pris', 'Saknat material', 'Annat'];
const errorLabel = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';

function TerminalDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); return; }
      const first = elements[0], last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [busy, onClose]);
  return <div className="terminal-dialog-backdrop"><div ref={dialogRef} className="terminal-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <button className="terminal-dialog-close" aria-label="Stäng" disabled={busy} onClick={onClose}><X size={20} /></button>
    {children}
  </div></div>;
}


export default function TerminalApp() {
  const [session, setSession] = useState<TerminalSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const [comment, setComment] = useState('');
  const [responding, setResponding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const connectionRef = useRef(false);
  const refreshTimeRef = useRef(0);
  const previousApprovalRef = useRef<PublicApproval | null>(null);
  const terminalId = session?.terminal.id;
  const approval = connected ? session?.approval ?? null : null;
  const approvalKey = approval ? `${approval.id}:${approval.version}` : null;

  const clearCustomer = useCallback(() => {
    setTermsAccepted(false); setDialog(null); setChangeOpen(false); setChangeReason(''); setComment(''); setResponding(false); setError('');
  }, []);
  const markDisconnected = useCallback(() => {
    requestSequence.current += 1;
    connectionRef.current = false; setConnected(false);
    setSession(current => current ? { ...current, approval: null } : current);
    clearCustomer();
  }, [clearCustomer]);

  const refresh = useCallback(async () => {
    const currentGeneration = generation.current;
    const sequence = ++requestSequence.current;
    refreshTimeRef.current = Date.now();
    try {
      const current = await terminalDemoApi.session();
      if (currentGeneration !== generation.current || sequence !== requestSequence.current) return;
      if (document.visibilityState === 'hidden') { markDisconnected(); return; }
      connectionRef.current = true; setConnected(true); setSession(current); setLoading(false);
    } catch (caught) {
      if (currentGeneration !== generation.current || sequence !== requestSequence.current) return;
      if (caught instanceof TerminalDemoError && caught.status === 401) { setSession(null); clearCustomer(); }
      else markDisconnected();
      setLoading(false);
    }
  }, [clearCustomer, markDisconnected]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  useEffect(() => {
    clearCustomer();
    if (approvalKey) setNotice('');
  }, [approvalKey, clearCustomer]);

  useEffect(() => {
    const previous = previousApprovalRef.current;
    if (previous && !approval && connected) {
      if (previous.status === 'id_requested') setNotice('Kundvisningen är avslutad. Tack!');
      else if (previous.status === 'change_requested') setNotice('Din ändringsbegäran är skickad till personalen.');
    }
    previousApprovalRef.current = approval;
  }, [approval, connected]);

  useEffect(() => {
    if (!terminalId) return;
    const source = new EventSource('/api/terminal-demo/terminal-events', { withCredentials: true });
    const eventGeneration = generation.current;
    const update = () => { if (eventGeneration === generation.current) void refresh(); };
    const disconnect = () => { if (eventGeneration === generation.current) markDisconnected(); };
    source.onopen = update;
    source.onmessage = update;
    source.onerror = disconnect;
    source.addEventListener('state', update);
    source.addEventListener('update', update);
    source.addEventListener('session-ended', disconnect);
    const heartbeat = window.setInterval(() => {
      if (!connectionRef.current || Date.now() - refreshTimeRef.current >= 9_000) void refresh();
    }, 3_000);
    const visibility = () => { if (document.hidden) markDisconnected(); else void refresh(); };
    const online = () => void refresh();
    const offline = () => markDisconnected();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => { source.close(); window.clearInterval(heartbeat); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
  }, [terminalId, refresh, markDisconnected]);

  const login = async (event: FormEvent) => {
    event.preventDefault(); if (loginPending) return;
    setError(''); setLoginPending(true);
    const currentGeneration = ++generation.current;
    requestSequence.current += 1;
    try {
      const result = await terminalDemoApi.login(username.trim(), password);
      if (currentGeneration !== generation.current) return;
      connectionRef.current = true; setSession(result); setConnected(true); setPassword(''); setNotice(''); clearCustomer();
    } catch (caught) { if (currentGeneration === generation.current) setError(errorLabel(caught)); }
    finally { if (currentGeneration === generation.current) setLoginPending(false); }
  };

  const logout = async () => {
    generation.current += 1; requestSequence.current += 1;
    setSession(null); setMenuOpen(false); setConnected(false); connectionRef.current = false; clearCustomer();
    try { await terminalDemoApi.logout(); } catch { setError('Kunde inte avsluta serverinloggningen. Kontrollera anslutningen och försök igen.'); }
  };

  const respond = async (action: 'id_requested' | 'change_requested') => {
    if (!approval || responding || !connected) return;
    const currentGeneration = generation.current;
    setResponding(true); setError('');
    try {
      await terminalDemoApi.respond(approval.id, { action, termsAccepted, ...(action === 'change_requested' ? { comment: [changeReason, comment.trim()].filter(Boolean).join(': ') } : {}) });
      if (currentGeneration !== generation.current) return;
      setDialog(null); setChangeOpen(false);
      if (action === 'change_requested') setNotice('Din ändringsbegäran är skickad till personalen.');
      await refresh();
    } catch (caught) {
      if (currentGeneration !== generation.current) return;
      if (caught instanceof TerminalDemoError && caught.status === 401) { setSession(null); clearCustomer(); }
      else { setError(errorLabel(caught)); await refresh(); }
    } finally { if (currentGeneration === generation.current) setResponding(false); }
  };

  const closeDialog = useCallback(() => { if (!responding) setDialog(null); }, [responding]);
  const idle = !approval || ['cancelled', 'expired', 'attested'].includes(approval.status);

  return <div className="terminal-app">
    <header className="terminal-header"><img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" />
      {session && <div className="terminal-device-menu"><button className="terminal-device-button" aria-expanded={menuOpen} aria-label="Terminalinställningar" onClick={() => setMenuOpen(value => !value)}><Monitor size={17} /><span>{session.terminal.name}</span><ChevronDown size={14} /></button>{menuOpen && <div className="terminal-menu"><p>{session.terminal.name}</p><span>Inloggad som kundterminal</span><button onClick={() => void logout()}><LogOut size={17} /> Logga ut terminalen</button></div>}</div>}
    </header>
    {loading ? <main className="terminal-welcome" aria-live="polite"><LoaderCircle className="terminal-spinner" size={32} /><p>Ansluter till JEROC…</p></main> : !session ? <main className="terminal-login"><div className="terminal-login-icon"><Monitor size={31} /></div><span className="terminal-eyebrow">KUNDTERMINAL</span><h1>Välkommen till JEROC</h1><p>Logga in med terminalens konto.</p><form onSubmit={login}>
      <label htmlFor="terminal-username">Inloggningsnamn</label><div className="terminal-input-icon"><UserRound size={18} /><input id="terminal-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required value={username} onChange={event => setUsername(event.target.value)} disabled={loginPending} /></div>
      <label htmlFor="terminal-password">Lösenord</label><div className="terminal-input-icon"><LockKeyhole size={18} /><input id="terminal-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={loginPending} /></div>
      {error && <p className="terminal-error" role="alert"><CircleAlert size={17} />{error}</p>}
      <button className="terminal-button green" disabled={loginPending}>{loginPending ? <><LoaderCircle className="terminal-spinner" size={19} /> Ansluter…</> : 'Logga in terminal'}</button>
    </form><p className="terminal-login-help">Kontot skapas av systemadmin under Terminaler.</p></main> : idle ? <main className="terminal-welcome" aria-live="polite">
      <div className={`terminal-welcome-icon${connected ? '' : ' offline'}`}>{connected ? <ShieldCheck size={53} /> : <WifiOff size={48} />}</div>
      <span className="terminal-eyebrow">{session.terminal.name}</span><h1>Välkommen till JEROC</h1><h2>{connected ? 'Invänta personal' : 'Återansluter…'}</h2><p>{connected ? 'Din avräkning visas här när personalen är redo.' : 'Kundvisningen är dold tills anslutningen har återställts.'}</p>
      <div className="terminal-ready"><span className={`terminal-connection-dot${connected ? '' : ' offline'}`} />{connected ? 'Terminalen är redo' : 'Ingen kontakt med servern'}</div>{notice && <p className="terminal-notice">{notice}</p>}
    </main> : approval.status === 'id_requested' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><IdCard size={52} /></div><h1>Visa din legitimation</h1><h2>Inväntar personalens bekräftelse</h2><p>Kontoristen kontrollerar din legitimation och registrerar godkännandet för den här avräkningen.</p><div className="terminal-waiting"><LoaderCircle size={18} className="terminal-spinner" /> Kontoristen fortsätter på sin skärm</div></main> : approval.status === 'approved' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><CheckCircle2 size={52} /></div><h1>Tack, avräkningen är godkänd</h1><p>Personalen hanterar nästa steg. Kundgodkännandet innebär inte att en utbetalning har genomförts.</p></main> : approval.status === 'change_requested' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><ClipboardList size={52} /></div><h1>Ändringsbegäran skickad</h1><p>Personalen går igenom din kommentar. Du får granska en ny version om avräkningen ändras.</p></main> : <main className="terminal-settlement" key={approvalKey}>
      {changeOpen ? <><button className="terminal-back" onClick={() => { setChangeOpen(false); setError(''); }} disabled={responding}><ArrowLeft size={19} /> Tillbaka till avräkningen</button><h1>Begär ändring</h1><p className="terminal-intro">Beskriv vad som inte stämmer så hjälper personalen dig.</p><section className="terminal-seller-card"><div className="terminal-icon-bubble"><UserRound size={27} /></div><div><h2>{approval.snapshot.customerName}</h2><p>Invägningskort INV-{approval.snapshot.cardId} · Version {approval.version}</p></div></section><form className="terminal-change-form" onSubmit={event => { event.preventDefault(); if (comment.trim()) void respond('change_requested'); }}><fieldset><legend><HelpCircle size={21} /> Vad behöver ändras?</legend>{changeReasons.map(reason => <label key={reason} className="terminal-reason"><input type="radio" name="change-reason" value={reason} checked={changeReason === reason} onChange={() => setChangeReason(reason)} disabled={responding} />{reason}</label>)}</fieldset><label htmlFor="terminal-comment"><FileText size={21} /> Beskrivning</label><textarea id="terminal-comment" required maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="Beskriv vad som inte stämmer och vad som behöver ändras…" rows={5} disabled={responding} /><span className="terminal-hint">Beskrivning krävs. {comment.length}/2 000 tecken.</span>{error && <p className="terminal-error" role="alert">{error}</p>}<button className="terminal-button blue" disabled={responding || !comment.trim()}>{responding ? 'Skickar…' : 'Skicka begäran'}</button><button type="button" className="terminal-button outline" onClick={() => setChangeOpen(false)} disabled={responding}>Tillbaka</button><p className="terminal-safe-note"><ShieldCheck size={17} />Avräkningen går inte vidare till attest innan ändringen har hanterats och en ny version godkänts.</p></form></> : <>
        <div className="terminal-heading"><div><span className="terminal-eyebrow">AVRÄKNINGSNOTA</span><h1>Granska och godkänn din avräkning</h1><p className="terminal-intro">Kontrollera material, vikt och belopp innan du godkänner.</p></div></div>
        <SettlementView settlement={approval.snapshot} />
        <button className="terminal-print" onClick={() => window.print()}><Printer size={16} /> Skriv ut preliminärt underlag</button>
        <section className="terminal-terms"><h2><ShieldCheck size={23} /> Säljarens intygande</h2><p>Genom att godkänna avräkningen intygar jag att:</p><ul><li><Check size={16} />Jag äger materialet eller har rätt att sälja det.</li><li><Check size={16} />Materialet har lagligt ursprung.</li><li><Check size={16} />Uppgifterna jag lämnat är riktiga och jag har granskat artiklar, vikter och priser.</li><li><Check size={16} />Jag har informerat JEROC om farligt innehåll och annat som kan påverka hanteringen.</li><li><Check size={16} />Om jag säljer för ett företag har jag rätt att företräda företaget.</li></ul><p className="terminal-terms-note">En ändrad avräkning behöver granskas och godkännas på nytt.</p><label className="terminal-accept"><input type="checkbox" checked={termsAccepted} onChange={event => { setTermsAccepted(event.target.checked); setError(''); }} /><span>Jag har granskat avräkningen och bekräftar intygandet.</span></label><span className="terminal-hint">Demovillkor {approval.snapshot.termsVersion} · avräkningsversion {approval.version}</span></section>
        {error && <p className="terminal-error" role="alert">{error}</p>}
        <div className="terminal-customer-actions"><button className="terminal-button green" disabled={responding} onClick={() => setDialog('bankid')}><ShieldCheck size={20} /> Godkänn med BankID</button><button className="terminal-button outline green-outline" disabled={responding} onClick={() => { if (!termsAccepted) { setError('Bekräfta att du har granskat avräkningen och intygandet först.'); return; } setDialog('id'); }}><IdCard size={20} /> Godkänn med legitimation</button><button className="terminal-button outline" disabled={responding} onClick={() => { setChangeOpen(true); setError(''); window.scrollTo({ top: 0, behavior: 'instant' }); }}>Begär ändring</button></div>
      </>}
    </main>}
    <footer className="terminal-footer"><span>DEMO · Inga riktiga betalningar eller BankID-signeringar</span>{session && <small>{session.terminal.name}</small>}</footer>
    {dialog === 'id' && approval && <TerminalDialog title="Manuell verifiering" onClose={closeDialog} busy={responding}><div className="terminal-dialog-icon"><IdCard size={36} /></div><h2>Manuell verifiering</h2><p>Visa din legitimation för kontoristen så att identiteten kan kontrolleras.</p><div className="terminal-dialog-info"><ShieldCheck size={22} /><span>Godkännandet registreras först när personalen har kontrollerat legitimationen och bekräftat på sin skärm.</span></div><p className="terminal-dialog-method">Fysisk legitimation · avräkningsversion {approval.version}</p>{error && <p className="terminal-error" role="alert">{error}</p>}<button className="terminal-button green" disabled={responding} onClick={() => void respond('id_requested')}>{responding ? 'Skickar till personal…' : 'Okej'}</button><button className="terminal-button outline" disabled={responding} onClick={closeDialog}>Avbryt</button></TerminalDialog>}
    {dialog === 'bankid' && approval && <TerminalDialog title="BankID – demoläge" onClose={closeDialog}><div className="terminal-dialog-icon"><ShieldCheck size={37} /></div><span className="terminal-demo-label">DEMO</span><h2>BankID är inte anslutet</h2><p>I den färdiga kopplingen signerar du med BankID på din egen mobil. Här utförs ingen signering eller identitetskontroll.</p><div className="terminal-dialog-info"><IdCard size={22} /><span>För att prova terminalflödet väljer du Godkänn med legitimation. Personalen fortsätter sedan från kontorets vy.</span></div><button className="terminal-button outline" onClick={closeDialog}>Tillbaka till avräkningen</button></TerminalDialog>}
  </div>;
}
