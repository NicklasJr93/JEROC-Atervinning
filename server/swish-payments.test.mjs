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
    configurationStatus: async () => ({ ready: true, mode: 'mss', merchantAlias: MERCHANT, issues: [], missing: [] }),
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
      assertPaymentReady: hooks.assertPaymentReady ?? (async () => ({ status: 'booked', companyId: 'sandbox-company-123',
        generation: 'connection-a', invoiceId: 'f5b80286-13fb-4dfe-b16d-e885b01aa27e', draftId: '8cba9df5-bd89-4bc4-811c-cdb7a1961fd3' })),
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
