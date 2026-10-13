import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronRight, Clock3, Coffee, LogIn, LogOut, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Button, Notice } from '../components';
import { employeeError, useEmployee } from './EmployeeProvider';
import { hoursLabel } from './Calendar';
import type { EmployeeClock, EmployeeClockAction, EmployeeClockSession, EmployeeOverview } from './types';

const zone = 'Europe/Stockholm';
const statusNames: Record<EmployeeClock['status'], string> = { working: 'Instämplad', break: 'På rast', out: 'Inte instämplad', off: 'Ingen schemalagd tid' };
export function isEmployeeClockDay(overview: EmployeeOverview | null | undefined, date?: string) {
  if (!overview || !date) return Boolean(overview?.clock?.enabled);
  const day = overview.selectedDay.date === date ? overview.selectedDay : overview.days.find(value => value.date === date);
  if (day?.timeSource) return day.timeSource === 'clock';
  if (overview.gate.date === date) return overview.gate.timeSource === 'clock';
  return Boolean(overview.clock?.enabled);
}
export const clockDuration = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 3600).toString().padStart(2, '0')}:${Math.floor(value / 60 % 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
};
function clockTime(value: string, date = false) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, ...(date ? { day: 'numeric', month: 'short' } : {}), hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function localInput(value: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
/** Preserve an unchanged instant through a winter-time fold. New local times
 * are round-trip checked so a nonexistent spring-transition time is rejected. */
export function clockInstant(value: string, original?: string | null) {
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
  if (original && localInput(original) === normalized) return original;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
  if (!match) throw new Error('Ange datum och tid för hela passet.');
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]);
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const observed = localInput(new Date(instant).toISOString()).match(/\d+/g)!.map(Number);
    const offset = desired - Date.UTC(observed[0], observed[1] - 1, observed[2], observed[3], observed[4], observed[5]);
    instant += offset;
    if (!offset) break;
  }
  const result = new Date(instant).toISOString();
  if (localInput(result) !== normalized) throw new Error('Klockslaget finns inte vid sommartidsbytet. Kontrollera tiden.');
  return result;
}
function useServerNow(serverNow?: string, live = false) {
  const anchor = useRef({ source: '', server: 0, elapsed: performance.now() });
  if (serverNow && anchor.current.source !== serverNow) anchor.current = { source: serverNow, server: Date.parse(serverNow), elapsed: performance.now() };
  const [tick, setTick] = useState(performance.now());
  useEffect(() => {
    const update = () => setTick(performance.now()); update();
    if (!live) return;
    const timer = window.setInterval(() => { if (!document.hidden) update(); }, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [serverNow, live]);
  const elapsed = live ? Math.max(0, tick - anchor.current.elapsed) : 0;
  return { now: anchor.current.server + elapsed, elapsedSeconds: Math.floor(elapsed / 1000) };
}
function useOnline() {
  const [online, setOnline] = useState(navigator.onLine !== false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return online;
}
function useClockCounters(clock?: EmployeeClock) {
  const live = Boolean(clock?.enabled && clock.activeSession && ['working', 'break'].includes(clock.status));
  const time = useServerNow(clock?.serverNow, live);
  return {
    ...time,
    workSeconds: (clock?.activeSession?.workSeconds ?? clock?.workSeconds ?? 0) + (clock?.status === 'working' ? time.elapsedSeconds : 0),
    breakSeconds: (clock?.activeSession?.breakSeconds ?? clock?.breakSeconds ?? 0) + (clock?.status === 'break' ? time.elapsedSeconds : 0),
  };
}

export function EmployeeClockStatus() {
  const { overview } = useEmployee(), navigate = useNavigate();
  const clock = overview?.clock, counters = useClockCounters(clock);
  if (!clock?.enabled) return null;
  const target = overview?.gate.blocked && overview.gate.date ? `/time?date=${overview.gate.date}` : '/time';
  const restStart = clock.activeSession?.breaks.find(rest => !rest.endedAt)?.startedAt;
  const statusSeconds = clock.status === 'break' && restStart ? Math.max(0, (counters.now - Date.parse(restStart)) / 1000) : counters.workSeconds;
  return <button type="button" className={`employee-clock-strip ${clock.status}${clock.requiresCorrection ? ' needs-correction' : ''}`} aria-label={`Stämpelklocka: ${clock.requiresCorrection ? 'Rättelse behövs' : statusNames[clock.status]}. Öppna Tid`} onClick={() => navigate(target)}>
    <span className="employee-clock-dot" /><Clock3 size={14} /><strong>{clock.requiresCorrection ? 'Rättelse behövs' : statusNames[clock.status]}</strong>{clock.activeSession && <span className="employee-clock-strip-duration">{clockDuration(statusSeconds)}</span>}<span className="employee-clock-strip-link">Tid<ChevronRight size={14} /></span>
  </button>;
}

export function EmployeeClockCard({ title = 'Stämpelklocka', compact = false }: { title?: string; compact?: boolean }) {
  const { overview, session, commandClock, clockBusy } = useEmployee(), navigate = useNavigate();
  const clock = overview?.clock, counters = useClockCounters(clock), online = useOnline();
  const [pending, setPending] = useState<EmployeeClockAction['action']>(), [error, setError] = useState('');
  const busy = useRef(false), mounted = useRef(true);
  const request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const identity = `${session?.companyId}/${session?.person.id}`, identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setError(''); setPending(undefined); busy.current = false; request.current = undefined; }, [identity]);
  if (!clock?.enabled) return null;
  async function act(action: EmployeeClockAction['action']) {
    if (!clock || busy.current || clockBusy) return;
    const expectedIdentity = identity;
    const fingerprint = JSON.stringify([identity, action, clock.revision, clock.activeSession?.id]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    busy.current = true; setPending(action); setError('');
    try { await commandClock({ action, revision: clock.revision, requestId: request.current.id, ...(clock.activeSession ? { sessionId: clock.activeSession.id } : {}) }); }
    catch (caught) { if (mounted.current && identityRef.current === expectedIdentity) setError(employeeError(caught)); }
    finally { if (mounted.current && identityRef.current === expectedIdentity) { busy.current = false; setPending(undefined); } }
  }
  const active = clock.activeSession;
  return <section className={`employee-card employee-clock-card ${clock.status}${compact ? ' compact' : ''}`} aria-label={title}>
    <header><span className="employee-clock-card-icon"><Clock3 size={23} /></span><h2>{title}</h2><span className={`employee-clock-state ${clock.status}`}>{statusNames[clock.status]}</span></header>
    {active ? <><div className="employee-clock-main"><strong>{clockDuration(counters.workSeconds)}</strong><span>Arbetat i passet</span></div><div className="employee-clock-facts"><span>In {clockTime(active.startedAt, true)}</span><span>Rast {clockDuration(counters.breakSeconds)}</span></div>{clock.status === 'break' && <p className="employee-clock-rest">Rast sedan {clockTime(active.breaks.find(rest => !rest.endedAt)?.startedAt || clock.serverNow)}</p>}</> : <p className="employee-clock-ready">{clock.status === 'out' ? 'Stämpla in när du börjar arbeta.' : 'Stämpla in för att starta ett arbetspass.'}</p>}
    {clock.requiresCorrection && <Notice tone="amber">Ett pass behöver kontrolleras innan tiden kan räknas.{active?.requiresCorrection && <button type="button" className="employee-text" onClick={() => navigate(`/time?${new URLSearchParams({ date: localInput(active.startedAt).slice(0, 10), clock: active.id })}`)}>Rätta stämpling<Pencil size={14} /></button>}</Notice>}
    {error && <Notice tone="red">{error}</Notice>}{!online && <Notice tone="amber">Stämpling kräver anslutning.</Notice>}
    <div className="employee-clock-actions">{!active ? <Button variant="blue" icon={LogIn} disabled={clockBusy || !online} onClick={() => void act('clock.in')}>{pending === 'clock.in' ? 'Stämplar in…' : 'Stämpla in'}</Button> : <>{clock.status === 'break' ? <Button variant="blue" icon={Play} disabled={clockBusy || !online} onClick={() => void act('clock.resume')}>{pending === 'clock.resume' ? 'Återupptar…' : 'Återuppta arbete'}</Button> : <Button variant="outline" icon={Coffee} disabled={clockBusy || !online} onClick={() => void act('clock.pause')}>{pending === 'clock.pause' ? 'Startar rast…' : 'Ta rast'}</Button>}<Button variant="danger" icon={LogOut} disabled={clockBusy || !online} onClick={() => void act('clock.out')}>{pending === 'clock.out' ? 'Stämplar ut…' : 'Stämpla ut'}</Button></>}</div>
  </section>;
}

export function EmployeeClockHistory({ date }: { date: string }) {
  const { overview } = useEmployee(), navigate = useNavigate();
  const day = overview?.date === date ? overview.selectedDay : undefined;
  const sessions = day?.clockSessions?.filter(pass => pass.endedAt || pass.requiresCorrection).sort((first, second) => first.startedAt.localeCompare(second.startedAt)) ?? [];
  const clockEnabled = Boolean(overview?.clock && isEmployeeClockDay(overview, date));
  if (!clockEnabled && !sessions.length) return null;
  function correct(pass?: EmployeeClockSession) { const query = new URLSearchParams({ date, clock: pass?.id || 'new' }); navigate(`/time?${query}`); }
  return <section className="employee-section employee-clock-history" aria-label="Stämplade pass"><div className="employee-section-title"><h2>Stämplade pass</h2><strong className="employee-hours">{hoursLabel(day?.clockMinutes ?? 0)}</strong></div>{sessions.length ? sessions.map(pass => <article className="employee-clock-session" key={pass.id}><div><small>{clockTime(pass.startedAt, true)}–{pass.endedAt ? clockTime(pass.endedAt, true) : 'Pågående'}</small><strong>{clockDuration(pass.dayWorkSeconds ?? pass.workSeconds)}</strong><span>{(pass.dayBreakSeconds ?? pass.breakSeconds) > 0 ? `Rast ${clockDuration(pass.dayBreakSeconds ?? pass.breakSeconds)}` : 'Ingen rast registrerad'}{pass.correctedAt ? ' · Rättat pass' : ''}</span>{pass.requiresCorrection && <p className="employee-clock-warning">Passet behöver rättas för att räknas som arbetstid.</p>}{pass.correctionReason && <p>{pass.correctionReason}</p>}</div>{clockEnabled && <button type="button" className="employee-text" aria-label={`Ändra stämplat pass ${clockTime(pass.startedAt, true)}`} onClick={() => correct(pass)}><Pencil size={15} />Ändra</button>}</article>) : <p className="employee-subtle">Inga avslutade pass för denna dag.</p>}{clockEnabled && <Button variant="outline" icon={Plus} onClick={() => correct()}>Komplettera stämpling</Button>}</section>;
}

export function EmployeeClockCorrectionForm({ pass, onClose }: { pass?: EmployeeClockSession; onClose: () => void }) {
  const { overview, session, commandClock, clockBusy } = useEmployee();
  const baseRevision = useRef(overview?.clock?.revision ?? 0), request = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const [from, setFrom] = useState(pass ? localInput(pass.startedAt) : ''), [to, setTo] = useState(pass?.endedAt ? localInput(pass.endedAt) : '');
  const [rests, setRests] = useState((pass?.breaks ?? []).map(rest => ({ from: localInput(rest.startedAt), to: rest.endedAt ? localInput(rest.endedAt) : '' })));
  const [reason, setReason] = useState(''), [error, setError] = useState('');
  const busy = useRef(false), mounted = useRef(true), online = useOnline();
  const identity = `${session?.companyId}/${session?.person.id}`, identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy.current || clockBusy) return;
    if (!reason.trim()) { setError('Beskriv varför stämplingen ska rättas.'); return; }
    const expectedIdentity = identity;
    try {
      const startedAt = clockInstant(from, pass?.startedAt), endedAt = clockInstant(to, pass?.endedAt);
      if (Date.parse(endedAt) <= Date.parse(startedAt)) throw new Error('Utstämplingen måste vara efter instämplingen.');
      const breaks = rests.map((rest, index) => ({ startedAt: clockInstant(rest.from, pass?.breaks[index]?.startedAt), endedAt: clockInstant(rest.to, pass?.breaks[index]?.endedAt) })).sort((first, second) => first.startedAt.localeCompare(second.startedAt));
      for (let index = 0; index < breaks.length; index++) {
        const rest = breaks[index];
        if (Date.parse(rest.endedAt) <= Date.parse(rest.startedAt) || Date.parse(rest.startedAt) < Date.parse(startedAt) || Date.parse(rest.endedAt) > Date.parse(endedAt)) throw new Error('Rasterna måste ligga inom passet och ha en sluttid efter starttiden.');
        if (index && Date.parse(rest.startedAt) < Date.parse(breaks[index - 1].endedAt)) throw new Error('Rasterna får inte överlappa varandra.');
      }
      const input = { action: 'clock.correct' as const, revision: baseRevision.current, ...(pass ? { sessionId: pass.id } : {}), startedAt, endedAt, breaks, reason: reason.trim() };
      const fingerprint = JSON.stringify([identity, input]);
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
      busy.current = true; setError('');
      await commandClock({ ...input, requestId: request.current.id });
      if (mounted.current && identityRef.current === expectedIdentity) onClose();
    } catch (caught) { if (mounted.current && identityRef.current === expectedIdentity) setError(employeeError(caught)); }
    finally { if (mounted.current && identityRef.current === expectedIdentity) busy.current = false; }
  }
  function updateRest(index: number, field: 'from' | 'to', value: string) { setRests(previous => previous.map((rest, current) => current === index ? { ...rest, [field]: value } : rest)); }
  return <form className="employee-form employee-clock-correction" onSubmit={save} aria-busy={clockBusy}><p className="employee-subtle">Ange de tider du faktiskt arbetade. Alla tider visas i svensk tid.</p>{error && <Notice tone="red">{error}</Notice>}
    <label>Instämpling<input required type="datetime-local" step="1" value={from} disabled={clockBusy} onChange={event => setFrom(event.target.value)} /></label><label>Utstämpling<input required type="datetime-local" step="1" value={to} disabled={clockBusy} onChange={event => setTo(event.target.value)} /></label>
    <section className="employee-clock-break-editor" aria-label="Rasttider"><h2>Raster</h2>{rests.map((rest, index) => <div className="employee-clock-break-inputs" key={index}><label>Rast {index + 1} från<input required type="datetime-local" step="1" value={rest.from} disabled={clockBusy} onChange={event => updateRest(index, 'from', event.target.value)} /></label><label>Rast {index + 1} till<input required type="datetime-local" step="1" value={rest.to} disabled={clockBusy} onChange={event => updateRest(index, 'to', event.target.value)} /></label><button type="button" className="employee-text danger" aria-label={`Ta bort rast ${index + 1}`} disabled={clockBusy} onClick={() => setRests(previous => previous.filter((_, current) => current !== index))}><Trash2 size={16} /></button></div>)}<button type="button" className="employee-text" disabled={clockBusy || rests.length >= 20} onClick={() => setRests(previous => [...previous, { from: '', to: '' }])}><Plus size={16} />Lägg till rast</button></section>
    <label>Anledning till rättelse<textarea required maxLength={1000} rows={3} value={reason} disabled={clockBusy} onChange={event => setReason(event.target.value)} placeholder="Beskriv vad som blev fel eller varför stämplingen saknas…" /></label>{!online && <Notice tone="amber">Rättelsen behöver anslutning för att sparas.</Notice>}<Button type="submit" variant="blue" icon={Check} disabled={clockBusy || !online}>{clockBusy ? 'Sparar rättelse…' : 'Spara rättelse'}</Button><Button type="button" variant="outline" disabled={clockBusy} onClick={onClose}>Avbryt</Button>
  </form>;
}
