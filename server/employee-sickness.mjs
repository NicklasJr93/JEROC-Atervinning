import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { employeeTimeToday, employeeClockCommand, employeeTimeLifecycle, employeeTimeDayProjection,
  assertEmployeeTimeEditable, assertEmployeeTimeRangeEditable } from './employee-time.mjs';
export { assertSicknessWorkAllowed } from './sickness-work-guard.mjs';

// A private, tenant-local HR domain. The ordinary absence register receives
// scheduling facts only; declarations, certificates, pay profiles and medical
// follow-up never enter general transport/mobile projections or generic audit.
const fail = (message, status = 422) => { throw new PricingError(message, status); };
const copy = value => structuredClone(value);
const uid = prefix => `${prefix}-${randomUUID()}`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = z.string().trim().min(1).max(120);
const revision = z.number().int().nonnegative();
const minute = z.number().int().min(0).max(1440);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01' && value <= '2100-12-31';
}, 'Ange ett giltigt datum.');
const extent = z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]);
const reason = z.string().trim().min(3).max(1000);
const forecast = z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }).strict(), z.object({ kind: z.literal('date'), date }).strict()]);
const policySchema = z.object({ revision, dailyContact: z.boolean(), contactByMinute: minute,
  agreement: z.enum(['unknown', 'statutory', 'collective']), agreementName: z.string().trim().max(200),
  calculationConfirmed: z.boolean(), effectiveFrom: date }).strict();
const profileSchema = z.object({ personId: id, revision, effectiveFrom: date,
  hourlyBase: z.number().finite().positive().max(100000), averageWeeklyHours: z.number().finite().positive().max(168),
  sickPayRate: z.number().finite().min(0).max(1), confirmed: z.boolean(), source: reason }).strict();
const certificateSchema = z.object({ received: z.boolean(), fromDate: date.optional(), toDate: date.optional(),
  receivedAt: z.string().datetime().optional(), reference: z.string().trim().max(200),
  firstDayRequired: z.boolean().optional(), firstDayReason: z.string().trim().max(1000).optional() }).strict();
const request = { requestId: id };
const selfSchemas = [
  z.object({ action: z.literal('sickness.report'), ...request, fromDate: date, startMinute: minute.optional(), extent,
    forecast, declared: z.boolean(), clockOut: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('sickness.confirm'), ...request, id, revision, extent, forecast: forecast.optional() }).strict(),
  z.object({ action: z.literal('sickness.forecast'), ...request, id, revision, forecast }).strict(),
  z.object({ action: z.literal('sickness.declare'), ...request, id, revision, declared: z.literal(true) }).strict(),
  z.object({ action: z.literal('sickness.recover'), ...request, id, revision, lastSickDate: date, recoveryMinute: minute.optional() }).strict(),
];
const selfSchema = z.discriminatedUnion('action', selfSchemas);
const managementSchema = z.discriminatedUnion('action', [
  ...selfSchemas.map(schema => schema.extend({ personId: id, reason: reason.optional() })),
  z.object({ action: z.literal('sickness.correct'), ...request, personId: id, id, revision,
    fromDate: date, startMinute: minute.optional(), extent, lastSickDate: date.optional(), recoveryMinute: minute.optional(), reason }).strict(),
  z.object({ action: z.literal('certificate.save'), ...request, personId: id, id, revision, certificate: certificateSchema }).strict(),
  z.object({ action: z.literal('policy.save'), ...request, policy: policySchema }).strict(),
  z.object({ action: z.literal('payprofile.save'), ...request, profile: profileSchema }).strict(),
  z.object({ action: z.literal('highrisk.save'), ...request, decision: z.object({ id, personId: id, fromDate: date, toDate: date,
    kind: z.enum(['frequent', 'long']), reference: reason, revision }).strict() }).strict(),
  z.object({ action: z.literal('deduction.import'), ...request, personId: id, date, source: reason }).strict(),
  z.object({ action: z.literal('case.review'), ...request, personId: id, id, revision,
    kind: z.enum(['insurer_reported', 'rehabilitation_plan', 'checked', 'report_delay_exception', 'return_work_verified', 'employment_eligibility_verified']), reason }).strict(),
]);
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '));
  return result.data;
};
const nowOf = context => {
  const now = new Date(typeof context?.now === 'function' ? context.now() : context?.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail('Systemets tid kunde inte läsas.');
  return now;
};
const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const localMinute = instant => { const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value])); return Number(parts.hour) * 60 + Number(parts.minute); };
const addDays = (day, count) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };
const dayDifference = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
function endOfFirstEmploymentMonth(start) {
  const d = new Date(`${start}T12:00:00Z`), originalDay = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(d); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  d.setUTCDate(Math.min(originalDay, last.getUTCDate()));
  return addDays(d.toISOString().slice(0, 10), -1);
}
const dates = (from, to) => { const out = []; for (let day = from; day <= to; day = addDays(day, 1)) out.push(day); return out; };
const cents = value => Math.round((value + Number.EPSILON) * 100);
const money = value => value / 100;
const identities = p => [p?.actor, p?.user];
const can = (user, right) => Boolean(user?.id) && user.active !== false && (user.level === 'Systemadmin' || user.permissions?.includes(right));
const allowed = (principal, right) => identities(principal).every(user => can(user, right));
const visibleSite = (principal, siteId) => identities(principal).every(user => Boolean(user?.id) && user.active !== false && (!Array.isArray(user.siteIds) || user.siteIds.includes(siteId)));
const visiblePerson = (principal, person) => identities(principal).every(user => Boolean(user?.id) && user.active !== false &&
  (!Array.isArray(user.siteIds) || person.siteIds?.length > 0 && person.siteIds.every(siteId => user.siteIds.includes(siteId))));
const demand = (principal, right) => { if (!allowed(principal, right)) fail('Du saknar behörighet för sjukfrånvaro och sjuklöneunderlag.', 403); };
function personOf(state, personId) {
  const person = state.personnel?.people?.find(p => p.id === personId && p.kind === 'employee');
  if (!person) fail('Välj en anställd i bolaget.', 404);
  return person;
}
function ownPerson(state, personOrId, context) {
  const person = personOf(state, typeof personOrId === 'string' ? personOrId : personOrId?.id);
  if (!person.active || context.effectiveUserId && context.effectiveUserId !== (person.userId ?? person.id)) fail('Du kan bara sjukanmäla din egen aktiva personalprofil.', 403);
  return person;
}
function managementPerson(state, principal, personId) {
  const person = personOf(state, personId);
  if (!visiblePerson(principal, person)) fail('Personen ligger utanför din anläggningsåtkomst.', 403);
  return person;
}
function checkCase(domain, person, input) {
  const item = domain.cases.find(value => value.id === input.id && value.personId === person.id);
  if (!item) fail('Sjukärendet finns inte för personen.', 404);
  if (input.revision !== item.revision) fail('Sjukärendet ändrades i en annan session. Uppdatera och försök igen.', 409);
  return item;
}
function checkForecast(value, today) {
  if (value.kind === 'date' && value.date < today) fail('Uppskattad återkomst måste vara idag eller senare. Välj Vet inte om prognosen är osäker.');
}
export function ensureEmployeeSickness(state, context = {}) {
  const today = employeeTimeToday(context);
  state.employeeSickness ??= { version: 1, revision: 0, cases: [], cycles: [], profiles: [], highRiskDecisions: [],
    deductionImports: [], ledgerSnapshots: [], events: [], requests: [], policy: { revision: 0, dailyContact: true, contactByMinute: 600,
      agreement: 'unknown', agreementName: '', calculationConfirmed: false, effectiveFrom: today } };
  const domain = state.employeeSickness;
  domain.ledgerSnapshots ??= [];
  if (domain.version !== 1 || !Number.isInteger(domain.revision) || domain.revision < 0 ||
      !['cases', 'cycles', 'profiles', 'highRiskDecisions', 'deductionImports', 'events', 'requests'].every(key => Array.isArray(domain[key])))
    fail('Sjukregistret har ett format som inte stöds.', 503);
  return domain;
}
function event(state, principal, action, personId, caseId, text, transactionAudit, context, reasonText) {
  const domain = ensureEmployeeSickness(state, context), at = nowOf(context).toISOString();
  const entry = { id: uid('sickness-event'), action, personId, caseId, at,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id, text, ...(reasonText ? { reason: reasonText } : {}) };
  domain.events.push(entry); domain.revision++;
  transactionAudit.push({ id: entry.id, domain: 'employeeSickness', action, at, actualUserId: entry.actualUserId,
    effectiveUserId: entry.effectiveUserId, ...(personId ? { personId } : {}), ...(caseId ? { caseId } : {}) });
  return entry;
}
function selfPrincipal(person, context) {
  const effective = context.effectiveUserId ?? person.userId ?? person.id;
  return { actor: { id: context.actualUserId ?? effective }, user: { id: effective } };
}
function replay(domain, principal, command, scope) {
  const old = domain.requests.find(r => r.requestId === command.requestId && r.scope === scope);
  if (!old) return false;
  if (old.payloadHash !== hash(command) || old.actualUserId !== principal.actor.id || old.effectiveUserId !== principal.user.id)
    fail('Begäran har redan använts för en annan sjukåtgärd.', 409);
  return true;
}
function recordRequest(domain, principal, command, scope, context) {
  domain.requests.push({ requestId: command.requestId, scope, payloadHash: hash(command),
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id, at: nowOf(context).toISOString() });
}
function eligiblePolicy(policy) {
  return policy.calculationConfirmed && policy.agreement !== 'unknown' && (policy.agreement !== 'collective' || policy.agreementName.length > 0);
}
function applicableProfile(domain, personId, firstDate) {
  return domain.profiles.filter(p => p.personId === personId && p.effectiveFrom <= firstDate && p.confirmed)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0];
}
function highRiskExemption(domain, personId, firstDate) {
  if (domain.highRiskDecisions.some(d => d.personId === personId && d.kind === 'frequent' && d.fromDate <= firstDate && d.toDate >= firstDate)) return 'special_high_risk';
  const start = new Date(`${firstDate}T12:00:00Z`); start.setUTCFullYear(start.getUTCFullYear() - 1);
  const after = start.toISOString().slice(0, 10);
  // Actual deduction occasions, not the number of daily contacts or linked
  // relapses. Imports are dated, provenance-labelled occasions only.
  const count = domain.cycles.filter(c => c.personId === personId && c.deductionOccasionDate > after && c.deductionOccasionDate < firstDate && c.deductionExemption === 'none')
    .length + domain.deductionImports.filter(i => i.personId === personId && i.date > after && i.date < firstDate).length;
  return count >= 10 ? 'general_high_risk' : 'none';
}
function createCycle(domain, person, firstDate) {
  const profile = eligiblePolicy(domain.policy) && domain.policy.effectiveFrom <= firstDate ? applicableProfile(domain, person.id, firstDate) : undefined;
  const cycle = { id: uid('sickness-cycle'), personId: person.id, firstDate, caseIds: [],
    deductionExemption: highRiskExemption(domain, person.id, firstDate), basis: profile ? copy(profile) : null,
    policySnapshot: copy(domain.policy), revision: 1 };
  domain.cycles.push(cycle); return cycle;
}
function mergeIntervals(values) {
  const out = [];
  for (const [a, b] of values.filter(([x, y]) => y > x).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out;
}
function subtractIntervals(values, exclusions) {
  let out = mergeIntervals(values);
  for (const [a, b] of mergeIntervals(exclusions)) out = out.flatMap(([x, y]) => b <= x || a >= y ? [[x, y]] : [...(x < a ? [[x, a]] : []), ...(b < y ? [[b, y]] : [])]);
  return out;
}
const duration = intervals => intervals.reduce((sum, [a, b]) => sum + b - a, 0);
function scheduleFor(state, personId, day) {
  const historic = (state.employeeTime?.normativeHistory ?? []).filter(v => v.personId === personId && v.effectiveFrom <= day)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0];
  const sources = historic?.schedules ?? (state.personnel?.schedules ?? []).filter(s => s.personId === personId);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay() || 7;
  const matched = sources.filter(s => s.weekdays.includes(weekday) && s.effectiveFrom <= day && (!s.effectiveTo || s.effectiveTo >= day));
  return subtractIntervals(matched.map(s => [s.startMinute, s.endMinute]), matched.filter(s => s.lunchStart !== undefined && s.lunchEnd !== undefined).map(s => [s.lunchStart, s.lunchEnd]));
}
function selectExtent(item, day) {
  const change = item.dayChanges.filter(v => v.date <= day).sort((a, b) => b.date.localeCompare(a.date) || b.revision - a.revision)[0];
  return change?.extent ?? item.extent;
}
function materialDay(state, item, day, context) {
  const person = personOf(state, item.personId), scheduled = scheduleFor(state, item.personId, day), scheduledMinutes = duration(scheduled), dailyExtent = selectExtent(item, day);
  let rangeStart = day === item.fromDate ? item.startMinute ?? 0 : 0;
  let rangeEnd = item.status === 'recovered' && day === item.lastSickDate ? item.recoveryMinute ?? 1440 : 1440;
  rangeEnd = Math.max(rangeStart, rangeEnd);
  const full = dailyExtent === 100 && rangeStart === 0 && rangeEnd === 1440;
  const absenceId = `sickday-${hash([item.id, day]).slice(0, 32)}`;
  const row = { id: absenceId, personId: item.personId, kind: 'sick', fromDate: day, toDate: day,
    allDay: full, ...(!full ? { startMinute: rangeStart, endMinute: rangeEnd } : {}),
    ...(dailyExtent < 100 ? { sicknessExtent: dailyExtent } : {}),
    managerId: person.managerId, status: 'registered', createdAt: item.reportedAt,
    createdBy: item.reportedBy, sicknessCaseId: item.id, revision: 1 };
  // The established time engine determines contractual hours, so part-time
  // percentages/weekly schedule scaling and breaks are not duplicated here.
  const baseState = { ...state, personnel: { ...state.personnel, absences: state.personnel.absences.filter(a => a.sicknessCaseId !== item.id) } };
  const withAbsence = { ...baseState, personnel: { ...baseState.personnel, absences: [...baseState.personnel.absences, row] } };
  const projected = employeeTimeDayProjection(withAbsence, person, day, context);
  const before = employeeTimeDayProjection(baseState, person, day, context);
  const absenceDelta = Math.max(0, before.expectedMinutes - projected.expectedMinutes);
  const lostMinutes = Math.min(absenceDelta, Math.max(0, before.expectedMinutes - before.recordedMinutes));
  const notificationDate = employeeTimeToday({ now: item.reportedAt });
  const preNoticeScheduled = day === notificationDate ? duration(subtractIntervals(scheduled, [[0, rangeStart], [Math.min(rangeEnd, localMinute(item.reportedAt)), 1440]])) : 0;
  const preNoticeLostMinutes = day < notificationDate ? lostMinutes : day === notificationDate
    ? Math.min(lostMinutes, Math.max(0, Math.round(preNoticeScheduled * (scheduledMinutes ? before.expectedMinutes / scheduledMinutes : 0)) - before.recordedMinutes)) : 0;
  return { row, day: { date: day, extent: dailyExtent, ...(!full ? { startMinute: rangeStart, endMinute: rangeEnd } : {}), absenceId,
    scheduledMinutes: before.expectedMinutes, lostMinutes, preNoticeLostMinutes, sourceRevision: item.revision, timeLocked: false } };
}
function lockedDay(state, personId, day) {
  return (state.employeeTime?.reviews ?? []).some(r => r.personId === personId && r.month === day.slice(0, 7) && ['submitted', 'approved'].includes(r.status));
}
/** Materializes actual ongoing sickness through today's Stockholm date only.
 * Caller persists in the same transaction as time commands/review submissions.
 * Frozen time months never receive a newly discovered or revised absence row. */
export function refreshSicknessAbsences(state, context = {}) {
  if (!state.employeeSickness) return [];
  const domain = ensureEmployeeSickness(state, context), today = employeeTimeToday(context), added = [];
  state.personnel.absences ??= [];
  for (const item of domain.cases) {
    const through = item.status === 'recovered' ? item.lastSickDate : today;
    if (!through || through < item.fromDate) continue;
    const existingDates = new Set(item.days.map(d => d.date));
    for (const day of dates(item.fromDate, through < today ? through : today)) {
      if (existingDates.has(day)) continue;
      if (lockedDay(state, item.personId, day)) { item.timeIssue = true; continue; }
      const built = materialDay(state, item, day, context);
      item.days.push(built.day); state.personnel.absences.push(built.row); added.push(built.row);
    }
  }
  if (added.length) { state.personnel.revision = (state.personnel.revision ?? 0) + 1; domain.revision++; }
  return added;
}
function rematerialize(state, item, first, last, context) {
  assertEmployeeTimeRangeEditable(state, item.personId, first, last);
  state.personnel.absences = state.personnel.absences.filter(a => a.sicknessCaseId !== item.id || a.fromDate < first || a.fromDate > last);
  item.days = item.days.filter(d => d.date < first || d.date > last);
  refreshSicknessAbsences(state, context);
}
function stopForSickness(state, person, command, principal, transactionAudit, context) {
  if (!command.clockOut) return false;
  let issue = false;
  const ctx = { ...context, actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
  const clockSession = state.employeeTime?.clockSessions?.find(s => s.personId === person.id && !s.endedAt);
  if (clockSession) {
    try { const stopped = employeeClockCommand(state, person, { action: 'clock.out', requestId: `sickclock-${hash(command.requestId).slice(0, 64)}`,
      revision: state.employeeTime.clockStates?.find(s => s.personId === person.id)?.revision ?? 0, sessionId: clockSession.id }, transactionAudit, ctx);
      issue ||= Boolean(stopped.session?.requiresCorrection); }
    catch (error) { if (![423, 403].includes(error.status)) throw error; issue = true; }
  }
  const activeWork = state.employeeTime?.orderSessions?.find(s => s.personId === person.id && !s.endedAt);
  if (activeWork) {
    try { employeeTimeLifecycle(state, person, activeWork.orderId, 'stop', transactionAudit, ctx); }
    catch (error) { if (![423, 403].includes(error.status)) throw error; issue = true; }
  }
  return issue;
}
function commandCase(state, person, command, principal, transactionAudit, context, management = false) {
  const domain = ensureEmployeeSickness(state, context), today = employeeTimeToday(context), at = nowOf(context).toISOString();
  if (command.action === 'sickness.report') {
    if (command.fromDate > today || dayDifference(command.fromDate, today) > 366) fail('Sjukanmälan gäller faktisk frånvaro idag eller tidigare, högst ett år tillbaka. Prognos anges separat.');
    checkForecast(command.forecast, today);
    if (command.fromDate === today && command.startMinute !== undefined && command.startMinute > localMinute(at)) fail('Faktisk sjukfrånvaro kan inte börja vid ett framtida klockslag. Prognos anges separat.');
    if (domain.cases.some(c => c.personId === person.id && c.status === 'open')) fail('Du har redan ett öppet sjukärende. Uppdatera det eller friskanmäl dig först.', 409);
    // Receipt of a sick notification must not be refused because yesterday's
    // month is frozen. Materialization skips the locked dates and records a
    // follow-up instead; only a later actual correction requires reopening.
    reconcileSicknessOccasions(state, context);
    const previous = domain.cases.filter(c => c.personId === person.id && c.status === 'recovered' && c.lastSickDate <= command.fromDate)
      .sort((a, b) => b.lastSickDate.localeCompare(a.lastSickDate))[0];
    if (previous && previous.lastSickDate >= command.fromDate) fail('Sjukfrånvaron överlappar ett tidigare sjukärende.', 409);
    const relapse = previous && dayDifference(previous.lastSickDate, command.fromDate) <= 5;
    const cycle = relapse ? domain.cycles.find(c => c.id === previous.cycleId) : createCycle(domain, person, command.fromDate);
    if (!relapse) cycle.employmentSnapshot = copy(state.personnel.employment?.find(e => e.personId === person.id) ?? null);
    if (!relapse && previous) {
      cycle.previousCycleId = previous.cycleId;
      const previousCycle = domain.cycles.find(c => c.id === previous.cycleId);
      const previousRows = cycleUnderlay(state, previousCycle, context).rows;
      if (previousRows.some(r => r.employerDay >= 14)) {
        cycle.returnWorkRequired = true;
        cycle.returnWorkVerified = dates(addDays(previous.lastSickDate, 1), addDays(command.fromDate, -1)).some(day =>
          employeeTimeDayProjection(state, person, day, context).recordedMinutes > 0);
      }
    }
    const hadActive = state.employeeTime?.clockSessions?.some(s => s.personId === person.id && !s.endedAt) || state.employeeTime?.orderSessions?.some(s => s.personId === person.id && !s.endedAt);
    const timeIssue = stopForSickness(state, person, command, principal, transactionAudit, context);
    const stillActive = state.employeeTime?.clockSessions?.some(s => s.personId === person.id && !s.endedAt) || state.employeeTime?.orderSessions?.some(s => s.personId === person.id && !s.endedAt);
    const item = { id: uid('sickness-case'), personId: person.id, revision: 1, status: 'open', fromDate: command.fromDate,
      startMinute: command.startMinute ?? (hadActive && command.fromDate === today ? localMinute(at) : 0),
      extent: command.extent, forecast: copy(command.forecast), declared: command.declared, ...(command.declared ? { declaredAt: at } : {}),
      reportedAt: at, reportedBy: principal.user.id, cycleId: cycle.id, relapse: Boolean(relapse), lastContactDate: today,
      contacts: [{ date: today, at, extent: command.extent }], dayChanges: [{ date: command.fromDate, extent: command.extent, revision: 1 }],
      certificate: { received: false, reference: '' }, timeIssue: Boolean(timeIssue || stillActive), days: [] };
    domain.cases.push(item); cycle.caseIds.push(item.id);
    refreshSicknessAbsences(state, context);
    event(state, principal, command.action, person.id, item.id, item.relapse ? 'Återinsjuknande registrerat i samma sjuklöneperiod. Inget nytt karensavdrag.' : 'Sjukanmälan registrerad. Faktisk frånvaro hålls separat från uppskattad återkomst.', transactionAudit, context, command.reason);
    return;
  }
  const item = checkCase(domain, person, command);
  if (command.action !== 'sickness.declare' && item.status !== 'open') fail('Sjukärendet är avslutat. En ansvarig kan göra en spårbar rättelse.', 409);
  if (command.action === 'sickness.confirm') {
    if (command.forecast) checkForecast(command.forecast, today);
    if (command.extent !== selectExtent(item, today)) {
      assertEmployeeTimeEditable(state, person, [today]);
      item.dayChanges.push({ date: today, extent: command.extent, revision: item.revision + 1 });
      item.extent = command.extent;
      rematerialize(state, item, today, today, context);
    }
    item.contacts.push({ date: today, at, extent: command.extent }); item.lastContactDate = today;
    if (command.forecast) item.forecast = copy(command.forecast);
    event(state, principal, command.action, person.id, item.id, 'Fortsatt sjukfrånvaro bekräftad i befintligt ärende. Ingen ny karensperiod.', transactionAudit, context, command.reason);
  } else if (command.action === 'sickness.forecast') {
    checkForecast(command.forecast, today); item.forecast = copy(command.forecast);
    event(state, principal, command.action, person.id, item.id, 'Prognos uppdaterad. Faktisk sjukfrånvaro och bokade uppdrag ändras inte.', transactionAudit, context, command.reason);
  } else if (command.action === 'sickness.declare') {
    item.declared = true; item.declaredAt = at;
    event(state, principal, command.action, person.id, item.id, management ? 'Skriftlig försäkran om sjukfrånvaron registrerad av ansvarig.' : 'Skriftlig försäkran om sjukdom och nedsatt arbetsförmåga lämnad.', transactionAudit, context, command.reason);
  } else if (command.action === 'sickness.recover') {
    if (command.lastSickDate < item.fromDate || command.lastSickDate > today) fail('Sista faktiska sjukdag måste ligga mellan sjukanmälan och idag.');
    if (command.lastSickDate === today && command.recoveryMinute !== undefined && command.recoveryMinute > localMinute(at)) fail('Friskanmälan kan inte skapa en framtida återkomsttid.');
    if (command.lastSickDate === item.fromDate && command.recoveryMinute !== undefined && command.recoveryMinute <= (item.startMinute ?? 0)) fail('Faktisk återkomsttid måste vara efter sjukfrånvarons start.');
    item.status = 'recovered'; item.lastSickDate = command.lastSickDate; item.recoveryMinute = command.recoveryMinute;
    item.recoveredAt = at; item.lastContactDate = today; item.revision++;
    // Actual recovery may be reported after a payroll period has been frozen.
    // Close the operational case without changing any locked absence facts;
    // expose the conflict for a later authorised reopen/correction instead.
    const recoveryDates = dates(command.lastSickDate, today), locked = recoveryDates.filter(d => lockedDay(state, person.id, d));
    if (locked.length) item.timeIssue = true;
    const editable = new Set(recoveryDates.filter(d => !lockedDay(state, person.id, d)));
    state.personnel.absences = state.personnel.absences.filter(a => a.sicknessCaseId !== item.id || !editable.has(a.fromDate));
    item.days = item.days.filter(d => !editable.has(d.date));
    refreshSicknessAbsences(state, context);
    event(state, principal, command.action, person.id, item.id, 'Friskanmälan registrerad med faktisk sista sjukdag. Uppskattad återkomst har inte avslutat perioden automatiskt.', transactionAudit, context, command.reason);
    return;
  }
  item.revision++;
}
export function employeeSicknessCommand(state, personOrId, value, transactionAudit = [], context = {}) {
  context = { ...context, now: nowOf(context) };
  const person = ownPerson(state, personOrId, context), command = parse(selfSchema, value), principal = selfPrincipal(person, context);
  const domain = ensureEmployeeSickness(state, context), scope = `employee:${person.id}`;
  if (!replay(domain, principal, command, scope)) {
    commandCase(state, person, command, principal, transactionAudit, context); recordRequest(domain, principal, command, scope, context);
  }
  reconcileSicknessOccasions(state, context);
  return employeeSicknessProjection(state, person.id, context);
}
function actualSpans(domain, cycle, today) {
  return cycle.caseIds.map(id => domain.cases.find(c => c.id === id)).filter(Boolean).sort((a, b) => a.fromDate.localeCompare(b.fromDate))
    .flatMap(item => dates(item.fromDate, item.status === 'recovered' ? item.lastSickDate : today).map(day => ({ item, day })));
}
/** All arithmetic is rounded to öre. Carries a partially consumed deduction to
 * later eligible days in the same cycle, never below zero sick pay. This pure
 * helper is also used by the traceable underlay projection. */
export function calculateSicknessLedger({ profile, deductionExemption = 'none', days = [] }) {
  if (profile) parse(profileSchema, profile);
  if (days.some(d => !Number.isFinite(d.lostMinutes) || d.lostMinutes < 0 || d.lostMinutes > 1440 || !Number.isInteger(d.employerDay) || d.employerDay < 0))
    fail('Sjuklöneunderlaget innehåller ogiltiga timmar eller sjuklönedagar.');
  if (!profile || !profile.confirmed) return { target: null, taken: null, remaining: null,
    rows: days.map(day => ({ ...day, salaryLoss: null, grossSickPay: null, karensDeduction: null, payableSickPay: null })) };
  const target = deductionExemption === 'none' ? cents(profile.hourlyBase * profile.averageWeeklyHours * profile.sickPayRate * 0.2) : 0;
  let remaining = target, taken = 0;
  const rows = days.map(day => {
    const salaryLoss = cents(profile.hourlyBase * day.lostMinutes / 60), gross = cents(profile.hourlyBase * day.lostMinutes / 60 * profile.sickPayRate);
    const eligible = day.employerDay <= 14 && !day.blocked;
    const deducted = eligible ? Math.min(gross, remaining) : 0;
    if (eligible) { remaining -= deducted; taken += deducted; }
    return { ...day, salaryLoss: money(salaryLoss), grossSickPay: eligible ? money(gross) : 0,
      karensDeduction: money(deducted), payableSickPay: eligible ? money(gross - deducted) : 0 };
  });
  return { target: money(target), taken: money(taken), remaining: money(remaining), rows };
}
function cycleUnderlay(state, cycle, context) {
  const domain = ensureEmployeeSickness(state, context), today = employeeTimeToday(context), days = actualSpans(domain, cycle, today);
  const hasBasis = eligiblePolicy(cycle.policySnapshot) && cycle.policySnapshot.effectiveFrom <= cycle.firstDate && cycle.basis?.confirmed;
  let periodStarted = false, employerDay = 0;
  const entries = days.map(({ item, day }) => {
    const recordedDay = item.days.find(d => d.date === day);
    // A later legitimate time/clock correction changes the salary loss, not
    // the illness declaration. Reconcile unlocked worked time on projection;
    // frozen payroll months retain their already recorded loss/source facts.
    const stored = recordedDay && !lockedDay(state, item.personId, day) ? materialDay(state, item, day, context).day : recordedDay;
    const messages = [];
    // The employer period begins when work is actually missed, not merely
    // when an off-duty person files a notification on a Saturday.
    if (!periodStarted && stored?.lostMinutes > 0) periodStarted = true;
    if (periodStarted) employerDay++;
    const reportedDay = employeeTimeToday({ now: item.reportedAt });
    if ((day < reportedDay || stored?.preNoticeLostMinutes > 0) && !item.reportDelayException) messages.push('Frånvaro före mottagen sjukanmälan: ansvarig måste kontrollera undantag innan sjuklön beräknas.');
    if (!item.declared) messages.push('Skriftlig försäkran om nedsatt arbetsförmåga saknas.');
    if (cycle.returnWorkRequired && !cycle.returnWorkVerified) messages.push('Tidigare sjuklöneperiod är förbrukad. Full återgång och minst en arbetad dag behöver verifieras före en ny sjuklöneperiod.');
    const employment = cycle.employmentSnapshot;
    if (!employment && !cycle.employmentEligibilityVerified) messages.push('Anställningsuppgifter saknas; rätten till sjuklön behöver kontrolleras.');
    else if (employment?.form === 'hourly' && !employment.endDate && !cycle.employmentEligibilityVerified) messages.push('Tim-/behovsanställningens avtalade arbete och kvalifikation till sjuklön behöver kontrolleras.');
    else if (employment?.endDate && employment.endDate < endOfFirstEmploymentMonth(employment.startDate) && dayDifference(employment.startDate, day) < 14 && !cycle.employmentEligibilityVerified)
      messages.push('Kort avtalad anställning: 14 dagars kvalifikation till sjuklön behöver kontrolleras.');
    if (employment?.startDate && day < employment.startDate) messages.push('Sjukfrånvaron ligger före den faktiska anställningens start.');
    if (item.timeIssue) messages.push('Stämpling eller frånvarotid behöver kontrolleras.');
    if (!stored) messages.push('Tidperioden behöver kontrolleras/återöppnas; sjukfrånvaron har inte skrivits in i en låst tidrapport.');
    const certDue = addDays(item.fromDate, item.certificate.firstDayRequired ? 0 : 7);
    if (day >= certDue && (!item.certificate.received || !item.certificate.fromDate || !item.certificate.toDate || day < item.certificate.fromDate || day > item.certificate.toDate))
      messages.push('Läkarintyg för dagen behöver kontrolleras innan sjuklöneunderlaget färdigställs.');
    return { caseId: item.id, cycleId: cycle.id, date: day, employerDay: periodStarted ? employerDay : 0,
      lostMinutes: employment?.endDate && day > employment.endDate ? 0 : stored?.lostMinutes ?? 0, blocked: messages.length > 0, messages,
      status: !hasBasis ? 'missing_basis' : messages.length ? 'review_required' : employerDay > 14 ? 'outside_employer_period' : 'calculated' };
  });
  const ledger = calculateSicknessLedger({ profile: hasBasis ? cycle.basis : null, deductionExemption: cycle.deductionExemption, days: entries });
  return { rows: ledger.rows.map(({ blocked, ...row }) => row), cycle: { id: cycle.id, firstDate: cycle.firstDate,
    caseIds: [...cycle.caseIds], relapse: cycle.caseIds.length > 1, deductionExemption: cycle.deductionExemption,
    deductionTarget: ledger.target, deductionTaken: ledger.taken, deductionRemaining: ledger.remaining,
    ...(hasBasis ? { basis: copy(cycle.basis) } : {}) } };
}
function reconcileSicknessOccasions(state, context) {
  const domain = ensureEmployeeSickness(state, context);
  for (const cycle of [...domain.cycles].sort((a, b) => a.firstDate.localeCompare(b.firstDate))) {
    cycle.deductionExemption = highRiskExemption(domain, cycle.personId, cycle.firstDate);
    const row = cycleUnderlay(state, cycle, context).rows.find(r => r.karensDeduction > 0);
    if (row) cycle.deductionOccasionDate = row.date;
    else if (cycle.basis?.confirmed && eligiblePolicy(cycle.policySnapshot)) delete cycle.deductionOccasionDate;
  }
}
export function sicknessPayUnderlay(state, personOrId, context = {}) {
  const person = personOf(state, typeof personOrId === 'string' ? personOrId : personOrId?.id), domain = ensureEmployeeSickness(state, context);
  const projected = domain.cycles.filter(c => c.personId === person.id).map(c => cycleUnderlay(state, c, context));
  // Carry/eligibility are calculated over the entire cycle first; only the
  // final presentation/export rows are clipped to a requested payroll month.
  const rows = projected.flatMap(p => p.rows).filter(row => !context.month || row.date.startsWith(context.month));
  const messages = [...new Set(rows.flatMap(r => r.messages))];
  if (rows.some(r => r.status === 'missing_basis')) messages.unshift('Fastställd löne-/avtalsprofil saknas. Inga lönebelopp gissas; timlöneunderlag och genomsnittlig veckoarbetstid måste bekräftas.');
  const unavailable = rows.some(r => r.status === 'missing_basis'), review = rows.some(r => r.status === 'review_required');
  const sum = field => unavailable ? null : money(rows.reduce((total, row) => total + cents(row[field] ?? 0), 0));
  return { available: !unavailable, generatedAt: nowOf(context).toISOString(), currency: 'SEK',
    calculationStatus: unavailable ? 'missing_basis' : review ? 'review_required' : 'calculated', messages, rows,
    cycles: projected.map(p => p.cycle), totalSalaryLoss: sum('salaryLoss'), totalGrossSickPay: sum('grossSickPay'),
    totalDeduction: sum('karensDeduction'), totalPayableSickPay: sum('payableSickPay') };
}
/** A durable, versioned payroll export receipt. The transaction caller stores
 * the frozen financial source/rows/checksum, never a fabricated payroll payout.
 * Re-exporting identical content returns the same receipt. */
export function recordSicknessPayUnderlay(state, principal, personId, filters = {}, transactionAudit = [], context = {}) {
  demand(principal, 'absenceRead'); demand(principal, 'salaryRead');
  managementPerson(state, principal, personId);
  const parsed = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict(), filters);
  const domain = ensureEmployeeSickness(state, context), underlay = sicknessPayUnderlay(state, personId, { ...context, ...parsed });
  const { generatedAt, ...content } = underlay;
  const contentHash = hash(content);
  let snapshot = domain.ledgerSnapshots.find(s => s.personId === personId && s.month === parsed.month && s.contentHash === contentHash);
  if (!snapshot) {
    const number = domain.ledgerSnapshots.filter(s => s.personId === personId && s.month === parsed.month).length + 1;
    snapshot = { id: uid('sickpay-underlay'), personId, month: parsed.month, revision: number, contentHash,
      createdAt: generatedAt, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, underlay: copy(underlay),
      sourceCases: domain.cases.filter(c => c.personId === personId).map(c => ({ id: c.id, revision: c.revision })),
      sourceCycles: domain.cycles.filter(c => c.personId === personId).map(c => ({ id: c.id, revision: c.revision })) };
    domain.ledgerSnapshots.push(snapshot);
    event(state, principal, 'underlay.export', personId, undefined, `Sjuklöneunderlag version ${number} sparat med källversioner och kontrollsumma. Det är ett underlag, ingen löneutbetalning.`, transactionAudit, context);
  }
  return { ...copy(snapshot.underlay), ledgerId: snapshot.id, ledgerRevision: snapshot.revision, contentHash: snapshot.contentHash };
}
function publicCase(state, item, context) {
  const domain = ensureEmployeeSickness(state, context), today = employeeTimeToday(context), open = item.status === 'open';
  const certificateDueDate = addDays(item.fromDate, item.certificate.firstDayRequired ? 0 : 7), day = dayDifference(item.fromDate, today) + 1;
  const cycle = domain.cycles.find(c => c.id === item.cycleId);
  const lostSpan = cycle ? actualSpans(domain, cycle, today) : [];
  const periodStart = lostSpan.find(({ item: source, day: date }) => source.days.some(d => d.date === date && d.lostMinutes > 0))?.day;
  const employerCount = periodStart ? lostSpan.filter(v => v.day >= periodStart && (!cycle.employmentSnapshot?.endDate || v.day <= cycle.employmentSnapshot.endDate)).length : 0;
  const insurerReportDeadline = addDays(periodStart ?? cycle?.firstDate ?? item.fromDate, 20);
  const predicted = item.forecast.kind === 'date' ? dayDifference(item.fromDate, item.forecast.date) : 0;
  const messages = [];
  const lastRelevantDay = open ? today : item.lastSickDate;
  const certificateRequired = lastRelevantDay >= certificateDueDate && (!item.certificate.received || !item.certificate.fromDate || !item.certificate.toDate || item.certificate.fromDate > certificateDueDate || item.certificate.toDate < lastRelevantDay);
  const insurerReportDue = employerCount >= 15 && !item.insurerReportedAt;
  const rehabilitationPlanDue = open && day >= 30 && (predicted >= 60 || day >= 60) && !item.rehabilitationPlanAt;
  const contactOverdue = open && domain.policy.dailyContact && item.lastContactDate < today && localMinute(nowOf(context)) >= domain.policy.contactByMinute;
  if (certificateRequired) messages.push('Läkarintyg behöver följas upp.');
  if (insurerReportDue) messages.push('Följ upp arbetsgivarens sjukanmälan till Försäkringskassan; den görs separat från appen.');
  if (rehabilitationPlanDue) messages.push('Plan för återgång i arbete behöver följas upp.');
  if (contactOverdue) messages.push('Dagens kontakt saknas enligt arbetsplatsens rutin. Ärendet fortsätter att vara öppet.');
  if (!item.declared) messages.push('Skriftlig försäkran saknas.');
  if (item.timeIssue) messages.push('Tid/frånvaro behöver kontrolleras utan att sjukanmälan blockeras.');
  const keys = ['id', 'personId', 'revision', 'status', 'fromDate', 'startMinute', 'lastSickDate', 'recoveredAt', 'recoveryMinute',
    'extent', 'forecast', 'declared', 'declaredAt', 'reportedAt', 'cycleId', 'relapse', 'lastContactDate', 'contacts', 'certificate', 'timeIssue', 'days'];
  const result = Object.fromEntries(keys.filter(k => item[k] !== undefined).map(k => [k, copy(item[k])]));
  if (context.bootstrap) { result.days = result.days.slice(-7); result.contacts = result.contacts.slice(-10); }
  result.days = result.days.map(d => ({ ...d, timeLocked: lockedDay(state, item.personId, d.date) }));
  return { ...result, personName: state.personnel.people.find(p => p.id === item.personId)?.name ?? '', followup: {
    certificateRequired, certificateDueDate, insurerReportDue, insurerReportDeadline,
    ...(item.insurerReportedAt ? { insurerReportedAt: item.insurerReportedAt } : {}),
    rehabilitationPlanDue, ...(item.rehabilitationPlanAt ? { rehabilitationPlanAt: item.rehabilitationPlanAt } : {}),
    contactOverdue, reviewRequired: messages.length > 0, messages } };
}
export function employeeSicknessProjection(state, personOrId, context = {}) {
  const person = ownPerson(state, personOrId, context), domain = ensureEmployeeSickness(state, context), today = employeeTimeToday(context);
  const cases = domain.cases.filter(c => c.personId === person.id).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  const active = cases.find(c => c.status === 'open'), visible = context.bootstrap ? cases.slice(0, 5) : cases;
  const activeClock = Boolean(state.employeeTime?.clockSessions?.some(s => s.personId === person.id && !s.endedAt));
  const activeWork = Boolean(state.employeeTime?.orderSessions?.some(s => s.personId === person.id && !s.endedAt));
  return { revision: domain.revision, today, policy: copy(domain.policy), activeCase: active ? publicCase(state, active, context) : null,
    cases: visible.map(c => publicCase(state, c, context)), events: copy(domain.events.filter(e => e.personId === person.id).slice(context.bootstrap ? -10 : -100).reverse()),
    canReport: !active, activeClock, activeWork,
    notification: active ? 'Sjukfrånvaron är registrerad tills du friskanmäler dig. Prognosen avslutar inte ärendet.' : 'Sjukanmälan registreras direkt. Ange faktisk frånvaro; diagnos efterfrågas inte.' };
}
export function sicknessManagementProjection(state, principal, filters = {}, context = {}) {
  demand(principal, 'absenceRead');
  const domain = ensureEmployeeSickness(state, context), input = parse(z.object({ personId: id.optional(), siteId: id.optional(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict(), filters);
  if (input.siteId && !visibleSite(principal, input.siteId)) fail('Anläggningen ligger utanför din behörighet.', 403);
  const people = (state.personnel?.people ?? []).filter(p => p.kind === 'employee' && visiblePerson(principal, p) && (!input.siteId || p.siteIds.includes(input.siteId)));
  if (input.personId && !people.some(p => p.id === input.personId)) fail('Personen ligger utanför din behörighet.', 403);
  const ids = new Set(people.filter(p => !input.personId || p.id === input.personId).map(p => p.id));
  const cases = domain.cases.filter(c => ids.has(c.personId)).map(c => publicCase(state, c, context)).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  const salaryRead = allowed(principal, 'salaryRead');
  const allSites = context.siteCatalog?.filter(s => s.active !== false).map(s => s.id) ?? [...new Set(state.personnel.people.flatMap(p => p.siteIds ?? []))];
  const policyWrite = allowed(principal, 'absenceWrite') && allowed(principal, 'salaryWrite') && identities(principal).every(user =>
    !Array.isArray(user.siteIds) || allSites.length > 0 && allSites.every(siteId => user.siteIds.includes(siteId)));
  return { revision: domain.revision, today: employeeTimeToday(context), policy: copy(domain.policy),
    people: copy(people.map(({ id, name, siteIds, active }) => ({ id, name, siteIds: siteIds.filter(s => visibleSite(principal, s)), active }))), cases,
    events: copy(domain.events.filter(e => (e.personId ? ids.has(e.personId) : true) &&
      (salaryRead || !['payprofile.save', 'deduction.import', 'policy.save', 'underlay.export'].includes(e.action))).slice(-200).reverse()),
    profiles: salaryRead ? copy(domain.profiles.filter(p => ids.has(p.personId))) : [],
    highRiskDecisions: copy(domain.highRiskDecisions.filter(d => ids.has(d.personId))),
    deductionImports: salaryRead ? copy(domain.deductionImports.filter(d => ids.has(d.personId))) : [],
    ...(input.personId && salaryRead ? { underlay: sicknessPayUnderlay(state, input.personId, { ...context, month: input.month }) } : {}),
    capabilities: [...['absenceRead', 'absenceWrite', 'salaryRead', 'salaryWrite'].filter(right => allowed(principal, right)), ...(policyWrite ? ['policyWrite'] : [])],
    notificationCount: cases.filter(c => c.followup.reviewRequired || c.status === 'open' && !domain.cases.find(raw => raw.id === c.id)?.checkedAt).length };
}
export function sicknessManagementCommand(state, principal, value, transactionAudit = [], context = {}) {
  demand(principal, 'absenceRead'); demand(principal, 'absenceWrite');
  context = { ...context, now: nowOf(context) };
  const command = parse(managementSchema, value), domain = ensureEmployeeSickness(state, context), scope = 'management';
  const today = employeeTimeToday(context), at = nowOf(context).toISOString();
  const personId = command.personId ?? command.profile?.personId ?? command.decision?.personId;
  const person = personId ? managementPerson(state, principal, personId) : null;
  if (command.action === 'policy.save' || command.action === 'payprofile.save' || command.action === 'deduction.import') demand(principal, 'salaryWrite');
  if (replay(domain, principal, command, scope)) return sicknessManagementProjection(state, principal, personId ? { personId } : {}, context);
  if (selfSchemas.some(s => s.shape.action.value === command.action)) {
    if (command.action === 'sickness.declare' && !command.reason) fail('Ange hur personens skriftliga försäkran har mottagits.');
    commandCase(state, person, command, principal, transactionAudit, context, true);
  } else if (command.action === 'policy.save') {
    const allSites = context.siteCatalog?.filter(s => s.active !== false).map(s => s.id) ?? [...new Set(state.personnel.people.flatMap(p => p.siteIds ?? []))];
    if (!identities(principal).every(user => !Array.isArray(user.siteIds) || allSites.length > 0 && allSites.every(siteId => user.siteIds.includes(siteId))))
      fail('Bolagets gemensamma sjukrutin kräver åtkomst till samtliga anläggningar.', 403);
    if (domain.policy.revision !== command.policy.revision) fail('Sjukrutinen ändrades i en annan session.', 409);
    if (command.policy.calculationConfirmed && (command.policy.agreement === 'unknown' || command.policy.agreement === 'collective' && !command.policy.agreementName)) fail('Fastställ avtalsgrund och eventuellt avtalsnamn innan beräkningen bekräftas.');
    domain.policy = { ...copy(command.policy), revision: domain.policy.revision + 1 };
    event(state, principal, command.action, undefined, undefined, 'Sjukrutin/avtalsgrund sparad som ny version. Befintliga bekräftade lönegrunder skrivs inte över.', transactionAudit, context);
  } else if (command.action === 'payprofile.save') {
    if (domain.policy.agreement === 'statutory' && command.profile.sickPayRate !== 0.8) fail('Lagstadgad sjuklön beräknas med 80 procent. En annan sats kräver fastställd avtalsgrund.');
    const old = domain.profiles.filter(p => p.personId === person.id).sort((a, b) => b.revision - a.revision)[0];
    if ((old?.revision ?? 0) !== command.profile.revision) fail('Löneunderlaget ändrades i en annan session.', 409);
    const saved = { ...copy(command.profile), revision: (old?.revision ?? 0) + 1 };
    domain.profiles.push(saved);
    // Missing bases can be explicitly completed. Once a basis exists its
    // version/salary/rate remain fixed for the cycle, including a relapse.
    for (const cycle of domain.cycles.filter(c => c.personId === person.id && !c.basis && saved.effectiveFrom <= c.firstDate)) {
      if (saved.confirmed && eligiblePolicy(domain.policy) && domain.policy.effectiveFrom <= cycle.firstDate) { cycle.basis = copy(saved); cycle.policySnapshot = copy(domain.policy); cycle.revision++; }
    }
    event(state, principal, command.action, person.id, undefined, 'Bekräftad timlönegrund och genomsnittlig veckoarbetstid sparade med källa och giltighetsdatum.', transactionAudit, context, command.profile.source);
  } else if (command.action === 'highrisk.save') {
    demand(principal, 'salaryWrite');
    const decision = command.decision;
    if (decision.toDate < decision.fromDate) fail('Kontrollera högriskbeslutets giltighetsperiod.');
    const old = domain.highRiskDecisions.find(d => d.id === decision.id);
    if (old && old.personId !== person.id) fail('Beslutet kan inte flyttas till en annan person.', 403);
    if ((old?.revision ?? 0) !== decision.revision) fail('Högriskbeslutet ändrades.', 409);
    if (old) domain.highRiskDecisions[domain.highRiskDecisions.indexOf(old)] = { ...copy(decision), revision: old.revision + 1 };
    else domain.highRiskDecisions.push({ ...copy(decision), revision: 1 });
    for (const cycle of domain.cycles.filter(c => c.personId === person.id && c.firstDate >= decision.fromDate && c.firstDate <= decision.toDate)) {
      cycle.deductionExemption = highRiskExemption(domain, person.id, cycle.firstDate); cycle.revision++;
    }
    event(state, principal, command.action, person.id, undefined, decision.kind === 'frequent' ? 'Särskilt högriskskydd vid frekvent sjukdom registrerat enligt daterat beslut.' : 'Högriskbeslut vid lång sjukdom registrerat. Det innebär inte automatiskt befrielse från karensavdrag.', transactionAudit, context, decision.reference);
  } else if (command.action === 'deduction.import') {
    if (command.date > today) fail('Historiskt karensavdrag måste redan ha inträffat.');
    if (domain.deductionImports.some(i => i.personId === person.id && i.date === command.date) || domain.cycles.some(c => c.personId === person.id && c.deductionOccasionDate === command.date)) fail('Karensavdragstillfället finns redan registrerat.');
    domain.deductionImports.push({ id: uid('deduction-import'), personId: person.id, date: command.date, source: command.source });
    event(state, principal, command.action, person.id, undefined, 'Historiskt faktiskt karensavdragstillfälle importerat med källa. Inga sjukdagar eller lönebelopp skapades.', transactionAudit, context, command.source);
  } else {
    const item = checkCase(domain, person, command);
    if (command.action === 'certificate.save') {
      const cert = command.certificate;
      if (cert.received && (!cert.fromDate || !cert.toDate || cert.toDate < cert.fromDate || !cert.reference.trim())) fail('Registrera intygets datumintervall och en referens i det skyddade HR-arkivet.');
      if (cert.firstDayRequired && (!cert.firstDayReason?.trim() || cert.firstDayReason.length < 3)) fail('Förstadagsintyg kräver ett skriftligt beslut med särskilda skäl eller tillämplig avtalsregel.');
      item.certificate = { ...copy(cert), ...(cert.received ? { receivedAt: at } : {}) };
      event(state, principal, command.action, person.id, item.id, 'Läkarintygets mottagning/giltighet registrerad. Diagnos lagras inte i sjukärendet.', transactionAudit, context, cert.firstDayRequired ? cert.firstDayReason : undefined);
    } else if (command.action === 'case.review') {
      if (command.kind === 'insurer_reported') item.insurerReportedAt = at;
      else if (command.kind === 'rehabilitation_plan') item.rehabilitationPlanAt = at;
      else if (command.kind === 'report_delay_exception') { item.reportDelayException = true; item.reportDelayExceptionAt = at; }
      else if (command.kind === 'return_work_verified') {
        const cycle = domain.cycles.find(c => c.id === item.cycleId);
        cycle.returnWorkVerified = true; cycle.returnWorkVerifiedAt = at;
      }
      else if (command.kind === 'employment_eligibility_verified') {
        const cycle = domain.cycles.find(c => c.id === item.cycleId);
        cycle.employmentEligibilityVerified = true; cycle.employmentEligibilityVerifiedAt = at;
      }
      else { item.timeIssue = false; item.checkedAt = at; }
      event(state, principal, command.action, person.id, item.id, command.kind === 'insurer_reported' ? 'Ansvarig bekräftade att separat sjukanmälan till Försäkringskassan har utförts.' : command.kind === 'rehabilitation_plan' ? 'Ansvarig bekräftade upprättad plan för återgång i arbete.' : command.kind === 'report_delay_exception' ? 'Ansvarig dokumenterade hinder för tidigare sjukanmälan och bedömde undantag från anmälningsdagen.' : command.kind === 'return_work_verified' ? 'Ansvarig verifierade full återgång och minst en arbetad dag efter föregående förbrukade sjuklöneperiod.' : command.kind === 'employment_eligibility_verified' ? 'Ansvarig verifierade avtalat arbete och kvalifikation till sjuklön med dokumenterad källa. Faktiska anställningsgränser ändrades inte.' : 'Ansvarig kontrollerade tids-/frånvaroavvikelsen.', transactionAudit, context, command.reason);
    } else if (command.action === 'sickness.correct') {
      if (command.fromDate > today || command.lastSickDate && (command.lastSickDate < command.fromDate || command.lastSickDate > today)) fail('Kontrollera rättelsens faktiska datum.');
      const earliest = command.fromDate < item.fromDate ? command.fromDate : item.fromDate;
      const latest = [today, item.lastSickDate ?? today, command.lastSickDate ?? today].sort().at(-1);
      assertEmployeeTimeRangeEditable(state, person, earliest, latest);
      const cycle = domain.cycles.find(c => c.id === item.cycleId);
      if (command.fromDate !== item.fromDate && cycle.caseIds.length > 1) fail('Datumändring i en återinsjuknandekedja kräver kontroll av karensperioden. Ändra omfattning/tider eller skapa rättelse i nästa löneunderlag.');
      const other = domain.cases.filter(c => c.personId === person.id && c.id !== item.id);
      const through = command.lastSickDate ?? today;
      if (!command.lastSickDate && other.some(c => c.status === 'open')) fail('Personen har redan ett öppet sjukärende. Avsluta eller rätta det först.', 409);
      if (other.some(c => c.fromDate <= through && (c.lastSickDate ?? today) >= command.fromDate)) fail('Rättelsen överlappar ett annat sjukärende.');
      const preceding = other.filter(c => c.status === 'recovered' && c.lastSickDate < command.fromDate).sort((a, b) => b.lastSickDate.localeCompare(a.lastSickDate))[0];
      if (Boolean(preceding && dayDifference(preceding.lastSickDate, command.fromDate) <= 5) !== Boolean(item.relapse))
        fail('Rättelsen ändrar kopplingen mellan sjuklöneperioder. Karensperioden behöver stämmas av i ett särskilt rättelseunderlag innan datumet ändras.');
      if (cycle.basis && cycle.basis.effectiveFrom > command.fromDate) fail('Det korrigerade datumet ligger före den låsta lönegrundens giltighet. Fastställ ett rättelseunderlag först.');
      const following = other.filter(c => c.fromDate > (item.lastSickDate ?? today)).sort((a, b) => a.fromDate.localeCompare(b.fromDate))[0];
      if (command.lastSickDate && following && Boolean(dayDifference(command.lastSickDate, following.fromDate) <= 5) !== Boolean(following.relapse))
        fail('Rättelsen ändrar ett senare återinsjuknande. Stäm av karensperioden i ett särskilt rättelseunderlag först.');
      if (command.fromDate !== item.fromDate) {
        cycle.firstDate = command.fromDate; cycle.revision++;
      }
      Object.assign(item, { fromDate: command.fromDate, startMinute: command.startMinute ?? 0, extent: command.extent,
        status: command.lastSickDate ? 'recovered' : 'open', lastSickDate: command.lastSickDate, recoveryMinute: command.recoveryMinute,
        dayChanges: [{ date: command.fromDate, extent: command.extent, revision: item.revision + 1 }] });
      rematerialize(state, item, earliest, latest, context);
      event(state, principal, command.action, person.id, item.id, 'Faktisk sjukfrånvaro rättad med orsak. Arbetade timmar har behållits.', transactionAudit, context, command.reason);
    }
    item.revision++;
  }
  refreshSicknessAbsences(state, context);
  // Register a karens occasion only when an actual positive deduction is
  // calculated, never for a report, a weekend, or missing payroll input.
  reconcileSicknessOccasions(state, context);
  recordRequest(domain, principal, command, scope, context);
  return sicknessManagementProjection(state, principal, personId ? { personId } : {}, context);
}
