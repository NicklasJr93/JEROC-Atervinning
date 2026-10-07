import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  List,
  LockKeyhole,
  LogOut,
  MapPin,
  Plus,
  Scale,
  Truck,
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
import { articleById, articles } from '../data';
import { dateTime, kilos, money, totalWeight, type Draft } from '../model';

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
      navigate('/');
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
      <div className="login-hero">
        <Logo />
        <div>
          <span className="eyebrow">GÅRDSAPPEN</span>
          <h1>
            Enklare vägning.
            <br />
            Från första kilo.
          </h1>
          <p>
            Material, vikter och underlag.
            <br />
            Allt på samma kort.
          </p>
        </div>
      </div>
      <section className="login-card">
        <div className="heading-row">
          <h2>Välkommen in</h2>
          <DemoBadge />
        </div>
        <p className="muted">Logga in och börja testa gårdsflödet.</p>
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
          Hjälp med lösenord
        </button>
        <div className="demo-login">
          <span className="eyebrow">PROVA UTAN KRÅNGEL</span>
          <p>
            Demokonto: <strong>niklas</strong> · <strong>Demo123!</strong>
          </p>
          <Button variant="outline" onClick={() => enter('niklas', 'Demo123!')}>
            Öppna demokontot <ChevronRight size={18} />
          </Button>
          <small>
            Fiktiva uppgifter. Vägningar sparas bara i din webbläsare.
          </small>
        </div>
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
  const { data } = useDemo();
  const navigate = useNavigate();
  const pending = data.drafts.filter((d) => d.status === 'awaiting-exit');
  const drafts = data.drafts.filter((d) => d.status !== 'awaiting-exit');
  return (
    <>
      <main className="home-page">
        <header className="home-header">
          <Logo />
          <DemoBadge />
          <button
            className="avatar-button"
            aria-label="Öppna profil"
            onClick={() => navigate('/profile')}
          >
            NN
          </button>
        </header>
        <section className="home-hero">
          <div>
            <span className="eyebrow">REDO FÖR EN NY DAG</span>
            <h1>
              Hej Niklas<span className="greeting-dot">.</span>
            </h1>
            <p>
              <MapPin size={16} /> Gårdsplan
            </p>
          </div>
          <span className="yard-label">
            <span /> Gårdsappen
          </span>
        </section>
        <div className="home-content">
          <button className="hero-action" onClick={() => navigate('/new')}>
            <span className="hero-action-icon">
              <Scale size={33} strokeWidth={1.6} />
            </span>
            <span>
              <strong>Starta invägning</strong>
              <small>Välj material och ange vikt</small>
            </span>
            <ChevronRight />
          </button>
          <div className="quick-actions">
            <button
              className="quick-action"
              onClick={() => navigate('/drafts')}
            >
              <span className="quick-icon blue">
                <List size={25} />
              </span>
              <strong>Mina utkast</strong>
              <small>{drafts.length} sparade vägningar</small>
              <span className="corner-count">{drafts.length}</span>
            </button>
            <button
              className="quick-action"
              onClick={() => navigate('/prices')}
            >
              <span className="quick-icon green">
                <FileText size={25} />
              </span>
              <strong>Prislista</strong>
              <small>Aktuella A-, B- & C-priser</small>
              <ChevronRight size={18} className="corner-arrow" />
            </button>
          </div>
          <div className="section-title">
            <h2>
              Pågående fordon <span>{pending.length}</span>
            </h2>
            <button
              className="text-button"
              onClick={() => navigate('/pending')}
            >
              Visa alla <ChevronRight size={15} />
            </button>
          </div>
          {pending.length ? (
            <div className="stack tight">
              {pending.slice(0, 3).map((d) => (
                <PendingMini key={d.id} draft={d} />
              ))}
            </div>
          ) : (
            <div className="quiet-card">
              <Truck size={24} />
              <span>Inga fordon väntar på utfart.</span>
            </div>
          )}
          <div className="home-note">
            <span className="status-dot" />
            <div>
              <strong>Du testar i demoläge</strong>
              <p>Utkast stannar på den här enheten.</p>
            </div>
          </div>
        </div>
      </main>
      <Nav />
    </>
  );
}
function PendingMini({ draft }: { draft: Draft }) {
  const navigate = useNavigate();
  const row = draft.rows.find((r) => r.method === 'vehicle');
  if (!row || row.method !== 'vehicle') return null;
  const article = articleById(row.articleId);
  return (
    <button
      className="pending-mini"
      onClick={() => navigate(`/weigh/${draft.id}/vehicle`)}
    >
      <Photo index={article.photos[0]} label={article.name} />
      <span className="pending-copy">
        <strong>{row.registration}</strong>
        <small>
          {article.name} · {kilos(row.gross ?? 0)} kg
        </small>
      </span>
      <span className="badge amber">Väntar på utfart</span>
      <ChevronRight size={17} />
    </button>
  );
}
export function DraftsPage() {
  const { data, removeDraft } = useDemo();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<Draft | null>(null);
  const drafts = data.drafts
    .filter((d) => d.status !== 'awaiting-exit')
    .filter((d) =>
      `${d.number} ${data.customers.find((c) => c.id === d.customerId)?.name ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <>
      <Header title="Mina utkast" />
      <main className="page-body with-nav">
        <Search
          value={search}
          setValue={setSearch}
          placeholder="Sök utkast eller kund"
        />
        <p className="section-caption">SPARAT PÅ DEN HÄR ENHETEN</p>
        <div className="stack">
          {drafts.map((d) => (
            <article className="draft-card" key={d.id}>
              <div className="heading-row">
                <h2>
                  #{d.number} <span className="muted">·</span>{' '}
                  {kilos(totalWeight(d))} kg
                </h2>
                <span
                  className={`badge ${d.status === 'ready' ? 'green' : 'amber'}`}
                >
                  {d.status === 'ready' ? 'Färdig · demo' : 'Utkast'}
                </span>
              </div>
              <p>
                {d.rows.length} material ·{' '}
                {data.customers.find((c) => c.id === d.customerId)?.name ??
                  'Kund ej vald'}
              </p>
              <small className="muted">
                Senast sparat {dateTime(d.updatedAt)}
              </small>
              <div className="draft-actions">
                <Button
                  variant="blue"
                  onClick={() =>
                    navigate(
                      `/weigh/${d.id}/${d.mode === 'vehicle' && !d.rows.some((r) => r.method === 'vehicle' && r.tare != null) ? 'vehicle' : 'summary'}`,
                    )
                  }
                >
                  Fortsätt <ChevronRight size={18} />
                </Button>
                <button
                  className="delete-draft"
                  aria-label={`Ta bort utkast ${d.number}`}
                  onClick={() => setDeleting(d)}
                >
                  Ta bort
                </button>
              </div>
            </article>
          ))}
        </div>
        {!drafts.length && (
          <Empty
            title="Inga utkast här"
            text={
              search
                ? 'Prova en annan sökning.'
                : 'Dina sparade vägningar visas här.'
            }
            action={
              <Button icon={Plus} onClick={() => navigate('/new')}>
                Starta invägning
              </Button>
            }
          />
        )}
        <Notice>
          Även färdiga demovägningar är lokala utkast. Ingenting har skickats
          till kontoret.
        </Notice>
      </main>
      <Nav />
      {deleting && (
        <Modal
          title={`Ta bort utkast #${deleting.number}?`}
          onClose={() => setDeleting(null)}
        >
          <p>Utkastet tas bort från den här enheten.</p>
          <Button
            variant="danger"
            onClick={() => {
              if (removeDraft(deleting.id)) setDeleting(null);
            }}
          >
            Ta bort utkast
          </Button>
          <Button variant="outline" onClick={() => setDeleting(null)}>
            Behåll utkast
          </Button>
        </Modal>
      )}
    </>
  );
}
export function PricesPage() {
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
        <div className="price-intro">
          <span className="badge blue">EXEMPELPRISER</span>
          <span className="muted small">kr / kg</span>
        </div>
        <div className="price-table">
          <div className="price-head">
            <span>Artikel</span>
            <span>A</span>
            <span>B</span>
            <span>C</span>
          </div>
          {filtered.map((a) => (
            <div className="price-row" key={a.id}>
              <div className="price-article">
                <Photo index={a.photos[0]} label={a.name} />
                <strong>{a.name}</strong>
              </div>
              {a.prices.map((price, index) => (
                <span className={`price-value tier-${index}`} key={index}>
                  {money(price)}
                </span>
              ))}
            </div>
          ))}
        </div>
        {!filtered.length && (
          <Empty title="Inga artiklar hittades" text="Prova ett annat namn." />
        )}
        <Notice>
          Allmän prislista med fiktiva demopriser. Kundpriser och prissättning
          hanteras senare på kontoret.
        </Notice>
      </main>
      <Nav />
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
            <strong>Demokonto</strong>
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
  const { changePassword } = useDemo();
  const [current, setCurrent] = useState('');
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
    setSuccess(true);
    setCurrent('');
    setNext('');
    setRepeat('');
  }
  return (
    <>
      <Header title="Byt lösenord" back="/profile" />
      <main className="page-body">
        <Notice>
          I demon gäller ändringen tills sidan laddas om. Därefter används
          Demo123! igen.
        </Notice>
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
            Spara lösenord
          </Button>
        </form>
      </main>
    </>
  );
}
