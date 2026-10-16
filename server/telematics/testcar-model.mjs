import { createHash } from 'node:crypto';
import { decodeCodec8EFrame, encodeRecordAck } from './codec8e.mjs';
import { projectTrips } from './trips.mjs';
import { createVirtualFmc003 } from './virtual-fmc003.mjs';
export { encodeSyntheticFmc003Frame as encodeSyntheticTestCarFrame } from './virtual-fmc003.mjs';

// Fictional destinations on real coordinates near Norrtälje. These hand-drawn
// polylines are for a synthetic demonstration, not navigational instructions.
const PLACES = [
  { id: 'office', name: 'Kontoret', subtitle: 'Påhittat kontor · Norrtälje', lat: 59.76035, lng: 18.70412 },
  { id: 'customer1', name: 'Kund 1', subtitle: 'Påhittad kund · söder om Norrtälje', lat: 59.72975, lng: 18.71182 },
  { id: 'customer2', name: 'Kund 2', subtitle: 'Påhittad kund · väster om Norrtälje', lat: 59.7799, lng: 18.6368 },
  { id: 'home', name: 'Hem', subtitle: 'Påhittad bostad · norr om Norrtälje', lat: 59.8002, lng: 18.7055 },
];
const POINT = (lat, lng) => ({ lat, lng });
const COORDINATE = place => POINT(place.lat, place.lng);
const SPOKES = {
  office: [COORDINATE(PLACES[0])],
  customer1: [COORDINATE(PLACES[0]), POINT(59.7583, 18.6999), POINT(59.7525, 18.699), POINT(59.7495, 18.7105), POINT(59.743, 18.7134), POINT(59.7365, 18.705), COORDINATE(PLACES[1])],
  customer2: [COORDINATE(PLACES[0]), POINT(59.7615, 18.692), POINT(59.765, 18.679), POINT(59.7705, 18.665), POINT(59.778, 18.65), COORDINATE(PLACES[2])],
  home: [COORDINATE(PLACES[0]), POINT(59.765, 18.701), POINT(59.773, 18.7055), POINT(59.78, 18.7128), POINT(59.787, 18.707), POINT(59.794, 18.702), COORDINATE(PLACES[3])],
};
const INITIAL_ODOMETER_METERS = 124583000;
const TANK_LITERS = 60;
const MEMORY_RECORD_LIMIT = 1000;

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const samePoint = (a, b) => Math.abs(a.lat - b.lat) < 1e-10 && Math.abs(a.lng - b.lng) < 1e-10;
const radians = degrees => degrees * Math.PI / 180;
function metersBetween(a, b) {
  const sinLat = Math.sin(radians(b.lat - a.lat) / 2);
  const sinLng = Math.sin(radians(b.lng - a.lng) / 2);
  return 6371000 * 2 * Math.asin(Math.sqrt(clamp(sinLat ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * sinLng ** 2, 0, 1)));
}
function bearing(a, b) {
  const difference = radians(b.lng - a.lng);
  const y = Math.sin(difference) * Math.cos(radians(b.lat));
  const x = Math.cos(radians(a.lat)) * Math.sin(radians(b.lat)) - Math.sin(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.cos(difference);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function validateCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail(422, 'TESTCAR_INVALID_COMMAND', 'Välj ett giltigt kommando för testbilen.');
  }
  const allowed = {
    start: ['action'], stop: ['action'], pause: ['action'], reset: ['action'],
    drive: ['action', 'destination'], network: ['action', 'online'], speed: ['action', 'timeScale'],
  };
  if (!Object.hasOwn(allowed, input.action) || Object.keys(input).some(key => !allowed[input.action].includes(key))) {
    fail(422, 'TESTCAR_INVALID_COMMAND', 'Kommandot innehåller ogiltiga fält.');
  }
  if (input.action === 'drive' && !PLACES.some(place => place.id === input.destination)) {
    fail(422, 'TESTCAR_INVALID_DESTINATION', 'Välj Kontoret, Kund 1, Kund 2 eller Hem.');
  }
  if (input.action === 'network' && typeof input.online !== 'boolean') {
    fail(422, 'TESTCAR_INVALID_NETWORK', 'Ange om testbilens nätverk ska vara anslutet.');
  }
  if (input.action === 'speed' && ![1, 5, 10].includes(input.timeScale)) {
    fail(422, 'TESTCAR_INVALID_SPEED', 'Simuleringshastigheten måste vara 1×, 5× eller 10×.');
  }
}

/** An isolated in-memory demonstration: no socket, database, CRM or real device. */
export function createTestCar({ now = () => new Date(), random = Math.random } = {}) {
  let state;
  let device;
  let revision = 0;
  let sequence = 0;
  function wallTime() {
    const result = new Date(now());
    if (!Number.isFinite(result.getTime())) throw new TypeError('Test-car clock must return a valid date');
    return result;
  }
  function randomUnit() {
    try { const value = random(); return Number.isFinite(value) ? clamp(value, 0, 1) : 0.5; }
    catch { return 0.5; }
  }
  function initialize() {
    const clockMs = wallTime().getTime();
    state = {
      clockMs,
      engineOn: false, mode: 'off', timeScale: 10, networkOnline: true,
      currentPlaceId: 'office', position: COORDINATE(PLACES[0]), route: null,
      speedKmh: 0, rpm: 0, coolantC: 18, fuelLiters: TANK_LITERS * 0.68,
      fuelRateLh: 0, batteryVolts: 12.6, odometerMeters: INITIAL_ODOMETER_METERS,
      received: [], dedupe: new Map(), events: [], trips: [], speedHistory: [],
      recordsReceived: 0, packetsReceived: 0, lastReceivedAt: null, receiverOdometer: INITIAL_ODOMETER_METERS,
      receiverTripActive: false, receiverCompletedTrips: 0,
    };
    sequence = 0;
    device = createVirtualFmc003({
      initialAt: new Date(clockMs), receivePacket: receive,
      onSample(sample) {
        state.speedHistory.push({ at: sample.at, value: round(sample.speedKmh, 1) });
        state.speedHistory = state.speedHistory.slice(-60);
      },
    });
  }
  initialize();
  const iso = () => new Date(state.clockMs).toISOString();
  function event(text, type = 'info') {
    state.events.unshift({ id: `testcar-event-${++sequence}`, at: iso(), text, type });
    state.events = state.events.slice(0, 15);
  }
  function receive(packet) {
    // Genuine Codec 8E bytes pass the existing strict decoder before any record
    // is counted as received. ACK counts all accepted records, including repeats.
    const { records } = decodeCodec8EFrame(packet);
    state.packetsReceived += 1;
    for (const record of records) {
      const hash = createHash('sha256').update(JSON.stringify(record)).digest('hex');
      if (state.dedupe.has(hash)) continue;
      state.dedupe.set(hash, true);
      if (state.dedupe.size > MEMORY_RECORD_LIMIT) state.dedupe.delete(state.dedupe.keys().next().value);
      const odometerMeters = parseInt(record.io[16], 16);
      const minimal = { id: `synthetic-${hash}`, at: record.at, source: 'tracker', ignition: record.io[239] === '01', movement: record.io[240] === '01', odometerMeters };
      state.received.push(minimal);
      state.recordsReceived += 1;
      state.receiverOdometer = Math.max(state.receiverOdometer, odometerMeters);
      const tripActive = record.io[250] === '01';
      if (state.receiverTripActive && !tripActive) state.receiverCompletedTrips += 1;
      state.receiverTripActive = tripActive;
    }
    state.received = state.received.slice(-MEMORY_RECORD_LIMIT);
    // The real trip projection receives only its permitted fields, never GPS.
    const engineTrips = projectTrips(state.received);
    if (engineTrips.some(trip => trip.reviewReasons.includes('odometer-reset'))) {
      event('Den syntetiska mottagaren upptäckte ett mätarhopp.', 'warning');
    }
    state.lastReceivedAt = wallTime().toISOString();
    return encodeRecordAck(records.length);
  }
  function carTelemetry() {
    return {
      lat: state.position.lat, lng: state.position.lng, angle: state.route?.angle ?? 0,
      speedKmh: state.speedKmh, rpm: state.rpm, coolantC: state.coolantC,
      fuelPercent: state.fuelLiters / TANK_LITERS * 100, fuelRateLh: state.fuelRateLh,
      batteryVolts: state.batteryVolts, engineOn: state.engineOn,
      tripActive: Boolean(state.route?.active), odometerMeters: state.odometerMeters,
    };
  }
  function warnBuffer() {
    if (device.snapshot().droppedRecords && !state.events.some(entry => entry.text.includes('bufferten är full'))) {
      event('Den syntetiska bufferten är full. Äldsta väntande posten har tagits bort.', 'warning');
    }
  }
  function capture({ eventIoId = 0, immediate = false } = {}) {
    device.capture(carTelemetry(), { at: iso(), eventIoId, immediate });
    warnBuffer();
  }
  function placeName() {
    return PLACES.find(place => place.id === state.currentPlaceId)?.name ?? 'Längs vägen…';
  }
  function endJourney(completed) {
    const route = state.route;
    if (!route?.active) return;
    const trip = state.trips.find(item => item.id === route.tripId);
    if (trip) {
      trip.endedAt = iso();
      trip.distanceKm = round((state.odometerMeters - route.startOdometer) / 1000, 3);
      trip.durationSeconds = round((state.clockMs - Date.parse(trip.startedAt)) / 1000, 1);
      trip.completed = completed;
    }
    route.active = false;
  }
  function beginRoute(destinationId) {
    const destination = PLACES.find(place => place.id === destinationId);
    let points;
    if (state.currentPlaceId) {
      const backToOffice = [...SPOKES[state.currentPlaceId]].reverse();
      points = [...backToOffice, ...SPOKES[destinationId].slice(1)];
    } else if (state.route) {
      // For a redirection, retrace the current synthetic route to its original
      // hub, then take the destination's spoke. Never teleport to a place.
      const previous = state.route;
      const prefix = previous.points.slice(0, previous.segment + 1).reverse();
      points = [COORDINATE(state.position), ...prefix];
      const originSpoke = SPOKES[previous.originPlaceId ?? 'office'];
      if (previous.originPlaceId && previous.originPlaceId !== 'office') points.push(...originSpoke.slice(0, -1).reverse());
      points.push(...SPOKES[destinationId].slice(1));
    } else {
      points = [COORDINATE(state.position), ...SPOKES[destinationId]];
    }
    points = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]));
    const lengths = points.slice(1).map((point, index) => metersBetween(points[index], point));
    const totalMeters = lengths.reduce((sum, length) => sum + length, 0);
    const tripId = `testcar-trip-${++sequence}`;
    const originPlaceId = state.currentPlaceId;
    const from = placeName();
    state.route = {
      points, lengths, totalMeters, movedMeters: 0, segment: 0, segmentMoved: 0,
      destinationId, originPlaceId, tripId, active: true,
      startOdometer: state.odometerMeters, cruiseKmh: clamp(totalMeters / 1000 * 5, 35, 55),
      angle: bearing(points[0], points[1]),
    };
    state.trips.unshift({ id: tripId, from, to: destination.name, startedAt: iso(), endedAt: null, distanceKm: 0, durationSeconds: 0, completed: false });
    state.trips = state.trips.slice(0, 10);
    state.currentPlaceId = null;
    state.mode = 'driving';
    event(`Testbilen kör mot ${destination.name}.`);
    capture({ eventIoId: 250, immediate: true });
  }
  function advancePosition(meters) {
    const route = state.route;
    const actual = Math.min(meters, route.totalMeters - route.movedMeters);
    route.movedMeters += actual;
    state.odometerMeters += actual;
    let remaining = actual;
    while (remaining > 0 && route.segment < route.lengths.length) {
      const available = route.lengths[route.segment] - route.segmentMoved;
      const step = Math.min(remaining, available);
      route.segmentMoved += step;
      remaining -= step;
      const start = route.points[route.segment];
      const end = route.points[route.segment + 1];
      const progress = clamp(route.segmentMoved / route.lengths[route.segment], 0, 1);
      state.position = POINT(start.lat + (end.lat - start.lat) * progress, start.lng + (end.lng - start.lng) * progress);
      route.angle = bearing(start, end);
      if (route.segmentMoved >= route.lengths[route.segment] - 1e-8) {
        state.position = COORDINATE(end);
        route.segment += 1;
        route.segmentMoved = 0;
      }
    }
    if (route.totalMeters - route.movedMeters < 1e-6) {
      const destination = PLACES.find(place => place.id === route.destinationId);
      state.position = COORDINATE(destination);
      state.currentPlaceId = destination.id;
      state.speedKmh = 0;
      state.rpm = 780;
      state.mode = 'idling';
      endJourney(true);
      event(`Framme vid ${destination.name}. Motorn går på tomgång.`, 'success');
      capture({ eventIoId: 250, immediate: true });
    }
  }
  function advanceStep(milliseconds) {
    const seconds = milliseconds / 1000;
    state.clockMs += milliseconds;
    if (state.mode === 'driving' && state.route?.active) {
      const oldSpeed = state.speedKmh;
      const remainingMeters = state.route.totalMeters - state.route.movedMeters;
      const target = Math.min(state.route.cruiseKmh + (randomUnit() - 0.5) * 3, Math.sqrt(2 * 1.5 * remainingMeters) * 3.6);
      state.speedKmh = clamp(target, Math.max(0, oldSpeed - 5.4 * seconds), Math.min(55, oldSpeed + 5.4 * seconds));
      state.rpm = round(900 + state.speedKmh * 35 + (randomUnit() - 0.5) * 40, 0);
      advancePosition((oldSpeed + state.speedKmh) / 2 / 3.6 * seconds);
    } else {
      state.speedKmh = 0;
      state.rpm = state.engineOn ? 780 : 0;
    }
    if (state.engineOn) {
      state.fuelRateLh = state.speedKmh > 0 ? 3 + state.speedKmh * 0.11 : 0.8;
      state.fuelLiters = Math.max(0, state.fuelLiters - state.fuelRateLh * seconds / 3600);
      state.coolantC = Math.min(91, state.coolantC + 0.085 * seconds);
      state.batteryVolts = 14.2;
    } else {
      state.fuelRateLh = 0;
      state.coolantC = Math.max(18, state.coolantC - 0.02 * seconds);
      state.batteryVolts = 12.6;
    }
  }
  function snapshot() {
    const deviceView = device.snapshot();
    const route = state.route;
    let routeView = null;
    if (route) {
      const traveled = route.points.slice(0, Math.min(route.segment + 1, route.points.length)).map(COORDINATE);
      if (!traveled.length || !samePoint(traveled.at(-1), state.position)) traveled.push(COORDINATE(state.position));
      routeView = {
        points: route.points.map(COORDINATE), traveled,
        distanceKm: round(route.totalMeters / 1000, 3), remainingKm: round(Math.max(0, route.totalMeters - route.movedMeters) / 1000, 3),
        progress: clamp(route.movedMeters / route.totalMeters, 0, 1),
        etaSeconds: route.active ? Math.ceil((route.totalMeters - route.movedMeters) / (route.cruiseKmh / 3.6)) : 0,
      };
    }
    const trips = state.trips.map(trip => trip.endedAt ? { ...trip } : {
      ...trip, distanceKm: round((state.odometerMeters - route.startOdometer) / 1000, 3),
      durationSeconds: round((state.clockMs - Date.parse(trip.startedAt)) / 1000, 1),
    });
    return {
      simulated: true, id: 'testbil1', name: 'Testbil 01', deviceModel: 'Virtuell FMC003',
      engineOn: state.engineOn, mode: state.mode, timeScale: state.timeScale, simulatedAt: iso(),
      currentPlace: { id: state.currentPlaceId, name: placeName(), ...COORDINATE(state.position) },
      destinations: PLACES.map(place => ({ ...place })),
      destinationId: route?.destinationId ?? null, route: routeView,
      telemetry: {
        speedKmh: round(state.speedKmh, 1), rpm: Math.round(state.rpm), fuelPercent: round(state.fuelLiters / TANK_LITERS * 100, 1),
        fuelLiters: round(state.fuelLiters, 2), coolantC: round(state.coolantC, 1), batteryVolts: round(state.batteryVolts, 2),
        odometerKm: round(state.odometerMeters / 1000, 3),
      },
      driver: { name: 'Niklas', source: 'default' },
      stats: {
        recordsReceived: state.recordsReceived, packetsReceived: state.packetsReceived, pendingRecords: deviceView.pendingRecords,
        distanceKm: round((state.receiverOdometer - INITIAL_ODOMETER_METERS) / 1000, 3), trips: state.receiverCompletedTrips, lastReceivedAt: state.lastReceivedAt,
      },
      events: state.events.map(entry => ({ ...entry })), trips,
      speedHistory: state.speedHistory.map(point => ({ ...point })), networkOnline: state.networkOnline, revision,
      device: deviceView,
    };
  }
  function command(input) {
    validateCommand(input);
    if (input.action === 'start' && state.engineOn) fail(409, 'TESTCAR_ALREADY_RUNNING', 'Testbilens motor är redan startad.');
    if (input.action === 'stop' && !state.engineOn) fail(409, 'TESTCAR_ALREADY_STOPPED', 'Testbilens motor är redan avstängd.');
    if (input.action === 'pause' && state.mode !== 'driving') fail(409, 'TESTCAR_NOT_DRIVING', 'Testbilen behöver köra innan den kan pausas.');
    if (input.action === 'drive') {
      if (!state.engineOn) fail(409, 'TESTCAR_ENGINE_OFF', 'Starta motorn innan du kör testbilen.');
      const target = PLACES.find(place => place.id === input.destination);
      if (state.currentPlaceId === input.destination || metersBetween(state.position, target) < 1) fail(409, 'TESTCAR_ALREADY_AT_DESTINATION', 'Testbilen är redan på den valda platsen.');
      if (state.mode === 'driving' && state.route?.destinationId === input.destination) fail(409, 'TESTCAR_ALREADY_DRIVING', 'Testbilen kör redan mot den valda platsen.');
    }
    if (input.action === 'reset') {
      initialize();
      event('Den syntetiska testbilen har återställts.', 'success');
    } else {
      // Separate immediate event timestamps, even when several commands arrive
      // before the next scheduler tick. Validation above leaves failures atomic.
      state.clockMs += 1;
      if (input.action === 'start') {
        state.engineOn = true; state.mode = 'idling'; state.rpm = 780; state.fuelRateLh = 0.8; state.batteryVolts = 14.2;
        event('Testbilens motor har startats.'); capture({ eventIoId: 239, immediate: true });
      } else if (input.action === 'stop') {
        endJourney(false); state.engineOn = false; state.mode = 'off'; state.speedKmh = 0; state.rpm = 0; state.fuelRateLh = 0; state.batteryVolts = 12.6;
        event('Testbilens motor har stängts av.'); capture({ eventIoId: 239, immediate: true });
      } else if (input.action === 'pause') {
        state.mode = 'paused'; state.speedKmh = 0; state.rpm = 780; state.fuelRateLh = 0.8;
        event('Testbilens körning är pausad. Motorn går på tomgång.'); capture({ eventIoId: 240, immediate: true });
      } else if (input.action === 'drive') {
        if (state.mode === 'paused' && state.route?.active && state.route.destinationId === input.destination) {
          state.mode = 'driving'; event('Testbilen fortsätter från sin nuvarande position.'); capture({ eventIoId: 240, immediate: true });
        } else {
          endJourney(false); beginRoute(input.destination);
        }
      } else if (input.action === 'network') {
        const changed = state.networkOnline !== input.online;
        state.networkOnline = input.online;
        if (changed) event(input.online ? 'Nätverket är anslutet. Väntande syntetiska poster skickas.' : 'Nätverket är frånkopplat. Syntetiska poster sparas i minnet.', input.online ? 'success' : 'warning');
        device.setOnline(input.online, iso());
      } else if (input.action === 'speed') {
        state.timeScale = input.timeScale; event(`Simuleringshastigheten är ${input.timeScale}×.`);
      }
      device.advanceTo(iso(), carTelemetry);
    }
    revision += 1;
    return snapshot();
  }
  function tick(realSeconds = 1) {
    if (typeof realSeconds !== 'number' || !Number.isFinite(realSeconds) || realSeconds < 0 || realSeconds > 3600) {
      fail(422, 'TESTCAR_INVALID_TICK', 'Tidssteget måste vara mellan 0 och 3 600 sekunder.');
    }
    let remainingMs = Math.round(realSeconds * state.timeScale * 1000);
    if (!remainingMs) return snapshot();
    while (remainingMs > 0) {
      const step = Math.min(remainingMs, 1000, Math.max(1, device.nextEventAt() - state.clockMs));
      advanceStep(step); remainingMs -= step;
      device.advanceTo(iso(), carTelemetry);
      warnBuffer();
    }
    revision += 1;
    return snapshot();
  }
  return { snapshot, command, tick };
}
