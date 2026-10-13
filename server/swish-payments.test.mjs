import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createSwishPayments } from './swish-payments.mjs';

const CARD_ID = 2053, SSN = '197709306828', PHONE = '+46711111132', MERCHANT = '1234679304';
const context = {
  organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'swish-fixture',
  actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' },
};
const details = () => ({ method: 'swish', phone: PHONE, recipient: 'Erik Johansson', personalNumber: SSN });
const booked = () => ({ status: 'booked', companyId: 'sandbox-company-123', generation: 'connection-a',
  invoiceId: 'f5b80286-13fb-4dfe-b16d-e885b01aa27e', draftId: '8cba9df5-bd89-4bc4-811c-cdb7a1961fd3' });
const amountFailure = (field = 'TotalAmount', valueType = 'string') => Object.assign(new Error('Spiris-beloppet har fel format.'), {
  code: 'accounting_amount_invalid', status: 409, details: { provider: 'spiris', field, valueType, rawValue: 'DO-NOT-EXPOSE', token: 'SECRET' },
});

async function fixture(run, hooks = {}) {
  const state = initialApplicationState();
  const customer = state.office.customers.find(value => value.id === 'customer-erik');
  Object.assign(customer, { type: 'Privatperson', number: SSN, phone: PHONE });
  const card = state.office.cards.find(value => value.id === CARD_ID);
  Object.assign(card, {
    status: 'ready', siteId: 'norrtalje', customerId: customer.id, origin: 'Testgatan 1, 761 41 Norrtälje', reference: 'Swish fixture',
    payment: 'Swish', paymentDetails: { method: 'swish', phone: PHONE, recipient: customer.name },
    pricingSnapshotId: 'swish-frozen-pricing', pricingTotal: 100, financialPending: false, pricingRowsPending: false,
    rows: [{ articleId: 'copper-1', weight: 1, price: 100, tier: 'C' }],
    customerApproval: { id: 'swish-attested-approval', version: 1, status: 'attested' },
  });
  const snapshot = {
    hash: 'swish-frozen-hash', card: structuredClone(card), customer: structuredClone(customer),
    rows: [{ articleId: 'copper-1', name: 'Koppar klass 1', weight: 1, price: 100, amount: 100 }],
    gross: 100, net: 100, offset: 0,
  };
  const approval = {
    id: 'swish-attested-approval', cardId: CARD_ID, version: 1, status: 'attested', snapshot,
    approvedAt: '2026-10-13T08:00:00Z', attestedAt: '2026-10-13T08:01:00Z', attestedBy: 'admin',
    approvedHash: snapshot.hash, approvedMethod: 'id',
  };
  const repository = await createApplicationRepository({ env: {}, filename: ':memory:', seed: () => state });
  let timestamp = new Date('2026-10-13T09:00:00Z');
  const calls = [], payloads = new Map(), bookkeeping = [];
  const successful = (payload, status = 'PAID') => ({
    ok: true, statusCode: status === 'PAID' ? 200 : 201, environment: 'mss', uncertain: false,
    data: { ...structuredClone(payload), status, paymentReference: '9559320588048323', datePaid: '2026-10-13T08:59:59Z' },
  });
  const client = {
    configurationStatus: hooks.configurationStatus ?? (async () => ({ ready: true, mode: 'mss', merchantAlias: MERCHANT, issues: [], missing: [] })),
    async createPayout(payload) {
      calls.push({ method: 'POST', id: payload.payoutInstructionUUID });
      payloads.set(payload.payoutInstructionUUID, structuredClone(payload));
      return hooks.create ? hooks.create(payload, successful) : successful(payload, 'CREATED');
    },
    async getPayout(id) {
      calls.push({ method: 'GET', id });
      const payload = payloads.get(id);
      assert.ok(payload, 'Every status lookup must use an already reserved provider instruction');
      return hooks.read ? hooks.read(payload, successful) : successful(payload);
    },
  };
  function service() {
    return createSwishPayments({
      getRepository: async () => repository, sourceProvider: async () => [structuredClone(approval)], client, env: {}, now: () => timestamp,
      onPrepared: hooks.onPrepared,
      onPaymentConfirmed: hooks.onPaymentConfirmed,
      assertPaymentReady: hooks.assertPaymentReady ?? (async () => booked()),
      onVerifiedPayment: async job => {
        bookkeeping.push(structuredClone(job));
        return hooks.onVerifiedPayment ? hooks.onVerifiedPayment(job) : { status: 'registered', paymentId: 'spiris-sandbox-payment' };
      },
    });
  }
  const payments = service();
  await payments.saveSettings({ enabled: true, registerSpirisPayment: true }, context);
  const input = overrides => ({
    cardId: CARD_ID, source: { approvalId: approval.id, version: approval.version, hash: snapshot.hash }, paymentDetails: details(), ...overrides,
  });
  try {
    await run({ payments, repository, approval, snapshot, calls, bookkeeping, input, service,
      advance: milliseconds => { timestamp = new Date(timestamp.getTime() + milliseconds); } });
  } finally { await repository.close(); }
}

test('Spiris settings preserve opaque company identifiers through a verified payout and reject invalid bank accounts', async () => fixture(async f => {
  const companyId = 'sandbox-company-123', bankAccountId = 'bba9d9b5-19f6-4a23-b546-3e79a3360d18';
  const saved = await f.payments.saveSettings({ enabled: true, bookkeepingEnabled: true,
    spirisCompanyId: companyId, spirisBankAccountId: bankAccountId }, context);
  assert.equal(saved.settings.spirisCompanyId, companyId);
  assert.equal(saved.settings.spirisBankAccountId, bankAccountId);
  for (const patch of [{ spirisCompanyId: '   ' }, { spirisCompanyId: 123 }, { spirisBankAccountId: '1930' }]) {
    await assert.rejects(() => f.payments.saveSettings({ enabled: true, bookkeepingEnabled: true,
      spirisCompanyId: companyId, spirisBankAccountId: bankAccountId, ...patch }, context), error => error.status === 422);
  }
  assert.equal((await f.payments.settings(context)).settings.revision, saved.settings.revision);
  const job = await f.payments.start(f.input(), context);
  await f.payments.processQueuedPayments(); f.advance(5000); await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(job.id, context)).status, 'simulated_paid');
  assert.equal(f.bookkeeping.length, 1);
  assert.equal(f.bookkeeping[0].spirisCompanyId, companyId);
  assert.equal(f.bookkeeping[0].spirisBankAccountId, bankAccountId);
}));

test('an unbooked Spiris invoice blocks preparation and direct payout before reserving any Swish instruction', async () => fixture(async f => {
  const preparation = await f.payments.prepare(CARD_ID, context);
  assert.equal(preparation.canStart, false); assert.equal(preparation.canInitiate, false);
  assert.ok(preparation.issues.includes('Bokför underlaget i Spiris före utbetalning.'));
  await assert.rejects(() => f.payments.start(f.input(), context), error => error.code === 'swish_invoice_unbooked');
  assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 0); assert.equal(f.calls.length, 0);
}, { assertPaymentReady: async () => { throw Object.assign(new Error('Bokför underlaget i Spiris före utbetalning.'), { code: 'swish_invoice_unbooked', status: 409 }); } }));

test('a changed or disconnected booked invoice is rechecked before dispatch and cannot reach Swish', async () => fixture(async f => {
  const job = await f.payments.start(f.input(), context);
  await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(job.id, context)).status, 'blocked'); assert.equal(f.calls.length, 0);
}, { assertPaymentReady: async (_source, { fresh }) => ({ status: 'booked', companyId: 'sandbox-company-123',
  generation: fresh ? 'reconnected-company' : 'connection-a', invoiceId: 'f5b80286-13fb-4dfe-b16d-e885b01aa27e', draftId: '8cba9df5-bd89-4bc4-811c-cdb7a1961fd3' }) }));

test('a failed paid-PDF archive retries separately without another payout or payment registration', async () => {
  let attempts = 0;
  await fixture(async f => {
    const job = await f.payments.start(f.input(), context); await f.payments.processQueuedPayments(); f.advance(5000); await f.payments.processQueuedPayments();
    let paid = await f.payments.job(job.id, context);
    assert.equal(paid.status, 'simulated_paid'); assert.equal(paid.paymentDocumentStatus, 'failed');
    assert.equal(paid.bookkeepingStatus, 'registered'); assert.equal(f.bookkeeping.length, 1);
    f.advance(61000); await f.payments.processQueuedPayments(); paid = await f.payments.job(job.id, context);
    assert.equal(paid.paymentDocumentStatus, 'archived'); assert.equal(paid.paymentConfirmationDocument.documentId, 'paid-pdf');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.bookkeeping.length, 1);
    await f.payments.refresh(job.id, context); assert.equal(attempts, 2);
  }, { onPaymentConfirmed: async job => {
    assert.equal(job.providerResult.status, 'PAID'); assert.ok(job.verifiedAt);
    if (++attempts === 1) throw new Error('Document archive temporarily unavailable');
    return { documentId: 'paid-pdf', version: 2, document: { id: 'paid-pdf', paymentConfirmation: true } };
  } });
});

test('concurrent reservations and workers send exactly one Swish instruction for one frozen attest version', async () => fixture(async f => {
  const preview = await f.payments.prepare(CARD_ID, context);
  assert.equal(preview.canStart, true, preview.issues.join('; '));
  assert.equal(preview.amountCents, 10000);
  const secondWorker = f.service();
  const jobs = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? secondWorker : f.payments).start(f.input(), context)));
  assert.equal(new Set(jobs.map(job => job.id)).size, 1);
  assert.equal(f.calls.length, 0, 'Reserving an instruction must not perform provider I/O');
  await Promise.all([f.payments.processQueuedPayments(), secondWorker.processQueuedPayments()]);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  f.advance(5000);
  await secondWorker.processQueuedPayments();
  assert.equal((await f.payments.job(jobs[0].id, context)).status, 'simulated_paid');
  assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 1);
  await assert.rejects(() => f.payments.assertNoManagedPayment(CARD_ID), error => error.code === 'swish_payment_reserved');
}));

test('an unknown POST result survives restart and recovers only by GET of the original UUID', async () => fixture(async f => {
  const original = await f.payments.start(f.input(), context);
  await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(original.id, context)).status, 'unknown');
  assert.equal(f.bookkeeping.length, 0);
  const restarted = f.service();
  assert.equal((await restarted.start(f.input(), context)).id, original.id);
  f.advance(31000);
  await restarted.processQueuedPayments();
  assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET']);
  assert.ok(f.calls.every(call => call.id === original.providerInstructionUUID));
  assert.equal((await restarted.job(original.id, context)).status, 'simulated_paid');
}, { create: () => ({ ok: false, uncertain: true, environment: 'mss', error: { code: 'SWISH_TIMEOUT', message: 'Timeout after dispatch' } }) }));

test('recipient overrides require a reason and remain separate from the immutable card and approval', async () => fixture(async f => {
  const officeBefore = await f.repository.read(state => structuredClone(state.office.cards.find(card => card.id === CARD_ID)));
  const snapshotBefore = structuredClone(f.snapshot);
  const paymentDetails = { ...details(), phone: '+46701234567', recipient: 'Authorized alternate recipient' };
  await assert.rejects(() => f.payments.start(f.input({ paymentDetails }), context), error => error.code === 'swish_override_reason_required');
  assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 0);
  const job = await f.payments.start(f.input({ paymentDetails, reason: 'Customer confirmed corrected Swish number' }), context);
  assert.equal(job.paymentDetails.phone, paymentDetails.phone);
  assert.equal(job.originalPaymentDetails.phone, PHONE);
  assert.equal(job.amountCents, 10000);
  assert.ok(job.events.some(event => event.action === 'payment_details_overridden' && event.reason === job.reason));
  assert.deepEqual(f.snapshot, snapshotBefore);
  assert.deepEqual(await f.repository.read(state => state.office.cards.find(card => card.id === CARD_ID)), officeBefore);
  await assert.rejects(() => f.payments.start(f.input({ amount: 1 }), context), error => error.status === 422);
}));

test('fresh permissions and facility scope are enforced at start and again before queued dispatch', async () => fixture(async f => {
  await f.repository.transact(state => {
    Object.assign(state.pricing.users.find(user => user.id === 'admin'), { level: 'Medarbetare', permissions: [], siteIds: ['norrtalje'] });
  });
  await assert.rejects(() => f.payments.start(f.input(), context), error => error.status === 403);
  await f.repository.transact(state => {
    Object.assign(state.pricing.users.find(user => user.id === 'admin'), { permissions: ['pay'], siteIds: ['rimbo'] });
  });
  await assert.rejects(() => f.payments.start(f.input(), context), error => error.code === 'swish_site_forbidden');
  await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'admin').siteIds = ['norrtalje']; });
  const job = await f.payments.start(f.input(), context);
  await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'admin').permissions = []; });
  await f.payments.processQueuedPayments();
  assert.equal(f.calls.length, 0);
  await f.repository.transact(state => { state.pricing.users.find(user => user.id === 'admin').permissions = ['pay']; });
  assert.equal((await f.payments.job(job.id, context)).status, 'blocked');
}));

test('a different tenant cannot read, refresh or reserve payments in this tenant journal', async () => fixture(async f => {
  const job = await f.payments.start(f.input(), context), foreign = { ...context, organisationId: 'another-company' };
  for (const action of [
    () => f.payments.job(job.id, foreign), () => f.payments.refresh(job.id, foreign),
    () => f.payments.getCardJobs(CARD_ID, foreign), () => f.payments.start(f.input(), foreign),
  ]) await assert.rejects(action, error => error.status === 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 1);
}));

test('a PAID response with mismatched amount or recipient never confirms payout or triggers Spiris', async () => {
  for (const mismatch of [{ amount: '100.01' }, { payeeAlias: '46700000000' }, { payeeSSN: '197709306829' }, { payerPaymentReference: 'another-payment' }]) {
    await fixture(async f => {
      const job = await f.payments.start(f.input(), context);
      await f.payments.processQueuedPayments(); f.advance(5000);
      await f.payments.processQueuedPayments();
      const result = await f.payments.job(job.id, context);
      assert.equal(result.status, 'unknown');
      assert.equal(result.error.code, 'SWISH_RESPONSE_MISMATCH');
      assert.equal(await f.payments.readVerifiedPayment(job.id), null);
      assert.equal(f.bookkeeping.length, 0);
      assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    }, { read: (payload, successful) => ({ ...successful(payload), data: { ...successful(payload).data, ...mismatch } }) });
  }
});

test('bookkeeping runs only after verified PAID, once, while MSS leaves the real payment ledger untouched', async () => fixture(async f => {
  const before = await f.repository.read(state => ({ card: structuredClone(state.office.cards.find(card => card.id === CARD_ID)), payments: structuredClone(state.office.payments) }));
  const job = await f.payments.start(f.input(), context);
  assert.equal(await f.payments.readVerifiedPayment(job.id), null);
  await f.payments.processQueuedPayments();
  assert.equal(f.bookkeeping.length, 0, 'CREATED means accepted, not paid');
  f.advance(5000); await f.payments.processQueuedPayments();
  assert.equal(f.bookkeeping.length, 1);
  assert.equal(f.bookkeeping[0].status, 'simulated_paid');
  assert.equal(f.bookkeeping[0].providerResult.status, 'PAID');
  assert.equal(f.bookkeeping[0].providerResult.amount, '100.00');
  assert.equal((await f.payments.readVerifiedPayment(job.id)).providerInstructionUUID, job.providerInstructionUUID);
  const result = await f.payments.refresh(job.id, context);
  assert.equal(result.bookkeepingStatus, 'registered');
  await f.payments.processQueuedPayments();
  assert.equal(f.bookkeeping.length, 1);
  assert.deepEqual(await f.repository.read(state => ({ card: state.office.cards.find(card => card.id === CARD_ID), payments: state.office.payments })), before);
}));

test('a failed payment-document archive blocks provider dispatch', async () => fixture(async f => {
  const job = await f.payments.start(f.input(), context);
  await f.payments.processQueuedPayments();
  const result = await f.payments.job(job.id, context);
  assert.equal(result.status, 'blocked');
  assert.match(result.error.message, /archive unavailable/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.bookkeeping.length, 0);
}, { onPrepared: async () => { throw new Error('Payment archive unavailable'); } }));

test('bank mapping and the customer identity cannot be changed from a payment confirmation', async () => fixture(async f => {
  await assert.rejects(() => f.payments.start(f.input({ spirisBankAccountId: '65b0216d-f99b-45c2-8785-18367dece467' }), context), error => error.status === 422);
  await assert.rejects(() => f.payments.start(f.input({ paymentDetails: { ...details(), personalNumber: '199001012398' }, reason: 'Another identity' }), context),
    error => ['swish_recipient_identity_changed', 'swish_personal_number_invalid'].includes(error.code));
  assert.equal(f.calls.length, 0);
  assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 0);
}));

test('bookkeeping requires explicit opt-in and a successful simulation does not poll an unrequested Spiris payment', async () => fixture(async f => {
  await f.payments.saveSettings({ enabled: true, bookkeepingEnabled: false }, context);
  const job = await f.payments.start(f.input(), context);
  assert.equal(job.bookkeepingStatus, 'not_requested');
  await f.payments.processQueuedPayments(); f.advance(5000); await f.payments.processQueuedPayments();
  const done = await f.payments.job(job.id, context);
  assert.equal(done.status, 'simulated_paid'); assert.equal(done.bookkeepingStatus, 'not_requested');
  assert.equal(f.bookkeeping.length, 0); assert.equal(await f.payments.processQueuedPayments(), 0);
}));

test('unknown outcomes eventually pause polling, yet manual reconciliation still uses the original UUID', async () => fixture(async f => {
  const job = await f.payments.start(f.input(), context);
  await f.payments.processQueuedPayments();
  for (let index = 0; index < 8; index++) { f.advance(31000); await f.payments.processQueuedPayments(); }
  const paused = await f.payments.job(job.id, context);
  assert.equal(paused.status, 'unknown'); assert.equal(paused.pollSuspended, true);
  const count = f.calls.length; f.advance(31000); assert.equal(await f.payments.processQueuedPayments(), 0); assert.equal(f.calls.length, count);
  await f.payments.refresh(job.id, context);
  assert.equal(f.calls.length, count + 1); assert.equal(f.calls.at(-1).method, 'GET');
  assert.ok(f.calls.every(call => call.id === job.providerInstructionUUID));
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
}, { create: () => ({ ok: false, uncertain: true, environment: 'mss', error: { code: 'SWISH_TIMEOUT', message: 'Lost response' } }),
  read: () => ({ ok: false, statusCode: 404, uncertain: true, environment: 'mss', error: { code: 'SWISH_NOT_FOUND', message: 'Cannot prove non-execution' } }) }));

test('the integration catalog does not download certificates or invoke the transport', async () => fixture(async f => {
  const status = await f.payments.integrationStatus();
  assert.equal(status.connected, false); assert.equal(f.calls.length, 0);
  assert.equal(status.mode, 'disabled', 'A ready mocked client cannot fabricate a live provider connection');
}));

test('a changed attest proof during PDF generation blocks the reserved payout before provider dispatch', async () => {
  let change;
  await fixture(async f => {
    change = () => { f.approval.version = 2; };
    const job = await f.payments.start(f.input(), context);
    await f.payments.processQueuedPayments();
    const result = await f.payments.job(job.id, context);
    assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'swish_source_changed');
    assert.equal(f.calls.length, 0); assert.equal(f.bookkeeping.length, 0);
  }, { onPrepared: async () => { change(); return { documentId: 'archived-payment-revision', version: 2 }; } });
});

test('blocked refresh rereads Spiris diagnostics without sending or replacing the reserved instruction', async () => {
  let failure = amountFailure(), freshReads = 0;
  await fixture(async f => {
    const original = await f.payments.start(f.input(), context);
    await f.payments.refresh(original.id, context);
    assert.equal(f.calls.length, 0, 'A status refresh must not dispatch even a queued instruction');
    await f.payments.processQueuedPayments();
    let job = await f.payments.job(original.id, context);
    assert.equal(job.status, 'blocked'); assert.equal(job.canResume, false);
    assert.deepEqual(job.error.details, { provider: 'spiris', field: 'TotalAmount', valueType: 'string' });
    assert.deepEqual(job.events.at(-1).error, job.error);
    failure = amountFailure('Rows[2].DebetAmount', 'number');
    job = await f.payments.refresh(original.id, context);
    assert.equal(freshReads, 2); assert.equal(job.status, 'blocked'); assert.equal(job.preflightStatus, 'blocked');
    assert.equal(job.canResume, false); assert.equal(job.id, original.id);
    assert.equal(job.providerInstructionUUID, original.providerInstructionUUID);
    assert.deepEqual(job.request, original.request);
    assert.deepEqual(job.error.details, { provider: 'spiris', field: 'Rows[2].DebetAmount', valueType: 'number' });
    assert.ok(!JSON.stringify(job).includes('DO-NOT-EXPOSE')); assert.ok(!JSON.stringify(job).includes('SECRET'));
    await assert.rejects(() => f.payments.resume(original.id, context), error => error.code === 'swish_resume_forbidden');
    assert.equal(await f.payments.processQueuedPayments(), 0); assert.equal(f.calls.length, 0);
    assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 1);
  }, { assertPaymentReady: async (_source, { fresh }) => { if (fresh) { freshReads++; throw failure; } return booked(); } });
});

test('corrected preflight stays blocked until explicit idempotent resume queues the same instruction', async () => {
  let corrected = false, freshReads = 0;
  await fixture(async f => {
    const original = await f.payments.start(f.input(), context);
    await f.payments.processQueuedPayments(); corrected = true;
    const checked = await f.payments.refresh(original.id, context);
    assert.equal(checked.status, 'blocked'); assert.equal(checked.preflightStatus, 'ready'); assert.equal(checked.canResume, true);
    assert.equal(f.calls.length, 0); assert.equal(await f.payments.processQueuedPayments(), 0);
    const otherWorker = f.service();
    const resumed = await Promise.all([f.payments.resume(original.id, context), otherWorker.resume(original.id, context)]);
    assert.ok(resumed.every(item => item.status === 'queued' && item.id === original.id && item.providerInstructionUUID === original.providerInstructionUUID));
    assert.equal(freshReads, 4, 'Dispatch, refresh and both explicit resume requests each verify current booking');
    assert.equal(f.calls.length, 0, 'Resume only changes the queue, never invokes the Swish client');
    assert.equal((await f.payments.resume(original.id, context)).id, original.id);
    const stored = await f.repository.read(state => structuredClone(state.swishPayments.jobs[original.id]));
    assert.equal(stored.events.filter(item => item.action === 'payment_resumed').length, 1);
    assert.equal(stored.preflightStatus, undefined); assert.equal(stored.error, null);
    for (const key of ['source', 'sourceSnapshot', 'amount', 'amountCents', 'currency', 'recipient', 'bookingProof', 'request'])
      assert.deepEqual(stored[key], original[key], `${key} remains immutable`);
    assert.ok(stored.events.some(item => item.action === 'payment_resumed'
      && item.actualUserId === context.actorId && item.effectiveUserId === context.effectiveUserId));
    await Promise.all([f.payments.processQueuedPayments(), otherWorker.processQueuedPayments()]);
    assert.deepEqual(f.calls.map(call => call.method), ['POST']);
    await assert.rejects(() => f.payments.resume(original.id, context), error => error.code === 'swish_resume_forbidden');
    f.advance(5000); await otherWorker.processQueuedPayments();
    assert.equal((await f.payments.job(original.id, context)).status, 'simulated_paid');
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal((await f.payments.getCardJobs(CARD_ID, context)).length, 1);
  }, { assertPaymentReady: async (_source, { fresh }) => {
    if (fresh) { freshReads++; if (!corrected) throw amountFailure(); } return booked();
  } });
});

test('resume rechecks a ready blocked job and refuses a changed booking connection or invoice', async () => {
  for (const changed of [{ generation: 'connection-b' }, { invoiceId: 'f9f62c7c-89a2-41d9-a3c8-7f127cc44a18' }]) {
    let current = 'failure';
    await fixture(async f => {
      const original = await f.payments.start(f.input(), context); await f.payments.processQueuedPayments();
      current = 'ready'; assert.equal((await f.payments.refresh(original.id, context)).canResume, true);
      current = 'changed';
      await assert.rejects(() => f.payments.resume(original.id, context), error => error.code === 'swish_booking_changed');
      const saved = await f.payments.job(original.id, context);
      assert.equal(saved.status, 'blocked'); assert.equal(saved.canResume, false); assert.equal(saved.preflightStatus, 'blocked');
      assert.deepEqual(saved.bookingProof, original.bookingProof); assert.equal(f.calls.length, 0);
    }, { assertPaymentReady: async (_source, { fresh }) => {
      if (!fresh) return booked(); if (current === 'failure') throw amountFailure();
      return { ...booked(), ...(current === 'changed' ? changed : {}) };
    } });
  }
});

test('source, recipient instruction and payment settings changes keep blocked recovery from sending', async () => {
  const changes = [
    { code: 'swish_source_changed', mutate: async f => { f.approval.version++; } },
    { code: 'swish_source_changed', mutate: async f => { f.snapshot.net = 99; f.snapshot.gross = 99; } },
    { code: 'swish_source_changed', mutate: async f => f.repository.transact(state => { state.office.cards.find(card => card.id === CARD_ID).rows[0].weight = 2; }) },
    { code: 'swish_instruction_changed', mutate: async (f, id) => f.repository.transact(state => { state.swishPayments.jobs[id].request.payload.payeeAlias = '46700000000'; }) },
    { code: 'swish_settings_changed', mutate: async f => f.payments.saveSettings({ enabled: true, bookkeepingEnabled: false }, context) },
    { code: 'swish_disabled', mutate: async f => f.payments.saveSettings({ enabled: false, bookkeepingEnabled: true }, context) },
  ];
  for (const { code, mutate } of changes) {
    let corrected = false;
    await fixture(async f => {
      const original = await f.payments.start(f.input(), context); await f.payments.processQueuedPayments(); corrected = true;
      await mutate(f, original.id);
      const checked = await f.payments.refresh(original.id, context);
      assert.equal(checked.status, 'blocked'); assert.equal(checked.canResume, false); assert.equal(checked.error.code, code);
      await assert.rejects(() => f.payments.resume(original.id, context), error => error.code === 'swish_resume_forbidden');
      assert.equal(f.calls.length, 0);
    }, { assertPaymentReady: async (_source, { fresh }) => { if (fresh && !corrected) throw amountFailure(); return booked(); } });
  }
});

test('a privileged caller cannot resume an instruction after its original payment permission is revoked', async () => {
  let corrected = false;
  await fixture(async f => {
    const original = await f.payments.start(f.input(), context); await f.payments.processQueuedPayments(); corrected = true;
    await f.repository.transact(state => {
      const admin = state.pricing.users.find(user => user.id === 'admin');
      state.pricing.users.push({ ...structuredClone(admin), id: 'recovery-admin' });
      Object.assign(admin, { level: 'Medarbetare', permissions: [] });
    });
    const recoveryContext = { ...context, actorId: 'recovery-admin', effectiveUserId: 'recovery-admin' };
    const checked = await f.payments.refresh(original.id, recoveryContext);
    assert.equal(checked.status, 'blocked'); assert.equal(checked.canResume, false); assert.equal(checked.error.code, 'swish_forbidden');
    await assert.rejects(() => f.payments.resume(original.id, recoveryContext), error => error.code === 'swish_resume_forbidden');
    await assert.rejects(() => f.payments.refresh(original.id, context), error => error.status === 403);
    assert.equal(f.calls.length, 0);
  }, { assertPaymentReady: async (_source, { fresh }) => { if (fresh && !corrected) throw amountFailure(); return booked(); } });
});

test('sent evidence, active leases and uncertain or paid statuses can never become resumable', async () => {
  const patches = [
    { sentAt: '2026-10-13T08:59:59Z' }, { response: { method: 'POST', httpStatus: null } },
    { verifiedAt: '2026-10-13T08:59:59Z' }, { events: [{ action: 'payment_sent' }] },
    { lease: { id: 'other-worker', expiresAt: '2026-10-13T10:00:00Z' } },
    { status: 'unknown' }, { status: 'pending' }, { status: 'simulated_paid' },
  ];
  for (const patch of patches) await fixture(async f => {
    const original = await f.payments.start(f.input(), context);
    await f.repository.transact(state => Object.assign(state.swishPayments.jobs[original.id], { status: 'blocked', preflightStatus: 'ready' }, patch));
    await assert.rejects(() => f.payments.resume(original.id, context), error => error.code === 'swish_resume_forbidden');
    if (!patch.status) {
      const checked = await f.payments.refresh(original.id, context);
      assert.equal(checked.status, 'blocked'); assert.equal(checked.canResume, false);
    }
    assert.equal(f.calls.length, 0);
  });
});

test('the worker rechecks a resumed instruction before dispatch after another settings change', async () => {
  let corrected = false;
  await fixture(async f => {
    const original = await f.payments.start(f.input(), context); await f.payments.processQueuedPayments(); corrected = true;
    await f.payments.refresh(original.id, context); await f.payments.resume(original.id, context);
    await f.payments.saveSettings({ enabled: true, bookkeepingEnabled: false }, context);
    await f.payments.processQueuedPayments();
    const saved = await f.payments.job(original.id, context);
    assert.equal(saved.status, 'blocked'); assert.equal(saved.error.code, 'swish_settings_changed'); assert.equal(f.calls.length, 0);
  }, { assertPaymentReady: async (_source, { fresh }) => { if (fresh && !corrected) throw amountFailure(); return booked(); } });
});

for (const bankOriginal of [
  { method: 'bank', bankType: 'iban', iban: 'SE45 5000 0000 0583 9825 7466', bic: 'essessex', bankCountry: 'se', holder: 'Erik Johansson' },
  { method: 'bank', bankType: 'bankgiro', bankgiro: '123-4566', holder: 'Erik Johansson' },
  { method: 'bank', bankType: 'plusgiro', plusgiro: '12345-5', holder: 'Erik Johansson' },
]) test(`typed ${bankOriginal.bankType} original survives a reasoned Swish override without changing the frozen source`, async () => fixture(async f => {
  f.approval.snapshot.card.paymentDetails = structuredClone(bankOriginal);
  await f.repository.transact(state => { state.office.cards.find(card => card.id === CARD_ID).paymentDetails = structuredClone(bankOriginal); });
  const originalSnapshot = structuredClone(f.approval.snapshot);
  const preparation = await f.payments.prepare(CARD_ID, context);
  assert.equal(preparation.originalPaymentDetails.bankType, bankOriginal.bankType);
  assert.equal(preparation.canInitiate, true); assert.equal(preparation.canStart, false);
  await assert.rejects(() => f.payments.start(f.input(), context), error => error.code === 'swish_override_reason_required');
  const item = await f.payments.start(f.input({ reason: 'Kunden bekräftade Swish istället.' }), context);
  assert.equal(item.originalPaymentDetails.bankType, bankOriginal.bankType);
  if (bankOriginal.bankType === 'iban') {
    assert.equal(item.originalPaymentDetails.iban, 'SE4550000000058398257466'); assert.equal(item.originalPaymentDetails.bic, 'ESSESSEX');
  } else assert.equal(item.originalPaymentDetails[bankOriginal.bankType], bankOriginal[bankOriginal.bankType].replaceAll('-', ''));
  assert.equal(item.paymentDetails.method, 'swish'); assert.equal(item.sourceSnapshotHash, originalSnapshot.hash);
  assert.deepEqual(item.sourceSnapshot, originalSnapshot);
  assert.deepEqual(await f.repository.read(state => state.office.cards.find(card => card.id === CARD_ID).paymentDetails), bankOriginal);
  await f.payments.processQueuedPayments(); f.advance(5000); await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(item.id, context)).status, 'simulated_paid');
}));

test('pre-109 bank originals keep exactly their old normalization and frozen source bytes', async () => fixture(async f => {
  const legacy = { method: 'bank', bank: '  Demobank  ', clearing: '83-27', account: '123 4567 890', holder: 'Erik Johansson' };
  f.approval.snapshot.card.paymentDetails = structuredClone(legacy);
  await f.repository.transact(state => { state.office.cards.find(card => card.id === CARD_ID).paymentDetails = structuredClone(legacy); });
  const frozen = structuredClone(f.approval.snapshot);
  const item = await f.payments.start(f.input({ reason: 'Kunden valde Swish.' }), context);
  assert.deepEqual(item.originalPaymentDetails, legacy); assert.deepEqual(item.sourceSnapshot, frozen);
  const before = await f.repository.read(state => structuredClone(state.swishPayments.jobs[item.id]));
  await f.payments.refresh(item.id, context);
  const after = await f.repository.read(state => structuredClone(state.swishPayments.jobs[item.id]));
  assert.equal(after.instructionHash, before.instructionHash);
  assert.deepEqual(after.originalPaymentDetails, before.originalPaymentDetails); assert.deepEqual(after.sourceSnapshot, before.sourceSnapshot);
}));
