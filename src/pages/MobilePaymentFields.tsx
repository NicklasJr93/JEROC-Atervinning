import { useId, useState } from 'react';
import { bankRecipientError, bankRecipientType, normalizePaymentDetails, phoneNumberError } from '../data-format';
import { bankRecipientLabels, type PaymentDetails } from '../payment-details';

/** Optional customer profile entry. Existing financial profiles are never
 * requested by the general mobile customer list. */
export default function MobilePaymentFields({ value, onChange, bankOnly = false }: {
  value: PaymentDetails; onChange: (value: PaymentDetails) => void; bankOnly?: boolean;
}) {
  const identifier = useId();
  const [touched, setTouched] = useState(false);
  const type = bankRecipientType(value);
  const change = (next: PaymentDetails) => { if (!bankOnly || next.method === 'bank') onChange(normalizePaymentDetails(next)); };
  const issue = !touched ? null : value.method === 'bank' ? bankRecipientError(value)
    : value.method === 'swish' ? phoneNumberError(value.phone ?? '', { required: true, swish: true }) || (!value.recipient?.trim() ? 'Ange mottagarens namn.' : null) : null;
  const field = (name: 'bank' | 'clearing' | 'account' | 'holder' | 'bankgiro' | 'plusgiro' | 'iban' | 'bic' | 'bankCountry' | 'beneficiaryAddress' | 'ocr' | 'phone' | 'recipient', label: string, required = false, numeric = false) => (
    <label key={name}>{label}{required ? ' *' : ''}<input aria-label={label} value={value[name] ?? ''}
      inputMode={name === 'phone' ? 'tel' : numeric ? 'numeric' : 'text'}
      autoComplete={name === 'phone' ? 'tel' : 'off'} required={required}
      onChange={event => change({ ...value, [name]: event.target.value })} onBlur={() => setTouched(true)} /></label>
  );
  return <div className="mobile-payment-fields stack" aria-label="Betalningsuppgifter">
    {!bankOnly && <label>Betalningssätt<select aria-label="Betalningssätt" value={value.method} onChange={event => {
      const method = event.target.value as PaymentDetails['method'];
      change({ method, ...(method === 'bank' ? { bankType: 'account', holder: value.holder || value.recipient || '' }
        : method === 'swish' ? { phone: '', recipient: value.recipient || value.holder || '' } : {}) });
      setTouched(false);
    }}><option value="bank">Banköverföring</option><option value="swish">Swish</option><option value="cash">Kontant</option><option value="balance">Spara på saldo</option></select></label>}
    {value.method === 'bank' && <>
      <label>Mottagartyp<select aria-label="Mottagartyp" value={type} onChange={event => {
        change({ method: 'bank', bankType: event.target.value as PaymentDetails['bankType'], holder: value.holder || '', bank: value.bank || '' });
        setTouched(false);
      }}>{Object.entries(bankRecipientLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      {type === 'account' && <div className="split">{field('clearing', 'Clearingnummer', true, true)}{field('account', 'Kontonummer', true, true)}</div>}
      {type === 'bankgiro' && field('bankgiro', 'Bankgironummer', true, true)}
      {type === 'plusgiro' && field('plusgiro', 'Plusgironummer', true, true)}
      {type === 'iban' && field('iban', 'IBAN', true)}
      {field('holder', type === 'account' ? 'Kontohavare' : 'Mottagare', true)}
      <details className="mobile-payment-extra"><summary>Fler mottagaruppgifter</summary><div className="stack">
        {field('bank', 'Bank (valfritt)')}
        {type === 'iban' && field('bic', 'BIC / SWIFT (vid behov)')}
        {field('bankCountry', 'Bankland (vid behov)')}
        {field('ocr', 'OCR (om mottagaren kräver det)', false, true)}
        {field('beneficiaryAddress', 'Mottagaradress (vid behov)')}
      </div></details>
    </>}
    {!bankOnly && value.method === 'swish' && <>{field('phone', 'Swish-nummer', true)}{field('recipient', 'Mottagare', true)}</>}
    {!bankOnly && value.method === 'cash' && <p className="field-help">Inga kontouppgifter behövs för kontant betalning.</p>}
    {!bankOnly && value.method === 'balance' && <p className="field-help">Beloppet sparas på kundens saldo.</p>}
    {issue && <p id={`${identifier}-error`} className="red-text" role="alert">{issue}</p>}
  </div>;
}
