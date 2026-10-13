import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ExternalLink, PlugZap, RefreshCw, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { can, type OfficeCard, type OfficeUser } from './model';
import { mayManageSpiris } from './integration-permissions';
import { useEnvironmentSession } from './EnvironmentSession';
import { spirisAccountingApi } from './spiris-accounting-client';
import { useCardSwishTracking } from './SwishPaymentPanel';
import { swishPaymentTrace } from './swish-payment-trace';
import './card-spiris-status.css';

const exportSchema = z.object({
  id: z.string().min(1), cardId: z.number().int().positive(), approvalId: z.string(), version: z.number().int().positive(),
  status: z.string(), startedAt: z.string().nullish(), finishedAt: z.string().nullish(),
  supplierId: z.string().nullish(), draftId: z.string().nullish(),
  error: z.object({ message: z.string() }).nullish(),
  canRefresh: z.boolean().optional(), canRecreate: z.boolean().optional(),
  tracking: z.object({
    state: z.enum(['pending', 'booked', 'paused', 'missing', 'expired', 'attention', 'replaced']),
    lastCheckedAt: z.string().nullish(), lastAttemptAt: z.string().nullish(), nextCheckAt: z.string().nullish(),
    deadlineAt: z.string().nullish(), intervalMinutes: z.number().optional(), reason: z.string().nullish(),
    invoiceId: z.string().nullish(), invoiceNumber: z.string().nullish(), voucherId: z.string().nullish(),
    voucherNumber: z.union([z.string(), z.number()]).nullish(),
  }).nullish(),
  events: z.array(z.object({ id: z.string().optional(), type: z.string().optional(), at: z.string(), text: z.string(), actor: z.string().optional(), detail: z.string().optional() })),
});
const responseSchema = z.object({ export: exportSchema.nullable() });
type CardExport = z.infer<typeof exportSchema>;
type PanelState = { scope: string; job?: CardExport | null; loading: boolean; error: string };
type TrackingContext = {
  current: PanelState; allowed: boolean; attested: boolean; fullJournal: boolean;
  details: boolean; setDetails: (value: boolean) => void;
  busy: boolean; refresh: () => Promise<void>; recreate: () => Promise<void>;
};
const TrackingContext = createContext<TrackingContext | null>(null);
const trackingLabels: Record<string, string> = {
  pending: 'Inväntar bokföring', booked: 'Bokförd i Spiris', paused: 'Statuskontroll pausad',
  missing: 'Underlag saknas i Spiris', expired: 'Bokföringsbekräftelse saknas – kontrollera',
  attention: 'Statuskontroll behöver åtgärdas',
  replaced: 'Utkast ersatt av ett nytt försök',
};
const headlineTitles: Record<string, string> = {
  queued: 'Överföring till Spiris köad', started: 'Överföring till Spiris påbörjad',
  draft_created: 'Fakturautkast skapat i Spiris', local_blocked: 'Överföring till Spiris stoppad',
  remote_rejected: 'Spiris avvisade överföringen', response_unknown: 'Svar från Spiris behöver kontrolleras',
  booked: 'Bokförd i Spiris', tracking_paused: 'Statuskontroll pausad',
  draft_missing: 'Underlag saknas i Spiris', draft_recreated: 'Fakturautkast återskapat i Spiris',
  tracking_expired: 'Bokföringsbekräftelse saknas – kontrollera',
};
const activeStatuses = new Set(['queued', 'processing', 'running', 'in_flight']);
const labels: Record<string, string> = {
  queued: 'Köad', processing: 'Överföring pågår', running: 'Överföring pågår', in_flight: 'Överföring pågår',
  accepted: 'Utkast skapat', rejected: 'Avvisad', unknown: 'Svar behöver kontrolleras', blocked: 'Behöver åtgärdas',
};
function time(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? 'Tid saknas' : new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm', dateStyle: 'medium', timeStyle: 'short',
  }).format(timestamp);
}

/** Read the limited office projection; fetching this panel never starts an export. */
export function CardSpirisTrackingProvider({ card, user, actualUser, children }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser; children: ReactNode;
}) {
  const environment = useEnvironmentSession();
  const allowed = can(user, 'attest') || can(user, 'pay') || can(user, 'reports');
  const attested = ['ready', 'paid', 'balance'].includes(card.status) || card.customerApproval?.status === 'attested';
  const fullJournal = mayManageSpiris(user, actualUser);
  const scope = JSON.stringify([card.id, actualUser.id, user.id, user.level, user.permissions, user.siteIds, actualUser.level, actualUser.siteIds]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<PanelState>({ scope: '', loading: true, error: '' });
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionController = useRef<AbortController | undefined>(undefined);
  const recreateRequest = useRef<{ jobId: string; id: string } | undefined>(undefined);
  useEffect(() => {
    setDetails(false); setBusy(false); recreateRequest.current = undefined;
    return () => actionController.current?.abort();
  }, [scope]);
  useEffect(() => {
    if (!allowed) { setState({ scope, loading: false, error: '' }); return; }
    const abort = new AbortController();
    let active = true, discoveries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState(previous => ({ scope, job: previous.scope === scope ? previous.job : undefined, loading: true, error: '' }));
    async function read() {
      if (!active || abort.signal.aborted || currentScope.current !== scope) return;
      const requestAbort = new AbortController();
      let timedOut = false;
      const cancel = () => requestAbort.abort();
      abort.signal.addEventListener('abort', cancel, { once: true });
      const deadline = setTimeout(() => { timedOut = true; requestAbort.abort(); }, 15000);
      try {
        const response = await fetch(`/api/application/office/accounting/cards/${card.id}`, {
          method: 'GET', credentials: 'same-origin', signal: requestAbort.signal,
          headers: { 'X-Demo-Actor': actualUser.id, 'X-Demo-User': user.id },
        });
        const body = await response.json().catch(() => ({}));
        if (!active || currentScope.current !== scope) return;
        if (!response.ok) throw new Error(body.error ?? 'Överföringsstatus kunde inte hämtas.');
        const parsed = responseSchema.safeParse(body);
        if (!parsed.success || parsed.data.export && parsed.data.export.cardId !== card.id)
          throw new Error('Överföringsstatus kunde inte läsas. Försök hämta den igen.');
        const job = parsed.data.export;
        setState({ scope, job, loading: false, error: '' });
        if (job && activeStatuses.has(job.status)) timer = setTimeout(() => void read(), 2500);
        else if (job?.tracking && ['pending', 'attention'].includes(job.tracking.state) && job.tracking.nextCheckAt)
          timer = setTimeout(() => void read(), 60000);
        else if (!job && attested && discoveries < 3) {
          discoveries += 1;
          timer = setTimeout(() => void read(), 2000);
        }
      } catch (failure) {
        if (!active || abort.signal.aborted || currentScope.current !== scope) return;
        setState(previous => ({ scope, job: previous.scope === scope ? previous.job : undefined, loading: false,
          error: timedOut ? 'Överföringsstatus svarade inte i tid. Försök uppdatera igen.' : failure instanceof Error ? failure.message : 'Överföringsstatus kunde inte hämtas.' }));
      } finally {
        clearTimeout(deadline);
        abort.signal.removeEventListener('abort', cancel);
      }
    }
    void read();
    return () => { active = false; abort.abort(); if (timer) clearTimeout(timer); };
  }, [scope, allowed, attested, card.status, card.customerApproval?.version, refresh]);

  const current = state.scope === scope ? state : { scope, loading: true, error: '', job: undefined };
  async function action(recreate: boolean) {
    if (busy || current.loading) return;
    const job = current.job;
    if (!job || !fullJournal || !(recreate ? job.canRecreate : job.canRefresh)) {
      setRefresh(value => value + 1); return;
    }
    const requestedScope = scope, controller = new AbortController();
    actionController.current?.abort(); actionController.current = controller;
    setBusy(true); setState(previous => ({ ...previous, error: '' }));
    const deadline = setTimeout(() => controller.abort(), 60000);
    try {
      await environment.refreshSession();
      if (currentScope.current !== requestedScope || controller.signal.aborted) return;
      if (recreate) {
        if (recreateRequest.current?.jobId !== job.id) recreateRequest.current = { jobId: job.id, id: crypto.randomUUID() };
        await spirisAccountingApi.recreateExport(job.id, recreateRequest.current.id, controller.signal);
      } else await spirisAccountingApi.refreshExport(job.id, controller.signal);
      if (currentScope.current === requestedScope && !controller.signal.aborted) setRefresh(value => value + 1);
    } catch (failure) {
      if (currentScope.current === requestedScope) setState(previous => ({ ...previous,
        error: controller.signal.aborted ? 'Kontrollen tog för lång tid. Kontrollera status innan du försöker igen.'
          : failure instanceof Error ? failure.message : 'Spiris kunde inte kontrolleras.' }));
      if (currentScope.current === requestedScope) setRefresh(value => value + 1);
    } finally {
      clearTimeout(deadline);
      if (currentScope.current === requestedScope) setBusy(false);
    }
  }
  return <TrackingContext.Provider value={{ current, allowed, attested, fullJournal, details, setDetails, busy,
    refresh: () => action(false), recreate: () => action(true) }}>{children}</TrackingContext.Provider>;
}

export default function CardSpirisStatusPanel(_props: { card: OfficeCard; user: OfficeUser; actualUser: OfficeUser }) {
  const context = useContext(TrackingContext);
  if (!context) throw new Error('Spiris-kortet behöver CardSpirisTrackingProvider.');
  const { current, allowed, attested, fullJournal, details, setDetails, busy } = context;
  if (!allowed || !attested && !current.job) return null;
  const job = current.job;
  const tracking = job?.tracking;
  const laterAttempt = Boolean(tracking?.lastAttemptAt && (!tracking.lastCheckedAt ||
    Date.parse(tracking.lastAttemptAt) > Date.parse(tracking.lastCheckedAt)));
  const latestCheck = laterAttempt ? tracking?.lastAttemptAt : tracking?.lastCheckedAt;
  const booked = tracking?.state === 'booked';
  const headline = booked ? trackingLabels.booked : job ? labels[job.status] ?? 'Status behöver kontrolleras' : '';
  const events = job?.events.map((event, index) => ({ ...event, index })).sort((first, second) =>
    (Date.parse(first.at) || 0) - (Date.parse(second.at) || 0) || first.index - second.index) ?? [];
  return (
    <section id="card-spiris-status" className="office-panel card-spiris-status" aria-label="Spiris-överföring" aria-busy={busy}>
      <div className="card-spiris-heading">
        <h2><PlugZap size={20} aria-hidden="true" /> Spiris-överföring</h2>
        <div className="card-spiris-actions">
          <button type="button" className="office-link card-spiris-refresh" onClick={() => void context.refresh()} disabled={current.loading || busy}>
            <RefreshCw size={14} aria-hidden="true" /> {busy ? 'Kontrollerar…' : 'Uppdatera'}
          </button>
          {job && <button type="button" className="office-link card-spiris-details-toggle" aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? 'Dölj detaljer' : 'Visa detaljer'}<ChevronDown size={14} aria-hidden="true" />
          </button>}
        </div>
      </div>
      {job ? (
        <>
          <div className="card-spiris-summary">
            <span className={'card-spiris-pill ' + (booked || job.status === 'accepted' ? 'success' : activeStatuses.has(job.status) ? 'pending' : 'warning')}>
              {headline}
            </span>
            {tracking && tracking.state !== 'pending' && !booked && <span className="card-spiris-pill warning">{trackingLabels[tracking.state]}</span>}
            <span>Avräkning <strong>{'AV-' + job.cardId + '-V' + job.version}</strong></span>
            {tracking?.invoiceNumber && <span>Spiris faktura <strong>{tracking.invoiceNumber}</strong></span>}
            {booked && tracking?.voucherNumber != null && <span>Verifikation <strong>{tracking.voucherNumber}</strong></span>}
          </div>
          {tracking && <p className="card-spiris-followup">
            {tracking.reason || (tracking.state === 'pending' && tracking.intervalMinutes
              ? 'Bokföringsstatus kontrolleras automatiskt ' + (tracking.intervalMinutes < 60 ? 'var ' + tracking.intervalMinutes + ':e minut.' : tracking.intervalMinutes < 1440 ? 'varje timme.' : 'en gång per dygn.')
              : booked ? 'Bokföringen är bekräftad. Betalningsstatus hanteras separat.' : trackingLabels[tracking.state])}
            {latestCheck && <span>{laterAttempt ? 'Senaste kontrollförsök' : 'Senast kontrollerad'}: {time(latestCheck)}</span>}
            {tracking.nextCheckAt && tracking.state === 'pending' && <span>Nästa kontroll: {time(tracking.nextCheckAt)}</span>}
          </p>}
          {job.error?.message && <p className="card-spiris-error">{job.error.message}</p>}
          {fullJournal && attested && (!_props.card.customerApproval || _props.card.customerApproval.version === job.version) && job.canRecreate && <button type="button" className="office-btn outline card-spiris-recreate" disabled={busy || current.loading} onClick={() => void context.recreate()}>
            <RotateCcw size={15} aria-hidden="true" /> Återskapa utkast i Spiris
          </button>}
          {details && <div className="card-spiris-details">
          <div className="card-spiris-summary">
            <span>Version <strong>{job.version}</strong></span>
            {job.startedAt && <span>Startad <time dateTime={job.startedAt}>{time(job.startedAt)}</time></span>}
            {job.finishedAt && <span>Avslutad <time dateTime={job.finishedAt}>{time(job.finishedAt)}</time></span>}
          </div>
          <dl className="card-spiris-identities">
            <div><dt>Överförings-ID</dt><dd>{job.id}</dd></div>
            {job.supplierId && <div><dt>Leverantörs-ID</dt><dd>{job.supplierId}</dd></div>}
            {job.draftId && <div><dt>Utkast-ID</dt><dd>{job.draftId}</dd></div>}
            {tracking?.invoiceId && <div><dt>Faktura-ID</dt><dd>{tracking.invoiceId}</dd></div>}
            {tracking?.voucherId && <div><dt>Verifikations-ID</dt><dd>{tracking.voucherId}</dd></div>}
          </dl>
          {events.length > 0 && <ol className="card-spiris-events" aria-label="Överföringshistorik">
            {events.map(event => <li key={`${event.at}/${event.index}`}>
              <i aria-hidden="true" />
              <div><strong>{event.text}</strong><small>{event.actor && `${event.actor} · `}<time dateTime={event.at}>{time(event.at)}</time></small></div>
            </li>)}
          </ol>}
          </div>}
        </>
      ) : <p className="card-spiris-empty">{current.loading ? 'Hämtar överföringsstatus…' : 'Ingen överföring ännu'}</p>}
      {current.error && <p className="card-spiris-error" role="alert">{current.error}</p>}
      {fullJournal && (!job || details) && <Link className="office-link card-spiris-journal" to="/integrations?service=visma"><ExternalLink size={14} aria-hidden="true" /> Öppna fullständig överföringsjournal</Link>}
    </section>
  );
}

/** The same limited projection powers both the status card and the timeline. */
export function CardAuditTimeline({ card, user, users = [], renderText }: {
  card: OfficeCard; user: OfficeUser; users?: OfficeUser[]; renderText: (text: string) => string;
}) {
  const context = useContext(TrackingContext);
  const swish = useCardSwishTracking();
  const job = context?.allowed ? context.current.job : null;
  const audit = card.audit.filter(event => !event.text.startsWith('Pris för') || can(user, 'changePrice'))
    .map((event, index) => ({ ...event, key: 'card-' + index, order: index, integration: false, payment: false, detail: '' }));
  const integrations = (job?.events ?? []).flatMap((event, index) => {
    if (event.type && !headlineTitles[event.type]) return [];
    if (!event.type && event.text.toLocaleLowerCase('sv').includes('leverantör') && !event.text.toLocaleLowerCase('sv').includes('faktura')) return [];
    return [{ at: event.at, text: event.type ? headlineTitles[event.type] : event.text,
      actor: event.actor ?? 'Spiris', key: 'spiris-' + job!.id + '-' + (event.id ?? index),
      order: card.audit.length + index, integration: true, payment: false,
      detail: 'Avräkning AV-' + card.id + '-V' + job!.version + (event.detail ? ' · ' + event.detail : '') }];
  });
  const payments = swishPaymentTrace(swish.permitted && swish.sessionMatches ? swish.jobs : [], users)
    .map(event => ({ ...event, order: card.audit.length + integrations.length + event.order, integration: false, payment: true }));
  const items = [...audit, ...integrations, ...payments].sort((first, second) =>
    (Date.parse(second.at) || 0) - (Date.parse(first.at) || 0) || second.order - first.order);
  return <ol className="office-audit">{items.map(event => <li key={event.key}>
    <i /><div><strong>{renderText(event.text)}</strong>
      {event.detail && <p className="office-small card-spiris-trace-detail">{event.detail}</p>}
      <small>{event.actor} · {time(event.at)}</small>
      {event.integration && <button type="button" className="office-link card-spiris-trace-link" onClick={() => {
        context?.setDetails(true); document.getElementById('card-spiris-status')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}>Visa överföring</button>}
      {event.payment && <button type="button" className="office-link card-spiris-trace-link" onClick={() => {
        const panel = document.getElementById('card-swish-payment');
        const history = panel?.querySelector<HTMLDetailsElement>('.swish-payment-history');
        if (history) history.open = true;
        panel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}>Visa utbetalningshistorik</button>}
    </div>
  </li>)}</ol>;
}
