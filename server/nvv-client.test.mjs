import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNvvClient, describeNvvCertificate, NVV_TEST_API_URL, NVV_TEST_TOKEN_URL } from './nvv-client.mjs';

// Anonymous, self-signed fixture generated locally. This key identifies no real
// organization, is publicly available test data, and is never used on a network.
const localOnlyPfx = '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';
// Public anonymous loopback server fixture, with localhost/127.0.0.1 SANs.
// Its fixture key and PIN have no production identity or value.
const localOnlyServerPfx = 'MIIEvAIBAzCCBHIGCSqGSIb3DQEHAaCCBGMEggRfMIIEWzCCAwoGCSqGSIb3DQEHBqCCAvswggL3AgEAMIIC8AYJKoZIhvcNAQcBMF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBCPJo1T4gCwYmlbvrxz8x6gAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQ+mDd8VgNW3XvEm3jT90GWoCCAoDoGyGFEPiHIuyuksFec+GMtWj9EXnBc/3r7128pf5iu83s9dhW9X34wg3QsWv1j+mzRAd0Hxh/Fq0kFd25SEynHanJEM78Lak2UpDjsOnfLE+FN2U1D1P7Og8UCeauRSIRwujeXlhfB/32ruJfvQMpPjYt006M1hI1UsW2gM6o9zFPvWDUE+xQb0ESIAdIwynUrmwhRcG2gX9Kmet1NVcAjqjs0bPQJ72nM/etncZST9eEB8ugjp1aS2LeJaSxYHnc6+TlV1FBBdOEFajOxk5oM4NjMFTuDQx4NRyu4NGshxg3ql5r6/N7bNZaCAfwCWdev87n4/g3d27FI8d1KQEbu2OWQr9mNYAoOf91AN43MzXmcwOmpMsRGLxvIwqKpz3FO7AWGuzVaAYVzuuG/sFqZ7R0cxBzaGuzgNk1Xsgfh5cCrWLknH/NmCrmcvVCvdcvpMFghES2oDSUfkl7XB8Hx5QpJbhSzlI8oiNZCCmzwVSyspEoCZSHp3Vn+w48xCXVlWUIQNJWQ8rTxy4HpNW69DilhUbx63fqnsR08UCNgQ1Kbl/3TRmLE1v7PHZKvYRT/6Vkv/Gl/hgvYzKDRJ5otsmpo2HJTOfEp5gNpYVofQFUYyIgXWrvAjuUXJDb8KnrVYSujv4MArEJhVFJHbB6uIoTu0yn3Ib6sstB9ZunZyosfdUq+feaqmJsHwUJEUtDjo6H0vTkMhrF3VJw55ZI7PmWkxmvexAwprpQGG5YeJ4j3bBnRpBV2gTp6COsp3P03iba0dSXhJ+vEVdZvu5r8fIMVHD7rpRC2phVIkCyIO/AjRnCzb0XajNPTGV1pxYHq/LKNn5/2xHC4KW+Dr+xMIIBSQYJKoZIhvcNAQcBoIIBOgSCATYwggEyMIIBLgYLKoZIhvcNAQwKAQKggfcwgfQwXwYJKoZIhvcNAQUNMFIwMQYJKoZIhvcNAQUMMCQEEInn8CSayTbzfCEONWHq7ScCAggAMAwGCCqGSIb3DQIJBQAwHQYJYIZIAWUDBAEqBBDuH1yxMCBMPhWHBIdu63xtBIGQMQx2OJiJWs+ZZTYsdYky16+KOJyYh6FSie48Z/pvqYweBiu4X9LOHyXRX+e6s0cuVv97KqGhE/tmFUs3LXZQt1fqRCp+no0mOMvfhbWg4vjgLeVS9FMQbNtyJJxNxTKegqQjk8EE3oLg0fSW1V5xF3cWHdAqV84Tqpvs9B3wLMvfql2cmUUrKGWCaqtGfBIcMSUwIwYJKoZIhvcNAQkVMRYEFFIE7tkcuZOCl6GwS8Qi/1aj7XdUMEEwMTANBglghkgBZQMEAgEFAAQggVvTefTexKrYLXhgUrY+wV/MUEeOwdhO0NBog3fdzqQECDQ1LTSc6TbFAgIIAA==';
const acceptedId = '3cbf001c-5c51-4f31-a8a4-173dbd7e7bc8';
const payload = { referens: 'LOCAL-TEST-1', avfall: { kod: '160601', mangd: 250 } };

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jeroc-nvv-client-'));
  const file = join(dir, 'certificate.base64');
  await writeFile(file, localOnlyPfx, { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { NVV_ENVIRONMENT: 'test', NVV_CLIENT_ID: 'local-test-client-id', NVV_CLIENT_SECRET: 'local-test-client-secret', NVV_CLIENT_PFX_SECRET_FILE: file, NVV_CLIENT_PFX_PASSWORD: 'fixture-only-password', NVV_CLIENT_SYSTEM_ID: 'JEROC local tests 1', ...extra };
  const calls = [];
  const request = async (input) => {
    calls.push(input);
    if (input.url === NVV_TEST_TOKEN_URL) return { statusCode: 200, headers: {}, body: { access_token: 'local-test-bearer', token_type: 'Bearer', expires_in: 3600 } };
    return { statusCode: 200, headers: { 'nv-client-tracking-id': input.headers['NV-Client-Tracking-ID'] }, body: { avfallId: acceptedId } };
  };
  return { env, calls, request };
}

test('NVV client is disabled by default and never performs I/O', async () => {
  let calls = 0;
  const client = createNvvClient({ env: {}, request: async () => { calls++; } });
  assert.equal((await client.status()).mode, 'disabled');
  const check = await client.check(); assert.equal(check.connected, false); assert.deepEqual(check.diagnostics, []);
  assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).error.code, 'NVV_DISABLED');
  assert.equal(calls, 0);
});

test('loaded TLS certificate exposes only public X509 metadata and keeps it coherent across cache reads', async t => {
  const f = await fixture(t), client = createNvvClient({ env: f.env, request: f.request });
  const der = tls.createSecureContext({ pfx: Buffer.from(localOnlyPfx, 'base64'), passphrase: f.env.NVV_CLIENT_PFX_PASSWORD }).context.getCertificate();
  const certificate = new X509Certificate(der), first = await client.status();
  assert.deepEqual(first.certificate, { configured: true, validated: true, metadataAvailable: true,
    organisationName: 'Not a real NVV identity', organisationNumber: null, issuer: certificate.issuer, freshHandshake: true,
    validFrom: new Date(certificate.validFrom).toISOString(), validTo: new Date(certificate.validTo).toISOString(), fingerprint256: certificate.fingerprint256 });
  assert.equal(f.calls.length, 0);
  const originalFingerprint = first.certificate.fingerprint256;
  first.certificate.fingerprint256 = 'spoofed'; first.certificate.organisationNumber = '5560000167';
  assert.equal((await client.status()).certificate.fingerprint256, originalFingerprint);
  assert.equal((await client.status()).certificate.organisationNumber, null);
  assert.deepEqual((await client.configurationSnapshot()).status.certificate, { ...first.certificate, fingerprint256: originalFingerprint, organisationNumber: null });
  const submitted = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(submitted.outcome, 'accepted');
  assert.equal((await client.status()).certificate.fingerprint256, originalFingerprint);
  const publicJson = JSON.stringify(await client.status());
  for (const secret of [localOnlyPfx, der.toString('base64'), f.env.NVV_CLIENT_PFX_PASSWORD, f.env.NVV_CLIENT_PFX_SECRET_FILE, f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_ID])
    assert.equal(publicJson.includes(secret), false);
  f.env.NVV_CLIENT_PFX_PASSWORD = 'incorrect-rotated-pin';
  const rotated = await client.status();
  assert.equal(rotated.ready, false); assert.equal(rotated.certificate.metadataAvailable, false);
  assert.equal(rotated.certificate.fingerprint256, null); assert.equal(rotated.certificate.organisationNumber, null);
});

test('certificate organisation identity comes from explicit subject fields, without guessing from CN or certificate serial', t => {
  const certificate = new X509Certificate(tls.createSecureContext({ pfx: Buffer.from(localOnlyPfx, 'base64'), passphrase: 'fixture-only-password' }).context.getCertificate());
  let subject = {};
  t.mock.method(certificate, 'toLegacyObject', () => ({ subject }));
  for (const [field, value] of [['serialNumber', '165560000167'], ['2.5.4.5', '556000-0167'], ['organizationIdentifier', 'NTRSE-5560000167'], ['organisationIdentifier', 'SE5560000167'], ['2.5.4.97', 'SE556000016701']]) {
    subject = { O: 'Testorganisation AB', [field]: value };
    const metadata = describeNvvCertificate(certificate);
    assert.equal(metadata.organisationNumber, '5560000167', `${field}: ${value}`);
    assert.equal(metadata.organisationName, 'Testorganisation AB');
  }
  for (const value of ['190211108220', '194801301872', 'NTRNO-5560000167', 'arbitrary5560000167', '556000016799']) {
    subject = { CN: 'Testorganisation 5560000167', serialNumber: value };
    assert.equal(describeNvvCertificate(certificate).organisationNumber, null);
    assert.equal(describeNvvCertificate(certificate).organisationName, null);
  }
  subject = { CN: '5560000167', organizationIdentifier: ['NTRSE-5560000167', 'NTRSE-5560065087'], O: ['First AB', 'Second AB'] };
  assert.equal(describeNvvCertificate(certificate).organisationNumber, null);
  assert.equal(describeNvvCertificate(certificate).organisationName, null);
  assert.equal(describeNvvCertificate(Buffer.from('not a certificate')).metadataAvailable, false);
});

test('unavailable native certificate metadata preserves successful TLS validation and never leaks extraction errors', async t => {
  const realCreate = tls.createSecureContext;
  let nativeContext = {};
  t.mock.method(tls, 'createSecureContext', options => { realCreate(options); return { context: nativeContext }; });
  for (const broken of [{}, { getCertificate() { throw new Error('secret extraction details'); } }, { getCertificate: () => Buffer.from('invalid DER') }]) {
    nativeContext = broken;
    const f = await fixture(t), client = createNvvClient({ env: f.env, request: f.request });
    const status = await client.status();
    assert.equal(status.ready, true); assert.equal(status.certificate.validated, true);
    assert.equal(status.certificate.metadataAvailable, false); assert.equal(status.certificate.fingerprint256, null);
    assert.deepEqual(status.issues, []); assert.equal(JSON.stringify(status).includes('secret extraction'), false);
    assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).outcome, 'accepted');
  }
});

test('NVV PascalCase 400 identity error retains every safe provider error and explains code1023', async t => {
  const f = await fixture(t);
  const body = { Message: 'Validation failed', Errors: [{ Code: 1023, Message: 'Organisation identity mismatch' }, { Code: 1004, Message: `Other field error ${f.env.NVV_CLIENT_SECRET}` }] };
  const client = createNvvClient({ env: f.env, request: async input => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 400, body } });
  const rejected = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.httpStatus, 400);
  assert.equal(rejected.error.code, 'NVV_REPORTER_IDENTITY');
  assert.equal(rejected.error.message, 'NVV kunde inte matcha verksamhetsutövaren eller ombudet mot rapportörens organisationsnummer. Kontrollera klientcertifikatets identitet och rapporteringsrollen.');
  assert.deepEqual(rejected.error.details.map(item => item.Code), [1023, 1004]);
  assert.equal(rejected.response.Message, body.Message); assert.deepEqual(rejected.response.Errors, rejected.error.details);
  assert.equal(JSON.stringify(rejected).includes(f.env.NVV_CLIENT_SECRET), false);
  const generic = createNvvClient({ env: f.env, request: async input => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 400, body: { Message: 'Actual provider message', Code: 1004 } } });
  assert.equal((await generic.submit({ method: 'POST', path: '/insamlingar', payload })).error.message, 'Actual provider message');
  const topLevel = createNvvClient({ env: f.env, request: async input => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 400, body: { Code: '1023', Message: 'Identity mismatch' } } });
  assert.equal((await topLevel.submit({ method: 'POST', path: '/insamlingar', payload })).error.code, 'NVV_REPORTER_IDENTITY');
});

test('production and custom endpoints are blocked before any network operation', async (t) => {
  for (const extra of [{ NVV_ENVIRONMENT: 'production' }, { NVV_API_BASE_URL: 'https://apim.naturvardsverket.se/btfa/anteckning/v1' }, { NVV_TOKEN_URL: 'https://unexpected.example/token' }, { NVV_API_BASE_URL: `${NVV_TEST_API_URL}?next=https://evil.example` }]) {
    const f = await fixture(t, extra);
    const client = createNvvClient({ env: f.env, request: f.request });
    assert.equal((await client.status()).ready, false);
    assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).outcome, 'rejected');
    assert.equal(f.calls.length, 0);
  }
});

test('explicit mock returns SIM identifiers, supports correction, and never uses network', async () => {
  const client = createNvvClient({ env: { NVV_ENVIRONMENT: 'mock' }, request: async () => { throw new Error('must not call'); } });
  const initial = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(initial.simulated, true);
  assert.match(initial.avfallId, /^SIM-/);
  const correction = await client.submit({ method: 'PUT', path: `/insamlingar/${initial.avfallId}`, payload: { ...payload, avfall: { kod: '160601', mangd: 245 } } });
  assert.equal(correction.outcome, 'accepted');
  assert.notEqual(correction.avfallId, initial.avfallId);
  assert.equal((await client.read({ avfallId: initial.avfallId })).response.payload.avfall.mangd, 250);
  const check = await client.check(); assert.equal(check.simulated, true); assert.deepEqual(check.diagnostics, []);
});

test('missing config, malformed PFX and wrong password do not contact NVV or leak secrets', async (t) => {
  const missing = createNvvClient({ env: { NVV_ENVIRONMENT: 'test' }, request: async () => { throw new Error('must not call'); } });
  assert.ok((await missing.status()).missing.includes('NVV_CLIENT_PFX_SECRET_FILE'));
  const f = await fixture(t, { NVV_CLIENT_PFX_PASSWORD: 'wrong-private-password' });
  const client = createNvvClient({ env: f.env, request: f.request });
  const state = await client.status();
  assert.equal(state.ready, false);
  assert.ok(!JSON.stringify(state).includes('wrong-private-password'));
  await writeFile(f.env.NVV_CLIENT_PFX_SECRET_FILE, 'not a valid pfx');
  assert.equal((await client.check()).connected, false);
  assert.equal(f.calls.length, 0);
});

test('valid PFX config exposes only public readiness and safely checks nested code lists', async (t) => {
  const f = await fixture(t);
  const request = async (input) => {
    if (input.url.endsWith('/avfallstyper')) return { statusCode: 200, body: [{ kod: '16', avfallstyper: [{ kod: '1606', avfallstyper: [{ kod: '160601', beskrivning: 'Blybatterier', farligt: 'Ja' }] }] }] };
    if (input.url.endsWith('/transportsatt')) return { statusCode: 200, body: [{ transportsatt: 'R', beskrivning: 'Vägtransport' }] };
    return f.request(input);
  };
  const client = createNvvClient({ env: f.env, request });
  const state = await client.status();
  assert.equal(state.ready, true);
  assert.equal(state.certificate.validated, true);
  assert.equal(state.certificate.metadataAvailable, true);
  const result = await client.check();
  assert.equal(result.connected, true);
  assert.ok(result.wasteCodes.some((item) => item.code === '160601' && item.hazardous));
  assert.ok(result.transportModes.some((item) => item.code === 'R'));
  assert.deepEqual(result.diagnostics.map(item => [item.method, item.path, item.httpStatus, item.outcome]), [['GET', '/avfallstyper', 200, 'accepted'], ['GET', '/transportsatt', 200, 'accepted']]);
  assert.deepEqual(result.diagnostics[0].response, { summary: 'Sammanfattat utdrag ur NVV:s kodlista.', count: 3, sixDigitCodes: 1, example: { kod: '160601', beskrivning: 'Blybatterier', farligt: 'Ja' } });
  assert.deepEqual(result.diagnostics[1].response.items, [{ transportsatt: 'R', beskrivning: 'Vägtransport' }]);
  assert.equal(f.calls.length, 1, 'token is reused for both authenticated reads');
  for (const secret of [f.env.NVV_CLIENT_ID, f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_PFX_PASSWORD, f.env.NVV_CLIENT_PFX_SECRET_FILE]) assert.ok(!JSON.stringify(state).includes(secret));
});

test('check diagnostics report the actual OAuth rejection and no code-list request that never happened', async t => {
  const f = await fixture(t), calls = [];
  const client = createNvvClient({ env: f.env, request: async input => { calls.push(input); return { statusCode: 400,
    transport: { protocol: 'TLSv1.2', cipher: `TLS_FIXTURE_${f.env.NVV_CLIENT_PFX_PASSWORD}` },
    body: { error: 'invalid_client', error_description: `Denied ${f.env.NVV_CLIENT_SECRET} ${f.env.NVV_CLIENT_ID}`, access_token: 'invalid-private-token', extra: { echo: 'invalid-private-token', file: f.env.NVV_CLIENT_PFX_SECRET_FILE } } }; } });
  const checked = await client.check(); assert.equal(checked.connected, false); assert.equal(calls.length, 1); assert.equal(calls[0].url, NVV_TEST_TOKEN_URL);
  assert.equal(checked.diagnostics.length, 1); const diagnostic = checked.diagnostics[0];
  assert.equal(diagnostic.method, 'POST'); assert.equal(diagnostic.path, '/oauth2/token'); assert.equal(diagnostic.httpStatus, 400); assert.equal(diagnostic.outcome, 'rejected'); assert.equal(diagnostic.trackingId, undefined); assert.equal(diagnostic.response.error, 'invalid_client');
  assert.deepEqual(diagnostic.transport, { protocol: 'TLSv1.2', cipher: 'TLS_FIXTURE_[redacted]' });
  for (const secret of [f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_ID, f.env.NVV_CLIENT_PFX_SECRET_FILE, 'invalid-private-token']) assert.equal(JSON.stringify(checked).includes(secret), false);
});

test('OAuth diagnostics redact an oversized token before shortening an echoed error message', async t => {
  const f = await fixture(t), oversizedToken = 'private-oversized-token-'.repeat(900);
  const client = createNvvClient({ env: f.env, request: async () => ({ statusCode: 400, body: { error: 'invalid_client', access_token: oversizedToken, message: `Denied ${oversizedToken}` } }) });
  const result = await client.check(); assert.equal(result.diagnostics[0].httpStatus, 400); assert.equal(result.diagnostics[0].response.message, 'Denied [redacted]'); assert.equal(JSON.stringify(result).includes('private-oversized-token'), false);
});

test('check diagnostics preserve a real GET401 before a failed OAuth refresh and show its actual status', async t => {
  const f = await fixture(t); let authenticationCalls = 0, readCalls = 0;
  const client = createNvvClient({ env: f.env, request: async input => {
    if (input.url === NVV_TEST_TOKEN_URL) { authenticationCalls++; return authenticationCalls === 1 ? f.request(input) : { statusCode: 503, body: { message: 'OAuth service unavailable', token: 'local-test-bearer' } }; }
    readCalls++; return { statusCode: 401, headers: { 'nv-client-tracking-id': 'real-tracking-401' }, body: { message: 'Expired authentication' } };
  } });
  const checked = await client.check(); assert.equal(checked.connected, false); assert.equal(authenticationCalls, 2); assert.equal(readCalls, 1);
  assert.deepEqual(checked.diagnostics.map(item => [item.method, item.path, item.httpStatus, item.outcome]), [['GET', '/avfallstyper', 401, 'rejected'], ['POST', '/oauth2/token', 503, 'unknown']]);
  assert.equal(checked.diagnostics[0].trackingId, 'real-tracking-401'); assert.equal(checked.diagnostics[1].response.message, 'OAuth service unavailable'); assert.equal(JSON.stringify(checked).includes('local-test-bearer'), false);
});

test('large real code-list responses produce only a bounded labelled diagnostics excerpt', async t => {
  const f = await fixture(t), codes = Array.from({ length: 3000 }, (_, index) => ({ kod: String(100000 + index), beskrivning: 'Avfall '.repeat(100), farligt: 'Nej' }));
  codes.push({ kod: '160601', beskrivning: `Blybatterier ${f.env.NVV_CLIENT_PFX_PASSWORD}`, farligt: 'Ja' });
  const client = createNvvClient({ env: f.env, request: async input => input.url === NVV_TEST_TOKEN_URL ? f.request(input)
    : { statusCode: 200, body: input.url.endsWith('/avfallstyper') ? codes : [{ transportsatt: 'R', beskrivning: 'Vägtransport' }] } });
  const checked = await client.check(); assert.equal(checked.connected, true); assert.equal(checked.diagnostics[0].response.count, 3001); assert.equal(checked.diagnostics[0].response.sixDigitCodes, 3001);
  assert.ok(JSON.stringify(checked.diagnostics).length < 1200); assert.equal(JSON.stringify(checked.diagnostics).includes(f.env.NVV_CLIENT_PFX_PASSWORD), false); assert.equal(checked.diagnostics[0].response.example.kod, '160601');
});

test('missing reference codes leave the connection check incomplete', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 200, body: [] } });
  const result = await client.check();
  assert.equal(result.connected, false);
  assert.equal(result.error.code, 'NVV_REFERENCE_DATA');
});

test('submission preserves a verified 200 avfallId receipt and exact tracking', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: f.request });
  const result = await client.submit({ method: 'POST', path: '/insamlingar', payload, trackingId: 'tracking-local-1' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.avfallId, acceptedId);
  assert.equal(result.response.avfallId, acceptedId);
  assert.equal(result.trackingId, 'tracking-local-1');
  assert.equal(f.calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(f.calls[0].body, 'grant_type=client_credentials');
  assert.equal(f.calls[1].url, `${NVV_TEST_API_URL}/insamlingar`);
  assert.equal(f.calls[1].headers.Authorization, 'Bearer local-test-bearer');
  assert.equal(f.calls[1].headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(f.calls[1].body), payload);
  assert.ok(Buffer.isBuffer(f.calls[1].pfx));
});

test('explicit documented legacy 201 AvfallsId variant is normalized while retaining raw body', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 201, body: JSON.stringify({ AvfallsId: acceptedId }) } });
  const result = await client.submit({ method: 'PUT', path: `/insamlingar/${acceptedId}`, payload });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.avfallId, acceptedId);
  assert.equal(result.httpStatus, 201);
  assert.equal(result.response.AvfallsId, acceptedId);
});

test('malformed success, HTTP408, 5xx and dropped responses are unknown and never blindly retried', async (t) => {
  for (const answer of [{ statusCode: 200, body: { avfallId: null } }, { statusCode: 200, body: '<html>wrong service</html>' }, { statusCode: 204, body: '' }, { statusCode: 408, body: { message: 'request timed out' } }, { statusCode: 500, body: { message: 'server error' } }, { statusCode: 504, body: 'gateway timeout' }, { statusCode: 302, body: '' }, null]) {
    const f = await fixture(t);
    let submitted = 0;
    const client = createNvvClient({ env: f.env, request: async (input) => {
      if (input.url === NVV_TEST_TOKEN_URL) return f.request(input);
      submitted++;
      if (!answer) throw new Error(`secret network failure ${f.env.NVV_CLIENT_SECRET}`);
      return answer;
    } });
    const result = await client.submit({ method: 'POST', path: '/insamlingar', payload });
    assert.equal(result.outcome, 'unknown');
    assert.equal(submitted, 1);
    assert.ok(!JSON.stringify(result).includes(f.env.NVV_CLIENT_SECRET));
  }
});

test('HTTP429 is explicitly rejected without an automatic retry; reads never acknowledge408', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url === NVV_TEST_TOKEN_URL) return f.request(input);
    calls++;
    return { statusCode: input.method === 'GET' ? 408 : 429, body: { message: 'limited' } };
  } });
  const submission = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(submission.outcome, 'rejected');
  assert.equal(submission.httpStatus, 429);
  assert.equal(calls, 1);
  assert.notEqual((await client.read({ avfallId: acceptedId })).outcome, 'accepted');
  assert.equal(calls, 2);
});

test('rejected responses retain field errors and redact tokens or credentials in any value', async (t) => {
  const f = await fixture(t);
  const response = { message: `Invalid field ${f.env.NVV_CLIENT_SECRET}`, traceId: 'public-trace-1', errors: [{ code: 4206, message: 'Kommunkod för kommande hanteringsplats ska anges.' }], access_token: 'local-test-bearer', nested: { text: f.env.NVV_CLIENT_PFX_PASSWORD } };
  const client = createNvvClient({ env: f.env, request: async (input) => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 400, body: response } });
  const result = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.error.details[0].code, 4206);
  assert.equal(result.response.traceId, 'public-trace-1');
  for (const secret of [f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_PFX_PASSWORD, 'local-test-bearer']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('an explicit 401 renews once and resubmits the same immutable request and tracking', async (t) => {
  const f = await fixture(t);
  let tokens = 0;
  const submissions = [];
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url === NVV_TEST_TOKEN_URL) return { statusCode: 200, body: { access_token: `local-token-${++tokens}`, expires_in: 3600 } };
    submissions.push(input);
    return submissions.length === 1 ? { statusCode: 401, body: { message: 'expired' } } : { statusCode: 200, body: { avfallId: acceptedId } };
  } });
  const result = await client.submit({ method: 'POST', path: '/insamlingar', payload, trackingId: 'retry-same-tracking' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(tokens, 2);
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0].body, submissions[1].body);
  assert.equal(submissions[0].headers['NV-Client-Tracking-ID'], submissions[1].headers['NV-Client-Tracking-ID']);
});

test('a second 401 stops and an expired token is refreshed before the next request', async (t) => {
  const f = await fixture(t);
  let time = Date.now();
  let tokens = 0;
  let submitted = 0;
  const client = createNvvClient({ env: f.env, now: () => time, request: async (input) => {
    if (input.url === NVV_TEST_TOKEN_URL) return { statusCode: 200, body: { access_token: `local-token-${++tokens}`, expires_in: 60 } };
    submitted++;
    return { statusCode: submitted <= 2 ? 401 : 200, body: { avfallId: acceptedId } };
  } });
  assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).outcome, 'rejected');
  assert.equal(submitted, 2);
  time += 61_000;
  assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).outcome, 'accepted');
  assert.equal(tokens, 3);
});

test('only reception operations are permitted; no path injection or outgoing/makulering', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: f.request });
  for (const op of [{ method: 'DELETE', path: '/anteckningar' }, { method: 'POST', path: '/insamlingstransport' }, { method: 'POST', path: '/insamlingar?override=x' }, { method: 'PUT', path: '/insamlingar/../../other' }]) {
    assert.equal((await client.submit({ ...op, payload })).error.code, 'NVV_OPERATION_DISABLED');
  }
  assert.equal(f.calls.length, 0);
});

test('TEST read uses GET and exact time query names, preserving record IDs and snapshots', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url === NVV_TEST_TOKEN_URL) return f.request(input);
    f.calls.push(input);
    return { statusCode: 200, body: { antalSidor: 1, anteckningar: [{ id: 'note-id-separate', avfall: { avfallId: acceptedId, kod: '160601', mangd: 250 }, referens: payload.referens, senasteHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Local test 1', postnummer: '76141' } } }] } };
  } });
  const result = await client.read({ from: '2026-10-10T10:00:00Z', to: '2026-10-10T11:00:00Z' });
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.response.anteckningar[0].id, 'note-id-separate');
  assert.equal(result.response.anteckningar[0].avfall.avfallId, acceptedId);
  const query = new URL(f.calls.at(-1).url).searchParams;
  assert.equal(query.get('DatumTidFran'), '2026-10-10T10:00:00Z');
  assert.equal(query.get('DatumTidTom'), '2026-10-10T11:00:00Z');
  assert.equal(f.calls.at(-1).method, 'GET');
  const before = f.calls.length;
  assert.equal((await client.read({ avfallId: 'not-a-guid' })).outcome, 'rejected');
  assert.equal((await client.read({ from: 'bad-date' })).outcome, 'rejected');
  assert.equal(f.calls.length, before);
});

test('token endpoint redirects or malformed token responses never cause API submission', async (t) => {
  for (const answer of [{ statusCode: 302, body: {}, headers: { location: 'https://evil.example/token' } }, { statusCode: 200, body: { access_token: 'local-token', expires_in: -1 } }]) {
    const f = await fixture(t);
    let calls = 0;
    const client = createNvvClient({ env: f.env, request: async () => { calls++; return answer; } });
    assert.equal((await client.submit({ method: 'POST', path: '/insamlingar', payload })).error.code, 'NVV_AUTHENTICATION');
    assert.equal(calls, 1);
  }
});

test('concurrent reception calls share the OAuth refresh and keep separate tracking IDs', async (t) => {
  const f = await fixture(t);
  let tokens = 0;
  const submitted = [];
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url === NVV_TEST_TOKEN_URL) { tokens++; await new Promise((resolve) => setTimeout(resolve, 5)); return { statusCode: 200, body: { access_token: 'shared-local-bearer', expires_in: 3600 } }; }
    submitted.push(input);
    return { statusCode: 200, body: { avfallId: acceptedId } };
  } });
  const results = await Promise.all(['tracking-a', 'tracking-b'].map((trackingId) => client.submit({ method: 'POST', path: '/insamlingar', payload, trackingId })));
  assert.equal(tokens, 1);
  assert.equal(results.filter((result) => result.outcome === 'accepted').length, 2);
  assert.deepEqual(submitted.map((input) => input.headers['NV-Client-Tracking-ID']).sort(), ['tracking-a', 'tracking-b']);
});

test('truncated TEST recovery cannot be mistaken for a complete unique match', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 200, body: { antalSidor: 1, anteckningar: Array.from({ length: 5001 }, () => ({ avfall: { avfallId: acceptedId } })) } } });
  const result = await client.read({});
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.responseTruncated, true);
});

test('invalid URL credentials and secrets used as response keys are never returned', async (t) => {
  const f = await fixture(t);
  const badUrl = createNvvClient({ env: { ...f.env, NVV_API_BASE_URL: `https://someone:${f.env.NVV_CLIENT_SECRET}@unexpected.example` }, request: f.request });
  assert.ok(!JSON.stringify(await badUrl.status()).includes(f.env.NVV_CLIENT_SECRET));
  const client = createNvvClient({ env: f.env, request: async (input) => input.url === NVV_TEST_TOKEN_URL ? f.request(input) : { statusCode: 400, body: { [f.env.NVV_CLIENT_SECRET]: 'bad upstream key', message: 'rejected' } } });
  assert.ok(!JSON.stringify(await client.submit({ method: 'POST', path: '/insamlingar', payload })).includes(f.env.NVV_CLIENT_SECRET));
});

test('private configuration identity changes with credential/PFX rotation and never enters public DTOs', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url.endsWith('/avfallstyper')) return { statusCode: 200, body: [{ kod: '160601', farligt: 'Ja' }] };
    if (input.url.endsWith('/transportsatt')) return { statusCode: 200, body: [{ transportsatt: 'R' }] };
    return f.request(input);
  } });
  const original = await client.configurationSnapshot();
  assert.match(original.configurationId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(original.status).includes(original.configurationId));
  const checked = await client.checkWithConfiguration();
  assert.equal(checked.configurationId, original.configurationId);
  assert.ok(!JSON.stringify(checked.result).includes(original.configurationId));
  assert.ok(!JSON.stringify(await client.check()).includes(original.configurationId));
  for (const name of ['NVV_CLIENT_ID', 'NVV_CLIENT_SECRET', 'NVV_CLIENT_PFX_PASSWORD', 'NVV_CLIENT_SYSTEM_ID']) {
    const previous = f.env[name];
    f.env[name] = `${previous}-rotated`;
    assert.notEqual((await client.configurationSnapshot()).configurationId, original.configurationId, `${name} must invalidate the check`);
    f.env[name] = previous;
  }
  await writeFile(f.env.NVV_CLIENT_PFX_SECRET_FILE, Buffer.from('different certificate bytes').toString('base64'));
  assert.notEqual((await client.configurationSnapshot()).configurationId, original.configurationId);
});

test('a check retains the private identity of the configuration actually used if env changes during I/O', async (t) => {
  const f = await fixture(t);
  const client = createNvvClient({ env: f.env, request: async (input) => {
    if (input.url.endsWith('/avfallstyper')) {
      f.env.NVV_CLIENT_SECRET = 'changed-after-check-started';
      return { statusCode: 200, body: [{ kod: '160601', farligt: 'Ja' }] };
    }
    if (input.url.endsWith('/transportsatt')) return { statusCode: 200, body: [{ transportsatt: 'R' }] };
    return f.request(input);
  } });
  const before = await client.configurationSnapshot();
  const checked = await client.checkWithConfiguration();
  assert.equal(checked.result.connected, true);
  assert.equal(checked.configurationId, before.configurationId);
  assert.notEqual((await client.configurationSnapshot()).configurationId, checked.configurationId);
});


test('fresh verified mTLS requests use new connections and expose the actual client leaf only', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-nvv-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clientPfx = Buffer.from(localOnlyPfx, 'base64'), serverPfx = Buffer.from(localOnlyServerPfx, 'base64');
  const clientCertificate = new X509Certificate(tls.createSecureContext({ pfx: clientPfx, passphrase: 'fixture-only-password' }).context.getCertificate());
  const serverCertificate = new X509Certificate(tls.createSecureContext({ pfx: serverPfx, passphrase: 'anonymous-local-test-only' }).context.getCertificate());
  const caFile = join(directory, 'anonymous-server-ca.pem');
  await writeFile(caFile, serverCertificate.toString(), { mode: 0o600 });
  const connections = [];
  const server = https.createServer({ pfx: serverPfx, passphrase: 'anonymous-local-test-only', ca: clientCertificate.toString(),
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
    });
  server.on('secureConnection', socket => connections.push({ port: socket.remotePort, authorized: socket.authorized,
    reused: socket.isSessionReused(), fingerprint: socket.getPeerX509Certificate().fingerprint256 }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const input = { url: `https://127.0.0.1:${server.address().port}/local-only`, method: 'GET', pfx: localOnlyPfx, passphrase: 'fixture-only-password', maxTlsVersion: 'TLSv1.2' };
  const script = `import assert from 'node:assert/strict';
    import { requestHttps } from ${JSON.stringify(new URL('./nvv-client.mjs', import.meta.url).href)};
    const input = ${JSON.stringify(input)}; input.pfx=Buffer.from(input.pfx,'base64');
    const results=[]; for(let index=0;index<2;index++) results.push(await requestHttps(input));
    for(const result of results) {assert.equal(result.statusCode,200); assert.equal(result.clientCertificate.fingerprint256,${JSON.stringify(clientCertificate.fingerprint256)});assert.equal(result.transport.protocol,'TLSv1.2');assert.match(result.transport.cipher,/^TLS_/);}
    console.log(JSON.stringify(results.map(result=>result.clientCertificate)));`;
  const childEnv = { ...process.env, NODE_EXTRA_CA_CERTS: caFile }; delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
  const run = promisify(execFile);
  const child = await run(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, timeout: 5000 });
  const metadata = JSON.parse(child.stdout);
  assert.equal(connections.length, 2); assert.equal(new Set(connections.map(item => item.port)).size, 2);
  assert.ok(connections.every(item => item.authorized && !item.reused && item.fingerprint === clientCertificate.fingerprint256));
  assert.equal(metadata[0].fingerprint256, metadata[1].fingerprint256); assert.equal(metadata[0].organisationNumber, null);
  assert.equal(JSON.stringify(metadata).includes(localOnlyPfx), false); assert.equal(JSON.stringify(metadata).includes('fixture-only-password'), false);
  // The same request without explicit test-CA trust must fail verification.
  const untrustedEnv = { ...childEnv }; delete untrustedEnv.NODE_EXTRA_CA_CERTS;
  const untrusted = `import assert from 'node:assert/strict';
    import { requestHttps } from ${JSON.stringify(new URL('./nvv-client.mjs', import.meta.url).href)};
    const input=${JSON.stringify(input)}; input.pfx=Buffer.from(input.pfx,'base64');
    await assert.rejects(requestHttps(input), cause=>cause.code==='DEPTH_ZERO_SELF_SIGNED_CERT');`;
  await run(process.execPath, ['--input-type=module', '-e', untrusted], { env: untrustedEnv, timeout: 5000 });
});

test('actual socket certificate diagnostics survive normalization without private metadata fields', async t => {
  const f = await fixture(t);
  const certificate = describeNvvCertificate(tls.createSecureContext({ pfx: Buffer.from(localOnlyPfx, 'base64'), passphrase: 'fixture-only-password' }).context.getCertificate());
  const unsafe = { ...certificate, privateKey: localOnlyPfx, pem: 'PRIVATE MATERIAL', password: f.env.NVV_CLIENT_PFX_PASSWORD, path: f.env.NVV_CLIENT_PFX_SECRET_FILE };
  const client = createNvvClient({ env: f.env, request: async input => {
    if (input.url === NVV_TEST_TOKEN_URL) return f.request(input);
    if (input.url.endsWith('/avfallstyper')) return { statusCode: 200, clientCertificate: unsafe, body: [{ kod: '160601', farligt: 'Ja' }] };
    if (input.url.endsWith('/transportsatt')) return { statusCode: 200, clientCertificate: unsafe, body: [{ transportsatt: 'R' }] };
    return { statusCode: 400, clientCertificate: unsafe, body: { Code: 1023, Message: 'Mismatch' } };
  } });
  const checked = await client.check(); assert.equal(checked.connected, true);
  assert.deepEqual(checked.diagnostics.map(item => item.clientCertificate), [certificate, certificate]);
  const rejected = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(rejected.error.code, 'NVV_REPORTER_IDENTITY'); assert.deepEqual(rejected.clientCertificate, certificate);
  for (const field of ['privateKey', 'pem', 'password', 'path']) {
    assert.equal(Object.hasOwn(rejected.clientCertificate, field), false);
    assert.ok(checked.diagnostics.every(item => !Object.hasOwn(item.clientCertificate, field)));
  }
  for (const forbidden of [localOnlyPfx, 'PRIVATE MATERIAL', f.env.NVV_CLIENT_PFX_PASSWORD, f.env.NVV_CLIENT_PFX_SECRET_FILE])
    assert.equal(JSON.stringify([checked, rejected]).includes(forbidden), false);
});

test('diagnostic sessions reject unsupported profiles, unapproved anonymous certificates and non-TEST modes without I/O or secret exposure', async t => {
  const f = await fixture(t), client = createNvvClient({ env: f.env, request: f.request });
  assert.equal((await client.status()).ready, true);
  const profiles = [null, [], 'not a profile', { tls: 'tls13' }, { endpoint: 'https://wrong.invalid' },
    { certificate: { p12Base64: localOnlyPfx, password: f.env.NVV_CLIENT_PFX_PASSWORD, path: f.env.NVV_CLIENT_PFX_SECRET_FILE } },
    { certificate: { p12Base64: 'not-base64', password: 'incorrect-private-password' } },
    { certificate: { p12Base64: localOnlyPfx, password: 'incorrect-private-password' } },
    { certificate: { p12Base64: localOnlyPfx, password: f.env.NVV_CLIENT_PFX_PASSWORD } }, {}];
  for (const profile of profiles) await assert.rejects(() => client.diagnosticSession(profile), cause => {
    assert.equal(cause.code, 'diagnostic_invalid');
    for (const secret of [localOnlyPfx, f.env.NVV_CLIENT_PFX_PASSWORD, f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_PFX_SECRET_FILE, 'incorrect-private-password'])
      assert.equal(String(cause).includes(secret), false);
    return true;
  });
  for (const mode of ['production', 'mock', 'disabled']) {
    const denied = createNvvClient({ env: { ...f.env, NVV_ENVIRONMENT: mode }, request: f.request });
    await assert.rejects(() => denied.diagnosticSession({ tls: 'tls12' }), cause => cause.code === 'diagnostic_invalid');
  }
  assert.equal(f.calls.length, 0);
});

test('diagnostic reads bound MaxAntalPerSida to 1–5 and reject invalid limits before network', async t => {
  const f = await fixture(t), client = createNvvClient({ env: f.env, request: f.request });
  for (const maxCount of [1, 5]) {
    const result = await client.read({ from: '2026-10-10T10:00:00Z', to: '2026-10-10T11:00:00Z', maxCount });
    assert.equal(result.outcome, 'accepted');
    const url = new URL(f.calls.at(-1).url);
    assert.equal(url.pathname, new URL(NVV_TEST_API_URL).pathname + '/anteckningar');
    assert.equal(url.searchParams.get('MaxAntalPerSida'), String(maxCount)); assert.equal(url.searchParams.get('Sida'), '1');
    assert.equal(url.searchParams.get('DatumTidFran'), '2026-10-10T10:00:00Z');
    assert.equal(url.searchParams.get('DatumTidTom'), '2026-10-10T11:00:00Z');
    assert.equal(f.calls.at(-1).method, 'GET');
  }
  const before = f.calls.length;
  for (const maxCount of [0, 6, -1, 1.5, '5', NaN, Infinity]) {
    const result = await client.read({ maxCount });
    assert.equal(result.outcome, 'rejected'); assert.equal(result.error.code, 'NVV_LIMIT');
  }
  assert.equal(f.calls.length, before);
});

test('normalized transport diagnostics include only bounded redacted TLS protocol and cipher', async t => {
  const f = await fixture(t), transport = { protocol: `TLSv1.2 ${f.env.NVV_CLIENT_SECRET}`, cipher: `TLS_FIXTURE_${f.env.NVV_CLIENT_PFX_PASSWORD}`,
    pfx: localOnlyPfx, password: f.env.NVV_CLIENT_PFX_PASSWORD, privateKey: 'PRIVATE MATERIAL' };
  const client = createNvvClient({ env: f.env, request: async input => input.url === NVV_TEST_TOKEN_URL ? f.request(input)
    : { statusCode: 400, transport, body: { Code: 1023, Message: 'Synthetic validation rejection' } } });
  const result = await client.submit({ method: 'POST', path: '/insamlingar', payload });
  assert.equal(result.error.code, 'NVV_REPORTER_IDENTITY');
  assert.deepEqual(result.transport, { protocol: 'TLSv1.2 [redacted]', cipher: 'TLS_FIXTURE_[redacted]' });
  for (const forbidden of [f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_PFX_PASSWORD, localOnlyPfx, 'PRIVATE MATERIAL'])
    assert.equal(JSON.stringify(result).includes(forbidden), false);
});
