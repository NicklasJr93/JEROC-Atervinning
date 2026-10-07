import {
  ArrowUpRight,
  BadgeCheck,
  Building2,
  CheckCircle2,
  Clock3,
  FileSearch,
  Scale,
  ShieldAlert,
  Users,
  Wallet,
} from 'lucide-react';
import { articles, initialCustomers } from '../data';
import {
  amount,
  can,
  statusNames,
  weight,
  type OfficeCard,
  type OfficeUser,
  type Permission,
} from './model';
import './overview.css';

const number = (value: number, decimals = 0) =>
  value.toLocaleString('sv-SE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

const rowPriceVisible = (user: OfficeUser, row: OfficeCard['rows'][number]) =>
  !row.pricePending &&
  can(user, 'prices') &&
  can(
    user,
    row.tier === 'Eget' || row.source === 'Kundanpassat pris'
      ? 'customerPrices'
      : (`price${row.tier}` as Permission),
  );

const totalVisible = (user: OfficeUser, card: OfficeCard) =>
  !card.financialPending &&
  (can(user, 'reports') ||
    can(user, 'pay') ||
    can(user, 'attest') ||
    card.rows.every((row) => rowPriceVisible(user, row)));

function deliveryDay(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Stockholm',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date)
    : '';
}

export function QueueSummary({
  cards,
  user,
  mode,
}: {
  cards: OfficeCard[];
  user: OfficeUser;
  mode: 'attest' | 'payments';
}) {
  const queue = cards.filter((card) =>
    mode === 'attest' ? card.status === 'attest' : card.status === 'ready',
  );
  const overLimit = queue.filter(
    (card) => !card.financialPending && amount(card) > user.maxAttest,
  );
  const ownBlocked = queue.filter(
    (card) => !user.ownAttest && card.preparedBy === user.id,
  );
  const eligible = queue.filter(
    (card) =>
      !card.financialPending &&
      amount(card) <= user.maxAttest &&
      (user.ownAttest || card.preparedBy !== user.id),
  );
  const paymentMethods = new Set(
    queue.map((card) => card.payment.split('·')[0].trim()).filter(Boolean),
  );
  const metrics = [
    {
      label: mode === 'attest' ? 'Väntar på attest' : 'Klara för utbetalning',
      value: number(queue.length),
      note: 'viktkort i kön',
      icon: mode === 'attest' ? FileSearch : Wallet,
      color: 'blue',
    },
    {
      label: mode === 'attest' ? 'Kan attesteras av dig' : 'Att betala ut',
      value:
        mode === 'attest'
          ? number(eligible.length)
          : queue.some((card) => card.financialPending)
            ? 'Läser prisunderlag…'
            : `${number(
                queue.reduce((sum, card) => sum + amount(card), 0),
                2,
              )} kr`,
      note:
        mode === 'attest'
          ? 'inom din gräns och attestregel'
          : 'sammanlagt i kön · demo',
      icon: CheckCircle2,
      color: 'green',
    },
    {
      label: mode === 'attest' ? 'Över din attestgräns' : 'Material i kön',
      value:
        mode === 'attest'
          ? number(overLimit.length)
          : `${number(queue.reduce((sum, card) => sum + weight(card), 0))} kg`,
      note:
        mode === 'attest'
          ? `Din gräns: ${number(user.maxAttest, 2)} kr`
          : `${queue.reduce((sum, card) => sum + card.rows.length, 0)} materialrader`,
      icon: mode === 'attest' ? ShieldAlert : Scale,
      color: mode === 'attest' ? 'amber' : 'blue',
    },
    {
      label: mode === 'attest' ? 'Egen attest spärrad' : 'Demoutbetalda',
      value:
        mode === 'attest'
          ? number(ownBlocked.length)
          : number(cards.filter((card) => card.status === 'paid').length),
      note:
        mode === 'attest'
          ? user.ownAttest
            ? 'Egen attest är tillåten'
            : 'förberedda av dig'
          : `${paymentMethods.size} betalningssätt i väntande kö`,
      icon: mode === 'attest' ? Clock3 : BadgeCheck,
      color: 'purple',
    },
  ];
  return (
    <div className="office-queue-summary">
      {metrics.map(({ label, value, note, icon: Icon, color }) => (
        <section className="office-queue-metric" key={label}>
          <span className={`office-overview-icon overview-${color}`}>
            <Icon size={19} />
          </span>
          <div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        </section>
      ))}
    </div>
  );
}

export function QuickActions({
  user,
  onNavigate,
}: {
  user: OfficeUser;
  onNavigate: (path: string) => void;
}) {
  const actions = [
    {
      right: 'prepare',
      label: 'Granska nya invägningar',
      path: '/weighings?status=new',
      icon: FileSearch,
    },
    {
      right: 'attest',
      label: 'Öppna attestkön',
      path: '/attest',
      icon: BadgeCheck,
    },
    {
      right: 'pay',
      label: 'Hantera utbetalningar',
      path: '/payments',
      icon: Wallet,
    },
    {
      right: 'view',
      label: 'Sök i kundregistret',
      path: '/customers',
      icon: Users,
    },
    {
      right: 'prices',
      label: 'Artiklar & priser',
      path: '/prices',
      icon: Scale,
    },
  ] as const;
  const visible = actions.filter((action) => can(user, action.right));
  if (!visible.length) return null;
  return (
    <section className="office-panel office-quick-actions">
      <h2>Snabbåtgärder</h2>
      <div>
        {visible.map(({ label, path, icon: Icon }) => (
          <button key={path} onClick={() => onNavigate(path)}>
            <Icon size={16} />
            <span>{label}</span>
            <ArrowUpRight size={14} />
          </button>
        ))}
      </div>
    </section>
  );
}

export function DailyWeights({ cards }: { cards: OfficeCard[] }) {
  const today = deliveryDay(new Date().toISOString());
  const latest = cards
    .map((card) => deliveryDay(card.date))
    .filter(Boolean)
    .sort()
    .at(-1);
  const day = cards.some((card) => deliveryDay(card.date) === today)
    ? today
    : (latest ?? today);
  const daily = cards.filter((card) => deliveryDay(card.date) === day);
  const total = daily.reduce((sum, card) => sum + weight(card), 0);
  const byHour = Array.from({ length: 24 }, () => ({ weight: 0, count: 0 }));
  daily.forEach((card) => {
    const hour = Number(
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Stockholm',
        hour: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(card.date)),
    );
    byHour[hour].weight += weight(card);
    byHour[hour].count++;
  });
  const activeHours = byHour.flatMap((bucket, hour) =>
    bucket.count ? [hour] : [],
  );
  const firstHour = Math.min(7, ...activeHours);
  const lastHour = Math.max(18, ...activeHours);
  const max = Math.max(1, ...byHour.map((bucket) => bucket.weight));
  return (
    <section className="office-panel office-daily-weights">
      <div className="office-panel-heading">
        <h2>{day === today ? 'Dagens invägningar' : 'Senaste leveransdag'}</h2>
        <time dateTime={day}>{day}</time>
      </div>
      <div className="office-daily-totals">
        <span>
          <strong>{number(daily.length)}</strong>
          <small>invägningar</small>
        </span>
        <span>
          <strong>{number(total)} kg</strong>
          <small>invägt material</small>
        </span>
      </div>
      <div
        className="office-weight-chart"
        role="img"
        aria-label={`${daily.length} invägningar, ${number(total)} kilogram, den ${day}, fördelat per timme.`}
      >
        {byHour.slice(firstHour, lastHour + 1).map((bucket, index) => {
          const hour = index + firstHour;
          return (
            <div
              className="office-weight-bar-slot"
              key={hour}
              aria-hidden="true"
              title={`${hour}–${hour + 1}: ${number(bucket.weight)} kg · ${bucket.count} invägningar`}
            >
              <i
                className={bucket.count ? 'has-weight' : ''}
                style={{
                  height: `${bucket.count ? Math.max(4, (bucket.weight / max) * 78) : 2}px`,
                }}
              />
              <small>
                {hour % 3 === 0 ? String(hour).padStart(2, '0') : '\u00a0'}
              </small>
            </div>
          );
        })}
      </div>
      {!daily.length && (
        <p className="office-small">Inga invägningar den här dagen.</p>
      )}
      <p className="office-small">
        Färdiga viktkort i kontorsdemon · leveransdatum.
      </p>
    </section>
  );
}

export function CardPreview({
  card,
  user,
  onOpen,
}: {
  card: OfficeCard;
  user: OfficeUser;
  onOpen: (id: number) => void;
}) {
  const customer = initialCustomers.find((item) => item.id === card.customerId);
  const moneyVisible = totalVisible(user, card);
  return (
    <section
      className="office-panel office-card-preview"
      aria-label={`Förhandsvisning av viktkort ${card.id}`}
    >
      <div className="office-panel-heading">
        <div className="office-preview-heading">
          <h2>Invägning #{card.id}</h2>
          <span className={`office-status status-${card.status}`}>
            {statusNames[card.status]}
          </span>
        </div>
        <button className="office-view" onClick={() => onOpen(card.id)}>
          Öppna underlag <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="office-preview-columns">
        <div>
          <h3>Grundinformation</h3>
          <dl>
            <div>
              <dt>Inlämnat</dt>
              <dd>{deliveryDay(card.date)}</dd>
            </div>
            <div>
              <dt>Invägare</dt>
              <dd>{card.weigher}</dd>
            </div>
            <div>
              <dt>Gård</dt>
              <dd>{card.yard}</dd>
            </div>
            <div>
              <dt>Materialvikt</dt>
              <dd>{number(weight(card))} kg</dd>
            </div>
            {moneyVisible && (
              <div>
                <dt>Materialvärde</dt>
                <dd>{number(amount(card), 2)} kr</dd>
              </div>
            )}
            {card.registration && (
              <div>
                <dt>Fordon</dt>
                <dd>{card.registration}</dd>
              </div>
            )}
          </dl>
        </div>
        <div>
          <h3>Kunduppgifter</h3>
          {customer ? (
            <>
              <strong className="office-preview-customer">
                <Building2 size={15} />
                {customer.name}
              </strong>
              <small className="office-preview-customer-number">
                {customer.number} · {customer.type}
              </small>
              <dl>
                <div>
                  <dt>Referens</dt>
                  <dd>{card.reference || 'Saknas'}</dd>
                </div>
                <div>
                  <dt>Ursprung</dt>
                  <dd>{card.origin || 'Saknas'}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd
                    className={
                      card.idVerified
                        ? 'office-preview-ok'
                        : 'office-preview-warning'
                    }
                  >
                    {card.idVerified ? 'Kontrollerat' : 'Behöver kontrolleras'}
                  </dd>
                </div>
                <div>
                  <dt>Betalningssätt</dt>
                  <dd>{card.payment.split('·')[0].trim() || 'Saknas'}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="office-preview-missing">
              Kunduppgifter saknas. Välj kund när underlaget kompletteras.
            </p>
          )}
        </div>
        <div>
          <h3>Material ({card.rows.length})</h3>
          <ul className="office-preview-materials">
            {card.rows.map((row, index) => {
              const article = articles.find(
                (item) => item.id === row.articleId,
              );
              const cell = article?.photos[0];
              return (
                <li key={`${row.articleId}-${index}`}>
                  {cell !== undefined && (
                    <span
                      className="office-preview-material-image"
                      aria-hidden="true"
                      style={{
                        backgroundImage: `url(${cell >= 28 ? '/images/copper-grades.png' : '/images/materials.png'})`,
                        backgroundSize: cell >= 28 ? '400% 300%' : '400% 700%',
                        backgroundPosition: `${(((cell >= 28 ? cell - 28 : cell) % 4) * 100) / 3}% ${(Math.floor((cell >= 28 ? cell - 28 : cell) / 4) * 100) / (cell >= 28 ? 2 : 6)}%`,
                      }}
                    />
                  )}
                  <span>
                    <strong>{article?.name ?? row.articleId}</strong>
                    {rowPriceVisible(user, row) && (
                      <small>
                        {row.source === 'Kundanpassat pris'
                          ? 'Kundpris'
                          : row.tier === 'Eget'
                            ? 'Engångspris'
                            : `${row.tier}-pris`}{' '}
                        · {number(row.price, 2)} kr/kg
                      </small>
                    )}
                  </span>
                  <b>{number(row.weight)} kg</b>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Export exactly the supplied queue; private price fields obey individual price rights. */
export function exportOfficeCsv(
  cards: OfficeCard[],
  user: OfficeUser,
): boolean {
  if (!can(user, 'reports')) return false;
  const priceColumns = cards.some((card) =>
    card.rows.some((row) => rowPriceVisible(user, row)),
  );
  const quote = (value: string | number) => {
    const text = String(value);
    const safe =
      typeof value === 'string' && /^[\s]*[=+@-]/.test(text)
        ? `'${text}`
        : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const headers = [
    'Viktkort',
    'Leveransdatum',
    'Kund',
    'Invägare',
    'Gård',
    'Status',
    'Artikel',
    'Vikt kg',
    'Referens',
    'Ursprungsadress',
  ];
  if (priceColumns) headers.push('Prisregel', 'Pris kr/kg', 'Radbelopp kr');
  headers.push('Kortets totalbelopp kr');
  const rows: (string | number)[][] = [headers];
  cards.forEach((card) => {
    card.rows.forEach((row, index) => {
      const line: (string | number)[] = [
        card.id,
        deliveryDay(card.date),
        initialCustomers.find((customer) => customer.id === card.customerId)
          ?.name ?? 'Kund saknas',
        card.weigher,
        card.yard,
        statusNames[card.status],
        articles.find((article) => article.id === row.articleId)?.name ??
          row.articleId,
        String(row.weight).replace('.', ','),
        card.reference,
        card.origin,
      ];
      if (priceColumns)
        line.push(
          ...(rowPriceVisible(user, row)
            ? [
                row.tier,
                row.price.toFixed(2).replace('.', ','),
                (row.price * row.weight).toFixed(2).replace('.', ','),
              ]
            : ['', '', '']),
        );
      line.push(
        index === 0 && totalVisible(user, card)
          ? amount(card).toFixed(2).replace('.', ',')
          : '',
      );
      rows.push(line);
    });
  });
  const csv =
    '\uFEFF' + rows.map((row) => row.map(quote).join(';')).join('\r\n');
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `JEROC-viktkort-${deliveryDay(new Date().toISOString())}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
