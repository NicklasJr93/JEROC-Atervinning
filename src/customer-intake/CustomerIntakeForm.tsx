import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, Check, CreditCard, LoaderCircle, Mail, UserRound } from 'lucide-react';
import { z } from 'zod';
import CustomerIdentityInput from '../customer-identity/CustomerIdentityInput';
import { normalizeCustomerDetails, validateCustomerDetails } from '../data-format';
import type { PaymentDetails } from '../payment-details';
import MobilePaymentFields from '../pages/MobilePaymentFields';
import { customerIntakeInputSchema, type CustomerIntakeInput } from './types';
import './customer-intake.css';

export interface CustomerIntakeFormProps {
  onSubmit(customer: CustomerIntakeInput): Promise<void>;
  disabled?: boolean;
  initialValues?: Partial<CustomerIntakeInput>;
  submitLabel?: string;
  autoComplete?: 'on' | 'off';
}

const emptyCustomer = (): CustomerIntakeInput => ({ type: 'Privatperson', name: '', number: '', phone: '', email: '',
  address: '', postalCode: '', city: '', countryCode: 'SE' });

/** Shared by a paired terminal and the personal SMS link. It only edits the
 * information entered here; protected lookup and customer lists are not used. */
export default function CustomerIntakeForm({ onSubmit, disabled = false, initialValues, submitLabel = 'Skicka mina uppgifter', autoComplete = 'on' }: CustomerIntakeFormProps) {
  const [customer, setCustomer] = useState<CustomerIntakeInput>(() => ({ ...emptyCustomer(), ...initialValues, paymentProfile: undefined }));
  const [includeBank, setIncludeBank] = useState(false);
  const [bank, setBank] = useState<PaymentDetails>({ method: 'bank', bankType: 'account' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null), flight = useRef(false), mounted = useRef(true), id = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const blocked = disabled || busy;
  const change = (field: keyof CustomerIntakeInput, value: string) => { setCustomer(current => ({ ...current, [field]: value })); setError(''); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (blocked || flight.current) return;
    const input = normalizeCustomerDetails({ ...customer, name: customer.name.trim(), email: customer.email.trim(),
      countryCode: 'SE', ...(includeBank ? { paymentProfile: { ...bank, method: 'bank' as const, holder: bank.holder?.trim() || customer.name.trim() } } : {}) });
    // A new anonymous submission must be a complete legal identity; the helper
    // retains the established private-person/sole-trader distinction.
    const issue = !input.number ? 'Ange organisations- eller personnummer.' : !input.name ? 'Ange ditt namn eller företagsnamn.'
      : input.email && !z.string().email().max(200).safeParse(input.email).success ? 'Ange en giltig e-postadress med högst 200 tecken, eller lämna fältet tomt.'
      : validateCustomerDetails(input) || (!customerIntakeInputSchema.safeParse(input).success ? 'Kontrollera de ifyllda uppgifterna.' : '');
    if (issue) { setError(issue); return; }
    flight.current = true; setBusy(true); setError(''); setNotice('');
    try { await onSubmit(input); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Uppgifterna kunde inte skickas. Försök igen.'); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  }
  return <form className="customer-intake-form" onSubmit={event => void submit(event)} autoComplete={autoComplete} noValidate>
    <fieldset disabled={blocked} className="customer-intake-fields">
      <section className="customer-intake-section" aria-labelledby={`${id}-identity-title`}>
        <h2 id={`${id}-identity-title`}>{customer.type === 'Privatperson' ? <UserRound size={20} /> : <Building2 size={20} />}Dina uppgifter</h2>
        <CustomerIdentityInput value={customer.number} type={customer.type} disabled={blocked}
          autoDetect={!initialValues?.number} onChange={value => change('number', value)} onTypeChange={value => change('type', value)} />
        <label>{customer.type === 'Privatperson' ? 'Namn' : 'Företagsnamn'}<input value={customer.name} onChange={event => change('name', event.target.value)}
          autoComplete={autoComplete === 'off' ? 'off' : customer.type === 'Privatperson' ? 'name' : 'organization'} maxLength={200} required /></label>
        <div className="customer-intake-grid">
          <label>Telefonnummer<input type="tel" autoComplete={autoComplete === 'off' ? 'off' : 'tel'} value={customer.phone} maxLength={80}
            onChange={event => change('phone', event.target.value)} /></label>
          <label>E-postadress<input type="email" autoComplete={autoComplete === 'off' ? 'off' : 'email'} value={customer.email} maxLength={200}
            onChange={event => change('email', event.target.value)} aria-describedby={`${id}-email-help`} /></label>
        </div>
        <p id={`${id}-email-help`} className="customer-intake-help"><Mail size={16} />Används för kvitton och information om din inlämning – ingen reklam.</p>
        <label>Postadress<input autoComplete={autoComplete === 'off' ? 'off' : 'street-address'} value={customer.address} maxLength={300} onChange={event => change('address', event.target.value)} /></label>
        <div className="customer-intake-grid">
          <label>Postnummer<input inputMode="numeric" autoComplete={autoComplete === 'off' ? 'off' : 'postal-code'} value={customer.postalCode} maxLength={20} onChange={event => change('postalCode', event.target.value)} /></label>
          <label>Ort<input autoComplete={autoComplete === 'off' ? 'off' : 'address-level2'} value={customer.city} maxLength={200} onChange={event => change('city', event.target.value)} /></label>
        </div>
      </section>
      <section className="customer-intake-section" aria-labelledby={`${id}-bank-title`}>
        <h2 id={`${id}-bank-title`}><CreditCard size={20} />Utbetalning</h2>
        <p id={`${id}-bank-help`} className="customer-intake-help">Sparas på ditt kundkort för kommande utbetalningar. Du behöver normalt bara fylla i det en gång.</p>
        <label className="customer-intake-bank-toggle"><input type="checkbox" checked={includeBank} aria-describedby={`${id}-bank-help`}
          onChange={event => { setIncludeBank(event.target.checked); setError(''); if (event.target.checked) setBank(current => ({ ...current, holder: current.holder || customer.name.trim() })); }} />Lägg till bankuppgifter</label>
        {includeBank && <MobilePaymentFields bankOnly value={bank} onChange={value => { if (value.method === 'bank') { setBank(value); setError(''); } }} />}
        <button type="button" className="customer-intake-swish" aria-disabled="true" onClick={() => setNotice('Kommer snart')}>
          <img src="/images/swish-symbol.svg" alt="" />Swish – kommer snart
        </button>
        {notice && <p className="customer-intake-notice" role="status">{notice}</p>}
      </section>
    </fieldset>
    {error && <p className="customer-intake-error" ref={errorRef} tabIndex={-1} role="alert">{error}</p>}
    <button className="customer-intake-submit" type="submit" disabled={blocked}>{busy ? <LoaderCircle size={20} className="customer-intake-spinner" /> : <Check size={20} />}{busy ? 'Skickar uppgifterna…' : submitLabel}</button>
  </form>;
}
