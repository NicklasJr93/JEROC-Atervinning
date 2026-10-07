import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  TrendingUp,
  Download,
} from 'lucide-react';
import { initialCustomers, articleById } from '../data';
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
import PricingWorkspace from './PricingWorkspace';
import {
  pricingRequest,
  type PricingState,
  type PricingQuote,
} from './pricing-client';
import {
  QueueSummary,
  QuickActions,
  DailyWeights,
  CardPreview,
  exportOfficeCsv,
} from './OfficeOverview';
import './office.css';
const fmt = (s: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Stockholm',
  }).format(new Date(s));
const rowVisible = (u: OfficeUser, r: OfficeCard['rows'][number]) =>
  !r.pricePending &&
  can(u, 'prices') &&
  can(
    u,
    r.tier === 'Eget' ? 'customerPrices' : (`price${r.tier}` as Permission),
  );
const cardMoneyVisible = (u: OfficeUser, c: OfficeCard) =>
  !c.financialPending &&
  (can(u, 'reports') ||
    can(u, 'attest') ||
    can(u, 'pay') ||
    c.rows.every((r) => rowVisible(u, r)));
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
  const dataRef = useRef(data);
  dataRef.current = data;
  const [error, setError] = useState(initial.error);
  const [blocked, setBlocked] = useState(Boolean(initial.error));
  const [userId, setUserId] = useState<string | undefined>(() => {
    try {
      return sessionStorage.getItem('jeroc.office.user') ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [actingId, setActingId] = useState<string>(() => {
    try {
      return sessionStorage.getItem('jeroc.office.acting') ?? '';
    } catch {
      return '';
    }
  });
  const [previewId, setPreviewId] = useState<number | undefined>(1412);
  const [pricing, setPricing] = useState<PricingState>();
  const [priceBusy, setPriceBusy] = useState(false);
  const [pricingError, setPricingError] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const location = useLocation(),
    navigate = useNavigate();
  const actualUser = data.users.find((u) => u.id === userId);
  const user =
    actualUser?.level === 'Systemadmin' && actingId
      ? (data.users.find((u) => u.id === actingId) ?? actualUser)
      : actualUser;
  const principalRef = useRef('');
  principalRef.current = `${actualUser?.id ?? ''}:${user?.id ?? ''}`;
  const acting = Boolean(actualUser && user && actualUser.id !== user.id);
  const auditActor = user
    ? `${acting ? `${actualUser!.name} som ` : ''}${user.name} · Kontor Norrtälje`
    : '';
  function workAs(id: string) {
    if (actualUser?.level !== 'Systemadmin') return;
    try {
      sessionStorage.setItem('jeroc.office.acting', id);
      setActingId(id);
      setSearch('');
      setMessage('');
      setPreviewId(undefined);
      navigate('/dashboard');
    } catch {
      setError('Tillåt sessionslagring för att använda Jobba som.');
    }
  }
  const section = location.pathname.split('/')[1] || 'dashboard';
  const selectedId = Number(location.pathname.split('/')[2]);
  const selected = data.cards.find((c) => c.id === selectedId);
  useEffect(() => {
    let current = true;
    setPricing(undefined);
    if (user && actualUser && (can(user, 'prices') || can(user, 'lmeRead')))
      pricingRequest<PricingState>(
        section === 'weighings' && selected
          ? `state?at=${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(selected.date))}`
          : 'state',
        user,
        actualUser,
      )
        .then((state) => {
          if (current) {
            setPricing(state);
            setPricingError('');
          }
        })
        .catch((e: Error) => {
          if (current) setPricingError(e.message);
        });
    return () => {
      current = false;
    };
  }, [userId, actingId, section, selectedId]);
  const pendingPrices = data.cards
    .filter(
      (c) =>
        c.pricingSnapshotId && (c.financialPending || c.pricingRowsPending),
    )
    .map((c) => `${c.id}:${c.pricingSnapshotId}`)
    .join(',');
  useEffect(() => {
    let current = true;
    if (!user || !actualUser || !pendingPrices) return;
    const pending = dataRef.current.cards.filter(
      (c) =>
        c.pricingSnapshotId && (c.financialPending || c.pricingRowsPending),
    );
    Promise.all(
      pending.map(async (card) => {
        const archive = await pricingRequest<{
          snapshots: (PricingQuote & { id: string })[];
        }>(`snapshots?cardId=${card.id}`, user, actualUser);
        const snapshot = archive.snapshots.find(
          (entry) => entry.id === card.pricingSnapshotId,
        );
        return { card, snapshot };
      }),
    )
      .then((results) => {
        if (!current) return;
        const live = dataRef.current;
        let changed = false;
        const cards = live.cards.map((card) => {
          const snapshot = results.find(
            (result) => result.card.id === card.id,
          )?.snapshot;
          if (
            !snapshot ||
            card.pricingSnapshotId !== snapshot.id ||
            snapshot.total == null ||
            snapshot.rows.length !== card.rows.length
          )
            return card;
          const rowsPending = snapshot.rows.some((r) => r.price == null);
          if (!card.financialPending && rowsPending) return card;
          changed = true;
          return {
            ...card,
            pricingTotal: snapshot.total,
            financialPending: false,
            pricingRowsPending: rowsPending,
            rows: snapshot.rows.map((r, i) => ({
              ...card.rows[i],
              price: r.price ?? card.rows[i].price,
              pricePending: r.price == null,
              tier: r.tier === 'Special' ? ('Eget' as const) : r.tier,
              volumeBefore: r.volumeBefore ?? card.rows[i].volumeBefore,
              volumeWithDelivery:
                r.volumeWithDelivery ?? card.rows[i].volumeWithDelivery,
              source: r.source,
            })),
          };
        });
        if (changed) persist({ ...live, cards });
      })
      .catch(() => {
        /* A restricted reader keeps financial actions locked until an authorized reader can fetch the snapshot. */
      });
    return () => {
      current = false;
    };
  }, [userId, actingId, pendingPrices]);
  function persist(next: OfficeData, force = false) {
    if (blocked && !force) return false;
    try {
      localStorage.setItem(officeKey, JSON.stringify(officeSchema.parse(next)));
      dataRef.current = next;
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
      if (!blocked && !localStorage.getItem(officeKey))
        persist(dataRef.current);
      sessionStorage.setItem('jeroc.office.user', id);
      sessionStorage.removeItem('jeroc.office.acting');
      setActingId('');
      setUserId(id);
      navigate('/dashboard');
    } catch {
      setError('Tillåt sessionslagring för att öppna demokontot.');
    }
  }
  function update(card: OfficeCard, text: string, right: Permission) {
    if (!user || !can(user, right)) return false;
    const live = dataRef.current;
    const old = live.cards.find((c) => c.id === card.id);
    if (!old || (right === 'pay' && old.financialPending)) return false;
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
        old.financialPending ||
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
          actor: auditActor,
          actualUserId: actualUser?.id,
          effectiveUserId: user.id,
          text,
        },
      ],
    };
    return persist({
      ...live,
      cards: live.cards.map((c) => (c.id === card.id ? saved : c)),
    });
  }
  async function calculatePrices(
    card: OfficeCard,
    customerId = card.customerId,
    customerChange = false,
  ) {
    if (
      !user ||
      !actualUser ||
      !can(user, customerChange ? 'customers' : 'changePrice')
    )
      return;
    const principalId = principalRef.current;
    setPriceBusy(true);
    try {
      const quote = await pricingRequest<PricingQuote>(
        'quote',
        user,
        actualUser,
        {
          customerId,
          deliveredAt: card.date,
          excludeCardId: String(card.id),
          rows: card.rows.map(({ articleId, weight }) => ({
            articleId,
            weight,
          })),
        },
      );
      if (principalRef.current !== principalId) return;
      const live = dataRef.current.cards.find((c) => c.id === card.id);
      if (!live || live.audit.length !== card.audit.length) {
        setMessage(
          'Kortet ändrades under beräkningen. Beräkna priser på nytt.',
        );
        return;
      }
      const rows = quote.rows.map((r, i) => ({
        ...card.rows[i],
        price: r.price ?? card.rows[i].price,
        pricePending: r.price == null,
        tier: r.tier === 'Special' ? ('Eget' as const) : r.tier,
        volumeBefore: r.volumeBefore ?? undefined,
        volumeWithDelivery: r.volumeWithDelivery ?? undefined,
        source: r.source,
        manualOverride: false,
      }));
      update(
        {
          ...card,
          customerId,
          reference: customerChange ? '' : card.reference,
          origin: customerChange ? '' : card.origin,
          rows,
          pricedAt: card.date,
          pricingTotal: quote.total ?? undefined,
          financialPending: quote.total == null,
          pricingRowsPending: quote.rows.some((r) => r.price == null),
        },
        customerChange
          ? `Kund vald: ${initialCustomers.find((c) => c.id === customerId)?.name ?? 'Kund saknas'}. Priser beräknade vid inlämningen.`
          : 'Priser räknade av servern: artikelregler, rullande 12 månader och kundundantag.',
        customerChange ? 'customers' : 'changePrice',
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Priserna kunde inte beräknas.',
      );
    } finally {
      setPriceBusy(false);
    }
  }
  async function prepareCard(card: OfficeCard) {
    if (!user || !actualUser || !can(user, 'prepare') || priceBusy) return;
    const principalId = principalRef.current;
    setPriceBusy(true);
    try {
      const archive = await pricingRequest<{ snapshots: { id: string }[] }>(
        `snapshots?cardId=${card.id}`,
        user,
        actualUser,
      );
      const previousSnapshot = archive.snapshots.at(-1);
      const snapshot = await pricingRequest<PricingQuote & { id: string }>(
        'snapshots',
        user,
        actualUser,
        {
          cardId: String(card.id),
          ...(previousSnapshot
            ? { supersedesSnapshotId: previousSnapshot.id }
            : {}),
          customerId: card.customerId,
          deliveredAt: card.date,
          excludeCardId: String(card.id),
          rows: card.rows.map((r) => ({
            articleId: r.articleId,
            weight: r.weight,
            ...(can(user, 'changePrice') && (r.manualOverride || !r.source)
              ? {
                  override: {
                    price: r.price,
                    tier: r.tier,
                    reason: r.manualOverride
                      ? 'Spårbar prisändring på viktkort'
                      : 'Befintligt prissatt demounderlag',
                  },
                }
              : {}),
          })),
        },
      );
      if (principalRef.current !== principalId) return;
      const rows = snapshot.rows.map((r, i) => ({
        ...card.rows[i],
        price: r.price ?? card.rows[i].price,
        pricePending: r.price == null,
        tier:
          r.tier === 'Special'
            ? ('Eget' as const)
            : (r.tier as OfficeCard['rows'][number]['tier']),
        volumeBefore: r.volumeBefore ?? undefined,
        volumeWithDelivery: r.volumeWithDelivery ?? undefined,
        source: r.source,
      }));
      if (
        update(
          {
            ...card,
            rows,
            status: 'attest',
            preparedBy: user.id,
            pricingSnapshotId: snapshot.id,
            pricedAt: card.date,
            pricingTotal: snapshot.total ?? undefined,
            financialPending: snapshot.total == null,
            pricingRowsPending: snapshot.rows.some((r) => r.price == null),
          },
          'Underlaget färdigställt. Serverns prisögonblicksbild låst vid inlämningsdatum och skickat för attest.',
          'prepare',
        )
      )
        setMessage('Kortet väntar nu på attest.');
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : 'Underlaget kunde inte låsas.',
      );
    } finally {
      setPriceBusy(false);
    }
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
      id: 'lme',
      name: 'LME Cash',
      icon: TrendingUp,
      right: 'lmeRead',
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
    new URLSearchParams(location.search).get('status') ??
    (section === 'attest'
      ? 'attest'
      : section === 'payments'
        ? 'ready'
        : undefined);
  const cards = data.cards
    .filter((c) => !filter || c.status === filter)
    .filter((c) =>
      `${c.id} ${customerName(c)} ${c.reference} ${c.registration ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.id - a.id);
  const pricingAccess =
    user &&
    (can(user, 'prices') ||
      can(user, 'articlesEdit') ||
      can(user, 'customerPrices') ||
      can(user, 'customerPriceEdit'));
  const allowed =
    section === 'weighings'
      ? 'view'
      : section === 'prices' && pricingAccess
        ? undefined
        : nav.find((n) => n.id === section)?.right;
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
            .filter((n) =>
              n.id === 'prices' ? pricingAccess : can(user, n.right),
            )
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
              sessionStorage.removeItem('jeroc.office.acting');
              setActingId('');
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
          {actualUser?.level === 'Systemadmin' && (
            <label className="office-work-as">
              Jobba som
              <select
                aria-label="Jobba som"
                value={acting ? user.id : ''}
                onChange={(e) => workAs(e.target.value)}
              >
                <option value="">Systemadmin · egen behörighet</option>
                {data.users
                  .filter((u) => u.id !== actualUser.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
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
        {acting && (
          <div className="office-acting-banner" role="status">
            <ShieldCheck size={17} />
            <span>
              <strong>Jobbar som {user.name}</strong> · {user.level}
              {can(user, 'attest')
                ? ` · Attestgräns ${money(user.maxAttest)} kr`
                : ''}
              <small>
                Inloggad som {actualUser!.name}. Åtgärder sparar båda namnen i
                historiken.
              </small>
            </span>
            <button onClick={() => workAs('')}>
              Avsluta Jobba som <X size={14} />
            </button>
          </div>
        )}
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
              {pricingError && editable && (
                <div className="office-alert" role="alert">
                  {pricingError}
                </div>
              )}
              <div className="office-detail-grid">
                <div>
                  <section className="office-panel">
                    <div className="office-panel-heading">
                      <h2>Material & prissättning</h2>
                      <strong>{kilos(weight(selected))} kg</strong>
                      {editable && can(user, 'changePrice') && (
                        <button
                          className="office-link"
                          disabled={priceBusy || !selected.customerId}
                          onClick={() => calculatePrices(selected)}
                        >
                          Beräkna priser
                        </button>
                      )}
                    </div>
                    <div className="office-info">
                      Prisdatum {fmt(selected.date)} ·{' '}
                      {selected.pricingSnapshotId
                        ? 'Låst prisögonblicksbild'
                        : 'Serverns artikelregler och kundpriser'}
                    </div>
                    <div className="office-table-wrap">
                      <table className="office-table">
                        <thead>
                          <tr>
                            <th>Material</th>
                            <th>Vikt</th>
                            {can(user, 'prices') && (
                              <>
                                <th>Volym 12 mån</th>
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
                                    {!can(user, 'customerPrices') ||
                                    r.volumeWithDelivery == null
                                      ? '–'
                                      : `${kilos(r.volumeWithDelivery)} kg`}
                                    <small>
                                      {!can(user, 'customerPrices')
                                        ? 'Kundprisbehörighet krävs'
                                        : r.volumeBefore == null
                                          ? 'Beräkna för volymunderlag'
                                          : `Före: ${kilos(r.volumeBefore)} kg`}
                                    </small>
                                  </td>
                                  <td>
                                    <span className="office-rule">
                                      {rowVisible(user, r)
                                        ? r.tier === 'Eget'
                                          ? r.manualOverride
                                            ? 'Engångspris'
                                            : 'Kundpris'
                                          : `${r.tier}-pris`
                                        : 'Dolt pris'}
                                    </span>
                                    <small>
                                      {rowVisible(user, r)
                                        ? (r.source ?? 'Befintligt underlag')
                                        : 'Behörighet saknas'}
                                    </small>
                                  </td>
                                  <td>
                                    {rowVisible(user, r) ? money(r.price) : '–'}
                                  </td>
                                  <td>
                                    {rowVisible(user, r)
                                      ? money(r.weight * r.price)
                                      : '–'}
                                  </td>
                                </>
                              )}
                              {(editable || selected.status === 'attest') &&
                                can(user, 'changePrice') &&
                                rowVisible(user, r) && (
                                  <td>
                                    <PriceEditor
                                      row={r}
                                      disabled={priceBusy}
                                      user={user}
                                      rates={
                                        pricing?.articles.find(
                                          (a) => a.id === r.articleId,
                                        )?.prices
                                      }
                                      onSave={(tier, price) =>
                                        update(
                                          {
                                            ...selected,
                                            status:
                                              selected.status === 'attest'
                                                ? 'complement'
                                                : selected.status,
                                            pricingTotal: undefined,
                                            financialPending: false,
                                            pricingRowsPending: false,
                                            rows: selected.rows.map((x, j) =>
                                              j === i
                                                ? {
                                                    ...x,
                                                    tier,
                                                    price,
                                                    manualOverride: true,
                                                    pricePending: false,
                                                    source:
                                                      'Manuellt engångsval',
                                                  }
                                                : x,
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
                    </div>
                    {selected.gross != null && (
                      <div className="office-scale-facts">
                        <span>
                          Infart<strong>{kilos(selected.gross)} kg</strong>
                        </span>
                        <span>
                          Utfart<strong>{kilos(selected.tare ?? 0)} kg</strong>
                        </span>
                        <span>
                          Nettovikt före avdrag
                          <strong>
                            {kilos(selected.gross - (selected.tare ?? 0))} kg
                          </strong>
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
                        .filter(
                          (a) =>
                            !a.text.startsWith('Pris för') ||
                            can(user, 'changePrice'),
                        )
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
                        disabled={
                          priceBusy || !editable || !can(user, 'customers')
                        }
                        value={selected.customerId ?? ''}
                        onChange={(e) => {
                          if (e.target.value)
                            calculatePrices(selected, e.target.value, true);
                          else
                            update(
                              {
                                ...selected,
                                customerId: undefined,
                                reference: '',
                                origin: '',
                              },
                              'Kund borttagen från underlaget.',
                              'customers',
                            );
                        }}
                      >
                        <option value="">Välj kund</option>
                        {initialCustomers.map((c) => (
                          <option value={c.id} key={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {selected.customerId && (
                      <div className="office-customer-contact">
                        <span className="office-customer-symbol">
                          <Users size={22} />
                        </span>
                        <div>
                          <strong>{customerName(selected)}</strong>
                          <small>
                            {
                              initialCustomers.find(
                                (c) => c.id === selected.customerId,
                              )?.number
                            }{' '}
                            ·{' '}
                            {
                              initialCustomers.find(
                                (c) => c.id === selected.customerId,
                              )?.type
                            }
                          </small>
                        </div>
                        <dl>
                          <dt>Telefon</dt>
                          <dd>
                            {initialCustomers.find(
                              (c) => c.id === selected.customerId,
                            )?.phone || '–'}
                          </dd>
                          <dt>E-post</dt>
                          <dd>
                            {initialCustomers.find(
                              (c) => c.id === selected.customerId,
                            )?.email || '–'}
                          </dd>
                        </dl>
                      </div>
                    )}
                    <DetailFields
                      key={`${selected.id}-${selected.customerId}`}
                      card={selected}
                      disabled={priceBusy || !editable || !can(user, 'prepare')}
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
                        disabled={priceBusy || !editable}
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
                          disabled={priceBusy}
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
                    {selected.financialPending && (
                      <p className="office-small">
                        Beloppet finns i serverns prisunderlag. En användare med
                        ekonomibehörighet behöver läsa in det före attest och
                        utbetalning.
                      </p>
                    )}
                    {cardMoneyVisible(user, selected) ? (
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
                          priceBusy ||
                          !selected.customerId ||
                          !selected.idVerified ||
                          !selected.payment
                        }
                        onClick={() => prepareCard(selected)}
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
                            selected.financialPending ||
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
                        disabled={selected.financialPending}
                        onClick={() => {
                          if (selected.financialPending) return;
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
                            actor: auditActor,
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
                      user={user}
                      open={open}
                      selectedId={previewId}
                      onSelect={setPreviewId}
                    />
                  </section>
                  {data.cards.find((c) => c.id === previewId) && (
                    <CardPreview
                      card={data.cards.find((c) => c.id === previewId)!}
                      user={user}
                      onOpen={open}
                    />
                  )}
                </div>
                <aside>
                  <QuickActions user={user} onNavigate={navigate} />
                  <DailyWeights cards={data.cards} />
                  <section className="office-panel">
                    <h2>Senaste aktivitet</h2>
                    <ol className="office-audit">
                      {data.cards
                        .flatMap((c) =>
                          c.audit.map((a) => ({ ...a, cardId: c.id })),
                        )
                        .filter(
                          (a) =>
                            !a.text.startsWith('Pris för') ||
                            (can(user, 'changePrice') &&
                              can(user, 'customerPrices')),
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
                {can(user, 'reports') && (
                  <button
                    className="office-btn outline"
                    onClick={() => exportOfficeCsv(cards, user)}
                  >
                    <Download size={16} />
                    Exportera kö
                  </button>
                )}
              </div>
              {(section === 'attest' || section === 'payments') && (
                <QueueSummary cards={data.cards} user={user} mode={section} />
              )}
              {['weighings', 'attest', 'payments'].includes(section) && (
                <div className="office-filters">
                  <button
                    className={!filter ? 'active' : ''}
                    onClick={() => navigate(`/${section}?status=`)}
                  >
                    Alla
                  </button>
                  {Object.entries(statusNames)
                    .filter(
                      ([s]) =>
                        section === 'weighings' ||
                        (section === 'payments'
                          ? ['ready', 'paid'].includes(s)
                          : ['attest', 'complement', 'ready'].includes(s)),
                    )
                    .map(([s, label]) => (
                      <button
                        key={s}
                        className={filter === s ? 'active' : ''}
                        onClick={() => navigate(`/${section}?status=${s}`)}
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
                  user={user}
                  open={open}
                  selectedId={previewId}
                  onSelect={setPreviewId}
                />
                {!cards.length && (
                  <p>Inga vägningar matchar den här kön eller sökningen.</p>
                )}
              </section>
              {cards.find((c) => c.id === previewId) && (
                <CardPreview
                  card={cards.find((c) => c.id === previewId)!}
                  user={user}
                  onOpen={open}
                />
              )}
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
                {can(user, 'customerPrices') && (
                  <button
                    className="office-btn outline"
                    onClick={() => navigate('/prices?tab=customer-prices')}
                  >
                    Kundanpassade skrotpriser
                  </button>
                )}
                <p className="office-small">
                  Kundregistret är fiktivt. I första versionen kopplar du kunder
                  till viktkort; fullständig kundadministration kommer senare.
                </p>
              </section>
            </>
          ) : ['prices', 'lme'].includes(section) ? (
            <PricingWorkspace
              user={user}
              actualUser={actualUser!}
              onNotice={setMessage}
              section={
                section === 'lme'
                  ? 'lme'
                  : new URLSearchParams(location.search).get('tab') ===
                      'customer-prices'
                    ? 'customer-prices'
                    : 'articles'
              }
              onSectionChange={(next) =>
                navigate(
                  next === 'lme'
                    ? '/lme'
                    : next === 'customer-prices'
                      ? '/prices?tab=customer-prices'
                      : '/prices',
                )
              }
            />
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
              save={async (users) => {
                if (!can(user, 'users')) return false;
                try {
                  await pricingRequest('users', user, actualUser!, { users });
                  return persist({ ...data, users });
                } catch (e) {
                  setMessage(
                    e instanceof Error
                      ? e.message
                      : 'Behörigheterna kunde inte sparas på servern.',
                  );
                  return false;
                }
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
                  sessionStorage.removeItem('jeroc.office.acting');
                  setActingId('');
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
  user,
  open,
  selectedId,
  onSelect,
}: {
  cards: OfficeCard[];
  showMoney: boolean;
  user: OfficeUser;
  open: (id: number) => void;
  selectedId?: number;
  onSelect?: (id: number) => void;
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
            <tr
              key={c.id}
              className={selectedId === c.id ? 'office-row-selected' : ''}
              onClick={() => onSelect?.(c.id)}
            >
              <td>
                <button
                  className="office-link"
                  aria-label={`Förhandsvisa viktkort ${c.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect?.(c.id);
                  }}
                >
                  #{c.id}
                </button>
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
              {showMoney && (
                <td>
                  {cardMoneyVisible(user, c) ? `${money(amount(c))} kr` : '–'}
                </td>
              )}
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
  disabled,
  user,
  rates,
  onSave,
}: {
  disabled: boolean;
  user: OfficeUser;
  rates?: Record<'A' | 'B' | 'C', number | null>;
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
            setPrice(String(rates?.[t as 'A' | 'B' | 'C'] ?? row.price));
        }}
      >
        {['A', 'B', 'C', 'Eget']
          .filter((t) => t === 'Eget' || can(user, `price${t}` as Permission))
          .map((t) => (
            <option
              key={t}
              disabled={t !== 'Eget' && rates?.[t as 'A' | 'B' | 'C'] == null}
            >
              {t}
            </option>
          ))}
      </select>
      <input
        aria-label="Engångspris kr/kg"
        readOnly={tier !== 'Eget'}
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
    <button
      className="office-link"
      disabled={disabled}
      onClick={() => {
        setTier(row.tier);
        setPrice(String(row.price));
        setOpen(true);
      }}
    >
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
        <button className="office-btn outline" disabled={!card.customerId}>
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
  save: (u: OfficeUser[]) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState(users[0]),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false);
  const editable =
    actor.level === 'Systemadmin' || selected.level !== 'Systemadmin';
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !editable ||
      selected.maxAttest < 0 ||
      (actor.level !== 'Systemadmin' && selected.maxAttest > actor.maxAttest) ||
      !Number.isFinite(selected.maxAttest)
    )
      return;
    setSaving(true);
    if (
      await save(
        users.some((u) => u.id === selected.id)
          ? users.map((u) => (u.id === selected.id ? selected : u))
          : [...users, selected],
      )
    )
      setNotice(
        'Behörigheterna har sparats i kontorsdemon och på prismotorns demoserver.',
      );
    setSaving(false);
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
                disabled={!editable || selected.id === actor.id}
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
                          ? [
                              ...new Set([
                                ...selected.permissions,
                                key as Permission,
                                ...(key === 'lmeWrite'
                                  ? ['lmeRead' as const]
                                  : []),
                              ]),
                            ]
                          : selected.permissions.filter(
                              (p) =>
                                p !== key &&
                                !(key === 'lmeRead' && p === 'lmeWrite'),
                            ),
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
                max={
                  actor.level === 'Systemadmin' ? undefined : actor.maxAttest
                }
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
            <button className="office-btn" disabled={!editable || saving}>
              Spara behörigheter
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
