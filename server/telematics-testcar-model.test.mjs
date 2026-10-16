import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestCar, encodeSyntheticTestCarFrame } from './telematics/testcar-model.mjs';
import { decodeCodec8EFrame } from './telematics/codec8e.mjs';

const START = '2026-10-16T08:00:00.000Z';
const fixture = () => createTestCar({ now: () => new Date(START), random: () => 0.5 });
function arrive(car, destination) {
  car.command({ action: 'drive', destination });
  let seconds = 0;
  while (car.snapshot().mode === 'driving' && seconds < 120) { car.tick(); seconds += 1; }
  assert.equal(car.snapshot().mode, 'idling');
  return seconds;
}
function commandFailsAtomically(car, command, status, code) {
  const before = car.snapshot();
  assert.throws(() => car.command(command), error => error.status === status && error.code === code && typeof error.message === 'string');
  assert.deepEqual(car.snapshot(), before);
}
function meters(a, b) {
  const r = value => value * Math.PI / 180;
  return 12742000 * Math.asin(Math.sqrt(Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2));
}

test('initial synthetic state, strict command validation and per-instance isolation', () => {
  const car = fixture();
  const initial = car.snapshot();
  assert.equal(initial.simulated, true);
  assert.equal(initial.id, 'testbil1');
  assert.equal(initial.deviceModel, 'Virtuell FMC003');
  assert.equal(initial.engineOn, false);
  assert.equal(initial.mode, 'off');
  assert.equal(initial.currentPlace.id, 'office');
  assert.equal(initial.timeScale, 10);
  assert.equal(initial.telemetry.fuelPercent, 68);
  assert.equal(initial.telemetry.odometerKm, 124583);
  assert.equal(initial.stats.recordsReceived, 0);
  commandFailsAtomically(car, { action: 'drive', destination: 'customer1' }, 409, 'TESTCAR_ENGINE_OFF');
  commandFailsAtomically(car, { action: 'drive', destination: 'unknown' }, 422, 'TESTCAR_INVALID_DESTINATION');
  commandFailsAtomically(car, { action: 'start', tenantId: 'real-company' }, 422, 'TESTCAR_INVALID_COMMAND');
  commandFailsAtomically(car, { action: 'speed', timeScale: 100 }, 422, 'TESTCAR_INVALID_SPEED');
  commandFailsAtomically(car, { action: 'network', online: 'false' }, 422, 'TESTCAR_INVALID_NETWORK');
  car.command({ action: 'start' });
  assert.deepEqual(fixture().snapshot(), initial);
  const copy = car.snapshot(); copy.currentPlace.lat = 0; copy.destinations[0].name = 'Changed';
  assert.notEqual(car.snapshot().currentPlace.lat, 0);
  assert.equal(car.snapshot().destinations[0].name, 'Kontoret');
});

test('engine start idles, captures immediate packets, and separates record/send periods', () => {
  const car = fixture();
  let state = car.command({ action: 'start' });
  assert.equal(state.engineOn, true); assert.equal(state.mode, 'idling');
  assert.equal(state.telemetry.speedKmh, 0); assert.equal(state.telemetry.rpm, 780);
  assert.equal(state.stats.recordsReceived, 1); assert.equal(state.stats.packetsReceived, 1);
  commandFailsAtomically(car, { action: 'drive', destination: 'office' }, 409, 'TESTCAR_ALREADY_AT_DESTINATION');
  car.tick(1.5);
  state = car.snapshot();
  assert.equal(state.stats.pendingRecords, 1);
  assert.equal(state.stats.recordsReceived, 1);
  car.tick(1.5);
  state = car.snapshot();
  assert.equal(state.stats.pendingRecords, 0);
  assert.equal(state.stats.recordsReceived, 3);
  assert.equal(state.stats.packetsReceived, 2);
  assert.equal(state.stats.lastReceivedAt, START);
});

test('routes arrive at exact destination coordinates in 40–90 real seconds with consistent distance', () => {
  for (const destination of ['customer1', 'customer2', 'home']) {
    const car = fixture(); car.command({ action: 'start' });
    const seconds = arrive(car, destination);
    const state = car.snapshot();
    assert.ok(seconds >= 40 && seconds <= 90, `${destination}: ${seconds}s`);
    const target = state.destinations.find(place => place.id === destination);
    assert.deepEqual(state.currentPlace, { id: destination, name: target.name, lat: target.lat, lng: target.lng });
    assert.equal(state.engineOn, true);
    assert.equal(state.telemetry.speedKmh, 0);
    assert.equal(state.route.progress, 1);
    assert.equal(state.route.remainingKm, 0);
    const polylineKm = state.route.points.slice(1).reduce((sum, point, index) => sum + meters(state.route.points[index], point), 0) / 1000;
    assert.ok(Math.abs(polylineKm - state.route.distanceKm) < 0.001);
    assert.ok(Math.abs(state.telemetry.odometerKm - 124583 - polylineKm) < 0.001);
    assert.ok(Math.abs(state.stats.distanceKm - polylineKm) < 0.001);
    assert.equal(state.stats.trips, 1);
    assert.equal(state.trips[0].completed, true);
    assert.ok(state.telemetry.fuelPercent < 68);
    commandFailsAtomically(car, { action: 'drive', destination }, 409, 'TESTCAR_ALREADY_AT_DESTINATION');
  }
});

test('pause/stop retain mid-route position; resume continues without teleport or a duplicate journey', () => {
  const car = fixture(); car.command({ action: 'start' }); car.command({ action: 'drive', destination: 'customer1' });
  // Starting a route already clears the old location label, but a zero-distance
  // reversal must still fail before changing the existing journey.
  commandFailsAtomically(car, { action: 'drive', destination: 'office' }, 409, 'TESTCAR_ALREADY_AT_DESTINATION');
  car.tick(10);
  const moving = car.snapshot();
  assert.equal(moving.currentPlace.id, null); assert.match(moving.currentPlace.name, /Längs vägen/);
  assert.ok(moving.telemetry.speedKmh >= 30 && moving.telemetry.speedKmh <= 55);
  car.command({ action: 'pause' }); car.tick(10);
  const paused = car.snapshot();
  assert.equal(paused.mode, 'paused'); assert.equal(paused.engineOn, true);
  assert.deepEqual(paused.currentPlace, moving.currentPlace);
  assert.equal(paused.telemetry.odometerKm, moving.telemetry.odometerKm);
  assert.equal(paused.stats.trips, 0);
  assert.ok(paused.telemetry.fuelLiters < moving.telemetry.fuelLiters);
  car.command({ action: 'drive', destination: 'customer1' });
  assert.deepEqual(car.snapshot().currentPlace, paused.currentPlace);
  assert.equal(car.snapshot().trips.length, 1);
  car.tick(5);
  car.command({ action: 'stop' });
  const stopped = car.snapshot();
  assert.equal(stopped.mode, 'off'); assert.equal(stopped.engineOn, false);
  assert.equal(stopped.currentPlace.id, null);
  assert.equal(stopped.telemetry.rpm, 0);
  assert.equal(stopped.trips[0].completed, false);
  assert.notEqual(stopped.trips[0].endedAt, null);
  const position = stopped.currentPlace;
  car.tick(20); assert.deepEqual(car.snapshot().currentPlace, position);
  car.command({ action: 'start' });
  car.command({ action: 'drive', destination: 'office' });
  assert.deepEqual(car.snapshot().currentPlace, position);
});

test('offline records wait for reconnect, flush once through bounded packets and leave other cars untouched', () => {
  const car = fixture(); const other = fixture();
  car.command({ action: 'network', online: false });
  car.command({ action: 'start' });
  car.command({ action: 'drive', destination: 'customer2' });
  car.tick(20);
  const offline = car.snapshot();
  assert.equal(offline.stats.recordsReceived, 0);
  assert.equal(offline.stats.lastReceivedAt, null);
  assert.ok(offline.stats.pendingRecords > 10);
  assert.equal(offline.stats.distanceKm, 0);
  assert.ok(offline.telemetry.odometerKm > 124583);
  const online = car.command({ action: 'network', online: true });
  assert.equal(online.stats.recordsReceived, offline.stats.pendingRecords);
  assert.equal(online.stats.pendingRecords, 0);
  assert.ok(online.stats.distanceKm > 1);
  car.command({ action: 'network', online: true });
  assert.equal(car.snapshot().stats.recordsReceived, online.stats.recordsReceived);
  assert.equal(car.snapshot().stats.packetsReceived, online.stats.packetsReceived);
  assert.equal(other.snapshot().stats.recordsReceived, 0);
});

test('memory buffers and visible histories stay bounded and reset clears all synthetic data', () => {
  const car = fixture(); car.command({ action: 'network', online: false }); car.command({ action: 'start' });
  car.tick(1600);
  let state = car.snapshot();
  assert.equal(state.stats.pendingRecords, 1000);
  assert.equal(state.speedHistory.length, 60);
  assert.ok(state.events.some(entry => /bufferten är full/.test(entry.text)));
  state = car.command({ action: 'network', online: true });
  assert.equal(state.stats.recordsReceived, 1000);
  assert.equal(state.stats.packetsReceived, 10);
  for (let index = 0; index < 20; index += 1) car.command({ action: 'speed', timeScale: index % 2 ? 5 : 10 });
  assert.equal(car.snapshot().events.length, 15);
  const revision = car.snapshot().revision;
  state = car.command({ action: 'reset' });
  assert.ok(state.revision > revision);
  assert.equal(state.mode, 'off'); assert.equal(state.currentPlace.id, 'office');
  assert.equal(state.stats.recordsReceived, 0); assert.equal(state.stats.pendingRecords, 0);
  assert.equal(state.trips.length, 0); assert.equal(state.speedHistory.length, 0);
  assert.equal(state.telemetry.fuelPercent, 68); assert.equal(state.telemetry.odometerKm, 124583);
});

test('time-scale choices affect virtual elapsed time without corrupting rejected ticks', () => {
  const car = fixture(); car.command({ action: 'speed', timeScale: 1 });
  let before = Date.parse(car.snapshot().simulatedAt); car.tick(2);
  assert.equal(Date.parse(car.snapshot().simulatedAt) - before, 2000);
  car.command({ action: 'speed', timeScale: 5 }); before = Date.parse(car.snapshot().simulatedAt); car.tick(2);
  assert.equal(Date.parse(car.snapshot().simulatedAt) - before, 10000);
  const state = car.snapshot();
  for (const seconds of [-1, Infinity, NaN, '2', 3601]) assert.throws(() => car.tick(seconds), error => error.status === 422);
  assert.deepEqual(car.snapshot(), state);
});

test('synthetic FMC003 packets preserve AVL units and are rejected by the strict decoder after corruption', () => {
  const sample = {
    simulated: true, at: START, lat: 59.76035, lng: 18.70412, angle: 90,
    engineOn: true, tripActive: true, speedKmh: 45, rpm: 1800, coolantC: -5,
    fuelPercent: 68, fuelRateLh: 7.25, batteryVolts: 14.2, odometerMeters: 124583456,
  };
  const packet = encodeSyntheticTestCarFrame([sample]);
  const { records: [decoded] } = decodeCodec8EFrame(packet);
  assert.equal(decoded.gps.latitude, sample.lat); assert.equal(decoded.gps.longitude, sample.lng);
  assert.equal(decoded.gps.speedKmh, 45);
  assert.equal(parseInt(decoded.io[36], 16), 1800);
  assert.equal(Buffer.from(decoded.io[32], 'hex').readInt8(), -5);
  assert.equal(parseInt(decoded.io[48], 16), 68);
  assert.equal(parseInt(decoded.io[60], 16) / 100, 7.25);
  assert.equal(parseInt(decoded.io[16], 16), sample.odometerMeters);
  assert.equal(decoded.io[239], '01'); assert.equal(decoded.io[240], '01');
  packet[packet.length - 1] ^= 1;
  assert.throws(() => decodeCodec8EFrame(packet), error => error.code === 'TELEMATICS_CODEC_INVALID');
  assert.throws(() => encodeSyntheticTestCarFrame([{ ...sample, simulated: false }]), TypeError);
});
