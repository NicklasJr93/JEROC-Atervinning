import { z } from 'zod';

export const FACILITY_TIME_ZONE = 'Europe/Stockholm';
export const FACILITY_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Ange tid som HH:mm.');
const interval = z.object({ open: time, close: time }).strict().refine(value => value.close > value.open,
  { path: ['close'], message: 'Stängning måste vara efter öppning samma dag.' });
const intervals = z.array(interval).max(4, 'Ange högst fyra öppna perioder per dag.').superRefine((values, context) => {
  const sorted = [...values].sort((left, right) => left.open.localeCompare(right.open));
  if (sorted.some((value, index) => index > 0 && value.open < sorted[index - 1].close))
    context.addIssue({ code: 'custom', message: 'Öppettiderna får inte överlappa.' });
}).transform(values => [...values].sort((left, right) => left.open.localeCompare(right.open)));

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Välj ett datum.').refine(value => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(`${value}T00:00:00Z`);
  return year >= 1900 && year <= 2199 && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'Välj ett giltigt kalenderdatum.');
const exception = z.object({
  date: calendarDate, label: z.string().trim().max(150), closed: z.boolean(), intervals,
}).strict().superRefine((value, context) => {
  if (value.closed && value.intervals.length)
    context.addIssue({ code: 'custom', path: ['intervals'], message: 'En stängd dag ska inte ha öppettider.' });
  if (!value.closed && !value.intervals.length)
    context.addIssue({ code: 'custom', path: ['intervals'], message: 'Ange öppettider eller markera dagen som stängd.' });
});

/** Missing/null days are unconfigured; [] explicitly means closed. This schema
 * never invents hours, national holidays, or an alternate time zone. */
export const facilityOpeningHoursSchema = z.object({
  week: z.object(Object.fromEntries(FACILITY_WEEKDAYS.map(day => [day, intervals.nullable()]))).strict(),
  exceptions: z.array(exception).max(100, 'Ange högst 100 avvikande dagar.').superRefine((values, context) => {
    if (new Set(values.map(value => value.date)).size !== values.length)
      context.addIssue({ code: 'custom', message: 'Ange varje avvikande datum endast en gång.' });
  }).transform(values => [...values].sort((left, right) => left.date.localeCompare(right.date))),
}).strict();
