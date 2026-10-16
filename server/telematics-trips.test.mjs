import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectTrips } from './telematics/trips.mjs';

const at = minute => `2026-10-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const sample = (id, minute, fields = {}) => ({ id, at: at(minute), ...fields });
const stopped = sample('stopped', 0, { ignition: false, odometerMeters: 1000 });
const start = sample('start', 1, { ignition: true, odometerMeters: 1000 });
const end = sample('end', 5, { ignition: false, odometerMeters: 1800 });

test('successive ignition trips never inherit a prior scan, purpose or work order', () => {
  const trips = projectTrips([
    stopped,
    { ...start, source: 'panel', driverId: 'driver-A' },
    sample('job', 2, { source: 'app', workOrderId: 'work-1', businessPurpose: 'Collect material' }),
    end,
    sample('between-trips', 6, { source: 'panel', driverId: 'driver-A', purpose: 'business' }),
    sample('second-start', 7, { ignition: true, odometerMeters: 1800 }),
    sample('second-end', 9, { ignition: false, odometerMeters: 1900 }),
    sample('third-start', 10, { source: 'panel', ignition: true, odometerMeters: 1900, driverId: 'driver-B', purpose: 'private' }),
  ]);
  assert.equal(trips.length, 3);
  assert.equal(trips[0].driverId, 'driver-A');
  assert.equal(trips[0].purpose, 'business');
  assert.equal(trips[0].workOrderId, 'work-1');
  assert.equal(trips[0].distanceMeters, 800);
  assert.equal(trips[0].requiresFollowup, false);
  assert.equal(trips[1].driverId, null);
  assert.equal(trips[1].purpose, null);
  assert.equal(Object.hasOwn(trips[1], 'workOrderId'), false);
  assert.equal(Object.hasOwn(trips[1], 'businessPurpose'), false);
  assert.deepEqual(trips[1].followupReasons, ['driver-unknown', 'purpose-unknown']);
  assert.equal(trips[2].driverId, 'driver-B');
  assert.equal(trips[2].purpose, 'private');
  assert.equal(trips[2].endedAt, null);
});

test('a default driver works without a panel and is explicitly distinguished from identification', () => {
  const records = [stopped, { ...start, defaultDriverId: 'driver-A' }, end];
  const [trip] = projectTrips(records);
  assert.equal(trip.driverPanelAvailable, false);
  assert.equal(trip.defaultDriverId, 'driver-A');
  assert.equal(trip.driverId, 'driver-A');
  assert.equal(trip.driverSource, 'default');
  assert.equal(trip.driverIdentificationObserved, false);
  assert.deepEqual(trip.followupReasons, ['purpose-unknown']);
  const [complete] = projectTrips([stopped, { ...start, defaultDriverId: 'driver-A', purpose: 'private' }, end]);
  assert.equal(complete.requiresFollowup, false);
});

test('a current panel scan overrides the default for one trip, and the next trip resets to its own snapshot', () => {
  const trips = projectTrips([
    stopped, { ...start, defaultDriverId: 'driver-A', purpose: 'private' },
    sample('current-card', 2, { source: 'panel', driverId: 'driver-B' }),
    sample('assignment-change', 3, { source: 'app', defaultDriverId: 'driver-C' }), end,
    sample('next-start', 6, { ignition: true, odometerMeters: 1800, defaultDriverId: 'driver-A' }),
    sample('next-end', 7, { ignition: false, odometerMeters: 1900 }),
    sample('new-assignment-start', 8, { ignition: true, odometerMeters: 1900, defaultDriverId: 'driver-C' }),
    sample('new-assignment-end', 9, { ignition: false, odometerMeters: 2000 }),
    sample('no-snapshot-start', 10, { ignition: true, odometerMeters: 2000 }),
  ], { driverPanel: true });
  assert.equal(trips[0].defaultDriverId, 'driver-A');
  assert.equal(trips[0].driverId, 'driver-B');
  assert.equal(trips[0].driverSource, 'panel');
  assert.equal(trips[0].driverIdentificationObserved, true);
  assert.equal(trips[0].needsReview, false, 'first actual scan is not a conflicting identification');
  assert.equal(trips[1].defaultDriverId, 'driver-A');
  assert.equal(trips[1].driverId, 'driver-A');
  assert.equal(trips[1].driverSource, 'default');
  assert.equal(trips[1].driverIdentificationObserved, false);
  assert.equal(trips[2].defaultDriverId, 'driver-C');
  assert.equal(trips[2].driverId, 'driver-C');
  assert.equal(trips[3].defaultDriverId, null);
  assert.equal(trips[3].driverId, null);
  assert.equal(trips[3].driverSource, 'unknown');
  assert.equal(trips[3].driverIdentificationObserved, false);
  assert.ok(trips[3].followupReasons.includes('driver-unknown'));
});

test('a default assignment update inside a trip does not replace its start snapshot', () => {
  const [trip] = projectTrips([
    stopped, { ...start, defaultDriverId: 'driver-A' },
    sample('new-default', 2, { source: 'app', defaultDriverId: 'driver-B' }), end,
  ]);
  assert.equal(trip.defaultDriverId, 'driver-A');
  assert.equal(trip.driverId, 'driver-A');
  assert.equal(trip.driverSource, 'default');
  assert.equal(trip.driverIdentificationObserved, false);
});

test('an explicit app driver choice overrides a default, including identification of the same person', () => {
  for (const actualId of ['driver-A', 'driver-B']) {
    const [trip] = projectTrips([
      stopped, { ...start, defaultDriverId: 'driver-A', purpose: 'private' },
      sample('app-choice', 2, { source: 'app', driverId: actualId }), end,
    ]);
    assert.equal(trip.driverId, actualId);
    assert.equal(trip.defaultDriverId, 'driver-A');
    assert.equal(trip.driverSource, 'app');
    assert.equal(trip.driverIdentificationObserved, true);
    assert.equal(trip.needsReview, false);
    assert.equal(trip.requiresFollowup, false);
  }
});

test('forged or cached tracker driver IDs cannot identify a driver or override a default', () => {
  for (const defaultDriverId of [undefined, 'driver-A']) {
    const [trip] = projectTrips([
      stopped, { ...start, defaultDriverId, driverId: 'cached-driver-B', source: 'tracker' },
      sample('cached-again', 2, { source: 'tracker', driverId: 'cached-driver-C', odometerMeters: 1400 }), end,
    ]);
    assert.equal(trip.driverId, defaultDriverId ?? null);
    assert.equal(trip.driverSource, defaultDriverId ? 'default' : 'unknown');
    assert.equal(trip.driverIdentificationObserved, false);
    assert.equal(trip.needsReview, false);
    assert.equal(trip.followupReasons.includes('driver-unknown'), !defaultDriverId);
    assert.equal(JSON.stringify(trip).includes('cached-driver'), false);
  }
});

test('different actual identifications remain uncertain after the first overrides a default', () => {
  const [trip] = projectTrips([
    stopped, { ...start, defaultDriverId: 'driver-A', purpose: 'private' },
    sample('actual-panel', 2, { source: 'panel', driverId: 'driver-B' }),
    sample('actual-app', 3, { source: 'app', driverId: 'driver-C' }), end,
  ]);
  assert.equal(trip.defaultDriverId, 'driver-A');
  assert.equal(trip.driverId, null);
  assert.equal(trip.driverSource, 'unknown');
  assert.equal(trip.driverIdentificationObserved, true);
  assert.deepEqual(trip.reviewReasons, ['driver-changed']);
  assert.deepEqual(trip.followupReasons, ['driver-unknown']);
});

test('first ignition-on has an unobserved start; signal gaps never manufacture an end', () => {
  const [trip] = projectTrips([
    start,
    sample('moving', 2, { movement: true, odometerMeters: 1300 }),
    sample('not-moving', 3, { movement: false, odometerMeters: 1300 }),
    sample('still-on', 4, { ignition: true, odometerMeters: 1400 }),
  ]);
  assert.equal(trip.id, start.id);
  assert.equal(trip.startObserved, false);
  assert.equal(trip.endObserved, false);
  assert.equal(trip.endedAt, null);
  assert.equal(trip.endRecordId, null);
  assert.equal(trip.distanceMeters, 400);
  assert.deepEqual(trip.reviewReasons, ['start-unobserved']);
  assert.equal(trip.driverPanelAvailable, false);
  assert.equal(trip.requiresFollowup, true);
});

test('only explicit ignition signals open and close trips, with stable start-record ids', () => {
  const records = [
    stopped,
    sample('idle-again', 0, { ignition: false, odometerMeters: 1000 }),
    start,
    sample('no-ignition', 2, { movement: false, odometerMeters: 1200 }),
    end,
    sample('stopped-again', 6, { ignition: false, odometerMeters: 1800 }),
  ];
  const [trip] = projectTrips(records);
  assert.equal(projectTrips(records).length, 1);
  assert.equal(trip.id, 'start');
  assert.equal(trip.startObserved, true);
  assert.equal(trip.endObserved, true);
  assert.equal(trip.endedAt, at(5));
  assert.equal(trip.endRecordId, 'end');
  assert.equal(trip.needsReview, false);
  assert.deepEqual(projectTrips([stopped, sample('movement-only', 1, { movement: true })]), []);
});

test('private wins over all work order inference and removes business details entirely', () => {
  const records = [
    stopped, start,
    sample('business', 2, { source: 'app', workOrderId: 'work-1', businessPurpose: 'Customer visit' }),
    sample('private', 3, { source: 'panel', purpose: 'private' }),
    sample('later-job', 4, { source: 'app', workOrderId: 'work-2', businessPurpose: 'Must not override privacy' }),
    end,
  ];
  const [trip] = projectTrips(records, { driverPanel: true });
  assert.equal(trip.purpose, 'private');
  assert.equal(Object.hasOwn(trip, 'workOrderId'), false);
  assert.equal(Object.hasOwn(trip, 'businessPurpose'), false);
  assert.equal(JSON.stringify(trip).includes('work-'), false);
  assert.equal(trip.distanceMeters, 800, 'annotations do not constitute missing tracker measurements');
  assert.equal(trip.driverPanelAvailable, true);

  const [sameEvent] = projectTrips([stopped, { ...start, source: 'app', purpose: 'private', workOrderId: 'work-3', businessPurpose: 'Hidden' }, end]);
  assert.equal(sameEvent.purpose, 'private');
  assert.equal(Object.hasOwn(sameEvent, 'workOrderId'), false);
  assert.equal(Object.hasOwn(sameEvent, 'businessPurpose'), false);
});

test('only a later explicit business choice can leave private, without reviving old details', () => {
  const [trip] = projectTrips([
    stopped, start,
    sample('private', 2, { source: 'app', purpose: 'private', workOrderId: 'discarded' }),
    sample('explicit-business', 3, { source: 'panel', purpose: 'business' }),
    end,
  ]);
  assert.equal(trip.purpose, 'business');
  assert.equal(Object.hasOwn(trip, 'workOrderId'), false);
  assert.equal(Object.hasOwn(trip, 'businessPurpose'), false);
  assert.ok(trip.followupReasons.includes('business-purpose-missing'));
});

test('business selection needs a work order or explicit manual purpose, including without a panel', () => {
  const driverStart = { ...start, source: 'panel', driverId: 'driver-A' };
  const businessChoice = sample('choice', 2, { source: 'panel', purpose: 'business' });
  const [missing] = projectTrips([stopped, driverStart, businessChoice, end]);
  assert.equal(missing.driverPanelAvailable, false);
  assert.equal(missing.requiresFollowup, true);
  assert.deepEqual(missing.followupReasons, ['business-purpose-missing']);

  for (const fields of [
    { businessPurpose: 'Visit a prospective customer' },
    { workOrderId: 'work-1' },
  ]) {
    const [complete] = projectTrips([
      stopped, driverStart, businessChoice,
      sample('manual-details', 3, { source: 'app', ...fields }), end,
    ]);
    assert.equal(complete.requiresFollowup, false);
    assert.deepEqual(complete.followupReasons, []);
  }
  const [blank] = projectTrips([
    stopped, driverStart, businessChoice,
    sample('blank-details', 3, { source: 'app', businessPurpose: '  ', workOrderId: '' }), end,
  ]);
  assert.deepEqual(blank.followupReasons, ['business-purpose-missing']);
  const [privateTrip] = projectTrips([stopped, { ...driverStart, purpose: 'private' }, end]);
  assert.equal(privateTrip.requiresFollowup, false);
});

test('app login and tracker work-order claims never infer business; a trusted app job event does', () => {
  const [unknown] = projectTrips([
    stopped, { ...start, workOrderId: 'device-claim', businessPurpose: 'Untrusted', source: 'tracker' },
    sample('app-login', 2, { source: 'app', driverId: 'driver-A' }), end,
  ]);
  assert.equal(unknown.purpose, null);
  assert.deepEqual(unknown.followupReasons, ['purpose-unknown']);
  assert.equal(Object.hasOwn(unknown, 'workOrderId'), false);
  assert.equal(Object.hasOwn(unknown, 'businessPurpose'), false);

  const [business] = projectTrips([
    stopped, start,
    sample('app-job', 2, { source: 'app', driverId: 'driver-A', workOrderId: 'trusted-work' }), end,
  ]);
  assert.equal(business.purpose, 'business');
  assert.equal(business.workOrderId, 'trusted-work');
  assert.equal(business.requiresFollowup, false);
});

test('odometer gaps, resets and invalid readings stay unknown even after readings recover', () => {
  for (const fields of [{}, { odometerMeters: 900 }, { odometerMeters: -1 }]) {
    const [trip] = projectTrips([
      stopped, start, sample('bad-reading', 2, fields),
      sample('recovered', 3, { odometerMeters: 1600 }), end,
    ]);
    assert.equal(trip.distanceMeters, null);
    assert.equal(trip.needsReview, true);
    assert.ok(trip.reviewReasons.some(reason => reason.startsWith('odometer-')));
  }
  for (const records of [
    [stopped, sample('missing-start', 1, { ignition: true }), end],
    [stopped, start, sample('missing-end', 5, { ignition: false })],
  ]) {
    const [trip] = projectTrips(records);
    assert.equal(trip.distanceMeters, null);
    assert.ok(trip.reviewReasons.includes('odometer-missing'));
  }
  assert.equal(projectTrips([stopped, start, { ...end, odometerMeters: 1000 }])[0].distanceMeters, 0);
});

test('late records and equal-timestamp ids rebuild deterministically without mutating inputs', () => {
  const sameTimeA = sample('annotation-a', 2, { source: 'app', purpose: 'private' });
  const sameTimeB = sample('annotation-b', 2, { source: 'app', purpose: 'business' });
  const ordered = [stopped, start, sameTimeA, sameTimeB, end];
  const shuffled = [end, sameTimeB, start, stopped, sameTimeA];
  const snapshot = structuredClone(shuffled);
  shuffled.forEach(Object.freeze);
  Object.freeze(shuffled);
  const expected = projectTrips(ordered);
  assert.deepEqual(projectTrips(shuffled), expected);
  assert.equal(expected[0].purpose, 'private');
  assert.deepEqual(expected[0].reviewReasons, ['purpose-conflict']);
  assert.deepEqual(shuffled, snapshot);
  const withLateRecord = [...shuffled, sample('late-distance', 3, { odometerMeters: 1700 })];
  assert.deepEqual(projectTrips(withLateRecord), projectTrips([...ordered, withLateRecord.at(-1)]));
});

test('same-timestamp purpose conflicts preserve privacy in either id order until a later explicit choice', () => {
  for (const [privateId, businessId] of [['choice-a', 'choice-b'], ['choice-b', 'choice-a']]) {
    const privateChoice = sample(privateId, 2, { source: 'panel', purpose: 'private' });
    const businessChoice = sample(businessId, 2, {
      source: 'app', purpose: 'business', workOrderId: 'conflicting-job', businessPurpose: 'Unproven later choice',
    });
    const records = [stopped, { ...start, source: 'panel', driverId: 'driver-A' }, privateChoice, businessChoice, end];
    const [privateTrip] = projectTrips(records);
    assert.deepEqual(projectTrips([...records].reverse()), [privateTrip]);
    assert.equal(privateTrip.purpose, 'private');
    assert.equal(privateTrip.needsReview, true);
    assert.deepEqual(privateTrip.reviewReasons, ['purpose-conflict']);
    assert.equal(Object.hasOwn(privateTrip, 'workOrderId'), false);
    assert.equal(Object.hasOwn(privateTrip, 'businessPurpose'), false);
    assert.equal(JSON.stringify(privateTrip).includes('conflicting-job'), false);

    const [stillPrivate] = projectTrips([
      ...records, sample('inferred-later', 3, { source: 'app', workOrderId: 'later-job' }),
    ]);
    assert.equal(stillPrivate.purpose, 'private');
    assert.equal(Object.hasOwn(stillPrivate, 'workOrderId'), false);

    const [explicitlyBusiness] = projectTrips([
      ...records,
      sample('explicitly-later', 3, { source: 'app', purpose: 'business', businessPurpose: 'A confirmed later choice' }),
    ]);
    assert.equal(explicitlyBusiness.purpose, 'business');
    assert.equal(explicitlyBusiness.businessPurpose, 'A confirmed later choice');
    assert.equal(Object.hasOwn(explicitlyBusiness, 'workOrderId'), false);
    assert.equal(explicitlyBusiness.requiresFollowup, false);
    assert.deepEqual(explicitlyBusiness.reviewReasons, ['purpose-conflict']);
  }
});

test('opposing ignition at one timestamp flags both adjoining trips despite deterministic id order', () => {
  const simultaneousStop = sample('boundary-a-stop', 3, { ignition: false, odometerMeters: 1400 });
  const simultaneousStart = sample('boundary-b-start', 3, { ignition: true, odometerMeters: 1400 });
  const ordered = [stopped, start, simultaneousStop, simultaneousStart, end];
  const trips = projectTrips(ordered);
  assert.equal(trips.length, 2);
  assert.deepEqual(projectTrips([...ordered].reverse()), trips);
  for (const trip of trips) {
    assert.equal(trip.needsReview, true);
    assert.deepEqual(trip.reviewReasons, ['timestamp-ambiguous']);
  }
  assert.equal(trips[0].endRecordId, simultaneousStop.id);
  assert.equal(trips[1].startRecordId, simultaneousStart.id);
});

test('same-timestamp on-before-off cannot produce an apparently reliable zero-length trip', () => {
  const simultaneousStart = sample('boundary-a-start', 3, { ignition: true, odometerMeters: 1400 });
  const simultaneousStop = sample('boundary-b-stop', 3, { ignition: false, odometerMeters: 1400 });
  const [trip] = projectTrips([simultaneousStop, stopped, simultaneousStart]);
  assert.equal(trip.startedAt, trip.endedAt);
  assert.equal(trip.distanceMeters, 0);
  assert.equal(trip.needsReview, true);
  assert.deepEqual(trip.reviewReasons, ['timestamp-ambiguous']);
  const [nonConflicting] = projectTrips([
    stopped, start,
    sample('same-time-on', 1, { ignition: true, odometerMeters: 1000 }), end,
  ]);
  assert.equal(nonConflicting.needsReview, false);
});

test('identical normalized ids are idempotent and conflicting known facts reject the rebuild', () => {
  const duplicate = { ...start, at: '2026-10-16T12:01:00+02:00', source: 'tracker' };
  assert.deepEqual(projectTrips([end, start, stopped, duplicate]), projectTrips([stopped, start, end]));
  assert.throws(() => projectTrips([start, { ...start, odometerMeters: 1001 }]), /Conflicting trip records/);
  assert.throws(() => projectTrips([start, { ...start, ignition: false }]), /Conflicting trip records/);
});

test('conflicting driver scans require followup instead of silently attributing the trip', () => {
  const [trip] = projectTrips([
    stopped, { ...start, source: 'panel', driverId: 'driver-A', purpose: 'business' },
    sample('other-driver', 2, { source: 'panel', driverId: 'driver-B' }),
    sample('first-again', 3, { source: 'panel', driverId: 'driver-A' }), end,
  ]);
  assert.equal(trip.driverId, null);
  assert.deepEqual(trip.reviewReasons, ['driver-changed']);
  assert.deepEqual(trip.followupReasons, ['driver-unknown', 'business-purpose-missing']);
});

test('projection discards coordinates and arbitrary payloads, and returns independent results', () => {
  const records = [stopped, { ...start, latitude: 59.123, longitude: 18.456, payload: { coordinates: ['sensitive'] } }, end];
  const result = projectTrips(records);
  assert.equal(JSON.stringify(result).includes('59.123'), false);
  assert.equal(JSON.stringify(result).includes('coordinates'), false);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  result[0].reviewReasons.push('caller-change');
  result[0].driverId = 'caller-change';
  assert.deepEqual(projectTrips(records), projectTrips([stopped, start, end]));
});

test('invalid normalized facts fail explicitly instead of producing misleading trips', () => {
  for (const record of [
    { ...start, id: '' }, { ...start, at: 'not-a-time' }, { ...start, at: '2026-10-16' },
    { ...start, ignition: 'true' }, { ...start, movement: 1 }, { ...start, odometerMeters: NaN },
    { ...start, purpose: 'commute' }, { ...start, source: 'untrusted' },
  ]) assert.throws(() => projectTrips([record]), TypeError);
  assert.deepEqual(projectTrips([]), []);
});
