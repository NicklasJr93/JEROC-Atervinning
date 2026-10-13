import { employeeClockProjection, employeeTimeToday } from './employee-time.mjs';
import { PricingError } from './pricing.mjs';

const ZONE = 'Europe/Stockholm';
const localFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const fail = (message, status = 403) => { throw new PricingError(message, status); };
const can = (user, permission) => Boolean(user && user.active !== false
  && (user.level === 'Systemadmin' || (user.permissions ?? []).includes(permission)));
const siteAllowed = (user, siteId) => !Array.isArray(user.siteIds) || user.siteIds.includes(siteId);
const personAllowed = (user, person) => !Array.isArray(user.siteIds)
  || person.siteIds?.length > 0 && person.siteIds.every(id => user.siteIds.includes(id));

function serverClock(context) {
  const value = new Date(typeof context.now === 'function' ? context.now() : context.now ?? Date.now());
  if (!Number.isFinite(value.getTime())) fail('Systemets tid kunde inte läsas.', 422);
  return value;
}
function grouped(values, key = 'personId') {
  const index = new Map();
  for (const value of values ?? []) {
    if (!index.has(value[key])) index.set(value[key], []);
    index.get(value[key]).push(value);
  }
  return index;
}
function buildIndex(state) {
  const time = state.employeeTime ?? {}, personnel = state.personnel ?? {};
  return {
    people: new Map((personnel.people ?? []).map(value => [value.id, value])),
    users: new Map((state.pricing?.users ?? []).map(value => [value.id, value])),
    orders: new Map((state.transport?.orders ?? []).map(value => [value.id, value])),
    clocks: grouped(time.clockSessions), clockStates: grouped(time.clockStates),
    orderSessions: grouped(time.orderSessions), settings: grouped(time.settings),
    requirements: grouped(time.requirementHistory), norms: grouped(time.normativeHistory),
    schedules: grouped(personnel.schedules), employment: grouped(personnel.employment),
    absences: grouped(personnel.absences),
    // Keep only the event timestamp index. Reasons and before/after snapshots
    // are never copied into the personnel-presence response.
    lastClockEvents: (time.audit ?? []).reduce((index, event) => {
      if (typeof event.action !== 'string' || !event.action.startsWith('clock.') || !Number.isFinite(Date.parse(event.at))) return index;
      const previous = index.get(event.personId);
      if (!previous || Date.parse(event.at) >= Date.parse(previous.at)) index.set(event.personId, { at: event.at });
      return index;
    }, new Map()),
  };
}
function ownState(state, person, index) {
  const values = name => index[name].get(person.id) ?? [];
  return {
    personnel: { people: [person], schedules: values('schedules'), employment: values('employment'), absences: values('absences') },
    employeeTime: {
      clockSessions: values('clocks'), clockStates: values('clockStates'), settings: values('settings'),
      requirementHistory: values('requirements'), normativeHistory: values('norms'),
    },
  };
}
function currentNorm(index, person, today) {
  return (index.norms.get(person.id) ?? []).filter(value => value.effectiveFrom <= today)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.revision - a.revision)[0] ?? {
    employment: (index.employment.get(person.id) ?? [])[0], schedules: index.schedules.get(person.id) ?? [],
  };
}
function scheduleFacts(index, person, today, now) {
  const norm = currentNorm(index, person, today);
  const employment = norm.employment;
  const isEmploymentActive = !employment || (employment.startDate <= today && (!employment.endDate || employment.endDate >= today));
  const parts = Object.fromEntries(localFormatter.formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
  const configured = (norm.schedules ?? []).filter(value => value.effectiveFrom <= today && (!value.effectiveTo || value.effectiveTo >= today));
  const todaySchedules = configured.filter(value => value.weekdays?.includes(weekday));
  const isScheduledNow = configured.length ? todaySchedules.some(value => minute >= value.startMinute && minute < value.endMinute
    && !(value.lunchStart !== undefined && value.lunchEnd !== undefined && minute >= value.lunchStart && minute < value.lunchEnd)) : null;
  const registered = (index.absences.get(person.id) ?? []).filter(value => value.status === 'registered' && value.fromDate <= today && value.toDate >= today);
  const hasPartialAbsence = registered.some(value => [25, 50, 75].includes(value.sicknessExtent));
  const isAbsentNow = registered.some(value => ![25, 50, 75].includes(value.sicknessExtent) && value.status === 'registered'
    && value.fromDate <= today && value.toDate >= today
    && (value.allDay || minute >= value.startMinute && minute < value.endMinute));
  return { isEmploymentActive, isScheduledNow, isAbsentNow, hasPartialAbsence };
}
function latestClosedAt(sessions) {
  let latest = null;
  for (const session of sessions) if (session.endedAt && Number.isFinite(Date.parse(session.endedAt))
    && (!latest || Date.parse(session.endedAt) > Date.parse(latest))) latest = session.endedAt;
  return latest;
}
function projectPerson(state, person, index, context, scope = {}) {
  const now = context.now, nowMs = now.getTime(), today = employeeTimeToday({ now });
  const scopedState = ownState(state, person, index), clock = employeeClockProjection(scopedState, person, { now });
  const sessions = index.clocks.get(person.id) ?? [];
  const activeClocks = sessions.filter(value => !value.endedAt);
  const active = activeClocks[0];
  const activeOrders = (index.orderSessions.get(person.id) ?? []).filter(value => !value.endedAt && Date.parse(value.startedAt) <= nowMs);
  const activeOrder = activeOrders[0];
  const linkedUser = person.userId ? index.users.get(person.userId) : undefined;
  const accountDisabled = linkedUser?.active === false;
  const accountMissing = Boolean(person.userId && !linkedUser);
  const facts = scheduleFacts(index, person, today, now);
  const invalidClock = Boolean(active && (!Number.isFinite(Date.parse(active.startedAt)) || Date.parse(active.startedAt) > nowMs));
  const requiresCorrection = clock.requiresCorrection || invalidClock || activeClocks.length > 1;
  const clockEnabled = clock.enabled;
  const clockStatus = clockEnabled ? clock.status : 'disabled';
  const isClockedIn = Boolean(active), isOnBreak = Boolean(active?.breaks?.some(value => !value.endedAt));
  const clockWorking = isClockedIn && !isOnBreak;
  const workStateSource = clockEnabled ? 'clock' : activeOrder ? 'order' : 'unknown';
  const isWorkingNow = workStateSource === 'clock' ? clockWorking : workStateSource === 'order';
  const reasons = [];
  if (accountDisabled) reasons.push('account_disabled');
  if (accountMissing) reasons.push('account_missing');
  if (!facts.isEmploymentActive) reasons.push('employment_inactive');
  if (requiresCorrection) reasons.push('clock_requires_correction');
  if (activeOrders.length > 1) reasons.push('multiple_active_orders');
  if (facts.isAbsentNow) reasons.push('registered_absence');
  if (facts.hasPartialAbsence) reasons.push('partial_absence_needs_planning');
  if (isOnBreak) reasons.push('clock_on_break');
  if (activeOrder) reasons.push('active_order');
  if (facts.isScheduledNow === false) reasons.push('outside_schedule');
  if (facts.isScheduledNow === null) reasons.push('schedule_unknown');
  let availabilityStatus, isAvailableNow;
  if (accountDisabled || accountMissing || !facts.isEmploymentActive || requiresCorrection || activeOrders.length > 1) {
    availabilityStatus = 'needs_review'; isAvailableNow = false;
  } else if (facts.isAbsentNow) {
    availabilityStatus = 'absent'; isAvailableNow = false;
  } else if (facts.hasPartialAbsence) {
    availabilityStatus = 'needs_review'; isAvailableNow = null;
  } else if (isOnBreak) {
    availabilityStatus = 'on_break'; isAvailableNow = false;
  } else if (activeOrder && isWorkingNow) {
    availabilityStatus = 'busy'; isAvailableNow = false;
  } else if (!clockEnabled) {
    availabilityStatus = 'unknown'; isAvailableNow = null; reasons.push('clock_disabled');
  } else if (!isClockedIn) {
    availabilityStatus = 'not_clocked_in'; isAvailableNow = false; reasons.push('clock_not_started');
  } else {
    availabilityStatus = 'available'; isAvailableNow = true;
  }
  const siteVisible = id => typeof id === 'string' && (scope.siteVisible ? scope.siteVisible(id)
    : !Array.isArray(context.allowedSiteIds) || context.allowedSiteIds.includes(id));
  const activeOrderSite = activeOrder?.siteId ?? state.logistics?.details?.[activeOrder?.orderId]?.siteId
    ?? index.orders.get(activeOrder?.orderId)?.siteId;
  const breakStartedAt = isOnBreak ? active.breaks.findLast(value => !value.endedAt)?.startedAt ?? null : null;
  const lastClockEventAt = index.lastClockEvents.get(person.id)?.at ?? latestClosedAt(sessions) ?? active?.startedAt ?? null;
  return {
    personId: person.id, name: person.name, team: person.team ?? '',
    siteIds: [...(person.siteIds ?? [])].filter(siteVisible), timeSource: clock.source,
    clockEnabled, clockStatus, isClockedIn, isOnBreak, isWorkingNow, workStateSource,
    clockSessionId: active?.id ?? null, clockedInAt: active?.startedAt ?? null, breakStartedAt,
    ...(active?.siteId && siteVisible(active.siteId) ? { clockSiteId: active.siteId } : {}),
    workSeconds: clock.workSeconds, breakSeconds: clock.breakSeconds,
    lastClockEventAt, statusSince: clockEnabled ? breakStartedAt ?? active?.startedAt ?? latestClosedAt(sessions)
      : workStateSource === 'order' ? activeOrder.startedAt : null, isRunning: isClockedIn,
    requiresCorrection, hasActiveOrder: Boolean(activeOrder),
    ...(activeOrder && scope.readOrderIds && typeof activeOrderSite === 'string' && siteVisible(activeOrderSite) ? { activeOrderId: activeOrder.orderId } : {}),
    ...facts, availabilityStatus, isAvailableNow, reasonCodes: reasons,
  };
}

/** Own authenticated employee projection. The HTTP caller binds the person and
 * identities to the verified employee session; no cross-person permission is
 * inferred from ordinary personnel, employment or transport read rights. */
export function employeePresenceForPerson(state, personOrId, context = {}) {
  const index = buildIndex(state), personId = typeof personOrId === 'string' ? personOrId : personOrId?.id;
  const person = index.people.get(personId);
  if (!person || !person.active || person.kind !== 'employee') fail('Närvaro gäller en aktiv anställd.');
  if (context.effectiveUserId && context.effectiveUserId !== (person.userId ?? person.id)) fail('Du kan bara läsa din egen närvaro.');
  return projectPerson(state, person, index, { ...context, now: serverClock(context) });
}

/** One consistent read snapshot, one set of person indexes, no month/time
 * histories or persisted availability flags. These observations introduce no
 * new login, booking or work-action restrictions. */
export function employeePresenceProjection(state, principal, context = {}) {
  const user = principal?.user;
  const actor = !principal?.actor || principal.actor.id === user?.id ? { ...user, ...principal?.actor } : principal.actor;
  if (!user || !actor?.id || actor.id !== user.id && actor.level !== 'Systemadmin'
    || !can(actor, 'personnelPresenceRead') || !can(user, 'personnelPresenceRead')) {
    fail('Du saknar behörighet att läsa personalens närvaro.');
  }
  const index = buildIndex(state), now = serverClock(context);
  const siteVisible = id => siteAllowed(actor, id) && siteAllowed(user, id);
  if (context.siteId !== undefined && !siteVisible(context.siteId)) fail('Du saknar åtkomst till den valda anläggningen.');
  const readOrderIds = can(actor, 'transportRead') && can(user, 'transportRead');
  const people = (state.personnel?.people ?? []).filter(person => person.kind === 'employee' && person.active
    && personAllowed(actor, person) && personAllowed(user, person)
    && (!context.siteId || person.siteIds.includes(context.siteId)))
    .map(person => projectPerson(state, person, index, { ...context, now }, { siteVisible, readOrderIds }))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.personId.localeCompare(b.personId));
  const summary = {
    total: people.length, clockedIn: 0, working: 0, onBreak: 0, clockedOut: 0, clockDisabled: 0, needsReview: 0, available: 0,
  };
  for (const person of people) {
    if (person.isClockedIn) summary.clockedIn += 1;
    if (person.clockStatus === 'working') summary.working += 1;
    if (person.clockStatus === 'break') summary.onBreak += 1;
    if (person.clockStatus === 'out' || person.clockStatus === 'off') summary.clockedOut += 1;
    if (person.clockStatus === 'disabled') summary.clockDisabled += 1;
    if (person.availabilityStatus === 'needs_review') summary.needsReview += 1;
    if (person.isAvailableNow === true) summary.available += 1;
  }
  const catalog = context.siteCatalog ?? state.environment?.sites ?? state.logistics?.sites ?? [];
  const sites = catalog.filter(site => site.active !== false && siteVisible(site.id)).map(({ id, name }) => ({ id, name }));
  const revisions = [state.employeeTime?.revision, state.personnel?.revision, state.pricing?.revision, state.logistics?.revision, state.transport?.revision];
  return { serverNow: now.toISOString(), people, summary, sites,
    revision: revisions.reduce((total, value) => total + (Number.isSafeInteger(value) && value >= 0 ? value : 0), 0) };
}
