import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationRepository } from './application-storage.mjs';
import { createVismaPayments } from './visma-payments.mjs';
import { createVismaClient, parseVismaSandboxInput, VISMA_OPERATIONS } from './visma-client.mjs';
import { createVismaSandbox } from './visma-sandbox.mjs';
import { createVismaStorage } from './visma-storage.mjs';

// CompanyIdentifier is an opaque string in Spiris, unlike bank/invoice IDs.
const organisationId = 'tenant-a', companyId = 'sandbox-company-123', bankId = randomUUID(), invoiceId = randomUUID(), draftId = randomUUID(), supplierId = randomUUID();
const transactionId = randomUUID(), voucherId = randomUUID(), paymentVoucherId = randomUUID();
async function fixture(run, { amountCents = 12345 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'visma-payment-')), file = join(directory, 'application.sqlite');
  let repository = await createApplicationRepository({ env: {}, filename: file, seed: () => ({}) });
  let time = new Date('2026-10-13T12:00:00Z'), booked = true, generation = 'connection-a', enabled = true, mode = 'sandbox';
  let posted = false, afterPost = 'accepted', matchedReference = true, externalCompany = companyId, nextReadFailure = null;
  const source = { cardId: 3024, approvalId: randomUUID(), version: 1, hash: 'a'.repeat(64) };
  const value = { id: randomUUID(), organisationId, kind: 'card', mode: 'mss', simulation: true, status: 'simulated_paid',
    source, amountCents, currency: 'SEK', spirisCompanyId: companyId, spirisBankAccountId: bankId,
    providerInstructionUUID: 'ABCDEF1234567890ABCDEF1234567890AB', providerPaymentReference: 'reference-a', providerResult: { status: 'PAID', datePaid: '2026-10-12T22:30:00Z' } };
  const job = { source, companyId, status: 'accepted', environment: 'sandbox', draftId, supplierId,
    draft: { InvoiceNumber: 'AV-3024-V1', CurrencyCode: 'SEK', TotalAmount: amountCents / 100 }, accounting: { paymentNetCents: amountCents, offsetCents: 0 },
    tracking: { state: 'booked', invoiceId } };
  const invoice = { Id: invoiceId, CreatedFromDraftId: draftId, SupplierId: supplierId, InvoiceNumber: 'AV-3024-V1', CurrencyCode: 'SEK', TotalAmount: amountCents / 100,
    IsCreditInvoice: false, Status: 1, VoucherId: voucherId, VoucherNumber: 'A11', RemainingAmountInvoiceCurrency: amountCents / 100, PaymentStatus: 3, SkipSendToBank: true };
  const readback = {};
  const transaction = () => ({ Id: transactionId, TransactionDate: '2026-10-13T00:00:00', Reference: matchedReference ? `SP-SWISH-${value.providerInstructionUUID}` : 'OTHER-REFERENCE',
    IsReconciled: true, TransactionAmount: -amountCents / 100, TransactionAmountCurrency: 'SEK', Rows: [{ SourceId: invoiceId,
      PaymentVoucherId: paymentVoucherId, PaymentVoucherNumber: 'B12', AmountTransactionCurrency: -amountCents / 100 }] });
  const calls = [];
  const send = async (operation, parameters, payload) => {
    calls.push({ operation, parameters: structuredClone(parameters), payload: structuredClone(payload) });
    if (nextReadFailure?.operation === operation) { const failure = nextReadFailure.result; nextReadFailure = null; return failure; }
    if (operation === 'invoice') return { outcome: 'accepted', response: { ...invoice, ...(posted ? {
      RemainingAmountInvoiceCurrency: 0, PaymentStatus: 6, ...(Object.hasOwn(invoice, 'RemainingAmount') ? { RemainingAmount: 0 } : {}), ...readback,
    } : {}) } };
    if (operation === 'bankAccounts') return { outcome: 'accepted', response: { Data: [{ Id: bankId, IsActive: true, BankAccountType: 1, CurrencyCode: 'SEK', LedgerAccountNumber: 1930 }], Meta: { CurrentPage: 1, TotalNumberOfPages: 1 } } };
    if (operation === 'recordPayment') {
      posted = true;
      if (afterPost === 'throw') throw new Error('Provider response lost');
      return { outcome: afterPost, httpStatus: afterPost === 'accepted' ? 201 : null, response: afterPost === 'accepted' ? { BankTransactionId: transactionId } : null };
    }
    if (operation === 'bankTransaction') return { outcome: 'accepted', response: transaction() };
    if (operation === 'matchedTransactions') return { outcome: 'accepted', response: { Data: posted ? [transaction()] : [], Meta: { CurrentPage: 1, TotalNumberOfPages: 1 } } };
    assert.fail(`Unexpected operation ${operation}`);
  };
  const make = () => createVismaPayments({ organisationId, getRepository: async () => repository, clock: () => time,
    proofProvider: async id => id === value.id ? structuredClone(value) : null,
    config: () => ({ mode, configured: true, expectedCompanyId: externalCompany }),
    connection: async () => ({ generation, companyVerified: true, company: { id: externalCompany } }),
    target: async () => ({ settings: { enabled, sandbox: true, companyId, enabledBy: { actualUserId: 'admin' } },
      job: booked ? structuredClone(job) : { ...structuredClone(job), tracking: { state: 'pending' } } }),
    batch: async (_scope, authorize, operation) => { await authorize(); return operation(async (...args) => { await authorize(); return send(...args); }); },
  });
  let service = make();
  const f = { value, job, invoice, readback, calls, get service() { return service; },
    posts: () => calls.filter(call => call.operation === 'recordPayment'),
    setBooked: flag => { booked = flag; }, setEnabled: flag => { enabled = flag; }, setMode: flag => { mode = flag; },
    changeGeneration: () => { generation = 'connection-b'; }, changeCompany: () => { externalCompany = randomUUID(); },
    loseResponse: () => { afterPost = 'unknown'; }, crash: () => { afterPost = 'throw'; }, wrongReference: () => { matchedReference = false; },
    failRead: (operation, result) => { nextReadFailure = { operation, result }; },
    stored: () => repository.read(state => structuredClone(state.vismaPayments.records.find(entry => entry.paymentId === value.id)), { domains: ['vismaPayments'] }),
    patchStored: operation => repository.transact(state => operation(state.vismaPayments.records.find(entry => entry.paymentId === value.id)), { domains: ['vismaPayments'] }),
    advance: () => { time = new Date(time.getTime() + 300001); },
    async restart() { await repository.close(); repository = await createApplicationRepository({ env: {}, filename: file, seed: () => ({}) }); service = make(); },
  };
  try { await run(f); } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('only verified Swish PAID proof may create a payment journal; unlinked test payments and other tenants cannot', async () => fixture(async f => {
  const original = structuredClone(f.value);
  for (const patch of [{ status: 'debiting' }, { providerResult: { status: 'DEBITED' } }, { simulation: false }, { mode: 'production' },
    { organisationId: 'tenant-b' }, { kind: 'sandbox' }, { amountCents: 0 }, { spirisCompanyId: '   ' }, { spirisCompanyId: 123 },
    { spirisCompanyId: randomUUID(), spirisBankAccountId: 'bad-id' }]) {
    Object.assign(f.value, original, patch);
    await assert.rejects(() => f.service.synchronize(f.value.id), error => error.code === 'visma_payment_proof_missing');
  }
  assert.equal(f.posts().length, 0);
}));

test('waits for the frozen invoice to be booked, then posts once and confirms transaction and payment voucher', async () => fixture(async f => {
  f.setBooked(false);
  const queued = await f.service.synchronize(f.value.id); assert.equal(queued.status, 'waiting_booked'); assert.equal(f.posts().length, 0);
  f.setBooked(true); f.advance(); const result = await f.service.processQueue(); assert.equal(result.processed, 1);
  const [entry] = result.payments; assert.equal(entry.status, 'registered'); assert.equal(entry.invoiceId, invoiceId);
  assert.equal(entry.bankTransactionId, transactionId); assert.equal(entry.paymentVoucherNumber, 'B12');
  assert.deepEqual(f.posts()[0].payload, { CompanyBankAccountId: bankId, PaymentDate: '2026-10-13', PaymentAmount: 123.45,
    PaymentCurrency: 'SEK', PaymentType: 2, Reference: `SP-SWISH-${f.value.providerInstructionUUID}` });
  await f.service.synchronize(f.value.id); await f.restart(); await f.service.synchronize(f.value.id);
  assert.equal(f.posts().length, 1, 'Repeated hooks and restarts cannot create a second payment registration');
}));

test('concurrent callbacks reserve exactly one payment POST', async () => fixture(async f => {
  await Promise.all([f.service.synchronize(f.value.id), f.service.synchronize(f.value.id), f.service.synchronize(f.value.id)]);
  assert.equal(f.posts().length, 1); assert.equal((await f.service.projection(f.value.id)).status, 'registered');
}));

test('positive and negative full supplier balances register one positive 240 payment and preserve the provider sign', async () => {
  for (const sign of [1, -1]) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = sign * 240;
    f.invoice.RemainingAmount = -sign * 240;
    const result = await f.service.synchronize(f.value.id);
    assert.equal(result.status, 'registered'); assert.equal(result.bankTransactionId, transactionId);
    assert.equal(result.paymentVoucherId, paymentVoucherId); assert.equal(result.paymentVoucherNumber, 'B12');
    assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].payload.PaymentAmount, 240); assert.equal(f.posts()[0].payload.PaymentType, 2);
    const stored = await f.stored();
    assert.equal(stored.remainingBeforeCents, 24000); assert.equal(stored.remainingBeforeSignedCents, sign * 24000);
    await f.restart(); await f.service.synchronize(f.value.id, { force: true });
    assert.equal(f.posts().length, 1);
  }, { amountCents: 24000 });
});

test('every permitted unpaid status supports a negative full supplier balance', async () => {
  for (const status of [3, 7, 8, 10, 13, 14]) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; f.invoice.PaymentStatus = status;
    assert.equal((await f.service.synchronize(f.value.id)).status, 'registered');
    assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].payload.PaymentAmount, 240);
  }, { amountCents: 24000 });
});

test('partial, zero, excessive and malformed signed balances block before payment registration', async () => {
  for (const remaining of [-239.99, 239.99, 0, -240.01, 240.01, undefined, null, '-240', '', NaN, Infinity, -Infinity, -240.001, {}, []])
    await fixture(async f => {
      f.invoice.RemainingAmountInvoiceCurrency = remaining;
      const result = await f.service.synchronize(f.value.id);
      assert.equal(result.status, 'blocked', `RemainingAmountInvoiceCurrency=${String(remaining)}`); assert.equal(f.posts().length, 0);
    }, { amountCents: 24000 });
  for (const remaining of [-239.99, 0, 240.01, undefined, null, '-240', NaN, -240.001]) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; f.invoice.RemainingAmount = remaining;
    assert.equal((await f.service.synchronize(f.value.id)).status, 'blocked'); assert.equal(f.posts().length, 0);
  }, { amountCents: 24000 });
});

test('credit, unverified credit flag and a larger frozen invoice cannot receive a full-invoice payout', async () => {
  for (const credit of [true, undefined, null, 0, 'false']) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; f.invoice.IsCreditInvoice = credit;
    assert.equal((await f.service.synchronize(f.value.id)).status, 'blocked'); assert.equal(f.posts().length, 0);
  }, { amountCents: 24000 });
  await fixture(async f => {
    f.invoice.TotalAmount = 300; f.job.draft.TotalAmount = 300; f.invoice.RemainingAmountInvoiceCurrency = -300;
    assert.equal((await f.service.synchronize(f.value.id)).status, 'blocked'); assert.equal(f.posts().length, 0);
  }, { amountCents: 24000 });
});

test('a delayed PAID callback retains the original payout connection and invoice rather than adopting a reconnect', async () => fixture(async f => {
  f.value.bookingProof = { companyId, generation: 'connection-a', invoiceId, draftId };
  f.changeGeneration();
  const result = await f.service.synchronize(f.value.id);
  assert.equal(result.status, 'paused'); assert.equal(f.posts().length, 0);
}));

test('lost POST response is reconciled only through an exact matched transaction, never a retry', async () => fixture(async f => {
  f.loseResponse(); const result = await f.service.synchronize(f.value.id); assert.equal(result.status, 'registered');
  assert.ok(f.calls.some(call => call.operation === 'matchedTransactions'));
  await f.service.synchronize(f.value.id); assert.equal(f.posts().length, 1);
}));

test('lost responses for signed supplier balances reconcile zero and the matching voucher without resubmission', async () => {
  for (const sign of [1, -1]) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = sign * 240; f.loseResponse();
    const result = await f.service.synchronize(f.value.id);
    assert.equal(result.status, 'registered'); assert.equal(result.paymentVoucherId, paymentVoucherId);
    assert.ok(f.calls.some(call => call.operation === 'matchedTransactions'));
    await f.restart(); await f.service.synchronize(f.value.id, { force: true });
    assert.equal(f.posts().length, 1); assert.equal(f.posts()[0].payload.PaymentAmount, 240);
  }, { amountCents: 24000 });
});

test('nonzero or malformed payment readback never confirms a signed full balance and never resubmits', async () => {
  for (const patch of [{ RemainingAmountInvoiceCurrency: -1 }, { RemainingAmountInvoiceCurrency: 1 },
    { RemainingAmountInvoiceCurrency: '0' }, { RemainingAmount: -1 }, { RemainingAmount: null }, { PaymentStatus: 5 }]) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; Object.assign(f.readback, patch); f.loseResponse();
    assert.equal((await f.service.synchronize(f.value.id)).status, 'unknown');
    f.advance(); assert.equal((await f.service.processQueue()).payments[0].status, 'unknown');
    assert.equal(f.posts().length, 1);
  }, { amountCents: 24000 });
});

test('process crash after POST is durable and resumes readback after restart without a second POST', async () => fixture(async f => {
  f.crash(); const unknown = await f.service.synchronize(f.value.id); assert.equal(unknown.status, 'unknown'); assert.equal(f.posts().length, 1);
  await f.restart(); f.advance(); const { payments } = await f.service.processQueue(); assert.equal(payments[0].status, 'registered'); assert.equal(f.posts().length, 1);
}));

test('reserved legacy payments lacking the raw signed balance still reconcile without a second POST', async () => fixture(async f => {
  f.invoice.RemainingAmountInvoiceCurrency = -240; f.crash();
  assert.equal((await f.service.synchronize(f.value.id)).status, 'unknown');
  await f.patchStored(entry => { delete entry.remainingBeforeSignedCents; });
  await f.restart(); f.advance();
  assert.equal((await f.service.processQueue()).payments[0].status, 'registered'); assert.equal(f.posts().length, 1);
}, { amountCents: 24000 }));

test('zero balance or unrelated payment reference is insufficient proof', async () => fixture(async f => {
  f.wrongReference(); const result = await f.service.synchronize(f.value.id); assert.equal(result.status, 'unknown');
  f.advance(); await f.service.processQueue(); assert.equal(f.posts().length, 1);
  assert.equal((await f.service.projection(f.value.id)).status, 'unknown');
}));

test('explicit refresh bypasses the readback due time but never resends a reserved payment', async () => fixture(async f => {
  f.wrongReference(); assert.equal((await f.service.synchronize(f.value.id)).status, 'unknown');
  const reads = f.calls.filter(call => call.operation === 'invoice').length;
  await f.service.synchronize(f.value.id); assert.equal(f.calls.filter(call => call.operation === 'invoice').length, reads);
  const result = await f.service.synchronize(f.value.id, { force: true });
  assert.equal(result.status, 'unknown'); assert.equal(f.calls.filter(call => call.operation === 'invoice').length, reads + 1); assert.equal(f.posts().length, 1);
}));

test('paid, partial, bank-submitted and unknown statuses are blocked even with a negative full balance', async () => {
  for (const status of [1, 2, 4, 5, 6, 9, 11, 12, 15, 16, 17, undefined, null, '3']) await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; f.invoice.PaymentStatus = status;
    const result = await f.service.synchronize(f.value.id); assert.equal(result.status, 'blocked'); assert.equal(f.posts().length, 0);
  }, { amountCents: 24000 });
  await fixture(async f => {
    f.invoice.RemainingAmountInvoiceCurrency = -240; f.invoice.SkipSendToBank = false;
    assert.equal((await f.service.synchronize(f.value.id)).status, 'blocked'); assert.equal(f.posts().length, 0);
  }, { amountCents: 24000 });
});

test('different invoice supplier or total cannot receive the payment', async () => fixture(async f => {
  f.invoice.SupplierId = randomUUID(); const result = await f.service.synchronize(f.value.id); assert.equal(result.status, 'blocked'); assert.equal(f.posts().length, 0);
}));

test('transient preflight invoice and bank reads retry safely, while missing invoice and malformed bank response remain blocked', async () => {
  for (const operation of ['invoice', 'bankAccounts']) for (const result of [
    { outcome: 'unknown', httpStatus: null, response: null }, { outcome: 'rejected', httpStatus: 429, response: null },
    { outcome: 'rejected', httpStatus: 503, response: null },
  ]) await fixture(async f => {
    f.failRead(operation, result);
    const pending = await f.service.synchronize(f.value.id); assert.equal(pending.status, 'pending'); assert.ok(pending.nextCheckAt); assert.equal(f.posts().length, 0);
    await f.service.synchronize(f.value.id); assert.equal(f.calls.filter(call => call.operation === operation).length, 1, 'Backoff skips immediate duplicate callbacks');
    f.advance(); const { payments } = await f.service.processQueue(); assert.equal(payments[0].status, 'registered'); assert.equal(f.posts().length, 1);
    await f.service.synchronize(f.value.id); assert.equal(f.posts().length, 1);
  });
  for (const [operation, result] of [['invoice', { outcome: 'rejected', httpStatus: 404, response: null }],
    ['bankAccounts', { outcome: 'accepted', httpStatus: 200, response: { Data: 'malformed' } }]]) await fixture(async f => {
    f.failRead(operation, result); assert.equal((await f.service.synchronize(f.value.id)).status, 'blocked'); assert.equal(f.posts().length, 0);
  });
});

test('connection generation, company pin, disabled transfer and production mode stop queued payments', async () => {
  for (const change of ['changeGeneration', 'changeCompany', 'setEnabled', 'setMode']) await fixture(async f => {
    f.setBooked(false); await f.service.synchronize(f.value.id); f.setBooked(true);
    if (change === 'setEnabled') f.setEnabled(false); else if (change === 'setMode') f.setMode('production'); else f[change]();
    f.advance(); const { payments } = await f.service.processQueue(); assert.equal(payments[0].status, 'paused'); assert.equal(f.posts().length, 0);
  });
});

test('a mutated Swish amount under the same payment id is an idempotency conflict', async () => fixture(async f => {
  f.setBooked(false); await f.service.synchronize(f.value.id); f.value.amountCents++;
  await assert.rejects(() => f.service.synchronize(f.value.id), error => error.code === 'idempotency_conflict'); assert.equal(f.posts().length, 0);
}));

test('payment transport is separate from browser operations, strict and accepts the documented BankTransactionId response', async () => {
  const calls = [], env = { VISMA_ENVIRONMENT: 'sandbox', VISMA_CLIENT_ID: 'test', VISMA_CLIENT_SECRET: 'secret',
    VISMA_REDIRECT_URI: 'https://example.org/api/integrations/visma/oauth/callback', VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  const client = createVismaClient({ env, fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ BankTransactionId: transactionId }), { status: 201 }); } });
  const payload = { CompanyBankAccountId: bankId, PaymentDate: '2026-10-13', PaymentAmount: 123.45, PaymentCurrency: 'SEK', PaymentType: 2, Reference: 'SP-SWISH-test' };
  const result = await client.paymentRequest({ operation: 'recordPayment', parameters: { resourceId: invoiceId }, payload, accessToken: 'token' });
  assert.equal(result.outcome, 'accepted'); assert.equal(result.response.BankTransactionId, transactionId);
  assert.equal(calls[0].url, `https://eaccountingapi.vismaonline.com/v2/supplierinvoices/${invoiceId}/payments`);
  assert.ok(!VISMA_OPERATIONS.some(operation => operation.id === 'recordPayment'));
  assert.throws(() => parseVismaSandboxInput({ requestId: randomUUID(), idempotencyKey: 'id', operation: 'recordPayment', parameters: { resourceId: invoiceId }, payload }));
  for (const extra of [{ SkipSendToBank: false }, { BankTransactionId: transactionId }, { PaymentType: 4 }, { PaymentAmount: 0 }])
    await assert.rejects(() => client.paymentRequest({ operation: 'recordPayment', parameters: { resourceId: invoiceId }, payload: { ...payload, ...extra }, accessToken: 'token' }));
  await assert.rejects(() => client.paymentRequest({ operation: 'recordPayment', parameters: { resourceId: '../tenant-b' }, payload, accessToken: 'token' }));
  assert.equal(calls.length, 1);
});

test('real OAuth service exposes own-account choices and privately books a verified payout on its exact tenant export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visma-payment-oauth-'));
  const repository = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: () => ({}) });
  const source = { cardId: 3024, approvalId: randomUUID(), version: 1, hash: 'a'.repeat(64) };
  const paid = { id: randomUUID(), organisationId, kind: 'card', mode: 'mss', simulation: true, status: 'simulated_paid', source,
    amountCents: 10000, currency: 'SEK', spirisCompanyId: companyId, spirisBankAccountId: bankId,
    providerInstructionUUID: 'ABCD1234ABCD1234ABCD1234ABCD1234', providerPaymentReference: 'swish-ref', providerResult: { status: 'PAID', datePaid: '2026-10-13T10:00:00Z' } };
  const context = { organisationId, actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'session-a', actor: { id: 'admin', level: 'Systemadmin' }, user: { id: 'admin', level: 'Systemadmin' } };
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  let recorded = false, unavailableCompany = false;
  const calls = [], service = createVismaSandbox({ getRepository: async () => repository, swishPaymentProvider: async id => id === paid.id ? paid : null,
    now: () => new Date('2026-10-13T12:00:00Z'), env: { SCRAPPILOT_ORGANISATION_ID: organisationId, VISMA_ENVIRONMENT: 'sandbox', VISMA_TENANT_COMPANY_ID: companyId,
      VISMA_CLIENT_ID: 'test', VISMA_CLIENT_SECRET: 'secret', VISMA_REDIRECT_URI: 'https://example.org/api/integrations/visma/oauth/callback', VISMA_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
    fetchImpl: async (url, options) => {
      const address = new URL(url); calls.push({ address, method: options.method });
      if (address.hostname === 'identity.vismaonline.com') return response({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 });
      if (address.pathname === '/v2/companysettings') {
        if (unavailableCompany) { unavailableCompany = false; return response({ message: 'temporary outage' }, 503); }
        return response({ CompanyIdentifier: companyId, Name: 'Our verified sandbox' });
      }
      if (address.pathname === '/v2/bankaccounts') return response({ Data: [{ Id: bankId, IsActive: true, Name: 'Företagskonto', BankAccountType: 1, LedgerAccountNumber: 1930, CurrencyCode: 'SEK' }], Meta: { CurrentPage: 1, TotalNumberOfPages: 1 } });
      if (address.pathname === `/v2/supplierinvoices/${invoiceId}`) return response({ Id: invoiceId, CreatedFromDraftId: draftId, SupplierId: supplierId,
        InvoiceNumber: 'AV-3024-V1', CurrencyCode: 'SEK', TotalAmount: 100, IsCreditInvoice: false, Status: 1, VoucherId: voucherId, SkipSendToBank: true,
        RemainingAmountInvoiceCurrency: recorded ? 0 : 100, PaymentStatus: recorded ? 6 : 3 });
      if (address.pathname === `/v2/supplierinvoices/${invoiceId}/payments` && options.method === 'POST') { recorded = true; return response({ BankTransactionId: transactionId }, 201); }
      if (address.pathname === `/v2/banktransactions/${bankId}/${transactionId}`) return response({ Id: transactionId, Reference: `SP-SWISH-${paid.providerInstructionUUID}`,
        TransactionDate: '2026-10-13T00:00:00', TransactionAmount: -100, TransactionAmountCurrency: 'SEK', IsReconciled: true,
        Rows: [{ SourceId: invoiceId, AmountTransactionCurrency: -100, PaymentVoucherId: paymentVoucherId, PaymentVoucherNumber: 'B12' }] });
      assert.fail(`Unexpected URL ${url}`);
    } });
  try {
    const started = await service.begin(context); await service.callback({ state: new URL(started.authorizationUrl).searchParams.get('state'), code: 'test-code', cookieBinding: started.cookieBinding }); await service.complete(context);
    const choices = await service.paymentChoices(context); assert.equal(choices.companyId, companyId); assert.deepEqual(choices.bankAccounts[0], { id: bankId, name: 'Företagskonto', ledgerAccountNumber: 1930, currency: 'SEK', type: 1, active: true });
    await assert.rejects(() => service.paymentChoices({ ...context, organisationId: 'tenant-b' }), error => error.code === 'forbidden');
    const storage = createVismaStorage({ getRepository: async () => repository, organisationId });
    await storage.transact(document => {
      document.tenants[organisationId].finance = { settings: { [companyId]: { enabled: true, sandbox: true, companyId, enabledBy: { actualUserId: 'admin' } } },
        outbox: [{ id: randomUUID(), source, companyId, environment: 'sandbox', status: 'accepted', createdAt: '2026-10-13T08:00:00Z', draftId, supplierId,
          draft: { InvoiceNumber: 'AV-3024-V1', TotalAmount: 100 }, accounting: { paymentNetCents: 10000, offsetCents: 0 }, tracking: { state: 'booked', invoiceId } }] };
    });
    unavailableCompany = true;
    assert.equal((await service.synchronizeSwishPayment(paid.id)).status, 'pending');
    assert.equal(calls.filter(call => call.address.pathname.endsWith('/payments')).length, 0);
    const result = await service.synchronizeSwishPayment(paid.id, { force: true }); assert.equal(result.status, 'registered'); assert.equal(result.paymentVoucherNumber, 'B12');
    assert.equal((await service.swishPaymentBookkeeping(paid.id)).status, 'registered');
    await service.synchronizeSwishPayment(paid.id); assert.equal(calls.filter(call => call.address.pathname.endsWith('/payments')).length, 1);
    await assert.rejects(() => service.send({ requestId: randomUUID(), idempotencyKey: 'attempt', operation: 'recordPayment' }, context));
    assert.equal(calls.filter(call => call.address.pathname.endsWith('/payments')).length, 1);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
