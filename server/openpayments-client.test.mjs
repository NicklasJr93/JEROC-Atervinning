import test from 'node:test';
import assert from 'node:assert/strict';
import { bankPaymentCreditorAccount, buildSandboxPaymentPayload, createOpenPaymentsClient, OPENPAYMENTS_SANDBOX_API, OPENPAYMENTS_SANDBOX_OAUTH, safeOpenPaymentsData } from './openpayments-client.mjs';

const env = () => ({ OPENPAYMENTS_CLIENT_ID: 'sandbox-client', OPENPAYMENTS_CLIENT_SECRET: 'test-secret-not-a-real-credential' });
const requestId = '4da9ab29-0613-4000-8128-27e1c014ed73';
const context = { bankId: 'SWEDSESS', psuId: '199001010011', corporateId: '5560000167', psuIp: '127.0.0.1', userAgent: 'ScrapPilot sandbox test' };
const account = { iban: 'SE4550000000058398257466', currency: 'SEK' };
const recipient = { method: 'bank', bankType: 'account', bank: 'Testbank', clearing: '5000', account: '0058398257466', holder: 'Testleverantör AB' };
const bankDetails = { bicFi: 'SWEDSESS', globalPaymentProducts: ['domestic', 'swedish-giro'] };
const fixture = (change = {}) => buildSandboxPaymentPayload({ amountCents: 24000, recipient, debtorAccount: account, reference: 'AV-3026-V1', executionDate: '2026-10-13', bankDetails, ...change });
const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const token = () => reply({ access_token: 'test-bearer-token-private', token_type: 'Bearer', expires_in: 3600 });

function clientMock(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: String(url), ...init }; calls.push(call);
    if (call.url === `${OPENPAYMENTS_SANDBOX_OAUTH}/connect/token` && new URLSearchParams(init.body).get('grant_type') === 'client_credentials') return token();
    return handler(call);
  };
  return { client: createOpenPaymentsClient({ env: env(), fetchImpl, ...options }), calls };
}

test('new Swedish PIS payload uses national BBAN and preserves clearing digits, leading zeros and exact cents', () => {
  const result = fixture(); assert.equal(result.ok, true); assert.equal(result.product, 'domestic');
  assert.equal(result.payloadVersion, 2);
  assert.deepEqual(result.payload.creditorAccount, { bban: '50000058398257466', currency: 'SEK' });
  assert.deepEqual(result.payload.instructedAmount, { amount: '240.00', currency: 'SEK' });
  assert.equal(result.payload.endToEndIdentification, 'AV-3026-V1');
  assert.equal(fixture({ amountCents: 1001 }).payload.instructedAmount.amount, '10.01');
});
test('five-digit Swedbank clearing stays intact; a missing fifth digit is rejected without padding or invented digits', () => {
  const complete = { ...recipient, clearing: '83279', account: '0001234567' };
  assert.deepEqual(bankPaymentCreditorAccount(complete), { bban: '832790001234567', currency: 'SEK' });
  assert.deepEqual(fixture({ recipient: complete }).payload.creditorAccount, bankPaymentCreditorAccount(complete));
  assert.deepEqual(bankPaymentCreditorAccount({ ...recipient, clearing: '7104', account: '0012345' }), { bban: '71040012345', currency: 'SEK' });
  assert.deepEqual(bankPaymentCreditorAccount({ ...recipient, clearing: '0500', account: '0001234' }), { bban: '05000001234', currency: 'SEK' });
  const missing = { ...complete, clearing: '8327' };
  assert.equal(bankPaymentCreditorAccount(missing), null);
  const rejected = fixture({ recipient: missing });
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'bank_clearing_incomplete');
  assert.match(rejected.error.message, /fem siffror/);
  for (const clearing of ['832', '832799', '8327-9']) assert.equal(fixture({ recipient: { ...complete, clearing } }).ok, false);
});
test('new debtor references preserve fetched IBAN/BBAN and map a valid AIS clearing/account pair without altering digits', () => {
  assert.deepEqual(fixture().payload.debtorAccount, account);
  const bban = { bban: '0058398257466', currency: 'SEK' };
  assert.deepEqual(fixture({ debtorAccount: bban }).payload.debtorAccount, bban);
  const pair = { clearingNumber: '83279', accountNumber: '0001234567', currency: 'SEK' };
  const before = structuredClone(pair);
  assert.deepEqual(fixture({ debtorAccount: pair }).payload.debtorAccount, { bban: '832790001234567', currency: 'SEK' });
  assert.deepEqual(pair, before, 'the original fetched account remains unchanged');
  assert.equal(fixture({ debtorAccount: { ...pair, iban: account.iban } }).ok, false);
  assert.equal(fixture({ debtorAccount: { clearingNumber: '83279', currency: 'SEK' } }).ok, false);
});
test('explicit legacy version reconstructs its original schema without new clearing rules; unknown versions fail closed', () => {
  const oldRecipient = { ...recipient, clearing: '8327', account: '1234567890' };
  const oldDebtor = { clearingNumber: '8327', accountNumber: '0012345678', currency: 'SEK' };
  const legacy = fixture({ payloadVersion: 1, recipient: oldRecipient, debtorAccount: oldDebtor });
  assert.equal(legacy.ok, true); assert.equal(legacy.payloadVersion, 1);
  assert.deepEqual(legacy.payload.creditorAccount, { clearingNumber: '8327', accountNumber: '1234567890', currency: 'SEK' });
  assert.deepEqual(legacy.payload.debtorAccount, oldDebtor);
  assert.deepEqual(bankPaymentCreditorAccount(oldRecipient, 1), legacy.payload.creditorAccount);
  for (const version of [0, 3, '1', '2', null, NaN]) {
    assert.equal(bankPaymentCreditorAccount(recipient, version), null);
    assert.equal(fixture({ payloadVersion: version }).error.code, 'bank_payload_version_invalid');
  }
});
test('legacy pair references are read-verifiable but cannot be posted to PIS or trigger even token HTTP', async () => {
  const { client, calls } = clientMock(() => { throw new Error('must not reach provider'); });
  const pair = { clearingNumber: '5000', accountNumber: '0058398257466', currency: 'SEK' };
  const legacy = fixture({ payloadVersion: 1 });
  assert.equal(legacy.ok, true);
  const invalid = [legacy.payload, { ...fixture().payload, debtorAccount: pair },
    { ...fixture().payload, creditorAccount: { ...pair, bban: '50000058398257466' } }];
  for (const payload of invalid) {
    const result = await client.createPayment({ ...context, product: 'domestic', payload });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'bank_payload_invalid');
  }
  const giro = fixture({ payloadVersion: 1, debtorAccount: pair,
    recipient: { holder: recipient.holder, bankType: 'bankgiro', bankgiro: '12345678' } });
  assert.equal((await client.createPayment({ ...context, product: 'swedish-giro', payload: giro.payload })).ok, false);
  assert.equal(calls.length, 0);
});
test('IBAN and BG/PG use distinct confirmed bank products and canonical giro references', () => {
  const iban = fixture({ recipient: { ...recipient, bankType: 'iban', iban: account.iban, bankCountry: 'SE' } });
  assert.deepEqual(iban.payload.creditorAccount, account);
  for (const [type, number, giroType] of [['bankgiro', '12345678', 'BANKGIRO'], ['plusgiro', '9482945', 'PLUSGIRO']]) {
    const result = fixture({ recipient: { holder: recipient.holder, bankType: type, [type]: number } });
    assert.equal(result.ok, true); assert.equal(result.product, 'swedish-giro');
    assert.deepEqual(result.payload.creditorGiro, { giroNumber: number, giroType });
    assert.equal(result.payload.invoiceRef, 'AV-3026-V1');
    assert.equal(result.payload.creditorAccount, undefined);
  }
  const ocr = fixture({ recipient: { holder: recipient.holder, bankType: 'bankgiro', bankgiro: '12345678', ocr: '1234567890' } });
  assert.equal(ocr.payload.ocrRef, '1234567890'); assert.equal(ocr.payload.invoiceRef, undefined);
});
test('foreign IBAN, unsupported product, missing bank capabilities, invalid money/date/IBAN and conflicting account formats fail closed', () => {
  assert.equal(fixture({ recipient: { ...recipient, bankType: 'iban', iban: 'FI7521123456700081' } }).error.code, 'bank_country_unsupported');
  assert.equal(fixture({ bankDetails: { globalPaymentProducts: ['cross-border'] } }).error.code, 'bank_product_unsupported');
  assert.equal(fixture({ bankDetails: {} }).ok, false);
  for (const amountCents of [0, -1, 10.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(fixture({ amountCents }).ok, false);
  assert.equal(fixture({ executionDate: '2026-02-30' }).ok, false);
  assert.equal(fixture({ recipient: { ...recipient, bankType: 'iban', iban: 'SE4550000000058398257467' } }).ok, false);
  assert.equal(fixture({ debtorAccount: { ...account, bban: '12345' } }).ok, false);
  assert.equal(fixture({ debtorAccount: { ...account, currency: 'EUR' } }).error.code, 'bank_currency_unsupported');
});
test('sandbox configuration rejects production mode or host override before any HTTP call', async () => {
  for (const change of [{ OPENPAYMENTS_ENVIRONMENT: 'production' }, { OPENPAYMENTS_API_BASE_URL: 'https://api.openbankingplatform.com' },
    { OPENPAYMENTS_AUTH_BASE_URL: 'https://attacker.invalid' }, { OPENPAYMENTS_CLIENT_SECRET: '' }]) {
    let calls = 0; const client = createOpenPaymentsClient({ env: { ...env(), ...change }, fetchImpl: async () => { calls++; throw new Error(); } });
    assert.equal(client.configuration().ready, false); assert.equal((await client.banks()).ok, false); assert.equal(calls, 0);
  }
});
test('token exchange follows fixed sandbox OAuth form contract, bank query and one shared cached corporate token', async () => {
  const { client, calls } = clientMock(call => call.url.endsWith('/SWEDSESS') ? reply(bankDetails) : reply({ aspsps: [{ bicFi: 'SWEDSESS', name: 'Swedbank' }] }));
  const [list, detail, testResult] = await Promise.all([client.banks(), client.bankDetails('SWEDSESS'), client.testConnection()]);
  assert.equal(list.ok, true); assert.equal(detail.ok, true); assert.equal(testResult.bankCount, 1);
  const exchanges = calls.filter(call => call.url === `${OPENPAYMENTS_SANDBOX_OAUTH}/connect/token`);
  assert.equal(exchanges.length, 1);
  const form = new URLSearchParams(exchanges[0].body);
  assert.equal(form.get('client_id'), 'sandbox-client'); assert.equal(form.get('client_secret'), env().OPENPAYMENTS_CLIENT_SECRET);
  assert.equal(form.get('scope'), 'accountinformation paymentinitiation corporate'); assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.has('redirect_uri'), false);
  assert.ok(calls.every(call => call.redirect === 'error'));
  const request = calls.find(call => call.url.startsWith(OPENPAYMENTS_SANDBOX_API));
  assert.ok(request.url.endsWith('/psd2/aspspinformation/v1/aspsps?isoCountryCodes=SE'));
  assert.match(request.headers['X-Request-ID'], /^[0-9a-f-]{36}$/); assert.equal(request.headers.Authorization, 'Bearer test-bearer-token-private');
  assert.equal(JSON.stringify(testResult).includes('test-bearer-token-private'), false);
});
test('token cache expires and rotated credentials invalidate the old token; provider 401 is never automatically replayed', async () => {
  let clock = 0, denied = false; const settings = env();
  const { client, calls } = clientMock(() => denied ? reply({ error: 'invalid_token' }, 401) : reply({ aspsps: [] }), { env: settings, now: () => clock });
  await client.banks(); await client.banks(); assert.equal(calls.filter(call => call.url.includes('/connect/token')).length, 1);
  clock = 3600000; await client.banks(); assert.equal(calls.filter(call => call.url.includes('/connect/token')).length, 2);
  settings.OPENPAYMENTS_CLIENT_SECRET = 'replacement-test-secret'; await client.banks(); assert.equal(calls.filter(call => call.url.includes('/connect/token')).length, 3);
  denied = true; const before = calls.length; assert.equal((await client.banks()).ok, false); assert.equal(calls.length, before + 1);
  denied = false; await client.banks(); assert.equal(calls.filter(call => call.url.includes('/connect/token')).length, 4);
});
test('AIS consent/account/balance requests carry exact consent and PSU context without exposing credentials in diagnostics', async () => {
  const { client, calls } = clientMock(call => call.method === 'POST' ? reply({ consentId: 'consent-1', consentStatus: 'received' }, 201)
    : call.url.endsWith('/status') ? reply({ consentStatus: 'valid' }) : call.url.endsWith('/balances') ? reply({ balances: [{ balanceAmount: { amount: '1000.00', currency: 'SEK' }, balanceType: 'interimAvailable' }] })
      : reply({ accounts: [{ resourceId: 'account-1', ...account }] }));
  assert.equal((await client.createConsent({ ...context, payload: { access: {}, combinedServiceIndicator: false, frequencyPerDay: 4, recurringIndicator: true, validUntil: '2026-12-31' } })).ok, true);
  assert.equal((await client.readConsentStatus({ ...context, id: 'consent-1' })).data.consentStatus, 'valid');
  const list = await client.accounts({ ...context, consentId: 'consent-1' }); assert.equal(list.data.accounts[0].iban, account.iban);
  const balances = await client.balances({ ...context, consentId: 'consent-1', accountId: 'account-1' }); assert.equal(balances.ok, true);
  const ais = calls.filter(call => call.url.includes('/accountinformation/'));
  assert.equal(ais.length, 2); for (const call of ais) {
    assert.equal(call.headers['Consent-ID'], 'consent-1'); assert.equal(call.headers['X-BicFi'], context.bankId);
    assert.equal(call.headers['PSU-ID'], context.psuId); assert.equal(call.headers['PSU-Corporate-ID'], context.corporateId);
    assert.equal(call.headers['PSU-IP-Address'], context.psuIp); assert.equal(call.headers['X-Feature-Flags'], 'new-balances');
  }
  assert.equal(JSON.stringify(list.journal).includes(account.iban), false);
  const count = calls.length; assert.equal((await client.accounts({ ...context })).ok, false); assert.equal(calls.length, count);
});
test('payment POST preserves exact frozen payload and trace ID; status GET does not create or authorise anything', async () => {
  const frozen = fixture();
  const { client, calls } = clientMock(call => call.method === 'POST' ? reply({ paymentId: 'payment-1', transactionStatus: 'RCVD' }, 201)
    : call.url.endsWith('/status') ? reply({ transactionStatus: 'ACSC' }) : reply({ ...frozen.payload, transactionStatus: 'ACSC' }));
  const created = await client.createPayment({ ...context, requestId, product: frozen.product, payload: frozen.payload });
  assert.equal(created.ok, true); assert.equal(created.data.paymentId, 'payment-1');
  const post = calls.find(call => call.url.includes('/paymentinitiation/'));
  assert.equal(post.url, `${OPENPAYMENTS_SANDBOX_API}/psd2/paymentinitiation/v1/payments/domestic`);
  assert.equal(post.headers['X-Request-ID'], requestId); assert.deepEqual(JSON.parse(post.body), frozen.payload);
  const read = await client.readPayment({ ...context, product: 'domestic', id: 'payment-1' });
  assert.equal(read.data.instructedAmount.amount, '240.00'); assert.equal(read.data.creditorAccount.bban, `${recipient.clearing}${recipient.account}`);
  assert.equal((await client.readPaymentStatus({ ...context, product: 'domestic', id: 'payment-1' })).data.transactionStatus, 'ACSC');
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.startsWith(OPENPAYMENTS_SANDBOX_API)).length, 1);
  assert.equal(JSON.stringify(created.journal).includes(account.iban), false);
  assert.equal(JSON.stringify(created.journal).includes(recipient.account), false);
});
test('payment POST unknown result is uncertain and never retried; unverified 201 also holds the durable reservation', async () => {
  for (const response of ['throw', 'malformed', 'conflict', 'server']) {
    const { client, calls } = clientMock(() => {
      if (response === 'throw') throw new Error('secret leaked in network exception');
      return response === 'malformed' ? reply({ transactionStatus: 'RCVD' }, 201) : reply({ tppMessages: [{ code: 'BANK_UNAVAILABLE', text: env().OPENPAYMENTS_CLIENT_SECRET }] }, response === 'conflict' ? 409 : 503);
    });
    const result = await client.createPayment({ ...context, product: 'domestic', payload: fixture().payload });
    assert.equal(result.ok, false); assert.equal(result.uncertain, true);
    assert.equal(calls.filter(call => call.url.includes('/paymentinitiation/')).length, 1);
    assert.equal(JSON.stringify(result).includes(env().OPENPAYMENTS_CLIENT_SECRET), false);
    assert.equal(JSON.stringify(result).includes('network exception'), false);
  }
});
test('invalid context, path traversal, FX/production products and unexpected payment fields never reach provider', async () => {
  const { client, calls } = clientMock(() => { throw new Error('must not reach provider'); });
  for (const product of ['sepa-credit-transfers', 'cross-border', '../../production', undefined]) assert.equal((await client.createPayment({ ...context, product, payload: fixture().payload })).ok, false);
  assert.equal((await client.createPayment({ ...context, product: 'domestic', payload: { ...fixture().payload, callbackUrl: 'https://attacker.invalid' } })).ok, false);
  assert.equal((await client.createPayment({ ...context, product: 'domestic', payload: { ...fixture().payload, instructedAmount: { amount: '240.00', currency: 'EUR' } } })).ok, false);
  assert.equal((await client.readPayment({ ...context, product: 'domestic', id: '../other-payment' })).ok, false);
  assert.equal((await client.createPayment({ ...context, psuIp: 'localhost', product: 'domestic', payload: fixture().payload })).ok, false);
  assert.equal((await client.createPayment({ ...context, requestId: 'invalid', product: 'domestic', payload: fixture().payload })).ok, false);
  assert.equal(calls.length, 0);
});
test('bank authorisation POST and method-selection PUT are distinct; redirect link is restricted and correctly populated', async () => {
  const { client, calls } = clientMock(call => call.method === 'POST' ? reply({ authorisationId: 'authorisation-1', scaStatus: 'received', scaMethods: [{ authenticationMethodId: 'mbid' }] }, 201)
    : call.method === 'PUT' ? reply({ scaStatus: 'started', _links: { scaOAuth: { href: 'https://auth.sandbox.openbankingplatform.com/connect/authorize?client_id=[CLIENT_ID]&redirect_uri=[TPP_REDIRECT_URI]&state=[TPP_STATE]&acr_values=idp:SWEDSESS%20paymentId:payment-1' } } }, 200, { 'aspsp-sca-approach': 'REDIRECT' })
      : reply({ scaStatus: 'finalised' }));
  const options = { ...context, resource: 'payment', product: 'domestic', id: 'payment-1', redirectUri: 'https://test.scrappilot.example/api/bank/callback', state: 'one_time_tenant_bound_state_123' };
  assert.equal((await client.createAuthorisation(options)).ok, true);
  const result = await client.startAuthorisation({ ...options, authorisationId: 'authorisation-1', authenticationMethodId: 'mbid' });
  assert.equal(result.ok, true); assert.equal(result.scaApproach, 'REDIRECT');
  const link = new URL(result.authorisationUrl); assert.equal(link.origin, 'https://auth.sandbox.openbankingplatform.com');
  assert.equal(link.searchParams.get('client_id'), 'sandbox-client'); assert.equal(link.searchParams.get('redirect_uri'), options.redirectUri);
  assert.equal(link.searchParams.get('state'), options.state); assert.equal(link.searchParams.get('scope'), 'paymentinitiation corporate');
  assert.equal(link.searchParams.get('acr_values'), 'idp:SWEDSESS paymentId:payment-1 PaymentAuthorisationId:authorisation-1');
  const put = calls.find(call => call.method === 'PUT'); assert.deepEqual(JSON.parse(put.body), { authenticationMethodId: 'mbid' });
  assert.equal(put.headers['TPP-Redirect-URI'], options.redirectUri);
  assert.equal((await client.readAuthorisation({ ...options, authorisationId: 'authorisation-1' })).data.scaStatus, 'finalised');
});
test('unsafe authorisation links, HTTP callback and missing authentication method are blocked', async () => {
  for (const href of ['https://auth.openbankingplatform.com/connect/authorize', 'https://attacker.invalid/connect/authorize', 'https://auth.sandbox.openbankingplatform.com@attacker.invalid/connect/authorize', 'https://auth.sandbox.openbankingplatform.com/not-authorize']) {
    const { client } = clientMock(() => reply({ _links: { scaOAuth: { href } } }));
    const result = await client.startAuthorisation({ ...context, product: 'domestic', id: 'payment-1', authorisationId: 'auth-1', authenticationMethodId: 'mbid',
      redirectUri: 'https://test.scrappilot.example/callback', state: 'long_enough_state_123' });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'bank_authorisation_link_invalid');
  }
  const { client, calls } = clientMock(() => { throw new Error(); });
  assert.equal((await client.startAuthorisation({ ...context, product: 'domestic', id: 'payment-1', authorisationId: 'auth-1', authenticationMethodId: 'mbid', redirectUri: 'http://localhost/callback' })).ok, false);
  assert.equal((await client.startAuthorisation({ ...context, product: 'domestic', id: 'payment-1', authorisationId: 'auth-1' })).ok, false);
  assert.equal(calls.length, 0);
});
test('the real sandbox lowercase consent selector is preserved while all resource values come from the bound request', async () => {
  const {client}=clientMock(()=>reply({scaStatus:'started',_links:{scaOAuth:{href:'https://oauth.sandbox.openbankingplatform.com/connect/authorize?acr_values=idp:WRONGSESS%20consentId:other-consent%20consentAuthorisationId:other-auth'}}}));
  const options={...context,resource:'consent',id:'bound-consent',authorisationId:'bound-auth',authenticationMethodId:'mbid',
    redirectUri:'https://test.scrappilot.example/callback',state:'bound_new_oauth_state_123456789'};
  const result=await client.startAuthorisation(options);assert.equal(result.ok,true);
  const url=new URL(result.authorisationUrl);
  assert.equal(url.searchParams.get('acr_values'),`idp:${context.bankId} consentId:bound-consent consentAuthorisationId:bound-auth`);
  assert.equal(url.searchParams.get('state'),options.state);assert.equal(url.searchParams.get('scope'),'accountinformation corporate');
  assert.equal(url.toString().includes('other-consent'),false);
});
test('fresh OAuth links for a started existing consent require no provider write and carry fresh bound state', async () => {
  const {client,calls}=clientMock(()=>{throw new Error('No HTTP call is needed to renew a started OAuth authorisation');});
  const options={...context,resource:'consent',id:'same-consent',authorisationId:'same-auth',
    redirectUri:'https://test.scrappilot.example/callback',state:'fresh_oauth_state_123456789'};
  const result=client.renewAuthorisation(options);assert.equal(result.ok,true);assert.equal(calls.length,0);
  const url=new URL(result.authorisationUrl);assert.equal(url.origin,'https://oauth.sandbox.openbankingplatform.com');
  assert.equal(url.searchParams.get('acr_values'),`idp:${context.bankId} consentId:same-consent consentAuthorisationId:same-auth`);
  assert.equal(url.searchParams.get('state'),options.state);
  // An explicit registered callback configuration rejects any other URI.
  const bound=createOpenPaymentsClient({env:{...env(),OPENPAYMENTS_REDIRECT_URI:options.redirectUri}});
  assert.equal(bound.renewAuthorisation({...options,redirectUri:'https://attacker.invalid/callback'}).ok,false);
  assert.equal(client.renewAuthorisation({...options,resource:'production'}).ok,false);
});
test('callback activation uses documented resource headers and discards its token; it does not claim payment completion', async () => {
  for (const resource of ['payment', 'consent']) {
    const { client, calls } = clientMock(() => reply({ access_token: 'callback-secret-token', token_type: 'Bearer', expires_in: 3600 }));
    const result = await client.completeAuthorisation({ ...context, resource, product: 'domestic', id: 'resource-1', authorisationId: 'auth-1',
      code: 'one-time-code', redirectUri: 'https://test.scrappilot.example/callback' });
    assert.equal(result.ok, true); assert.deepEqual(result.data, { activated: true });
    assert.equal(JSON.stringify(result).includes('callback-secret-token'), false); assert.equal(JSON.stringify(result).includes('one-time-code'), false);
    assert.equal(calls.length, 1);
    const form = new URLSearchParams(calls[0].body); assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('scope'), resource === 'consent' ? 'accountinformation corporate' : 'paymentinitiation corporate');
    assert.equal(calls[0].headers[`X-${resource}Id`], 'resource-1'); assert.equal(calls[0].headers[`X-${resource === 'consent' ? 'Consent' : 'Payment'}AuthorisationId`], 'auth-1');
  }
});
test('a rejected OAuth code exchange keeps safe provider diagnostics without retaining one-use codes or tokens', async () => {
  const settings=env(),code='synthetic-expired-callback-code';
  const client=createOpenPaymentsClient({env:settings,fetchImpl:async()=>reply({error:'invalid_grant',
    error_description:`Rejected ${code}; secret ${settings.OPENPAYMENTS_CLIENT_SECRET}`,access_token:'synthetic-echoed-access-token'},400)});
  const result=await client.completeAuthorisation({...context,resource:'consent',id:'consent-1',authorisationId:'auth-1',code,
    redirectUri:'https://test.scrappilot.example/callback'});
  assert.equal(result.ok,false);assert.equal(result.statusCode,400);assert.equal(result.uncertain,false);
  assert.deepEqual(result.error.providerCodes,['invalid_grant']);assert.equal(result.journal.statusCode,400);
  const serialized=JSON.stringify(result);
  for(const secret of [code,settings.OPENPAYMENTS_CLIENT_SECRET,'synthetic-echoed-access-token'])assert.equal(serialized.includes(secret),false);
  const reflected=createOpenPaymentsClient({env:settings,fetchImpl:async()=>reply({error:code,errors:[{code:settings.OPENPAYMENTS_CLIENT_SECRET}]},400)});
  const reflectedResult=await reflected.completeAuthorisation({...context,resource:'consent',id:'consent-1',authorisationId:'auth-1',code,
    redirectUri:'https://test.scrappilot.example/callback'});
  assert.deepEqual(reflectedResult.error.providerCodes,[]);
  for(const secret of [code,settings.OPENPAYMENTS_CLIENT_SECRET])assert.equal(JSON.stringify(reflectedResult).includes(secret),false);
});
test('connection errors redact reflected client secrets and access tokens; malicious or oversized responses do not enter journals', async () => {
  const settings = env();
  const client = createOpenPaymentsClient({ env: settings, fetchImpl: async () => reply({ error: 'invalid_client', message: `Invalid secret ${settings.OPENPAYMENTS_CLIENT_SECRET}` }, 401) });
  const denied = await client.testConnection(); assert.equal(denied.ok, false); assert.equal(JSON.stringify(denied).includes(settings.OPENPAYMENTS_CLIENT_SECRET), false);
  const { client: oversized } = clientMock(() => new Response('x'.repeat(512 * 1024 + 1), { status: 200 }));
  const result = await oversized.banks(); assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('xxxxx'), false);
  assert.deepEqual(safeOpenPaymentsData({ iban: account.iban, accountNumber: recipient.account, access_token: 'raw', code: 'raw', message: `Account ${account.iban}` }),
    { iban: '••••7466', accountNumber: '••••7466', access_token: '[redacted]', code: '[redacted]', message: 'Account [redacted]' });
});
test('network timeout aborts one uncertain payment POST and never retries; provider redirects are not followed', async () => {
  let postCount = 0;
  const { client } = clientMock(call => new Promise((resolve, reject) => {
    postCount++;
    call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 100 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const timed = await client.createPayment({ ...context, product: 'domestic', payload: fixture().payload });
    assert.equal(timed.ok, false); assert.equal(timed.uncertain, true); assert.equal(postCount, 1);
  } finally { clearTimeout(keepAlive); }
  const { client: redirected, calls } = clientMock(() => new Response(null, { status: 307, headers: { Location: 'https://api.openbankingplatform.com/production' } }));
  const result = await redirected.createPayment({ ...context, product: 'domestic', payload: fixture().payload });
  assert.equal(result.error.code, 'bank_redirect_forbidden'); assert.equal(result.uncertain, true);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.redirect === 'error'));
  assert.ok(calls.every(call => !call.url.includes('api.openbankingplatform.com/production')));
});
