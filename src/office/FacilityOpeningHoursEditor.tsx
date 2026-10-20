import { Plus, Trash2 } from 'lucide-react';
import type { FacilityOpeningHours, FacilityTimeRange, FacilityWeekday } from './environment-types';
import './facility-hours.css';

const weekdays: [FacilityWeekday, string][] = [
  ['mon', 'Måndag'], ['tue', 'Tisdag'], ['wed', 'Onsdag'], ['thu', 'Torsdag'],
  ['fri', 'Fredag'], ['sat', 'Lördag'], ['sun', 'Söndag'],
];
const emptyHours = (): FacilityOpeningHours => ({
  week: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, exceptions: [],
});
const emptyPeriod = (): FacilityTimeRange => ({ open: '', close: '' });

function Periods({ title, value, disabled, onChange }: {
  title: string; value: FacilityTimeRange[]; disabled: boolean; onChange(value: FacilityTimeRange[]): void;
}) {
  return <div className="facility-hours-periods">
    {value.map((period, index) => <div className="facility-hours-period" key={index}>
      <label>Öppnar<input aria-label={`${title} öppnar ${index + 1}`} type="time" value={period.open} disabled={disabled}
        onChange={event => onChange(value.map((row, at) => at === index ? { ...row, open: event.target.value } : row))} /></label>
      <label>Stänger<input aria-label={`${title} stänger ${index + 1}`} type="time" value={period.close} disabled={disabled}
        onChange={event => onChange(value.map((row, at) => at === index ? { ...row, close: event.target.value } : row))} /></label>
      <button type="button" className="office-btn outline" disabled={disabled} aria-label={`Ta bort ${title.toLocaleLowerCase('sv-SE')} period ${index + 1}`}
        onClick={() => onChange(value.filter((_, at) => at !== index))}><Trash2 size={14} /></button>
    </div>)}
    {value.length < 4 && <button type="button" className="office-link" disabled={disabled} onClick={() => onChange([...value, emptyPeriod()])}><Plus size={13} />Lägg till period</button>}
  </div>;
}

/** Site-owned opening hours, separate from company-wide contact/defaults. No
 * times or holidays are guessed when a legacy facility has no configuration. */
export default function FacilityOpeningHoursEditor({ value, disabled = false, onChange }: {
  value?: FacilityOpeningHours | null; disabled?: boolean; onChange(value: FacilityOpeningHours | null): void;
}) {
  const hours = value ?? emptyHours();
  const changeDay = (day: FacilityWeekday, intervals: FacilityTimeRange[] | null) => onChange({ ...hours, week: { ...hours.week, [day]: intervals } });
  const changeException = (index: number, fields: Partial<FacilityOpeningHours['exceptions'][number]>) => onChange({
    ...hours, exceptions: hours.exceptions.map((row, at) => at === index ? { ...row, ...fields } : row),
  });
  return <section className="facility-hours" aria-label="Anläggningens öppettider">
    <header className="environment-heading"><div><h3>Öppettider</h3><p>Gäller denna anläggning. Tider anges i svensk tid, Europe/Stockholm.</p></div></header>
    {!value && <p className="environment-muted">Öppettider är inte angivna. Det betyder inte att anläggningen är stängd.</p>}
    <div className="facility-hours-week">
      {weekdays.map(([day, title]) => {
        const periods = hours.week[day];
        return <div className="facility-hours-day" key={day}>
          <label>{title}<select aria-label={`${title} öppetstatus`} disabled={disabled} value={periods === null ? 'unset' : periods.length ? 'open' : 'closed'}
            onChange={event => changeDay(day, event.target.value === 'unset' ? null : event.target.value === 'closed' ? [] : [emptyPeriod()])}>
            <option value="unset">Ej angivet</option><option value="closed">Stängt</option><option value="open">Öppet</option>
          </select></label>
          {periods && periods.length > 0 && <Periods title={title} value={periods} disabled={disabled} onChange={periods => changeDay(day, periods)} />}
        </div>;
      })}
    </div>
    <div className="facility-hours-exceptions">
      <h3>Avvikande dagar</h3><p className="environment-muted">Ange exempelvis helgdagar eller tillfälligt ändrade tider. En avvikelse ersätter veckans tider för det datumet.</p>
      {hours.exceptions.map((exception, index) => <div className="facility-hours-exception" key={index}>
        <div className="environment-form-grid">
          <label>Datum<input type="date" aria-label={`Avvikelse ${index + 1} datum`} value={exception.date} disabled={disabled} onChange={event => changeException(index, { date: event.target.value })} /></label>
          <label>Beskrivning<input aria-label={`Avvikelse ${index + 1} beskrivning`} value={exception.label} maxLength={150} placeholder="Exempelvis helgdag" disabled={disabled} onChange={event => changeException(index, { label: event.target.value })} /></label>
          <label>Status<select aria-label={`Avvikelse ${index + 1} status`} disabled={disabled} value={exception.closed ? 'closed' : 'open'}
            onChange={event => changeException(index, { closed: event.target.value === 'closed', intervals: event.target.value === 'closed' ? [] : [emptyPeriod()] })}>
            <option value="closed">Stängt</option><option value="open">Ändrade öppettider</option>
          </select></label>
        </div>
        {!exception.closed && <Periods title={`Avvikelse ${index + 1}`} value={exception.intervals} disabled={disabled}
          onChange={intervals => changeException(index, { intervals, ...(intervals.length ? {} : { closed: true }) })} />}
        <button type="button" className="office-link" disabled={disabled} onClick={() => onChange({ ...hours, exceptions: hours.exceptions.filter((_, at) => at !== index) })}><Trash2 size={13} />Ta bort avvikelse</button>
      </div>)}
      {hours.exceptions.length < 100 && <button type="button" className="office-btn outline" disabled={disabled}
        onClick={() => onChange({ ...hours, exceptions: [...hours.exceptions, { date: '', label: '', closed: true, intervals: [] }] })}><Plus size={14} />Lägg till avvikande dag</button>}
    </div>
    {value && <button type="button" className="office-link" disabled={disabled} onClick={() => onChange(null)}>Rensa alla öppettider</button>}
  </section>;
}
