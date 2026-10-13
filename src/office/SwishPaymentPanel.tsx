import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FileText, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react';
import { can, type OfficeCard, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { readDocumentPdf, type ArchivedDocument } from './documents/client';
import { PaymentReadOnly } from './PaymentEditor';
import {
  swishPaymentsApi, swishPaymentRunning, swishBookkeepingRunning, swishFailureMessage,
  swishPaymentStatusNames, swishBookkeepingStatusNames, type SwishPaymentJob,
} from './swish-payments-client';
import './swish-payments.css';

const timestamp = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
export function SwishPaymentDocument({ job, user, actualUser }: { job: SwishPaymentJob; user: OfficeUser; actualUser: OfficeUser }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef<AbortController | null>(null), generation = useRef(0);
  useEffect(() => {
    generation.current += 1; flight.current?.abort(); flight.current = null; setBusy(false); setError('');
    return () => { generation.current += 1; flight.current?.abort(); flight.current = null; };
  }, [job.id, actualUser.id, user.id]);
  const revision = job.documentRevision;
  const document = revision && 'document' in revision ? revision.document : revision;
  const documentId = document?.id;
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
    <div><strong>{pdfVersion ? `Avräkning · PDF-version ${pdfVersion}` : document?.title ?? revision.title ?? 'Ny avräkningsversion med ändrade betalningsuppgifter'}</strong>
      <small>Ersätter föregående PDF vad gäller betalningsuppgifter. Belopp och material är oförändrade. Originalet finns kvar.</small>
      {documentId && <button className="office-text-button" type="button" onClick={() => void download()} disabled={busy}>{busy ? 'Hämtar PDF…' : 'Ladda ner avräkning'}</button>}
      {error && <p role="alert" className="swish-payment-error">{error}</p>}
    </div>
  </div>;
}

export default function SwishPaymentPanel({ card, user, actualUser, onStart, refreshKey = 0 }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; onStart: () => void; refreshKey?: number;
}) {
  const { session, loading: sessionLoading } = useEnvironmentSession();
  const [jobs, setJobs] = useState<SwishPaymentJob[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const flight = useRef<AbortController | null>(null), epoch = useRef(0);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
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
  if (!permitted || !sessionMatches || (!eligible && !jobs.length && card.status !== 'paid')) return null;
  const latest = jobs[0];
  return <section className="swish-payment-panel" aria-label="Swish-utbetalning i testmiljö">
    <div className="swish-payment-panel-heading"><div><span className="swish-payment-test-badge">SWISH · MSS</span></div>
      <button type="button" className="office-text-button" onClick={() => void load(true)} disabled={loading || sessionLoading || !sessionMatches}><RefreshCw size={14} className={loading ? 'swish-payment-spin' : ''} />Uppdatera</button>
    </div>
    <p className="swish-payment-test-note">Testmiljö · inga pengar flyttas. Kortet markeras inte som utbetalt av ett MSS-test.</p>
    {error && <p className="swish-payment-error" role="alert">{error}</p>}
    {loading && !latest && <p className="swish-payment-muted" role="status">Hämtar utbetalningsstatus…</p>}
    {latest ? <>
      <div className={`swish-payment-result is-${latest.status}`} role="status">
        {swishPaymentRunning(latest) ? <LoaderCircle size={18} className="swish-payment-spin" /> : latest.status === 'simulated_paid' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}
        <div><strong>{swishPaymentStatusNames[latest.status]}</strong><small>{timestamp(latest.updatedAt)}</small></div>
      </div>
      <dl className="swish-payment-summary"><div><dt>Testbelopp</dt><dd>{latest.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</dd></div><div><dt>Swish-nummer</dt><dd>{latest.paymentDetails.phone || '–'}</dd></div>
        <div><dt>Mottagare</dt><dd>{latest.paymentDetails.recipient || card.customerSnapshot?.name || '–'}</dd></div>
        <div><dt>Spiris sandbox</dt><dd>{swishBookkeepingStatusNames[latest.bookkeepingStatus]}</dd></div>
        {latest.bookkeepingStatus === 'registered' && latest.bookkeeping?.paymentVoucherNumber && <div><dt>Betalningsverifikation</dt><dd>{latest.bookkeeping.paymentVoucherNumber}</dd></div>}
      </dl>
      {latest.bookkeeping?.reason && latest.bookkeepingStatus !== 'registered' && <p className="swish-payment-muted">{latest.bookkeeping.reason}</p>}
      {swishFailureMessage(latest.error) && <p className="swish-payment-error">{swishFailureMessage(latest.error)}</p>}
      {latest.bookkeeping?.reason && latest.bookkeepingStatus !== 'registered' && <p className="swish-payment-muted">{latest.bookkeeping.reason}</p>}
      {latest.status === 'unknown' && <p className="swish-payment-muted">Resultatet kontrolleras med samma instruktion. Skicka ingen ny utbetalning.</p>}
      <SwishPaymentDocument job={latest} user={user} actualUser={actualUser} />
      <details className="swish-payment-history"><summary>Utbetalningshistorik{jobs.length > 1 ? ` · ${jobs.length} försök` : ''}</summary>
        {jobs.map(job => <div key={job.id}><strong>{swishPaymentStatusNames[job.status]}</strong><small>{timestamp(job.createdAt)} · {job.id}</small>
          {job.reason && <p>Orsak till ändrade betalningsuppgifter: {job.reason}</p>}
          {!!job.events?.length && <ol>{job.events.map((event, index) => <li key={`${event.at ?? ''}/${index}`}><span>{event.text ?? event.message ?? event.type ?? 'Status uppdaterad'}</span>{event.at && <small>{timestamp(event.at)}</small>}</li>)}</ol>}
        </div>)}
      </details>
    </> : !loading && <><PaymentReadOnly value={card.paymentDetails} legacy={card.payment} locked /><p className="swish-payment-muted">Swishs bekräftelse inväntas innan betalningen registreras i Spiris sandbox.</p></>}
    {eligible && <div className="swish-payment-panel-actions"><button type="button" className="office-btn" onClick={onStart} disabled={sessionLoading || !sessionMatches}><Smartphone size={16} />{latest ? 'Visa utbetalning' : 'Betala ut'}</button><small>MSS · inga pengar flyttas</small></div>}
  </section>;
}
