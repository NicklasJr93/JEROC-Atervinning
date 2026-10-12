import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';

const ZONE = 'Europe/Stockholm';
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const fail = (message, status = 422) => { throw new PricingError(message, status); };
const copy = value => structuredClone(value);
const uid = prefix => `${prefix}-${randomUUID()}`;
const text = z.string().trim().max(1000);
const identifier = z.string().trim().min(1).max(120);
const minute = z.number().int().min(0).max(1440);
const revision = z.number().int().nonnegative();
const dateSchema = z.string().regex(dayPattern).refine(validDay, 'Ange ett giltigt datum.');
const clockFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localInstantCache = new Map();

function validDay(value) {
  if (!dayPattern.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2100;
}
function parse(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '));
  return parsed.data;
}
function clock(context = {}) {
  const date = new Date(typeof context.now === 'function' ? context.now() : context.now ?? Date.now());
  if (!Number.isFinite(date.getTime())) fail('Systemets tid kunde inte läsas.');
  return date;
}
function localParts(value) {
  const parts = Object.fromEntries(clockFormatter.formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
export function employeeTimeToday(context = {}) { return localParts(clock(context)).date; }
function addDays(day, count) { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); }
function weekday(day) { return new Date(`${day}T12:00:00Z`).getUTCDay() || 7; }
function datesBetween(first, last) { const result = []; for (let date = first; date <= last; date = addDays(date, 1)) result.push(date); return result; }

/** Map wall-clock minutes to real instants. A DST fold retains elapsed time;
 * nonexistent spring-transition times are rejected rather than shifted. */
function localInstant(day, value, side = 'start', requireUnique = false) {
  if (value === 1440) return localInstant(addDays(day, 1), 0, side);
  const key = `${day}:${value}`, cached = localInstantCache.get(key);
  if (cached) {
    if (requireUnique && !cached.unique) fail('Klockslaget förekommer två gånger vid övergången till vintertid. Kontakta din chef för att registrera detta pass.');
    return cached[side];
  }
  const nominal = Date.parse(`${day}T00:00:00Z`) + value * 60000;
  const candidates = [];
  for (let offset = -180; offset <= 180; offset += 30) {
    const candidate = nominal + offset * 60000, parts = localParts(candidate);
    if (parts.date === day && parts.minute === value) candidates.push(candidate);
  }
  if (!candidates.length) fail('Klockslaget finns inte vid övergången till sommartid. Välj ett annat klockslag.');
  if (localInstantCache.size >= 5000) localInstantCache.clear();
  localInstantCache.set(key, { start: Math.min(...candidates), end: Math.max(...candidates), unique: candidates.length === 1 });
  if (requireUnique && candidates.length > 1) fail('Klockslaget förekommer två gånger vid övergången till vintertid. Kontakta din chef för att registrera detta pass.');
  return side === 'end' ? Math.max(...candidates) : Math.min(...candidates);
}
function mergeIntervals(intervals) {
  const ordered = intervals.filter(([start, end]) => end > start).map(value => [...value]).sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const interval of ordered) {
    const last = result.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else result.push(interval);
  }
  return result;
}
function subtractIntervals(intervals, exclusions) {
  let result = mergeIntervals(intervals);
  for (const [start, end] of mergeIntervals(exclusions)) result = result.flatMap(([a, b]) => end <= a || start >= b ? [[a, b]] : [...(a < start ? [[a, start]] : []), ...(b > end ? [[end, b]] : [])]);
  return result;
}
const intervalMinutes = intervals => Math.round(mergeIntervals(intervals).reduce((sum, [a, b]) => sum + b - a, 0));
const elapsedMinutes = intervals => Math.round(intervalMinutes(intervals) / 60000);

export function ensureEmployeeTime(state) {
  state.employeeTime ??= { version: 1, revision: 0, settings: [], requirementHistory: [], normativeHistory: [], entries: [], orderSessions: [], leaveRequests: [], audit: [] };
  for (const key of ['settings', 'requirementHistory', 'normativeHistory', 'entries', 'orderSessions', 'leaveRequests', 'audit']) state.employeeTime[key] ??= [];
  return state.employeeTime;
}
function ownPerson(state, personOrId) {
  const person = state.personnel?.people?.find(value => value.id === (typeof personOrId === 'string' ? personOrId : personOrId?.id));
  if (!person || !person.active || person.kind !== 'employee') fail('Tidrapportering kräver en aktiv anställd.', 403);
  return person;
}
function audit(state, person, action, details, transactionAudit, context, actorId = person.userId ?? person.id) {
  const row = { id: uid('time-event'), action, at: clock(context).toISOString(), personId: person.id, actorId, ...details };
  state.employeeTime.audit.push(row); state.employeeTime.revision += 1; transactionAudit.push({ ...row, domain: 'employeeTime' });
}

/** Called in the successful-login transaction. Enforcement starts today, never
 * at the historic employment start date or with fabricated example hours. */
export function enrollEmployeeTime(state, personOrId, context = {}) {
  const person = ownPerson(state, personOrId), domain = ensureEmployeeTime(state);
  let setting = domain.settings.find(value => value.personId === person.id);
  if (!setting) {
    const today = employeeTimeToday(context);
    setting = { personId: person.id, enabled: context.enabled ?? true, mode: 'schedule', effectiveFrom: today, enforcementFrom: today, revision: 1 };
    domain.settings.push(setting); domain.requirementHistory.push(copy(setting)); domain.revision += 1;
  }
  refreshEmployeeTimeNorms(state, context);
  return copy(setting);
}
/** Call after successful personnel schedule/employment writes in the same
 * durable transaction. Existing dates retain the version applicable then. */
export function refreshEmployeeTimeNorms(state, context = {}) {
  const domain = ensureEmployeeTime(state), today = employeeTimeToday(context);
  for (const setting of domain.settings) {
    const source = {
      employment: copy(state.personnel?.employment?.find(value => value.personId === setting.personId) ?? null),
      schedules: copy((state.personnel?.schedules ?? []).filter(value => value.personId === setting.personId).sort((a, b) => a.id.localeCompare(b.id))),
    };
    const previous = domain.normativeHistory.filter(value => value.personId === setting.personId).at(-1);
    if (previous && isDeepStrictEqual(previous.employment, source.employment) && isDeepStrictEqual(previous.schedules, source.schedules)) continue;
    domain.normativeHistory.push({ personId: setting.personId, effectiveFrom: today, revision: (previous?.revision ?? 0) + 1, ...source });
    domain.revision += 1;
  }
}
function normAt(state, person, date) {
  return state.employeeTime?.normativeHistory.filter(value => value.personId === person.id && value.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0] ?? {
    employment: state.personnel?.employment?.find(value => value.personId === person.id),
    schedules: (state.personnel?.schedules ?? []).filter(value => value.personId === person.id),
  };
}
function requirementAt(state, person, date) {
  const current = state.employeeTime?.settings.find(value => value.personId === person.id);
  const history = state.employeeTime?.requirementHistory.filter(value => value.personId === person.id && value.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision);
  return copy(history?.[0] ?? (current && current.effectiveFrom <= date ? current : { personId: person.id, enabled: false, mode: 'schedule', effectiveFrom: date, enforcementFrom: date, revision: 0 }));
}
function personSchedules(state, person, date) {
  return normAt(state, person, date).schedules.filter(value => value.weekdays.includes(weekday(date)) && value.effectiveFrom <= date && (!value.effectiveTo || value.effectiveTo >= date));
}
function personAbsences(state, person, date) {
  return (state.personnel?.absences ?? []).filter(value => value.personId === person.id && value.status === 'registered' && value.fromDate <= date && value.toDate >= date);
}
function scheduleIntervals(schedules) {
  return subtractIntervals(schedules.map(value => [value.startMinute, value.endMinute]), schedules.filter(value => value.lunchStart !== undefined && value.lunchEnd !== undefined).map(value => [value.lunchStart, value.lunchEnd]));
}
function expectedDay(state, person, date) {
  const setting = requirementAt(state, person, date), schedules = personSchedules(state, person, date), absences = personAbsences(state, person, date);
  const norm = normAt(state, person, date), employment = norm.employment;
  const outsideEmployment = employment && (date < employment.startDate || employment.endDate && date > employment.endDate);
  const scheduled = scheduleIntervals(schedules), scheduledMinutes = intervalMinutes(scheduled);
  const weekdays = setting.weekdays ?? norm.schedules.filter(value => value.effectiveFrom <= date && (!value.effectiveTo || value.effectiveTo >= date)).flatMap(value => value.weekdays);
  const workingDays = [...new Set(weekdays.length ? weekdays : [1, 2, 3, 4, 5])];
  let base = 0;
  if (!outsideEmployment && workingDays.includes(weekday(date))) {
    if (setting.mode === 'fixed') base = setting.dailyMinutes ?? 0;
    else if (schedules.length) {
      base = scheduledMinutes;
      // hoursPerWeek is the actual contract amount. Do not multiply it by
      // percentage a second time. An already part-time schedule stays intact.
      if (employment?.hoursPerWeek >= 0) {
        const monday = addDays(date, 1 - weekday(date));
        const weeklyMinutes = datesBetween(monday, addDays(monday, 6)).reduce((sum, day) => sum + intervalMinutes(scheduleIntervals(norm.schedules.filter(value => value.weekdays.includes(weekday(day)) && value.effectiveFrom <= day && (!value.effectiveTo || value.effectiveTo >= day)))), 0);
        if (weeklyMinutes > employment.hoursPerWeek * 60) base = Math.round(base * employment.hoursPerWeek * 60 / weeklyMinutes);
      }
    } else if (employment) base = Math.round(employment.hoursPerWeek * 60 / workingDays.length);
  }
  const exclusions = absences.map(value => value.allDay ? [0, 1440] : [value.startMinute, value.endMinute]);
  const absent = absences.some(value => value.allDay) ? base : Math.min(base, scheduledMinutes > 0 ? Math.round((scheduledMinutes - intervalMinutes(subtractIntervals(scheduled, exclusions))) * base / scheduledMinutes) : intervalMinutes(exclusions));
  return { expectedMinutes: Math.max(0, base - absent), absenceMinutes: absent, schedules, absences, requirement: setting };
}

function assignedOrder(state, person, orderId) {
  const order = state.transport?.orders?.find(value => value.id === orderId), detail = state.logistics?.details?.[orderId];
  if (!order) fail('Arbetsordern finns inte.', 404);
  if (!person.driverId || (detail?.assignedDriverId ?? order.driverId) !== person.driverId || detail?.operator === 'external') fail('Arbetsordern är inte tilldelad dig.', 403);
  return order;
}
function ownOrders(state, person) {
  if (!person.driverId) return [];
  return (state.transport?.orders ?? []).filter(order => (state.logistics?.details?.[order.id]?.assignedDriverId ?? order.driverId) === person.driverId && state.logistics?.details?.[order.id]?.operator !== 'external').map(order => Object.fromEntries(['id', 'customerName', 'action', 'address', 'city', 'date', 'startMinute', 'durationMinutes', 'status', 'siteId', 'driverId', 'vehicleId', 'material', 'notes'].filter(key => order[key] !== undefined).map(key => [key, copy(order[key])])));
}
function siteList(state, person, context) {
  const sites = context.siteCatalog ?? state.environment?.sites ?? state.logistics?.sites ?? [];
  return sites.filter(value => value.active !== false && person.siteIds.includes(value.id)).map(({ id, name }) => ({ id, name }));
}
function manualIntervals(entry) {
  const start = localInstant(entry.date, entry.startMinute), end = localInstant(entry.date, entry.endMinute, 'end') - entry.breakMinutes * 60000;
  return end > start ? [[start, end]] : [];
}
function orderSegments(session, dayStart, dayEnd) {
  if (!session.endedAt) return [];
  const start = Date.parse(session.startedAt), end = Date.parse(session.endedAt) - (session.breakMinutes ?? 0) * 60000;
  const a = Math.max(start, dayStart), b = Math.min(end, dayEnd);
  return b > a ? [[a, b]] : [];
}
function datedEntries(state, person, date, sites) {
  const dayStart = localInstant(date, 0), dayEnd = localInstant(addDays(date, 1), 0);
  const manual = (state.employeeTime?.entries ?? []).filter(value => value.personId === person.id && value.date === date && !value.deletedAt).map(value => ({ ...copy(value), source: 'manual', intervals: manualIntervals(value) }));
  const automatic = (state.employeeTime?.orderSessions ?? []).filter(value => value.personId === person.id && value.endedAt && Date.parse(value.startedAt) < dayEnd && Date.parse(value.endedAt) > dayStart).flatMap(value => {
    const intervals = orderSegments(value, dayStart, dayEnd);
    if (!intervals.length) return [];
    const [start, end] = intervals[0];
    return [{ id: `${value.id}:${date}`, sessionId: value.id, personId: person.id, revision: value.revision, source: 'order', date, startMinute: localParts(start).minute, endMinute: end === dayEnd ? 1440 : localParts(end).minute, breakMinutes: 0, activity: 'Arbetsorder', note: '', orderId: value.orderId, siteId: value.siteId, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), intervals }];
  });
  return [...manual, ...automatic].map(entry => ({ ...entry, minutes: elapsedMinutes(entry.intervals), orderName: state.transport?.orders?.find(value => value.id === entry.orderId)?.customerName, siteName: sites.find(value => value.id === entry.siteId)?.name })).sort((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}
function dayData(state, person, date, sites, orders = ownOrders(state, person)) {
  const expected = expectedDay(state, person, date), entries = datedEntries(state, person, date, sites);
  const recordedMinutes = elapsedMinutes(entries.flatMap(entry => entry.intervals));
  const automaticMinutes = elapsedMinutes(entries.filter(entry => entry.source === 'order').flatMap(entry => entry.intervals));
  const manualMinutes = recordedMinutes - automaticMinutes;
  const expectedMinutes = expected.expectedMinutes, missingMinutes = Math.max(0, expectedMinutes - recordedMinutes);
  return { date, expectedMinutes, recordedMinutes, missingMinutes, automaticMinutes, manualMinutes, absenceMinutes: expected.absenceMinutes, jobsCount: orders.filter(order => order.date === date && order.status !== 'cancelled').length, status: expectedMinutes === 0 ? 'not_required' : recordedMinutes === 0 ? 'empty' : missingMinutes > 0 ? 'partial' : 'complete', entries, schedules: expected.schedules, absences: expected.absences, orders: orders.filter(order => order.date === date) };
}
function publicDay({ entries, schedules, absences, orders, ...day }) { return day; }

export function employeeTimeGate(state, personOrId, context = {}) {
  const person = ownPerson(state, personOrId), today = employeeTimeToday(context);
  const setting = requirementAt(state, person, today), empty = { blocked: false, expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 };
  if (!setting.enabled || !state.employeeTime?.settings.some(value => value.personId === person.id)) return empty;
  const sites = siteList(state, person, context), orders = ownOrders(state, person);
  for (const date of datesBetween(setting.enforcementFrom, addDays(today, -1))) {
    if (!requirementAt(state, person, date).enabled) continue;
    const day = dayData(state, person, date, sites, orders);
    if (day.missingMinutes > 0) return { blocked: true, date, expectedMinutes: day.expectedMinutes, recordedMinutes: day.recordedMinutes, missingMinutes: day.missingMinutes };
  }
  return empty;
}
export function employeeTimeProjection(state, personOrId, context = {}) {
  const person = ownPerson(state, personOrId), today = employeeTimeToday(context);
  const month = context.month ?? today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month) || !validDay(`${month}-01`)) fail('Ange en giltig månad.');
  const date = parse(dateSchema, context.date ?? (today.startsWith(month) ? today : `${month}-01`));
  const sites = siteList(state, person, context), orders = ownOrders(state, person), last = new Date(`${month}-01T12:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(last.getUTCDate() - 1);
  const days = datesBetween(`${month}-01`, last.toISOString().slice(0, 10)).map(day => publicDay(dayData(state, person, day, sites, orders)));
  const selected = dayData(state, person, date, sites, orders);
  const selectedDay = { ...selected, entries: selected.entries.map(({ intervals, personId, ...entry }) => entry) };
  const summary = days.reduce((sum, day) => {
    const requirement = requirementAt(state, person, day.date);
    return { expectedMinutes: sum.expectedMinutes + day.expectedMinutes, recordedMinutes: sum.recordedMinutes + day.recordedMinutes, missingMinutes: sum.missingMinutes + (day.date < today && requirement.enabled && day.date >= requirement.enforcementFrom ? day.missingMinutes : 0) };
  }, { expectedMinutes: 0, recordedMinutes: 0, missingMinutes: 0 });
  const activeWork = state.employeeTime?.orderSessions.find(value => value.personId === person.id && !value.endedAt);
  return { revision: state.employeeTime?.revision ?? 0, today, month, date, person: Object.fromEntries(['id', 'name', 'role', 'team', 'phone', 'email', 'employeeNumber', 'siteIds'].filter(key => person[key] !== undefined).map(key => [key, copy(person[key])])), requirement: requirementAt(state, person, today), gate: employeeTimeGate(state, person, context), days, selectedDay, orders, ...(activeWork ? { activeWork: copy(activeWork) } : {}), leaveRequests: copy((state.employeeTime?.leaveRequests ?? []).filter(value => value.personId === person.id)), sites, summary, balances: { available: false } };
}

const entrySchema = z.object({ id: identifier.optional(), revision: revision.optional(), date: dateSchema, startMinute: minute, endMinute: minute, breakMinutes: z.number().int().min(0).max(720).default(0), activity: z.string().trim().min(1).max(120), note: text.default(''), orderId: identifier.optional(), siteId: identifier.optional() }).strict().refine(value => value.endMinute > value.startMinute && value.breakMinutes < value.endMinute - value.startMinute, 'Slut måste vara efter start och rasten kortare än passet.');
function saveEntry(state, person, value, transactionAudit, context) {
  const input = parse(entrySchema, value), domain = ensureEmployeeTime(state), old = input.id ? domain.entries.find(entry => entry.id === input.id) : undefined;
  if (input.id && !old) fail('Tidsposten finns inte.', 404);
  if (old && old.personId !== person.id) fail('Du kan bara ändra din egen tid.', 403);
  if (old?.deletedAt) fail('Tidsposten har redan tagits bort.', 409);
  if (old && old.revision !== input.revision) fail('Tidsposten ändrades i en annan session. Ladda om.', 409);
  const now = clock(context), today = employeeTimeToday(context);
  if (input.date > today || input.date === today && localInstant(input.date, input.endMinute, 'end') > now.getTime()) fail('Registrera bara tid som redan har arbetats.');
  if (input.orderId) assignedOrder(state, person, input.orderId);
  if (input.siteId && !siteList(state, person, context).some(site => site.id === input.siteId)) fail('Välj en anläggning som du har åtkomst till.', 403);
  const start = localInstant(input.date, input.startMinute, 'start', true), end = localInstant(input.date, input.endMinute, 'end', true);
  const existing = datedEntries(state, person, input.date, siteList(state, person, context)).filter(entry => entry.id !== old?.id);
  // Breaks do not turn an overlapping entry into another payable work interval.
  if (existing.some(entry => { const a = entry.startedAt ? Date.parse(entry.startedAt) : localInstant(entry.date, entry.startMinute), b = entry.endedAt ? Date.parse(entry.endedAt) : localInstant(entry.date, entry.endMinute, 'end'); return start < b && end > a; })) fail('Tiden överlappar redan registrerad tid eller automatisk uppdragstid.');
  const active = domain.orderSessions.find(session => session.personId === person.id && !session.endedAt);
  if (active && start < now.getTime() && end > Date.parse(active.startedAt)) fail('Avsluta den pågående uppdragstiden innan du registrerar överlappande tid.');
  const saved = { ...input, id: old?.id ?? uid('time'), personId: person.id, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() };
  if (old) domain.entries[domain.entries.indexOf(old)] = saved; else domain.entries.push(saved);
  audit(state, person, old ? 'time.updated' : 'time.created', { entryId: saved.id, date: saved.date, text: 'Arbetad tid sparad.' }, transactionAudit, context);
  return { entry: copy(saved), gate: employeeTimeGate(state, person, context) };
}
function removeEntry(state, person, command, transactionAudit, context) {
  const input = parse(z.object({ action: z.literal('time.remove'), id: identifier, revision }).strict(), command);
  const entry = state.employeeTime.entries.find(value => value.id === input.id);
  if (!entry) fail('Tidsposten finns inte.', 404);
  if (entry.personId !== person.id) fail('Du kan bara ta bort din egen tid.', 403);
  if (entry.revision !== input.revision || entry.deletedAt) fail('Tidsposten har ändrats. Ladda om.', 409);
  entry.deletedAt = clock(context).toISOString(); entry.revision += 1;
  audit(state, person, 'time.removed', { entryId: entry.id, date: entry.date, text: 'Manuell tidspost borttagen. Händelsen finns kvar i historiken.' }, transactionAudit, context);
  return { gate: employeeTimeGate(state, person, context) };
}

/** Start and stop are real lifecycle instants. The performer is immutable after
 * start, even if the order is subsequently reassigned. Multiple closed sessions
 * are allowed; completed planned orders alone never create worked hours. */
export function employeeTimeLifecycle(state, personOrId, orderId, phase, transactionAudit = [], context = {}) {
  const person = ownPerson(state, personOrId), domain = ensureEmployeeTime(state), now = clock(context).toISOString();
  const active = domain.orderSessions.find(value => value.personId === person.id && !value.endedAt);
  if (phase === 'start') {
    const order = assignedOrder(state, person, orderId);
    if (['cancelled', 'done'].includes(order.status)) fail('Uppdraget är avslutat eller avbrutet.', 409);
    if (active?.orderId === orderId) return { session: copy(active), gate: employeeTimeGate(state, person, context) };
    if (active) fail('Avsluta det pågående uppdragets tid innan du startar ett annat.', 409);
    const session = { id: uid('order-time'), personId: person.id, performerId: person.id, performerUserId: person.userId, orderId, siteId: state.logistics?.details?.[orderId]?.siteId ?? order.siteId, startedAt: now, revision: 1 };
    domain.orderSessions.push(session);
    audit(state, person, 'order.time_started', { orderId, sessionId: session.id, text: 'Verklig uppdragstid startad.' }, transactionAudit, context);
    return { session: copy(session), gate: employeeTimeGate(state, person, context) };
  }
  if (phase !== 'stop') fail('Välj start eller stopp för uppdragstiden.');
  if (!active || active.orderId !== orderId) {
    const last = domain.orderSessions.filter(value => value.personId === person.id && value.orderId === orderId && value.endedAt).at(-1);
    if (last) return { session: copy(last), gate: employeeTimeGate(state, person, context) };
    fail('Uppdraget har ingen startad tid för dig.', 409);
  }
  if (Date.parse(now) < Date.parse(active.startedAt)) fail('Sluttiden måste vara efter starten.');
  const breakMinutes = parse(z.number().int().min(0).max(720), context.breakMinutes ?? 0);
  if (breakMinutes * 60000 > Date.parse(now) - Date.parse(active.startedAt)) fail('Rasten kan inte vara längre än uppdragstiden.');
  if (breakMinutes > 0 && localParts(active.startedAt).date !== localParts(now).date) fail('För pass över midnatt behöver uppdragstiden stoppas före rast och startas igen efteråt, så att timmarna hamnar på rätt dag.');
  active.endedAt = now; active.breakMinutes = breakMinutes; active.revision += 1;
  audit(state, person, 'order.time_stopped', { orderId, sessionId: active.id, text: 'Verklig uppdragstid sparad från start och stopp.' }, transactionAudit, context);
  return { session: copy(active), gate: employeeTimeGate(state, person, context) };
}

const leaveSchema = z.object({ kind: z.enum(['holiday', 'leave', 'vab']), fromDate: dateSchema, toDate: dateSchema, allDay: z.boolean().default(true), startMinute: minute.optional(), endMinute: minute.optional(), note: text.default('') }).strict().refine(value => value.toDate >= value.fromDate && datesBetween(value.fromDate, value.toDate).length <= 366 && (value.allDay || value.startMinute !== undefined && value.endMinute !== undefined && value.endMinute > value.startMinute), 'Kontrollera datum och tider för ledigheten.');
function requestLeave(state, person, value, transactionAudit, context) {
  const input = parse(leaveSchema, value), today = employeeTimeToday(context);
  if (input.fromDate < today) fail('Ledighetsansökan kan inte börja i det förflutna. Kontakta din chef för tidigare frånvaro.');
  const overlap = value => value.personId === person.id && value.fromDate <= input.toDate && value.toDate >= input.fromDate && (value.allDay || input.allDay || value.startMinute < input.endMinute && value.endMinute > input.startMinute);
  if (state.employeeTime.leaveRequests.some(value => ['pending', 'approved'].includes(value.status) && overlap(value)) || (state.personnel?.absences ?? []).some(value => value.status === 'registered' && overlap(value))) fail('Du har redan frånvaro eller en ansökan under den tiden.');
  const request = { ...input, id: uid('leave-request'), personId: person.id, managerId: person.managerId, status: 'pending', revision: 1, createdAt: clock(context).toISOString() };
  state.employeeTime.leaveRequests.push(request);
  audit(state, person, 'leave.requested', { requestId: request.id, text: 'Ledighetsansökan skickad till ansvarig. Ingen frånvaro eller saldoändring har registrerats.' }, transactionAudit, context);
  return { request: copy(request) };
}
export function employeeTimeCommand(state, personOrId, command, transactionAudit = [], context = {}) {
  const person = ownPerson(state, personOrId); ensureEmployeeTime(state);
  if (!command || typeof command.action !== 'string') fail('Välj en tidrapporteringsåtgärd.');
  if (command.action === 'time.save') return saveEntry(state, person, command.entry, transactionAudit, context);
  if (command.action === 'time.remove') return removeEntry(state, person, command, transactionAudit, context);
  if (command.action === 'order.start' || command.action === 'order.stop') {
    const input = parse(z.object({ action: z.enum(['order.start', 'order.stop']), orderId: identifier, breakMinutes: z.number().int().min(0).max(720).optional() }).strict(), command);
    return employeeTimeLifecycle(state, person, input.orderId, input.action === 'order.start' ? 'start' : 'stop', transactionAudit, { ...context, breakMinutes: input.breakMinutes });
  }
  if (command.action === 'leave.request') return requestLeave(state, person, command.request, transactionAudit, context);
  if (command.action === 'leave.cancel') {
    const input = parse(z.object({ action: z.literal('leave.cancel'), id: identifier, revision }).strict(), command), request = state.employeeTime.leaveRequests.find(value => value.id === input.id);
    if (!request) fail('Ansökan finns inte.', 404);
    if (request.personId !== person.id) fail('Du kan bara ändra din egen ansökan.', 403);
    if (request.status !== 'pending' || request.revision !== input.revision) fail('Ansökan har redan behandlats eller ändrats.', 409);
    request.status = 'cancelled'; request.revision += 1;
    audit(state, person, 'leave.cancelled', { requestId: request.id, text: 'Ledighetsansökan återkallad.' }, transactionAudit, context);
    return { request: copy(request) };
  }
  fail('Åtgärden stöds inte.');
}

const requirementSchema = z.object({ enabled: z.boolean(), mode: z.enum(['schedule', 'fixed']), dailyMinutes: z.number().int().min(0).max(1440).optional(), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(), effectiveFrom: dateSchema.optional(), revision: revision.optional() }).strict().refine(value => value.mode !== 'fixed' || value.dailyMinutes !== undefined, 'Ange timkravet för en arbetsdag.');
function managementAccess(state, principal, person, right) {
  const user = principal?.user, actor = principal?.actor ?? user;
  if (!user || actor?.id !== user.id || user.level !== 'Systemadmin' && !(user.permissions ?? []).includes(right)) fail('Du saknar behörighet att ändra dessa personaluppgifter.', 403);
  if (user.siteIds && !person.siteIds.some(id => user.siteIds.includes(id))) fail('Du saknar åtkomst till personens anläggning.', 403);
  return user;
}
export function employeeTimeRequirementCommand(state, principal, command, transactionAudit = [], context = {}) {
  const person = ownPerson(state, command?.personId), user = managementAccess(state, principal, person, 'employmentWrite');
  if (person.userId === user.id && user.level !== 'Systemadmin') fail('Du kan inte ändra ditt eget timkrav. Be en annan ansvarig.', 403);
  const input = parse(requirementSchema, command.requirement), domain = ensureEmployeeTime(state), today = employeeTimeToday(context);
  const old = domain.settings.find(value => value.personId === person.id);
  if (old && input.revision !== old.revision) fail('Timkravet ändrades i en annan session. Ladda om.', 409);
  if (input.effectiveFrom && input.effectiveFrom < today) fail('Nya timkrav gäller tidigast från idag. Tidigare dagar behåller sina regler.');
  const setting = { ...input, personId: person.id, effectiveFrom: input.effectiveFrom ?? today, enforcementFrom: old?.enforcementFrom ?? today, revision: (old?.revision ?? 0) + 1 };
  if (old) domain.settings[domain.settings.indexOf(old)] = setting; else domain.settings.push(setting);
  domain.requirementHistory.push(copy(setting));
  refreshEmployeeTimeNorms(state, context);
  audit(state, person, 'requirement.saved', { text: 'Personens timkrav uppdaterat utan retroaktiv ändring av tidigare arbetsdagar.' }, transactionAudit, context, user.id);
  return { requirement: copy(setting), gate: employeeTimeGate(state, person, context) };
}

/** A manager decision is separate from employee requests. Approval adds the
 * existing registered-absence shape; staffing refresh remains with the caller.
 * No vacation accrual or salary transaction is inferred. */
export function employeeLeaveDecision(state, principal, command, transactionAudit = [], context = {}) {
  const input = parse(z.object({ id: identifier, revision, decision: z.enum(['approve', 'reject']), note: text.default('') }).strict(), command);
  const request = state.employeeTime?.leaveRequests.find(value => value.id === input.id);
  if (!request) fail('Ansökan finns inte.', 404);
  const person = ownPerson(state, request.personId), user = managementAccess(state, principal, person, 'absenceWrite');
  if (person.userId === user.id && user.level !== 'Systemadmin') fail('Du kan inte godkänna din egen ledighetsansökan.', 403);
  if (request.status !== 'pending' || request.revision !== input.revision) fail('Ansökan har redan behandlats eller ändrats.', 409);
  if (input.decision === 'approve') {
    if ((state.personnel.absences ?? []).some(value => value.personId === person.id && value.status === 'registered' && value.fromDate <= request.toDate && value.toDate >= request.fromDate && (value.allDay || request.allDay || value.startMinute < request.endMinute && value.endMinute > request.startMinute))) fail('Det finns redan registrerad frånvaro under den tiden.');
    const absence = { id: `absence-${request.id}`, personId: person.id, kind: request.kind, fromDate: request.fromDate, toDate: request.toDate, allDay: request.allDay, ...(request.allDay ? {} : { startMinute: request.startMinute, endMinute: request.endMinute }), managerId: person.managerId, status: 'registered', createdAt: clock(context).toISOString(), createdBy: user.id, revision: 1 };
    state.personnel.absences.push(absence); state.personnel.revision += 1; request.absenceId = absence.id;
  }
  request.status = input.decision === 'approve' ? 'approved' : 'rejected'; request.revision += 1; request.decisionAt = clock(context).toISOString(); request.decisionBy = user.id; request.decisionNote = input.note;
  audit(state, person, 'leave.decided', { requestId: request.id, decision: request.status, text: input.decision === 'approve' ? 'Ledighet godkänd och frånvaro registrerad.' : 'Ledighetsansökan avslagen.' }, transactionAudit, context, user.id);
  return { request: copy(request) };
}
