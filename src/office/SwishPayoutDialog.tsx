import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, LockKeyhole, Pencil, Smartphone, X } from 'lucide-react';
import { can, type OfficeCard, type OfficeUser, type PaymentDetails } from './model';
import { EnvironmentApiError } from './environment-client';
import { useEnvironmentSession } from './EnvironmentSession';
import PaymentEditor from './PaymentEditor';
import SwishPayoutProgressDialog from './SwishPayoutProgressDialog';
import { normalizePhoneNumber } from '../data-format';
import {
  swishPaymentsApi, swishPaymentChanged, swishPaymentRunning, swishBookkeepingRunning,
  type SwishPaymentDetails, type SwishPaymentJob, type SwishPaymentPreparation,
} from './swish-payments-client';
import './swish-payments.css';

function comparable(value?: PaymentDetails) {
  if (!value) return '';
  if (value.method === 'swish') return JSON.stringify({ method: value.method, phone: normalizePhoneNumber(value.phone ?? '', { swish: true }), recipient: value.recipient?.trim() ?? '' });
  if (value.method === 'bank') return JSON.stringify({ method: value.method, bank: value.bank?.trim() ?? '', clearing: value.clearing?.replace(/[\s-]/g, '') ?? '', account: value.account?.replace(/[\s-]/g, '') ?? '', holder: value.holder?.trim() ?? '' });
  return value.method;
}
export default function SwishPayoutDialog({ card, user, actualUser, open, onClose, onNotice, onChanged }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; open: boolean; onClose: () => void;
  onNotice?: (message: string) => void; onChanged?: () => void;
}) {
  const { session, loading: sessionLoading } = useEnvironmentSession();
  const dialog = useRef<HTMLDialogElement>(null), heading = useId(), description = useId();
  const [preparation, setPreparation] = useState<SwishPaymentPreparation>(), [details, setDetails] = useState<SwishPaymentDetails>();
  const [reason, setReason] = useState(''), [job, setJob] = useState<SwishPaymentJob>();
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false), [pollPaused, setPollPaused] = useState(false);
  const [editing, setEditing] = useState(false), [submitting, setSubmitting] = useState(false), [baselineReason, setBaselineReason] = useState('');
  const [retryOf, setRetryOf] = useState<string>();
  const flight = useRef<AbortController | null>(null), mutationInFlight = useRef(false), generation = useRef(0);
  const identity = `${actualUser.id}/${user.id}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  const jobRef = useRef<SwishPaymentJob | undefined>(job); jobRef.current = job;
  const permitted = can(user, 'pay') && can(actualUser, 'pay');
  const sessionMatches = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const publish = useCallback((next: SwishPaymentJob) => {
    const previous = jobRef.current;
    jobRef.current = next;
    setJob(next); setUncertain(false); setError('');
    if (!previous || previous.id !== next.id || previous.updatedAt !== next.updatedAt || previous.status !== next.status || previous.bookkeepingStatus !== next.bookkeepingStatus) {
      swishPaymentChanged(card.id, actualUser.id, user.id); onChangedRef.current?.();
    }
  }, [card.id, actualUser.id, user.id]);

  useEffect(() => {
    generation.current += 1; const expected = generation.current;
    flight.current?.abort(); flight.current = null;
    setPreparation(undefined); setDetails(undefined); setReason(''); setJob(undefined); setError('');
    setUncertain(false); setPollPaused(false); setBusy(false); setRetryOf(undefined); mutationInFlight.current = false;
    setEditing(false); setSubmitting(false); setBaselineReason('');
    if (!open || !permitted || !sessionMatches) { setLoading(false); return; }
    const controller = new AbortController(); flight.current = controller; setLoading(true);
    void swishPaymentsApi.prepare(card.id, controller.signal).then(value => {
      if (controller.signal.aborted || generation.current !== expected) return;
      setPreparation(value); setDetails(value.paymentDetails);
      if (value.existingJob) setJob(value.existingJob);
    }).catch(failure => {
      if (!controller.signal.aborted && generation.current === expected) setError(failure instanceof Error ? failure.message : 'Utbetalningsuppgifterna kunde inte hämtas.');
    }).finally(() => {
      if (flight.current === controller) flight.current = null;
      if (generation.current === expected) setLoading(false);
    });
    return () => { generation.current += 1; controller.abort(); };
  }, [open, card.id, identity, permitted, sessionMatches]);

  useEffect(() => {
    if (!open || !permitted || job || submitting || uncertain) return;
    const element = dialog.current, opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element && !element.open) element.showModal();
    if (element) element.scrollTop = 0;
    return () => { if (element?.open) element.close(); if (opener?.isConnected && !opener.matches(':disabled')) opener.focus({ preventScroll: true }); };
  }, [open, permitted, Boolean(job), submitting, uncertain]);

  useEffect(() => {
    if (!open || !job || !(swishPaymentRunning(job) || swishBookkeepingRunning(job)) || pollPaused || !sessionMatches || !permitted) return;
    const expected = generation.current, started = Date.now(), controller = new AbortController();
    let timer: number, reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted || generation.current !== expected) return;
      reading = true;
      try {
        const next = await swishPaymentsApi.job(job.id, controller.signal);
        if (controller.signal.aborted || generation.current !== expected) return;
        publish(next);
        if (!(swishPaymentRunning(next) || swishBookkeepingRunning(next))) return;
      } catch (failure) {
        if (controller.signal.aborted || generation.current !== expected) return;
        setError(failure instanceof Error ? failure.message : 'Slutstatus kunde inte hämtas. Det sparade testet finns kvar.');
      } finally { reading = false; }
      if (controller.signal.aborted) return;
      if (Date.now() - started > 90_000) { setPollPaused(true); return; }
      timer = window.setTimeout(() => void read(), 2000);
    };
    timer = window.setTimeout(() => void read(), 700);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, job?.id, job?.status, job?.bookkeepingStatus, pollPaused, sessionMatches, permitted, publish]);

  async function recover() {
    if (busy || !sessionMatches || !permitted) return;
    const expected = generation.current, expectedIdentity = identityRef.current;
    setBusy(true); setError('');
    try {
      if (job) {
        const next = await swishPaymentsApi.refresh(job.id);
        if (generation.current === expected && identityRef.current === expectedIdentity) { publish(next); setPollPaused(false); }
      } else {
        const value = await swishPaymentsApi.prepare(card.id);
        if (generation.current !== expected || identityRef.current !== expectedIdentity) return;
        if (value.existingJob) publish(value.existingJob);
        else setError('Ingen sparad instruktion kunde bekräftas ännu. Kontrollera historiken igen innan ett nytt försök.');
      }
    } catch (failure) {
      if (generation.current === expected && identityRef.current === expectedIdentity) setError(failure instanceof Error ? failure.message : 'Testets status kunde inte kontrolleras.');
    } finally { if (generation.current === expected) setBusy(false); }
  }
  async function editRejected() {
    if (busy || !job || !['rejected', 'failed'].includes(job.status) || !sessionMatches || !permitted) return;
    const expected = generation.current, previous = job;
    setBusy(true); setError('');
    try {
      const value = await swishPaymentsApi.prepare(card.id);
      if (generation.current !== expected) return;
      if (value.existingJob && !['rejected', 'failed'].includes(value.existingJob.status)) { publish(value.existingJob); return; }
      const nextDetails = { ...previous.paymentDetails, personalNumber: value.customer.number };
      setPreparation({ ...value, paymentDetails: nextDetails }); setDetails(nextDetails);
      setReason(previous.reason ?? ''); setBaselineReason(previous.reason ?? ''); setEditing(false);
      setRetryOf(previous.id); setJob(undefined); setUncertain(false); setPollPaused(false);
    } catch (failure) {
      if (generation.current === expected) setError(failure instanceof Error ? failure.message : 'Underlaget kunde inte hämtas för ett nytt test.');
    } finally { if (generation.current === expected) setBusy(false); }
  }
  async function resume() {
    if (mutationInFlight.current || busy || !job?.canResume || !sessionMatches || !permitted) return;
    const expected = generation.current, expectedIdentity = identityRef.current;
    mutationInFlight.current = true; setBusy(true); setError('');
    try {
      const next = await swishPaymentsApi.resume(job.id);
      if (generation.current !== expected || identityRef.current !== expectedIdentity) return;
      publish(next); setPollPaused(false);
      onNotice?.('Samma sparade Swish-test fortsätter. Ingen ny betalningsinstruktion skapas.');
    } catch (failure) {
      if (generation.current === expected && identityRef.current === expectedIdentity)
        setError(failure instanceof Error ? failure.message : 'Det sparade testet kunde inte fortsätta. Kontrollera status igen.');
    } finally {
      if (generation.current === expected) { mutationInFlight.current = false; setBusy(false); }
    }
  }
  const changed = Boolean(preparation && comparable(details) !== comparable(preparation.originalPaymentDetails));
  const isPrivate = preparation?.customer.type === 'Privatperson';
  const swishNumber = normalizePhoneNumber(details?.phone ?? '', { swish: true });
  const phoneValid = /^\+467[02369]\d{7}$/.test(swishNumber) || preparation?.mode === 'mss' && swishNumber === '+46711111132';
  const methodSupported = details?.method === 'swish';
  const ready = Boolean(preparation && preparation.canInitiate !== false && methodSupported && phoneValid && details?.recipient?.trim() && isPrivate && (!changed || reason.trim()) && preparation.settings.enabled && preparation.configuration.ready);

  async function start() {
    if (mutationInFlight.current || busy || uncertain || !preparation || !details || !sessionMatches || !permitted) return;
    if (preparation.canInitiate === false) { setError(preparation.issues.join(' ') || 'Underlaget behöver kontrolleras före utbetalning.'); return; }
    if (!methodSupported) { setError('Den här etappen stöder bara Swishs testmiljö. Bank, kontant och saldo ändrar inget underlag här.'); return; }
    if (!isPrivate) { setError('Swish Utbetalning gäller privatpersoner. Företag behöver bankutbetalning.'); return; }
    if (!phoneValid) { setError('Ange mottagarens svenska mobilnummer för Swish.'); return; }
    if (!details.recipient?.trim()) { setError('Ange mottagarens namn.'); return; }
    if (changed && !reason.trim()) { setError('Ange en orsak till ändrade betalningsuppgifter.'); return; }
    const expected = generation.current, expectedIdentity = identityRef.current;
    mutationInFlight.current = true; setBusy(true); setSubmitting(true); setEditing(false); setError('');
    try {
      const next = await swishPaymentsApi.start({ cardId: card.id,
        source: { approvalId: preparation.source.approvalId, version: preparation.source.version, hash: preparation.source.hash },
        paymentDetails: { ...details, phone: swishNumber, recipient: details.recipient.trim(), personalNumber: preparation.paymentDetails.personalNumber ?? preparation.customer.number },
        ...(changed ? { reason: reason.trim() } : {}),
        ...(retryOf ? { retryOf } : {}),
      });
      if (generation.current !== expected || identityRef.current !== expectedIdentity) return;
      publish(next);
      onNotice?.('Swish-testet är sparat. Inväntar simulatorns bekräftelse.');
    } catch (failure) {
      if (generation.current !== expected || identityRef.current !== expectedIdentity) return;
      if (!(failure instanceof EnvironmentApiError) || failure.status >= 500) {
        setUncertain(true);
        setError('Serverns bekräftelse kunde inte hämtas. Testet kan ha sparats. Kontrollera historiken innan du gör något nytt försök.');
      } else setError(failure.message);
    } finally { if (generation.current === expected) { mutationInFlight.current = false; setBusy(false); setSubmitting(false); } }
  }

  function cancelEditing() {
    if (!preparation || busy || uncertain) return;
    setDetails({ ...preparation.paymentDetails }); setReason(baselineReason); setEditing(false); setError('');
  }

  if (!open || !permitted) return null;
  if ((job || submitting || uncertain) && sessionMatches) {
    return <SwishPayoutProgressDialog job={job} preparing={submitting && !job} uncertain={uncertain} pollPaused={pollPaused}
      busy={busy} error={error} onClose={onClose} onRefresh={() => void recover()}
      onResume={() => void resume()}
      onEditRejected={job && ['rejected', 'failed'].includes(job.status) ? () => void editRejected() : undefined} />;
  }
  return <dialog ref={dialog} className="swish-payout-dialog" aria-labelledby={heading} aria-describedby={description}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="swish-payout-heading"><div><span className="swish-payment-test-badge">SWISH · MSS</span><h2 id={heading}>Betala ut</h2><p id={description}>Testmiljö · inga pengar flyttas.</p></div>
      <button type="button" className="swish-payout-close" aria-label="Stäng utbetalning" onClick={onClose} disabled={busy}><X size={21} /></button>
    </div>
    {(loading || sessionLoading) && <p className="swish-payment-muted" role="status"><LoaderCircle size={18} className="swish-payment-spin" />Hämtar det attesterade underlaget…</p>}
    {!sessionLoading && !sessionMatches && <p className="swish-payment-error" role="alert">En giltig inloggning behövs för att hämta utbetalningsuppgifterna.</p>}
    {preparation && sessionMatches && <>
      <div className="swish-payout-frozen"><div><span>Attesterat belopp <LockKeyhole size={13} /></span><strong>{preparation.amount.toLocaleString('sv-SE', { style: 'currency', currency: 'SEK' })}</strong></div><div><span>Mottagare</span><strong>{preparation.customer.name}</strong><small>{preparation.customer.type} · {preparation.customer.number}</small></div></div>
      <div className="swish-payout-details-heading"><strong>{editing ? 'Redigerar utbetalningsuppgifter' : 'Utbetalningsuppgifter'} {!editing && <LockKeyhole size={13} />}</strong>
        {!editing ? <button type="button" className="office-btn outline" disabled={busy || uncertain} onClick={() => setEditing(true)}><Pencil size={14} />Redigera</button>
          : <div><button type="button" className="office-btn text" disabled={busy} onClick={cancelEditing}>Avbryt redigering</button><button type="button" className="office-btn outline" disabled={busy} onClick={() => setEditing(false)}><Check size={14} />Klar</button></div>}
      </div>
      <p className="swish-payment-muted">Kontrollera uppgifterna före utbetalning. Belopp och kundidentitet är alltid låsta.</p>
      <fieldset className="swish-payout-fields" disabled={busy || uncertain}>
        {editing ? <PaymentEditor value={details} customerName={preparation.customer.name} hideSaveAction onSave={() => false}
          onDraftChange={value => setDetails({ ...value, personalNumber: preparation.paymentDetails.personalNumber ?? preparation.customer.number })} />
          : <dl className="swish-payout-locked-details" aria-label="Låsta utbetalningsuppgifter"><div><dt>Betalsätt</dt><dd>{({ swish: 'Swish', bank: 'Bankkonto', cash: 'Kontant', balance: 'Spara på saldo' })[details?.method ?? 'bank']}</dd></div>
            {details?.method === 'swish' && <><div><dt>Telefonnummer</dt><dd>{details.phone || '–'}</dd></div><div><dt>Mottagare</dt><dd>{details.recipient || '–'}</dd></div></>}
            {details?.method === 'bank' && <><div><dt>Bank</dt><dd>{details.bank || '–'}</dd></div><div><dt>Clearingnummer</dt><dd>{details.clearing || '–'}</dd></div><div><dt>Kontonummer</dt><dd>{details.account || '–'}</dd></div><div><dt>Kontohavare</dt><dd>{details.holder || '–'}</dd></div></>}
          </dl>}
        {methodSupported && <label className="swish-payout-identity">Mottagarens personnummer<input aria-label="Mottagarens personnummer" value={preparation.paymentDetails.personalNumber ?? preparation.customer.number} readOnly /><small>Identiteten följer den attesterade kunden och kan inte bytas i utbetalningen.</small></label>}
        {!methodSupported && <p className="swish-payout-warning"><CircleAlert size={16} />Bank, kontant och saldo är planerade. Välj Swish för att provköra den här testmiljön.</p>}
        {!isPrivate && <p className="swish-payout-warning"><CircleAlert size={16} />Swish Utbetalning gäller privatpersoner. Företag behöver bankutbetalning.</p>}
        {changed && (editing ? <label className="swish-payout-reason">Orsak till ändrade betalningsuppgifter<textarea aria-label="Orsak till ändrade betalningsuppgifter" value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={2} required /><small>En ny PDF-version arkiveras med ändrade betalningsuppgifter. Material, belopp och det attesterade originalet bevaras.</small></label>
          : <div className="swish-payout-reason-summary"><strong>Orsak till ändringen</strong><p>{reason || 'Ange en orsak via Redigera innan utbetalningen kan startas.'}</p></div>)}
      </fieldset>
      {!!preparation.issues.length && preparation.canInitiate === false && <div className="swish-payout-warning" role="status"><CircleAlert size={16} /><div>{preparation.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div></div>}
    </>}
    {error && <p role="alert" className="swish-payment-error">{error}</p>}
    <div className="swish-payout-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={onClose}>Avbryt</button>
      {uncertain ? <button type="button" className="office-btn" disabled={busy} onClick={() => void recover()}>{busy ? 'Kontrollerar…' : 'Kontrollera sparat test'}</button>
        : <button type="button" className="office-btn" disabled={busy || loading || sessionLoading || !sessionMatches || !ready} onClick={() => void start()}><Smartphone size={16} />{busy ? 'Sparar instruktionen…' : 'Testa Swish-utbetalning'}</button>}
    </div>
  </dialog>;
}
