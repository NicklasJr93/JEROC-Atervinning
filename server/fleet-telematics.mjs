import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PricingError } from './pricing.mjs';
import { ensureFleet, fleetCapabilities, ingestFleetTrip } from './fleet.mjs';
import { projectTrips } from './telematics/trips.mjs';

const id = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_:-]+$/);
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const request = { expectedRevision: revision, requestId: id };
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('device.link'), deviceId: id, vehicleId: id, ...request }).strict(),
  z.object({ action: z.literal('device.transfer.start'), deviceId: id, toVehicleId: id, ...request }).strict(),
  z.object({ action: z.literal('device.transfer.confirm'), transferId: id, ...request }).strict(),
  z.object({ action: z.literal('device.transfer.restore'), transferId: id, ...request }).strict(),
  z.object({ action: z.literal('device.transfer.cutoff'), deviceId: id, toVehicleId: id,
    cutAt: instant, reason: z.string().trim().min(5).max(1000), ...request }).strict(),
]);
const assignmentSchema = z.object({ id, name: z.string().trim().min(1).max(200), organisationId: id,
  source: z.enum(['simulator', 'device']), active: z.boolean().default(true) }).strict();
const recordSchema = z.object({
  id, at: instant, ignition: z.boolean().optional(), movement: z.boolean().optional(),
  odometerMeters: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lat: z.number().finite().min(-90).max(90).optional(), lng: z.number().finite().min(-180).max(180).optional(),
  speedKmh: z.number().finite().min(0).max(500).optional(), rpm: z.number().finite().min(0).max(30000).optional(),
  fuelPercent: z.number().finite().min(0).max(100).optional(), coolantC: z.number().finite().min(-128).max(300).optional(),
  batteryVolts: z.number().finite().min(0).max(1000).optional(),
}).strict().refine(value => (value.lat === undefined) === (value.lng === undefined), { message: 'Ange båda koordinaterna.' });
const batchSchema = z.object({ deviceId: id, source: z.enum(['simulator', 'device']),
  records: z.array(recordSchema).min(1).max(2000) }).strict();
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 409, code = 'fleet_telematics_conflict') => {
  const error = new PricingError(message, status); error.code = code; throw error;
};
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail('Enhetsuppgifterna innehåller ogiltiga eller otillåtna fält.', 422, 'fleet_telematics_invalid');
  return result.data;
};
const time = opts => {
  const at = new Date(typeof opts?.now === 'function' ? opts.now() : opts?.now ?? Date.now());
  if (!Number.isFinite(at.getTime())) fail('Serverns tid kunde inte bestämmas.', 503);
  return at.toISOString();
};

/** organisationId is supplied by the selected tenant repository, never by a
 * browser command or tracker packet. Provisioning binds this aggregate once. */
function organisation(state, opts) {
  const organisationId = parse(id, opts?.organisationId);
  if (state.metadata?.organisation?.id && state.metadata.organisation.id !== organisationId
    || state.fleet?.telematicsOrganisationId && state.fleet.telematicsOrganisationId !== organisationId)
    fail('Enheten tillhör ett annat bolag.', 403, 'fleet_device_forbidden');
  return organisationId;
}

function workingState(state, opts) {
  const next = { ...state, fleet: copy(state.fleet ?? {}) };
  ensureFleet(next);
  const org = organisation(next, opts);
  next.fleet.telematicsOrganisationId = org;
  for (const key of ['devices', 'bindings', 'transfers', 'telemetryEvents', 'telemetryQuarantine', 'deviceRequests'])
    next.fleet[key] ??= [];
  return next;
}
const principals = principal => [principal?.actor, principal?.user];
const scoped = principal => principals(principal).some(user => Array.isArray(user?.siteIds));
function vehicleAllowed(state, principal, vehicleId) {
  const profile = state.fleet?.profiles?.[vehicleId];
  return principals(principal).every(user => Boolean(user?.id) && user.active !== false &&
    (!Array.isArray(user.siteIds) || Boolean(profile?.siteId) && user.siteIds.includes(profile.siteId)));
}
const activeBinding = (fleet, deviceId) => fleet.bindings.find(value => value.deviceId === deviceId && value.endAt === null);
const pendingTransfer = (fleet, deviceId) => fleet.transfers.find(value => value.deviceId === deviceId && value.status === 'pending');
function vehicleFree(fleet, vehicleId, ignoreTransferId) {
  return !fleet.bindings.some(value => value.vehicleId === vehicleId && value.endAt === null)
    && !fleet.transfers.some(value => value.id !== ignoreTransferId && value.toVehicleId === vehicleId && value.status === 'pending');
}
function motorReasons(device, now, after) {
  const reasons = [];
  if (device.ignition !== false) reasons.push(device.ignition === true ? 'Motorn är påslagen.' : 'Motorns status är okänd.');
  if (device.tripState !== 'idle') reasons.push(device.tripState === 'active' ? 'En resa pågår.' : 'Resans status är okänd.');
  if (!device.observationAt || Date.parse(now) - Date.parse(device.observationAt) > 5 * 60 * 1000
    || Date.parse(device.observationAt) > Date.parse(now)) reasons.push('En färsk kontakt med avstängd motor behövs.');
  if (after && (!device.observationAt || device.observationAt < after))
    reasons.push('Invänta en ny kontakt med avstängd motor efter att flytten påbörjades.');
  return reasons;
}
function checkMotor(device, now, after) {
  const reasons = motorReasons(device, now, after);
  if (reasons.length) fail(reasons.join(' '), 409, 'fleet_device_motor_unknown');
}
function deviceFacts(device, now) {
  return { lastContactAt: device.lastContactAt ?? null,
    ignition: device.ignition === true ? 'on' : device.ignition === false ? 'off' : 'unknown',
    tripState: device.tripState ?? 'unknown',
    contactStatus: !device.lastContactAt ? 'never' : Date.parse(now) - Date.parse(device.lastContactAt) > 5 * 60 * 1000 ? 'stale' : 'recent' };
}
function businessPosition(device, latestEvents, tripsById, allowedVehicle, bindingId) {
  const latest = latestEvents.get(device.lastTelemetryKey), trip = latest?.tripId && tripsById.get(latest.tripId);
  if (!bindingId || latest?.bindingId !== bindingId || trip?.classification !== 'business'
    || !allowedVehicle(trip.vehicleId) || latest.lat === undefined) return {};
  return { latestPosition: { at: latest.at, lat: latest.lat, lng: latest.lng },
    sensors: Object.fromEntries(['speedKmh', 'rpm', 'fuelPercent', 'coolantC', 'batteryVolts']
      .filter(key => latest[key] !== undefined).map(key => [key, latest[key]])) };
}
function publicDevice(state, principal, device, now, latestEvents, tripsById, reviewCounts) {
  const fleet = state.fleet, binding = activeBinding(fleet, device.id), transfer = pendingTransfer(fleet, device.id);
  const permitted = !binding || vehicleAllowed(state, principal, binding.vehicleId);
  // An unbound device has no site yet; sharing it across restricted sites would
  // expose other branches' equipment and allow taking their reserved hardware.
  if (!permitted || transfer && (![transfer.fromVehicleId, transfer.toVehicleId].every(value => vehicleAllowed(state, principal, value)))
    || !binding && !transfer && scoped(principal)) return null;
  const blockedReasons = motorReasons(device, now, transfer?.startedAt);
  const write = fleetCapabilities(principal).write;
  const status = !device.active ? 'inactive' : transfer ? 'transferring' : binding ? 'linked' : 'available';
  const result = {
    id: device.id, name: device.name, source: device.source, status, revision: device.revision,
    vehicleId: binding?.vehicleId ?? null, transferId: transfer?.id ?? null, assignedAt: device.assignedAt,
    ...deviceFacts(device, now),
    reviewCount: reviewCounts.get(device.id) ?? 0,
    canLink: write && status === 'available' && !blockedReasons.length,
    canTransfer: write && status === 'linked' && !blockedReasons.length,
    blockedReasons,
  };
  // Coordinates/sensors are private domain data. Only a currently classified
  // business trip may expose a point; neither an unknown trip nor a cached
  // previous driver's position grants office map access.
  return { ...result, ...businessPosition(device, latestEvents, tripsById, vehicleId => vehicleAllowed(state, principal, vehicleId), binding?.id) };
}

/** Restricted self-service read. allowedVehicleIds comes exclusively from the
 * server's own employeeFleetProjection, never from a browser query/command.
 * It exposes contact facts only for a currently linked own vehicle. */
export function fleetEmployeeTelematicsProjection(state, allowedVehicleIds, opts = {}) {
  const org = organisation(state, opts), now = time(opts), fleet = state.fleet;
  if (!fleet || !Array.isArray(allowedVehicleIds)) return { devices: [] };
  const allowed = new Set(allowedVehicleIds), bindings = new Map((fleet.bindings ?? [])
    .filter(value => value.organisationId === org && value.endAt === null && allowed.has(value.vehicleId))
    .map(value => [value.deviceId, value]));
  const latestEvents = new Map((fleet.telemetryEvents ?? []).map(value => [value.key, value]));
  const tripsById = new Map((fleet.trips ?? []).map(value => [value.id, value]));
  return { devices: (fleet.devices ?? []).filter(device => device.organisationId === org && bindings.has(device.id)).map(device => ({
    id: device.id, name: device.name, source: device.source, status: device.active ? 'linked' : 'inactive',
    vehicleId: bindings.get(device.id).vehicleId, ...deviceFacts(device, now),
    ...businessPosition(device, latestEvents, tripsById, vehicleId => allowed.has(vehicleId), bindings.get(device.id).id),
  })) };
}

/** Public, privacy-filtered tenant device administration projection. A read
 * never normalises/persists the aggregate or returns raw telemetry/gap records. */
export function fleetTelematicsProjection(state, principal, opts = {}) {
  const capabilities = fleetCapabilities(principal);
  if (!capabilities.read) fail('Du saknar behörighet att läsa fordonsenheter.', 403, 'fleet_read_required');
  const org = organisation(state, opts), now = time(opts);
  const fleet = { devices: [], bindings: [], transfers: [], telemetryEvents: [], trips: [], ...state.fleet };
  const view = { ...state, fleet };
  const latestEvents = new Map(fleet.telemetryEvents.map(value => [value.key, value]));
  const tripsById = new Map(fleet.trips.map(value => [value.id, value]));
  const reviewCounts = new Map();
  for (const row of fleet.telemetryQuarantine ?? []) if (row.reason !== 'unbound')
    reviewCounts.set(row.deviceId, (reviewCounts.get(row.deviceId) ?? 0) + 1);
  const devices = fleet.devices.filter(value => value.organisationId === org)
    .map(value => publicDevice(view, principal, value, now, latestEvents, tripsById, reviewCounts)).filter(Boolean);
  const allowed = new Set(devices.map(value => value.id));
  return { revision: fleet.revision ?? 0, devices,
    bindings: fleet.bindings.filter(value => value.organisationId === org && allowed.has(value.deviceId) && vehicleAllowed(state, principal, value.vehicleId))
      .map(value => ({ id: value.id, deviceId: value.deviceId, vehicleId: value.vehicleId, startAt: value.startAt, endAt: value.endAt,
        source: value.source, baseline: { source: value.baseline?.source ?? 'unknown', odometerKm: null },
        createdBy: value.createdBy ?? null, closedBy: value.closedBy ?? null })),
    transfers: fleet.transfers.filter(value => value.organisationId === org && allowed.has(value.deviceId)
      && [value.fromVehicleId, value.toVehicleId].every(vehicleId => vehicleAllowed(state, principal, vehicleId)))
      .map(value => ({ id: value.id, deviceId: value.deviceId, fromVehicleId: value.fromVehicleId, toVehicleId: value.toVehicleId,
        startedAt: value.startedAt, status: value.status, completedAt: value.completedAt, revision: value.revision,
        ...(value.manual ? { manual: true, reason: value.reason } : {}) })),
    capabilities: { read: capabilities.read, manage: capabilities.write },
  };
}

function auditEvent(fleet, principal, action, fields, now, audit) {
  const event = { id: `fleet-device-event-${randomUUID()}`, action, at: now,
    actualUserId: principal?.actor?.id ?? null, effectiveUserId: principal?.user?.id ?? null, ...fields };
  fleet.events ??= []; fleet.events.push(event);
  audit.push({ ...copy(event), domain: 'fleet' });
  return event;
}
function newBinding(fleet, device, vehicleId, now, principal) {
  const binding = { id: `binding-${randomUUID()}`, organisationId: device.organisationId, deviceId: device.id,
    vehicleId, startAt: now, endAt: null, source: device.source,
    baseline: { source: 'unknown', odometerKm: null, deviceOdometerMeters: null },
    createdBy: principal.user.id, actualUserId: principal.actor.id, closedBy: null };
  fleet.bindings.push(binding);
  return binding;
}
function targetVehicle(state, principal, vehicleId) {
  const vehicle = state.transport?.vehicles?.find(value => value.id === vehicleId);
  if (!vehicle || !vehicleAllowed(state, principal, vehicleId)) fail('Fordonet är inte tillgängligt för ditt konto.', 403, 'fleet_vehicle_forbidden');
  if (vehicle.active === false) fail('Välj ett aktivt fordon.', 422, 'fleet_vehicle_inactive');
  return vehicle;
}

/** Invoked inside the tenant aggregate transaction. Work on a private fleet
 * copy so schema, CAS, scope or reservation failures cannot partially close a
 * binding even when a caller catches the error. */
export function fleetTelematicsCommand(state, principal, value, transactionAudit = [], opts = {}) {
  if (!fleetCapabilities(principal).write) fail('Du saknar behörighet att koppla fordonsenheter.', 403, 'fleet_write_required');
  const command = parse(commandSchema, value), next = workingState(state, opts), fleet = next.fleet, now = time(opts);
  const org = organisation(next, opts), commandHash = hash(command);
  const previous = fleet.deviceRequests.find(item => item.requestId === command.requestId);
  if (previous) {
    if (previous.commandHash !== commandHash || previous.actualUserId !== principal.actor.id || previous.effectiveUserId !== principal.user.id)
      fail('Begäran har redan använts för en annan enhetsändring.', 409, 'idempotency_conflict');
    // Recheck current access before disclosing an old result after revocation.
    const result = fleetTelematicsProjection(next, principal, opts);
    if (!result.devices.some(device => device.id === previous.deviceId)) fail('Enheten är inte tillgänglig för ditt konto.', 403);
    return { ...result, savedDeviceId: previous.deviceId, savedTransferId: previous.transferId ?? null };
  }
  const transfer = command.transferId ? fleet.transfers.find(item => item.id === command.transferId && item.organisationId === org) : null;
  const device = fleet.devices.find(item => item.id === (command.deviceId ?? transfer?.deviceId) && item.organisationId === org);
  if (!device || !device.active && command.action !== 'device.transfer.cutoff')
    fail('Enheten är inte tillgänglig eller aktiverad för bolaget.', 404, 'fleet_device_not_found');
  const current = activeBinding(fleet, device.id), pending = pendingTransfer(fleet, device.id);
  if (current && !vehicleAllowed(next, principal, current.vehicleId)
    || pending && ![pending.fromVehicleId, pending.toVehicleId].every(vehicleId => vehicleAllowed(next, principal, vehicleId))
    || !current && !pending && scoped(principal)) fail('Enheten är inte tillgänglig för ditt konto.', 403, 'fleet_device_forbidden');
  if (command.expectedRevision !== (transfer?.revision ?? device.revision))
    fail('Enhetskopplingen har ändrats. Uppdatera sidan.', 409, 'revision_conflict');
  const audit = []; let savedTransferId = null;
  if (command.action === 'device.link') {
    targetVehicle(next, principal, command.vehicleId);
    if (current || pending || !vehicleFree(fleet, command.vehicleId)) fail('Enheten eller fordonet är redan kopplat eller reserverat.');
    checkMotor(device, now);
    const binding = newBinding(fleet, device, command.vehicleId, now, principal);
    auditEvent(fleet, principal, command.action, { deviceId: device.id, vehicleId: command.vehicleId, bindingId: binding.id }, now, audit);
  } else if (['device.transfer.start', 'device.transfer.cutoff'].includes(command.action)) {
    if (!current || pending) fail('Enheten saknar en fri, aktiv koppling.');
    targetVehicle(next, principal, command.toVehicleId);
    if (command.toVehicleId === current.vehicleId || !vehicleFree(fleet, command.toVehicleId)) fail('Det nya fordonet är redan kopplat eller reserverat.');
    const manual = command.action === 'device.transfer.cutoff';
    if (manual && (!opts.allowManualCutoff || scoped(principal))) fail('Manuell bryttid kräver särskild behörighet.', 403);
    if (!manual) checkMotor(device, now);
    const cutAt = manual ? new Date(command.cutAt).toISOString() : now;
    if (cutAt < current.startAt || cutAt > now) fail('Bryttiden måste ligga inom den pågående kopplingen och får inte vara i framtiden.', 422);
    current.endAt = cutAt; current.closedBy = principal.user.id;
    if (manual) current.manualCutoff = { at: cutAt, reason: command.reason, observedEnd: false };
    const saved = { id: `transfer-${randomUUID()}`, organisationId: org, deviceId: device.id,
      fromVehicleId: current.vehicleId, toVehicleId: command.toVehicleId, fromBindingId: current.id,
      startedAt: cutAt, recordedAt: now, completedAt: null, status: 'pending', revision: 1,
      startedBy: principal.user.id, actualUserId: principal.actor.id,
      ...(manual ? { manual: true, reason: command.reason } : {}) };
    fleet.transfers.push(saved); savedTransferId = saved.id;
    if (manual) {
      device.tripState = 'unknown'; device.ignition = null; device.observationAt = null;
      for (const trip of fleet.trips.filter(item => item.bindingId === current.id && (!item.endAt || item.endAt > cutAt))) {
        trip.quality = 'review'; trip.manualCutoff = { at: cutAt, reason: command.reason, observedEnd: false };
      }
      for (const record of fleet.telemetryEvents.filter(item => item.bindingId === current.id && item.at >= cutAt))
        quarantine(fleet, record, 'manual_cutoff');
    }
    auditEvent(fleet, principal, command.action, { deviceId: device.id, transferId: saved.id,
      fromVehicleId: current.vehicleId, toVehicleId: command.toVehicleId, ...(manual ? { cutAt, reason: command.reason } : {}) }, now, audit);
  } else {
    if (!transfer || transfer.status !== 'pending' || current) fail('Flytten är redan avslutad eller har ändrats.');
    checkMotor(device, now, transfer.recordedAt ?? transfer.startedAt);
    const vehicleId = command.action === 'device.transfer.restore' ? transfer.fromVehicleId : transfer.toVehicleId;
    targetVehicle(next, principal, vehicleId);
    if (!vehicleFree(fleet, vehicleId, transfer.id)) fail('Fordonet har kopplats eller reserverats av någon annan.');
    newBinding(fleet, device, vehicleId, now, principal);
    transfer.status = command.action === 'device.transfer.restore' ? 'restored' : 'confirmed';
    transfer.completedAt = now; transfer.completedBy = principal.user.id; transfer.actualCompletedBy = principal.actor.id;
    transfer.revision++; savedTransferId = transfer.id;
    auditEvent(fleet, principal, command.action, { deviceId: device.id, transferId: transfer.id, vehicleId }, now, audit);
  }
  device.revision++; device.updatedAt = now; fleet.revision++;
  fleet.deviceRequests.push({ requestId: command.requestId, commandHash, deviceId: device.id, transferId: savedTransferId,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id, at: now });
  const result = fleetTelematicsProjection(next, principal, opts);
  state.fleet = fleet; transactionAudit.push(...audit);
  return { ...result, savedDeviceId: device.id, savedTransferId };
}

/** Central provisioning only. IMEI/ID identifies a pre-authenticated device;
 * neither an arbitrary browser nor a decoded packet can provision its company. */
export function applyFleetDeviceAssignment(state, value, opts = {}) {
  const assignment = parse(assignmentSchema, value), org = organisation(state, opts);
  if (assignment.organisationId !== org) fail('Enheten tillhör ett annat bolag.', 403, 'fleet_device_forbidden');
  const next = workingState(state, opts), fleet = next.fleet, now = time(opts);
  let device = fleet.devices.find(item => item.id === assignment.id);
  if (device) {
    if (device.organisationId !== org || device.source !== assignment.source)
      fail('En historisk enhet får inte byta bolag eller datakälla genom en fordonskoppling.', 409);
    if (device.name === assignment.name && device.active === assignment.active) return copy(device);
    Object.assign(device, { name: assignment.name, active: assignment.active, updatedAt: now, revision: device.revision + 1 });
  } else {
    device = { ...assignment, revision: 1, assignedAt: now, updatedAt: now, lastContactAt: null,
      lastEventAt: null, observationAt: null, ignition: null, tripState: 'unknown' };
    fleet.devices.push(device);
  }
  fleet.revision++; state.fleet = fleet;
  return copy(device);
}

function quarantine(fleet, record, reason) {
  const key = `${record.key}:${reason}`;
  if (!fleet.telemetryQuarantine.some(item => item.id === key)) fleet.telemetryQuarantine.push({ id: key,
    deviceId: record.deviceId, eventId: record.id, at: record.at, receivedAt: record.receivedAt,
    bindingId: record.bindingId ?? null, reason });
  record.quarantined = true;
}
const overlaps = (a, b) => a.startAt < (b.endAt ?? '9999') && b.startAt < (a.endAt ?? '9999');
function buildTrips(state, binding, now, audit) {
  const fleet = state.fleet;
  const events = fleet.telemetryEvents.filter(value => value.bindingId === binding.id && !value.quarantined)
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  const projected = projectTrips(events.map(value => ({ id: value.id, at: value.at, source: 'tracker',
    ...(value.ignition !== undefined ? { ignition: value.ignition } : {}),
    ...(value.movement !== undefined ? { movement: value.movement } : {}),
    ...(value.odometerMeters !== undefined ? { odometerMeters: value.odometerMeters } : {}) })));
  const byId = new Map(events.map(value => [value.id, value]));
  for (const projectedTrip of projected) {
    const start = byId.get(projectedTrip.startRecordId), end = byId.get(projectedTrip.endRecordId);
    const tripId = `trip-${hash([binding.id, start.id]).slice(0, 40)}`;
    const existing = fleet.trips.find(value => value.id === tripId);
    const span = { startAt: projectedTrip.startedAt, endAt: projectedTrip.endedAt ?? undefined };
    if (fleet.trips.some(value => value.bindingId === binding.id && value.id !== tripId && overlaps(value, span))) {
      quarantine(fleet, start, 'late_trip_overlap');
      continue;
    }
    const positions = events.filter(value => value.at >= span.startAt && (!span.endAt || value.at <= span.endAt) && value.lat !== undefined)
      .map(value => ({ at: value.at, lat: value.lat, lng: value.lng }));
    if (existing?.endAt && existing.endAt !== span.endAt) {
      quarantine(fleet, end ?? start, 'late_end_conflict');
      continue;
    }
    const freshStart = Date.parse(start.receivedAt) - Date.parse(start.at) <= 5 * 60 * 1000;
    const profile = fleet.profiles[binding.vehicleId];
    const selection = profile?.nextDriver?.selectedAt <= start.at ? profile.nextDriver : null;
    const defaultPersonId = !profile?.defaultDriverSetAt || profile.defaultDriverSetAt <= start.at ? profile?.defaultDriverId : null;
    const selectedPersonId = freshStart ? selection?.personId ?? defaultPersonId : null;
    const person = state.personnel?.people?.find(value => value.id === selectedPersonId && value.active !== false);
    const trip = { id: tripId, vehicleId: binding.vehicleId, deviceId: binding.deviceId, bindingId: binding.id,
      ...span, driverSource: existing?.driverSource ?? (person ? selection ? selection.source : 'default' : 'unknown'),
      ...(existing?.personId ? { personId: existing.personId } : {}),
      ...(!existing && person ? { personId: person.id } : {}),
      source: binding.source, sourceEventId: start.id, receivedAt: existing?.receivedAt ?? now, positions,
      quality: projectedTrip.needsReview || existing?.manualCutoff ? 'review' : 'good',
      ...(projectedTrip.distanceMeters !== null ? { distanceKm: projectedTrip.distanceMeters / 1000 } : {}),
    };
    // Keep our device/event references while the core atomically replaces its
    // own fleet copy. Only trip/profile/audit collections are changed there.
    const tripState = { ...state, fleet: copy(fleet) };
    ingestFleetTrip(tripState, trip, audit, { now });
    for (const key of ['trips', 'profiles', 'events', 'revision']) fleet[key] = tripState.fleet[key];
    for (const event of events.filter(value => value.at >= span.startAt && (!span.endAt || value.at <= span.endAt))) event.tripId = tripId;
    // The baseline is relative to this binding. Its virtual absolute value is
    // never written to the new vehicle's odometer or included in the public DTO.
    if (binding.baseline.source === 'unknown' && start.odometerMeters !== undefined)
      binding.baseline = { source: 'virtual_delta', odometerKm: null, deviceOdometerMeters: start.odometerMeters };
    if (end && end.odometerMeters < start.odometerMeters) quarantine(fleet, end, 'odometer_reset');
  }
}

/** Trusted receiver adapter only. Caller proves device authentication and
 * selects its tenant before entering this function; payload cannot name a
 * company, vehicle, driver or trip classification. Both clocks are preserved. */
export function ingestFleetTelemetry(state, value, opts = {}) {
  const batch = parse(batchSchema, value), next = workingState(state, opts), fleet = next.fleet;
  const org = organisation(next, opts), now = time(opts), device = fleet.devices.find(item => item.id === batch.deviceId && item.organisationId === org);
  if (!device || !device.active || device.source !== batch.source)
    fail('Enheten är inte aktiverad för den här mottagaren.', 403, 'fleet_device_forbidden');
  const seen = new Map(fleet.telemetryEvents.filter(item => item.deviceId === device.id).map(item => [item.id, item]));
  const touched = new Set(), acceptedKeys = new Set(), audit = []; let accepted = 0, duplicates = 0;
  const records = batch.records.map(raw => ({ ...raw, at: new Date(raw.at).toISOString() }))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  for (const normalized of records) {
    const eventHash = hash(normalized), previous = seen.get(normalized.id);
    if (previous) {
      if (previous.eventHash !== eventHash) fail('Samma telemetri-ID innehåller olika uppgifter.', 409, 'fleet_event_conflict');
      duplicates++; continue;
    }
    const record = { ...normalized, key: hash([device.id, normalized.id]), deviceId: device.id, organisationId: org,
      source: batch.source, receivedAt: now, eventHash, bindingId: null };
    fleet.telemetryEvents.push(record); seen.set(record.id, record); acceptedKeys.add(record.key); accepted++;
    if (record.at < device.assignedAt) quarantine(fleet, record, 'before_assignment');
    else if (Date.parse(record.at) > Date.parse(now) + 60 * 1000) {
      quarantine(fleet, record, 'clock_skew');
      device.ignition = null; device.tripState = 'unknown'; device.observationAt = null;
    }
    else {
      const matches = fleet.bindings.filter(binding => binding.deviceId === device.id && binding.startAt <= record.at && (!binding.endAt || record.at < binding.endAt));
      const gap = fleet.transfers.find(transfer => transfer.deviceId === device.id && transfer.startedAt <= record.at
        && (!transfer.completedAt || record.at < transfer.completedAt));
      if (gap) quarantine(fleet, record, 'transfer_gap');
      else if (matches.length === 1) {
        record.bindingId = matches[0].id;
        if (record.at === matches[0].startAt || fleet.bindings.some(binding => binding.deviceId === device.id && binding.endAt === record.at))
          quarantine(fleet, record, 'binding_boundary');
        else if (matches[0].manualCutoff && record.at >= matches[0].manualCutoff.at) quarantine(fleet, record, 'manual_cutoff');
        else touched.add(matches[0].id);
      } else quarantine(fleet, record, matches.length ? 'binding_ambiguous' : 'unbound');
      // Contact received and a trustworthy current ignition observation are
      // different facts. Buffered old or clock-skewed packets never assert idle.
      if ((!device.lastEventAt || record.at >= device.lastEventAt) && Date.parse(record.at) <= Date.parse(now)) {
        device.lastEventAt = record.at; device.lastTelemetryKey = record.key;
        if (record.ignition !== undefined) {
          device.ignition = record.ignition; device.observationAt = record.at;
          device.tripState = record.ignition ? 'active' : record.movement ? 'unknown' : 'idle';
        }
        if (record.movement === true && record.ignition === undefined) device.tripState = 'unknown';
      }
    }
    device.lastContactAt = now;
  }
  const latestSignals = fleet.telemetryEvents.filter(record => record.deviceId === device.id && record.at === device.lastEventAt
    && typeof record.ignition === 'boolean');
  if (latestSignals.some(record => record.ignition) && latestSignals.some(record => !record.ignition)) {
    device.ignition = null; device.tripState = 'unknown'; device.observationAt = null;
    for (const record of latestSignals) quarantine(fleet, record, 'ignition_ambiguous');
  }
  for (const bindingId of touched) buildTrips(next, fleet.bindings.find(value => value.id === bindingId), now, audit);
  // Mapping CAS is independent of heartbeat frequency; the current motor/trip
  // state is checked in the same command transaction even when a UI revision
  // remains valid. The aggregate revision still invalidates status projections.
  if (accepted) { device.updatedAt = now; fleet.revision++; }
  state.fleet = next.fleet; if (Array.isArray(opts.audit)) opts.audit.push(...audit);
  return { accepted, duplicates, quarantined: fleet.telemetryEvents.filter(value => acceptedKeys.has(value.key) && value.quarantined).length,
    revision: fleet.revision, deviceId: device.id };
}
