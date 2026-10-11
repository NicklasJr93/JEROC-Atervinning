import { useEffect, useRef, useState } from 'react';
import { ExternalLink, PlugZap, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { can, type OfficeCard, type OfficeUser } from './model';
import './card-spiris-status.css';

const exportSchema = z.object({
  id: z.string().min(1), cardId: z.number().int().positive(), approvalId: z.string(), version: z.number().int().positive(),
  status: z.string(), startedAt: z.string().nullish(), finishedAt: z.string().nullish(),
  supplierId: z.string().nullish(), draftId: z.string().nullish(),
  error: z.object({ message: z.string() }).nullish(),
  events: z.array(z.object({ at: z.string(), text: z.string(), actor: z.string().optional() })),
});
const responseSchema = z.object({ export: exportSchema.nullable() });
type CardExport = z.infer<typeof exportSchema>;
type PanelState = { scope: string; job?: CardExport | null; loading: boolean; error: string };
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
export default function CardSpirisStatusPanel({ card, user, actualUser }: {
  card: OfficeCard; user: OfficeUser; actualUser: OfficeUser;
}) {
  const allowed = can(user, 'attest') || can(user, 'pay') || can(user, 'reports');
  const attested = ['ready', 'paid', 'balance'].includes(card.status) || card.customerApproval?.status === 'attested';
  const fullJournal = user.level === 'Systemadmin' && actualUser.level === 'Systemadmin' &&
    !user.siteIds && !actualUser.siteIds && can(user, 'integrationsRead');
  const scope = JSON.stringify([card.id, actualUser.id, user.id, user.level, user.permissions, user.siteIds, actualUser.level, actualUser.siteIds]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<PanelState>({ scope: '', loading: true, error: '' });
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
  if (!allowed || !attested && !current.job) return null;
  const job = current.job;
  const events = job?.events.map((event, index) => ({ ...event, index })).sort((first, second) =>
    (Date.parse(first.at) || 0) - (Date.parse(second.at) || 0) || first.index - second.index) ?? [];
  return (
    <section className="office-panel card-spiris-status" aria-label="Spiris-överföring">
      <div className="card-spiris-heading">
        <h2><PlugZap size={20} aria-hidden="true" /> Spiris-överföring</h2>
        <button type="button" className="office-link card-spiris-refresh" onClick={() => setRefresh(value => value + 1)} disabled={current.loading}>
          <RefreshCw size={14} aria-hidden="true" /> Uppdatera
        </button>
      </div>
      {job ? (
        <>
          <div className="card-spiris-summary">
            <span className={`card-spiris-pill ${job.status === 'accepted' ? 'success' : activeStatuses.has(job.status) ? 'pending' : 'warning'}`}>
              {labels[job.status] ?? 'Status behöver kontrolleras'}
            </span>
            <span>Version <strong>{job.version}</strong></span>
            {job.startedAt && <span>Startad <time dateTime={job.startedAt}>{time(job.startedAt)}</time></span>}
            {job.finishedAt && <span>Avslutad <time dateTime={job.finishedAt}>{time(job.finishedAt)}</time></span>}
          </div>
          <dl className="card-spiris-identities">
            <div><dt>Överförings-ID</dt><dd>{job.id}</dd></div>
            {job.supplierId && <div><dt>Leverantörs-ID</dt><dd>{job.supplierId}</dd></div>}
            {job.draftId && <div><dt>Utkast-ID</dt><dd>{job.draftId}</dd></div>}
          </dl>
          {job.error?.message && <p className="card-spiris-error">{job.error.message}</p>}
          {events.length > 0 && <ol className="card-spiris-events" aria-label="Överföringshistorik">
            {events.map(event => <li key={`${event.at}/${event.index}`}>
              <i aria-hidden="true" />
              <div><strong>{event.text}</strong><small>{event.actor && `${event.actor} · `}<time dateTime={event.at}>{time(event.at)}</time></small></div>
            </li>)}
          </ol>}
        </>
      ) : <p className="card-spiris-empty">{current.loading ? 'Hämtar överföringsstatus…' : 'Ingen överföring ännu'}</p>}
      {current.error && <p className="card-spiris-error" role="alert">{current.error}</p>}
      {fullJournal && <Link className="office-link card-spiris-journal" to="/integrations?service=visma"><ExternalLink size={14} aria-hidden="true" /> Öppna fullständig överföringsjournal</Link>}
    </section>
  );
}
