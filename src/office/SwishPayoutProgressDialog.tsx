import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, CircleAlert, Copy, LoaderCircle, RefreshCw, X } from 'lucide-react';
import {
  swishBookkeepingStatusNames, swishFailureMessage, swishPaymentRunning,
  type SwishPaymentJob,
} from './swish-payments-client';
import './swish-payments.css';

const steps = ['Förbereder utbetalning', 'Skickar till Swish', 'Väntar på bekräftelse', 'Testutbetalning genomförd'];

/** Support information can be copied without disclosing recipients or credentials. */
function sanitizeDiagnostic(value: unknown, key = '', depth = 0): unknown {
  if (/secret|token|authorization|signature|password|certificate|private.?key/i.test(key)) return '[borttaget]';
  if (/personal.?number|personnummer|payee.?ssn|ssn|phone|mobile|alias|clearing|account|iban/i.test(key)) {
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return text ? `••••${text.replace(/\D/g, '').slice(-4)}` : '[maskerat]';
  }
  if (depth > 8) return '[förkortat]';
  if (typeof value === 'string') return value.slice(0, 2000)
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[borttaget]')
    .replace(/Bearer\s+\S+/gi, '[borttaget]')
    .replace(/(?<![\w])\+?\d(?:[ -]?\d){9,15}(?![\w])/g, match => `••••${match.replace(/\D/g, '').slice(-4)}`);
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeDiagnostic(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 50)
    .map(([name, item]) => [name, sanitizeDiagnostic(item, name, depth + 1)]));
  return value;
}

export default function SwishPayoutProgressDialog({ job, preparing = false, uncertain = false, pollPaused = false, busy = false,
  error = '', onClose, onRefresh, onEditRejected, onResume }: {
  job?: SwishPaymentJob; preparing?: boolean; uncertain?: boolean; pollPaused?: boolean; busy?: boolean; error?: string;
  onClose: () => void; onRefresh: () => void; onEditRejected?: () => void; onResume?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), headingId = useId(), descriptionId = useId();
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false);
  const success = job?.status === 'simulated_paid';
  const unknown = !success && (uncertain || job?.status === 'unknown' || pollPaused);
  const running = !unknown && !success && (preparing || Boolean(job && swishPaymentRunning(job)));
  const rejected = job?.status === 'rejected';
  const resumable = job?.status === 'blocked' && job.canResume === true && !error;
  const closeDisabled = preparing && busy && !job && !uncertain;
  const outcome = success ? 'success' : resumable ? 'ready' : unknown ? 'unknown' : running ? 'running' : 'error';
  const activeStep = success ? 3 : !job || job.status === 'queued' || job.status === 'blocked' ? 0 : job.status === 'in_flight' ? 1 : 2;
  const title = success ? 'Testutbetalning genomförd' : resumable ? 'Kontrollen är godkänd' : unknown ? 'Inväntar bekräftelse' : running ? steps[activeStep]
    : rejected ? 'Swish avvisade testutbetalningen' : 'Testutbetalningen kan inte genomföras';
  const description = success ? 'Swish MSS har bekräftat resultatet. Inga riktiga pengar har flyttats.'
    : resumable ? 'Det sparade testet är redo att fortsätta. Ingen utbetalning har skickats av statuskontrollen.'
    : unknown ? 'Slutresultatet är inte bekräftat. Vi kontrollerar samma betalning; ingen ny utbetalning skickas.'
      : preparing ? 'Förbereder testutbetalningen och sparar betalningsinstruktionen.'
        : running ? 'Utbetalningen provas i Swishs testmiljö. Du kan stänga den här rutan och följa resultatet på kortet.'
        : 'Ingen genomförd testutbetalning har bekräftats. Kontrollera uppgifterna och orsaken nedan.';
  const failure = error || (job ? swishFailureMessage(job.error) : '') || (rejected ? 'Swish kunde inte godkänna testutbetalningen.' : 'Testutbetalningen behöver kontrolleras.');
  const diagnostics = useMemo(() => JSON.stringify(sanitizeDiagnostic({
    paymentId: job?.id ?? null, instructionId: job?.providerInstructionUUID ?? null,
    code: typeof job?.error === 'object' ? job.error.code ?? null : null,
    serverStatus: job?.status ?? (uncertain ? 'unknown' : 'preparing'), httpStatus: job?.response?.httpStatus ?? null,
    preflightStatus: job?.preflightStatus ?? null, preflightCheckedAt: job?.preflightCheckedAt ?? null,
    request: job?.request ?? null, response: job?.response?.data ?? null, error: job?.error ?? (error || null),
  }), null, 2), [job, uncertain, error]);

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    if (element) { element.scrollTop = 0; element.focus({ preventScroll: true }); }
    return () => { if (element?.open) element.close(); if (opener?.isConnected && !opener.matches(':disabled')) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setCopied(false); setCopyError(false); }, [diagnostics]);

  async function copyDiagnostics() {
    setCopyError(false);
    try { await navigator.clipboard.writeText(diagnostics); setCopied(true); }
    catch { setCopyError(true); }
  }

  return <dialog ref={dialog} className={`swish-payout-progress-dialog is-${outcome}`} aria-labelledby={headingId} aria-describedby={descriptionId} tabIndex={-1}
    onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }}>
    <button type="button" className="swish-payout-close swish-payout-progress-close" aria-label="Stäng Swish-utbetalning" disabled={closeDisabled} onClick={onClose}><X size={20} /></button>
    <span className="swish-payment-test-badge">SWISH · TESTMILJÖ</span>
    <div className="swish-payout-progress-brand" aria-hidden="true"><span className="swish-payout-progress-ring" /><img src="/images/swish-symbol.svg" alt="" /><strong>Swish</strong>
      <span className="swish-payout-progress-outcome">{success || resumable ? <CheckCircle2 size={25} /> : unknown || !running ? <CircleAlert size={25} /> : <LoaderCircle size={24} />}</span>
    </div>
    <div className="swish-payout-progress-status" role="status" aria-live="polite"><h2 id={headingId}>{title}</h2><p id={descriptionId}>{description}</p></div>
    {job && <div className="swish-payout-progress-amount"><strong>{job.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong><span>{job.paymentDetails.recipient || job.source?.customerName}</span></div>}
    <ol className="swish-payout-progress-steps" aria-label="Utbetalningens steg">{steps.map((step, index) => <li key={step}
      className={index < activeStep || success ? 'is-complete' : index === activeStep ? `is-current${unknown ? ' is-waiting' : ''}` : ''}
      aria-current={index === activeStep ? 'step' : undefined}><span aria-hidden="true">{index < activeStep || success ? <Check size={13} /> : index + 1}</span>{step}</li>)}</ol>
    {!running && !success && <div className={`swish-payout-progress-info ${unknown || resumable ? 'is-waiting' : ''}`} role={unknown || resumable ? 'status' : 'alert'}>{resumable ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<div><strong>{resumable ? 'Fortsätt samma sparade test' : unknown ? 'Kontrollera samma betalning' : 'Varför gick det inte?'}</strong><p>{resumable ? 'Tryck på Fortsätt testutbetalning när du vill starta. Samma belopp, mottagare och instruktion används.' : unknown && !error ? 'Betalningen finns kvar i historiken. Kontrollera status innan du gör något nytt försök.' : failure}</p></div></div>}
    {success && job?.bookkeepingStatus && <div className={`swish-payout-progress-bookkeeping${['failed', 'blocked', 'unknown', 'paused'].includes(job.bookkeepingStatus) ? ' needs-attention' : ''}`}>
      <strong>Registrering i Spiris</strong><p>{swishBookkeepingStatusNames[job.bookkeepingStatus]}</p>
      {['failed', 'blocked', 'unknown', 'paused'].includes(job.bookkeepingStatus) && <small>Swish-testet är genomfört. Endast bokföringen behöver följas upp; betalningen skickas inte igen.</small>}
    </div>}
    <details className="swish-payout-progress-advanced"><summary>Avancerat</summary><p>Maskerad felsökningsinformation att dela med systemadministratören.</p>
      <pre>{diagnostics}</pre><button type="button" className="office-btn outline" onClick={() => void copyDiagnostics()}><Copy size={14} />{copied ? 'Kopierat' : 'Kopiera felsökningsinfo'}</button>
      {copyError && <p role="alert">Kopieringen fungerade inte. Markera och kopiera informationen ovan.</p>}
    </details>
    <div className="swish-payout-progress-actions">
      {resumable && onResume && <button type="button" className="office-btn" disabled={busy} onClick={onResume}>Fortsätt testutbetalning</button>}
      {onEditRejected && !unknown && !running && !success && <button type="button" className="office-btn outline" disabled={busy} onClick={onEditRejected}>Rätta uppgifter och gör nytt test</button>}
      {(unknown || !running || Boolean(error)) && job && <button type="button" className="office-btn outline" disabled={busy} onClick={onRefresh}><RefreshCw size={15} />{busy ? 'Kontrollerar…' : 'Kontrollera status'}</button>}
      {unknown && !job && <button type="button" className="office-btn outline" disabled={busy} onClick={onRefresh}><RefreshCw size={15} />{busy ? 'Kontrollerar…' : 'Kontrollera sparat test'}</button>}
      <button type="button" className="office-btn" disabled={closeDisabled} onClick={onClose}>{success ? 'Klart' : 'Stäng'}</button>
    </div>
  </dialog>;
}
