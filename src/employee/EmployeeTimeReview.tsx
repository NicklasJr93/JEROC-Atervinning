import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, CheckCircle2, ChevronRight, ClipboardCheck, History, LoaderCircle, LockKeyhole, RefreshCw, Send, Undo2 } from 'lucide-react';
import { Button, Nav, Notice } from '../components';
import { EmployeeError, employeeError, employeeRequest, stockholmDay, useEmployee } from './EmployeeProvider';
import { employeeCompanyId } from './cache';
import { capitalize, fullDayLabel, hoursLabel } from './Calendar';
import { parseEmployeeTimeReview, type EmployeeReviewCommand, type EmployeeTimeReview } from './employee-time-review-types';
import type { TimeReviewHistory, TimeReviewStatus } from '../office/personnel/review-types';
import './employee.css';
import './employee-time-review.css';

const statusLabels: Record<TimeReviewStatus, string> = { draft: 'Utkast', submitted: 'Skickad till chef', returned: 'Återlämnad av chef', approved: 'Godkänd av chef', reopened: 'Öppnad för rättelse' };
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthLabel = (month: string) => capitalize(new Intl.DateTimeFormat('sv-SE', { month: 'long', year: 'numeric', timeZone: 'Europe/Stockholm' }).format(new Date(`${month}-01T12:00:00Z`)));
const at = (value: string) => new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date(value));
const editableStatus = (status: TimeReviewStatus) => ['draft', 'returned', 'reopened'].includes(status);
function eventLabel(event: TimeReviewHistory) {
  if (event.toStatus === 'draft' && event.fromStatus === 'submitted') return 'Återtagen för rättelse';
  return statusLabels[event.toStatus];
}
function issueLabel(code: string) {
  return ({ missing_time: 'Registrerad tid behöver kompletteras.', open_clock_session: 'Ett stämplat pass behöver avslutas eller rättas.',
    clock_requires_correction: 'En stämpling behöver rättas.', unallocated_time: 'Arbetad tid behöver fördelas på aktivitet eller uppdrag.',
    open_order_session: 'Ett pågående uppdrag behöver avslutas.', period_not_closed: 'Månaden pågår och visas som förhandsvisning.' } as Record<string, string>)[code] ?? 'Dagens tiduppgifter behöver kontrolleras.';
}

export default function EmployeeTimeReview() {
  const { session, overview, sessionGeneration } = useEmployee();
  const navigate = useNavigate(), [search, setSearch] = useSearchParams();
  const proposed = search.get('month');
  const month = proposed && monthPattern.test(proposed) ? proposed : (overview?.today ?? stockholmDay()).slice(0, 7);
  const companyId = employeeCompanyId(session?.companyId), personId = session?.person.id;
  const boundSession = useRef({ session, generation: sessionGeneration });
  if (boundSession.current.session !== session) boundSession.current = { session, generation: sessionGeneration };
  // A login/logout starts by invalidating generation while the old session
  // object may still be present. Do not start another private read for it.
  const readable = Boolean(session && boundSession.current.generation === sessionGeneration
    && session.capabilities.employeeTime && session.person.kind !== 'external');
  const scope = useMemo(() => JSON.stringify([companyId, personId, sessionGeneration, readable]), [companyId, personId, sessionGeneration, readable]);
  const key = `${scope}/${month}`, keyRef = useRef(key); keyRef.current = key;
  const mounted = useRef(true), sequence = useRef(0), readController = useRef<AbortController | undefined>(undefined), writeController = useRef<AbortController | undefined>(undefined);
  const retry = useRef<{ key: string; fingerprint: string; requestId: string } | undefined>(undefined);
  const [stored, setStored] = useState<{ key: string; value: EmployeeTimeReview }>();
  const [activity, setActivity] = useState<{ key: string; kind?: 'read' | 'write'; error?: string; notice?: string; mustReload?: boolean }>();
  const data = readable && stored?.key === key ? stored.value : undefined;
  const pending = activity?.key === key ? activity.kind : undefined, error = activity?.key === key ? activity.error : undefined;
  const notice = activity?.key === key ? activity.notice : undefined, mustReload = activity?.key === key && activity.mustReload;
  const locked = data?.review.status === 'submitted' || data?.review.status === 'approved';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; readController.current?.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => { ++sequence.current; readController.current?.abort(); writeController.current?.abort(); readController.current = undefined; writeController.current = undefined; retry.current = undefined; setStored(undefined); setActivity(undefined); }, [key]);
  const request = useCallback(async (signal: AbortSignal, command?: EmployeeReviewCommand) => {
    const result = parseEmployeeTimeReview(await employeeRequest<unknown>(`/time-review?${new URLSearchParams({ month })}`, command,
      { signal, expectedCompanyId: companyId }));
    if (result.person.id !== personId || result.review.personId !== personId || result.month !== month || result.review.month !== month || result.period.month !== month)
      throw new Error('Svaret tillhör en annan person eller månad. Hämta din månadsrapport igen.');
    return result;
  }, [companyId, personId, month]);
  const load = useCallback(async () => {
    if (!readable || writeController.current) return;
    readController.current?.abort();
    const controller = new AbortController(), version = ++sequence.current; readController.current = controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException('Månadsrapporten svarade inte i tid. Försök igen.', 'TimeoutError')), 30_000);
    const current = () => mounted.current && keyRef.current === key && version === sequence.current && readController.current === controller;
    setActivity({ key, kind: 'read' });
    try {
      const value = await request(controller.signal);
      if (!current() || controller.signal.aborted) return;
      setStored(previous => previous?.key === key && previous.value.review.revision > value.review.revision ? previous : { key, value });
    } catch (failure) {
      if (!current()) return;
      const denied = failure instanceof EmployeeError && ([401, 403].includes(failure.status) || failure.code === 'company_selection_changed');
      if (denied) { setStored(undefined); retry.current = undefined; window.dispatchEvent(new Event('jeroc:employee-session-check')); }
      setActivity({ key, error: controller.signal.aborted ? 'Månadsrapporten svarade inte i tid. Försök igen.' : employeeError(failure) });
    } finally {
      window.clearTimeout(timer);
      if (current()) setActivity(previous => previous?.key === key ? { ...previous, kind: undefined } : previous);
      if (readController.current === controller) readController.current = undefined;
    }
  }, [key, readable, request]);
  useEffect(() => { void load(); return () => readController.current?.abort(); }, [load]);
  useEffect(() => { const visible = () => { if (!document.hidden) void load(); }; document.addEventListener('visibilitychange', visible); window.addEventListener('online', visible); return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); }; }, [load]);
  async function mutate(action: EmployeeReviewCommand['action']) {
    if (!data || pending || mustReload || writeController.current || !readable
      || action === 'review.submit' && (!data.period.isClosed || !data.capabilities.canSubmit)
      || action === 'review.withdraw' && !data.capabilities.canWithdraw) return;
    if (navigator.onLine === false) { setActivity({ key, error: 'Anslut till internet för att skicka eller återta månadsrapporten.' }); return; }
    const fingerprint = JSON.stringify([action, month, data.review.revision]);
    if (retry.current?.key !== key || retry.current.fingerprint !== fingerprint) retry.current = { key, fingerprint, requestId: crypto.randomUUID() };
    const command: EmployeeReviewCommand = { action, month, revision: data.review.revision, requestId: retry.current.requestId };
    readController.current?.abort(); ++sequence.current;
    const controller = new AbortController(); writeController.current = controller;
    const timer = window.setTimeout(() => controller.abort(new DOMException('Kontrollera rapportens status innan du försöker igen.', 'TimeoutError')), 30_000);
    const current = () => mounted.current && keyRef.current === key && writeController.current === controller;
    setActivity({ key, kind: 'write' });
    try {
      const value = await request(controller.signal, command);
      if (!current() || controller.signal.aborted) return;
      setStored({ key, value }); retry.current = undefined;
      setActivity({ key, notice: action === 'review.submit' ? 'Din månadsrapport är skickad till chef.' : 'Rapporten är återtagen för rättelse.' });
      window.dispatchEvent(new Event('jeroc:employee-session-check'));
    } catch (failure) {
      if (!current()) return;
      const denied = failure instanceof EmployeeError && ([401, 403].includes(failure.status) || failure.code === 'company_selection_changed');
      if (denied) { setStored(undefined); retry.current = undefined; window.dispatchEvent(new Event('jeroc:employee-session-check')); }
      setActivity({ key, mustReload: true, error: controller.signal.aborted ? 'Kontrollera rapportens status innan du försöker igen.' : employeeError(failure) });
    } finally { window.clearTimeout(timer); if (current()) setActivity(previous => previous?.key === key ? { ...previous, kind: undefined } : previous); if (writeController.current === controller) writeController.current = undefined; }
  }
  const visibleIssues = data?.period.issues.filter(issue => issue.code !== 'period_not_closed') ?? [];
  const blockedIssues = visibleIssues.filter(issue => issue.severity === 'blocking');
  const canOpenDay = Boolean(data && data.period.isClosed && editableStatus(data.review.status) && !pending && !mustReload);
  return <><main className="employee-page employee-review-page"><header className="employee-page-heading"><button className="icon-button" aria-label="Tillbaka till tidrapportering" onClick={() => navigate('/time')}><ArrowLeft size={22} /></button><div className="employee-heading-copy"><h1>Min månadsrapport</h1><p>Din arbetstid och chefens granskning.</p></div><button className="icon-button" aria-label="Uppdatera min månadsrapport" disabled={Boolean(pending) || !readable} onClick={() => void load()}><RefreshCw size={20} className={pending === 'read' ? 'employee-review-spinner' : undefined} /></button></header>
    <div className="employee-review-month"><CalendarDays size={21} /><label>Månad<input type="month" value={month} max={(data?.today ?? overview?.today ?? stockholmDay()).slice(0, 7)} disabled={pending === 'write'} onChange={event => { if (monthPattern.test(event.target.value)) setSearch({ month: event.target.value }); }} /></label></div>
    {error && <Notice tone="red">{error}</Notice>}{notice && <Notice tone="green">{notice}</Notice>}
    {mustReload && <Notice tone="amber">Hämta rapportens aktuella status före nästa ändring.<button className="employee-text" disabled={Boolean(pending)} onClick={() => void load()}>Hämta aktuell månadsrapport<RefreshCw size={16} /></button></Notice>}
    {!data ? <div className="employee-review-empty">{pending === 'read' ? <LoaderCircle size={28} className="employee-review-spinner" /> : <ClipboardCheck size={28} />}<p>{!readable ? 'Logga in på ditt personalkonto för att se din månadsrapport.' : pending === 'read' ? 'Hämtar din månadsrapport…' : 'Din månadsrapport kunde inte hämtas.'}</p>{readable && !pending && <button className="employee-text" onClick={() => void load()}>Försök igen</button>}</div> : <>
      <section className="employee-card" aria-label="Månadens sammanställning"><div className="employee-review-status">{data.review.status === 'approved' ? <CheckCircle2 size={26} /> : <ClipboardCheck size={26} />}<div><h2>{monthLabel(data.month)}</h2><p>{data.person.name}{data.review.version > 0 ? ` · Version ${data.review.version}` : ''}</p></div><span className={`employee-review-pill ${data.review.status}`}>{statusLabels[data.review.status]}</span></div>
        <div className="employee-review-summary"><div className="registered"><span>Registrerad arbetstid</span><strong>{hoursLabel(data.period.summary.recordedMinutes)}</strong></div><div><span>Timkrav</span><strong>{hoursLabel(data.period.summary.expectedMinutes)}</strong></div><div className={data.period.summary.missingMinutes ? 'missing' : undefined}><span>Tid saknas</span><strong>{hoursLabel(data.period.summary.missingMinutes)}</strong></div><div><span>Rast</span><strong>{hoursLabel(data.period.summary.breakMinutes)}</strong></div></div>
        {!data.period.isClosed && <Notice>Pågående månad · förhandsvisning. Rapporten kan skickas till chef när månaden är avslutad.</Notice>}
        {locked && <p className="employee-review-message"><LockKeyhole size={15} /> {data.review.status === 'approved' ? 'Den godkända perioden är låst. Kontakta din chef om något behöver rättas.' : 'Dina tidsregistreringar är låsta medan rapporten väntar på granskning.'}</p>}
        {data.review.status === 'reopened' && <Notice tone="amber">Öppnad för rättelse. Det tidigare godkännandet finns kvar i granskningshistoriken.</Notice>}
        {data.review.reason && <div className="employee-review-comment"><strong>Chefens kommentar</strong><p>{data.review.reason}</p></div>}
        {data.review.stale && <Notice tone="amber">Tiduppgifterna har ändrats sedan rapporten skickades. Hämta aktuell status och följ chefens återkoppling.</Notice>}
        {visibleIssues.length > 0 && <Notice tone={blockedIssues.length ? 'amber' : 'blue'}><ul className="employee-review-issues">{visibleIssues.map((issue, index) => <li key={`${issue.code}/${issue.date ?? ''}/${index}`}>{issue.date && <strong>{capitalize(fullDayLabel(issue.date))}: </strong>}{issueLabel(issue.code)}</li>)}</ul></Notice>}
        <div className="employee-review-actions">{data.period.isClosed && editableStatus(data.review.status) && <Button variant="blue" icon={Send} disabled={Boolean(pending) || Boolean(mustReload) || !data.capabilities.canSubmit} onClick={() => void mutate('review.submit')}>{pending === 'write' ? 'Skickar…' : data.review.status === 'returned' || data.review.status === 'reopened' ? 'Skicka igen till chef' : 'Skicka till chef'}</Button>}{data.review.status === 'submitted' && data.capabilities.canWithdraw && <Button variant="outline" icon={Undo2} disabled={Boolean(pending) || Boolean(mustReload)} onClick={() => void mutate('review.withdraw')}>{pending === 'write' ? 'Återtar…' : 'Återta för rättelse'}</Button>}</div>
        <p className="employee-review-message">{data.period.source === 'live' ? 'Sammanställningen bygger på dina registrerade tider.' : data.period.source === 'approved' ? 'Sammanställningen visar den godkända versionen.' : 'Sammanställningen visar versionen du skickade till chef.'} Arbetstid och uppdragsfördelning räknas inte dubbelt.</p>
      </section>
      {(data.history.length > 0 || data.versions.length > 0) && <details className="employee-card"><summary><History size={17} /> Granskningshistorik</summary><ol className="employee-review-history">{data.history.map(event => <li key={event.id}><i /><div><strong>{eventLabel(event)}{event.version > 0 ? ` · Version ${event.version}` : ''}</strong><small>{at(event.at)}</small>{event.reason && <p>{event.reason}</p>}</div></li>)}</ol>{data.versions.length > 0 && <div className="employee-review-days">{data.versions.map(version => <div className="employee-review-day" key={version.version}><div className="employee-review-day-top"><h3>Version {version.version}</h3><strong>{hoursLabel(version.summary.recordedMinutes)}</strong></div><p className="employee-review-day-source">Skickad {at(version.submittedAt)}{version.approvedAt && ` · Godkänd ${at(version.approvedAt)}`}</p></div>)}</div>}</details>}
      <section className="employee-section" aria-label="Dagar i månadsrapporten"><div className="employee-section-title"><h2>Dagar i månaden</h2><span className="employee-subtle">{data.period.days.length} dagar</span></div><div className="employee-review-days">{data.period.days.map(day => <article className="employee-review-day" key={day.date}><div className="employee-review-day-top"><h3>{capitalize(fullDayLabel(day.date))}</h3><strong>{hoursLabel(day.recordedMinutes)}</strong></div><p className="employee-review-day-source">{day.timeSource === 'clock' ? 'Stämpelklocka' : 'Arbetsorder och manuell tid'}</p><div className="employee-review-day-facts"><span>Timkrav {hoursLabel(day.expectedMinutes)}</span>{day.breakMinutes > 0 && <span>Rast {hoursLabel(day.breakMinutes)}</span>}{day.missingMinutes > 0 && <span className="missing">Saknas {hoursLabel(day.missingMinutes)}</span>}{day.absenceMinutes > 0 && <span>Registrerad frånvaro {hoursLabel(day.absenceMinutes)}</span>}{day.timeSource === 'clock' && <span>Fördelat {hoursLabel(day.allocatedMinutes)}</span>}</div>{canOpenDay && <button className="employee-text" onClick={() => navigate(`/time?date=${day.date}`)}>{data.review.status === 'returned' || data.review.status === 'reopened' ? 'Öppna dag för rättelse' : 'Öppna dagen'}<ChevronRight size={16} /></button>}</article>)}</div>{data.period.days.length === 0 && <div className="employee-review-empty"><CalendarDays size={27} /><p>Inga tiduppgifter finns för den här månaden.</p></div>}</section>
    </>}
  </main><Nav /></>;
}
