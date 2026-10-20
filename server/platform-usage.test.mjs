import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatformUsageStorage } from './platform-usage-storage.mjs';
import { createPlatformUsage, platformUsageMonth, PLATFORM_USAGE_TARIFFS } from './platform-usage.mjs';
import { createPlatformStorage } from './platform-storage.mjs';
import { createPlatformAuth, platformPasswordHash } from './platform-auth.mjs';
import { createPlatformApi } from './platform-api.mjs';

const service = 'roaring.person.lookup', channel = 'customer_registration';
const privatePnr = '199001019999', privateName = 'PRIVATE-FICTIONAL-NAME';
const simpleAuth = { async withPlatformAdminTransaction(_req, operation) { return operation({ companies: [{ id: 'company-a', name: '=Unsafe company label' }, { id: 'company-b', name: 'Other company' }] }); } };
const failure = code => error => error.code === code;
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-platform-usage-')), env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  let storage = await createPlatformUsageStorage({ env }), clock = new Date('2026-10-20T12:00:00Z'), usage;
  const options = () => ({ storage, auth: simpleAuth, now: () => clock });
  usage = createPlatformUsage(options());
  const makeCommand = async (extra = {}) => { const input = { organisationId: 'company-a', operationId: randomUUID(), service, channel, actorId: 'opaque-user-id', ...extra }; return { ...input, fingerprint: await usage.fingerprint({ organisationId: input.organisationId, service: input.service, value: privatePnr }) }; };
  const f = { env, get storage() { return storage; }, get usage() { return usage; }, command: makeCommand, clock(value) { clock = new Date(value); },
    makeUsage: extra => createPlatformUsage({ ...options(), ...extra }),
    async reopen(extra = {}) { usage.close(); await storage.close(); storage = await createPlatformUsageStorage({ env }); usage = createPlatformUsage({ ...options(), ...extra }); },
    summary: () => usage.read({ month: '2026-10' }),
  };
  try { await run(f); } finally { usage.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); }
}
const succeed = async ({ beforeDispatch }) => { await beforeDispatch(); return { status: 'success', result: { name: privateName, personalNumber: privatePnr } }; };

test('durable HMAC fingerprints are tenant/service separated; ledger stores only IDs, amounts and outcomes, not person/provider data', () => fixture(async f => {
  const input = await f.command(), first = await f.usage.execute(input, succeed);
  assert.equal(first.replayed, false); assert.equal(first.record.status, 'success'); assert.equal(first.record.unitSalesMinor, 200); assert.equal(first.record.unitCostMinor, 200); assert.equal(first.record.billableConfirmed, true);
  assert.deepEqual(first.result, { name: privateName, personalNumber: privatePnr });
  const stored = await f.storage.list({ month: '2026-10' }), text = JSON.stringify(stored);
  for (const value of [privatePnr, privateName, 'PRIVATE-API-KEY']) assert.equal(text.includes(value), false);
  assert.equal(text.includes('result'), false); assert.match(stored[0].fingerprint, /^[a-f0-9]{64}$/); assert.equal(first.record.fingerprint, undefined); assert.equal(first.record.claimId, undefined);
  assert.notEqual(await f.usage.fingerprint({ organisationId: 'company-b', service, value: privatePnr }), input.fingerprint);
  assert.notEqual(await f.usage.fingerprint({ organisationId: 'company-a', service: 'other.lookup', value: privatePnr }), input.fingerprint);
  await f.reopen(); assert.equal(await f.usage.fingerprint({ organisationId: 'company-a', service, value: privatePnr }), input.fingerprint);
  const retry = await f.usage.execute(input, () => { throw new Error('A paid call must not repeat'); });
  assert.equal(retry.replayed, true); assert.equal(retry.record.billableConfirmed, true); assert.equal(Object.hasOwn(retry, 'result'), false);
}));

test('two storage instances reserve and dispatch a shared UUID once, reject changed fingerprints and isolate companies', () => fixture(async f => {
  const secondStorage = await createPlatformUsageStorage({ env: f.env }), second = f.makeUsage({ storage: secondStorage });
  try {
    const command = await f.command(); let release, entered, calls = 0;
    const hold = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
    const pending = f.usage.execute(command, async hooks => { entered(); await hold; await hooks.beforeDispatch(); calls++; return { status: 'success' }; });
    await ready;
    const replay = await second.execute(command, async () => { calls++; throw new Error('Duplicate dispatch'); }); assert.equal(replay.replayed, true); assert.equal(replay.record.status, 'reserved');
    assert.equal((await f.summary()).totals.providerCalls, 0, 'OAuth/preparation and reservations never count as provider requests');
    release(); await pending; assert.equal(calls, 1);
    const otherCompany = await f.command({ organisationId: 'company-b', operationId: command.operationId }); await second.execute(otherCompany, async hooks => { await hooks.beforeDispatch(); calls++; return { status: 'not_found' }; }); assert.equal(calls, 2);
    assert.equal((await f.summary()).totals.providerCalls, 2);
    await assert.rejects(second.execute({ ...command, fingerprint: 'f'.repeat(64) }, succeed), failure('platform_usage_operation_conflict'));
    await assert.rejects(second.execute({ ...command, actorId: 'different-actor' }, succeed), failure('platform_usage_operation_conflict'));
    assert.equal((await secondStorage.list({ month: '2026-10' })).length, 2);
  } finally { second.close(); await secondStorage.close(); }
}));

test('success, not-found and protected acknowledgements bill once; post-dispatch failures need review and OAuth failures count zero calls', () => fixture(async f => {
  for (const outcome of [{ status: 'success' }, { status: 'not_found' }, { status: 'rejected', billableConfirmed: true }, { status: 'failed' }, { status: 'unknown' }, { status: 'rejected' }]) await f.usage.execute(await f.command(), async ({ beforeDispatch }) => { await beforeDispatch(); return outcome; });
  await assert.rejects(f.usage.execute(await f.command(), async () => { throw new Error('PRIVATE-OAUTH-ERROR'); }), /PRIVATE-OAUTH-ERROR/);
  const summary = await f.summary();
  assert.deepEqual(summary.totals, { providerCalls: 6, billableCount: 3, reviewCount: 3, reservedCount: 0, notDispatchedCount: 1, success: 1, notFound: 1, rejected: 3, failed: 1, unknown: 1, costMinor: 1200, salesMinor: 600, reviewSalesMinor: 600 });
  const raw = await f.storage.list({ month: '2026-10' }); assert.equal(JSON.stringify(raw).includes('PRIVATE-OAUTH-ERROR'), false);
  const beforeDispatchRejected = raw.find(record => !record.dispatchedAt); assert.equal(beforeDispatchRejected.status, 'rejected'); assert.equal(beforeDispatchRejected.billableConfirmed, false);
  const noResult = await f.usage.execute(await f.command(), async () => ({ status: 'success' })).catch(error => error); assert.equal(noResult.code, 'platform_usage_dispatch_missing');
  assert.equal((await f.summary()).totals.providerCalls, 6);
}));

test('timeouts and lost acknowledgement never re-dispatch or double-charge across restart', () => fixture(async f => {
  let calls = 0; const command = await f.command();
  await assert.rejects(f.usage.execute(command, async ({ beforeDispatch }) => { await beforeDispatch(); calls++; throw new Error('Simulated timeout with PRIVATE body'); }), /Simulated timeout/);
  await f.reopen(); const retry = await f.usage.execute(command, async () => { calls++; return { status: 'success' }; });
  assert.equal(retry.replayed, true); assert.equal(retry.record.status, 'unknown'); assert.equal(retry.record.billableConfirmed, false); assert.equal(calls, 1); assert.equal((await f.summary()).totals.reviewSalesMinor, 200);
  const originalFinish = f.storage.finish.bind(f.storage); let loseAck = true;
  const flakyStorage = { reserve: f.storage.reserve.bind(f.storage), markDispatched: f.storage.markDispatched.bind(f.storage), list: f.storage.list.bind(f.storage), fingerprintKey: f.storage.fingerprintKey.bind(f.storage), async finish(...args) { const saved = await originalFinish(...args); if (loseAck) { loseAck = false; throw new Error('DB COMMIT acknowledged too late'); } return saved; } };
  const flaky = f.makeUsage({ storage: flakyStorage }), acknowledged = await f.command();
  await assert.rejects(flaky.execute(acknowledged, async ({ beforeDispatch }) => { await beforeDispatch(); calls++; return { status: 'success' }; }), failure('platform_usage_outcome_unknown'));
  await f.reopen(); const acknowledgedReplay = await f.usage.execute(acknowledged, () => { calls++; throw new Error('Must not call again'); });
  assert.equal(acknowledgedReplay.record.billableConfirmed, true); assert.equal(acknowledgedReplay.replayed, true); assert.equal(calls, 2);
  const summary = await f.summary(); assert.equal(summary.totals.providerCalls, 2); assert.equal(summary.totals.billableCount, 1); assert.equal(summary.totals.salesMinor, 200);
}));

test('abandoned dispatched reservations become visibly unknown without a paid retry; late same-claim outcomes settle once', () => fixture(async f => {
  await f.usage.execute(await f.command(), succeed);
  const sample = (await f.storage.list({ month: '2026-10' }))[0], input = await f.command();
  const record = { ...sample, ...input, id: randomUUID(), claimId: randomUUID(), status: 'reserved', billableConfirmed: false, history: [{ status: 'reserved', at: '2026-10-20T12:00:00Z' }] }; delete record.dispatchedAt; delete record.completedAt;
  await f.storage.reserve(record); await f.storage.markDispatched(input, { claimId: record.claimId, at: '2026-10-20T12:00:00Z', month: '2026-10', leaseUntil: '2026-10-20T12:01:00Z' });
  f.clock('2026-10-20T12:01:01Z'); await f.reopen();
  const replay = await f.usage.execute(input, () => { throw new Error('Recovery must not repeat paid lookups'); }); assert.equal(replay.record.status, 'unknown'); assert.equal((await f.summary()).totals.unknown, 1);
  await f.storage.finish(input, { claimId: record.claimId, status: 'success', billableConfirmed: true, at: '2026-10-20T12:01:02Z' });
  await f.storage.finish(input, { claimId: record.claimId, status: 'success', billableConfirmed: true, at: '2026-10-20T12:01:03Z' });
  const summary = await f.summary(); assert.equal(summary.totals.providerCalls, 2); assert.equal(summary.totals.billableCount, 2); assert.equal(summary.totals.salesMinor, 400);
  const settled = (await f.storage.list({ month: '2026-10' })).find(item => item.id === record.id); assert.equal(settled.history.filter(item => item.status === 'success').length, 1);
}));

test('frozen integer tariffs survive restart and future services append without changing historic invoice lines', () => fixture(async f => {
  const old = await f.command(); await f.usage.execute(old, succeed);
  const tariffs = { ...PLATFORM_USAGE_TARIFFS, [service]: { unitCostMinor: 250, unitSalesMinor: 350, currency: 'SEK', version: 2 }, 'sms.delivery': { unitCostMinor: 10, unitSalesMinor: 30, currency: 'SEK', version: 1 } };
  await f.reopen({ tariffs }); const replay = await f.usage.execute(old, () => { throw new Error('Price change cannot redispatch'); }); assert.equal(replay.record.unitSalesMinor, 200);
  await f.usage.execute(await f.command(), succeed); await f.usage.execute(await f.command({ service: 'sms.delivery', channel: 'customer_approval' }), succeed);
  const summary = await f.summary(), rows = summary.companies[0].services;
  assert.equal(rows.length, 3); assert.deepEqual(rows.filter(row => row.service === service).map(row => row.unitSalesMinor), [200, 350]);
  assert.equal(summary.totals.salesMinor, 580); assert.equal(summary.totals.costMinor, 460);
  const first = await f.usage.exportCsv({ month: '2026-10' }); const second = await f.usage.exportCsv({ month: '2026-10' }); assert.equal(first.csv, second.csv); assert.match(first.csv, /"2,00"/); assert.match(first.csv, /"3,50"/); assert.equal(first.filename, 'anvandning-2026-10-alla-bolag.csv');
  assert.equal(first.csv.includes(privateName), false); assert.equal(first.csv.includes(privatePnr), false); assert.match(first.csv, /"'=Unsafe company label"/, 'Current registry names are spreadsheet-safe');
}));

test('billing month follows actual dispatch in Stockholm across midnight and DST, not reservation UTC time', () => fixture(async f => {
  assert.equal(platformUsageMonth('2026-09-30T21:59:59Z'), '2026-09'); assert.equal(platformUsageMonth('2026-09-30T22:00:00Z'), '2026-10');
  assert.equal(platformUsageMonth('2026-10-31T22:59:59Z'), '2026-10'); assert.equal(platformUsageMonth('2026-10-31T23:00:00Z'), '2026-11');
  f.clock('2026-09-30T21:59:59Z'); await f.usage.execute(await f.command(), async ({ beforeDispatch }) => { f.clock('2026-09-30T22:00:01Z'); await beforeDispatch(); return { status: 'success' }; });
  assert.equal((await f.storage.list({ month: '2026-09' })).length, 0); assert.equal((await f.storage.list({ month: '2026-10' })).length, 1); assert.equal((await f.summary()).totals.salesMinor, 200);
}));

test('unknown services, caller tariffs, raw payload fields and duplicate dispatches cannot create extra billable events', () => fixture(async f => {
  const command = await f.command();
  for (const input of [{ ...command, personalNumber: privatePnr }, { ...command, unitSalesMinor: 1 }, { ...command, operationId: 'not-a-uuid' }, { ...command, fingerprint: privatePnr }, { ...command, organisationId: 'company\r\nheader' }]) await assert.rejects(f.usage.execute(input, succeed), failure('platform_usage_invalid'));
  for (const service of ['unknown.lookup', 'constructor']) await assert.rejects(f.usage.execute({ ...command, service }, succeed), failure('platform_usage_service_unknown'));
  assert.equal((await f.storage.list({ month: '2026-10' })).length, 0);
  let calls = 0;
  await assert.rejects(f.usage.execute(command, async ({ beforeDispatch }) => { await beforeDispatch(); calls++; await beforeDispatch(); calls++; return { status: 'success' }; }), failure('platform_usage_already_dispatched'));
  assert.equal(calls, 1); assert.equal((await f.summary()).totals.reviewCount, 1); assert.equal((await f.summary()).totals.salesMinor, 0);
}));

test('a lost dispatch-claim COMMIT acknowledgement reconciles the same owner before exactly one provider GET', () => fixture(async f => {
  let writes = 0, providerGets = 0;
  const proxy = { reserve: f.storage.reserve.bind(f.storage), list: f.storage.list.bind(f.storage), fingerprintKey: f.storage.fingerprintKey.bind(f.storage), finish: f.storage.finish.bind(f.storage), async markDispatched(...args) {
    const result = await f.storage.markDispatched(...args); if (++writes === 1) throw new Error('Lost dispatch COMMIT acknowledgement'); return result;
  } };
  const usage = f.makeUsage({ storage: proxy }), command = await f.command();
  const result = await usage.execute(command, async ({ beforeDispatch }) => { await beforeDispatch(); providerGets++; return { status: 'success' }; });
  assert.equal(result.record.billableConfirmed, true); assert.equal(writes, 2); assert.equal(providerGets, 1);
  const replay = await usage.execute(command, () => { providerGets++; throw new Error('Paid operation cannot repeat'); }); assert.equal(replay.replayed, true); assert.equal(providerGets, 1);
  const summary = await f.summary(); assert.equal(summary.totals.providerCalls, 1); assert.equal(summary.totals.billableCount, 1); assert.equal(summary.totals.salesMinor, 200);
}));

test('unrecoverable dispatch-claim ambiguity stays review-only and never starts the provider GET', () => fixture(async f => {
  let providerGets = 0;
  const proxy = { reserve: f.storage.reserve.bind(f.storage), list: f.storage.list.bind(f.storage), fingerprintKey: f.storage.fingerprintKey.bind(f.storage), finish: f.storage.finish.bind(f.storage), async markDispatched(...args) { await f.storage.markDispatched(...args); throw new Error('Database response unavailable'); } };
  const usage = f.makeUsage({ storage: proxy }), command = await f.command();
  await assert.rejects(usage.execute(command, async ({ beforeDispatch }) => { await beforeDispatch(); providerGets++; return { status: 'success' }; }), /Database response unavailable/);
  assert.equal(providerGets, 0); const summary = await f.summary(); assert.equal(summary.totals.unknown, 1); assert.equal(summary.totals.salesMinor, 0); assert.equal(summary.totals.reviewSalesMinor, 200);
  assert.equal((await usage.execute(command, succeed)).replayed, true);
  const csv = await usage.exportCsv({ month: '2026-10' }); assert.match(csv.csv, /Leverantörsförsök inkl. osäkra/); assert.match(csv.csv, /Beräknad leverantörskostnad/);
}));

const bootstrapPassword = 'Private-Usage-Bootstrap-2026!', adminPassword = 'Changed-Usage-Administrator-2026!';
const passwordHash = platformPasswordHash(bootstrapPassword);
async function httpFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-usage-http-')), env = { JEROC_PLATFORM_DB_PATH: join(directory, 'platform.sqlite') };
  const repository = await createPlatformStorage({ env }), storage = await createPlatformUsageStorage({ env }), companyId = randomUUID();
  const auth = createPlatformAuth({ repository, bootstrapPlatform: async () => ({ id: 'platform-admin', name: 'Systemadmin', username: 'admin', active: true, password: await passwordHash }),
    resolveCompanyUser: async (_companyId, id) => ['__platform-admin', 'vd'].includes(id) ? { id, name: id, level: id === 'vd' ? 'VD' : 'Systemadmin', active: true, permissions: [] } : undefined });
  await auth.initialize(); await repository.transact(async state => {
    state.companies.push({ id: companyId, name: 'Tenant company', status: 'active', ownerUserId: 'vd' });
    state.users.push({ id: 'vd', businessId: 'vd', name: 'VD', username: 'vd', password: await passwordHash, active: true, platformAdmin: false, mustChangePassword: false });
    state.memberships.push({ userId: 'vd', organisationId: companyId, businessUserId: 'vd', active: true });
  });
  const usage = createPlatformUsage({ storage, auth }), api = createPlatformApi({ auth, usage, env }), failures = [];
  const server = createServer((req, res) => void api(req, res, new URL(req.url, 'http://localhost')).catch(error => { failures.push(error); res.writeHead(500); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = 'usage?month=2026-10', account, body, headers = {}, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${base}/api/platform/${path}`, { method, headers: { origin: base, 'content-type': 'application/json', ...(account ? { cookie: account.cookie, 'x-platform-generation': account.body.generation, 'x-platform-csrf': account.body.csrfToken } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text(), cookie = response.headers.getSetCookie().filter(value => value.startsWith('jeroc_platform=') || value.startsWith('jeroc_tenant=')).map(value => value.split(';')[0]).join('; ');
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : undefined, text, cookie: cookie || account?.cookie, headers: response.headers };
  }
  async function admin() { const initial = await request('login', undefined, { username: 'admin', password: bootstrapPassword }); return request('change-password', initial, { newPassword: adminPassword }); }
  try { await run({ request, admin, usage, storage, repository, companyId }); assert.deepEqual(failures, []); }
  finally { usage.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await storage.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('usage JSON and CSV require the actual platform admin in own context; tenant VD, support, forged headers and stale scopes are denied', () => httpFixture(async f => {
  assert.equal((await f.request()).status, 401); assert.equal((await f.request(undefined, undefined, undefined, { 'x-demo-actor': 'platform-admin', 'x-platform-admin': 'true' })).status, 401);
  const admin = await f.admin(); assert.equal(admin.status, 200);
  const view = await f.request(undefined, admin); assert.equal(view.status, 200); assert.equal(view.body.totals.providerCalls, 0); assert.deepEqual(view.body.companies, []); assert.match(view.headers.get('cache-control'), /no-store/);
  const vd = await f.request('login', undefined, { username: 'vd', password: bootstrapPassword }); assert.equal(vd.status, 200);
  for (const path of ['usage?month=2026-10', 'usage/export?month=2026-10']) { const denied = await f.request(path, vd); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'platform_usage_forbidden'); }
  const support = await f.request('switch', admin, { organisationId: f.companyId }); assert.equal(support.status, 200); assert.equal((await f.request(undefined, support)).status, 403);
  assert.equal((await f.request(undefined, admin)).status, 401, 'Switching companies rotated the cookie and invalidated the old session token');
  const own = await f.request('open-administration', support, {}); assert.equal(own.status, 200); assert.equal((await f.request(undefined, own)).status, 200);
  assert.equal((await f.request(undefined, own, undefined, { origin: 'https://foreign.invalid' })).status, 403);
  for (const path of ['usage?month=invalid', 'usage?month=2026-10&month=2026-11', 'usage?month=2026-10&organisationId=foreign', 'usage?month=2026-10&companyId=x%0d%0ainjection']) assert.equal((await f.request(path, own)).status, 422);
  assert.equal((await f.request('usage?month=2026-10', own, {})).status, 404, 'No billing/invoice mutation exists');
}));

test('admin company/month filters and deterministic UTF-8 CSV expose only aggregated immutable invoice amounts', () => httpFixture(async f => {
  const admin = await f.admin();
  for (const organisationId of [f.companyId, 'other-company']) {
    const fingerprint = await f.usage.fingerprint({ organisationId, service, value: privatePnr });
    await f.usage.execute({ organisationId, operationId: randomUUID(), service, channel, fingerprint }, succeed);
  }
  const view = await f.request('usage?month=2026-10', admin); assert.equal(view.body.totals.providerCalls, 2); assert.equal(view.body.totals.salesMinor, 400);
  const filtered = await f.request(`usage?month=2026-10&companyId=${f.companyId}`, admin); assert.equal(filtered.body.companies.length, 1); assert.equal(filtered.body.companies[0].companyId, f.companyId); assert.equal(filtered.body.totals.salesMinor, 200);
  const path = `usage/export?month=2026-10&companyId=${f.companyId}`, csv = await f.request(path, admin); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /^text\/csv/); assert.match(csv.headers.get('content-disposition'), /2026-10/); assert.match(csv.text, /"2,00"/); assert.equal(csv.text.includes('other-company'), false); assert.equal(csv.text.includes(privatePnr), false); assert.equal(csv.text.includes(privateName), false);
  await f.repository.transact(state => { state.companies.find(company => company.id === f.companyId).name = '  =HYPERLINK("https://foreign.invalid")'; });
  const renamed = await f.request(path, admin); assert.match(renamed.text, /"'  =HYPERLINK\(""https:\/\/foreign.invalid""\)"/, 'Leading spaces cannot hide a spreadsheet formula'); assert.match(renamed.text, /"2,00"/); assert.equal((await f.request(path, admin)).text, renamed.text, 'The same ledger and registry snapshot export reproducibly with formula-safe names');
  const head = await f.request(path, admin, undefined, {}, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.text, '');
}));
