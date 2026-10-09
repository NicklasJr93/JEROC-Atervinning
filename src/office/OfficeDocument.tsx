import { Printer, X } from 'lucide-react';
import { articleById } from '../data';
import { kilos, money } from '../model';
import {
  amount,
  type OfficeCard,
  type OfficeCustomer,
  type OfficePayment,
} from './model';
import { paymentSummary } from './customer-model';

export default function OfficeDocument({
  card,
  customer,
  payment,
  type,
  onClose,
  showPaymentDetails,
  showRowPrice,
}: {
  card: OfficeCard;
  customer?: OfficeCustomer;
  payment?: OfficePayment;
  type: 'settlement' | 'receipt';
  onClose: () => void;
  showPaymentDetails: boolean;
  showRowPrice: (row: OfficeCard['rows'][number]) => boolean;
}) {
  const receipt = type === 'receipt';
  return (
    <div
      className="office-document-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={receipt ? 'Utbetalningskvitto' : 'Avräkningsnota'}
    >
      <div className="office-document-actions">
        <button className="office-btn outline" onClick={() => window.print()}>
          <Printer size={16} />
          Skriv ut / spara som PDF
        </button>
        <button className="office-btn outline" onClick={onClose}>
          <X size={16} />
          Stäng underlag
        </button>
      </div>
      <article className="office-document">
        <header>
          <img src="/images/jeroc-logo-v2.png" alt="JEROC Återvinning" />
          <div>
            <span>DEMO · FIKTIVT UNDERLAG</span>
            <h1>{receipt ? 'Utbetalningskvitto' : 'Avräkningsnota'}</h1>
            <p>
              {receipt
                ? (payment?.reference ?? `Äldre demo #${card.id}`)
                : `AV-${card.id}`}{' '}
              · Viktkort #{card.id}
            </p>
          </div>
        </header>
        <div className="office-document-parties">
          <section>
            <h2>Köpare</h2>
            <strong>JEROC Återvinning AB · Demo</strong>
            <p>
              Fiktiv företagsadress, Norrtälje
              <br />
              Organisationsnummer: 559000-0000
              <br />
              Uppgifterna är testdata.
            </p>
          </section>
          <section>
            <h2>Säljare</h2>
            <strong>{customer?.name ?? 'Kund saknas'}</strong>
            <p>
              {customer?.number}
              <br />
              {customer?.address}
              <br />
              {customer?.postalCode} {customer?.city}
              <br />
              {customer?.customerNumber}
            </p>
          </section>
        </div>
        <dl className="office-document-facts">
          <div>
            <dt>Inlämnat</dt>
            <dd>
              {new Date(card.date).toLocaleString('sv-SE', {
                timeZone: 'Europe/Stockholm',
              })}
            </dd>
          </div>
          <div>
            <dt>Plats</dt>
            <dd>{card.yard}</dd>
          </div>
          <div>
            <dt>Referens</dt>
            <dd>{card.reference || '–'}</dd>
          </div>
          <div>
            <dt>Ursprungsadress</dt>
            <dd>{card.origin || '–'}</dd>
          </div>
          {card.registration && (
            <div>
              <dt>Registrering</dt>
              <dd>{card.registration}</dd>
            </div>
          )}
        </dl>
        {card.customerApproval?.approvedAt && <section className="office-document-approval">
          <h2>Kundgodkänd &amp; JEROC-attesterad</h2>
          <p>Kundgodkännande med fysisk legitimation · version {card.customerApproval.version}<br />
            Bekräftat av {card.customerApproval.approvedBy} · {new Date(card.customerApproval.approvedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}<br />
            {card.customerApproval.attestedAt && <>JEROC-attest: {card.customerApproval.attestedBy} · {new Date(card.customerApproval.attestedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}</>}
          </p>
        </section>}
        <table>
          <thead>
            <tr>
              <th>Material</th>
              <th>Vikt</th>
              <th>Pris/kg</th>
              <th>Belopp</th>
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row, i) => (
              <tr key={i}>
                <td>{row.articleName ?? articleById(row.articleId)?.name ?? row.articleId}</td>
                <td>{kilos(row.weight)} kg</td>
                <td>{showRowPrice(row) ? `${money(row.price)} kr` : '—'}</td>
                <td>
                  {showRowPrice(row)
                    ? `${money(row.weight * row.price)} kr`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="office-document-totals">
          <p>
            Viktkortets belopp<strong>{money(amount(card))} kr</strong>
          </p>
          {receipt && (
            <>
              <p>
                Kvittning mot minussaldo
                <strong>−{money(payment?.offset ?? 0)} kr</strong>
              </p>
              <p>
                Registrerad demoutbetalning
                <strong>{money(payment?.amount ?? amount(card))} kr</strong>
              </p>
            </>
          )}
        </div>
        {receipt && (
          <section>
            <h2>Utbetalningsuppgifter</h2>
            <p>
              {showPaymentDetails
                ? payment?.paymentDetails
                  ? paymentSummary(payment.paymentDetails)
                  : card.payment
                : 'Betalningsuppgifter dolda av behörighet'}
            </p>
            <p>
              Registrerat:{' '}
              {new Date(
                payment?.date ?? card.paidAt ?? card.date,
              ).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}
              <br />
              Registrerat av: {payment?.actor ?? 'Äldre demoregistrering'}
              <br />
              Referens: {payment?.reference ?? 'Äldre demoutbetalning'}
            </p>
          </section>
        )}
        <section>
          <h2>Spårbarhet</h2>
          {card.audit
            .filter((a) =>
              receipt
                ? a.text.startsWith('Demoutbetalning')
                : !a.text.startsWith('Pris för'),
            )
            .slice(-5)
            .map((a, i) => (
              <p key={i}>
                {a.text.startsWith('Demoutbetalning')
                  ? 'Demoutbetalning registrerad. Belopp och referens framgår ovan.'
                  : a.text}
                <br />
                <small>
                  {a.actor} ·{' '}
                  {new Date(a.at).toLocaleString('sv-SE', {
                    timeZone: 'Europe/Stockholm',
                  })}
                </small>
              </p>
            ))}
        </section>
        <footer>
          Det här är ett demounderlag. Ingen betalning eller bokföring har
          skickats. Moms och konton behöver fastställas innan skarp drift.
        </footer>
      </article>
    </div>
  );
}
