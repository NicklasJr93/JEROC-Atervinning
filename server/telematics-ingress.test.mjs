import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createTelematicsStore } from './telematics/storage.mjs';
import { createTelematicsReceiver } from './telematics/receiver.mjs';
import { normalizeFtc134Records } from './telematics/normalize.mjs';
import { decodeCodec8EFrame } from './telematics/codec8e.mjs';
import { projectTrips } from './telematics/trips.mjs';
import { connectSimulatedTracker, simulatedImeiHandshake, simulatedFtc134Frame } from './telematics/simulator.mjs';

const IMEI = '356307042441013';
const samples = [
  { at: '2026-10-16T07:00:00.000Z', ignition: false, odometerMeters: 1000, longitude: 18.1234567, latitude: 59.7654321 },
  { at: '2026-10-16T07:01:00.000Z', ignition: true, movement: true, odometerMeters: 1000 },
  { at: '2026-10-16T07:10:00.000Z', ignition: false, movement: false, odometerMeters: 2500 },
];
const normalized = values => normalizeFtc134Records(decodeCodec8EFrame(simulatedFtc134Frame(values)).records);
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-telematics-test-'));
  const stores = [], receivers = [], clients = [];
  const registry = new Set(['tenant-a/vehicle-a', 'tenant-b/vehicle-b']);
  const defaults = new Map();
  const filename = join(directory, 'pilot.sqlite');
  const open = async () => {
    const store = await createTelematicsStore({ filename, ...options,
      resolveVehicle: async reference => registry.has(`${reference.tenantId}/${reference.vehicleId}`)
        ? { ...reference, active: true, defaultDriver: defaults.get(`${reference.tenantId}/${reference.vehicleId}`) } : null });
    stores.push(store); return store;
  };
  const store = await open();
  const binding = await store.registerDevice({ tenantId: 'tenant-a', vehicleId: 'vehicle-a', imei: IMEI });
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    for (const receiver of receivers) await receiver.close();
    for (const storage of stores) storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (settings = {}) => {
    const receiver = await createTelematicsReceiver({ store, ...settings }); receivers.push(receiver); return receiver;
  };
  const connect = async receiver => {
    const client = await connectSimulatedTracker(receiver.address.port); clients.push(client); return client;
  };
  const login = async receiver => {
    const client = await connect(receiver), ack = client.readBytes(1);
    client.socket.write(simulatedImeiHandshake(IMEI)); assert.deepEqual(await ack, Buffer.from([1])); return client;
  };
  const read = (storage = store, query = {}) => storage.listRecords({ tenantId: binding.tenantId, deviceId: binding.id, ...query });
  return { directory, registry, defaults, open, store, binding, start, connect, login, read };
}

test('ingress commits fragmented TCP records and retry ACKs without duplicate rows or trips', async t => {
  const f = await fixture(t), receiver = await f.start(), client = await f.connect(receiver);
  const handshake = simulatedImeiHandshake(IMEI), accepted = client.readBytes(1);
  client.socket.write(handshake.subarray(0, 1)); await delay(5);
  client.socket.write(handshake.subarray(1, 7)); await delay(5); client.socket.write(handshake.subarray(7));
  assert.equal((await accepted)[0], 1);
  const frame = simulatedFtc134Frame(samples), ack = client.readBytes(4);
  for (const [start, end] of [[0, 3], [3, 8], [8, 19], [19, frame.length]]) {
    client.socket.write(frame.subarray(start, end)); await delay(5);
  }
  assert.equal((await ack).readUInt32BE(), 3);
  const retry = client.readBytes(4); client.socket.write(frame); assert.equal((await retry).readUInt32BE(), 3);
  const rows = (await f.read()).records; assert.equal(rows.length, 3);
  assert.equal(projectTrips(rows).length, 1); assert.equal(projectTrips(rows)[0].distanceMeters, 1500);
});

test('one TCP write may contain IMEI and multiple complete frames', async t => {
  const f = await fixture(t), receiver = await f.start(), client = await f.connect(receiver);
  const ack = client.readBytes(9);
  client.socket.write(Buffer.concat([simulatedImeiHandshake(IMEI), simulatedFtc134Frame(samples.slice(0, 1)), simulatedFtc134Frame(samples.slice(1))]));
  assert.deepEqual([...await ack], [1, 0, 0, 0, 1, 0, 0, 0, 2]);
  assert.equal((await f.read()).records.length, 3);
});

test('commit must complete before record ACK and storage errors leave the batch unacknowledged', async t => {
  const f = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const receiver = await f.start({ store: { lookupDevice: value => f.store.lookupDevice(value),
    ingest: async (...args) => { entered(); await gate; return f.store.ingest(...args); } } });
  const client = await f.login(receiver); let acknowledged = false;
  const ack = client.readBytes(4).then(value => { acknowledged = true; return value; });
  client.socket.write(simulatedFtc134Frame(samples)); await started; await delay(10);
  assert.equal(acknowledged, false); assert.equal((await f.read()).records.length, 0);
  release(); assert.equal((await ack).readUInt32BE(), 3); assert.equal((await f.read()).records.length, 3);
  const failing = await f.start({ store: { lookupDevice: value => f.store.lookupDevice(value), ingest: async () => { throw new Error('unavailable'); } } });
  const second = await f.login(failing), lost = second.readBytes(4);
  second.socket.write(simulatedFtc134Frame(samples)); await assert.rejects(lost, /disconnected/);
});

test('bad CRC, unknown IMEI, oversized frames and bad signals get no record ACK or rows', async t => {
  const f = await fixture(t), errors = [], receiver = await f.start({ onError: error => errors.push(error) });
  const unknown = await f.connect(receiver), rejected = unknown.readBytes(1);
  unknown.socket.write(simulatedImeiHandshake('123456789012345')); assert.equal((await rejected)[0], 0);
  for (const frame of [
    (() => { const value = simulatedFtc134Frame(samples); value[value.length - 1] ^= 1; return value; })(),
    Buffer.from('0000000000010000', 'hex'),
    simulatedFtc134Frame([{ ...samples[0], ignition: 2 }]),
  ]) {
    const client = await f.login(receiver), noAck = client.readBytes(4);
    client.socket.write(frame); await assert.rejects(noAck, /disconnected/);
  }
  assert.equal((await f.read()).records.length, 0);
  assert.equal(errors.length, 3); assert.deepEqual(Object.keys(errors[0]), ['code']);
});

test('plain public listeners are refused; an unauthenticated handshake expires', async t => {
  const f = await fixture(t);
  await assert.rejects(createTelematicsReceiver({ store: f.store, host: '0.0.0.0' }), /public_tls_required/);
  await assert.rejects(createTelematicsReceiver({ store: f.store, host: '0.0.0.0', tlsOptions: {} }), /tls_configuration_invalid/);
  const receiver = await f.start({ handshakeTimeoutMs: 20 }), client = await f.connect(receiver);
  await assert.rejects(client.readBytes(1), /disconnected/);
});

test('public TLS ingress requires both a trusted client certificate and the fingerprint registered for its IMEI', async t => {
  const f = await fixture(t);
  const openssl = args => execFileSync('openssl', args, { cwd: f.directory, stdio: 'ignore' });
  // Short-lived synthetic certificates, removed by fixture cleanup. The demo
  // CA doubles as the test server only; this is not a provisioning template.
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=pilot.local', '-addext', 'subjectAltName=DNS:pilot.local']);
  openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=synthetic-tracker']);
  openssl(['x509', '-req', '-days', '1', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
    '-CAcreateserial', '-out', 'client.crt']);
  const ca = await readFile(join(f.directory, 'ca.crt')), key = await readFile(join(f.directory, 'ca.key'));
  const clientCert = await readFile(join(f.directory, 'client.crt')), clientKey = await readFile(join(f.directory, 'client.key'));
  const fingerprint = new X509Certificate(clientCert).fingerprint256.replaceAll(':', '').toLowerCase();
  const trustedImei = '123456789012345';
  const binding = await f.store.registerDevice({ imei: trustedImei, tenantId: 'tenant-b', vehicleId: 'vehicle-b', certificateFingerprint: fingerprint });
  const receiver = await f.start({ host: '0.0.0.0', tlsOptions: { key, cert: ca, ca } });
  const connect = () => connectSimulatedTracker(receiver.address.port, { tlsOptions: { key: clientKey, cert: clientCert, ca, servername: 'pilot.local' } });
  const client = await connect(); t.after(() => client.socket.destroy());
  let ack = client.readBytes(1); client.socket.write(simulatedImeiHandshake(trustedImei)); assert.equal((await ack)[0], 1);
  ack = client.readBytes(4); client.socket.write(simulatedFtc134Frame(samples)); assert.equal((await ack).readUInt32BE(), 3);
  assert.equal((await f.store.listRecords({ tenantId: binding.tenantId, deviceId: binding.id })).records.length, 3);
  const wrongBinding = await connect(); t.after(() => wrongBinding.socket.destroy());
  ack = wrongBinding.readBytes(1); wrongBinding.socket.write(simulatedImeiHandshake(IMEI)); assert.equal((await ack)[0], 0);
  const wrongPinImei = '123456789012346';
  await f.store.registerDevice({ imei: wrongPinImei, tenantId: 'tenant-a', vehicleId: 'vehicle-a', certificateFingerprint: '0'.repeat(64) });
  const wrongPin = await connect(); t.after(() => wrongPin.socket.destroy());
  ack = wrongPin.readBytes(1); wrongPin.socket.write(simulatedImeiHandshake(wrongPinImei)); assert.equal((await ack)[0], 0);
  const anonymous = await connectSimulatedTracker(receiver.address.port, { tlsOptions: { ca, servername: 'pilot.local' } });
  t.after(() => anonymous.socket.destroy());
  const rejected = anonymous.readBytes(1); anonymous.socket.write(simulatedImeiHandshake(trustedImei)); await assert.rejects(rejected);
});

test('trusted canonical registry is required; IMEI cannot enroll itself or bind to a second company', async t => {
  const f = await fixture(t);
  await assert.rejects(createTelematicsStore({ filename: join(f.directory, 'unsafe.sqlite') }), /trusted_registry_required/);
  await assert.rejects(f.store.registerDevice({ imei: '123456789012345', tenantId: 'tenant-a', vehicleId: 'vehicle-b' }), /vehicle_not_verified/);
  await assert.rejects(f.store.registerDevice({ imei: IMEI, tenantId: 'tenant-b', vehicleId: 'vehicle-b' }), /already_bound/);
  assert.deepEqual(await f.store.registerDevice({ imei: IMEI, tenantId: 'tenant-a', vehicleId: 'vehicle-a' }), f.binding);
});

test('every read is tenant-scoped, bounded and cursor-paginated without loss', async t => {
  const f = await fixture(t); await f.store.ingest(f.binding, normalized(samples));
  await assert.rejects(f.read(f.store, { tenantId: 'tenant-b' }), /not_found/);
  await assert.rejects(f.read(f.store, { limit: 5001 }), /limit_invalid/);
  const first = await f.read(f.store, { limit: 2 }); assert.equal(first.records.length, 2); assert.ok(first.next);
  const last = await f.read(f.store, { limit: 2, after: first.next }); assert.equal(last.records.length, 1); assert.equal(last.next, null);
  assert.equal(new Set([...first.records, ...last.records].map(row => row.id)).size, 3);
  await assert.rejects(f.store.ingest({ ...f.binding, tenantId: 'tenant-b' }, normalized(samples)), /binding_changed/);
});

test('restart retains records and dedupe; parallel submissions share the durable unique constraint', async t => {
  const f = await fixture(t), records = normalized(samples);
  const receipts = await Promise.all([f.store.ingest(f.binding, records), f.store.ingest(f.binding, records)]);
  assert.equal(receipts.reduce((n, receipt) => n + receipt.inserted, 0), 3);
  f.store.close(); const reopened = await f.open(), binding = await reopened.lookupDevice(IMEI);
  assert.equal((await f.read(reopened)).records.length, 3);
  assert.deepEqual(await reopened.ingest(binding, records), { accepted: 3, inserted: 0 });
  assert.equal(projectTrips((await f.read(reopened)).records).length, 1);
});

test('deactivation/re-activation invalidates old connection generation and canonical retirement rejects further ingest', async t => {
  const f = await fixture(t), records = normalized(samples);
  await f.store.setDeviceActive({ tenantId: 'tenant-a', deviceId: f.binding.id, active: false });
  assert.equal(await f.store.lookupDevice(IMEI), undefined);
  await assert.rejects(f.store.ingest(f.binding, records), /binding_changed/);
  await f.store.setDeviceActive({ tenantId: 'tenant-a', deviceId: f.binding.id, active: true });
  await assert.rejects(f.store.ingest(f.binding, records), /binding_changed/);
  const fresh = await f.store.lookupDevice(IMEI); assert.ok(fresh.generation > f.binding.generation);
  f.registry.delete('tenant-a/vehicle-a');
  await assert.rejects(f.store.lookupDevice(IMEI), /vehicle_not_verified/);
  await assert.rejects(f.store.ingest(fresh, records), /vehicle_not_verified/);
  assert.equal((await f.read()).records.length, 0);
});

test('batch rollback, conflicting identities and pilot capacity never accept a partial batch', async t => {
  const f = await fixture(t, { maxRecordsPerDevice: 1 }), records = normalized(samples);
  await assert.rejects(f.store.ingest(f.binding, records), /capacity_reached/);
  assert.equal((await f.read()).records.length, 0);
  await f.store.ingest(f.binding, records.slice(0, 1));
  assert.deepEqual(await f.store.ingest(f.binding, records.slice(0, 1)), { accepted: 1, inserted: 0 });
  await assert.rejects(f.store.ingest(f.binding, [{ ...records[0], ignition: true }]), /record_conflict/);
  assert.equal((await f.read()).records.length, 1);
});

test('storage is a privacy whitelist: no GPS, arbitrary IO, RFID or forged app provenance', async t => {
  const f = await fixture(t), records = normalized(samples);
  const decoded = decodeCodec8EFrame(simulatedFtc134Frame(samples));
  decoded.records[0].io[78] = 'f1e2d3c4b5a69788'; decoded.records[0].io[999] = 'deadbeef';
  const safe = normalizeFtc134Records(decoded.records);
  await f.store.ingest(f.binding, safe);
  for (const row of (await f.read()).records) assert.ok(Object.keys(row).every(key =>
    ['id', 'at', 'source', 'ignition', 'movement', 'odometerMeters'].includes(key)));
  await assert.rejects(f.store.ingest(f.binding, [{ ...records[0], gps: decoded.records[0].gps }]), /input_invalid/);
  await assert.rejects(f.store.ingest(f.binding, [{ ...records[0], source: 'app', driverId: 'someone' }]), /input_invalid/);
  await assert.rejects(f.store.ingest(f.binding, [{ ...records[0], defaultDriverId: 'forged-default' }]), /input_invalid/);
  for (const filename of await readdir(f.directory)) {
    const bytes = await readFile(join(f.directory, filename)), text = bytes.toString('utf8');
    for (const sensitive of ['18.1234567', '59.7654321', 'f1e2d3c4b5a69788', 'deadbeef', 'longitude', 'latitude'])
      assert.equal(text.includes(sensitive), false, `${sensitive} must not reach persistent storage`);
  }
});

test('default driver comes from the trusted company registry, snapshots history and cannot break retry ACKs', async t => {
  const f = await fixture(t), records = normalized(samples);
  f.defaults.set('tenant-a/vehicle-a', { id: 'person-niklas', tenantId: 'tenant-a', active: true });
  await f.store.ingest(f.binding, records);
  assert.ok((await f.read()).records.every(row => row.defaultDriverId === 'person-niklas'));
  f.defaults.set('tenant-a/vehicle-a', { id: 'person-other', tenantId: 'tenant-a', active: true });
  assert.deepEqual(await f.store.ingest(f.binding, records), { accepted: 3, inserted: 0 });
  assert.ok((await f.read()).records.every(row => row.defaultDriverId === 'person-niklas'));
  f.defaults.set('tenant-a/vehicle-a', { id: 'person-foreign', tenantId: 'tenant-b', active: true });
  await assert.rejects(f.store.ingest(f.binding, records), /driver_not_verified/);
  f.defaults.set('tenant-a/vehicle-a', { id: 'person-inactive', tenantId: 'tenant-a', active: false });
  const fresh = normalized([{ ...samples[0], at: '2026-10-16T08:00:00.000Z' }]);
  await f.store.ingest(f.binding, fresh);
  assert.equal((await f.read()).records.at(-1).defaultDriverId, undefined);
});
