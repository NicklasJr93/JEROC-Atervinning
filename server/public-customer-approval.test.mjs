import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPublicCustomerApproval, PUBLIC_APPROVAL_LIMITS } from './public-customer-approval.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const a = { id: randomUUID(), name: 'Återvinning Alpha', status: 'active', storageSchema: 'jeroc_t_1234567890123456' };
const b = { id: randomUUID(), name: 'Återvinning Beta', status: 'active', storageSchema: 'jeroc_t_6543210987654321' };
const tokenA = 'a'.repeat(43), tokenB = 'b'.repeat(43), approvalA = randomUUID(), approvalB = randomUUID();
const at = Date.parse('2026-10-20T10:00:00Z');
const link = (token, approvalId) => ({ tokenHash: digest(token), approvalId, expiresAt: new Date(at + 86400000).toISOString() });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'public-customer-approval-'));
  let repository = await createPlatformStorage({ filename: join(directory, 'platform.sqlite'), env: {} });
  let clock = at, badId = false, outage = false;
  const opened = [], responded = [];
  const options = () => ({ repository, now: () => clock, openCompany: async company => {
    opened.push(company.id);
    if (outage) throw Object.assign(new Error(`PRIVATE_DATABASE_URL/${tokenA}`), { status: 503 });
    const read = token => ({ companyName: company.name, approval: { id: badId ? randomUUID() : token === tokenA ? approvalA : approvalB, status: 'waiting' } });
    return { terminalDemoApi: { remoteRead: async token => read(token), remoteRespond: async (token, body) => {
      responded.push({ companyId: company.id, token, body }); return read(token);
    } } };
  } });
  let api = createPublicCustomerApproval(options());
  const server = createServer((req, res) => {
    void api.handle(req, res, new URL(req.url, 'http://localhost')).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await repository.transact(state => { state.companies = [a, b]; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (token, body, headers = {}, suffix = '') => {
    const response = await fetch(`${base}/api/public/customer-approval${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try {
    await run({ api, request, opened, responded, get repository() { return repository; }, base, advance: delta => { clock += delta; },
      badId: () => { badId = true; }, outage: () => { outage = true; },
      reopen: async () => { await repository.close(); repository = await createPlatformStorage({ filename: join(directory, 'platform.sqlite'), env: {} }); api = createPublicCustomerApproval(options()); return api; } });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('durable hash routing selects only the token tenant and ignores staff/tenant cookies and forged headers', () => fixture(async f => {
  await f.api.register(a.id, link(tokenA, approvalA)); await f.api.register(b.id, link(tokenB, approvalB));
  await f.reopen();
  const read = await f.request(tokenA, undefined, { cookie: `jeroc_platform=${tokenB}; jeroc_terminal_demo_device=${tokenB}`, 'x-client-company': b.id, 'x-demo-actor': 'admin' });
  assert.equal(read.status, 200); assert.equal(read.body.companyName, a.name); assert.equal(read.body.approval.id, approvalA);
  assert.deepEqual(f.opened, [a.id]); assert.match(read.headers.get('cache-control'), /no-store/);
  assert.equal(read.headers.get('referrer-policy'), 'no-referrer');
  const body = { action: 'id_requested', termsAccepted: true };
  assert.equal((await f.request(tokenB, body, {}, '/respond')).status, 200);
  assert.deepEqual(f.responded, [{ companyId: b.id, token: tokenB, body }]);
  const durable = await f.repository.read(state => JSON.stringify(state.customerApprovalLinks));
  assert.ok(!durable.includes(tokenA) && !durable.includes(tokenB)); assert.ok(durable.includes(digest(tokenA)));
}));

test('missing, invented, expired and inactive-company links never open business services or reveal data', () => fixture(async f => {
  await f.api.register(a.id, link(tokenA, approvalA)); await f.api.register(b.id, link(tokenB, approvalB));
  const missing = await f.request(undefined), unknown = await f.request('x'.repeat(43));
  assert.equal(missing.status, 410); assert.deepEqual(missing.body, unknown.body);
  await f.repository.transact(state => { state.companies.find(company => company.id === b.id).status = 'inactive'; });
  assert.deepEqual((await f.request(tokenB)).body, missing.body);
  f.advance(86400001);
  assert.deepEqual((await f.request(tokenA)).body, missing.body);
  assert.deepEqual((await f.request(tokenA, { action: 'id_requested', termsAccepted: true }, {}, '/respond')).body, missing.body);
  assert.equal(f.opened.length, 0);
}));

test('routing registration is idempotent, detects collisions, binds the company and prunes expired records', () => fixture(async f => {
  const input = link(tokenA, approvalA);
  await f.api.register(a.id, input); await f.api.register(a.id, input);
  assert.equal(await f.repository.read(state => state.customerApprovalLinks.length), 1);
  await assert.rejects(f.api.register(b.id, input), error => error.code === 'customer_approval_link_conflict');
  await assert.rejects(f.api.register('unregistered', link(tokenB, approvalB)), error => error.status === 410);
  for (const invalid of [{ ...input, token: tokenA }, { ...input, tokenHash: tokenA }, { ...input, expiresAt: new Date(at - 1).toISOString() }])
    await assert.rejects(f.api.register(a.id, invalid), error => error.code === 'customer_approval_link_invalid');
  f.advance(86400001);
  await f.api.register(b.id, { ...link(tokenB, approvalB), expiresAt: new Date(at + 2 * 86400000).toISOString() });
  assert.equal(await f.repository.read(state => state.customerApprovalLinks.length), 1);
}));

test('same-origin, header-only capability and bounded JSON checks reject unsafe requests before actions', () => fixture(async f => {
  await f.api.register(a.id, link(tokenA, approvalA));
  assert.equal((await f.request(tokenA, undefined, { origin: 'https://foreign.invalid' })).status, 403);
  assert.equal((await f.request(tokenA, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.request(tokenA, undefined, {}, `?token=${tokenA}`)).status, 410);
  assert.equal((await f.request(tokenA, {}, { 'Content-Type': 'text/plain' }, '/respond')).status, 415);
  assert.equal((await f.request(tokenA, { comment: 'x'.repeat(PUBLIC_APPROVAL_LIMITS.bodyBytes) }, {}, '/respond')).status, 413);
  assert.equal((await f.request(tokenA, {}, {}, '/approve')).status, 404);
  assert.equal(f.responded.length, 0); assert.equal(f.opened.length, 0);
}));

test('wrong approval identity and internal failures produce no snapshot, credentials or token in responses', () => fixture(async f => {
  await f.api.register(a.id, link(tokenA, approvalA));
  f.badId(); const mismatch = await f.request(tokenA);
  assert.equal(mismatch.status, 410); assert.equal(mismatch.body.approval, undefined);
  f.outage(); const failed = await f.request(tokenA);
  assert.equal(failed.status, 503); assert.equal(failed.body.approval, undefined);
  assert.ok(!JSON.stringify(failed.body).includes('PRIVATE_DATABASE_URL')); assert.ok(!JSON.stringify(failed.body).includes(tokenA));
}));

test('public request limits bound polling and reset after the next minute', () => fixture(async f => {
  for (let i = 0; i < PUBLIC_APPROVAL_LIMITS.requestsPerIpMinute; i++) assert.equal((await f.request(undefined)).status, 410);
  const limited = await f.request(undefined); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(f.opened.length, 0); f.advance(60000); assert.equal((await f.request(undefined)).status, 410);
}));
