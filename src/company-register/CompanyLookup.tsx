import { useEffect, useId, useRef, useState } from 'react';
import { Building2, Check, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { CompanyLookupError, companyLookupNumberError, companyLookupScope, lookupCompany, normalizeCompanyLookupNumber, type CompanyRegisterCompany } from './client';
import './company-register.css';

export type { CompanyRegisterCompany } from './client';
export interface CompanyLookupProps {
  organisationNumber: string;
  enabled?: boolean;
  disabled?: boolean;
  /** Include the edited record and fields which applying a result would replace. */
  scopeKey?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  applyLabel?: string;
  helpText?: string;
  onApply(company: CompanyRegisterCompany): void;
}

type LookupState = { key: string; phase: 'idle' | 'loading' | 'found' | 'applied' | 'not-found' | 'unavailable' | 'error'; company?: CompanyRegisterCompany; message?: string };

function lookupFailure(error: unknown): Pick<LookupState, 'phase' | 'message'> {
  if (!(error instanceof CompanyLookupError)) return { phase: 'error', message: 'Företagsuppgifterna kunde inte hämtas. Fyll i uppgifterna manuellt eller sök igen.' };
  if (error.code === 'company_lookup_not_found') return { phase: 'not-found', message: 'Ingen träff i företagsregistret. Kontrollera organisationsnumret eller fyll i uppgifterna manuellt.' };
  if (error.code === 'company_lookup_not_configured') return { phase: 'unavailable', message: 'Företagsuppslag är inte aktiverat ännu. Du kan fylla i uppgifterna manuellt.' };
  if (error.code === 'company_lookup_rate_limited' || error.status === 429) return { phase: 'unavailable', message: 'För många sökningar just nu. Vänta en stund och försök igen, eller fyll i uppgifterna manuellt.' };
  if (error.status === 401 || error.status === 403) return { phase: 'unavailable', message: 'Företagsuppslag är inte tillgängligt med den aktuella inloggningen. Du kan fylla i uppgifterna manuellt.' };
  if (error.code === 'company_selection_changed') return { phase: 'unavailable', message: 'Inloggningen eller bolaget har ändrats. Öppna formuläret igen innan du hämtar uppgifter.' };
  if (error.code === 'company_lookup_invalid') return { phase: 'error', message: 'Organisationsnumret kunde inte användas för företagsuppslag. Kontrollera numret eller fyll i uppgifterna manuellt.' };
  return { phase: 'unavailable', message: 'Företagsregistret kunde inte nås just nu. Fyll i uppgifterna manuellt eller sök igen.' };
}

/** Preview-only assistance. Applying the preview changes editable fields, never saves a customer or tenant. */
export function CompanyLookup({ organisationNumber, enabled = true, disabled = false, scopeKey = '', requestHeaders, applyLabel = 'Använd företagsuppgifter', helpText = 'Fyller i företagsnamn, postadress och momsval när SCB har lämnat besked. Du kan ändra uppgifterna innan du sparar.', onApply }: CompanyLookupProps) {
  const id = useId();
  const number = normalizeCompanyLookupNumber(organisationNumber);
  const validation = companyLookupNumberError(organisationNumber);
  const complete = number.length >= 10;
  const scope = companyLookupScope(requestHeaders);
  const primaryKey = JSON.stringify([enabled, number, scope.key]);
  const lookupKey = JSON.stringify([primaryKey, scopeKey, disabled]);
  const [state, setState] = useState<LookupState>({ key: '', phase: 'idle' });
  const [retry, setRetry] = useState({ key: '', attempt: 0 });
  const last = useRef({ primaryKey: '', lookupKey: '', attempt: 0 });
  const latest = useRef({ lookupKey, scope, onApply });
  latest.current = { lookupKey, scope, onApply };
  const visible = state.key === lookupKey ? state : { key: lookupKey, phase: 'idle' as const };
  const retryAttempt = retry.key === lookupKey ? retry.attempt : 0;

  useEffect(() => {
    const previous = last.current;
    const manual = retryAttempt !== previous.attempt && retryAttempt > 0;
    last.current = { primaryKey, lookupKey, attempt: retryAttempt };
    const controller = new AbortController();
    if (!enabled || disabled || validation) {
      setState({ key: lookupKey, phase: 'idle' });
      return () => controller.abort();
    }
    // Another editable field changed while SCB was responding. Discard that
    // preview, but don't query the same number on every name/address keystroke.
    if (previous.primaryKey === primaryKey && previous.lookupKey !== lookupKey && !manual) {
      setState(current => current.phase === 'applied' && current.company?.organisationNumber === number
        ? { key: lookupKey, phase: 'applied', company: current.company, message: 'Företagsuppgifterna är ifyllda. Granska dem innan du sparar.' }
        : { key: lookupKey, phase: 'idle', message: 'Uppgifterna har ändrats. Sök igen om du vill hämta en ny förhandsvisning.' });
      return () => controller.abort();
    }
    setState({ key: lookupKey, phase: 'loading' });
    const initiatingScope = latest.current.scope;
    const timer = window.setTimeout(() => {
      void lookupCompany(number, { scope: initiatingScope, signal: controller.signal }).then(company => {
        if (!controller.signal.aborted && latest.current.lookupKey === lookupKey)
          setState({ key: lookupKey, phase: 'found', company });
      }).catch(error => {
        if (!controller.signal.aborted && latest.current.lookupKey === lookupKey)
          setState({ key: lookupKey, ...lookupFailure(error) });
      });
    }, manual ? 0 : 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, disabled, number, validation, primaryKey, lookupKey, retryAttempt]);

  if (!enabled) return null;
  const busy = visible.phase === 'loading';
  const company = visible.company;
  const message = validation && complete ? validation : visible.message ?? (busy
    ? 'Hämtar företagsuppgifter från SCB…'
    : !validation ? 'Företagsuppgifter hämtas när organisationsnumret är komplett.'
      : 'Skriv hela organisationsnumret för att söka i SCB:s företagsregister.');
  const apply = () => {
    if (disabled || !company || latest.current.lookupKey !== lookupKey
      || latest.current.scope.key !== companyLookupScope(requestHeaders).key) return;
    latest.current.onApply(company);
    setState({ key: lookupKey, phase: 'applied', company });
  };

  return <section className={`company-register-lookup${company ? ' has-result' : ''}`} aria-labelledby={`${id}-title`} aria-busy={busy}>
    <div className="company-register-lookup-heading">
      <span className="company-register-lookup-title" id={`${id}-title`}><Building2 size={16} aria-hidden="true" />Företagsuppslag</span>
      {!validation && <button type="button" className="company-register-lookup-search" disabled={disabled || busy} onClick={() => setRetry(value => ({ key: lookupKey, attempt: value.attempt + 1 }))}>
        {busy ? <LoaderCircle size={14} aria-hidden="true" /> : visible.phase === 'idle' ? <Search size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
        {busy ? 'Söker…' : 'Sök igen'}
      </button>}
    </div>
    <div className="company-register-lookup-status" role="status" aria-live="polite" aria-atomic="true">
      {company ? <p>{visible.phase === 'applied' ? 'Företagsuppgifterna är ifyllda. Granska dem innan du sparar.' : 'En träff hittades. Granska företagsuppgifterna innan du använder dem.'}</p> : <p className={validation && complete || visible.phase === 'error' ? 'is-warning' : ''}>{message}</p>}
    </div>
    {company && <div className="company-register-lookup-result">
      <div className="company-register-lookup-company"><strong>{company.name}</strong><span>Org.nr {company.organisationNumber.slice(0, 6)}-{company.organisationNumber.slice(6)}</span>
        {company.careOf && <span>{/^c\s*\/\s*o(?:\s|:|$)/i.test(company.careOf) ? company.careOf : `c/o ${company.careOf}`}</span>}
        {company.address && <span>{company.address}</span>}
        {(company.postalCode || company.city) && <span>{[company.postalCode.replace(/^(\d{3})(\d{2})$/, '$1 $2'), company.city].filter(Boolean).join(' ')}</span>}
        <span>Momsregistrerad: {company.vatRegistered === true ? 'Ja' : company.vatRegistered === false ? 'Nej' : 'Uppgift saknas'}</span>
        <span>Godkänd för F-skatt: {company.fTaxRegistered === true ? 'Ja' : company.fTaxRegistered === false ? 'Nej' : 'Uppgift saknas'}</span>
        <small>SCB:s företagsregister · Hämtat {new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(company.fetchedAt))}</small>
      </div>
      <button className="company-register-lookup-apply" type="button" disabled={disabled || visible.phase === 'applied'} onClick={apply}><Check size={15} aria-hidden="true" />{visible.phase === 'applied' ? 'Uppgifter ifyllda' : applyLabel}</button>
    </div>}
    {company && <p className="company-register-lookup-note">{helpText}</p>}
  </section>;
}

export default CompanyLookup;
