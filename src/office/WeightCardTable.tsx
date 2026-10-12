import { money, kilos } from '../model';
import { amount, can, statusNames, weight, type OfficeCard, type OfficeCustomer, type OfficeUser, type Permission } from './model';
import { createWeightCardPreview, WeightCardLink, WeightCardRow, WeightCardRows } from './WeightCardRows';

const time = (value: string) => new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(value));
const totalVisible = (user: OfficeUser, card: OfficeCard) => !card.financialPending && (can(user, 'reports') || can(user, 'attest') || can(user, 'pay') || card.rows.every(row => !row.pricePending && can(user, 'prices') && can(user, row.tier === 'Eget' ? 'customerPrices' : `price${row.tier}` as Permission)));

export default function WeightCardTable({ cards, customers, showMoney, user, onOpen, getCardRoute }: {
  cards: OfficeCard[];
  customers?: OfficeCustomer[];
  showMoney: boolean;
  user: OfficeUser;
  onOpen: (id: number) => void;
  getCardRoute: (card: OfficeCard) => string;
}) {
  return <WeightCardRows scope={`${user.id}:${user.permissions.join(',')}:${user.siteIds?.join(',') ?? ''}`}><div className="office-table-wrap"><table className="office-table office-weight-card-table">
    <thead><tr><th>Viktkort</th><th>Kund / invägare</th><th>Vikt</th>{showMoney && <th>Belopp</th>}<th>Status</th></tr></thead>
    <tbody>{cards.map(card => {
      const name = card.customerSnapshot?.name ?? customers?.find(customer => customer.id === card.customerId)?.name ?? 'Kund saknas';
      const to = getCardRoute(card);
      return <WeightCardRow key={card.id} cardId={card.id} to={to} onOpen={onOpen} preview={createWeightCardPreview(card, name)}>
        <td><WeightCardLink cardId={card.id} to={to} onOpen={onOpen} /><small>{time(card.date)}</small></td>
        <td><strong>{name}</strong><small>{card.weigher} · {card.yard}</small></td>
        <td>{kilos(weight(card))} kg<small>{card.rows.length} material</small></td>
        {showMoney && <td>{totalVisible(user, card) ? `${money(amount(card))} kr` : '–'}</td>}
        <td><span className={`office-status status-${card.status}`}>{statusNames[card.status]}</span></td>
      </WeightCardRow>;
    })}</tbody>
  </table></div></WeightCardRows>;
}
