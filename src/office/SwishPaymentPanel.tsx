import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FileText, LoaderCircle, RefreshCw, Smartphone, Wallet, BookOpenCheck } from 'lucide-react';
import { can, type OfficeCard, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { readDocumentPdf, type ArchivedDocument } from './documents/client';
import { PaymentReadOnly } from './PaymentEditor';
import {
  swishPaymentsApi, swishPaymentRunning, swishBookkeepingRunning, swishFailureMessage,
  swishPaymentStatusNames, swishBookkeepingStatusNames, type SwishPaymentJob,
} from './swish-payments-client';
import './swish-payments.css';
import './office-payment-workflow.css';
import ElectricFocusBorder from './ElectricFocusBorder';
import { useCardBooking } from './CardBookingContext';
import { spirisBookingStatusNames } from './booking-client';

const timestamp = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
export function SwishPaymentDocument({ job, user, actualUser }: { job: SwishPaymentJob; user: OfficeUser; actualUser: OfficeUser }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => {
    generation.current += 1; flight.current?.abort(); flight.current = null; setBusy(false); setError('');
    return () => { generation.current += 1; flight.current?.abort(); flight.current = null; };
  }, [job.id, actualUser.id, user.id]);
  const confirmation = job.paymentConfirmationDocument;
  const revision = confirmation ?? job.documentRevision;
  const document = revision && 'document' in revision ? revision.document : revision && 'id' in revision ? revision as ArchivedDocument : undefined;
  const documentId = document?.id ?? (revision && 'documentId' in revision ? revision.documentId : undefined);
  const documentTitle = document?.title ?? (revision && 'title' in revision ? revision.title : undefined);
  const pdfVersion = revision && 'version' in revision ? revision.version : document && 'pdfVersion' in document ? document.pdfVersion : undefined;
  if (!revision) return null;
  async function download() {
    if (!documentId || busy) return;
    const expected = generation.current, controller = new AbortController(); flight.current = controller;
    setBusy(true); setError('');
    try {
      const record = { kind: 'settlement', sourceId: job.source?.cardId ?? '', sourceVersion: '', ...document, id: documentId } as ArchivedDocument;
      const result = await readDocumentPdf(record, { actualUserId: actualUser.id, userId: user.id }, controller.signal);
      if (controller.signal.aborted || generation.current !== expected) return;
      const url = URL.createObjectURL(result.blob), anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = result.filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!controller.signal.aborted && generation.current === expected) setError(failure instanceof Error ? failure.message : 'PDF-filen kunde inte hämtas.'); }
    finally { if (flight.current === controller) flight.current = null; if (generation.current === expected) setBusy(false); }
  }
  return <div className="swish-payment-document">
    <FileText size={16} aria-hidden="true" />
    <div><strong>{pdfVersion ? `Avräkning · PDF-version ${pdfVersion}` : documentTitle ?? (confirmation ? 'Avräkning med betalningsbekräftelse' : 'Ny avräkningsversion med ändrade betalningsuppgifter')}</strong>
      <small>{confirmation ? 'Senaste PDF-versionen innehåller den bekräftade testutbetalningen. Originalet finns kvar.' : 'Ersätter föregående PDF vad gäller betalningsuppgifter. Belopp och material är oförändrade. Originalet finns kvar.'}</small>
      {documentId && <button className="office-text-button" type="button" onClick={() => void download()} disabled={busy}>{busy ? 'Hämtar PDF…' : 'Ladda ner avräkning'}</button>}
      {error && <p role="alert" className="swish-payment-error">{error}</p>}
    </div>
  </div>;
}

export default function SwishPaymentPanel({ card, user, actualUser, onStart, onReview, refreshKey = 0 }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; onStart: () => void; onReview?: () => void; refreshKey?: number;
}) {
  const bookingState = useCardBooking();
  const { session, loading: sessionLoading } = useEnvironmentSession();
  const [jobs, setJobs] = useState<SwishPaymentJob[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const flight = useRef<AbortController | null>(null), epoch = useRef(0);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const reportPayment = bookingState.reportPayment;
  useEffect(() => { reportPayment(jobs[0]); }, [jobs[0], reportPayment]);
  const identity = `${actualUser.id}/${user.id}`;
  const permitted = can(user, 'pay') && can(actualUser, 'pay');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const eligible = card.status === 'ready';
  const load = useCallback(async (manual = false) => {
    if (!permitted || !sessionMatches || flight.current) return;
    const version = epoch.current, controller = new AbortController(); flight.current = controller;
    if (manual) setLoading(true);
    try {
      if (manual && jobsRef.current[0]) await swishPaymentsApi.refresh(jobsRef.current[0].id, controller.signal);
      const next = await swishPaymentsApi.jobs(card.id, controller.signal);
      if (version !== epoch.current || controller.signal.aborted) return;
      setJobs([...next].sort((left, right) => right.createdAt.localeCompare(left.createdAt))); setError('');
    } catch (failure) {
      if (version === epoch.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Swish-statusen kunde inte hämtas.');
    } finally {
      if (flight.current === controller) flight.current = null;
      if (version === epoch.current) setLoading(false);
    }
  }, [card.id, identity, permitted, sessionMatches]);
  useEffect(() => {
    epoch.current += 1; flight.current?.abort(); flight.current = null;
    setJobs([]); setError(''); setLoading(false);
    if (permitted && sessionMatches && (eligible || card.status === 'paid')) void load(true);
    return () => { epoch.current += 1; flight.current?.abort(); flight.current = null; };
  }, [load, eligible, card.status]);
  useEffect(() => { if (refreshKey > 0) void load(); }, [refreshKey, load]);
  useEffect(() => {
    if (!permitted || !sessionMatches) return;
    const changed = (event: Event) => {
      const value = (event as CustomEvent<{ cardId: number; identity: string }>).detail;
      if (value?.cardId === card.id && value.identity === identity) void load();
    };
    window.addEventListener('scrappilot:payment-change', changed);
    return () => window.removeEventListener('scrappilot:payment-change', changed);
  }, [card.id, identity, permitted, sessionMatches, load]);
  useEffect(() => {
    if (!jobs.some(job => swishPaymentRunning(job) || swishBookkeepingRunning(job))) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 90_000) { window.clearInterval(timer); return; }
      if (document.visibilityState === 'visible') void load();
    }, jobs[0]?.status === 'simulated_paid' ? 15_000 : 4000);
    return () => window.clearInterval(timer);
  }, [jobs[0]?.id, jobs[0]?.status, jobs[0]?.bookkeepingStatus, load]);
  if (!bookingState.permitted || !['ready', 'paid', 'balance'].includes(card.status)) return null;
  const latest = jobs[0], booking = bookingState.booking;
  const paid = latest?.status === 'simulated_paid';
  const paymentActive = Boolean(latest && (swishPaymentRunning(latest) || latest.status === 'unknown'));
  const actionable = eligible && !paid && !paymentActive && (bookingState.canBook || bookingState.canPay);
  const bookingName = booking ? paid && booking.status === 'booked' ? 'Fakturan är bokförd i Spiris' : spirisBookingStatusNames[booking.status] : 'Kontrollerar bokföringen i Spiris…';
  const nextAction = paid
    ? latest.bookkeepingStatus === 'registered' ? 'Testutbetalningen är bekräftad och registrerad i Spiris sandbox.' : 'Testutbetalningen är bekräftad. Registreringen i Spiris hanteras separat; inga pengar skickas igen.'
    : paymentActive ? 'Inväntar Swishs bekräftelse. Den befintliga betalningen kontrolleras utan att skickas igen.'
    : booking?.status === 'booked' ? 'Underlaget är bokfört. Granska mottagaren och påbörja utbetalningen.'
    : booking?.status === 'draft' ? 'Granska utkastet och bokför underlaget i Spiris före utbetalning.'
    : booking?.status === 'booking' || booking?.status === 'creating_draft' ? 'Spiris arbetar i bakgrunden. Utbetalningen öppnas när bokföringen har bekräftats.'
    : booking?.reason ?? 'Utbetalningen öppnas först när bokföringen i Spiris har bekräftats.';
  return <section className={`office-panel office-card-payout swish-payment-panel${actionable ? ' office-guidance-focus' : ''}`} aria-label="Utbetalning">
    <ElectricFocusBorder active={actionable} />
    <div className="office-payout-heading">
      <div className="office-payout-title"><Wallet size={25} aria-hidden="true" /><div><h2>Utbetalning</h2><p>{nextAction}</p></div></div>
      <span className="swish-payment-test-badge">SWISH · MSS · TEST</span>
    </div>
    {bookingState.error && <p className="swish-payment-error" role="alert">{bookingState.error}</p>}
    <div className={`office-payout-booking is-${booking?.status ?? 'loading'}`} role="status">
      {bookingState.loading || ['creating_draft', 'booking'].includes(booking?.status ?? '') ? <LoaderCircle size={18} className="swish-payment-spin" /> : booking?.status === 'booked' ? <CheckCircle2 size={18} /> : <FileText size={18} />}
      <div><strong>{bookingName}</strong>{booking?.voucherNumber && <small>Verifikation {booking.voucherNumber}</small>}
        {booking?.reason && !['booked', 'draft', 'booking', 'creating_draft'].includes(booking.status) && <small>{booking.reason}</small>}</div>
      <div className="office-payout-booking-actions">
        {booking?.status === 'draft' && onReview && <button type="button" className="office-text-button" onClick={onReview}>Granska avräkning</button>}
        {bookingState.canBook && <button type="button" className="office-btn outline" disabled={bookingState.loading} onClick={() => void bookingState.book()}><BookOpenCheck size={16} />Bokför i Spiris</button>}
        <button type="button" className="office-text-button" disabled={bookingState.loading || !sessionMatches || Boolean(booking && !booking.canRefresh)} onClick={() => void bookingState.refresh()}><RefreshCw size={14} className={bookingState.loading ? 'swish-payment-spin' : ''} />Uppdatera status</button>
      </div>
    </div>
    {permitted && <>
    {error && <p className="swish-payment-error" role="alert">{error}</p>}
    {loading && !latest && <p className="swish-payment-muted" role="status">Hämtar utbetalningsstatus…</p>}
    {latest ? <div className="office-payout-details">
      <div>
      <div className={`swish-payment-result is-${latest.status}`} role="status">
        {swishPaymentRunning(latest) ? <LoaderCircle size={18} className="swish-payment-spin" /> : paid ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
        <div><strong>{swishPaymentStatusNames[latest.status]}</strong><small>{timestamp(latest.updatedAt)}</small></div>
      </div>
      <dl className="swish-payment-summary"><div><dt>Testbelopp</dt><dd>{latest.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</dd></div><div><dt>Swish-nummer</dt><dd>{latest.paymentDetails.phone || '–'}</dd></div>
        <div><dt>Mottagare</dt><dd>{latest.paymentDetails.recipient || card.customerSnapshot?.name || '–'}</dd></div>
        <div><dt>Betalningsbokföring</dt><dd>{swishBookkeepingStatusNames[latest.bookkeepingStatus]}</dd></div>
        {latest.bookkeepingStatus === 'registered' && latest.bookkeeping?.paymentVoucherNumber && <div><dt>Betalningsverifikation</dt><dd>{latest.bookkeeping.paymentVoucherNumber}</dd></div>}
      </dl>
      {latest.bookkeeping?.reason && latest.bookkeepingStatus !== 'registered' && <p className="swish-payment-muted">{latest.bookkeeping.reason}</p>}
      {swishFailureMessage(latest.error) && <p className="swish-payment-error">{swishFailureMessage(latest.error)}</p>}
      {latest.status === 'unknown' && <p className="swish-payment-muted">Resultatet kontrolleras med samma instruktion. Skicka ingen ny utbetalning.</p>}
      </div><div>
      <SwishPaymentDocument job={latest} user={user} actualUser={actualUser} />
      {latest.paymentDocumentStatus === 'pending' && paid && <p className="swish-payment-muted">Skapar PDF med betalningsbekräftelsen…</p>}
      {latest.paymentDocumentStatus === 'failed' && paid && <p className="swish-payment-error">Testutbetalningen är bekräftad, men PDF-versionen behöver åtgärdas. Utbetalningen ska inte skickas igen.</p>}
      <details className="swish-payment-history"><summary>Utbetalningshistorik{jobs.length > 1 ? ` · ${jobs.length} försök` : ''}</summary>
        {jobs.map(job => <div key={job.id}><strong>{swishPaymentStatusNames[job.status]}</strong><small>{timestamp(job.createdAt)} · {job.id}</small>
          {job.reason && <p>Orsak till ändrade betalningsuppgifter: {job.reason}</p>}
          {!!job.events?.length && <ol>{job.events.map((event, index) => <li key={`${event.at ?? ''}/${index}`}><span>{event.text ?? event.message ?? event.type ?? 'Status uppdaterad'}</span>{event.at && <small>{timestamp(event.at)}</small>}</li>)}</ol>}
        </div>)}
      </details>
      </div>
    </div> : !loading && <div className="office-payout-instructions"><PaymentReadOnly value={card.paymentDetails} legacy={card.payment} locked /><p className="swish-payment-muted">Mottagaruppgifterna granskas i utbetalningspopupen. Ändringar sparas med orsak och historik.</p></div>}
    {eligible && <div className="swish-payment-panel-actions">
      {latest && <button type="button" className="office-text-button" onClick={() => void load(true)} disabled={loading || sessionLoading || !sessionMatches}><RefreshCw size={14} className={loading ? 'swish-payment-spin' : ''} />Uppdatera betalning</button>}
      <button type="button" className="office-btn" onClick={onStart} disabled={sessionLoading || !sessionMatches || (!latest && !bookingState.canPay)}><Smartphone size={16} />{latest ? 'Visa utbetalning' : 'Betala ut'}</button><small>Testmiljö · inga pengar flyttas</small>
    </div>}
    </>}
  </section>;
}
