import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { vehicleRegistryCapabilities } from './personnel-vehicles.mjs';

const clone = value => structuredClone(value);
const id = z.string().trim().min(1).max(120);
const rev = z.number().int().nonnegative().safe();
const text = z.string().trim().max(2000);
const positive = z.number().finite().nonnegative().max(1e10);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value);
const instant = z.string().datetime({ offset: true });
const photo = z.string().trim().max(1000).refine(value => !value || /^\/api\/fleet\/(?:photos|files)\/[a-zA-Z0-9_-]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value), 'Välj en sparad bild eller en HTTPS-adress.');
const photos = z.array(photo).max(10);
const fail = (message, status = 409, code = 'fleet_invalid') => { const error = new PricingError(message, status); error.code = code; throw error; };
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '), 422); return result.data; };
const clock = opts => { const value = new Date(typeof opts?.now === 'function' ? opts.now() : opts?.now ?? Date.now()); if (!Number.isFinite(value.getTime())) fail('Systemets tid är ogiltig.', 422); return value.toISOString(); };
const emptyFleet = () => ({ version: 1, revision: 0, profiles: {}, services: [], issues: [], inspections: [], trips: [], events: [], requests: [] });

/** Metadata only: the canonical vehicle registry and every existing ID survive. */
export function ensureFleet(state) {
  state.fleet ??= emptyFleet();
  state.fleet.version ??= 1; state.fleet.revision ??= 0; state.fleet.profiles ??= {};
  for (const key of ['services', 'issues', 'inspections', 'trips', 'events', 'requests']) state.fleet[key] ??= [];
  return state.fleet;
}
const users = principal => [principal?.actor, principal?.user];
const permitted = (user, right) => Boolean(user?.id) && user.active !== false && (['Systemadmin', 'VD'].includes(user.level) || user.level === 'Medarbetare' && Array.isArray(user.permissions) && user.permissions.includes(right));
export function fleetCapabilities(principal) {
  const read = users(principal).every(user => permitted(user, 'fleetRead'));
  return { read, write: read && users(principal).every(user => permitted(user, 'fleetWrite')),
    vehicleWrite: read && vehicleRegistryCapabilities(principal).vehicleWrite,
    export: read && users(principal).every(user => permitted(user, 'fleetExport')),
    unblock: read && users(principal).every(user => permitted(user, 'fleetUnblock')) };
}
const siteVisible = (principal, siteId) => users(principal).every(user => !Array.isArray(user?.siteIds) || Boolean(siteId) && user.siteIds.includes(siteId));
const vehicleSite = (state, vehicleId) => state.fleet?.profiles?.[vehicleId]?.siteId;
const visibleVehicle = (state, principal, vehicleId) => siteVisible(principal, vehicleSite(state, vehicleId));
function vehicleFor(state, vehicleId) { const vehicle = state.transport?.vehicles?.find(value => value.id === vehicleId); if (!vehicle) fail('Fordonet finns inte i det gemensamma fordonsregistret.', 404, 'fleet_vehicle_missing'); return vehicle; }
function requireVehicle(state, principal, vehicleId) { const vehicle = vehicleFor(state, vehicleId); if (!visibleVehicle(state, principal, vehicleId)) fail('Du saknar åtkomst till fordonets anläggning.', 403, 'fleet_site_forbidden'); return vehicle; }
const personSitesVisible = (principal, person) => users(principal).every(user => !Array.isArray(user?.siteIds) || person.siteIds?.some(siteId => user.siteIds.includes(siteId)));
function personFor(state, personId) { const person = state.personnel?.people?.find(value => value.id === personId); if (!person || person.active === false) fail('Välj en aktiv registrerad person.', 422, 'fleet_person_missing'); return person; }
function employeeIdentity(state, identity, opts = {}) {
  if (!identity) fail('Logga in för att öppna ditt fordon.', 401, 'fleet_auth_required');
  if (identity.principal) identity = { ...identity, ...identity.principal };
  const assertedId = identity.personId ?? identity.person?.id;
  let matches = assertedId ? state.personnel?.people?.filter(person => person.id === assertedId) : identity.user?.id ? state.personnel?.people?.filter(person => person.userId === identity.user.id) : [];
  if (identity.user && (identity.user.active === false || !identity.user.id) || identity.actor && identity.actor.active === false || matches?.length !== 1) fail('Ditt konto saknar en entydig aktiv personkoppling.', 403, 'fleet_identity_invalid');
  const person = matches[0];
  if (person.active === false || person.kind !== 'employee' || identity.user?.id && person.userId && person.userId !== identity.user.id) fail('Fordonsappen kräver en aktiv egen anställdprofil.', 403, 'fleet_identity_invalid');
  const restrictions = [identity.allowedSiteIds, identity.siteIds, identity.user?.siteIds, identity.actor?.siteIds, opts.allowedSiteIds].filter(Array.isArray);
  return { person, allowedSiteIds: restrictions.reduce((sites, scope) => sites.filter(siteId => scope.includes(siteId)), [...(person.siteIds ?? [])]),
    actorId: opts.actualUserId ?? identity.actor?.id ?? identity.actualUserId ?? person.userId ?? person.id,
    userId: opts.effectiveUserId ?? identity.user?.id ?? identity.effectiveUserId ?? person.userId ?? person.id };
}
const ownTrip = (trip, personId) => trip.personId === personId && (trip.driverSource !== 'unknown' || trip.manualDriverAssignment?.personId === personId);
const hasPurpose = value => typeof value === 'string' && value.trim().length >= 5 && !/^(tjänst|arbete|jobb|business|work)$/i.test(value.trim());
const completedTrip = trip => trip.classification === 'private' || trip.classification === 'business' && (hasPurpose(trip.purpose) || Boolean(trip.workOrderId));
const latestFirst = (a, b) => Date.parse(b.endAt ?? b.startAt) - Date.parse(a.endAt ?? a.startAt) || a.id.localeCompare(b.id);
export function fleetTripGate(state, personOrId) {
  const personId = typeof personOrId === 'string' ? personOrId : personOrId?.personId ?? personOrId?.id;
  const person = state.personnel?.people?.find(value => value.id === personId && value.active !== false);
  if (!person) return { blocked: false, count: 0, pendingTrips: [], safeToInteract: true };
  const trips = (state.fleet?.trips ?? []).filter(trip => ownTrip(trip, person.id));
  const pendingTrips = trips.filter(trip => trip.endAt && trip.quality !== 'sensor_gap' && !completedTrip(trip)).sort(latestFirst).map(clone);
  return { blocked: pendingTrips.length > 0, count: pendingTrips.length, pendingTrips, safeToInteract: !trips.some(trip => !trip.endAt) };
}
const planningFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const planningCache = new Map();
function localWallTime(timestamp) {
  const parts = Object.fromEntries(planningFormatter.formatToParts(new Date(timestamp)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}
function wallCandidates(wallTime) {
  // Read the zone's actual offsets around this day instead of assuming a UTC
  // offset. A fold has two candidates; a spring-forward gap has none.
  const offsets = new Set([-2, 0, 2].map(days => { const sample = wallTime + days * 86400000; return localWallTime(sample) - sample; }));
  return [...offsets].map(offset => wallTime - offset).filter(timestamp => localWallTime(timestamp) === wallTime).sort((a, b) => a - b);
}
function planningIntervals(plan) {
  if (!plan || !date.safeParse(plan.date).success || !Number.isInteger(plan.startMinute) || plan.startMinute < 0 || plan.startMinute >= 1440 ||
    !Number.isInteger(plan.durationMinutes) || plan.durationMinutes <= 0 || plan.startMinute + plan.durationMinutes > 1440) return [];
  const key = `${plan.date}:${plan.startMinute}:${plan.durationMinutes}`;
  if (planningCache.has(key)) return planningCache.get(key);
  const wallStart = Date.parse(`${plan.date}T00:00:00Z`) + plan.startMinute * 60000, wallEnd = wallStart + plan.durationMinutes * 60000;
  const starts = wallCandidates(wallStart), ends = wallCandidates(wallEnd);
  const intervals = starts.flatMap(start => ends.filter(end => end > start && (starts.length !== 2 || ends.length !== 2 || wallStart - start === wallEnd - end)).map(end => [start, end]));
  if (planningCache.size >= 5000) planningCache.clear(); planningCache.set(key, intervals);
  return intervals;
}
const serviceInterval = service => service.status === 'planned' && service.startAt && service.endAt && Number.isFinite(Date.parse(service.startAt)) && Date.parse(service.endAt) > Date.parse(service.startAt)
  ? [Date.parse(service.startAt), Date.parse(service.endAt)] : null;
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
export function fleetVehicleEligible(state, vehicleId, opts = {}) {
  const vehicle = state.transport?.vehicles?.find(value => value.id === vehicleId), profile = state.fleet?.profiles?.[vehicleId], issues = [];
  if (!vehicle) issues.push({ code: 'fleet_vehicle_missing', message: 'Fordonet saknas i fordonsregistret.' });
  else if (vehicle.active === false) issues.push({ code: 'fleet_vehicle_inactive', message: 'Fordonet är inaktiverat.' });
  if (profile?.blocked) issues.push({ code: 'fleet_vehicle_blocked', message: profile.blockReason || 'Fordonet är driftspärrat.' });
  const intervals = opts.plan ? planningIntervals(opts.plan) : undefined;
  if (opts.plan && !intervals.length) issues.push({ code: 'fleet_plan_time_invalid', message: 'Planens lokala datum och klockslag behöver kontrolleras, även vid övergång till sommartid.' });
  const timestamp = opts.plan ? null : opts.at === undefined ? Date.parse(clock(opts)) : new Date(opts.at).getTime();
  if (!opts.plan && !Number.isFinite(timestamp)) issues.push({ code: 'fleet_plan_time_invalid', message: 'Tidpunkten för fordonets tillgänglighet är ogiltig.' });
  for (const service of state.fleet?.services ?? []) {
    if (service.vehicleId !== vehicleId) continue;
    const interval = serviceInterval(service); if (!interval) continue;
    if (intervals ? intervals.some(plan => overlaps(plan, interval)) : interval[0] <= timestamp && timestamp < interval[1])
      issues.push({ code: 'fleet_vehicle_service', message: `Fordonet är reserverat för verkstad: ${service.title}.`, serviceId: service.id });
  }
  return { eligible: issues.length === 0, issues };
}

const officeTrip = trip => { const result = clone(trip); if (trip.classification !== 'business') for (const key of ['positions', 'fromLabel', 'toLabel', 'purpose', 'workOrderId']) delete result[key]; return result; };
const eventView = event => Object.fromEntries(['id', 'action', 'at', 'vehicleId', 'tripId', 'personId', 'actualUserId', 'effectiveUserId', 'text'].filter(key => event[key] !== undefined).map(key => [key, clone(event[key])]));
const workOrderView = order => Object.fromEntries(['id', 'customerName', 'siteId', 'driverId', 'vehicleId'].filter(key => order[key] !== undefined).map(key => [key, order[key]]));
const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
const tripDay = value => dayFormatter.format(new Date(value));
function tripSearch(state, trip, own = false) {
  const vehicle = state.transport?.vehicles?.find(vehicle => vehicle.id === trip.vehicleId), person = state.personnel?.people?.find(person => person.id === trip.personId);
  return [trip.id, trip.vehicleId, trip.personId, vehicle?.registration, vehicle?.machineIdentifier, vehicle?.name, person?.name,
    ...(own || trip.classification === 'business' ? [trip.purpose, trip.workOrderId, trip.fromLabel, trip.toLabel] : [])].filter(Boolean).join(' ').toLocaleLowerCase('sv-SE');
}
function tripPage(rows, opts, searchText) {
  const from = opts.fromDate ?? opts.from, to = opts.toDate ?? opts.to;
  if (from !== undefined) parse(date, from); if (to !== undefined) parse(date, to);
  if (from && to && from > to) fail('Periodens slutdatum föregår startdatum.', 422);
  const limit = opts.limit === undefined ? 100 : parse(z.number().int().min(1).max(1000), opts.limit), offset = opts.offset === undefined ? 0 : parse(rev, opts.offset);
  const search = opts.search === undefined ? '' : parse(z.string().trim().max(200), opts.search).toLocaleLowerCase('sv-SE');
  const classification = opts.classification === undefined ? 'all' : parse(z.enum(['all', 'private', 'business', 'unclassified']), opts.classification);
  const status = opts.status === undefined ? 'all' : parse(z.enum(['all', 'active', 'incomplete', 'pending', 'complete', 'completed', 'review']), opts.status);
  const matching = rows.filter(trip => (!opts.vehicleId || trip.vehicleId === opts.vehicleId) && (!opts.personId || trip.personId === opts.personId) &&
    (classification === 'all' || classification === 'unclassified' ? classification === 'all' || !trip.classification : trip.classification === classification) &&
    (status === 'all' || status === 'active' && !trip.endAt || ['incomplete', 'pending'].includes(status) && trip.endAt && trip.quality !== 'sensor_gap' && !completedTrip(trip) ||
      ['complete', 'completed'].includes(status) && trip.endAt && completedTrip(trip) || status === 'review' && (trip.quality === 'review' || trip.quality === 'sensor_gap' || trip.driverConflict && !trip.manualDriverAssignment || trip.driverSource === 'unknown' && !trip.manualDriverAssignment)) &&
    (!search || searchText(trip).includes(search)) && (!from || tripDay(trip.startAt) >= from) && (!to || tripDay(trip.startAt) <= to)).sort(latestFirst);
  return { trips: matching.slice(offset, offset + limit), tripCount: matching.length, truncated: offset > 0 || matching.length > limit, pagination: { offset, limit, total: matching.length } };
}
export function fleetProjection(state, principal, opts = {}) {
  const capabilities = fleetCapabilities(principal); if (!capabilities.read) fail('Du saknar behörighet att läsa fordon.', 403, 'fleet_forbidden');
  const fleet = state.fleet ?? emptyFleet(), vehicles = (state.transport?.vehicles ?? []).filter(vehicle => visibleVehicle(state, principal, vehicle.id));
  const ids = new Set(vehicles.map(vehicle => vehicle.id));
  const page = tripPage(fleet.trips.filter(trip => ids.has(trip.vehicleId)), opts, trip => tripSearch(state, trip));
  const now = Date.parse(clock(opts)), positions = vehicles.flatMap(vehicle => {
    const trip = fleet.trips.filter(trip => trip.vehicleId === vehicle.id).sort(latestFirst)[0];
    if (trip?.classification !== 'business' || !trip.positions?.length) return [];
    const last = [...trip.positions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return [{ vehicleId: vehicle.id, ...clone(last), source: trip.source, stale: now - Date.parse(last.at) > 10 * 60 * 1000 }];
  });
  return { revision: fleet.revision, vehicles: clone(vehicles), profiles: clone(Object.fromEntries(Object.entries(fleet.profiles).filter(([vehicleId]) => ids.has(vehicleId)))), positions,
    services: clone(fleet.services.filter(row => ids.has(row.vehicleId))), issues: clone(fleet.issues.filter(row => ids.has(row.vehicleId))), inspections: clone(fleet.inspections.filter(row => ids.has(row.vehicleId))),
    ...page, trips: page.trips.map(officeTrip),
    events: fleet.events.filter(row => ids.has(row.vehicleId)).map(eventView), people: (state.personnel?.people ?? []).filter(person => person.active !== false && personSitesVisible(principal, person)).map(person => Object.fromEntries(['id', 'name', 'userId', 'driverId', 'vehicleId'].filter(key => person[key] !== undefined).map(key => [key, person[key]]))),
    workOrders: (state.transport?.orders ?? []).filter(order => siteVisible(principal, order.siteId)).map(workOrderView), capabilities };
}
function employeeVehicles(state, auth) {
  return (state.transport?.vehicles ?? []).filter(vehicle => {
    const profile = state.fleet?.profiles?.[vehicle.id], siteId = profile?.siteId;
    const knownSite = siteId ? auth.allowedSiteIds.includes(siteId) : auth.allowedSiteIds.length > 0;
    // Trip ownership grants access to that historical trip, never to the
    // vehicle's current files, reports or next-driver controls after a move.
    return knownSite && (auth.person.vehicleId === vehicle.id || profile?.defaultDriverId === auth.person.id || profile?.nextDriver?.personId === auth.person.id);
  });
}
function employeeOrder(state, auth, orderId) {
  const order = state.transport?.orders?.find(value => value.id === orderId);
  if (!order || !auth.allowedSiteIds.length || !auth.person.driverId || order.driverId !== auth.person.driverId || order.siteId && !auth.allowedSiteIds.includes(order.siteId)) fail('Arbetsordern är inte tillgänglig för dig.', 403, 'fleet_order_forbidden');
  return order;
}
export function employeeFleetProjection(state, identity, opts = {}) {
  const auth = employeeIdentity(state, identity, opts), fleet = state.fleet ?? emptyFleet(), vehicles = employeeVehicles(state, auth), ids = new Set(vehicles.map(vehicle => vehicle.id));
  const page = tripPage(fleet.trips.filter(trip => ownTrip(trip, auth.person.id)), opts, trip => tripSearch(state, trip, true)), gate = fleetTripGate(state, auth.person);
  // A historic own trip remains completable after site access changes. Its
  // private route stays visible to its driver, never to the company map.
  return { revision: fleet.revision, personId: auth.person.id, vehicles: clone(vehicles), profiles: clone(Object.fromEntries(Object.entries(fleet.profiles).filter(([vehicleId]) => ids.has(vehicleId)))),
    services: clone(fleet.services.filter(row => ids.has(row.vehicleId))), issues: clone(fleet.issues.filter(row => ids.has(row.vehicleId))), inspections: clone(fleet.inspections.filter(row => ids.has(row.vehicleId))),
    ...page, trips: page.trips.map(clone), pendingTrips: clone(gate.pendingTrips), gate,
    workOrders: (state.transport?.orders ?? []).filter(order => auth.allowedSiteIds.length && auth.person.driverId && order.driverId === auth.person.driverId && (!order.siteId || auth.allowedSiteIds.includes(order.siteId))).map(workOrderView),
    capabilities: { read: true, write: true, vehicleWrite: false, export: false, unblock: false } };
}

const maintenance = z.object({ intervalKm: positive.optional(), intervalHours: positive.optional(), intervalMonths: z.number().int().min(1).max(120).optional(), lastServiceKm: positive.optional(), lastServiceHours: positive.optional(), lastServiceDate: date.optional() }).strict();
const profileInput = z.object({ siteId: id.optional(), defaultDriverId: id.nullable().optional(), odometerKm: positive.optional(), odometerSource: z.enum(['manual', 'oem', 'virtual', 'unknown']).optional(), photoUrl: photo.optional(), notes: text.optional(), operatingHours: positive.optional(), maintenance: maintenance.optional() }).strict();
const serviceInput = z.object({ id: id.optional(), vehicleId: id, title: z.string().trim().min(1).max(200), dueDate: date.optional(), dueKm: positive.optional(), dueHours: positive.optional(), status: z.enum(['planned', 'completed']), workshop: z.string().trim().max(200).optional(), startAt: instant.optional(), endAt: instant.optional(), cost: positive.optional(), documentRefs: z.array(z.string().trim().min(1).max(500)).max(20).optional() }).strict();
const issueInput = z.object({ id: id.optional(), vehicleId: id, title: z.string().trim().min(1).max(200), description: text.optional(), severity: z.enum(['low', 'medium', 'high', 'critical']), status: z.enum(['open', 'in_progress', 'resolved']), photoUrls: photos.optional() }).strict();
const envelope = { requestId: id, expectedRevision: rev };
const commands = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('profile.save'), vehicleId: id, profile: profileInput }).strict(),
  z.object({ ...envelope, action: z.literal('service.save'), service: serviceInput }).strict(),
  z.object({ ...envelope, action: z.literal('issue.save'), issue: issueInput }).strict(),
  z.object({ ...envelope, action: z.literal('vehicle.block'), vehicleId: id, blocked: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ ...envelope, action: z.literal('inspection.save'), vehicleId: id, checks: z.array(z.object({ key: id, label: z.string().trim().max(200).optional(), ok: z.boolean() }).strict()).min(1).max(50), comment: text.optional(), photoUrls: photos.optional() }).strict(),
  z.object({ ...envelope, action: z.literal('driver.select'), vehicleId: id, personId: id }).strict(),
  z.object({ ...envelope, action: z.literal('trip.complete'), tripId: id, expectedTripRevision: rev, classification: z.enum(['private', 'business']), purpose: text.optional(), workOrderId: id.optional() }).strict(),
  z.object({ ...envelope, action: z.literal('trip.assign'), tripId: id, expectedTripRevision: rev, personId: id, reason: z.string().trim().min(5).max(1000) }).strict(),
]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function event(fleet, actorId, userId, action, vehicleId, details, audit, opts) {
  const row = { id: `fleet-event-${randomUUID()}`, action, vehicleId, at: clock(opts), actualUserId: actorId, effectiveUserId: userId, ...details };
  fleet.events.push(row); fleet.revision++; audit.push({ ...clone(row), domain: 'fleet' }); return row;
}
function completeTrip(state, command, auth, principal) {
  const trip = state.fleet.trips.find(value => value.id === command.tripId);
  if (!trip) fail('Resan finns inte.', 404, 'fleet_trip_missing');
  if (auth && !ownTrip(trip, auth.person.id)) fail('Du kan bara komplettera dina egna resor.', 403, 'fleet_trip_forbidden');
  if (!auth) requireVehicle(state, principal, trip.vehicleId);
  if (!trip.endAt) fail('Resan pågår och kan inte kompletteras än.', 409, 'fleet_trip_active');
  if (trip.revision !== command.expectedTripRevision) fail('Resan har ändrats. Läs in den senaste versionen.', 409, 'fleet_trip_revision');
  const next = { ...trip, classification: command.classification, revision: trip.revision + 1 };
  delete next.purpose; delete next.workOrderId;
  if (command.classification === 'business') {
    if (command.workOrderId) {
      const order = auth ? employeeOrder(state, auth, command.workOrderId) : state.transport?.orders?.find(order => order.id === command.workOrderId);
      if (!order || !auth && !siteVisible(principal, order.siteId)) fail('Arbetsordern är inte tillgänglig.', 403, 'fleet_order_forbidden');
      next.workOrderId = order.id;
    }
    if (command.purpose?.trim()) next.purpose = command.purpose.trim();
    if (!next.workOrderId && !hasPurpose(next.purpose)) fail('Ange ett konkret tjänstesyfte eller välj en tillgänglig arbetsorder.', 422, 'fleet_purpose_required');
  }
  state.fleet.trips[state.fleet.trips.indexOf(trip)] = next;
  return { trip: clone(next), vehicleId: trip.vehicleId, tripId: trip.id, personId: trip.personId };
}
function commandOperation(state, command, principal, auth, opts) {
  const fleet = state.fleet, at = clock(opts);
  if (command.action === 'trip.complete') return completeTrip(state, command, auth, principal);
  if (command.action === 'trip.assign') {
    const trip = fleet.trips.find(trip => trip.id === command.tripId);
    if (!trip) fail('Resan finns inte.', 404, 'fleet_trip_missing');
    requireVehicle(state, principal, trip.vehicleId);
    if (trip.revision !== command.expectedTripRevision) fail('Resan har ändrats. Läs in den senaste versionen.', 409, 'fleet_trip_revision');
    if (trip.manualDriverAssignment || trip.driverSource !== 'unknown' && !trip.driverConflict) fail('Resan har redan en identifierad förare. En vanlig tilldelning får inte skriva över den.', 409, 'fleet_driver_already_known');
    if (!trip.endAt) fail('En pågående resa kan inte få en historisk förartilldelning.', 409, 'fleet_trip_active');
    const person = personFor(state, command.personId), siteId = vehicleSite(state, trip.vehicleId);
    if (!personSitesVisible(principal, person) || !siteId || !person.siteIds?.includes(siteId)) fail('Personen saknar åtkomst till resans fordonsanläggning.', 403, 'fleet_person_forbidden');
    const manualDriverAssignment = { personId: person.id, reason: command.reason, at, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
      ...(trip.personId ? { previousPersonId: trip.personId } : {}), observedDriverSource: trip.driverSource };
    const next = { ...trip, personId: person.id, manualDriverAssignment, revision: trip.revision + 1 };
    fleet.trips[fleet.trips.indexOf(trip)] = next;
    return { trip: clone(next), vehicleId: trip.vehicleId, tripId: trip.id, personId: person.id, reason: command.reason };
  }
  const vehicleId = command.vehicleId ?? command.service?.vehicleId ?? command.issue?.vehicleId;
  if (auth) { if (!vehicleSite(state, vehicleId) || !employeeVehicles(state, auth).some(vehicle => vehicle.id === vehicleId)) fail('Välj ett av dina tillgängliga fordon med en registrerad anläggning.', 403, 'fleet_vehicle_forbidden'); }
  else requireVehicle(state, principal, vehicleId);
  const previousProfile = fleet.profiles[vehicleId] ?? { vehicleId, revision: 0 };
  if (command.action === 'profile.save') {
    const profile = command.profile, next = { ...previousProfile, ...clone(profile), vehicleId, revision: previousProfile.revision + 1, updatedAt: at };
    if (profile.siteId && !siteVisible(principal, profile.siteId)) fail('Du saknar åtkomst till den nya anläggningen.', 403, 'fleet_site_forbidden');
    if (profile.siteId && opts.siteCatalog && !opts.siteCatalog.some(site => site.id === profile.siteId && site.active !== false)) fail('Välj en registrerad aktiv anläggning.', 422, 'fleet_site_invalid');
    if (next.defaultDriverId) { const person = personFor(state, next.defaultDriverId); if (!personSitesVisible(principal, person) || next.siteId && !person.siteIds?.includes(next.siteId)) fail('Föraren saknar åtkomst till fordonets anläggning.', 403, 'fleet_person_forbidden'); }
    if (profile.defaultDriverId !== undefined && profile.defaultDriverId !== previousProfile.defaultDriverId) next.defaultDriverSetAt = at;
    if (profile.odometerKm !== undefined && !profile.odometerSource) fail('Ange källa för mätarställningen.', 422, 'fleet_odometer_source');
    fleet.profiles[vehicleId] = next; return { profile: clone(next), vehicleId };
  }
  if (command.action === 'vehicle.block') {
    if (!command.blocked && !fleetCapabilities(principal).unblock) fail('Separat behörighet krävs för att häva driftspärr.', 403, 'fleet_unblock_forbidden');
    const next = { ...previousProfile, blocked: command.blocked, blockReason: command.reason, blockedAt: command.blocked ? at : previousProfile.blockedAt, unblockedAt: command.blocked ? previousProfile.unblockedAt : at, revision: previousProfile.revision + 1, updatedAt: at };
    fleet.profiles[vehicleId] = next; return { profile: clone(next), vehicleId };
  }
  if (command.action === 'driver.select') {
    const person = personFor(state, command.personId); if (auth && person.id !== auth.person.id) fail('Du kan bara välja dig själv som förare.', 403, 'fleet_person_forbidden');
    if (!auth && !personSitesVisible(principal, person) || previousProfile.siteId && !person.siteIds?.includes(previousProfile.siteId)) fail('Föraren saknar åtkomst till fordonets anläggning.', 403, 'fleet_person_forbidden');
    const eligible = fleetVehicleEligible(state, vehicleId); if (!eligible.eligible) fail(eligible.issues.map(issue => issue.message).join(' '), 409, eligible.issues[0].code);
    const next = { ...previousProfile, nextDriver: { personId: person.id, source: auth ? 'app' : 'office', selectedAt: at }, revision: previousProfile.revision + 1, updatedAt: at };
    fleet.profiles[vehicleId] = next; return { profile: clone(next), vehicleId, personId: person.id };
  }
  if (command.action === 'inspection.save') {
    if (new Set(command.checks.map(check => check.key)).size !== command.checks.length) fail('Varje kontrollpunkt får bara anges en gång.', 422);
    const inspection = { id: `inspection-${randomUUID()}`, vehicleId, checks: clone(command.checks), ...(command.comment ? { comment: command.comment } : {}), photoUrls: command.photoUrls ?? [], ...(auth ? { personId: auth.person.id } : {}), at, revision: 1 };
    fleet.inspections.push(inspection); return { inspection: clone(inspection), vehicleId };
  }
  const type = command.action === 'service.save' ? 'service' : 'issue', input = command[type], rows = fleet[type === 'service' ? 'services' : 'issues'];
  const old = input.id ? rows.find(row => row.id === input.id) : null;
  if (input.id && !old) fail('Posten finns inte.', 404);
  if (old && old.vehicleId !== vehicleId) fail('En historikpost får inte flyttas mellan fordon.', 422);
  if (auth && (type !== 'issue' || old && old.personId !== auth.person.id || input.status !== 'open')) fail('Appen kan bara skicka en egen öppen felanmälan.', 403, 'fleet_issue_forbidden');
  if (type === 'service') {
    if (Boolean(input.startAt) !== Boolean(input.endAt) || input.startAt && Date.parse(input.endAt) <= Date.parse(input.startAt)) fail('Ange både start och slut för verkstadsreservationen, med slut efter start.', 422, 'fleet_service_time_invalid');
    const interval = serviceInterval(input);
    if (interval) {
      const other = fleet.services.find(service => service.id !== old?.id && service.vehicleId === vehicleId && serviceInterval(service) && overlaps(interval, serviceInterval(service)));
      if (other) fail('Fordonet har redan en överlappande planerad verkstadsreservation.', 409, 'fleet_service_conflict');
      for (const order of state.transport?.orders ?? []) if (order.vehicleId === vehicleId && ['booked', 'on_way'].includes(order.status)) {
        const plans = planningIntervals(order);
        if (!plans.length || plans.some(plan => overlaps(interval, plan))) fail(`Verkstadsreservationen krockar med ett befintligt uppdrag (${order.id}). Flytta uppdraget uttryckligen först.`, 409, 'fleet_service_booking_conflict');
      }
      for (const [orderId, plan] of Object.entries(state.transport?.preliminary ?? {})) if (plan.vehicleId === vehicleId) {
        const plans = planningIntervals(plan);
        if (!plans.length || plans.some(plan => overlaps(interval, plan))) fail(`Verkstadsreservationen krockar med en preliminär bokning (${orderId}).`, 409, 'fleet_service_booking_conflict');
      }
    }
  }
  const saved = { ...clone(input), id: old?.id ?? `${type}-${randomUUID()}`, revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? at, updatedAt: at, ...(auth ? { personId: auth.person.id } : {}) };
  if (old) rows[rows.indexOf(old)] = saved; else rows.push(saved);
  return { [type]: clone(saved), vehicleId };
}
function execute(state, principal, identity, value, audit, opts) {
  const auth = identity ? employeeIdentity(state, identity, opts) : null;
  if (!auth && !fleetCapabilities(principal).write) fail('Du saknar behörighet att ändra fordonsuppgifter.', 403, 'fleet_forbidden');
  const command = parse(commands, value);
  if (!auth && command.action === 'trip.complete') fail('Resor kan bara klassas eller ändras av den egna föraren i personalappen.', 403, 'fleet_trip_owner_required');
  if (auth && !['issue.save', 'inspection.save', 'driver.select', 'trip.complete'].includes(command.action)) fail('Åtgärden kräver kontorsbehörighet.', 403, 'fleet_forbidden');
  const fleet = state.fleet ?? emptyFleet(), actorId = auth?.actorId ?? principal.actor.id, userId = auth?.userId ?? principal.user.id, hash = fingerprint(command);
  const previous = fleet.requests.find(request => request.requestId === command.requestId && request.actualUserId === actorId && request.effectiveUserId === userId);
  const projection = target => auth ? employeeFleetProjection(target, identity, opts) : fleetProjection(target, principal, opts);
  if (previous) {
    if (previous.hash !== hash) fail('Begärans ID har redan använts för en annan åtgärd.', 409, 'fleet_idempotency_conflict');
    if (!auth) requireVehicle(state, principal, previous.saved.vehicleId);
    else if (command.action !== 'trip.complete' && !employeeVehicles(state, auth).some(vehicle => vehicle.id === previous.saved.vehicleId)) fail('Du saknar aktuell åtkomst till fordonet.', 403, 'fleet_vehicle_forbidden');
    const replaySaved = clone(previous.saved); if (!auth && replaySaved.trip) replaySaved.trip = officeTrip(replaySaved.trip);
    return { ...projection(state), saved: replaySaved, replayed: true };
  }
  if (command.expectedRevision !== fleet.revision) fail('Fordonsuppgifterna har ändrats. Läs in sidan innan du sparar.', 409, 'fleet_revision_conflict');
  if (auth && ['trip.complete', 'driver.select'].includes(command.action) && !fleetTripGate(state, auth.person).safeToInteract) fail('En egen resa pågår. Stanna säkert innan du använder resefunktionerna.', 409, 'fleet_trip_active');
  if (auth && command.action === 'driver.select' && fleetTripGate(state, auth.person).blocked) fail('Komplettera dina avslutade resor före nästa förarval.', 423, 'fleet_trip_completion_required');
  const nextState = { ...state, fleet: clone(fleet) }, saved = commandOperation(nextState, command, principal, auth, opts), next = nextState.fleet;
  const details = { ...(saved.tripId ? { tripId: saved.tripId } : {}), ...(saved.personId ? { personId: saved.personId } : {}), ...(saved.reason ? { reason: saved.reason } : {}),
    ...(command.action === 'trip.assign' ? { driverAssignment: clone(saved.trip.manualDriverAssignment) } : {}), text: saved.reason ? `${command.action}: ${saved.reason}` : command.action };
  const auditRows = []; event(next, actorId, userId, command.action, saved.vehicleId, details, auditRows, opts);
  next.requests.push({ requestId: command.requestId, actualUserId: actorId, effectiveUserId: userId, hash, saved: clone(saved), at: clock(opts) });
  state.fleet = next; audit.push(...auditRows);
  const responseSaved = clone(saved); if (!auth && responseSaved.trip) responseSaved.trip = officeTrip(responseSaved.trip);
  return { ...projection(state), saved: responseSaved };
}
export function fleetCommand(state, principal, command, audit = [], opts = {}) { return execute(state, principal, null, command, audit, opts); }
export function employeeFleetCommand(state, identity, command, audit = [], opts = {}) { return execute(state, null, identity, command, audit, opts); }

const tripInput = z.object({ id, vehicleId: id, personId: id.optional(), driverSource: z.enum(['default', 'app', 'office', 'panel', 'unknown']), driverConflict: z.boolean().optional(), startAt: instant, endAt: instant.optional(), distanceKm: positive.optional(), startOdometerKm: positive.optional(), endOdometerKm: positive.optional(), fromLabel: z.string().trim().max(300).optional(), toLabel: z.string().trim().max(300).optional(), classification: z.enum(['private', 'business']).optional(), purpose: text.optional(), workOrderId: id.optional(), revision: rev.optional(), quality: z.enum(['good', 'sensor_gap', 'review']).optional(), source: z.enum(['simulator', 'device']), deviceId: id.optional(), bindingId: id.optional(), receivedAt: instant.optional(), sourceEventId: id.optional(), positions: z.array(z.object({ at: instant, lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict()).max(5000).optional() }).strict();
/** Trusted receiver capability, never an employee command. Event identity and
 * the first observed driver/vehicle attribution survive updates and retries. */
export function ingestFleetTrip(state, input, audit = [], opts = {}) {
  const incoming = parse(tripInput, input); vehicleFor(state, incoming.vehicleId);
  if (incoming.endAt && Date.parse(incoming.endAt) < Date.parse(incoming.startAt)) fail('Resans slut föregår dess start.', 422, 'fleet_trip_time');
  if (incoming.startOdometerKm !== undefined && incoming.endOdometerKm !== undefined && incoming.endOdometerKm < incoming.startOdometerKm) fail('Mätarställningen går bakåt.', 422, 'fleet_trip_odometer');
  const fleet = state.fleet ?? emptyFleet(), old = fleet.trips.find(trip => trip.id === incoming.id), profile = fleet.profiles[incoming.vehicleId];
  if (old && (old.vehicleId !== incoming.vehicleId || old.startAt !== incoming.startAt || old.source !== incoming.source || old.personId && incoming.personId && old.personId !== incoming.personId && incoming.personId !== old.manualDriverAssignment?.previousPersonId ||
    old.bindingId && incoming.bindingId && old.bindingId !== incoming.bindingId || old.deviceId && incoming.deviceId && old.deviceId !== incoming.deviceId)) fail('En mottagen resa får inte byta historiskt fordon, koppling, start eller förare.', 409, 'fleet_trip_identity');
  let next = { ...incoming, revision: old?.revision ?? 0 };
  if (old) { next = { ...old, ...incoming, driverSource: old.driverSource, revision: old.revision }; if (old.personId) next.personId = old.personId; else delete next.personId; for (const key of ['classification', 'purpose', 'workOrderId']) { if (old[key] !== undefined) next[key] = old[key]; else delete next[key]; } }
  else if (!incoming.personId && incoming.driverSource !== 'unknown') {
    const selected = profile?.nextDriver && Date.parse(profile.nextDriver.selectedAt) <= Date.parse(incoming.startAt) ? profile.nextDriver : undefined;
    const defaultId = !profile?.defaultDriverSetAt || Date.parse(profile.defaultDriverSetAt) <= Date.parse(incoming.startAt) ? profile?.defaultDriverId : undefined, personId = selected?.personId ?? defaultId;
    const person = state.personnel?.people?.find(person => person.id === personId && person.active !== false);
    if (person) { next.personId = person.id; next.driverSource = selected?.source ?? 'default'; }
    else { delete next.personId; next.driverSource = 'unknown'; }
  }
  if (next.personId && !state.personnel?.people?.some(person => person.id === next.personId)) fail('Resans förare saknar en registrerad personkoppling.', 422, 'fleet_person_missing');
  if (next.driverSource === 'unknown' && !next.manualDriverAssignment) delete next.personId;
  if (next.classification === 'private') { delete next.purpose; delete next.workOrderId; }
  if (next.classification === 'business' && !hasPurpose(next.purpose) && !state.transport?.orders?.some(order => order.id === next.workOrderId)) fail('En tjänsteresa kräver ett konkret syfte eller en befintlig arbetsorder.', 422, 'fleet_purpose_required');
  if (next.startOdometerKm !== undefined && next.endOdometerKm !== undefined && next.endOdometerKm < next.startOdometerKm) fail('Mätarställningen går bakåt.', 422, 'fleet_trip_odometer');
  if (old?.endAt && incoming.endAt && old.endAt !== incoming.endAt) fail('Ett observerat resslut får inte skrivas över.', 409, 'fleet_trip_time');
  if (isDeepStrictEqual(next, old)) return clone(old);
  next.revision = (old?.revision ?? 0) + 1;
  const updated = clone(fleet);
  if (old) updated.trips[updated.trips.findIndex(trip => trip.id === old.id)] = next; else updated.trips.push(next);
  if (!old && profile?.nextDriver && Date.parse(profile.nextDriver.selectedAt) <= Date.parse(incoming.startAt) && next.personId === profile.nextDriver.personId) { delete updated.profiles[incoming.vehicleId].nextDriver; updated.profiles[incoming.vehicleId].revision = (profile.revision ?? 0) + 1; }
  const auditRows = []; event(updated, 'service:telematics', 'service:telematics', old ? 'trip.updated' : 'trip.received', next.vehicleId, { tripId: next.id, ...(next.personId ? { personId: next.personId } : {}), text: next.source }, auditRows, opts);
  state.fleet = updated; audit.push(...auditRows); return clone(next);
}
