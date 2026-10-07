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
import { MissingDraft, useDraft } from './shared';

const returnPage = (draft: Draft) =>
  `/weigh/${draft.id}/${draft.mode === 'vehicle' && !draft.rows.some((r) => r.method === 'vehicle' && r.tare != null) ? 'vehicle' : 'summary'}`;
export function CustomerPage() {
  const { draft, data, saveDraft } = useDraft();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [choosing, setChoosing] = useState(false);
  if (!draft) return <MissingDraft />;
  const selected = data.customers.find((c) => c.id === draft.customerId);
  const showSelected = selected && !choosing;
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
                  {selected.address && (
                    <div>
                      <dt>Adress</dt>
                      <dd>{selected.address}</dd>
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
  const navigate = useNavigate();
  const [type, setType] = useState<Customer['type']>('Företag');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
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
      number: number.trim() || 'Ej angivet',
      phone: phone.trim(),
      email: email.trim(),
      address: address.trim(),
      references: [],
      origins: [],
    };
    if (addCustomer(customer, draft)) navigate(`/weigh/${draft!.id}/customer`);
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
              onClick={() => setType(t)}
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
              ? 'Personnummer (valfritt i demon)'
              : 'Organisationsnummer (valfritt)'}
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Använd testuppgifter"
              maxLength={30}
            />
          </label>
          <label>
            Telefon (valfritt)
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Telefonnummer"
              maxLength={30}
            />
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
            Kundens adress (valfritt)
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Gatuadress, postnummer och ort"
              maxLength={180}
            />
          </label>
          <p className="field-help">
            Materialets ursprungsadress anges separat efter att kunden är vald.
          </p>
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
        origin: origin.trim(),
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
                onChange={(e) => setOrigin(e.target.value)}
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
          {customer.origins.length > 0 && (
            <div className="saved-options">
              {customer.origins.map((o) => (
                <button
                  type="button"
                  key={o}
                  onClick={() => setOrigin(o)}
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
