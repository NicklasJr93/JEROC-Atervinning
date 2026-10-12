import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChangeEvents, changeEventChannel } from './change-events.mjs';

test('company notification hubs and database channels isolate equal domain/revision events', async () => {
  const base = { ...(process.env.JEROC_TEST_DATABASE_URL && { DATABASE_URL: process.env.JEROC_TEST_DATABASE_URL }), JEROC_APPLICATION_DB_PATH: ':memory:' };
  const envA = { ...base, JEROC_TENANT_ID: 'notification-company-a' }, envB = { ...base, JEROC_TENANT_ID: 'notification-company-b' };
  const a = createChangeEvents({ env: envA }), secondA = createChangeEvents({ env: envA }), b = createChangeEvents({ env: envB });
  const seenA = [], seenB = [];
  secondA.subscribe(value => seenA.push(value)); b.subscribe(value => seenB.push(value));
  try {
    await Promise.all([a.ready(), secondA.ready(), b.ready()]);
    await a.publish({ domain: 'application', revision: 1, eventId: 'only-a' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(seenA.map(value => value.eventId), ['only-a']); assert.deepEqual(seenB, []);
    await b.publish({ domain: 'application', revision: 1, eventId: 'only-b' });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual(seenA.map(value => value.eventId), ['only-a']); assert.deepEqual(seenB.map(value => value.eventId), ['only-b']);
    assert.equal(changeEventChannel({ JEROC_TENANT_ID: 'jeroc-demo' }), 'jeroc_changes');
    assert.notEqual(changeEventChannel(envA), changeEventChannel(envB));
  } finally { await Promise.all([a.close(), secondA.close(), b.close()]); }
});
