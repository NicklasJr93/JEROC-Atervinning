import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ensureFleet } from './fleet.mjs';
import { applyFleetDeviceAssignment, fleetEmployeeTelematicsProjection, fleetTelematicsCommand, fleetTelematicsProjection, ingestFleetTelemetry } from './fleet-telematics.mjs';

const org = 'company-one';
const at = minute => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const admin = { id: 'admin', level: 'Systemadmin', active: true, permissions: [] };
const principal = { actor: admin, user: admin };
function fixture() {
  const state = { metadata: { organisation: { id: org } },
    transport: { vehicles: ['one', 'two', 'three'].map(name => ({ id: `vehicle-${name}`, name, active: true })), orders: [] },
    personnel: { people: [{ id: 'person-one', active: true, kind: 'employee', siteIds: ['north'] },
      { id: 'person-two', active: true, kind: 'employee', siteIds: ['south'] }] } };
  ensureFleet(state);
  state.fleet.profiles = { 'vehicle-one': { siteId: 'north', defaultDriverId: 'person-one', odometerKm: 200, odometerSource: 'manual' },
    'vehicle-two': { siteId: 'south', defaultDriverId: 'person-two', odometerKm: 800, odometerSource: 'manual' },
    'vehicle-three': { siteId: 'north' } };
  assign(state, 'device-one');
  return state;
}
function opts(now = at(0), extra = {}) { return { organisationId: org, now, ...extra }; }
function assign(state, deviceId, extra = {}) {
  return applyFleetDeviceAssignment(state, { id: deviceId, name: deviceId, organisationId: org, source: 'simulator', active: true, ...extra }, opts('2026-10-16T09:50:00.000Z'));
}
function ingest(state, records, now = records.at(-1).at, deviceId = 'device-one') {
  return ingestFleetTelemetry(state, { deviceId, source: 'simulator', records }, opts(now));
}
function off(state, minute = 0, deviceId = 'device-one') {
  return ingest(state, [{ id: `off-${minute}`, at: at(minute), ignition: false, movement: false, odometerMeters: 120000000 }], at(minute), deviceId);
}
function command(state, action, fields, now = at(0), requestId = randomUUID()) {
  const target = fields.transferId ? state.fleet.transfers.find(value => value.id === fields.transferId)
    : state.fleet.devices.find(value => value.id === (fields.deviceId ?? 'device-one'));
  return fleetTelematicsCommand(state, principal, { action, expectedRevision: target.revision, requestId,
    ...(fields.transferId ? {} : { deviceId: 'device-one' }), ...fields }, [], opts(now));
}
function link(state, vehicleId = 'vehicle-one') { off(state); return command(state, 'device.link', { vehicleId }, '2026-10-16T10:00:01.000Z'); }
function atomicFailure(state, callback, code) {
  const before = structuredClone(state);
  assert.throws(callback, error => !code || error.code === code);
  assert.deepEqual(state, before);
}

test('central assignment is tenant-bound, idempotent and cannot reassign company/source or accept public extra fields', () => {
  const state = fixture(), first = structuredClone(state.fleet);
  assign(state, 'device-one'); assert.deepEqual(state.fleet, first);
  assert.equal(first.devices[0].ignition, null); assert.equal(first.devices[0].tripState, 'unknown');
  atomicFailure(state, () => applyFleetDeviceAssignment(state, { id: 'device-one', name: 'Foreign', organisationId: 'foreign', source: 'device', active: true }, opts()), 'fleet_device_forbidden');
  atomicFailure(state, () => applyFleetDeviceAssignment(state, { id: 'device-one', name: 'Changed', organisationId: org, source: 'device', active: true }, opts()));
  atomicFailure(state, () => assign(state, 'device-two', { companyId: 'forged' }), 'fleet_telematics_invalid');
  assert.throws(() => fleetTelematicsProjection(state, principal, { organisationId: 'foreign' }), { status: 403 });
  const beforeRead = structuredClone(state);
  const projected = fleetTelematicsProjection(state, principal, opts());
  assert.equal(projected.devices[0].contactStatus, 'never'); assert.equal(projected.devices[0].canLink, false);
  assert.deepEqual(state, beforeRead);
});

test('first mapping requires a fresh observed motor-off, active available resources, and no guessed online state', () => {
  const state = fixture();
  atomicFailure(state, () => command(state, 'device.link', { vehicleId: 'vehicle-one' }), 'fleet_device_motor_unknown');
  ingest(state, [{ id: 'motor-on', at: at(0), ignition: true }]);
  atomicFailure(state, () => command(state, 'device.link', { vehicleId: 'vehicle-one' }), 'fleet_device_motor_unknown');
  off(state, 1);
  atomicFailure(state, () => command(state, 'device.link', { vehicleId: 'vehicle-one' }, at(7)), 'fleet_device_motor_unknown');
  state.transport.vehicles[0].active = false;
  atomicFailure(state, () => command(state, 'device.link', { vehicleId: 'vehicle-one' }, at(2)), 'fleet_vehicle_inactive');
  state.transport.vehicles[0].active = true;
  const result = command(state, 'device.link', { vehicleId: 'vehicle-one' }, at(2));
  assert.equal(result.devices[0].status, 'linked'); assert.equal(result.devices[0].source, 'simulator');
  assert.equal(result.bindings[0].baseline.odometerKm, null); assert.equal(state.fleet.profiles['vehicle-one'].odometerKm, 200);
  assert.equal(result.devices[0].ignition, 'off'); assert.equal(result.devices[0].contactStatus, 'recent');
  assert.equal(Object.hasOwn(result.devices[0], 'online'), false);
});

test('two-step transfer persists across reload, reserves target, quarantines gap and demands a new off observation', () => {
  let state = fixture(); link(state); assign(state, 'device-two'); off(state, 1, 'device-two');
  const oldBinding = structuredClone(state.fleet.bindings[0]);
  const started = command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(2), 'transfer-start');
  const transferId = started.savedTransferId;
  assert.equal(state.fleet.bindings[0].endAt, at(2)); assert.equal(started.devices[0].status, 'transferring');
  atomicFailure(state, () => command(state, 'device.link', { deviceId: 'device-two', vehicleId: 'vehicle-two' }, at(2)));
  atomicFailure(state, () => command(state, 'device.transfer.confirm', { transferId }, at(2)), 'fleet_device_motor_unknown');
  ingest(state, [{ id: 'gap-on', at: at(3), ignition: true, odometerMeters: 121000000 },
    { id: 'gap-off', at: at(4), ignition: false, odometerMeters: 121002000 }]);
  assert.equal(state.fleet.trips.length, 0); assert.equal(state.fleet.telemetryQuarantine.filter(value => value.reason === 'transfer_gap').length, 2);
  state = structuredClone(state); // Serialized tenant state, not a browser-local pending flag.
  const before = state.fleet.transfers[0].revision;
  const input = { action: 'device.transfer.confirm', transferId, expectedRevision: before, requestId: 'confirm-once' };
  fleetTelematicsCommand(state, principal, input, [], opts(at(5)));
  const saved = structuredClone(state.fleet);
  fleetTelematicsCommand(state, principal, input, [], opts(at(5))); assert.deepEqual(state.fleet, saved);
  const current = state.fleet.bindings.find(value => !value.endAt);
  assert.equal(current.vehicleId, 'vehicle-two'); assert.equal(current.baseline.odometerKm, null);
  assert.equal(state.fleet.bindings[0].id, oldBinding.id); assert.equal(state.fleet.bindings[0].startAt, oldBinding.startAt);
  assert.equal(state.fleet.profiles['vehicle-two'].odometerKm, 800); assert.equal(state.fleet.transfers[0].status, 'confirmed');
});

test('restoration is explicit, appends a new historical interval, and cannot reclaim an occupied former vehicle', () => {
  const state = fixture(); link(state);
  const transferId = command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(2)).savedTransferId;
  off(state, 3); const oldId = state.fleet.bindings[0].id;
  command(state, 'device.transfer.restore', { transferId }, at(4));
  assert.equal(state.fleet.bindings.length, 2); assert.notEqual(state.fleet.bindings[1].id, oldId);
  assert.equal(state.fleet.bindings[0].endAt, at(2)); assert.equal(state.fleet.bindings[1].vehicleId, 'vehicle-one');
  assign(state, 'device-two'); off(state, 4, 'device-two');
  command(state, 'device.link', { deviceId: 'device-two', vehicleId: 'vehicle-two' }, at(5));
  assert.equal(state.fleet.transfers[0].status, 'restored');

  const second = fixture(); link(second); assign(second, 'device-two'); off(second, 1, 'device-two');
  const pending = command(second, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(2)).savedTransferId;
  command(second, 'device.link', { deviceId: 'device-two', vehicleId: 'vehicle-one' }, at(2)); off(second, 3);
  atomicFailure(second, () => command(second, 'device.transfer.restore', { transferId: pending }, at(4)));
});

test('command CAS/idempotency and dual permissions/site scopes prevent competing or forged links atomically', () => {
  const state = fixture(); off(state);
  const device = state.fleet.devices[0], input = { action: 'device.link', deviceId: device.id, vehicleId: 'vehicle-one', expectedRevision: device.revision, requestId: 'stable-link' };
  fleetTelematicsCommand(state, principal, input, [], opts(at(1))); const saved = structuredClone(state.fleet);
  fleetTelematicsCommand(state, principal, input, [], opts(at(1))); assert.deepEqual(state.fleet, saved);
  atomicFailure(state, () => fleetTelematicsCommand(state, principal, { ...input, vehicleId: 'vehicle-two' }, [], opts(at(1))), 'idempotency_conflict');
  atomicFailure(state, () => fleetTelematicsCommand(state, principal, { ...input, action: 'device.transfer.start', toVehicleId: 'vehicle-two', vehicleId: undefined, requestId: 'stale' }, [], opts(at(2))));
  const weak = { id: 'weak', level: 'Medarbetare', active: true, permissions: ['fleetRead'] };
  atomicFailure(state, () => fleetTelematicsCommand(state, { actor: weak, user: admin }, { action: 'device.transfer.start', deviceId: device.id, toVehicleId: 'vehicle-two', expectedRevision: state.fleet.devices[0].revision, requestId: 'weak' }, [], opts()), 'fleet_write_required');
  const north = { id: 'north-user', level: 'Medarbetare', active: true, permissions: ['fleetRead', 'fleetWrite'], siteIds: ['north'] };
  assert.equal(fleetTelematicsProjection(state, { actor: admin, user: north }, opts()).devices.length, 1);
  atomicFailure(state, () => fleetTelematicsCommand(state, { actor: admin, user: north }, { action: 'device.transfer.start', deviceId: device.id, toVehicleId: 'vehicle-two', expectedRevision: state.fleet.devices[0].revision, requestId: 'foreign-site' }, [], opts(at(2))), 'fleet_vehicle_forbidden');
  atomicFailure(state, () => fleetTelematicsCommand(state, principal, { ...input, organisationId: 'foreign' }, [], opts()), 'fleet_telematics_invalid');
});

test('ignition creates one trip with vehicle driver snapshot, deduplicates events and never transfers absolute meter/default driver', () => {
  const state = fixture(); link(state);
  const first = [{ id: 'start', at: at(1), ignition: true, odometerMeters: 120000000, lat: 59.7, lng: 18.7 },
    { id: 'finish', at: at(2), ignition: false, odometerMeters: 120005000, lat: 59.8, lng: 18.8 }];
  const result = ingest(state, first);
  assert.equal(result.accepted, 2); assert.equal(state.fleet.trips.length, 1);
  const trip = state.fleet.trips[0]; assert.equal(trip.personId, 'person-one'); assert.equal(trip.driverSource, 'default');
  assert.equal(trip.distanceKm, 5); assert.equal(trip.vehicleId, 'vehicle-one'); assert.equal(trip.source, 'simulator');
  assert.equal(trip.startOdometerKm, undefined); assert.equal(state.fleet.profiles['vehicle-one'].odometerKm, 200);
  const revisionBefore = state.fleet.revision; assert.equal(ingest(state, first).duplicates, 2); assert.equal(state.fleet.revision, revisionBefore);
  const pending = command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(3)).savedTransferId;
  off(state, 4); command(state, 'device.transfer.confirm', { transferId: pending }, at(5));
  ingest(state, [{ id: 'start-two', at: at(6), ignition: true, odometerMeters: 120006000 },
    { id: 'finish-two', at: at(7), ignition: false, odometerMeters: 120008000 }]);
  assert.equal(state.fleet.trips.length, 2);
  const next = state.fleet.trips.find(value => value.vehicleId === 'vehicle-two');
  assert.equal(next.personId, 'person-two'); assert.equal(next.distanceKm, 2); assert.equal(state.fleet.profiles['vehicle-two'].odometerKm, 800);
  assert.deepEqual(state.fleet.trips.find(value => value.id === trip.id), trip);
});

test('buffered old events use old binding, never current vehicle/default or next-trip selection; overlap is review, not duplicate trip', () => {
  const state = fixture(); link(state);
  off(state, 4); const transferId = command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(5)).savedTransferId;
  off(state, 6); command(state, 'device.transfer.confirm', { transferId }, at(7));
  state.fleet.profiles['vehicle-one'].nextDriver = { personId: 'person-two', source: 'app', selectedAt: at(8) };
  ingest(state, [{ id: 'buffered-start', at: at(1), ignition: true, odometerMeters: 120000000 },
    { id: 'buffered-end', at: at(2), ignition: false, odometerMeters: 120002000 }], at(15));
  assert.equal(state.fleet.trips.length, 1); assert.equal(state.fleet.trips[0].vehicleId, 'vehicle-one');
  assert.equal(state.fleet.trips[0].personId, undefined); assert.equal(state.fleet.profiles['vehicle-one'].nextDriver.personId, 'person-two');
  assert.equal(state.fleet.devices[0].lastEventAt, at(6));
  ingest(state, [{ id: 'earlier-start', at: '2026-10-16T10:00:30.000Z', ignition: true, odometerMeters: 119999000 }], at(16));
  assert.equal(state.fleet.trips.length, 1); assert.ok(state.fleet.telemetryQuarantine.some(value => value.reason === 'late_trip_overlap'));
});

test('live trip or unknown status blocks transfer, clock skew stays quarantined, and missing contact never asserts idle', () => {
  const state = fixture(); link(state);
  ingest(state, [{ id: 'on', at: at(1), ignition: true, odometerMeters: 20000 }]);
  atomicFailure(state, () => command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(2)), 'fleet_device_motor_unknown');
  ingest(state, [{ id: 'future-off', at: at(20), ignition: false }], at(2));
  assert.equal(state.fleet.devices[0].ignition, null); assert.equal(state.fleet.devices[0].tripState, 'unknown');
  assert.ok(state.fleet.telemetryQuarantine.some(value => value.reason === 'clock_skew'));
  atomicFailure(state, () => command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(30)), 'fleet_device_motor_unknown');
  const other = fixture(); ingest(other, [{ id: 'movement-unknown', at: at(0), movement: true }]);
  atomicFailure(other, () => command(other, 'device.link', { vehicleId: 'vehicle-one' }), 'fleet_device_motor_unknown');
});

test('unknown/private telemetry positions are never exposed, while explicitly business-classified latest points can be shown', () => {
  const state = fixture(); link(state);
  ingest(state, [{ id: 'start', at: at(1), ignition: true, lat: 59.77, lng: 18.77, rpm: 1800 },
    { id: 'stop', at: at(2), ignition: false, lat: 59.88, lng: 18.88, rpm: 0 }]);
  const serialized = () => JSON.stringify(fleetTelematicsProjection(state, principal, opts(at(2))));
  assert.equal(serialized().includes('59.88'), false); assert.equal(serialized().includes('telemetryEvents'), false);
  state.fleet.trips[0].classification = 'private'; assert.equal(serialized().includes('59.88'), false);
  state.fleet.trips[0].classification = 'business'; assert.equal(serialized().includes('59.88'), true);
  state.fleet.trips[0].classification = undefined;
  const before = structuredClone(state);
  assert.throws(() => fleetTelematicsProjection(state, { actor: admin, user: { id: 'none', level: 'Medarbetare', permissions: [] } }, opts()), { status: 403 });
  assert.deepEqual(state, before);
});

test('conflicting duplicate or forged driver/company/binding fields reject the whole telemetry batch without partial mutation', () => {
  const state = fixture(); link(state);
  ingest(state, [{ id: 'same', at: at(1), ignition: true }]);
  atomicFailure(state, () => ingest(state, [{ id: 'new-first', at: at(2), ignition: true }, { id: 'same', at: at(1), ignition: false }]), 'fleet_event_conflict');
  for (const extra of [{ personId: 'person-two' }, { vehicleId: 'vehicle-two' }, { organisationId: 'foreign' }, { classification: 'business' }])
    atomicFailure(state, () => ingest(state, [{ id: 'forged', at: at(2), ...extra }]), 'fleet_telematics_invalid');
  atomicFailure(state, () => ingestFleetTelemetry(state, { deviceId: 'device-one', source: 'device', records: [{ id: 'fake-real', at: at(2) }] }, opts(at(2))), 'fleet_device_forbidden');
});

test('manual cutoff is a separate capability, does not invent an observed stop, and old virtual odometer stays unknown', () => {
  const state = fixture(); link(state);
  ingest(state, [{ id: 'open', at: at(1), ignition: true, odometerMeters: 999000000 }]);
  const input = { action: 'device.transfer.cutoff', deviceId: 'device-one', toVehicleId: 'vehicle-two',
    expectedRevision: state.fleet.devices[0].revision, requestId: 'manual-cutoff', cutAt: at(2), reason: 'Pucken är trasig och hämtas för kontroll.' };
  atomicFailure(state, () => fleetTelematicsCommand(state, principal, input, [], opts(at(3))), undefined);
  fleetTelematicsCommand(state, principal, input, [], opts(at(3), { allowManualCutoff: true }));
  assert.equal(state.fleet.transfers[0].manual, true); assert.equal(state.fleet.trips[0].endAt, undefined);
  assert.equal(state.fleet.trips[0].quality, 'review'); assert.equal(state.fleet.trips[0].manualCutoff.observedEnd, false);
  assert.equal(state.fleet.devices[0].tripState, 'unknown');
  atomicFailure(state, () => command(state, 'device.transfer.confirm', { transferId: state.fleet.transfers[0].id }, at(4)), 'fleet_device_motor_unknown');
});

test('opposing same-instant ignition signals and exact binding boundary cannot assert a safe off or create extra trips', () => {
  const state = fixture(); link(state);
  const boundary = state.fleet.bindings[0].startAt;
  ingest(state, [{ id: 'boundary', at: boundary, ignition: true }], at(1));
  assert.equal(state.fleet.trips.length, 0); assert.ok(state.fleet.telemetryQuarantine.some(value => value.reason === 'binding_boundary'));
  ingest(state, [{ id: 'a-on', at: at(2), ignition: true }, { id: 'z-off', at: at(2), ignition: false }]);
  assert.equal(state.fleet.devices[0].tripState, 'unknown'); assert.equal(state.fleet.devices[0].ignition, null);
  atomicFailure(state, () => command(state, 'device.transfer.start', { toVehicleId: 'vehicle-two' }, at(3)), 'fleet_device_motor_unknown');
  off(state, 3); assert.equal(fleetTelematicsProjection(state, principal, opts(at(3))).devices[0].canTransfer, true);
});

test('heartbeat does not invalidate mapping CAS, but current motor checks still stop a previously offered action', () => {
  const state = fixture(); off(state);
  const expectedRevision = state.fleet.devices[0].revision;
  off(state, 1); assert.equal(state.fleet.devices[0].revision, expectedRevision);
  const input = { action: 'device.link', deviceId: 'device-one', vehicleId: 'vehicle-one', expectedRevision, requestId: 'heartbeat-cas' };
  fleetTelematicsCommand(state, principal, input, [], opts(at(2)));
  const offeredRevision = state.fleet.devices[0].revision;
  ingest(state, [{ id: 'suddenly-on', at: at(3), ignition: true }]);
  atomicFailure(state, () => fleetTelematicsCommand(state, principal, { action: 'device.transfer.start', deviceId: 'device-one',
    toVehicleId: 'vehicle-two', expectedRevision: offeredRevision, requestId: 'after-start' }, [], opts(at(4))), 'fleet_device_motor_unknown');
});

test('employee contact projection only includes current permitted vehicle and never carries an old vehicle position through transfer', () => {
  const state = fixture(); link(state); assign(state, 'device-two'); off(state, 0, 'device-two');
  command(state, 'device.link', { deviceId: 'device-two', vehicleId: 'vehicle-two' }, at(1));
  ingest(state, [{ id: 'start', at: at(1), ignition: true, lat: 59.1, lng: 18.1 },
    { id: 'stop', at: at(2), ignition: false, lat: 59.2, lng: 18.2 }]);
  state.fleet.trips[0].classification = 'business';
  const own = fleetEmployeeTelematicsProjection(state, ['vehicle-one'], opts(at(2)));
  assert.equal(own.devices.length, 1); assert.equal(own.devices[0].vehicleId, 'vehicle-one');
  assert.equal(own.devices[0].latestPosition.lat, 59.2); assert.equal(Object.hasOwn(own.devices[0], 'revision'), false);
  assert.equal(Object.hasOwn(own, 'transfers'), false); assert.equal(JSON.stringify(own).includes('vehicle-two'), false);
  assert.deepEqual(fleetEmployeeTelematicsProjection(state, [], opts()), { devices: [] });
  command(state, 'device.transfer.start', { toVehicleId: 'vehicle-three' }, at(3));
  assert.equal(fleetTelematicsProjection(state, principal, opts(at(3))).devices.find(value => value.id === 'device-one').latestPosition, undefined);
  assert.equal(fleetEmployeeTelematicsProjection(state, ['vehicle-one'], opts(at(3))).devices.length, 0);
});

test('a fresh next-trip app driver is snapshotted once, later default changes never rewrite that trip', () => {
  const state = fixture(); link(state);
  state.fleet.profiles['vehicle-one'].nextDriver = { personId: 'person-two', source: 'app', selectedAt: at(0) };
  ingest(state, [{ id: 'app-start', at: at(1), ignition: true, odometerMeters: 3000 }]);
  const first = structuredClone(state.fleet.trips[0]);
  assert.equal(first.personId, 'person-two'); assert.equal(first.driverSource, 'app'); assert.equal(state.fleet.profiles['vehicle-one'].nextDriver, undefined);
  state.fleet.profiles['vehicle-one'].defaultDriverId = 'person-one';
  ingest(state, [{ id: 'app-end', at: at(2), ignition: false, odometerMeters: 4000 }]);
  assert.equal(state.fleet.trips[0].personId, 'person-two'); assert.equal(state.fleet.trips[0].startAt, first.startAt);
  assert.equal(state.fleet.trips[0].driverSource, 'app');
});
