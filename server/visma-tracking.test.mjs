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

const trackedDraft = {
  draftId: 'c20331af-a5a9-44ff-baaa-08866177c185', supplierId: '1831c176-4020-4a9c-9fe5-1f8b2fdb0d91',
  draft: { InvoiceNumber: 'AV-3024-V1', TotalAmount: 4500, CurrencyCode: 'SEK' },
};
const finalInvoice = {
  Id: 'c69ef321-0657-49d6-94d8-66d1f5963c30', CreatedFromDraftId: trackedDraft.draftId, SupplierId: trackedDraft.supplierId,
  InvoiceNumber: 'AV-3024-V1', TotalAmount: 4500, CurrencyCode: 'SEK', Status: 1,
  VoucherId: '22222222-4020-4a9c-9fe5-1f8b2fdb0d91', VoucherNumber: 'A28',
};
const invoicePage = (invoices, total = invoices.length) => ({ Data: invoices,
  Meta: { CurrentPage: 1, TotalNumberOfPages: 1, TotalNumberOfResults: total } });

// A missing converted draft is a lookup trigger, never bookkeeping evidence.
test('HTTP 400 with numeric ResourceNotFound 3000 checks and verifies the corresponding final invoice', async () => {
  const { observeSpirisDraft } = await import('./visma-tracking.mjs'), calls = [];
  const result = await observeSpirisDraft(trackedDraft, async request => {
    calls.push(request.operation); assert.equal(request.payload, undefined);
    if (request.operation === 'draft') return { status: 'rejected', httpStatus: 400, response: { ErrorCode: 3000, DeveloperErrorMessage: 'SupplierInvoiceNotFound' } };
    return { status: 'accepted', httpStatus: 200, response: request.operation === 'invoices' ? invoicePage([finalInvoice]) : finalInvoice };
  });
  assert.deepEqual(calls, ['draft', 'invoices', 'invoice']); assert.equal(result.kind, 'booked'); assert.equal(result.voucherNumber, 'A28');
});

test('ResourceNotFound 400 requires a complete final-invoice search before absence can be observed', async () => {
  const { observeSpirisDraft } = await import('./visma-tracking.mjs');
  for (const total of [0, 1]) {
    const observation = () => observeSpirisDraft(trackedDraft, async request => request.operation === 'draft'
      ? { status: 'rejected', httpStatus: 400, response: { ErrorCode: 3000 } }
      : { status: 'accepted', httpStatus: 200, response: invoicePage([], total) });
    if (total === 0) assert.equal((await observation()).kind, 'missing');
    else await assert.rejects(observation, error => error.code === 'visma_tracking_incomplete');
  }
});

test('other draft failures never trigger final-invoice lookup and diagnostic keeps only status and numeric code', async () => {
  const { observeSpirisDraft } = await import('./visma-tracking.mjs');
  for (const [httpStatus, ErrorCode] of [[400, 2000], [400, '3000'], [401, 3000], [403, 3000], [429, 3000], [500, 3000], [null, 3000]]) {
    const calls = [];
    await assert.rejects(() => observeSpirisDraft(trackedDraft, async request => {
      calls.push(request.operation); return { status: 'rejected', httpStatus, response: { ErrorCode, DeveloperErrorMessage: 'PRIVATE_PROVIDER_MESSAGE', secret: 'PRIVATE_PROVIDER_SECRET' } };
    }), error => {
      assert.equal(error.providerHttpStatus, httpStatus);
      assert.equal(error.providerErrorCode, typeof ErrorCode === 'number' ? ErrorCode : undefined);
      assert.equal(JSON.stringify(error).includes('PRIVATE_PROVIDER'), false);
      return error.code === ([401, 403].includes(httpStatus) ? 'visma_tracking_access' : 'visma_tracking_unavailable');
    });
    assert.deepEqual(calls, ['draft']);
  }
});
