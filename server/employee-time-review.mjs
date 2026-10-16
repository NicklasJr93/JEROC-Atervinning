import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { principalOwnsUser } from './business-identity.mjs';
import { employeeTimeToday, employeeTimePeriodProjection, employeeTimeIntervalDates,
  assertEmployeeTimeEditable, assertEmployeeTimeRangeEditable } from './employee-time.mjs';

export { assertEmployeeTimeEditable, assertEmployeeTimeRangeEditable };
const copy = value => structuredClone(value);
const fail = (message, status = 422) => { throw new PricingError(message, status); };
const id = z.string().trim().min(1).max(120);
const revision = z.number().int().nonnegative();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 2100);
const reason = z.string().trim().min(1).max(1000);
const commandSchema = z.object({
  action: z.enum(['review.submit', 'review.withdraw', 'review.approve', 'review.return', 'review.reopen']),
  personId: id.optional(), month: monthSchema, revision, requestId: id, reason: reason.optional(),
}).strict();
const LOCKED = new Set(['submitted', 'approved']);
const can = (user, right) => Boolean(user && user.active !== false && (user.level === 'Systemadmin' || (user.permissions ?? []).includes(right)));
const sitesAllowPerson = (user, person) => !Array.isArray(user.siteIds) || person.siteIds?.length > 0 && person.siteIds.every(siteId => user.siteIds.includes(siteId));
const sitesAllowRecord = (user, siteId) => !Array.isArray(user.siteIds) || typeof siteId === 'string' && user.siteIds.includes(siteId);
function parsed(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '));
  return result.data;
}
function nowContext(context = {}) {
  const now = new Date(typeof context.now === 'function' ? context.now() : context.now ?? Date.now());
  if (!Number.isFinite(now.getTime())) fail('Systemets tid kunde inte läsas.');
  return { ...context, now };
}
function grouped(values) {
  const map = new Map();
  for (const value of values ?? []) {
    if (!map.has(value.personId)) map.set(value.personId, []);
    map.get(value.personId).push(value);
  }
  return map;
}
function buildIndex(state) {
  const domain = state.employeeTime ?? {}, personnel = state.personnel ?? {};
  const index = { people: new Map((personnel.people ?? []).map(value => [value.id, value])),
    users: new Map((state.pricing?.users ?? []).map(value => [value.id, value])),
    orders: new Map((state.transport?.orders ?? []).map(value => [value.id, value])) };
  for (const name of ['entries', 'orderSessions', 'clockSessions', 'settings', 'requirementHistory', 'normativeHistory', 'reviews', 'reviewEvents']) index[name] = grouped(domain[name]);
  for (const name of ['schedules', 'employment', 'absences']) index[name] = grouped(personnel[name]);
  return index;
}
function findPerson(index, personOrId) {
  const person = index.people.get(typeof personOrId === 'string' ? personOrId : personOrId?.id);
  if (!person || person.kind !== 'employee') fail('Välj en anställd i bolaget för tidrapporten.', 404);
  return person;
}
function personState(state, person, index) {
  const own = name => index[name].get(person.id) ?? [];
  const historicSites = [...own('entries'), ...own('orderSessions'), ...own('clockSessions')].map(value => value.siteId).filter(Boolean);
  const canonicalPerson = { ...person, siteIds: [...new Set([...person.siteIds, ...historicSites])] };
  return { personnel: { people: [canonicalPerson], schedules: own('schedules'), employment: own('employment'), absences: own('absences') },
    employeeTime: Object.fromEntries(['entries', 'orderSessions', 'clockSessions', 'settings', 'requirementHistory', 'normativeHistory'].map(name => [name, own(name)])) };
}
function deterministic(value) {
  if (Array.isArray(value)) return value.map(deterministic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => [key, deterministic(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(deterministic(value))).digest('hex');
const select = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, copy(value[key])]));
function overlapsMonth(value, month, context) {
  if (!Number.isFinite(Date.parse(value.startedAt))) return false;
  const span = employeeTimeIntervalDates(value.startedAt, value.endedAt, context);
  return span.fromDate.slice(0, 7) <= month && span.toDate.slice(0, 7) >= month;
}
function recordSite(state, index, record) {
  return record.siteId ?? state.logistics?.details?.[record.orderId]?.siteId ?? index.orders.get(record.orderId)?.siteId;
}
function calculatePeriod(state, person, month, index, context) {
  const result = employeeTimePeriodProjection(personState(state, person, index), person, { ...context, month });
  const keys = ['date', 'timeSource', 'expectedMinutes', 'recordedMinutes', 'missingMinutes', 'absenceMinutes', 'automaticMinutes', 'manualMinutes', 'clockMinutes', 'breakMinutes', 'allocatedMinutes', 'unallocatedMinutes', 'status', 'requirement'];
  const entryKeys = ['id', 'source', 'revision', 'activity', 'startMinute', 'endMinute', 'breakMinutes', 'minutes', 'orderId', 'siteId', 'startedAt', 'endedAt'];
  const clockKeys = ['id', 'startedAt', 'endedAt', 'breaks', 'revision', 'provisional', 'requiresCorrection', 'workSeconds', 'breakSeconds', 'dayWorkSeconds', 'dayBreakSeconds', 'siteId'];
  const days = result.days.map(day => ({ ...select(day, keys),
    entries: day.entries.map(entry => select(entry, entryKeys)), clockSessions: day.clockSessions.map(session => select(session, clockKeys)) }));
  const sources = {
    entries: (index.entries.get(person.id) ?? []).filter(value => value.date?.startsWith(`${month}-`) && !value.deletedAt)
      .map(value => select(value, ['id', 'revision', 'date', 'startMinute', 'endMinute', 'breakMinutes', 'activity', 'orderId', 'siteId'])).sort((a, b) => a.id.localeCompare(b.id)),
    orders: (index.orderSessions.get(person.id) ?? []).filter(value => overlapsMonth(value, month, context))
      .map(value => select(value, ['id', 'revision', 'orderId', 'siteId', 'startedAt', 'endedAt', 'breakMinutes'])).sort((a, b) => a.id.localeCompare(b.id)),
    clocks: (index.clockSessions.get(person.id) ?? []).filter(value => overlapsMonth(value, month, context))
      .map(value => select(value, ['id', 'revision', 'siteId', 'startedAt', 'endedAt', 'breaks', 'requiresCorrection'])).sort((a, b) => a.id.localeCompare(b.id)),
    absences: (index.absences.get(person.id) ?? []).filter(value => value.status === 'registered'
      && value.fromDate.slice(0, 7) <= month && value.toDate.slice(0, 7) >= month)
      .map(value => select(value, ['id', 'revision', 'fromDate', 'toDate', 'allDay', 'startMinute', 'endMinute', 'sicknessExtent', 'status']))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const sourceSiteIds = [...new Set([...sources.entries, ...sources.orders, ...sources.clocks]
    .map(value => recordSite(state, index, value)).filter(Boolean))].sort();
  const issues = [];
  if (!result.isClosed) issues.push({ code: 'period_not_closed', severity: 'blocking' });
  for (const session of sources.orders.filter(value => !value.endedAt)) issues.push({ code: 'open_order_session', severity: 'blocking' });
  for (const session of sources.clocks.filter(value => !value.endedAt)) issues.push({ code: 'open_clock_session', severity: 'blocking' });
  if (days.some(day => day.clockSessions.some(value => value.requiresCorrection))) issues.push({ code: 'clock_requires_correction', severity: 'blocking' });
  if (result.summary.missingMinutes > 0) issues.push({ code: 'missing_time', severity: 'warning' });
  if (result.summary.unallocatedMinutes > 0) issues.push({ code: 'unallocated_time', severity: 'warning' });
  return { month, isClosed: result.isClosed, source: 'live', sourceHash: hash({ month, days, summary: result.summary, sources, sourceSiteIds, normativeSources: result.normativeSources }), sourceSiteIds,
    calculatedAt: context.now.toISOString(), days, summary: result.summary, issues };
}
function reviewFor(index, person, month) {
  return (index.reviews.get(person.id) ?? []).find(value => value.month === month) ?? {
    id: `review-${hash([person.id, month]).slice(0, 32)}`, personId: person.id, month, status: 'draft', revision: 0, version: 0, snapshots: [],
  };
}
function snapshotFor(review) { return (review.snapshots ?? []).find(value => value.version === review.version); }
function principalValues(principal) {
  const user = principal?.user;
  const actor = !principal?.actor || principal.actor.id === user?.id ? { ...user, ...principal?.actor } : principal.actor;
  if (!user || !actor?.id || actor.id !== user.id && actor.level !== 'Systemadmin') fail('Logga in som behörig personalansvarig.', 403);
  return { actor, user };
}
function requireRead(principal) {
  const value = principalValues(principal);
  if (![value.actor, value.user].every(user => can(user, 'personnelRead') && can(user, 'personnelTimeReviewRead'))) fail('Du saknar behörighet att granska tidrapporter.', 403);
  return value;
}
function requirePersonScope(principal, person) {
  if (![principal.actor, principal.user].every(user => sitesAllowPerson(user, person))) fail('Du saknar åtkomst till personens samtliga anläggningar.', 403);
}
function selfApproval(principal, person, review) {
  const owners = new Set([person.userId ?? person.id, snapshotFor(review)?.person?.userId].filter(Boolean));
  return [...owners].some(userId => principalOwnsUser(principal, userId));
}
function periodSiteIds(period) {
  return new Set([...(period.sourceSiteIds ?? []), ...period.days.flatMap(day => [...day.entries, ...day.clockSessions]).map(value => value.siteId).filter(Boolean)]);
}
function canReviewPeriod(principal, period) {
  return [...periodSiteIds(period)].every(siteId => [principal.actor, principal.user].every(user => sitesAllowRecord(user, siteId)));
}
function publicPeriod(period, principal, context = {}) {
  const readOrders = principal ? [principal.actor, principal.user].every(user => can(user, 'transportRead')) : false;
  const siteAllowed = siteId => principal ? [principal.actor, principal.user].every(user => sitesAllowRecord(user, siteId))
    : !Array.isArray(context.allowedSiteIds) || typeof siteId === 'string' && context.allowedSiteIds.includes(siteId);
  const { sourceSiteIds: _privateSites, ...publicFields } = period;
  return { ...copy(publicFields), days: period.days.map(day => ({ ...copy(day),
    entries: day.entries.map(entry => {
      const value = copy(entry);
      if (!readOrders || !siteAllowed(value.siteId)) {
        if (value.orderId || value.source === 'order') value.activity = 'Uppdrag';
        delete value.orderId;
      }
      if (value.siteId && !siteAllowed(value.siteId)) delete value.siteId;
      return value;
    }), clockSessions: day.clockSessions.map(session => {
      const value = copy(session); if (value.siteId && !siteAllowed(value.siteId)) delete value.siteId; return value;
    }),
  })) };
}
function reviewView(review, current) {
  return { ...select(review, ['id', 'personId', 'month', 'status', 'revision', 'version']),
    submittedAt: review.submittedAt ?? null, approvedAt: review.approvedAt ?? null, returnedAt: review.returnedAt ?? null, reopenedAt: review.reopenedAt ?? null,
    reason: review.reason ?? null, snapshotHash: snapshotFor(review)?.period.sourceHash ?? null,
    stale: review.status === 'submitted' && snapshotFor(review)?.period.sourceHash !== current.sourceHash };
}
function capabilities(principal, person, review, current, own = false) {
  const submitted = review.status === 'submitted', approved = review.status === 'approved';
  const canManage = principal && [principal.actor, principal.user].every(user => can(user, 'personnelTimeApprove'));
  const snapshotScope = !snapshotFor(review) || !principal || canReviewPeriod(principal, snapshotFor(review).period);
  const validSubmission = submitted && snapshotFor(review)?.period.sourceHash === current.sourceHash;
  const editable = ['draft', 'returned', 'reopened'].includes(review.status);
  return {
    canSubmit: own && person.active && editable && current.isClosed && !current.issues.some(issue => issue.severity === 'blocking'),
    canWithdraw: own && submitted, canApprove: Boolean(canManage && validSubmission && current.isClosed
      && !selfApproval(principal, person, review) && canReviewPeriod(principal, snapshotFor(review).period) && !current.issues.some(issue => issue.severity === 'blocking')),
    canReturn: Boolean(canManage && submitted && snapshotScope), canReopen: Boolean(canManage && approved && snapshotScope),
    canExport: Boolean(principal && approved && snapshotFor(review) && canReviewPeriod(principal, snapshotFor(review).period)),
    canExportHistory: Boolean(principal && (review.snapshots ?? []).some(value => value.approvedAt && canReviewPeriod(principal, value.period))),
    approvalReasonRequired: Boolean(current.summary.missingMinutes > 0 || current.summary.unallocatedMinutes > 0),
  };
}
function detail(state, person, month, index, context, principal, own = false) {
  const review = reviewFor(index, person, month), snapshot = snapshotFor(review);
  const current = review.status === 'approved' && snapshot ? snapshot.period : calculatePeriod(state, person, month, index, context);
  const display = LOCKED.has(review.status) && snapshot ? { ...copy(snapshot.period), source: review.status === 'approved' ? 'approved' : 'submitted' } : current;
  return { serverNow: context.now.toISOString(), today: employeeTimeToday(context), month,
    person: select(person, ['id', 'name', 'team', 'siteIds']), review: reviewView(review, current),
    period: publicPeriod(display, principal, context), history: copy((index.reviewEvents.get(person.id) ?? []).filter(value => value.month === month)),
    versions: (review.snapshots ?? []).filter(value => !principal || canReviewPeriod(principal, value.period)).map(value => ({ version: value.version, sourceHash: value.period.sourceHash, calculatedAt: value.period.calculatedAt,
      submittedAt: value.submittedAt, approvedAt: value.approvedAt ?? null, summary: copy(value.period.summary) })),
    capabilities: capabilities(principal, person, review, current, own) };
}
export function employeeTimeReviewOwn(state, personOrId, context = {}) {
  context = nowContext(context); const index = buildIndex(state), person = findPerson(index, personOrId);
  if (context.effectiveUserId && context.effectiveUserId !== (person.userId ?? person.id)) fail('Du kan bara läsa din egen tidrapport.', 403);
  const month = parsed(monthSchema, context.month ?? employeeTimeToday(context).slice(0, 7));
  return detail(state, person, month, index, context, null, true);
}
export function employeeTimeReviewDetail(state, principal, personOrId, context = {}) {
  context = nowContext(context); principal = requireRead(principal);
  const index = buildIndex(state), person = findPerson(index, personOrId); requirePersonScope(principal, person);
  const month = parsed(monthSchema, context.month ?? employeeTimeToday(context).slice(0, 7));
  return detail(state, person, month, index, context, principal);
}
export function employeeTimeReviewList(state, principal, context = {}) {
  context = nowContext(context); principal = requireRead(principal);
  const index = buildIndex(state), month = parsed(monthSchema, context.month ?? employeeTimeToday(context).slice(0, 7));
  const siteAllowed = siteId => [principal.actor, principal.user].every(user => sitesAllowRecord(user, siteId));
  if (context.siteId && !siteAllowed(context.siteId)) fail('Du saknar åtkomst till den valda anläggningen.', 403);
  const people = (state.personnel?.people ?? []).filter(person => person.kind === 'employee' && (person.active || (index.reviews.get(person.id) ?? []).some(value => value.month === month))
    && [principal.actor, principal.user].every(user => sitesAllowPerson(user, person)) && (!context.siteId || person.siteIds.includes(context.siteId)))
    .map(person => {
      const value = detail(state, person, month, index, context, principal);
      return { personId: person.id, name: person.name, team: person.team ?? '', siteIds: [...person.siteIds], review: value.review,
        summary: value.period.summary, issues: value.period.issues, capabilities: value.capabilities };
    }).sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.personId.localeCompare(b.personId));
  const summary = { total: people.length, draft: 0, submitted: 0, returned: 0, approved: 0, reopened: 0 };
  for (const person of people) summary[person.review.status] += 1;
  const sites = (context.siteCatalog ?? state.logistics?.sites ?? []).filter(site => site.active !== false && siteAllowed(site.id)).map(({ id, name }) => ({ id, name }));
  return { serverNow: context.now.toISOString(), today: employeeTimeToday(context), month, people, summary, sites,
    capabilities: { canRead: true, canApprove: [principal.actor, principal.user].every(user => can(user, 'personnelTimeApprove')), canExport: true } };
}
function ensureReviews(state) {
  state.employeeTime ??= { revision: 0 };
  for (const name of ['reviews', 'reviewRequests', 'reviewEvents', 'audit']) state.employeeTime[name] ??= [];
  return state.employeeTime;
}
function preparedCommand(state, person, command, identity, context) {
  const input = parsed(commandSchema, command);
  if (input.personId && input.personId !== person.id) fail('Personvalet har ändrats. Öppna tidrapporten igen.', 409);
  const payloadHash = hash({ ...input, personId: person.id });
  const previous = (state.employeeTime?.reviewRequests ?? []).find(value => value.requestId === input.requestId);
  if (previous) {
    if (previous.payloadHash !== payloadHash || previous.personId !== person.id || previous.actualUserId !== identity.actualUserId || previous.effectiveUserId !== identity.effectiveUserId) {
      fail('Samma anrops-ID används för en annan tidrapportsåtgärd.', 409);
    }
    return { input, payloadHash, retry: true };
  }
  const current = reviewFor(buildIndex(state), person, input.month);
  if (current.revision !== input.revision) fail('Tidrapporten ändrades i en annan session. Uppdatera och försök igen.', 409);
  return { input, payloadHash, current };
}
function eventAndSave(state, person, review, input, identity, payloadHash, transactionAudit, context, fromStatus) {
  const domain = ensureReviews(state), at = context.now.toISOString();
  const event = { id: `time-review-event-${randomUUID()}`, personId: person.id, month: input.month, action: input.action, at,
    actualUserId: identity.actualUserId, effectiveUserId: identity.effectiveUserId, reason: input.reason ?? '',
    fromStatus, toStatus: review.status, version: review.version, snapshotHash: snapshotFor(review)?.period.sourceHash ?? null };
  const previous = domain.reviews.findIndex(value => value.id === review.id);
  if (previous < 0) domain.reviews.push(review); else domain.reviews[previous] = review;
  domain.reviewEvents.push(event); domain.audit.push({ ...event, actorId: identity.effectiveUserId }); domain.revision = (domain.revision ?? 0) + 1;
  domain.reviewRequests.push({ requestId: input.requestId, personId: person.id, payloadHash, ...identity, at });
  transactionAudit.push({ ...event, domain: 'employeeTime' });
}
export function employeeTimeReviewEmployeeCommand(state, personOrId, command, transactionAudit = [], context = {}) {
  context = nowContext(context); const index = buildIndex(state), person = findPerson(index, personOrId);
  if (!person.active || context.effectiveUserId && context.effectiveUserId !== (person.userId ?? person.id)) fail('Du kan bara skicka eller återkalla din egen tidrapport.', 403);
  const identity = { actualUserId: context.actualUserId ?? person.userId ?? person.id, effectiveUserId: context.effectiveUserId ?? person.userId ?? person.id };
  const prepared = preparedCommand(state, person, command, identity, context), { input, payloadHash } = prepared;
  if (!['review.submit', 'review.withdraw'].includes(input.action)) fail('Välj skicka eller återkalla din egen tidrapport.', 403);
  if (prepared.retry) return employeeTimeReviewOwn(state, person, { ...context, month: input.month });
  const review = copy(prepared.current), fromStatus = review.status;
  if (input.action === 'review.submit') {
    if (!['draft', 'returned', 'reopened'].includes(review.status)) fail('Tidrapporten är redan inskickad eller attesterad.', 409);
    const period = calculatePeriod(state, person, input.month, index, context);
    if (!period.isClosed) fail('En tidrapport kan skickas först när månaden är avslutad.', 409);
    if (period.issues.some(issue => issue.severity === 'blocking')) fail('Avsluta pågående pass och rätta stämplingar innan tidrapporten skickas.', 409);
    review.version += 1; review.status = 'submitted'; review.submittedAt = context.now.toISOString(); review.approvedAt = null; review.reason = null;
    review.snapshots ??= [];
    review.snapshots.push({ version: review.version, submittedAt: review.submittedAt, submittedBy: identity.effectiveUserId,
      person: { ...select(person, ['id', 'name', 'employeeNumber', 'siteIds']), userId: person.userId ?? person.id }, period: copy(period) });
  } else {
    if (review.status !== 'submitted') fail('Endast en inskickad tidrapport kan återkallas.', 409);
    review.status = 'draft'; review.reason = null;
  }
  review.revision += 1;
  eventAndSave(state, person, review, input, identity, payloadHash, transactionAudit, context, fromStatus);
  return employeeTimeReviewOwn(state, person, { ...context, month: input.month });
}
export function employeeTimeReviewStaffCommand(state, principal, command, transactionAudit = [], context = {}) {
  context = nowContext(context); principal = requireRead(principal);
  if (![principal.actor, principal.user].every(user => can(user, 'personnelTimeApprove'))) fail('Du saknar behörighet att attestera eller återöppna tidrapporter.', 403);
  const index = buildIndex(state), person = findPerson(index, command?.personId); requirePersonScope(principal, person);
  const identity = { actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
  const prepared = preparedCommand(state, person, command, identity, context), { input, payloadHash } = prepared;
  if (!['review.approve', 'review.return', 'review.reopen'].includes(input.action)) fail('Välj attestera, skicka tillbaka eller återöppna tidrapporten.', 403);
  if (prepared.retry) return employeeTimeReviewDetail(state, principal, person, { ...context, month: input.month });
  const review = copy(prepared.current), fromStatus = review.status;
  if (input.action === 'review.approve') {
    if (review.status !== 'submitted') fail('Tidrapporten måste vara inskickad innan attest.', 409);
    if (selfApproval(principal, person, review)) fail('Du får inte attestera din egen tidrapport, även om du är systemadministratör.', 403);
    const current = calculatePeriod(state, person, input.month, index, context), snapshot = snapshotFor(review);
    if (!current.isClosed) fail('En tidrapport kan attesteras först när månaden är avslutad.', 409);
    if (!snapshot || snapshot.period.sourceHash !== current.sourceHash) fail('Tidunderlaget har ändrats sedan rapporten skickades. Skicka tillbaka och låt personen skicka en ny version.', 409);
    if (current.issues.some(issue => issue.severity === 'blocking')) fail('Tidrapporten innehåller pågående eller rättelsekrävande pass.', 409);
    if (!canReviewPeriod(principal, snapshot.period)) fail('Tidrapporten innehåller underlag från en anläggning utanför din åtkomst.', 403);
    if ((current.summary.missingMinutes > 0 || current.summary.unallocatedMinutes > 0) && !input.reason) fail('Ange en anledning när attest godtar saknade eller ofördelade verkliga timmar.');
    review.status = 'approved'; review.approvedAt = context.now.toISOString(); review.approvedBy = principal.user.id; review.reason = input.reason ?? null;
    snapshot.approvedAt = review.approvedAt; snapshot.approvedBy = principal.user.id;
    snapshot.approvedActualUserId = principal.actor.id; snapshot.approvedEffectiveUserId = principal.user.id;
    snapshot.approvalReason = input.reason ?? null;
  } else {
    if (!input.reason) fail('Ange en anledning när tidrapporten skickas tillbaka eller återöppnas.');
    if (input.action === 'review.return' && review.status !== 'submitted') fail('Endast en inskickad tidrapport kan skickas tillbaka.', 409);
    if (input.action === 'review.reopen' && review.status !== 'approved') fail('Endast en attesterad tidrapport kan återöppnas.', 409);
    if (snapshotFor(review) && !canReviewPeriod(principal, snapshotFor(review).period)) fail('Tidrapporten innehåller underlag från en anläggning utanför din åtkomst.', 403);
    review.status = input.action === 'review.return' ? 'returned' : 'reopened'; review.reason = input.reason;
    review[input.action === 'review.return' ? 'returnedAt' : 'reopenedAt'] = context.now.toISOString();
  }
  review.revision += 1;
  eventAndSave(state, person, review, input, identity, payloadHash, transactionAudit, context, fromStatus);
  return employeeTimeReviewDetail(state, principal, person, { ...context, month: input.month });
}
/** Canonical before/after guards permit unrelated profile/future schedule
 * writes, but prevent historical recalculation of submitted/approved periods.
 * Compare current source before and after, not a possibly already-stale saved
 * snapshot, so an unrelated write never blocks because of an older mismatch. */
export function employeeTimeReviewSourceStamp(state, personIds, context = {}) {
  context = nowContext(context); const index = buildIndex(state), ids = new Set(personIds ?? []);
  return (state.employeeTime?.reviews ?? []).filter(review => ids.has(review.personId) && LOCKED.has(review.status)).map(review => {
    const person = findPerson(index, review.personId);
    return { personId: person.id, month: review.month, comparisonAt: context.now.toISOString(), sourceHash: calculatePeriod(state, person, review.month, index, context).sourceHash };
  });
}
export function assertEmployeeTimeReviewSourceStamp(state, stamp, context = {}) {
  context = nowContext(context); const index = buildIndex(state);
  for (const previous of stamp) {
    const person = findPerson(index, previous.personId);
    if (calculatePeriod(state, person, previous.month, index, { ...context, now: new Date(previous.comparisonAt ?? context.now) }).sourceHash !== previous.sourceHash) {
      fail(`Ändringen påverkar den låsta tidrapporten för ${previous.month}. Skicka tillbaka eller återöppna perioden först.`, 409);
    }
  }
}
export function employeeTimeReviewApproved(state, principal, context = {}) {
  context = nowContext(context); principal = requireRead(principal);
  const index = buildIndex(state), month = parsed(monthSchema, context.month);
  const requested = context.personIds ? new Set(context.personIds) : null;
  const selectedVersion = context.version === undefined ? null : parsed(z.number().int().positive(), context.version);
  if (selectedVersion !== null && requested?.size !== 1) fail('En historisk export kräver exakt en vald person.');
  const result = [];
  for (const review of state.employeeTime?.reviews ?? []) {
    if (review.month !== month || selectedVersion === null && review.status !== 'approved' || requested && !requested.has(review.personId)) continue;
    const person = findPerson(index, review.personId);
    if (!sitesAllowPerson(principal.actor, person) || !sitesAllowPerson(principal.user, person) || context.siteId && !person.siteIds.includes(context.siteId)) {
      if (requested?.has(person.id)) fail('Du saknar åtkomst till den valda personens tidrapport.', 403);
      continue;
    }
    const snapshot = selectedVersion === null ? snapshotFor(review) : review.snapshots?.find(value => value.version === selectedVersion);
    if (!snapshot || !snapshot.approvedAt || !canReviewPeriod(principal, snapshot.period)) fail('Den attesterade tidrapportens underlag kan inte exporteras med din åtkomst.', 403);
    result.push({ person: { ...select(snapshot.person, ['id', 'name', 'employeeNumber']),
        siteIds: (snapshot.person.siteIds ?? []).filter(siteId => [principal.actor, principal.user].every(user => sitesAllowRecord(user, siteId))) },
      latestStatus: review.status, historical: selectedVersion !== null && (review.status !== 'approved' || selectedVersion !== review.version),
      review: { ...reviewView(review, snapshot.period), version: snapshot.version, status: 'approved', submittedAt: snapshot.submittedAt,
        approvedAt: snapshot.approvedAt, approvedBy: snapshot.approvedBy,
        approvedActualUserId: snapshot.approvedActualUserId, approvedEffectiveUserId: snapshot.approvedEffectiveUserId,
        reason: snapshot.approvalReason ?? null, snapshotHash: snapshot.period.sourceHash },
      period: publicPeriod({ ...snapshot.period, source: 'approved' }, principal, context) });
  }
  if (requested && [...requested].some(personId => !result.some(value => value.person.id === personId))) fail('Export kräver en aktuell attesterad tidrapport för varje vald person.', 409);
  return { month, serverNow: context.now.toISOString(), reports: result };
}
