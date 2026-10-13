import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CircleAlert, FlaskConical, LoaderCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import type { OfficeUser } from './model';
import { environmentFailure, useEnvironmentSession } from './EnvironmentSession';
import { EnvironmentApiError } from './environment-client';
import { environmentTime, type NvvJsonObject } from './environment-types';
import NvvConnectionCheckDialog, { type NvvCheckProgress } from './NvvConnectionCheckDialog';
import { OfficePageHeader } from './OfficePageHeader';
import { sharedBusinessCacheKey } from '../shared-data';
import { mayManageSwish, swishIntegrationApi, swishPaymentStatusLabel, type SwishIntegrationState, type SwishPaymentJob, type SwishSandboxRequest } from './swish-integration-client';
import './environment.css';
import './swish-integration.css';

const running = (job: SwishPaymentJob) => ['queued', 'in_flight', 'pending'].includes(job.status);
const uncertain = (job: SwishPaymentJob) => job.status === 'unknown';
const progressFor = (job: SwishPaymentJob): NvvCheckProgress => running(job) ? { phase: 'running', mode: 'test' }
  : job.status === 'simulated_paid' ? { phase: 'success', mode: 'test', wasteCodes: 0, transportModes: 0 }
    : { phase: 'error', mode: 'test', message: job.error?.message || swishPaymentStatusLabel(job.status) };
const initialForm = { amount: '10.00', paymentDetails: { method: 'swish' as const, phone: '+46711111132', personalNumber: '197709306828', recipient: 'Swish MSS testmottagare' }, message: 'ScrapPilot MSS-test' };
const unknownJob = (request: SwishSandboxRequest): SwishPaymentJob => ({ id: request.idempotencyKey, kind: 'sandbox', mode: 'mss', simulation: true,
  status: 'unknown', amount: request.amount, amountCents: Math.round(Number(request.amount.replace(',', '.')) * 100), currency: 'SEK', paymentDetails: request.paymentDetails,
  request: { method: 'POST', path: '/api/environment/swish/sandbox', payload: request as unknown as NvvJsonObject }, events: [],
  error: { message: 'Testets slutresultat är oklart. Kontrollera det sparade resultatet innan du skickar ett nytt test.' } });
const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

export default function SwishSandboxWorkspace({ user, actualUser }: { user: OfficeUser; actualUser: OfficeUser; onNotice?: (message: string) => void }) {
  const { session, loading: sessionLoading, error: sessionError, refreshSession } = useEnvironmentSession();
  const permitted = mayManageSwish(user, actualUser);
  const matching = session?.actualUserId === actualUser.id && session?.effectiveUserId === user.id;
  const identity = `${actualUser.id}/${actualUser.level}/${actualUser.permissions.join(',')}/${user.id}/${user.level}/${user.permissions.join(',')}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const allowedRef = useRef(false); allowedRef.current = permitted && matching;
  const storageKey = sharedBusinessCacheKey(`scrappilot.swish-mss.pending:${encodeURIComponent(actualUser.id)}:${encodeURIComponent(user.id)}`, { actor: actualUser.id, user: user.id });
  const mounted = useRef(true), generation = useRef(0), busy = useRef(false), timer = useRef<number | undefined>(undefined);
  const controllers = useRef(new Set<AbortController>()), submitButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<SwishIntegrationState>(), [form, setForm] = useState(initialForm);
  const [job, setJob] = useState<SwishPaymentJob>(), [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState<'load' | 'send' | 'refresh'>(), [error, setError] = useState('');

  function clearTimer() { if (timer.current !== undefined) window.clearTimeout(timer.current); timer.current = undefined; }
  const savePending = useCallback((id: string) => { try { window.sessionStorage.setItem(storageKey, JSON.stringify({ id })); } catch { /* The server keeps the durable test result. */ } }, [storageKey]);
  const finishPending = useCallback((value: SwishPaymentJob) => {
    if (running(value) || uncertain(value)) { savePending(value.id); return; }
    try { const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null'); if (saved?.id === value.id) window.sessionStorage.removeItem(storageKey); } catch { /* Server history remains authoritative. */ }
  }, [savePending, storageKey]);
  const applyJob = useCallback((value: SwishPaymentJob) => { setJob(value); finishPending(value); }, [finishPending]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; clearTimer(); for (const controller of controllers.current) controller.abort(); }; }, []);
  useEffect(() => {
    generation.current++; clearTimer(); for (const c of controllers.current) c.abort(); controllers.current.clear(); busy.current = false;
    setState(undefined); setForm(initialForm); setJob(undefined); setDialogOpen(false); setError(''); setPending(undefined);
  }, [identity, matching]);

  const readJob = useCallback(async (id: string, providerRefresh: boolean, showDialog = false) => {
    if (!allowedRef.current || busy.current) return;
    clearTimer(); busy.current = true; setPending('refresh'); setError(''); if (showDialog) setDialogOpen(true);
    const request = ++generation.current, controller = new AbortController(); controllers.current.add(controller);
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && allowedRef.current && generation.current === request;
    try {
      const value = providerRefresh ? await swishIntegrationApi.refresh(id, controller.signal) : await swishIntegrationApi.job(id, controller.signal);
      if (current()) applyJob(value);
    } catch (failure) { if (current()) setError(environmentFailure(failure)); }
    finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }, [identity, applyJob]);

  const loadSettings = useCallback(() => {
    if (!permitted || !matching || busy.current) return;
    const controller = new AbortController(); controllers.current.add(controller);
    const request = ++generation.current;
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && allowedRef.current && generation.current === request;
    busy.current = true; setPending('load'); setError('');
    void swishIntegrationApi.settings(controller.signal).then(value => {
      if (current()) { setState(value); setForm(structuredClone(value.defaults)); }
    }).catch(failure => { if (current()) setError(environmentFailure(failure)); }).finally(() => {
      controllers.current.delete(controller); if (!current()) return; busy.current = false; setPending(undefined);
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null');
        if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(saved?.id ?? '')) {
          setJob({ ...unknownJob({ ...initialForm, idempotencyKey: saved.id }), request: undefined });
          void readJob(saved.id, false);
        }
      } catch { /* No previous test to recover. */ }
    });
  }, [identity, matching, permitted, readJob, storageKey]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Only read the saved job while the page is visible. The server alone decides
  // when to reconcile Swish; this loop never submits another payout instruction.
  useEffect(() => {
    clearTimer(); if (!job || !running(job) || pending || !permitted || !matching) return;
    const id = job.id;
    const readWhenVisible = () => { if (document.visibilityState === 'visible') void readJob(id, false); };
    timer.current = window.setTimeout(readWhenVisible, 3000);
    document.addEventListener('visibilitychange', readWhenVisible);
    return () => { clearTimer(); document.removeEventListener('visibilitychange', readWhenVisible); };
  }, [job, pending, permitted, matching, readJob]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowedRef.current || busy.current || !state?.settings.enabled || !state.configuration.ready || job && (running(job) || uncertain(job))) return;
    const submitted: SwishSandboxRequest = { ...structuredClone(form), amount: form.amount.replace(',', '.'), idempotencyKey: crypto.randomUUID() };
    const placeholder = unknownJob(submitted);
    savePending(placeholder.id); applyJob({ ...placeholder, status: 'in_flight', error: undefined }); setDialogOpen(true); setError(''); setPending('send'); busy.current = true;
    const request = ++generation.current, controller = new AbortController(); controllers.current.add(controller);
    const current = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && allowedRef.current && generation.current === request;
    try { const value = await swishIntegrationApi.sandbox(submitted, controller.signal); if (current()) applyJob(value); }
    catch (failure) { if (current()) {
      const denied = failure instanceof EnvironmentApiError && failure.status >= 400 && failure.status < 500 && ![408, 409, 429].includes(failure.status);
      applyJob({ ...placeholder, status: denied ? 'blocked' : 'unknown', error: { message: environmentFailure(failure) } }); setError(environmentFailure(failure));
    } }
    finally { controllers.current.delete(controller); if (current()) { busy.current = false; setPending(undefined); } }
  }

  if (!permitted) return <div className="office-panel integration-message"><ShieldCheck size={19} /><span>Du behöver behörighet att hantera bolagets integrationer för att köra Swish-test.</span></div>;
  const requestBlocked = !state?.configuration.ready || !state?.settings.enabled;
  const unresolved = !!job && (running(job) || uncertain(job));
  return <section className="swish-sandbox-workspace">
    <OfficePageHeader><Link className="office-link integration-back" to="/integrations?service=swish"><ArrowLeft size={15} />Till Swish-inställningar</Link><div className="office-title"><div><span className="office-eyebrow">INTEGRATIONSTEST · SWISH MSS</span><h1>Prova Swish Utbetalning</h1><p>Ett fristående prov med Swishs syntetiska testmottagare.</p></div><span className="integration-status test"><FlaskConical size={14} />SWISH · TEST</span></div></OfficePageHeader>
    <div className="swish-test-note"><ShieldCheck size={18} /><div><strong>Inga riktiga pengar eller viktkort påverkas</strong><p>Testsidan skickar till Swish MSS. Ingen betalning registreras i Spiris från detta fristående test.</p></div></div>
    {!matching && <div className="swish-feedback" role={sessionError ? 'alert' : 'status'}><span>{sessionError || 'Hämtar bolagets anslutning…'}</span>{!sessionLoading && <button className="office-btn outline" onClick={() => void refreshSession().catch(() => undefined)}>Försök igen</button>}</div>}
    {error && <div className="swish-feedback error" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}
    {matching && <div className="swish-sandbox-layout"><article className="office-panel"><h2>Testutbetalning</h2>
      {requestBlocked && <div className="swish-feedback warning"><CircleAlert size={17} /><span>{!state ? pending ? 'Hämtar testinställningar…' : 'Testinställningarna kunde inte hämtas.' : !state.settings.enabled ? 'Aktivera Swish MSS i bolagets integrationsinställningar först.' : 'Serverns Swish MSS-anslutning är inte klar. Kontrollera integrationsinställningarna.'}</span>{!state && !pending && <button className="office-btn outline" onClick={loadSettings}>Försök igen</button>}</div>}
      <form onSubmit={event => void submit(event)}><div className="swish-sandbox-form">
        <label>Belopp · SEK<input inputMode="decimal" value={form.amount} required pattern="[0-9]+([.,][0-9]{1,2})?" disabled={!!pending} onChange={event => setForm(value => ({ ...value, amount: event.target.value }))} /></label>
        <label>Swish-nummer<input type="tel" value={form.paymentDetails.phone} required disabled={!!pending} onChange={event => setForm(value => ({ ...value, paymentDetails: { ...value.paymentDetails, phone: event.target.value } }))} /><small>Swishs testnummer, inte en riktig mottagare.</small></label>
        <label>Personnummer<input value={form.paymentDetails.personalNumber} required disabled={!!pending} onChange={event => setForm(value => ({ ...value, paymentDetails: { ...value.paymentDetails, personalNumber: event.target.value } }))} /><small>Syntetisk identitet från Swish MSS.</small></label>
        <label>Mottagare<input value={form.paymentDetails.recipient} required maxLength={100} disabled={!!pending} onChange={event => setForm(value => ({ ...value, paymentDetails: { ...value.paymentDetails, recipient: event.target.value } }))} /></label>
        <label className="swish-form-wide">Meddelande / referens<input value={form.message} maxLength={50} disabled={!!pending} onChange={event => setForm(value => ({ ...value, message: event.target.value }))} /></label>
      </div><div className="swish-test-toolbar"><button type="button" className="office-link" disabled={!!pending || !state} onClick={() => state && setForm(structuredClone(state.defaults))}>Återställ testuppgifter</button><button className="office-btn" ref={submitButton} type="submit" disabled={!!pending || requestBlocked || unresolved}>{pending === 'send' ? <LoaderCircle size={15} className="swish-spin" /> : <Send size={15} />}{pending === 'send' ? 'Skickar test…' : 'Skicka Swish-test'}</button></div></form>
      {unresolved && <div className="swish-feedback"><CircleAlert size={17} /><div><strong>Kontrollera det pågående testet först</strong><p className="swish-field-help">Ett nytt test skickas först när vi har ett känt resultat. Kontrollknappen hämtar status för samma instruktion.</p><button className="office-btn outline" disabled={!!pending} onClick={() => job && void readJob(job.id, true, true)}><RefreshCw size={14} />Kontrollera resultat</button></div></div>}
    </article><article className="office-panel swish-sandbox-result"><h2>Senaste testet</h2>{job ? <><strong>{swishPaymentStatusLabel(job.status)}</strong><p>{job.amountCents / 100} SEK · {job.paymentDetails.recipient}</p>{job.updatedAt && <p>Uppdaterat {environmentTime(job.updatedAt)}</p>}<div className="swish-test-toolbar"><button className="office-btn outline" onClick={() => setDialogOpen(true)}>Visa anrop och svar</button><button className="office-link" disabled={!!pending} onClick={() => void readJob(job.id, true)}><RefreshCw size={14} />Kontrollera status</button></div>
      {job.events.length > 0 && <ol className="swish-sandbox-events">{job.events.map((event, index) => <li key={`${event.at}/${index}`}>{event.text || event.message || event.action || event.type}{event.at && <small> · {environmentTime(event.at)}</small>}</li>)}</ol>}
      {job.response && <details><summary>Tekniskt svar{job.response.httpStatus != null ? ` · HTTP ${job.response.httpStatus}` : ''}</summary><pre>{json(job.response.data)}</pre></details>}
    </> : <p>Skicka ett test så visas status, skickade uppgifter och Swishs svar här.</p>}</article></div>}
    {dialogOpen && job && <NvvConnectionCheckDialog progress={progressFor(job)} onClose={() => setDialogOpen(false)} onRetry={() => void readJob(job.id, true, true)} returnFocus={submitButton}
      externalTest={{ provider: 'Swish', environmentLabel: 'SWISH MSS · SIMULERING', method: job.request?.method ?? 'POST', path: job.request?.path ?? '/api/environment/swish/sandbox', payload: job.request?.payload,
        uncertain: uncertain(job), run: { status: running(job) ? 'in_flight' : job.status === 'simulated_paid' ? 'accepted' : uncertain(job) ? 'unknown' : 'rejected',
          httpStatus: job.response?.httpStatus, response: job.response?.data, resourceId: job.providerInstructionUUID ?? job.id, finishedAt: running(job) ? undefined : job.updatedAt } }} />}
  </section>;
}
