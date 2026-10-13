import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, CheckCircle2, Clock3, History, LockKeyhole, Pencil, Plus, RefreshCw, Save, Timer, Trash2 } from 'lucide-react';
import type { OfficeUser } from '../model';
import type { EmployeeClockSession } from '../../employee/types';
import { Alert, Dialog, Field, Panel, Pill, formatDate, localToday } from './components/Ui';
import { PersonnelTimeError, mayReadPersonnelTime, mayWritePersonnelTime, personnelTimeScope, readPersonnelTime, updatePersonnelTime } from './time-client';
import type { PersonnelTimeCommand, PersonnelTimeOverview, PersonnelTimeRequirement } from './time-types';
import './time-settings.css';

export interface TimeSettingsPanelProps { user: OfficeUser; actualUser: OfficeUser; personId: string; onNotice: (message: string) => void }
type SettingsForm = { enabled: boolean; mode: 'schedule' | 'fixed'; hours: string; weekdays: number[]; timeSource: 'workorder' | 'clock'; effectiveFrom: string; revision: number };
type WallTime = { value: string; original?: string; occurrence: '' | 'first' | 'second' };
type CorrectionForm = { key: string; requestId: string; revision: number; sessionId?: string; start: WallTime; end: WallTime; breaks: { id: string; start: WallTime; end: WallTime }[]; reason: string };
const weekdayNames = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
const clockLabels = { working: 'Instämplad', break: 'På rast', out: 'Utstämplad', off: 'Ingen schemalagd tid' };
const actionLabels: Record<string, string> = { 'clock.in': 'Stämplade in', 'clock.pause': 'Startade rast', 'clock.resume': 'Avslutade rast', 'clock.out': 'Stämplade ut', 'clock.correct': 'Stämpling rättad', 'clock.corrected': 'Stämpling rättad' };
const hours = (minutes: number) => { const whole = Math.floor(Math.max(0, minutes)); return `${Math.floor(whole / 60)} h ${whole % 60} min`; };
const clockTime = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value)) : '—';
const fullClockTime = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const wallFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function wallValue(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const parts = Object.fromEntries(wallFormatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
const asWall = (value?: string | null): WallTime => ({ value: wallValue(value), ...(value ? { original: value } : {}), occurrence: '' });
function wallCandidates(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return [];
  const [, year, month, day, hour, minute, second = '00'] = match;
  const nominal = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  const normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  return [120, 60].map(offset => nominal - offset * 60_000).filter(instant => wallValue(new Date(instant).toISOString()) === normalized).sort((a, b) => a - b);
}
function instant(value: WallTime) {
  const normalized = value.value.length === 16 ? `${value.value}:00` : value.value;
  if (value.original && wallValue(value.original) === normalized) return value.original;
  const candidates = wallCandidates(value.value);
  if (!candidates.length) throw new Error('Ange ett giltigt klockslag i svensk tid. Tider som inte finns vid övergången till sommartid kan inte sparas.');
  if (candidates.length === 2 && !value.occurrence) throw new Error('Välj vilken av de två tiderna som gäller vid övergången till vintertid.');
  return new Date(candidates[value.occurrence === 'second' ? candidates.length - 1 : 0]).toISOString();
}
function TimeInput({ label, value, onChange, disabled = false }: { label: string; value: WallTime; onChange: (value: WallTime) => void; disabled?: boolean }) {
  const ambiguous = wallCandidates(value.value).length === 2;
  return <div className="hr-time-instant"><Field label={label}><input type="datetime-local" step="1" required disabled={disabled} value={value.value} onChange={event => onChange({ ...value, value: event.target.value, occurrence: '' })} /></Field>{ambiguous && !(value.original && wallValue(value.original) === (value.value.length === 16 ? `${value.value}:00` : value.value)) && <Field label={`Tidszon för ${label.toLocaleLowerCase('sv-SE')}`}><select required disabled={disabled} value={value.occurrence} onChange={event => onChange({ ...value, occurrence: event.target.value as WallTime['occurrence'] })}><option value="">Välj tid vid klockomställningen</option><option value="first">Första tiden · sommartid UTC+02</option><option value="second">Andra tiden · vintertid UTC+01</option></select></Field>}</div>;
}
function settingsFrom(data: PersonnelTimeOverview): SettingsForm {
  const configured = data.configuredRequirement ?? data.requirement;
  const earliest = data.timeSourceChange?.earliestEffectiveFrom ?? data.today;
  return { enabled: configured.enabled, mode: configured.mode, hours: String((configured.dailyMinutes ?? 480) / 60),
    weekdays: [...(configured.weekdays ?? [1, 2, 3, 4, 5])], timeSource: configured.timeSource ?? 'workorder', revision: configured.revision,
    effectiveFrom: configured.effectiveFrom >= earliest ? configured.effectiveFrom : earliest };
}
function historySnapshot(value: unknown) {
  if (!value || typeof value !== 'object') return '—';
  const row = value as { startedAt?: string; endedAt?: string; breaks?: unknown[] };
  return row.startedAt ? `${fullClockTime(row.startedAt)} – ${row.endedAt ? fullClockTime(row.endedAt) : 'pågående'}${row.breaks?.length ? ` · ${row.breaks.length} raster` : ''}` : '—';
}

export default function TimeSettingsPanel({ user, actualUser, personId, onNotice }: TimeSettingsPanelProps) {
  const currentScope = personnelTimeScope(user, actualUser);
  const scope = useMemo(() => currentScope, [currentScope.key]);
  const identity = `${scope.key}/${personId}`, readable = mayReadPersonnelTime(user, actualUser), writable = mayWritePersonnelTime(user, actualUser);
  const [date, setDate] = useState(localToday), [month, setMonth] = useState(() => localToday().slice(0, 7));
  const selected = useMemo(() => ({ personId, date, month }), [personId, date, month]);
  const key = JSON.stringify([identity, date, month]);
  const identityRef = useRef(identity), keyRef = useRef(key); identityRef.current = identity; keyRef.current = key;
  const mounted = useRef(true), dirty = useRef(false), serial = useRef(0);
  const readController = useRef<AbortController | undefined>(undefined), writeController = useRef<AbortController | undefined>(undefined);
  const [stored, setStored] = useState<{ key: string; value: PersonnelTimeOverview }>();
  const [editor, setEditor] = useState<{ identity: string; value: SettingsForm }>();
  const [activity, setActivity] = useState<{ identity: string; kind: 'read' | 'requirement' | 'correction' }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [refreshNeeded, setRefreshNeeded] = useState<string>();
  const [correction, setCorrection] = useState<CorrectionForm>();
  const [correctionError, setCorrectionError] = useState('');
  const data = stored?.key === key ? stored.value : undefined, form = editor?.identity === identity ? editor.value : undefined;
  const pending = activity?.identity === identity ? activity.kind : undefined;
  const error = failure?.key === key ? failure.message : '';
  const canSave = writable && Boolean(data?.capabilities.manageTimeSettings), canCorrect = writable && Boolean(data?.capabilities.correctClock);
  const writePending = pending === 'requirement' || pending === 'correction';
  const mustRefresh = refreshNeeded === identity;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++serial.current; readController.current?.abort(); writeController.current?.abort(); }; }, []);
  useEffect(() => { ++serial.current; readController.current?.abort(); writeController.current?.abort(); writeController.current = undefined; dirty.current = false; setEditor(undefined); setCorrection(undefined); setCorrectionError(''); setRefreshNeeded(undefined); }, [identity, readable]);
  const load = useCallback(async (discardChanges = false) => {
    if (!readable || writeController.current) return;
    readController.current?.abort();
    const controller = new AbortController(), version = ++serial.current;
    readController.current = controller;
    const valid = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && keyRef.current === key && version === serial.current && personnelTimeScope(user, actualUser).key === scope.key;
    if (discardChanges) { dirty.current = false; setCorrection(undefined); }
    setActivity({ identity, kind: 'read' }); setFailure(undefined);
    try {
      const next = await readPersonnelTime(scope, selected, controller.signal);
      if (!valid()) return;
      if (next.person.id !== personId) throw new Error('Tidrapporten tillhör en annan person. Öppna personkortet igen.');
      setStored({ key, value: next }); setRefreshNeeded(undefined);
      if (!dirty.current) setEditor({ identity, value: settingsFrom(next) });
    } catch (reason) {
      if (!valid()) return;
      if (reason instanceof PersonnelTimeError && [401, 403].includes(reason.status)) { setStored(undefined); setEditor(undefined); setCorrection(undefined); setCorrectionError(''); dirty.current = false; }
      setFailure({ key, message: reason instanceof Error ? reason.message : 'Tidrapporten kunde inte hämtas.' });
    } finally { if (valid()) setActivity(undefined); if (readController.current === controller) readController.current = undefined; }
  }, [readable, identity, key, scope, selected, personId]);
  useEffect(() => { void load(); return () => readController.current?.abort(); }, [load]);

  const updateForm = (patch: Partial<SettingsForm>) => { dirty.current = true; setEditor(previous => previous?.identity === identity ? { identity, value: { ...previous.value, ...patch } } : previous); };
  async function mutate(command: PersonnelTimeCommand, kind: 'requirement' | 'correction') {
    if (writeController.current || !readable || !writable || mustRefresh) return false;
    readController.current?.abort(); ++serial.current;
    const controller = new AbortController(); writeController.current = controller;
    const valid = () => mounted.current && !controller.signal.aborted && identityRef.current === identity && keyRef.current === key && personnelTimeScope(user, actualUser).key === scope.key;
    setActivity({ identity, kind }); setFailure(undefined); setCorrectionError('');
    try {
      const next = await updatePersonnelTime(scope, selected, structuredClone(command), controller.signal);
      if (!valid()) return false;
      if (next.person.id !== personId) throw new Error('Svaret tillhör en annan person. Hämta aktuell tidrapport.');
      setStored({ key, value: next }); setRefreshNeeded(undefined);
      if (kind === 'requirement') { dirty.current = false; setEditor({ identity, value: settingsFrom(next) }); }
      else setCorrection(undefined);
      onNotice(kind === 'requirement' ? 'Timkrav och timkälla är sparade från valt datum.' : 'Stämplingen är rättad. Tidigare uppgifter finns kvar i historiken.');
      return true;
    } catch (reason) {
      if (!valid()) return false;
      const message = reason instanceof Error ? reason.message : 'Ändringen kunde inte sparas.';
      if (!(reason instanceof PersonnelTimeError) || [401, 403, 409].includes(reason.status) || reason.status >= 500) setRefreshNeeded(identity);
      if (reason instanceof PersonnelTimeError && [401, 403].includes(reason.status)) {
        setStored(undefined); setEditor(undefined); setCorrection(undefined); setCorrectionError(''); dirty.current = false;
        setFailure({ key, message });
      } else if (kind === 'correction') setCorrectionError(message); else setFailure({ key, message });
      return false;
    } finally { if (valid()) setActivity(undefined); if (writeController.current === controller) writeController.current = undefined; }
  }
  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (!form || !data || !canSave) return;
    const minutes = Math.round(Number(form.hours) * 60);
    if (form.mode === 'fixed' && (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440 || !form.weekdays.length)) { setFailure({ key, message: 'Ange 0–24 timmar och minst en arbetsdag för det fasta timkravet.' }); return; }
    const requirement: PersonnelTimeRequirement = { enabled: form.enabled, mode: form.mode, timeSource: form.timeSource, effectiveFrom: form.effectiveFrom, revision: form.revision,
      ...(form.mode === 'fixed' ? { dailyMinutes: minutes, weekdays: [...form.weekdays].sort() } : data.configuredRequirement?.mode === 'schedule' && data.configuredRequirement.weekdays ? { weekdays: data.configuredRequirement.weekdays } : {}) };
    await mutate({ action: 'requirement.save', personId, requirement }, 'requirement');
  }
  function openCorrection(session?: EmployeeClockSession) {
    if (!data?.clock || !canCorrect || writePending || mustRefresh) return;
    setCorrectionError('');
    setCorrection({ key, requestId: crypto.randomUUID(), revision: data.clock.revision, ...(session ? { sessionId: session.id } : {}),
      start: asWall(session?.startedAt), end: asWall(session?.endedAt), reason: '',
      breaks: (session?.breaks ?? []).map(value => ({ id: crypto.randomUUID(), start: asWall(value.startedAt), end: asWall(value.endedAt) })) });
  }
  async function saveCorrection(event: FormEvent) {
    event.preventDefault(); if (!correction || correction.key !== key || !canCorrect) return;
    try {
      const command: PersonnelTimeCommand = { action: 'clock.correct', personId, requestId: correction.requestId, revision: correction.revision,
        ...(correction.sessionId ? { sessionId: correction.sessionId } : {}), startedAt: instant(correction.start), endedAt: instant(correction.end),
        breaks: correction.breaks.map(value => ({ startedAt: instant(value.start), endedAt: instant(value.end) })), reason: correction.reason.trim() };
      await mutate(command, 'correction');
    } catch (reason) { setCorrectionError(reason instanceof Error ? reason.message : 'Kontrollera stämplingens tider.'); }
  }
  const selectDate = (value: string) => { if (value) { setDate(value); setMonth(value.slice(0, 7)); } };
  const selectedSource = data?.selectedDay.timeSource ?? data?.requirement.timeSource ?? 'workorder';
  const configured = data?.configuredRequirement ?? data?.requirement;
  const earliest = data?.timeSourceChange?.earliestEffectiveFrom ?? data?.today ?? localToday();
  const history = data?.clockHistory ?? [];

  if (!readable) return <section className="office-panel hr-time-protected"><LockKeyhole size={28} /><h2>Begränsad åtkomst</h2><p>Behörighet till anställningsuppgifter krävs för att läsa tidrapporteringen.</p></section>;
  return <div className="hr-time-workspace">
    <div className="hr-time-toolbar"><div><h2>Tidrapportering</h2><p>Timkrav, registrerad arbetstid och stämplingshistorik.</p></div><div className="hr-time-controls"><Field label="Datum för tidrapport"><input type="date" value={date} disabled={writePending} onChange={event => selectDate(event.target.value)} /></Field><Field label="Månad för sammanställning"><input type="month" value={month} disabled={writePending} onChange={event => { if (event.target.value) { setMonth(event.target.value); setDate(`${event.target.value}-01`); } }} /></Field><button className="office-btn outline" disabled={Boolean(pending)} onClick={() => void load()}><RefreshCw size={14} />{pending === 'read' ? 'Hämtar…' : 'Uppdatera tidrapport'}</button></div></div>
    {error && <Alert tone="red">{error}</Alert>}
    {mustRefresh && <Alert tone="orange">Hämta aktuella uppgifter före nästa ändring.<button className="office-btn outline" disabled={Boolean(pending)} onClick={() => void load(true)}>Läs in aktuella uppgifter</button></Alert>}
    {!data || !form ? <div className="hr-empty"><Clock3 size={26} /><strong>{pending === 'read' ? 'Hämtar tidrapport…' : 'Tidrapporten är inte tillgänglig'}</strong>{!pending && <button className="office-btn outline" onClick={() => void load(true)}>Försök igen</button>}</div> : <>
      <div className="hr-time-grid">
        <Panel title="Timkrav & timkälla" icon={<CalendarDays size={18} />}>
          {configured && <div className="hr-time-rule-summary"><Pill tone={configured.effectiveFrom > data.today ? 'orange' : 'blue'}>{configured.effectiveFrom > data.today ? 'Planerad regel' : 'Aktuell regel'} · från {formatDate(configured.effectiveFrom)}</Pill><span>{configured.timeSource === 'clock' ? 'Stämpelklocka' : 'Arbetsorder och manuell tid'}</span></div>}
          <form onSubmit={event => void saveSettings(event)}><fieldset className="hr-time-settings-fields" disabled={!canSave || writePending || mustRefresh}>
            <label className="hr-checkbox hr-time-requirement-toggle"><input type="checkbox" checked={form.enabled} onChange={event => updateForm({ enabled: event.target.checked })} />Kräv full tidrapport för arbetsdagen</label>
            <div className="hr-form-grid"><Field label="Timkälla"><select aria-label="Timkälla" value={form.timeSource} onChange={event => updateForm({ timeSource: event.target.value as SettingsForm['timeSource'] })}><option value="workorder">Arbetsorder och manuell tid</option><option value="clock">Stämpelklocka</option></select></Field><Field label="Timkrav"><select aria-label="Timkrav" value={form.mode} onChange={event => updateForm({ mode: event.target.value as SettingsForm['mode'] })}><option value="schedule">Enligt schema</option><option value="fixed">Fast tid per arbetsdag</option></select></Field>{form.mode === 'fixed' && <Field label="Timkrav per dag (timmar)"><input type="number" min="0" max="24" step="0.01" required value={form.hours} onChange={event => updateForm({ hours: event.target.value })} /></Field>}<Field label="Gäller från"><input type="date" required min={earliest} value={form.effectiveFrom} onChange={event => updateForm({ effectiveFrom: event.target.value })} /></Field></div>
            {form.mode === 'fixed' && <fieldset className="hr-time-weekdays"><legend>Arbetsdagar</legend>{weekdayNames.map((label, index) => <label key={label}><input type="checkbox" checked={form.weekdays.includes(index + 1)} onChange={event => updateForm({ weekdays: event.target.checked ? [...form.weekdays, index + 1] : form.weekdays.filter(day => day !== index + 1) })} />{label}</label>)}</fieldset>}
          </fieldset><p className="hr-muted">En timkälla används per dag. Tid från klocka och arbetsorder summeras inte dubbelt. Tidigare dagar behåller sina regler.{data.timeSourceChange.hasRecordedToday && ` Dagens tid är registrerad; byte av timkälla kan göras från ${formatDate(earliest)}.`}</p>
            <div className="hr-time-form-footer">{!canSave ? <span><LockKeyhole size={13} />Läsbehörighet</span> : dirty.current ? <span>Osparade inställningar</span> : <span>Serverns sparade inställningar</span>}{canSave && <button type="submit" className="office-btn" disabled={writePending || mustRefresh}><Save size={14} />{pending === 'requirement' ? 'Sparar…' : 'Spara timinställningar'}</button>}</div>
          </form>
        </Panel>
        <Panel title="Klockstatus just nu" icon={<Timer size={18} />}>
          {data.clock ? <><div className={`hr-time-clock-state is-${data.clock.status}`}><Clock3 size={30} /><div><strong>{data.clock.enabled ? clockLabels[data.clock.status] : 'Stämpelklockan används inte'}</strong><small>{data.clock.activeSession ? `Instämplad ${fullClockTime(data.clock.activeSession.startedAt)}` : 'Inget pågående klockpass'}</small></div></div><div className="hr-time-clock-totals"><div><span>Arbetad tid</span><strong>{hours(data.clock.workSeconds / 60)}</strong></div><div><span>Rast</span><strong>{hours(data.clock.breakSeconds / 60)}</strong></div></div><p className="hr-muted">{data.clock.activeSession?.provisional && 'Pågående tid är preliminär tills passet har avslutats. '}Avläst på servern {clockTime(data.clock.serverNow)} · svensk tid.</p>{data.clock.requiresCorrection && <Alert tone="orange">Ett klockpass behöver rättas. Kontrollera faktisk sluttid; det kan inte räknas som färdig arbetstid.</Alert>}{data.clock.source !== 'clock' && <Alert>Arbetstid hämtas från arbetsorder och manuella tidrapporter för den aktuella regeln.</Alert>}</> : <div className="hr-empty"><Clock3 size={25} /><strong>Ingen klockstatus registrerad</strong></div>}
          <div className="hr-time-day-stats"><div><span>Vald dag · {formatDate(data.date)}</span><strong>{hours(data.selectedDay.recordedMinutes)} registrerat</strong></div><div><span>Timkrav</span><strong>{hours(data.selectedDay.expectedMinutes)}</strong></div><div><span>Fördelat på arbetsorder</span><strong>{hours(data.selectedDay.allocatedMinutes ?? data.selectedDay.automaticMinutes)}</strong></div></div>
        </Panel>
      </div>
      <Panel title="Stämplingar för vald dag" icon={<Clock3 size={18} />} actions={canCorrect && selectedSource === 'clock' && <button className="office-btn outline" disabled={writePending || mustRefresh || !data.clock} onClick={() => openCorrection()}><Plus size={14} />Lägg till missat pass</button>}>
        {(data.selectedDay.clockSessions ?? []).length ? <div className="hr-time-sessions">{data.selectedDay.clockSessions!.map(session => <article key={session.id}><div><strong>{fullClockTime(session.startedAt)} – {session.endedAt ? fullClockTime(session.endedAt) : 'Pågående'}</strong><small>{session.requiresCorrection ? 'Arbetstid fastställs efter rättelse' : `${hours((session.dayWorkSeconds ?? session.workSeconds) / 60)} arbetad tid · ${hours((session.dayBreakSeconds ?? session.breakSeconds) / 60)} rast`}</small>{session.provisional && <p>Pågående pass. En tidigare dag räknas inte som komplett innan sluttiden har bekräftats.</p>}{session.breaks.map((pause, index) => <span className="hr-time-break-line" key={`${pause.startedAt}/${index}`}>Rast {clockTime(pause.startedAt)}–{pause.endedAt ? clockTime(pause.endedAt) : 'pågår'}</span>)}{session.correctionReason && <p>Rättad: {session.correctionReason}</p>}</div><div className="hr-time-session-actions">{session.requiresCorrection ? <Pill tone="orange">Behöver rättas</Pill> : session.correctedAt ? <Pill tone="orange">Rättad</Pill> : session.provisional ? <Pill tone="blue">Pågående tid</Pill> : null}{canCorrect && <button className="office-link" disabled={writePending || mustRefresh} onClick={() => openCorrection(session)}><Pencil size={14} />Rätta pass</button>}</div></article>)}</div> : <div className="hr-empty"><Clock3 size={25} /><strong>Inga stämplingar för vald dag</strong><p>{selectedSource === 'clock' ? 'Ett missat pass kan rättas av behörig personal.' : 'Den här dagen använder arbetsorder och manuell tid.'}</p></div>}
      </Panel>
      <div className="hr-time-grid">
        <Panel title="Månadens tid" icon={<CalendarDays size={18} />}><div className="hr-time-month-stats"><div><span>Timkrav</span><strong>{hours(data.summary.expectedMinutes)}</strong></div><div><span>Registrerat</span><strong>{hours(data.summary.recordedMinutes)}</strong></div><div><span>Saknas</span><strong>{hours(data.summary.missingMinutes)}</strong></div></div><div className="hr-table-scroll"><table className="hr-table hr-time-days"><thead><tr><th>Datum</th><th>Registrerat</th><th>Timkrav</th><th>Status</th></tr></thead><tbody>{data.days.map(day => <tr key={day.date} className={day.date === date ? 'selected' : undefined}><td><button className="office-link" disabled={writePending} onClick={() => selectDate(day.date)}>{formatDate(day.date)}</button></td><td>{hours(day.recordedMinutes)}</td><td>{hours(day.expectedMinutes)}</td><td><Pill tone={day.date > data.today ? 'grey' : day.missingMinutes > 0 ? 'orange' : 'green'}>{day.date > data.today ? 'Planerad' : day.status === 'not_required' ? 'Inget timkrav' : day.missingMinutes > 0 ? `${hours(day.missingMinutes)} saknas` : 'Komplett'}</Pill></td></tr>)}</tbody></table></div></Panel>
        <Panel title="Stämplingshistorik" icon={<History size={18} />}>{history.length ? <ol className="hr-time-history">{history.map(row => <li key={row.id}><i /><div><strong>{actionLabels[row.action] ?? row.text ?? 'Stämplingshändelse'}</strong><time dateTime={row.at}>{fullClockTime(row.at)}</time>{row.reason && <p>{row.reason}</p>}{Boolean(row.before || row.after) && <div className="hr-time-history-change"><span>Före: {historySnapshot(row.before)}</span><span>Efter: {historySnapshot(row.after)}</span></div>}</div></li>)}</ol> : <div className="hr-empty"><CheckCircle2 size={24} /><strong>Inga stämplingshändelser ännu</strong></div>}</Panel>
      </div>
    </>}
    {correction?.key === key && <Dialog title={correction.sessionId ? 'Rätta stämpling' : 'Registrera missat pass'} description={`${data?.person.name ?? ''} · Tider anges i Europe/Stockholm`} onClose={() => { if (!writePending) setCorrection(undefined); }}><form onSubmit={event => void saveCorrection(event)}><div className="hr-form-grid"><TimeInput disabled={writePending || mustRefresh} label="Instämpling" value={correction.start} onChange={start => setCorrection({ ...correction, start })} /><TimeInput disabled={writePending || mustRefresh} label="Utstämpling" value={correction.end} onChange={end => setCorrection({ ...correction, end })} /></div><div className="hr-time-correction-breaks"><h3>Raster</h3>{correction.breaks.map((pause, index) => <div className="hr-time-correction-break" key={pause.id}><TimeInput disabled={writePending || mustRefresh} label={`Rast ${index + 1} från`} value={pause.start} onChange={start => setCorrection({ ...correction, breaks: correction.breaks.map(value => value.id === pause.id ? { ...value, start } : value) })} /><TimeInput disabled={writePending || mustRefresh} label={`Rast ${index + 1} till`} value={pause.end} onChange={end => setCorrection({ ...correction, breaks: correction.breaks.map(value => value.id === pause.id ? { ...value, end } : value) })} /><button type="button" className="office-link" aria-label={`Ta bort rast ${index + 1}`} disabled={writePending} onClick={() => setCorrection({ ...correction, breaks: correction.breaks.filter(value => value.id !== pause.id) })}><Trash2 size={15} /></button></div>)}<button type="button" className="office-link" disabled={writePending} onClick={() => setCorrection({ ...correction, breaks: [...correction.breaks, { id: crypto.randomUUID(), start: asWall(), end: asWall() }] })}><Plus size={14} />Lägg till rast</button></div><Field label="Orsak till rättelsen"><textarea required minLength={3} maxLength={1000} value={correction.reason} disabled={writePending} onChange={event => setCorrection({ ...correction, reason: event.target.value })} /></Field><p className="hr-muted">Ange faktiskt arbetade tider. Rättelsen sparas med tidigare uppgifter och motivering.</p>{correctionError && <Alert tone="red">{correctionError}</Alert>}{mustRefresh && <Alert tone="orange">Stäng rättelsen och läs in aktuell tidrapport före nästa ändring.</Alert>}<div className="hr-dialog-actions"><button type="button" className="office-btn outline" disabled={writePending} onClick={() => setCorrection(undefined)}>Avbryt</button><button type="submit" className="office-btn" disabled={writePending || mustRefresh}><Save size={14} />{pending === 'correction' ? 'Sparar…' : 'Spara rättelse'}</button></div></form></Dialog>}
  </div>;
}
