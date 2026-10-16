import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createDemoReceiverRuntime } from './telematics/demo-runtime.mjs';
import { createDemoTelematicsClient, createServiceTestCar, validateDemoEndpoint } from './telematics/demo-client.mjs';
import { createTestCarApi } from './telematics/testcar-api.mjs';
import { encodeSyntheticFmc003Frame } from './telematics/virtual-fmc003.mjs';

const sample = (at = new Date().toISOString()) => ({ simulated: true, at, lat: 59.76, lng: 18.7, angle: 90,
  speedKmh: 35, rpm: 1800, coolantC: 45, fuelPercent: 67, fuelRateLh: 4, batteryVolts: 14.2,
  engineOn: true, tripActive: true, odometerMeters: 12345000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Expected receiver state did not arrive'); await sleep(300); }
}

test('separate receiver commits, survives process restart and deduplicates the identical frame', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-demo-process-'));
  const env = { TELEMATICS_SQLITE_PATH: join(directory, 'isolated.sqlite') };
  let runtime = createDemoReceiverRuntime({ env }), client, other;
  t.after(async () => { client?.close(); other?.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const streamId = randomUUID();
  client = createDemoTelematicsClient({ endpoint: runtime.ready, streamId });
  await client.initialize();
  const bytes = encodeSyntheticFmc003Frame([sample()]);
  assert.equal((await client.send(bytes)).readUInt32BE(), 1);
  assert.equal(client.snapshot().recordsStored, 1);
  assert.equal(client.snapshot().storage, 'sqlite');
  assert.equal(client.snapshot().lastRecord.rpm, 1800);
  client.close(); await runtime.close();
  runtime = createDemoReceiverRuntime({ env });
  client = createDemoTelematicsClient({ endpoint: runtime.ready, streamId });
  await client.initialize();
  assert.equal(client.snapshot().recordsStored, 1, 'committed data survives a real child-process restart');
  assert.equal((await client.send(bytes)).readUInt32BE(), 1);
  assert.equal(client.snapshot().recordsStored, 1, 'retry does not insert again');
  assert.equal(client.snapshot().packetsReceived, 2);
  other = createDemoTelematicsClient({ endpoint: runtime.ready });
  await other.initialize(); assert.equal(other.snapshot().recordsStored, 0, 'new stream has no access to another stream');
});

test('actual browser API uses only the separate receiver and reset creates a new isolated stream', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-demo-api-process-'));
  const runtime = createDemoReceiverRuntime({ env: { TELEMATICS_SQLITE_PATH: join(directory, 'isolated.sqlite') } });
  let wall = Date.now();
  const api = createTestCarApi({ now: () => wall, autoTick: false,
    factory: () => createServiceTestCar({ createClient: runtime.createClient, now: () => new Date(wall), random: () => 0.5 }) });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); await new Promise(resolve => server.close(resolve)); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/testcar/session`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const initial = await response.json();
  assert.equal(initial.car.receiver.channel, 'separate_http');
  const get = async () => (await (await fetch(`${base}/api/testcar/state`, { headers: { cookie } })).json()).car;
  const command = async value => (await (await fetch(`${base}/api/testcar/command`, { method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json', 'x-testcar-csrf': initial.csrfToken }, body: JSON.stringify(value) })).json()).car;
  await until(async () => (await get()).receiver.status === 'ready');
  await command({ action: 'start' });
  await until(async () => (await get()).stats.recordsReceived === 1);
  let state = await get();
  assert.equal(state.receiver.storage, 'sqlite'); assert.equal(state.device.transport, 'http');
  assert.equal(state.stats.pendingRecords, 0); assert.equal(state.receiver.recentRecords.length, 1);
  await command({ action: 'drive', destination: 'customer1' });
  wall += 2000; api.tick();
  await until(async () => (await get()).stats.recordsReceived >= 2);
  state = await get(); assert.ok(state.telemetry.speedKmh > 0); assert.equal(state.currentPlace.id, null);
  await command({ action: 'reset' });
  await until(async () => (await get()).receiver.status === 'ready');
  state = await get(); assert.equal(state.stats.recordsReceived, 0); assert.equal(state.currentPlace.id, 'office');
  assert.equal(state.receiver.recentRecords.length, 0);
});

test('transport outage applies real-time backoff without inventing an ACK or discarding the car queue', async () => {
  let calls = 0, wall = Date.now();
  const endpoint = async () => ({ url: 'http://127.0.0.1:3001', token: 'test-only-transport-token-with-32-bytes' });
  const client = createDemoTelematicsClient({ endpoint, now: () => wall, fetchImpl: async () => { calls++; throw new Error('local injected outage'); } });
  const car = createServiceTestCar({ createClient: () => client, now: () => new Date(wall) });
  car.command({ action: 'start' }); await until(() => client.snapshot().status === 'unavailable');
  const count = calls; car.tick(1); await sleep(0);
  assert.equal(calls, count); assert.ok(car.snapshot().stats.pendingRecords > 0);
  assert.equal(car.snapshot().stats.recordsReceived, 0); assert.equal(car.snapshot().receiver.status, 'unavailable');
  wall += 60000; car.tick(4); await until(() => calls > count);
  assert.equal(car.snapshot().stats.recordsReceived, 0); car.close();
});

test('remote endpoint configuration rejects credential-bearing/cleartext URLs and never starts a fallback child', async () => {
  for (const value of ['http://example.com', 'https://name:password@example.com', 'https://example.com/other', 'https://example.com/?token=x'])
    assert.throws(() => validateDemoEndpoint(value));
  assert.equal(validateDemoEndpoint('https://receiver.example.com'), 'https://receiver.example.com');
  let spawned = 0;
  const runtime = createDemoReceiverRuntime({ env: { TELEMATICS_SERVICE_URL: 'http://example.com', TELEMATICS_SERVICE_TOKEN: 'test-only-token-with-at-least-32-bytes' },
    spawnImpl: () => { spawned++; throw new Error('must not spawn'); } });
  await assert.rejects(runtime.ready(), /unavailable/); assert.equal(spawned, 0); await runtime.close();
});

test('a valid ACK survives a failed follow-up summary and no secrets escape the public snapshot', async () => {
  const streamId = randomUUID(), token = 'test-only-transport-token-with-32-bytes';
  const client = createDemoTelematicsClient({ endpoint: async () => ({ url: 'https://receiver.example.com', token }), streamId,
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error');
      if (String(url).endsWith('/streams')) return new Response(JSON.stringify({ simulated: true, streamId, storage: 'sqlite' }));
      if (options.method === 'POST') return new Response(Buffer.from([0, 0, 0, 1]));
      throw new Error(`private message ${token}`);
    } });
  const ack = await client.send(encodeSyntheticFmc003Frame([sample()]));
  assert.equal(ack.readUInt32BE(), 1);
  const snapshot = JSON.stringify(client.snapshot());
  assert.equal(snapshot.includes(token), false); assert.equal(snapshot.includes('receiver.example.com'), false);
  assert.equal(client.snapshot().status, 'unavailable'); client.close();
});

test('a timed-out child cannot publish a late address and is killed before replacement', async () => {
  const child = new EventEmitter(); child.pid = 123;
  const signals = []; let spawned = 0;
  child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', 1)); return true; };
  const runtime = createDemoReceiverRuntime({ env: {}, startupTimeoutMs: 20, spawnImpl: () => { spawned++; return child; } });
  const assertion = assert.rejects(runtime.ready(), /unavailable/);
  await Promise.all([assertion, sleep(40)]);
  child.emit('message', { type: 'telematics-ready', port: 3001 });
  await assert.rejects(runtime.ready(), /unavailable/);
  assert.equal(spawned, 1); await sleep(550);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  await runtime.close();
});

test('engine-off car retries its final frame through the real receiver after an outage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'scrappilot-demo-final-frame-'));
  const runtime = createDemoReceiverRuntime({ env: { TELEMATICS_SQLITE_PATH: join(directory, 'isolated.sqlite') } });
  let wall = Date.now(), failing = true, car;
  const api = createTestCarApi({ now: () => wall, autoTick: false, factory: () => {
    car = createServiceTestCar({ now: () => new Date(wall), createClient: () => createDemoTelematicsClient({ endpoint: runtime.ready, now: () => wall,
      fetchImpl: (url, options) => { if (failing && String(url).endsWith('/frames')) throw new Error('injected network outage'); return fetch(url, options); } }) });
    return car;
  } });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, 'http://localhost')); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { api.close(); await new Promise(resolve => server.close(resolve)); await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  await (await fetch(`http://127.0.0.1:${server.address().port}/api/testcar/session`)).arrayBuffer();
  await until(() => car.snapshot().receiver.status === 'ready');
  car.command({ action: 'start' });
  await until(() => car.snapshot().receiver.status === 'unavailable');
  car.command({ action: 'stop' });
  assert.equal(car.snapshot().engineOn, false); assert.ok(car.snapshot().stats.pendingRecords >= 2);
  failing = false;
  for (let i = 0; i < 4; i++) { wall += 5000; api.tick(); await sleep(50); }
  await until(() => car.snapshot().stats.pendingRecords === 0);
  const saved = car.snapshot();
  assert.ok(saved.receiver.recordsStored >= 2); assert.equal(saved.receiver.lastRecord.ignition, false);
  assert.equal(saved.engineOn, false, 'delivery does not require starting the engine again');
});
