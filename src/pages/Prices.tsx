import { useRef, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, UserRound, X, ChevronRight } from 'lucide-react';
import {
  Header,
  Search,
  Photo,
  Empty,
  Notice,
  Nav,
  Modal,
} from '../components';
import { articles, demoCustomerPrice, type Article } from '../data';
import { money } from '../model';
import { useDemo } from '../store';

function usePriceContext() {
  const { data } = useDemo();
  const [params, setParams] = useSearchParams();
  const customer = data.customers.find((c) => c.id === params.get('customer'));
  function selectCustomer(id?: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set('customer', id);
        else next.delete('customer');
        return next;
      },
      { replace: true },
    );
  }
  return { customer, params, setParams, selectCustomer };
}
function PriceCustomer({
  customer,
  onSelect,
}: {
  customer?: { id: string; name: string };
  onSelect: (id?: string) => void;
}) {
  const { data } = useDemo();
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState('');
  const matches = data.customers.filter((c) =>
    `${c.name} ${c.number}`.toLowerCase().includes(search.toLowerCase()),
  );
  const open = () => {
    setSearch('');
    setChoosing(true);
  };
  return (
    <>
      <div className="price-header-customer">
        <button
          className="price-header-select"
          aria-label={customer ? 'Byt kund i prislistan' : 'Lägg till kund'}
          onClick={open}
        >
          {customer ? <UserRound size={15} /> : <Plus size={15} />}
          <span>{customer?.name ?? 'Lägg till kund'}</span>
        </button>
        {customer && (
          <button
            className="price-clear-customer"
            aria-label="Ta bort vald kund"
            onClick={() => onSelect(undefined)}
          >
            <X size={17} />
          </button>
        )}
      </div>
      {choosing && (
        <Modal title="Välj kund" onClose={() => setChoosing(false)}>
          <Search
            value={search}
            setValue={setSearch}
            placeholder="Sök kund eller kundnummer"
          />
          <div className="price-customer-options">
            {matches.map((c) => (
              <button
                key={c.id}
                className="customer-choice"
                onClick={() => {
                  onSelect(c.id);
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
export function PricesPage() {
  const { customer, params, setParams, selectCustomer } = usePriceContext();
  const navigate = useNavigate();
  const listRef = useRef<HTMLElement>(null);
  const search = params.get('search') ?? '';
  useEffect(() => {
    listRef.current?.scrollTo(0, 0);
  }, [search]);
  const filtered = articles.filter((a) =>
    `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="prices-fixed-top">
        <Header title="Prislista">
          <PriceCustomer customer={customer} onSelect={selectCustomer} />
        </Header>
        <div className="prices-search">
          <Search
            value={search}
            setValue={(value) =>
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  if (value) next.set('search', value);
                  else next.delete('search');
                  return next;
                },
                { replace: true },
              )
            }
            placeholder="Sök material eller artikel"
          />
        </div>
      </div>
      <main ref={listRef} className="prices-scroll-list">
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
            <button
              className="price-row"
              key={a.id}
              aria-label={`Visa priser för ${a.name}`}
              onClick={() =>
                navigate(`/prices/${a.id}${params.size ? `?${params}` : ''}`)
              }
            >
              <div className="price-article">
                <Photo index={a.photos[0]} label={a.name} />
                <strong>
                  {a.name}
                  <ChevronRight size={12} />
                </strong>
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
            </button>
          ))}
        </div>
        {!filtered.length && (
          <Empty title="Inga artiklar hittades" text="Prova ett annat namn." />
        )}
        <Notice>
          {customer
            ? 'Fiktiva kundpriser för demonstration. Specialpris går före A/B/C. Kontorets prissättning och volymberäkning är ännu inte anslutna.'
            : 'Allmän prislista med fiktiva demopriser. Tryck på en artikel för pristrend och jämförelse.'}
        </Notice>
      </main>
      <Nav />
    </>
  );
}

const factors = [
  0.79, 0.83, 0.81, 0.87, 0.9, 0.88, 0.92, 0.95, 0.93, 0.97, 0.96, 1,
];
const months = [
  'Nov',
  'Dec',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Maj',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
];
const colors = ['#0667ff', '#07954f', '#ee9200'];
function PriceTrend({
  article,
  customerPrice,
}: {
  article: Article;
  customerPrice?: number;
}) {
  const [period, setPeriod] = useState(12);
  const start = 12 - period;
  const series = article.prices.map((price) =>
    factors.slice(start).map((f) => Math.round(price * f * 100) / 100),
  );
  const values = series
    .flat()
    .concat(customerPrice == null ? [] : [customerPrice]);
  const min = Math.min(...values),
    max = Math.max(...values);
  const span = Math.max(max - min, max * 0.15, 0.1);
  const low = Math.max(0, min - span * 0.15),
    high = max + span * 0.25;
  const x = (index: number) => 40 + (index / (period - 1)) * 235;
  const y = (price: number) => 160 - ((price - low) / (high - low)) * 125;
  const indices = Array.from(
    new Set([0, Math.floor((period - 1) / 2), period - 1]),
  );
  return (
    <section className="article-price-panel trend-panel">
      <div className="trend-heading">
        <h2>Prisutveckling</h2>
        <div className="trend-periods" aria-label="Period för pristrend">
          {[3, 6, 12].map((n) => (
            <button
              key={n}
              aria-pressed={period === n}
              onClick={() => setPeriod(n)}
            >
              {n} mån
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox="0 0 360 200"
        role="img"
        aria-label={`A/B/C pristrend, ${period} månader${customerPrice != null ? ', med kundpris idag som streckad linje' : ''}`}
      >
        <title>
          Fiktiv prishistorik för {article.name}. {period} månader.
        </title>
        <text x="8" y="17" className="chart-label">
          kr/kg
        </text>
        {[0, 1, 2, 3, 4].map((i) => {
          const value = low + ((high - low) * i) / 4;
          return (
            <g key={i}>
              <line
                x1="40"
                x2="275"
                y1={y(value)}
                y2={y(value)}
                stroke="#e8eef5"
              />
              <text
                x="33"
                y={y(value) + 4}
                textAnchor="end"
                className="chart-label"
              >
                {value < 10 ? money(value) : Math.round(value)}
              </text>
            </g>
          );
        })}
        {indices.map((i) => (
          <text
            key={i}
            x={x(i)}
            y="181"
            textAnchor="middle"
            className="chart-label"
          >
            {months[start + i]}
          </text>
        ))}
        {series.map((prices, tier) => (
          <g key={tier}>
            <polyline
              fill="none"
              stroke={colors[tier]}
              strokeWidth="2.5"
              strokeLinejoin="round"
              points={prices.map((p, i) => `${x(i)},${y(p)}`).join(' ')}
            />
            <circle
              cx={x(period - 1)}
              cy={y(prices[period - 1])}
              r="3.5"
              fill={colors[tier]}
            />
            <text
              x="284"
              y={y(prices[period - 1]) + 4}
              fill={colors[tier]}
              className="chart-price"
            >
              {money(prices[period - 1])}
            </text>
          </g>
        ))}
        {customerPrice != null && (
          <g>
            <line
              x1="40"
              x2="275"
              y1={y(customerPrice)}
              y2={y(customerPrice)}
              stroke="#087c45"
              strokeDasharray="5 4"
            />
            <text
              x="42"
              y={y(customerPrice) - 7}
              className="chart-label"
              fill="#087c45"
            >
              Kundpris idag {money(customerPrice)}
            </text>
          </g>
        )}
      </svg>
      <div className="trend-legend">
        {colors.map((color, i) => (
          <span key={color}>
            <i style={{ background: color }} />
            {['A', 'B', 'C'][i]}
          </span>
        ))}
      </div>
      {customerPrice != null && (
        <p className="trend-footnote">
          Streckad linje: kundpris idag, inte kundens prishistorik.
        </p>
      )}
      <p className="trend-footnote">
        {months[start]} {start < 2 ? '2025' : '2026'} – okt 2026 · Exempeldata
      </p>
    </section>
  );
}
export function ArticlePricesPage() {
  const { articleId } = useParams();
  const { customer, params, selectCustomer } = usePriceContext();
  const article = articles.find((a) => a.id === articleId);
  const back = `/prices${params.size ? `?${params}` : ''}`;
  if (!article)
    return (
      <>
        <Header title="Artikelpriser" back={back} />
        <Empty
          title="Artikeln finns inte"
          text="Gå tillbaka till prislistan och välj en artikel."
        />
        <Nav />
      </>
    );
  const quote = customer && demoCustomerPrice(customer.id, article);
  const difference = (base: number) => {
    const diff = Math.round((quote!.price - base) * 100) / 100;
    return `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${money(Math.abs(diff))}`;
  };
  return (
    <>
      <div className="prices-fixed-top">
        <Header title="Artikelpriser" back={back} />
      </div>
      <main className="prices-scroll-list article-prices-page">
        <div className="article-price-identity">
          <Photo index={article.photos[0]} label={article.name} />
          <div>
            <h1>{article.name}</h1>
            <p>Priser i kr/kg</p>
            <span className="badge blue">EXEMPELPRISER</span>
          </div>
        </div>
        <PriceCustomer customer={customer} onSelect={selectCustomer} />
        {quote ? (
          <>
            <section className="customer-price-highlight">
              <h2>Kundens pris idag</h2>
              <div>
                <strong>{money(quote.price)} kr/kg</strong>
                <span className="badge green">{quote.source}</span>
              </div>
              <p>{difference(article.prices[0])} kr/kg jämfört med A</p>
            </section>
            <section className="article-price-panel">
              <h2>Jämför med prislistan</h2>
              <table className="customer-price-comparison">
                <thead>
                  <tr>
                    <th>Lista</th>
                    <th>Pris (kr/kg)</th>
                    <th>Kundens skillnad</th>
                  </tr>
                </thead>
                <tbody>
                  {article.prices.map((price, i) => (
                    <tr key={i}>
                      <th>
                        <i style={{ background: colors[i] }} />
                        {['A', 'B', 'C'][i]}
                      </th>
                      <td>{money(price)}</td>
                      <td
                        className={
                          quote.price >= price
                            ? 'price-positive'
                            : 'price-negative'
                        }
                      >
                        {difference(price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        ) : (
          <section className="article-price-panel">
            <h2>Aktuella priser</h2>
            <div className="article-current-prices">
              {article.prices.map((price, i) => (
                <div key={i}>
                  <span>
                    <i style={{ background: colors[i] }} />
                    {['A', 'B', 'C'][i]}
                  </span>
                  <strong>{money(price)}</strong>
                  <small>kr/kg</small>
                </div>
              ))}
            </div>
          </section>
        )}
        <PriceTrend article={article} customerPrice={quote?.price} />
        <Notice>
          {customer
            ? 'Fiktiva demopriser och historik. Kontorets prisregler är ännu inte anslutna.'
            : 'Välj kund för att jämföra med kundens pris. Historiken är fiktiv exempeldata.'}
        </Notice>
      </main>
      <Nav />
    </>
  );
}
