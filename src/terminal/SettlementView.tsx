import { ClipboardList, FileText, UserRound } from 'lucide-react';
import { kilos, money } from '../model';
import type { PublicSettlement } from '../office/terminal-demo-types';
import './settlement.css';

const dateLabel = (date: string) => new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });

export function SettlementView({ settlement }: { settlement: PublicSettlement }) {
  const balance = settlement.paymentMethod === 'balance';
  return <div className="jeroc-settlement">
    <section className="settlement-seller-card">
      <div className="settlement-icon-bubble"><UserRound size={28} /></div>
      <div><h2>{settlement.customerName}</h2><p><ClipboardList size={15} />Invägningskort INV-{settlement.cardId}</p><p>Datum: {dateLabel(settlement.deliveredAt)} · {settlement.siteName}</p>{settlement.reference && <p>Referens: {settlement.reference}</p>}</div>
    </section>
    <section className="settlement-articles">
      <h2><FileText size={21} /> Artiklar</h2>
      <table className="settlement-material-table terminal-material-table"><caption className="settlement-sr-only">Material, vikt och priser i din avräkning</caption><thead><tr><th>Artikel</th><th>Vikt</th><th>Pris/kg</th><th>Belopp</th></tr></thead><tbody>{settlement.rows.map((row, index) => <tr key={`${row.articleId}-${index}`}><td>{row.name}</td><td>{kilos(row.weight)} kg</td><td>{money(row.price)} kr</td><td>{money(row.amount)} kr</td></tr>)}</tbody></table>
      {settlement.offset > 0 && <dl className="settlement-adjustments"><div><dt>Materialvärde</dt><dd>{money(settlement.gross)} kr</dd></div><div><dt>Avdrag mot tidigare minussaldo</dt><dd>−{money(settlement.offset)} kr</dd></div></dl>}
    </section>
    <section className="settlement-total"><div className="settlement-icon-bubble"><ClipboardList size={29} /></div><div><span>{balance ? 'Att lägga på saldo' : 'Föreslagen utbetalning'}</span><strong>{money(settlement.net)} <small>kr</small></strong></div></section>
    <p className="settlement-preliminary"><FileText size={15} /> PRELIMINÄR – EJ BOKFÖRD <span>Version {settlement.version}</span></p>
  </div>;
}
