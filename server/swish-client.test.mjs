import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSwishMssClient, requestSwishMssHttps, safeSwishData, signSwishPayoutPayload, SWISH_MSS_PAYOUTS_URL } from './swish-client.mjs';
import { extractSwishMssCredentials, validateSwishMssCredentials } from './swish-mss-certificates.mjs';

// A generated LOCAL test key is never a usable Swish certificate. Tests inject
// both validation and transport, so no network or public fixture download occurs.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'swish-client-unit-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(temporary, 'key.pem'),
  '-out', path.join(temporary, 'cert.pem'), '-days', '1', '-subj', '/CN=LocalUnitTest'], { stdio: 'ignore' });
const key = readFileSync(path.join(temporary, 'key.pem')), cert = readFileSync(path.join(temporary, 'cert.pem'));
const credentials = { tlsCert: cert, tlsKey: key, signingCert: cert, signingKey: key, ca: cert };
const uuid = 'E4D773858AF5459B96ABCA4B9DBFF94D';
const payload = () => ({ payoutInstructionUUID: uuid, payerPaymentReference: 'SP-3010', payeeAlias: '46711111132', payeeSSN: '197709306828',
  amount: '100.00', currency: 'SEK', payoutType: 'PAYOUT', message: 'Avräkning 3010', instructionDate: '2026-10-13T08:00:00.000Z' });
const create = (request, extra = {}) => createSwishMssClient({ env: { SWISH_ENVIRONMENT: 'mss' }, request, credentialLoader: async () => credentials,
  credentialValidator: () => ({ signingSerial: 'ABC123', validTo: '2027-01-01T00:00:00Z', tlsValidTo: '2027-01-01T00:00:00Z' }), ...extra });
after(() => rmSync(temporary, { recursive: true, force: true }));

test('signature follows Swish SHA512 JSON then SHA512withRSA hash, including Swedish UTF8', () => {
  const serialized = JSON.stringify(payload()), signature = Buffer.from(signSwishPayoutPayload(serialized, key), 'base64');
  assert.equal(verify('RSA-SHA512', createHash('sha512').update(serialized, 'utf8').digest(), createPublicKey(key), signature), true);
  assert.equal(verify('RSA-SHA512', Buffer.from(serialized, 'utf8'), createPublicKey(key), signature), false);
  assert.equal(verify('RSA-SHA512', createHash('sha512').update(`${serialized} `).digest(), createPublicKey(key), signature), false);
});

test('disabled, production and alternate hosts never load keys or send requests', async () => {
  let calls = 0;
  for (const env of [{}, { SWISH_ENVIRONMENT: 'production' }, { SWISH_ENVIRONMENT: 'mss', SWISH_API_BASE_URL: 'https://cpc.getswish.net/swish-cpcapi/api/v1/payouts' }]) {
    const client = createSwishMssClient({ env, request: async () => { calls++; }, credentialLoader: async () => { calls++; return credentials; } });
    assert.equal((await client.configurationStatus()).ready, false);
    assert.equal((await client.createPayout(payload())).error.code, 'swish_not_configured');
  }
  assert.equal(calls, 0);
  assert.throws(() => requestSwishMssHttps({ url: 'https://cpc.getswish.net/swish-cpcapi/api/v1/payouts', method: 'POST' }), /SWISH_TARGET_FORBIDDEN/);
  assert.throws(() => requestSwishMssHttps({ url: `${SWISH_MSS_PAYOUTS_URL}?target=production`, method: 'POST' }), /SWISH_TARGET_FORBIDDEN/);
  assert.throws(() => requestSwishMssHttps({ url: SWISH_MSS_PAYOUTS_URL, method: 'DELETE' }), /SWISH_TARGET_FORBIDDEN/);
});

test('POST sends precisely signed payload once and retains separate TLS/signing keys', async () => {
  let calls = 0;
  const client = create(async request => {
    calls++;
    assert.equal(request.url, SWISH_MSS_PAYOUTS_URL);
    assert.equal(request.method, 'POST');
    assert.equal(request.rejectUnauthorized, true);
    assert.equal(request.minVersion, 'TLSv1.2');
    assert.equal(request.cert, credentials.tlsCert);
    assert.equal(request.key, credentials.tlsKey);
    assert.equal(request.headers['Content-Length'], Buffer.byteLength(request.body));
    const body = JSON.parse(request.body), serialized = JSON.stringify(body.payload);
    assert.equal(body.payload.payerAlias, '1234679304');
    assert.equal(body.payload.signingCertificateSerialNumber, 'ABC123');
    assert.equal(verify('RSA-SHA512', createHash('sha512').update(serialized, 'utf8').digest(), createPublicKey(key), Buffer.from(body.signature, 'base64')), true);
    assert.equal('callbackUrl' in body, false);
    return { statusCode: 201, headers: { location: `${SWISH_MSS_PAYOUTS_URL}/${uuid}` }, body: '' };
  });
  assert.equal((await client.configurationStatus()).ready, true);
  const result = await client.createPayout(payload());
  assert.equal(result.ok, true);
  assert.equal(result.uncertain, false);
  assert.equal(result.payoutReference, uuid);
  assert.equal(calls, 1);
});

test('timeout, 5xx and duplicate UUID are uncertain and never trigger automatic POST retries', async () => {
  for (const response of [new Error('private key or SSN197709306828'), { statusCode: 503, body: '' },
    { statusCode: 422, body: [{ errorCode: 'RP09', errorMessage: 'Already exists' }] }]) {
    let calls = 0;
    const result = await create(async () => { calls++; if (response instanceof Error) throw response; return response; }).createPayout(payload());
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.instructionUUID, uuid);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('197709306828'), false);
  }
});

test('synchronous Swish validation rejection is definitive and error diagnostics redact identifiers', async () => {
  const result = await create(async () => ({ statusCode: 422, body: [{ errorCode: 'PA06', errorMessage: 'Invalid 197709306828 or 46711111132', payeeSSN: '197709306828' }] })).createPayout(payload());
  assert.equal(result.uncertain, false);
  assert.deepEqual(result.error.providerCodes, ['PA06']);
  assert.equal(JSON.stringify(result).includes('197709306828'), false);
  assert.equal(JSON.stringify(result).includes('46711111132'), false);
});

test('redirects and wrong or missing creation Location stay uncertain without following the URL', async () => {
  for (const response of [{ statusCode: 301, headers: { location: 'https://cpc.getswish.net/' } }, { statusCode: 201, headers: {} },
    { statusCode: 201, headers: { location: `https://example.org/${uuid}` } },
    { statusCode: 201, headers: { location: `${SWISH_MSS_PAYOUTS_URL}/${'A'.repeat(32)}` } }]) {
    let calls = 0;
    const result = await create(async () => { calls++; return response; }).createPayout(payload());
    assert.equal(result.uncertain, true);
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});

test('GET only reconciles the original UUID and rejects malformed status or foreign instruction', async () => {
  const paid = { ...payload(), status: 'PAID', paymentReference: 'public-reference', datePaid: '2026-10-13T08:00:01Z' };
  const client = create(async request => { assert.equal(request.method, 'GET'); assert.equal(request.url, `${SWISH_MSS_PAYOUTS_URL}/${uuid}`); return { statusCode: 200, body: JSON.stringify(paid) }; });
  assert.equal((await client.getPayout(uuid)).data.payeeSSN, paid.payeeSSN); // Internal result, diagnostics are redacted separately.
  assert.equal((await create(async () => ({ statusCode: 200, body: { ...paid, status: 'DEBITED', datePaid: null } })).getPayout(uuid)).ok, true);
  for (const body of [null, { ...paid, payoutInstructionUUID: 'A'.repeat(32) }, { ...paid, status: 'UNKNOWN' }]) {
    const result = await create(async () => ({ statusCode: 200, body })).getPayout(uuid);
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
  }
  const missing = await create(async () => ({ statusCode: 404 })).getPayout(uuid);
  assert.equal(missing.error.code, 'swish_not_found');
  assert.equal(missing.uncertain, true); // Expired MSS cache never authorizes another payout.
});

test('invalid payload, callback, certificate serial and changed runtime mode are blocked before transport', async () => {
  let calls = 0;
  const env = { SWISH_ENVIRONMENT: 'mss' }, client = create(async () => { calls++; return { statusCode: 201, headers: { location: `${SWISH_MSS_PAYOUTS_URL}/${uuid}` } }; }, { env });
  for (const data of [{ ...payload(), amount: '1.001' }, { ...payload(), amount: '0.00' }, { ...payload(), payerAlias: '1231231234' },
    { ...payload(), payeeSSN: '123' }, { ...payload(), signingCertificateSerialNumber: 'DEF' }, { ...payload(), callbackUrl: 'http://unsafe.example' }]) {
    assert.equal((await client.createPayout(data)).ok, false);
  }
  assert.equal((await client.createPayout(payload(), { callbackUrl: 'http://unsafe.example' })).ok, false);
  assert.equal((await client.getPayout('../secret')).ok, false);
  assert.equal(calls, 0);
  assert.equal((await client.createPayout(payload())).ok, true);
  env.SWISH_ENVIRONMENT = 'disabled';
  assert.equal((await client.createPayout(payload())).error.code, 'swish_not_configured');
  assert.equal(calls, 1);
});

test('only the pinned public certificates may use the real transport; invalid archive fails closed', async () => {
  assert.throws(() => validateSwishMssCredentials(credentials), /SWISH_MSS_PUBLIC_CERTIFICATES_INVALID/);
  assert.throws(() => extractSwishMssCredentials(Buffer.from('not a trusted ZIP')), /SWISH_MSS_PUBLIC_CERTIFICATES_INVALID/);
  assert.throws(() => createSwishMssClient({ credentialValidator: () => ({}) }), /SWISH_TEST_VALIDATOR_REQUIRES_TEST_TRANSPORT/);
  const client = createSwishMssClient({ env: { SWISH_ENVIRONMENT: 'mss' }, credentialLoader: async () => credentials });
  const status = await client.configurationStatus();
  assert.equal(status.ready, false);
  assert.equal(JSON.stringify(status).includes('BEGIN'), false);
});

test('nested diagnostics redact secrets, certificates and phone/SSN values', () => {
  const data = safeSwishData({ signature: 'abc', key: 'abc', nested: { payeeSSN: '197709306828', payeeAlias: '46711111132',
    message: 'Reflected 197709306828 and 19770930-6828 and 770930-6828', certificate: cert.toString() } });
  assert.equal(JSON.stringify(data).includes('197709306828'), false);
  assert.equal(JSON.stringify(data).includes('19770930-6828'), false);
  assert.equal(JSON.stringify(data).includes('770930-6828'), false);
  assert.equal(JSON.stringify(data).includes('46711111132'), false);
  assert.equal(JSON.stringify(data).includes('BEGIN'), false);
  assert.equal(data.signature, '[redacted]');
});
