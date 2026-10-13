import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ChevronRight, Clock3, Coffee, LockKeyhole, RefreshCw, Search, Users } from 'lucide-react';
import { can, type OfficeUser } from '../model';
import { OfficePageHeader } from '../OfficePageHeader';
import { Alert, Pill, initials } from './components/Ui';
import { mayReadPersonnelTime } from './time-client';
import { PersonnelPresenceError, mayReadPersonnelPresence, personnelPresenceScope, readPersonnelPresence } from './presence-client';
import type { PersonnelPresenceAvailability, PersonnelPresenceClockStatus, PersonnelPresenceResponse, PresencePerson } from './presence-types';
import './personal.css';
import './presence.css';

export interface PresenceOverviewProps {
  user: OfficeUser; actualUser: OfficeUser; selectedSiteId?: string; onNotice: (message: string) => void;
}
type Scoped<T> = { key: string; value: T };
const clockLabels: Record<PersonnelPresenceClockStatus, string> = {
  working: 'Instämplad', break: 'På rast', out: 'Utstämplad', off: 'Ingen schemalagd tid', disabled: 'Stämpelklocka av',
};
const availabilityLabels: Record<PersonnelPresenceAvailability, string> = {
  available: 'Tillgänglig', on_break: 'På rast', busy: 'Upptagen', absent: 'Frånvarande',
  not_clocked_in: 'Inte instämplad', unknown: 'Ej fastställd', needs_review: 'Behöver kontrolleras',
};
const clockTone = { working: 'green', break: 'orange', out: 'red', off: 'grey', disabled: 'grey' } as const;
const availabilityTone = { available: 'green', on_break: 'orange', busy: 'blue', absent: 'grey', not_clocked_in: 'grey', unknown: 'grey', needs_review: 'orange' } as const;
const duration = (seconds: number) => {
  const whole = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(whole / 3600)).padStart(2, '0')}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
const time = (value?: string | null) => value && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const dateAndTime = (value: string, serverNow: string) => {
  const date = new Date(value), now = new Date(serverNow);
  if (!Number.isFinite(date.getTime())) return '—';
  const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
  return dateFormat.format(date) === dateFormat.format(now) ? time(value)
    : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
};
function Metric({ label, value, note, icon, tone }: { label: string; value: number; note: string; icon: ReactNode; tone: string }) {
  return <div className="hr-metric"><span className={`hr-metric-icon ${tone}`}>{icon}</span><div><small>{label}</small><strong>{value}</strong><small>{note}</small></div></div>;
}

/** The server snapshot is the time anchor. Ticking never performs an API call. */
function useLiveSeconds(data?: PersonnelPresenceResponse) {
  const anchor = useRef({ data, at: performance.now() });
  if (anchor.current.data !== data) anchor.current = { data, at: performance.now() };
  const [, render] = useState(0);
  const running = data?.people.some(person => person.isRunning) ?? false;
  useEffect(() => {
    if (!running) return;
    const tick = () => { if (!document.hidden) render(value => value + 1); };
    const interval = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [running]);
  return data ? Math.max(0, (performance.now() - anchor.current.at) / 1000) : 0;
}

export default function PresenceOverview({ user, actualUser, selectedSiteId = 'all' }: PresenceOverviewProps) {
  const navigate = useNavigate();
  const currentScope = personnelPresenceScope(user, actualUser);
  const scope = useMemo(() => currentScope, [currentScope.key]);
  const readable = mayReadPersonnelPresence(user, actualUser);
  const key = `${scope.key}/${selectedSiteId}`;
  const keyRef = useRef(key); keyRef.current = key;
  const readableRef = useRef(readable); readableRef.current = readable;
  const mounted = useRef(true), serial = useRef(0), controller = useRef<AbortController | undefined>(undefined);
  const [stored, setStored] = useState<Scoped<PersonnelPresenceResponse>>();
  const [activity, setActivity] = useState<{ key: string; pending: boolean; error?: string }>();
  const [query, setQuery] = useState(''), [statusFilter, setStatusFilter] = useState('all'), [siteFilter, setSiteFilter] = useState('all');
  const data = readable && stored?.key === key ? stored.value : undefined;
  const pending = activity?.key === key ? activity.pending : false;
  const error = activity?.key === key ? activity.error : undefined;
  const elapsed = useLiveSeconds(data);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++serial.current; controller.current?.abort(); }; }, []);
  const load = useCallback(async () => {
    if (!readableRef.current || document.hidden || controller.current) return;
    const request = new AbortController(), version = ++serial.current;
    controller.current = request;
    const valid = () => mounted.current && !request.signal.aborted && readableRef.current && keyRef.current === key
      && version === serial.current && personnelPresenceScope(user, actualUser).key === scope.key;
    setActivity({ key, pending: true });
    try {
      const next = await readPersonnelPresence(scope, selectedSiteId, request.signal);
      if (!valid()) return;
      setStored(previous => previous?.key === key && previous.value.revision > next.revision ? previous : { key, value: next });
    } catch (reason) {
      if (!valid()) return;
      if (reason instanceof PersonnelPresenceError && [401, 403].includes(reason.status)) setStored(undefined);
      setActivity({ key, pending: false, error: reason instanceof Error ? reason.message : 'Närvaroöversikten kunde inte hämtas.' });
    } finally {
      if (valid()) setActivity(previous => previous?.key === key ? { ...previous, pending: false } : previous);
      if (controller.current === request) controller.current = undefined;
    }
  }, [key, scope, selectedSiteId]);
  useEffect(() => {
    ++serial.current; controller.current?.abort(); controller.current = undefined;
    setStored(undefined); setActivity(undefined); setQuery(''); setStatusFilter('all'); setSiteFilter('all');
    if (readable) void load();
    const foreground = () => { if (!document.hidden) void load(); };
    const interval = window.setInterval(foreground, 20000);
    document.addEventListener('visibilitychange', foreground);
    return () => { ++serial.current; controller.current?.abort(); controller.current = undefined; window.clearInterval(interval); document.removeEventListener('visibilitychange', foreground); };
  }, [load, readable]);

  const availableSites = data?.sites.filter(site => selectedSiteId === 'all' || site.id === selectedSiteId) ?? [];
  const siteName = (siteId: string) => data?.sites.find(site => site.id === siteId)?.name ?? 'Anläggning';
  const people = (data?.people ?? []).filter(person => (siteFilter === 'all' || person.siteIds.includes(siteFilter))
    && (statusFilter === 'all' || (statusFilter === 'review' ? person.availabilityStatus === 'needs_review' : person.clockStatus === statusFilter))
    && [person.name, person.team, ...person.siteIds.map(siteName), person.clockSiteId ? siteName(person.clockSiteId) : ''].join(' ').toLocaleLowerCase('sv-SE').includes(query.trim().toLocaleLowerCase('sv-SE')));
  const openPerson = (person: PresencePerson) => navigate(`/personnel/${encodeURIComponent(person.personId)}/${mayReadPersonnelTime(user, actualUser) ? 'time' : 'overview'}`);
  const navigation = <nav className="hr-section-nav" aria-label="Personal">
    <button onClick={() => navigate('/personnel')}>Alla personer</button><button className="active" aria-current="page" onClick={() => navigate('/personnel/presence')}>Närvaro</button>
    {[user, actualUser].every(person => can(person, 'personnelTimeReviewRead')) && <button onClick={() => navigate('/personnel/time-review')}>Månadsgranskning</button>}
    <button onClick={() => navigate('/personnel/tasks')}>Bemanning att lösa</button>{[user, actualUser].every(person => can(person, 'users')) && <button onClick={() => navigate('/personnel/accounts')}>Konton</button>}
  </nav>;
  const controls = <div className="hr-presence-controls"><label className="hr-search"><Search size={16} /><input aria-label="Sök i närvaro" placeholder="Sök person, team eller anläggning…" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <select aria-label="Närvarostatus" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">Alla statusar</option><option value="working">Instämplade</option><option value="break">På rast</option><option value="out">Utstämplade</option><option value="review">Behöver åtgärd</option><option value="off">Ingen schemalagd tid</option><option value="disabled">Stämpelklocka av</option></select>
    <select aria-label="Närvarons anläggning" value={siteFilter} onChange={event => setSiteFilter(event.target.value)}><option value="all">Alla anläggningar</option>{availableSites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select>
  </div>;
  if (!readable) return <div className="hr-workspace hr-presence-workspace"><Alert tone="orange"><LockKeyhole size={17} />Du saknar behörighet att läsa personalens närvaro.</Alert></div>;
  return <section className="hr-workspace hr-presence-workspace">
    <OfficePageHeader className="hr-page-header" controls={controls}>{navigation}<div className="office-page-title"><div><h1>Närvaro</h1><p>Aktuell stämpling och tillgänglighet för personalen.</p></div><div className="hr-presence-heading-actions">
      {data && <span className={`hr-presence-freshness${error ? ' stale' : ''}`}><i />{error ? 'Senaste avläsning' : 'Avläst'} {time(data.serverNow)}</span>}
      <button className="office-btn outline" disabled={pending} onClick={() => void load()}><RefreshCw size={15} className={pending ? 'hr-presence-spin' : ''} />Uppdatera</button>
    </div></div></OfficePageHeader>
    {error && <Alert tone="red">{error}{data && ' Senast hämtade uppgifter visas.'}</Alert>}
    {!data ? <div className="office-panel hr-presence-empty">{pending ? <><RefreshCw size={24} className="hr-presence-spin" /><strong>Hämtar närvaro…</strong></> : <><Users size={27} /><strong>Närvaroöversikten kunde inte hämtas.</strong><button className="office-btn outline" onClick={() => void load()}>Försök igen</button></>}</div> : <>
      <div className="hr-metrics hr-presence-metrics" aria-label="Närvaro i valda anläggningar"><Metric label="Instämplade" value={data.summary.clockedIn} note="Inklusive personal på rast" icon={<CheckCircle2 size={21} />} tone="green" /><Metric label="På rast" value={data.summary.onBreak} note="Aktuell rast" icon={<Coffee size={21} />} tone="orange" /><Metric label="Utstämplade" value={data.summary.clockedOut} note="Utan pågående klockpass" icon={<Clock3 size={21} />} tone="grey" /><Metric label="Behöver åtgärd" value={data.summary.needsReview} note="Uppgifter behöver kontrolleras" icon={<AlertCircle size={21} />} tone="red" /></div>
      <article className="office-panel hr-panel hr-presence-table-panel"><div className="hr-presence-table-heading"><h2>Personal just nu</h2><span>{people.length} av {data.summary.total} personer</span></div>
        {people.length ? <div className="hr-table-scroll"><table className="hr-table hr-presence-table"><thead><tr><th>Person / team</th><th>Anläggning</th><th>Status</th><th>Sedan</th><th>Arbetstid</th><th>Rast</th><th>Tillgänglighet</th><th><span className="hr-presence-sr-only">Öppna person</span></th></tr></thead><tbody>{people.map(person => {
          const ticking = person.isRunning ? elapsed : 0;
          const workSeconds = person.workSeconds + (person.clockStatus === 'working' ? ticking : 0), breakSeconds = person.breakSeconds + (person.clockStatus === 'break' ? ticking : 0);
          return <tr key={person.personId} tabIndex={0} aria-label={`Öppna ${person.name}`} onClick={() => openPerson(person)} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPerson(person); } }}>
            <td><div className="hr-presence-person"><span className="hr-avatar">{initials(person.name)}</span><div><strong>{person.name}</strong><small>{person.team || 'Inget team'}</small></div></div></td>
            <td>{person.siteIds.map(siteName).join(', ') || '—'}{person.clockSiteId && <small>Instämplad på {siteName(person.clockSiteId)}</small>}</td>
            <td><div className="hr-presence-status"><Pill tone={clockTone[person.clockStatus]}>{clockLabels[person.clockStatus]}</Pill>{person.requiresCorrection && <small>Stämpling behöver rättas</small>}{person.clockStatus === 'disabled' && person.workStateSource === 'order' && <small>Uppdrag pågår</small>}</div></td>
            <td><time dateTime={person.statusSince ?? undefined}>{person.statusSince ? dateAndTime(person.statusSince, data.serverNow) : '—'}</time></td>
            <td className="hr-presence-duration">{person.clockStatus === 'disabled' ? '—' : <>{duration(workSeconds)}<small>{person.isRunning ? 'Pågående pass' : 'Idag'}</small></>}</td><td className="hr-presence-duration">{person.clockStatus === 'disabled' ? '—' : duration(breakSeconds)}</td>
            <td><Pill tone={availabilityTone[person.availabilityStatus]}>{availabilityLabels[person.availabilityStatus]}</Pill></td><td><ChevronRight size={16} /></td>
          </tr>;
        })}</tbody></table></div> : <div className="hr-presence-empty"><Users size={25} /><strong>{data.people.length ? 'Ingen person matchar filtret.' : 'Ingen personal finns i valda anläggningar.'}</strong></div>}
      </article><p className="hr-presence-help">Arbetstid visas utan rast. Närvaron uppdateras var 20:e sekund medan sidan är öppen.</p>
    </>}
  </section>;
}
