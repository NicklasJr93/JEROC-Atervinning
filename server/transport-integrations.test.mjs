import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPricingStore, PricingError } from './pricing.mjs';
import { createTransportIntegrationsApi, createTransportOutbox } from './transport-integrations.mjs';

const event = (id = 'event-1', extra = {}) => ({
  id, type: 'work_order.booked', orderId: 'AO-1043', at: '2026-10-08T10:00:00.000Z', bookingVersion: 1,
  customer: { id: 'customer-andersson', name: 'Andersson Entreprenad' }, driver: { id: 'kalle', name: 'Kalle' },
  afterPlan: { date: '2026-10-09', startMinute: 600, durationMinutes: 60, driverId: 'kalle', vehicleId: 'vehicle-kalle' },
  actor: 'Kajsa Nilsson · Kontor Norrtälje', actualUserId: 'kajsa', effectiveUserId: 'kajsa', ...extra,
});
const setup = (options = {}) => {
  const principalStore = createPricingStore();
  const outbox = createTransportOutbox(options);
  return { principalStore, outbox, kajsa: principalStore.principal('kajsa'), anna: principalStore.principal('anna'), admin: principalStore.principal('admin') };
};
const rejects = (action, status) => assert.throws(action, (error) => error instanceof PricingError && error.status === status);

test('preparation is idempotent, protects event identities and rejects a conflicting batch atomically', () => {
  const { outbox, kajsa } = setup();
  const first = outbox.prepare({ events: [event()] }, kajsa);
  assert.equal(first.prepared, 1);
  assert.equal(first.deliveryEnabled, false);
  assert.equal(first.memoryOnly, true);
  const retry = outbox.prepare({ events: [event(), event()] }, kajsa);
  assert.equal(retry.prepared, 0);
  assert.equal(retry.duplicates, 2);
  assert.deepEqual(retry.acceptedIds, ['event-1']);
  rejects(() => outbox.prepare({ events: [event('new'), event('event-1', { orderId: 'AO-9999' })] }, kajsa), 409);
  const result = outbox.read(kajsa);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].attempts, 0);
  assert.equal(result.entries[0].state, 'prepared');
  result.entries[0].event.customer.name = 'Changed outside the store';
  assert.equal(outbox.read(kajsa).entries[0].event.customer.name, 'Andersson Entreprenad');
});

test('preparation uses transport rights and the actual/effective identities, including Jobba som', () => {
  const { outbox, principalStore, kajsa, anna } = setup();
  rejects(() => outbox.prepare({ events: [event()] }, anna), 403);
  rejects(() => outbox.prepare({ events: [event('forged', { actualUserId: 'admin' })] }, kajsa), 403);
  outbox.prepare({ events: [event('acting', { actualUserId: 'admin' })] }, principalStore.principal('admin', 'kajsa'));
  assert.equal(outbox.read(anna).entries[0].event.actualUserId, 'admin');
  rejects(() => outbox.prepare({ events: [event('too-powerful', { actualUserId: 'admin', effectiveUserId: 'anna' })] }, principalStore.principal('admin', 'anna')), 403);
});

test('invalid payloads and full demo queues leave existing events unchanged', () => {
  const { outbox, kajsa } = setup({ maxEvents: 1 });
  rejects(() => outbox.prepare({ events: [event('bad-date', { afterPlan: { ...event().afterPlan, date: '2026-02-31' } })] }, kajsa), 400);
  rejects(() => outbox.prepare({ events: [event('fake-delivery', { deliveryEnabled: true })] }, kajsa), 400);
  outbox.prepare({ events: [event()] }, kajsa);
  rejects(() => outbox.prepare({ events: [event('second')] }, kajsa), 503);
  assert.equal(outbox.read(kajsa).entries.length, 1);
});

test('delivery is disabled without an explicit future adapter', async () => {
  const { outbox, kajsa } = setup();
  outbox.prepare({ events: [event()] }, kajsa);
  assert.deepEqual(await outbox.deliver(), { enabled: false, delivered: 0, failed: 0 });
  assert.equal(outbox.read(kajsa).entries[0].attempts, 0);
});

test('future adapter retries reuse the idempotency key and keep a delivery receipt', async () => {
  let time = new Date('2026-10-08T10:00:00Z');
  const { outbox, kajsa } = setup({ now: () => time });
  outbox.prepare({ events: [event()] }, kajsa);
  const keys = [];
  let fail = true;
  const adapter = async (payload, { idempotencyKey }) => {
    assert.equal(payload.orderId, 'AO-1043'); keys.push(idempotencyKey);
    if (fail) throw new Error('Provider unavailable');
    return { receiptId: 'provider-receipt' };
  };
  assert.deepEqual(await outbox.deliver({ adapter }), { enabled: true, delivered: 0, failed: 1 });
  const failed = outbox.read(kajsa).entries[0];
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempts, 1);
  assert.equal(failed.nextAttemptAt, '2026-10-08T10:00:30.000Z');
  await outbox.deliver({ adapter });
  assert.equal(keys.length, 1, 'A retry must wait until the next attempt time');
  fail = false; time = new Date(failed.nextAttemptAt);
  assert.deepEqual(await outbox.deliver({ adapter }), { enabled: true, delivered: 1, failed: 0 });
  assert.deepEqual(keys, ['event-1', 'event-1']);
  const delivered = outbox.read(kajsa).entries[0];
  assert.equal(delivered.attempts, 2); assert.equal(delivered.receiptId, 'provider-receipt');
  await outbox.deliver({ adapter });
  assert.equal(keys.length, 2, 'Delivered entries cannot be delivered again');
});

test('two future workers cannot deliver the same event simultaneously', async () => {
  const { outbox, kajsa } = setup();
  outbox.prepare({ events: [event()] }, kajsa);
  let resolveDelivery;
  const pending = new Promise((resolve) => { resolveDelivery = resolve; });
  let calls = 0;
  const adapter = async () => { calls += 1; await pending; };
  const first = outbox.deliver({ adapter });
  const second = await outbox.deliver({ adapter });
  assert.equal(second.delivered, 0); assert.equal(calls, 1);
  resolveDelivery(); await first;
  assert.equal(outbox.read(kajsa).entries[0].attempts, 1);
});

async function apiTest(run) {
  const { principalStore, outbox } = setup();
  const api = createTransportIntegrationsApi({ principalStore, outbox });
  const server = createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (method, actor, payload, headers = {}, path = '/api/transport/outbox') => fetch(base + path, {
    method, headers: { 'X-Demo-Actor': actor, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  try { await run({ request, principalStore, outbox }); }
  finally { server.close(); await once(server, 'close'); }
}

test('the API prepares only, enforces same-origin and has no dispatch or public response route', async () => apiTest(async ({ request }) => {
  const accepted = await request('POST', 'kajsa', { events: [event()] });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).deliveryEnabled, false);
  const read = await request('GET', 'anna');
  assert.equal(read.status, 200); assert.equal((await read.json()).entries[0].attempts, 0);
  const denied = await request('POST', 'anna', { events: [event()] }); assert.equal(denied.status, 403);
  const cross = await request('POST', 'kajsa', { events: [event()] }, { Origin: 'https://other-site.example' }); assert.equal(cross.status, 403);
  const missing = await request('GET', 'not-a-user'); assert.equal(missing.status, 401);
  const fakeActing = await request('GET', 'kajsa', undefined, { 'X-Demo-User': 'admin' }); assert.equal(fakeActing.status, 403);
  for (const path of ['/api/transport/send', '/api/transport/confirmation']) assert.equal((await request('POST', 'kajsa', { events: [event()] }, {}, path)).status, 404);
  const wrongMethod = await request('DELETE', 'kajsa'); assert.equal(wrongMethod.status, 405);
  const head = await request('HEAD', 'anna'); assert.equal(head.status, 200); assert.equal(await head.text(), '');
}));

test('the API rechecks canonical permissions after an administrator revokes access', async () => apiTest(async ({ request, principalStore }) => {
  assert.equal((await request('POST', 'kajsa', { events: [event()] })).status, 200);
  const admin = principalStore.principal('admin');
  const users = principalStore.read(admin).users.map((user) => user.id === 'kajsa' ? { ...user, permissions: user.permissions.filter((right) => right !== 'transportPlan') } : user);
  principalStore.saveUsers({ users }, admin);
  assert.equal((await request('POST', 'kajsa', { events: [event('new')] })).status, 403);
  const revokedRead = users.map((user) => user.id === 'kajsa' ? { ...user, permissions: user.permissions.filter((right) => right !== 'transportRead') } : user);
  principalStore.saveUsers({ users: revokedRead }, admin);
  assert.equal((await request('GET', 'kajsa')).status, 403);
}));
