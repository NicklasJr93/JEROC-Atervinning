import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, Check, FileUp, HeartPulse, RefreshCw } from 'lucide-react';
import { Button, Modal, Notice } from '../components';
import { EmployeeError, employeeError, employeeRequest, useEmployee } from './EmployeeProvider';
import { employeeCompanyId } from './cache';
import { fullDayLabel, minuteLabel } from './Calendar';
import type { EmployeeSicknessCommand, EmployeeSicknessResponse, SicknessExtent, SicknessForecast } from './sickness-types';
import './employee-sickness.css';

type Mode = 'report' | 'confirm' | 'forecast' | 'declare' | 'recover' | 'recover_cancel';
type ReturnWhen = 'now' | 'today' | 'tomorrow' | 'date';
type Pending = { command: EmployeeSicknessCommand; uncertain: boolean; inFlight?: boolean };
const pendingCommands = new Map<string, Pending>();
const pendingEvent = 'scrappilot:sickness-command';
function savePending(scope: string, value?: Pending) {
  if (value) pendingCommands.set(scope, value); else pendingCommands.delete(scope);
  window.dispatchEvent(new CustomEvent(pendingEvent, { detail: scope }));
}
const zone = 'Europe/Stockholm';
const shiftDay = (day: string, days: number) => {
  const value = new Date(`${day}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const validResponse = (value: EmployeeSicknessResponse) => value && Number.isSafeInteger(value.revision) && typeof value.today === 'string'
  && Array.isArray(value.cases) && Array.isArray(value.events) && typeof value.policy?.dailyContact === 'boolean';
const dateAt = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const minuteAt = (instant: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  return Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
};

export function EmployeeSicknessCard({ expanded = false }: { expanded?: boolean }) {
  const { session, overview, sessionGeneration, commandSickness, refresh } = useEmployee();
  const scope = `${employeeCompanyId(session?.companyId)}/${session?.person.id}/${sessionGeneration}`;
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const mounted = useRef(true), busyRef = useRef(false);
  const serverAnchor = useRef({ source: '', time: Date.now(), elapsed: performance.now() });
  const serverNow = overview?.clock?.serverNow;
  if (serverNow && serverNow !== serverAnchor.current.source && Number.isFinite(Date.parse(serverNow)))
    serverAnchor.current = { source: serverNow, time: Date.parse(serverNow), elapsed: performance.now() };
  const currentInstant = () => new Date(serverAnchor.current.time + performance.now() - serverAnchor.current.elapsed).toISOString();
  const [fetched, setFetched] = useState<{ scope: string; value: EmployeeSicknessResponse }>();
  const [mode, setMode] = useState<Mode>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [online, setOnline] = useState(navigator.onLine !== false), [pending, setPending] = useState<Pending>();
  const [fromDate, setFromDate] = useState(''), [startTime, setStartTime] = useState(''), [extent, setExtent] = useState<SicknessExtent>(100);
  const [forecastKind, setForecastKind] = useState<SicknessForecast['kind']>('unknown'), [forecastDate, setForecastDate] = useState('');
  const [declared, setDeclared] = useState(false), [returnWhen, setReturnWhen] = useState<ReturnWhen>('now'), [healthyFromDate, setHealthyFromDate] = useState('');
  const [uploading, setUploading] = useState(false), [uploadMessage, setUploadMessage] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const data = fetched?.scope === scope && (!overview?.sickness || fetched.value.revision >= overview.sickness.revision) ? fetched.value : overview?.sickness;
  const active = data?.activeCase;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setMode(undefined); setError(''); setNotice(''); setFetched(undefined); setBusy(false); busyRef.current = false; setUploadMessage('');
    for (const key of pendingCommands.keys()) if (key !== scope) pendingCommands.delete(key);
    setPending(pendingCommands.get(scope));
  }, [scope]);
  useEffect(() => {
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === scope) setPending(pendingCommands.get(scope)); };
    window.addEventListener(pendingEvent, changed);
    return () => window.removeEventListener(pendingEvent, changed);
  }, [scope]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!session || session.support || overview?.sickness) return;
    const controller = new AbortController(), expected = scope;
    void employeeRequest<EmployeeSicknessResponse>('/sickness', undefined, { signal: controller.signal, expectedCompanyId: session.companyId }).then(value => {
      if (!controller.signal.aborted && scopeRef.current === expected) {
        if (!validResponse(value)) throw new Error('Sjukfrånvaron kunde inte läsas. Försök igen.');
        setFetched({ scope: expected, value });
      }
    }).catch(caught => { if (!controller.signal.aborted && scopeRef.current === expected) setError(employeeError(caught)); });
    return () => controller.abort();
  }, [scope, session?.companyId, overview?.sickness]);
  const remember = (value?: Pending) => { savePending(scope, value); setPending(value); };
  async function reconcile() {
    if (!session || busyRef.current || !online) return;
    const expected = scope; busyRef.current = true; setBusy(true); setError('');
    try {
      const value = await employeeRequest<EmployeeSicknessResponse>('/sickness', undefined, { expectedCompanyId: session.companyId });
      if (!mounted.current || scopeRef.current !== expected) return;
      if (!validResponse(value)) throw new Error('Servern gav ett ofullständigt svar. Kontrollera igen.');
      setFetched({ scope: expected, value });
      const command = pendingCommands.get(expected)?.command;
      const item = command && 'id' in command ? value.cases.find(entry => entry.id === command.id)
        ?? (value.activeCase?.id === command.id ? value.activeCase : undefined) : value.activeCase;
      if (command && (command.action === 'sickness.report' && value.activeCase
        || command.action === 'sickness.recover' && item?.status === 'recovered' && item.lastSickDate === command.lastSickDate && item.recoveryMinute === command.recoveryMinute
        || command.action === 'sickness.recovery.schedule' && (item?.status === 'open' && item.recoveryPlan?.healthyFromDate === command.healthyFromDate
          || item?.status === 'recovered' && item.lastSickDate === shiftDay(command.healthyFromDate, -1) && item.recoveryMinute === undefined)
        || command.action === 'sickness.recovery.cancel' && item?.status === 'open' && !item.recoveryPlan && item.revision > command.revision
        || command.action === 'sickness.declare' && item?.declared
        || command.action === 'sickness.confirm' && item?.lastContactDate === value.today
        || command.action === 'sickness.forecast' && JSON.stringify(item?.forecast) === JSON.stringify(command.forecast))) {
        remember(undefined); setNotice('Serverns registrering har bekräftats.'); setMode(undefined);
      } else if (command) setNotice('Utfallet är ännu inte bekräftat. Kontrollera igen eller skicka samma försök med samma begäran.');
      void refresh().catch(() => undefined);
    } catch (caught) { if (mounted.current && scopeRef.current === expected) setError(employeeError(caught)); }
    finally { if (mounted.current && scopeRef.current === expected) { busyRef.current = false; setBusy(false); } }
  }
  async function send(command: EmployeeSicknessCommand) {
    if (!online || busyRef.current || pendingCommands.get(scope)?.inFlight) return;
    const expected = scope; busyRef.current = true; setBusy(true); setError(''); setNotice(''); remember({ command, uncertain: false, inFlight: true });
    try {
      await commandSickness(command);
      if (pendingCommands.get(expected)?.command.requestId === command.requestId) savePending(expected);
      if (!mounted.current || scopeRef.current !== expected) return;
      remember(undefined); setFetched(undefined); setMode(undefined);
      setNotice(command.action === 'sickness.recovery.schedule' ? `Friskanmälan är registrerad från ${fullDayLabel(command.healthyFromDate)}.`
        : command.action === 'sickness.recovery.cancel' ? 'Friskanmälan är återkallad. Sjukfrånvaron fortsätter.'
        : command.action === 'sickness.recover' ? 'Friskanmälan är registrerad.' : command.action === 'sickness.report' ? 'Sjukanmälan är registrerad. Din chef kan följa upp frånvaron.' : 'Uppgifterna är registrerade.');
    } catch (caught) {
      const uncertain = !(caught instanceof EmployeeError) || caught.status === 0 || caught.status >= 500;
      if (pendingCommands.get(expected)?.command.requestId === command.requestId) savePending(expected, uncertain ? { command, uncertain: true } : undefined);
      if (!mounted.current || scopeRef.current !== expected) return;
      remember(uncertain ? { command, uncertain: true } : undefined);
      setError(uncertain ? 'Svaret kunde inte bekräftas. Registreringen kan ha sparats. Kontrollera serverns registrering innan du gör ett nytt försök.' : employeeError(caught));
    } finally { if (mounted.current && scopeRef.current === expected) { busyRef.current = false; setBusy(false); } }
  }
  function open(next: Mode) {
    if (!data || pending || busy) return;
    setError(''); setNotice(''); setMode(next); setFromDate(data.today); setExtent(active?.extent ?? 100);
    setForecastKind(active?.forecast.kind ?? 'unknown'); setForecastDate(active?.forecast.date ?? data.today); setDeclared(false); setReturnWhen('now');
    setHealthyFromDate(active?.recoveryPlan?.healthyFromDate ?? shiftDay(data.today, 1));
    if (next === 'recover' && active?.recoveryPlan) setReturnWhen('date');
    const serverNow = currentInstant();
    const ended = overview?.selectedDay.date === data.today ? overview.selectedDay.clockSessions?.filter(pass => pass.endedAt && dateAt(pass.endedAt) === data.today).map(pass => minuteAt(pass.endedAt!)) ?? [] : [];
    const entries = overview?.selectedDay.date === data.today ? overview.selectedDay.entries.map(entry => entry.endMinute) : [];
    const lastEnd = Math.max(0, ...ended, ...entries.filter(value => value <= minuteAt(serverNow)));
    setStartTime(lastEnd > 0 && lastEnd < 1440 ? minuteLabel(lastEnd) : '');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!data || !mode || busy || pending?.uncertain) return;
    const forecast: SicknessForecast = forecastKind === 'date' ? { kind: 'date', date: forecastDate } : { kind: 'unknown' };
    const requestId = crypto.randomUUID();
    if (mode === 'report') {
      const clockOut = data.activeClock || data.activeWork;
      const parts = startTime.split(':').map(Number), startMinute = parts.length === 2 ? parts[0] * 60 + parts[1] : undefined;
      await send({ action: 'sickness.report', requestId, fromDate, extent, forecast, declared,
        ...(clockOut ? { clockOut: true } : startMinute !== undefined ? { startMinute } : {}) }); return;
    }
    if (!active) return;
    const common = { requestId, id: active.id, revision: active.revision };
    if (mode === 'confirm') await send({ ...common, action: 'sickness.confirm', extent, forecast });
    if (mode === 'forecast') await send({ ...common, action: 'sickness.forecast', forecast });
    if (mode === 'declare') await send({ ...common, action: 'sickness.declare', declared: true });
    if (mode === 'recover_cancel') await send({ ...common, action: 'sickness.recovery.cancel' });
    if (mode === 'recover') {
      if (returnWhen === 'tomorrow' || returnWhen === 'date') {
        await send({ ...common, action: 'sickness.recovery.schedule', healthyFromDate: returnWhen === 'tomorrow' ? shiftDay(data.today, 1) : healthyFromDate }); return;
      }
      await send({ ...common, action: 'sickness.recover', lastSickDate: returnWhen === 'today' ? shiftDay(data.today, -1) : data.today,
        ...(returnWhen === 'now' ? { recoveryMinute: minuteAt(currentInstant()) } : {}) });
    }
  }
  async function upload(file?: File) {
    if (!file || !session || !active || uploading || !online) return;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024) { setUploadMessage('Välj en PDF, JPG eller PNG på högst 5 MB.'); return; }
    const expected = scope, caseId = active.id; setUploading(true); setUploadMessage('');
    try {
      const result = await fetch(`/api/employee/sickness/files?caseId=${encodeURIComponent(caseId)}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name), 'X-Employee-Company': employeeCompanyId(session.companyId), 'X-Employee-Person': session.person.id }, body: file });
      const value = await result.json().catch(() => null);
      if (!result.ok || !value?.file?.id) throw new Error(value?.error || 'Intyget kunde inte bekräftas uppladdat.');
      if (mounted.current && scopeRef.current === expected) setUploadMessage('Intyget är uppladdat. Din chef kontrollerar vilka datum det gäller.');
    } catch (caught) { if (mounted.current && scopeRef.current === expected) setUploadMessage(employeeError(caught)); }
    finally { if (mounted.current && scopeRef.current === expected) { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; } }
  }
  if (!session || session.support || session.person.kind === 'external') return null;
  return <section className={`employee-sickness${active ? ' ongoing' : ''}`} aria-label="Sjukanmälan och friskanmälan">
    {!data ? <p role="status">Hämtar sjukfrånvaro…</p> : active ? <>
      <header><HeartPulse size={23} /><div><h2>Du är sjukanmäld</h2><p>Från {fullDayLabel(active.fromDate)} · {active.extent} %</p></div></header>
      {active.recoveryPlan && <Notice tone="green">Friskanmälan registrerad – frisk från {fullDayLabel(active.recoveryPlan.healthyFromDate)}. Du är fortfarande sjukanmäld fram till dess.</Notice>}
      <p>{active.forecast.kind === 'date' && active.forecast.date ? `Uppskattad återgång ${fullDayLabel(active.forecast.date)}.` : 'Återgång är ännu inte uppskattad.'} Prognosen avslutar inte frånvaron.</p>
      {data.policy.dailyContact && <Notice tone={active.lastContactDate === data.today ? 'green' : 'amber'}>{active.lastContactDate === data.today ? 'Fortsatt sjukfrånvaro är bekräftad idag.' : 'Bekräfta fortsatt sjukfrånvaro enligt arbetsplatsens dagliga kontakt­rutin.'}</Notice>}
      <div className="employee-sickness-actions"><Button variant="danger" disabled={busy || Boolean(pending)} onClick={() => open('confirm')}>Jag är fortfarande sjuk</Button><Button variant="outline" disabled={busy || Boolean(pending)} onClick={() => open('recover')}>{active.recoveryPlan ? 'Ändra friskanmälan' : 'Friskanmäl mig'}</Button></div>
      {active.recoveryPlan && <button type="button" className="employee-text" disabled={busy || Boolean(pending)} onClick={() => open('recover_cancel')}>Återkalla friskanmälan</button>}
      <button type="button" className="employee-text" disabled={busy || Boolean(pending)} onClick={() => open('forecast')}>Ändra uppskattad återgång</button>
      {!active.declared && <button type="button" className="employee-text" disabled={busy || Boolean(pending)} onClick={() => open('declare')}>Lämna sjukförsäkran</button>}
      {active.followup.certificateRequired && <div className="employee-sickness-certificate"><Notice tone="amber">Läkarintyg behövs enligt registrerad rutin. Normalt gäller det från dag 8. Du behöver inte ange diagnos i appen.</Notice><input ref={uploadInput} type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Välj läkarintyg" disabled={uploading || !online} onChange={event => void upload(event.target.files?.[0])} /><Button variant="outline" icon={FileUp} disabled={uploading || !online} onClick={() => uploadInput.current?.click()}>{uploading ? 'Laddar upp…' : 'Ladda upp läkarintyg'}</Button>{uploadMessage && <p role="status">{uploadMessage}</p>}</div>}
      {active.timeIssue && <Notice tone="amber">Din chef behöver följa upp berörda tidsuppgifter. Redan arbetade timmar och attesterade perioder ändras inte automatiskt.</Notice>}
    </> : <Button variant="danger" icon={HeartPulse} disabled={busy || Boolean(pending)} onClick={() => open('report')}>{data.activeClock || data.activeWork ? 'Stämpla ut och sjukanmäl' : 'Sjukanmälan'}</Button>}
    {(busy || pending?.inFlight) && <p role="status">Sparar registreringen…</p>}{!online && <Notice tone="amber">Sjukanmälan behöver anslutning. Kontakta din chef om du inte kan ansluta.</Notice>}
    {error && <Notice tone="red">{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    {(pending?.uncertain || !data && error) && <div className="employee-sickness-actions"><Button variant="outline" icon={RefreshCw} disabled={busy || !online} onClick={() => void reconcile()}>Kontrollera registreringen</Button>{pending?.uncertain && <Button variant="outline" disabled={busy || !online} onClick={() => void send(pending.command)}>Skicka samma försök</Button>}</div>}
    {expanded && data && data.cases.filter(item => item.id !== active?.id).slice(0, 5).map(item => <div className="employee-sickness-history" key={item.id}><strong>{fullDayLabel(item.fromDate)}{item.lastSickDate ? `–${fullDayLabel(item.lastSickDate)}` : ''}</strong><span>{item.extent} % · {item.status === 'recovered' ? 'Friskanmäld' : 'Pågår'}</span></div>)}
    {mode && data && <Modal title={mode === 'report' ? 'Sjukanmälan' : mode === 'recover' ? 'Friskanmälan' : mode === 'recover_cancel' ? 'Återkalla friskanmälan' : mode === 'declare' ? 'Sjukförsäkran' : mode === 'forecast' ? 'Uppskattad återgång' : 'Bekräfta fortsatt sjukfrånvaro'} onClose={() => setMode(undefined)}><form className="employee-form employee-sickness-form" onSubmit={event => void submit(event)}>
      {mode === 'report' && <><label>Första sjukdagen<input type="date" value={fromDate} max={data.today} required disabled={busy || Boolean(pending)} onChange={event => { setFromDate(event.target.value); setStartTime(''); }} /></label>{data.activeClock || data.activeWork ? <Notice>Pågående stämpling och uppdragstid avslutas när anmälan sparas. Redan arbetad tid behålls.</Notice> : <label>Sjuk från klockan (lämna tomt för hela arbetsdagen)<input type="time" value={startTime} disabled={busy || Boolean(pending)} onChange={event => setStartTime(event.target.value)} /></label>}</>}
      {(mode === 'report' || mode === 'confirm') && <label>Sjukfrånvarons omfattning<select value={extent} disabled={busy || Boolean(pending)} onChange={event => setExtent(Number(event.target.value) as SicknessExtent)}>{[100, 75, 50, 25].map(value => <option key={value} value={value}>{value} % av ordinarie arbetstid</option>)}</select></label>}
      {mode === 'confirm' && active?.recoveryPlan && <Notice>Friskanmälan från {fullDayLabel(active.recoveryPlan.healthyFromDate)} behålls. Om du fortfarande kommer att vara sjuk då behöver du ändra eller återkalla friskanmälan.</Notice>}
      {['report', 'confirm', 'forecast'].includes(mode) && <><label>När tror du att du kan arbeta igen?<select value={forecastKind} disabled={busy || Boolean(pending)} onChange={event => setForecastKind(event.target.value as SicknessForecast['kind'])}><option value="unknown">Vet inte ännu</option><option value="date">Ange uppskattat datum</option></select></label>{forecastKind === 'date' && <label>Uppskattad återgång<input type="date" required min={data.today} value={forecastDate} disabled={busy || Boolean(pending)} onChange={event => setForecastDate(event.target.value)} /></label>}<p className="employee-subtle">Detta är en prognos för planeringen. Du är sjukanmäld tills du friskanmäl­er dig.</p></>}
      {(mode === 'report' || mode === 'declare') && <label className="employee-checkbox"><input type="checkbox" checked={declared} required disabled={busy || Boolean(pending)} onChange={event => setDeclared(event.target.checked)} />Jag intygar att sjukdom sätter ned min arbetsförmåga i den angivna omfattningen. Jag lämnar inga diagnosuppgifter.</label>}
      {mode === 'recover' && <><label>När är du frisk?<select value={returnWhen} disabled={busy || Boolean(pending)} onChange={event => setReturnWhen(event.target.value as ReturnWhen)}><option value="now">Nu, under dagen</option>{active && active.fromDate < data.today && <option value="today">Från och med idag</option>}<option value="tomorrow">Från imorgon</option><option value="date">Välj datum</option></select></label>{returnWhen === 'date' && <label>Frisk från datum<input type="date" required min={shiftDay(data.today, 1)} max={shiftDay(data.today, 366)} value={healthyFromDate} disabled={busy || Boolean(pending)} onChange={event => setHealthyFromDate(event.target.value)} /></label>}<p className="employee-subtle">Datumet gäller när du är frisk, även om nästa arbetspass börjar senare.</p><Notice tone="green">{returnWhen === 'tomorrow' || returnWhen === 'date' ? 'Friskanmälan registreras nu och sjukperioden avslutas från det valda datumet. Fram till dess är du sjukanmäld.' : 'Friskanmälan avslutar sjukperioden.'} Instämpling görs separat när du börjar arbeta.</Notice></>}
      {mode === 'recover_cancel' && <Notice tone="amber">Friskanmälan från {active?.recoveryPlan && fullDayLabel(active.recoveryPlan.healthyFromDate)} återkallas. Din sjukfrånvaro fortsätter tills du registrerar en ny friskanmälan.</Notice>}
      {error && <Notice tone="red">{error}</Notice>}{!online && <Notice tone="amber">Registreringen kan inte sparas offline.</Notice>}
      <Button type="submit" variant={mode === 'recover' ? 'blue' : 'danger'} icon={mode === 'recover' ? Check : Activity} disabled={busy || !online || Boolean(pending)}>{busy ? 'Sparar…' : mode === 'report' ? data.activeClock || data.activeWork ? 'Avsluta pass och sjukanmäl' : 'Registrera sjukanmälan' : mode === 'recover' ? 'Registrera friskanmälan' : mode === 'recover_cancel' ? 'Återkalla friskanmälan' : 'Spara'}</Button><Button variant="outline" disabled={busy} onClick={() => setMode(undefined)}>Avbryt</Button>
    </form></Modal>}
  </section>;
}
