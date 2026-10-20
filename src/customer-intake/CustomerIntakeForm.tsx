import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Building2, Check, CreditCard, LoaderCircle, Mail, MapPin, RefreshCw, UserRound } from 'lucide-react';
import { z } from 'zod';
import CustomerIdentityInput from '../customer-identity/CustomerIdentityInput';
import { addressError, bankRecipientError, customerIdentifierError, normalizeAddress, normalizeCustomerDetails, normalizePaymentDetails, phoneNumberError, validateCustomerDetails } from '../data-format';
import { CompanyLookupError, companyLookupNumberError, formatCompanyRegisterAddress, normalizeCompanyLookupNumber } from '../company-register/client';
import type { PaymentDetails } from '../payment-details';
import MobilePaymentFields from '../pages/MobilePaymentFields';
import type { CustomerIntakeCompanyLookup } from './company-lookup';
import { customerIntakeInputSchema, type CustomerIntakeInput } from './types';
import './customer-intake.css';

export interface CustomerIntakeFormProps {
  onSubmit(customer: CustomerIntakeInput): Promise<void>;
  lookupCompany?: CustomerIntakeCompanyLookup;
  lookupContextKey?: string;
  disabled?: boolean;
  initialValues?: Partial<CustomerIntakeInput>;
  submitLabel?: string;
  autoComplete?: 'on' | 'off';
}
type Step = 1 | 2 | 3 | 4;
type AutoField = 'name' | 'address' | 'postalCode' | 'city' | 'phone' | 'email';
const autoFields: AutoField[] = ['name', 'address', 'postalCode', 'city', 'phone', 'email'];
const addressFields: AutoField[] = ['address', 'postalCode', 'city'];
const stepNames = ['Dina uppgifter', 'Kontaktuppgifter', 'Utbetalning', 'Referens & ursprung'];
const emptyCustomer = (): CustomerIntakeInput => ({ type: 'Privatperson', name: '', number: '', phone: '', email: '', address: '', postalCode: '', city: '', countryCode: 'SE' });
const lookupFailure = (error: unknown) => error instanceof CompanyLookupError && error.code === 'company_lookup_not_found'
  ? 'Ingen träff i SCB. Kontrollera organisationsnumret eller fyll i uppgifterna manuellt.'
  : error instanceof CompanyLookupError && error.status === 429
    ? 'För många sökningar just nu. Fyll i uppgifterna manuellt eller försök igen om en stund.'
    : 'Företagsuppgifterna kunde inte hämtas. Du kan fylla i allt manuellt och fortsätta.';

/** Terminal and SMS share the wizard. The injected lookup remains bound to
 * this intake's narrow bearer or paired terminal session. */
export default function CustomerIntakeForm({ onSubmit, lookupCompany, lookupContextKey = '', disabled = false,
  initialValues, submitLabel = 'Skicka mina uppgifter', autoComplete = 'on' }: CustomerIntakeFormProps) {
  const [customer, setCustomer] = useState<CustomerIntakeInput>(() => ({ ...emptyCustomer(), ...initialValues, paymentProfile: undefined }));
  const [step, setStep] = useState<Step>(1), [includeContact, setIncludeContact] = useState(true);
  const [includeBank, setIncludeBank] = useState(false);
  const [bank, setBank] = useState<PaymentDetails>({ method: 'bank', bankType: 'account' });
  const [reference, setReference] = useState(initialValues?.reference ?? '');
  const [originEdited, setOriginEdited] = useState(Boolean(initialValues?.originDetails));
  const [origin, setOrigin] = useState(() => normalizeAddress(initialValues?.originDetails ?? initialValues ?? ''));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [lookup, setLookup] = useState<{ key: string; phase: 'loading' | 'filled' | 'failed'; message?: string }>();
  const [retry, setRetry] = useState(0);
  const errorRef = useRef<HTMLParagraphElement>(null), headingRef = useRef<HTMLHeadingElement>(null);
  const flight = useRef(false), mounted = useRef(true), id = useId();
  const touched = useRef(new Set<AutoField>(autoFields.filter(field => Boolean(initialValues?.[field]))));
  const filled = useRef<Partial<Record<AutoField, string>>>({}), filledKey = useRef('');
  const lookupEpoch = useRef(0), lookupController = useRef<AbortController | undefined>(undefined);
  const completedLookup = useRef('');
  const number = normalizeCompanyLookupNumber(customer.number);
  const eligibleLookup = customer.type !== 'Privatperson' && !companyLookupNumberError(number);
  const lookupKey = JSON.stringify([lookupContextKey, number, customer.type]);
  const latestLookup = useRef(lookupKey); latestLookup.current = lookupKey;
  const originValue = originEdited ? origin : normalizeAddress(customer);
  const blocked = disabled || busy;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; lookupEpoch.current++; lookupController.current?.abort(); }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); headingRef.current?.scrollIntoView({ block: 'nearest' }); }, [step]);
  useEffect(() => {
    const generation = ++lookupEpoch.current, controller = new AbortController(); lookupController.current = controller;
    if (filledKey.current !== lookupKey) {
      const previous = filled.current; filled.current = {}; filledKey.current = lookupKey; completedLookup.current = '';
      // Never retain an earlier company's automatic values for a new identity.
      // Deliberate customer edits, including an empty field, remain untouched.
      if (Object.keys(previous).length) setCustomer(current => {
        const next = { ...current };
        for (const field of autoFields) if (!touched.current.has(field) && previous[field] !== undefined && current[field] === previous[field]) next[field] = '';
        return next;
      });
    }
    if (!lookupCompany || !eligibleLookup) { setLookup(undefined); return () => controller.abort(); }
    const attemptKey = JSON.stringify([lookupKey, retry]);
    if (blocked || completedLookup.current === attemptKey) return () => controller.abort();
    setLookup({ key: lookupKey, phase: 'loading' });
    const timer = window.setTimeout(() => {
      void lookupCompany(number, controller.signal).then(company => {
        if (!mounted.current || controller.signal.aborted || lookupEpoch.current !== generation || latestLookup.current !== lookupKey) return;
        completedLookup.current = attemptKey;
        const values: Partial<Record<AutoField, string>> = { name: company.name, address: formatCompanyRegisterAddress(company),
          postalCode: company.postalCode, city: company.city, phone: company.phone, email: company.email };
        setCustomer(current => {
          if (latestLookup.current !== lookupKey || normalizeCompanyLookupNumber(current.number) !== number) return current;
          const next = { ...current }, addressTouched = addressFields.some(field => touched.current.has(field));
          for (const field of autoFields) {
            const value = values[field];
            if (value === undefined || touched.current.has(field) || addressTouched && addressFields.includes(field)) continue;
            if (!current[field] || current[field] === filled.current[field]) { next[field] = value; filled.current[field] = value; }
          }
          return next;
        });
        setLookup({ key: lookupKey, phase: 'filled' });
      }).catch(failure => {
        if (mounted.current && !controller.signal.aborted && lookupEpoch.current === generation && latestLookup.current === lookupKey) {
          completedLookup.current = attemptKey;
          setLookup({ key: lookupKey, phase: 'failed', message: lookupFailure(failure) });
        }
      });
    }, retry ? 0 : 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [lookupCompany, eligibleLookup, lookupKey, number, blocked, retry]);

  const change = (field: keyof CustomerIntakeInput, value: string) => {
    if (autoFields.includes(field as AutoField)) touched.current.add(field as AutoField);
    if (field === 'number' && normalizeCompanyLookupNumber(value) !== number || field === 'type' && value !== customer.type) {
      lookupEpoch.current++; lookupController.current?.abort();
    }
    if (field === 'phone' || field === 'email') setIncludeContact(true);
    setCustomer(current => ({ ...current, [field]: value })); setError('');
  };
  const changeOrigin = (field: 'address' | 'postalCode' | 'city', value: string) => {
    setOrigin({ ...originValue, [field]: value }); setOriginEdited(true); setError('');
  };
  function stepError(value: Step): string {
    if (value === 1) return !customer.number.trim() ? 'Ange organisations- eller personnummer.'
      : customerIdentifierError(customer.type, customer.number) || (!customer.name.trim() ? 'Ange ditt namn eller företagsnamn.'
        : customer.name.normalize('NFKC').trim().length > 200 ? 'Namnet får innehålla högst 200 tecken.' : '') || addressError(customer) || '';
    if (value === 2) return phoneNumberError(customer.phone) || (customer.email && !z.string().trim().email().max(200).safeParse(customer.email).success
      ? 'Ange en giltig e-postadress med högst 200 tecken, eller lämna fältet tomt.' : '');
    if (value === 3 && includeBank) return bankRecipientError(normalizePaymentDetails({ ...bank, method: 'bank', holder: bank.holder?.trim() || customer.name.trim() })) || '';
    return '';
  }
  function next() {
    if (blocked) return;
    const issue = stepError(step); if (issue) { setError(issue); return; }
    if (step === 2) setIncludeContact(true);
    setError(''); setNotice(''); setStep(current => Math.min(4, current + 1) as Step);
  }
  function goBack() { if (!blocked) { setError(''); setNotice(''); setStep(current => Math.max(1, current - 1) as Step); } }
  async function finish(skipDetails = false) {
    if (blocked || flight.current) return;
    const normalizedOrigin = normalizeAddress(originValue);
    const input = normalizeCustomerDetails({ type: customer.type, number: customer.number, name: customer.name.trim(),
      email: includeContact ? customer.email.trim() : '', phone: includeContact ? customer.phone : '',
      address: customer.address, postalCode: customer.postalCode, city: customer.city, countryCode: 'SE',
      ...(includeBank ? { paymentProfile: { ...bank, method: 'bank' as const, holder: bank.holder?.trim() || customer.name.trim() } } : {}),
      ...(!skipDetails && reference.trim() ? { reference: reference.trim() } : {}),
      ...(!skipDetails && normalizedOrigin.address ? { originDetails: { ...normalizedOrigin, countryCode: 'SE' as const } } : {}),
    });
    for (const previousStep of [1, ...(includeContact ? [2] : []), 3] as Step[]) {
      const previousIssue = stepError(previousStep);
      if (previousIssue) { setStep(previousStep); setError(previousIssue); return; }
    }
    const parsed = customerIntakeInputSchema.safeParse(input);
    const issue = (!skipDetails && addressError(originValue)) || validateCustomerDetails(input)
      || (!parsed.success ? 'Kontrollera de ifyllda uppgifterna.' : '');
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      setStep(field === 'phone' || field === 'email' ? 2 : field === 'paymentProfile' ? 3 : field === 'reference' || field === 'originDetails' ? 4 : 1);
    }
    if (issue) { setError(issue); return; }
    // A retry after an uncertain submit must carry identical customer data;
    // an optional lookup may not refill fields between the two attempts.
    completedLookup.current = JSON.stringify([lookupKey, retry]); lookupEpoch.current++; lookupController.current?.abort();
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try { await onSubmit(input); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Uppgifterna kunde inte skickas. Försök igen.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (step < 4) next(); else void finish(); }
  const activeLookup = lookup?.key === lookupKey ? lookup : undefined;

  return <form className="customer-intake-form" onSubmit={submit} autoComplete={autoComplete} noValidate>
    <nav className="customer-intake-progress" aria-label="Formulärets steg"><p aria-live="polite">Steg {step} av 4</p>
      <ol>{stepNames.map((name, index) => <li key={name} className={step > index + 1 ? 'complete' : step === index + 1 ? 'current' : ''}
        aria-current={step === index + 1 ? 'step' : undefined}><span>{step > index + 1 ? <Check size={14} /> : index + 1}</span><small>{name}</small></li>)}</ol>
    </nav>
    <fieldset disabled={blocked} className="customer-intake-fields">
      {step === 1 && <section className="customer-intake-section" aria-labelledby={`${id}-step-title`}>
        <h2 id={`${id}-step-title`} ref={headingRef} tabIndex={-1}>{customer.type === 'Privatperson' ? <UserRound size={20} /> : <Building2 size={20} />}Dina uppgifter</h2>
        <CustomerIdentityInput value={customer.number} type={customer.type} disabled={blocked} autoDetect={!initialValues?.number}
          onChange={value => change('number', value)} onTypeChange={value => change('type', value)} />
        {eligibleLookup && lookupCompany && <div className={`customer-intake-lookup ${activeLookup?.phase ?? ''}`} aria-live="polite" role="status">
          <span>{activeLookup?.phase === 'loading' ? <LoaderCircle size={17} className="customer-intake-spinner" /> : <Building2 size={17} />}
            {activeLookup?.phase === 'loading' ? 'Hämtar företagsuppgifter från SCB…' : activeLookup?.phase === 'filled'
              ? 'Företagsuppgifter hämtade från SCB. Granska dem och ändra det som behövs.' : activeLookup?.message || 'Du kan fylla i uppgifterna manuellt.'}</span>
          {activeLookup?.phase === 'failed' && <button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />Sök igen</button>}
        </div>}
        <label>{customer.type === 'Privatperson' ? 'Namn' : 'Företagsnamn'}<input value={customer.name} onChange={event => change('name', event.target.value)}
          autoComplete={autoComplete === 'off' ? 'off' : customer.type === 'Privatperson' ? 'name' : 'organization'} maxLength={200} required /></label>
        <label>Postadress<input autoComplete={autoComplete === 'off' ? 'off' : 'street-address'} value={customer.address} maxLength={300} onChange={event => change('address', event.target.value)} /></label>
        <div className="customer-intake-grid"><label>Postnummer<input inputMode="numeric" autoComplete={autoComplete === 'off' ? 'off' : 'postal-code'} value={customer.postalCode} maxLength={20} onChange={event => change('postalCode', event.target.value)} /></label>
          <label>Ort<input autoComplete={autoComplete === 'off' ? 'off' : 'address-level2'} value={customer.city} maxLength={200} onChange={event => change('city', event.target.value)} /></label></div>
      </section>}
      {step === 2 && <section className="customer-intake-section" aria-labelledby={`${id}-step-title`}>
        <h2 id={`${id}-step-title`} ref={headingRef} tabIndex={-1}><Mail size={20} />Kontaktuppgifter</h2>
        <div className="customer-intake-grid"><label>Telefonnummer<input type="tel" autoComplete={autoComplete === 'off' ? 'off' : 'tel'} value={customer.phone} maxLength={80} onChange={event => change('phone', event.target.value)} /></label>
          <label>E-postadress<input type="email" autoComplete={autoComplete === 'off' ? 'off' : 'email'} value={customer.email} maxLength={200} onChange={event => change('email', event.target.value)} aria-describedby={`${id}-email-help`} /></label></div>
        <p id={`${id}-email-help`} className="customer-intake-help"><Mail size={16} />Används för kvitton och information om din inlämning – ingen reklam. Kontaktuppgifterna är valfria.</p>
      </section>}
      {step === 3 && <section className="customer-intake-section" aria-labelledby={`${id}-step-title`}>
        <h2 id={`${id}-step-title`} ref={headingRef} tabIndex={-1}><CreditCard size={20} />Utbetalning</h2>
        <p id={`${id}-bank-help`} className="customer-intake-help">Sparas på ditt kundkort för kommande utbetalningar. Du behöver normalt bara fylla i det en gång. Det går bra att hoppa över.</p>
        <label className="customer-intake-bank-toggle"><input type="checkbox" checked={includeBank} aria-describedby={`${id}-bank-help`}
          onChange={event => { setIncludeBank(event.target.checked); setError(''); if (event.target.checked) setBank(current => ({ ...current, holder: current.holder || customer.name.trim() })); }} />Lägg till bankuppgifter</label>
        {includeBank && <MobilePaymentFields bankOnly value={bank} onChange={value => { if (value.method === 'bank') { setBank(value); setError(''); } }} />}
        <button type="button" className="customer-intake-swish" aria-disabled="true" onClick={() => setNotice('Kommer snart')}><img src="/images/swish-symbol.svg" alt="" />Swish – kommer snart</button>
        {notice && <p className="customer-intake-notice" role="status">{notice}</p>}
      </section>}
      {step === 4 && <section className="customer-intake-section" aria-labelledby={`${id}-step-title`}>
        <h2 id={`${id}-step-title`} ref={headingRef} tabIndex={-1}><MapPin size={20} />Referens & ursprung</h2>
        <p className="customer-intake-help">Gäller den här inlämningen. Fyll i en referens om du har en och var materialet kommer ifrån, eller hoppa över.</p>
        <label>Referens (valfritt)<input value={reference} maxLength={200} autoComplete="off" placeholder="Till exempel projekt eller arbetsorder" onChange={event => { setReference(event.target.value); setError(''); }} /></label>
        <label className="customer-intake-bank-toggle"><input type="checkbox" checked={!originEdited} onChange={event => {
          if (event.target.checked) setOriginEdited(false); else { setOrigin(normalizeAddress(customer)); setOriginEdited(true); } setError('');
        }} />Samma som postadressen</label>
        <label>Ursprungsadress<input value={originValue.address} maxLength={300} autoComplete="off" onChange={event => changeOrigin('address', event.target.value)} /></label>
        <div className="customer-intake-grid"><label>Ursprungets postnummer<input value={originValue.postalCode} maxLength={20} inputMode="numeric" autoComplete="off" onChange={event => changeOrigin('postalCode', event.target.value)} /></label>
          <label>Ursprungets ort<input value={originValue.city} maxLength={200} autoComplete="off" onChange={event => changeOrigin('city', event.target.value)} /></label></div>
      </section>}
    </fieldset>
    {error && <p className="customer-intake-error" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    <div className="customer-intake-actions">{step > 1 && <button className="customer-intake-back" type="button" disabled={blocked} onClick={goBack}><ArrowLeft size={18} />Tillbaka</button>}
      <button className="customer-intake-submit" type="submit" disabled={blocked}>{busy ? <LoaderCircle size={20} className="customer-intake-spinner" /> : step < 4 ? <ArrowRight size={20} /> : <Check size={20} />}{busy ? 'Skickar uppgifterna…' : step < 4 ? 'Fortsätt' : submitLabel}</button></div>
    {step === 2 && <button className="customer-intake-skip" type="button" disabled={blocked} onClick={() => { setIncludeContact(false); setError(''); setStep(3); }}>Hoppa över kontaktuppgifter</button>}
    {step === 3 && <button className="customer-intake-skip" type="button" disabled={blocked} onClick={() => { setIncludeBank(false); setError(''); setNotice(''); setStep(4); }}>Hoppa över bankuppgifter</button>}
    {step === 4 && <button className="customer-intake-skip" type="button" disabled={blocked} onClick={() => void finish(true)}>Hoppa över och skicka</button>}
  </form>;
}
