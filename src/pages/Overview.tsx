import { useState, useRef, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  LockKeyhole,
  LogOut,
  MapPin,
  Scale,
  Truck,
  Trash2,
  X,
  Plus,
  UserRound,
  RotateCcw,
} from 'lucide-react';
import {
  Button,
  DemoBadge,
  Empty,
  Header,
  Logo,
  MenuRow,
  Modal,
  Nav,
  Notice,
  Photo,
  Search,
} from '../components';
import { useDemo } from '../store';
import { articleById, articles, demoCustomerPrice } from '../data';
import {
  APP_VERSION,
  draftPath,
  dateTime,
  kilos,
  money,
  totalWeight,
  type Draft,
} from '../model';

export function Login() {
  const { login } = useDemo();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  function enter(user: string, pw: string) {
    if (login(user, pw)) {
      navigate('/password');
      setError('');
    } else
      setError(
        'Kontrollera användarnamn och lösenord. Demokontot är niklas / Demo123!',
      );
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    enter(name, password);
  }
  return (
    <main className="login-page">
      <div className="login-hero" aria-hidden="true" />
      <section className="login-card">
        <Logo />
        <h1>Logga in</h1>
        <form onSubmit={submit} className="stack">
          <label>
            Användarnamn
            <div className="input-with-icon">
              <UserRound size={18} />
              <input
                autoComplete="username"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ditt användarnamn"
              />
            </div>
          </label>
          <label>
            Lösenord
            <div className="input-with-icon">
              <LockKeyhole size={18} />
              <input
                autoComplete="current-password"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Ditt lösenord"
              />
              <button
                className="icon-button"
                type="button"
                aria-label={show ? 'Dölj lösenord' : 'Visa lösenord'}
                onClick={() => setShow(!show)}
              >
                {show ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
          </label>
          {error && <Notice tone="red">{error}</Notice>}
          <Button type="submit" icon={LogOut}>
            Logga in
          </Button>
        </form>
        <button className="text-button" onClick={() => setHelp(true)}>
          Glömt lösenord?
        </button>
        <Button variant="outline" onClick={() => enter('niklas', 'Demo123!')}>
          Öppna demokontot
        </Button>
      </section>
      {help && (
        <Modal title="Hjälp med lösenord" onClose={() => setHelp(false)}>
          <Notice>
            Demokontot använder <strong>niklas / Demo123!</strong>. I den
            färdiga appen kontaktar du systemadmin för ett tillfälligt lösenord.
          </Notice>
          <Button onClick={() => setHelp(false)}>Okej</Button>
        </Modal>
      )}
    </main>
  );
}
export function HomePage() {
  const location = useLocation();
  const navigateHome = useNavigate();
  const [entrySaved, setEntrySaved] = useState<string | undefined>(
    location.state?.entrySaved,
  );
  useEffect(() => {
    if (!entrySaved) return;
    navigateHome('/', { replace: true, state: null });
    const timer = window.setTimeout(() => setEntrySaved(undefined), 6000);
    return () => window.clearTimeout(timer);
  }, [entrySaved, navigateHome]);
  const { data } = useDemo();
  const navigate = useNavigate();
  const ongoing = data.drafts
    .filter((d) => d.status !== 'ready')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      <main className="home-page compact-home">
        <header className="home-header">
          <div>
            <h1>Gårdsappen</h1>
            <p>
              <MapPin size={14} /> Gårdsplan · Norrtälje
            </p>
          </div>
          <button
            className="avatar-button"
            aria-label="Öppna profil"
            onClick={() => navigate('/profile')}
          >
            NN
          </button>
        </header>
        <button className="hero-action" onClick={() => navigate('/new')}>
          <span className="hero-action-icon">
            <Scale size={33} />
          </span>
          <span>
            <strong>Starta invägning</strong>
            <small>Ny vägning av material eller fordon</small>
          </span>
          <ChevronRight />
        </button>
        {entrySaved && (
          <div role="status" className="entry-confirmation">
            Infarten sparad · {entrySaved} väntar på utvägning.
          </div>
        )}
        <div className="section-title">
          <h2>
            Pågående vägningar <span>{ongoing.length}</span>
          </h2>
        </div>
        <div className="ongoing-list" aria-label="Pågående vägningar">
          {ongoing.map((draft) => (
            <OngoingCard key={draft.id} draft={draft} />
          ))}
          {!ongoing.length && (
            <div className="quiet-card">
              <Scale size={24} />
              Inga pågående vägningar.
            </div>
          )}
        </div>
        <p className="field-help">Tryck på en vägning för att fortsätta.</p>
      </main>
      <Nav />
    </>
  );
}
function OngoingCard({ draft }: { draft: Draft }) {
  const { data } = useDemo();
  const navigate = useNavigate();
  const vehicle = draft.rows.find((r) => r.method === 'vehicle');
  const article = draft.rows[0] && articleById(draft.rows[0].articleId);
  const customer = data.customers.find((c) => c.id === draft.customerId);
  return (
    <button className="pending-mini" onClick={() => navigate(draftPath(draft))}>
      {vehicle ? <Truck size={26} /> : <Scale size={26} />}
      <span className="pending-copy">
        <strong>
          {vehicle?.registration ||
            customer?.name ||
            `Vägning #${draft.number}`}
        </strong>
        <span
          className={`badge ${draft.status === 'awaiting-exit' ? 'amber' : 'blue'}`}
        >
          {draft.status === 'awaiting-exit' ? 'Väntar på utvägning' : 'Utkast'}
        </span>
        <small>
          {article?.name ?? 'Material ej valt'} ·{' '}
          {vehicle && vehicle.tare == null
            ? `Invägt ${kilos(vehicle.gross ?? 0)}`
            : kilos(totalWeight(draft))}{' '}
          kg
        </small>
        <small>Sparad {dateTime(draft.updatedAt)}</small>
      </span>
      <ChevronRight size={17} />
    </button>
  );
}
export function DraftsPage() {
  const { data, removeDraft } = useDemo();
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState<Draft | null>(null);
  const [reset, setReset] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    listRef.current?.scrollTo(0, 0);
  }, [history, search]);
  const drafts = data.drafts
    .filter((d) => (d.status === 'ready') === history)
    .filter((d) =>
      `${d.number} ${data.customers.find((c) => c.id === d.customerId)?.name ?? ''} ${d.vehicleInput?.registration ?? ''} ${d.rows
        .filter((r) => r.method === 'vehicle')
        .map((r) => r.registration)
        .join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  function closeDelete() {
    setDeleting(null);
    setReset((r) => r + 1);
  }
  return (
    <>
      <div className="weighings-fixed-top">
        <Header title="Vägningar">
          <button
            className="avatar-button"
            aria-label="Öppna profil"
            onClick={() => navigate('/profile')}
          >
            NN
          </button>
        </Header>
        <div className="weighings-controls">
          <div className="customer-tabs" role="tablist" aria-label="Vägningar">
            <button
              role="tab"
              aria-selected={!history}
              className={!history ? 'selected' : ''}
              onClick={() => setHistory(false)}
            >
              Pågående
            </button>
            <button
              role="tab"
              aria-selected={history}
              className={history ? 'selected' : ''}
              onClick={() => setHistory(true)}
            >
              Historik
            </button>
          </div>
          <Search
            value={search}
            setValue={setSearch}
            placeholder="Sök kund, regnummer eller vägning"
          />
        </div>
      </div>
      <main
        ref={listRef}
        className="weighings-list"
        aria-label={history ? 'Historik' : 'Pågående vägningar'}
      >
        <p className="muted weighings-count">
          {drafts.length} {history ? 'färdiga' : 'pågående'} vägningar
        </p>
        <div className="stack">
          {drafts.map((d) => (
            <WeighingCard
              key={`${d.id}-${reset}`}
              draft={d}
              onDelete={() => setDeleting(d)}
            />
          ))}
        </div>
        {!drafts.length && (
          <Empty
            title={history ? 'Ingen historik ännu' : 'Inga pågående vägningar'}
            text={
              search
                ? 'Prova en annan sökning.'
                : 'Dina sparade vägningar visas här.'
            }
          />
        )}
        <Notice>
          Vägningarna sparas på den här enheten. Inget skickas till kontoret i
          demon.
        </Notice>
      </main>
      <Nav />
      {deleting && (
        <Modal
          title={
            deleting.status === 'awaiting-exit'
              ? 'Vill du radera denna pågående fordonsvägning?'
              : 'Vill du radera detta utkast?'
          }
          onClose={closeDelete}
        >
          <p>Vägning #{deleting.number} tas bort från den här enheten.</p>
          <Button variant="outline" onClick={closeDelete}>
            Nej
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (removeDraft(deleting.id)) closeDelete();
            }}
          >
            Ja, radera
          </Button>
        </Modal>
      )}
    </>
  );
}
function WeighingCard({
  draft,
  onDelete,
}: {
  draft: Draft;
  onDelete: () => void;
}) {
  const { data } = useDemo();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef({
    x: 0,
    y: 0,
    initial: 0,
    offset: 0,
    axis: '',
    active: false,
  });
  const suppressClick = useRef(false);
  const locked = draft.status === 'ready';
  const awaiting = draft.status === 'awaiting-exit';
  const vehicle = draft.rows.find((r) => r.method === 'vehicle');
  const registration =
    vehicle?.registration || draft.vehicleInput?.registration;
  const customer = data.customers.find((c) => c.id === draft.customerId);
  const askDelete = () => {
    setOffset(0);
    onDelete();
  };
  return (
    <article className={`draft-card swipe-card ${locked ? 'locked-card' : ''}`}>
      {!locked && (
        <button
          className="swipe-delete"
          aria-label={`Radera vägning ${draft.number}`}
          tabIndex={offset < 0 ? 0 : -1}
          aria-hidden={offset === 0}
          onClick={askDelete}
        >
          <Trash2 size={24} />
          <span>Radera</span>
        </button>
      )}
      <button
        className="weighing-card-content"
        aria-label={`Öppna vägning ${draft.number}`}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : undefined,
        }}
        onPointerDown={(e) => {
          if (locked || !e.isPrimary || e.button !== 0) return;
          suppressClick.current = false;
          gesture.current = {
            x: e.clientX,
            y: e.clientY,
            initial: offset,
            offset,
            axis: '',
            active: true,
          };
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g.active) return;
          const dx = e.clientX - g.x,
            dy = e.clientY - g.y;
          if (!g.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 8) {
            g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            suppressClick.current = true;
            if (g.axis === 'x') {
              e.currentTarget.setPointerCapture(e.pointerId);
              setDragging(true);
            }
          }
          if (g.axis === 'x') {
            g.offset = Math.max(-170, Math.min(0, g.initial + dx));
            setOffset(g.offset);
          }
        }}
        onPointerUp={() => {
          const g = gesture.current;
          if (!g.active) return;
          g.active = false;
          setDragging(false);
          if (g.axis === 'x') {
            if (g.offset <= -130) askDelete();
            else setOffset(g.offset < -35 ? -88 : 0);
          }
        }}
        onPointerCancel={() => {
          gesture.current.active = false;
          suppressClick.current = true;
          setDragging(false);
          setOffset(0);
        }}
        onClick={(e) => {
          if (suppressClick.current && e.detail !== 0) {
            suppressClick.current = false;
            return;
          }
          if (offset !== 0) {
            setOffset(0);
            return;
          }
          navigate(draftPath(draft));
        }}
      >
        <span className="weighing-card-copy">
          <strong>
            {customer?.name || registration || `Vägning #${draft.number}`}
          </strong>
          <span className="muted">
            {registration
              ? `${registration} · Fordonsvåg`
              : draft.mode === 'vehicle'
                ? 'Fordonsvåg'
                : 'Materialvåg'}
            {!customer && registration ? ' · Kund ej vald' : ''}
          </span>
          <span
            className={`badge ${locked ? 'green' : awaiting ? 'amber' : 'blue'}`}
          >
            {locked && <LockKeyhole size={13} />}
            {locked
              ? 'Färdig · låst'
              : awaiting
                ? 'Väntar på utvägning'
                : 'Utkast'}
          </span>
          <small className="muted">
            #{draft.number} · {dateTime(draft.updatedAt)}
            {locked ? ` · ${draft.rows.length} material` : ''}
          </small>
        </span>
        <span className="weighing-card-weight">
          {awaiting && <small>Infart</small>}
          <strong>
            {kilos(awaiting ? (vehicle?.gross ?? 0) : totalWeight(draft))} kg
          </strong>
        </span>
        <ChevronRight size={19} />
      </button>
    </article>
  );
}
export function PricesPage() {
  const { data } = useDemo();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [choosing, setChoosing] = useState(false);
  const [customerSearch, setCustomerSearch] = useState('');
  const customer = data.customers.find((c) => c.id === customerId);
  const matches = data.customers.filter((c) =>
    `${c.name} ${c.number}`
      .toLowerCase()
      .includes(customerSearch.toLowerCase()),
  );
  const [search, setSearch] = useState('');
  const filtered = articles.filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Header title="Prislista" />
      <main className="page-body with-nav">
        <Search
          value={search}
          setValue={setSearch}
          placeholder="Sök material eller artikel"
        />
        <div className="price-customer-bar">
          {customer ? (
            <>
              <button
                className="price-customer-selected"
                onClick={() => {
                  setCustomerSearch('');
                  setChoosing(true);
                }}
                aria-label="Byt kund i prislistan"
              >
                <UserRound size={17} />
                <strong>{customer.name}</strong>
              </button>
              <button
                className="icon-button"
                aria-label="Ta bort vald kund"
                onClick={() => setCustomerId(undefined)}
              >
                <X size={19} />
              </button>
            </>
          ) : (
            <button
              className="price-add-customer"
              onClick={() => {
                setCustomerSearch('');
                setChoosing(true);
              }}
            >
              <Plus size={17} />
              Lägg till kund
            </button>
          )}
        </div>
        <div className="price-intro">
          <span className="badge blue">EXEMPELPRISER</span>
          <span className="muted small">kr / kg</span>
        </div>
        <div
          className={`price-table ${customer ? 'customer-price-table' : ''}`}
        >
          <div className="price-head">
            <span>Artikel</span>
            {customer ? (
              <span>Kundpris</span>
            ) : (
              <>
                <span>A</span>
                <span>B</span>
                <span>C</span>
              </>
            )}
          </div>
          {filtered.map((a) => (
            <div className="price-row" key={a.id}>
              <div className="price-article">
                <Photo index={a.photos[0]} label={a.name} />
                <strong>{a.name}</strong>
              </div>
              {customer ? (
                <span className="customer-price-value">
                  <strong>
                    {money(demoCustomerPrice(customer.id, a).price)}
                  </strong>
                  <small
                    className={`badge ${demoCustomerPrice(customer.id, a).source === 'Specialpris' ? 'green' : 'blue'}`}
                  >
                    {demoCustomerPrice(customer.id, a).source}
                  </small>
                </span>
              ) : (
                a.prices.map((price, index) => (
                  <span className={`price-value tier-${index}`} key={index}>
                    {money(price)}
                  </span>
                ))
              )}
            </div>
          ))}
        </div>
        {!filtered.length && (
          <Empty title="Inga artiklar hittades" text="Prova ett annat namn." />
        )}
        <Notice>
          {customer
            ? 'Fiktiva kundpriser för demonstration. Varje artikel har egen prisnivå; specialpris går före A/B/C. Kontorets prissättning och volymberäkning är ännu inte anslutna.'
            : 'Allmän prislista med fiktiva demopriser. Välj en kund för att visa kundens demopriser.'}
        </Notice>
      </main>
      <Nav />
      {choosing && (
        <Modal title="Välj kund" onClose={() => setChoosing(false)}>
          <Search
            value={customerSearch}
            setValue={setCustomerSearch}
            placeholder="Sök kund eller kundnummer"
          />
          <div className="price-customer-options">
            {matches.map((c) => (
              <button
                key={c.id}
                className="customer-choice"
                onClick={() => {
                  setCustomerId(c.id);
                  setChoosing(false);
                }}
              >
                <UserRound size={20} />
                <span>
                  <strong>{c.name}</strong>
                  <small>
                    {c.type} · {c.number}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
            {!matches.length && <p className="muted">Ingen kund hittades.</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
export function ProfilePage() {
  const { logout, reset } = useDemo();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState('');
  return (
    <>
      <Header title="Profil" />
      <main className="page-body with-nav">
        <section className="profile-identity">
          <span className="big-avatar">NN</span>
          <h2>Niklas Nilsson</h2>
          <p>Gårdspersonal</p>
          <DemoBadge />
        </section>
        <div className="profile-data">
          <div>
            <span>Användarnamn</span>
            <strong>niklas</strong>
          </div>
          <div>
            <span>Plats</span>
            <strong>Gårdsplan</strong>
          </div>
          <div>
            <span>Konto</span>
            <strong>Demokonto · v{APP_VERSION}</strong>
          </div>
        </div>
        <MenuRow
          title="Byt lösenord"
          icon={LockKeyhole}
          onClick={() => navigate('/password')}
        />
        <Notice>
          <strong>Hjälp med lösenord</strong>
          <br />I den färdiga appen hjälper systemadmin dig med ett tillfälligt
          lösenord.
        </Notice>
        <MenuRow
          title="Återställ demodata"
          description="Börja om med exempelvägningarna"
          icon={RotateCcw}
          onClick={() => setConfirm(true)}
        />
        {message && <Notice tone="green">{message}</Notice>}
        <Button
          variant="danger"
          icon={LogOut}
          onClick={() => {
            logout();
            navigate('/');
          }}
        >
          Logga ut
        </Button>
      </main>
      <Nav />
      {confirm && (
        <Modal title="Återställ demon?" onClose={() => setConfirm(false)}>
          <p>
            Alla lokala demoutkast och nya demokunder ersätts med
            exempeluppgifterna.
          </p>
          <Button
            onClick={() => {
              if (reset()) {
                setConfirm(false);
                setMessage('Demodata är återställda.');
              }
            }}
          >
            Återställ demodata
          </Button>
          <Button variant="outline" onClick={() => setConfirm(false)}>
            Avbryt
          </Button>
        </Modal>
      )}
    </>
  );
}
export function PasswordPage() {
  const { changePassword, passwordRequired, logout } = useDemo();
  const navigate = useNavigate();
  const [current, setCurrent] = useState(passwordRequired ? 'Demo123!' : '');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const rules = [
    next.length >= 8,
    /[a-zåäö]/.test(next),
    /[A-ZÅÄÖ]/.test(next),
    /\d/.test(next),
  ];
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!rules.every(Boolean)) {
      setError('Det nya lösenordet uppfyller inte alla krav.');
      return;
    }
    if (next !== repeat) {
      setError('De nya lösenorden är inte lika.');
      return;
    }
    if (!changePassword(current, next)) {
      setError('Nuvarande lösenord stämmer inte.');
      return;
    }
    setError('');
    if (passwordRequired) {
      navigate('/');
      return;
    }
    setSuccess(true);
    setCurrent('');
    setNext('');
    setRepeat('');
  }
  return (
    <>
      <Header
        title="Byt lösenord"
        back={passwordRequired ? '/' : '/profile'}
        onBack={
          passwordRequired
            ? () => {
                logout();
                navigate('/');
              }
            : undefined
        }
      />
      <main className="page-body password-page">
        <h2>Välj ditt nya lösenord</h2>
        <p className="muted">Byt lösenord innan du fortsätter.</p>
        <form className="stack" onSubmit={submit}>
          <label>
            Nuvarande lösenord
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            Nytt lösenord
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
          <label>
            Bekräfta nytt lösenord
            <input
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </label>
          <div className="password-rules">
            {[
              'Minst 8 tecken',
              'Minst en liten bokstav',
              'Minst en stor bokstav',
              'Minst en siffra',
            ].map((r, i) => (
              <span className={rules[i] ? 'met' : ''} key={r}>
                <Check size={15} />
                {r}
              </span>
            ))}
          </div>
          {error && <Notice tone="red">{error}</Notice>}
          {success && (
            <Notice tone="green">
              Demolösenordet har ändrats för den här öppna appen.
            </Notice>
          )}
          <Button type="submit" icon={Check}>
            {passwordRequired ? 'Spara och fortsätt' : 'Spara lösenord'}
          </Button>
        </form>
      </main>
    </>
  );
}
