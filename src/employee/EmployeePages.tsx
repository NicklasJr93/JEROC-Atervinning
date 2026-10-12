import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CalendarDays, Check, CheckCircle2, ChevronRight, Clock3, Eye, EyeOff, HelpCircle, LockKeyhole, LogOut, Mail, MapPin, Pencil, Phone, Play, Plus, RefreshCw, Scale, Settings2, Square, Trash2, Truck, UserRound } from 'lucide-react';
import { Button, Logo, MenuRow, Nav, Notice } from '../components';
import { useDemo } from '../store';
import { draftPath, recentDraftFirst } from '../model';
import { actionLabels, transportStatusLabels } from '../office/transport/types';
import type { LogisticsDriverCommand } from '../office/logistics/types';
import DriverLogistics from '../driver/DriverLogistics';
import { Calendar, capitalize, fullDayLabel, hoursLabel, minuteLabel } from './Calendar';
import { employeeError, employeeRequest, stockholmDay, useEmployee } from './EmployeeProvider';
import type { EmployeeAccountPerson, EmployeeOrder, EmployeeOverview, EmployeeRequirement, EmployeeRequirementPerson, EmployeeTimeDraft, EmployeeTimeEntry } from './types';
import './employee.css';
import { tenantPublicHeaders } from '../tenant-public-context';
import { ActiveSitePicker } from './ActiveSitePicker';

function Page({ title, subtitle, children, back, sitePicker = false }: { title: string; subtitle?: string; children: ReactNode; back?: string; sitePicker?: boolean }) {
  const navigate = useNavigate();
  return <><main className="employee-page"><header className="employee-page-heading">{back && <button className="icon-button" aria-label="Tillbaka" onClick={() => navigate(back)}><ArrowLeft size={22} /></button>}<div className="employee-heading-copy"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{sitePicker && <ActiveSitePicker />}</header>{children}</main><Nav /></>;
}
function Empty({ children, icon = 'calendar' }: { children: ReactNode; icon?: 'calendar' | 'clock' | 'truck' }) {
  return <div className="employee-empty">{icon === 'clock' ? <Clock3 size={28} /> : icon === 'truck' ? <Truck size={28} /> : <CalendarDays size={28} />}<p>{children}</p></div>;
}
function useFocus(defaultDate?: string) {
  const { overview, refresh } = useEmployee();
  const [search, setSearch] = useSearchParams();
  const proposed = search.get('date');
  const parsed = proposed && /^\d{4}-\d{2}-\d{2}$/.test(proposed) ? new Date(`${proposed}T12:00:00Z`) : null;
  const date = parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(proposed!) ? proposed! : defaultDate || overview?.today || stockholmDay();
  useEffect(() => { void refresh({ month: date.slice(0, 7), date }).catch(() => undefined); }, [date, refresh]);
  const select = (next: string) => setSearch(previous => { const value = new URLSearchParams(previous); value.set('date', next); return value; });
  return { date, search, setSearch, select };
}
function OverviewError() {
  const { error, refresh, refreshing } = useEmployee();
  return error ? <div className="employee-error"><Notice tone="red">{error}</Notice><button className="employee-text" disabled={refreshing} onClick={() => void refresh().catch(() => undefined)}><RefreshCw size={16} />Försök igen</button></div> : null;
}

export function EmployeeLoginPage() {
  const { login, error: loadError } = useEmployee();
  const navigate = useNavigate();
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [show, setShow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [demoAccounts, setDemoAccounts] = useState<{ niklas?: boolean; admin?: boolean } | null>(null);
  const [companyName, setCompanyName] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void tenantPublicHeaders().then(headers => fetch('/api/employee/demo-config', { credentials: 'same-origin', cache: 'no-store', headers, signal: controller.signal }))
      .then(async response => response.ok ? response.json() : null)
      .then(result => { if (!controller.signal.aborted) { if (result?.enabled === true) setDemoAccounts(result.accounts); if (typeof result?.companyName === 'string') setCompanyName(result.companyName); } })
      .catch(() => { /* Optional demo shortcuts never block real authentication. */ });
    return () => controller.abort();
  }, []);
  function chooseDemo(account: 'niklas' | 'admin') {
    if (busy) return;
    setUsername(account);
    setPassword(account === 'niklas' ? 'Demo123!' : 'JerocDemo2026!');
    setShow(false); setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await login(username, password); navigate('/', { replace: true }); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  return <main className="employee-login"><Logo /><h1>Välkommen tillbaka</h1><p>{companyName ? `Logga in på ditt personalkonto hos ${companyName}.` : 'Logga in på ditt personalkonto.'}</p><form onSubmit={submit} className="stack"><label>Användarnamn<div className="input-with-icon"><UserRound size={18} /><input required autoComplete="username" autoCapitalize="none" autoCorrect="off" disabled={busy} value={username} onChange={event => setUsername(event.target.value)} /></div></label><label>Lösenord<div className="input-with-icon"><LockKeyhole size={18} /><input required type={show ? 'text' : 'password'} autoComplete="current-password" disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /><button className="icon-button" type="button" aria-label={show ? 'Dölj lösenord' : 'Visa lösenord'} onClick={() => setShow(value => !value)}>{show ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>{(error || loadError) && <Notice tone="red">{error || loadError}</Notice>}<Button type="submit" variant="blue" disabled={busy}>{busy ? 'Loggar in…' : 'Logga in'}</Button></form>{(demoAccounts?.niklas || demoAccounts?.admin) && <section className="employee-demo-login" aria-label="Demoinloggning"><p>Prova demon</p><div>{demoAccounts.niklas && <button type="button" disabled={busy} onClick={() => chooseDemo('niklas')}><UserRound size={19} /><span>Logga in som Niklas</span></button>}{demoAccounts.admin && <button type="button" disabled={busy} onClick={() => chooseDemo('admin')}><Settings2 size={19} /><span>Logga in som chef/admin</span></button>}</div></section>}<p className="employee-help"><HelpCircle size={17} />Behöver du hjälp? Kontakta din chef eller systemadmin.</p></main>;
}

export function EmployeeHomePage() {
  const { overview, session, refresh } = useEmployee();
  const { data, markDraftActive, sharedReady } = useDemo();
  const navigate = useNavigate();
  useEffect(() => { const date = stockholmDay(); void refresh({ date, month: date.slice(0, 7) }).catch(() => undefined); }, [refresh]);
  if (!session || !overview) return <Page title="Hem"><Empty>Hämtar din dag…</Empty><OverviewError /></Page>;
  const today = overview.today;
  const todayOrders = overview.orders.filter(order => order.date === today && order.status !== 'cancelled').sort((a, b) => (a.startMinute ?? 1440) - (b.startMinute ?? 1440));
  const next = todayOrders.find(order => order.status !== 'done');
  const schedule = overview.date === today ? overview.selectedDay.schedules[0] : undefined;
  const ongoing = sharedReady ? data.drafts.filter(draft => draft.status !== 'ready').sort(recentDraftFirst)[0] : undefined;
  const ongoingSite = session.sites.find(site => site.id === ongoing?.siteId);
  return <Page title={`Hej, ${session.person.name.split(' ')[0]}!`} subtitle={capitalize(fullDayLabel(today))} sitePicker><OverviewError />
    <section className="employee-card employee-day-overview"><h2>Din dag</h2><div className="employee-two-stat"><div><span>Arbetspass</span><strong>{schedule ? `${minuteLabel(schedule.startMinute)}–${minuteLabel(schedule.endMinute)}` : 'Inget planerat'}</strong></div><div><span>Dagens uppdrag</span><strong>{todayOrders.length} {todayOrders.length === 1 ? 'jobb' : 'jobb'}</strong></div></div>{next ? <button className="employee-next-job" onClick={() => navigate(`/assignments?order=${encodeURIComponent(next.id)}`)}><span className="employee-tile-icon blue"><Truck size={25} /></span><span><small>Nästa{next.startMinute !== undefined ? ` · ${minuteLabel(next.startMinute)}–${minuteLabel(next.startMinute + next.durationMinutes)}` : ''}</small><strong>{actionLabels[next.action]} · {next.customerName}</strong><span>{next.city || next.address}</span></span><ChevronRight size={21} /></button> : <p className="employee-subtle">Inga fler planerade uppdrag idag.</p>}</section>
    <section className="employee-section"><h2>Vad vill du göra?</h2>{session.capabilities.yardWork && <MenuRow title="Gårdsarbete" description="Väg in, vägningar och prislista" icon={Scale} onClick={() => navigate('/yard')} />}{session.capabilities.assignedOrders && <MenuRow title="Mina uppdrag" description="Arbetsorder och transportdokument" icon={Truck} trailing={todayOrders.filter(order => order.status !== 'done').length > 0 ? String(todayOrders.filter(order => order.status !== 'done').length) : undefined} onClick={() => navigate('/assignments')} />}{session.capabilities.employeeTime && <MenuRow title="Schema & tid" description="Mitt schema, tidrapportering och ledighet" icon={CalendarDays} onClick={() => navigate('/schedule')} />}</section>
    {(overview.activeWork || ongoing && session.capabilities.yardWork) && <section className="employee-section"><h2>Fortsätt där du var</h2>{overview.activeWork && <MenuRow title="Pågående arbetstid" description={`${overview.activeWork.orderId} · startad ${new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date(overview.activeWork.startedAt))}`} icon={Clock3} onClick={() => navigate(`/assignments?order=${encodeURIComponent(overview.activeWork!.orderId)}`)} />}{ongoing && session.capabilities.yardWork && <MenuRow title={ongoing.vehicleInput?.registration || `Vägning #${ongoing.number}`} description={`${ongoing.status === 'awaiting-exit' ? 'Väntar på utvägning' : 'Fortsätt din invägning'}${ongoingSite ? ` · ${ongoingSite.name}` : ''}`} icon={Scale} onClick={() => { markDraftActive(ongoing.id); navigate(draftPath(ongoing)); }} />}</section>}
  </Page>;
}

function JobCard({ order }: { order: EmployeeOrder }) {
  const navigate = useNavigate();
  return <button className={`employee-job ${order.status === 'done' ? 'complete' : ''}`} onClick={() => navigate(`/assignments?order=${encodeURIComponent(order.id)}`)}><span className="employee-tile-icon blue"><Truck size={24} /></span><span className="employee-job-copy"><small>{order.startMinute !== undefined ? `${minuteLabel(order.startMinute)}–${minuteLabel(order.startMinute + order.durationMinutes)}` : 'Tid ej bokad'}</small><strong>{actionLabels[order.action] || 'Uppdrag'}</strong><span>{order.customerName}</span><small>{order.city || order.address}</small></span>{order.status === 'done' ? <CheckCircle2 size={21} /> : <ChevronRight size={20} />}</button>;
}

export function EmployeeSchedulePage() {
  const { overview } = useEmployee();
  const { date, select } = useFocus();
  const [view, setView] = useState<'day' | 'week' | 'month'>('month');
  const selected = overview?.date === date ? overview.selectedDay : undefined;
  const agendaOrders = (selected?.orders || []).filter(order => order.status !== 'cancelled').sort((a, b) => (a.startMinute ?? 1440) - (b.startMinute ?? 1440));
  const jobCounts: Record<string, number> = {};
  for (const order of overview?.orders || []) if (order.date && order.status !== 'cancelled') jobCounts[order.date] = (jobCounts[order.date] || 0) + 1;
  return <Page title="Mitt schema"><OverviewError /><div className="employee-segments" aria-label="Kalendervy">{(['day', 'week', 'month'] as const).map((value, index) => <button type="button" key={value} className={view === value ? 'active' : ''} aria-pressed={view === value} onClick={() => setView(value)}>{['Dag', 'Vecka', 'Månad'][index]}</button>)}</div><Calendar date={date} today={overview?.today || stockholmDay()} days={overview?.days || []} kind="jobs" view={view} jobCounts={jobCounts} onSelect={select} onMove={select} />{view !== 'day' && <div className="employee-calendar-key"><span><i className="job-dot" />Antal jobb</span><span><i className="leave-dot" />Registrerad frånvaro</span></div>}
    <section className="employee-agenda" aria-label="Jobb för vald dag"><div className="employee-section-title"><h2>{capitalize(fullDayLabel(date))}</h2>{Boolean(agendaOrders.length) && <span className="employee-count">{agendaOrders.length} jobb</span>}</div>{selected?.schedules.map(schedule => <p className="employee-shift" key={schedule.id}>{minuteLabel(schedule.startMinute)}–{minuteLabel(schedule.endMinute)} · Arbetspass</p>)}{selected?.absences.filter(absence => absence.status !== 'cancelled').map(absence => <div className="employee-absence" key={absence.id}><CalendarDays size={17} />{absenceLabels[absence.kind || 'leave'] || 'Frånvaro'}{!absence.allDay && absence.startMinute !== undefined && absence.endMinute !== undefined ? ` · ${minuteLabel(absence.startMinute)}–${minuteLabel(absence.endMinute)}` : ' · Heldag'}</div>)}{agendaOrders.length ? agendaOrders.map(order => <JobCard key={order.id} order={order} />) : <Empty>{selected ? 'Inga uppdrag planerade för denna dag.' : 'Hämtar vald dag…'}</Empty>}</section>
  </Page>;
}

const absenceLabels: Record<string, string> = { sick: 'Sjukfrånvaro', holiday: 'Semester', vab: 'VAB', leave: 'Ledighet', training: 'Utbildning' };
const leaveStatusLabels: Record<string, string> = { pending: 'Inväntar beslut', approved: 'Godkänd', rejected: 'Avslagen', cancelled: 'Återtagen' };

export function EmployeeTimePage() {
  const { overview } = useEmployee();
  const { date, search, setSearch, select } = useFocus();
  const register = search.get('register') === '1';
  const editId = search.get('entry');
  const leave = search.get('leave') === '1';
  const balances = search.get('balances') === '1';
  const selected = overview?.date === date ? overview.selectedDay : undefined;
  const edit = selected?.entries.find(entry => entry.id === editId);
  const registerTime = (entry?: EmployeeTimeEntry) => setSearch({ date, register: '1', ...(entry ? { entry: entry.id } : {}) });
  const closeForm = () => setSearch({ date });
  if (leave) return <LeaveForm onClose={closeForm} />;
  if (balances) return <LeaveAndBalances overview={overview} onClose={closeForm} />;
  if (register && editId && !selected) return <Page title="Ändra registrerad tid" back={`/time?date=${date}`}><Empty icon="clock">Hämtar tidrapporten…</Empty><OverviewError /></Page>;
  if (register && editId && (!edit || edit.source !== 'manual')) return <Page title="Registrerad tid" back={`/time?date=${date}`}><Notice tone="amber">{edit?.source === 'order' ? 'Uppdragstid registreras med start och stopp på arbetsordern. Den kan inte ändras som manuell tid.' : 'Tidsposten kunde inte hittas. Öppna dagen igen.'}</Notice><Button variant="outline" onClick={closeForm}>Till tidrapportering</Button></Page>;
  if (register) return <TimeForm key={`${date}:${editId || 'new'}`} date={date} entry={edit} loadingEntry={false} onClose={closeForm} />;
  return <Page title="Tidrapportering"><OverviewError /><GateNotice /><ActiveWorkStop />
    <div className="employee-hours-total"><Clock3 size={29} /><span><strong>{hoursLabel(overview?.summary.recordedMinutes || 0)} registrerat</strong><small>Arbetad tid efter rast</small></span></div><Calendar date={date} today={overview?.today || stockholmDay()} days={overview?.days || []} kind="time" onSelect={select} onMove={select} />
    <section className="employee-section"><div className="employee-section-title"><h2>{capitalize(fullDayLabel(date))}</h2><strong className="employee-hours">{hoursLabel(selected?.recordedMinutes || 0)}</strong></div><div className="employee-day-requirement"><span>Timkrav {hoursLabel(selected?.expectedMinutes || 0)}</span><span className={selected?.missingMinutes ? 'missing' : 'complete'}>{selected?.missingMinutes ? `Saknas ${hoursLabel(selected.missingMinutes)}` : 'Ingen tid saknas'}</span></div>
      {selected?.entries.length ? selected.entries.map(entry => <TimeEntryCard key={entry.id} entry={entry} onEdit={() => registerTime(entry)} />) : <Empty icon="clock">{selected ? 'Ingen arbetstid registrerad för denna dag.' : 'Hämtar vald dag…'}</Empty>}
      {selected?.absences.map(absence => <div className="employee-absence" key={absence.id}><CalendarDays size={17} />{absenceLabels[absence.kind || 'leave'] || 'Frånvaro'}</div>)}
      <Button variant="blue" icon={Plus} onClick={() => registerTime()}>Registrera tid</Button><Button variant="outline" icon={CalendarDays} onClick={() => setSearch({ date, leave: '1' })}>Ansök om ledighet</Button><button className="employee-text centered" onClick={() => setSearch({ date, balances: '1' })}>Ledighet & saldon<ChevronRight size={17} /></button>
    </section>
  </Page>;
}

function GateNotice() {
  const { overview } = useEmployee();
  const navigate = useNavigate(), location = useLocation();
  const gate = overview?.gate;
  const selectedDate = new URLSearchParams(location.search).get('date');
  return gate?.blocked && gate.date ? <Notice tone="amber">Tid saknas för <strong>{fullDayLabel(gate.date)}</strong>. Registrera {hoursLabel(gate.missingMinutes)} för att fortsätta arbeta i appen.{selectedDate !== gate.date && <button className="employee-text" onClick={() => navigate(`/time?date=${gate.date}&register=1`)}>Öppna dagen som saknar tid<ChevronRight size={16} /></button>}</Notice> : null;
}

function TimeEntryCard({ entry, onEdit }: { entry: EmployeeTimeEntry; onEdit: () => void }) {
  const content = <><span><small>{minuteLabel(entry.startMinute)}–{minuteLabel(entry.endMinute)}{entry.breakMinutes > 0 ? ` · Rast ${entry.breakMinutes} min` : ''}</small><strong>{entry.orderName || entry.activity}</strong><span>{entry.orderId ? `${entry.orderId} · ` : ''}{entry.siteName || entry.activity}</span>{entry.note && <small>{entry.note}</small>}<small>{entry.source === 'order' ? 'Registrerad från arbetsorder' : 'Manuellt registrerad'}</small></span><span><strong>{hoursLabel(entry.minutes)}</strong>{entry.source === 'manual' && <Pencil size={17} />}</span></>;
  return entry.source === 'manual' ? <button className="employee-time-entry" onClick={onEdit} aria-label={`Ändra tid ${minuteLabel(entry.startMinute)}–${minuteLabel(entry.endMinute)}, ${entry.activity}`}>{content}</button> : <article className="employee-time-entry">{content}</article>;
}

function ActiveWorkStop() {
  const { overview, commandOrder } = useEmployee();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = overview?.activeWork;
  if (!active) return null;
  async function stop() { if (!active || busy) return; setBusy(true); setError(''); try { await commandOrder(active.orderId, 'stop'); } catch (caught) { setError(employeeError(caught)); } finally { setBusy(false); } }
  return <div className="employee-active-work"><Notice tone="blue">Uppdragstid pågår för <strong>{active.orderId}</strong>. Avsluta den innan du registrerar överlappande manuell tid.</Notice>{error && <Notice tone="red">{error}</Notice>}<Button variant="outline" icon={Square} disabled={busy} onClick={() => void stop()}>{busy ? 'Sparar uppdragstid…' : 'Avsluta pågående arbetstid'}</Button></div>;
}

function TimeForm({ date, entry, loadingEntry, onClose }: { date: string; entry?: EmployeeTimeEntry; loadingEntry: boolean; onClose: () => void }) {
  const { saveTime, removeTime, overview, session } = useEmployee();
  const [day, setDay] = useState(entry?.date || date), [from, setFrom] = useState(minuteLabel(entry?.startMinute ?? 420)), [to, setTo] = useState(minuteLabel(entry?.endMinute ?? 960));
  const [rest, setRest] = useState(String(entry?.breakMinutes ?? 60)), [activity, setActivity] = useState(entry?.activity || 'Gårdsarbete');
  const [orderId, setOrderId] = useState(entry?.orderId || ''), [siteId, setSiteId] = useState(entry?.siteId || session?.activeSiteId || '');
  const [note, setNote] = useState(entry?.note || ''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const asMinutes = (value: string) => { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; };
  const minutes = asMinutes(to) - asMinutes(from) - Number(rest);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || loadingEntry) return;
    if (minutes <= 0 || !Number.isFinite(minutes)) { setError('Välj en sluttid efter starttiden och kontrollera rasten.'); return; }
    setBusy(true); setError('');
    try {
      const draft: EmployeeTimeDraft = { ...(entry ? { id: entry.id, revision: entry.revision } : {}), date: day, startMinute: asMinutes(from), endMinute: asMinutes(to), breakMinutes: Number(rest), activity: activity.trim(), note: note.trim(), ...(orderId ? { orderId } : {}), ...(siteId ? { siteId } : {}) };
      await saveTime(draft); onClose();
    } catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!entry || busy) return; setBusy(true); setError('');
    try { await removeTime(entry.id, entry.revision); onClose(); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  return <Page title={entry ? 'Ändra registrerad tid' : 'Registrera tid'} back={`/time?date=${date}`}><GateNotice /><ActiveWorkStop /><p className="employee-subtle">Registrera den tid du faktiskt arbetade. Planerade uppdrag räknas inte automatiskt som arbetstid.</p><form className="employee-form" onSubmit={save} aria-busy={busy}>
    <label>Datum<input required type="date" max={overview?.today || stockholmDay()} value={day} disabled={busy || Boolean(entry)} onChange={event => setDay(event.target.value)} /></label><div className="split"><label>Från<input required type="time" value={from} disabled={busy} onChange={event => setFrom(event.target.value)} /></label><label>Till<input required type="time" value={to} disabled={busy} onChange={event => setTo(event.target.value)} /></label></div><label>Rast (minuter)<input required type="number" min="0" max="1440" step="1" inputMode="numeric" value={rest} disabled={busy} onChange={event => setRest(event.target.value)} /></label><div className="employee-duration"><Clock3 size={19} /><strong>{minutes > 0 ? hoursLabel(minutes) : 'Kontrollera tiderna'}</strong><span>Arbetad tid</span></div>
    <label>Aktivitet<select required value={activity} disabled={busy} onChange={event => setActivity(event.target.value)}>{[...new Set(['Gårdsarbete', 'Transport', 'Underhåll', 'Administration', 'Utbildning', 'Övrig arbetstid', ...(entry?.activity ? [entry.activity] : [])])].map(value => <option key={value}>{value}</option>)}</select></label><label>Arbetsorder (valfritt)<select value={orderId} disabled={busy} onChange={event => setOrderId(event.target.value)}><option value="">Ingen arbetsorder · intern tid</option>{(overview?.orders || []).map(order => <option key={order.id} value={order.id}>{order.id} · {order.customerName}</option>)}{entry?.orderId && !overview?.orders.some(order => order.id === entry.orderId) && <option value={entry.orderId}>{entry.orderId} · {entry.orderName || 'Arbetsorder'}</option>}</select></label><label>Anläggning<select value={siteId} disabled={busy} onChange={event => setSiteId(event.target.value)}><option value="">Välj anläggning</option>{session?.sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Anteckning (valfritt)<textarea rows={3} maxLength={2000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="T.ex. städning och sortering mellan uppdrag" /></label>{error && <Notice tone="red">{error}</Notice>}{loadingEntry && <Notice>Hämtar tidrapporten…</Notice>}<Button type="submit" variant="blue" icon={Check} disabled={busy || loadingEntry}>{busy ? 'Sparar…' : 'Spara tid'}</Button><Button variant="outline" disabled={busy} onClick={onClose}>Avbryt</Button>{entry && (confirmDelete ? <div className="employee-delete-confirm"><Notice tone="amber">Ta bort denna tidsregistrering? Dagens timkrav kontrolleras igen.</Notice><Button variant="danger" disabled={busy} onClick={() => void remove()}>Ja, ta bort tiden</Button><button type="button" className="employee-text" disabled={busy} onClick={() => setConfirmDelete(false)}>Behåll tiden</button></div> : <button type="button" className="employee-text danger" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={17} />Ta bort registrerad tid</button>)}
  </form></Page>;
}

function LeaveForm({ onClose }: { onClose: () => void }) {
  const { requestLeave, overview } = useEmployee();
  const [kind, setKind] = useState('holiday'), [fromDate, setFromDate] = useState(overview?.today || stockholmDay()), [toDate, setToDate] = useState(overview?.today || stockholmDay()), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await requestLeave({ kind, fromDate, toDate, note }); navigate('/time?balances=1', { replace: true }); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  return <Page title="Ansök om ledighet" back="/time"><GateNotice /><p className="employee-subtle">Ansökan blir ledighet först när din chef har godkänt den.</p><form className="employee-form" onSubmit={submit}><label>Typ av ledighet<select value={kind} disabled={busy} onChange={event => setKind(event.target.value)}><option value="holiday">Semester</option><option value="leave">Annan ledighet</option></select></label><label>Från datum<input required type="date" value={fromDate} disabled={busy} onChange={event => { setFromDate(event.target.value); if (toDate < event.target.value) setToDate(event.target.value); }} /></label><label>Till datum<input required type="date" min={fromDate} value={toDate} disabled={busy} onChange={event => setToDate(event.target.value)} /></label><label>Meddelande till chef<textarea maxLength={2000} rows={4} value={note} disabled={busy} onChange={event => setNote(event.target.value)} /></label>{error && <Notice tone="red">{error}</Notice>}<Button type="submit" variant="blue" disabled={busy}>{busy ? 'Skickar…' : 'Skicka ansökan'}</Button><Button variant="outline" disabled={busy} onClick={onClose}>Avbryt</Button></form></Page>;
}

function LeaveAndBalances({ overview, onClose }: { overview: EmployeeOverview | null; onClose: () => void }) {
  const { cancelLeave } = useEmployee();
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('');
  async function cancel(id: string, revision: number) { setBusy(id); setError(''); try { await cancelLeave(id, revision); } catch (caught) { setError(employeeError(caught)); } finally { setBusy(null); } }
  return <Page title="Ledighet & saldon" back="/time"><GateNotice />{error && <Notice tone="red">{error}</Notice>}<section className="employee-card"><h2>Mina saldon</h2>{overview?.balances.available ? <div className="employee-details"><div><span>Semesterdagar</span><strong>{overview.balances.holidayDays ?? '—'}</strong></div><div><span>Flex</span><strong>{hoursLabel(overview.balances.flexMinutes || 0)}</strong></div><div><span>Komp</span><strong>{hoursLabel(overview.balances.compMinutes || 0)}</strong></div></div> : <p className="employee-subtle">Semester-, flex- och kompsaldon har ännu inte lagts in. Kontakta din chef för ditt aktuella saldo.</p>}</section><section className="employee-section"><h2>Mina ansökningar</h2>{overview?.leaveRequests.length ? overview.leaveRequests.map(request => <article className="employee-card" key={request.id}><div className="employee-section-title"><h3>{absenceLabels[request.kind] || 'Ledighet'}</h3><span className={`employee-status ${request.status}`}>{leaveStatusLabels[request.status] || request.status}</span></div><p>{capitalize(fullDayLabel(request.fromDate))}–{fullDayLabel(request.toDate)}</p>{request.note && <p className="employee-subtle">{request.note}</p>}{request.status === 'pending' && <button className="employee-text danger" disabled={Boolean(busy)} onClick={() => void cancel(request.id, request.revision)}>{busy === request.id ? 'Återtar…' : 'Återta ansökan'}</button>}</article>) : <Empty>Du har inga ledighetsansökningar.</Empty>}</section><Button variant="outline" onClick={onClose}>Till tidrapportering</Button></Page>;
}

export function EmployeeProfilePage() {
  const { session, overview, logout, updateProfile, changePassword } = useEmployee();
  const location = useLocation(), navigate = useNavigate();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [phone, setPhone] = useState(session?.person.phone || ''), [email, setEmail] = useState(session?.person.email || '');
  const [currentPassword, setCurrentPassword] = useState(''), [password, setPassword] = useState(''), [repeat, setRepeat] = useState('');
  if (!session) return null;
  if (location.pathname.endsWith('/accounts')) return <EmployeeAccountPage />;
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (location.pathname.endsWith('/password')) {
        if (password !== repeat) { setError('De nya lösenorden matchar inte.'); return; }
        await changePassword(currentPassword, password); setCurrentPassword(''); setPassword(''); setRepeat('');
      } else await updateProfile({ phone, email });
      navigate('/profile');
    } catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  async function exit() { setBusy(true); setError(''); try { await logout(); navigate('/', { replace: true }); } catch (caught) { setError(employeeError(caught)); } finally { setBusy(false); } }
  if (location.pathname.endsWith('/contact')) return <Page title="Kontaktuppgifter" back="/profile"><form className="employee-form" onSubmit={save}><label>Telefon<div className="input-with-icon"><Phone size={18} /><input autoComplete="tel" type="tel" maxLength={50} value={phone} disabled={busy} onChange={event => setPhone(event.target.value)} /></div></label><label>E-post<div className="input-with-icon"><Mail size={18} /><input autoComplete="email" type="email" maxLength={200} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></div></label>{error && <Notice tone="red">{error}</Notice>}<Button type="submit" variant="blue" disabled={busy}>{busy ? 'Sparar…' : 'Spara kontaktuppgifter'}</Button></form></Page>;
  if (location.pathname.endsWith('/password')) return <Page title="Byt lösenord" back="/profile"><form className="employee-form" onSubmit={save}><label>Nuvarande lösenord<input required type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={event => setCurrentPassword(event.target.value)} /></label><label>Nytt lösenord<input required type="password" minLength={10} maxLength={200} autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label><label>Upprepa nytt lösenord<input required type="password" minLength={10} maxLength={200} autoComplete="new-password" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} /></label><p className="employee-subtle">Använd minst 10 tecken.</p>{error && <Notice tone="red">{error}</Notice>}<Button type="submit" variant="blue" disabled={busy}>{busy ? 'Sparar…' : 'Spara nytt lösenord'}</Button></form></Page>;
  const person = session.person;
  const initials = person.name.split(' ').filter(Boolean).map(part => part[0]).slice(0, 2).join('');
  return <Page title="Profil"><OverviewError />{error && <Notice tone="red">{error}</Notice>}<section className="employee-card employee-profile-card"><div className="employee-profile-avatar">{initials}</div><h2>{person.name}</h2><p>{person.role}{session.sites.filter(site => person.siteIds.includes(site.id)).map(site => ` · ${site.name}`).join('')}</p><span className="employee-status approved">Aktivt konto</span><div className="employee-details"><div><span>Användarnamn</span><strong>{person.username || person.employeeNumber || '—'}</strong></div><div><span>Arbetsgrupp</span><strong>{person.team || '—'}</strong></div>{person.managerName && <div><span>Närmaste chef</span><strong>{person.managerName}</strong></div>}<div><span>Timkrav</span><strong>{overview?.requirement.enabled ? overview.requirement.mode === 'fixed' ? `${hoursLabel(overview.requirement.dailyMinutes || 0)} / arbetsdag` : 'Enligt arbetsschema' : 'Inget timkrav'}</strong></div></div></section><section className="employee-section"><h2>Kontoinställningar</h2><MenuRow title="Kontaktuppgifter" description="Telefon och e-post" icon={UserRound} onClick={() => navigate('/profile/contact')} /><MenuRow title="Byt lösenord" icon={LockKeyhole} onClick={() => navigate('/profile/password')} />{session.capabilities.manageEmployeeAccounts && <MenuRow title="Personalkonton" description="Inloggning och lösenord" icon={UserRound} onClick={() => navigate('/profile/accounts')} />}{session.capabilities.manageTimeRequirements && <MenuRow title="Timkrav för personal" description="Schema eller timmar per arbetsdag" icon={Settings2} onClick={() => navigate('/profile/requirements')} />}</section><p className="employee-help"><HelpCircle size={21} /><span><strong>Behöver du hjälp?</strong>Kontakta din chef eller systemadmin.</span></p><Button variant="danger" icon={LogOut} disabled={busy} onClick={() => void exit()}>{busy ? 'Loggar ut…' : 'Logga ut'}</Button></Page>;
}

export function EmployeeRequirementPage() {
  const { session, loadRequirements, saveRequirement } = useEmployee();
  const [people, setPeople] = useState<EmployeeRequirementPerson[]>([]), [personId, setPersonId] = useState('');
  const [requirement, setRequirement] = useState<EmployeeRequirement | null>(null), [hours, setHours] = useState('8');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const loadRef = useRef(loadRequirements);
  useEffect(() => {
    let cancelled = false;
    void loadRef.current().then(result => { if (!cancelled) { setPeople(result); const first = result[0]; if (first) { setPersonId(first.id); setRequirement(first.requirement); setHours(String((first.requirement.dailyMinutes || 480) / 60)); } } }).catch(caught => { if (!cancelled) setError(employeeError(caught)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  if (!session?.capabilities.manageTimeRequirements) return <Page title="Timkrav" back="/profile"><Notice tone="amber">Du saknar behörighet att ändra timkrav.</Notice></Page>;
  async function save(event: FormEvent) {
    event.preventDefault(); if (!requirement || busy) return; setBusy(true); setError(''); setNotice('');
    try { const next = { ...requirement, ...(requirement.mode === 'fixed' ? { dailyMinutes: Math.round(Number(hours) * 60) } : {}) }; await saveRequirement(personId, next); const result = await loadRequirements(); setPeople(result); const updated = result.find(person => person.id === personId); if (updated) setRequirement(updated.requirement); setNotice('Timkravet är sparat.'); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  return <Page title="Timkrav för personal" back="/profile"><p className="employee-subtle">Kravet gäller arbetsdagar enligt personens schema. Registrerad frånvaro räknas av. Tid från pågående uppdrag och manuell registrering hålls åtskilda från planering.</p>{error && <Notice tone="red">{error}</Notice>}{notice && <Notice tone="green">{notice}</Notice>}{loading ? <Empty>Hämtar personal…</Empty> : !people.length ? <Empty>Ingen personal tillgänglig för denna behörighet.</Empty> : requirement && <form className="employee-form" onSubmit={save}><label>Person<select value={personId} disabled={busy} onChange={event => { const selected = people.find(person => person.id === event.target.value); if (selected) { setPersonId(selected.id); setRequirement(selected.requirement); setHours(String((selected.requirement.dailyMinutes || 480) / 60)); setNotice(''); } }}>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label className="employee-checkbox"><input type="checkbox" checked={requirement.enabled} disabled={busy} onChange={event => setRequirement({ ...requirement, enabled: event.target.checked })} />Kräv komplett tidrapport före fortsatt arbete</label><label>Beräkna timkrav<select value={requirement.mode} disabled={busy} onChange={event => setRequirement({ ...requirement, mode: event.target.value as 'schedule' | 'fixed' })}><option value="schedule">Enligt arbetsschema</option><option value="fixed">Fast antal timmar per arbetsdag</option></select></label>{requirement.mode === 'fixed' && <label>Timmar per arbetsdag<input required type="number" min="0.25" max="24" step="0.25" inputMode="decimal" value={hours} disabled={busy} onChange={event => setHours(event.target.value)} /></label>}<p className="employee-subtle">Kontroll börjar {requirement.enforcementFrom || 'från aktivering'}. Äldre dagar före aktiveringen låser inte appen.</p><Button type="submit" variant="blue" icon={Check} disabled={busy}>{busy ? 'Sparar…' : 'Spara timkrav'}</Button></form>}</Page>;
}

export function EmployeeAccountPage() {
  const { session, loadAccounts, saveAccount, refresh } = useEmployee();
  const [people, setPeople] = useState<EmployeeAccountPerson[]>([]), [personId, setPersonId] = useState('');
  const [username, setUsername] = useState(''), [password, setPassword] = useState(''), [active, setActive] = useState(true);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const loadRef = useRef(loadAccounts);
  const selected = people.find(person => person.id === personId);
  const choose = (person: EmployeeAccountPerson) => { setPersonId(person.id); setUsername(person.account?.username || ''); setActive(person.account?.active ?? person.active); setPassword(''); setNotice(''); };
  useEffect(() => { let disposed = false; void loadRef.current().then(result => { if (!disposed) { setPeople(result); if (result[0]) choose(result[0]); } }).catch(caught => { if (!disposed) setError(employeeError(caught)); }).finally(() => { if (!disposed) setLoading(false); }); return () => { disposed = true; }; }, []);
  if (!session?.capabilities.manageEmployeeAccounts) return <Page title="Personalkonton" back="/profile"><Notice tone="amber">Du saknar behörighet att administrera personalkonton.</Notice></Page>;
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await saveAccount({ personId, username: username.trim(), active, ...(password ? { password } : {}) }); setPassword(''); if (personId === session?.person.id) { await refresh().catch(() => undefined); return; } const result = await loadAccounts(); setPeople(result); setNotice('Personalkontot är sparat. Personen kan använda samma inloggning i appen.'); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusy(false); }
  }
  return <Page title="Personalkonton" back="/profile"><p className="employee-subtle">Inloggningen kopplas till personens befintliga profil och behörigheter. Lägg först upp personen under Personal på kontoret.</p>{error && <Notice tone="red">{error}</Notice>}{notice && <Notice tone="green">{notice}</Notice>}{loading ? <Empty>Hämtar personal…</Empty> : !people.length ? <Empty>Inga personprofiler med användarkonto finns ännu.</Empty> : <form className="employee-form" onSubmit={save}><label>Person<select disabled={busy} value={personId} onChange={event => { const person = people.find(value => value.id === event.target.value); if (person) choose(person); }}>{people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label>Inloggningsnamn<input required minLength={3} maxLength={200} autoComplete="off" autoCapitalize="none" autoCorrect="off" value={username} disabled={busy} onChange={event => setUsername(event.target.value)} /></label><label>{selected?.account ? 'Nytt lösenord (valfritt)' : 'Lösenord för nytt konto'}<input required={!selected?.account} type="password" minLength={10} maxLength={200} autoComplete="new-password" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label><label className="employee-checkbox"><input type="checkbox" checked={active} disabled={busy || !selected?.active} onChange={event => setActive(event.target.checked)} />Inloggningen är aktiv</label>{!selected?.active && <Notice tone="amber">Personprofilen behöver aktiveras på kontoret innan inloggningen kan aktiveras.</Notice>}{personId === session.person.id && <Notice tone="amber">Om du ändrar ditt eget konto behöver du logga in igen.</Notice>}<Button type="submit" variant="blue" disabled={busy}>{busy ? 'Sparar…' : 'Spara personalkonto'}</Button></form>}</Page>;
}

export function EmployeeAssignmentsPage() {
  const { overview, commandOrder } = useEmployee();
  const [search, setSearch] = useSearchParams();
  const [orders, setOrders] = useState<EmployeeOrder[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null), [history, setHistory] = useState(false);
  const requestSequence = useRef(0);
  async function load() {
    const sequence = ++requestSequence.current;
    try { const result = await employeeRequest<{ orders: EmployeeOrder[] }>('/orders'); if (sequence === requestSequence.current) { setOrders(result.orders); setError(''); } }
    catch (caught) { if (sequence === requestSequence.current) setError(employeeError(caught)); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { requestSequence.current += 1; }; }, []);
  async function act(orderId: string, command: 'start' | 'stop' | 'logistics' | 'status', body?: unknown) {
    if (busyId) return; setBusyId(orderId); setError('');
    try { await commandOrder(orderId, command, body); await load(); }
    catch (caught) { setError(employeeError(caught)); }
    finally { setBusyId(null); }
  }
  const shown = orders.filter(order => history === ['done', 'cancelled'].includes(order.status)).sort((a, b) => `${a.date || '9999'}:${String(a.startMinute || 0).padStart(4, '0')}`.localeCompare(`${b.date || '9999'}:${String(b.startMinute || 0).padStart(4, '0')}`));
  const openId = search.get('order');
  return <Page title="Mina uppdrag" back="/"><OverviewError />{error && <Notice tone="red">{error}</Notice>}<div className="employee-segments"><button type="button" className={!history ? 'active' : ''} aria-pressed={!history} onClick={() => setHistory(false)}>Aktiva</button><button type="button" className={history ? 'active' : ''} aria-pressed={history} onClick={() => setHistory(true)}>Avslutade</button></div>{loading ? <Empty icon="truck">Hämtar uppdrag…</Empty> : !shown.length ? <Empty icon="truck">{history ? 'Inga avslutade uppdrag.' : 'Du har inga tilldelade uppdrag.'}</Empty> : shown.map(order => {
    const open = order.id === openId, tracking = overview?.activeWork?.orderId === order.id;
    return <article className="employee-card employee-assignment" key={order.id}><div className="employee-section-title"><span className="employee-subtle">{order.id}</span><span className={`employee-status ${order.status}`}>{transportStatusLabels[order.status]}</span></div><h2>{order.customerName}</h2><p>{actionLabels[order.action]} · {order.material || 'Material ej angivet'}</p><p className="employee-address"><MapPin size={16} />{order.address}{order.city ? `, ${order.city}` : ''}</p><p className="employee-shift">{order.date ? capitalize(fullDayLabel(order.date)) : 'Datum ej bokat'}{order.startMinute !== undefined ? ` · ${minuteLabel(order.startMinute)}–${minuteLabel(order.startMinute + order.durationMinutes)}` : ''}</p><button className="employee-text" aria-expanded={open} onClick={() => setSearch(open ? {} : { order: order.id })}>{open ? 'Dölj uppgifter' : 'Visa uppdrag'}<ChevronRight size={17} /></button>{open && <div className="employee-order-detail">{order.notes && <p>{order.notes}</p>}{order.phone && <a className="employee-phone" href={`tel:${order.phone.replace(/[^+\d]/g, '')}`}><Phone size={16} />{order.contact || order.phone}</a>}{tracking ? <><Notice tone="green">Arbetstid registreras sedan {new Intl.DateTimeFormat('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(new Date(overview!.activeWork!.startedAt))}.</Notice><Button variant="outline" icon={Square} disabled={Boolean(busyId)} onClick={() => void act(order.id, 'stop')}>{busyId === order.id ? 'Sparar…' : 'Avsluta arbetstid'}</Button></> : !['done', 'cancelled'].includes(order.status) && <Button variant="blue" icon={Play} disabled={Boolean(busyId) || Boolean(overview?.activeWork)} onClick={() => void act(order.id, 'start')}>{busyId === order.id ? 'Startar…' : 'Starta arbetstid'}</Button>}{order.detail ? <DriverLogistics key={`${order.id}:${order.detail.version}`} detail={order.detail} busy={busyId === order.id} disabled={Boolean(busyId)} onAction={(command: LogisticsDriverCommand) => void act(order.id, 'logistics', command)} /> : order.status === 'booked' ? <Button variant="outline" icon={Truck} disabled={Boolean(busyId)} onClick={() => void act(order.id, 'status', { status: 'on_way' })}>Jag är på väg</Button> : order.status === 'on_way' ? <Button icon={CheckCircle2} disabled={Boolean(busyId)} onClick={() => void act(order.id, 'status', { status: 'done' })}>Markera uppdrag klart</Button> : null}</div>}</article>;
  })}</Page>;
}

export function EmployeeTimeGate() {
  const { overview, session } = useEmployee();
  const location = useLocation(), navigate = useNavigate();
  const dialog = useRef<HTMLDialogElement>(null);
  const gate = overview?.gate;
  const allowed = location.pathname === '/time' || location.pathname.startsWith('/profile');
  const blocked = Boolean(session && gate?.blocked && !allowed);
  useEffect(() => {
    if (!blocked || !dialog.current) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!dialog.current.open) dialog.current.showModal();
    dialog.current.scrollTop = 0;
    return () => { document.body.style.overflow = previousOverflow; };
  }, [blocked]);
  if (!blocked || !gate?.date) return null;
  return createPortal(<dialog className="employee-gate-dialog" ref={dialog} aria-labelledby="employee-gate-title" aria-describedby="employee-gate-description" onCancel={event => event.preventDefault()}><div className="employee-gate-icon"><Clock3 size={31} /></div><h2 id="employee-gate-title">Tid saknas för {fullDayLabel(gate.date)}</h2><p id="employee-gate-description">Komplettera din tidrapport för att fortsätta använda appen.</p><div className="employee-gate-stats"><div><span>Timkrav</span><strong>{hoursLabel(gate.expectedMinutes)}</strong></div><div><span>Registrerat</span><strong>{hoursLabel(gate.recordedMinutes)}</strong></div><div><span>Saknas</span><strong>{hoursLabel(gate.missingMinutes)}</strong></div></div><ActiveWorkStop /><Button variant="blue" icon={Plus} onClick={() => navigate(`/time?date=${gate.date}&register=1`)}>Registrera tid</Button><button className="employee-text centered" onClick={() => navigate('/profile')}>Kontakta chef eller logga ut</button></dialog>, document.body);
}
