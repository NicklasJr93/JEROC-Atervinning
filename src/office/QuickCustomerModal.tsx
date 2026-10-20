import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Check, ExternalLink, Info, X } from 'lucide-react';
import CompanyLookup from '../company-register/CompanyLookup';
import PersonLookup from '../person-register/PersonLookup';
import { usePersonLookupAutofill } from '../person-register/usePersonLookupAutofill';
import CustomerIdentityInput from '../customer-identity/CustomerIdentityInput';
import { inspectCustomerIdentifier } from '../customer-identity';
import AddressField from '../address-assistance/AddressField';
import { applyInitialPaymentTerms, useCompanyDefaults } from '../company-settings-defaults';
import { can, type OfficeCustomer, type OfficeData, type OfficeUser } from './model';
import { applyCompanyLookupToCustomer, cleanCustomerDraft, createCustomerDraft, customerDraftDuplicates, customerDraftError, customerDraftForSave } from './customer-form';
import { customerIdentifierError, phoneNumberError } from '../data-format';
import './quick-customer.css';

export type QuickCustomerModalProps = {
  data: OfficeData;
  user: OfficeUser;
  actualUser?: OfficeUser;
  initialDraft?: OfficeCustomer;
  onSave: (customer: OfficeCustomer) => boolean | Promise<boolean>;
  onSelectExisting?: (customer: OfficeCustomer) => boolean | Promise<boolean>;
  onOpenFull: (draft: OfficeCustomer) => void;
  onClose: () => void;
};

/** Native dialog supplies focus containment and restores focus to its opener. */
export default function QuickCustomerModal({
  data, user, actualUser = user, initialDraft, onSave, onSelectExisting, onOpenFull, onClose,
}: QuickCustomerModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId(), descriptionId = useId();
  const [draft, setDraft] = useState(() => createCustomerDraft(data, initialDraft));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [checkedFields, setCheckedFields] = useState<string[]>([]);
  const personAutofill = usePersonLookupAutofill(draft, setDraft, draft.id);
  const duplicates = customerDraftDuplicates(draft, data.customers);
  const identifierKind = inspectCustomerIdentifier(draft.number).kind;
  const personalIdentity = identifierKind === 'person' || identifierKind === 'coordination';
  const allowed = can(user, 'customers');
  const companyDefaults = useCompanyDefaults({ enabled: allowed && !initialDraft, scopeKey: draft.id,
    requestHeaders: { 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id } });
  const initialPaymentTermDays = useRef(initialDraft?.paymentTermDays);
  useEffect(() => {
    if (busy || !companyDefaults) return;
    setDraft(current => applyInitialPaymentTerms(current, companyDefaults.defaults, {
      fresh: true, transferred: Boolean(initialDraft), initialValue: initialPaymentTermDays.current,
    }));
  }, [companyDefaults, initialDraft, busy]);
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
    setCheckedFields(['number', 'phone']);
    const validationError = customerDraftError(draft, data.customers, { allowDuplicate });
    if (validationError) {
      setError(validationError);
      return;
    }
    const customer = customerDraftForSave(draft);
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
    key: 'name' | 'phone' | 'email' | 'address' | 'postalCode' | 'city' | 'contactPerson',
    label: string,
    placeholder: string,
    autocomplete?: string,
  ) {
    const validationError = checkedFields.includes(key)
      ? key === 'phone' ? phoneNumberError(draft.phone) : null
      : null;
    return (
      <label className={key === 'name' || key === 'contactPerson' ? 'quick-customer-wide' : ''}>
        {label}{key === 'name' && <span className="quick-customer-required"> *</span>}
        <input
          aria-label={label}
          aria-invalid={Boolean(validationError)}
          required={key === 'name'}
          value={draft[key]}
          onChange={(event) => {
            personAutofill.touch(key);
            setDraft((current) => ({ ...current, [key]: event.target.value }));
          }}
          onBlur={() => setCheckedFields(current => current.includes(key) ? current : [...current, key])}
          placeholder={placeholder}
          type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text'}
          autoComplete={autocomplete ?? 'off'}
          inputMode={key === 'postalCode' ? 'numeric' : undefined}
          maxLength={key === 'postalCode' ? 10 : 200}
          disabled={busy || !allowed}
        />
        {validationError && <small className="customer-field-error">{validationError}</small>}
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
        <div style={{ margin: '20px 0' }}>
          <CustomerIdentityInput
            value={draft.number}
            type={draft.type}
            autoDetect={!initialDraft}
            disabled={busy || !allowed}
            error={checkedFields.includes('number') ? customerIdentifierError(draft.type, draft.number) ?? undefined : undefined}
            onChange={(number) => {
              setAllowDuplicate(false);
              setDraft((current) => ({ ...current, number }));
            }}
            onTypeChange={(type) => {
                setAllowDuplicate(false);
                setDraft((current) => ({ ...current, type: type as OfficeCustomer['type'] }));
            }}
          />
        </div>
        {allowed && draft.type !== 'Privatperson' && !personalIdentity && (
          <div style={{ marginBottom: 20 }}>
            <CompanyLookup
              organisationNumber={draft.number}
              enabled={duplicates.length === 0}
              disabled={busy}
              scopeKey={JSON.stringify([draft.id, draft.type, draft.name, draft.address, draft.postalCode, draft.city, draft.countryCode, draft.vatRegistered])}
              requestHeaders={{ 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }}
              onApply={(company) => {
                if (!busy && allowed) setDraft((current) => applyCompanyLookupToCustomer(current, company));
              }}
            />
          </div>
        )}
        <div style={{ marginBottom: 20 }} hidden={!allowed || !(draft.type === 'Privatperson' || personalIdentity) || duplicates.length > 0}>
          <PersonLookup
            personalNumber={draft.number}
            enabled={allowed && (draft.type === 'Privatperson' || personalIdentity) && duplicates.length === 0}
            disabled={busy}
            lookupContextKey={draft.id}
            scopeKey={JSON.stringify([draft.id, draft.type, draft.name, draft.address, draft.postalCode, draft.city, draft.countryCode, draft.phone, draft.email])}
            requestHeaders={{ 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }}
            onApply={person => {
              if (!busy && allowed && !customerDraftDuplicates(draft, data.customers).length)
                personAutofill.apply(person);
            }}
          />
        </div>
        {draft.type !== 'Privatperson' && (
          <fieldset className="quick-customer-vat" disabled={busy || !allowed}>
            <legend>Momsregistrerad</legend>
            <div className="quick-customer-vat-options">
              {[true, false].map((registered) => (
                <button
                  key={String(registered)}
                  type="button"
                  aria-pressed={draft.vatRegistered === registered}
                  className={draft.vatRegistered === registered ? 'active' : ''}
                  onClick={() => setDraft((current) => ({ ...current, vatRegistered: registered }))}
                >
                  {draft.vatRegistered === registered && <Check size={16} aria-hidden="true" />}
                  {registered ? 'Ja' : 'Nej'}
                </button>
              ))}
            </div>
            <p>{draft.vatRegistered === undefined ? 'Momsregistrering behöver anges. ' : ''}Kontrollera uppgiften enligt ordinarie rutin.</p>
          </fieldset>
        )}
        <div className="quick-customer-fields">
          {field('name', draft.type === 'Privatperson' ? 'Namn' : draft.type === 'BRF' ? 'Föreningsnamn' : 'Företagsnamn', draft.type === 'Privatperson' ? 'Ange för- och efternamn' : 'Ange namn', draft.type === 'Privatperson' ? 'name' : 'organization')}
          {field('phone', 'Telefon', '070-123 45 67', 'tel')}
          {field('email', 'E-post', 'namn@example.se', 'email')}
          <label>Gatuadress<AddressField
            aria-label="Gatuadress"
            value={{ address: draft.address, postalCode: draft.postalCode, city: draft.city, countryCode: draft.countryCode }}
            disabled={busy || !allowed}
            scopeKey={JSON.stringify([draft.id, draft.type, draft.number])}
            requestHeaders={{ 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id }}
            onChange={address => { personAutofill.touch('address'); setDraft(current => ({ ...current, address })); }}
            onApply={address => { if (!busy && allowed) { personAutofill.touch('address'); setDraft(current => ({ ...current, ...address })); } }}
            onBlur={() => setCheckedFields(current => current.includes('address') ? current : [...current, 'address'])}
            placeholder="T.ex. Storgatan 12"
            autoComplete="street-address"
            maxLength={200}
          /></label>
          <div className="quick-customer-location">
            {field('postalCode', 'Postnummer', '761 30', 'postal-code')}
            {field('city', 'Ort', 'T.ex. Norrtälje', 'address-level2')}
          </div>
          {draft.type !== 'Privatperson' && field('contactPerson', 'Kontaktperson (valfri)', 'Namn på kontaktperson')}
        </div>
        {duplicates.length > 0 && (
          <div className="quick-customer-duplicate" role="status">
            <strong>En kund med samma nummer finns redan.</strong>
            {duplicates.map(customer => (
              <div key={customer.id}>
                <span>{customer.name} · {customer.customerNumber}</span>
                {onSelectExisting && <button type="button" className="office-link" disabled={busy || !allowed}
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      if (!await onSelectExisting(customer)) setError('Kunden kunde inte väljas. Försök igen.');
                    } catch { setError('Kunden kunde inte väljas. Försök igen.'); }
                    finally { setBusy(false); }
                  }}>Välj befintlig kund</button>}
              </div>
            ))}
            <label><input type="checkbox" checked={allowDuplicate} disabled={busy || !allowed}
              onChange={event => setAllowDuplicate(event.target.checked)} />Skapa en separat kundpost för samma verksamhet/person</label>
          </div>
        )}
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
