import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Scale,
  Users,
  BadgeCheck,
  Wallet,
  History,
  FileText,
  LogOut,
  ArrowLeft,
  ChevronRight,
  ShieldCheck,
  Search,
  Check,
  Printer,
  Plus,
  X,
} from 'lucide-react';
import { initialCustomers, articles, articleById } from '../data';
import { money, kilos } from '../model';
import {
  OFFICE_VERSION,
  officeKey,
  officeSchema,
  seedOffice,
  can,
  amount,
  weight,
  statusNames,
  permissionNames,
  type OfficeData,
  type OfficeUser,
  type OfficeCard,
  type Permission,
} from './model';
import './office.css';
const fmt = (s: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(s));
const customerName = (c: OfficeCard) =>
  initialCustomers.find((x) => x.id === c.customerId)?.name ?? 'Kund saknas';
export function OfficeApp() {
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(officeKey);
      return {
        data: raw ? officeSchema.parse(JSON.parse(raw)) : seedOffice(),
        error: '',
      };
    } catch {
      return {
        data: seedOffice(),
        error:
          'Kontorsdemon kunde inte läsa sparade uppgifter. Sparandet är blockerat; återställ demon för att fortsätta.',
      };
    }
  });
  const [data, setData] = useState<OfficeData>(initial.data);
  const [error, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const [userId, setUserId] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem('jeroc.office.user') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const location = useLocation(),
    navigate = useNavigate();
  const user = data.users.find((u) => u.id === userId);
  const section = location.pathname.split('/')[1] || 'dashboard';
  const selectedId = Number(location.pathname.split('/')[2]);
  const selected = data.cards.find((c) => c.id === selectedId);
  function persist(next: OfficeData, force = false) {
    if (blocked && !force) return false;
    try {
      localStorage.setItem(officeKey, JSON.stringify(officeSchema.parse(next)));
      setData(next);
      setError('');
      setBlocked(false);
      return true;
    } catch {
      setError(
        'Ändringen kunde inte sparas. Tillåt lokal lagring och försök igen.',
      );
      return false;
    }
  }
  function login(id: string) {
    try {
      sessionStorage.setItem('jeroc.office.user', id);
      setUserId(id);
      navigate('/dashboard');
    } catch {
      setError('Tillåt sessionslagring för att öppna demokontot.');
    }
  }
  function update(card: OfficeCard, text: string, right: Permission) {
    if (!user || !can(user, right)) return false;
    const old = data.cards.find((c) => c.id === card.id);
    if (!old) return false;
    if (
      ['ready', 'paid'].includes(old.status) &&
      !(right === 'pay' && old.status === 'ready' && card.status === 'paid')
    ) {
      setMessage('Kortet är låst. Ändringar ska göras genom ett rättelsekort.');
      return false;
    }
    if (
      right === 'attest' &&
      card.status === 'ready' &&
      (old.status !== 'attest' ||
        amount(old) > user.maxAttest ||
        (!user.ownAttest && old.preparedBy === user.id))
    )
      return false;
    const saved = {
      ...card,
      audit: [
        ...old.audit,
        {
          at: new Date().toISOString(),
          actor: `${user.name} · Kontor Norrtälje`,
          text,
        },
      ],
    };
    return persist({
      ...data,
      cards: data.cards.map((c) => (c.id === card.id ? saved : c)),
    });
  }
  const editable =
    selected && !['attest', 'ready', 'paid'].includes(selected.status);
  const nav = [
    { id: 'dashboard', name: 'Översikt', icon: LayoutDashboard, right: 'view' },
    { id: 'weighings', name: 'Invägningar', icon: Scale, right: 'view' },
    { id: 'attest', name: 'Attest', icon: BadgeCheck, right: 'attest' },
    { id: 'payments', name: 'Utbetalningar', icon: Wallet, right: 'pay' },
    { id: 'customers', name: 'Kunder', icon: Users, right: 'view' },
    {
      id: 'prices',
      name: 'Artiklar & priser',
      icon: FileText,
      right: 'prices',
    },
    {
      id: 'corrections',
      name: 'Rättelser',
      icon: History,
      right: 'corrections',
    },
    { id: 'users', name: 'Användare', icon: ShieldCheck, right: 'users' },
  ] as const;
  function open(id: number) {
    setMessage('');
    navigate(`/weighings/${id}`);
  }
  const filter =
    section === 'attest'
      ? 'attest'
      : section === 'payments'
        ? 'ready'
        : new URLSearchParams(location.search).get('status');
  const cards = data.cards
    .filter((c) => !filter || c.status === filter)
    .filter((c) =>
      `${c.id} ${customerName(c)} ${c.reference} ${c.registration ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.id - a.id);
  const allowed =
    section === 'weighings' ? 'view' : nav.find((n) => n.id === section)?.right;
  if (!user)
    return (
      <div className="office office-login">
        <div className="office-login-card">
          <img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" />
          <span className="office-eyebrow">
            KONTORET · DEMO {OFFICE_VERSION}
          </span>
          <h1>Välkommen till kontoret</h1>
          <p>
            Prova arbetsflödet med ett demokonto. Uppgifterna sparas bara i den
            här webbläsaren.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="office-demo-users">
            {data.users.map((u) => (
              <button key={u.id} onClick={() => login(u.id)}>
                <span className="office-avatar">
                  {u.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')
                    .slice(0, 2)}
                </span>
                <span>
                  <strong>{u.name}</strong>
                  <small>
                    {u.level} ·{' '}
                    {can(u, 'attest')
                      ? `Attest upp till ${money(u.maxAttest)} kr`
                      : 'Granskning och komplettering'}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
          <p className="office-small">
            Ingen riktig inloggning, bankkoppling eller synkning med mobilappen
            ännu.
          </p>
          <a href="/">Öppna gårdsappen</a>
        </div>
      </div>
    );
  return (
    <div className="office">
      <aside className="office-sidebar">
        <img
          className="office-logo"
          src="/images/jeroc-logo-v2.png"
          alt="JEROC Återvinning"
        />
        <span className="office-eyebrow">KONTORSÖVERSIKT</span>
        <nav>
          {nav
            .filter((n) => can(user, n.right))
            .map((n) => (
              <button
                className={section === n.id ? 'active' : ''}
                key={n.id}
                onClick={() => {
                  setSearch('');
                  setMessage('');
                  navigate(`/${n.id}`);
                }}
              >
                <n.icon size={19} />
                {n.name}
                {n.id === 'attest' && (
                  <span>
                    {data.cards.filter((c) => c.status === 'attest').length}
                  </span>
                )}
              </button>
            ))}
        </nav>
        <div className="office-sidebar-bottom">
          <span className="office-online">● Kontorsdemo {OFFICE_VERSION}</span>
          <p>Norrtälje · Alla uppgifter är fiktiva</p>
          <button
            onClick={() => {
              sessionStorage.removeItem('jeroc.office.user');
              setUserId(undefined);
              setSearch('');
            }}
          >
            <LogOut size={17} />
            Byt demokonto
          </button>
        </div>
      </aside>
      <div className="office-workspace">
        <header className="office-topbar">
          <span>
            Kontoret <ChevronRight size={14} />{' '}
            {nav.find((n) => n.id === section)?.name ?? 'Vägning'}
          </span>
          <label className="office-search">
            <Search size={17} />
            <input
              aria-label="Sök vägning, kund eller referens"
              placeholder="Sök vägning, kund eller referens…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (section === 'dashboard') navigate('/weighings');
              }}
            />
          </label>
          <div className="office-user">
            <span className="office-avatar">
              {user.name
                .split(' ')
                .map((n) => n[0])
                .join('')
                .slice(0, 2)}
            </span>
            <span>
              <strong>{user.name}</strong>
              <small>{user.level} · Norrtälje</small>
            </span>
          </div>
        </header>
        <div className="office-demo-notice">
          Demo · Inga riktiga betalningar eller kontorsöverföringar · Separat
          från gårdsappens lokala data
        </div>
        <main className="office-main">
          {error && (
            <div className="office-alert" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="office-message" role="status">
              {message}
              <button
                onClick={() => setMessage('')}
                aria-label="Stäng meddelande"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {allowed && typeof allowed === 'string' && !can(user, allowed) ? (
            <section className="office-panel">
              <h1>Behörighet saknas</h1>
              <p>Ditt konto har inte åtkomst till denna vy.</p>
            </section>
          ) : selected && section === 'weighings' ? (
            <>
              <button
                className="office-back"
                onClick={() => navigate('/weighings')}
              >
                <ArrowLeft size={16} />
                Till invägningar
              </button>
              <div className="office-title">
                <div>
                  <span className="office-eyebrow">
                    UNDERLAG FRÅN GÅRDSPLAN · {selected.yard}
                  </span>
                  <h1>Invägning #{selected.id}</h1>
                  <p>
                    {selected.weigher} · Inlämnat {fmt(selected.date)}
                    {selected.registration
                      ? ` · Fordonsvåg ${selected.registration}`
                      : ''}
                  </p>
                </div>
                <Status status={selected.status} />
              </div>
              <div className="office-detail-grid">
                <div>
                  <section className="office-panel">
                    <div className="office-panel-heading">
                      <h2>Material & prissättning</h2>
                      <strong>{kilos(weight(selected))} kg</strong>
                    </div>
                    <div className="office-info">
                      Pris vid inlämningen · Fiktiva exempelpriser per artikel
                    </div>
                    <table className="office-table">
                      <thead>
                        <tr>
                          <th>Material</th>
                          <th>Vikt</th>
                          {can(user, 'prices') && (
                            <>
                              <th>Prisregel</th>
                              <th>kr/kg</th>
                              <th>Belopp</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {selected.rows.map((r, i) => (
                          <tr key={i}>
                            <td>
                              <span className="office-material">
                                <MaterialImage id={r.articleId} />
                                {articleById(r.articleId).name}
                              </span>
                            </td>
                            <td>{kilos(r.weight)} kg</td>
                            {can(user, 'prices') && (
                              <>
                                <td>
                                  {r.tier === 'Eget' ? 'Engångspris' : r.tier}
                                </td>
                                <td>{money(r.price)}</td>
                                <td>{money(r.weight * r.price)}</td>
                              </>
                            )}
                            {editable && can(user, 'changePrice') && (
                              <td>
                                <PriceEditor
                                  row={r}
                                  onSave={(tier, price) =>
                                    update(
                                      {
                                        ...selected,
                                        rows: selected.rows.map((x, j) =>
                                          j === i ? { ...x, tier, price } : x,
                                        ),
                                      },
                                      `Pris för ${articleById(r.articleId).name} ändrat från ${r.tier} ${money(r.price)} till ${tier} ${money(price)} kr/kg.`,
                                      'changePrice',
                                    )
                                  }
                                />
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {selected.gross != null && (
                      <div className="office-scale-facts">
                        <span>
                          Infart<strong>{kilos(selected.gross)} kg</strong>
                        </span>
                        <span>
                          Utfart<strong>{kilos(selected.tare ?? 0)} kg</strong>
                        </span>
                        <span>
                          Avdrag
                          <strong>{kilos(selected.deduction ?? 0)} kg</strong>
                        </span>
                        <span>
                          Materialvikt
                          <strong>{kilos(weight(selected))} kg</strong>
                        </span>
                      </div>
                    )}
                  </section>
                  <section className="office-panel">
                    <h2>Spårbarhet</h2>
                    <ol className="office-audit">
                      {selected.audit
                        .slice()
                        .reverse()
                        .map((a, i) => (
                          <li key={i}>
                            <i />
                            <div>
                              <strong>{a.text}</strong>
                              <small>
                                {a.actor} · {fmt(a.at)}
                              </small>
                            </div>
                          </li>
                        ))}
                    </ol>
                  </section>
                </div>
                <div>
                  <section className="office-panel">
                    <h2>Kund, referens & ursprung</h2>
                    <label>
                      Kund
                      <select
                        aria-label="Kund på vägningen"
                        disabled={!editable || !can(user, 'customers')}
                        value={selected.customerId ?? ''}
                        onChange={(e) =>
                          update(
                            {
                              ...selected,
                              customerId: e.target.value || undefined,
                              reference: '',
                              origin: '',
                            },
                            `Kund ändrad från ${customerName(selected)} till ${initialCustomers.find((c) => c.id === e.target.value)?.name ?? 'Kund saknas'}.`,
                            'customers',
                          )
                        }
                      >
                        <option value="">Välj kund</option>
                        {initialCustomers.map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <DetailFields
                      key={`${selected.id}-${selected.customerId}`}
                      card={selected}
                      disabled={!editable || !can(user, 'prepare')}
                      save={(reference, origin) =>
                        update(
                          { ...selected, reference, origin },
                          'Referens och ursprung uppdaterade.',
                          'prepare',
                        )
                      }
                    />
                  </section>
                  <section className="office-panel">
                    <h2>Utbetalning & ID</h2>
                    {can(user, 'paymentDetails') ? (
                      <PaymentField
                        key={`${selected.id}-${selected.status}`}
                        card={selected}
                        disabled={!editable}
                        save={(payment) =>
                          update(
                            { ...selected, payment },
                            'Betalningsuppgift ändrad i demon.',
                            'paymentDetails',
                          )
                        }
                      />
                    ) : (
                      <p>
                        {selected.payment
                          ? 'Betalningsuppgifter finns'
                          : 'Betalningsuppgifter saknas'}
                      </p>
                    )}
                    <div
                      className={`office-id ${selected.idVerified ? 'ok' : ''}`}
                    >
                      <ShieldCheck size={20} />
                      {selected.idVerified
                        ? 'ID kontrollerat'
                        : 'ID behöver kontrolleras'}
                    </div>
                    {editable &&
                      can(user, 'verifyId') &&
                      !selected.idVerified && (
                        <button
                          className="office-btn outline"
                          onClick={() =>
                            update(
                              { ...selected, idVerified: true },
                              'Legitimation kontrollerad manuellt och ID markerat verifierat.',
                              'verifyId',
                            )
                          }
                        >
                          Verifiera ID
                        </button>
                      )}
                  </section>
                  <section className="office-panel">
                    <h2>Sammanställning</h2>
                    {can(user, 'prices') || can(user, 'reports') ? (
                      <div className="office-total">
                        <span>Att betala ut</span>
                        <strong>{money(amount(selected))} kr</strong>
                      </div>
                    ) : (
                      <p>
                        {kilos(weight(selected))} kg · {selected.rows.length}{' '}
                        material
                      </p>
                    )}
                    {editable && can(user, 'prepare') && (
                      <button
                        className="office-btn"
                        disabled={
                          !selected.customerId ||
                          !selected.idVerified ||
                          !selected.payment
                        }
                        onClick={() => {
                          if (
                            update(
                              {
                                ...selected,
                                status: 'attest',
                                preparedBy: user.id,
                              },
                              'Underlaget färdigställt och skickat för attest.',
                              'prepare',
                            )
                          )
                            setMessage('Kortet väntar nu på attest.');
                        }}
                      >
                        Skicka för attest <ChevronRight size={16} />
                      </button>
                    )}
                    {editable &&
                      (!selected.customerId ||
                        !selected.idVerified ||
                        !selected.payment) && (
                        <p className="office-small">
                          Välj kund, kontrollera ID och fyll i
                          betalningsuppgifter före attest.
                        </p>
                      )}
                    {selected.status === 'attest' && can(user, 'attest') && (
                      <>
                        <p className="office-small">
                          Din attestgräns: {money(user.maxAttest)} kr
                        </p>
                        <button
                          className="office-btn"
                          disabled={
                            amount(selected) > user.maxAttest ||
                            (!user.ownAttest && selected.preparedBy === user.id)
                          }
                          onClick={() => {
                            if (
                              update(
                                {
                                  ...selected,
                                  status: 'ready',
                                  approvedBy: user.id,
                                },
                                'Kortet attesterat och klart för utbetalning.',
                                'attest',
                              )
                            )
                              setMessage(
                                'Attesterat. Kortet ligger under Utbetalningar.',
                              );
                          }}
                        >
                          Attestera
                        </button>
                        {amount(selected) > user.maxAttest && (
                          <div className="office-alert">
                            Beloppet överstiger din attestgräns. En användare
                            med högre gräns behöver attestera.
                          </div>
                        )}
                        {!user.ownAttest && selected.preparedBy === user.id && (
                          <p>
                            Du får inte attestera ett kort du själv förberett.
                          </p>
                        )}
                        <button
                          className="office-btn outline"
                          onClick={() =>
                            update(
                              { ...selected, status: 'complement' },
                              'Returnerat för komplettering.',
                              'attest',
                            )
                          }
                        >
                          Returnera för komplettering
                        </button>
                      </>
                    )}
                    {selected.status === 'ready' && can(user, 'pay') && (
                      <button
                        className="office-btn"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Registrera en DEMOutbetalning på ${money(amount(selected))} kr? Ingen betalning skickas.`,
                            ) &&
                            update(
                              { ...selected, status: 'paid' },
                              'Utbetalning registrerad i DEMO. Ingen banktransaktion genomförd.',
                              'pay',
                            )
                          )
                            setMessage(
                              'Demoutbetalningen är registrerad. Ingen betalning skickades.',
                            );
                        }}
                      >
                        Registrera demoutbetalning
                      </button>
                    )}
                    {['ready', 'paid'].includes(selected.status) && (
                      <>
                        <p className="office-lock">
                          <ShieldCheck size={16} />
                          Låst underlag · ändringar kräver rättelsekort
                        </p>
                        <button
                          className="office-btn outline"
                          onClick={() => window.print()}
                        >
                          <Printer size={16} />
                          Skriv ut demounderlag
                        </button>
                      </>
                    )}
                  </section>
                  {['ready', 'paid'].includes(selected.status) &&
                    can(user, 'corrections') && (
                      <CorrectionForm
                        card={selected}
                        onSave={(articleId, weightDelta, reason) => {
                          const next = {
                            id:
                              Math.max(
                                0,
                                ...data.corrections.map((c) => c.id),
                              ) + 1,
                            cardId: selected.id,
                            customerId: selected.customerId!,
                            articleId,
                            weightDelta,
                            reason,
                            actor: user.name,
                            at: new Date().toISOString(),
                          };
                          if (
                            persist({
                              ...data,
                              corrections: [...data.corrections, next],
                            })
                          ) {
                            setMessage(
                              'Rättelseutkast skapat. Originalet är oförändrat; saldon och statistik påverkas först när ett framtida rättelseflöde godkänner det.',
                            );
                            navigate('/corrections');
                          }
                        }}
                      />
                    )}
                </div>
              </div>
            </>
          ) : section === 'dashboard' ? (
            <>
              <div className="office-title">
                <div>
                  <span className="office-eyebrow">
                    GOD ÖVERBLICK, FRÅN GÅRD TILL KONTOR
                  </span>
                  <h1>Kontorsöversikt</h1>
                  <p>
                    Här ser du vad som behöver granskas, attesteras och betalas
                    ut.
                  </p>
                </div>
                <span className="office-date">Norrtälje · Kontorsdemo</span>
              </div>
              <div className="office-metrics">
                {(['new', 'complement', 'attest', 'ready'] as const).map(
                  (s, i) => (
                    <button
                      key={s}
                      onClick={() => navigate(`/weighings?status=${s}`)}
                    >
                      <span className={`office-metric-icon metric-${i}`}>
                        <Scale size={21} />
                      </span>
                      <span>
                        <small>{statusNames[s]}</small>
                        <strong>
                          {data.cards.filter((c) => c.status === s).length}
                        </strong>
                        <em>
                          Visa kön <ChevronRight size={12} />
                        </em>
                      </span>
                    </button>
                  ),
                )}
              </div>
              <div className="office-dashboard-grid">
                <div>
                  <section className="office-panel">
                    <div className="office-panel-heading">
                      <div>
                        <h2>Invägningar från gårdsplan</h2>
                        <p>Senaste viktkorten och deras nästa steg</p>
                      </div>
                      <button
                        className="office-link"
                        onClick={() => navigate('/weighings')}
                      >
                        Visa alla <ChevronRight size={15} />
                      </button>
                    </div>
                    <CardTable
                      cards={data.cards
                        .filter((c) => c.status !== 'paid')
                        .sort((a, b) => b.id - a.id)}
                      showMoney={can(user, 'prices') || can(user, 'reports')}
                      open={open}
                    />
                  </section>
                  <section className="office-panel office-flow">
                    <h2>Från invägning till utbetalning</h2>
                    <div>
                      {[
                        'Granska underlag',
                        'Kund, betalning & ID',
                        'Attest med beloppsgräns',
                        'Registrera utbetalning',
                      ].map((s, i) => (
                        <span key={s}>
                          <i>{i + 1}</i>
                          {s}
                          {i < 3 && <ChevronRight size={16} />}
                        </span>
                      ))}
                    </div>
                    <p>
                      Attesterade och utbetalda kort är låsta. Rättelser
                      behåller originalet.
                    </p>
                  </section>
                </div>
                <aside>
                  <section className="office-panel">
                    <h2>Dina behörigheter</h2>
                    <p>{user.level}</p>
                    <div className="office-permission-tags">
                      {Object.keys(permissionNames)
                        .filter((p) => can(user, p as Permission))
                        .map((p) => (
                          <span key={p}>
                            {permissionNames[p as Permission]}
                          </span>
                        ))}
                    </div>
                    {can(user, 'attest') && (
                      <p className="office-small">
                        Attest upp till{' '}
                        <strong>{money(user.maxAttest)} kr</strong>
                        <br />
                        Egen attest:{' '}
                        {user.ownAttest ? 'Tillåten' : 'Inte tillåten'}
                      </p>
                    )}
                  </section>
                  <section className="office-panel">
                    <h2>Senaste aktivitet</h2>
                    <ol className="office-audit">
                      {data.cards
                        .flatMap((c) =>
                          c.audit.map((a) => ({ ...a, cardId: c.id })),
                        )
                        .sort((a, b) => b.at.localeCompare(a.at))
                        .slice(0, 5)
                        .map((a, i) => (
                          <li key={i}>
                            <i />
                            <div>
                              <button
                                className="office-link"
                                onClick={() => open(a.cardId)}
                              >
                                Vägning #{a.cardId}
                              </button>
                              <small>
                                {a.text}
                                <br />
                                {a.actor}
                              </small>
                            </div>
                          </li>
                        ))}
                    </ol>
                  </section>
                </aside>
              </div>
            </>
          ) : ['weighings', 'attest', 'payments'].includes(section) ? (
            <>
              <div className="office-title">
                <div>
                  <h1>
                    {section === 'attest'
                      ? 'Attestöversikt'
                      : section === 'payments'
                        ? 'Utbetalningar'
                        : 'Invägningar'}
                  </h1>
                  <p>
                    {section === 'attest'
                      ? `Din attestgräns: ${money(user.maxAttest)} kr. Kort över gränsen visas men kan inte godkännas.`
                      : section === 'payments'
                        ? 'Attesterade kort som är klara för utbetalning i demon.'
                        : 'Alla viktkort från gårdsplan.'}
                  </p>
                </div>
              </div>
              {section === 'weighings' && (
                <div className="office-filters">
                  <button
                    className={!filter ? 'active' : ''}
                    onClick={() => navigate('/weighings')}
                  >
                    Alla
                  </button>
                  {Object.entries(statusNames).map(([s, label]) => (
                    <button
                      key={s}
                      className={filter === s ? 'active' : ''}
                      onClick={() => navigate(`/weighings?status=${s}`)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <section className="office-panel">
                <CardTable
                  cards={cards}
                  showMoney={can(user, 'prices') || can(user, 'reports')}
                  open={open}
                />
                {!cards.length && (
                  <p>Inga vägningar matchar den här kön eller sökningen.</p>
                )}
              </section>
            </>
          ) : section === 'customers' ? (
            <>
              <h1>Kunder</h1>
              <section className="office-panel">
                <table className="office-table">
                  <thead>
                    <tr>
                      <th>Kund</th>
                      <th>Typ</th>
                      <th>Kontakt</th>
                      <th>Vägningar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {initialCustomers
                      .filter((c) =>
                        c.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((c) => (
                        <tr key={c.id}>
                          <td>
                            <strong>{c.name}</strong>
                            <small>{c.number}</small>
                          </td>
                          <td>{c.type}</td>
                          <td>{c.phone}</td>
                          <td>
                            <button
                              className="office-link"
                              onClick={() => {
                                setSearch(c.name);
                                navigate('/weighings');
                              }}
                            >
                              Visa{' '}
                              {
                                data.cards.filter((x) => x.customerId === c.id)
                                  .length
                              }{' '}
                              viktkort
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="office-small">
                  Kundregistret är fiktivt. I första versionen kopplar du kunder
                  till viktkort; fullständig kundadministration kommer senare.
                </p>
              </section>
            </>
          ) : section === 'prices' ? (
            <>
              <h1>Artiklar & priser</h1>
              <p>Allmänna exempelpriser · kr/kg · skrivskyddad översikt</p>
              <section className="office-panel">
                <table className="office-table">
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      {(['priceA', 'priceB', 'priceC'] as const).map(
                        (right, i) =>
                          can(user, right) && (
                            <th key={right}>{['A', 'B', 'C'][i]}</th>
                          ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {articles
                      .filter((a) =>
                        a.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((a) => (
                        <tr key={a.id}>
                          <td>
                            <span className="office-material">
                              <MaterialImage id={a.id} />
                              {a.name}
                            </span>
                          </td>
                          {a.prices.map(
                            (p, i) =>
                              can(
                                user,
                                (['priceA', 'priceB', 'priceC'] as const)[i],
                              ) && <td key={i}>{money(p)}</td>,
                          )}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </section>
            </>
          ) : section === 'corrections' ? (
            <>
              <h1>Rättelseutkast</h1>
              <p>
                Spårbara utkast kopplade till original och kund. Godkännande,
                saldo och volymjustering byggs i nästa steg.
              </p>
              <section className="office-panel">
                {!data.corrections.length ? (
                  <p>
                    Inga rättelseutkast ännu. Öppna ett låst kort för att skapa
                    ett utkast.
                  </p>
                ) : (
                  <table className="office-table">
                    <thead>
                      <tr>
                        <th>Rättelse</th>
                        <th>Original</th>
                        <th>Material / viktändring</th>
                        <th>Orsak</th>
                        <th>Skapad av</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.corrections.map((c) => (
                        <tr key={c.id}>
                          <td>R-{c.id} · Utkast</td>
                          <td>
                            <button
                              className="office-link"
                              onClick={() => open(c.cardId)}
                            >
                              #{c.cardId}
                            </button>
                          </td>
                          <td>
                            {articleById(c.articleId).name}
                            <small>
                              {c.weightDelta > 0 ? '+' : ''}
                              {kilos(c.weightDelta)} kg
                            </small>
                          </td>
                          <td>{c.reason}</td>
                          <td>
                            {c.actor}
                            <small>{fmt(c.at)}</small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          ) : section === 'users' ? (
            <UserAdmin
              users={data.users}
              actor={user}
              save={(users) => {
                if (!can(user, 'users')) return false;
                return persist({ ...data, users });
              }}
            />
          ) : (
            <section className="office-panel">
              <h1>Vyn finns inte</h1>
              <button
                className="office-btn"
                onClick={() => navigate('/dashboard')}
              >
                Till översikten
              </button>
            </section>
          )}
          <footer className="office-footer">
            JEROC Kontorsdemo {OFFICE_VERSION} · Lokal testdata ·{' '}
            <button
              className="office-link"
              onClick={() => {
                if (
                  window.confirm(
                    'Återställ bara kontorsdemons testdata? Gårdsappens data påverkas inte.',
                  ) &&
                  persist(seedOffice(), true)
                ) {
                  sessionStorage.removeItem('jeroc.office.user');
                  setUserId(undefined);
                  navigate('/dashboard');
                }
              }}
            >
              Återställ kontorsdemo
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Status({ status }: { status: OfficeCard['status'] }) {
  return (
    <span className={`office-status status-${status}`}>
      {status === 'ready' || status === 'paid' ? <Check size={13} /> : null}
      {statusNames[status]}
    </span>
  );
}
function MaterialImage({ id }: { id: string }) {
  const a = articleById(id),
    cell = a.photos[0];
  return (
    <span
      className="office-material-image"
      role="img"
      aria-label={a.name}
      style={{
        backgroundImage: `url(${cell >= 28 ? '/images/copper-grades.png' : '/images/materials.png'})`,
        backgroundSize: cell >= 28 ? '400% 300%' : '400% 700%',
        backgroundPosition: `${(((cell >= 28 ? cell - 28 : cell) % 4) * 100) / 3}% ${(Math.floor((cell >= 28 ? cell - 28 : cell) / 4) * 100) / (cell >= 28 ? 2 : 6)}%`,
      }}
    />
  );
}
function CardTable({
  cards,
  showMoney,
  open,
}: {
  cards: OfficeCard[];
  showMoney: boolean;
  open: (id: number) => void;
}) {
  return (
    <div className="office-table-wrap">
      <table className="office-table">
        <thead>
          <tr>
            <th>Viktkort</th>
            <th>Kund / invägare</th>
            <th>Vikt</th>
            {showMoney && <th>Belopp</th>}
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>#{c.id}</strong>
                <small>{fmt(c.date)}</small>
              </td>
              <td>
                <strong>{customerName(c)}</strong>
                <small>
                  {c.weigher} · {c.yard}
                </small>
              </td>
              <td>
                {kilos(weight(c))} kg<small>{c.rows.length} material</small>
              </td>
              {showMoney && <td>{money(amount(c))} kr</td>}
              <td>
                <Status status={c.status} />
              </td>
              <td>
                <button
                  className="office-view"
                  aria-label={`Öppna viktkort ${c.id}`}
                  onClick={() => open(c.id)}
                >
                  Visa <ChevronRight size={13} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PriceEditor({
  row,
  onSave,
}: {
  row: OfficeCard['rows'][number];
  onSave: (tier: OfficeCard['rows'][number]['tier'], price: number) => boolean;
}) {
  const [open, setOpen] = useState(false),
    [tier, setTier] = useState(row.tier),
    [price, setPrice] = useState(String(row.price));
  return open ? (
    <form
      className="office-price-edit"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(price.replace(',', '.'));
        if (price.trim() && Number.isFinite(n) && n >= 0 && onSave(tier, n))
          setOpen(false);
      }}
    >
      <select
        aria-label="Prisalternativ"
        value={tier}
        onChange={(e) => {
          const t = e.target.value as typeof tier;
          setTier(t);
          if (t !== 'Eget')
            setPrice(
              String(
                articleById(row.articleId).prices[['A', 'B', 'C'].indexOf(t)],
              ),
            );
        }}
      >
        {['A', 'B', 'C', 'Eget'].map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <input
        aria-label="Engångspris kr/kg"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
      />
      <button className="office-view">Spara pris</button>
      <button
        type="button"
        className="office-link"
        onClick={() => setOpen(false)}
      >
        Avbryt
      </button>
    </form>
  ) : (
    <button className="office-link" onClick={() => setOpen(true)}>
      Ändra pris
    </button>
  );
}
function DetailFields({
  card,
  disabled,
  save,
}: {
  card: OfficeCard;
  disabled: boolean;
  save: (r: string, o: string) => boolean;
}) {
  const [reference, setReference] = useState(card.reference),
    [origin, setOrigin] = useState(card.origin);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(reference, origin);
      }}
    >
      <label>
        Referens
        <input
          disabled={disabled || !card.customerId}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          list="office-reference"
        />
      </label>
      <datalist id="office-reference">
        {initialCustomers
          .find((c) => c.id === card.customerId)
          ?.references.map((r) => (
            <option value={r} key={r} />
          ))}
      </datalist>
      <label>
        Ursprungsadress
        <input
          disabled={disabled || !card.customerId}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          list="office-origin"
        />
      </label>
      <datalist id="office-origin">
        {initialCustomers
          .find((c) => c.id === card.customerId)
          ?.origins.map((r) => (
            <option value={r} key={r} />
          ))}
      </datalist>
      {!disabled && (
        <button className="office-btn outline">
          Spara referens & ursprung
        </button>
      )}
    </form>
  );
}
function PaymentField({
  card,
  disabled,
  save,
}: {
  card: OfficeCard;
  disabled: boolean;
  save: (p: string) => boolean;
}) {
  const [payment, setPayment] = useState(card.payment);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (payment.trim()) save(payment.trim());
      }}
    >
      <label>
        Betalningsuppgift (demo)
        <input
          disabled={disabled}
          value={payment}
          onChange={(e) => setPayment(e.target.value)}
          placeholder="Bankkonto / Swish · fiktiva uppgifter"
          required
        />
      </label>
      {!disabled && (
        <button className="office-btn outline">Spara betalningsuppgift</button>
      )}
    </form>
  );
}
function CorrectionForm({
  card,
  onSave,
}: {
  card: OfficeCard;
  onSave: (a: string, w: number, r: string) => void;
}) {
  const [article, setArticle] = useState(card.rows[0].articleId),
    [delta, setDelta] = useState(''),
    [reason, setReason] = useState('');
  return (
    <section className="office-panel">
      <h2>Skapa rättelseutkast</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(delta.replace(',', '.'));
          if (delta.trim() && Number.isFinite(n) && n !== 0 && reason.trim())
            onSave(article, n, reason.trim());
        }}
      >
        <label>
          Material
          <select value={article} onChange={(e) => setArticle(e.target.value)}>
            {card.rows.map((r) => (
              <option key={r.articleId} value={r.articleId}>
                {articleById(r.articleId).name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Viktändring, kg
          <input
            required
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            placeholder="Exempel: −100 eller +25"
          />
        </label>
        <label>
          Orsak / rättelseunderlag
          <input
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button className="office-btn outline">Skapa rättelseutkast</button>
      </form>
    </section>
  );
}
function UserAdmin({
  users,
  actor,
  save,
}: {
  users: OfficeUser[];
  actor: OfficeUser;
  save: (u: OfficeUser[]) => boolean;
}) {
  const [selected, setSelected] = useState(users[0]),
    [notice, setNotice] = useState('');
  const editable =
    actor.level === 'Systemadmin' || selected.level !== 'Systemadmin';
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !editable ||
      selected.maxAttest < 0 ||
      !Number.isFinite(selected.maxAttest)
    )
      return;
    if (
      save(
        users.some((u) => u.id === selected.id)
          ? users.map((u) => (u.id === selected.id ? selected : u))
          : [...users, selected],
      )
    )
      setNotice('Behörigheterna har sparats i kontorsdemon.');
  }
  return (
    <>
      <div className="office-title">
        <div>
          <h1>Användare & behörigheter</h1>
          <p>
            Kontonivå och valbara moment. Reglerna gäller bara i den här demon.
          </p>
        </div>
        <button
          className="office-btn"
          onClick={() => {
            setNotice('');
            setSelected({
              id: crypto.randomUUID(),
              name: '',
              level: 'Medarbetare',
              permissions: ['view'],
              maxAttest: 0,
              ownAttest: false,
            });
          }}
        >
          <Plus size={17} />
          Ny användare
        </button>
      </div>
      <div className="office-user-admin">
        <section className="office-panel">
          {users.map((u) => (
            <button
              className={`office-user-choice ${u.id === selected.id ? 'active' : ''}`}
              key={u.id}
              onClick={() => {
                setSelected(u);
                setNotice('');
              }}
            >
              <strong>{u.name}</strong>
              <small>{u.level}</small>
            </button>
          ))}
        </section>
        <section className="office-panel">
          <form onSubmit={submit}>
            <h2>{selected.name || 'Ny användare'}</h2>
            {notice && <p role="status">{notice}</p>}
            {!editable && (
              <div className="office-alert">
                VD kan inte ändra ett systemadminkonto.
              </div>
            )}
            <label>
              Namn
              <input
                required
                value={selected.name}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <label>
              Kontonivå
              <select
                disabled={!editable}
                value={selected.level}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    level: e.target.value as OfficeUser['level'],
                  })
                }
              >
                {[
                  'Medarbetare',
                  'VD',
                  ...(actor.level === 'Systemadmin' ? ['Systemadmin'] : []),
                ].map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
            <div className="office-permission-grid">
              {Object.entries(permissionNames).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    disabled={!editable || selected.level !== 'Medarbetare'}
                    checked={can(selected, key as Permission)}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        permissions: e.target.checked
                          ? [...selected.permissions, key as Permission]
                          : selected.permissions.filter((p) => p !== key),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label>
              Maxbelopp för attest (kr)
              <input
                type="number"
                min="0"
                step="0.01"
                value={selected.maxAttest}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    maxAttest: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="office-checkbox">
              <input
                type="checkbox"
                checked={selected.ownAttest}
                disabled={!editable}
                onChange={(e) =>
                  setSelected({ ...selected, ownAttest: e.target.checked })
                }
              />
              Får attestera egna förberedda kort
            </label>
            <button className="office-btn" disabled={!editable}>
              Spara behörigheter
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
