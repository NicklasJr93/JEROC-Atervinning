import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository, ENVIRONMENT_DEMO_GENERATION } from './environment-storage.mjs';
import { createEnvironmentStore, ENVIRONMENT_DEMO_PASSWORD, addSwedishWorkingDays, environmentHash } from './environment-model.mjs';
import { createEnvironmentApi } from './environment-api.mjs';

const reject = (operation, status, code) => assert.rejects(async () => operation(), (error) => error.status === status && (!code || error.code === code));
const testPostgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
const input = (extra = {}) => ({ sourceId: randomUUID(), cardId: 2050, siteId: 'norrtalje', receivedAt: '2026-10-09T10:00:00+02:00',
  rows: [{ articleId: 'lead-battery', weight: 250 }, { articleId: 'copper-1', weight: 12 }],
  previousHolder: { name: 'Verkstad Test AB', number: '556000-0167', contactName: 'Testpersonen', email: 'kund@example.invalid', phone: '0100000000' },
  lastPlace: place, nextPlace: { ...place, address: 'Ängsvägen 19' }, transportMode: 'road',
  incomingDocument: { missingReason: 'Kunden saknade dokument vid faktisk mottagning.' }, idempotencyKey: randomUUID(), ...extra });

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-env-test-')), filename = join(directory, 'environment.sqlite');
  let options = { env: {}, filename }, postgres, schema;
  if (testPostgresUrl) {
    const { Pool } = await import('pg');
    postgres = new Pool({ connectionString: testPostgresUrl });
    schema = `jeroc_env_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(testPostgresUrl);
    connection.searchParams.set('options', `-c search_path=${schema}`);
    options = { env: { DATABASE_URL: connection.toString() } };
  }
  let repository = await createEnvironmentRepository(options);
  const pricing = createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
  let time = new Date('2026-10-09T10:00:00Z');
  const siteRestrictions = new Map();
  const principalStore = { ...pricing, principal(actor, effective) {
    const result = pricing.principal(actor, effective);
    if (siteRestrictions.has(result.user.id)) result.user.siteIds = siteRestrictions.get(result.user.id);
    return result;
  } };
  const make = () => createEnvironmentStore({ repository, principalStore, now: () => time });
  let store = make();
  const login = (userId = 'admin', effectiveUserId) => store.login({ userId, password: ENVIRONMENT_DEMO_PASSWORD, ...(effectiveUserId ? { effectiveUserId } : {}) });
  const admin = await login(), kajsa = await login('kajsa'), anna = await login('anna');
  try {
    await run({ get store() { return store; }, get repository() { return repository; }, pricing, principalStore, login, admin, kajsa, anna, directory, filename, siteRestrictions, repositoryOptions: options,
      advance: (milliseconds) => { time = new Date(time.getTime() + milliseconds); },
      restart: async () => { await repository.close(); repository = await createEnvironmentRepository(options); store = make(); },
    });
  } finally {
    await repository.close();
    if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

test('environment requires persistent storage on Render and rejects a memory fallback', async () => {
  await reject(() => createEnvironmentRepository({ env: { RENDER: 'true' } }), 503, 'setup_required');
  await reject(() => createEnvironmentRepository({ env: {}, filename: ':memory:' }), 503, 'persistent_database_required');
});

test('receipts, immutable snapshots, passwords and sessions survive database reopening and backup restoration', async () => fixture(async (f) => {
  const receipt = await f.store.receive(input(), f.kajsa.token);
  assert.equal(receipt.hash, environmentHash(receipt.snapshot));
  const backup = await f.repository.backup();
  assert.equal(backup.includes(ENVIRONMENT_DEMO_PASSWORD), false);
  await f.restart();
  assert.equal((await f.store.state(f.anna.token)).receipts[0].hash, receipt.hash);
  assert.equal((await f.store.session(f.kajsa.token)).effectiveUserId, 'kajsa');
  const empty = JSON.parse(backup); empty.receipts = []; empty.inventory = []; empty.reports = []; empty.requests = []; empty.audit = [];
  await f.repository.restore(JSON.stringify(empty));
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 0);
  await f.repository.restore(backup);
  assert.equal((await f.store.state(f.admin.token)).inventory.length, 2);
  await f.restart();
  assert.equal((await f.store.state(f.admin.token)).reports.length, 1);
  if (f.repository.kind === 'sqlite') assert.equal((await readFile(f.filename)).includes(Buffer.from(ENVIRONMENT_DEMO_PASSWORD)), false);
}));

test('two staff sessions register a mixed receipt exactly once; repeated card numbers are separate stable sources', async () => fixture(async (f) => {
  const request = input();
  const results = await Promise.all([f.store.receive(request, f.kajsa.token), f.store.receive({ ...request, idempotencyKey: randomUUID() }, f.admin.token)]);
  assert.equal(results[0].id, results[1].id);
  const state = await f.store.state(f.anna.token);
  assert.equal(state.receipts.length, 1); assert.equal(state.inventory.length, 2); assert.equal(state.reports.length, 1);
  assert.equal(state.inventory.reduce((sum, row) => sum + row.weight, 0), 262);
  assert.equal(state.reports[0].wasteCode, '160601'); assert.equal(state.reports[0].weight, 250);
  assert.equal(state.reports[0].mode, 'prepared-only'); assert.equal(state.reports[0].status, 'incomplete');
  assert.match(state.reports[0].missingFields.join(' '), /verksamhetsutövaruppgifter/);
  assert.equal(state.receipts[0].deviations[0].code, 'missing_document');
  assert.equal(state.reports[0].noteDueDate, '2026-10-13'); assert.equal(state.reports[0].reportDueDate, '2026-10-15');
  const second = await f.store.receive(input({ cardId: request.cardId }), f.kajsa.token);
  assert.notEqual(second.id, results[0].id);
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 2);
  await reject(() => f.store.receive({ ...request, rows: [{ articleId: 'lead-battery', weight: 251 }] }, f.kajsa.token), 409, 'idempotency_conflict');
  await reject(() => f.store.receive({ ...request, idempotencyKey: randomUUID(), rows: [{ articleId: 'lead-battery', weight: 251 }] }, f.admin.token), 409, 'source_conflict');
}));

test('classification versions are optimistic, audited and never alter historical physical receipt rows', async () => fixture(async (f) => {
  const receipt = await f.store.receive(input(), f.kajsa.token);
  const current = await f.store.classification('lead-battery', f.admin.token);
  const updated = await f.store.classify('lead-battery', { expectedVersion: current.version, hazardous: false, wasteCode: '', wasteDescription: '', handlingInstructions: 'Ny instruktion', adrRequired: false }, f.admin.token);
  assert.equal(updated.version, 2);
  await reject(() => f.store.classify('lead-battery', { expectedVersion: 1, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier', handlingInstructions: '', adrRequired: false }, f.admin.token), 409, 'version_conflict');
  const state = await f.store.state(f.admin.token);
  assert.equal(state.receipts[0].snapshot.rows[0].classification.hazardous, true);
  assert.equal(state.receipts[0].snapshot.rows[0].classification.version, 1);
  assert.equal(state.receipts[0].hash, receipt.hash);
  assert.equal(state.reports[0].weight, 250);
  const plain = await f.store.receive(input(), f.kajsa.token);
  assert.equal(plain.reportIds.length, 0);
  assert.equal((await f.repository.backup()).includes('environment.classified'), true);
}));

test('a matching cross-actor retry also reserves its idempotency key against later reuse', async () => fixture(async (f) => {
  const request = input();
  const first = await f.store.receive(request, f.kajsa.token);
  const secondKey = randomUUID();
  const retry = await f.store.receive({ ...request, idempotencyKey: secondKey }, f.admin.token);
  assert.equal(retry.id, first.id);
  await reject(() => f.store.receive(input({ idempotencyKey: secondKey }), f.admin.token), 409, 'idempotency_conflict');
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 1);
}));

test('independent repository connections share the same atomic receipt and migration safely', async () => fixture(async (f) => {
  const otherRepository = await createEnvironmentRepository(f.repositoryOptions);
  const otherStore = createEnvironmentStore({ repository: otherRepository, principalStore: f.principalStore, now: () => new Date('2026-10-09T10:00:00Z') });
  try {
    const otherLogin = await otherStore.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD });
    const request = input();
    const receipts = await Promise.all([f.store.receive(request, f.admin.token), otherStore.receive(request, otherLogin.token)]);
    assert.equal(receipts[0].id, receipts[1].id);
    assert.equal((await otherStore.state(otherLogin.token)).inventory.length, 2);
  } finally { await otherRepository.close(); }
}));

test('repository prevents accidental overwriting/deletion of original receipts, classifications, stock and audit', async () => fixture(async (f) => {
  const receipt = await f.store.receive(input(), f.admin.token);
  for (const name of ['receipts', 'classifications', 'inventory', 'audit']) await reject(() => f.repository.transact((state) => { state[name][0].accidentalChange = true; }), 409, 'immutable_record');
  await reject(() => f.repository.transact((state) => { state.receipts = []; }), 409, 'immutable_record');
  assert.equal((await f.store.state(f.admin.token)).receipts[0].hash, receipt.hash);
}));

test('site/operation permissions re-resolve on every call; impersonation requires authenticated Systemadmin', async () => fixture(async (f) => {
  await reject(() => f.store.classify('lead-battery', { expectedVersion: 1, hazardous: true, wasteCode: '160601', wasteDescription: 'Bly', handlingInstructions: '', adrRequired: false }, f.kajsa.token), 403, 'forbidden');
  await reject(() => f.store.receive(input(), f.anna.token), 403, 'forbidden');
  await reject(() => f.store.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD, effectiveUserId: 'admin' }), 401, 'invalid_credentials');
  const acted = await f.login('admin', 'anna');
  await reject(() => f.store.receive(input(), acted.token), 403, 'forbidden');
  await f.store.receive(input(), f.kajsa.token);
  f.siteRestrictions.set('kajsa', ['rimbo']);
  assert.equal((await f.store.state(f.kajsa.token)).receipts.length, 0);
  await reject(() => f.store.state(f.kajsa.token, 'norrtalje'), 403, 'site_forbidden');
  await reject(() => f.store.receive(input(), f.kajsa.token), 403, 'site_forbidden');
  const users = f.pricing.read(f.pricing.principal('admin')).users;
  f.pricing.saveUsers({ users: users.map((user) => user.id === 'anna' ? { ...user, permissions: user.permissions.filter((permission) => permission !== 'environmentRead') } : user) }, f.pricing.principal('admin'));
  await reject(() => f.store.state(f.anna.token), 403, 'forbidden');
  await f.store.logout(f.admin.token); await reject(() => f.store.state(f.admin.token), 401, 'session_required');
  f.advance(9 * 60 * 60 * 1000); await reject(() => f.store.session(f.kajsa.token), 401, 'session_required');
}));

test('environment rejects invalid physical weights, unknown articles, missing domestic fields and future receipts', async () => fixture(async (f) => {
  for (const invalid of [0, -1, 1.2345, Infinity]) await reject(() => f.store.receive(input({ rows: [{ articleId: 'lead-battery', weight: invalid }] }), f.admin.token), 422);
  await reject(() => f.store.receive(input({ rows: [{ articleId: 'missing-article', weight: 1 }] }), f.admin.token), 422, 'article_not_found');
  await reject(() => f.store.receive(input({ lastPlace: { ...place, municipalityCode: '' } }), f.admin.token), 422);
  await reject(() => f.store.receive(input({ incomingDocument: {} }), f.admin.token), 422);
  await reject(() => f.store.receive(input({ receivedAt: '2026-10-10T10:00:00+02:00' }), f.admin.token), 422, 'future_receipt');
  await reject(() => f.store.receive(input({ rows: [{ articleId: 'lead-battery', weight: 1e9 }, { articleId: 'lead-battery', weight: 1e9 }] }), f.admin.token), 422);
  assert.equal((await f.store.state(f.admin.token)).receipts.length, 0);
  const valid = await f.store.receive(input({ rows: [{ articleId: 'lead-battery', weight: 1.123 }], incomingDocument: { reference: 'TD-IN-2050' } }), f.admin.token);
  assert.equal(valid.deviations.length, 0);
}));

test('Swedish receipt deadlines cross weekends, public holidays, year boundaries and Stockholm local midnight', () => {
  assert.equal(addSwedishWorkingDays('2026-10-09T10:00:00+02:00', 2), '2026-10-13');
  assert.equal(addSwedishWorkingDays('2026-10-08T22:30:00Z', 2), '2026-10-13');
  assert.equal(addSwedishWorkingDays('2026-04-02T10:00:00+02:00', 2), '2026-04-08');
  assert.equal(addSwedishWorkingDays('2026-12-24T10:00:00+01:00', 2), '2026-12-29');
  assert.equal(addSwedishWorkingDays('2026-12-31T10:00:00+01:00', 2), '2027-01-05');
  assert.equal(addSwedishWorkingDays('2027-01-05', 2), '2027-01-08');
});

test('authorized demo generation reset removes only physical weighing-linked records and preserves credentials/classifications', async () => fixture(async (f) => {
  await f.store.receive(input(), f.admin.token);
  const backup = JSON.parse(await f.repository.backup());
  backup.demoGeneration = 'old-demo-generation';
  await f.repository.restore(JSON.stringify(backup));
  const restored = JSON.parse(await f.repository.backup());
  assert.equal(restored.demoGeneration, ENVIRONMENT_DEMO_GENERATION);
  assert.equal(restored.receipts.length, 0); assert.equal(restored.inventory.length, 0); assert.equal(restored.reports.length, 0);
  assert.equal(restored.credentials.length, 4); assert.equal(restored.classifications.length, 1);
  assert.equal((await f.store.session(f.admin.token)).actualUserId, 'admin');
}));

test('HTTP environment authentication ignores demo headers, protects cookie writes and rejects cross-origin requests', async () => fixture(async (f) => {
  const api = createEnvironmentApi({ repository: f.repository, principalStore: f.principalStore, now: () => new Date('2026-10-09T10:00:00Z') });
  const server = createServer(async (req, res) => { if (!await api(req, res, new URL(req.url, 'http://localhost'))) { res.statusCode = 404; res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', value, headers = {}) => fetch(`${base}/api/environment${path}`, { method, headers: { ...(value ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(value ? { body: JSON.stringify(value) } : {}) });
  try {
    assert.equal((await call('/state', 'GET', undefined, { 'X-Demo-User': 'admin', 'X-Demo-Actor': 'admin' })).status, 401);
    const login = await call('/login', 'POST', { userId: 'admin', password: ENVIRONMENT_DEMO_PASSWORD }, { Origin: base });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/receipts', 'POST', input(), { Cookie: cookie, Origin: base })).status, 403);
    const authenticated = { Cookie: cookie, Origin: base, 'X-Environment-CSRF': session.csrfToken };
    const receipt = await call('/receipts', 'POST', input(), authenticated); assert.equal(receipt.status, 201);
    const response = await receipt.json(); assert.equal(response.hash, environmentHash(response.snapshot));
    assert.equal((await call('/state', 'GET', undefined, { Cookie: cookie, Origin: 'https://hostile.example' })).status, 403);
    assert.equal((await call('/receipts', 'POST', input(), { ...authenticated, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const stateResponse = await call('/state', 'GET', undefined, { Cookie: cookie }); const state = await stateResponse.json();
    assert.equal(state.receipts.length, 1); assert.equal(JSON.stringify(state).includes('digest'), false); assert.equal(JSON.stringify(state).includes('csrfToken'), false);
    assert.equal((await call('/logout', 'POST', {}, authenticated)).status, 200);
    assert.equal((await call('/state', 'GET', undefined, { Cookie: cookie })).status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test('failed password attempts persist their rate limit across restart', async () => fixture(async (f) => {
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await f.store.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD }, undefined, 'successful-logins')).result.effectiveUserId, 'kajsa');
  for (let attempt = 0; attempt < 8; attempt += 1) await reject(() => f.store.login({ userId: 'kajsa', password: 'wrong-password' }, undefined, 'rate-test'), 401, 'invalid_credentials');
  await f.restart();
  await reject(() => f.store.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD }, undefined, 'rate-test'), 429, 'rate_limited');
  f.advance(11 * 60 * 1000);
  assert.equal((await f.store.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD }, undefined, 'rate-test')).result.effectiveUserId, 'kajsa');
}));

test('PostgreSQL normalized migrations, unique stock/source constraints and recovery work on a real database', { skip: !testPostgresUrl }, async () => fixture(async (f) => {
  assert.equal(f.repository.kind, 'postgresql');
  const { Pool } = await import('pg');
  const inspection = new Pool({ connectionString: f.repositoryOptions.env.DATABASE_URL });
  try {
    const request = input(), receipt = await f.store.receive(request, f.kajsa.token);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_receipts')).rows[0].count), 1);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_inventory')).rows[0].count), 2);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_reports')).rows[0].count), 1);
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_receipts (id, source_id, data) VALUES ($1, $2, $3::jsonb)', [randomUUID(), request.sourceId, '{}']), (error) => error.code === '23505');
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_inventory (id, receipt_id, article_id, data) VALUES ($1, $2, $3, $4::jsonb)', [randomUUID(), receipt.id, 'lead-battery', '{}']), (error) => error.code === '23505');
    await assert.rejects(() => inspection.query('INSERT INTO jeroc_environment_inventory (id, receipt_id, article_id, data) VALUES ($1, $2, $3, $4::jsonb)', [randomUUID(), randomUUID(), 'lead-battery', '{}']), (error) => error.code === '23503');
    const backup = await f.repository.backup();
    await f.restart();
    assert.equal((await f.store.state(f.anna.token)).receipts[0].hash, receipt.hash);
    await f.repository.restore(backup);
    assert.equal(Number((await inspection.query('SELECT COUNT(*) FROM jeroc_environment_inventory')).rows[0].count), 2);
  } finally { await inspection.end(); }
}));
