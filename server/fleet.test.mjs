import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureFleet, fleetCapabilities, fleetProjection, fleetCommand, employeeFleetProjection, employeeFleetCommand, fleetTripGate, fleetVehicleEligible, ingestFleetTrip } from './fleet.mjs';

const at = '2026-10-16T09:00:00Z', opts = { now: at, siteCatalog: [{ id: 'north', active: true }, { id: 'south', active: true }] };
const user = (id, patch = {}) => ({ id, name: id, active: true, level: 'Medarbetare', permissions: ['fleetRead', 'fleetWrite', 'fleetExport'], ...patch });
const principal = (actor = user('admin', { level: 'Systemadmin' }), effective = actor) => ({ actor, user: effective });
const state = () => ({ transport: { revision: 9, vehicles: [{ id: 'vehicle-1', registration: 'ABC123', name: 'Truck', active: true, types: ['container'] },
  { id: 'vehicle-2', registration: '', machineIdentifier: 'MACHINE-17', name: 'Excavator', active: true, types: ['container'] }, { id: 'unscoped', registration: 'LEG123', name: 'Legacy vehicle', types: ['bin'] }],
  drivers: [{ id: 'driver-1', personId: 'person-1', vehicleId: 'vehicle-1' }, { id: 'driver-2', personId: 'person-2', vehicleId: 'vehicle-1' }],
  orders: [{ id: 'AO-own', customerName: 'Own customer', driverId: 'driver-1', vehicleId: 'vehicle-1', siteId: 'north' }, { id: 'AO-other', customerName: 'Other customer', driverId: 'driver-2', vehicleId: 'vehicle-2', siteId: 'south' }] },
  personnel: { people: [{ id: 'person-1', userId: 'user-1', driverId: 'driver-1', vehicleId: 'vehicle-1', active: true, kind: 'employee', name: 'One', siteIds: ['north'] },
    { id: 'person-2', userId: 'user-2', driverId: 'driver-2', vehicleId: 'vehicle-1', active: true, kind: 'employee', name: 'Two', siteIds: ['north', 'south'] },
    { id: 'person-3', userId: 'user-3', active: false, kind: 'employee', name: 'Former', siteIds: ['north'] }] } });
function setup() { const data = state(); ensureFleet(data); data.fleet.profiles = { 'vehicle-1': { vehicleId: 'vehicle-1', siteId: 'north', revision: 0 }, 'vehicle-2': { vehicleId: 'vehicle-2', siteId: 'south', revision: 0 } }; return data; }
const mobile = (patch = {}) => ({ personId: 'person-1', principal: principal(user('user-1', { permissions: [], siteIds: ['north'], ...patch })) });
const command = (data, action, fields, patch = {}) => ({ action, requestId: randomUUID(), expectedRevision: data.fleet?.revision ?? 0, ...fields, ...patch });
const trip = (id, patch = {}) => ({ id, vehicleId: 'vehicle-1', personId: 'person-1', driverSource: 'panel', startAt: '2026-10-15T07:00:00Z', endAt: '2026-10-15T07:30:00Z', distanceKm: 12.3,
  startOdometerKm: 100, endOdometerKm: 112.3, quality: 'good', source: 'simulator', ...patch });
const rejectedUnchanged = (data, operation, check) => { const before = structuredClone(data); assert.throws(operation, check); assert.deepEqual(data, before); };
const code = expected => error => error.code === expected;

test('fleet initialization is additive, idempotent and creates no second vehicle registry or production demo data', () => {
  const data = state(), original = structuredClone(data.transport);
  const fleet = ensureFleet(data); assert.deepEqual(data.transport, original); assert.equal(fleet.trips.length, 0); assert.equal(fleet.services.length, 0); assert.deepEqual(fleet.profiles, {});
  fleet.devices = [{ id: 'sibling-device' }]; fleet.bindings = [{ id: 'binding' }]; fleet.transfers = [{ id: 'transfer' }];
  const before = structuredClone(data); ensureFleet(data); assert.deepEqual(data, before); assert.equal(data.fleet.vehicles, undefined);
});

test('office capabilities require two active known identities and both site scopes including empty arrays are enforced', () => {
  const data = setup(), scoped = principal(user('actual', { siteIds: ['north'] }), user('effective', { siteIds: ['north', 'south'] }));
  assert.equal(fleetCapabilities(undefined).read, false); assert.equal(fleetCapabilities({ actor: principal().actor }).read, false);
  assert.equal(fleetCapabilities(principal(user('allowed'), user('denied', { permissions: [] }))).read, false);
  assert.equal(fleetCapabilities(principal(user('actual', { active: false }), user('effective'))).write, false);
  assert.equal(fleetCapabilities(principal(user('unknown', { level: 'invented' }))).read, false);
  assert.deepEqual(fleetProjection(data, scoped).vehicles.map(vehicle => vehicle.id), ['vehicle-1']);
  assert.deepEqual(fleetProjection(data, principal(user('none', { siteIds: [] }))).vehicles, []);
  rejectedUnchanged(data, () => fleetCommand(data, scoped, command(data, 'profile.save', { vehicleId: 'vehicle-2', profile: { notes: 'Forbidden' } }), [], opts), code('fleet_site_forbidden'));
  rejectedUnchanged(data, () => fleetCommand(data, scoped, command(data, 'profile.save', { vehicleId: 'unscoped', profile: { siteId: 'north' } }), [], opts), code('fleet_site_forbidden'));
});

test('profile settings never change canonical IDs, machine identifiers, bookings or historical trip attribution', () => {
  const data = setup(), canonical = structuredClone(data.transport), audit = [];
  ingestFleetTrip(data, trip('historic'), audit, opts);
  const original = structuredClone(data.fleet.trips[0]);
  const result = fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { siteId: 'north', defaultDriverId: 'person-2', odometerKm: 123, odometerSource: 'manual',
    operatingHours: 50, notes: 'Main vehicle', photoUrl: '/api/fleet/files/photo-1', maintenance: { intervalKm: 10000, lastServiceKm: 0 } } }), audit, opts);
  assert.equal(result.saved.profile.defaultDriverId, 'person-2'); assert.equal(result.saved.profile.odometerKm, 123); assert.deepEqual(data.fleet.trips[0], original); assert.deepEqual(data.transport, canonical);
  assert.equal(fleetProjection(data, principal(), opts).vehicles.find(vehicle => vehicle.id === 'vehicle-2').machineIdentifier, 'MACHINE-17');
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { siteId: 'south', defaultDriverId: 'person-1' } }), [], opts), code('fleet_person_forbidden'));
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { odometerKm: 300 } }), [], opts), code('fleet_odometer_source'));
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { registration: 'HACK' } }), [], opts), error => error.status === 422);
});

test('global revision guards, actor-bound idempotency and changed request hashes prevent double writes', () => {
  const data = setup(), audit = [], input = command(data, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Brake service', status: 'planned', dueKm: 1000 } });
  const first = fleetCommand(data, principal(), input, audit, opts), before = structuredClone(data), auditCount = audit.length;
  const replay = fleetCommand(data, principal(), input, audit, opts); assert.equal(replay.saved.service.id, first.saved.service.id); assert.equal(replay.replayed, true); assert.deepEqual(data, before); assert.equal(audit.length, auditCount);
  rejectedUnchanged(data, () => fleetCommand(data, principal(), { ...input, service: { ...input.service, title: 'Different' } }, audit, opts), code('fleet_idempotency_conflict'));
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'service.save', { service: input.service }, { expectedRevision: 0 }), audit, opts), code('fleet_revision_conflict'));
  const noLongerAllowed = principal(user('admin', { level: 'Systemadmin', siteIds: ['south'] }));
  rejectedUnchanged(data, () => fleetCommand(data, noLongerAllowed, input, audit, opts), code('fleet_site_forbidden'));
});

test('service reminders, severe issues and inspections never implicitly raise or clear an explicit operating block', () => {
  const data = setup(), admin = principal(), writer = principal(user('writer'));
  fleetCommand(data, admin, command(data, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Overdue service', status: 'planned', dueDate: '2020-01-01', dueKm: 1 } }), [], opts);
  const issue = fleetCommand(data, admin, command(data, 'issue.save', { issue: { vehicleId: 'vehicle-1', title: 'Brake warning', severity: 'critical', status: 'open', photoUrls: ['/api/fleet/files/evidence'] } }), [], opts).saved.issue;
  assert.equal(fleetVehicleEligible(data, 'vehicle-1').eligible, true);
  fleetCommand(data, writer, command(data, 'vehicle.block', { vehicleId: 'vehicle-1', blocked: true, reason: 'Brake assessment required' }), [], opts);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1').issues[0].code, 'fleet_vehicle_blocked');
  fleetCommand(data, admin, command(data, 'issue.save', { issue: { ...Object.fromEntries(Object.entries(issue).filter(([key]) => ['id', 'vehicleId', 'title', 'severity', 'status', 'photoUrls'].includes(key))), status: 'resolved' } }), [], opts);
  fleetCommand(data, admin, command(data, 'inspection.save', { vehicleId: 'vehicle-1', checks: [{ key: 'brakes', ok: true }] }), [], opts);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1').eligible, false);
  rejectedUnchanged(data, () => fleetCommand(data, writer, command(data, 'vehicle.block', { vehicleId: 'vehicle-1', blocked: false, reason: 'Tried without authority' }), [], opts), code('fleet_unblock_forbidden'));
  fleetCommand(data, admin, command(data, 'vehicle.block', { vehicleId: 'vehicle-1', blocked: false, reason: 'Workshop released vehicle' }), [], opts);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1').eligible, true); data.transport.vehicles[0].active = false; assert.equal(fleetVehicleEligible(data, 'vehicle-1').issues[0].code, 'fleet_vehicle_inactive');
});

test('trip gate covers every ended own incomplete trip across all dates while separating active, unknown-driver and sensor-gap records', () => {
  const data = setup();
  for (const value of [trip('old', { startAt: '2020-01-01T07:00:00Z', endAt: '2020-01-01T07:30:00Z' }), trip('latest'), trip('active', { endAt: undefined }), trip('gap', { quality: 'sensor_gap' }), trip('unknown', { personId: undefined, driverSource: 'unknown' }), trip('other', { personId: 'person-2' }), trip('private', { classification: 'private' }), trip('business', { classification: 'business', purpose: 'Return from customer pickup' })]) ingestFleetTrip(data, value, [], opts);
  const gate = fleetTripGate(data, 'person-1'); assert.equal(gate.blocked, true); assert.equal(gate.count, 2); assert.deepEqual(gate.pendingTrips.map(trip => trip.id), ['latest', 'old']); assert.equal(gate.safeToInteract, false);
  const filtered = employeeFleetProjection(data, mobile(), { date: '2026-10-16' }); assert.equal(filtered.gate.count, 2);
  assert.equal(filtered.trips.some(trip => trip.id === 'other'), false); assert.equal(filtered.trips.some(trip => trip.id === 'unknown'), false);
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'trip.complete', { tripId: 'old', expectedTripRevision: 1, classification: 'private' }), [], opts), code('fleet_trip_active'));
});

test('mobile completion requires explicit classification and a real accessible order or concrete purpose, and private clears business references', () => {
  const data = setup(), audit = []; ingestFleetTrip(data, trip('own'), [], opts); ingestFleetTrip(data, trip('foreign', { personId: 'person-2' }), [], opts);
  const complete = patch => command(data, 'trip.complete', { tripId: 'own', expectedTripRevision: data.fleet.trips.find(trip => trip.id === 'own').revision, classification: 'business', ...patch });
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), complete({ purpose: 'Tjänst' }), audit, opts), code('fleet_purpose_required'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), complete({ workOrderId: 'AO-other' }), audit, opts), code('fleet_order_forbidden'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), complete({ tripId: 'foreign', expectedTripRevision: 1, purpose: 'Business pickup route' }), audit, opts), code('fleet_trip_forbidden'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), complete({ expectedTripRevision: 99, purpose: 'Business pickup route' }), audit, opts), code('fleet_trip_revision'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), { ...complete({ purpose: 'Business pickup route' }), personId: 'person-2' }, audit, opts), error => error.status === 422);
  const completed = employeeFleetCommand(data, mobile(), complete({ workOrderId: 'AO-own', purpose: 'Customer pickup' }), audit, opts);
  assert.equal(completed.gate.blocked, false); assert.equal(completed.saved.trip.workOrderId, 'AO-own');
  const privateResult = employeeFleetCommand(data, mobile(), complete({ classification: 'private', purpose: 'Must disappear', workOrderId: 'AO-other' }), audit, opts);
  assert.equal(privateResult.saved.trip.classification, 'private'); assert.equal(privateResult.saved.trip.purpose, undefined); assert.equal(privateResult.saved.trip.workOrderId, undefined);
  assert.equal(audit.at(-1).actualUserId, 'user-1'); assert.equal(audit.at(-1).effectiveUserId, 'user-1');
});

test('old own trips stay completable after access revocation without leaking another persons trips or accepting inaccessible work orders', () => {
  const data = setup(); ingestFleetTrip(data, trip('old-own'), [], opts); data.personnel.people[0].siteIds = [];
  const identity = mobile({ siteIds: [] }), view = employeeFleetProjection(data, identity, opts);
  assert.deepEqual(view.vehicles, []); assert.deepEqual(view.workOrders, []); assert.equal(view.gate.count, 1);
  const result = employeeFleetCommand(data, identity, command(data, 'trip.complete', { tripId: 'old-own', expectedTripRevision: 1, classification: 'business', purpose: 'Return after approved customer visit' }), [], opts);
  assert.equal(result.gate.blocked, false);
});

test('reassignment preserves an own historical trip without retaining current vehicle data or command access', () => {
  const data = setup(); ingestFleetTrip(data, trip('before-reassignment', { fromLabel: 'Own historic departure' }), [], opts);
  data.fleet.services.push({ id: 'current-service', vehicleId: 'vehicle-1', title: 'New workshop visit', status: 'planned' });
  data.fleet.issues.push({ id: 'current-issue', vehicleId: 'vehicle-1', title: 'Current issue' });
  data.fleet.inspections.push({ id: 'current-inspection', vehicleId: 'vehicle-1', checks: [] });
  delete data.personnel.people[0].vehicleId;
  // The former driver's legacy driver.vehicleId preference remains ambiguous.
  // Only an actual current personal/default/NEXT link grants vehicle access.
  fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { defaultDriverId: 'person-2', notes: 'Current private vehicle information' } }), [], opts);
  const view = employeeFleetProjection(data, mobile(), opts);
  for (const key of ['vehicles', 'services', 'issues', 'inspections']) assert.deepEqual(view[key], []);
  assert.deepEqual(view.profiles, {}); assert.equal(view.trips[0].id, 'before-reassignment'); assert.equal(view.trips[0].fromLabel, 'Own historic departure'); assert.equal(view.gate.count, 1);
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'issue.save', { issue: { vehicleId: 'vehicle-1', title: 'Not my current vehicle', severity: 'low', status: 'open' } }), [], opts), code('fleet_vehicle_forbidden'));
  const completed = employeeFleetCommand(data, mobile(), command(data, 'trip.complete', { tripId: 'before-reassignment', expectedTripRevision: 1, classification: 'private' }), [], opts);
  assert.equal(completed.gate.blocked, false); assert.deepEqual(completed.vehicles, []);
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'driver.select', { vehicleId: 'vehicle-1', personId: 'person-1' }), [], opts), code('fleet_vehicle_forbidden'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'inspection.save', { vehicleId: 'vehicle-1', checks: [{ key: 'lights', ok: true }] }), [], opts), code('fleet_vehicle_forbidden'));
});

test('mobile identities are reloaded and cannot manage profiles, services, other drivers or another persons report', () => {
  const data = setup(); assert.throws(() => employeeFleetProjection(data, undefined), code('fleet_auth_required'));
  assert.throws(() => employeeFleetProjection(data, { personId: 'person-3' }), code('fleet_identity_invalid'));
  assert.throws(() => employeeFleetProjection(data, { personId: 'person-2', ...mobile() , person: { id: 'person-2' }, principal: principal(user('user-2', { active: false })) }), code('fleet_identity_invalid'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { defaultDriverId: 'person-1' } }), [], opts), code('fleet_forbidden'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), command(data, 'driver.select', { vehicleId: 'vehicle-1', personId: 'person-2' }), [], opts), code('fleet_person_forbidden'));
  const report = employeeFleetCommand(data, mobile(), command(data, 'issue.save', { issue: { vehicleId: 'vehicle-1', title: 'Warning light', severity: 'medium', status: 'open' } }), [], opts);
  assert.equal(report.saved.issue.personId, 'person-1');
  const inspection = employeeFleetCommand(data, mobile(), command(data, 'inspection.save', { vehicleId: 'vehicle-1', checks: [{ key: 'lights', ok: false }], comment: 'Reported separately' }), [], opts);
  assert.equal(inspection.saved.inspection.personId, 'person-1'); assert.equal(fleetVehicleEligible(data, 'vehicle-1').eligible, true);
});

test('next driver selection and explicit default are sampled at trip start, never guessed from shared vehicle preferences', () => {
  const data = setup(), unknown = ingestFleetTrip(data, trip('ambiguous', { personId: undefined, driverSource: 'default' }), [], opts);
  assert.equal(unknown.personId, undefined); assert.equal(unknown.driverSource, 'unknown');
  fleetCommand(data, principal(), command(data, 'profile.save', { vehicleId: 'vehicle-1', profile: { defaultDriverId: 'person-2' } }), [], opts);
  employeeFleetCommand(data, mobile(), command(data, 'driver.select', { vehicleId: 'vehicle-1', personId: 'person-1' }), [], opts);
  const buffered = ingestFleetTrip(data, trip('buffered-before-selection', { personId: undefined, driverSource: 'default' }), [], opts);
  assert.equal(buffered.personId, undefined); assert.equal(data.fleet.profiles['vehicle-1'].nextDriver.personId, 'person-1');
  const next = ingestFleetTrip(data, trip('next', { personId: undefined, driverSource: 'default', startAt: '2026-10-16T09:01:00Z', endAt: '2026-10-16T09:30:00Z' }), [], opts);
  assert.equal(next.personId, 'person-1'); assert.equal(next.driverSource, 'app'); assert.equal(data.fleet.profiles['vehicle-1'].nextDriver, undefined);
  const later = ingestFleetTrip(data, trip('later', { personId: undefined, driverSource: 'default', startAt: '2026-10-16T10:00:00Z', endAt: '2026-10-16T10:30:00Z' }), [], opts);
  assert.equal(later.personId, 'person-2'); assert.equal(later.driverSource, 'default'); assert.equal(data.fleet.trips.find(trip => trip.id === 'ambiguous').personId, undefined);
});

test('an office next-driver choice is attributed to the office and never presented as a physical panel observation', () => {
  const data = setup(), selected = fleetCommand(data, principal(), command(data, 'driver.select', { vehicleId: 'vehicle-1', personId: 'person-2' }), [], opts);
  assert.equal(selected.saved.profile.nextDriver.source, 'office');
  const input = trip('office-selected', { personId: undefined, driverSource: 'default', startAt: '2026-10-16T09:01:00Z', endAt: '2026-10-16T09:30:00Z' });
  const observed = ingestFleetTrip(data, input, [], opts);
  assert.equal(observed.personId, 'person-2'); assert.equal(observed.driverSource, 'office'); assert.equal(data.fleet.profiles['vehicle-1'].nextDriver, undefined);
  assert.deepEqual(ingestFleetTrip(data, { ...input, personId: 'person-2', driverSource: 'office' }, [], opts), observed);
  const hardware = ingestFleetTrip(data, trip('real-panel', { startAt: '2026-10-16T10:01:00Z', endAt: '2026-10-16T10:30:00Z' }), [], opts);
  assert.equal(hardware.personId, 'person-1'); assert.equal(hardware.driverSource, 'panel');
});

test('trusted trip ingestion is idempotent, preserves approved detail/ownership and rejects changed historical vehicle or observed end', () => {
  const data = setup(), audit = [], input = trip('same');
  const first = ingestFleetTrip(data, input, audit, opts), before = structuredClone(data); assert.deepEqual(ingestFleetTrip(data, input, audit, opts), first); assert.deepEqual(data, before); assert.equal(audit.length, 1);
  employeeFleetCommand(data, mobile(), command(data, 'trip.complete', { tripId: first.id, expectedTripRevision: first.revision, classification: 'private' }), [], opts);
  ingestFleetTrip(data, { ...input, classification: 'business', purpose: 'Injected receiver purpose', distanceKm: 12.4 }, [], opts);
  assert.equal(data.fleet.trips[0].classification, 'private'); assert.equal(data.fleet.trips[0].purpose, undefined);
  rejectedUnchanged(data, () => ingestFleetTrip(data, { ...input, vehicleId: 'vehicle-2' }, [], opts), code('fleet_trip_identity'));
  rejectedUnchanged(data, () => ingestFleetTrip(data, { ...input, personId: 'person-2' }, [], opts), code('fleet_trip_identity'));
  rejectedUnchanged(data, () => ingestFleetTrip(data, { ...input, endAt: '2026-10-15T08:00:00Z' }, [], opts), code('fleet_trip_time'));
  const rawUnknown = trip('unknown-repeat', { personId: undefined, driverSource: 'unknown' }); ingestFleetTrip(data, rawUnknown, [], opts); const stable = structuredClone(data); ingestFleetTrip(data, rawUnknown, [], opts); assert.deepEqual(data, stable);
});

test('company projections hide private and unclassified routes and never reuse an earlier business position after a private trip', () => {
  const data = setup(), position = { at: '2026-10-15T07:20:00Z', lat: 59.7, lng: 18.7 };
  ingestFleetTrip(data, trip('business-route', { classification: 'business', purpose: 'Customer collection', positions: [position], fromLabel: 'Depot', toLabel: 'Customer' }), [], opts);
  let view = fleetProjection(data, principal(), opts); assert.equal(view.positions.length, 1); assert.equal(view.positions[0].stale, true); assert.equal(view.trips[0].positions.length, 1);
  ingestFleetTrip(data, trip('private-route', { startAt: '2026-10-15T08:00:00Z', endAt: '2026-10-15T08:30:00Z', classification: 'private', positions: [position], fromLabel: 'Secret home', toLabel: 'Private visit' }), [], opts);
  ingestFleetTrip(data, trip('unclassified-route', { startAt: '2026-10-15T09:00:00Z', endAt: '2026-10-15T09:30:00Z', positions: [position], fromLabel: 'Unclassified place' }), [], opts);
  view = fleetProjection(data, principal(), opts); assert.deepEqual(view.positions, []);
  for (const item of view.trips.filter(trip => trip.classification !== 'business')) { assert.equal(item.positions, undefined); assert.equal(item.fromLabel, undefined); assert.equal(item.toLabel, undefined); }
  const own = employeeFleetProjection(data, mobile(), opts); assert.equal(own.trips.find(trip => trip.id === 'private-route').fromLabel, 'Secret home');
  const stored = data.fleet.trips.find(trip => trip.id === 'private-route'); assert.equal(stored.positions.length, 1, 'Projection must not erase original telemetry');
  const input = command(data, 'trip.complete', { tripId: 'private-route', expectedTripRevision: stored.revision, classification: 'business', purpose: 'Office must not expose a private journey' });
  rejectedUnchanged(data, () => fleetCommand(data, principal(), input, [], opts), code('fleet_trip_owner_required'));
  rejectedUnchanged(data, () => employeeFleetCommand(data, { personId: 'person-2' }, input, [], opts), code('fleet_trip_forbidden'));
  assert.equal(fleetProjection(data, principal(), { ...opts, search: 'Secret home' }).tripCount, 0, 'Private route search must not reveal hidden places through matching counts');
  assert.equal(employeeFleetProjection(data, mobile(), { ...opts, search: 'Secret home' }).tripCount, 1);
  const changedByOwner = employeeFleetCommand(data, mobile(), input, [], opts);
  assert.equal(changedByOwner.saved.trip.classification, 'business'); assert.equal(changedByOwner.saved.trip.fromLabel, 'Secret home');
});

test('an unknown trip requires an explicit audited office assignment, remains truthful about its source and survives later telemetry', () => {
  const data = setup(), audit = [], raw = trip('review-driver', { personId: undefined, driverSource: 'unknown', quality: 'review' });
  ingestFleetTrip(data, raw, [], opts); assert.equal(fleetTripGate(data, 'person-1').count, 0);
  const input = command(data, 'trip.assign', { tripId: raw.id, expectedTripRevision: 1, personId: 'person-1', reason: 'Driver confirmed from the dispatch log' });
  rejectedUnchanged(data, () => employeeFleetCommand(data, mobile(), input, audit, opts), code('fleet_forbidden'));
  rejectedUnchanged(data, () => fleetCommand(data, principal(), { ...input, expectedTripRevision: 99 }, audit, opts), code('fleet_trip_revision'));
  const assigned = fleetCommand(data, principal(), input, audit, opts).saved.trip;
  assert.equal(assigned.personId, 'person-1'); assert.equal(assigned.driverSource, 'unknown'); assert.equal(assigned.manualDriverAssignment.personId, 'person-1'); assert.equal(audit[0].driverAssignment.reason, input.reason);
  assert.equal(fleetTripGate(data, 'person-1').count, 1);
  const replay = fleetCommand(data, principal(), input, audit, opts); assert.equal(replay.replayed, true); assert.equal(audit.length, 1);
  employeeFleetCommand(data, mobile(), command(data, 'trip.complete', { tripId: raw.id, expectedTripRevision: assigned.revision, classification: 'business', purpose: 'Collection at the authorized customer location' }), [], opts);
  ingestFleetTrip(data, { ...raw, distanceKm: 13 }, [], opts);
  const stored = data.fleet.trips[0]; assert.equal(stored.personId, 'person-1'); assert.equal(stored.driverSource, 'unknown'); assert.equal(stored.manualDriverAssignment.reason, input.reason); assert.equal(stored.classification, 'business'); assert.match(stored.purpose, /Collection/); assert.equal(fleetTripGate(data, 'person-1').blocked, false);
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'trip.assign', { tripId: stored.id, expectedTripRevision: stored.revision, personId: 'person-2', reason: 'Attempt to overwrite reviewed driver' }), [], opts), code('fleet_driver_already_known'));
  ingestFleetTrip(data, trip('known-driver'), [], opts);
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'trip.assign', { tripId: 'known-driver', expectedTripRevision: 1, personId: 'person-2', reason: 'Attempt to change a known driver' }), [], opts), code('fleet_driver_already_known'));
});

test('explicit observed driver conflicts retain the observation and manual resolution on buffered replay', () => {
  const data = setup(), raw = trip('conflict', { personId: 'person-2', driverSource: 'panel', driverConflict: true, quality: 'review' });
  ingestFleetTrip(data, raw, [], opts);
  const result = fleetCommand(data, principal(), command(data, 'trip.assign', { tripId: raw.id, expectedTripRevision: 1, personId: 'person-1', reason: 'Conflicting panel identity reviewed with both drivers' }), [], opts);
  assert.equal(result.saved.trip.driverSource, 'panel'); assert.equal(result.saved.trip.manualDriverAssignment.previousPersonId, 'person-2'); assert.equal(result.saved.trip.manualDriverAssignment.observedDriverSource, 'panel');
  ingestFleetTrip(data, raw, [], opts); assert.equal(data.fleet.trips[0].personId, 'person-1'); assert.equal(data.fleet.trips[0].manualDriverAssignment.personId, 'person-1');
});

test('bounded trip pagination and Stockholm-date filters do not hide older own mandatory completions', () => {
  const data = setup();
  for (let index = 0; index < 105; index++) ingestFleetTrip(data, trip(`page-${String(index).padStart(3, '0')}`, { startAt: new Date(Date.parse('2026-10-14T22:30:00Z') + index * 60000).toISOString(), endAt: new Date(Date.parse('2026-10-14T22:31:00Z') + index * 60000).toISOString() }), [], opts);
  const first = fleetProjection(data, principal(), opts); assert.equal(first.trips.length, 100); assert.equal(first.tripCount, 105); assert.equal(first.truncated, true); assert.equal(first.pagination.limit, 100);
  const second = fleetProjection(data, principal(), { ...opts, offset: 100 }); assert.equal(second.trips.length, 5); assert.equal(second.tripCount, 105);
  const all = fleetProjection(data, principal(), { ...opts, limit: 1000 }); assert.equal(all.trips.length, 105); assert.equal(all.truncated, false);
  const selected = employeeFleetProjection(data, mobile(), { ...opts, fromDate: '2026-10-15', toDate: '2026-10-15', limit: 1 }); assert.equal(selected.tripCount, 105); assert.equal(selected.trips.length, 1); assert.equal(selected.pendingTrips.length, 105); assert.equal(selected.gate.count, 105);
  assert.equal(employeeFleetProjection(data, mobile(), { ...opts, fromDate: '2026-10-16' }).tripCount, 0); assert.equal(employeeFleetProjection(data, mobile(), { ...opts, fromDate: '2026-10-16' }).gate.count, 105);
  assert.equal(fleetProjection(data, principal(), { ...opts, classification: 'unclassified', status: 'incomplete', search: 'Truck', limit: 12 }).tripCount, 105);
  assert.equal(fleetProjection(data, principal(), { ...opts, classification: 'business' }).tripCount, 0);
});

test('an explicit planned workshop interval reserves exactly its half-open window for local bookings and actual departures', () => {
  const data = setup();
  fleetCommand(data, principal(), command(data, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Reserved workshop', status: 'planned', startAt: '2026-10-16T08:00:00Z', endAt: '2026-10-16T10:00:00Z' } }), [], opts);
  const available = (startMinute, durationMinutes = 15) => fleetVehicleEligible(data, 'vehicle-1', { plan: { date: '2026-10-16', startMinute, durationMinutes } });
  assert.equal(available(540, 60).eligible, true, 'A booking ending at workshop start is allowed');
  assert.equal(available(600).issues[0].code, 'fleet_vehicle_service'); assert.equal(available(705).eligible, false);
  assert.equal(available(720).eligible, true, 'A booking starting at workshop end is allowed');
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { at: '2026-10-16T07:59:59.999Z' }).eligible, true);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { at: '2026-10-16T08:00:00Z' }).eligible, false);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { at: '2026-10-16T10:00:00Z' }).eligible, true);
  assert.equal(fleetVehicleEligible(data, 'vehicle-2', { plan: { date: '2026-10-16', startMinute: 600, durationMinutes: 60 } }).eligible, true);
});

test('workshop saves require two ordered times and atomically reject overlap with planned service, booked/on-way work and preliminary plans', () => {
  const service = { vehicleId: 'vehicle-1', title: 'Workshop', status: 'planned', startAt: '2026-10-16T08:30:00Z', endAt: '2026-10-16T09:30:00Z' };
  for (const patch of [{ endAt: undefined }, { startAt: undefined }, { endAt: service.startAt }, { endAt: '2026-10-16T08:00:00Z' }]) {
    const data = setup(); rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'service.save', { service: { ...service, ...patch } }), [], opts), code('fleet_service_time_invalid'));
  }
  for (const status of ['booked', 'on_way', 'preliminary']) {
    const data = setup(), plan = { vehicleId: 'vehicle-1', date: '2026-10-16', startMinute: 600, durationMinutes: 60 };
    if (status === 'preliminary') data.transport.preliminary = { 'AO-proposal': plan };
    else Object.assign(data.transport.orders[0], { ...plan, status });
    rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'service.save', { service }), [], opts), code('fleet_service_booking_conflict'));
  }
  const data = setup(); const saved = fleetCommand(data, principal(), command(data, 'service.save', { service }), [], opts).saved.service;
  rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'service.save', { service: { ...service, startAt: '2026-10-16T09:00:00Z', endAt: '2026-10-16T10:00:00Z' } }), [], opts), code('fleet_service_conflict'));
  const edited = fleetCommand(data, principal(), command(data, 'service.save', { service: { ...service, id: saved.id, title: 'Same reservation edited' } }), [], opts); assert.equal(edited.saved.service.id, saved.id);
  assert.equal(fleetCommand(data, principal(), command(data, 'service.save', { service: { ...service, startAt: service.endAt, endAt: '2026-10-16T10:00:00Z' } }), [], opts).saved.service.status, 'planned');
});

test('service-save boundary checks keep existing bookings unchanged and due-only/completed records never reserve or lift explicit blocks', () => {
  const data = setup(), plan = { vehicleId: 'vehicle-1', date: '2026-10-16', startMinute: 600, durationMinutes: 60, status: 'booked' };
  Object.assign(data.transport.orders[0], plan); const original = structuredClone(data.transport);
  const before = { vehicleId: 'vehicle-1', title: 'Before booking', status: 'planned', startAt: '2026-10-16T07:00:00Z', endAt: '2026-10-16T08:00:00Z' };
  const after = { vehicleId: 'vehicle-1', title: 'After booking', status: 'planned', startAt: '2026-10-16T09:00:00Z', endAt: '2026-10-16T10:00:00Z' };
  fleetCommand(data, principal(), command(data, 'service.save', { service: before }), [], opts); fleetCommand(data, principal(), command(data, 'service.save', { service: after }), [], opts); assert.deepEqual(data.transport, original);
  fleetCommand(data, principal(), command(data, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Date reminder', status: 'planned', dueDate: '2020-01-01' } }), [], opts);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { plan }).eligible, true);
  const now = Date.now(), present = setup(), liveService = { vehicleId: 'vehicle-1', title: 'Current workshop', status: 'planned', startAt: new Date(now - 60000).toISOString(), endAt: new Date(now + 60000).toISOString() };
  const saved = fleetCommand(present, principal(), command(present, 'service.save', { service: liveService }), [], opts).saved.service;
  assert.equal(fleetVehicleEligible(present, 'vehicle-1').eligible, false, 'Actual departure checks current time without a plan option');
  fleetCommand(present, principal(), command(present, 'vehicle.block', { vehicleId: 'vehicle-1', blocked: true, reason: 'Separate unresolved safety assessment' }), [], opts);
  fleetCommand(present, principal(), command(present, 'service.save', { service: { ...liveService, id: saved.id, status: 'completed' } }), [], opts);
  assert.deepEqual(fleetVehicleEligible(present, 'vehicle-1').issues.map(issue => issue.code), ['fleet_vehicle_blocked']);
});

test('Stockholm DST gaps and both autumn folds are checked against observed workshop instants without inventing a UTC offset', () => {
  const data = setup();
  fleetCommand(data, principal(), command(data, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Spring workshop', status: 'planned', startAt: '2026-03-29T00:45:00Z', endAt: '2026-03-29T01:15:00Z' } }), [], opts);
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { plan: { date: '2026-03-29', startMinute: 90, durationMinutes: 120 } }).eligible, false, '01:30–03:30 local crosses the spring clock change');
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { plan: { date: '2026-03-29', startMinute: 195, durationMinutes: 15 } }).eligible, true, '03:15 local is the actual service end');
  assert.equal(fleetVehicleEligible(data, 'vehicle-1', { plan: { date: '2026-03-29', startMinute: 135, durationMinutes: 15 } }).issues[0].code, 'fleet_plan_time_invalid');
  for (const hour of ['00', '01']) {
    const autumn = setup();
    fleetCommand(autumn, principal(), command(autumn, 'service.save', { service: { vehicleId: 'vehicle-1', title: 'Autumn workshop', status: 'planned', startAt: `2026-10-25T${hour}:40:00Z`, endAt: `2026-10-25T${hour}:50:00Z` } }), [], opts);
    assert.equal(fleetVehicleEligible(autumn, 'vehicle-1', { plan: { date: '2026-10-25', startMinute: 130, durationMinutes: 15 } }).eligible, true, '02:10–02:25 in either fold does not cover 02:40');
    assert.equal(fleetVehicleEligible(autumn, 'vehicle-1', { plan: { date: '2026-10-25', startMinute: 165, durationMinutes: 15 } }).eligible, false, '02:45–03:00 must honor either possible start fold');
  }
});

test('saving a workshop reservation uses the same autumn-fold booking semantics as later vehicle selection', () => {
  for (const hour of ['00', '01']) {
    const data = setup(); Object.assign(data.transport.orders[0], { vehicleId: 'vehicle-1', date: '2026-10-25', startMinute: 130, durationMinutes: 15, status: 'booked' });
    const service = { vehicleId: 'vehicle-1', title: 'Fold reservation', status: 'planned', startAt: `2026-10-25T${hour}:15:00Z`, endAt: `2026-10-25T${hour}:20:00Z` };
    rejectedUnchanged(data, () => fleetCommand(data, principal(), command(data, 'service.save', { service }), [], opts), code('fleet_service_booking_conflict'));
    const outside = { ...service, startAt: `2026-10-25T${hour}:40:00Z`, endAt: `2026-10-25T${hour}:50:00Z` };
    assert.equal(fleetCommand(data, principal(), command(data, 'service.save', { service: outside }), [], opts).saved.service.status, 'planned');
  }
});
