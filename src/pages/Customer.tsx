import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  Check,
  ChevronRight,
  MapPin,
  Plus,
  UserRound,
} from 'lucide-react';
import {
  Button,
  Empty,
  Header,
  Notice,
  ReferenceLink,
  Search,
} from '../components';
import { type Customer } from '../data';
import { id, type Draft } from '../model';
import { customerIdentifierError, formatAddress, normalizeAddress, normalizeCustomerDetails, normalizeOriginAddress, phoneNumberError, validateCustomerDetails } from '../data-format';
import { MissingDraft, useDraft } from './shared';
import { useEmployee } from '../employee/EmployeeProvider';
import type { PaymentDetails } from '../payment-details';
import MobilePaymentFields from './MobilePaymentFields';
import './customer.css';

const returnPage = (draft: Draft) =>
  `/weigh/${draft.id}/${draft.mode === 'vehicle' && (Boolean(draft.vehicleInput) || !draft.rows.some((r) => r.method === 'vehicle' && r.tare != null)) ? 'vehicle' : 'summary'}`;
export function CustomerPage() {
  const { draft, data, saveDraft, linkRegistration } = useDraft();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [linked, setLinked] = useState(false);
  if (!draft) return <MissingDraft />;
  const selected = data.customers.find((c) => c.id === draft.customerId);
  const showSelected = selected && !choosing;
  const registration =
    draft.vehicleInput?.registration ||
    draft.rows.find((r) => r.method === 'vehicle')?.registration;
  const listed = data.customers.filter((c) =>
    `${c.name} ${c.number} ${c.phone}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  function select(c: Customer) {
    if (
      saveDraft({
        ...draft!,
        customerId: c.id,
        reference: c.id === draft!.customerId ? draft!.reference : '',
        origin: c.id === draft!.customerId ? draft!.origin : '',
        originDetails: c.id === draft!.customerId ? draft!.originDetails : undefined,
        customerSelectionsSavedAt: c.id === draft!.customerId ? draft!.customerSelectionsSavedAt : undefined,
      })
    )
      setChoosing(false);
  }
  return (
    <>
      <Header
        title={showSelected ? 'Vald kund' : 'Välj kund'}
        back={returnPage(draft)}
      />
      <main className="page-body flow-body">
        <div className="stack">
          {showSelected ? (
            <>
              <section className="customer-card">
                <span className="customer-type-icon">
                  {selected.type === 'Privatperson' ? (
                    <UserRound size={30} />
                  ) : (
                    <Building2 size={30} />
                  )}
                </span>
                <h2>{selected.name}</h2>
                <p>
                  {selected.number} · {selected.type}
                </p>
                <dl>
                  {selected.phone && (
                    <div>
                      <dt>Telefon</dt>
                      <dd>{selected.phone}</dd>
                    </div>
                  )}
                  {selected.email && (
                    <div>
                      <dt>E-post</dt>
                      <dd>{selected.email}</dd>
                    </div>
                  )}
                  {formatAddress(selected) && (
                    <div>
                      <dt>Adress</dt>
                      <dd>{formatAddress(selected)}</dd>
                    </div>
                  )}
                </dl>
                <span className="badge blue">Kopplad till #{draft.number}</span>
              </section>
              <Button variant="outline" onClick={() => setChoosing(true)}>
                Byt kund
              </Button>
              <ReferenceLink
                draftId={draft.id}
                customerId={draft.customerId}
                reference={draft.reference}
                origin={draft.origin}
              />
              {registration && (
                <div className="stack tight">
                  <p className="field-help">
                    Kundens fordon:{' '}
                    {selected.registrations?.join(', ') ||
                      'Ingen sparad koppling'}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (linkRegistration(selected.id, registration))
                        setLinked(true);
                    }}
                  >
                    Koppla {registration} till kunden
                  </Button>
                  {linked && (
                    <Notice tone="green">
                      Registreringsnumret är kopplat till kunden för kommande
                      vägningar.
                    </Notice>
                  )}
                </div>
              )}
              <Notice>
                Kunden är vald. Referens och ursprungsadress kan nu hämtas från
                kundens sparade uppgifter eller skrivas in.
              </Notice>
              <button
                className="text-button red-text"
                onClick={() => {
                  if (
                    saveDraft({
                      ...draft,
                      customerId: undefined,
                      reference: '',
                      origin: '',
                      originDetails: undefined,
                      customerSelectionsSavedAt: undefined,
                    })
                  )
                    setChoosing(false);
                }}
              >
                Ta bort kund från kortet
              </button>
            </>
          ) : (
            <>
              <Search
                value={search}
                setValue={setSearch}
                placeholder="Sök namn, organisationsnummer eller telefon"
              />
              <Button
                variant="outline"
                icon={Plus}
                onClick={() => navigate(`/weigh/${draft.id}/customer/new`)}
              >
                Skapa ny kund
              </Button>
              <p className="section-caption">{listed.length} DEMOKUNDER</p>
              <div className="customer-list">
                {listed.map((c) => (
                  <button
                    className="customer-choice"
                    key={c.id}
                    onClick={() => select(c)}
                  >
                    <span className="customer-choice-icon">
                      {c.type === 'Privatperson' ? (
                        <UserRound size={21} />
                      ) : (
                        <Building2 size={21} />
                      )}
                    </span>
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {c.number} · {c.type}
                      </small>
                    </span>
                    <ChevronRight size={20} />
                  </button>
                ))}
              </div>
              {!listed.length && (
                <Empty
                  title="Ingen kund hittades"
                  text="Prova en annan sökning eller skapa en ny demokund."
                />
              )}
              <Notice>
                Kundval är valfritt. Kontoret kan komplettera detta senare i den
                färdiga appen.
              </Notice>
            </>
          )}
        </div>
        <Button onClick={() => navigate(returnPage(draft))} icon={Check}>
          {showSelected ? 'Klar' : 'Fortsätt utan ändring'}
        </Button>
      </main>
    </>
  );
}
export function NewCustomerPage() {
  const { draft, addCustomer } = useDraft();
  const { session } = useEmployee();
  const navigate = useNavigate();
  const [type, setType] = useState<Customer['type']>('Företag');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [city, setCity] = useState('');
  const [vatRegistered, setVatRegistered] = useState(true);
  const [numberError, setNumberError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [error, setError] = useState('');
  const [includePayment, setIncludePayment] = useState(false);
  const [paymentProfile, setPaymentProfile] = useState<PaymentDetails>({ method: 'bank', bankType: 'account' });
  if (!draft) return <MissingDraft />;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Ange kundens namn eller företagsnamn.');
      return;
    }
    const customer: Customer = {
      id: id(),
      type,
      name: name.trim(),
      number: number.trim(),
      phone: phone.trim(),
      email: email.trim(),
      address: address.trim(),
      postalCode: postalCode.trim(),
      city: city.trim(),
      countryCode: 'SE',
      vatRegistered: type === 'Privatperson' ? false : vatRegistered,
      references: [],
      origins: [],
      ...(includePayment && session?.capabilities.paymentDetails ? { paymentProfile: { ...paymentProfile,
        ...(paymentProfile.method === 'bank' ? { holder: paymentProfile.holder?.trim() || name.trim() }
          : paymentProfile.method === 'swish' ? { recipient: paymentProfile.recipient?.trim() || name.trim() } : {}) } } : {}),
    };
    const invalid = validateCustomerDetails(customer);
    if (invalid) { setError(invalid); return; }
    setError('');
    if (addCustomer(normalizeCustomerDetails(customer), draft)) navigate(`/weigh/${draft!.id}/customer`);
  }
  return (
    <>
      <Header title="Ny kund" back={`/weigh/${draft.id}/customer`} />
      <main className="page-body">
        <div className="customer-tabs">
          {(['Företag', 'Privatperson', 'BRF'] as const).map((t) => (
            <button
              className={type === t ? 'selected' : ''}
              key={t}
              onClick={() => { setType(t); setNumberError(''); setError(''); }}
            >
              {t}
            </button>
          ))}
        </div>
        <form className="stack" onSubmit={submit}>
          <label>
            {type === 'Privatperson' ? 'Namn' : 'Företagsnamn'}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                type === 'Privatperson'
                  ? 'För- och efternamn'
                  : 'Namn på företaget'
              }
              maxLength={120}
            />
          </label>
          <label>
            {type === 'Privatperson'
              ? 'Personnummer (valfritt)'
              : 'Organisationsnummer'}
            <input
              value={number}
              onChange={(e) => { setNumber(e.target.value); setNumberError(''); setError(''); }}
              onBlur={() => setNumberError(customerIdentifierError(type, number) || '')}
              aria-invalid={Boolean(numberError)}
              aria-label={type === 'Privatperson' ? 'Personnummer (valfritt)' : 'Organisationsnummer'}
              aria-describedby={numberError ? 'mobile-customer-number-error' : undefined}
              inputMode="numeric"
              required={type !== 'Privatperson'}
              placeholder={type === 'Privatperson' ? 'ÅÅÅÅMMDD-XXXX' : 'XXXXXX-XXXX'}
              maxLength={30}
            />
            {numberError && <span id="mobile-customer-number-error" className="red-text" role="alert">{numberError}</span>}
          </label>
          {type !== 'Privatperson' && <label>
            Momsregistrerad
            <select aria-label="Momsregistrerad" value={vatRegistered ? 'yes' : 'no'} onChange={event => setVatRegistered(event.target.value === 'yes')}>
              <option value="yes">Ja</option>
              <option value="no">Nej</option>
            </select>
          </label>}
          <label>
            Telefon (valfritt)
            <input
              type="tel"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); setPhoneError(''); setError(''); }}
              onBlur={() => setPhoneError(phoneNumberError(phone) || '')}
              aria-invalid={Boolean(phoneError)}
              aria-label="Telefon (valfritt)"
              aria-describedby={phoneError ? 'mobile-customer-phone-error' : undefined}
              placeholder="Telefonnummer"
              maxLength={30}
            />
            {phoneError && <span id="mobile-customer-phone-error" className="red-text" role="alert">{phoneError}</span>}
          </label>
          <label>
            E-post (valfritt)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="E-postadress"
              maxLength={120}
            />
          </label>
          <label>
            Gatuadress (valfritt)
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Ex. Storgatan 12"
              autoComplete="street-address"
              maxLength={180}
            />
          </label>
          <div className="split">
            <label>Postnummer (valfritt)<input value={postalCode} onChange={event => setPostalCode(event.target.value)} inputMode="numeric" autoComplete="postal-code" placeholder="761 41" maxLength={10} /></label>
            <label>Ort (valfritt)<input value={city} onChange={event => setCity(event.target.value)} autoComplete="address-level2" placeholder="Norrtälje" maxLength={100} /></label>
          </div>
          <p className="field-help">
            Materialets ursprungsadress anges separat efter att kunden är vald.
          </p>
          {session?.capabilities.paymentDetails && <section className="mobile-payment-profile">
            <label className="mobile-origin-copy"><input type="checkbox" checked={includePayment}
              aria-label="Lägg till betalningsuppgifter" onChange={event => {
                setIncludePayment(event.target.checked);
                if (event.target.checked) setPaymentProfile(current => ({ ...current,
                  ...(current.method === 'bank' && !current.holder ? { holder: name.trim() } : {}) }));
              }} /><span>Lägg till betalningsuppgifter<small>Valfritt. Används som förval på nya viktkort.</small></span></label>
            {includePayment && <MobilePaymentFields value={paymentProfile} onChange={setPaymentProfile} />}
          </section>}
          {error && <Notice tone="red">{error}</Notice>}
          <Button type="submit" icon={Check}>
            Spara och välj kund
          </Button>
        </form>
      </main>
    </>
  );
}
export function ReferencePage() {
  const { draft, data, saveDraft } = useDraft();
  const navigate = useNavigate();
  const [reference, setReference] = useState(draft?.reference ?? '');
  const [origin, setOrigin] = useState(draft?.origin ?? '');
  const [useCustomerAddress, setUseCustomerAddress] = useState(false);
  if (!draft) return <MissingDraft />;
  const customer = data.customers.find((c) => c.id === draft.customerId);
  if (!customer)
    return (
      <>
        <Header title="Referens & ursprung" back={returnPage(draft)} />
        <main className="page-body">
          <Notice>
            Välj kund innan du fyller i referens och ursprungsadress.
          </Notice>
          <Button onClick={() => navigate(`/weigh/${draft.id}/customer`)}>
            Välj kund
          </Button>
        </main>
      </>
    );
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      saveDraft({
        ...draft!,
        reference: reference.trim(),
        origin: normalizeOriginAddress(origin),
        originDetails: origin.trim() ? normalizeAddress(origin) : undefined,
        customerSelectionsSavedAt: new Date().toISOString(),
      })
    )
      navigate(returnPage(draft!));
  }
  return (
    <>
      <Header title="Referens & ursprung" back={returnPage(draft)} />
      <main className="page-body flow-body">
        <form className="stack reference-form" onSubmit={submit}>
          <div className="reference-customer">
            <Building2 size={23} />
            <span>
              <small>VALD KUND</small>
              <strong>{customer.name}</strong>
            </span>
          </div>
          <label>
            Referens (valfritt)
            <input
              list="saved-references"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Ex. projektnamn eller märkning"
              maxLength={150}
            />
            <datalist id="saved-references">
              {customer.references.map((r) => (
                <option value={r} key={r} />
              ))}
            </datalist>
          </label>
          {customer.references.length > 0 && (
            <div className="saved-options">
              {customer.references.map((r) => (
                <button
                  type="button"
                  key={r}
                  onClick={() => setReference(r)}
                  className={reference === r ? 'selected' : ''}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          <label>
            Materialets ursprungsadress (valfritt)
            <div className="input-with-icon">
              <MapPin size={18} />
              <input
                list="saved-origins"
                value={origin}
                onChange={(e) => { setOrigin(e.target.value); setUseCustomerAddress(false); }}
                placeholder="Gatuadress, postnummer och ort"
                maxLength={180}
              />
            </div>
            <datalist id="saved-origins">
              {customer.origins.map((o) => (
                <option value={o} key={o} />
              ))}
            </datalist>
          </label>
          <p className="field-help">
            Gatuadressen där materialet kommer ifrån.
          </p>
          {formatAddress(customer) && <label className="mobile-origin-copy">
            <input type="checkbox" checked={useCustomerAddress} onChange={event => {
              const checked = event.target.checked;
              setUseCustomerAddress(checked);
              if (checked) setOrigin(formatAddress(customer));
            }} />
            <span>Använd kundens adress som ursprungsadress<small>{formatAddress(customer)}</small></span>
          </label>}
          {customer.origins.length > 0 && (
            <div className="saved-options">
              {customer.origins.map((o) => (
                <button
                  type="button"
                  key={o}
                  onClick={() => { setOrigin(o); setUseCustomerAddress(false); }}
                  className={origin === o ? 'selected' : ''}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <Notice>
            Välj en sparad uppgift eller skriv en egen. Uppgifterna gäller det
            här kortet.
          </Notice>
          <Button type="submit" icon={Check}>
            Spara uppgifter
          </Button>
        </form>
      </main>
    </>
  );
}
