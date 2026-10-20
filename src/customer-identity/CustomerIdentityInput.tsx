import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { completeCustomerIdentifier, customerTypeFromIdentifier, inspectCustomerIdentifier, type CustomerIdentifierInspection } from '../customer-identity';
import ElectricFocusBorder from '../office/ElectricFocusBorder';
import './customer-identity.css';

export interface CustomerIdentityInputProps {
  value: string;
  onChange(value: string): void;
  type: string;
  onTypeChange(type: string): void;
  /** Start existing or transferred customers in manual mode to preserve their chosen role. */
  autoDetect?: boolean;
  /** Explicitly enabled only for new registrations; saved identities stay unchanged. */
  completeCentury?: boolean;
  disabled?: boolean;
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
}

function identityHelp(inspection: CustomerIdentifierInspection, automatic: boolean, type: string): string {
  if (inspection.kind === 'empty') return 'Börja med organisations- eller personnummer. Du kan också välja kundtyp manuellt.';
  if (inspection.kind === 'incomplete') return 'Fortsätt skriva hela numret. Kundtypen föreslås först när numret är komplett och giltigt.';
  if (inspection.kind === 'invalid') return inspection.error!;
  if (inspection.kind === 'organisation') return automatic
    ? 'Organisationsnummer identifierat. Företag föreslås; välj BRF manuellt för en bostadsrättsförening.'
    : 'Organisationsnummer identifierat. Den kundtyp du har valt behålls.';
  const identity = inspection.kind === 'coordination' ? 'Samordningsnummer' : 'Personnummer';
  if (!automatic && type === 'Företag') return `${identity} används för enskild firma. Personuppgifter söks inte i företagsregistret.`;
  return `${identity} identifierat. ${automatic ? 'Privatperson föreslås' : 'Den kundtyp du har valt behålls'}; välj Företag för enskild firma.`;
}

/** A bare ten-digit value can still be the beginning of YYYYMMDDNNNN.
 * An explicit separator establishes the intended short format instead. */
function possibleTwelveDigitPrefix(value: string): boolean {
  const formatted = value.normalize('NFKC').replace(/\s/g, '');
  if (/^\d{6}[-+]\d{4}$/.test(formatted)) return false;
  const compact = formatted.replace(/[-+]/g, '');
  if (!/^\d{10}$/.test(compact)) return false;
  const year = Number(compact.slice(0, 4)), month = Number(compact.slice(4, 6)), day = Number(compact.slice(6, 8));
  if (year < 1800 || year > 2199) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('');
  return compact.slice(0, 8) <= today;
}

/** Identity-first assistance only: no lookup, persistence or changes to saved customers. */
export default function CustomerIdentityInput({ value, onChange, type, onTypeChange, autoDetect = true, completeCentury = false, disabled = false, error, inputRef }: CustomerIdentityInputProps) {
  const id = useId();
  const [automatic, setAutomatic] = useState(autoDetect);
  const [completedNumber, setCompletedNumber] = useState('');
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null), timer = useRef<number | undefined>(undefined), composing = useRef(false);
  const pending = useRef<{ from: string; to: string } | undefined>(undefined);
  const latest = useRef({ value, onChange, completeCentury, disabled }); latest.current = { value, onChange, completeCentury, disabled };
  useImperativeHandle(inputRef, () => input.current!, []);
  const inspection = inspectCustomerIdentifier(value);
  const inferredType = customerTypeFromIdentifier(value);
  const complete = Boolean(inferredType);
  const completed = completedNumber && inspection.kind === 'person' && inspection.normalized === completedNumber;
  const awaitingBlur = completeCentury && focused && inspection.kind === 'person' && inspection.normalized.length === 10
    && completeCustomerIdentifier(value) !== value && possibleTwelveDigitPrefix(value);
  const message = error || [identityHelp(inspection, automatic, type), completed
    ? 'Århundradet är automatiskt kompletterat. Kontrollera födelseåret, särskilt för personer över 100 år. Du kan ändra numret.'
    : awaitingBlur ? 'Fortsätt till 12 siffror, eller lämna fältet så kompletteras århundradet.' : ''].filter(Boolean).join(' ');
  const invalid = Boolean(error) || inspection.kind === 'invalid';

  const cancelTimer = useCallback(() => { window.clearTimeout(timer.current); timer.current = undefined; }, []);
  const completeNow = useCallback((expectedValue?: string, finished = false) => {
    const current = latest.current;
    if (!current.completeCentury || current.disabled || composing.current || !input.current || input.current.matches(':disabled')
      || expectedValue !== undefined && current.value !== expectedValue
      || !finished && document.activeElement === input.current && (possibleTwelveDigitPrefix(current.value)
        || input.current.selectionStart !== current.value.length || input.current.selectionEnd !== current.value.length)) return;
    const next = completeCustomerIdentifier(current.value);
    if (next === current.value || pending.current?.from === current.value && pending.current.to === next) return;
    pending.current = { from: current.value, to: next };
    setCompletedNumber(inspectCustomerIdentifier(next).normalized);
    current.onChange(next);
  }, []);

  useEffect(() => {
    if (pending.current && value !== pending.current.from) pending.current = undefined;
    cancelTimer();
    if (!completeCentury || disabled || composing.current || awaitingBlur || completeCustomerIdentifier(value) === value) return;
    // Only a pause in this exact value completes it. More typing, a pasted
    // twelve-digit identity or disabling the form cancels the pending change.
    timer.current = window.setTimeout(() => { timer.current = undefined; completeNow(value); }, 700);
    return cancelTimer;
  }, [value, completeCentury, disabled, awaitingBlur, cancelTimer, completeNow]);

  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    // Native capture runs before React's submit handler. Commit the controlled
    // value first so validation and save see the same full number as the field.
    const submit = () => { cancelTimer(); flushSync(() => completeNow(undefined, true)); };
    form.addEventListener('submit', submit, true);
    return () => { form.removeEventListener('submit', submit, true); cancelTimer(); };
  }, [cancelTimer, completeNow]);

  useEffect(() => { setAutomatic(autoDetect); }, [autoDetect]);
  useEffect(() => {
    if (automatic && !disabled && inferredType && inferredType !== type) onTypeChange(inferredType);
  }, [automatic, disabled, inferredType, onTypeChange, type]);

  return <div className="customer-identity-input">
    <div className="customer-identity-number">
      <label htmlFor={`${id}-number`}>Organisations-/personnummer</label>
      <div className={`customer-identity-number-outline${!disabled && !complete ? ' is-active' : ''}`}>
        <input ref={input} id={`${id}-number`} value={value} onChange={event => {
          cancelTimer(); pending.current = undefined; setCompletedNumber(''); onChange(event.target.value);
        }} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); cancelTimer(); completeNow(undefined, true); }}
          onCompositionStart={() => { composing.current = true; cancelTimer(); }}
          onCompositionEnd={() => { composing.current = false; cancelTimer(); const current = latest.current;
            if (current.completeCentury && !current.disabled && completeCustomerIdentifier(current.value) !== current.value)
              timer.current = window.setTimeout(() => { timer.current = undefined; completeNow(current.value); }, 700); }}
          type="text" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={30} disabled={disabled}
          aria-invalid={invalid || undefined} aria-describedby={`${id}-help`} />
        <ElectricFocusBorder active={!disabled && !complete} />
      </div>
    </div>
    <div className="customer-identity-type">
      <label htmlFor={`${id}-type`}>Kundtyp</label>
      <select id={`${id}-type`} value={automatic ? 'automatic' : type} disabled={disabled}
        aria-describedby={`${id}-help`} onChange={event => {
          const selected = event.target.value;
          setAutomatic(selected === 'automatic');
          if (selected !== 'automatic') onTypeChange(selected);
          else if (inferredType) onTypeChange(inferredType);
        }}>
        <option value="automatic">Automatiskt{inferredType ? ` – ${inferredType}` : ''}</option>
        <option value="Företag">Företag</option>
        <option value="Privatperson">Privatperson</option>
        <option value="BRF">BRF</option>
      </select>
    </div>
    <p id={`${id}-help`} className={`customer-identity-help${invalid ? ' is-error' : ''}`} role="status" aria-live="polite" aria-atomic="true">{message}</p>
  </div>;
}
