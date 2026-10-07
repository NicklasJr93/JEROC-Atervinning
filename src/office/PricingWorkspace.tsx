import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  History,
  Info,
  Layers3,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingUp,
  X,
} from 'lucide-react';
import { categories } from '../data';
import type { OfficeUser, Permission } from './model';
import {
  pricingRequest,
  type CustomerPrice,
  type LmeRate,
  type PriceArticle,
  type PriceTier,
  type PricingQuote,
  type PricingState,
} from './pricing-client';
import './pricing.css';

export type PricingSection = 'articles' | 'lme' | 'customer-prices';
type Props = {
  user: OfficeUser;
  actualUser: OfficeUser;
  onNotice: (message: string) => void;
  section?: PricingSection;
  onSectionChange?: (section: PricingSection) => void;
};
const tiers: PriceTier[] = ['A', 'B', 'C'];
const money = (value: number | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('sv-SE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
const number = (value: number | null | undefined) =>
  value == null
    ? '—'
    : new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(
        value,
      );
const right = (user: OfficeUser, permission: string) =>
  user.level !== 'Medarbetare' ||
  user.permissions.includes(permission as Permission);
const today = () => new Date().toISOString().slice(0, 10);
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Åtgärden kunde inte utföras.';

export default function PricingWorkspace({
  user,
  actualUser,
  onNotice,
  section = 'articles',
  onSectionChange,
}: Props) {
  const [state, setState] = useState<PricingState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [selected, setSelected] = useState<PriceArticle>();
  const [customer, setCustomer] = useState('');
  const [localSection, setLocalSection] = useState(section);
  const principal = `${actualUser.id}/${user.id}`;
  const latestPrincipal = useRef(principal);
  latestPrincipal.current = principal;
  const currentSection = onSectionChange ? section : localSection;
  function switchSection(next: PricingSection) {
    setSelected(undefined);
    if (onSectionChange) onSectionChange(next);
    else setLocalSection(next);
  }
  async function reload() {
    setBusy(true);
    setError('');
    try {
      const next = await pricingRequest<PricingState>(
        'state',
        user,
        actualUser,
      );
      if (latestPrincipal.current === principal) setState(next);
    } catch (failure) {
      if (latestPrincipal.current === principal)
        setError(errorMessage(failure));
    } finally {
      if (latestPrincipal.current === principal) setBusy(false);
    }
  }
  useEffect(() => {
    setState(undefined);
    setSelected(undefined);
    void reload();
  }, [user.id, actualUser.id]);
  useEffect(() => {
    setLocalSection(section);
    setSelected(undefined);
  }, [section]);
  async function save(path: string, body: unknown, message: string) {
    setBusy(true);
    setError('');
    try {
      const next = await pricingRequest<PricingState>(
        path,
        user,
        actualUser,
        body,
      );
      if (latestPrincipal.current !== principal) return false;
      setState(next);
      onNotice(message);
      return true;
    } catch (failure) {
      if (latestPrincipal.current === principal)
        setError(errorMessage(failure));
      return false;
    } finally {
      if (latestPrincipal.current === principal) setBusy(false);
    }
  }
  const visibleArticles = (state?.articles || []).filter(
    (article) =>
      (!category || article.category === category) &&
      `${article.name} ${article.description} ${article.id}`
        .toLocaleLowerCase('sv')
        .includes(search.toLocaleLowerCase('sv')),
  );
  const allowedTiers = tiers.filter((tier) => right(user, `price${tier}`));
  const tabs: { id: PricingSection; name: string; allowed: boolean }[] = [
    {
      id: 'articles',
      name: 'Artiklar & priser',
      allowed: right(user, 'prices') || right(user, 'articlesEdit'),
    },
    { id: 'lme', name: 'LME Cash', allowed: right(user, 'lmeRead') },
    {
      id: 'customer-prices',
      name: 'Kundpriser',
      allowed:
        right(user, 'customerPrices') || right(user, 'customerPriceEdit'),
    },
  ];
  const currentAllowed = tabs.find((tab) => tab.id === currentSection)?.allowed;
  return (
    <div className="office-pricing">
      <div className="office-pricing-heading">
        <div>
          <span className="office-eyebrow">
            SKROTPRISER / {currentSection === 'lme' ? 'LME CASH' : 'ARTIKLAR'}
          </span>
          <h1>
            {selected
              ? `Artikelinställningar – ${selected.name}`
              : currentSection === 'lme'
                ? 'LME Cash'
                : currentSection === 'customer-prices'
                  ? 'Kundanpassade skrotpriser'
                  : 'Artiklar & priser'}
          </h1>
          <p>
            {selected
              ? 'Referensbilder, prisformler och volymgränser per artikel.'
              : currentSection === 'lme'
                ? 'Manuella Cash-priser som artikelns prisformler räknar mot.'
                : currentSection === 'customer-prices'
                  ? 'En kundregel går före kundens ordinarie volympris.'
                  : 'Prismotorns aktuella artiklar, A/B/C-priser och LME-kopplingar.'}
          </p>
        </div>
        <div className="office-pricing-heading-actions">
          {selected ? (
            <button
              className="office-pricing-plain"
              onClick={() => setSelected(undefined)}
            >
              <ArrowLeft size={15} /> Till artikelöversikten
            </button>
          ) : (
            <button
              className="office-pricing-plain"
              disabled={busy}
              onClick={() => void reload()}
            >
              <RefreshCw size={15} /> Uppdatera
            </button>
          )}
          {!selected &&
            currentSection === 'articles' &&
            right(user, 'articlesEdit') &&
            state && (
              <button
                className="office-pricing-primary"
                onClick={() => setSelected(newArticle(state))}
              >
                <Plus size={15} /> Ny artikel
              </button>
            )}
        </div>
      </div>
      <nav className="office-pricing-tabs" aria-label="Prisvyer">
        {tabs
          .filter((tab) => tab.allowed)
          .map((tab) => (
            <button
              key={tab.id}
              className={tab.id === currentSection ? 'active' : ''}
              onClick={() => switchSection(tab.id)}
            >
              {tab.name}
            </button>
          ))}
      </nav>
      <div className="office-pricing-demo">
        <Info size={15} />
        <span>
          <strong>Serverdemo.</strong> Priser och historik sparas i serverns
          minne och återställs vid omstart eller ny driftsättning. Mobilens
          prislista kopplas in i nästa steg.
        </span>
      </div>
      {error && (
        <div className="office-pricing-error" role="alert">
          {error}
          <button onClick={() => void reload()}>Försök igen</button>
        </div>
      )}
      {!currentAllowed ? (
        <div className="office-panel">
          <ShieldCheck size={20} />
          <h2>Du saknar behörighet till den här prisvyn.</h2>
        </div>
      ) : !state ? (
        <div className="office-panel office-pricing-loading" role="status">
          {busy
            ? 'Hämtar priser från servern…'
            : 'Pristjänsten är inte tillgänglig.'}
        </div>
      ) : selected ? (
        <ArticleEditor
          key={selected.id || 'new'}
          article={selected}
          state={state}
          user={user}
          actualUser={actualUser}
          busy={busy}
          onCancel={() => setSelected(undefined)}
          onSave={async (body) => {
            if (
              await save(
                'articles',
                body,
                'Artikeln och prisreglerna sparades på servern.',
              )
            )
              setSelected(undefined);
          }}
        />
      ) : currentSection === 'lme' ? (
        <LmeWorkspace
          state={state}
          editable={right(user, 'lmeWrite')}
          busy={busy}
          onSave={(body) =>
            save(
              'lme',
              body,
              'Cash-priset sparades. Kopplade artikelpriser har räknats om.',
            )
          }
        />
      ) : currentSection === 'customer-prices' ? (
        <CustomerWorkspace
          state={state}
          user={user}
          actualUser={actualUser}
          busy={busy}
          selectedCustomer={customer}
          onCustomer={setCustomer}
          onSave={(body) =>
            save(
              'customer-prices',
              body,
              'Kundens prisregel sparades på servern.',
            )
          }
        />
      ) : (
        <>
          <div className="office-pricing-stats">
            <Stat
              icon={<Layers3 size={18} />}
              label="Aktiva artiklar"
              value={String(
                state.articles.filter((article) => article.active).length,
              )}
              detail="Artiklar redo för invägning"
            />
            {right(user, 'lmeRead') && (
              <Stat
                icon={<TrendingUp size={18} />}
                label="LME Cash"
                value={String(
                  state.metals.filter((metal) =>
                    currentRate(state.lme || [], metal.id, state.asOfDate),
                  ).length,
                )}
                detail="Manuella metallreferenser"
              />
            )}
            <Stat
              icon={<History size={18} />}
              label="Volymperiod"
              value="12 månader"
              detail="Per kund och artikel, rullande"
            />
            {right(user, 'customerPrices') && (
              <Stat
                icon={<ShieldCheck size={18} />}
                label="Kundprisregler"
                value={String(
                  currentCustomerRules(
                    state.customerPrices || [],
                    state.asOfDate,
                  ).filter((rule) => rule.active).length,
                )}
                detail="Har företräde över volympriser"
              />
            )}
          </div>
          <div className="office-pricing-grid">
            <section className="office-panel office-pricing-article-panel">
              <div className="office-pricing-toolbar">
                <label className="office-pricing-search">
                  <Search size={15} />
                  <input
                    aria-label="Sök artikel"
                    placeholder="Sök artikel eller material…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <select
                  aria-label="Filtrera materialkategori"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  <option value="">Alla material</option>
                  {categories.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                {right(user, 'reports') && (
                  <button
                    className="office-pricing-plain"
                    onClick={() => exportPrices(visibleArticles, allowedTiers)}
                  >
                    <Download size={14} /> Exportera CSV
                  </button>
                )}
              </div>
              <div className="office-pricing-table-wrap">
                <table className="office-pricing-table">
                  <thead>
                    <tr>
                      <th>Artikel</th>
                      {right(user, 'lmeRead') && <th>Prisbas</th>}
                      {allowedTiers.map((tier) => (
                        <th key={tier}>{tier}-pris / kg</th>
                      ))}
                      <th>Volymgränser</th>
                      <th>Status</th>
                      {right(user, 'articlesEdit') && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleArticles.map((article) => (
                      <tr key={article.id}>
                        <td>
                          <span className="office-pricing-material">
                            <ArticlePhoto article={article} />
                            <span>
                              <strong>{article.name}</strong>
                              <small>{article.description}</small>
                            </span>
                          </span>
                        </td>
                        {right(user, 'lmeRead') && (
                          <td>
                            <strong>{money(article.baseSekKg)} kr/kg</strong>
                            <small>
                              {article.base?.type === 'lme'
                                ? `LME ${state.metals.find((metal) => article.base?.type === 'lme' && metal.id === article.base.metal)?.name || article.base.metal}`
                                : 'Manuell referens'}
                            </small>
                          </td>
                        )}
                        {allowedTiers.map((tier) => (
                          <td key={tier}>
                            <span
                              className={`office-pricing-tier tier-${tier}`}
                            >
                              {money(article.prices[tier])}
                            </span>
                          </td>
                        ))}
                        <td>
                          <strong>A ≥ {number(article.thresholds.A)} kg</strong>
                          <small>
                            B ≥ {number(article.thresholds.B)} kg · C under B
                          </small>
                        </td>
                        <td>
                          <span
                            className={`office-pricing-badge ${article.active ? 'green' : 'gray'}`}
                          >
                            {article.active ? 'Aktiv' : 'Inaktiv'}
                          </span>
                        </td>
                        {right(user, 'articlesEdit') && (
                          <td>
                            <button
                              className="office-pricing-edit"
                              aria-label={`Redigera ${article.name}`}
                              onClick={() => setSelected(article)}
                            >
                              <Pencil size={14} /> Öppna
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visibleArticles.length && (
                  <div className="office-pricing-empty">
                    Inga artiklar matchar sökningen.
                  </div>
                )}
              </div>
              <div className="office-pricing-footer">
                Visar {visibleArticles.length} av {state.articles.length}{' '}
                artiklar · priser giltiga {state.asOfDate}
              </div>
            </section>
            <aside className="office-pricing-aside">
              <PricingPriority />
              <div className="office-panel">
                <h2>Volymgränser</h2>
                <p>
                  Varje artikel har egna gränser. Kundens tidigare leveranser
                  under de senaste 12 månaderna räknas ihop med leveransen som
                  prisberäknas.
                </p>
                <div className="office-pricing-volume-example">
                  <span>C</span>
                  <span>B</span>
                  <span>A</span>
                </div>
                <small>
                  En ny kund kan nå A-pris direkt med sin första leverans.
                </small>
              </div>
              <div className="office-panel">
                <h2>Spårbara priser</h2>
                <p>
                  Nya LME-värden och artikelregler får ett giltighetsdatum. En
                  sparad prisberäkning behåller värdena och prisreglerna som
                  användes vid inlämningen.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="office-pricing-stat">
      <span className="office-pricing-stat-icon">{icon}</span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}
function ArticlePhoto({
  article,
  large = false,
}: {
  article: Pick<PriceArticle, 'name' | 'photos'>;
  large?: boolean;
}) {
  const cell = article.photos[0] ?? 0,
    extra = cell >= 28,
    position = extra ? cell - 28 : cell;
  return (
    <span
      className={`office-pricing-photo ${large ? 'large' : ''}`}
      role="img"
      aria-label={article.name}
      style={{
        backgroundImage: `url(${extra ? '/images/copper-grades.png' : '/images/materials.png'})`,
        backgroundSize: extra ? '400% 300%' : '400% 700%',
        backgroundPosition: `${((position % 4) * 100) / 3}% ${(Math.floor(position / 4) * 100) / (extra ? 2 : 6)}%`,
      }}
    />
  );
}
function PricingPriority() {
  return (
    <div className="office-panel">
      <h2>Så väljs priset</h2>
      <ol className="office-pricing-priority">
        <li>
          <strong>Kundens specialpris</strong>
          <small>En aktiv kundregel går före A/B/C.</small>
        </li>
        <li>
          <strong>Volympris A, B eller C</strong>
          <small>Per artikel och kund, senaste 12 månaderna.</small>
        </li>
        <li>
          <strong>Sparad prisbild</strong>
          <small>Inlämningsdatum styr vilka regler som används.</small>
        </li>
      </ol>
      <p>
        Ett engångspris på ett viktkort sparas separat med vem som ändrade
        priset och varför.
      </p>
    </div>
  );
}
function currentRate(rates: LmeRate[], metal: string, date: string) {
  return rates
    .filter((rate) => rate.metal === metal && rate.effectiveFrom <= date)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        b.at.localeCompare(a.at) ||
        (b.sequence || 0) - (a.sequence || 0),
    )[0];
}
function currentCustomerRules(rules: CustomerPrice[], date: string) {
  const current = new Map<string, CustomerPrice>();
  for (const rule of rules) {
    if (rule.effectiveFrom > date) continue;
    const key = `${rule.customerId}/${rule.articleId}`;
    const previous = current.get(key);
    // Server history is appended in revision order; the later entry wins on
    // an identical effective date, as it does in the pricing engine.
    if (!previous || previous.effectiveFrom <= rule.effectiveFrom)
      current.set(key, rule);
  }
  return [...current.values()];
}
function customerRuleStatus(
  rule: CustomerPrice,
  rules: CustomerPrice[],
  date: string,
) {
  if (rule.effectiveFrom > date) {
    const sameDate = rules
      .filter(
        (item) =>
          item.customerId === rule.customerId &&
          item.articleId === rule.articleId &&
          item.effectiveFrom === rule.effectiveFrom,
      )
      .at(-1);
    return sameDate === rule ? 'Kommande' : 'Historik';
  }
  return currentCustomerRules(rules, date).includes(rule)
    ? rule.active
      ? 'Aktiv'
      : 'Avslutad'
    : 'Historik';
}
function pricingActor(state: PricingState, item: LmeRate) {
  const name = (id: string) =>
    state.users?.find((user) => user.id === id)?.name || id;
  return item.actingUser && item.actingUser !== item.actor
    ? `${name(item.actor)} som ${name(item.actingUser)}`
    : name(item.actor);
}
function newArticle(state: PricingState): PriceArticle {
  return {
    id: '',
    name: '',
    category: 'koppar',
    description: '',
    includes: [],
    excludes: [],
    photos: [0],
    active: true,
    base: { type: 'lme', metal: state.metals[0]?.id || 'copper' },
    tiers: {
      A: { discountPercent: 18, adjustmentKr: 0 },
      B: { discountPercent: 26.2, adjustmentKr: 0 },
      C: { discountPercent: 34.4, adjustmentKr: 0 },
    },
    thresholds: { A: 100, B: 50 },
    effectiveFrom: state.asOfDate,
    prices: { A: null, B: null, C: null },
    baseSekKg: null,
  };
}

function LmeWorkspace({
  state,
  editable,
  busy,
  onSave,
}: {
  state: PricingState;
  editable: boolean;
  busy: boolean;
  onSave: (body: unknown) => Promise<boolean>;
}) {
  const [metal, setMetal] = useState(state.metals[0]?.id || 'copper');
  const rate = currentRate(state.lme || [], metal, state.asOfDate);
  const [cash, setCash] = useState(String(rate?.cashUsdPerTonne || 10000));
  const [fx, setFx] = useState(String(rate?.usdSek || 10));
  const [date, setDate] = useState(state.asOfDate);
  const [note, setNote] = useState('');
  useEffect(() => {
    const selected = currentRate(state.lme || [], metal, state.asOfDate);
    setCash(String(selected?.cashUsdPerTonne || ''));
    setFx(String(selected?.usdSek || 10));
  }, [metal, state.revision]);
  const converted =
    Number(cash) > 0 && Number(fx) > 0
      ? (Number(cash) * Number(fx)) / 1000
      : null;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      await onSave({
        metal,
        cashUsdPerTonne: Number(cash),
        usdSek: Number(fx),
        effectiveFrom: date,
        note,
      })
    )
      setNote('');
  }
  return (
    <div className="office-pricing-lme-grid">
      <div>
        <section className="office-panel">
          <div className="office-pricing-panel-title">
            <div>
              <h2>Cash-referenser</h2>
              <p>USD per ton omräknas till SEK per kilo.</p>
            </div>
            <span className="office-pricing-badge green">
              Manuell inmatning
            </span>
          </div>
          <div className="office-pricing-table-wrap">
            <table className="office-pricing-table">
              <thead>
                <tr>
                  <th>Metall</th>
                  <th>Cash USD/ton</th>
                  <th>USD/SEK</th>
                  <th>SEK/kg</th>
                  <th>Gäller från</th>
                </tr>
              </thead>
              <tbody>
                {state.metals.map((item) => {
                  const current = currentRate(
                    state.lme || [],
                    item.id,
                    state.asOfDate,
                  );
                  return (
                    <tr
                      key={item.id}
                      className={item.id === metal ? 'selected' : ''}
                      onClick={() => setMetal(item.id)}
                    >
                      <td>
                        <button
                          className="office-pricing-metal-select"
                          onClick={() => setMetal(item.id)}
                        >
                          {item.name}
                          <ChevronRight size={13} />
                        </button>
                      </td>
                      <td>
                        {current ? money(current.cashUsdPerTonne) : 'Saknas'}
                      </td>
                      <td>{current ? money(current.usdSek) : '—'}</td>
                      <td>
                        <strong>
                          {current
                            ? money(
                                (current.cashUsdPerTonne * current.usdSek) /
                                  1000,
                              )
                            : '—'}
                        </strong>
                      </td>
                      <td>{current?.effectiveFrom || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="office-panel office-pricing-history">
          <h2>
            <History size={16} /> Cash-historik
          </h2>
          <p>
            Historiken behåller giltighetsdatum, valutakurs och vem som
            registrerade värdet.
          </p>
          <div className="office-pricing-table-wrap">
            <table className="office-pricing-table">
              <thead>
                <tr>
                  <th>Metall / giltighet</th>
                  <th>Cash USD/ton</th>
                  <th>USD/SEK</th>
                  <th>SEK/kg</th>
                  <th>Registrerat av</th>
                </tr>
              </thead>
              <tbody>
                {[...(state.lme || [])]
                  .sort(
                    (a, b) =>
                      b.effectiveFrom.localeCompare(a.effectiveFrom) ||
                      b.at.localeCompare(a.at),
                  )
                  .map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>
                          {state.metals.find((value) => value.id === item.metal)
                            ?.name || item.metal}
                        </strong>
                        <small>
                          {item.effectiveFrom}
                          {item.effectiveFrom > state.asOfDate
                            ? ' · kommande'
                            : ''}
                        </small>
                      </td>
                      <td>{money(item.cashUsdPerTonne)}</td>
                      <td>{money(item.usdSek)}</td>
                      <td>
                        {money((item.cashUsdPerTonne * item.usdSek) / 1000)}
                      </td>
                      <td>
                        <strong>{pricingActor(state, item)}</strong>
                        <small>
                          {item.note ||
                            new Date(item.at).toLocaleString('sv-SE')}
                        </small>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {!state.lme?.length && (
              <div className="office-pricing-empty">
                Inga Cash-priser registrerade.
              </div>
            )}
          </div>
        </section>
      </div>
      <aside>
        {editable ? (
          <form
            className="office-panel office-pricing-form"
            onSubmit={(event) => void submit(event)}
          >
            <h2>Registrera Cash-pris</h2>
            <label>
              Metall
              <select
                value={metal}
                onChange={(event) => setMetal(event.target.value)}
              >
                {state.metals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="office-pricing-form-row">
              <label>
                Cash (USD/ton)
                <input
                  type="number"
                  min="0.01"
                  step="any"
                  required
                  value={cash}
                  onChange={(event) => setCash(event.target.value)}
                />
              </label>
              <label>
                USD/SEK
                <input
                  type="number"
                  min="0.0001"
                  step="any"
                  required
                  value={fx}
                  onChange={(event) => setFx(event.target.value)}
                />
              </label>
            </div>
            <label>
              Gäller från
              <input
                type="date"
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              Anteckning
              <textarea
                placeholder="Källa eller anledning till ändringen…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
              />
            </label>
            <div className="office-pricing-conversion">
              <small>Prisreferens i SEK/kg</small>
              <strong>
                {money(converted)} <span>kr/kg</span>
              </strong>
              <span>
                {number(Number(cash) || 0)} × {number(Number(fx) || 0)} ÷ 1 000
              </span>
            </div>
            <button
              className="office-pricing-primary"
              type="submit"
              disabled={busy}
            >
              <Check size={15} /> {busy ? 'Sparar…' : 'Spara Cash-pris'}
            </button>
          </form>
        ) : (
          <section className="office-panel">
            <ShieldCheck size={20} />
            <h2>Läsbehörighet</h2>
            <p>
              Du kan se Cash-priserna och historiken. För att registrera nya
              värden behöver du behörigheten Ändra LME-priser.
            </p>
          </section>
        )}
        <section className="office-panel office-pricing-explainer">
          <h2>
            <Info size={16} /> Hur räknas priserna?
          </h2>
          <p>
            <strong>Cash USD/ton × USD/SEK ÷ 1 000</strong> ger referenspriset i
            SEK/kg. Artikelns A/B/C-formler räknar sedan avdrag och eventuella
            kronjusteringar.
          </p>
          <p>
            Giltighetsdatumet gör att äldre leveranser kan räknas mot rätt
            prisbild. Redan sparade underlag ändras inte.
          </p>
        </section>
      </aside>
    </div>
  );
}

function ArticleEditor({
  article,
  state,
  user,
  actualUser,
  busy,
  onCancel,
  onSave,
}: {
  article: PriceArticle;
  state: PricingState;
  user: OfficeUser;
  actualUser: OfficeUser;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PriceArticle>(() => ({
    ...structuredClone(article),
    effectiveFrom: state.asOfDate,
  }));
  const [includeText, setIncludeText] = useState(article.includes.join('\n'));
  const [excludeText, setExcludeText] = useState(article.excludes.join('\n'));
  const [photoPicker, setPhotoPicker] = useState(false);
  const [validation, setValidation] = useState('');
  const base =
    draft.base.type === 'manual'
      ? draft.base.price
      : (() => {
          const rate = currentRate(
            state.lme || [],
            draft.base.metal,
            draft.effectiveFrom,
          );
          return rate ? (rate.cashUsdPerTonne * rate.usdSek) / 1000 : null;
        })();
  const preview = Object.fromEntries(
    tiers.map((tier) => [
      tier,
      base === null
        ? null
        : Math.max(
            0,
            Math.round(
              (base * (1 - draft.tiers[tier].discountPercent / 100) +
                draft.tiers[tier].adjustmentKr) *
                100,
            ) / 100,
          ),
    ]),
  ) as Record<PriceTier, number | null>;
  function setRule(
    tier: PriceTier,
    key: 'discountPercent' | 'adjustmentKr',
    value: number,
  ) {
    setDraft((old) => ({
      ...old,
      tiers: { ...old.tiers, [tier]: { ...old.tiers[tier], [key]: value } },
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setValidation('');
    if (draft.thresholds.A <= draft.thresholds.B) {
      setValidation('A-gränsen måste vara högre än B-gränsen.');
      return;
    }
    if (!draft.photos.length) {
      setValidation('Välj minst en referensbild för artikeln.');
      return;
    }
    await onSave({
      id: draft.id || undefined,
      name: draft.name.trim(),
      category: draft.category,
      description: draft.description.trim(),
      includes: lines(includeText),
      excludes: lines(excludeText),
      photos: draft.photos,
      active: draft.active,
      base: draft.base,
      tiers: draft.tiers,
      thresholds: draft.thresholds,
      effectiveFrom: draft.effectiveFrom,
    });
  }
  const history = (state.articleHistory || []).filter(
    (item) => item.id === article.id,
  );
  return (
    <form
      className="office-pricing-editor office-pricing-form"
      onSubmit={(event) => void submit(event)}
    >
      {validation && (
        <div className="office-pricing-error" role="alert">
          {validation}
        </div>
      )}
      <div className="office-pricing-editor-grid">
        <section className="office-panel">
          <h2>Grunduppgifter & referensbilder</h2>
          <div className="office-pricing-article-identity">
            <ArticlePhoto article={draft} large />
            <div>
              <label>
                Artikelnamn
                <input
                  required
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((old) => ({ ...old, name: event.target.value }))
                  }
                  maxLength={120}
                />
              </label>
              <label>
                Materialkategori
                <select
                  value={draft.category}
                  onChange={(event) =>
                    setDraft((old) => ({
                      ...old,
                      category: event.target.value,
                    }))
                  }
                >
                  {categories.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <label>
            Kort beskrivning
            <input
              value={draft.description}
              onChange={(event) =>
                setDraft((old) => ({ ...old, description: event.target.value }))
              }
              maxLength={250}
            />
          </label>
          <button
            type="button"
            className="office-pricing-plain"
            onClick={() => setPhotoPicker((value) => !value)}
          >
            {photoPicker
              ? 'Stäng bildval'
              : `Välj referensbilder (${draft.photos.length})`}
          </button>
          {photoPicker && (
            <div
              className="office-pricing-photo-picker"
              aria-label="Referensbilder"
            >
              {Array.from({ length: 40 }, (_, cell) => (
                <button
                  className={draft.photos.includes(cell) ? 'selected' : ''}
                  type="button"
                  key={cell}
                  aria-label={`Referensbild ${cell + 1}`}
                  aria-pressed={draft.photos.includes(cell)}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      photos: old.photos.includes(cell)
                        ? old.photos.filter((photo) => photo !== cell)
                        : old.photos.length < 6
                          ? [...old.photos, cell]
                          : old.photos,
                    }))
                  }
                >
                  <ArticlePhoto
                    article={{
                      name: `Referensbild ${cell + 1}`,
                      photos: [cell],
                    }}
                  />
                  {draft.photos.includes(cell) && <Check size={12} />}
                </button>
              ))}
            </div>
          )}
          <small>Upp till sex bilder ur demobiblioteket.</small>
          <label>
            Exempel på vad som ingår
            <textarea
              value={includeText}
              onChange={(event) => setIncludeText(event.target.value)}
              placeholder="En beskrivning per rad"
              maxLength={3000}
            />
          </label>
          <label>
            Detta ingår inte
            <textarea
              value={excludeText}
              onChange={(event) => setExcludeText(event.target.value)}
              placeholder="En beskrivning per rad"
              maxLength={3000}
            />
          </label>
          <label className="office-pricing-checkbox">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) =>
                setDraft((old) => ({ ...old, active: event.target.checked }))
              }
            />{' '}
            Artikeln är aktiv för invägning
          </label>
        </section>
        <section className="office-panel">
          <h2>Prisbas & A/B/C-formler</h2>
          <div className="office-pricing-segment">
            <button
              type="button"
              className={draft.base.type === 'lme' ? 'active' : ''}
              onClick={() =>
                setDraft((old) => ({
                  ...old,
                  base: { type: 'lme', metal: state.metals[0]?.id || 'copper' },
                }))
              }
            >
              LME Cash
            </button>
            <button
              type="button"
              className={draft.base.type === 'manual' ? 'active' : ''}
              onClick={() =>
                setDraft((old) => ({
                  ...old,
                  base: { type: 'manual', price: old.baseSekKg || 3 },
                }))
              }
            >
              Manuell bas
            </button>
          </div>
          {draft.base.type === 'lme' ? (
            <label>
              LME-metall
              <select
                value={draft.base.metal}
                onChange={(event) =>
                  setDraft((old) => ({
                    ...old,
                    base: { type: 'lme', metal: event.target.value },
                  }))
                }
              >
                {state.metals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Referenspris (SEK/kg)
              <input
                type="number"
                required
                min="0"
                step="any"
                value={draft.base.price}
                onChange={(event) =>
                  setDraft((old) => ({
                    ...old,
                    base: { type: 'manual', price: Number(event.target.value) },
                  }))
                }
              />
            </label>
          )}
          <div className="office-pricing-base">
            <small>Bas för prisformeln</small>
            <strong>{money(base)} kr/kg</strong>
          </div>
          <div className="office-pricing-rule-heading">
            <span>Prislista</span>
            <span>Avdrag %</span>
            <span>Justering kr/kg</span>
          </div>
          {tiers.map((tier) => (
            <div className="office-pricing-rule" key={tier}>
              <span className={`office-pricing-tier tier-${tier}`}>
                {tier}-pris
              </span>
              <label className="office-pricing-sr-only-label">
                <span>{tier} avdrag procent</span>
                <input
                  aria-label={`${tier} avdrag procent`}
                  type="number"
                  required
                  min="0"
                  max="100"
                  step="any"
                  value={draft.tiers[tier].discountPercent}
                  onChange={(event) =>
                    setRule(tier, 'discountPercent', Number(event.target.value))
                  }
                />
              </label>
              <label className="office-pricing-sr-only-label">
                <span>{tier} justering kr/kg</span>
                <input
                  aria-label={`${tier} justering kr/kg`}
                  type="number"
                  required
                  step="any"
                  value={draft.tiers[tier].adjustmentKr}
                  onChange={(event) =>
                    setRule(tier, 'adjustmentKr', Number(event.target.value))
                  }
                />
              </label>
            </div>
          ))}
          <p className="office-pricing-formula">
            Pris = bas × (1 − avdrag / 100) + kronjustering
          </p>
          <h2>Volymstyrd prislista</h2>
          <p>
            Vikt per artikel, senaste 12 månaderna inklusive aktuell leverans.
          </p>
          <div className="office-pricing-form-row">
            <label>
              B från (kg)
              <input
                type="number"
                min="0"
                step="any"
                required
                value={draft.thresholds.B}
                onChange={(event) =>
                  setDraft((old) => ({
                    ...old,
                    thresholds: {
                      ...old.thresholds,
                      B: Number(event.target.value),
                    },
                  }))
                }
              />
            </label>
            <label>
              A från (kg)
              <input
                type="number"
                min="0.01"
                step="any"
                required
                value={draft.thresholds.A}
                onChange={(event) =>
                  setDraft((old) => ({
                    ...old,
                    thresholds: {
                      ...old.thresholds,
                      A: Number(event.target.value),
                    },
                  }))
                }
              />
            </label>
          </div>
          <label>
            Reglerna gäller från
            <input
              type="date"
              required
              value={draft.effectiveFrom}
              onChange={(event) =>
                setDraft((old) => ({
                  ...old,
                  effectiveFrom: event.target.value,
                }))
              }
            />
          </label>
          <div className="office-pricing-note">
            <Info size={14} /> C används när kundens volym är lägre än
            B-gränsen.
          </div>
        </section>
        <aside className="office-pricing-preview">
          <section className="office-panel">
            <h2>Prisförhandsvisning</h2>
            <p>Beräknat mot prisbasen för {draft.effectiveFrom}.</p>
            {tiers
              .filter((tier) => right(user, `price${tier}`))
              .map((tier) => (
                <div
                  className={`office-pricing-preview-tier tier-${tier}`}
                  key={tier}
                >
                  <span>{tier}-pris</span>
                  <strong>
                    {money(preview[tier])} <small>kr/kg</small>
                  </strong>
                </div>
              ))}
            {base === null && (
              <div className="office-pricing-note">
                LME-pris saknas för valt datum. Registrera en Cash-referens
                innan artikeln prisberäknas.
              </div>
            )}
            <div className="office-pricing-note">
              <Check size={14} /> Befintliga prisbilder på viktkort bevaras.
            </div>
          </section>
          {article.id && (
            <QuotePreview
              article={article}
              state={state}
              user={user}
              actualUser={actualUser}
            />
          )}
          <section className="office-panel">
            <h2>Exempel på volymnivåer</h2>
            {[
              { label: 'C', value: Math.max(1, draft.thresholds.B - 1) },
              { label: 'B', value: draft.thresholds.B },
              { label: 'A', value: draft.thresholds.A },
            ].map((item) => (
              <div className="office-pricing-example" key={item.label}>
                <span>
                  {number(item.value)} kg
                  <br />
                  <small>Ny kund, första leveransen</small>
                </span>
                <strong>{item.label}-pris</strong>
              </div>
            ))}
          </section>
        </aside>
      </div>
      {history.length > 0 && (
        <details className="office-panel office-pricing-history">
          <summary>
            <History size={16} /> Artikelhistorik ({history.length} prisbilder)
          </summary>
          <div className="office-pricing-table-wrap">
            <table className="office-pricing-table">
              <thead>
                <tr>
                  <th>Gäller från</th>
                  <th>Prisbas</th>
                  <th>A / B / C avdrag</th>
                  <th>Volymgränser B / A</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item, index) => (
                  <tr key={item.revisionId || index}>
                    <td>{item.effectiveFrom}</td>
                    <td>
                      {item.base.type === 'lme'
                        ? state.metals.find(
                            (metal) =>
                              item.base.type === 'lme' &&
                              metal.id === item.base.metal,
                          )?.name
                        : `${money(item.base.price)} kr/kg`}
                    </td>
                    <td>
                      {tiers
                        .map((tier) => `${item.tiers[tier].discountPercent}%`)
                        .join(' / ')}
                    </td>
                    <td>
                      {item.thresholds.B} / {item.thresholds.A} kg
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <div className="office-pricing-editor-actions">
        <span>
          <ShieldCheck size={15} /> Ändringen får en ny spårbar prisversion.
        </span>
        <button
          type="button"
          className="office-pricing-plain"
          onClick={onCancel}
        >
          Avbryt
        </button>
        <button
          type="submit"
          className="office-pricing-primary"
          disabled={busy}
        >
          <Check size={15} /> {busy ? 'Sparar…' : 'Spara artikel'}
        </button>
      </div>
    </form>
  );
}

function QuotePreview({
  article,
  state,
  user,
  actualUser,
  initialCustomer = '',
}: {
  article: PriceArticle;
  state: PricingState;
  user: OfficeUser;
  actualUser: OfficeUser;
  initialCustomer?: string;
}) {
  const [customer, setCustomer] = useState(initialCustomer);
  const [weight, setWeight] = useState('125');
  const [date, setDate] = useState(state.asOfDate);
  const [quote, setQuote] = useState<PricingQuote>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const queryKey = JSON.stringify([
    actualUser.id,
    user.id,
    article.id,
    customer,
    weight,
    date,
  ]);
  const currentQuery = useRef(queryKey);
  currentQuery.current = queryKey;
  async function calculate() {
    setBusy(true);
    setError('');
    setQuote(undefined);
    try {
      const result = await pricingRequest<PricingQuote>(
        'quote',
        user,
        actualUser,
        {
          customerId: customer || undefined,
          deliveredAt: date,
          rows: [{ articleId: article.id, weight: Number(weight) }],
        },
      );
      if (currentQuery.current === queryKey) setQuote(result);
    } catch (failure) {
      if (currentQuery.current === queryKey) setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const row = quote?.rows[0];
  return (
    <section className="office-panel office-pricing-form">
      <h2>Prova kundens pris</h2>
      <p>
        Beräknar mot sparade serverregler och registrerad kundvolym. Välj kund
        för volympris och kundundantag.
      </p>
      {right(user, 'customerPrices') && (
        <label>
          Kund
          <select
            value={customer}
            onChange={(event) => {
              setCustomer(event.target.value);
              setQuote(undefined);
            }}
          >
            <option value="">Ingen kund vald · C-pris</option>
            {state.customers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="office-pricing-form-row">
        <label>
          Ny leverans (kg)
          <input
            type="number"
            min="0.01"
            step="any"
            value={weight}
            onChange={(event) => {
              setWeight(event.target.value);
              setQuote(undefined);
            }}
          />
        </label>
        <label>
          Inlämningsdatum
          <input
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
              setQuote(undefined);
            }}
          />
        </label>
      </div>
      <button
        type="button"
        className="office-pricing-plain"
        disabled={busy || Number(weight) <= 0 || !date}
        onClick={() => void calculate()}
      >
        <TrendingUp size={14} /> {busy ? 'Beräknar…' : 'Beräkna kundpris'}
      </button>
      {error && (
        <div className="office-pricing-error" role="alert">
          {error}
        </div>
      )}
      {row && (
        <div className="office-pricing-quote-result">
          <small>
            {row.tier === 'Special'
              ? 'Kundens specialpris'
              : `Prislista ${row.tier}`}
          </small>
          <strong>{money(row.price)} kr/kg</strong>
          <span>Volym innan: {number(row.volumeBefore)} kg</span>
          <span>Med leveransen: {number(row.volumeWithDelivery)} kg</span>
          <span>Totalt: {money(quote?.total)} kr</span>
        </div>
      )}
    </section>
  );
}

function CustomerWorkspace({
  state,
  user,
  actualUser,
  busy,
  selectedCustomer,
  onCustomer,
  onSave,
}: {
  state: PricingState;
  user: OfficeUser;
  actualUser: OfficeUser;
  busy: boolean;
  selectedCustomer: string;
  onCustomer: (id: string) => void;
  onSave: (body: unknown) => Promise<boolean>;
}) {
  const [articleId, setArticleId] = useState(state.articles[0]?.id || '');
  const [kind, setKind] = useState<CustomerPrice['kind']>('fixed');
  const [price, setPrice] = useState('84');
  const [tier, setTier] = useState<PriceTier>('A');
  const [adjustment, setAdjustment] = useState('2');
  const [discount, setDiscount] = useState('16');
  const [date, setDate] = useState(state.asOfDate);
  const [note, setNote] = useState('');
  const [active, setActive] = useState(true);
  const [editing, setEditing] = useState(false);
  const article = state.articles.find((item) => item.id === articleId);
  const filtered = (state.customerPrices || [])
    .filter((rule) => !selectedCustomer || rule.customerId === selectedCustomer)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const allowedTiers = tiers.filter((value) => right(user, `price${value}`));
  const [historical, setHistorical] = useState<PricingState>();
  const [historicalError, setHistoricalError] = useState('');
  useEffect(() => {
    let current = true;
    setHistorical(undefined);
    setHistoricalError('');
    if (date === state.asOfDate || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    pricingRequest<PricingState>(`state?at=${date}`, user, actualUser)
      .then((result) => {
        if (current) setHistorical(result);
      })
      .catch((failure) => {
        if (current) setHistoricalError(errorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [date, state.revision, user.id, actualUser.id]);
  const previewState = date === state.asOfDate ? state : historical;
  const previewArticle = previewState?.articles.find(
    (item) => item.id === articleId,
  );
  const selectedBase =
    previewArticle?.base?.type === 'lme'
      ? currentRate(previewState?.lme || [], previewArticle.base.metal, date)
      : undefined;
  const preview =
    kind === 'fixed'
      ? Number(price)
      : kind === 'tier-adjustment'
        ? previewArticle?.prices[tier] == null
          ? null
          : Math.max(0, previewArticle.prices[tier]! + Number(adjustment))
        : selectedBase
          ? ((selectedBase.cashUsdPerTonne * selectedBase.usdSek) / 1000) *
            (1 - Number(discount) / 100)
          : null;
  const editable = right(user, 'customerPriceEdit');
  function edit(rule: CustomerPrice) {
    onCustomer(rule.customerId);
    setArticleId(rule.articleId);
    setKind(rule.kind);
    setPrice(String(rule.price ?? 84));
    setTier(rule.tier || 'A');
    setAdjustment(String(rule.adjustmentKr ?? 0));
    setDiscount(String(rule.discountPercent ?? 0));
    setDate(rule.effectiveFrom);
    setNote(rule.note || '');
    setActive(rule.active);
    setEditing(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      customerId: selectedCustomer,
      articleId,
      kind,
      active,
      effectiveFrom: date,
      note,
      ...(kind === 'fixed'
        ? { price: Number(price) }
        : kind === 'tier-adjustment'
          ? { tier, adjustmentKr: Number(adjustment) }
          : { discountPercent: Number(discount) }),
    };
    if (await onSave(body)) setEditing(false);
  }
  return (
    <div className="office-pricing-customer-grid">
      <div>
        <section className="office-panel">
          <div className="office-pricing-panel-title">
            <h2>Kundens prisregler</h2>
            <label className="office-pricing-customer-filter">
              Kund
              <select
                aria-label="Filtrera kundpriser"
                value={selectedCustomer}
                onChange={(event) => onCustomer(event.target.value)}
              >
                <option value="">Alla kunder</option>
                {state.customers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="office-pricing-table-wrap">
            <table className="office-pricing-table">
              <thead>
                <tr>
                  <th>Kund / artikel</th>
                  <th>Specialregel</th>
                  <th>Gäller från</th>
                  <th>Status</th>
                  {editable && <th />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((rule, index) => (
                  <tr key={rule.revisionId || rule.id || index}>
                    <td>
                      <strong>
                        {state.customers.find(
                          (item) => item.id === rule.customerId,
                        )?.name || rule.customerId}
                      </strong>
                      <small>
                        {state.articles.find(
                          (item) => item.id === rule.articleId,
                        )?.name || rule.articleId}
                      </small>
                    </td>
                    <td>
                      <strong>
                        {rule.kind === 'fixed'
                          ? `${money(rule.price)} kr/kg`
                          : rule.kind === 'tier-adjustment'
                            ? `${rule.tier} ${Number(rule.adjustmentKr) >= 0 ? '+' : ''}${number(rule.adjustmentKr || 0)} kr/kg`
                            : `${number(rule.discountPercent || 0)} % under LME`}
                      </strong>
                      <small>{rule.note || 'Går före volympris'}</small>
                    </td>
                    <td>{rule.effectiveFrom}</td>
                    <td>
                      <span
                        className={`office-pricing-badge ${customerRuleStatus(rule, state.customerPrices || [], state.asOfDate) === 'Aktiv' ? 'green' : 'gray'}`}
                      >
                        {customerRuleStatus(
                          rule,
                          state.customerPrices || [],
                          state.asOfDate,
                        )}
                      </span>
                    </td>
                    {editable && (
                      <td>
                        <button
                          type="button"
                          className="office-pricing-edit"
                          onClick={() => edit(rule)}
                        >
                          <Pencil size={14} /> Ändra
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!filtered.length && (
              <div className="office-pricing-empty">
                Inga kundregler registrerade för den här kunden.
              </div>
            )}
          </div>
        </section>
        {article && selectedCustomer && (
          <QuotePreview
            key={`${article.id}-${selectedCustomer}`}
            article={article}
            state={state}
            user={user}
            actualUser={actualUser}
            initialCustomer={selectedCustomer}
          />
        )}
      </div>
      <aside>
        {editable ? (
          <form
            className="office-panel office-pricing-form"
            onSubmit={(event) => void submit(event)}
          >
            <div className="office-pricing-panel-title">
              <h2>{editing ? 'Ändra kundregel' : 'Ny kundregel'}</h2>
              {editing && (
                <button
                  type="button"
                  className="office-pricing-icon"
                  aria-label="Avbryt ändring av kundregel"
                  onClick={() => {
                    setEditing(false);
                    setDate(state.asOfDate);
                  }}
                >
                  <X size={15} />
                </button>
              )}
            </div>
            <label>
              Kund för prisregeln
              <select
                required
                value={selectedCustomer}
                onChange={(event) => onCustomer(event.target.value)}
              >
                <option value="">Välj kund…</option>
                {state.customers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Artikel för prisregeln
              <select
                required
                value={articleId}
                onChange={(event) => setArticleId(event.target.value)}
              >
                {state.articles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Typ av specialpris
              <select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as CustomerPrice['kind'])
                }
              >
                <option value="fixed">Fast pris i kr/kg</option>
                <option value="tier-adjustment">
                  Kronjustering från A/B/C
                </option>
                <option
                  value="lme-discount"
                  disabled={article?.base?.type !== 'lme'}
                >
                  Eget procentavdrag under LME
                </option>
              </select>
            </label>
            {kind === 'fixed' ? (
              <label>
                Kundpris (kr/kg)
                <input
                  type="number"
                  required
                  min="0"
                  step="any"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </label>
            ) : kind === 'tier-adjustment' ? (
              <div className="office-pricing-form-row">
                <label>
                  Utgå från prislista
                  <select
                    value={tier}
                    onChange={(event) =>
                      setTier(event.target.value as PriceTier)
                    }
                  >
                    {allowedTiers.map((value) => (
                      <option key={value} value={value}>
                        {value}-pris
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Justering (kr/kg)
                  <input
                    type="number"
                    required
                    step="any"
                    value={adjustment}
                    onChange={(event) => setAdjustment(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label>
                Avdrag under LME (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="any"
                  required
                  value={discount}
                  onChange={(event) => setDiscount(event.target.value)}
                />
              </label>
            )}
            <label>
              Kundregeln gäller från
              <input
                type="date"
                required
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              Anteckning
              <textarea
                required
                placeholder="Avtal eller anledning till kundpriset…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
              />
            </label>
            <label className="office-pricing-checkbox">
              <input
                type="checkbox"
                checked={active}
                onChange={(event) => setActive(event.target.checked)}
              />{' '}
              Prisregeln är aktiv
            </label>
            <div className="office-pricing-conversion">
              <small>Förhandsvisning specialpris · {date}</small>
              <strong>
                {money(preview)} <span>kr/kg</span>
              </strong>
              <span>
                {historicalError ||
                  (kind !== 'fixed' && !previewState
                    ? 'Hämtar prisbas för giltighetsdatumet…'
                    : kind !== 'fixed' && !previewArticle
                      ? 'Artikeln saknar en prisversion på valt datum.'
                      : 'Går före kundens volympris.')}
              </span>
            </div>
            <button
              type="submit"
              className="office-pricing-primary"
              disabled={busy || !selectedCustomer || !articleId}
            >
              <Check size={15} /> {busy ? 'Sparar…' : 'Spara kundregel'}
            </button>
            <small>
              Avsluta en regel genom att spara en ny version med Aktiverad
              avmarkerad. Historiken finns kvar.
            </small>
          </form>
        ) : (
          <PricingPriority />
        )}
      </aside>
    </div>
  );
}
function exportPrices(articles: PriceArticle[], allowed: PriceTier[]) {
  const escape = (value: unknown) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = [
    [
      'Artikel',
      'Beskrivning',
      ...allowed.map((tier) => `${tier} kr/kg`),
      'B kg',
      'A kg',
      'Gäller från',
    ],
    ...articles.map((article) => [
      article.name,
      article.description,
      ...allowed.map((tier) => article.prices[tier]),
      article.thresholds.B,
      article.thresholds.A,
      article.effectiveFrom,
    ]),
  ];
  const blob = new Blob(
    ['\uFEFF', rows.map((row) => row.map(escape).join(';')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `jeroc-artikelpriser-${today()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
