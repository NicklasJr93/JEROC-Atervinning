import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { initialApplicationState } from './application.mjs';
import { createBankPayments } from './bank-payments.mjs';
import { createOpenPaymentsClient, OPENPAYMENTS_SANDBOX_API, OPENPAYMENTS_SANDBOX_OAUTH } from './openpayments-client.mjs';

// Transport-only fixtures retain the real client validation, URL/header/form
// contracts and the real durable engine; no external financial writes occur.
const cardId = 2053, bankId = 'SWEDSESS', iban = 'SE4550000000058398257466';
const context = { organisationId: 'jeroc-demo', actorId: 'admin', effectiveUserId: 'admin', sessionKey: 'bank-http-contract-fixture',
  psuIp: '127.0.0.1', userAgent: 'ScrapPilot bank contract tests' };
const bankRecipient = { method: 'bank', bankType: 'account', clearing: '83279', account: '1234567890', holder: 'Erik Johansson' };
const environment = () => ({ OPENPAYMENTS_CLIENT_ID: 'bank-contract-client', OPENPAYMENTS_CLIENT_SECRET: 'fixture-only-no-live-credential',
  OPENPAYMENTS_REDIRECT_URI: 'https://scrappilot.example/api/integrations/openpayments/callback' });
const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });

async function fixture(run, { recipient = bankRecipient, readTransform } = {}) {
  const state = initialApplicationState(), customer = state.office.customers.find(item => item.id === 'customer-erik');
  const card = state.office.cards.find(item => item.id === cardId);
  Object.assign(card, { status: 'ready', siteId: 'norrtalje', customerId: customer.id, origin: 'Testgatan 1', reference: 'HTTP contract fixture',
    payment: 'Bankkonto', paymentDetails: structuredClone(recipient), pricingSnapshotId: 'bank-http-pricing', pricingTotal: 240,
    financialPending: false, pricingRowsPending: false, rows: [{ articleId: 'copper-1', weight: 1, price: 240, tier: 'C' }],
    customerApproval: { id: 'e09ff1ed-46dc-4976-bca5-5e582710781c', version: 1, status: 'attested' } });
  const snapshot = { hash: 'bank-http-frozen-source', card: structuredClone(card), customer: structuredClone(customer),
    rows: [{ articleId: 'copper-1', name: 'Koppar', weight: 1, price: 240, amount: 240 }], gross: 240, net: 240, offset: 0 };
  const approval = { id: card.customerApproval.id, cardId, version: 1, status: 'attested', snapshot, approvedHash: snapshot.hash,
    approvedAt: '2026-10-13T08:00:00Z', attestedAt: '2026-10-13T08:01:00Z', attestedBy: 'admin', approvedMethod: 'id' };
  const repository = await createApplicationRepository({ env: {}, filename: ':memory:', seed: () => state });
  let timestamp = new Date('2026-10-13T09:00:00Z');
  const env = environment(), calls = [], activated = new Set(), payloads = new Map(), receipts = [], bookkeeping = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url), path = target.pathname;
    calls.push({ url: String(url), path, method: init.method, headers: { ...init.headers }, body: init.body });
    assert.ok([OPENPAYMENTS_SANDBOX_API, OPENPAYMENTS_SANDBOX_OAUTH].includes(target.origin));
    assert.equal(init.redirect, 'error');
    if (path === '/connect/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('client_id'), env.OPENPAYMENTS_CLIENT_ID); assert.equal(form.get('client_secret'), env.OPENPAYMENTS_CLIENT_SECRET);
      if (form.get('grant_type') === 'authorization_code') {
        const resource = init.headers['X-consentId'] ?? init.headers['X-paymentId']; assert.ok(resource); activated.add(resource);
        assert.equal(form.get('redirect_uri'), env.OPENPAYMENTS_REDIRECT_URI);
        assert.ok(init.headers[init.headers['X-consentId'] ? 'X-ConsentAuthorisationId' : 'X-PaymentAuthorisationId']);
      }
      return response({ access_token: 'fixture-private-bearer-token', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer fixture-private-bearer-token');
    assert.match(init.headers['X-Request-ID'], /^[0-9a-f-]{36}$/i);
    if (path === '/psd2/aspspinformation/v1/aspsps') return response({ aspsps: [{ bicFi: bankId, name: 'Swedbank' }] });
    if (path === `/psd2/aspspinformation/v1/aspsps/${bankId}`) return response({ bicFi: bankId, globalPaymentProducts: ['domestic', 'swedish-giro'] });
    assert.equal(init.headers['X-BicFi'], bankId); assert.equal(init.headers['PSU-ID'], '199002092386');
    assert.equal(init.headers['PSU-Corporate-ID'], '5560160680');
    if (path === '/psd2/consent/v1/consents' && init.method === 'POST') {
      const body = JSON.parse(init.body); assert.deepEqual(body.access, {}); assert.equal(body.frequencyPerDay, 4);
      return response({ consentId: 'consent-http', consentStatus: 'received' }, 201);
    }
    if (path.endsWith('/authorisations') && init.method === 'POST') {
      assert.equal(init.headers['TPP-Redirect-Preferred'], 'true');
      assert.equal(init.headers['TPP-Redirect-URI'], env.OPENPAYMENTS_REDIRECT_URI);
      return response({ authorisationId: 'auth-http', scaStatus: 'received', scaMethods: [{ authenticationMethodId: 'mbid' }] }, 201);
    }
    if (path.endsWith('/authorisations/auth-http') && init.method === 'PUT') {
      assert.deepEqual(JSON.parse(init.body), { authenticationMethodId: 'mbid' });
      return response({ scaStatus: 'started', _links: { scaOAuth: { href: 'https://auth.sandbox.openbankingplatform.com/connect/authorize?client_id=[CLIENT_ID]&redirect_uri=[TPP_REDIRECT_URI]&state=[TPP_STATE]' } } },
        200, { 'aspsp-sca-approach': 'REDIRECT' });
    }
    if (path === '/psd2/consent/v1/consents/consent-http/status') return response({ consentStatus: activated.has('consent-http') ? 'valid' : 'received' });
    if (path === '/psd2/accountinformation/v1/accounts') {
      assert.equal(init.headers['Consent-ID'], 'consent-http'); assert.ok(activated.has('consent-http'));
      return response({ accounts: [{ resourceId: 'debtor-http', iban, currency: 'SEK', name: 'Företagskonto', status: 'enabled' }] });
    }
    if (/^\/psd2\/paymentinitiation\/v1\/payments\/(domestic|swedish-giro)$/.test(path) && init.method === 'POST') {
      const payload = JSON.parse(init.body);
      if (path.endsWith('/domestic')) {
        const account = payload.creditorAccount;
        // Model the provider's actual writable contract independently of our
        // client's permissive historic account-reference read schema.
        if (!account || Object.keys(account).some(key => !['iban', 'bban', 'currency'].includes(key))
          || Number(typeof account.iban === 'string') + Number(typeof account.bban === 'string') !== 1)
          return response({ tppMessages: [{ code: 'FORMAT_ERROR', text: 'creditorAccount requires iban or bban' }] }, 400);
      }
      payloads.set('payment-http', payload);
      return response({ paymentId: 'payment-http', transactionStatus: 'RCVD' }, 201);
    }
    if (/^\/psd2\/paymentinitiation\/v1\/payments\/(domestic|swedish-giro)\/payment-http$/.test(path) && init.method === 'GET') {
      assert.ok(payloads.has('payment-http'));
      const value = { ...structuredClone(payloads.get('payment-http')), paymentId: 'payment-http', transactionStatus: activated.has('payment-http') ? 'ACSC' : 'RCVD' };
      return response(readTransform ? readTransform(value) : value);
    }
    throw new Error(`Unexpected contract fixture route ${path}`);
  };
  const client = createOpenPaymentsClient({ env, fetchImpl });
  const payments = createBankPayments({ getRepository: async () => repository, sourceProvider: async () => [structuredClone(approval)], client, env, now: () => timestamp,
    assertPaymentReady: async () => ({ status: 'booked', companyId: 'sandbox-http-company', generation: 'http-generation',
      invoiceId: 'ffef9c9d-7d99-47bb-b0a9-67121c701cc2', draftId: '4d303ef5-0189-4f7e-80b6-14fbcb8c933d' }),
    onPaymentConfirmed: async value => { receipts.push(structuredClone(value)); return { documentId: 'simulated-bank-receipt' }; },
    onVerifiedPayment: async value => { bookkeeping.push(structuredClone(value)); return { status: 'registered', paymentId: 'simulated-spiris-booking' }; } });
  const callbacks = calls => calls.filter(call => call.path === '/connect/token' && new URLSearchParams(call.body).get('grant_type') === 'authorization_code');
  async function connect() {
    await payments.saveSettings({ enabled: true, bankId, corporateId: '5560160680', psuId: '199002092386' }, context);
    const consent = await payments.connectConsent({}, context), state = new URL(consent.authorisationUrl).searchParams.get('state');
    assert.ok(consent.expiresAt);
    await payments.completeAuthorisation({ state, code: 'consent-code' }, context);
    await payments.saveSettings({ enabled: true, debtorAccountId: 'debtor-http', bookkeepingEnabled: true,
      spirisCompanyId: 'sandbox-http-company', spirisBankAccountId: '685c13c5-f465-49d7-aee1-b2c17b7ad1ad' }, context);
    return { consent, state };
  }
  try { await run({ payments, repository, client, calls, callbacks, connect, receipts, bookkeeping, payloads,
    advance: milliseconds => { timestamp = new Date(timestamp.getTime() + milliseconds); } }); }
  finally { await repository.close(); }
}

test('real adapter + engine complete AIS consent callback with persisted expiry and one-time session binding', () => fixture(async f => {
  const { state } = await f.connect(); const settings = await f.payments.settings(context);
  assert.equal(settings.consent.status, 'valid'); assert.equal(settings.accounts[0].id, 'debtor-http'); assert.equal(settings.settings.debtorAccountId, 'debtor-http');
  const count = f.callbacks(f.calls).length;
  await assert.rejects(() => f.payments.completeAuthorisation({ state, code: 'consent-code' }, { ...context, sessionKey: 'other-session' }), error => error.code === 'bank_callback_forbidden');
  await f.payments.completeAuthorisation({ state, code: 'consent-code' }, context); assert.equal(f.callbacks(f.calls).length, count);
  f.advance(31 * 86400000);
  await assert.rejects(() => f.payments.start({ cardId }, context), error => error.code === 'bank_consent_expired');
  assert.equal(f.calls.some(call => call.path.includes('/paymentinitiation/')), false);
}));

test('real adapter + engine domestic flow reserves once and only matched resource ACSC reaches PDF/Spiris hooks', () => fixture(async f => {
  await f.connect(); const reserved = await f.payments.start({ cardId }, context);
  assert.equal(reserved.status, 'queued'); assert.equal(f.calls.some(call => /^\/psd2\/paymentinitiation/.test(call.path)), false);
  await f.payments.processQueuedPayments(); const created = await f.payments.job(reserved.id, context);
  assert.equal(created.status, 'awaiting_authorization'); assert.equal(f.receipts.length, 0); assert.equal(f.bookkeeping.length, 0);
  const signed = await f.payments.beginAuthorisation(reserved.id, {}, context), state = new URL(signed.authorisationUrl).searchParams.get('state');
  const activated = await f.payments.completeAuthorisation({ state, code: 'payment-code' }, context);
  assert.equal(activated.job.status, 'simulated_paid'); assert.equal(activated.job.paymentDocumentStatus, 'archived'); assert.equal(activated.job.bookkeepingStatus, 'registered');
  assert.equal(f.receipts.length, 1); assert.equal(f.bookkeeping.length, 1); assert.equal(f.receipts[0].providerResult.transactionStatus, 'ACSC');
  assert.equal(f.receipts[0].providerResult.datePaidSource, 'sandbox_confirmation');
  assert.equal(await f.repository.read(state => state.bankPayments.jobs[reserved.id].payloadVersion, { domains: ['bankPayments'] }), 2);
  assert.deepEqual(f.payloads.get('payment-http').creditorAccount, { bban: '832791234567890', currency: 'SEK' });
  const verified = await f.payments.readVerifiedPayment(reserved.id); assert.ok(verified);
  await f.payments.refresh(reserved.id, context); await f.payments.completeAuthorisation({ state, code: 'payment-code' }, context);
  assert.equal(f.calls.filter(call => call.method === 'POST' && /^\/psd2\/paymentinitiation\/v1\/payments\/domestic$/.test(call.path)).length, 1);
  assert.equal(f.callbacks(f.calls).filter(call => call.headers['X-paymentId']).length, 1);
  assert.equal(f.receipts.length, 1); assert.equal(f.bookkeeping.length, 1);
  const saved = await f.payments.job(reserved.id, context); assert.equal(saved.verifiedAt, verified.verifiedAt);
  assert.equal(JSON.stringify(saved.response).includes('fixture-private-bearer-token'), false);
  const traceIds = f.calls.filter(call => call.url.startsWith(OPENPAYMENTS_SANDBOX_API)).map(call => call.headers['X-Request-ID']);
  assert.equal(new Set(traceIds).size, traceIds.length, 'Each provider HTTP request needs its own trace ID; durable payment identity remains unchanged');
}));

test('explicit retry of a confirmed legacy FORMAT_ERROR reserves one new v2 instruction and preserves the rejected attempt', () => fixture(async f => {
  await f.connect();
  const preparation = await f.payments.prepare(cardId, context), legacyId = randomUUID();
  const legacy = { id: legacyId, organisationId: context.organisationId, provider: 'openpayments', kind: 'card', mode: 'sandbox', simulation: true,
    source: structuredClone(preparation.source), paymentDetails: structuredClone(bankRecipient), amount: 240, amountCents: 24000, currency: 'SEK',
    providerInstructionUUID: randomUUID(), providerPaymentId: null, providerProduct: 'domestic', status: 'rejected',
    createdAt: '2026-10-13T08:59:00Z', sentAt: '2026-10-13T08:59:01Z', finishedAt: '2026-10-13T08:59:02Z',
    request: { method: 'POST', path: '/psd2/paymentinitiation/v1/payments/domestic', payload: {
      creditorName: bankRecipient.holder, creditorAccount: { clearingNumber: '83279', accountNumber: '1234567890', currency: 'SEK' },
      debtorAccount: { iban, currency: 'SEK' }, instructedAmount: { amount: '240.00', currency: 'SEK' },
      endToEndIdentification: preparation.source.number, remittanceInformationUnstructured: preparation.source.number } },
    response: { method: 'POST', httpStatus: 400, data: { tppMessages: [{ code: 'FORMAT_ERROR' }] } },
    error: { code: 'bank_provider_rejected', message: 'creditorAccount requires iban or bban' }, events: [{ action: 'payment_rejected' }] };
  await f.repository.transact(state => { state.bankPayments.jobs[legacyId] = structuredClone(legacy); });
  await f.payments.refresh(legacyId, context);
  assert.equal(f.calls.some(call => /^\/psd2\/paymentinitiation\//.test(call.path)), false, 'Refreshing a rejected attempt never resends it.');
  assert.equal((await f.payments.start({ cardId }, context)).id, legacyId, 'A retry must explicitly name the rejected attempt.');
  const [first, duplicate] = await Promise.all([
    f.payments.start({ cardId, retryOf: legacyId }, context),
    f.payments.start({ cardId, retryOf: legacyId }, context),
  ]);
  assert.notEqual(first.id, legacyId); assert.equal(duplicate.id, first.id); assert.equal(first.retryOf, legacyId);
  const stored = await f.repository.read(state => structuredClone(state.bankPayments.jobs[first.id]), { domains: ['bankPayments'] });
  assert.equal(stored.payloadVersion, 2);
  assert.notEqual(first.providerInstructionUUID, legacy.providerInstructionUUID);
  assert.deepEqual(stored.request.payload.creditorAccount, { bban: '832791234567890', currency: 'SEK' });
  await f.payments.processQueuedPayments();
  assert.equal((await f.payments.job(first.id, context)).status, 'awaiting_authorization');
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/payments/domestic')).length, 1);
  assert.deepEqual(await f.repository.read(state => state.bankPayments.jobs[legacyId], { domains: ['bankPayments'] }), legacy,
    'The historical rejected payload, response and identity stay immutable.');
  assert.equal(f.receipts.length, 0); assert.equal(f.bookkeeping.length, 0);
}));

test('real adapter + engine giro ACSC without an exact creditor/reference echo fails closed instead of inferring settlement', () => fixture(async f => {
  await f.connect(); const reserved = await f.payments.start({ cardId }, context); await f.payments.processQueuedPayments();
  const signed = await f.payments.beginAuthorisation(reserved.id, {}, context), state = new URL(signed.authorisationUrl).searchParams.get('state');
  const completed = await f.payments.completeAuthorisation({ state, code: 'giro-code' }, context);
  assert.equal(completed.job.status, 'unknown'); assert.equal(completed.job.error.code, 'bank_response_mismatch');
  assert.equal(completed.job.pollSuspended, true); assert.equal(await f.payments.readVerifiedPayment(reserved.id), null);
  assert.equal(f.receipts.length, 0); assert.equal(f.bookkeeping.length, 0);
  assert.deepEqual(f.payloads.get('payment-http').creditorGiro, { giroNumber: '1234566', giroType: 'BANKGIRO' });
  assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/payments/swedish-giro')).length, 1);
  const repeated = await f.payments.start({ cardId }, context); assert.equal(repeated.id, reserved.id);
}, { recipient: { method: 'bank', bankType: 'bankgiro', bankgiro: '1234566', holder: 'Erik Johansson' }, readTransform: value => {
  if (value.transactionStatus !== 'ACSC') return value;
  const { creditorGiro, invoiceRef, ...genericSchema } = value; void creditorGiro; void invoiceRef;
  return { ...genericSchema, creditorAccount: { iban, currency: 'SEK' } };
} }));
