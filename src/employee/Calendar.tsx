import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { EmployeeDay } from './types';

export const minuteLabel = (value: number) => `${Math.floor(value / 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
export const hoursLabel = (minutes: number) => `${(minutes / 60).toLocaleString('sv-SE', { maximumFractionDigits: 2 })} h`;
export const fullDayLabel = (day: string) => new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Stockholm' }).format(new Date(`${day}T12:00:00Z`));
export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export function addDays(day: string, amount: number) {
  const value = new Date(`${day}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10);
}
export function addMonths(day: string, amount: number) {
  const value = new Date(`${day}T12:00:00Z`); const date = value.getUTCDate(); value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() + amount);
  const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate(); value.setUTCDate(Math.min(date, last)); return value.toISOString().slice(0, 10);
}
const dayNumber = (day: string) => Number(day.slice(-2));
export function Calendar({ date, today, days, kind, view = 'month', jobCounts, onSelect, onMove }: {
  date: string; today: string; days: EmployeeDay[]; kind: 'jobs' | 'time'; view?: 'day' | 'week' | 'month';
  jobCounts?: Record<string, number>;
  onSelect: (date: string) => void; onMove: (date: string) => void;
}) {
  const day = new Date(`${date}T12:00:00Z`), mondayOffset = (day.getUTCDay() + 6) % 7;
  const month = date.slice(0, 7), first = `${month}-01`;
  const firstOffset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
  const count = Math.ceil((firstOffset + last) / 7) * 7;
  const grid = view === 'week' ? Array.from({ length: 7 }, (_, index) => addDays(date, index - mondayOffset)) : Array.from({ length: count }, (_, index) => addDays(first, index - firstOffset));
  const heading = view === 'day' ? capitalize(fullDayLabel(date)) : view === 'week' ? `${dayNumber(grid[0])}–${dayNumber(grid[6])} ${new Intl.DateTimeFormat('sv-SE', { month: 'long' }).format(day)}` : capitalize(new Intl.DateTimeFormat('sv-SE', { month: 'long', year: 'numeric' }).format(day));
  const shift = (direction: number) => onMove(view === 'month' ? addMonths(date, direction) : addDays(date, direction * (view === 'week' ? 7 : 1)));
  return <section className={`employee-calendar ${view}`} aria-label={kind === 'time' ? 'Kalender för registrerad tid' : 'Schemakalender'}>
    <div className="employee-calendar-toolbar"><button type="button" className="icon-button" aria-label={view === 'month' ? 'Föregående månad' : view === 'week' ? 'Föregående vecka' : 'Föregående dag'} onClick={() => shift(-1)}><ChevronLeft size={22} /></button><button type="button" className="employee-today" onClick={() => onMove(today)}>Idag</button><strong>{heading}</strong><button type="button" className="icon-button" aria-label={view === 'month' ? 'Nästa månad' : view === 'week' ? 'Nästa vecka' : 'Nästa dag'} onClick={() => shift(1)}><ChevronRight size={22} /></button></div>
    {view !== 'day' && <><div className="employee-weekdays" aria-hidden="true">{['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön'].map(label => <span key={label}>{label}</span>)}</div><div className="employee-calendar-grid">{grid.map((value, index) => {
      const details = days.find(entry => entry.date === value);
      const amount = kind === 'jobs' ? jobCounts?.[value] ?? details?.jobsCount ?? 0 : details?.recordedMinutes ?? 0;
      const outside = view === 'month' && !value.startsWith(month);
      const description = kind === 'jobs' ? `${amount} jobb` : `${(amount / 60).toLocaleString('sv-SE')} timmar registrerat`;
      return <button type="button" key={value} className={`${value === date ? 'selected ' : ''}${value === today ? 'today ' : ''}${outside ? 'outside ' : ''}${index % 7 > 4 ? 'weekend ' : ''}${details?.absenceMinutes ? 'absence ' : ''}`} aria-label={`${capitalize(fullDayLabel(value))}, ${description}`} aria-pressed={value === date} onClick={() => onSelect(value)}><span className="employee-calendar-date">{dayNumber(value)}</span>{amount > 0 && <span className="employee-calendar-chip">{kind === 'jobs' ? amount : hoursLabel(amount)}</span>}{!amount && Boolean(details?.absenceMinutes) && <span className="employee-absence-dot" aria-label="Frånvaro" />}</button>;
    })}</div></>}
  </section>;
}
