import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpenCheck, CheckCircle2, CircleAlert, FileText, Landmark, LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import { can, type OfficeCard, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { PaymentReadOnly } from './PaymentEditor';
import ElectricFocusBorder from './ElectricFocusBorder';
import { useCardBooking } from './CardBookingContext';
import { spirisBookingStatusNames } from './booking-client';
import { bankBookkeepingRunning, bankBookkeepingStatusNames, bankFailureMessage, bankPaymentRunning, bankPaymentStatusNames, bankPaymentsApi, type BankPaymentJob } from './bank-payments-client';
import { readDocumentPdf, type ArchivedDocument } from './documents/client';
import './bank-payments.css';
import './office-payment-workflow.css';

const time = (value: string) => new Date(value).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', dateStyle: 'short', timeStyle: 'short' });
const emptyJobs: BankPaymentJob[] = [];
export interface CardBankTrackingState {
  jobs: BankPaymentJob[]; loading: boolean; error: string; permitted: boolean; sessionMatches: boolean;
  sessionLoading: boolean; eligible: boolean; load: (manual?: boolean) => Promise<void>;
}
const Context = createContext<CardBankTrackingState>({ jobs: emptyJobs, loading: false, error: '', permitted: false,
  sessionMatches: false, sessionLoading: false, eligible: false, load: () => Promise.resolve() });
export const useCardBankTracking = () => useContext(Context);
interface ReadState { scope: string; jobs: BankPaymentJob[]; loading: boolean; error: string }
const emptyRead = (scope: string): ReadState => ({ scope, jobs: emptyJobs, loading: false, error: '' });

function BankPaymentDocument({ job, user, actualUser }: { job: BankPaymentJob; user: OfficeUser; actualUser: OfficeUser }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), flight = useRef<AbortController | null>(null);
  useEffect(() => { generation.current += 1; flight.current?.abort(); flight.current = null; setBusy(false); setError('');
    return () => { generation.current += 1; flight.current?.abort(); flight.current = null; };
  }, [job.id, user.id, actualUser.id]);
  const revision = job.paymentConfirmationDocument ?? job.documentRevision;
  const record = revision && 'document' in revision ? revision.document : revision && 'id' in revision ? revision as ArchivedDocument : undefined;
  const documentId = record?.id ?? (revision && 'documentId' in revision ? revision.documentId : undefined);
  if (!revision) return null;
  async function download() {
    if (busy || !documentId) return;
    const expected = generation.current, controller = new AbortController(); flight.current = controller; setBusy(true); setError('');
    try {
      const document = { kind: 'settlement', sourceId: job.source?.cardId ?? '', sourceVersion: '', ...record, id: documentId } as ArchivedDocument;
      const result = await readDocumentPdf(document, { actualUserId: actualUser.id, userId: user.id }, controller.signal);
      if (controller.signal.aborted || expected !== generation.current) return;
      const url = URL.createObjectURL(result.blob), anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = result.filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (!controller.signal.aborted && expected === generation.current) setError(failure instanceof Error ? failure.message : 'Avräkningens PDF kunde inte hämtas.'); }
    finally { if (flight.current === controller) flight.current = null; if (expected === generation.current) setBusy(false); }
  }
  return <div className="bank-payment-document"><FileText size={17} /><div><strong>{record?.title ?? (job.paymentConfirmationDocument ? 'Avräkning med bankens testbekräftelse' : 'Avräkning med ändrade mottagaruppgifter')}</strong><small>En ny PDF-version arkiveras. Det attesterade originalet finns kvar.</small>{documentId && <button className="office-text-button" type="button" disabled={busy} onClick={() => void download()}>{busy ? 'Hämtar PDF…' : 'Ladda ner avräkning'}</button>}{error && <p className="bank-payment-error" role="alert">{error}</p>}</div></div>;
}

/** Card/session-scoped GET projection. Reading a card never creates or sends a payment. */
export function CardBankTrackingProvider({ card, user, actualUser, children }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; children: ReactNode;
}) {
  const { session, loading: sessionLoading } = useEnvironmentSession();
  const { reportBankPayment } = useCardBooking();
  const identity = `${actualUser.id}/${user.id}`, permitted = can(user, 'pay') && can(actualUser, 'pay');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const eligible = card.status === 'ready';
  const readAllowed = permitted && sessionMatches && (eligible || card.status === 'paid');
  const scope = JSON.stringify([card.id, card.siteId, card.status, identity, actualUser.level, actualUser.permissions, actualUser.siteIds,
    user.level, user.permissions, user.siteIds, session?.actualUserId, session?.effectiveUserId, session?.csrfToken, session?.expiresAt]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const epoch = useRef(0), flight = useRef<AbortController | null>(null);
  const sessionLoadingRef = useRef(sessionLoading); sessionLoadingRef.current = sessionLoading;
  const [state, setState] = useState<ReadState>(() => emptyRead(scope));
  const jobsRef = useRef({ scope, jobs: emptyJobs });
  const visible = state.scope === scope ? state : emptyRead(scope);
  useEffect(() => { reportBankPayment(visible.jobs[0]); }, [visible.jobs[0], reportBankPayment]);
  const load = useCallback(async (manual = false) => {
    if (!readAllowed || scopeRef.current !== scope || flight.current || manual && sessionLoadingRef.current) return;
    const expected = epoch.current, controller = new AbortController(); flight.current = controller;
    const current = () => expected === epoch.current && scopeRef.current === scope && !controller.signal.aborted;
    const latest = jobsRef.current.scope === scope ? jobsRef.current.jobs[0] : undefined;
    if (manual || !latest) setState(previous => ({ ...(previous.scope === scope ? previous : emptyRead(scope)), loading: true }));
    try {
      if (manual && latest?.kind === 'card' && latest.source?.cardId === card.id) {
        await bankPaymentsApi.refresh(latest.id, controller.signal);
        if (!current()) return;
      }
      const next = await bankPaymentsApi.jobs(card.id, controller.signal);
      if (!current()) return;
      const jobs = next.filter(job => job.kind === 'card' && job.source?.cardId === card.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      jobsRef.current = { scope, jobs }; setState({ scope, jobs, loading: false, error: '' });
    } catch (failure) {
      if (current()) setState(previous => ({ ...(previous.scope === scope ? previous : emptyRead(scope)),
        error: failure instanceof Error ? failure.message : 'Bankens betalstatus kunde inte hämtas.' }));
    } finally {
      if (flight.current === controller) flight.current = null;
      if (current()) setState(previous => ({ ...previous, loading: false }));
    }
  }, [card.id, scope, readAllowed]);
  useEffect(() => {
    epoch.current += 1; flight.current?.abort(); flight.current = null;
    jobsRef.current = { scope, jobs: emptyJobs }; setState(emptyRead(scope)); void load();
    return () => { epoch.current += 1; flight.current?.abort(); flight.current = null; jobsRef.current = { scope, jobs: emptyJobs }; };
  }, [scope, load]);
  useEffect(() => {
    if (!readAllowed) return;
    const changed = (event: Event) => { const value = (event as CustomEvent<{ cardId: number; identity: string }>).detail;
      if (value?.cardId === card.id && value.identity === identity) void load(); };
    window.addEventListener('scrappilot:bank-payment-change', changed);
    return () => window.removeEventListener('scrappilot:bank-payment-change', changed);
  }, [readAllowed, card.id, identity, load]);
  useEffect(() => {
    if (!readAllowed || !visible.jobs.some(job => bankPaymentRunning(job) || bankBookkeepingRunning(job))) return;
    const started = Date.now(), timer = window.setInterval(() => {
      if (Date.now() - started > 120_000) { window.clearInterval(timer); return; }
      if (document.visibilityState === 'visible') void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [readAllowed, visible.jobs[0]?.id, visible.jobs[0]?.status, visible.jobs[0]?.bookkeepingStatus, load]);
  return <Context.Provider value={{ ...visible, permitted, sessionMatches, sessionLoading, eligible, load }}>{children}</Context.Provider>;
}

export default function BankPaymentPanel({ card, user, actualUser, onStart, onReview, refreshKey = 0 }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; onStart: () => void; onReview?: () => void; refreshKey?: number;
}) {
  const bookingState = useCardBooking();
  const { jobs, loading, error, permitted, sessionMatches, sessionLoading, eligible, load } = useCardBankTracking();
  const previousRefresh = useRef(refreshKey);
  useEffect(() => { if (refreshKey > 0 && previousRefresh.current !== refreshKey) void load(); previousRefresh.current = refreshKey; }, [refreshKey, load]);
  if (!bookingState.permitted || !['ready', 'paid', 'balance'].includes(card.status)) return null;
  const latest = jobs[0], booking = bookingState.booking, paid = latest?.status === 'simulated_paid';
  const active = Boolean(latest && (bankPaymentRunning(latest) || latest.status === 'unknown'));
  const actionable = eligible && !paid && !active && (bookingState.canBook || bookingState.canPay);
  const instruction = paid ? 'Bankens testmiljö har bekräftat betalningen. Spiris-registreringen följs separat.'
    : active ? latest?.status === 'awaiting_authorization' ? 'Godkänn den sparade betalningen i testbanken. Samma instruktion följs tills banken bekräftar resultatet.' : 'Inväntar bankens bekräftelse. Ingen ny betalning skickas av statuskontrollen.'
    : booking?.status === 'booked' ? 'Underlaget är bokfört. Granska mottagaren och påbörja banktestet.'
    : booking?.status === 'draft' ? 'Bokför underlaget i Spiris före utbetalningen.' : booking?.reason ?? 'Utbetalningen öppnas när bokföringen i Spiris har bekräftats.';
  return <section id="card-bank-payment" className={`office-panel office-card-payout bank-payment-panel${actionable ? ' office-guidance-focus' : ''}`} aria-label="Bankutbetalning">
    <ElectricFocusBorder active={actionable} />
    <div className="office-payout-heading"><div className="office-payout-title"><Wallet size={25} /><div><h2>Utbetalning</h2><p>{instruction}</p></div></div><span className="bank-payment-test-badge">BANK · SANDBOX</span></div>
    {bookingState.error && <p role="alert" className="bank-payment-error">{bookingState.error}</p>}
    <div className={`office-payout-booking is-${booking?.status ?? 'loading'}`} role="status">
      {bookingState.loading || ['creating_draft', 'booking'].includes(booking?.status ?? '') ? <LoaderCircle size={18} className="bank-payment-spin" /> : booking?.status === 'booked' ? <CheckCircle2 size={18} /> : <FileText size={18} />}
      <div><strong>{booking ? spirisBookingStatusNames[booking.status] : 'Kontrollerar bokföringen i Spiris…'}</strong>{booking?.voucherNumber && <small>Verifikation {booking.voucherNumber}</small>}</div>
      <div className="office-payout-booking-actions">{booking?.status === 'draft' && onReview && <button type="button" className="office-text-button" onClick={onReview}>Granska avräkning</button>}
        {bookingState.canBook && <button className="office-btn outline" type="button" disabled={bookingState.loading} onClick={() => void bookingState.book()}><BookOpenCheck size={16} />Bokför i Spiris</button>}
        <button type="button" className="office-text-button" disabled={bookingState.loading || !sessionMatches || Boolean(booking && !booking.canRefresh)} onClick={() => void bookingState.refresh()}><RefreshCw size={14} />Uppdatera status</button></div>
    </div>
    {permitted && <>{error && <p role="alert" className="bank-payment-error">{error}</p>}{loading && !latest && <p role="status">Hämtar bankens betalstatus…</p>}
      {latest ? <div className="bank-payment-details"><div>
        <div className={`bank-payment-result is-${latest.status}`} role="status">{bankPaymentRunning(latest) ? <LoaderCircle size={18} className="bank-payment-spin" /> : paid ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<div><strong>{bankPaymentStatusNames[latest.status]}</strong><small>{time(latest.updatedAt)}</small></div></div>
        <dl className="bank-payment-summary"><div><dt>Testbelopp</dt><dd>{latest.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</dd></div><div><dt>Mottagare</dt><dd>{latest.paymentDetails.holder || latest.source?.customerName || '–'}</dd></div><div><dt>Spiris</dt><dd>{bankBookkeepingStatusNames[latest.bookkeepingStatus]}</dd></div>{latest.providerPaymentReference && <div><dt>Bankreferens</dt><dd>{latest.providerPaymentReference}</dd></div>}{latest.bookkeeping?.paymentVoucherNumber && <div><dt>Betalningsverifikation</dt><dd>{latest.bookkeeping.paymentVoucherNumber}</dd></div>}</dl>
        {bankFailureMessage(latest.error) && <p className="bank-payment-error">{bankFailureMessage(latest.error)}</p>}
        {latest.bookkeeping?.reason && latest.bookkeepingStatus !== 'registered' && <p className="bank-payment-muted">{latest.bookkeeping.reason}</p>}
      </div><div><PaymentReadOnly value={latest.paymentDetails} locked /><BankPaymentDocument job={latest} user={user} actualUser={actualUser} />
        {paid && latest.paymentDocumentStatus === 'pending' && <p className="bank-payment-muted">Arkiverar PDF med bankens testbekräftelse…</p>}
        {paid && latest.paymentDocumentStatus === 'failed' && <p className="bank-payment-error">Banktestet är genomfört, men PDF-versionen behöver åtgärdas. Betalningen ska inte skickas igen.</p>}
        <details className="bank-payment-history"><summary>Utbetalningshistorik{jobs.length > 1 ? ` · ${jobs.length} försök` : ''}</summary>{jobs.map(job => <div key={job.id}><strong>{bankPaymentStatusNames[job.status]}</strong><small>{time(job.createdAt)}</small>{job.reason && <p>Ändringsorsak: {job.reason}</p>}{job.events?.length ? <ol>{job.events.map((event, index) => <li key={event.id ?? `${event.at}-${index}`}><span>{event.text ?? event.message ?? event.action ?? 'Bankstatus uppdaterad'}</span>{event.at && <small>{time(event.at)}</small>}</li>)}</ol> : null}</div>)}</details>
      </div></div> : !loading && <div className="office-payout-instructions"><PaymentReadOnly value={card.paymentDetails} legacy={card.payment} locked /><p className="bank-payment-muted">Mottagaren granskas i popupen. Ändringar sparas med orsak och historik.</p></div>}
      {eligible && <div className="bank-payment-panel-actions">{latest && <button className="office-text-button" type="button" disabled={loading || sessionLoading || !sessionMatches} onClick={() => void load(true)}><RefreshCw size={14} />Uppdatera betalstatus</button>}
        <button className="office-btn" type="button" onClick={onStart} disabled={sessionLoading || !sessionMatches || !latest && !bookingState.canPay}><Landmark size={16} />{latest ? 'Visa utbetalning' : 'Betala ut'}</button><small>Testmiljö · inga pengar flyttas</small></div>}
    </>}
  </section>;
}
