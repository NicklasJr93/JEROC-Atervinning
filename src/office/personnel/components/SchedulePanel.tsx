import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Plus, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Absence, AbsenceKind, Person, PersonnelCommand, PersonnelResponse, WorkSchedule } from '../types';
import type { TransportOrder } from '../../transport/types';
import { Alert, Dialog, Field, Panel, Pill, formatDate, localToday, minuteLabel } from './Ui';

interface Props {
  response: PersonnelResponse;
  person: Person;
  runCommand: (command: PersonnelCommand) => Promise<PersonnelResponse>;
  onOpenStaffing: () => void;
  activeTab?: 'schedule' | 'absence';
}
type AbsenceInput = Extract<PersonnelCommand, { action: 'absence.preview' | 'absence.save' }>['absence'];
type ScheduleInput = Extract<PersonnelCommand, { action: 'schedule.save' }>['schedule'];
const absenceLabels: Record<AbsenceKind, string> = { sick: 'Sjukfrånvaro', holiday: 'Semester', vab: 'VAB', leave: 'Ledighet', training: 'Utbildning' };
const dayLabels = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'];
const shiftDate = (date: string, days: number) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const monday = (date: string) => shiftDate(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
const parseTime = (value: string) => Number(value.split(':')[0]) * 60 + Number(value.split(':')[1]);
const scheduleFor = (schedules: WorkSchedule[], date: string) => schedules.filter(item => item.effectiveFrom <= date && (!item.effectiveTo || item.effectiveTo >= date) && item.weekdays.includes(weekday(date))).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
const absenceOn = (absence: Absence, date: string) => absence.status === 'registered' && absence.fromDate <= date && absence.toDate >= date;
const personOrders = (response: PersonnelResponse, person: Person) => person.driverId ? response.transport.orders.filter(order => order.driverId === person.driverId && order.date && order.startMinute !== undefined && ['booked', 'on_way', 'done'].includes(order.status)) : [];
function workedMinutes(schedule: WorkSchedule | undefined, absences: Absence[]) {
  if (!schedule) return 0;
  const excluded = absences.map(item => item.allDay ? [schedule.startMinute, schedule.endMinute] : [item.startMinute ?? 0, item.endMinute ?? 1440]);
  if (schedule.lunchStart !== undefined && schedule.lunchEnd !== undefined) excluded.push([schedule.lunchStart, schedule.lunchEnd]);
  let result = 0;
  for (let minute = schedule.startMinute; minute < schedule.endMinute; minute++) if (!excluded.some(([from, to]) => minute >= from && minute < to)) result++;
  return result;
}

export default function SchedulePanel({ response, person, runCommand, onOpenStaffing, activeTab = 'schedule' }: Props) {
  const schedules = response.data.schedules.filter(item => item.personId === person.id);
  const absences = response.data.absences.filter(item => item.personId === person.id);
  const orders = personOrders(response, person);
  const [tab, setTab] = useState(activeTab);
  const [week, setWeek] = useState(() => monday(orders.filter(item => item.date! >= localToday()).sort((a, b) => a.date!.localeCompare(b.date!))[0]?.date ?? localToday()));
  const [scheduleInput, setScheduleInput] = useState<ScheduleInput>();
  const [absenceInput, setAbsenceInput] = useState<AbsenceInput>();
  const [absencePreview, setAbsencePreview] = useState<TransportOrder[]>();
  const [cancelling, setCancelling] = useState<Absence>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => setTab(activeTab), [activeTab]);
  const days = Array.from({ length: 7 }, (_, index) => shiftDate(week, index));
  const tasks = response.data.staffingTasks.filter(item => item.personId === person.id && item.status === 'open');
  const currentAbsences = absences.filter(item => absenceOn(item, localToday()));
  const weekOrders = orders.filter(item => days.includes(item.date!));
  const ordinaryMinutes = days.reduce((sum, date) => sum + workedMinutes(scheduleFor(schedules, date), []), 0);
  const availableMinutes = days.reduce((sum, date) => sum + workedMinutes(scheduleFor(schedules, date), absences.filter(item => absenceOn(item, date))), 0);
  const partialAbsences = absences.filter(item => !item.allDay && days.some(date => absenceOn(item, date)));
  const timelineStart = Math.max(0, Math.floor(Math.min(420, ...weekOrders.map(item => item.startMinute!), ...days.map(date => scheduleFor(schedules, date)?.startMinute ?? 420), ...partialAbsences.map(item => item.startMinute ?? 420)) / 60) * 60);
  const timelineEnd = Math.min(1440, Math.ceil(Math.max(1080, ...weekOrders.map(item => item.startMinute! + item.durationMinutes), ...days.map(date => scheduleFor(schedules, date)?.endMinute ?? 1080), ...partialAbsences.map(item => item.endMinute ?? 1080)) / 60) * 60);
  const timelineLength = timelineEnd - timelineStart;
  const blockStyle = (from: number, to: number) => ({ top: `${(Math.max(from, timelineStart) - timelineStart) / timelineLength * 100}%`, height: `${(Math.min(to, timelineEnd) - Math.max(from, timelineStart)) / timelineLength * 100}%` });
  const managers = response.data.people.filter(item => item.active && item.kind === 'employee');
  const canSchedule = response.capabilities.includes('personnelWrite');
  const canAbsence = response.capabilities.includes('absenceWrite');
  const canReadAbsence = response.capabilities.includes('absenceRead');
  const absenceTitle = (item: Absence) => canReadAbsence && item.kind ? absenceLabels[item.kind] : 'Frånvaro';
  const closeDialog = () => { if (!busy) { setScheduleInput(undefined); setAbsenceInput(undefined); setAbsencePreview(undefined); setCancelling(undefined); setError(''); } };
  const perform = async (command: PersonnelCommand, notice?: string) => {
    setBusy(true); setError('');
    try { const next = await runCommand(command); if (notice) setSuccess(notice); return next; }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Ändringen kunde inte sparas.'); return undefined; }
    finally { setBusy(false); }
  };
  const editSchedule = (item?: WorkSchedule) => { setError(''); setScheduleInput(item ? { ...item } : { personId: person.id, weekdays: [1, 2, 3, 4, 5], startMinute: 420, endMinute: 960, lunchStart: 720, lunchEnd: 780, effectiveFrom: localToday() }); };
  const editAbsence = () => { setError(''); setAbsencePreview(undefined); setAbsenceInput({ personId: person.id, kind: 'sick', fromDate: week, toDate: week, allDay: true, managerId: person.managerId }); };
  const patchAbsence = (patch: Partial<AbsenceInput>) => { setAbsenceInput(current => current ? { ...current, ...patch } : current); setAbsencePreview(undefined); setError(''); };
  const saveSchedule = async () => { if (!scheduleInput) return; const next = await perform({ action: 'schedule.save', schedule: scheduleInput }, 'Arbetsschemat har sparats.'); if (next) setScheduleInput(undefined); };
  const previewAbsence = async () => { if (!absenceInput) return; const next = await perform({ action: 'absence.preview', absence: absenceInput }); if (next) setAbsencePreview(next.preview?.affectedOrders ?? []); };
  const saveAbsence = async () => { if (!absenceInput || absencePreview === undefined) return; const next = await perform({ action: 'absence.save', absence: absenceInput }, 'Frånvaron har registrerats. Berörda bokningar ligger kvar och får bemanningsuppgifter.'); if (next) { setAbsenceInput(undefined); setAbsencePreview(undefined); setTab('absence'); } };
  const cancelAbsence = async () => { if (!cancelling) return; const next = await perform({ action: 'absence.cancel', absenceId: cancelling.id, revision: cancelling.revision }, 'Frånvaron har återkallats.'); if (next) setCancelling(undefined); };
  const newestSchedules = useMemo(() => [...schedules].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)), [response.data.schedules, person.id]);
  return <div className="hr-schedule-workspace">
    <div className="hr-subtabs" role="tablist" aria-label="Schema och frånvaro"><button role="tab" aria-selected={tab === 'schedule'} className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>Arbetsschema</button><button role="tab" aria-selected={tab === 'absence'} className={tab === 'absence' ? 'active' : ''} onClick={() => setTab('absence')}>Frånvaro</button></div>
    {success && <Alert tone="green">{success}</Alert>}
    {error && !scheduleInput && !absenceInput && !cancelling && <Alert tone="red">{error}</Alert>}
    <div className="hr-metrics"><div className="hr-metric"><span>Ordinarie arbetstid denna vecka</span><strong>{(ordinaryMinutes / 60).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} h</strong><small>{formatDate(week)}–{formatDate(days[6])}</small></div><div className="hr-metric"><span>Arbetstid efter frånvaro</span><strong>{(availableMinutes / 60).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} h</strong><small>Raster och registrerad frånvaro borträknade</small></div><div className="hr-metric"><span>Bemanning att lösa</span><strong>{tasks.length} uppdrag</strong><small>{currentAbsences.length ? 'Frånvarande idag' : `${weekOrders.length} bokade uppdrag denna vecka`}</small></div></div>
    {tasks.length > 0 && <Alert tone="orange"><TriangleAlert size={20} /><div><strong>{tasks.length} uppdrag behöver ny bemanning</strong><p>Bokningarnas tider och kunduppgifter är bevarade tills en ansvarig väljer ersättare.</p></div><button className="office-btn" onClick={onOpenStaffing}>Hantera bemanning</button></Alert>}
    {tab === 'schedule' ? <>
      <Panel title="Arbetsschema" icon={<CalendarDays size={20} />} actions={<>{canSchedule && <button className="office-btn" onClick={() => editSchedule(newestSchedules[0])}>Ändra schema</button>}{canAbsence && <button className="office-btn primary" onClick={editAbsence}><Plus size={16} /> Registrera frånvaro</button>}</>}>
        <div className="hr-calendar-toolbar"><div className="hr-actions"><button className="hr-icon-btn" aria-label="Föregående vecka" onClick={() => setWeek(shiftDate(week, -7))}><ChevronLeft size={20} /></button><strong>{formatDate(week)}–{formatDate(days[6])}</strong><button className="hr-icon-btn" aria-label="Nästa vecka" onClick={() => setWeek(shiftDate(week, 7))}><ChevronRight size={20} /></button><button className="office-btn" onClick={() => setWeek(monday(localToday()))}>Idag</button></div><span className="hr-muted">Svensk tid</span></div>
        <div className="hr-cal-legend"><span><b className="hr-cal-key shift" />Arbetspass</span><span><b className="hr-cal-key job" />Transportuppdrag</span><span><b className="hr-cal-key absence" />Frånvaro</span></div>
        <div className="hr-table-scroll"><div className="hr-cal-grid"><div className="hr-cal-corner">Tid</div>{days.map((date, index) => { const shift = scheduleFor(schedules, date); return <div key={date} className={`hr-cal-heading${date === localToday() ? ' today' : ''}`}><strong>{dayLabels[index]} {new Date(`${date}T12:00:00Z`).getUTCDate()}</strong><span>{shift ? `${minuteLabel(shift.startMinute)}–${minuteLabel(shift.endMinute)}` : 'Inget arbetspass'}</span></div>; })}
          <div className="hr-cal-time-axis">{Array.from({ length: Math.floor(timelineLength / 60) + 1 }, (_, index) => <span key={index} style={{ top: `${index * 60 / timelineLength * 100}%` }}>{minuteLabel(timelineStart + index * 60)}</span>)}</div>
          {days.map(date => { const shift = scheduleFor(schedules, date); const dayAbsences = absences.filter(item => absenceOn(item, date)); const dayOrders = weekOrders.filter(item => item.date === date); const hourPercent = 60 / timelineLength * 100; return <div key={date} className="hr-cal-day" style={{ backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent calc(${hourPercent}% - 1px), #e6edf7 calc(${hourPercent}% - 1px), #e6edf7 ${hourPercent}%)` }}>
            {shift && <div className="hr-cal-shift" style={blockStyle(shift.startMinute, shift.endMinute)}><span>Arbetspass</span></div>}
            {shift?.lunchStart !== undefined && shift.lunchEnd !== undefined && <div className="hr-cal-lunch" style={blockStyle(shift.lunchStart, shift.lunchEnd)}><span>Rast</span></div>}
            {dayAbsences.map(item => <div key={item.id} className="hr-cal-absence" style={blockStyle(item.allDay ? timelineStart : item.startMinute ?? timelineStart, item.allDay ? timelineEnd : item.endMinute ?? timelineEnd)}><span>{absenceTitle(item)}</span></div>)}
            {dayOrders.map(order => { const conflict = dayAbsences.some(item => item.allDay || (item.startMinute ?? 0) < order.startMinute! + order.durationMinutes && (item.endMinute ?? 1440) > order.startMinute!); return <div key={order.id} className={`hr-cal-job${conflict ? ' conflict' : ''}`} style={blockStyle(order.startMinute!, order.startMinute! + order.durationMinutes)} title={`${order.id} · ${order.customerName} · ${order.material}${conflict ? ' · Behöver ny förare' : ''}`}><span>{minuteLabel(order.startMinute!)}–{minuteLabel(order.startMinute! + order.durationMinutes)} {conflict && <TriangleAlert size={12} />}</span><strong>{order.id} · {order.customerName}</strong><small>{order.material}</small></div>; })}
          </div>; })}
        </div></div>
      </Panel>
      <div className="hr-grid-2"><Panel title="Återkommande arbetspass" icon={<RefreshCw size={20} />} actions={canSchedule && <button className="office-btn" onClick={() => editSchedule()}><Plus size={16} /> Ny period</button>}>
        {newestSchedules.length ? newestSchedules.map(item => <div className="hr-schedule-row" key={item.id}><div><strong>{item.weekdays.map(day => dayLabels[(day + 6) % 7]).join(', ')} · {minuteLabel(item.startMinute)}–{minuteLabel(item.endMinute)}</strong><small>Gäller från {formatDate(item.effectiveFrom)}{item.effectiveTo && ` till ${formatDate(item.effectiveTo)}`}{item.lunchStart !== undefined && item.lunchEnd !== undefined && ` · Rast ${minuteLabel(item.lunchStart)}–${minuteLabel(item.lunchEnd)}`}</small></div>{canSchedule && <button className="office-btn" onClick={() => editSchedule(item)}>Ändra</button>}</div>) : <p className="hr-empty">Inget arbetsschema registrerat.</p>}
      </Panel><Panel title="Kontroll vid bokning" icon={<ShieldCheck size={20} />}><div className="hr-check-list"><div><Clock size={18} /><div><strong>Arbetstid och frånvaro</strong><small>Kontrolleras före bekräftad bokning.</small></div><Pill tone="orange">Kontroll</Pill></div><div><CalendarDays size={18} /><div><strong>Upptagen tid</strong><small>En ersättare måste vara ledig för hela uppdraget.</small></div><Pill tone="orange">Konflikt</Pill></div><div><ShieldCheck size={18} /><div><strong>Giltig kompetens</strong><small>Fordons- och uppdragskrav måste vara uppfyllda.</small></div><Pill tone="red">Krav</Pill></div></div></Panel></div>
    </> : <Panel title="Frånvaro" icon={<CalendarDays size={20} />} actions={canAbsence && <button className="office-btn primary" onClick={editAbsence}><Plus size={16} /> Registrera frånvaro</button>}>
      <div className="hr-table-scroll"><table className="hr-table"><thead><tr><th>Typ</th><th>Period</th><th>Omfattning</th><th>Status</th><th>Berörda uppdrag</th><th>Ansvarig</th><th /></tr></thead><tbody>{[...absences].sort((a, b) => b.fromDate.localeCompare(a.fromDate)).map(item => { const affected = response.data.staffingTasks.filter(task => task.absenceId === item.id); const open = affected.filter(task => task.status === 'open').length; return <tr key={item.id}><td><strong>{absenceTitle(item)}</strong></td><td>{formatDate(item.fromDate)}{item.toDate !== item.fromDate && `–${formatDate(item.toDate)}`}</td><td>{item.allDay ? 'Hela dagen' : `${minuteLabel(item.startMinute ?? 0)}–${minuteLabel(item.endMinute ?? 0)}`}</td><td><Pill tone={item.status === 'cancelled' ? 'grey' : 'orange'}>{item.status === 'cancelled' ? 'Återkallad' : 'Registrerad'}</Pill></td><td>{affected.length ? <button className="hr-text-btn" onClick={onOpenStaffing}>{open ? `${open} behöver ersättare` : `${affected.length} hanterade`}</button> : 'Inga bokade uppdrag'}</td><td>{response.data.people.find(manager => manager.id === item.managerId)?.name ?? '—'}</td><td>{canAbsence && item.status === 'registered' && <button className="hr-text-btn" onClick={() => { setError(''); setCancelling(item); }}>Återkalla</button>}</td></tr>; })}</tbody></table></div>{!absences.length && <p className="hr-empty">Ingen frånvaro registrerad.</p>}
    </Panel>}
    {scheduleInput && <Dialog title="Återkommande arbetspass" description={`${person.name} · Arbetstid styr tillgängligheten i transportplaneringen.`} onClose={closeDialog}><fieldset disabled={busy} className="hr-form-fieldset"><div className="hr-form-grid">
      <Field label="Gäller från"><input type="date" value={scheduleInput.effectiveFrom} onChange={event => setScheduleInput({ ...scheduleInput, effectiveFrom: event.target.value })} /></Field><Field label="Gäller till (valfritt)"><input type="date" min={scheduleInput.effectiveFrom} value={scheduleInput.effectiveTo ?? ''} onChange={event => setScheduleInput({ ...scheduleInput, effectiveTo: event.target.value || undefined })} /></Field>
      <Field label="Arbetstid från"><input type="time" value={minuteLabel(scheduleInput.startMinute)} onChange={event => setScheduleInput({ ...scheduleInput, startMinute: parseTime(event.target.value) })} /></Field><Field label="Arbetstid till"><input type="time" value={minuteLabel(scheduleInput.endMinute)} onChange={event => setScheduleInput({ ...scheduleInput, endMinute: parseTime(event.target.value) })} /></Field>
      <Field label="Rast från (valfritt)"><input type="time" value={scheduleInput.lunchStart === undefined ? '' : minuteLabel(scheduleInput.lunchStart)} onChange={event => setScheduleInput({ ...scheduleInput, lunchStart: event.target.value ? parseTime(event.target.value) : undefined })} /></Field><Field label="Rast till (valfritt)"><input type="time" value={scheduleInput.lunchEnd === undefined ? '' : minuteLabel(scheduleInput.lunchEnd)} onChange={event => setScheduleInput({ ...scheduleInput, lunchEnd: event.target.value ? parseTime(event.target.value) : undefined })} /></Field>
    </div><div className="hr-day-options">{dayLabels.map((label, index) => { const day = index + 1; return <label key={label}><input type="checkbox" checked={scheduleInput.weekdays.includes(day)} onChange={event => setScheduleInput({ ...scheduleInput, weekdays: event.target.checked ? [...scheduleInput.weekdays, day].sort() : scheduleInput.weekdays.filter(value => value !== day) })} /> {label}</label>; })}</div></fieldset>{error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button className="office-btn" onClick={closeDialog} disabled={busy}>Avbryt</button><button className="office-btn primary" onClick={saveSchedule} disabled={busy || !scheduleInput.effectiveFrom || !scheduleInput.weekdays.length}>{busy ? 'Sparar…' : 'Spara arbetspass'}</button></div></Dialog>}
    {absenceInput && <Dialog title="Registrera frånvaro" description={`${person.name} · Kontrollera berörda uppdrag innan frånvaron sparas.`} onClose={closeDialog}><fieldset className="hr-form-fieldset" disabled={busy}><div className="hr-form-grid">
      <Field label="Typ"><select value={absenceInput.kind} onChange={event => patchAbsence({ kind: event.target.value as AbsenceKind })}>{Object.entries(absenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Ansvarig för bemanning"><select value={absenceInput.managerId ?? ''} onChange={event => patchAbsence({ managerId: event.target.value || undefined })}><option value="">Ingen vald</option>{managers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="Från"><input type="date" value={absenceInput.fromDate} onChange={event => patchAbsence({ fromDate: event.target.value, toDate: event.target.value > absenceInput.toDate ? event.target.value : absenceInput.toDate })} /></Field><Field label="Till"><input type="date" min={absenceInput.fromDate} value={absenceInput.toDate} onChange={event => patchAbsence({ toDate: event.target.value })} /></Field>
      <Field label="Omfattning" full><span className="hr-checkbox"><input type="checkbox" aria-label="Hela dagen" checked={absenceInput.allDay} onChange={event => patchAbsence({ allDay: event.target.checked, startMinute: event.target.checked ? undefined : 420, endMinute: event.target.checked ? undefined : 960 })} /> Hela dagen</span></Field>
      {!absenceInput.allDay && <><Field label="Från klockan"><input type="time" value={minuteLabel(absenceInput.startMinute ?? 420)} onChange={event => patchAbsence({ startMinute: parseTime(event.target.value) })} /></Field><Field label="Till klockan"><input type="time" value={minuteLabel(absenceInput.endMinute ?? 960)} onChange={event => patchAbsence({ endMinute: parseTime(event.target.value) })} /></Field></>}
    </div></fieldset>{absencePreview !== undefined && <div className="hr-absence-preview"><Alert tone={absencePreview.length ? 'orange' : 'green'}><strong>{absencePreview.length ? `${absencePreview.length} bokade uppdrag berörs` : 'Inga bokade uppdrag berörs'}</strong><p>Bokningarna tas inte bort. Ansvarig får bemanningsuppgifter för uppdrag som behöver ersättare.</p></Alert>{absencePreview.map(order => <div className="hr-preview-order" key={order.id}><strong>{order.id} · {order.customerName}</strong><span>{formatDate(order.date)} · {minuteLabel(order.startMinute ?? 0)}–{minuteLabel((order.startMinute ?? 0) + order.durationMinutes)}</span></div>)}</div>}{error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button className="office-btn" onClick={closeDialog} disabled={busy}>Avbryt</button><button className="office-btn primary" disabled={busy || !absenceInput.fromDate || !absenceInput.toDate} onClick={absencePreview === undefined ? previewAbsence : saveAbsence}>{busy ? 'Kontrollerar…' : absencePreview === undefined ? 'Kontrollera påverkan' : 'Registrera frånvaro'}</button></div></Dialog>}
    {cancelling && <Dialog title="Återkalla frånvaro" description={`${person.name} · ${formatDate(cancelling.fromDate)}–${formatDate(cancelling.toDate)}`} onClose={closeDialog}><p>Frånvaron återkallas och personens tillgänglighet räknas om. Uppdrag som redan tilldelats en ersättare flyttas inte tillbaka automatiskt.</p>{error && <Alert tone="red">{error}</Alert>}<div className="hr-dialog-actions"><button className="office-btn" disabled={busy} onClick={closeDialog}>Avbryt</button><button className="office-btn primary" disabled={busy} onClick={cancelAbsence}>{busy ? 'Sparar…' : 'Återkalla frånvaro'}</button></div></Dialog>}
  </div>;
}
