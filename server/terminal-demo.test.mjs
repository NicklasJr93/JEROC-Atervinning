import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPricingStore } from './pricing.mjs';
import { createTerminalDemoRepository, TerminalDemoError } from './terminal-demo-storage.mjs';
import { createTerminalDemoStore, createTerminalDemoApi } from './terminal-demo.mjs';

const fail = (operation, status, code) => assert.rejects(async () => operation(), (error) => error.status === status && (!code || error.code === code));
const customer = { id: 'customer-build', name: 'Bygg & Riv AB', type: 'Företag', number: '551923-4567',
  customerNumber: 'K-1001', phone: '0701234567', email: 'kund@example.invalid', address: 'Storgatan 12',
  paymentProfile: { method: 'bank', bank: 'Demobank', clearing: '8327', account: '1234567890', holder: 'Bygg & Riv AB' } };

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-terminal-test-'));
  const filename = join(directory, 'terminals.sqlite');
  let repositoryOptions = { filename, env: {} };
  let postgresAdmin, schema;
  // Opt-in only. Each test gets its own newly created schema, leaving all
  // existing database tables untouched. CI can exercise the same tests on PG.
  if (process.env.JEROC_TEST_POSTGRES_URL) {
    const { Pool } = await import('pg');
    postgresAdmin = new Pool({ connectionString: process.env.JEROC_TEST_POSTGRES_URL });
    schema = `jeroc_terminal_test_${directory.split('-').at(-1).toLowerCase()}`;
    await postgresAdmin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_POSTGRES_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    repositoryOptions = { env: { DATABASE_URL: url.toString() } };
  }
  let repository = await createTerminalDemoRepository(repositoryOptions);
  const pricing = createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
  let time = new Date('2026-10-09T10:00:00Z');
  const store = () => createTerminalDemoStore({ repository, principalStore: pricing, now: () => time });
  let service = store();
  const staff = async (user = 'admin', actor = user) => (await service.staffSession({ actualUserId: actor, effectiveUserId: user })).token;
  const admin = await staff(), kajsa = await staff('kajsa'), anna = await staff('anna');
  const create = (name = 'Terminal 1', siteId = 'norrtalje', username = name.toLowerCase().replaceAll(' ', '')) => service.createTerminal({ name, username, password: 'demolosen123', siteId }, admin);
  const payload = (cardId = 9000, terminalId, extra = {}) => {
    const locked = pricing.snapshot({ cardId, customerId: customer.id, deliveredAt: '2026-10-09T09:00:00Z',
      rows: [{ articleId: 'copper-1', weight: 10 }] }, pricing.principal('kajsa'));
    return { card: { id: cardId, customerId: customer.id, status: 'complement', yard: 'Norrtälje', date: '2026-10-09T09:00:00Z',
      reference: 'Projekt A', origin: 'Ängsvägen 19', pricingSnapshotId: locked.id, idVerified: false,
      weigher: 'Niklas', payment: 'Bankkonto', rows: locked.rows.map((row) => ({ articleId: row.articleId, weight: row.weight, price: row.price, tier: row.tier === 'Special' ? 'Eget' : row.tier })), audit: [] },
    customer, terminalId, siteId: 'norrtalje', rows: locked.rows.map((row) => ({ articleId: row.articleId, name: 'Koppar klass 1', weight: row.weight, price: row.price, amount: Math.round(row.weight * row.price * 100) / 100 })),
    offset: 0, correctionIds: [], idempotencyKey: `send-${cardId}`, ...extra };
  };
  try {
    await run({ get service() { return service; }, pricing, admin, kajsa, anna, staff, create, payload, filename, repositoryOptions,
      advance: (milliseconds) => { time = new Date(time.getTime() + milliseconds); },
      restart: async () => { await repository.close(); repository = await createTerminalDemoRepository(repositoryOptions); service = store(); },
    });
  } finally {
    await repository.close();
    if (postgresAdmin) { await postgresAdmin.query(`DROP SCHEMA "${schema}" CASCADE`); await postgresAdmin.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('Render requires PostgreSQL, while the local repository persists across reopening', async () => {
  await fail(() => createTerminalDemoRepository({ env: { RENDER: 'true' } }), 503, 'setup_required');
  await fixture(async (f) => {
    const terminal = await f.create();
    const loggedIn = await f.service.login({ username: terminal.username, password: 'demolosen123' });
    await f.service.defaultTerminal({ siteId: 'norrtalje', terminalId: terminal.id }, f.kajsa);
    const approval = await f.service.send(f.payload(9000, terminal.id), f.kajsa);
    await f.restart();
    const recovered = await f.service.session(loggedIn.token);
    assert.equal(recovered.approval.id, approval.id);
    const state = await f.service.read(f.kajsa);
    assert.equal(state.defaults[0].terminalId, terminal.id);
    assert.equal(state.approvals[0].snapshot.hash, approval.snapshot.hash);
    assert.equal(state.configured, true);
  });
});

test('terminal passwords are hashed, accounts are separate from staff, and only one device can log in', async () => fixture(async (f) => {
  await fail(() => f.service.createTerminal({ name: 'Bad', username: 'bad', password: 'demolosen123', siteId: 'norrtalje' }, f.kajsa), 403);
  const terminal = await f.create();
  assert.equal(JSON.stringify(terminal).includes('digest'), false);
  const session = await f.service.login({ username: terminal.username.toUpperCase(), password: 'demolosen123' });
  await fail(() => f.service.login({ username: terminal.username, password: 'demolosen123' }), 409, 'terminal_session_in_use');
  await fail(() => f.service.read(session.token), 401);
  await fail(() => f.service.session(f.admin), 401);
  const persisted = f.repositoryOptions.env.DATABASE_URL
    ? Buffer.from(JSON.stringify(await f.service.repository.transact((state) => state))) : await readFile(f.filename);
  assert.equal(persisted.includes(Buffer.from('demolosen123')), false);
  await f.service.releaseTerminal(terminal.id, f.admin);
  await fail(() => f.service.session(session.token), 401);
  const next = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  assert.equal(next.result.terminal.id, terminal.id);
  await f.service.updateTerminal(terminal.id, { password: 'newpassword123' }, f.admin);
  await fail(() => f.service.session(next.token), 401);
  await fail(() => f.service.login({ username: terminal.username, password: 'demolosen123' }), 401);
  assert.equal((await f.service.login({ username: terminal.username, password: 'newpassword123' })).result.terminal.id, terminal.id);
}));

test('two simultaneous senders cannot reserve a terminal twice, and retries are idempotent', async () => fixture(async (f) => {
  const terminal = await f.create();
  await fail(() => f.service.send(f.payload(9000, terminal.id), f.kajsa), 409, 'terminal_offline');
  await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const firstPayload = f.payload(9000, terminal.id), secondPayload = f.payload(9001, terminal.id);
  const results = await Promise.allSettled([f.service.send(firstPayload, f.kajsa), f.service.send(secondPayload, f.kajsa)]);
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal(results.find((value) => value.status === 'rejected').reason.code, 'terminal_busy');
  const winner = results.find((value) => value.status === 'fulfilled').value;
  const winningPayload = winner.cardId === 9000 ? firstPayload : secondPayload;
  assert.equal((await f.service.send(winningPayload, f.kajsa)).id, winner.id);
  await fail(() => f.service.send({ ...winningPayload, offset: 1 }, f.kajsa), 409, 'idempotency_conflict');
  assert.equal((await f.service.read(f.kajsa)).approvals.length, 1);
}));

test('separate repository instances share the same durable reservation lock', async () => fixture(async (f) => {
  const terminal = await f.create();
  await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const otherRepository = await createTerminalDemoRepository(f.repositoryOptions);
  const other = createTerminalDemoStore({ repository: otherRepository, principalStore: f.pricing, now: () => new Date('2026-10-09T10:00:00Z') });
  try {
    const results = await Promise.allSettled([f.service.send(f.payload(9000, terminal.id), f.kajsa), other.send(f.payload(9001, terminal.id), f.kajsa)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'terminal_busy');
    assert.equal((await other.read(f.kajsa)).approvals.length, 1);
  } finally { await otherRepository.close(); }
}));

test('each device sees only its own redacted review and cannot act on another terminal', async () => fixture(async (f) => {
  const one = await f.create('Terminal 1'), two = await f.create('Terminal 2');
  const oneSession = await f.service.login({ username: one.username, password: 'demolosen123' });
  const twoSession = await f.service.login({ username: two.username, password: 'demolosen123' });
  const first = await f.service.send(f.payload(9000, one.id), f.kajsa);
  const second = await f.service.send(f.payload(9001, two.id), f.kajsa);
  const publicState = await f.service.session(oneSession.token);
  assert.equal(publicState.approval.id, first.id);
  assert.equal((await f.service.session(twoSession.token)).approval.id, second.id);
  const data = JSON.stringify(publicState);
  for (const sensitive of ['1234567890', '551923-4567', 'kund@example.invalid', 'customerSnapshot', 'pricingSnapshotId']) assert.equal(data.includes(sensitive), false, sensitive);
  await fail(() => f.service.respond(second.id, { action: 'change_requested', comment: 'Wrong', termsAccepted: false }, oneSession.token), 409, 'stale_approval');
  await f.service.cancel(first.id, f.kajsa);
  assert.equal((await f.service.session(oneSession.token)).approval, null);
  assert.equal((await f.service.session(twoSession.token)).approval.id, second.id);
}));

test('a customer click never verifies identity or bypasses internal attest; price snapshot stays immutable', async () => fixture(async (f) => {
  const terminal = await f.create(), login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const approval = await f.service.send(f.payload(9000, terminal.id), f.kajsa);
  await fail(() => f.service.attest(approval.id, f.anna), 409, 'customer_approval_required');
  await fail(() => f.service.confirmId(approval.id, f.kajsa), 409, 'id_not_requested');
  await fail(() => f.service.respond(approval.id, { action: 'id_requested', termsAccepted: false }, login.token), 400);
  await f.service.respond(approval.id, { action: 'id_requested', termsAccepted: true }, login.token);
  assert.equal((await f.service.read(f.kajsa)).approvals[0].snapshot.card.idVerified, false);
  await fail(() => f.service.confirmId(approval.id, f.anna), 403);
  const approved = await f.service.confirmId(approval.id, f.kajsa);
  assert.equal(approved.status, 'approved'); assert.equal(approved.snapshot.card.status, 'attest');
  assert.equal(approved.snapshot.card.idVerified, true);
  assert.equal((await f.service.session(login.token)).approval, null);
  const attested = await f.service.attest(approval.id, f.anna);
  assert.equal(attested.status, 'attested'); assert.equal(attested.snapshot.card.status, 'ready');
  assert.equal(attested.snapshot.hash, approval.snapshot.hash);
  assert.equal(attested.snapshot.card.approvedBy, 'anna');
  await fail(() => f.service.cancel(approval.id, f.kajsa), 409, 'card_locked');
  const record = await f.service.repository.transact((state) => state.approvals[0]);
  assert.equal(record.snapshot.card.idVerified, false, 'The original signed review is immutable');
  assert.equal(record.snapshot.card.status, 'complement');
  assert.equal(record.snapshot.hash, approval.snapshot.hash);
}));

test('requested changes return the card to completion and old sessions cannot approve a new version', async () => fixture(async (f) => {
  const terminal = await f.create(), login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const originalPayload = f.payload(9000, terminal.id);
  const original = await f.service.send(originalPayload, f.kajsa);
  await fail(() => f.service.respond(original.id, { action: 'change_requested', termsAccepted: false }, login.token), 400);
  await f.service.respond(original.id, { action: 'change_requested', comment: 'Vikten ska vara mindre', termsAccepted: false }, login.token);
  assert.equal((await f.service.read(f.kajsa)).approvals[0].status, 'change_requested');
  await fail(() => f.service.attest(original.id, f.anna), 409);
  const replacement = await f.service.send({ ...originalPayload, idempotencyKey: 'replacement', card: { ...originalPayload.card, reference: 'Rättad referens' } }, f.kajsa);
  assert.equal(replacement.version, 2); assert.notEqual(replacement.snapshot.hash, original.snapshot.hash);
  assert.equal((await f.service.session(login.token)).approval.id, replacement.id);
  await fail(() => f.service.respond(original.id, { action: 'id_requested', termsAccepted: true }, login.token), 409);
  assert.equal((await f.service.read(f.kajsa)).approvals[0].status, 'cancelled');
}));

test('origin, payment, site and canonical pricing are checked server-side before any reservation', async () => fixture(async (f) => {
  const terminal = await f.create(), login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const value = f.payload(9000, terminal.id);
  await fail(() => f.service.send({ ...value, card: { ...value.card, origin: ' ' } }, f.kajsa), 400);
  await fail(() => f.service.send({ ...value, customer: { ...customer, paymentProfile: undefined } }, f.kajsa), 422);
  await fail(() => f.service.send({ ...value, siteId: 'rimbo' }, f.kajsa), 409, 'site_mismatch');
  await fail(() => f.service.send({ ...value, card: { ...value.card, rows: [{ ...value.card.rows[0], price: 0 }] } }, f.kajsa), 409, 'pricing_mismatch');
  await fail(() => f.service.send({ ...value, card: { ...value.card, pricingSnapshotId: 'invented' } }, f.kajsa), 409, 'pricing_snapshot_missing');
  assert.equal((await f.service.session(login.token)).approval, null);
  assert.equal((await f.service.read(f.kajsa)).approvals.length, 0);
}));

test('attest limits, own-attest and changed effective rights are enforced against canonical users', async () => fixture(async (f) => {
  const terminal = await f.create(), login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const approval = await f.service.send(f.payload(9000, terminal.id), f.kajsa);
  await f.service.respond(approval.id, { action: 'id_requested', termsAccepted: true }, login.token);
  await f.service.confirmId(approval.id, f.kajsa);
  let users = f.pricing.read(f.pricing.principal('admin')).users;
  users = users.map((user) => user.id === 'kajsa' ? { ...user, permissions: [...user.permissions, 'attest'], maxAttest: 100000 } : user.id === 'anna' ? { ...user, maxAttest: 1 } : user);
  f.pricing.saveUsers({ users }, f.pricing.principal('admin'));
  await fail(() => f.service.attest(approval.id, f.kajsa), 403, 'own_attest_forbidden');
  await fail(() => f.service.attest(approval.id, f.anna), 403, 'attest_limit');
  users = users.map((user) => user.id === 'kajsa' ? { ...user, permissions: user.permissions.filter((right) => right !== 'customerApprovalRead') } : user);
  f.pricing.saveUsers({ users }, f.pricing.principal('admin'));
  await fail(() => f.service.read(f.kajsa), 403);
  const actingAnna = await f.staff('anna', 'admin');
  await fail(() => f.service.createTerminal({ name: 'Too much', username: 'extra', password: 'demolosen123', siteId: 'norrtalje' }, actingAnna), 403);
}));

test('approval read alone never reveals financial snapshots or grants price access', async () => fixture(async (f) => {
  const terminal = await f.create();
  const login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const payload = f.payload(9000, terminal.id);
  const approval = await f.service.send(payload, f.kajsa);
  await f.service.respond(approval.id, { action: 'id_requested', termsAccepted: true }, login.token);
  const admin = f.pricing.principal('admin');
  const users = f.pricing.read(admin).users;
  users.push({ id: 'limited', name: 'Begränsad invägare', level: 'Medarbetare',
    permissions: ['view', 'customerApprovalRead', 'prepare', 'verifyId', 'prices', 'priceC'], maxAttest: 0, ownAttest: false });
  f.pricing.saveUsers({ users }, admin);
  const limited = await f.staff('limited');
  const state = await f.service.read(limited);
  assert.equal(state.terminals.length, 1); assert.deepEqual(state.approvals, []);
  await fail(() => f.service.send({ ...payload, idempotencyKey: 'limited-resend' }, limited), 403, 'financial_visibility_required');
  await fail(() => f.service.confirmId(approval.id, limited), 403, 'financial_visibility_required');
  await fail(() => f.service.cancel(approval.id, limited), 403, 'financial_visibility_required');
}));

test('price visibility never exposes bank credentials in reads or mutation responses', async () => fixture(async (f) => {
  const admin = f.pricing.principal('admin');
  const users = f.pricing.read(admin).users;
  const financialRead = ['view', 'customerApprovalRead', 'prices', 'priceA', 'priceB', 'priceC', 'customerPrices'];
  users.push({ id: 'price-reader', name: 'Prisläsare', level: 'Medarbetare', permissions: financialRead, maxAttest: 0, ownAttest: false });
  users.push({ id: 'reviewer', name: 'Granskare', level: 'Medarbetare', permissions: [...financialRead, 'prepare', 'verifyId'], maxAttest: 0, ownAttest: false });
  f.pricing.saveUsers({ users }, admin);
  const reader = await f.staff('price-reader'), reviewer = await f.staff('reviewer');
  const terminal = await f.create();
  const login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const first = f.payload(9000, terminal.id);
  first.card.payment = 'Bankkonto 8327 / 1234567890';
  const expectRedacted = (approval) => {
    assert.deepEqual(approval.snapshot.card.paymentDetails, { method: 'bank' });
    assert.deepEqual(approval.snapshot.card.customerSnapshot.paymentProfile, { method: 'bank' });
    assert.deepEqual(approval.snapshot.customer.paymentProfile, { method: 'bank' });
    assert.equal(approval.snapshot.card.payment, 'Bankkonto');
    assert.equal(JSON.stringify(approval).includes('1234567890'), false);
  };
  const sent = await f.service.send(first, reviewer);
  expectRedacted(sent);
  expectRedacted((await f.service.read(reader)).approvals[0]);
  expectRedacted(await f.service.send(first, reviewer));
  expectRedacted(await f.service.cancel(sent.id, reviewer));
  const second = await f.service.send({ ...first, idempotencyKey: 'second-review' }, reviewer);
  await f.service.respond(second.id, { action: 'id_requested', termsAccepted: true }, login.token);
  expectRedacted(await f.service.confirmId(second.id, reviewer));
  expectRedacted(await f.service.confirmId(second.id, reviewer));
  const authorized = (await f.service.read(f.anna)).approvals.at(-1);
  assert.equal(authorized.snapshot.card.paymentDetails.account, '1234567890');
  assert.equal(authorized.snapshot.customer.paymentProfile.account, '1234567890');
  assert.equal(authorized.snapshot.card.customerSnapshot.paymentProfile.account, '1234567890');
  const attested = await f.service.attest(second.id, f.anna);
  assert.equal(attested.snapshot.card.paymentDetails.account, '1234567890');
  const stored = await f.service.repository.transact((state) => state.approvals.at(-1));
  assert.equal(stored.snapshot.card.paymentDetails.account, '1234567890');
  assert.equal(stored.snapshot.hash, second.snapshot.hash);
  assert.equal(authorized.snapshot.hash, second.snapshot.hash);
}));

test('disconnect expiry clears sensitive terminal content and a new login cannot revive old approvals', async () => fixture(async (f) => {
  const terminal = await f.create(), login = await f.service.login({ username: terminal.username, password: 'demolosen123' });
  const approval = await f.service.send(f.payload(9000, terminal.id), f.kajsa);
  f.advance(91000);
  const state = await f.service.read(f.kajsa);
  assert.equal(state.approvals[0].status, 'expired'); assert.equal(state.terminals[0].online, false);
  assert.equal((await f.service.session(login.token)).approval, null);
  await fail(() => f.service.respond(approval.id, { action: 'id_requested', termsAccepted: true }, login.token), 409);
}));

test('failed passwords are durably rate-limited and deactivate revokes active sessions', async () => fixture(async (f) => {
  const terminal = await f.create();
  for (let attempt = 0; attempt < 5; attempt += 1) await fail(() => f.service.login({ username: terminal.username, password: 'bad' }, undefined, 'device'), 401);
  await f.restart();
  await fail(() => f.service.login({ username: terminal.username, password: 'demolosen123' }, undefined, 'device'), 429, 'rate_limited');
  f.advance(10 * 60 * 1000 + 1);
  const login = await f.service.login({ username: terminal.username, password: 'demolosen123' }, undefined, 'device');
  await f.service.updateTerminal(terminal.id, { active: false }, f.admin);
  await fail(() => f.service.session(login.token), 401);
  await fail(() => f.service.login({ username: terminal.username, password: 'demolosen123' }), 401);
}));

test('the HTTP API isolates cookies, rejects cross-origin writes and never accepts x-demo headers as auth', async () => fixture(async (f) => {
  const api = createTerminalDemoApi({ principalStore: f.pricing, repository: f.service.repository, env: {} });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', payload, cookie, extra = {}) => fetch(base + '/api/terminal-demo' + path, {
    method, headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  try {
    assert.equal((await request('/state', 'GET', undefined, undefined, { 'X-Demo-User': 'admin', 'X-Demo-Actor': 'admin' })).status, 401);
    const staffSession = await request('/staff-session', 'POST', { actualUserId: 'admin', effectiveUserId: 'admin' });
    const staffCookie = staffSession.headers.get('set-cookie');
    assert.match(staffCookie, /HttpOnly/); assert.match(staffCookie, /SameSite=Strict/);
    assert.equal((await request('/terminals', 'POST', { name: 'Terminal API', username: 'terminalapi', password: 'demolosen123', siteId: 'norrtalje' }, staffCookie, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/state', 'GET', undefined, staffCookie)).status, 200);
    const created = await request('/terminals', 'POST', { name: 'Terminal API', username: 'terminalapi', password: 'demolosen123', siteId: 'norrtalje' }, staffCookie);
    assert.equal(created.status, 201);
    const login = await request('/login', 'POST', { username: 'terminalapi', password: 'demolosen123' });
    const terminalCookie = login.headers.get('set-cookie');
    assert.equal((await request('/state', 'GET', undefined, terminalCookie)).status, 401);
    assert.equal((await request('/session', 'GET', undefined, staffCookie)).status, 401);
    assert.equal((await request('/session', 'GET', undefined, terminalCookie)).status, 200);
    const both = `${staffCookie.split(';')[0]}; ${terminalCookie.split(';')[0]}`;
    assert.equal((await request('/state', 'GET', undefined, both)).status, 200);
    assert.equal((await request('/session', 'GET', undefined, both)).status, 200);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
}));

test('an unconfigured cloud module returns setup_required without crashing the normal server', async () => {
  const api = createTerminalDemoApi({ env: { RENDER: 'true' } });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(200); res.end('normal app'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unavailable = await fetch(base + '/api/terminal-demo/state');
    assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).code, 'setup_required');
    assert.equal(await (await fetch(base + '/healthz')).text(), 'normal app');
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); await api.close(); }
});

test('a failed database initialization can recover on retry without restarting the app', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-terminal-retry-'));
  const blocked = join(directory, 'blocked');
  const { writeFile, mkdir } = await import('node:fs/promises');
  await writeFile(blocked, 'startup failure');
  const api = createTerminalDemoApi({ env: { JEROC_TERMINAL_DB_PATH: join(blocked, 'terminals.sqlite') } });
  const server = createServer(async (req, res) => { await api(req, res, new URL(req.url, 'http://localhost')); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/terminal-demo`;
  try {
    assert.equal((await fetch(base + '/state')).status, 503);
    await rm(blocked); await mkdir(blocked);
    const session = await fetch(base + '/staff-session', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actualUserId: 'admin', effectiveUserId: 'admin' }) });
    assert.equal(session.status, 200);
    assert.equal((await fetch(base + '/state', { headers: { Cookie: session.headers.get('set-cookie') } })).status, 200);
  } finally {
    server.closeAllConnections(); server.close(); await once(server, 'close'); await api.close();
    await rm(directory, { recursive: true, force: true });
  }
});
