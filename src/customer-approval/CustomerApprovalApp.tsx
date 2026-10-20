import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, CheckCircle2, CircleAlert, IdCard, LoaderCircle, MessageSquare, ShieldCheck, WifiOff } from 'lucide-react';
import { SettlementView } from '../terminal/SettlementView';
import { CustomerApprovalError, readCustomerApproval, respondToCustomerApproval, type CustomerApprovalState } from './client';
import '../terminal/terminal.css';
import './customer-approval.css';

type Availability = 'loading' | 'ready' | 'offline' | 'unavailable';
const fragmentToken = () => /^#\/?token=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? '';
const unavailableError = (error: unknown) => error instanceof CustomerApprovalError && [400, 401, 403, 404, 409, 410].includes(error.status);
const approvalIdentity = (state: CustomerApprovalState) => `${state.approval.id}/${state.approval.version}/${state.approval.snapshot.hash}`;

function PendingIdDialog() {
  const dialog = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement, bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    dialog.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Tab') { event.preventDefault(); dialog.current?.focus({ preventScroll: true }); } };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = bodyOverflow; document.documentElement.style.overflow = htmlOverflow;
      document.removeEventListener('keydown', keydown);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className="terminal-dialog-backdrop customer-approval-id-backdrop"><div ref={dialog} tabIndex={-1}
    className="terminal-dialog" role="dialog" aria-modal="true" aria-labelledby="public-approval-id-title">
    <div className="terminal-dialog-icon"><IdCard size={36} /></div>
    <h2 id="public-approval-id-title">Visa din legitimation</h2>
    <h3 className="terminal-dialog-waiting-title">Inväntar ID-kontroll</h3>
    <p>Visa din legitimation för kontoristen. Personalen kontrollerar din identitet och bekräftar godkännandet på sin skärm.</p>
    <div className="terminal-waiting" role="status"><LoaderCircle size={18} className="terminal-spinner" />Inväntar personalens bekräftelse</div>
    <p className="terminal-dialog-method">Avräkningen är ännu inte slutligt godkänd.</p>
  </div></div>, document.body);
}

export default function CustomerApprovalApp() {
  const [token, setToken] = useState(fragmentToken);
  const [availability, setAvailability] = useState<Availability>('loading');
  const [state, setState] = useState<CustomerApprovalState>();
  const [termsAccepted, setTermsAccepted] = useState(false), [changing, setChanging] = useState(false), [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  const generation = useRef(0), sequence = useRef(0), mounted = useRef(false), closed = useRef(false), busyRef = useRef(false);
  const controllers = useRef(new Set<AbortController>()), pendingRead = useRef<Promise<void> | undefined>(undefined);
  const acceptedIdentity = useRef(''), lastUpdated = useRef(0), lastRevision = useRef<number | undefined>(undefined);
  const lastStatus = useRef('');
  const resetForm = useCallback(() => { setTermsAccepted(false); setChanging(false); setComment(''); setActionError(''); setBusy(false); busyRef.current = false; }, []);
  const abortRequests = useCallback(() => { ++sequence.current; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); pendingRead.current = undefined; }, []);
  const unavailable = useCallback(() => {
    closed.current = true; abortRequests(); setState(undefined); setAvailability('unavailable'); resetForm();
  }, [abortRequests, resetForm]);
  const accept = useCallback((value: CustomerApprovalState) => {
    if (!mounted.current || closed.current) return;
    const identity = approvalIdentity(value), timestamp = Date.parse(value.approval.updatedAt);
    if (acceptedIdentity.current && acceptedIdentity.current !== identity) { unavailable(); return; }
    if ((value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) || ['expired', 'cancelled'].includes(value.approval.status)) { unavailable(); return; }
    if (timestamp < lastUpdated.current || value.approval.revision !== undefined && lastRevision.current !== undefined && value.approval.revision < lastRevision.current) return;
    if ((['id_requested', 'change_requested', 'approved', 'attested'].includes(lastStatus.current) && value.approval.status === 'waiting')
      || (['approved', 'attested'].includes(lastStatus.current) && !['approved', 'attested'].includes(value.approval.status))
      || (lastStatus.current === 'attested' && value.approval.status !== 'attested')) return;
    acceptedIdentity.current = identity; lastUpdated.current = timestamp; lastRevision.current = value.approval.revision;
    lastStatus.current = value.approval.status;
    setState(value); setAvailability('ready'); setActionError('');
    if (value.approval.status !== 'waiting') { setTermsAccepted(false); setChanging(false); setComment(''); }
  }, [unavailable]);
  const read = useCallback((): Promise<void> => {
    if (!token || !mounted.current || closed.current || busyRef.current || document.visibilityState === 'hidden') return Promise.resolve();
    if (pendingRead.current) return pendingRead.current;
    const activeGeneration = generation.current, activeSequence = ++sequence.current, controller = new AbortController();
    controllers.current.add(controller);
    const operation = readCustomerApproval(token, controller.signal).then(value => {
      if (!controller.signal.aborted && activeGeneration === generation.current && activeSequence === sequence.current && document.visibilityState !== 'hidden') accept(value);
    }).catch(error => {
      if (controller.signal.aborted || !mounted.current || activeGeneration !== generation.current || activeSequence !== sequence.current) return;
      if (unavailableError(error)) unavailable();
      else { setState(undefined); setAvailability('offline'); resetForm(); }
    }).finally(() => { controllers.current.delete(controller); if (pendingRead.current === operation) pendingRead.current = undefined; });
    pendingRead.current = operation; return operation;
  }, [token, accept, unavailable, resetForm]);

  useEffect(() => {
    document.title = 'Granska avräkning · ScrapPlanner';
    const capture = () => {
      const next = fragmentToken();
      abortRequests(); setState(undefined); resetForm(); setAvailability(next ? 'loading' : 'unavailable');
      acceptedIdentity.current = ''; lastUpdated.current = 0; lastRevision.current = undefined; lastStatus.current = ''; closed.current = !next;
      setToken(next);
      // Tokens stay in this page's memory, never the browsing history or a query.
      if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
    };
    if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname);
    window.addEventListener('hashchange', capture); window.addEventListener('popstate', capture);
    return () => { window.removeEventListener('hashchange', capture); window.removeEventListener('popstate', capture); };
  }, [abortRequests, resetForm]);

  useEffect(() => {
    mounted.current = true; closed.current = !token; ++generation.current;
    acceptedIdentity.current = ''; lastUpdated.current = 0; lastRevision.current = undefined; lastStatus.current = '';
    setState(undefined); resetForm(); setAvailability(token ? 'loading' : 'unavailable');
    void read();
    const timer = window.setInterval(() => void read(), 3000);
    const visibility = () => {
      if (document.visibilityState === 'hidden') { abortRequests(); setState(undefined); resetForm(); setAvailability('loading'); }
      else void read();
    };
    const pagehide = () => { abortRequests(); setState(undefined); resetForm(); };
    const pageshow = () => { if (!closed.current) void read(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow);
    return () => {
      mounted.current = false; ++generation.current; abortRequests(); window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow);
    };
  }, [token, read, resetForm, abortRequests]);

  useEffect(() => {
    if (!state?.expiresAt) return;
    const timer = window.setTimeout(unavailable, Math.max(0, Math.min(2147483647, Date.parse(state.expiresAt) - Date.now())));
    return () => window.clearTimeout(timer);
  }, [state, unavailable]);

  async function respond(action: 'id_requested' | 'change_requested') {
    if (!state || state.approval.status !== 'waiting' || availability !== 'ready' || busyRef.current || closed.current
      || action === 'id_requested' && !termsAccepted || action === 'change_requested' && !comment.trim()) return;
    abortRequests(); busyRef.current = true; setBusy(true); setActionError('');
    const controller = new AbortController(), activeGeneration = generation.current, activeSequence = ++sequence.current;
    controllers.current.add(controller);
    try {
      const value = await respondToCustomerApproval(token, { action, termsAccepted, ...(action === 'change_requested' ? { comment: comment.trim() } : {}) }, controller.signal);
      if (!controller.signal.aborted && mounted.current && activeGeneration === generation.current && activeSequence === sequence.current) accept(value);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || activeGeneration !== generation.current || activeSequence !== sequence.current) return;
      if (unavailableError(error)) unavailable();
      else { setState(undefined); setAvailability('offline'); resetForm(); setActionError('Kontakten avbröts. Vi kontrollerar ditt svar när anslutningen är tillbaka.'); }
    } finally { controllers.current.delete(controller); if (mounted.current && activeGeneration === generation.current && activeSequence === sequence.current) { busyRef.current = false; setBusy(false); } }
  }

  const current = availability === 'ready' ? state : undefined, status = current?.approval.status;
  const approved = status === 'approved' || status === 'attested';
  return <div className="terminal-app customer-approval-app">
    <header className="terminal-header"><img src="/images/scrapplanner-logo.png" alt="ScrapPlanner" />{current && <span className="customer-approval-company">{current.companyName}</span>}</header>
    {availability === 'unavailable' ? <main className="terminal-welcome"><div className="terminal-welcome-icon offline"><CircleAlert size={46} /></div><h1>Länken kan inte användas</h1><p>Den kan ha gått ut eller ersatts. Be kontoret skicka en ny länk till den aktuella avräkningen.</p></main>
      : availability === 'loading' ? <main className="terminal-welcome" role="status"><LoaderCircle className="terminal-spinner" size={32} /><h1>Hämtar avräkningen…</h1></main>
        : availability === 'offline' ? <main className="terminal-welcome"><div className="terminal-welcome-icon offline"><WifiOff size={46} /></div><h1>Kontakten avbröts</h1><p>{actionError || 'Avräkningen visas igen när vi har kontrollerat anslutningen. Försök om en stund.'}</p><button className="terminal-button outline" onClick={() => void read()}>Försök igen</button></main>
          : status === 'id_requested' ? <><main className="terminal-welcome" aria-hidden="true" /><PendingIdDialog /></>
            : approved ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><CheckCircle2 size={52} /></div><h1>Tack, avräkningen är godkänd</h1><p>Personalen har bekräftat godkännandet och hanterar nästa steg. Detta innebär inte att en utbetalning har genomförts.</p></main>
              : status === 'change_requested' ? <main className="terminal-welcome" aria-live="polite"><div className="terminal-welcome-icon"><MessageSquare size={48} /></div><h1>Ändringsbegäran skickad</h1><p>Kontoret går igenom din kommentar. Du får en ny länk om avräkningen ändras.</p></main>
                : current ? <main className="terminal-settlement">
                  {changing ? <><button className="terminal-back" disabled={busy} onClick={() => setChanging(false)}><ArrowLeft size={18} />Tillbaka till avräkningen</button><h1>Begär ändring</h1><p className="terminal-intro">Beskriv vad som inte stämmer så hjälper kontoret dig.</p><form className="terminal-change-form" onSubmit={event => { event.preventDefault(); void respond('change_requested'); }}><label htmlFor="public-approval-comment">Beskriv vad som behöver ändras</label><textarea id="public-approval-comment" value={comment} onChange={event => setComment(event.target.value)} maxLength={2000} required rows={5} disabled={busy} /><span className="terminal-hint">Beskrivning krävs. {comment.length}/2 000 tecken.</span><button className="terminal-button blue" disabled={busy || !comment.trim()}>{busy ? 'Skickar…' : 'Skicka begäran'}</button></form></>
                    : <><div className="terminal-heading"><span className="terminal-eyebrow">AVRÄKNINGSNOTA</span><h1>Granska och godkänn din avräkning</h1><p className="terminal-intro">Kontrollera material, vikt och belopp innan du godkänner.</p></div>
                      <SettlementView settlement={current.approval.snapshot} />
                      <section className="terminal-terms"><h2><ShieldCheck size={23} />Säljarens intygande</h2><p>Genom att godkänna avräkningen intygar jag att:</p><ul><li><Check size={16} />Jag äger materialet eller har rätt att sälja det.</li><li><Check size={16} />Materialet har lagligt ursprung.</li><li><Check size={16} />Uppgifterna jag lämnat är riktiga och jag har granskat artiklar, vikter och priser.</li><li><Check size={16} />Jag har informerat {current.companyName} om farligt innehåll och annat som kan påverka hanteringen.</li><li><Check size={16} />Om jag säljer för ett företag har jag rätt att företräda företaget.</li></ul><p className="terminal-terms-note">En ändrad avräkning behöver granskas och godkännas på nytt.</p><label className="terminal-accept"><input type="checkbox" checked={termsAccepted} disabled={busy} onChange={event => setTermsAccepted(event.target.checked)} /><span>Jag har granskat avräkningen och bekräftar intygandet.</span></label><span className="terminal-hint">Intygande {current.approval.snapshot.termsVersion} · avräkningsversion {current.approval.version}</span></section>
                      <div className="terminal-customer-actions"><button type="button" className="terminal-button green" disabled={busy || !termsAccepted} onClick={() => void respond('id_requested')}>{busy ? <><LoaderCircle size={18} className="terminal-spinner" />Skickar…</> : <><ShieldCheck size={20} />Godkänn</>}</button><button type="button" className="terminal-button outline" disabled={busy} onClick={() => setChanging(true)}><MessageSquare size={19} />Begär ändring</button></div><p className="terminal-safe-note"><IdCard size={17} />Godkännandet registreras efter att kontoristen har kontrollerat din legitimation.</p></>}
                </main> : null}
    <footer className="terminal-footer">ScrapPlanner · Kundgranskning</footer>
  </div>;
}
