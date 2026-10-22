import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoStorage, DemoStorageError } from '../public/bokforing/storage.js';
import { STORAGE_KEY, bookDraft, createState } from '../public/bokforing/model.js';

class MemoryStorage {
  constructor(raw = null) { this.raw = raw; this.reads = 0; this.writes = 0; }
  getItem(key) {
    assert.equal(key, STORAGE_KEY);
    this.reads++;
    if (this.readError || this.failReadAt === this.reads) throw new Error('Synthetic read failure');
    return this.raw;
  }
  setItem(key, value) {
    assert.equal(key, STORAGE_KEY);
    this.writes++;
    if (this.writeError) throw new Error('Synthetic quota failure');
    if (!this.dropWrites) this.raw = value;
  }
}

function serialLocks() {
  const pending = new Map();
  return {
    request(name, options, callback) {
      assert.equal(options.mode, 'exclusive');
      const previous = pending.get(name) ?? Promise.resolve();
      const result = previous.then(() => callback({ name, mode: options.mode }));
      pending.set(name, result.catch(() => {}));
      return result;
    },
  };
}

function harness({ storage = new MemoryStorage(), locks = serialLocks() } = {}) {
  let revision = 0;
  const create = () => createDemoStorage({ getStorage: () => storage, locks, makeRevision: () => `test-revision-${++revision}` });
  return { storage, locks, store: create(), second: create() };
}

const hasCode = code => error => error instanceof DemoStorageError && error.code === code;
const document = (state, id = 'doc-office') => state.documents.find(item => item.id === id);
const post = (id = 'doc-office') => state => {
  const item = document(state, id);
  return bookDraft(state, item.id, item.rows, item.version);
};

test('fresh demo is read without creating a persisted book', () => {
  const { store, storage } = harness();
  const snapshot = store.load();
  assert.equal(snapshot.writable, true);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.revision, null);
  assert.deepEqual(snapshot.state, createState());
  assert.equal(storage.raw, null);
  assert.equal(storage.writes, 0);
});

test('legacy stored state is loaded without migration or data replacement', () => {
  const original = post()(createState());
  original.integrationNote = 'Legacy extra metadata is preserved';
  const raw = JSON.stringify(original);
  const { store, storage } = harness({ storage: new MemoryStorage(raw) });
  const snapshot = store.load();
  assert.deepEqual(snapshot.state, original);
  assert.equal(snapshot.revision, raw);
  assert.equal(snapshot.writable, true);
  assert.equal(storage.writes, 0);
});

test('posting is returned only after confirmed local write and readback, without mutating caller state', async () => {
  const { store, storage } = harness();
  const initial = store.load();
  const before = structuredClone(initial);
  const committed = await store.commit(initial, post());
  assert.deepEqual(initial, before);
  assert.equal(document(initial.state).status, 'draft');
  assert.equal(document(committed.state).status, 'booked');
  assert.equal(committed.revision, storage.raw);
  assert.deepEqual(JSON.parse(storage.raw), committed.state);
  assert.equal(typeof committed.state._demoStorageRevision, 'string');
  assert.equal(committed.error, null);
  assert.equal(committed.writable, true);
  assert.equal(storage.writes, 1);
});

test('a stale tab cannot overwrite another tab posting and can safely retry after reloading', async () => {
  const { store, second, storage } = harness();
  const firstSnapshot = store.load(), staleSnapshot = second.load();
  const first = await store.commit(firstSnapshot, post());
  await assert.rejects(second.commit(staleSnapshot, post('doc-equipment')), hasCode('STALE_STATE'));
  assert.equal(storage.raw, first.revision);
  assert.equal(document(staleSnapshot.state, 'doc-equipment').status, 'draft');
  const loaded = second.load();
  const next = await second.commit(loaded, post('doc-equipment'));
  assert.equal(document(next.state).status, 'booked');
  assert.equal(document(next.state, 'doc-equipment').status, 'booked');
  assert.equal(next.state.entries.length, 14);
});

for (const otherId of ['doc-office', 'doc-equipment']) {
  test(`simultaneous tabs serialize safely when posting ${otherId}`, async () => {
    const { store, second, storage } = harness();
    const a = store.load(), b = second.load();
    const results = await Promise.allSettled([
      store.commit(a, async state => { await Promise.resolve(); return post()(state); }),
      second.commit(b, post(otherId)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'STALE_STATE').length, 1);
    const saved = JSON.parse(storage.raw);
    assert.equal(saved.entries.length, 13);
    assert.equal(saved.entries.filter(entry => entry.documentId === 'doc-office').length, 1);
    assert.equal(storage.writes, 1);
  });
}

test('reset rotates revision even when the resulting seed is otherwise identical', async () => {
  const raw = JSON.stringify(createState());
  const { store, second } = harness({ storage: new MemoryStorage(raw) });
  const oldSeed = second.load();
  const posted = await store.commit(store.load(), post());
  const reset = await store.reset(posted);
  assert.equal(document(reset.state).status, 'draft');
  assert.equal(reset.state.entries.length, 12);
  assert.notEqual(reset.revision, oldSeed.revision);
  await assert.rejects(second.commit(oldSeed, post('doc-equipment')), hasCode('STALE_STATE'));
  const resetAgain = await store.reset(reset);
  assert.notEqual(resetAgain.revision, reset.revision);
});

test('a stale reset does not delete newly saved work', async () => {
  const { store, second, storage } = harness();
  const stale = second.load();
  const committed = await store.commit(store.load(), post());
  await assert.rejects(second.reset(stale), hasCode('STALE_STATE'));
  assert.equal(storage.raw, committed.revision);
});

test('quota failure rejects posting and reset without replacing the snapshot or previous data', async () => {
  const { store, storage } = harness();
  const committed = await store.commit(store.load(), post());
  storage.writeError = true;
  await assert.rejects(store.commit(committed, post('doc-equipment')), hasCode('WRITE_FAILED'));
  await assert.rejects(store.reset(committed), hasCode('WRITE_FAILED'));
  assert.equal(storage.raw, committed.revision);
  assert.equal(document(committed.state).status, 'booked');
  assert.equal(document(committed.state, 'doc-equipment').status, 'draft');
});

test('failure reading storage is not treated as a healthy empty demo', async () => {
  const { store, storage } = harness();
  storage.readError = true;
  const unavailable = store.load();
  assert.equal(unavailable.writable, false);
  assert.equal(unavailable.error.code, 'READ_FAILED');
  assert.equal(unavailable.revision, undefined);
  storage.readError = false;
  await assert.rejects(store.commit(unavailable, post()), hasCode('READ_FAILED'));
  await assert.rejects(store.reset(unavailable), hasCode('READ_FAILED'));
  assert.equal(storage.writes, 0);
  assert.equal(store.load().writable, true);
});

test('a throwing localStorage getter produces a blocked snapshot', () => {
  const store = createDemoStorage({ getStorage: () => { throw new Error('Denied'); }, locks: serialLocks() });
  const snapshot = store.load();
  assert.equal(snapshot.error.code, 'READ_FAILED');
  assert.equal(snapshot.writable, false);
  assert.equal(snapshot.revision, undefined);
});

test('a read failure during commit rejects without writing', async () => {
  const { store, storage } = harness();
  const initial = store.load();
  storage.readError = true;
  await assert.rejects(store.commit(initial, post()), hasCode('READ_FAILED'));
  assert.equal(storage.writes, 0);
  assert.equal(document(initial.state).status, 'draft');
});

test('unconfirmed write is not acknowledged and reload recovers an already committed posting', async () => {
  const { store, storage } = harness();
  const initial = store.load();
  storage.failReadAt = storage.reads + 3; // lock read, pre-write check, confirmation
  await assert.rejects(store.commit(initial, post()), hasCode('CONFIRM_FAILED'));
  assert.equal(document(initial.state).status, 'draft');
  storage.failReadAt = null;
  const reloaded = store.load();
  assert.equal(document(reloaded.state).status, 'booked');
  assert.equal(reloaded.state.entries.length, 13);
  await assert.rejects(store.commit(initial, post()), hasCode('STALE_STATE'));
});

test('storage silently dropping a write cannot produce a successful result', async () => {
  const { store, storage } = harness();
  storage.dropWrites = true;
  await assert.rejects(store.commit(store.load(), post()), hasCode('CONFIRM_FAILED'));
  assert.equal(storage.raw, null);
});

for (const raw of ['not JSON', JSON.stringify({ schemaVersion: 99 }), JSON.stringify({ ...createState(), entries: [] })]) {
  test(`invalid persisted data is preserved until explicit reset (${raw.slice(0, 25)})`, async () => {
    const { store, storage } = harness({ storage: new MemoryStorage(raw) });
    const invalid = store.load();
    assert.equal(invalid.error.code, 'INVALID_DATA');
    assert.equal(invalid.revision, raw);
    assert.equal(invalid.writable, false);
    assert.equal(storage.raw, raw);
    assert.equal(storage.writes, 0);
    await assert.rejects(store.commit(invalid, post()), hasCode('INVALID_DATA'));
    assert.equal(storage.raw, raw);
    const reset = await store.reset(invalid);
    assert.equal(reset.state.entries.length, 12);
    assert.equal(reset.error, null);
    assert.equal(store.load().writable, true);
  });
}

test('missing Web Locks fails closed for posting and reset', async () => {
  const { storage, store } = harness({ locks: null });
  const snapshot = store.load();
  assert.equal(snapshot.error.code, 'COORDINATION_UNAVAILABLE');
  assert.equal(snapshot.writable, false);
  await assert.rejects(store.commit(snapshot, post()), hasCode('COORDINATION_UNAVAILABLE'));
  await assert.rejects(store.reset(snapshot), hasCode('COORDINATION_UNAVAILABLE'));
  assert.equal(storage.writes, 0);
});

test('lock-provider rejection fails before storage changes', async () => {
  const { store, storage } = harness({ locks: { request: async () => { throw new Error('Locks denied'); } } });
  await assert.rejects(store.commit(store.load(), post()), hasCode('COORDINATION_UNAVAILABLE'));
  assert.equal(storage.writes, 0);
});

test('invalid business transition leaves storage intact and releases the lock', async () => {
  const { store, storage } = harness();
  const snapshot = store.load();
  await assert.rejects(store.commit(snapshot, state => {
    const item = document(state), rows = structuredClone(item.rows);
    rows[0].debitCents++;
    return bookDraft(state, item.id, rows, item.version);
  }), /balansera/);
  assert.equal(storage.raw, null);
  const saved = await store.commit(snapshot, post());
  assert.equal(saved.state.entries.length, 13);
});

test('invalid transition output is rejected before persistence', async () => {
  const { store, storage } = harness();
  await assert.rejects(store.commit(store.load(), state => ({ ...state, entries: [] })), hasCode('INVALID_DATA'));
  assert.equal(storage.writes, 0);
});

test('an intervening non-cooperating write during an async transition is preserved', async () => {
  const { store, storage } = harness();
  const expected = store.load();
  const external = JSON.stringify(post('doc-equipment')(createState()));
  await assert.rejects(store.commit(expected, async state => {
    storage.raw = external;
    await Promise.resolve();
    return post()(state);
  }), hasCode('STALE_STATE'));
  assert.equal(storage.raw, external);
  assert.equal(storage.writes, 0);
});

test('revision-token failure does not acknowledge or write a new book', async () => {
  const { storage, locks } = harness();
  const store = createDemoStorage({ getStorage: () => storage, locks, makeRevision: () => '' });
  await assert.rejects(store.commit(store.load(), post()), hasCode('COORDINATION_UNAVAILABLE'));
  assert.equal(storage.writes, 0);
});
