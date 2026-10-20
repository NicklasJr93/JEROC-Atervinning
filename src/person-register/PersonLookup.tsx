import { useEffect, useId, useRef, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, UserRound } from 'lucide-react';
import { companyLookupScope } from '../company-register/client';
import { lookupPerson, normalizePersonLookupNumber, personLookupFailure, personLookupNumberError, type PersonRegisterLookupResult, type PersonRegisterPerson } from './client';
import '../company-register/company-register.css';

interface PersonLookupProps {
  personalNumber: string;
  enabled?: boolean;
  disabled?: boolean;
  scopeKey?: string;
  lookupContextKey?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  onApply(person: PersonRegisterPerson): void;
}
type LookupState = { key: string; phase: 'idle' | 'loading' | 'found' | 'applied' | 'existing' | 'failed'; person?: PersonRegisterPerson; message?: string };

/** A request ID belongs to this form, principal and full personal number. Retrying
 * a lost response reuses it, rather than authorising another provider operation. */
export default function PersonLookup({ personalNumber, enabled = true, disabled = false, scopeKey = '', lookupContextKey = '', requestHeaders, onApply }: PersonLookupProps) {
  const id = useId(), number = normalizePersonLookupNumber(personalNumber), validation = personLookupNumberError(personalNumber);
  const scope = companyLookupScope(requestHeaders);
  const identityKey = JSON.stringify([scope.key, lookupContextKey, number]);
  const key = JSON.stringify([identityKey, scopeKey, enabled, disabled]);
  const [state, setState] = useState<LookupState>({ key: '', phase: 'idle' });
  const [retry, setRetry] = useState({ key: '', attempt: 0 });
  const requests = useRef(new Map<string, string>()), attempted = useRef(new Set<string>());
  const results = useRef(new Map<string, PersonRegisterLookupResult>());
  const applied = useRef(new Set<string>());
  const previous = useRef({ key: '', identityKey: '', retry: 0 });
  const latest = useRef({ key, scope, onApply }); latest.current = { key, scope, onApply };
  const attempt = retry.key === key ? retry.attempt : 0;
  const visible = state.key === key ? state : { key, phase: 'idle' as const };
  useEffect(() => {
    const last = previous.current, manual = attempt > 0 && (last.key !== key || last.retry !== attempt);
    // Returning to a previous identity may reuse its in-memory preview, but
    // its old application has been cleared from the customer's editable fields.
    if (last.identityKey !== identityKey) applied.current.delete(last.identityKey);
    previous.current = { key, identityKey, retry: attempt };
    const controller = new AbortController();
    if (!enabled || disabled || validation) { setState({ key, phase: 'idle' }); return () => controller.abort(); }
    const cached = results.current.get(identityKey);
    if (cached) {
      setState(cached.existing ? { key, phase: 'existing' } : { key, phase: applied.current.has(identityKey) ? 'applied' : 'found', person: cached.person });
      return () => controller.abort();
    }
    if (!manual && attempted.current.has(identityKey)) {
      setState({ key, phase: 'idle', message: 'Uppgifterna har ändrats. Fyll i manuellt eller sök igen med samma sökning.' });
      return () => controller.abort();
    }
    setState({ key, phase: 'loading' });
    const initiatingScope = latest.current.scope;
    const timer = window.setTimeout(() => {
      let requestId = requests.current.get(identityKey);
      if (!requestId) { requestId = crypto.randomUUID(); requests.current.set(identityKey, requestId); }
      attempted.current.add(identityKey);
      void lookupPerson(number, { requestId, scope: initiatingScope, signal: controller.signal }).then(result => {
        if (controller.signal.aborted || latest.current.key !== key) return;
        results.current.set(identityKey, result);
        setState(result.existing ? { key, phase: 'existing' } : { key, phase: 'found', person: result.person });
      }).catch(error => {
        if (!controller.signal.aborted && latest.current.key === key) setState({ key, phase: 'failed', message: personLookupFailure(error) });
      });
    }, manual ? 0 : 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, disabled, validation, identityKey, key, number, attempt]);
  if (!enabled) return null;
  const person = visible.person, busy = visible.phase === 'loading';
  const message = validation || (busy ? 'Hämtar namn och postadress…' : visible.phase === 'existing'
    ? 'Kunden finns redan i företagets kundregister. Välj den befintliga kunden i kundlistan.' : visible.message || 'Namn och postadress hämtas när personnumret är komplett. Du kan alltid fylla i manuellt.');
  const apply = () => {
    if (disabled || !person || latest.current.key !== key || latest.current.scope.key !== companyLookupScope(requestHeaders).key) return;
    applied.current.add(identityKey); latest.current.onApply(person); setState({ key, phase: 'applied', person });
  };
  return <section className={`company-register-lookup${person ? ' has-result' : ''}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="company-register-lookup-heading"><span className="company-register-lookup-title" id={`${id}-title`}><UserRound size={16} aria-hidden="true" />Personuppslag</span>
      {!validation && !person && visible.phase !== 'existing' && <button type="button" className="company-register-lookup-search" disabled={disabled || busy}
        onClick={() => setRetry(value => ({ key, attempt: value.attempt + 1 }))}>{busy ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}{busy ? 'Söker…' : 'Sök igen'}</button>}</div>
    <div className="company-register-lookup-status" role="status" aria-live="polite" aria-atomic="true"><p>{person ? visible.phase === 'applied'
      ? 'Personuppgifterna är ifyllda. Granska dem innan du sparar.' : 'En träff hittades. Granska uppgifterna innan du använder dem.' : message}</p></div>
    {person && <><div className="company-register-lookup-result"><div className="company-register-lookup-company"><strong>{person.name}</strong>
      {person.careOf && <span>{person.careOf}</span>}{person.address && <span>{person.address}</span>}<span>{[person.postalCode.replace(/^(\d{3})(\d{2})$/, '$1 $2'), person.city].filter(Boolean).join(' ')}</span>
      <small>Roaring · Hämtat {new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(person.fetchedAt))}</small></div>
      <button className="company-register-lookup-apply" type="button" disabled={disabled || visible.phase === 'applied'} onClick={apply}><Check size={15} />{visible.phase === 'applied' ? 'Uppgifter ifyllda' : 'Använd personuppgifter'}</button></div>
      <p className="company-register-lookup-note">Fyller tomma namn- och adressfält. Uppslaget är inte en legitimationskontroll. Telefonnummer, e-post och betalningsuppgifter fylls i separat.</p></>}
  </section>;
}
