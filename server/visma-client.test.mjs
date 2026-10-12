import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  VISMA_SCOPES,
  VISMA_OPERATIONS,
  readVismaConfiguration,
  parseVismaSandboxInput,
  createVismaClient,
} from './visma-client.mjs';

const apiUrl = 'https://eaccountingapi.vismaonline.com/v2';
const authorizeUrl = 'https://identity.vismaonline.com/connect/authorize';
const tokenUrl = 'https://identity.vismaonline.com/connect/token';
const fiscalYearId = '129c42dd-dc45-4fdc-927c-1c3d96772c28';
const supplierId = 'd7c11854-0357-4107-a8de-1c578d1d8567';
const termsId = '8cf28396-08bd-4582-b120-8b4bf3e4c203';
const draftId = 'f3aa4bd5-d538-4bd2-bd43-136989674513';
const accessToken = 'fixture-only-access-token';
const refreshToken = 'fixture-only-refresh-token';
const verifier = 'fixture-only-pkce-verifier-012345678901234567890123456789';
const supplierPayload = {
  Name: 'JEROC Sandbox Leverantör AB',
  TermsOfPaymentId: termsId,
  CountryCode: 'SE',
  CurrencyCode: 'SEK',
  IsActive: true,
  UsesAutomaticSupplierInvoiceApproval: false,
  UsesAutomaticInvoicePostToLedger: false,
};
const draftPayload = {
  SupplierId: supplierId,
  IsCreditInvoice: false,
  InvoiceDate: '2026-10-11',
  DueDate: '2026-11-10',
  InvoiceNumber: 'JEROC-TEST-001',
  CurrencyCode: 'SEK',
  TotalAmount: 100,
  Vat: 0,
  SkipSendToBank: true,
  Rows: [
    { AccountNumber: 4000, DebitAmount: 100, CreditAmount: 0, LineNumber: 1 },
    { AccountNumber: 2440, DebitAmount: 0, CreditAmount: 100, LineNumber: 2 },
  ],
};

function fixture({ extra = {}, respond = () => new Response(JSON.stringify({ Id: supplierId }), { status: 201 }) } = {}) {
  // These strings are public local test data and identify no real Visma client.
  const env = {
    VISMA_ENVIRONMENT: 'sandbox',
    VISMA_CLIENT_ID: 'fixture-only-client-id',
    VISMA_CLIENT_SECRET: 'fixture-only-client-secret',
    VISMA_REDIRECT_URI: 'https://jeroc.example.invalid/api/integrations/visma/oauth/callback',
    VISMA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    VISMA_SANDBOX_COMPANY_ID: 'fixture-only-sandbox-company',
    ...extra,
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = { url: String(url), ...options, headers: new Headers(options.headers) };
    calls.push(call);
    return respond(call);
  };
  return { env, calls, client: createVismaClient({ env, fetchImpl }) };
}

const sandboxInput = (operation = 'createSupplier', payload = supplierPayload, parameters = {}) => ({
  requestId: randomUUID(), idempotencyKey: randomUUID(), operation, parameters, payload,
});
const assertNoSecrets = (value, secrets) => {
  const json = JSON.stringify(value);
  for (const secret of secrets) assert.equal(json.includes(secret), false, `Diagnostic leaked ${secret}`);
};

test('Visma configuration is disabled by default and reports missing sandbox requirements without secrets', () => {
  const disabled = readVismaConfiguration({});
  assert.equal(disabled.mode, 'disabled');
  assert.equal(disabled.configured, false);
  const incomplete = readVismaConfiguration({ VISMA_ENVIRONMENT: 'sandbox' });
  assert.equal(incomplete.mode, 'sandbox');
  assert.equal(incomplete.configured, false);
  for (const name of ['VISMA_CLIENT_ID', 'VISMA_CLIENT_SECRET', 'VISMA_REDIRECT_URI', 'VISMA_TOKEN_ENCRYPTION_KEY'])
    assert.ok(incomplete.missing.includes(name), `Missing requirement: ${name}`);
  const f = fixture(), complete = readVismaConfiguration(f.env);
  assert.equal(complete.configured, true);
  assert.deepEqual(complete.missing, []);
  assert.equal(complete.redirectUri, f.env.VISMA_REDIRECT_URI);
  assert.equal(complete.expectedCompanyId, f.env.VISMA_SANDBOX_COMPANY_ID);
  assertNoSecrets(complete, [f.env.VISMA_CLIENT_SECRET, f.env.VISMA_TOKEN_ENCRYPTION_KEY]);
});

test('Visma sandbox OAuth uses the documented scopes and PKCE S256 at the fixed identity host', () => {
  const f = fixture(), state = randomUUID();
  const url = new URL(f.client.authorizationUrl({ state, verifier }));
  assert.equal(`${url.origin}${url.pathname}`, authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), f.env.VISMA_CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), f.env.VISMA_REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), state);
  // The user's assigned sandbox client grants these scopes; the narrower
  // readonly aliases are not supported by that client registration.
  const scopes = ['ea:api', 'offline_access', 'ea:purchase', 'ea:accounting', 'ea:sales'];
  const exported = Array.isArray(VISMA_SCOPES) ? VISMA_SCOPES : VISMA_SCOPES.split(/\s+/);
  assert.deepEqual([...exported].sort(), [...scopes].sort());
  assert.deepEqual(url.searchParams.get('scope').split(/\s+/).sort(), [...scopes].sort());
  assert.equal(url.searchParams.get('prompt'), 'select_account');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('code_verifier'), false);
  assert.equal(f.calls.length, 0);
});

test('Visma operation inventory excludes approval, booking, payments and attachments', () => {
  const operations = Array.isArray(VISMA_OPERATIONS)
    ? VISMA_OPERATIONS.map(item => typeof item === 'string' ? item : item.id ?? item.operation)
    : Object.keys(VISMA_OPERATIONS);
  assert.deepEqual([...operations].sort(), ['company', 'fiscalYears', 'accounts', 'paymentTerms', 'vatCodes', 'costCenters', 'projects', 'suppliers', 'supplier', 'draft', 'invoice', 'invoices', 'createSupplier', 'createDraft'].sort());
});

test('Visma disabled, incomplete and invalid configuration fails locally before OAuth or API requests', async () => {
  const invalid = [
    { VISMA_ENVIRONMENT: undefined }, { VISMA_ENVIRONMENT: 'production' }, { VISMA_ENVIRONMENT: 'mock' },
    ...['VISMA_CLIENT_ID', 'VISMA_CLIENT_SECRET', 'VISMA_REDIRECT_URI', 'VISMA_TOKEN_ENCRYPTION_KEY'].map(name => ({ [name]: undefined })),
    { VISMA_TOKEN_ENCRYPTION_KEY: 'not-a-32-byte-base64-key' },
    { VISMA_REDIRECT_URI: 'http://jeroc.example.invalid/api/integrations/visma/oauth/callback' },
    { VISMA_REDIRECT_URI: 'https://jeroc.example.invalid/api/integrations/visma/oauth/callback#fragment' },
    { VISMA_REDIRECT_URI: 'https://jeroc.example.invalid/api/integrations/visma/oauth/callback?next=https://wrong.invalid' },
    { VISMA_REDIRECT_URI: 'https://client:secret@jeroc.example.invalid/api/integrations/visma/oauth/callback' },
    { VISMA_REDIRECT_URI: 'https://jeroc.example.invalid/unregistered-callback' },
  ];
  for (const extra of invalid) {
    const f = fixture({ extra });
    assert.equal(readVismaConfiguration(f.env).configured, false);
    assert.throws(() => f.client.authorizationUrl({ state: randomUUID(), verifier }), error => error.code === 'visma_not_configured');
    await assert.rejects(async () => f.client.exchangeCode({ code: 'fixture-only-code', verifier }), error => error.code === 'visma_not_configured');
    await assert.rejects(() => f.client.refreshToken(refreshToken), error => error.code === 'visma_not_configured');
    await assert.rejects(() => f.client.request({ operation: 'company', accessToken }), error => error.code === 'visma_not_configured');
    assert.equal(f.calls.length, 0);
  }
});

test('Visma permits a local development callback, requires HTTPS in production, and treats company pin as optional configuration', () => {
  const local = 'http://localhost:5173/api/integrations/visma/oauth/callback';
  const f = fixture({ extra: { VISMA_REDIRECT_URI: local, VISMA_SANDBOX_COMPANY_ID: undefined } });
  assert.equal(readVismaConfiguration(f.env).configured, true);
  assert.equal(readVismaConfiguration(f.env).expectedCompanyId, null);
  assert.equal(readVismaConfiguration({ ...f.env, NODE_ENV: 'production' }).configured, false);
  assert.equal(readVismaConfiguration({ ...f.env, RENDER: 'true' }).configured, false);
});

test('localhost relay is explicit, sandbox-only and restricted to the already registered HTTPS URI', () => {
  const f = fixture({ extra: { VISMA_REDIRECT_URI: 'https://localhost:44300/callback', NODE_ENV: 'production', RENDER: 'true' } });
  assert.equal(readVismaConfiguration(f.env).configured, false);
  const enabled = { ...f.env, VISMA_OAUTH_LOCAL_RELAY: 'true' };
  assert.equal(readVismaConfiguration(enabled).configured, true);
  assert.equal(readVismaConfiguration(enabled).localCallbackRelay, true);
  for (const uri of ['http://localhost:44300/callback', 'https://127.0.0.1:44300/callback', 'https://localhost:44301/callback',
    'https://localhost:44300/other', 'https://localhost:44300/callback?next=evil', 'https://localhost:44300/callback#fragment',
    'https://user:password@localhost:44300/callback', 'https://elsewhere.invalid/callback']) {
    assert.equal(readVismaConfiguration({ ...enabled, VISMA_REDIRECT_URI: uri }).configured, false);
  }
  assert.equal(readVismaConfiguration({ ...enabled, VISMA_ENVIRONMENT: 'production' }).configured, false);
});

test('Visma code exchange and refresh use the fixed token URL, Basic authentication and exact form grants', async () => {
  const f = fixture({ respond: () => new Response(JSON.stringify({
    access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600,
    scope: VISMA_SCOPES.join(' '),
  }), { status: 200 }) });
  const code = 'fixture-only-authorization-code';
  const tokens = await f.client.exchangeCode({ code, verifier });
  assert.deepEqual(tokens, { accessToken, refreshToken, expiresIn: 3600, scopes: [...VISMA_SCOPES] });
  await f.client.refreshToken(refreshToken);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.url, tokenUrl);
    assert.equal(call.method, 'POST');
    assert.match(call.headers.get('content-type'), /^application\/x-www-form-urlencoded(?:;.*)?$/i);
    assert.equal(call.headers.get('accept'), 'application/json');
    assert.equal(call.headers.get('authorization'), `Basic ${Buffer.from(`${f.env.VISMA_CLIENT_ID}:${f.env.VISMA_CLIENT_SECRET}`).toString('base64')}`);
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    const form = new URLSearchParams(call.body);
    assert.equal(form.has('client_secret'), false);
    assert.equal(form.has('client_id'), false);
  }
  assert.deepEqual(Object.fromEntries(new URLSearchParams(f.calls[0].body)), {
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: f.env.VISMA_REDIRECT_URI,
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(f.calls[1].body)), { grant_type: 'refresh_token', refresh_token: refreshToken });
});

test('Visma refresh returns the newly rotated token pair and retains the old refresh token when the provider omits it', async () => {
  const f = fixture({ respond: call => new Response(JSON.stringify({
    access_token: `${accessToken}-new`, ...(call.body.includes('rotated') ? {} : { refresh_token: `${refreshToken}-rotated` }),
    token_type: 'Bearer', expires_in: 7200,
  }), { status: 200 }) });
  const rotated = await f.client.refreshToken(refreshToken);
  assert.equal(rotated.accessToken, `${accessToken}-new`);
  assert.equal(rotated.refreshToken, `${refreshToken}-rotated`);
  assert.equal(rotated.expiresIn, 7200);
  const retained = await f.client.refreshToken(rotated.refreshToken);
  assert.equal(retained.refreshToken, rotated.refreshToken);
  assert.equal(f.calls.length, 2);
});

test('Visma OAuth rejects malformed tokens and provider errors with a safe error and no automatic retry', async () => {
  const valid = { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 };
  const replies = [
    [400, { error: 'invalid_client', error_description: 'fixture-only-client-secret' }],
    [503, { message: 'fixture-only-client-secret' }],
    [200, null], [200, {}], [200, { ...valid, access_token: '' }],
    [200, { ...valid, refresh_token: '' }], [200, { ...valid, expires_in: 0 }],
    [200, { ...valid, expires_in: 'not-a-number' }], [200, { ...valid, expires_in: 2592001 }],
  ];
  for (const [status, body] of replies) {
    const f = fixture({ respond: () => new Response(JSON.stringify(body), { status }) });
    await assert.rejects(() => f.client.exchangeCode({ code: 'fixture-only-code', verifier }), error => {
      assert.equal(error.code, 'visma_oauth_failed');
      assertNoSecrets(error, [f.env.VISMA_CLIENT_SECRET, 'fixture-only-code', verifier, accessToken, refreshToken]);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const dropped = fixture({ respond: () => { throw new Error(`Dropped ${accessToken} ${refreshToken}`); } });
  await assert.rejects(() => dropped.client.refreshToken(refreshToken), error => error.code === 'visma_oauth_failed' && !error.message.includes(refreshToken));
  assert.equal(dropped.calls.length, 1);
});

test('Visma parser accepts documented supplier and accounting draft fields and forces safe automation defaults', () => {
  const supplier = parseVismaSandboxInput(sandboxInput('createSupplier', { Name: 'Sandbox Privatperson', TermsOfPaymentId: termsId }));
  assert.deepEqual(supplier.payload, {
    Name: 'Sandbox Privatperson', TermsOfPaymentId: termsId,
    UsesAutomaticSupplierInvoiceApproval: false, UsesAutomaticInvoicePostToLedger: false,
  });
  const draft = parseVismaSandboxInput(sandboxInput('createDraft', { ...draftPayload, SkipSendToBank: undefined }));
  assert.equal(draft.payload.SkipSendToBank, true);
  assert.deepEqual(draft.payload.Rows, draftPayload.Rows);
  const nullableSupplier = { ...supplierPayload, CorporateIdentityNumber: null, VatNumber: null, Address1: null };
  assert.deepEqual(parseVismaSandboxInput(sandboxInput('createSupplier', nullableSupplier)).payload, nullableSupplier);
});

test('Visma parser restricts operation parameters and rejects endpoint, credential and method overrides', () => {
  const validRead = operation => ({ requestId: randomUUID(), idempotencyKey: randomUUID(), operation });
  for (const operation of ['company', 'fiscalYears', 'paymentTerms', 'suppliers'])
    assert.equal(parseVismaSandboxInput(validRead(operation)).operation, operation);
  for (const [operation, parameters] of [['accounts', { fiscalYearId }], ['supplier', { resourceId: supplierId }], ['draft', { resourceId: draftId }]])
    assert.deepEqual(parseVismaSandboxInput({ ...validRead(operation), parameters }).parameters, parameters);
  const invalid = [
    { ...validRead('company'), payload: {} },
    { ...validRead('approveDraft') },
    { ...validRead('company'), method: 'POST' },
    { ...validRead('company'), path: '/supplierinvoices' },
    { ...validRead('company'), url: 'https://wrong.invalid/api' },
    { ...validRead('company'), headers: { Authorization: 'Bearer injected' } },
    { ...validRead('company'), accessToken: 'injected-token' },
    { ...validRead('company'), parameters: { fiscalYearId } },
    { ...validRead('accounts'), parameters: {} },
    { ...validRead('supplier'), parameters: { resourceId: `${supplierId}?next=https://wrong.invalid` } },
    { ...validRead('draft'), parameters: { resourceId: '../supplierinvoices' } },
    { ...validRead('accounts'), parameters: { fiscalYearId, resourceId: supplierId } },
    { ...validRead('company'), parameters: { '$filter': 'authorization eq secret' } },
  ];
  for (const input of invalid) assert.throws(() => parseVismaSandboxInput(input), error => error.code === 'visma_invalid');
});

test('Visma parser rejects hidden secrets, prototypes, read-only fields and unsafe automation throughout payloads', () => {
  const invalidSuppliers = [
    { ...supplierPayload, clientSecret: 'injected-secret' }, { ...supplierPayload, Authorization: 'injected-secret' },
    { ...supplierPayload, Id: supplierId }, { ...supplierPayload, IsPrivatePerson: true },
    { ...supplierPayload, UsesAutomaticSupplierInvoiceApproval: true }, { ...supplierPayload, UsesAutomaticInvoicePostToLedger: true },
    { ...supplierPayload, constructor: 'injected' },
    JSON.parse(JSON.stringify(supplierPayload).replace(/}$/, ',"__proto__":{"polluted":true}}')),
  ];
  for (const payload of invalidSuppliers) assert.throws(() => parseVismaSandboxInput(sandboxInput('createSupplier', payload)), error => error.code === 'visma_invalid');
  const invalidDrafts = [
    { ...draftPayload, SkipSendToBank: false }, { ...draftPayload, PaymentDate: '2026-10-11' },
    { ...draftPayload, IsApproved: true }, { ...draftPayload, url: 'https://wrong.invalid' },
    { ...draftPayload, Rows: [{ AccountNumber: supplierId, DebitAmount: 100 }] },
    { ...draftPayload, Rows: [{ AccountNumber: 4000, DebitAmount: 100.001 }] },
    { ...draftPayload, Rows: [{ AccountNumber: 4000, DebitAmount: 100, headers: {} }] },
    { ...draftPayload, Rows: [{ AccountNumber: 4000, Weight: 100 }] },
    { ...draftPayload, Rows: [JSON.parse('{"AccountNumber":4000,"__proto__":{"polluted":true}}')] },
  ];
  for (const payload of invalidDrafts) assert.throws(() => parseVismaSandboxInput(sandboxInput('createDraft', payload)), error => error.code === 'visma_invalid');
  assert.equal(Object.prototype.polluted, undefined);
});

test('Visma parser bounds JSON and rejects unserializable input before validation', () => {
  assert.throws(() => parseVismaSandboxInput(sandboxInput('createSupplier', { ...supplierPayload, Note: 'x'.repeat(128 * 1024) })), error => error.status === 413 && error.code === 'payload_too_large');
  const circular = sandboxInput(); circular.payload = circular;
  assert.throws(() => parseVismaSandboxInput(circular), error => error.code === 'visma_invalid');
  assert.throws(() => parseVismaSandboxInput(sandboxInput('createDraft', { ...draftPayload, TotalAmount: Infinity })), error => error.code === 'visma_invalid');
});

test('Visma client maps each permitted operation to its documented method and route with server-side bearer authentication', async () => {
  const operations = [
    ['company', {}, undefined, 'GET', '/companysettings'],
    ['fiscalYears', {}, undefined, 'GET', '/fiscalyears'],
    ['accounts', { fiscalYearId }, undefined, 'GET', `/accounts/${fiscalYearId}`],
    ['paymentTerms', {}, undefined, 'GET', '/termsofpayments'],
    ['suppliers', {}, undefined, 'GET', '/suppliers'],
    ['supplier', { resourceId: supplierId }, undefined, 'GET', `/suppliers/${supplierId}`],
    ['draft', { resourceId: draftId }, undefined, 'GET', `/supplierinvoicedrafts/${draftId}`],
    ['createSupplier', {}, supplierPayload, 'POST', '/suppliers'],
    ['createDraft', {}, draftPayload, 'POST', '/supplierinvoicedrafts'],
  ];
  for (const [operation, parameters, payload, method, path] of operations) {
    const write = method === 'POST', resourceId = operation === 'createDraft' ? draftId : supplierId;
    const body = write ? { Id: resourceId } : { Meta: { TotalNumberOfPages: 2 }, Data: [] };
    const f = fixture({ respond: () => new Response(JSON.stringify(body), { status: write ? 201 : 200 }) });
    const result = await f.client.request({ operation, parameters, payload, accessToken, trackingId: randomUUID() });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.httpStatus, write ? 201 : 200);
    assert.deepEqual(result.response, body);
    assert.equal(result.resourceId, write ? resourceId : undefined);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.url, `${apiUrl}${path}`);
    assert.equal(call.method, method);
    assert.equal(call.headers.get('authorization'), `Bearer ${accessToken}`);
    assert.equal(call.headers.get('accept'), 'application/json');
    assert.equal(call.redirect, 'error');
    assert.ok(call.signal instanceof AbortSignal);
    if (write) {
      assert.match(call.headers.get('content-type'), /^application\/json(?:;.*)?$/i);
      assert.deepEqual(JSON.parse(call.body), payload);
    } else assert.equal(call.body, undefined);
    assertNoSecrets(result, [accessToken, f.env.VISMA_CLIENT_SECRET]);
  }
});

test('Visma transport rejects unsupported operations, malformed path IDs, read bodies and hidden write fields before I/O', async () => {
  const f = fixture();
  for (const input of [
    { operation: 'approveDraft' }, { operation: 'supplierinvoices' },
    { operation: 'accounts', parameters: { fiscalYearId: `${fiscalYearId}/../../payments` } },
    { operation: 'supplier', parameters: { resourceId: 'https://wrong.invalid' } },
    { operation: 'draft', parameters: { resourceId: draftId.replaceAll('-', '') } },
    { operation: 'company', parameters: { url: 'https://wrong.invalid' } },
    { operation: 'accounts', parameters: { fiscalYearId, resourceId: supplierId } },
    { operation: 'company', payload: {} },
    { operation: 'createSupplier', payload: { ...supplierPayload, authorization: 'injected' } },
    { operation: 'createDraft', payload: { ...draftPayload, SkipSendToBank: false } },
  ]) await assert.rejects(() => f.client.request({ ...input, accessToken, trackingId: randomUUID() }), error => error.code === 'visma_invalid');
  assert.equal(f.calls.length, 0);
});

test('Visma transport rejects missing or malformed bearer tokens before contacting the provider', async () => {
  for (const token of [undefined, null, '', '  ', 123, `injected\r\nX-Header: secret`, `injected\nsecret`, 'injected\0secret', 'injected\u007fsecret']) {
    const f = fixture();
    await assert.rejects(() => f.client.request({ operation: 'company', accessToken: token }), error => error.code === 'visma_invalid' && error.status === 409);
    assert.equal(f.calls.length, 0);
  }
});

test('Visma preserves provider validation details and actual status while redacting nested credentials and echoed tokens', async () => {
  const f = fixture({ respond: () => new Response(JSON.stringify({
    ErrorCode: 2000,
    DeveloperErrorMessage: `Validation denied ${accessToken} fixture-only-client-secret`,
    ErrorId: 'safe-provider-error-id',
    Errors: [{ Field: 'Rows', ErrorCode: 4032, Message: 'Raderna balanserar inte', Key: 'Rows' }],
    nested: { access_token: 'a-new-provider-token', refreshToken: 'a-new-provider-refresh-token', client_secret: 'a-new-provider-secret' },
    echo: `Bearer ${accessToken}`,
  }), { status: 400 }) });
  const result = await f.client.request({ operation: 'createDraft', payload: draftPayload, accessToken, trackingId: randomUUID() });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.response.ErrorCode, 2000);
  assert.equal(result.response.ErrorId, 'safe-provider-error-id');
  assert.deepEqual(result.response.Errors, [{ Field: 'Rows', ErrorCode: 4032, Message: 'Raderna balanserar inte', Key: 'Rows' }]);
  assertNoSecrets(result, [accessToken, f.env.VISMA_CLIENT_SECRET, 'a-new-provider-token', 'a-new-provider-refresh-token', 'a-new-provider-secret']);
  assert.equal(f.calls.length, 1);
});

test('Visma unauthorized, missing-resource and rate-limit responses retain status and never automatically repeat requests', async () => {
  for (const [status, errorCode] of [[401, 4034], [404, 3000], [429, 4010]]) {
    const body = { ErrorCode: errorCode, DeveloperErrorMessage: 'Actual provider error' };
    const f = fixture({ respond: () => new Response(JSON.stringify(body), { status, headers: { 'Retry-After': '60' } }) });
    const result = await f.client.request({ operation: 'suppliers', accessToken });
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.httpStatus, status);
    assert.deepEqual(result.response, body);
    assert.equal(result.error.code, status === 401 ? 'VISMA_UNAUTHORIZED' : 'VISMA_PROVIDER_REJECTED');
    assert.equal(f.calls.length, 1);
  }
});

test('Visma response diagnostics redact OAuth code, PKCE verifier and rotated tokens learned by the same client', async () => {
  const code = 'fixture-only-authorization-code', rotatedRefresh = `${refreshToken}-rotated`;
  const f = fixture({ respond: call => call.url === tokenUrl
    ? new Response(JSON.stringify({ access_token: accessToken, refresh_token: rotatedRefresh, expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify({ ErrorCode: 2000, DeveloperErrorMessage: `${code} ${verifier} ${accessToken} ${rotatedRefresh}` }), { status: 400 }) });
  await f.client.exchangeCode({ code, verifier });
  const result = await f.client.request({ operation: 'company', accessToken });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.httpStatus, 400);
  assert.equal(result.response.ErrorCode, 2000);
  assertNoSecrets(result, [code, verifier, accessToken, rotatedRefresh]);
  assert.equal(f.calls.length, 2);
});

test('Visma POST success without a verified resource UUID is unknown and keeps its actual response for inspection', async () => {
  for (const [status, body] of [[201, {}], [201, { Id: 'not-a-resource-uuid' }], [200, { Id: null }], [204, null]]) {
    const f = fixture({ respond: () => new Response(status === 204 ? null : JSON.stringify(body), { status }) });
    const result = await f.client.request({ operation: 'createSupplier', payload: supplierPayload, accessToken, trackingId: randomUUID() });
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.httpStatus, status);
    assert.deepEqual(result.response, body);
    assert.equal(result.resourceId, undefined);
    assert.equal(f.calls.length, 1);
  }
});

test('Visma lost and oversized provider replies produce a safe unknown outcome and are never resent', async () => {
  for (const respond of [
    () => { throw new Error(`Lost reply ${accessToken} fixture-only-client-secret`); },
    () => new Response(JSON.stringify({ Id: supplierId, Note: 'x'.repeat(256 * 1024) }), { status: 201 }),
  ]) {
    const f = fixture({ respond });
    const result = await f.client.request({ operation: 'createSupplier', payload: supplierPayload, accessToken, trackingId: randomUUID() });
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.httpStatus, null);
    assert.equal(result.resourceId, undefined);
    assert.equal(result.error.code, 'VISMA_UNKNOWN_OUTCOME');
    assertNoSecrets(result, [accessToken, f.env.VISMA_CLIENT_SECRET]);
    assert.equal(f.calls.length, 1);
  }
});

test('Visma ambiguous POST timeout and server-error responses retain actual HTTP evidence without declaring rejection or retrying', async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const body = { message: 'Provider cannot confirm whether the write completed' };
    const f = fixture({ respond: () => new Response(JSON.stringify(body), { status }) });
    const result = await f.client.request({ operation: 'createDraft', payload: draftPayload, accessToken, trackingId: randomUUID() });
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.httpStatus, status);
    assert.deepEqual(result.response, body);
    assert.equal(result.resourceId, undefined);
    assert.equal(f.calls.length, 1);
  }
});
