import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore } from './environment-model.mjs';
import { createEnvironmentApi } from './environment-api.mjs';
import { createPricingStore } from './pricing.mjs';

const now = () => new Date('2026-10-16T10:00:00Z');
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const input = (changes = {}) => ({ sourceId: randomUUID(), cardId: 2050, siteId: 'norrtalje', receivedAt: '2026-10-16T10:00:00+02:00',
  rows: [{ articleId: 'lead-battery', weight: 10 }], previousHolder: { name: 'Testverkstad AB', number: '5560000167' },
  lastPlace: place, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road', incomingDocument: { status: 'provided' },
  idempotencyKey: randomUUID(), ...changes });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-environment-performance-'));
  const durable = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const counts = { reads: 0, writes: 0, principals: 0, certificates: 0, outbound: 0 };
  const repository = { ...durable,
    read(callback, options) { counts.reads++; return durable.read(callback, options); },
    transact(callback, options) { counts.writes++; return durable.transact(callback, options); },
  };
  const pricing = createPricingStore({ now }), restrictions = new Map(), grants = new Map();
  const principalStore = { ...pricing, runFresh(operation) { counts.principals++; return operation(); },
    principal(actor, effective) { const p = pricing.principal(actor, effective);
      if (restrictions.has(p.user.id)) p.user.siteIds = restrictions.get(p.user.id);
      if (grants.has(p.user.id)) p.user.permissions = grants.get(p.user.id);
      return p;
    },
  };
  const nvvClient = { async status() { counts.certificates++; return { mode: 'disabled', enabled: false, ready: false, missing: ['Avstängd'], issues: [] }; } };
  const options = { repository, principalStore, now, nvvClient,
    outboundProvider: async () => { counts.outbound++; return []; } };
  const store = createEnvironmentStore(options);
  const admin = await store.demoSession({ userId: 'admin' }), kajsa = await store.demoSession({ userId: 'kajsa' });
  const reset = () => { for (const key of Object.keys(counts)) counts[key] = 0; };
  let api, server;
  const http = async () => {
    api = createEnvironmentApi({ ...options, env: {} }); await api.initialize();
    server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, method = 'GET', value, headers = {}) => fetch(`${base}/api/environment${path}`, { method,
      headers: { Cookie: `jeroc_environment_staff=${admin.token}`, Origin: base,
        'X-Environment-Actual-User': 'admin', 'X-Environment-Effective-User': 'admin', 'X-Environment-CSRF': admin.result.csrfToken,
        ...(value !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
    return call;
  };
  try { await run({ store, repository, durable, counts, reset, admin, kajsa, restrictions, grants, http, options }); }
  finally { if (server) await new Promise(resolve => server.close(resolve)); if (api) await api.close(); else await durable.close(); await rm(directory, { recursive: true, force: true }); }
}

test('environment catalog, session, draft and storage reads have no writes or NVV/certificate warm chain', async () => fixture(async f => {
  f.reset(); await f.store.catalog();
  assert.deepEqual(f.counts, { reads: 1, writes: 0, principals: 0, certificates: 0, outbound: 0 });
  f.reset(); await f.store.session(f.admin.token); await f.store.draft(randomUUID(), f.admin.token);
  assert.deepEqual(f.counts, { reads: 2, writes: 0, principals: 2, certificates: 0, outbound: 0 });
  f.reset(); const storage = await f.store.checkStorage({ siteId: 'norrtalje', rows: [{ articleId: 'lead-battery', weight: 10 }] }, f.admin.token);
  assert.equal(storage.canReceive, true);
  assert.deepEqual(f.counts, { reads: 1, writes: 0, principals: 1, certificates: 0, outbound: 1 });
}));

test('HTTP storage preview validates cookie, identity and CSRF in its single read operation', async () => fixture(async f => {
  const call = await f.http(), request = { siteId: 'norrtalje', rows: [{ articleId: 'lead-battery', weight: 10 }] };
  f.reset(); assert.equal((await call('/storage/check', 'POST', request)).status, 200);
  assert.deepEqual(f.counts, { reads: 1, writes: 0, principals: 1, certificates: 0, outbound: 1 });
  f.reset(); const csrf = await call('/storage/check', 'POST', request, { 'X-Environment-CSRF': '' });
  assert.equal(csrf.status, 403); assert.equal((await csrf.json()).code, 'csrf_required'); assert.equal(f.counts.writes, 0);
  f.reset(); const identity = await call('/storage/check', 'POST', request, { 'X-Environment-Effective-User': 'kajsa' });
  assert.equal(identity.status, 403); assert.equal((await identity.json()).code, 'session_identity_mismatch'); assert.equal(f.counts.reads, 1);
  const logout = await call('/logout', 'POST', {}, { 'X-Environment-CSRF': '' });
  assert.equal(logout.status, 403); assert.equal((await f.store.session(f.admin.token)).effectiveUserId, 'admin');
}));

test('a committed HTTP receipt returns an immediately applicable source patch; unrelated sources stay out', async () => fixture(async f => {
  const unrelated = await f.store.receive(input({ cardId: 2051 }), f.admin.token);
  const call = await f.http(), request = input(); f.reset();
  const response = await call('/receipts', 'POST', request); assert.equal(response.status, 201);
  const committed = await response.json(), patch = committed.environmentPatch;
  assert.equal(patch.sourceId, request.sourceId); assert.equal(patch.receipt.id, committed.id); assert.equal(patch.draft, null);
  assert.equal(patch.inventory.length, 1); assert.equal(patch.reports.length, 1); assert.equal(patch.municipalities.some(item => item.code === '0188'), true);
  assert.equal(JSON.stringify(patch).includes(unrelated.id), false); assert.equal(f.counts.writes, 1); assert.equal(f.counts.reads, 0); assert.equal(f.counts.certificates, 0);
  const reread = await call(`/sources/${request.sourceId}`); assert.equal(reread.status, 200);
  assert.equal((await reread.json()).receipt.hash, committed.hash);
}));

test('targeted source projection and mutations retain live permission and facility checks', async () => fixture(async f => {
  const original = await f.store.receive(input({ siteId: 'rimbo' }), f.admin.token);
  f.restrictions.set('kajsa', ['norrtalje']);
  await assert.rejects(() => f.store.source(original.sourceId, f.kajsa.token), error => error.status === 403 && error.code === 'site_forbidden');
  f.restrictions.delete('kajsa'); f.grants.set('kajsa', []);
  await assert.rejects(() => f.store.source(original.sourceId, f.kajsa.token), error => error.status === 403 && error.code === 'forbidden');
  await assert.rejects(() => f.store.receive(input(), f.kajsa.token), error => error.status === 403 && error.code === 'forbidden');
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 1);
}));

test('stock preview includes every signed correction once and never changes the frozen receipt', async () => fixture(async f => {
  const request = input(), receipt = await f.store.receive(request, f.admin.token);
  const { sourceId, cardId, siteId, idempotencyKey, ...fields } = request;
  await f.store.correct(receipt.id, { ...fields, expectedVersion: 1, reason: 'Kontrollvägning', rows: [{ articleId: 'lead-battery', weight: 7 }], idempotencyKey: randomUUID() }, f.admin.token);
  const check = await f.store.checkStorage({ siteId: 'norrtalje', receiptId: receipt.id, rows: [{ articleId: 'lead-battery', weight: 8 }] }, f.admin.token);
  const total = check.checks.find(item => item.code === 'site_policy_unconfigured');
  assert.equal(total.currentKg, 7); assert.equal(total.incomingKg, 1); assert.equal(total.projectedKg, 8);
  const state = await f.durable.read(state => state);
  assert.equal(state.receipts[0].snapshot.rows[0].weight, 10); assert.equal(state.inventory[0].weight, 10);
  assert.equal(state.corrections[0].inventoryMovements[0].weight, -3);
}));


test('environment invalidation is emitted after persistence and never turns a committed receipt into a failed save', async () => fixture(async f => {
  let notify; const observed = new Promise(resolve => { notify = resolve; });
  const linked = createEnvironmentStore({ ...f.options, onChanged: async revision => {
    const recorded = await f.durable.read(state => ({ revision: state.revision, receipts: state.receipts.length }));
    notify(recorded); assert.equal(recorded.revision, revision);
    throw new Error('Simulerat notifieringsavbrott efter commit');
  } });
  const committed = await linked.receive(input(), f.admin.token);
  assert.equal(committed.status, 'recorded'); assert.equal((await observed).receipts, 1);
  assert.equal((await f.store.source(committed.sourceId, f.admin.token)).receipt.id, committed.id);
}));
