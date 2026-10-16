import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createDemoTelematicsStore } from './telematics/demo-store.mjs';
import { createDemoTelematicsService } from './telematics/demo-service.mjs';
import { encodeSyntheticFmc003Frame } from './telematics/virtual-fmc003.mjs';

const samples = [
  { at: '2026-10-16T07:00:00.000Z', engineOn: false, tripActive: false, odometerMeters: 1000 },
  { at: '2026-10-16T07:01:00.000Z', engineOn: true, tripActive: true, odometerMeters: 1000 },
  { at: '2026-10-16T07:10:00.000Z', engineOn: true, tripActive: false, odometerMeters: 2500 },
].map((sample, index) => ({ simulated: true, lat: 59.76 + index / 1000, lng: 18.7,
  speedKmh: index === 1 ? 40 : 0, angle: 15, rpm: 780, fuelPercent: 68,
  coolantC: 18, batteryVolts: 14.2, fuelRateLh: 0.8, ...sample }));

async function fixture(t, { storeOptions = {}, serviceOptions = {}, wrapStore = value => value } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-demo-http-'));
  const filename = join(directory, 'demo.sqlite'), token = randomBytes(32).toString('hex');
  let store, service;
  const start = async () => {
    store = await createDemoTelematicsStore({ filename, ...storeOptions });
    service = await createDemoTelematicsService({ store: wrapStore(store), token, ...serviceOptions });
  };
  await start();
  t.after(async () => { await service?.close(); await store?.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, { method = 'GET', body, auth = token, contentType, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.address.port}${path}`, { method,
      headers: { ...(auth !== null && { authorization: `Bearer ${auth}` }),
        ...(contentType && { 'content-type': contentType }), ...headers }, body });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, bytes,
      json: response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(bytes.toString()) : undefined };
  };
  const register = (streamId = randomUUID()) => request('/v1/demo/streams', {
    method: 'POST', body: JSON.stringify({ streamId }), contentType: 'application/json',
  }).then(result => ({ ...result, streamId }));
  const send = (streamId, frame = encodeSyntheticFmc003Frame(samples)) => request(`/v1/demo/streams/${streamId}/frames`, {
    method: 'POST', body: frame, contentType: 'application/octet-stream',
  });
  return { token, request, register, send, get store() { return store; }, get port() { return service.address.port; },
    async reopen() { await service.close(); await store.close(); await start(); } };
}

test('the independent receiver authenticates stream reads, readiness and every write without browser CORS', async t => {
  const f = await fixture(t);
  for (const path of ['/readyz', '/v1/demo/streams', `/v1/demo/streams/${randomUUID()}`]) {
    const response = await f.request(path, { auth: null });
    assert.equal(response.status, 401); assert.equal(response.json.code, 'demo_auth_required');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.request('/readyz', { auth: 'wrong-token' })).status, 401);
  assert.equal((await f.request('/healthz')).status, 200);
  assert.equal((await f.request('/readyz')).status, 200);
  await assert.rejects(createDemoTelematicsService({ store: f.store, token: 'short' }), /configuration_invalid/);
});

test('public health returns only status without database access and has its own bounded traffic budget', async t => {
  let reads = 0;
  const f = await fixture(t, { serviceOptions: { requestBurst: 2, requestPeriodMs: 60000 },
    wrapStore: store => ({ ...store, ready() { reads++; return true; } }) });
  for (let index = 0; index < 2; index++) {
    const response = await f.request('/healthz', { auth: null });
    assert.equal(response.status, 200); assert.deepEqual(response.json, { status: 'ok' });
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(reads, 0);
  assert.equal((await f.request('/healthz', { auth: null })).status, 429);
  assert.equal((await f.request('/healthz', { auth: null, method: 'POST' })).status, 401);
  assert.equal((await f.request('/readyz', { auth: null })).status, 401);
  assert.equal((await f.request('/readyz')).status, 200); assert.equal(reads, 1);
});

test('registration is strict, idempotent and accepts only fictional UUID streams', async t => {
  const f = await fixture(t), streamId = randomUUID();
  for (const input of [{ streamId, tenantId: 'real-company' }, { streamId, imei: '356307042441013' }, { streamId: '356307042441013' }, []]) {
    const response = await f.request('/v1/demo/streams', { method: 'POST', contentType: 'application/json', body: JSON.stringify(input) });
    assert.equal(response.status, 422);
  }
  assert.equal((await f.register(streamId)).status, 200);
  assert.equal((await f.register(streamId)).status, 200);
  const response = await f.request(`/v1/demo/streams/${streamId}`);
  assert.equal(response.status, 200); assert.equal(response.json.storage, 'sqlite');
  assert.equal(response.json.recordsStored, 0); assert.equal(response.json.lastRecord, null);
  assert.equal((await f.request(`/v1/demo/streams/${randomUUID()}`)).status, 404);
  assert.equal((await f.request('/v1/demo/streams')).status, 405);
  assert.equal((await f.request('/v1/demo/streams?tenantId=other')).status, 400);
});

test('binary ACK follows durable storage; exact retries and reopening preserve records and committed summaries', async t => {
  const f = await fixture(t), { streamId } = await f.register();
  const first = await f.send(streamId);
  assert.equal(first.status, 200); assert.equal(first.bytes.length, 4); assert.equal(first.bytes.readUInt32BE(), 3);
  assert.equal(first.headers.get('content-type'), 'application/octet-stream');
  let summary = (await f.request(`/v1/demo/streams/${streamId}`)).json;
  assert.equal(summary.recordsStored, 3); assert.equal(summary.packetsReceived, 1);
  assert.equal(summary.distanceKm, 1.5); assert.equal(summary.trips, 1);
  assert.equal(summary.lastRecord.odometerMeters, 2500); assert.equal(summary.recentRecords.length, 3);
  assert.deepEqual(summary.recentRecords.map(row => row.at), samples.map(row => row.at));
  for (const row of summary.recentRecords) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'lat', 'lng', 'speedKmh', 'rpm', 'fuelPercent', 'coolantC', 'batteryVolts', 'odometerMeters', 'ignition', 'movement'].sort());
  }
  await f.reopen();
  assert.equal((await f.send(streamId)).bytes.readUInt32BE(), 3);
  summary = (await f.request(`/v1/demo/streams/${streamId}`)).json;
  assert.equal(summary.recordsStored, 3); assert.equal(summary.packetsReceived, 2);
  assert.equal(summary.distanceKm, 1.5); assert.equal(summary.trips, 1);
});

test('stream boundaries keep counters and records independent even for identical frame bytes', async t => {
  const f = await fixture(t), a = await f.register(), b = await f.register();
  await f.send(a.streamId);
  assert.equal((await f.request(`/v1/demo/streams/${b.streamId}`)).json.recordsStored, 0);
  await f.send(b.streamId);
  assert.equal((await f.request(`/v1/demo/streams/${a.streamId}`)).json.recordsStored, 3);
  assert.equal((await f.request(`/v1/demo/streams/${b.streamId}`)).json.recordsStored, 3);
});

test('CRC, body size, content type and required FMC003 signals fail without ACK or partial records', async t => {
  const f = await fixture(t), { streamId } = await f.register();
  const crc = encodeSyntheticFmc003Frame(samples); crc[crc.length - 1] ^= 1;
  const responses = [
    [await f.send(streamId, crc), 422],
    [await f.send(streamId, Buffer.alloc(65537)), 413],
    [await f.send(streamId, encodeSyntheticFmc003Frame([{ ...samples[0], fuelPercent: 101 }])), 422],
    [await f.request(`/v1/demo/streams/${streamId}/frames`, { method: 'POST', contentType: 'application/json', body: '{}' }), 415],
  ];
  for (const [response, status] of responses) {
    assert.equal(response.status, status); assert.match(response.headers.get('content-type'), /application\/json/);
    assert.ok(response.json.code); assert.notEqual(response.bytes.length, 4);
  }
  const summary = (await f.request(`/v1/demo/streams/${streamId}`)).json;
  assert.equal(summary.recordsStored, 0); assert.equal(summary.packetsReceived, 0);
});

test('storage commit gates the network ACK and storage exceptions never become success', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { wrapStore: store => ({ ...store, async ingest(...args) { entered(); await gate; return store.ingest(...args); } }) });
  const { streamId } = await f.register(); let answered = false;
  const result = f.send(streamId).then(value => { answered = true; return value; });
  await started; await delay(10);
  assert.equal(answered, false); assert.equal((await f.store.summary(streamId)).recordsStored, 0);
  release(); assert.equal((await result).bytes.readUInt32BE(), 3);
  const failure = await fixture(t, { wrapStore: store => ({ ...store, async ingest() { throw new Error('private SQL / token details'); } }) });
  const failedStream = await failure.register(), rejected = await failure.send(failedStream.streamId);
  assert.equal(rejected.status, 503); assert.equal(rejected.json.code, 'demo_storage_unavailable');
  assert.equal(rejected.bytes.toString().includes('private'), false);
  assert.equal((await failure.store.summary(failedStream.streamId)).recordsStored, 0);
});

test('capacity rejects a whole frame with no ACK and recent-record summary stays bounded', async t => {
  const f = await fixture(t, { storeOptions: { maxRecordsPerStream: 2 } }), stream = await f.register();
  const result = await f.send(stream.streamId);
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '1');
  assert.equal((await f.store.summary(stream.streamId)).recordsStored, 0);
  const g = await fixture(t), other = await g.register();
  const many = Array.from({ length: 15 }, (_, index) => ({ ...samples[0], at: new Date(Date.parse(samples[0].at) + index * 1000).toISOString(), odometerMeters: 1000 + index }));
  assert.equal((await g.send(other.streamId, encodeSyntheticFmc003Frame(many))).bytes.readUInt32BE(), 15);
  const summary = await g.store.summary(other.streamId);
  assert.equal(summary.recordsStored, 15); assert.equal(summary.recentRecords.length, 10);
  assert.deepEqual(summary.recentRecords.map(row => row.at), many.slice(-10).map(row => row.at));
});

test('an incomplete body times out without committing or acknowledging a frame', async t => {
  const f = await fixture(t, { serviceOptions: { bodyTimeoutMs: 20, requestTimeoutMs: 100 } }), stream = await f.register();
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: f.port, path: `/v1/demo/streams/${stream.streamId}/frames`,
      method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/octet-stream' } }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode, bytes: Buffer.concat(parts) }); });
    });
    request.on('error', reject); request.write(Buffer.from([0]));
  });
  assert.equal(result.status, 408); assert.equal(JSON.parse(result.bytes.toString()).code, 'demo_body_timeout');
  assert.equal((await f.store.summary(stream.streamId)).recordsStored, 0);
});
