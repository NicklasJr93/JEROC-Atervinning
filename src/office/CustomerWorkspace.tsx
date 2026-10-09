import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  ChevronRight,
  Download,
  FileText,
  History,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Scale,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { articles, categories } from '../data';
import {
  amount,
  can,
  statusNames,
  weight,
  type OfficeCard,
  type OfficeCustomer,
  type OfficeData,
  type OfficeUser,
} from './model';
import {
  canSeeMoney,
  customerBalance,
  customerLedger,
  customerStats,
  paymentSummary,
} from './customer-model';
import {
  pricingRequest,
  type CustomerPrice,
  type PriceArticle,
  type PriceTier,
  type PricingState,
  type QuoteRow,
} from './pricing-client';
import PaymentEditor from './PaymentEditor';
import { safeAuditText } from './workflow';
import { cleanCustomerDraft, createCustomerDraft, customerDraftError } from './customer-form';
import './customer.css';

type CorrectionInput = {
  cardId: number;
  articleId: string;
  weightDelta: number;
  reason: string;
  document?: string;
};
export type CustomerWorkspaceProps = {
  data: OfficeData;
  user: OfficeUser;
  actualUser: OfficeUser;
  onSaveCustomer: (customer: OfficeCustomer) => boolean | Promise<boolean>;
  newCustomerDraft?: OfficeCustomer;
  onNewCustomerComplete?: (customer: OfficeCustomer) => boolean | Promise<boolean>;
  onNewCustomerCancel?: () => void;
  onOpenCard: (id: number) => void;
  onNotice: (message: string) => void;
  onCreateCorrection: (input: CorrectionInput) => boolean | Promise<boolean>;
  onSubmitCorrection: (id: number) => boolean | Promise<boolean>;
  onApproveCorrection: (id: number) => boolean | Promise<boolean>;
};
const tabs = [
  ['overview', 'Översikt'],
  ['weighings', 'Vägningar'],
  ['prices', 'Priser'],
  ['details', 'Uppgifter & betalning'],
  ['balance', 'Rättelser & saldo'],
] as const;
const n = (value: number, decimals = 0) =>
  value.toLocaleString('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
const currency = (value: number) => `${n(value, 2)} kr`;
const date = (value?: string) =>
  value
    ? new Date(
        value.length === 10 ? `${value}T12:00:00Z` : value,
      ).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' })
    : '—';
const today = () =>
  new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const articleName = (id: string, state?: PricingState) =>
  state?.articles.find((a) => a.id === id)?.name ??
  articles.find((a) => a.id === id)?.name ??
  id;
type RuleWithAudit = CustomerPrice & {
  at?: string;
  actor?: string;
  actingUser?: string;
};
function sortedRules(rules: CustomerPrice[]) {
  return rules
    .slice()
    .reverse()
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        ((b as RuleWithAudit).at ?? '').localeCompare(
          (a as RuleWithAudit).at ?? '',
        ),
    );
}
function currentRules(rules: CustomerPrice[], at = today()) {
  const result = new Map<string, CustomerPrice>();
  for (const r of sortedRules(rules))
    if (r.effectiveFrom <= at && !result.has(r.articleId))
      result.set(r.articleId, r);
  return [...result.values()];
}
const hasPrices = (user: OfficeUser) =>
  can(user, 'prices') ||
  can(user, 'customerPrices') ||
  can(user, 'customerPriceEdit');
const quoteVisible = (user: OfficeUser, row: QuoteRow) =>
  row.price != null &&
  (row.tier === 'Special' || row.tier === 'Eget'
    ? can(user, 'customerPrices')
    : can(user, `price${row.tier}`));
function visibleTotal(user: OfficeUser, card: OfficeCard) {
  return (
    !card.financialPending &&
    (canSeeMoney(user) ||
      card.rows.every(
        (r) =>
          !r.pricePending &&
          can(user, 'prices') &&
          (r.tier === 'Eget' || r.source === 'Kundanpassat pris'
            ? can(user, 'customerPrices')
            : can(user, `price${r.tier}`)),
      ))
  );
}
function Photo({ id, state }: { id: string; state?: PricingState }) {
  const photo =
    state?.articles.find((a) => a.id === id)?.photos[0] ??
    articles.find((a) => a.id === id)?.photos[0] ??
    0;
  const extra = photo >= 28,
    cell = extra ? photo - 28 : photo;
  return (
    <span
      className="customer-photo"
      aria-hidden="true"
      style={{
        backgroundImage: `url(${extra ? '/images/copper-grades.png' : '/images/materials.png'})`,
        backgroundSize: extra ? '400% 300%' : '400% 700%',
        backgroundPosition: `${((cell % 4) * 100) / 3}% ${(Math.floor(cell / 4) * 100) / (extra ? 2 : 6)}%`,
      }}
    />
  );
}
function Metric({
  icon,
  label,
  value,
  detail,
  tone = 'blue',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className={`customer-metric ${tone}`}>
      <span className="customer-metric-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}
function Section({
  title,
  action,
  children,
  className = '',
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`office-panel customer-panel ${className}`}>
      <div className="customer-section-title">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function csvFile(name: string, rows: (string | number)[][]) {
  const cell = (v: string | number) =>
    `"${String(v)
      .replace(/^[=+@-]/, (s) => `'${s}`)
      .replaceAll('"', '""')}"`;
  const url = URL.createObjectURL(
    new Blob(['\ufeff' + rows.map((r) => r.map(cell).join(';')).join('\n')], {
      type: 'text/csv;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export default function CustomerWorkspace(props: CustomerWorkspaceProps) {
  const { data, user, actualUser, onSaveCustomer, onOpenCard, onNotice,
    newCustomerDraft, onNewCustomerComplete, onNewCustomerCancel } =
    props;
  const location = useLocation(),
    navigate = useNavigate();
  const query = new URLSearchParams(location.search),
    selectedId = decodeURIComponent(location.pathname.split('/')[2] ?? '');
  const customer = data.customers.find((c) => c.id === selectedId),
    isNew = selectedId === 'new';
  const tab = query.get('tab') ?? 'overview';
  const [search, setSearch] = useState(query.get('q') ?? ''),
    [type, setType] = useState(query.get('type') ?? ''),
    [openOnly, setOpenOnly] = useState(query.get('open') === '1'),
    [sort, setSort] = useState(query.get('sort') ?? 'activity');
  const [pricing, setPricing] = useState<PricingState>(),
    [preview, setPreview] = useState<QuoteRow[]>([]),
    [priceError, setPriceError] = useState(''),
    [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState(false),
    [months, setMonths] = useState(12);
  const [freshCustomer, setFreshCustomer] = useState(() => createCustomerDraft(data, newCustomerDraft));
  useEffect(() => {
    if (isNew) setFreshCustomer(createCustomerDraft(data, newCustomerDraft));
  }, [isNew, newCustomerDraft]);
  const listQuery = new URLSearchParams();
  if (search) listQuery.set('q', search);
  if (type) listQuery.set('type', type);
  if (openOnly) listQuery.set('open', '1');
  if (sort !== 'activity') listQuery.set('sort', sort);
  const listUrl = `/customers${listQuery.size ? `?${listQuery}` : ''}`;
  const principal = `${actualUser.id}/${user.id}`;
  useEffect(() => {
    setEditing(false);
    setMonths(12);
  }, [selectedId]);
  useEffect(() => {
    let live = true;
    setPricing(undefined);
    setPreview([]);
    setPriceError('');
    if (!hasPrices(user)) return;
    pricingRequest<PricingState>('state', user, actualUser)
      .then((s) => {
        if (live) setPricing(s);
      })
      .catch((e) => {
        if (live)
          setPriceError(
            e instanceof Error ? e.message : 'Priserna kunde inte hämtas.',
          );
      });
    if (customer && can(user, 'customerPrices'))
      pricingRequest<{ rows: QuoteRow[] }>(
        `customer-preview?customerId=${encodeURIComponent(customer.id)}&at=${today()}`,
        user,
        actualUser,
      )
        .then((s) => {
          if (live) setPreview(s.rows);
        })
        .catch((e) => {
          if (live)
            setPriceError(
              e instanceof Error
                ? e.message
                : 'Kundpriserna kunde inte hämtas.',
            );
        });
    return () => {
      live = false;
    };
  }, [selectedId, principal, refresh, data.corrections, data.cards]);
  function goTab(next: string) {
    setEditing(false);
    navigate(
      `/customers/${encodeURIComponent(customer!.id)}?tab=${next}${listQuery.size ? `&${listQuery}` : ''}`,
    );
  }
  const statistics = data.customers.map((c) => ({
    customer: c,
    stats: customerStats(data, c.id),
  }));
  const filtered = statistics
    .filter(
      ({ customer: c, stats }) =>
        (!type || c.type === type) &&
        (!openOnly || stats.openCount > 0) &&
        `${c.name} ${c.number} ${c.customerNumber} ${c.phone} ${c.registrations.join(' ')}`
          .toLocaleLowerCase('sv')
          .includes(search.toLocaleLowerCase('sv')),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.customer.name.localeCompare(b.customer.name, 'sv')
        : sort === 'weight'
          ? b.stats.totalKg - a.stats.totalKg
          : (b.stats.lastActivity ?? '').localeCompare(
              a.stats.lastActivity ?? '',
            ) || a.customer.name.localeCompare(b.customer.name, 'sv'),
    );
  const showMoney = canSeeMoney(user);
  async function save(c: OfficeCustomer) {
    if (!(await onSaveCustomer(c))) return false;
    onNotice(isNew ? 'Kunden är skapad.' : 'Kunduppgifterna är sparade.');
    setEditing(false);
    if (isNew) {
      if (newCustomerDraft && onNewCustomerComplete) {
        if (!(await onNewCustomerComplete(c))) return false;
      }
      else navigate(`/customers/${encodeURIComponent(c.id)}?tab=details`);
    }
    return true;
  }
  function cancelNewCustomer() {
    if (newCustomerDraft && onNewCustomerCancel) onNewCustomerCancel();
    else navigate(listUrl);
  }
  if (isNew)
    return (
      <div className="office-customers">
        <button
          className="office-link customer-back"
          onClick={cancelNewCustomer}
        >
          <ArrowLeft size={15} /> {newCustomerDraft ? 'Till invägningen' : 'Till kundlistan'}
        </button>
        <h1>Skapa kund</h1>
        <p>
          Kontakt, sparade referenser och betalningsprofil för kommande
          vägningar.
        </p>
        {can(user, 'customers') ? (
          <CustomerDetails
            key={freshCustomer.id}
            customer={freshCustomer}
            customers={data.customers}
            user={user}
            onSave={save}
            onCancel={cancelNewCustomer}
            fresh
          />
        ) : (
          <Section title="Behörighet saknas">
            <p>Du behöver behörighet att ändra kunduppgifter.</p>
          </Section>
        )}
      </div>
    );
  if (!customer)
    return (
      <div className="office-customers">
        <div className="office-title">
          <div>
            <span className="office-eyebrow">
              GOD ÖVERBLICK, FRÅN GÅRD TILL KONTOR
            </span>
            <h1>Kunder</h1>
            <p>Kundregister, aktivitet och betalningsöversikt.</p>
          </div>
          <div className="customer-actions">
            <span className="customer-period">
              <CalendarDays size={15} /> Rullande 12 månader
            </span>
            {can(user, 'reports') && (
              <button
                className="office-btn outline"
                onClick={() =>
                  csvFile('jeroc-kunder.csv', [
                    [
                      'Kundnummer',
                      'Kund',
                      'Typ',
                      'Vikt 12 mån',
                      'Öppna kort',
                      'Saldo',
                    ],
                    ...filtered.map(({ customer: c, stats }) => [
                      c.customerNumber,
                      c.name,
                      c.type,
                      stats.totalKg,
                      stats.openCount,
                      stats.balance,
                    ]),
                  ])
                }
              >
                <Download size={15} /> Exportera
              </button>
            )}
            {can(user, 'customers') && (
              <button
                className="office-btn"
                onClick={() => navigate('/customers/new')}
              >
                <Plus size={15} /> Skapa kund
              </button>
            )}
          </div>
        </div>
        <div className="customer-metrics">
          <Metric
            icon={<Users size={22} />}
            label="Kunder"
            value={n(data.customers.length)}
          />
          <Metric
            icon={<ShieldCheck size={22} />}
            label="Aktiva kunder, 12 mån"
            value={n(
              statistics.filter((s) => s.stats.weighingCount > 0).length,
            )}
            tone="green"
          />
          <Metric
            icon={<Scale size={22} />}
            label="Invägt, 12 mån"
            value={`${n(statistics.reduce((s, v) => s + v.stats.totalKg, 0))} kg`}
            tone="purple"
          />
          <Metric
            icon={<FileText size={22} />}
            label="Öppna viktkort"
            value={n(statistics.reduce((s, v) => s + v.stats.openCount, 0))}
            tone="orange"
          />
        </div>
        <section className="office-panel customer-panel">
          <div className="customer-list-tools">
            <label className="customer-search">
              <Search size={17} />
              <input
                aria-label="Sök kunder"
                placeholder="Sök kund, organisationsnummer, kundnummer eller reg.nr"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="Sortera kunder"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="activity">Senaste aktivitet</option>
              <option value="name">Namn</option>
              <option value="weight">Högsta vikt, 12 mån</option>
            </select>
          </div>
          <div className="customer-filterbar">
            {['', 'Företag', 'Privatperson', 'BRF'].map((value) => (
              <button
                key={value}
                className={type === value ? 'active' : ''}
                onClick={() => setType(value)}
              >
                {value || 'Alla'}
              </button>
            ))}
            <label>
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
              />{' '}
              Med öppna viktkort
            </label>
          </div>
          <div className="customer-table-wrap">
            <table className="office-table customer-table">
              <thead>
                <tr>
                  <th>Kund</th>
                  <th>Typ</th>
                  <th>Senaste aktivitet</th>
                  <th>Vikt, 12 mån</th>
                  <th>Öppna kort</th>
                  {showMoney && <th>Saldo</th>}
                  {can(user, 'customerPrices') && <th>Kundpriser</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ customer: c, stats }) => {
                  const count = currentRules(
                    (pricing?.customerPrices ?? []).filter(
                      (r) => r.customerId === c.id,
                    ),
                  ).filter((r) => r.active).length;
                  return (
                    <tr
                      key={c.id}
                      className="customer-clickrow"
                      onClick={() =>
                        navigate(
                          `/customers/${encodeURIComponent(c.id)}?tab=overview${listQuery.size ? `&${listQuery}` : ''}`,
                        )
                      }
                    >
                      <td>
                        <div className="customer-identity">
                          {c.type === 'Privatperson' ? (
                            <UserRound size={23} />
                          ) : (
                            <Building2 size={23} />
                          )}
                          <div>
                            <button
                              className="office-link"
                              onClick={(e) => {
                                e.stopPropagation();
                                navigate(
                                  `/customers/${encodeURIComponent(c.id)}?tab=overview${listQuery.size ? `&${listQuery}` : ''}`,
                                );
                              }}
                              aria-label={`Öppna kund ${c.name}`}
                            >
                              <strong>{c.name}</strong>
                            </button>
                            <small>
                              {c.customerNumber} · {c.number || 'Nummer saknas'}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>{c.type}</td>
                      <td>{date(stats.lastActivity)}</td>
                      <td>{n(stats.totalKg)} kg</td>
                      <td>{stats.openCount}</td>
                      {showMoney && (
                        <td
                          className={
                            stats.balance < 0
                              ? 'customer-negative'
                              : stats.balance > 0
                                ? 'customer-positive'
                                : ''
                          }
                        >
                          {currency(stats.balance)}
                        </td>
                      )}
                      {can(user, 'customerPrices') && (
                        <td>
                          {count
                            ? `${count} kundpris${count > 1 ? 'er' : ''}`
                            : '—'}
                        </td>
                      )}
                      <td>
                        <ChevronRight size={17} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!filtered.length && (
            <p className="customer-empty">Inga kunder matchar sökningen.</p>
          )}
          <div className="customer-list-footer">
            Visar {filtered.length} av {data.customers.length} kunder
          </div>
        </section>
      </div>
    );
  const stats = customerStats(data, customer.id),
    cards = data.cards
      .filter((c) => c.customerId === customer.id)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id),
    correctionCount = data.corrections.filter(
      (c) => c.customerId === customer.id,
    ).length;
  return (
    <div className="office-customers">
      <div className="customer-profile-heading">
        <button
          className="office-link customer-back"
          onClick={() => navigate(listUrl)}
        >
          <ArrowLeft size={15} /> Till kundlistan
        </button>
        <div className="customer-profile-title">
          <span className="customer-big-icon">
            {customer.type === 'Privatperson' ? (
              <UserRound size={31} />
            ) : (
              <Building2 size={31} />
            )}
          </span>
          <div>
            <h1>{customer.name}</h1>
            <p>
              {customer.customerNumber} · {customer.type} ·{' '}
              {customer.number || 'Nummer saknas'}
            </p>
          </div>
          {can(user, 'customers') && (
            <button
              className="office-btn outline"
              onClick={() => {
                goTab('details');
                setEditing(true);
              }}
            >
              <Pencil size={15} /> Redigera kund
            </button>
          )}
        </div>
        <nav
          className="customer-tabs"
          role="tablist"
          aria-label="Kundkortets flikar"
        >
          {tabs
            .filter(([id]) => id !== 'prices' || hasPrices(user))
            .map(([id, title]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => goTab(id)}
              >
                {title}
              </button>
            ))}
        </nav>
      </div>
      {priceError && (tab === 'prices' || tab === 'overview') && (
        <div className="customer-error" role="alert">
          {priceError}
          <button
            className="office-link"
            onClick={() => setRefresh((v) => v + 1)}
          >
            Försök igen
          </button>
        </div>
      )}
      {tab === 'details' ? (
        <CustomerDetails
          key={`${customer.id}/${principal}`}
          customer={customer}
          customers={data.customers}
          user={user}
          onSave={save}
          onCancel={() => {
            setEditing(false);
            onNotice('Ändringarna har återställts.');
          }}
          editing={editing}
        />
      ) : tab === 'weighings' ? (
        <CustomerWeighings
          users={data.users}
          cards={cards}
          user={user}
          onOpen={onOpenCard}
          state={pricing}
        />
      ) : tab === 'prices' ? (
        hasPrices(user) ? (
          <CustomerPrices
            customer={customer}
            user={user}
            actualUser={actualUser}
            state={pricing}
            preview={preview}
            onSaved={() => {
              setRefresh((v) => v + 1);
              onNotice('Kundprisregeln är sparad på servern.');
            }}
          />
        ) : (
          <Section title="Prisbehörighet saknas">
            <p>Du saknar tillgång till kundens priser.</p>
          </Section>
        )
      ) : tab === 'balance' ? (
        <CustomerBalance {...props} customer={customer} />
      ) : (
        <div className="customer-profile-grid">
          <div className="customer-main-column">
            <Section title="Rullande 12 månader">
              <div className="customer-metrics compact">
                <Metric
                  icon={<Scale size={19} />}
                  label="Nettovikt, 12 mån"
                  value={`${n(stats.totalKg)} kg`}
                />
                <Metric
                  icon={<FileText size={19} />}
                  label="Inlämningar"
                  value={n(stats.weighingCount)}
                  tone="purple"
                />
                <Metric
                  icon={<Wallet size={19} />}
                  label="Avräknat efter rättelser"
                  value={showMoney ? currency(stats.totalValue) : '—'}
                  detail="Rättelser inkluderade"
                  tone="orange"
                />
                <Metric
                  icon={<Building2 size={19} />}
                  label="Utbetalt, 12 mån"
                  value={showMoney ? currency(stats.paidValue) : '—'}
                  tone="green"
                />
              </div>
            </Section>
            <Section
              title="Material över tid"
              action={
                <div className="customer-segment">
                  {[3, 6, 12].map((m) => (
                    <button
                      key={m}
                      className={months === m ? 'active' : ''}
                      onClick={() => setMonths(m)}
                    >
                      {m} mån
                    </button>
                  ))}
                </div>
              }
            >
              <WeightChart
                months={
                  months === 12 ? stats.months : stats.months.slice(-months)
                }
              />
              <p className="customer-note">
                Godkända rättelser räknas på den ursprungliga inlämningsdagen.
              </p>
            </Section>
            <Section
              title="Material & kundpriser"
              action={
                hasPrices(user) && (
                  <button
                    className="office-link"
                    onClick={() => goTab('prices')}
                  >
                    Visa alla priser <ChevronRight size={13} />
                  </button>
                )
              }
            >
              <div className="customer-table-wrap">
                <table className="office-table customer-table">
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      <th>Volym 12 mån</th>
                      {hasPrices(user) && (
                        <>
                          <th>Volymnivå</th>
                          <th>Kundens pris</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {stats.articles.map((a) => {
                      const q = preview.find(
                        (r) => r.articleId === a.articleId,
                      );
                      return (
                        <tr key={a.articleId}>
                          <td>
                            <div className="customer-material">
                              <Photo id={a.articleId} state={pricing} />
                              <strong>
                                {articleName(a.articleId, pricing)}
                              </strong>
                            </div>
                          </td>
                          <td>{n(a.weight)} kg</td>
                          {hasPrices(user) && (
                            <>
                              <td>
                                {q?.volumeTier ? (
                                  <span
                                    className={`customer-tier ${q.volumeTier}`}
                                  >
                                    {q.volumeTier}
                                  </span>
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>
                                {q && quoteVisible(user, q) ? (
                                  <>
                                    <strong>{currency(q.price!)} /kg</strong>
                                    <small>{q.source}</small>
                                  </>
                                ) : (
                                  '—'
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!stats.articles.length && (
                <p>Inga färdigställda inlämningar under perioden.</p>
              )}
              <p className="customer-note">
                Volymnivå per artikel. Kundpriser gäller före ordinarie
                volympris.
              </p>
            </Section>
            <Section
              title="Senaste vägningar"
              action={
                <button
                  className="office-link"
                  onClick={() => goTab('weighings')}
                >
                  Visa alla <ChevronRight size={13} />
                </button>
              }
            >
              <WeighingTable
                users={data.users}
                cards={cards.slice(0, 4)}
                user={user}
                onOpen={onOpenCard}
                state={pricing}
              />
            </Section>
          </div>
          <aside className="customer-side-column">
            <Section
              title="Kontakt"
              action={
                can(user, 'customers') && (
                  <button
                    className="office-link"
                    onClick={() => goTab('details')}
                  >
                    Redigera
                  </button>
                )
              }
            >
              <div className="customer-contact">
                <span>
                  <UserRound size={16} />
                  {customer.contactPerson || customer.name}
                </span>
                <span>
                  <Phone size={16} />
                  {customer.phone || 'Telefon saknas'}
                </span>
                <span>
                  <Mail size={16} />
                  {customer.email || 'E-post saknas'}
                </span>
                <span>
                  <MapPin size={16} />
                  <span>
                    {customer.address || 'Adress saknas'}
                    <small>
                      {customer.postalCode} {customer.city}
                    </small>
                  </span>
                </span>
              </div>
            </Section>
            <Section
              title="Betalningsprofil"
              action={
                can(user, 'paymentDetails') && (
                  <button
                    className="office-link"
                    onClick={() => goTab('details')}
                  >
                    Ändra uppgifter
                  </button>
                )
              }
            >
              <div className="customer-payment-profile">
                <Wallet size={24} />
                <span>
                  {can(user, 'paymentDetails') ||
                  can(user, 'pay') ||
                  can(user, 'attest')
                    ? paymentSummary(customer.paymentProfile) ||
                      'Betalningssätt saknas'
                    : customer.paymentProfile
                      ? 'Betalningsprofil sparad'
                      : 'Betalningssätt saknas'}
                </span>
              </div>
            </Section>
            <Section
              title="Saldo & rättelser"
              action={
                <button
                  className="office-link"
                  onClick={() => goTab('balance')}
                >
                  Visa historik <ChevronRight size={13} />
                </button>
              }
            >
              <strong
                className={`customer-balance-number ${stats.balance < 0 ? 'customer-negative' : 'customer-positive'}`}
              >
                {showMoney ? currency(stats.balance) : '—'}
              </strong>
              <p>
                {stats.balance < 0
                  ? 'Minussaldo att kvitta vid nästa betalning'
                  : 'Återstår att betala'}
              </p>
              <span>
                {correctionCount} rättelsekort · {stats.openCount} öppna
                viktkort
              </span>
            </Section>
            <Section
              title="Sparade uppgifter"
              action={
                <button
                  className="office-link"
                  onClick={() => goTab('details')}
                >
                  Hantera
                </button>
              }
            >
              {[
                ['Referenser', customer.references],
                ['Ursprungsadresser', customer.origins],
                ['Fordon', customer.registrations],
              ].map(([label, values]) => (
                <div className="customer-saved-group" key={String(label)}>
                  <strong>{String(label)}</strong>
                  <div>
                    {(values as string[]).length ? (
                      (values as string[]).map((v) => <span key={v}>{v}</span>)
                    ) : (
                      <small>Inga sparade uppgifter</small>
                    )}
                  </div>
                </div>
              ))}
            </Section>
          </aside>
        </div>
      )}
    </div>
  );
}
function WeightChart({
  months,
}: {
  months: ReturnType<typeof customerStats>['months'];
}) {
  const max = Math.max(1, ...months.map((m) => m.weight));
  return (
    <div
      className="customer-weight-chart"
      role="img"
      aria-label={`Invägd vikt per månad: ${months.map((m) => `${m.label} ${n(m.weight)} kg`).join(', ')}`}
    >
      <div className="customer-chart-bars">
        {months.map((m) => (
          <div className="customer-chart-column" key={m.month}>
            <span className="customer-chart-value">
              {m.weight ? `${n(m.weight)} kg` : ''}
            </span>
            <div className="customer-chart-track">
              <i style={{ height: `${(m.weight / max) * 100}%` }} />
            </div>
            <small>{m.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}
function WeighingTable({
  cards,
  user,
  onOpen,
  state,
  users = [],
}: {
  cards: OfficeCard[];
  user: OfficeUser;
  onOpen: (id: number) => void;
  state?: PricingState;
  users?: OfficeUser[];
}) {
  return (
    <div className="customer-table-wrap">
      <table className="office-table customer-table">
        <thead>
          <tr>
            <th>Kort</th>
            <th>Datum</th>
            <th>Material / vikt</th>
            <th>Belopp</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr
              key={card.id}
              className="customer-clickrow"
              onClick={() => onOpen(card.id)}
            >
              <td>
                <button
                  className="office-link"
                  aria-label={`Öppna viktkort ${card.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(card.id);
                  }}
                >
                  #{card.id}
                </button>
                {card.kind === 'correction' && <small>Plusrättelse</small>}
              </td>
              <td>
                {date(card.date)}
                <small>{card.reference}</small>
              </td>
              <td>
                {card.rows.length === 1
                  ? articleName(card.rows[0].articleId, state)
                  : `${card.rows.length} material`}
                <small>
                  {n(weight(card))} kg
                  {card.registration ? ` · ${card.registration}` : ''}
                </small>
              </td>
              <td>{visibleTotal(user, card) ? currency(amount(card)) : '—'}</td>
              <td>
                <span className={`customer-status ${card.status}`}>
                  {statusNames[card.status]}
                </span>
                <small>
                  {card.status === 'attest'
                    ? 'Ekonomikön'
                    : card.approvedBy
                      ? `Attesterat av ${users?.find((u) => u.id === card.approvedBy)?.name ?? card.approvedBy}`
                      : card.yard}
                </small>
              </td>
              <td>
                <ChevronRight size={15} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!cards.length && (
        <p className="customer-empty">Inga vägningar matchar listan.</p>
      )}
    </div>
  );
}
function CustomerWeighings({
  cards,
  user,
  onOpen,
  state,
  users,
}: {
  cards: OfficeCard[];
  user: OfficeUser;
  onOpen: (id: number) => void;
  state?: PricingState;
  users?: OfficeUser[];
}) {
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('');
  const shown = cards.filter(
    (c) =>
      (!status || c.status === status) &&
      `${c.id} ${c.reference} ${c.origin} ${c.registration ?? ''} ${c.rows.map((r) => articleName(r.articleId, state)).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Section
      title="Kundens vägningar"
      action={
        can(user, 'reports') && (
          <button
            className="office-btn outline"
            onClick={() =>
              csvFile('kundens-vagningar.csv', [
                ['Kort', 'Datum', 'Vikt kg', 'Belopp kr', 'Status', 'Referens'],
                ...shown.map((c) => [
                  c.id,
                  date(c.date),
                  weight(c),
                  visibleTotal(user, c) ? amount(c) : 'Ej tillgängligt',
                  statusNames[c.status],
                  c.reference,
                ]),
              ])
            }
          >
            <Download size={14} /> Exportera
          </button>
        )
      }
    >
      <div className="customer-sticky-tools">
        <label className="customer-search">
          <Search size={16} />
          <input
            aria-label="Sök kundens vägningar"
            placeholder="Sök kort, material, referens eller registrering…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Filtrera kundens vägningar"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Alla statusar</option>
          {Object.entries(statusNames).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <WeighingTable
        users={users}
        cards={shown}
        user={user}
        onOpen={onOpen}
        state={state}
      />
    </Section>
  );
}
function SavedList({
  title,
  values,
  button,
  disabled,
  onChange,
  normalize,
}: {
  title: string;
  values: string[];
  button: string;
  disabled: boolean;
  onChange: (values: string[]) => void;
  normalize?: boolean;
}) {
  const [newValue, setNewValue] = useState(''),
    [editIndex, setEditIndex] = useState<number>();
  function add() {
    const v = normalize
      ? newValue.replace(/\s/g, '').toUpperCase()
      : newValue.trim();
    if (
      !v ||
      values.some(
        (s, i) => s.toLowerCase() === v.toLowerCase() && i !== editIndex,
      )
    )
      return;
    onChange(
      editIndex === undefined
        ? [...values, v]
        : values.map((s, i) => (i === editIndex ? v : s)),
    );
    setNewValue('');
    setEditIndex(undefined);
  }
  return (
    <Section title={title}>
      <div className="customer-saved-list">
        {values.map((v, i) => (
          <div key={`${v}/${i}`}>
            <span>{v}</span>
            {!disabled && (
              <>
                <button
                  type="button"
                  aria-label={`Redigera ${v}`}
                  className="office-link"
                  onClick={() => {
                    setEditIndex(i);
                    setNewValue(v);
                  }}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Ta bort ${v}`}
                  className="office-link customer-negative"
                  onClick={() => onChange(values.filter((_, j) => j !== i))}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {!values.length && (
        <p className="customer-note">Inga sparade uppgifter.</p>
      )}
      {!disabled && (
        <div className="customer-saved-add">
          <input
            aria-label={
              title === 'Sparade referenser'
                ? 'Ny referens'
                : title === 'Ursprungsadresser'
                  ? 'Ny ursprungsadress'
                  : 'Nytt reg.nr'
            }
            placeholder={
              title === 'Registrerade fordon' ? 'ABC123' : 'Skriv här…'
            }
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <button type="button" className="office-btn outline" onClick={add}>
            <Plus size={13} />
            {editIndex === undefined ? button : 'Spara ändring'}
          </button>
          {editIndex !== undefined && (
            <button
              type="button"
              className="office-link"
              onClick={() => {
                setEditIndex(undefined);
                setNewValue('');
              }}
            >
              Avbryt
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
function CustomerDetails({
  customer,
  customers,
  user,
  onSave,
  onCancel,
  fresh = false,
  editing = false,
}: {
  customer: OfficeCustomer;
  customers: OfficeCustomer[];
  user: OfficeUser;
  onSave: (customer: OfficeCustomer) => Promise<boolean>;
  onCancel: () => void;
  fresh?: boolean;
  editing?: boolean;
}) {
  const [draft, setDraft] = useState(customer),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setDraft(customer);
  }, [customer.id, customer.audit.length]);
  const edit = can(user, 'customers'),
    paymentEdit = can(user, 'paymentDetails');
  const paymentRead = paymentEdit || can(user, 'pay') || can(user, 'attest');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!edit || busy) return;
    const customer = cleanCustomerDraft(draft);
    const validationError = customerDraftError(customer, customers);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!(await onSave(customer)))
        setError('Kunduppgifterna kunde inte sparas.');
    } finally {
      setBusy(false);
    }
  }
  function input(
    key:
      | 'name'
      | 'number'
      | 'customerNumber'
      | 'address'
      | 'postalCode'
      | 'city'
      | 'contactPerson'
      | 'phone'
      | 'email',
    label: string,
    required = false,
  ) {
    return (
      <label>
        {label}
        <input
          aria-label={label}
          required={required}
          disabled={!edit || busy || key === 'customerNumber'}
          value={draft[key]}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          type={key === 'email' ? 'email' : 'text'}
        />
      </label>
    );
  }
  return (
    <div className="customer-details-grid">
      <div className="customer-main-column">
        <div className="customer-info">
          <FileText size={16} /> Uppgifter som kan hämtas när kunden väljs på en
          vägning
        </div>
        <form onSubmit={submit}>
          <Section title="Kunduppgifter">
            <div className="customer-form-grid">
              <label>
                Kundtyp
                <select
                  aria-label="Kundtyp"
                  disabled={!edit || busy}
                  value={draft.type}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      type: e.target.value as OfficeCustomer['type'],
                    }))
                  }
                >
                  {['Företag', 'Privatperson', 'BRF'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              {input('customerNumber', 'Kundnummer')}
              {input('name', 'Namn', true)}
              {input('number', 'Organisations-/personnummer')}
              {input('address', 'Adress')}
              {input('postalCode', 'Postnummer')}
              {input('city', 'Ort')}
            </div>
          </Section>
          <Section title="Kontakt">
            <div className="customer-form-grid three">
              {input('contactPerson', 'Kontaktperson')}
              {input('phone', 'Telefon')}
              {input('email', 'E-post')}
            </div>
          </Section>
          {error && (
            <p role="alert" className="customer-error">
              {error}
            </p>
          )}
          {edit && (
            <div className="customer-savebar">
              <button className="office-btn" disabled={busy} type="submit">
                <ShieldCheck size={15} />
                {busy ? 'Sparar…' : 'Spara kunduppgifter'}
              </button>
              <button
                className="office-btn outline"
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(customer);
                  setError('');
                  onCancel();
                }}
              >
                Avbryt
              </button>
              <span>Ändringar används på kommande viktkort</span>
            </div>
          )}
        </form>
        <Section title="Betalningsprofil">
          <p className="customer-note">
            Förvalt betalningssätt när kunden väljs. Låsta viktkort behåller
            sina tidigare uppgifter.
          </p>
          {paymentRead ? (
            <PaymentEditor
              key={customer.id}
              value={draft.paymentProfile}
              customerName={draft.name}
              disabled={!paymentEdit || busy}
              buttonLabel={
                fresh
                  ? 'Spara kund med betalningsprofil'
                  : 'Spara betalningsprofil'
              }
              onSave={async (details) => {
                if (!paymentEdit || !draft.name.trim()) {
                  setError('Spara kundens namn innan betalningsprofilen.');
                  return false;
                }
                const updated = cleanCustomerDraft({ ...draft, paymentProfile: details });
                const validationError = customerDraftError(updated, customers);
                if (validationError) {
                  setError(validationError);
                  return false;
                }
                const saved = await onSave(updated);
                if (saved) setDraft(updated);
                return saved;
              }}
            />
          ) : (
            <p>
              {customer.paymentProfile
                ? 'Betalningsprofil sparad'
                : 'Betalningsprofil saknas'}
            </p>
          )}
        </Section>
        {editing && (
          <p className="customer-note">
            Kunduppgifterna kan redigeras i fälten ovan.
          </p>
        )}
      </div>
      <aside className="customer-side-column">
        <SavedList
          title="Sparade referenser"
          values={draft.references}
          button="Lägg till referens"
          disabled={!edit || busy}
          onChange={(references) => setDraft((d) => ({ ...d, references }))}
        />
        <SavedList
          title="Ursprungsadresser"
          values={draft.origins}
          button="Lägg till adress"
          disabled={!edit || busy}
          onChange={(origins) => setDraft((d) => ({ ...d, origins }))}
        />
        <SavedList
          title="Registrerade fordon"
          values={draft.registrations}
          button="Lägg till reg.nr"
          disabled={!edit || busy}
          normalize
          onChange={(registrations) =>
            setDraft((d) => ({ ...d, registrations }))
          }
        />
        <Section title="Ändringshistorik">
          {customer.audit.length ? (
            <ol className="customer-audit">
              {customer.audit
                .slice()
                .reverse()
                .slice(0, 10)
                .map((a, i) => (
                  <li key={i}>
                    <strong>{a.actor}</strong>
                    <span>{a.text}</span>
                    <small>{date(a.at)}</small>
                  </li>
                ))}
            </ol>
          ) : (
            <p className="customer-note">Inga ändringar registrerade.</p>
          )}
        </Section>
      </aside>
    </div>
  );
}
function CustomerPrices({
  customer,
  user,
  actualUser,
  state,
  preview,
  onSaved,
}: {
  customer: OfficeCustomer;
  user: OfficeUser;
  actualUser: OfficeUser;
  state?: PricingState;
  preview: QuoteRow[];
  onSaved: () => void;
}) {
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState(''),
    [selected, setSelected] = useState('copper-1'),
    [editing, setEditing] = useState(false);
  const list = (state?.articles ?? []).filter(
    (a) =>
      a.active &&
      (!category || a.category === category) &&
      a.name.toLowerCase().includes(search.toLowerCase()),
  );
  const rules = sortedRules(
    (state?.customerPrices ?? []).filter((r) => r.customerId === customer.id),
  );
  const activeRules = currentRules(rules);
  const latestRuleIds = new Set(activeRules.map((r) => r.id ?? r.revisionId));
  if (!state)
    return (
      <Section title="Material & kundpriser">
        <p>Hämtar aktuella priser…</p>
      </Section>
    );
  return (
    <div className="customer-prices-grid">
      <div className="customer-main-column">
        <Section
          title="Material & kundpriser"
          action={
            can(user, 'customerPriceEdit') && (
              <button className="office-btn" onClick={() => setEditing(true)}>
                <Plus size={14} /> Ny kundprisregel
              </button>
            )
          }
        >
          <div className="customer-sticky-tools">
            <label className="customer-search">
              <Search size={16} />
              <input
                aria-label="Sök kundens artiklar"
                placeholder="Sök artikel…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="Filtrera material"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Alla material</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="customer-table-wrap">
            <table className="office-table customer-table">
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Volym 12 mån</th>
                  <th>Nivå</th>
                  {(['A', 'B', 'C'] as PriceTier[])
                    .filter((t) => can(user, `price${t}`))
                    .map((t) => (
                      <th key={t}>{t}</th>
                    ))}
                  {can(user, 'customerPrices') && <th>Kundens pris</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const q = preview.find((r) => r.articleId === a.id);
                  return (
                    <tr
                      key={a.id}
                      className={
                        selected === a.id
                          ? 'customer-selected customer-clickrow'
                          : 'customer-clickrow'
                      }
                      onClick={() => setSelected(a.id)}
                    >
                      <td>
                        <button
                          className="office-link customer-material"
                          onClick={() => setSelected(a.id)}
                        >
                          <Photo id={a.id} state={state} />
                          <strong>{a.name}</strong>
                        </button>
                      </td>
                      <td>
                        {q?.volumeBefore == null
                          ? '—'
                          : `${n(q.volumeBefore)} kg`}
                      </td>
                      <td>
                        {q?.volumeTier ? (
                          <span className={`customer-tier ${q.volumeTier}`}>
                            {q.volumeTier}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      {(['A', 'B', 'C'] as PriceTier[])
                        .filter((t) => can(user, `price${t}`))
                        .map((t) => (
                          <td key={t}>
                            {a.prices[t] == null ? '—' : n(a.prices[t]!, 2)}
                          </td>
                        ))}
                      {can(user, 'customerPrices') && (
                        <td>
                          {q && quoteVisible(user, q) ? (
                            <>
                              <strong>{currency(q.price!)} /kg</strong>
                              <small>{q.source}</small>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="customer-note">
            Alla priser i kr/kg. Volymnivån beräknas per artikel under kundens
            senaste 12 månader.
          </p>
        </Section>
        <PriceTrend
          articleId={selected}
          user={user}
          actualUser={actualUser}
          current={state.articles.find((a) => a.id === selected)}
          customerPrice={preview.find((r) => r.articleId === selected)?.price}
        />
        <Section title="Kundprisregler">
          <div className="customer-table-wrap">
            <table className="office-table customer-table">
              <thead>
                <tr>
                  <th>Artikel</th>
                  <th>Regel</th>
                  <th>Från och med</th>
                  <th>Status</th>
                  {can(user, 'customerPriceEdit') && <th />}
                </tr>
              </thead>
              <tbody>
                {rules.map((r, i) => (
                  <tr key={r.revisionId ?? i}>
                    <td>{articleName(r.articleId, state)}</td>
                    <td>{ruleText(r)}</td>
                    <td>{date(r.effectiveFrom)}</td>
                    <td>
                      <span
                        className={`customer-status ${r.active ? 'ready' : 'complement'}`}
                      >
                        {r.effectiveFrom > today()
                          ? 'Planerad'
                          : !latestRuleIds.has(r.id ?? r.revisionId)
                            ? 'Ersatt'
                            : r.active
                              ? 'Aktiv'
                              : 'Avslutad'}
                      </span>
                    </td>
                    {can(user, 'customerPriceEdit') && (
                      <td>
                        <button
                          className="office-link"
                          aria-label={`Redigera kundpris ${articleName(r.articleId, state)}`}
                          onClick={() => {
                            setSelected(r.articleId);
                            setEditing(true);
                          }}
                        >
                          <Pencil size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rules.length && (
            <p>
              Inga kundanpassade regler. Kundens artikelvolym avgör A, B eller
              C.
            </p>
          )}
        </Section>
      </div>
      <aside className="customer-side-column">
        {can(user, 'customerPriceEdit') && (
          <CustomerRuleEditor
            key={`${selected}/${editing}/${state.revision}`}
            customer={customer}
            user={user}
            actualUser={actualUser}
            state={state}
            articleId={selected}
            rules={rules}
            editing={editing}
            onArticle={(id) => {
              setSelected(id);
              setEditing(true);
            }}
            onSaved={() => {
              setEditing(false);
              onSaved();
            }}
            onCancel={() => setEditing(false)}
          />
        )}
        <Section title="Ändringshistorik">
          {rules.length ? (
            <ol className="customer-audit">
              {rules.slice(0, 10).map((r, i) => (
                <li key={r.id ?? i}>
                  <strong>
                    {articleName(r.articleId, state)} · {ruleText(r)}
                  </strong>
                  <span>
                    {(r as RuleWithAudit).actor ?? 'Registrerad prisregel'}
                    {(r as RuleWithAudit).actingUser
                      ? ` som ${(r as RuleWithAudit).actingUser}`
                      : ''}
                  </span>
                  <small>
                    Gäller från {date(r.effectiveFrom)}
                    {r.note ? ` · ${r.note}` : ''}
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p className="customer-note">
              Inga kundprisändringar registrerade.
            </p>
          )}
        </Section>
        <Section title="Så väljs kundens pris">
          <ol className="customer-priority">
            <li>
              <strong>Aktiv kundprisregel</strong>
              <span>Fast pris, tillägg mot A/B/C eller avdrag från LME.</span>
            </li>
            <li>
              <strong>Volympris per artikel</strong>
              <span>Rullande 12 månader, inklusive godkända rättelser.</span>
            </li>
            <li>
              <strong>Låst prisunderlag</strong>
              <span>
                Tidigare attesterade kort behåller sin sparade prisbild.
              </span>
            </li>
          </ol>
        </Section>
      </aside>
    </div>
  );
}
function ruleText(r: CustomerPrice) {
  return r.kind === 'fixed'
    ? `Fast ${currency(r.price ?? 0)} /kg`
    : r.kind === 'tier-adjustment'
      ? `${r.tier} ${r.adjustmentKr && r.adjustmentKr < 0 ? '−' : '+'} ${n(Math.abs(r.adjustmentKr ?? 0), 2)} kr/kg`
      : `${n(r.discountPercent ?? 0, 2)} % under LME`;
}
function CustomerRuleEditor({
  customer,
  user,
  actualUser,
  state,
  articleId,
  rules,
  editing,
  onArticle,
  onSaved,
  onCancel,
}: {
  customer: OfficeCustomer;
  user: OfficeUser;
  actualUser: OfficeUser;
  state: PricingState;
  articleId: string;
  rules: CustomerPrice[];
  editing: boolean;
  onArticle: (id: string) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const existing = currentRules(rules).find((r) => r.articleId === articleId);
  const [kind, setKind] = useState<CustomerPrice['kind']>(
      existing?.kind ?? 'fixed',
    ),
    [value, setValue] = useState(
      String(
        existing?.price ??
          existing?.adjustmentKr ??
          existing?.discountPercent ??
          0,
      ),
    ),
    [tier, setTier] = useState<PriceTier>(existing?.tier ?? 'A'),
    [from, setFrom] = useState(today()),
    [note, setNote] = useState(existing?.note ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const principal = `${actualUser.id}/${user.id}`,
    livePrincipal = useRef(principal);
  livePrincipal.current = principal;
  async function save(active = true) {
    if (busy) return;
    const numeric = Number(value.replace(',', '.'));
    if (
      !Number.isFinite(numeric) ||
      (kind !== 'tier-adjustment' && numeric < 0) ||
      (kind === 'lme-discount' && numeric > 100)
    ) {
      setError('Kontrollera regelns värde.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await pricingRequest('customer-prices', user, actualUser, {
        customerId: customer.id,
        articleId,
        kind,
        active,
        effectiveFrom: from,
        note,
        ...(kind === 'fixed'
          ? { price: numeric }
          : kind === 'tier-adjustment'
            ? { tier, adjustmentKr: numeric }
            : { discountPercent: numeric }),
      });
      if (livePrincipal.current === principal) onSaved();
    } catch (e) {
      if (livePrincipal.current === principal)
        setError(e instanceof Error ? e.message : 'Regeln kunde inte sparas.');
    } finally {
      if (livePrincipal.current === principal) setBusy(false);
    }
  }
  return (
    <Section title={editing ? 'Redigera kundpris' : 'Kundprisregel'}>
      <form
        className="customer-rule-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Artikel
          <select
            aria-label="Artikel för kundpris"
            value={articleId}
            onChange={(e) => onArticle(e.target.value)}
          >
            {state.articles
              .filter((a) => a.active)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <fieldset disabled={busy}>
          <legend>Prisregel</legend>
          {[
            ['fixed', 'Fast pris'],
            ['tier-adjustment', 'Tillägg / avdrag mot A, B eller C'],
            ['lme-discount', 'Avdrag från LME'],
          ].map(([k, label]) => (
            <label className="customer-radio" key={k}>
              <input
                type="radio"
                name="customer-rule-kind"
                checked={kind === k}
                onChange={() => {
                  setKind(k as CustomerPrice['kind']);
                  setValue('0');
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {kind === 'tier-adjustment' && (
          <label>
            Utgångspris
            <select
              aria-label="Utgångspris"
              value={tier}
              onChange={(e) => setTier(e.target.value as PriceTier)}
            >
              {(['A', 'B', 'C'] as PriceTier[]).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          {kind === 'fixed'
            ? 'Pris kr/kg'
            : kind === 'tier-adjustment'
              ? 'Tillägg eller avdrag kr/kg'
              : 'Procent under LME'}
          <input
            aria-label={
              kind === 'fixed'
                ? 'Pris kr/kg'
                : kind === 'tier-adjustment'
                  ? 'Tillägg eller avdrag kr/kg'
                  : 'Procent under LME'
            }
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        </label>
        <label>
          Gäller från
          <input
            aria-label="Kundpris gäller från"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
        </label>
        <label>
          Anteckning
          <textarea
            aria-label="Anteckning till kundpris"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p className="customer-note">Kundregeln gäller före volympriset.</p>
        {error && (
          <p className="customer-error" role="alert">
            {error}
          </p>
        )}
        <div className="customer-actions">
          <button className="office-btn" type="submit" disabled={busy}>
            Spara regel
          </button>
          <button
            className="office-btn outline"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Avbryt
          </button>
          {existing?.active && (
            <button
              className="office-link customer-negative"
              type="button"
              disabled={busy}
              onClick={() => void save(false)}
            >
              Avsluta regel
            </button>
          )}
        </div>
      </form>
    </Section>
  );
}
function PriceTrend({
  articleId,
  user,
  actualUser,
  current,
  customerPrice,
}: {
  articleId: string;
  user: OfficeUser;
  actualUser: OfficeUser;
  current?: PriceArticle;
  customerPrice?: number | null;
}) {
  const [months, setMonths] = useState(12),
    [history, setHistory] = useState<
      { label: string; prices: PriceArticle['prices'] }[]
    >([]),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setHistory([]);
    setError('');
    const end = new Date(`${today()}T12:00:00Z`);
    const dates = Array.from({ length: months }, (_, index) => {
      const d = new Date(end);
      if (index === months - 1) return today();
      d.setUTCMonth(end.getUTCMonth() - (months - 1 - index), 1);
      return d.toISOString().slice(0, 10);
    });
    Promise.all(
      dates.map(async (at) => {
        const s = await pricingRequest<PricingState>(
          `state?at=${at}`,
          user,
          actualUser,
        );
        return {
          label: new Date(`${at}T12:00:00Z`).toLocaleDateString('sv-SE', {
            month: 'short',
            year: '2-digit',
          }),
          prices: s.articles.find((a) => a.id === articleId)?.prices ?? {
            A: null,
            B: null,
            C: null,
          },
        };
      }),
    )
      .then((rows) => {
        if (live) setHistory(rows);
      })
      .catch((e) => {
        if (live)
          setError(
            e instanceof Error ? e.message : 'Historiken kunde inte hämtas.',
          );
      });
    return () => {
      live = false;
    };
  }, [articleId, months, user.id, actualUser.id, current?.revisionId]);
  const allowed = (['A', 'B', 'C'] as PriceTier[]).filter((t) =>
    can(user, `price${t}`),
  );
  const known = history.flatMap((h) =>
    allowed.map((t) => h.prices[t]).filter((p): p is number => p != null),
  );
  if (customerPrice != null && can(user, 'customerPrices'))
    known.push(customerPrice);
  const max = Math.max(1, ...known) * 1.12;
  return (
    <Section
      title={`Prisutveckling – ${current?.name ?? articleName(articleId)}`}
      action={
        <div className="customer-segment">
          {[3, 6, 12].map((m) => (
            <button
              key={m}
              className={months === m ? 'active' : ''}
              onClick={() => setMonths(m)}
            >
              {m} mån
            </button>
          ))}
        </div>
      }
    >
      {error ? (
        <p className="customer-error">{error}</p>
      ) : !history.length ? (
        <p>Hämtar sparad prishistorik…</p>
      ) : (
        <>
          <div className="customer-trend">
            <svg
              viewBox="0 0 700 180"
              role="img"
              aria-label="Historiska A-, B- och C-priser. Punkter utan sparad prisbild visas som luckor."
            >
              {[0, 1, 2, 3, 4].map((i) => (
                <g key={i}>
                  <line
                    x1="38"
                    x2="686"
                    y1={145 - i * 30}
                    y2={145 - i * 30}
                    stroke="#e7eef8"
                  />
                  <text x="0" y={149 - i * 30} fontSize="10" fill="#788ba8">
                    {n((max * i) / 4, 0)}
                  </text>
                </g>
              ))}
              {allowed.map((t) => (
                <g key={t}>
                  {history.map((h, i) => {
                    const p = h.prices[t],
                      prev = history[i - 1]?.prices[t],
                      x = 42 + (i / Math.max(1, history.length - 1)) * 640,
                      y = p == null ? 145 : 145 - (p / max) * 120;
                    return p == null ? null : (
                      <g key={i}>
                        {prev != null && (
                          <line
                            x1={
                              42 +
                              ((i - 1) / Math.max(1, history.length - 1)) * 640
                            }
                            y1={145 - (prev / max) * 120}
                            x2={x}
                            y2={y}
                            stroke={
                              t === 'A'
                                ? '#0866ed'
                                : t === 'B'
                                  ? '#f39a23'
                                  : '#16a065'
                            }
                            strokeWidth="2"
                          />
                        )}
                        <circle
                          cx={x}
                          cy={y}
                          r="2.5"
                          fill={
                            t === 'A'
                              ? '#0866ed'
                              : t === 'B'
                                ? '#f39a23'
                                : '#16a065'
                          }
                        />
                      </g>
                    );
                  })}
                </g>
              ))}
              {customerPrice != null && can(user, 'customerPrices') && (
                <line
                  x1="42"
                  x2="682"
                  y1={145 - (customerPrice / max) * 120}
                  y2={145 - (customerPrice / max) * 120}
                  stroke="#9955e7"
                  strokeDasharray="6 4"
                  strokeWidth="2"
                />
              )}
              {history.map((h, i) => (
                <text
                  key={i}
                  x={42 + (i / Math.max(1, history.length - 1)) * 640}
                  y="174"
                  textAnchor="middle"
                  fontSize="9"
                  fill="#788ba8"
                >
                  {h.label}
                </text>
              ))}
            </svg>
          </div>
          <div className="customer-trend-key">
            {allowed.map((t) => (
              <span key={t}>
                <i className={t} />
                {t} (nivåpris)
              </span>
            ))}
            {can(user, 'customerPrices') && customerPrice != null && (
              <span>
                <i className="special" />
                Kundpris idag
              </span>
            )}
          </div>
          <p className="customer-note">
            Historiska prisbilder från servern. Perioder utan registrerat pris
            visas som luckor.
          </p>
        </>
      )}
    </Section>
  );
}
function CustomerBalance(
  props: CustomerWorkspaceProps & { customer: OfficeCustomer },
) {
  const {
    data,
    user,
    customer,
    onOpenCard,
    onCreateCorrection,
    onSubmitCorrection,
    onApproveCorrection,
  } = props;
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState(''),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<number>(),
    [busy, setBusy] = useState(false);
  const corrections = data.corrections
      .filter((c) => c.customerId === customer.id)
      .sort((a, b) => b.id - a.id),
    stats = customerStats(data, customer.id),
    ledger = customerLedger(data, customer.id);
  const shown = ledger
    .filter(
      (e) =>
        (!kind || e.kind === kind) &&
        `${e.label} ${e.cardId} ${e.reference ?? ''}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .slice()
    .reverse();
  const correction =
      corrections.find((c) => c.id === selected) ?? corrections[0],
    money = canSeeMoney(user);
  async function act(callback: () => boolean | Promise<boolean>) {
    if (busy) return;
    setBusy(true);
    try {
      await callback();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Section
        title="Saldo & rättelser"
        action={
          <div className="customer-actions">
            {can(user, 'corrections') && (
              <button className="office-btn" onClick={() => setCreating(true)}>
                <Plus size={14} /> Skapa rättelse
              </button>
            )}
            {can(user, 'reports') && (
              <button
                className="office-btn outline"
                onClick={() =>
                  csvFile('kund-saldohistorik.csv', [
                    [
                      'Datum',
                      'Händelse',
                      'Kort',
                      'Förändring',
                      'Saldo efter',
                      'Referens',
                    ],
                    ...ledger.map((e) => [
                      date(e.date),
                      e.label,
                      e.cardId,
                      e.amount,
                      e.balance,
                      e.reference ?? '',
                    ]),
                  ])
                }
              >
                <Download size={14} /> Exportera
              </button>
            )}
          </div>
        }
      >
        <div className="customer-metrics compact">
          <Metric
            icon={<Wallet size={21} />}
            label="Kundsaldo"
            value={money ? currency(customerBalance(data, customer.id)) : '—'}
            detail={
              stats.balance < 0
                ? 'Minussaldo att kvitta'
                : 'Återstår att betala'
            }
            tone="green"
          />
          <Metric
            icon={<Scale size={21} />}
            label="Avräknat efter rättelser"
            value={money ? currency(stats.totalValue) : '—'}
            tone="orange"
          />
          <Metric
            icon={<Building2 size={21} />}
            label="Utbetalt, 12 mån"
            value={money ? currency(stats.paidValue) : '—'}
            tone="blue"
          />
          <Metric
            icon={<History size={21} />}
            label="Rättelsekort"
            value={`${corrections.filter((c) => c.status === 'approved').length} godkända`}
            detail={`${corrections.filter((c) => c.status !== 'approved').length} pågående`}
            tone="purple"
          />
        </div>
      </Section>
      {creating && (
        <CorrectionForm
          data={data}
          customer={customer}
          user={user}
          onSave={async (input) => {
            const ok = await onCreateCorrection(input);
            if (ok) setCreating(false);
            return ok;
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <div className="customer-profile-grid">
        <div className="customer-main-column">
          <Section title="Saldohistorik">
            <div className="customer-sticky-tools">
              <label className="customer-search">
                <Search size={16} />
                <input
                  aria-label="Sök saldohistorik"
                  placeholder="Sök vägning, rättelse eller betalning…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <select
                aria-label="Filtrera saldo"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">Alla händelser</option>
                <option value="weighing">Inlämningar</option>
                <option value="payment">Utbetalningar</option>
                <option value="correction">Rättelser</option>
                <option value="offset">Kvittningar</option>
              </select>
            </div>
            <div className="customer-table-wrap">
              <table className="office-table customer-table">
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Händelse</th>
                    <th>Underlag</th>
                    <th>Förändring</th>
                    <th>Saldo efter</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((e) => (
                    <tr key={e.id}>
                      <td>{date(e.date)}</td>
                      <td>
                        <strong>{e.label}</strong>
                        <small>
                          {e.actor}
                          {e.offset
                            ? ` · ${money ? currency(e.offset) : 'Belopp dolt'} kvittat`
                            : ''}
                        </small>
                      </td>
                      <td>
                        <button
                          className="office-link"
                          onClick={() => onOpenCard(e.cardId)}
                        >
                          #{e.cardId}
                        </button>
                        {e.correctionId && (
                          <button
                            className="office-link"
                            onClick={() => setSelected(e.correctionId)}
                          >
                            R-{e.correctionId}
                          </button>
                        )}
                      </td>
                      <td
                        className={
                          e.amount < 0
                            ? 'customer-negative'
                            : 'customer-positive'
                        }
                      >
                        {money ? currency(e.amount) : '—'}
                      </td>
                      <td className={e.balance < 0 ? 'customer-negative' : ''}>
                        {money ? currency(e.balance) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!shown.length && <p>Inga bokförda saldohändelser för kunden.</p>}
            <p className="customer-note">
              Saldo uppstår efter attest. Rättelseutkast påverkar inte saldo
              eller statistik.
            </p>
          </Section>
          <Section title="Rättelsekort">
            <div className="customer-correction-list">
              {corrections.map((c) => (
                <button
                  key={c.id}
                  className={correction?.id === c.id ? 'selected' : ''}
                  onClick={() => setSelected(c.id)}
                >
                  <div>
                    <strong>
                      R-{c.id} · {articleName(c.articleId)}
                    </strong>
                    <small>
                      Vägning #{c.cardId} · {c.weightDelta > 0 ? '+' : ''}
                      {n(c.weightDelta, 2)} kg
                    </small>
                  </div>
                  <span
                    className={`customer-status ${c.status === 'approved' ? 'ready' : 'complement'}`}
                  >
                    {c.status === 'approved'
                      ? 'Godkänd'
                      : c.status === 'attest'
                        ? 'Väntar på attest'
                        : 'Utkast'}
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
            {!corrections.length && <p>Inga rättelser skapade för kunden.</p>}
          </Section>
        </div>
        <aside className="customer-side-column">
          {correction && (
            <Section title={`Rättelse R-${correction.id}`}>
              <dl className="customer-correction-details">
                <dt>Originalvägning</dt>
                <dd>
                  <button
                    className="office-link"
                    onClick={() => onOpenCard(correction.cardId)}
                  >
                    #{correction.cardId}
                  </button>
                </dd>
                <dt>Rättelseunderlag</dt>
                <dd>{correction.document || 'Ej angivet'}</dd>
                <dt>Artikel</dt>
                <dd>{articleName(correction.articleId)}</dd>
                <dt>Rättad mängd</dt>
                <dd>
                  {correction.weightDelta > 0 ? '+' : ''}
                  {n(correction.weightDelta, 2)} kg
                </dd>
                <dt>Ekonomisk påverkan</dt>
                <dd
                  className={
                    correction.weightDelta < 0
                      ? 'customer-negative'
                      : 'customer-positive'
                  }
                >
                  {money ? currency(correction.amountDelta ?? 0) : '—'}
                </dd>
                <dt>Orsak</dt>
                <dd>{correction.reason}</dd>
                <dt>Skapad av</dt>
                <dd>
                  {correction.actor}
                  <small>
                    {correction.office} · {date(correction.at)}
                  </small>
                </dd>
                {correction.approvedBy && (
                  <>
                    <dt>Godkänd av</dt>
                    <dd>
                      {data.users.find((u) => u.id === correction.approvedBy)
                        ?.name ?? correction.approvedBy}
                    </dd>
                  </>
                )}
              </dl>
              <div className="customer-correction-actions">
                <button
                  className="office-btn outline"
                  onClick={() => onOpenCard(correction.cardId)}
                >
                  Öppna originalkort
                </button>
                {correction.resultCardId && (
                  <button
                    className="office-btn outline"
                    onClick={() => onOpenCard(correction.resultCardId!)}
                  >
                    Öppna utbetalningskort
                  </button>
                )}
                {(!correction.status || correction.status === 'draft') &&
                  can(user, 'corrections') && (
                    <button
                      className="office-btn"
                      disabled={busy}
                      onClick={() =>
                        void act(() => onSubmitCorrection(correction.id))
                      }
                    >
                      Skicka till attest
                    </button>
                  )}
                {correction.status === 'attest' && can(user, 'attest') && (
                  <>
                    <button
                      className="office-btn"
                      disabled={
                        busy ||
                        Math.abs(correction.amountDelta ?? 0) >
                          user.maxAttest ||
                        (!user.ownAttest &&
                          [
                            correction.submittedBy,
                            correction.effectiveUserId,
                          ].includes(user.id))
                      }
                      onClick={() =>
                        void act(() => onApproveCorrection(correction.id))
                      }
                    >
                      Godkänn rättelse
                    </button>
                    {Math.abs(correction.amountDelta ?? 0) > user.maxAttest && (
                      <p className="customer-note">
                        Över din attestgräns på {currency(user.maxAttest)}.
                      </p>
                    )}
                    {!user.ownAttest &&
                      [
                        correction.submittedBy,
                        correction.effectiveUserId,
                      ].includes(user.id) && (
                        <p className="customer-note">
                          En annan användare behöver attestera rättelsen.
                        </p>
                      )}
                  </>
                )}
              </div>
              {correction.audit?.length ? (
                <ol className="customer-audit">
                  {correction.audit.map((a, i) => (
                    <li key={i}>
                      <strong>{safeAuditText(user, a.text)}</strong>
                      <span>
                        {a.actor} · {date(a.at)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </Section>
          )}
          <Section title="Spårbart i båda riktningar">
            <p>
              Minusrättelser minskar kundens saldo och volym. Plusrättelser
              skapar ett nytt kort för utbetalning. Originalvägningen ligger
              kvar låst.
            </p>
          </Section>
        </aside>
      </div>
    </>
  );
}
function CorrectionForm({
  data,
  customer,
  user,
  onSave,
  onCancel,
}: {
  data: OfficeData;
  customer: OfficeCustomer;
  user: OfficeUser;
  onSave: (input: CorrectionInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const cards = data.cards.filter(
    (c) =>
      c.customerId === customer.id &&
      ['ready', 'paid', 'balance'].includes(c.status) &&
      c.kind !== 'correction',
  );
  const [cardId, setCardId] = useState(cards[0]?.id ?? 0),
    [articleId, setArticleId] = useState(cards[0]?.rows[0]?.articleId ?? ''),
    [delta, setDelta] = useState(''),
    [reason, setReason] = useState(''),
    [document, setDocument] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const card = cards.find((c) => c.id === cardId),
    value = Number(delta.replace(',', '.')),
    row = card?.rows.find((r) => r.articleId === articleId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !row ||
      !Number.isFinite(value) ||
      value === 0 ||
      !reason.trim() ||
      !document.trim()
    ) {
      setError(
        'Välj originalvägning, ange en ändring och fyll i orsak samt rättelseunderlag.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (
        !(await onSave({
          cardId,
          articleId,
          weightDelta: value,
          reason: reason.trim(),
          document: document.trim(),
        }))
      )
        setError(
          'Rättelsen kunde inte sparas. Kontrollera mängden och originalkortet.',
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Skapa rättelse"
      action={
        <button
          className="office-link"
          aria-label="Stäng rättelseformulär"
          onClick={onCancel}
        >
          <X size={18} />
        </button>
      }
    >
      {!cards.length ? (
        <p>
          Det behövs en attesterad originalvägning innan en rättelse kan skapas.
        </p>
      ) : (
        <form className="customer-correction-form" onSubmit={submit}>
          <div className="customer-form-grid">
            <label>
              Originalvägning
              <select
                aria-label="Originalvägning"
                value={cardId}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  setCardId(id);
                  setArticleId(
                    cards.find((c) => c.id === id)?.rows[0]?.articleId ?? '',
                  );
                }}
              >
                <option value="0" disabled>
                  Välj viktkort
                </option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.id} · {date(c.date)} · {n(weight(c))} kg
                  </option>
                ))}
              </select>
            </label>
            <label>
              Artikel
              <select
                aria-label="Artikel"
                value={articleId}
                onChange={(e) => setArticleId(e.target.value)}
              >
                {[...new Set(card?.rows.map((r) => r.articleId) ?? [])].map(
                  (id) => (
                    <option key={id} value={id}>
                      {articleName(id)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              Ändring i kg
              <input
                aria-label="Ändring i kg"
                placeholder="−100 eller +25"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                inputMode="decimal"
                required
              />
            </label>
            <label>
              Rättelseunderlag
              <input
                aria-label="Rättelseunderlag"
                placeholder="RU-001 eller dokumentreferens"
                value={document}
                onChange={(e) => setDocument(e.target.value)}
                required
              />
            </label>
            <label className="customer-form-wide">
              Orsak
              <textarea
                aria-label="Orsak"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </label>
          </div>
          <p className="customer-note">
            Minus tar bort tidigare vikt, plus lägger till vikt. Originalkortet
            ändras inte.{' '}
            {row && Number.isFinite(value) && canSeeMoney(user)
              ? `Preliminär påverkan: ${currency(value * row.price)}.`
              : ''}
          </p>
          {error && (
            <p role="alert" className="customer-error">
              {error}
            </p>
          )}
          <div className="customer-actions">
            <button type="submit" className="office-btn" disabled={busy}>
              Spara rättelseutkast
            </button>
            <button
              type="button"
              className="office-btn outline"
              onClick={onCancel}
              disabled={busy}
            >
              Avbryt
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}
