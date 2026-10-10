import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterDatabaseCommit, measureDatabaseWork, runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';

function pool(options = { connectionString: 'postgres://test@localhost/runtime_contract' }) {
  const calls = [], clients = [];
  return { options, calls, clients, async connect() {
    const client = { async query(sql) { calls.push(sql); return { command: sql === 'COMMIT' ? 'COMMIT' : undefined }; }, release() { calls.push('RELEASE'); } };
    clients.push(client); return client;
  } };
}

test('separate repository pools with one database config share a single client/commit, including reads', async () => {
  const outer = pool({ connectionString: 'postgres://test@localhost/runtime_contract', max: 5 });
  const repository = pool({ max: 2, connectionString: 'postgres://test@localhost/runtime_contract', connectionTimeoutMillis: 500 });
  const events = [];
  const result = await runInDatabaseTransaction(outer, async client => {
    await client.query('WRITE application');
    await runInDatabaseTransaction(repository, async nested => {
      assert.equal(nested, client); await nested.query('WRITE terminal');
      afterDatabaseCommit(() => { assert.equal(outer.calls.at(-1), 'RELEASE'); events.push('committed'); });
    });
    await runDatabaseRead(repository, async read => { assert.equal(read, client); await read.query('READ own writes'); });
    assert.deepEqual(events, []); return 'accepted';
  });
  assert.equal(result, 'accepted'); assert.deepEqual(events, ['committed']);
  assert.equal(outer.clients.length, 1); assert.equal(repository.clients.length, 0);
  assert.deepEqual(outer.calls, ['BEGIN', 'WRITE application', 'WRITE terminal', 'READ own writes', 'COMMIT', 'RELEASE']);
});

test('caught nested failures still roll back the outer transaction and discard notifications', async () => {
  const repository = pool(), failure = new Error('terminal reservation failed'); let notified = false;
  await assert.rejects(runInDatabaseTransaction(repository, async () => {
    afterDatabaseCommit(() => { notified = true; });
    try { await runInDatabaseTransaction(repository, () => { throw failure; }); } catch {}
    return 'must not commit';
  }), error => error === failure);
  assert.deepEqual(repository.calls, ['BEGIN', 'ROLLBACK', 'RELEASE']); assert.equal(notified, false);
});

test('read snapshots use repeatable-read without write locks and cannot nest writes', async () => {
  const repository = pool();
  await runDatabaseRead(repository, client => client.query('SELECT consistent snapshot'));
  assert.deepEqual(repository.calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT consistent snapshot', 'COMMIT', 'RELEASE']);
  await assert.rejects(runDatabaseRead(repository, () => runInDatabaseTransaction(repository, () => 'unsafe')), /skrivning.*lästransaktion/);
  assert.equal(repository.calls.at(-2), 'ROLLBACK');
});

test('different search paths or TLS settings fail closed instead of committing an independent repository', async () => {
  for (const other of [pool({ connectionString: 'postgres://test@localhost/runtime_contract', options: '-c search_path=other' }),
    pool({ connectionString: 'postgres://test@localhost/runtime_contract', ssl: { rejectUnauthorized: false } })]) {
    const repository = pool();
    await assert.rejects(runInDatabaseTransaction(repository, () => runInDatabaseTransaction(other, () => 'unsafe')), /olika anslutningskonfigurationer/);
    assert.equal(other.clients.length, 0); assert.deepEqual(repository.calls, ['BEGIN', 'ROLLBACK', 'RELEASE']);
  }
});

test('concurrent requests have independent units and after-commit work opens a fresh transaction', async () => {
  const repository = pool(), owned = [];
  await Promise.all([1, 2].map(id => runInDatabaseTransaction(repository, async client => {
    owned.push(client); await Promise.resolve();
    await runDatabaseRead(repository, nested => { assert.equal(nested, client); });
    afterDatabaseCommit(() => runDatabaseRead(repository, fresh => { assert.notEqual(fresh, client); }));
    return id;
  })));
  assert.notEqual(owned[0], owned[1]); assert.equal(repository.clients.length, 4);
  assert.equal(repository.calls.filter(sql => sql === 'COMMIT').length, 4);
});

test('a PostgreSQL aborted COMMIT never fires post-commit effects', async () => {
  const repository = pool(); const connect = repository.connect;
  repository.connect = async () => { const client = await connect(); const query = client.query; client.query = async sql => sql === 'COMMIT' ? (repository.calls.push(sql), { command: 'ROLLBACK' }) : query(sql); return client; };
  let notified = false;
  await assert.rejects(runInDatabaseTransaction(repository, () => { afterDatabaseCommit(() => { notified = true; }); }), /återställdes/);
  assert.equal(notified, false); assert.equal(repository.calls.at(-2), 'ROLLBACK');
});

test('request diagnostics count nested SQL once, contain no parameters and restore the pooled client', async () => {
  const repository = pool(); let original;
  const measured = await measureDatabaseWork(() => runInDatabaseTransaction(repository, async client => {
    original = repository.clients[0].query;
    await runDatabaseRead(repository, nested => nested.query('SELECT value FOR UPDATE', ['private-value']));
    return 'committed';
  }));
  assert.equal(measured.result, 'committed'); assert.equal(measured.metrics.sqlCount, 3);
  assert.equal(measured.metrics.sqlMs >= measured.metrics.commitMs, true);
  assert.equal(measured.metrics.lockQueryMs >= 0, true);
  assert.equal(JSON.stringify(measured.metrics).includes('private-value'), false);
  assert.notEqual(repository.clients[0].query, original);
  const restored = repository.clients[0].query;
  await restored('SELECT after request'); assert.equal(measured.metrics.sqlCount, 3);
});
