import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialTracking, trackingInterval, publicSpirisEvents } from './visma-tracking.mjs';

test('tracking slows after a day and a week, and the configured lifetime has an explicit endpoint', () => {
  const job = { id: 'example', createdAt: '2026-10-12T09:00:00.000Z', finishedAt: '2026-10-12T10:00:00.000Z' };
  assert.equal(trackingInterval(job, new Date('2026-10-13T09:59:59Z')), 5);
  assert.equal(trackingInterval(job, new Date('2026-10-13T10:00:00Z')), 60);
  assert.equal(trackingInterval(job, new Date('2026-10-19T10:00:00Z')), 1440);
  const tracking = initialTracking(job, 2);
  assert.equal(tracking.deadlineAt, '2026-10-14T10:00:00.000Z');
  assert.equal(tracking.nextCheckAt, '2026-10-12T10:05:00.000Z');
});

test('legacy event identities are stable on repeated reads and do not mutate their historical source', () => {
  const job = { id: 'example', events: [{ at: '2026-10-12T10:00:00Z', text: 'Historical source' }] };
  assert.deepEqual(publicSpirisEvents(job), publicSpirisEvents(job)); assert.equal(publicSpirisEvents(job)[0].id, 'example:legacy:0');
  assert.equal(job.events[0].id, undefined);
});
