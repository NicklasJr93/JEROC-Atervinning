import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, ShieldCheck, WifiOff } from 'lucide-react';
import CustomerIntakeForm from './CustomerIntakeForm';
import { CompanyLookupError } from '../company-register/client';
import { lookupPublicIntakeCompany } from './company-lookup';
import { PersonLookupError } from '../person-register/client';
import { lookupPublicIntakePerson } from './person-lookup';
import { publicCustomerIntakeStateSchema, type CustomerIntakeInput, type PublicCustomerIntakeState } from './types';
import './customer-intake.css';

const tokenFromFragment = (hash: string) => /^#\/?token=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? '';
const fragmentToken = () => tokenFromFragment(window.location.hash);
const complete = (status?: string) => status === 'submitted' || status === 'applied';
class IntakeRequestError extends Error {
  constructor(public status: number) { super('Kunduppgifterna kunde inte skickas. Kontrollera anslutningen och försök igen.'); }
}

/** This page and its limited registry lookups carry the intake bearer. Staff
 * cookies, company selectors and protected customer registers are not used. */
async function publicRequest(token: string, signal: AbortSignal, command?: { requestId: string; customer: CustomerIntakeInput }): Promise<PublicCustomerIntakeState> {
  const response = await fetch(`/api/public/customer-intake${command ? '/submit' : ''}`, {
    method: command ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  if (!response.ok) throw new IntakeRequestError(response.status);
  const parsed = publicCustomerIntakeStateSchema.safeParse(await response.json());
  if (!parsed.success || command && !complete(parsed.data.intake.status)) throw new IntakeRequestError(502);
  return parsed.data;
}

type Availability = 'loading' | 'ready' | 'offline' | 'unavailable';
export default function PublicCustomerIntakeApp() {
  const [token, setToken] = useState(fragmentToken), [availability, setAvailability] = useState<Availability>('loading');
  const [state, setState] = useState<PublicCustomerIntakeState>(), [busy, setBusy] = useState(false), [logoFailed, setLogoFailed] = useState(false);
  const generation = useRef(0), active = useRef(true), locked = useRef(false), controllers = useRef(new Set<AbortController>());
  const pending = useRef<{ requestId: string; customer: CustomerIntakeInput } | undefined>(undefined);
  const currentId = useRef('');
  const navigationToken = useRef(token);
  const abort = useCallback(() => { generation.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); }, []);
  const unavailable = useCallback(() => { abort(); locked.current = true; pending.current = undefined; setBusy(false); setState(undefined); setAvailability('unavailable'); }, [abort]);
  const accept = useCallback((value: PublicCustomerIntakeState) => {
    if (!active.current || locked.current) return;
    if (Date.parse(value.intake.expiresAt) <= Date.now() || !['waiting', 'submitted', 'applied'].includes(value.intake.status)
      || currentId.current && currentId.current !== value.intake.id) { unavailable(); return; }
    currentId.current = value.intake.id; setState(value); setAvailability('ready');
  }, [unavailable]);
  const read = useCallback(async () => {
    if (!token || locked.current || !active.current) { if (!token) setAvailability('unavailable'); return; }
    const controller = new AbortController(), sequence = generation.current;
    controllers.current.add(controller);
    try {
      const value = await publicRequest(token, controller.signal);
      if (!controller.signal.aborted && active.current && sequence === generation.current) accept(value);
    } catch (error) {
      if (controller.signal.aborted || !active.current || sequence !== generation.current) return;
      if (error instanceof IntakeRequestError && [400, 401, 403, 404, 409, 410].includes(error.status)) unavailable();
      else { setState(undefined); setAvailability('offline'); }
    } finally { controllers.current.delete(controller); }
  }, [token, accept, unavailable]);

  useEffect(() => {
    document.title = 'Dina kunduppgifter · ScrapPlanner';
    const scrub = () => { if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', window.location.pathname); };
    scrub();
    let handledFragment = false, resetHandled: number | undefined;
    const markFragment = () => { handledFragment = true; window.clearTimeout(resetHandled); resetHandled = window.setTimeout(() => { handledFragment = false; }, 0); };
    const capture = (next: string) => {
      if (next && navigationToken.current === next) { scrub(); return; }
      navigationToken.current = next; abort(); pending.current = undefined; currentId.current = ''; locked.current = !next;
      setState(undefined); setBusy(false); setLogoFailed(false); setAvailability(next ? 'loading' : 'unavailable'); setToken(next); scrub();
    };
    // A fragment navigation can emit both events. replaceState scrubs the live
    // URL between them, so read the hash event's original URL and deduplicate.
    const hashchange = (event: HashChangeEvent) => { markFragment(); capture(tokenFromFragment(new URL(event.newURL).hash)); };
    const popstate = () => { const next = fragmentToken(); if (next) { markFragment(); capture(next); } else if (!handledFragment) capture(''); };
    window.addEventListener('hashchange', hashchange); window.addEventListener('popstate', popstate);
    return () => { window.clearTimeout(resetHandled); window.removeEventListener('hashchange', hashchange); window.removeEventListener('popstate', popstate); };
  }, [abort]);
  useEffect(() => {
    active.current = true; locked.current = !token; currentId.current = ''; setState(undefined); setAvailability(token ? 'loading' : 'unavailable');
    void read();
    return () => { active.current = false; abort(); };
  }, [token, read, abort]);
  useEffect(() => {
    if (!state) return;
    const timeout = window.setTimeout(unavailable, Math.max(0, Math.min(2147483647, Date.parse(state.intake.expiresAt) - Date.now())));
    return () => window.clearTimeout(timeout);
  }, [state, unavailable]);

  const companyLookup = useCallback(async (number: string, signal: AbortSignal) => {
    if (!token || locked.current || !state || state.intake.status !== 'waiting' || availability !== 'ready')
      throw new Error('Kundlänken är inte längre aktiv.');
    const sequence = generation.current, controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    controllers.current.add(controller);
    try {
      const company = await lookupPublicIntakeCompany(token, number, controller.signal);
      if (controller.signal.aborted || !active.current || sequence !== generation.current) throw new DOMException('Kundlänken har ändrats.', 'AbortError');
      return company;
    } catch (error) {
      if (!controller.signal.aborted && active.current && sequence === generation.current && error instanceof CompanyLookupError
        && [401, 403, 409, 410].includes(error.status)) unavailable();
      throw error;
    } finally { controllers.current.delete(controller); signal.removeEventListener('abort', cancel); }
  }, [token, state?.intake.id, state?.intake.status, availability, unavailable]);

  const personLookup = useCallback(async (number: string, requestId: string, signal: AbortSignal) => {
    if (!token || locked.current || !state || state.intake.status !== 'waiting' || availability !== 'ready')
      throw new Error('Kundlänken är inte längre aktiv.');
    const sequence = generation.current, controller = new AbortController(), cancel = () => controller.abort(signal.reason);
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
    controllers.current.add(controller);
    try {
      const result = await lookupPublicIntakePerson(token, number, requestId, controller.signal);
      if (controller.signal.aborted || !active.current || sequence !== generation.current) throw new DOMException('Kundlänken har ändrats.', 'AbortError');
      return result;
    } catch (failure) {
      // Manual-only/replayed lookups use 409 too. They do not invalidate the
      // intake link and must leave the customer free to finish manually.
      if (!controller.signal.aborted && active.current && sequence === generation.current && failure instanceof PersonLookupError
        && ([401, 403, 410].includes(failure.status) || failure.code === 'customer_intake_unavailable')) unavailable();
      throw failure;
    } finally { controllers.current.delete(controller); signal.removeEventListener('abort', cancel); }
  }, [token, state?.intake.id, state?.intake.status, availability, unavailable]);

  async function submit(customer: CustomerIntakeInput) {
    if (busy || !state || state.intake.status !== 'waiting' || availability !== 'ready' || locked.current) return;
    if (pending.current && JSON.stringify(pending.current.customer) !== JSON.stringify(customer))
      throw new Error('Ett tidigare utskick behöver kontrolleras innan uppgifterna ändras. Prova igen med samma uppgifter.');
    pending.current ??= { requestId: crypto.randomUUID(), customer: structuredClone(customer) };
    const sequence = generation.current, controller = new AbortController();
    controllers.current.add(controller); setBusy(true);
    try {
      const result = await publicRequest(token, controller.signal, pending.current);
      if (!controller.signal.aborted && active.current && sequence === generation.current) { accept(result); pending.current = undefined; }
    } catch (error) {
      if (controller.signal.aborted || !active.current || sequence !== generation.current) return;
      if (error instanceof IntakeRequestError && [401, 403, 404, 409, 410].includes(error.status)) { unavailable(); return; }
      if (error instanceof IntakeRequestError && [400, 422].includes(error.status)) {
        pending.current = undefined; throw new Error('Kontrollera de ifyllda uppgifterna och försök igen.');
      }
      throw new Error('Det gick inte att bekräfta att uppgifterna kom fram. Försök igen med samma uppgifter så kontrolleras ditt utskick.');
    } finally { controllers.current.delete(controller); if (active.current && sequence === generation.current) setBusy(false); }
  }

  const company = state?.company;
  let logoUrl: string | undefined;
  if (company?.logoUrl && !logoFailed) {
    try { const url = new URL(company.logoUrl, window.location.origin); if (url.origin === window.location.origin && !url.username && !url.password) logoUrl = url.href; } catch { /* The company name remains available without a valid logo. */ }
  }
  const receipt = availability === 'ready' && complete(state?.intake.status);
  return <main className="public-customer-intake">
    <div className="public-customer-intake-card">
      <header className="public-customer-intake-brand">
        {logoUrl && <img src={logoUrl} alt={company?.name} onError={() => setLogoFailed(true)} />}
        <strong>{company?.name || 'ScrapPlanner'}</strong>
      </header>
      {availability === 'loading' ? <section className="customer-intake-state" role="status"><LoaderCircle className="customer-intake-spinner" size={32} /><h1>Öppnar kunduppgifterna…</h1></section>
        : availability === 'unavailable' ? <section className="customer-intake-state"><CircleAlert size={36} /><h1>Länken kan inte användas</h1><p>Den kan ha gått ut eller avslutats. Be personalen om en ny länk.</p></section>
        : availability === 'offline' ? <section className="customer-intake-state"><WifiOff size={36} /><h1>Kunde inte öppna formuläret</h1><p>Kontrollera anslutningen och försök igen.</p><button type="button" className="customer-intake-submit" onClick={() => { setAvailability('loading'); void read(); }}>Försök igen</button></section>
        : receipt ? <section className="customer-intake-state customer-intake-receipt"><CheckCircle2 size={44} /><h1>Tack! Dina uppgifter är skickade</h1><p>Personalen tar emot dina uppgifter och kopplar dem till din inlämning.</p><p>Du kan stänga sidan.</p></section>
        : <><div className="customer-intake-intro"><span><ShieldCheck size={18} />Till din inlämning</span><h1>Dina kunduppgifter</h1><p>Fyra korta steg, så hjälper personalen dig vidare.</p></div><CustomerIntakeForm key={`${token}/${state?.intake.id}`} disabled={busy} onSubmit={submit} lookupCompany={companyLookup} lookupPerson={personLookup} lookupContextKey={state?.intake.id} /></>}
      <footer className="public-customer-intake-footer">Skickat via <img src="/images/scrapplanner-logo.png" alt="ScrapPlanner" /></footer>
    </div>
  </main>;
}
