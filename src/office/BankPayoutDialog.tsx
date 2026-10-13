import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, CircleAlert, Copy, ExternalLink, Landmark, LoaderCircle, LockKeyhole, Pencil, RefreshCw, X } from 'lucide-react';
import { can, type OfficeCard, type OfficeUser, type PaymentDetails } from './model';
import { EnvironmentApiError } from './environment-client';
import { useEnvironmentSession } from './EnvironmentSession';
import PaymentEditor, { PaymentReadOnly } from './PaymentEditor';
import { bankRecipientError, normalizePaymentDetails } from '../data-format';
import { bankAuthorisationLink, bankBookkeepingRunning, bankBookkeepingStatusNames, bankDiagnostic, bankFailureMessage, bankPaymentChanged,
  bankPaymentRunning, bankPaymentStatusNames, bankPaymentsApi, type BankPaymentJob, type BankPaymentPreparation } from './bank-payments-client';
import './bank-payments.css';

function comparable(value?: PaymentDetails) {
  if (!value) return '';
  const normalized = normalizePaymentDetails(value);
  return JSON.stringify(Object.fromEntries(['method', 'bankType', 'bank', 'clearing', 'account', 'holder', 'bankgiro', 'plusgiro', 'iban', 'bic', 'bankCountry', 'beneficiaryAddress', 'ocr']
    .filter(key => normalized[key as keyof PaymentDetails] !== undefined && normalized[key as keyof PaymentDetails] !== '' && !(key === 'bankType' && normalized.bankType === 'account'))
    .map(key => [key, normalized[key as keyof PaymentDetails]])));
}

export default function BankPayoutDialog({ card, user, actualUser, open, onClose, onNotice, onChanged, methodSelector }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; open: boolean; onClose: () => void;
  onNotice?: (message: string) => void; onChanged?: () => void; methodSelector?: ReactNode;
}) {
  const { session, loading: sessionLoading } = useEnvironmentSession();
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), description = useId();
  const [preparation, setPreparation] = useState<BankPaymentPreparation>(), [details, setDetails] = useState<PaymentDetails>();
  const [job, setJob] = useState<BankPaymentJob>(), [reason, setReason] = useState(''), [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false), [submitting, setSubmitting] = useState(false), [pollPaused, setPollPaused] = useState(false);
  const [retryOf, setRetryOf] = useState<string>(), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false);
  const permitted = can(user, 'pay') && can(actualUser, 'pay');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const scope = JSON.stringify([open, card.id, card.siteId, actualUser.id, user.id, actualUser.level, actualUser.permissions, actualUser.siteIds,
    user.level, user.permissions, user.siteIds, session?.csrfToken, session?.expiresAt]);
  const [stateScope, setStateScope] = useState(scope);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const generation = useRef(0), mutation = useRef(false), flight = useRef<AbortController | null>(null);
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  const jobRef = useRef(job); jobRef.current = job;
  const current = stateScope === scope;
  const publish = useCallback((value: BankPaymentJob) => {
    if (value.kind !== 'card' || value.source?.cardId !== card.id) throw new Error('Bankens betalstatus hör inte till det här kortet.');
    const previous = jobRef.current; jobRef.current = value;
    setJob(value); setUncertain(false); setError('');
    if (!previous || previous.id !== value.id || previous.updatedAt !== value.updatedAt || previous.status !== value.status || previous.bookkeepingStatus !== value.bookkeepingStatus) {
      bankPaymentChanged(card.id, actualUser.id, user.id); onChangedRef.current?.();
    }
  }, [card.id, actualUser.id, user.id]);

  useEffect(() => {
    generation.current += 1; const expected = generation.current;
    flight.current?.abort(); flight.current = null; mutation.current = false;
    setStateScope(scope); setPreparation(undefined); setDetails(undefined); setJob(undefined); jobRef.current = undefined;
    setReason(''); setEditing(false); setLoading(false); setBusy(false); setError('');
    setUncertain(false); setSubmitting(false); setPollPaused(false); setRetryOf(undefined); setCopied(false); setCopyError(false);
    if (!open || !permitted || !sessionMatches) return;
    const controller = new AbortController(); flight.current = controller; setLoading(true);
    void bankPaymentsApi.prepare(card.id, controller.signal).then(value => {
      if (controller.signal.aborted || expected !== generation.current || scopeRef.current !== scope) return;
      if (value.cardId !== card.id || value.source?.cardId !== card.id || value.existingJob && value.existingJob.source?.cardId !== card.id)
        throw new Error('Utbetalningsuppgifterna hör inte till det här kortet.');
      setPreparation(value); setDetails(value.paymentDetails);
      if (value.existingJob) { jobRef.current = value.existingJob; setJob(value.existingJob); }
    }).catch(failure => {
      if (!controller.signal.aborted && expected === generation.current) setError(failure instanceof Error ? failure.message : 'Bankuppgifterna kunde inte hämtas.');
    }).finally(() => { if (flight.current === controller) flight.current = null; if (expected === generation.current) setLoading(false); });
    return () => { generation.current += 1; controller.abort(); };
  }, [scope, open, card.id, permitted, sessionMatches]);

  useEffect(() => {
    if (!open || !permitted) return;
    const element = dialog.current, opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    if (element) { element.scrollTop = 0; element.focus({ preventScroll: true }); }
    return () => { if (element?.open) element.close(); if (opener?.isConnected && !opener.matches(':disabled')) opener.focus({ preventScroll: true }); };
  }, [open, permitted]);

  useEffect(() => {
    if (!open || !current || !job || !(bankPaymentRunning(job) || bankBookkeepingRunning(job)) || pollPaused || !permitted || !sessionMatches) return;
    const expected = generation.current, controller = new AbortController(), started = Date.now();
    let timer: number;
    const read = async () => {
      if (controller.signal.aborted || expected !== generation.current || scopeRef.current !== scope) return;
      try {
        const next = await bankPaymentsApi.job(job.id, controller.signal);
        if (controller.signal.aborted || expected !== generation.current || scopeRef.current !== scope) return;
        publish(next);
        if (!(bankPaymentRunning(next) || bankBookkeepingRunning(next))) return;
      } catch (failure) { if (!controller.signal.aborted && expected === generation.current) setError(failure instanceof Error ? failure.message : 'Bankens slutstatus kunde inte hämtas.'); }
      if (controller.signal.aborted) return;
      if (Date.now() - started > 120_000) { setPollPaused(true); return; }
      timer = window.setTimeout(() => void read(), 3000);
    };
    timer = window.setTimeout(() => void read(), 1000);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [scope, open, current, job?.id, job?.status, job?.bookkeepingStatus, pollPaused, permitted, sessionMatches, publish]);

  async function action(kind: 'refresh' | 'authorise' | 'resume') {
    if (mutation.current || busy || !permitted || !sessionMatches || !current) return;
    const expected = generation.current, requestedScope = scope;
    mutation.current = true; setBusy(true); setError('');
    try {
      if (job) {
        if (kind === 'authorise' && !job.canAuthorise || kind === 'resume' && !job.canResume) return;
        const next = await bankPaymentsApi[kind](job.id);
        if (expected !== generation.current || scopeRef.current !== requestedScope) return;
        publish(next); setPollPaused(false);
      } else {
        const value = await bankPaymentsApi.prepare(card.id);
        if (expected !== generation.current || scopeRef.current !== requestedScope) return;
        if (value.existingJob) publish(value.existingJob);
        else setError('Ingen sparad betalning kunde bekräftas ännu. Kontrollera igen innan du försöker starta en ny.');
      }
    } catch (failure) {
      if (expected === generation.current && scopeRef.current === requestedScope) setError(failure instanceof Error ? failure.message : 'Bankens betalstatus kunde inte kontrolleras.');
    } finally { if (expected === generation.current) { mutation.current = false; setBusy(false); } }
  }

  const changed = Boolean(preparation && comparable(details) !== comparable(preparation.originalPaymentDetails));
  const recipientError = details?.method === 'bank' ? bankRecipientError(details) : 'Välj Banköverföring för banktestet.';
  const ready = Boolean(current && preparation && (preparation.canInitiate ?? preparation.canStart) && preparation.settings.enabled && preparation.configuration.ready && details?.method === 'bank' && !recipientError && (!changed || reason.trim()));
  async function start() {
    if (mutation.current || busy || uncertain || !ready || !preparation || !details || !permitted || !sessionMatches) return;
    const expected = generation.current, requestedScope = scope;
    mutation.current = true; setBusy(true); setSubmitting(true); setEditing(false); setError('');
    try {
      const next = await bankPaymentsApi.start({ cardId: card.id,
        source: { approvalId: preparation.source.approvalId, version: preparation.source.version, hash: preparation.source.hash },
        paymentDetails: normalizePaymentDetails(details), ...(changed ? { reason: reason.trim() } : {}), ...(retryOf ? { retryOf } : {}) });
      if (expected !== generation.current || scopeRef.current !== requestedScope) return;
      publish(next); onNotice?.('Banktestet är sparat. Följ godkännandet och bankens slutstatus.');
    } catch (failure) {
      if (expected !== generation.current || scopeRef.current !== requestedScope) return;
      if (!(failure instanceof EnvironmentApiError) || failure.status >= 500) {
        setUncertain(true); setError('Serverns svar kunde inte hämtas. Betalningen kan ha sparats. Kontrollera den sparade instruktionen innan du försöker igen.');
      } else setError(failure.message);
    } finally { if (expected === generation.current) { mutation.current = false; setBusy(false); setSubmitting(false); } }
  }

  async function editRejected() {
    if (busy || mutation.current || !current || !job || !['failed', 'rejected'].includes(job.status) || !sessionMatches || !permitted) return;
    const expected = generation.current, previous = job; setBusy(true); setError('');
    try {
      const value = await bankPaymentsApi.prepare(card.id);
      if (expected !== generation.current || scopeRef.current !== scope) return;
      if (value.existingJob && !['failed', 'rejected'].includes(value.existingJob.status)) { publish(value.existingJob); return; }
      setPreparation(value); setDetails(previous.paymentDetails); setRetryOf(previous.id); setReason(previous.reason ?? '');
      setJob(undefined); jobRef.current = undefined; setEditing(false); setUncertain(false); setPollPaused(false);
    } catch (failure) { if (expected === generation.current) setError(failure instanceof Error ? failure.message : 'Ett nytt banktest kunde inte förberedas.'); }
    finally { if (expected === generation.current) setBusy(false); }
  }

  if (!open || !permitted) return null;
  const visibleJob = current && sessionMatches ? job : undefined;
  const progress = current && sessionMatches && Boolean(job || submitting || uncertain);
  const success = visibleJob?.status === 'simulated_paid', unknown = !success && (uncertain || visibleJob?.status === 'unknown' || pollPaused);
  const running = !unknown && !success && (submitting || Boolean(visibleJob && bankPaymentRunning(visibleJob)));
  const signLink = visibleJob?.status === 'awaiting_authorization' ? bankAuthorisationLink(visibleJob.authorisationUrl) : undefined;
  const steps = ['Förbereder banktest', 'Godkännande i testbanken', 'Inväntar bankens bekräftelse', 'Testutbetalning genomförd'];
  const activeStep = success ? 3 : !visibleJob || visibleJob.status === 'queued' || visibleJob.status === 'in_flight' || visibleJob.status === 'blocked' ? 0 : visibleJob.status === 'awaiting_authorization' ? 1 : 2;
  const closeDisabled = busy && submitting && !visibleJob && !uncertain;
  const diagnostics = JSON.stringify(bankDiagnostic({ paymentId: visibleJob?.id ?? null, instructionId: visibleJob?.providerPaymentId ?? null,
    status: visibleJob?.status ?? (uncertain ? 'unknown' : 'preparing'), code: visibleJob?.error && typeof visibleJob.error === 'object' ? visibleJob.error.code ?? null : null,
    request: visibleJob?.request ?? null, response: visibleJob?.response ?? null, error: visibleJob?.error ?? (error || null) }), null, 2);
  return <dialog ref={dialog} className={`bank-payout-dialog${progress ? ` bank-payout-progress is-${success ? 'success' : unknown ? 'unknown' : running ? 'running' : 'error'}` : ''}`}
    aria-labelledby={heading} aria-describedby={description} tabIndex={-1} onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }}>
    <div className="bank-payout-heading"><div><span className="bank-payment-test-badge">OPEN PAYMENTS · SANDBOX</span>{!progress && <><h2 id={heading}>Betala ut via bank</h2><p id={description}>Testmiljö · inga pengar flyttas.</p></>}</div><button type="button" className="bank-payout-close" aria-label="Stäng bankutbetalning" disabled={closeDisabled} onClick={onClose}><X size={20} /></button></div>
    {!progress && methodSelector}
    {progress ? <>
      <div className="bank-payout-brand" aria-hidden="true"><Landmark size={50} />{running && <span className="bank-payout-brand-orbit" />}{success && <CheckCircle2 size={24} />}</div>
      <div className="bank-payout-status" role="status" aria-live="polite"><h2 id={heading}>{success ? 'Testutbetalning genomförd' : unknown ? 'Inväntar säker bekräftelse' : visibleJob ? bankPaymentStatusNames[visibleJob.status] : 'Förbereder banktest'}</h2><p id={description}>{success ? 'Bankens sandbox har bekräftat slutstatus. Inga riktiga pengar har flyttats.' : unknown ? 'Slutresultatet är inte bekräftat. Kontrollera samma instruktion; starta ingen ny betalning.' : running ? 'Den sparade instruktionen följs i bankens testmiljö. Du kan stänga rutan och följa resultatet på kortet.' : 'Ingen genomförd testutbetalning har bekräftats.'}</p></div>
      {visibleJob && <div className="bank-payout-amount"><strong>{visibleJob.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong><span>{visibleJob.paymentDetails.holder || visibleJob.source?.customerName}</span></div>}
      <ol className="bank-payout-steps" aria-label="Banktestets steg">{steps.map((step, index) => <li key={step} className={success || index < activeStep ? 'is-complete' : index === activeStep ? 'is-current' : ''} aria-current={index === activeStep ? 'step' : undefined}><span aria-hidden="true">{success || index < activeStep ? <Check size={13} /> : index + 1}</span>{step}</li>)}</ol>
      {visibleJob?.status === 'awaiting_authorization' && <div className="bank-payout-sign"><strong>Godkänn i testbanken</strong><p>Bankens godkännande krävs innan slutresultatet kan bekräftas.</p>{signLink ? <a className="office-btn" href={signLink} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Öppna testbankens godkännande</a> : visibleJob.canAuthorise ? <button className="office-btn" type="button" disabled={busy} onClick={() => void action('authorise')}>{busy ? 'Förbereder godkännandet…' : 'Förbered bankens godkännande'}</button> : <small>Kontrollera betalstatus för att hämta nästa steg. Ingen ny betalning skickas.</small>}</div>}
      {(error || !running && !success) && <div className="bank-payout-warning" role="alert"><CircleAlert size={18} /><div><strong>{unknown ? 'Kontrollera samma instruktion' : 'Varför gick det inte?'}</strong><p>{error || bankFailureMessage(visibleJob?.error) || 'Banktestet behöver kontrolleras.'}</p></div></div>}
      {success && visibleJob && <div className="bank-payout-sign"><strong>Registrering i Spiris</strong><p>{bankBookkeepingStatusNames[visibleJob.bookkeepingStatus]}</p>{!['registered', 'not_requested'].includes(visibleJob.bookkeepingStatus) && <small>Banktestet är genomfört. Betalningen skickas inte igen när bokföringen följs upp.</small>}</div>}
      <details className="bank-payout-advanced"><summary>Avancerat</summary><p>Maskerad felsökningsinformation att dela med systemadministratören.</p><pre>{diagnostics}</pre><button className="office-btn outline" type="button" onClick={() => {
        void navigator.clipboard.writeText(diagnostics).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true));
      }}><Copy size={14} />{copied ? 'Kopierat' : 'Kopiera felsökningsinfo'}</button>{copyError && <p role="alert">Kopiera informationen manuellt om urklipp inte är tillgängligt.</p>}</details>
      <div className="bank-payout-actions">{visibleJob?.canResume && <button className="office-btn" type="button" disabled={busy} onClick={() => void action('resume')}>Fortsätt samma banktest</button>}{visibleJob && ['rejected', 'failed'].includes(visibleJob.status) && <button className="office-btn outline" type="button" disabled={busy} onClick={() => void editRejected()}>Rätta uppgifter och gör nytt test</button>}<button className="office-btn outline" type="button" disabled={busy} onClick={() => void action('refresh')}><RefreshCw size={15} />{busy ? 'Kontrollerar…' : visibleJob ? 'Uppdatera betalstatus' : 'Kontrollera sparad instruktion'}</button><button className="office-btn" type="button" disabled={closeDisabled} onClick={onClose}>{success ? 'Klart' : 'Stäng'}</button></div>
    </> : <>
      {(!current || loading || sessionLoading) && <p role="status" className="bank-payment-muted"><LoaderCircle size={18} className="bank-payment-spin" />Hämtar det attesterade underlaget…</p>}
      {!sessionLoading && !sessionMatches && <p className="bank-payment-error" role="alert">En giltig inloggning behövs för att hämta utbetalningsuppgifterna.</p>}
      {current && sessionMatches && preparation && <><div className="bank-payout-frozen"><div><span>Attesterat belopp <LockKeyhole size={13} /></span><strong>{preparation.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong></div><div><span>Mottagare</span><strong>{preparation.customer.name}</strong><small>{preparation.customer.type} · {preparation.customer.number}</small></div></div>
        <div className="bank-payout-details-heading"><strong>{editing ? 'Redigerar mottagaruppgifter' : 'Låsta mottagaruppgifter'} {!editing && <LockKeyhole size={13} />}</strong>{editing ? <div><button className="office-text-button" type="button" disabled={busy} onClick={() => { setDetails(preparation.paymentDetails); setReason(''); setEditing(false); }}>Avbryt redigering</button><button className="office-btn outline" type="button" disabled={busy} onClick={() => setEditing(false)}><Check size={14} />Klar</button></div> : <button className="office-btn outline" type="button" disabled={busy} onClick={() => setEditing(true)}><Pencil size={14} />Redigera</button>}</div>
        <fieldset className="bank-payout-fields" disabled={busy}>{editing ? <PaymentEditor value={details} customerName={preparation.customer.name} bankOnly hideSaveAction onSave={() => false} onDraftChange={setDetails} /> : <PaymentReadOnly value={details} locked />}
          {details?.method !== 'bank' && <p className="bank-payout-warning"><CircleAlert size={16} />Välj Banköverföring för banktestet. Stäng rutan för att starta ett annat betalsätt.</p>}
          {changed && (editing ? <label className="bank-payout-reason">Orsak till ändrade betalningsuppgifter<textarea aria-label="Orsak till ändrade betalningsuppgifter" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={2} required /><small>Belopp, material och attesterat original är låsta. Ändringen sparas med historik och en ny PDF-version.</small></label> : <div className="bank-payout-reason"><strong>Ändringsorsak</strong><p>{reason || 'Ange en orsak via Redigera före utbetalningen.'}</p></div>)}
        </fieldset>
        {preparation.issues.length > 0 && <div className="bank-payout-warning" role="status"><CircleAlert size={18} /><div>{preparation.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div></div>}
      </>}
      {current && error && <p className="bank-payment-error" role="alert">{error}</p>}
      <div className="bank-payout-actions"><button className="office-btn outline" type="button" disabled={busy} onClick={onClose}>Avbryt</button><button className="office-btn" type="button" disabled={!ready || busy || loading || sessionLoading || !sessionMatches} onClick={() => void start()}><Landmark size={16} />Testa bankutbetalning</button></div>
    </>}
  </dialog>;
}
