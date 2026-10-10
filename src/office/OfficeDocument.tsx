import { useEffect, useState } from 'react';
import { FileText, Printer, RefreshCw, X } from 'lucide-react';
import { articleById } from '../data';
import { kilos, money } from '../model';
import {
  amount,
  type OfficeCard,
  type OfficeCustomer,
  type OfficePayment,
  type OfficeUser,
} from './model';
import { paymentSummary } from './customer-model';
import ArchiveViewer from './documents/ArchiveViewer';
import { documentApi, documentStageNames, documentsNewestFirst, type ArchivedDocument, type DocumentStage } from './documents/client';
import './documents/documents.css';

export default function OfficeDocument({
  card,
  customer,
  payment,
  type,
  onClose,
  showPaymentDetails,
  showRowPrice,
  user,
  actualUser,
}: {
  card: OfficeCard;
  customer?: OfficeCustomer;
  payment?: OfficePayment;
  type: 'settlement' | 'receipt';
  user: OfficeUser; actualUser: OfficeUser;
  onClose: () => void;
  showPaymentDetails: boolean;
  showRowPrice: (row: OfficeCard['rows'][number]) => boolean;
}) {
  const receipt = type === 'receipt';
  const sourceId = receipt ? payment?.id : card.id;
  const identity = {actualUserId:actualUser.id,userId:user.id};
  const [documents, setDocuments] = useState<ArchivedDocument[]>([]);
  const [preferredId, setPreferredId] = useState<string>();
  const [view, setView] = useState<'pdf' | 'preview'>('pdf');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const validApprovalStatus = card.customerApproval?.status === 'approved' || card.customerApproval?.status === 'attested';
  const frozenReview = card.customerApproval && ['waiting', 'id_requested', 'approved', 'attested'].includes(card.customerApproval.status);
  const stage: Exclude<DocumentStage, 'draft'> = card.customerApproval?.status === 'attested' && card.customerApproval.attestedAt ? 'final' : validApprovalStatus && card.customerApproval?.approvedAt ? 'reviewed' : 'preliminary';
  const fullPriceAccess = card.rows.every(showRowPrice);
  const mayGenerate = sourceId !== undefined && fullPriceAccess && (!receipt || showPaymentDetails);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setDocuments([]); setPreferredId(undefined); setNotice('');
    if (sourceId === undefined) { setError('Utbetalningskvittot saknar en registrerad betalning. Utskriftsvyn finns kvar.'); setView('preview'); setLoading(false); return; }
    void documentApi.list(receipt ? 'receipt' : 'settlement', sourceId, identity, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const ordered = documentsNewestFirst(value.documents); setDocuments(ordered);
      const current = receipt ? ordered[0] : frozenReview ? ordered.find(document => document.stage === stage && document.sourceVersion === card.customerApproval?.version) : undefined;
      setPreferredId(current?.id); setView(current ? 'pdf' : 'preview');
    }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Dokumentarkivet kunde inte hämtas.'); setView('preview'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sourceId, receipt, actualUser.id, user.id, stage, card.customerApproval?.version, card.customerApproval?.status, attempt]);
  async function generate() {
    if (!mayGenerate || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = receipt ? await documentApi.receipt(payment!.id, identity) : await documentApi.settlement(card.id, stage, identity);
      setDocuments(previous => [result.document, ...previous.filter(document => document.id !== result.document.id)]);
      setPreferredId(result.document.id); setView('pdf'); setNotice('PDF-filen är arkiverad.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'PDF-filen kunde inte skapas.'); }
    finally { setSaving(false); }
  }
  function printPreview() { setView('preview'); requestAnimationFrame(() => window.print()); }

  return (
    <div
      className="office-document-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={receipt ? 'Utbetalningskvitto' : 'Avräkningsnota'}
    >
      <div className="office-document-actions">
        <button className="office-btn" onClick={() => void generate()} disabled={saving || loading || !mayGenerate}>
          <FileText size={16} /> {saving ? 'Skapar PDF…' : 'Skapa arkiverad PDF'}
        </button>
        <button className="office-btn outline" onClick={printPreview}>
          <Printer size={16} /> Skriv ut förhandsvisning
        </button>
        <button className="office-btn outline" onClick={onClose}>
          <X size={16} />
          Stäng underlag
        </button>
      </div>
      <section className="document-panel">
        <div className="document-toolbar"><div><h2>{receipt ? 'Utbetalningskvitto' : 'Avräkningsnota'} · #{card.id}</h2><span className={`document-stage ${receipt ? 'final' : stage}`}>{receipt ? 'Registrerad utbetalning' : documentStageNames[stage]}</span></div><button className="office-btn outline" onClick={() => setAttempt(value => value + 1)} disabled={loading || saving}><RefreshCw size={15} /> Uppdatera</button></div>
        <nav className="document-tabs" aria-label="Dokumentvy"><button className={view === 'pdf' ? 'active' : ''} onClick={() => setView('pdf')}>PDF & historik{documents.length ? ` (${documents.length})` : ''}</button><button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>Förhandsvisning</button></nav>
        {error && <div className="document-error" role="alert">{error}</div>}
        {notice && <p role="status">{notice}</p>}
        {!fullPriceAccess && <p>PDF med priser kräver behörighet till underlagets priser.</p>}
        {loading && <div className="document-empty" role="status">Hämtar dokumentarkivet…</div>}
        {!loading && view === 'pdf' && <ArchiveViewer documents={documents} identity={identity} preferredId={preferredId} />}
        {view === 'preview' && <p>Förhandsvisning för utskrift. Det arkiverade originalet finns under PDF & historik när en PDF har skapats.</p>}
      </section>
      {view === 'preview' && <article className="office-document">
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
        {validApprovalStatus && card.customerApproval?.approvedAt && <section className="office-document-approval">
          <h2>Kundgodkänd{card.customerApproval.status === 'attested' && card.customerApproval.attestedAt && ' · JEROC-attesterad'}</h2>
          <p>Kundgodkännande med fysisk legitimation · version {card.customerApproval.version}<br />
            Bekräftat av {card.customerApproval.approvedBy} · {new Date(card.customerApproval.approvedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}<br />
            {card.customerApproval.status === 'attested' && card.customerApproval.attestedAt && <>JEROC-attest: {card.customerApproval.attestedBy} · {new Date(card.customerApproval.attestedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' })}</>}
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
            Viktkortets belopp<strong>{fullPriceAccess ? `${money(amount(card))} kr` : '—'}</strong>
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
      </article>}
    </div>
  );
}
