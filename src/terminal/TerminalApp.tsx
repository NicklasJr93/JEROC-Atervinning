import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, FileText, HelpCircle, IdCard, LoaderCircle, LockKeyhole, LogOut, Monitor, Printer, ShieldCheck, UserRound, WifiOff, X } from 'lucide-react';
import { TerminalDemoError, terminalDemoApi } from '../office/terminal-demo-client';
import { parseTerminalSession, publicApprovalSchema, type PublicApproval, type TerminalSessionState } from '../office/terminal-demo-types';
import { SettlementView } from './SettlementView';
import CustomerIntakeForm from '../customer-intake/CustomerIntakeForm';
import type { CustomerIntakeInput, PublicCustomerIntakeState } from '../customer-intake/types';
import { CompanyLookupError } from '../company-register/client';
import { lookupTerminalIntakeCompany } from '../customer-intake/company-lookup';
import { PersonLookupError } from '../person-register/client';
import { lookupTerminalIntakePerson } from '../customer-intake/person-lookup';
import './terminal.css';
import { tenantPublicEventUrl } from '../tenant-public-context';
import { useTenantCompanyName } from '../use-tenant-company';

const changeReasons = ['Fel vikt', 'Fel artikel', 'Fel pris', 'Saknat material', 'Annat'];
const errorLabel = (error: unknown) => error instanceof Error ? error.message : 'Något gick fel. Försök igen.';

function TerminalDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose?: () => void; busy?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef({ onClose, busy });
  controlsRef.current = { onClose, busy };
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const body = document.body, html = document.documentElement;
    const previousStyles = { position: body.style.position, top: body.style.top, left: body.style.left, width: body.style.width, overflow: body.style.overflow, htmlOverflow: html.style.overflow };
    // Fixing the body also prevents background touch scrolling on mobile Safari.
    // Keep its visual position while the portal is anchored to the viewport.
    Object.assign(body.style, { position: 'fixed', top: `${-scroll.y}px`, left: `${-scroll.x}px`, width: '100%', overflow: 'hidden' });
    html.style.overflow = 'hidden';
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])
      .filter(element => element.getClientRects().length > 0);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !controlsRef.current.busy) controlsRef.current.onClose?.();
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); dialogRef.current?.focus({ preventScroll: true }); return; }
      const first = elements[0], last = elements.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus({ preventScroll: true }); }
      if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      Object.assign(body.style, { position: previousStyles.position, top: previousStyles.top, left: previousStyles.left, width: previousStyles.width, overflow: previousStyles.overflow });
      html.style.overflow = previousStyles.htmlOverflow;
      window.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const element = dialogRef.current;
    if (!element) return;
    element.scrollTop = 0;
    const first = element.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
    (first ?? element).focus({ preventScroll: true });
  }, [title]);
  return createPortal(<div className="terminal-dialog-backdrop"><div ref={dialogRef} className="terminal-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    {onClose && <button className="terminal-dialog-close" aria-label="Stäng" disabled={busy} onClick={onClose}><X size={20} /></button>}
    {children}
  </div></div>, document.body);
}


/** Each reservation mounts a fresh form. No customer data is kept after the
 * device disconnects, its cookie epoch changes or staff finishes this intake. */
function TerminalCustomerIntake({ intakeId, onUnavailable }: { intakeId: string; onUnavailable: () => void }) {
  const [state, setState] = useState<PublicCustomerIntakeState | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const requests = useRef(new Set<AbortController>());
  const submission = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); requests.current.add(controller);
    void terminalDemoApi.customerIntake(controller.signal).then(result => {
      if (!mounted.current || controller.signal.aborted) return;
      if (!result || result.intake.id !== intakeId) { setExpired(true); onUnavailable(); return; }
      setState(result); setError('');
    }).catch(failure => {
      if (!mounted.current || controller.signal.aborted) return;
      if (failure instanceof TerminalDemoError && [401, 403, 409, 410].includes(failure.status)) { setExpired(true); onUnavailable(); }
      else setError(errorLabel(failure));
    }).finally(() => requests.current.delete(controller));
    return () => { mounted.current = false; for (const request of requests.current) request.abort(); requests.current.clear(); };
  }, [intakeId, onUnavailable, attempt]);
  useEffect(() => {
    if (!state) return;
    const timer = window.setTimeout(() => { setExpired(true); setState(null); onUnavailable(); },
      Math.max(0, Math.min(24 * 60 * 60 * 1000, Date.parse(state.intake.expiresAt) - Date.now())));
    return () => window.clearTimeout(timer);
  }, [state, onUnavailable]);
  const companyLookup = useCallback(async (number: string, signal: AbortSignal) => {
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    requests.current.add(controller);
    try {
      const company = await lookupTerminalIntakeCompany(intakeId, number, controller.signal);
      if (!mounted.current || controller.signal.aborted) throw new DOMException('Kundformuläret har avslutats.', 'AbortError');
      return company;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && failure instanceof CompanyLookupError && [401, 403, 409, 410].includes(failure.status)) {
        setExpired(true); setState(null); onUnavailable();
      }
      throw failure;
    } finally { requests.current.delete(controller); signal.removeEventListener('abort', cancel); }
  }, [intakeId, onUnavailable]);
  const personLookup = useCallback(async (number: string, requestId: string, signal: AbortSignal) => {
    const controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    requests.current.add(controller);
    try {
      const result = await lookupTerminalIntakePerson(intakeId, number, requestId, controller.signal);
      if (!mounted.current || controller.signal.aborted) throw new DOMException('Kundformuläret har avslutats.', 'AbortError');
      return result;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted && failure instanceof PersonLookupError
        && ([401, 403, 410].includes(failure.status) || failure.code === 'customer_intake_unavailable')) {
        setExpired(true); setState(null); onUnavailable();
      }
      throw failure;
    } finally { requests.current.delete(controller); signal.removeEventListener('abort', cancel); }
  }, [intakeId, onUnavailable]);
  const submit = async (customer: CustomerIntakeInput) => {
    if (!state || state.intake.id !== intakeId || expired || state.intake.status !== 'waiting')
      throw new Error('Kundformuläret har avslutats. Be personalen om hjälp.');
    const fingerprint = JSON.stringify(customer);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, requestId: crypto.randomUUID() };
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const result = await terminalDemoApi.submitCustomerIntake({ id: intakeId, requestId: submission.current.requestId, customer }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (result.intake.id !== intakeId) { setExpired(true); onUnavailable(); return; }
      setState(result);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      if (failure instanceof TerminalDemoError && [401, 403, 409, 410].includes(failure.status)) { setExpired(true); setState(null); onUnavailable(); }
      throw failure;
    } finally { requests.current.delete(controller); }
  };
  if (expired || state && !['waiting', 'submitted'].includes(state.intake.status))
    return <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><ShieldCheck size={48} /></div><h1>Kundformuläret är avslutat</h1><p>Invänta personalen.</p></main>;
  if (state?.intake.status === 'submitted')
    return <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><CheckCircle2 size={52} /></div><h1>Tack, uppgifterna är skickade</h1><p>Personalen granskar dina uppgifter och hjälper dig med nästa steg.</p></main>;
  if (!state) return <main className="terminal-welcome" aria-live="polite">{error ? <><p className="terminal-error" role="alert">{error}</p><button className="terminal-button outline" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Försök igen</button></> : <><LoaderCircle className="terminal-spinner" size={32} /><p>Hämtar kundformuläret…</p></>}</main>;
  return <main className="terminal-intake"><div className="terminal-heading"><span className="terminal-eyebrow">KUNDUPPGIFTER</span><h1>Fyll i dina uppgifter</h1><p className="terminal-intro">Skicka uppgifterna till personalen hos {state.company.name}. Personalen granskar dem innan de sparas.</p></div>
    <CustomerIntakeForm onSubmit={submit} autoComplete="off" lookupCompany={companyLookup} lookupPerson={personLookup} lookupContextKey={intakeId} />
  </main>;
}


export default function TerminalApp() {
  const companyName = useTenantCompanyName();
  const [session, setSession] = useState<TerminalSessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeReason, setChangeReason] = useState('');
  const [comment, setComment] = useState('');
  const [responding, setResponding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const sessionRef = useRef<TerminalSessionState | null>(null);
  const refreshFlight = useRef<{ generation: number; promise: Promise<void>; controller: AbortController } | undefined>(undefined);
  const displayedRef = useRef('');
  const previousApprovalRef = useRef<PublicApproval | null>(null);
  const respondingRef = useRef('');
  const terminalId = session?.terminal.id;
  const intakeId = connected && session?.terminal.busyKind === 'intake' ? session.terminal.activeIntakeId : undefined;
  const approval = connected && !intakeId ? session?.approval ?? null : null;
  const approvalKey = approval ? `${approval.id}:${approval.version}` : null;

  const clearCustomer = useCallback(() => {
    respondingRef.current = '';
    setTermsAccepted(false); setChangeOpen(false); setChangeReason(''); setComment(''); setResponding(false); setError('');
  }, []);
  const markDisconnected = useCallback(() => {
    requestSequence.current += 1;
    setConnected(false);
    setSession(current => current ? { ...current, approval: null } : current);
    clearCustomer();
  }, [clearCustomer]);

  const acceptSession = useCallback((payload: unknown, currentGeneration: number) => {
    if (currentGeneration !== generation.current) return false;
    const current = parseTerminalSession(payload), previous = sessionRef.current;
    if (previous && (current.terminal.id !== previous.terminal.id ||
        (previous.connectionId && current.connectionId !== previous.connectionId))) { markDisconnected(); return false; }
    if (previous?.revision !== undefined && current.revision !== undefined && current.revision < previous.revision) return false;
    if (previous?.approval && current.approval?.id === previous.approval.id &&
        (current.approval.version < previous.approval.version ||
          (current.approval.version === previous.approval.version && Date.parse(current.approval.updatedAt) < Date.parse(previous.approval.updatedAt)))) return false;
    if (document.visibilityState === 'hidden') { markDisconnected(); return false; }
    ++requestSequence.current;
    sessionRef.current = current; setConnected(true); setSession(current); setLoading(false);
    return true;
  }, [markDisconnected]);

  const refresh = useCallback((): Promise<void> => {
    const currentGeneration = generation.current;
    if (refreshFlight.current?.generation === currentGeneration) return refreshFlight.current.promise;
    const sequence = ++requestSequence.current, controller = new AbortController();
    const pending = { generation: currentGeneration, controller, promise: Promise.resolve() };
    pending.promise = (async () => {
      try {
        const current = await terminalDemoApi.session(controller.signal);
        if (sequence === requestSequence.current) acceptSession(current, currentGeneration);
      } catch (caught) {
        if (controller.signal.aborted || currentGeneration !== generation.current || sequence !== requestSequence.current) return;
        if (caught instanceof TerminalDemoError && (caught.status === 401 || caught.code === 'company_selection_changed')) { sessionRef.current = null; setSession(null); clearCustomer(); }
        else markDisconnected();
        setLoading(false);
      } finally { if (refreshFlight.current === pending) refreshFlight.current = undefined; }
    })();
    refreshFlight.current = pending;
    return pending.promise;
  }, [acceptSession, clearCustomer, markDisconnected]);

  const refreshIntake = useCallback(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; refreshFlight.current?.controller.abort(); };
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
    let disposed = false, cleanupStream: (() => void) | undefined;
    const startStream = async () => {
      const eventUrl = await tenantPublicEventUrl('/api/terminal-demo/terminal-events');
      if (disposed) return;
      const source = new EventSource(eventUrl, { withCredentials: true });
      const eventGeneration = generation.current;
      let lastEventAt = 0;
      const update = (event: MessageEvent<string>) => {
        if (eventGeneration !== generation.current) return;
        try { if (acceptSession(JSON.parse(event.data), eventGeneration)) lastEventAt = Date.now(); }
        catch { markDisconnected(); void refresh(); }
      };
      const disconnect = () => { if (eventGeneration === generation.current) { lastEventAt = 0; markDisconnected(); } };
      source.onmessage = update; source.onerror = disconnect;
      source.addEventListener('state', update);
      source.addEventListener('heartbeat', (event: MessageEvent<string>) => {
        if (eventGeneration !== generation.current) return;
        try {
          const payload = JSON.parse(event.data);
          if (payload.connectionId === sessionRef.current?.connectionId) lastEventAt = Date.now();
        } catch { /* Malformed heartbeats cannot keep a customer view alive. */ }
      });
      source.addEventListener('session-ended', () => { source.close(); disconnect(); void refresh(); });
      // Healthy SSE delivers its own scoped baseline and authenticated heartbeats.
      // Fallback is single-flight and never fetches again for an ordinary event.
      const heartbeat = window.setInterval(() => {
        if (document.hidden) return;
        if (source.readyState !== EventSource.OPEN || Date.now() - lastEventAt > 45_000) {
          disconnect();
          void terminalDemoApi.heartbeat().then(() => refresh()).catch(disconnect);
        }
      }, 30_000);
      const visibility = () => { if (document.hidden) disconnect(); else void refresh(); };
      const online = () => void refresh();
      const offline = disconnect;
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('online', online); window.addEventListener('offline', offline);
      cleanupStream = () => { source.close(); window.clearInterval(heartbeat); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
    };
    void startStream().catch(() => { if (!disposed) markDisconnected(); });
    return () => { disposed = true; cleanupStream?.(); };
  }, [terminalId, acceptSession, refresh, markDisconnected]);

  useEffect(() => {
    if (!connected || !approval || approval.status !== 'waiting' || approval.displayedAt) return;
    const key = `${approval.id}/${approval.version}/${approval.snapshot.hash}`;
    if (displayedRef.current === key) return;
    const currentGeneration = generation.current;
    let cancelled = false, frame = 0, retry: ReturnType<typeof setTimeout> | undefined;
    const acknowledge = async () => {
      if (cancelled || document.hidden || currentGeneration !== generation.current) return;
      try {
        await terminalDemoApi.displayed(approval.id, approval.version, approval.snapshot.hash);
        if (!cancelled && currentGeneration === generation.current) displayedRef.current = key;
      } catch {
        // Display acknowledgement is idempotent and can retry. It never signs
        // the review or hides a successfully rendered review on a transient error.
        if (!cancelled) retry = setTimeout(() => void acknowledge(), 5_000);
      }
    };
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => void acknowledge()); });
    return () => { cancelled = true; cancelAnimationFrame(frame); clearTimeout(retry); };
  }, [approvalKey, approval?.snapshot.hash, approval?.status, approval?.displayedAt, connected]);

  const login = async (event: FormEvent) => {
    event.preventDefault(); if (loginPending) return;
    setError(''); setLoginPending(true);
    const currentGeneration = ++generation.current;
    requestSequence.current += 1; refreshFlight.current?.controller.abort(); sessionRef.current = null;
    try {
      const result = await terminalDemoApi.login(username.trim(), password);
      if (currentGeneration !== generation.current) return;
      sessionRef.current = result; setSession(result); setConnected(true); setPassword(''); setNotice(''); clearCustomer();
    } catch (caught) { if (currentGeneration === generation.current) setError(errorLabel(caught)); }
    finally { if (currentGeneration === generation.current) setLoginPending(false); }
  };

  const logout = async () => {
    generation.current += 1; requestSequence.current += 1;
    refreshFlight.current?.controller.abort(); sessionRef.current = null; setSession(null); setMenuOpen(false); setConnected(false); clearCustomer();
    try { await terminalDemoApi.logout(); } catch { setError('Kunde inte avsluta serverinloggningen. Kontrollera anslutningen och försök igen.'); }
  };

  const respond = async (action: 'id_requested' | 'change_requested') => {
    if (!approval || respondingRef.current || !connected) return;
    const currentGeneration = generation.current;
    const actionKey = `${currentGeneration}/${session?.terminal.id}/${approval.id}/${approval.version}/${approval.snapshot.hash}`;
    respondingRef.current = actionKey;
    const current = () => {
      const currentSession = sessionRef.current;
      return currentGeneration === generation.current && respondingRef.current === actionKey && currentSession !== null
        && currentSession.terminal.id === session?.terminal.id && currentSession.approval?.id === approval.id
        && currentSession.approval.version === approval.version && currentSession.approval.snapshot.hash === approval.snapshot.hash;
    };
    setResponding(true); setError('');
    try {
      const response = publicApprovalSchema.parse(await terminalDemoApi.respond(approval.id, { action, termsAccepted, ...(action === 'change_requested' ? { comment: [changeReason, comment.trim()].filter(Boolean).join(': ') } : {}) }));
      if (!current()) return;
      if (response.id !== approval.id || response.version !== approval.version || response.snapshot.hash !== approval.snapshot.hash)
        throw new Error('Avräkningen har ändrats. Läs in den aktuella versionen igen.');
      setChangeOpen(false);
      if (action === 'change_requested') setNotice('Din ändringsbegäran är skickad till personalen.');
      const previous = sessionRef.current;
      if (previous?.approval?.id === approval.id && previous.approval.version === approval.version)
        acceptSession({ ...previous, approval: response, revision: response.revision ?? previous.revision }, currentGeneration);
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof TerminalDemoError && (caught.status === 401 || caught.code === 'company_selection_changed')) { sessionRef.current = null; setSession(null); clearCustomer(); }
      else { setError(errorLabel(caught)); void refresh(); }
    } finally { if (respondingRef.current === actionKey) { respondingRef.current = ''; if (currentGeneration === generation.current) setResponding(false); } }
  };

  const idle = !approval || ['cancelled', 'expired', 'attested'].includes(approval.status);
  const waitingForId = !idle && approval?.status === 'id_requested';

  return <div className="terminal-app">
    <header className="terminal-header"><img src="/images/scrapplanner-logo.png" alt="ScrapPlanner" />
      {session && <div className="terminal-device-menu"><button className="terminal-device-button" aria-expanded={menuOpen} aria-label="Terminalinställningar" onClick={() => setMenuOpen(value => !value)}><Monitor size={17} /><span>{session.terminal.name}</span><ChevronDown size={14} /></button>{menuOpen && <div className="terminal-menu"><p>{session.terminal.name}</p><span>Inloggad som kundterminal</span><button onClick={() => void logout()}><LogOut size={17} /> Logga ut terminalen</button></div>}</div>}
    </header>
    {loading ? <main className="terminal-welcome" aria-live="polite"><LoaderCircle className="terminal-spinner" size={32} /><p>Ansluter till {companyName}…</p></main> : !session ? <main className="terminal-login"><div className="terminal-login-icon"><Monitor size={31} /></div><span className="terminal-eyebrow">KUNDTERMINAL</span><h1>Välkommen till {companyName}</h1><p>Logga in med terminalens konto.</p><form onSubmit={login}>
      <label htmlFor="terminal-username">Inloggningsnamn</label><div className="terminal-input-icon"><UserRound size={18} /><input id="terminal-username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" required value={username} onChange={event => setUsername(event.target.value)} disabled={loginPending} /></div>
      <label htmlFor="terminal-password">Lösenord</label><div className="terminal-input-icon"><LockKeyhole size={18} /><input id="terminal-password" name="password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={loginPending} /></div>
      {error && <p className="terminal-error" role="alert"><CircleAlert size={17} />{error}</p>}
      <button className="terminal-button green" disabled={loginPending}>{loginPending ? <><LoaderCircle className="terminal-spinner" size={19} /> Ansluter…</> : 'Logga in terminal'}</button>
    </form><p className="terminal-login-help">Kontot skapas av systemadmin under Terminaler.</p></main> : intakeId ? <TerminalCustomerIntake key={`${session.connectionId}:${intakeId}`} intakeId={intakeId} onUnavailable={refreshIntake} /> : idle ? <main className="terminal-welcome" aria-live="polite">
      <div className={`terminal-welcome-icon${connected ? '' : ' offline'}`}>{connected ? <ShieldCheck size={53} /> : <WifiOff size={48} />}</div>
      <span className="terminal-eyebrow">{session.terminal.name}</span><h1>Välkommen till {companyName}</h1><h2>{connected ? 'Invänta personal' : 'Återansluter…'}</h2><p>{connected ? 'Din avräkning visas här när personalen är redo.' : 'Kundvisningen är dold tills anslutningen har återställts.'}</p>
      <div className="terminal-ready"><span className={`terminal-connection-dot${connected ? '' : ' offline'}`} />{connected ? 'Terminalen är redo' : 'Ingen kontakt med servern'}</div>{notice && <p className="terminal-notice">{notice}</p>}
    </main> : waitingForId ? <main className="terminal-welcome" aria-hidden="true" /> : approval.status === 'approved' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><CheckCircle2 size={52} /></div><h1>Tack, avräkningen är godkänd</h1><p>Personalen hanterar nästa steg. Kundgodkännandet innebär inte att en utbetalning har genomförts.</p></main> : approval.status === 'change_requested' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><ClipboardList size={52} /></div><h1>Ändringsbegäran skickad</h1><p>Personalen går igenom din kommentar. Du får granska en ny version om avräkningen ändras.</p></main> : <main className="terminal-settlement" key={approvalKey}>
      {changeOpen ? <><button className="terminal-back" onClick={() => { setChangeOpen(false); setError(''); }} disabled={responding}><ArrowLeft size={19} /> Tillbaka till avräkningen</button><h1>Begär ändring</h1><p className="terminal-intro">Beskriv vad som inte stämmer så hjälper personalen dig.</p><section className="terminal-seller-card"><div className="terminal-icon-bubble"><UserRound size={27} /></div><div><h2>{approval.snapshot.customerName}</h2><p>Invägningskort INV-{approval.snapshot.cardId} · Version {approval.version}</p></div></section><form className="terminal-change-form" onSubmit={event => { event.preventDefault(); if (comment.trim()) void respond('change_requested'); }}><fieldset><legend><HelpCircle size={21} /> Vad behöver ändras?</legend>{changeReasons.map(reason => <label key={reason} className="terminal-reason"><input type="radio" name="change-reason" value={reason} checked={changeReason === reason} onChange={() => setChangeReason(reason)} disabled={responding} />{reason}</label>)}</fieldset><label htmlFor="terminal-comment"><FileText size={21} /> Beskrivning</label><textarea id="terminal-comment" required maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} placeholder="Beskriv vad som inte stämmer och vad som behöver ändras…" rows={5} disabled={responding} /><span className="terminal-hint">Beskrivning krävs. {comment.length}/2 000 tecken.</span>{error && <p className="terminal-error" role="alert">{error}</p>}<button className="terminal-button blue" disabled={responding || !comment.trim()}>{responding ? 'Skickar…' : 'Skicka begäran'}</button><button type="button" className="terminal-button outline" onClick={() => setChangeOpen(false)} disabled={responding}>Tillbaka</button><p className="terminal-safe-note"><ShieldCheck size={17} />Avräkningen går inte vidare till attest innan ändringen har hanterats och en ny version godkänts.</p></form></> : <>
        <div className="terminal-heading"><div><span className="terminal-eyebrow">AVRÄKNINGSNOTA</span><h1>Granska och godkänn din avräkning</h1><p className="terminal-intro">Kontrollera material, vikt och belopp innan du godkänner.</p></div></div>
        <SettlementView settlement={approval.snapshot} />
        <button className="terminal-print" onClick={() => window.print()}><Printer size={16} /> Skriv ut preliminärt underlag</button>
        <section className="terminal-terms"><h2><ShieldCheck size={23} /> Säljarens intygande</h2><p>Genom att godkänna avräkningen intygar jag att:</p><ul><li><Check size={16} />Jag äger materialet eller har rätt att sälja det.</li><li><Check size={16} />Materialet har lagligt ursprung.</li><li><Check size={16} />Uppgifterna jag lämnat är riktiga och jag har granskat artiklar, vikter och priser.</li><li><Check size={16} />Jag har informerat {companyName} om farligt innehåll och annat som kan påverka hanteringen.</li><li><Check size={16} />Om jag säljer för ett företag har jag rätt att företräda företaget.</li></ul><p className="terminal-terms-note">En ändrad avräkning behöver granskas och godkännas på nytt.</p><label className="terminal-accept"><input type="checkbox" checked={termsAccepted} onChange={event => { setTermsAccepted(event.target.checked); setError(''); }} /><span>Jag har granskat avräkningen och bekräftar intygandet.</span></label><span className="terminal-hint">Intygande {approval.snapshot.termsVersion} · avräkningsversion {approval.version}</span></section>
        {error && <p className="terminal-error" role="alert">{error}</p>}
        <div className="terminal-customer-actions"><button className="terminal-button green" disabled={responding} onClick={() => { if (!termsAccepted) { setError('Bekräfta att du har granskat avräkningen och intygandet först.'); return; } void respond('id_requested'); }}><IdCard size={20} />{responding ? 'Skickar till personal…' : 'Godkänn'}</button><button className="terminal-button outline" disabled={responding} onClick={() => { setChangeOpen(true); setError(''); window.scrollTo({ top: 0, behavior: 'instant' }); }}>Begär ändring</button></div>
      </>}
    </main>}
    <footer className="terminal-footer"><span>{intakeId ? 'Dina uppgifter granskas av personalen. Detta är inte ett kundgodkännande.' : 'Legitimationen kontrolleras av personalen innan kundgodkännandet registreras.'}</span>{session && <small>{session.terminal.name}</small>}</footer>
    {approval && waitingForId && <TerminalDialog key={`terminal-dialog:${approvalKey}`} title="Visa din legitimation" busy={responding}>
      <div className="terminal-dialog-icon"><IdCard size={36} /></div><h2>Visa din legitimation</h2><h3 className="terminal-dialog-waiting-title">Inväntar personalens bekräftelse</h3><p>Visa din legitimation för kontoristen. Personalen kontrollerar identiteten och registrerar godkännandet på sin skärm.</p><div className="terminal-waiting" role="status"><LoaderCircle size={18} className="terminal-spinner" /> Kontoristen fortsätter på sin skärm</div><p className="terminal-dialog-method">Fysisk legitimation · avräkningsversion {approval.version}</p>
    </TerminalDialog>}
  </div>;
}
