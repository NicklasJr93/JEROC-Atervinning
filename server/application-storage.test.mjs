import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { createApplicationRepository } from './application-storage.mjs';
import { afterDatabaseCommit } from './database-runtime.mjs';
import { getChangeEvents } from './change-events.mjs';
import { withMobileSupportAuthorization } from './mobile-support-identity.mjs';

const seed = () => ({ metadata: { marker: randomUUID() }, office: { cards: [{ id: 1 }], customers: [] }, pricing: { users: [], articleHistory: [] }, transport: {}, mobile: { drafts: [] }, imports: [] });
const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
async function fixture(run, postgres = false, initial = seed) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-app-read-')), filename = join(directory, 'application.sqlite');
  let admin, schema, env = {};
  if (postgres) {
    const { Pool } = await import('pg'); admin = new Pool({ connectionString: postgresUrl });
    schema = `app_storage_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`); env = { DATABASE_URL: url.toString() };
  }
  const repositories = [];
  const create = async () => { const repository = await createApplicationRepository({ env, filename, seed: initial }); repositories.push(repository); return repository; };
  try { await run({ repository: await create(), create, filename, admin, schema, env }); }
  finally {
    for (const repository of repositories) await repository.close();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const postgres of [false, true]) {
  const backend = postgres ? 'PostgreSQL' : 'SQLite';
  test(`${backend}: revoked support rolls back before commit and ordinary writes have no support dependency`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository }) => {
    const before = await repository.read((state, revision) => ({ state, revision }));
    let allowed = true, checks = 0;
    const authorize = async () => { checks += 1; if (!allowed) throw new Error('Support session revoked'); };
    await assert.rejects(withMobileSupportAuthorization(authorize, () => repository.transact((state, _revision, audit) => {
      state.office.customers.push({ id: 'must-not-commit' }); audit.push({ action: 'must-not-commit' }); allowed = false;
    })), /Support session revoked/);
    assert.equal(checks, 2); assert.deepEqual(await repository.read((state, revision) => ({ state, revision })), before);
    let entered = false;
    await assert.rejects(withMobileSupportAuthorization(authorize, () => repository.transact(() => { entered = true; })), /Support session revoked/);
    assert.equal(entered, false);
    await repository.transact(state => { state.office.customers.push({ id: 'ordinary-write' }); });
    assert.equal((await repository.read(state => state.office.customers)).at(-1).id, 'ordinary-write');
  }, postgres));
  test(`${backend}: leaf projections omit large history, preserve JSON values and never write`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, create, filename, admin, schema }) => {
    const options = { domain: 'vismaIntegration', paths: [
      ['tenants', 'jeroc-demo', 'generation'], ['tenants', 'jeroc-demo', 'tokens'],
      ['tenants', 'jeroc-demo', 'enabled'], ['tenants', 'jeroc-demo', 'lastError'],
      ['tenants', 'jeroc-demo', 'missing'], ['tenants', 'other', 'generation'],
      ['tenants', 'jeroc-demo', 'generation'],
    ] };
    const before = await repository.read((state, revision) => ({ state, revision }));
    const result = await repository.readProjection((state, revision) => ({ state, revision }), options);
    assert.deepEqual(result, { state: { vismaIntegration: { tenants: { 'jeroc-demo': { generation: 0, tokens: { version: 3, access: 'encrypted-test-value' }, enabled: false, lastError: null } } } }, revision: 0 });
    assert.ok(JSON.stringify(result).length < 400);
    await repository.readProjection(state => { state.vismaIntegration.tenants['jeroc-demo'].tokens.version = 999; }, options);
    const other = await create();
    assert.deepEqual(await other.read((state, revision) => ({ state, revision })), before);
    assert.deepEqual(await other.readProjection(state => state, { domain: 'pricing', paths: [['users']] }), { pricing: { users: [{ id: 'employee', name: 'Test Person' }] } });
    if (postgres) assert.equal(Number((await admin.query(`SELECT COUNT(*) AS count FROM "${schema}".jeroc_application_audit`)).rows[0].count), 0);
    else { const db = new DatabaseSync(filename); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM application_audit').get().count, 0); db.close(); }
  }, postgres, () => ({ ...seed(), pricing: { users: [{ id: 'employee', name: 'Test Person' }] }, vismaIntegration: { tenants: { 'jeroc-demo': {
    generation: 0, tokens: { version: 3, access: 'encrypted-test-value' }, enabled: false, lastError: null,
    journal: [{ request: 'excluded-history'.repeat(200_000) }],
  } } } })));

  test(`${backend}: missing/empty projection paths do not manufacture fields or normalize domains`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository }) => {
    assert.deepEqual(await repository.readProjection(state => state, { domain: 'office', paths: [] }), {});
    assert.deepEqual(await repository.readProjection(state => state, { domain: 'office', paths: [['missing', 'leaf']] }), {});
    assert.deepEqual(await repository.readProjection(state => state, { domain: 'absent', paths: [['value']] }), {});
    assert.deepEqual(await repository.readProjection(state => state, { domain: 'pricing', paths: [['users'], ['articleHistory']] }), { pricing: { users: [], articleHistory: [] } });
    assert.deepEqual(await repository.readProjection(state => state, { domain: 'workOrderWeighing', paths: [['absent']] }), {});
    for (const options of [undefined, {}, { domain: '', paths: [] }, { domain: 'office', paths: 'cards' }, { domain: 'office', paths: [[]] }, { domain: 'office', paths: [[1]] }])
      await assert.rejects(async () => repository.readProjection(state => state, options), TypeError);
    assert.equal(await repository.read((state, revision) => revision), 0);
  }, postgres));

  test(`${backend}: empty and prototype-like JSON keys remain ordinary data`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository }) => {
    const state = await repository.readProjection(state => state, { domain: '__proto__', paths: [['constructor', 'value'], ['', '__proto__', 'label']] });
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
    assert.equal(Object.getPrototypeOf(state.__proto__), Object.prototype);
    assert.equal(state.__proto__.constructor.value, 'safe');
    assert.equal(state.__proto__[''].__proto__.label, 'empty-key');
    assert.equal({}.label, undefined);
  }, postgres, () => ({ ...seed(), ...JSON.parse('{"__proto__":{"constructor":{"value":"safe"},"":{"__proto__":{"label":"empty-key"}}}}') })));

  test(`${backend}: legacy document article labels select current names without prices or historical fields`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository }) => {
    assert.deepEqual(await repository.readArticleNames(['copper', 'inactive', 'missing', 'copper']), [{ id: 'copper', name: 'Current copper' }, { id: 'inactive', name: 'Inactive catalogue name' }]);
    assert.deepEqual(await repository.readArticleNames([]), []);
    await assert.rejects(async () => repository.readArticleNames([1]), TypeError);
    assert.equal(await repository.read((state, revision) => revision), 0);
  }, postgres, () => ({ ...seed(), pricing: { articleHistory: [
    { id: 'copper', name: 'Old copper', sequence: 1, price: 99, history: 'x'.repeat(1_000_000) },
    { id: 'copper', name: 'Current copper', sequence: 2, price: 123 },
    { id: 'copper', name: 'Later same-sequence row', sequence: 2, price: 456 },
    { id: 'inactive', name: 'Inactive catalogue name', active: false, sequence: 1 },
    { id: 'unrequested', name: 'Not transferred', sequence: 100 },
  ] } })));

  test(`${backend}: targeted reads do not persist mutations, load unrelated history or bump revision`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, create }) => {
    const original = await repository.read((state, revision) => ({ state, revision }));
    assert.equal(original.revision, 0);
    await repository.read(state => {
      assert.deepEqual(Object.keys(state), ['office']); state.office.cards[0].id = 999;
      assert.equal(state.imports, undefined); assert.equal(state.pricing, undefined); assert.equal(state.metadata, undefined);
    }, { domains: ['office'] });
    const other = await create(), saved = await other.read((state, revision) => ({ state, revision }));
    assert.deepEqual(saved, original); assert.equal(saved.state.office.cards[0].id, 1);
    assert.deepEqual(await other.read(state => Object.keys(state), { domains: [] }), []);
  }, postgres));

  test(`${backend}: scoped reads preserve persisted legacy documents instead of writing normalization`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, filename, admin, schema }) => {
    if (postgres) await admin.query(`DELETE FROM "${schema}".jeroc_application_documents WHERE domain='workOrderWeighing'`);
    else {
      const db = new DatabaseSync(filename), old = JSON.parse(db.prepare('SELECT document FROM application WHERE id=1').get().document);
      delete old.workOrderWeighing; db.prepare('UPDATE application SET document=? WHERE id=1').run(JSON.stringify(old)); db.close();
    }
    assert.deepEqual(await repository.read(state => state.workOrderWeighing, { domains: ['workOrderWeighing'] }), { version: 1, drafts: {} });
    if (postgres) assert.equal((await admin.query(`SELECT domain FROM "${schema}".jeroc_application_documents WHERE domain='workOrderWeighing'`)).rows.length, 0);
    else { const db = new DatabaseSync(filename); assert.equal(Object.hasOwn(JSON.parse(db.prepare('SELECT document FROM application WHERE id=1').get().document), 'workOrderWeighing'), false); db.close(); }
  }, postgres));

  test(`${backend}: failed writes roll back all domains/audit and later valid writes remain durable`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, create }) => {
    const before = await repository.read((state, revision) => ({ state, revision }));
    await assert.rejects(repository.transact((state, revision, audit) => {
      state.office.cards.push({ id: 2 }); state.pricing.users.push({ id: 'new' }); audit.push({ action: 'should-roll-back' }); throw new Error('blocked');
    }), /blocked/);
    assert.deepEqual(await repository.read((state, revision) => ({ state, revision })), before);
    await repository.transact((state, revision, audit) => { state.office.cards.push({ id: 2 }); state.pricing.users.push({ id: 'new' }); audit.push({ action: 'saved' }); });
    const other = await create(); assert.equal(await other.read(state => state.office.cards.length, { domains: ['office'] }), 2);
    assert.equal(await other.read((state, revision) => revision), before.revision + 1);
  }, postgres));

  test(`${backend}: invalidations follow successful changed commits, not reads/no-op/rolled-back writes`, { skip: postgres && !postgresUrl }, async () => fixture(async ({ repository, env, filename }) => {
    const changes = getChangeEvents({ ...env, JEROC_APPLICATION_DB_PATH: filename }), received = [], unsubscribe = changes.subscribe(event => received.push(event));
    try {
      await repository.read(state => { state.office.cards.push({ id: 999 }); }, { domains: ['office'] });
      await repository.transact(() => {});
      await assert.rejects(repository.transact(state => { state.office.cards.push({ id: 999 }); throw new Error('cancel'); }), /cancel/);
      assert.equal(received.length, 0);
      await repository.transact(state => { state.office.cards.push({ id: 2 }); });
      assert.equal(received.length, 1); assert.equal(received[0].domain, 'application'); assert.equal(received[0].revision, 1);
      assert.deepEqual(Object.keys(received[0]).sort(), ['domain', 'eventId', 'revision']);
    } finally { unsubscribe(); await changes.close(); }
  }, postgres));
}

test('SQLite: a projection inside a command copies its current values without deadlocking or leaking mutations', async () => fixture(async ({ repository }) => {
  await repository.transact(async state => {
    state.pricing.users.push({ id: 'uncommitted', roles: ['view'] });
    const projected = await repository.readProjection((projection, revision) => ({ projection, revision }), { domain: 'pricing', paths: [['users']] });
    assert.equal(projected.revision, 0); assert.equal(projected.projection.pricing.users[0].id, 'uncommitted');
    projected.projection.pricing.users[0].roles.push('admin');
    assert.deepEqual(state.pricing.users[0].roles, ['view']);
  });
  await assert.rejects(repository.transact(async state => {
    state.pricing.users[0].id = 'rolled-back';
    assert.equal(await repository.readProjection(projection => projection.pricing.users[0].id, { domain: 'pricing', paths: [['users']] }), 'rolled-back');
    throw new Error('undo projection command');
  }), /undo projection command/);
  assert.deepEqual(await repository.readProjection((state, revision) => ({ state, revision }), { domain: 'pricing', paths: [['users']] }), { state: { pricing: { users: [{ id: 'uncommitted', roles: ['view'] }] } }, revision: 1 });
}));

test('PostgreSQL projection SQL binds all paths, extracts leaves once, and uses one lock-free snapshot SELECT', async t => {
  const queries = [], client = { release() {}, async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('LIMIT 1')) return { rows: [{ domain: 'existing' }] };
    if (sql.includes('value_json')) return { rows: [
      { revision: '7', path: ['tenants', 'odd"key', 'enabled'], value_json: 'false' },
      { revision: '7', path: ['tenants', 'odd"key', 'lastError'], value_json: 'null' },
      { revision: '7', path: ['tenants', 'odd"key', 'absent'], value_json: null },
    ] };
    return { rows: [], command: sql.startsWith('COMMIT') ? 'COMMIT' : undefined };
  } };
  t.mock.method(pg.Pool.prototype, 'connect', async () => client);
  t.mock.method(pg.Pool.prototype, 'end', async () => {});
  const repository = await createApplicationRepository({ env: { DATABASE_URL: 'postgresql://projection-test.invalid/application' }, seed });
  try {
    queries.length = 0;
    const domain = "vismaIntegration'; DROP TABLE users; --", paths = [['tenants', 'odd"key', 'enabled'], ['tenants', 'odd"key', 'lastError'], ['tenants', 'odd"key', 'absent']];
    const result = await repository.readProjection((state, revision) => ({ state, revision }), { domain, paths });
    assert.deepEqual(result, { state: { [domain]: { tenants: { 'odd"key': { enabled: false, lastError: null } } } }, revision: 7 });
    assert.equal(queries.length, 3);
    assert.match(queries[0].sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    assert.equal(queries[2].sql, 'COMMIT');
    const select = queries[1];
    assert.match(select.sql, /^SELECT/); assert.equal((select.sql.match(/#>/g) ?? []).length, 1);
    assert.match(select.sql, /documents.domain=\$1::text/); assert.match(select.sql, /jsonb_array_elements\(\$2::jsonb\)/);
    assert.doesNotMatch(select.sql, /FOR UPDATE|pg_advisory|INSERT|DELETE|UPDATE/);
    assert.equal(select.sql.includes(domain), false); assert.equal(select.sql.includes('odd"key'), false);
    assert.deepEqual(select.values, [domain, JSON.stringify(paths)]);
  } finally { await repository.close(); }
});

test('PostgreSQL: projected reads join an outer unit of work and preserve its rollback', { skip: !postgresUrl }, async () => fixture(async ({ repository, create }) => {
  const other = await create();
  await assert.rejects(repository.runInTransaction(async () => {
    await repository.transact(state => state.pricing.users.push({ id: 'pending' }));
    const result = await other.readProjection((state, revision) => ({ state, revision }), { domain: 'pricing', paths: [['users']] });
    assert.deepEqual(result, { state: { pricing: { users: [{ id: 'pending' }] } }, revision: 1 });
    result.state.pricing.users[0].id = 'read-only-copy';
    throw new Error('abort shared unit');
  }), /abort shared unit/);
  assert.deepEqual(await other.readProjection((state, revision) => ({ state, revision }), { domain: 'pricing', paths: [['users']] }), { state: { pricing: { users: [] } }, revision: 0 });
}, true));

test('PostgreSQL: outer unit atomically spans independent repositories and committed notifications', { skip: !postgresUrl }, async () => fixture(async ({ repository, create, admin, schema }) => {
  const other = await create(); let notified = 0;
  await assert.rejects(repository.runInTransaction(async () => {
    await repository.transact(state => { state.office.cards.push({ id: 2 }); });
    afterDatabaseCommit(() => { notified += 1; });
    await other.transact(state => { state.pricing.users.push({ id: 'new' }); throw new Error('nested failed'); });
  }), /nested failed/);
  assert.equal(await repository.read(state => state.office.cards.length, { domains: ['office'] }), 1); assert.equal(notified, 0);
  assert.equal(await repository.read(state => state.pricing.users.length, { domains: ['pricing'] }), 0);
  await repository.runInTransaction(async () => {
    await repository.transact((state, revision, audit) => { state.office.cards.push({ id: 2 }); state.imports.push({ domain: 'office', hash: 'first', original: {} }); audit.push({ action: 'one' }, { action: 'two' }); });
    await other.transact(state => { state.pricing.users.push({ id: 'new' }); });
    afterDatabaseCommit(async () => {
      assert.equal(await other.read(state => state.office.cards.length, { domains: ['office'] }), 2); notified += 1;
    });
  });
  assert.equal(notified, 1);
  const revision = await repository.read((state, current) => current);
  await repository.transact(() => {});
  assert.equal(await repository.read((state, current) => current), revision);
  assert.equal((await admin.query(`SELECT id FROM "${schema}".jeroc_application_imports`)).rows.length, 1);
  assert.equal((await admin.query(`SELECT details FROM "${schema}".jeroc_application_audit`)).rows.length, 2);
}, true));

test('PostgreSQL: targeted and projected snapshot reads do not wait behind an uncommitted writer', { skip: !postgresUrl }, async () => fixture(async ({ repository, create }) => {
  const reader = await create(); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { release = resolve; });
  const writing = repository.transact(async state => { state.office.cards.push({ id: 2 }); enter(); await released; });
  await entered;
  let deadline;
  try {
    const during = await Promise.race([
      Promise.all([
        reader.read((state, revision) => ({ count: state.office.cards.length, revision }), { domains: ['office'] }),
        reader.readProjection((state, revision) => ({ count: state.office.cards.length, revision }), { domain: 'office', paths: [['cards']] }),
      ]),
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Read waited for a write lock')), 1000); }),
    ]);
    assert.deepEqual(during, [{ count: 1, revision: 0 }, { count: 1, revision: 0 }]);
  } finally { clearTimeout(deadline); release(); await writing; }
  assert.deepEqual(await reader.read((state, revision) => ({ count: state.office.cards.length, revision }), { domains: ['office'] }), { count: 2, revision: 1 });
  assert.deepEqual(await reader.readProjection((state, revision) => ({ count: state.office.cards.length, revision }), { domain: 'office', paths: [['cards']] }), { count: 2, revision: 1 });
}, true));
