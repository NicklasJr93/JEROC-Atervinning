import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  Banknote,
  CheckCircle2,
  Info,
  Landmark,
  LockKeyhole,
  Save,
  Smartphone,
  Wallet,
} from 'lucide-react';
import type { PaymentDetails } from './model';
import { bankRecipientLabels } from '../payment-details';
import { paymentSummary, validPaymentDetails } from './customer-model';
import { bankRecipientError, bankRecipientType, normalizePaymentDetails, normalizePhoneNumber, phoneNumberError } from '../data-format';
import './payment.css';

type PaymentMethod = PaymentDetails['method'];
type PaymentDraft = PaymentDetails & {
  bank: string;
  clearing: string;
  account: string;
  holder: string;
  phone: string;
  recipient: string;
  bankType: 'account' | 'bankgiro' | 'plusgiro' | 'iban';
  bankgiro: string;
  plusgiro: string;
  iban: string;
  bic: string;
  bankCountry: string;
  beneficiaryAddress: string;
  ocr: string;
};

export type PaymentEditorProps = {
  value?: PaymentDetails;
  legacy?: string;
  customerName?: string;
  customerPhone?: string;
  customerKey?: string;
  disabled?: boolean;
  onSave: (details: PaymentDetails) => boolean | Promise<boolean>;
  buttonLabel?: string;
  allowBalance?: boolean;
  onDraftChange?: (details: PaymentDetails) => void;
  hideSaveAction?: boolean;
  bankOnly?: boolean;
};

const methods = [
  { id: 'bank', label: 'Banköverföring', icon: Landmark },
  { id: 'swish', label: 'Swish', icon: Smartphone },
  { id: 'cash', label: 'Kontant', icon: Banknote },
  { id: 'balance', label: 'Spara på saldo', icon: Wallet },
] as const;

function makeDraft(value?: PaymentDetails, customerName = ''): PaymentDraft {
  return {
    method: value?.method ?? 'bank',
    bank: value?.bank ?? '',
    clearing: value?.clearing ?? '',
    account: value?.account ?? '',
    holder: value?.holder ?? customerName,
    phone: value?.phone ?? '',
    recipient: value?.recipient ?? customerName,
    bankType: bankRecipientType(value ?? {}),
    bankgiro: value?.bankgiro ?? '',
    plusgiro: value?.plusgiro ?? '',
    iban: value?.iban ?? '',
    bic: value?.bic ?? '',
    bankCountry: value?.bankCountry ?? '',
    beneficiaryAddress: value?.beneficiaryAddress ?? '',
    ocr: value?.ocr ?? '',
  };
}

function cleanDraft(draft: PaymentDraft): PaymentDetails {
  if (draft.method === 'bank') {
    return normalizePaymentDetails({
      method: 'bank',
      bankType: draft.bankType,
      bank: draft.bank.trim(),
      clearing: draft.clearing.replace(/[\s-]/g, ''),
      account: draft.account.replace(/[\s-]/g, ''),
      holder: draft.holder.trim(),
      bankgiro: draft.bankgiro,
      plusgiro: draft.plusgiro,
      iban: draft.iban,
      bic: draft.bic,
      bankCountry: draft.bankCountry,
      beneficiaryAddress: draft.beneficiaryAddress,
      ocr: draft.ocr,
    });
  }
  if (draft.method === 'swish') {
    return {
      method: 'swish',
      phone: normalizePhoneNumber(draft.phone, { swish: true }),
      recipient: draft.recipient.trim(),
    };
  }
  return { method: draft.method };
}

function fieldErrors(draft: PaymentDraft) {
  const errors: Partial<Record<keyof PaymentDraft, string>> = {};
  const clean = cleanDraft(draft);
  if (draft.method === 'bank') {
    if (draft.bankType === 'account' && !/^\d{4,5}$/.test(clean.clearing ?? '')) {
      errors.clearing = 'Ange 4 eller 5 siffror.';
    }
    if (draft.bankType === 'account' && !/^\d{4,15}$/.test(clean.account ?? '')) {
      errors.account = 'Ange kontonumret med 4–15 siffror.';
    }
    if (!clean.holder) errors.holder = 'Ange mottagarens namn.';
  }
  if (draft.method === 'swish') {
    const error = phoneNumberError(clean.phone ?? '', { swish: true, required: true });
    if (error) errors.phone = error;
    if (!clean.recipient) errors.recipient = 'Ange mottagarens namn.';
  }
  return errors;
}

export function PaymentReadOnly({
  value,
  legacy,
  locked = false,
}: {
  value?: PaymentDetails;
  legacy?: string;
  locked?: boolean;
}) {
  const selected = methods.find((method) => method.id === value?.method);
  const Icon = selected?.icon ?? Wallet;
  return (
    <div className="office-payment-readonly">
      <div className="office-payment-saved-heading">
        <Icon size={20} aria-hidden="true" />
        <strong>
          {selected?.label ??
            (legacy ? 'Sparad betalningsuppgift' : 'Betalningssätt saknas')}
        </strong>
        {locked && <LockKeyhole size={14} aria-label="Låsta uppgifter" />}
      </div>
      {value?.method === 'bank' && (
        <dl>
          {value.bank && (
            <>
              <dt>Bank</dt>
              <dd>{value.bank}</dd>
            </>
          )}
          <dt>Mottagartyp</dt>
          <dd>{bankRecipientLabels[bankRecipientType(value)]}</dd>
          {bankRecipientType(value) === 'account' && <><dt>Clearingnummer</dt><dd>{value.clearing || '–'}</dd><dt>Kontonummer</dt><dd>{value.account || '–'}</dd></>}
          {bankRecipientType(value) === 'bankgiro' && <><dt>Bankgiro</dt><dd>{value.bankgiro || '–'}</dd></>}
          {bankRecipientType(value) === 'plusgiro' && <><dt>Plusgiro</dt><dd>{value.plusgiro || '–'}</dd></>}
          {bankRecipientType(value) === 'iban' && <><dt>IBAN</dt><dd>{value.iban || '–'}</dd>{value.bic && <><dt>BIC / SWIFT</dt><dd>{value.bic}</dd></>}</>}
          <dt>{bankRecipientType(value) === 'account' ? 'Kontohavare' : 'Mottagare'}</dt>
          <dd>{value.holder || '–'}</dd>
          {value.bankCountry && <><dt>Bankland</dt><dd>{value.bankCountry}</dd></>}
          {value.beneficiaryAddress && <><dt>Mottagaradress</dt><dd>{value.beneficiaryAddress}</dd></>}
          {value.ocr && <><dt>OCR</dt><dd>{value.ocr}</dd></>}
        </dl>
      )}
      {value?.method === 'swish' && (
        <dl>
          <dt>Telefonnummer</dt>
          <dd>{value.phone || '–'}</dd>
          <dt>Mottagare</dt>
          <dd>{value.recipient || '–'}</dd>
        </dl>
      )}
      {value?.method === 'cash' && <p>Kontant betalning vald.</p>}
      {value?.method === 'balance' && (
        <p>
          Beloppet ligger kvar på kundens saldo för senare utbetalning eller
          kvittning.
        </p>
      )}
      {!value && legacy && <p>{legacy}</p>}
      {value && !validPaymentDetails(value) && (
        <p className="office-payment-warning">
          Uppgifterna behöver kompletteras.
        </p>
      )}
      {locked && <small>Uppgifterna följer det låsta underlaget.</small>}
    </div>
  );
}

export default function PaymentEditor({
  value,
  legacy,
  customerName,
  customerPhone,
  customerKey,
  disabled = false,
  onSave,
  buttonLabel = 'Spara betalningsuppgift',
  allowBalance = true,
  onDraftChange,
  hideSaveAction = false,
  bankOnly = false,
}: PaymentEditorProps) {
  const formId = useId();
  const [draft, setDraft] = useState(() => ({ ...makeDraft(value, customerName), ...(bankOnly ? { method: 'bank' as const } : {}) }));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [saveError, setSaveError] = useState('');
  const [copiedCustomerPhone, setCopiedCustomerPhone] = useState(false);
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const valueKey = JSON.stringify(value ?? null);
  const customerSwishPhone = normalizePhoneNumber(customerPhone ?? '', { swish: true });
  const customerSwishError = phoneNumberError(customerPhone ?? '', { swish: true, required: true });

  useEffect(() => { onDraftChangeRef.current?.(cleanDraft(draft)); }, [draft]);
  useEffect(() => { setCopiedCustomerPhone(false); }, [customerKey, customerPhone]);

  useEffect(() => {
    if (!value) return;
    setDraft((current) => {
      const next = makeDraft(value, customerName);
      return { ...current, ...value,
        ...(value.method === 'bank' ? { bank: next.bank, clearing: next.clearing, account: next.account, holder: next.holder,
          bankgiro: next.bankgiro, plusgiro: next.plusgiro, iban: next.iban, bic: next.bic,
          bankCountry: next.bankCountry, beneficiaryAddress: next.beneficiaryAddress, ocr: next.ocr } : {}),
        bankType: bankRecipientType(value), ...(bankOnly ? { method: 'bank' as const } : {}) };
    });
    setAttempted(false);
  }, [valueKey]); // Keep drafts for the other methods when the selected one is saved.

  useEffect(() => {
    if (!customerName) return;
    setDraft((current) => ({
      ...current,
      holder: current.holder || customerName,
      recipient: current.recipient || customerName,
    }));
  }, [customerName]);

  useEffect(() => {
    if (!allowBalance) {
      setDraft((current) =>
        current.method === 'balance' ? { ...current, method: 'bank' } : current,
      );
    }
  }, [allowBalance, valueKey]);

  const errors = attempted ? fieldErrors(draft) : {};
  const bankError = attempted && draft.method === 'bank' ? bankRecipientError(cleanDraft(draft)) : null;

  function selectMethod(method: PaymentMethod) {
    setDraft((current) => ({ ...current, method }));
    setAttempted(false);
    setMessage('');
    setSaveError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (hideSaveAction) return;
    setMessage('');
    setSaveError('');
    const details = cleanDraft(draft);
    if (
      !validPaymentDetails(details) ||
      (!allowBalance && details.method === 'balance')
    )
      return;
    setSaving(true);
    try {
      if (await onSave(details))
        setMessage('Betalningsuppgifterna är sparade.');
    } catch {
      setSaveError('Betalningsuppgifterna kunde inte sparas. Försök igen.');
    } finally {
      setSaving(false);
    }
  }

  function input(
    name: 'bank' | 'clearing' | 'account' | 'holder' | 'phone' | 'recipient' | 'bankgiro' | 'plusgiro' | 'iban' | 'bic' | 'bankCountry' | 'beneficiaryAddress' | 'ocr',
    label: string,
    options: {
      required?: boolean;
      placeholder?: string;
      wide?: boolean;
      numeric?: boolean;
      list?: string;
    } = {},
  ) {
    const errorId = `${formId}-${name}-error`;
    return (
      <label className={options.wide ? 'office-payment-wide' : ''}>
        {label}
        {options.required && (
          <span className="office-payment-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
        <input
          aria-label={label}
          value={draft[name]}
          onChange={(event) => {
            const next = event.target.value;
            if (name === 'phone') setCopiedCustomerPhone(false);
            setDraft((current) => ({ ...current, [name]: next }));
            setMessage('');
            setSaveError('');
          }}
          placeholder={options.placeholder}
          inputMode={
            name === 'phone' ? 'tel' : options.numeric ? 'numeric' : undefined
          }
          autoComplete={name === 'phone' ? 'tel' : 'off'}
          aria-required={options.required || undefined}
          aria-invalid={Boolean(errors[name])}
          aria-describedby={errors[name] ? errorId : undefined}
          list={options.list}
        />
        {errors[name] && (
          <small className="office-payment-field-error" id={errorId}>
            {errors[name]}
          </small>
        )}
      </label>
    );
  }

  if (disabled) return <PaymentReadOnly value={value} legacy={legacy} locked />;

  return (
    <form className="office-payment-editor" onSubmit={submit} noValidate>
      <fieldset disabled={saving}>
        <div
          className="office-payment-methods"
          role="group"
          aria-label="Betalningssätt"
        >
          {methods
            .filter((method) => (!bankOnly || method.id === 'bank') && (allowBalance || method.id !== 'balance'))
            .map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={draft.method === id}
                className={draft.method === id ? 'selected' : ''}
                onClick={() => selectMethod(id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{label}</span>
                {draft.method === id && (
                  <CheckCircle2 size={14} aria-hidden="true" />
                )}
              </button>
            ))}
        </div>

        {!value && legacy && (
          <div className="office-payment-legacy">
            <Info size={15} aria-hidden="true" />
            <div>
              <strong>Tidigare sparad uppgift</strong>
              <span>{legacy}</span>
              <small>
                Uppgiften behålls tills du sparar ett nytt betalningssätt.
              </small>
            </div>
          </div>
        )}

        {draft.method === 'bank' && (
          <div className="office-payment-fields">
            <label className="office-payment-wide">Mottagartyp
              <select aria-label="Mottagartyp" value={draft.bankType} onChange={event => {
                const bankType = event.target.value as PaymentDraft['bankType'];
                setDraft(current => ({ ...current, bankType, clearing: '', account: '', bankgiro: '', plusgiro: '', iban: '', bic: '', bankCountry: '', beneficiaryAddress: '', ocr: '' }));
                setAttempted(false); setMessage(''); setSaveError('');
              }}>{Object.entries(bankRecipientLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select>
            </label>
            {input('bank', 'Bank', {
              placeholder: 'Välj eller skriv bank',
              wide: true,
              list: `${formId}-banks`,
            })}
            <datalist id={`${formId}-banks`}>
              {[
                'Swedbank',
                'Roslagens Sparbank',
                'Handelsbanken',
                'SEB',
                'Nordea',
                'Länsförsäkringar Bank',
                'Danske Bank',
                'Annan bank',
              ].map((bank) => (
                <option key={bank} value={bank} />
              ))}
            </datalist>
            {draft.bankType === 'account' && <>{input('clearing', 'Clearingnummer', {
              required: true,
              numeric: true,
              placeholder: '8327',
            })}
            {input('account', 'Kontonummer', {
              required: true,
              numeric: true,
              placeholder: '1234567890',
            })}</>}
            {draft.bankType === 'bankgiro' && input('bankgiro', 'Bankgironummer', { required: true, numeric: true, placeholder: '123-4567', wide: true })}
            {draft.bankType === 'plusgiro' && input('plusgiro', 'Plusgironummer', { required: true, numeric: true, placeholder: '123456-7', wide: true })}
            {draft.bankType === 'iban' && input('iban', 'IBAN', { required: true, placeholder: 'SE45 5000 0000 0583 9825 7466', wide: true })}
            {input('holder', draft.bankType === 'account' ? 'Kontohavare' : 'Mottagare', { required: true, wide: true })}
            <details className="office-payment-bank-extra office-payment-wide"><summary>Fler mottagaruppgifter</summary><div className="office-payment-fields">
              {draft.bankType === 'iban' && input('bic', 'BIC / SWIFT (vid behov)', { placeholder: 'SWEDSESS', wide: true })}
              {input('bankCountry', 'Bankland (vid behov)', { placeholder: 'SE' })}
              {input('ocr', 'OCR (om mottagaren kräver det)', { numeric: true })}
              {input('beneficiaryAddress', 'Mottagaradress (vid behov)', { wide: true, placeholder: 'Gata, postnummer och ort' })}
            </div></details>
            {bankError && <p className="office-payment-field-error office-payment-wide" role="alert">{bankError}</p>}
          </div>
        )}
        {draft.method === 'swish' && (
          <div className="office-payment-fields">
            {input('phone', 'Telefonnummer', {
              required: true,
              placeholder: '070-123 45 67',
            })}
            {input('recipient', 'Mottagare', { required: true })}
            {customerPhone && (!value?.phone || copiedCustomerPhone) && (
              <label className="office-payment-copy-phone office-payment-wide">
                <input type="checkbox" checked={copiedCustomerPhone} disabled={Boolean(customerSwishError)}
                  aria-label="Använd kundens telefonnummer"
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setCopiedCustomerPhone(checked);
                    if (checked) setDraft(current => ({ ...current, phone: customerSwishPhone }));
                    setMessage(''); setSaveError('');
                  }} />
                <span>Använd kundens telefonnummer<small>{customerSwishError ? 'Kundens telefonnummer kan inte användas för Swish.' : customerSwishPhone}</small></span>
              </label>
            )}
          </div>
        )}
        {draft.method === 'cash' && (
          <div className="office-payment-choice-hint">
            <Banknote size={22} aria-hidden="true" />
            <div>
              <strong>Kontant betalning vald</strong>
              <span>Inga kontouppgifter behövs.</span>
            </div>
          </div>
        )}
        {draft.method === 'balance' && (
          <div className="office-payment-choice-hint">
            <Wallet size={22} aria-hidden="true" />
            <div>
              <strong>Spara på kundens saldo</strong>
              <span>
                Beloppet ligger kvar på kundens saldo för senare utbetalning
                eller kvittning.
              </span>
            </div>
          </div>
        )}
        {!hideSaveAction && <button
          className="office-btn outline office-payment-save"
          type="submit"
        >
          <Save size={14} aria-hidden="true" />
          {saving ? 'Sparar…' : buttonLabel}
        </button>}
      </fieldset>

      {value && !hideSaveAction && (
        <div className="office-payment-current">
          <CheckCircle2 size={13} aria-hidden="true" />
          <span>Sparat: {paymentSummary(value)}</span>
        </div>
      )}
      {message && (
        <p className="office-payment-status" role="status">
          {message}
        </p>
      )}
      {saveError && (
        <p className="office-payment-field-error" role="alert">
          {saveError}
        </p>
      )}
    </form>
  );
}
