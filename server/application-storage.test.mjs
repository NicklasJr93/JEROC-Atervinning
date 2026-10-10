import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApplicationRepository } from './application-storage.mjs';
import { afterDatabaseCommit } from './database-runtime.mjs';
import { getChangeEvents } from './change-events.mjs';

const seed = () => ({ metadata: { marker: randomUUID() }, office: { cards: [{ id: 1 }], customers: [] }, pricing: { users: [], articleHistory: [] }, transport: {}, mobile: { drafts: [] }, imports: [] });
const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
async function fixture(run, postgres = false) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-app-read-')), filename = join(directory, 'application.sqlite');
  let admin, schema, env = {};
  if (postgres) {
    const { Pool } = await import('pg'); admin = new Pool({ connectionString: postgresUrl });
    schema = `app_storage_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(postgresUrl); url.searchParams.set('options', `-c search_path=${schema}`); env = { DATABASE_URL: url.toString() };
  }
  const repositories = [];
  const create = async () => { const repository = await createApplicationRepository({ env, filename, seed }); repositories.push(repository); return repository; };
  try { await run({ repository: await create(), create, filename, admin, schema, env }); }
  finally {
    for (const repository of repositories) await repository.close();
    if (admin) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const postgres of [false, true]) {
  const backend = postgres ? 'PostgreSQL' : 'SQLite';
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

test('PostgreSQL: a targeted snapshot read does not wait behind an uncommitted writer', { skip: !postgresUrl }, async () => fixture(async ({ repository, create }) => {
  const reader = await create(); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), released = new Promise(resolve => { release = resolve; });
  const writing = repository.transact(async state => { state.office.cards.push({ id: 2 }); enter(); await released; });
  await entered;
  let deadline;
  try {
    const during = await Promise.race([
      reader.read((state, revision) => ({ count: state.office.cards.length, revision }), { domains: ['office'] }),
      new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Read waited for a write lock')), 1000); }),
    ]);
    assert.deepEqual(during, { count: 1, revision: 0 });
  } finally { clearTimeout(deadline); release(); await writing; }
  assert.deepEqual(await reader.read((state, revision) => ({ count: state.office.cards.length, revision }), { domains: ['office'] }), { count: 2, revision: 1 });
}, true));
