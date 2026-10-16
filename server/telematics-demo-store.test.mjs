import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDemoTelematicsStore } from './telematics/demo-store.mjs';

const BASE = Date.parse('2026-10-16T08:00:00.000Z');
const record = (seed, fields = {}) => ({
  id: createHash('sha256').update(String(seed)).digest('hex'),
  at: new Date(BASE).toISOString(), lat: 59.76035, lng: 18.70412, speedKmh: 45,
  rpm: 1800, fuelPercent: 68, coolantC: 85, batteryVolts: 14.2,
  odometerMeters: 1000, ignition: true, movement: true, tripActive: false,
  ...fields,
});
const publicRecord = ({ id, tripActive, ...value }) => value;
const errorStatus = status => error => error.status === status;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-demo-telematics-'));
  const filename = join(directory, 'demo.sqlite');
  const stores = new Set();
  let clock = BASE;
  const open = async () => {
    // Explicitly opt out of any ambient PostgreSQL configuration.
    const store = await createDemoTelematicsStore({
      filename, databaseUrl: '', now: () => new Date(clock), ...options,
    });
    stores.add(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const close = async store => { await store.close(); stores.delete(store); };
  return { store: await open(), filename, open, close, setNow: value => { clock = value; } };
}

test('SQLite restart preserves stream isolation, records and duplicate packet counts', async t => {
  const f = await fixture(t), first = randomUUID(), second = randomUUID();
  assert.equal(f.store.kind, 'sqlite');
  assert.equal(await f.store.ready(), true);
  assert.deepEqual(await f.store.registerStream(first), { streamId: first });
  await f.store.registerStream(second);
  const records = [record('restart-a'), record('restart-b', { at: new Date(BASE + 15000).toISOString(), rpm: 1800 })];
  assert.deepEqual(await f.store.ingest(first, records), { accepted: 2, inserted: 2 });
  assert.deepEqual(await f.store.ingest(first, records), { accepted: 2, inserted: 0 });
  assert.deepEqual(await f.store.ingest(second, records.slice(0, 1)), { accepted: 1, inserted: 1 });
  const before = await f.store.summary(first);
  assert.equal(before.simulated, true);
  assert.equal(before.streamId, first);
  assert.equal(before.storage, 'sqlite');
  assert.equal(before.recordsStored, 2);
  assert.equal(before.packetsReceived, 2);
  assert.equal(before.lastReceivedAt, new Date(BASE).toISOString());
  assert.deepEqual(before.lastRecord, publicRecord(records[1]));
  assert.equal((await f.store.summary(second)).recordsStored, 1);
  assert.equal((await f.store.summary(second)).packetsReceived, 1);
  await f.close(f.store);
  const reopened = await f.open();
  assert.deepEqual(await reopened.summary(first), before);
  assert.deepEqual(await reopened.ingest(first, records), { accepted: 2, inserted: 0 });
  assert.equal((await reopened.summary(first)).recordsStored, 2);
  assert.equal((await reopened.summary(first)).packetsReceived, 3);
  assert.equal((await reopened.summary(second)).packetsReceived, 1);
});

test('conflicting record identities roll back the complete batch and its counters', async t => {
  const { store } = await fixture(t), stream = randomUUID();
  await store.registerStream(stream);
  const original = record('original', { odometerMeters: 1000, tripActive: true });
  await store.ingest(stream, [original]);
  const before = await store.summary(stream);
  await assert.rejects(store.ingest(stream, [
    record('must-roll-back', { odometerMeters: 4000, tripActive: false }),
    { ...original, lat: 60 },
  ]), errorStatus(409));
  assert.deepEqual(await store.summary(stream), before);
  const fresh = record('same-batch-conflict');
  await assert.rejects(store.ingest(stream, [fresh, { ...fresh, speedKmh: 46 }]),
    errorStatus(409));
  assert.deepEqual(await store.summary(stream), before);
});

test('independent SQLite handles preserve deduplication and packet counts', async t => {
  const f = await fixture(t), stream = randomUUID();
  await f.store.registerStream(stream);
  const other = await f.open();
  const records = [record('shared-a'), record('shared-b')];
  const receipts = await Promise.all([f.store.ingest(stream, records), other.ingest(stream, records)]);
  assert.equal(receipts.reduce((total, receipt) => total + receipt.inserted, 0), 2);
  assert.ok(receipts.every(receipt => receipt.accepted === 2));
  const summary = await other.summary(stream);
  assert.equal(summary.recordsStored, 2);
  assert.equal(summary.packetsReceived, 2);
  assert.deepEqual(await f.store.summary(stream), summary);
});

test('stream capacity rejects new streams while existing registration remains idempotent', async t => {
  const { store } = await fixture(t, { maxStreams: 2 });
  const first = randomUUID(), second = randomUUID();
  await store.registerStream(first);
  await store.registerStream(second);
  assert.deepEqual(await store.registerStream(first), { streamId: first });
  await assert.rejects(store.registerStream(randomUUID()), errorStatus(429));
  for (const stream of [first, second]) {
    const summary = await store.summary(stream);
    assert.equal(summary.recordsStored, 0);
    assert.equal(summary.packetsReceived, 0);
    assert.equal(summary.lastReceivedAt, null);
    assert.equal(summary.lastRecord, null);
    assert.deepEqual(summary.recentRecords, []);
  }
});

test('per-stream capacity is atomic and still accepts a retransmitted full stream', async t => {
  const { store } = await fixture(t, { maxRecordsPerStream: 2, maxTotalRecords: 10 });
  const stream = randomUUID(); await store.registerStream(stream);
  const records = [record('per-stream-a'), record('per-stream-b')];
  await store.ingest(stream, records);
  const before = await store.summary(stream);
  await assert.rejects(store.ingest(stream, [records[0], record('per-stream-overflow')]),
    errorStatus(429));
  assert.deepEqual(await store.summary(stream), before);
  assert.deepEqual(await store.ingest(stream, records), { accepted: 2, inserted: 0 });
  const after = await store.summary(stream);
  assert.equal(after.recordsStored, 2);
  assert.equal(after.packetsReceived, 2);
});

test('total capacity is shared across streams and rejected batches leave both untouched', async t => {
  const { store } = await fixture(t, { maxRecordsPerStream: 3, maxTotalRecords: 3 });
  const first = randomUUID(), second = randomUUID();
  await store.registerStream(first); await store.registerStream(second);
  await store.ingest(first, [record('total-a'), record('total-b')]);
  const existing = record('total-c'); await store.ingest(second, [existing]);
  const before = await Promise.all([store.summary(first), store.summary(second)]);
  await assert.rejects(store.ingest(second, [existing, record('total-overflow')]),
    errorStatus(429));
  assert.deepEqual(await Promise.all([store.summary(first), store.summary(second)]), before);
  assert.deepEqual(await store.ingest(second, [existing]), { accepted: 1, inserted: 0 });
  assert.equal((await store.summary(second)).packetsReceived, 2);
});

test('UUIDs, record fields and unknown provenance are validated without partial writes', async t => {
  const { store } = await fixture(t), stream = randomUUID(); await store.registerStream(stream);
  const invalidInput = errorStatus(422);
  for (const invalid of ['', 'not-a-uuid', '../demo.sqlite', `${stream}x`, null, 123]) {
    await assert.rejects(store.registerStream(invalid), invalidInput);
    await assert.rejects(store.ingest(invalid, [record('invalid-stream')]), invalidInput);
    await assert.rejects(store.summary(invalid), invalidInput);
  }
  const unknown = randomUUID();
  await assert.rejects(store.summary(unknown), errorStatus(404));
  await assert.rejects(store.ingest(unknown, [record('unregistered')]), errorStatus(404));
  const valid = record('validation');
  const invalidRecords = [
    null, [], {},
    { ...valid, id: 'a'.repeat(63) }, { ...valid, id: 'z'.repeat(64) },
    { ...valid, at: 'not-a-date' }, { ...valid, at: BASE },
    { ...valid, lat: -90.01 }, { ...valid, lat: 90.01 }, { ...valid, lat: NaN },
    { ...valid, lng: -180.01 }, { ...valid, lng: 180.01 }, { ...valid, lng: Infinity },
    { ...valid, speedKmh: -1 }, { ...valid, speedKmh: 65536 }, { ...valid, speedKmh: '45' },
    { ...valid, rpm: '1800' }, { ...valid, fuelPercent: '68' },
    { ...valid, coolantC: NaN }, { ...valid, batteryVolts: Infinity },
    { ...valid, odometerMeters: -1 }, { ...valid, ignition: 1 }, { ...valid, movement: 'true' },
    { ...valid, tripActive: 1 }, { ...valid, tenantId: 'real-company' },
    { ...valid, driverId: 'real-person' }, { ...valid, rawIo: { 78: 'private-token' } },
  ];
  for (const field of Object.keys(valid)) {
    const missing = { ...valid }; delete missing[field]; invalidRecords.push(missing);
  }
  const before = await store.summary(stream);
  for (const invalid of invalidRecords) {
    await assert.rejects(store.ingest(stream, [record('valid-prefix'), invalid]), invalidInput);
    assert.deepEqual(await store.summary(stream), before);
  }
  for (const invalid of [null, {}, 'records']) await assert.rejects(store.ingest(stream, invalid), invalidInput);
});

test('public summaries expose bounded telemetry without internal IDs or trip flags', async t => {
  const { store } = await fixture(t), stream = randomUUID(); await store.registerStream(stream);
  const records = Array.from({ length: 12 }, (_, index) => record(`projection-${index}`, {
    at: new Date(BASE + index * 15000).toISOString(), lat: index === 0 ? -90 : 90,
    lng: index === 0 ? -180 : 180, speedKmh: index === 0 ? 0 : 65535,
    rpm: 1800, fuelPercent: 68, coolantC: 85, batteryVolts: 14.2,
    odometerMeters: 1000 + index * 100, ignition: true, movement: true, tripActive: true,
  }));
  await store.ingest(stream, records);
  const summary = await store.summary(stream);
  assert.equal(summary.recordsStored, 12);
  assert.equal(summary.recentRecords.length, 10);
  assert.deepEqual(summary.lastRecord, publicRecord(records.at(-1)));
  const expectedRecent = records.slice(-10).map(publicRecord);
  for (const value of summary.recentRecords) {
    assert.equal(Object.hasOwn(value, 'id'), false);
    assert.equal(Object.hasOwn(value, 'tripActive'), false);
    const expected = expectedRecent.find(candidate => candidate.at === value.at);
    assert.ok(expected);
    assert.deepEqual(value, expected);
  }
  assert.equal(new Set(summary.recentRecords.map(value => value.at)).size, 10);
  summary.lastRecord.rpm = 1; summary.recentRecords[0].lat = 0;
  assert.deepEqual((await store.summary(stream)).lastRecord, publicRecord(records.at(-1)));
});

test('distance and completed trips derive only from newly committed records and survive restart', async t => {
  const f = await fixture(t), stream = randomUUID(); await f.store.registerStream(stream);
  const records = [
    record('trip-off', { odometerMeters: 1000, tripActive: false }),
    record('trip-start', { odometerMeters: 1000, tripActive: true, at: new Date(BASE + 15000).toISOString() }),
    record('trip-moving', { odometerMeters: 1750, tripActive: true, at: new Date(BASE + 30000).toISOString() }),
    record('trip-end', { odometerMeters: 2500, tripActive: false, at: new Date(BASE + 45000).toISOString() }),
  ];
  await f.store.ingest(stream, records.slice(0, 2));
  assert.equal((await f.store.summary(stream)).trips, 0);
  await f.store.ingest(stream, records.slice(2));
  let summary = await f.store.summary(stream);
  assert.equal(summary.distanceKm, 1.5);
  assert.equal(summary.trips, 1);
  assert.deepEqual(await f.store.ingest(stream, records), { accepted: 4, inserted: 0 });
  summary = await f.store.summary(stream);
  assert.equal(summary.distanceKm, 1.5);
  assert.equal(summary.trips, 1);
  assert.equal(summary.packetsReceived, 3);
  await f.close(f.store);
  const reopened = await f.open();
  assert.deepEqual(await reopened.summary(stream), summary);
  await reopened.ingest(stream, [
    record('second-start', { odometerMeters: 2500, tripActive: true, at: new Date(BASE + 60000).toISOString() }),
    record('second-end', { odometerMeters: 3000, tripActive: false, at: new Date(BASE + 75000).toISOString() }),
  ]);
  const after = await reopened.summary(stream);
  assert.equal(after.distanceKm, 2);
  assert.equal(after.trips, 2);
  assert.equal(after.recordsStored, 6);
});

test('active streams retain old details and dedupe until receipt-clock inactivity expires the whole stream', async t => {
  const f = await fixture(t, { retentionMs: 60000, maxStreams: 1 });
  const stream = randomUUID(); await f.store.registerStream(stream);
  const future = record('future-record', { at: '2050-01-01T00:00:00.000Z', odometerMeters: 1000, tripActive: true });
  const old = record('old-record', { at: '2000-01-01T00:00:00.000Z', odometerMeters: 2500, tripActive: false });
  await f.store.ingest(stream, [future]);
  f.setNow(BASE + 30000);
  await f.store.ingest(stream, [old]);
  assert.equal((await f.store.summary(stream)).recordsStored, 2);
  f.setNow(BASE + 60001);
  const retained = await f.store.summary(stream);
  assert.equal(retained.recordsStored, 2);
  assert.equal(retained.recentRecords.length, 2);
  assert.deepEqual(retained.lastRecord, publicRecord(old));
  assert.equal(retained.packetsReceived, 2);
  assert.equal(retained.lastReceivedAt, new Date(BASE + 30000).toISOString());
  assert.equal(retained.distanceKm, 1.5);
  assert.equal(retained.trips, 1);
  assert.deepEqual(await f.store.ingest(stream, [future]), { accepted: 1, inserted: 0 });
  const retried = await f.store.summary(stream);
  assert.equal(retried.recordsStored, 2);
  assert.equal(retried.packetsReceived, 3);
  assert.equal(retried.distanceKm, 1.5);
  assert.equal(retried.trips, 1);
  f.setNow(BASE + 90001);
  assert.equal((await f.store.summary(stream)).recordsStored, 2);
  f.setNow(BASE + 120002);
  await assert.rejects(f.store.summary(stream), errorStatus(404));
  await assert.rejects(f.store.ingest(stream, [record('expired')]), errorStatus(404));
  const replacement = randomUUID();
  assert.deepEqual(await f.store.registerStream(replacement), { streamId: replacement });
  assert.equal((await f.store.summary(replacement)).recordsStored, 0);
});

test('existing registration, passive reads and failed ingest cannot prolong an abandoned stream', async t => {
  const f = await fixture(t, { retentionMs: 60000, maxTotalRecords: 1, maxRecordsPerStream: 1 });
  const stream = randomUUID(); await f.store.registerStream(stream);
  const original = record('expiring-detail');
  await f.store.ingest(stream, [original]);
  f.setNow(BASE + 40000);
  await f.store.registerStream(stream);
  f.setNow(BASE + 59999);
  const retained = await f.store.summary(stream);
  assert.equal(retained.recordsStored, 1);
  assert.equal(retained.packetsReceived, 1);
  await assert.rejects(f.store.ingest(stream, [record('overflow-detail')]), errorStatus(429));
  assert.equal((await f.store.summary(stream)).recordsStored, 1);
  assert.equal((await f.store.summary(stream)).packetsReceived, 1);
  f.setNow(BASE + 60001);
  await assert.rejects(f.store.summary(stream), errorStatus(404));
  const replacement = randomUUID(); await f.store.registerStream(replacement);
  assert.deepEqual(await f.store.ingest(replacement, [record('replacement-detail')]), { accepted: 1, inserted: 1 });
  assert.equal((await f.store.summary(replacement)).recordsStored, 1);
  assert.equal((await f.store.summary(replacement)).packetsReceived, 1);
});

test('ready physically deletes inactive streams and records without extending their lifetime', async t => {
  const f = await fixture(t, { retentionMs: 60000 }), stream = randomUUID();
  await f.store.registerStream(stream);
  await f.store.ingest(stream, [record('readiness-expiry')]);
  const observer = new DatabaseSync(f.filename, { readOnly: true });
  const counts = () => ({
    streams: observer.prepare('SELECT COUNT(*) AS count FROM demo_telematics_streams').get().count,
    records: observer.prepare('SELECT COUNT(*) AS count FROM demo_telematics_records').get().count,
  });
  try {
    assert.deepEqual(counts(), { streams: 1, records: 1 });
    f.setNow(BASE + 30000);
    assert.equal(await f.store.ready(), true);
    assert.deepEqual(counts(), { streams: 1, records: 1 });
    f.setNow(BASE + 60001);
    // Read the tables directly: summary/register/ingest would also run cleanup.
    assert.deepEqual(counts(), { streams: 1, records: 1 });
    assert.equal(await f.store.ready(), true);
    assert.deepEqual(counts(), { streams: 0, records: 0 });
  } finally {
    observer.close();
  }
});
