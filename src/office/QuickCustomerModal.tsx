import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, Check, ExternalLink, Info, UserRound, Users, X } from 'lucide-react';
import { can, type OfficeCustomer, type OfficeData, type OfficeUser } from './model';
import { cleanCustomerDraft, createCustomerDraft, customerDraftError } from './customer-form';
import './quick-customer.css';

export type QuickCustomerModalProps = {
  data: OfficeData;
  user: OfficeUser;
  initialDraft?: OfficeCustomer;
  onSave: (customer: OfficeCustomer) => boolean | Promise<boolean>;
  onOpenFull: (draft: OfficeCustomer) => void;
  onClose: () => void;
};

const customerTypes = [
  { type: 'Företag', Icon: Building2 },
  { type: 'BRF', Icon: Users },
  { type: 'Privatperson', Icon: UserRound },
] as const;

/** Native dialog supplies focus containment and restores focus to its opener. */
export default function QuickCustomerModal({
  data, user, initialDraft, onSave, onOpenFull, onClose,
}: QuickCustomerModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), descriptionId = useId();
  const [draft, setDraft] = useState(() => createCustomerDraft(data, initialDraft));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const allowed = can(user, 'customers');
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element?.showModal();
    element?.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      element?.close();
      opener?.focus();
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!allowed || busy) return;
    const customer = cleanCustomerDraft(draft);
    const validationError = customerDraftError(customer, data.customers);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setBusy(true);
    try {
      if (!(await onSave(customer))) setError('Kunden kunde inte sparas. Kontrollera uppgifterna och försök igen.');
    } catch {
      setError('Kunden kunde inte sparas. Försök igen.');
    } finally {
      setBusy(false);
    }
  }

  function field(
    key: 'name' | 'number' | 'phone' | 'email' | 'address' | 'postalCode' | 'city' | 'contactPerson',
    label: string,
    placeholder: string,
    autocomplete?: string,
  ) {
    return (
      <label className={key === 'contactPerson' ? 'quick-customer-wide' : ''}>
        {label}{key === 'name' && <span className="quick-customer-required"> *</span>}
        <input
          aria-label={label}
          required={key === 'name'}
          value={draft[key]}
          onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
          placeholder={placeholder}
          type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
          autoComplete={autocomplete ?? 'off'}
          inputMode={key === 'postalCode' ? 'numeric' : undefined}
          maxLength={key === 'postalCode' ? 10 : key === 'number' ? 40 : 200}
          disabled={busy || !allowed}
          autoFocus={key === 'name'}
        />
      </label>
    );
  }

  return (
    <dialog
      ref={dialog}
      className="quick-customer-dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="quick-customer-form">
        <div className="quick-customer-heading">
          <div>
            <h2 id={headingId}>Ny kund</h2>
            <p id={descriptionId}>Skapa kund direkt på viktkortet.</p>
          </div>
          <button type="button" className="quick-customer-close" onClick={onClose} disabled={busy} aria-label="Stäng ny kund">
            <X size={21} aria-hidden="true" />
          </button>
        </div>
        {!allowed && <p className="quick-customer-error" role="alert">Du saknar behörighet att skapa kunder.</p>}
        <div className="quick-customer-types" role="group" aria-label="Kundtyp">
          {customerTypes.map(({ type, Icon }) => (
            <button
              key={type}
              type="button"
              className={draft.type === type ? 'active' : ''}
              aria-pressed={draft.type === type}
              disabled={busy || !allowed}
              onClick={() => setDraft((current) => ({ ...current, type }))}
            >
              <Icon size={20} aria-hidden="true" /> {type}
            </button>
          ))}
        </div>
        <div className="quick-customer-fields">
          {field('name', draft.type === 'Privatperson' ? 'Namn' : draft.type === 'BRF' ? 'Föreningsnamn' : 'Företagsnamn', draft.type === 'Privatperson' ? 'Ange för- och efternamn' : 'Ange namn', draft.type === 'Privatperson' ? 'name' : 'organization')}
          {field('number', draft.type === 'Privatperson' ? 'Personnummer' : 'Organisationsnummer', draft.type === 'Privatperson' ? 'ÅÅÅÅMMDD-XXXX' : 'XXXXXX-XXXX')}
          {field('phone', 'Telefon', '070-123 45 67', 'tel')}
          {field('email', 'E-post', 'namn@example.se', 'email')}
          {field('address', 'Gatuadress', 'T.ex. Storgatan 12', 'street-address')}
          <div className="quick-customer-location">
            {field('postalCode', 'Postnummer', '761 30', 'postal-code')}
            {field('city', 'Ort', 'T.ex. Norrtälje', 'address-level2')}
          </div>
          {draft.type !== 'Privatperson' && field('contactPerson', 'Kontaktperson (valfri)', 'Namn på kontaktperson')}
        </div>
        <p className="quick-customer-note"><Info size={17} aria-hidden="true" /> Efter sparande kopplas kunden direkt till denna invägning.</p>
        {error && <p className="quick-customer-error" role="alert">{error}</p>}
        <div className="quick-customer-footer">
          <button
            type="button"
            className="office-link quick-customer-full"
            disabled={busy || !allowed}
            onClick={() => onOpenFull(cleanCustomerDraft(draft))}
          >
            <ExternalLink size={16} aria-hidden="true" /> Öppna fullständigt kundformulär
          </button>
          <div className="quick-customer-actions">
            <button type="button" className="office-btn outline" onClick={onClose} disabled={busy}>Avbryt</button>
            <button type="submit" className="office-btn" disabled={busy || !allowed}>
              <Check size={17} aria-hidden="true" /> {busy ? 'Sparar…' : 'Spara och välj kund'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
