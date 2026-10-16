const PURPOSES = new Set(['private', 'business']);
const SOURCES = new Set(['tracker', 'app', 'panel']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function optionalText(record, key) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`Invalid trip record ${key}`);
  return value.trim() || undefined;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.id !== 'string' || !record.id.trim()) {
    throw new TypeError('A trip record needs a nonempty id');
  }
  const timestamp = typeof record.at === 'string' && ISO_TIMESTAMP.test(record.at)
    ? Date.parse(record.at) : NaN;
  if (!Number.isFinite(timestamp)) throw new TypeError('A trip record needs an ISO timestamp');
  const normalized = { id: record.id, at: new Date(timestamp).toISOString(), source: record.source ?? 'tracker' };
  if (!SOURCES.has(normalized.source)) throw new TypeError('Invalid trip record source');
  for (const key of ['ignition', 'movement']) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== 'boolean') throw new TypeError(`Invalid trip record ${key}`);
    normalized[key] = record[key];
  }
  if (record.odometerMeters !== undefined) {
    if (typeof record.odometerMeters !== 'number' || !Number.isFinite(record.odometerMeters)) {
      throw new TypeError('Invalid trip record odometerMeters');
    }
    normalized.odometerMeters = record.odometerMeters;
  }
  for (const key of ['defaultDriverId', 'workOrderId', 'businessPurpose']) {
    const value = optionalText(record, key);
    if (value !== undefined) normalized[key] = value;
  }
  // A tracker may repeat its cached identifier on every sample. Only events
  // whose provenance the caller established as panel/app are actual choices.
  if (normalized.source === 'panel' || normalized.source === 'app') {
    const driverId = optionalText(record, 'driverId');
    if (driverId !== undefined) normalized.driverId = driverId;
  }
  if (record.purpose !== undefined) {
    if (!PURPOSES.has(record.purpose)) throw new TypeError('Invalid trip record purpose');
    normalized.purpose = record.purpose;
  }
  // Deliberately copy only the contract above. Coordinates and arbitrary device
  // payloads have no place in this projection, including its duplicate cache.
  return { normalized, timestamp };
}

function orderedRecords(records) {
  if (!Array.isArray(records)) throw new TypeError('Trip records must be an array');
  const unique = new Map();
  for (const record of records) {
    const entry = normalizeRecord(record);
    const previous = unique.get(entry.normalized.id);
    if (previous) {
      if (JSON.stringify(previous.normalized) !== JSON.stringify(entry.normalized)) {
        throw new Error(`Conflicting trip records for id ${entry.normalized.id}`);
      }
      continue;
    }
    unique.set(entry.normalized.id, entry);
  }
  return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp
    || (left.normalized.id < right.normalized.id ? -1 : left.normalized.id > right.normalized.id ? 1 : 0));
}

function observeOdometer(state, record, boundary) {
  const value = record.odometerMeters;
  if (value === undefined) {
    // App and panel annotations are events, not missing tracker measurements.
    if (boundary || record.source === 'tracker') state.reviewReasons.add('odometer-missing');
    return;
  }
  if (value < 0) {
    state.reviewReasons.add('odometer-invalid');
    return;
  }
  if (state.lastOdometer !== undefined && value < state.lastOdometer) {
    state.reviewReasons.add('odometer-reset');
  }
  state.lastOdometer = value;
  state.maxOdometer = Math.max(state.maxOdometer ?? value, value);
}

function applyAnnotations(state, record, purposeConflict) {
  if (record.driverId !== undefined) {
    state.driverIds.add(record.driverId);
    if (state.driverIds.size > 1) state.reviewReasons.add('driver-changed');
    // Conflicting identifications require a decision; never assign the whole
    // trip to whichever person happened to scan last.
    state.trip.driverId = state.driverIds.size === 1 ? record.driverId : null;
    state.trip.driverSource = state.driverIds.size === 1 ? record.source : 'unknown';
    state.trip.driverIdentificationObserved = true;
  }
  if (purposeConflict) state.trip.purpose = 'private';
  else if (record.purpose !== undefined) state.trip.purpose = record.purpose;
  if (state.trip.purpose === 'private') {
    delete state.trip.workOrderId;
    delete state.trip.businessPurpose;
    return;
  }
  // `source: app` is a trusted internal provenance marker, not a claim accepted
  // from tracker packets or public requests. The caller must establish it.
  if (record.source !== 'app') return;
  if (record.workOrderId !== undefined) {
    state.trip.purpose = 'business';
    state.trip.workOrderId = record.workOrderId;
  }
  if (state.trip.purpose === 'business' && record.businessPurpose !== undefined) {
    state.trip.businessPurpose = record.businessPurpose;
  }
}

function finishTrip(state) {
  const odometerUnreliable = [...state.reviewReasons].some(reason => reason.startsWith('odometer-'));
  const followupReasons = [];
  if (state.trip.driverId === null) followupReasons.push('driver-unknown');
  if (state.trip.purpose === null) followupReasons.push('purpose-unknown');
  if (state.trip.purpose === 'business' && !state.trip.workOrderId && !state.trip.businessPurpose) {
    followupReasons.push('business-purpose-missing');
  }
  return {
    ...state.trip,
    distanceMeters: odometerUnreliable ? null : state.maxOdometer - state.startOdometer,
    needsReview: state.reviewReasons.size > 0,
    reviewReasons: [...state.reviewReasons].sort(),
    requiresFollowup: followupReasons.length > 0,
    followupReasons,
  };
}

/**
 * Rebuild one vehicle's trips from normalized telemetry and trusted app/panel
 * events. The caller supplies defaultDriverId from a trusted vehicle-assignment
 * snapshot; only the start record's snapshot applies. Actual driverId requires
 * a current panel/app event, never a cached tracker identifier. Events outside
 * a trip carry neither identity nor classification into its successor. There
 * is deliberately no persistence, clock, sound or network.
 */
export function projectTrips(records, { driverPanel = false } = {}) {
  const ordered = orderedRecords(records);
  const ignitionAt = new Map();
  const purposeAt = new Map();
  for (const { normalized: record, timestamp } of ordered) {
    if (record.ignition !== undefined) {
      ignitionAt.set(timestamp, (ignitionAt.get(timestamp) ?? 0) | (record.ignition ? 1 : 2));
    }
    if (record.purpose !== undefined) {
      purposeAt.set(timestamp, (purposeAt.get(timestamp) ?? 0) | (record.purpose === 'private' ? 1 : 2));
    }
  }
  const trips = [];
  let lastIgnition;
  let active;
  for (const { normalized: record, timestamp } of ordered) {
    let started = false;
    if (record.ignition === true && !active) {
      active = {
        trip: {
          id: record.id,
          startRecordId: record.id,
          endRecordId: null,
          startedAt: record.at,
          endedAt: null,
          startObserved: lastIgnition === false,
          endObserved: false,
          defaultDriverId: record.defaultDriverId ?? null,
          driverId: record.defaultDriverId ?? null,
          driverSource: record.defaultDriverId === undefined ? 'unknown' : 'default',
          driverIdentificationObserved: false,
          purpose: null,
          driverPanelAvailable: Boolean(driverPanel),
        },
        driverIds: new Set(),
        reviewReasons: new Set(lastIgnition === false ? [] : ['start-unobserved']),
        startOdometer: record.odometerMeters,
        lastOdometer: undefined,
        maxOdometer: undefined,
      };
      started = true;
    }
    if (active) {
      // ID order gives reproducible output, not evidence of which simultaneous
      // opposing ignition signal happened first. Flag both sides of a boundary.
      if (ignitionAt.get(timestamp) === 3) active.reviewReasons.add('timestamp-ambiguous');
      const purposeConflict = purposeAt.get(timestamp) === 3;
      if (purposeConflict) active.reviewReasons.add('purpose-conflict');
      applyAnnotations(active, record, purposeConflict);
      observeOdometer(active, record, started || record.ignition === false);
      if (record.ignition === false) {
        active.trip.endRecordId = record.id;
        active.trip.endedAt = record.at;
        active.trip.endObserved = true;
        trips.push(finishTrip(active));
        active = undefined;
      }
    }
    if (record.ignition !== undefined) lastIgnition = record.ignition;
  }
  if (active) trips.push(finishTrip(active));
  return trips;
}
