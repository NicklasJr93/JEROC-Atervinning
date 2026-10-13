import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Download, History, LockKeyhole, RefreshCw, RotateCcw, Search, Send, ShieldCheck, Users } from 'lucide-react';
import { can, type OfficeUser } from '../model';
import { OfficePageHeader } from '../OfficePageHeader';
import { Alert, Dialog, Field, Panel, Pill, formatDate, initials, localToday, minuteLabel } from './components/Ui';
import { mayReadPersonnelPresence } from './presence-client';
import { TimeReviewError, downloadTimeReviewCsv, mayApproveTimeReview, mayReadTimeReview, readTimeReviewDetail, readTimeReviewOverview, timeReviewScope, updateTimeReview } from './review-client';
import { timeReviewStatusLabels, type TimeReviewCommand, type TimeReviewDay, type TimeReviewDetail, type TimeReviewIssue, type TimeReviewOverview, type TimeReviewSummary } from './review-types';
import './personal.css';
import './review.css';

export interface TimeReviewWorkspaceProps { user: OfficeUser; actualUser: OfficeUser; selectedSiteId?: string; onNotice: (message: string) => void }
type Result = { kind: 'list'; value: TimeReviewOverview } | { kind: 'detail'; value: TimeReviewDetail };
type ReasonForm = { key: string; action: TimeReviewCommand['action']; reason: string };
const statusTone = { draft: 'grey', submitted: 'blue', returned: 'orange', approved: 'green', reopened: 'orange' } as const;
const hours = (minutes: number) => `${(Math.max(0, Number.isFinite(minutes) ? minutes : 0) / 60).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} h`;
const time = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const fullTime = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const monthName = (month: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00Z`));
const shiftedMonth = (month: string, delta: number) => { const [year, index] = month.split('-').map(Number); const date = new Date(Date.UTC(year, index - 1 + delta, 15)); return date.toISOString().slice(0, 7); };
const issueLabels: Record<string, string> = {
  open_clock_session: 'Ett klockpass är fortfarande öppet.', clock_requires_correction: 'En stämpling behöver rättas.',
  missing_minutes: 'Registrerad tid understiger timkravet.', unallocated_minutes: 'Arbetstid saknar fördelning på uppdrag eller aktivitet.',
  open_order_session: 'Ett arbetspass på en arbetsorder är fortfarande öppet.', current_month: 'Månaden pågår fortfarande.',
  future_month: 'Månaden har inte börjat.', stale_submission: 'Uppgifterna har ändrats efter inlämning.',
  period_not_closed: 'Månaden är inte avslutad.', missing_time: 'Registrerad tid understiger timkravet.', unallocated_time: 'Arbetstid saknar fördelning på uppdrag eller aktivitet.',
};
const issueText = (issue: TimeReviewIssue) => `${issue.date ? `${formatDate(issue.date)}: ` : ''}${issueLabels[issue.code] ?? (issue.severity === 'blocking' ? 'Tidrapporten behöver kompletteras före godkännande.' : 'Kontrollera uppgifterna i tidrapporten.')}`;

function Totals({ summary }: { summary: TimeReviewSummary }) {
  return <div className="hr-review-kpis"><div><span>Timkrav</span><strong>{hours(summary.expectedMinutes)}</strong></div><div><span>Arbetad tid</span><strong>{hours(summary.recordedMinutes)}</strong></div><div><span>Frånvaro</span><strong>{hours(summary.absenceMinutes)}</strong></div><div><span>Saknade timmar</span><strong>{hours(summary.missingMinutes)}</strong></div><div><span>Fördelad tid</span><strong>{hours(summary.allocatedMinutes)}</strong></div><div><span>Ofördelad tid</span><strong>{hours(summary.unallocatedMinutes)}</strong></div></div>;
}
function DayDetail({ day }: { day: TimeReviewDay }) {
  return <div className="hr-review-day-detail"><div className="hr-review-heading"><h2>{formatDate(day.date)}</h2><Pill tone="grey">{day.timeSource === 'clock' ? 'Stämpelklocka' : 'Arbetsorder och manuell tid'}</Pill></div><div className="hr-grid two">
    <Panel title="Stämplade pass" icon={<Clock3 size={17} />}>{day.clockSessions.length ? <ul className="hr-review-clock-list">{day.clockSessions.map(pass => <li key={pass.id}><div><strong>{time(pass.startedAt)} – {pass.endedAt ? time(pass.endedAt) : 'Pågående'}</strong><small>{formatDate(pass.startedAt)}{pass.endedAt && pass.startedAt.slice(0, 10) !== pass.endedAt.slice(0, 10) ? ` – ${formatDate(pass.endedAt)}` : ''}</small>{pass.breaks.map((pause, index) => <p key={`${pause.startedAt}/${index}`}>Rast {time(pause.startedAt)} – {pause.endedAt ? time(pause.endedAt) : 'pågår'}</p>)}{pass.requiresCorrection && <Pill tone="orange">Behöver rättas</Pill>}</div><strong>{hours((pass.dayWorkSeconds ?? pass.workSeconds) / 60)}</strong></li>)}</ul> : <p className="hr-muted">Inga stämplade pass för dagen.</p>}</Panel>
    <Panel title={day.timeSource === 'clock' ? 'Fördelning av arbetstid' : 'Arbetsorder och manuell tid'} icon={<CalendarDays size={17} />}>{day.entries.length ? <ul className="hr-review-allocation-list">{day.entries.map(entry => <li key={entry.id}><div><strong>{entry.activity || (entry.source === 'order' ? 'Arbetsorder' : 'Manuell tid')}</strong><small>{entry.startedAt ? time(entry.startedAt) : minuteLabel(entry.startMinute)} – {entry.endedAt ? time(entry.endedAt) : minuteLabel(entry.endMinute)}{entry.breakMinutes > 0 && ` · ${entry.breakMinutes} min rast`}</small>{entry.orderId && <p>Arbetsorder {entry.orderId}</p>}</div><strong>{hours(entry.minutes)}</strong></li>)}</ul> : <p className="hr-muted">Ingen tid har fördelats eller registrerats på aktiviteter.</p>}{day.timeSource === 'clock' && <p className="hr-muted">Fördelad tid räknas inom stämplad arbetstid.</p>}</Panel>
  </div></div>;
}

export default function TimeReviewWorkspace({ user, actualUser, selectedSiteId = 'all', onNotice }: TimeReviewWorkspaceProps) {
  const navigate = useNavigate(), [search, setSearch] = useSearchParams();
  const currentMonth = localToday().slice(0, 7), rawMonth = search.get('month') ?? '';
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) ? rawMonth : currentMonth;
  const personId = search.get('personId') ?? '';
  const siteId = selectedSiteId !== 'all' ? selectedSiteId : search.get('siteId') ?? 'all';
  const currentScope = timeReviewScope(user, actualUser), scope = useMemo(() => currentScope, [currentScope.key]);
  const readable = mayReadTimeReview(user, actualUser), writable = mayApproveTimeReview(user, actualUser);
  const key = JSON.stringify([scope.key, month, siteId, personId]);
  const keyRef = useRef(key); keyRef.current = key;
  const readableRef = useRef(readable); readableRef.current = readable;
  const mounted = useRef(true), serial = useRef(0), controller = useRef<AbortController | undefined>(undefined), exportController = useRef<AbortController | undefined>(undefined);
  const retry = useRef<{ key: string; fingerprint: string; requestId: string } | undefined>(undefined);
  const [stored, setStored] = useState<{ key: string; value: Result }>();
  const [activity, setActivity] = useState<{ key: string; kind?: 'read' | 'write'; error?: string; refreshNeeded?: boolean }>();
  const [exportActivity, setExportActivity] = useState<{ key: string; pending: boolean; error?: string }>();
  const [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('all'), [selectedDate, setSelectedDate] = useState('');
  const [reasonForm, setReasonForm] = useState<ReasonForm>();
  const result = readable && stored?.key === key ? stored.value : undefined;
  const overview = result?.kind === 'list' ? result.value : undefined, detail = result?.kind === 'detail' ? result.value : undefined;
  const pending = activity?.key === key ? activity.kind : undefined, error = activity?.key === key ? activity.error : undefined;
  const mustRefresh = activity?.key === key && activity.refreshNeeded;
  const exporting = exportActivity?.key === key && exportActivity.pending, exportError = exportActivity?.key === key ? exportActivity.error : undefined;
  const modal = readable && reasonForm?.key === key ? reasonForm : undefined;
  const modalRef = useRef(modal); modalRef.current = modal;
  const busy = pending === 'write';
  const approvalReasonRequired = Boolean(detail && (detail.capabilities.approvalReasonRequired || detail.period.summary.missingMinutes > 0 || detail.period.summary.unallocatedMinutes > 0));
  const validScope = useCallback(() => mounted.current && readableRef.current && keyRef.current === key && timeReviewScope(user, actualUser).key === scope.key, [key, scope]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++serial.current; controller.current?.abort(); exportController.current?.abort(); }; }, []);
  useEffect(() => { setQuery(''); setStatusFilter('all'); }, [scope.key, month, siteId]);

  const load = useCallback(async () => {
    if (!readableRef.current || document.hidden || controller.current || modalRef.current) return;
    const request = new AbortController(), version = ++serial.current; controller.current = request;
    const valid = () => validScope() && !request.signal.aborted && version === serial.current;
    setActivity({ key, kind: 'read' });
    try {
      const value: Result = personId ? { kind: 'detail', value: await readTimeReviewDetail(scope, personId, month, siteId, request.signal) }
        : { kind: 'list', value: await readTimeReviewOverview(scope, month, siteId, request.signal) };
      if (!valid()) return;
      if (value.value.month !== month || value.kind === 'detail' && value.value.person.id !== personId) throw new Error('Svaret gäller en annan tidrapport. Öppna månaden igen.');
      setStored({ key, value }); setReasonForm(undefined); retry.current = undefined;
    } catch (reason) {
      if (!valid()) return;
      if (reason instanceof TimeReviewError && [401, 403].includes(reason.status)) { setStored(undefined); setReasonForm(undefined); }
      setActivity({ key, error: reason instanceof Error ? reason.message : 'Tidrapporterna kunde inte hämtas.' });
    } finally { if (valid()) setActivity(previous => previous?.key === key ? { ...previous, kind: undefined } : previous); if (controller.current === request) controller.current = undefined; }
  }, [key, scope, personId, month, siteId, validScope]);
  useEffect(() => {
    ++serial.current; controller.current?.abort(); controller.current = undefined; exportController.current?.abort(); exportController.current = undefined;
    setStored(undefined); setActivity(undefined); setExportActivity(undefined); setReasonForm(undefined); setSelectedDate(''); retry.current = undefined;
    if (readable) void load();
    const foreground = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', foreground);
    return () => { ++serial.current; controller.current?.abort(); controller.current = undefined; exportController.current?.abort(); exportController.current = undefined; document.removeEventListener('visibilitychange', foreground); };
  }, [load, readable]);

  const choose = (patch: { month?: string; siteId?: string; personId?: string }) => {
    const next = new URLSearchParams(search);
    for (const [field, value] of Object.entries(patch)) if (value && value !== 'all') next.set(field, value); else next.delete(field);
    setSearch(next);
  };
  const mutate = async (action: TimeReviewCommand['action'], reason?: string) => {
    if (!writable || !detail || controller.current || busy || mustRefresh) return;
    const allowed = action === 'review.approve' ? detail.capabilities.canApprove && detail.period.isClosed && detail.review.status === 'submitted'
      : action === 'review.return' ? detail.capabilities.canReturn : detail.capabilities.canReopen;
    if (!allowed) return;
    if (action === 'review.approve' && approvalReasonRequired && (reason?.trim().length ?? 0) < 3) return;
    const base = { action, personId, month, revision: detail.review.revision, ...(reason ? { reason: reason.trim() } : {}) };
    const fingerprint = JSON.stringify(base);
    if (retry.current?.key !== key || retry.current.fingerprint !== fingerprint) retry.current = { key, fingerprint, requestId: crypto.randomUUID() };
    const request = new AbortController(), version = ++serial.current; controller.current = request;
    const valid = () => validScope() && !request.signal.aborted && version === serial.current;
    setActivity({ key, kind: 'write' });
    try {
      const next = await updateTimeReview(scope, { ...base, requestId: retry.current.requestId }, siteId, request.signal);
      if (!valid()) return;
      if (next.month !== month || next.person.id !== personId) throw new Error('Svaret gäller en annan person. Hämta aktuell tidrapport.');
      setStored({ key, value: { kind: 'detail', value: next } }); setReasonForm(undefined); retry.current = undefined;
      onNotice(action === 'review.approve' ? 'Månaden är godkänd. Den godkända versionen är sparad.' : action === 'review.return' ? 'Tidrapporten är återlämnad med din kommentar.' : 'Månaden är återöppnad. Tidigare godkänd version finns kvar.');
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof TimeReviewError && [401, 403].includes(failure.status)) { setStored(undefined); setReasonForm(undefined); }
      setActivity({ key, error: failure instanceof Error ? failure.message : 'Tidrapporten kunde inte uppdateras.', refreshNeeded: failure instanceof TimeReviewError && failure.status === 409 });
    } finally { if (valid()) setActivity(previous => previous?.key === key ? { ...previous, kind: undefined } : previous); if (controller.current === request) controller.current = undefined; }
  };
  const download = async (version?: number) => {
    if (!readable || exportController.current || !(version ? detail?.capabilities.canExportHistory : detail?.capabilities.canExport || overview?.capabilities.canExport)) return;
    const request = new AbortController(); exportController.current = request; setExportActivity({ key, pending: true });
    const valid = () => validScope() && !request.signal.aborted;
    try {
      const file = await downloadTimeReviewCsv(scope, { month, siteId, ...(personId ? { personId } : {}), ...(version ? { version } : {}) }, request.signal);
      if (!valid()) return;
      const url = URL.createObjectURL(file.blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof TimeReviewError && [401, 403].includes(failure.status)) { setStored(undefined); setReasonForm(undefined); }
      setExportActivity({ key, pending: false, error: failure instanceof Error ? failure.message : 'CSV-filen kunde inte hämtas.' });
    } finally { if (valid()) setExportActivity(previous => previous?.key === key ? { ...previous, pending: false } : previous); if (exportController.current === request) exportController.current = undefined; }
  };

  const serverMonth = (detail?.today ?? overview?.today ?? localToday()).slice(0, 7);
  const isCurrent = month === serverMonth, isFuture = month > serverMonth;
  const people = (overview?.people ?? []).filter(person => (statusFilter === 'all' || person.review.status === statusFilter)
    && [person.name, person.team, ...person.siteIds.map(id => overview?.sites.find(site => site.id === id)?.name ?? '')].join(' ').toLocaleLowerCase('sv-SE').includes(query.trim().toLocaleLowerCase('sv-SE')));
  const day = detail?.period.days.find(value => value.date === selectedDate) ?? detail?.period.days.find(value => value.entries.length || value.clockSessions.length) ?? detail?.period.days[0];
  const navigation = <nav className="hr-section-nav" aria-label="Personal"><button disabled={busy} onClick={() => navigate('/personnel')}>Alla personer</button>{mayReadPersonnelPresence(user, actualUser) && <button disabled={busy} onClick={() => navigate('/personnel/presence')}>Närvaro</button>}<button className="active" aria-current="page" onClick={() => choose({ personId: '' })}>Månadsgranskning</button><button disabled={busy} onClick={() => navigate('/personnel/tasks')}>Bemanning att lösa</button>{[user, actualUser].every(person => can(person, 'users')) && <button disabled={busy} onClick={() => navigate('/personnel/accounts')}>Konton</button>}</nav>;
  const controls = <div className="hr-review-controls"><button className="office-link" aria-label="Föregående månad" disabled={busy} onClick={() => choose({ month: shiftedMonth(month, -1), personId: '' })}><ChevronLeft size={17} /></button><input type="month" aria-label="Granskningsmånad" max={currentMonth} value={month} disabled={busy} onChange={event => { if (event.target.value) choose({ month: event.target.value, personId: '' }); }} /><button className="office-link" aria-label="Nästa månad" disabled={busy || month >= currentMonth} onClick={() => choose({ month: shiftedMonth(month, 1), personId: '' })}><ChevronRight size={17} /></button>
    {!personId && <><label className="hr-search"><Search size={16} /><input aria-label="Sök tidrapporter" placeholder="Sök person, team eller anläggning…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Tidrapportens status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">Alla statusar</option>{Object.entries(timeReviewStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Tidrapportens anläggning" disabled={selectedSiteId !== 'all'} value={siteId} onChange={event => choose({ siteId: event.target.value })}><option value="all">Alla anläggningar</option>{overview?.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></>}
  </div>;
  if (!readable) return <div className="hr-workspace hr-review-workspace"><Alert tone="orange"><LockKeyhole size={17} />Du saknar behörighet att granska personalens månadsrapporter.</Alert></div>;
  return <section className="hr-workspace hr-review-workspace"><OfficePageHeader className="hr-page-header" controls={controls}>{navigation}{personId && <button className="office-back" disabled={busy} onClick={() => choose({ personId: '' })}><ArrowLeft size={16} />Till månadens tidrapporter</button>}<div className="office-page-title hr-review-title"><div><h1>{detail?.person.name ?? (personId ? 'Tidrapport' : 'Månadsgranskning')}</h1><p>{monthName(month)}{detail?.person.team ? ` · ${detail.person.team}` : ''}</p></div><div className="hr-review-actions">{(isCurrent || isFuture) && <Pill tone="blue">{isFuture ? 'Kommande månad' : 'Pågående månad'}</Pill>}<button className="office-btn outline" disabled={!!pending} onClick={() => void load()}><RefreshCw size={15} className={pending === 'read' ? 'hr-review-spin' : ''} />Uppdatera</button>{!personId && overview?.capabilities.canExport && <button className="office-btn outline" disabled={!!exporting} onClick={() => void download()}><Download size={15} />{exporting ? 'Hämtar CSV…' : 'Exportera godkända'}</button>}</div></div></OfficePageHeader>
    {error && !modal && <Alert tone="red">{error}</Alert>}{exportError && <Alert tone="red">{exportError}</Alert>}{mustRefresh && <Alert tone="orange">Tidrapporten har ändrats. Uppdatera uppgifterna före nästa åtgärd.</Alert>}
    {!result ? <div className="office-panel hr-review-empty">{pending === 'read' ? <><RefreshCw size={24} className="hr-review-spin" /><strong>Hämtar tidrapporter…</strong></> : <><CalendarDays size={27} /><strong>Tidrapporten kunde inte hämtas.</strong><button className="office-btn outline" onClick={() => void load()}>Försök igen</button></>}</div> : overview ? <>
      {(isCurrent || isFuture) && <Alert>{isFuture ? 'Månaden har inte börjat.' : 'Pågående månad visas som förhandsgranskning.'} Godkännande görs först när månaden är avslutad.</Alert>}
      <div className="hr-metrics"><ReviewMetric label="Inlämnade" value={overview.summary.submitted} icon={<Send size={21} />} /><ReviewMetric label="Godkända" value={overview.summary.approved} icon={<ShieldCheck size={21} />} /><ReviewMetric label="Återlämnade" value={overview.summary.returned} icon={<RotateCcw size={21} />} /><ReviewMetric label="Utkast / återöppnade" value={overview.summary.draft + overview.summary.reopened} icon={<CalendarDays size={21} />} /></div>
      <Panel title="Månadens tidrapporter" actions={<span className="hr-muted">{people.length} av {overview.summary.total} personer</span>}>{people.length ? <div className="hr-table-scroll"><table className="hr-table hr-review-table"><thead><tr><th>Person / team</th><th>Timkrav</th><th>Arbetat</th><th>Frånvaro</th><th>Saknas</th><th>Ofördelat</th><th>Status</th><th><span className="hr-review-sr-only">Öppna tidrapport</span></th></tr></thead><tbody>{people.map(person => <tr key={person.personId} tabIndex={0} aria-label={`Öppna tidrapport för ${person.name}`} onClick={() => choose({ personId: person.personId })} onKeyDown={event => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); choose({ personId: person.personId }); } }}><td><div className="hr-review-person"><span className="hr-avatar">{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.team || 'Inget team'}</small></div></div></td><td className="numeric">{hours(person.summary.expectedMinutes)}</td><td className="numeric">{hours(person.summary.recordedMinutes)}</td><td className="numeric">{hours(person.summary.absenceMinutes)}</td><td className={`numeric${person.summary.missingMinutes > 0 ? ' warning' : ''}`}>{hours(person.summary.missingMinutes)}</td><td className="numeric">{hours(person.summary.unallocatedMinutes)}</td><td><Pill tone={statusTone[person.review.status]}>{timeReviewStatusLabels[person.review.status]}</Pill>{person.issues.some(issue => issue.severity === 'blocking') && <small>Behöver kompletteras</small>}{person.review.stale && <small>Ändrad efter inlämning</small>}</td><td className="hr-review-open"><ChevronRight size={16} /></td></tr>)}</tbody></table></div> : <div className="hr-review-empty"><Users size={26} /><strong>{overview.people.length ? 'Ingen tidrapport matchar filtret.' : 'Ingen personal finns i valda anläggningar.'}</strong></div>}</Panel>
    </> : detail ? <>
      <div className="hr-review-state"><ShieldCheck size={22} /><div><h2>{timeReviewStatusLabels[detail.review.status]}{detail.review.version > 0 ? ` · version ${detail.review.version}` : ''}</h2><Pill tone={statusTone[detail.review.status]}>{detail.period.source === 'approved' ? 'Godkänd och sparad version' : detail.period.source === 'submitted' ? 'Inlämnat underlag' : 'Aktuella uppgifter'}</Pill>{detail.review.reason && <p>{detail.review.reason}</p>}{detail.review.approvedAt && <p>Godkänd {fullTime(detail.review.approvedAt)}</p>}{!detail.period.isClosed && <p>{isFuture ? 'Månaden har inte börjat.' : 'Pågående månad.'} Underlaget kan granskas men ännu inte godkännas.</p>}</div><div className="hr-review-actions">
        {detail.capabilities.canExport && <button className="office-btn outline" disabled={!!exporting || busy} onClick={() => void download()}><Download size={15} />Godkänd CSV</button>}
        {writable && detail.review.status === 'submitted' && <><button className="office-btn outline" disabled={busy || !!pending || mustRefresh || !detail.capabilities.canReturn} onClick={() => setReasonForm({ key, action: 'review.return', reason: '' })}><RotateCcw size={15} />Återlämna</button><button className="office-btn" disabled={busy || !!pending || mustRefresh || !detail.period.isClosed || !detail.capabilities.canApprove} onClick={() => setReasonForm({ key, action: 'review.approve', reason: '' })}><CheckCircle2 size={15} />Godkänn månad</button></>}
        {writable && detail.review.status === 'approved' && <button className="office-btn outline" disabled={busy || !!pending || mustRefresh || !detail.capabilities.canReopen} onClick={() => setReasonForm({ key, action: 'review.reopen', reason: '' })}><RotateCcw size={15} />Återöppna</button>}
      </div></div>
      {detail.review.stale && <Alert tone="orange">Uppgifterna har ändrats efter inlämningen. Rapporten behöver lämnas in på nytt före godkännande.</Alert>}
      {detail.period.issues.length > 0 && <Alert tone={detail.period.issues.some(issue => issue.severity === 'blocking') ? 'orange' : 'blue'}><AlertCircle size={17} /><div>{detail.period.issues.map((issue, index) => <p key={`${issue.code}/${issue.date}/${index}`}>{issueText(issue)}</p>)}</div></Alert>}
      <Totals summary={detail.period.summary} />
      <Panel title="Dagar i månaden" icon={<CalendarDays size={18} />}><div className="hr-table-scroll"><table className="hr-table hr-review-day-table"><thead><tr><th>Datum</th><th>Timkrav</th><th>Arbetat</th><th>Frånvaro</th><th>Saknas</th><th>Ofördelat</th><th>Status</th></tr></thead><tbody>{detail.period.days.map(value => <tr key={value.date} className={day?.date === value.date ? 'selected' : undefined}><td><button className="office-link" onClick={() => setSelectedDate(value.date)}>{formatDate(value.date)}</button></td><td className="numeric">{hours(value.expectedMinutes)}</td><td className="numeric">{hours(value.recordedMinutes)}</td><td className="numeric">{hours(value.absenceMinutes)}</td><td className={`numeric${value.missingMinutes > 0 ? ' warning' : ''}`}>{hours(value.missingMinutes)}</td><td className="numeric">{hours(value.unallocatedMinutes)}</td><td><Pill tone={value.date > detail.today ? 'grey' : value.missingMinutes > 0 ? 'orange' : 'green'}>{value.date > detail.today ? 'Planerad' : value.status === 'not_required' ? 'Inget timkrav' : value.missingMinutes > 0 ? 'Saknar tid' : 'Komplett'}</Pill></td></tr>)}</tbody></table></div>{day && <DayDetail day={day} />}</Panel>
      {detail.versions.some(version => version.approvedAt) && <Panel title="Godkända versioner" icon={<ShieldCheck size={18} />}><div className="hr-table-scroll"><table className="hr-table"><thead><tr><th>Version</th><th>Godkänd</th><th>Arbetad tid</th><th>Frånvaro</th><th /></tr></thead><tbody>{detail.versions.filter(version => version.approvedAt).map(version => <tr key={version.version}><td><strong>Version {version.version}</strong></td><td>{fullTime(version.approvedAt!)}</td><td>{hours(version.summary.recordedMinutes)}</td><td>{hours(version.summary.absenceMinutes)}</td><td>{detail.capabilities.canExportHistory && <button className="office-link" disabled={!!exporting} onClick={() => void download(version.version)}><Download size={14} />CSV version {version.version}</button>}</td></tr>)}</tbody></table></div><p className="hr-muted">Godkända versioner bevaras vid återöppning.</p></Panel>}
      <Panel title="Granskningshistorik" icon={<History size={18} />}>{detail.history.length ? <ol className="hr-review-history">{detail.history.map(event => <li key={event.id}><i /><div><strong>{timeReviewStatusLabels[event.toStatus]}{event.version > 0 ? ` · version ${event.version}` : ''}</strong><time dateTime={event.at}>{fullTime(event.at)}</time>{event.reason && <p>{event.reason}</p>}</div></li>)}</ol> : <p className="hr-muted">Inga granskningshändelser ännu.</p>}</Panel>
    </> : null}
    {modal && <Dialog title={modal.action === 'review.approve' ? 'Godkänn månadsrapport' : modal.action === 'review.return' ? 'Återlämna tidrapport' : 'Återöppna godkänd månad'} description={detail ? `${detail.person.name} · ${monthName(month)}` : undefined} onClose={() => { if (!busy) setReasonForm(undefined); }}>
      <form onSubmit={event => {
        event.preventDefault();
        const needsReason = modal.action !== 'review.approve' || approvalReasonRequired;
        if (!needsReason || modal.reason.trim().length >= 3) void mutate(modal.action, modal.reason);
      }}>
        {modal.action === 'review.approve' && detail && <><Totals summary={detail.period.summary} />{approvalReasonRequired ? <Alert tone="orange">{detail.period.issues.filter(issue => issue.severity === 'warning').map((issue, index) => <p key={`${issue.code}/${index}`}>{issueText(issue)}</p>)}Ange en motivering för att godkänna saknade eller ofördelade timmar.</Alert> : <Alert>Den inlämnade versionen sparas som godkänd. Kontrollera sammanställningen före godkännande.</Alert>}</>}
        <Field label={modal.action === 'review.approve' ? approvalReasonRequired ? 'Motivering till godkännande' : 'Kommentar · valfritt' : modal.action === 'review.return' ? 'Kommentar till den anställde' : 'Anledning till återöppning'}>
          <textarea required={modal.action !== 'review.approve' || approvalReasonRequired} minLength={3} maxLength={1000} rows={4} value={modal.reason} disabled={busy || mustRefresh} onChange={event => setReasonForm({ ...modal, reason: event.target.value })} />
        </Field>
        {modal.action === 'review.reopen' && <Alert>Den tidigare godkända versionen bevaras. Ändrade uppgifter måste lämnas in och godkännas på nytt.</Alert>}
        {error && <Alert tone="red">{error}</Alert>}
        <div className="hr-dialog-actions"><button type="button" className="office-btn outline" disabled={busy} onClick={() => setReasonForm(undefined)}>Avbryt</button><button className="office-btn" type="submit" disabled={busy || mustRefresh || ((modal.action !== 'review.approve' || approvalReasonRequired || modal.reason.trim().length > 0) && modal.reason.trim().length < 3)}>{busy ? 'Sparar…' : modal.action === 'review.approve' ? 'Godkänn och spara månad' : modal.action === 'review.return' ? 'Återlämna rapport' : 'Återöppna månad'}</button></div>
      </form>
    </Dialog>}
  </section>;
}

function ReviewMetric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return <div className="hr-metric"><span className="hr-metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><small>Vald månad</small></div></div>;
}
