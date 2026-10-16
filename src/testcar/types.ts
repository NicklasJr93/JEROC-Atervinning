export type PlaceId = 'office' | 'customer1' | 'customer2' | 'home';
export type TimeScale = 1 | 5 | 10;
export type CarMode = 'off' | 'idling' | 'driving' | 'paused';
export type TestCarAction = 'start' | 'stop' | 'drive' | 'pause' | 'reset' | 'network' | 'speed';

export interface MapPoint { lat: number; lng: number }
export interface Destination extends MapPoint { id: PlaceId; name: string; subtitle: string }
export interface TestCarEvent { id: string; at: string; text: string; type: 'info' | 'success' | 'warning' }

export interface TestCarReceiverRecord extends MapPoint {
  at: string;
  speedKmh: number;
  rpm?: number;
  fuelPercent?: number;
  coolantC?: number;
  batteryVolts?: number;
  odometerMeters?: number;
  ignition?: boolean;
  movement?: boolean;
}

export interface TestCarReceiver {
  channel: 'separate_http' | 'internal_memory';
  transport: 'http' | 'in_process';
  status: 'ready' | 'unavailable' | 'unknown';
  durable: boolean;
  storage: 'sqlite' | 'postgres' | null;
  recordsStored: number;
  lastReceivedAt: string | null;
  lastRecord: TestCarReceiverRecord | null;
  recentRecords: TestCarReceiverRecord[];
  lastError: string | null;
}

export interface TestCarSnapshot {
  simulated: true;
  id: string;
  name: string;
  deviceModel: string;
  engineOn: boolean;
  mode: CarMode;
  timeScale: TimeScale;
  simulatedAt: string;
  currentPlace: MapPoint & { id: PlaceId | null; name: string };
  destinations: Destination[];
  destinationId: PlaceId | null;
  route: null | {
    points: MapPoint[];
    traveled: MapPoint[];
    distanceKm: number;
    remainingKm: number;
    progress: number;
    etaSeconds: number;
  };
  telemetry: {
    speedKmh: number;
    rpm: number;
    fuelPercent: number;
    fuelLiters: number;
    coolantC: number;
    batteryVolts: number;
    odometerKm: number;
  };
  driver: { name: string; source: 'default' };
  stats: {
    recordsReceived: number;
    packetsReceived: number;
    pendingRecords: number;
    distanceKm: number;
    trips: number;
    lastReceivedAt: string | null;
  };
  events: TestCarEvent[];
  trips: Array<{
    id: string;
    from: string;
    to: string;
    startedAt: string;
    endedAt: string | null;
    distanceKm: number;
    durationSeconds: number;
    completed: boolean;
  }>;
  speedHistory: Array<{ at: string; value: number }>;
  networkOnline: boolean;
  revision: number;
  receiver?: TestCarReceiver;
}

export interface TestCarCommand {
  action: TestCarAction;
  destination?: PlaceId;
  online?: boolean;
  timeScale?: TimeScale;
}

export function currentPlaceName(car: TestCarSnapshot) {
  return car.currentPlace.id === null ? 'Längs vägen' : car.currentPlace.name;
}

const placeIds = new Set<unknown>(['office', 'customer1', 'customer2', 'home']);
const isPoint = (value: unknown): value is MapPoint => {
  if (!value || typeof value !== 'object') return false;
  const point = value as MapPoint;
  return Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
};

const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const isReceiverRecord = (value: unknown): value is TestCarReceiverRecord => {
  if (!isPoint(value)) return false;
  const record = value as TestCarReceiverRecord;
  return isTimestamp(record.at) && Number.isFinite(record.speedKmh)
    && (record.ignition === undefined || typeof record.ignition === 'boolean')
    && (record.movement === undefined || typeof record.movement === 'boolean')
    && [record.rpm, record.fuelPercent, record.coolantC, record.batteryVolts, record.odometerMeters]
      .every(value => value === undefined || Number.isFinite(value));
};

// The receiver is an optional, independently refreshed service. An invalid DTO
// must never blank the car dashboard or be mistaken for a healthy receiver.
export function readTestCarReceiver(value: unknown): TestCarReceiver | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const receiver = value as TestCarReceiver;
  if (!['separate_http', 'internal_memory'].includes(receiver.channel)
    || !['http', 'in_process'].includes(receiver.transport)
    || !['ready', 'unavailable', 'unknown'].includes(receiver.status)
    || typeof receiver.durable !== 'boolean'
    || ![null, 'sqlite', 'postgres'].includes(receiver.storage)
    || !Number.isSafeInteger(receiver.recordsStored) || receiver.recordsStored < 0
    || !(receiver.lastReceivedAt === null || isTimestamp(receiver.lastReceivedAt))
    || !(receiver.lastRecord === null || isReceiverRecord(receiver.lastRecord))
    || !Array.isArray(receiver.recentRecords) || receiver.recentRecords.length > 10 || !receiver.recentRecords.every(isReceiverRecord)
    || !(receiver.lastError === null || typeof receiver.lastError === 'string')) return null;
  return {
    channel: receiver.channel, transport: receiver.transport, status: receiver.status,
    durable: receiver.durable, storage: receiver.storage, recordsStored: receiver.recordsStored,
    lastReceivedAt: receiver.lastReceivedAt, lastRecord: receiver.lastRecord,
    recentRecords: [...receiver.recentRecords].sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 10),
    lastError: receiver.lastError,
  };
}

// An unexpected response leaves the last usable snapshot on screen. Checking
// the rendered fields also keeps a partial/error response out of Leaflet.
export function isTestCarSnapshot(value: unknown): value is TestCarSnapshot {
  if (!value || typeof value !== 'object') return false;
  const car = value as TestCarSnapshot;
  return car.simulated === true && typeof car.id === 'string' && typeof car.name === 'string'
    && typeof car.deviceModel === 'string' && typeof car.engineOn === 'boolean'
    && ['off', 'idling', 'driving', 'paused'].includes(car.mode) && [1, 5, 10].includes(car.timeScale)
    && Number.isFinite(Date.parse(car.simulatedAt)) && Number.isFinite(car.revision)
    && isPoint(car.currentPlace) && typeof car.currentPlace.name === 'string'
    && (car.currentPlace.id === null || placeIds.has(car.currentPlace.id))
    && Array.isArray(car.destinations) && car.destinations.length === 4
    && car.destinations.every(place => isPoint(place) && placeIds.has(place.id)
      && typeof place.name === 'string' && typeof place.subtitle === 'string')
    && (car.destinationId === null || placeIds.has(car.destinationId))
    && (car.route === null || (Array.isArray(car.route?.points) && car.route.points.every(isPoint)
      && Array.isArray(car.route.traveled) && car.route.traveled.every(isPoint)
      && [car.route.distanceKm, car.route.remainingKm, car.route.progress, car.route.etaSeconds].every(Number.isFinite)))
    && !!car.telemetry && ['speedKmh', 'rpm', 'fuelPercent', 'fuelLiters', 'coolantC', 'batteryVolts', 'odometerKm']
      .every(key => Number.isFinite(car.telemetry[key as keyof TestCarSnapshot['telemetry']]))
    && !!car.driver && typeof car.driver.name === 'string'
    && !!car.stats && ['recordsReceived', 'packetsReceived', 'pendingRecords', 'distanceKm', 'trips']
      .every(key => Number.isFinite(car.stats[key as keyof TestCarSnapshot['stats']]))
    && (car.stats.lastReceivedAt === null || Number.isFinite(Date.parse(car.stats.lastReceivedAt)))
    && typeof car.networkOnline === 'boolean' && Array.isArray(car.events)
    && car.events.every(event => typeof event.id === 'string' && typeof event.text === 'string'
      && Number.isFinite(Date.parse(event.at)) && ['info', 'success', 'warning'].includes(event.type))
    && Array.isArray(car.trips) && Array.isArray(car.speedHistory)
    && car.speedHistory.every(point => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.at)));
}
