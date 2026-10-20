import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Mail, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { normalizePhoneNumber, phoneNumberError } from '../data-format';
import { platformApi, PlatformRequestError } from './client';
import type { AuthenticatedPlatformSession, PlatformCommunicationsConfig, PlatformTestEmailResult, PlatformTestSmsResult } from './types';

export default function PlatformCommunications({ session }: { session: AuthenticatedPlatformSession }) {
  const allowed = session.actor.platformAdmin && !session.isSupportSession && !session.mustChangePassword
    && (!session.company || session.company.id === 'jeroc-demo');
  const scopeKey = JSON.stringify([session.actor.id, session.generation, session.organisationId, session.company?.id, allowed]);
  const scope = useRef(scopeKey); scope.current = scopeKey;
  const attempts = useRef(new Map<string, string>());
  const smsAttempts = useRef(new Map<string, string>());
  const smsReviews = useRef(new Map<string, string>());
  const pending = useRef<AbortController | undefined>(undefined);
  const [config, setConfig] = useState<PlatformCommunicationsConfig>();
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false), [to, setTo] = useState('');
  const [busy, setBusy] = useState<'email' | 'sms' | 'review'>();
  const [configError, setConfigError] = useState(''), [error, setError] = useState('');
  const [result, setResult] = useState<PlatformTestEmailResult>();
  const [smsOpen, setSmsOpen] = useState(false), [phone, setPhone] = useState(''), [smsError, setSmsError] = useState('');
  const [smsResult, setSmsResult] = useState<PlatformTestSmsResult>();
  const [reviewRequired, setReviewRequired] = useState(false), [reviewChecked, setReviewChecked] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');

  useEffect(() => {
    pending.current?.abort(); pending.current = undefined; attempts.current.clear(); smsAttempts.current.clear(); smsReviews.current.clear();
    setOpen(false); setTo(''); setBusy(undefined); setError(''); setResult(undefined);
    setSmsOpen(false); setPhone(''); setSmsError(''); setSmsResult(undefined);
    setReviewRequired(false); setReviewChecked(false); setReviewMessage('');
    return () => { pending.current?.abort(); };
  }, [scopeKey]);

  useEffect(() => {
    const controller = new AbortController();
    setConfig(undefined); setConfigError(''); setLoading(allowed);
    if (allowed) void platformApi.communications(controller.signal)
      .then(value => {
        if (controller.signal.aborted || scope.current !== scopeKey) return;
        if (!value || typeof value !== 'object' || !value.email || typeof value.email.configured !== 'boolean'
          || value.email.provider !== 'resend' || typeof value.email.from !== 'string' || !value.email.from.trim()
          || value.email.from.length > 320 || !value.sms || typeof value.sms.configured !== 'boolean'
          || (value.sms.configured && (value.sms.provider !== '46elks' || value.sms.from !== 'ScrapPlan')))
          throw new Error('Utskickstjänsten gav ett ofullständigt svar. Uppdatera status och försök igen.');
        setConfig(value);
      })
      .catch(failure => {
        if (!controller.signal.aborted && scope.current === scopeKey)
          setConfigError(failure instanceof Error ? failure.message : 'Utskickstjänstens status kunde inte hämtas.');
      })
      .finally(() => { if (!controller.signal.aborted && scope.current === scopeKey) setLoading(false); });
    return () => controller.abort();
  }, [allowed, refresh, scopeKey]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || busy || !allowed || !config?.email.configured) return;
    const recipient = to.trim().toLowerCase();
    if (!recipient || recipient.length > 254 || /[\r\n,;]/.test(recipient)) {
      setError('Ange en giltig e-postadress till en mottagare.'); return;
    }
    const requestId = attempts.current.get(recipient) ?? crypto.randomUUID();
    attempts.current.set(recipient, requestId);
    const controller = new AbortController(); pending.current = controller;
    const principal = scope.current;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setBusy('email'); setError(''); setResult(undefined);
    try {
      const response = await platformApi.sendTestEmail({ to: recipient, requestId }, controller.signal);
      controller.signal.throwIfAborted();
      if (scope.current !== principal) return;
      if (response.status !== 'accepted' || response.requestId !== requestId || typeof response.to !== 'string' || response.to.toLowerCase() !== recipient)
        throw new Error('Utskicket kunde inte bekräftas. Försök igen med samma mottagare.');
      attempts.current.delete(recipient); setResult(response);
    } catch (failure) {
      if ((!controller.signal.aborted || timedOut) && scope.current === principal)
        setError(timedOut ? 'Testmejlet kunde inte bekräftas i tid. Försök igen med samma mottagare.'
          : failure instanceof Error ? failure.message : 'Testmejlet kunde inte bekräftas. Försök igen med samma mottagare.');
    } finally {
      globalThis.clearTimeout(timeout);
      if (pending.current === controller) pending.current = undefined;
      if (scope.current === principal) setBusy(undefined);
    }
  }

  async function submitSms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || busy || !allowed || !config?.sms.configured || reviewRequired) return;
    const validation = phoneNumberError(phone, { required: true });
    if (validation) { setSmsError(validation); return; }
    const recipient = normalizePhoneNumber(phone);
    const requestId = smsAttempts.current.get(recipient) ?? crypto.randomUUID();
    smsAttempts.current.set(recipient, requestId);
    const controller = new AbortController(); pending.current = controller;
    const principal = scope.current;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setBusy('sms'); setSmsError(''); setSmsResult(undefined); setReviewChecked(false); setReviewMessage('');
    try {
      const response = await platformApi.sendTestSms({ to: recipient, requestId }, controller.signal);
      controller.signal.throwIfAborted();
      if (scope.current !== principal) return;
      if (response.status !== 'accepted' || response.requestId !== requestId || response.provider !== '46elks'
        || response.from !== 'ScrapPlan' || typeof response.to !== 'string' || normalizePhoneNumber(response.to) !== recipient
        || !['created', 'sent', 'delivered'].includes(response.providerStatus))
        throw new PlatformRequestError('SMS-testets resultat kunde inte bekräftas. Kontrollera utskicksloggen hos 46elks innan du provar igen.', 'system_sms_outcome_unknown');
      smsAttempts.current.delete(recipient); setSmsResult(response); setReviewRequired(false);
    } catch (failure) {
      if ((!controller.signal.aborted || timedOut) && scope.current === principal) {
        const uncertain = timedOut || !(failure instanceof PlatformRequestError)
          || ['system_sms_outcome_unknown', 'system_sms_recipient_blocked'].includes(failure.code ?? '')
          || ((failure.status ?? 0) >= 500 && !['system_sms_credentials_rejected', 'system_sms_rejected',
            'system_sms_not_configured', 'system_sms_registry_full', 'system_sms_balance_required',
            'system_sms_delivery_failed'].includes(failure.code ?? ''));
        setReviewRequired(uncertain);
        setSmsError(timedOut
          ? 'SMS-testet kunde inte bekräftas i tid. Kontrollera utskicksloggen hos 46elks innan du provar igen.'
          : failure instanceof Error ? failure.message : 'SMS-testets resultat kunde inte bekräftas. Kontrollera 46elks utskickslogg.');
      }
    } finally {
      globalThis.clearTimeout(timeout);
      if (pending.current === controller) pending.current = undefined;
      if (scope.current === principal) setBusy(undefined);
    }
  }

  async function reviewSms() {
    if (pending.current || busy || !allowed || !config?.sms.configured || !reviewRequired || !reviewChecked) return;
    const validation = phoneNumberError(phone, { required: true });
    if (validation) { setSmsError(validation); return; }
    const recipient = normalizePhoneNumber(phone);
    const requestId = smsReviews.current.get(recipient) ?? crypto.randomUUID();
    smsReviews.current.set(recipient, requestId);
    const controller = new AbortController(); pending.current = controller;
    const principal = scope.current;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setBusy('review'); setSmsError(''); setReviewMessage('');
    try {
      const response = await platformApi.reviewTestSms({ to: recipient, requestId }, controller.signal);
      controller.signal.throwIfAborted();
      if (scope.current !== principal) return;
      if (response.reviewed !== true) throw new Error('Kontrollen kunde inte sparas. Inget nytt SMS har begärts.');
      smsAttempts.current.delete(recipient); smsReviews.current.delete(recipient);
      setReviewRequired(false); setReviewChecked(false);
      setReviewMessage('Kontrollen är sparad. Inget SMS skickades. Du kan nu välja Skicka test-SMS för ett nytt test.');
    } catch (failure) {
      if ((!controller.signal.aborted || timedOut) && scope.current === principal) {
        setReviewChecked(false);
        setSmsError(timedOut ? 'Kontrollen kunde inte bekräftas i tid. Inget nytt SMS har begärts.'
          : failure instanceof Error ? failure.message : 'Kontrollen kunde inte sparas.');
      }
    } finally {
      globalThis.clearTimeout(timeout);
      if (pending.current === controller) pending.current = undefined;
      if (scope.current === principal) setBusy(undefined);
    }
  }

  if (!allowed) return null;
  return <section className="platform-panel platform-communications" aria-label="Systemutskick">
    <div className="platform-panel-heading"><h2><Mail size={20} />Systemutskick</h2>
      <button type="button" className="platform-text-btn" disabled={loading || Boolean(busy)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} />Uppdatera status</button></div>
    <p>Testa ScrapPlanners mejl och SMS från ditt systemadminkonto.</p>
    {loading && <p role="status">Kontrollerar utskickstjänsterna…</p>}
    {configError && <p className="platform-error" role="alert">{configError}</p>}
    {config && <>
      <div className="platform-communications-sender"><span>Avsändare<strong>{config.email.from}</strong></span>
        <span className={`platform-status ${config.email.configured ? 'active' : 'inactive'}`}>{config.email.configured ? 'Resend konfigurerat' : 'Mejltjänsten är inte konfigurerad'}</span></div>
      {!config.email.configured && <p className="platform-info">Spara RESEND_API_KEY i appserverns miljövariabler och deploya för att aktivera mejltestet.</p>}
      <div className="platform-communications-sender"><span>SMS-avsändare<strong>{config.sms.from ?? 'ScrapPlan'}</strong></span>
        <span className={`platform-status ${config.sms.configured ? 'active' : 'inactive'}`}>{config.sms.configured ? '46elks konfigurerat' : 'SMS-tjänsten är inte konfigurerad'}</span></div>
      {!config.sms.configured && <p className="platform-info">Spara ELKS_API_USERNAME och ELKS_API_PASSWORD i appserverns miljövariabler och deploya för att aktivera SMS-testet.</p>}
      <div className="platform-communications-actions">
        <button type="button" className="platform-btn outline" aria-expanded={open} aria-controls="platform-email-test-form" disabled={!config.email.configured || Boolean(busy)} onClick={() => { setOpen(value => !value); setError(''); setResult(undefined); }}><Mail size={16} />Testa mejlutskick</button>
        <button type="button" className="platform-btn outline" aria-expanded={smsOpen} aria-controls="platform-sms-test-form" disabled={!config.sms.configured || Boolean(busy)} onClick={() => { setSmsOpen(value => !value); setSmsError(''); setSmsResult(undefined); }}><MessageSquare size={16} />Testa SMS-utskick</button>
      </div>
      {open && <form id="platform-email-test-form" className="platform-form platform-email-test-form" onSubmit={event => void submit(event)}>
        <label>Mottagarens e-postadress<input type="email" autoComplete="email" value={to} required maxLength={254} disabled={Boolean(busy)} onChange={event => { setTo(event.target.value); setError(''); setResult(undefined); }} /></label>
        <p className="platform-email-test-help">Ett testmejl skickas till den angivna adressen när du väljer Skicka testmejl.</p>
        <div className="platform-form-actions"><button type="submit" className="platform-btn" disabled={Boolean(busy) || !to.trim() || !config.email.configured}><Send size={16} />{busy === 'email' ? 'Skickar…' : 'Skicka testmejl'}</button></div>
      </form>}
      {smsOpen && <form id="platform-sms-test-form" className="platform-form platform-email-test-form platform-sms-test-form" onSubmit={event => void submitSms(event)}>
        <label>Mottagarens telefonnummer<input type="tel" inputMode="tel" autoComplete="tel" value={phone} required maxLength={80} placeholder="070 123 45 67" disabled={Boolean(busy)} onChange={event => {
          setPhone(event.target.value); setSmsError(''); setSmsResult(undefined); setReviewRequired(false); setReviewChecked(false); setReviewMessage('');
        }} /></label>
        <p className="platform-email-test-help">Ett test-SMS skickas från ScrapPlan när du väljer Skicka test-SMS. Svenska nummer kan anges med 07 eller +46.</p>
        <div className="platform-form-actions"><button type="submit" className="platform-btn" disabled={Boolean(busy) || !phone.trim() || !config.sms.configured || reviewRequired}><Send size={16} />{busy === 'sms' ? 'Skickar SMS…' : 'Skicka test-SMS'}</button></div>
      </form>}
    </>}
    {error && <p className="platform-error" role="alert">{error}</p>}
    {result && <p className="platform-info platform-email-test-result" role="status">Resend har tagit emot testmejlet till <strong>{result.to}</strong> för utskick. Kontrollera inkorgen och skräpposten. Leveransen till inkorgen är ännu inte bekräftad.</p>}
    {smsError && <p className="platform-error" role="alert">{smsError}</p>}
    {smsResult && <p className="platform-info platform-email-test-result" role="status">{smsResult.providerStatus === 'delivered'
      ? <>46elks rapporterar att test-SMS:et till <strong>{smsResult.to}</strong> är levererat.</>
      : <>46elks har tagit emot test-SMS:et till <strong>{smsResult.to}</strong> för utskick. Leveransen till telefonen är ännu inte bekräftad.</>}</p>}
    {reviewRequired && smsOpen && <div className="platform-sms-review">
      <p>Kontrollera först utskicksloggen i ditt 46elks-konto. Ett osäkert svar kan betyda att SMS:et redan skickats.</p>
      <label><input type="checkbox" checked={reviewChecked} disabled={Boolean(busy)} onChange={event => setReviewChecked(event.target.checked)} />Jag har kontrollerat utskicksloggen</label>
      <button type="button" className="platform-btn outline" disabled={Boolean(busy) || !reviewChecked} onClick={() => void reviewSms()}>{busy === 'review' ? 'Sparar kontroll…' : 'Tillåt ett nytt SMS-test'}</button>
    </div>}
    {reviewMessage && <p className="platform-info" role="status">{reviewMessage}</p>}
    <p className="platform-communications-sms">SMS för kundgodkännanden och transportaviseringar är förberedda. Testknappen aktiverar inga automatiska aviseringar.</p>
  </section>;
}
