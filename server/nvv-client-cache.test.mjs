import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNvvClient, NVV_TEST_TOKEN_URL } from './nvv-client.mjs';

// These tests isolate cache behavior with synthetic certificate bytes. The
// existing nvv-client tests separately exercise real PKCS12/TLS validation.
const firstCertificate = Buffer.from('local-cache-certificate-A').toString('base64');
const secondCertificate = Buffer.from('local-cache-certificate-B').toString('base64');
const avfallId = '3cbf001c-5c51-4f31-a8a4-173dbd7e7bc8';

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'jeroc-nvv-cache-'));
  const file = join(directory, 'certificate.base64');
  await fs.writeFile(file, firstCertificate, { mode: 0o600 });
  const counts = { reads: 0, validations: 0 }, realRead = fs.readFile;
  t.mock.method(fs, 'readFile', async (...args) => { counts.reads++; return realRead(...args); });
  t.mock.method(tls, 'createSecureContext', ({ pfx }) => {
    counts.validations++;
    if (pfx.toString().startsWith('invalid')) throw new Error('Invalid synthetic certificate');
    return {};
  });
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(directory, { recursive: true, force: true }); });
  const env = { NVV_ENVIRONMENT: 'test', NVV_CLIENT_ID: 'private-cache-id', NVV_CLIENT_SECRET: 'private-cache-secret',
    NVV_CLIENT_PFX_PASSWORD: 'private-cache-pin', NVV_CLIENT_PFX_SECRET_FILE: file, NVV_CLIENT_SYSTEM_ID: 'JEROC cache tests 1' };
  const calls = [];
  const request = async input => {
    calls.push(input);
    if (input.url === NVV_TEST_TOKEN_URL) return { statusCode: 200, body: { access_token: 'private-cache-token', expires_in: 3600 } };
    if (input.url.endsWith('/avfallstyper')) return { statusCode: 200, body: [{ kod: '160601', farligt: true }] };
    if (input.url.endsWith('/transportsatt')) return { statusCode: 200, body: [{ transportsatt: 'R' }] };
    return { statusCode: 200, body: { avfallId } };
  };
  return { directory, file, env, counts, calls, client: createNvvClient({ env, request }) };
}

test('unchanged metadata and concurrent configuration reads reuse one private certificate validation', async t => {
  const f = await fixture(t);
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => f.client.configurationSnapshot()));
  assert.equal(new Set(snapshots.map(value => value.configurationId)).size, 1);
  assert.deepEqual(f.counts, { reads: 1, validations: 1 });
  for (let index = 0; index < 5; index++) assert.equal((await f.client.status()).ready, true);
  assert.deepEqual(f.counts, { reads: 1, validations: 1 });
  const publicStatus = await f.client.status();
  publicStatus.certificate.validated = false;
  publicStatus.missing.push('spoofed');
  publicStatus.issues.push('spoofed');
  const unchanged = await f.client.status();
  assert.equal(unchanged.certificate.validated, true);
  assert.deepEqual(unchanged.missing, []);
  assert.deepEqual(unchanged.issues, []);
  for (const secret of [f.env.NVV_CLIENT_ID, f.env.NVV_CLIENT_SECRET, f.env.NVV_CLIENT_PFX_PASSWORD, f.file, snapshots[0].configurationId])
    assert.equal(JSON.stringify(unchanged).includes(secret), false);
  assert.equal(f.calls.length, 0);
});

test('real check, submission and read reload file bytes while reusing unchanged TLS validation', async t => {
  const f = await fixture(t), before = await f.client.configurationSnapshot();
  const checked = await f.client.checkWithConfiguration();
  assert.equal(checked.result.connected, true);
  assert.equal(checked.configurationId, before.configurationId);
  const submitted = await f.client.submit({ method: 'POST', path: '/insamlingar', payload: { avfall: { kod: '160601', mangd: 10 } } });
  assert.equal(submitted.outcome, 'accepted');
  assert.equal((await f.client.read({ avfallId })).outcome, 'accepted');
  assert.deepEqual(f.counts, { reads: 4, validations: 1 });
  assert.equal(f.calls.filter(value => value.url === NVV_TEST_TOKEN_URL).length, 1);
});

test('credential, PIN, system ID, mode and path changes invalidate cached configuration', async t => {
  const f = await fixture(t), original = await f.client.configurationSnapshot();
  for (const field of ['NVV_CLIENT_ID', 'NVV_CLIENT_SECRET', 'NVV_CLIENT_PFX_PASSWORD', 'NVV_CLIENT_SYSTEM_ID']) {
    const previous = f.env[field];
    f.env[field] = `${previous}-changed`;
    assert.notEqual((await f.client.configurationSnapshot()).configurationId, original.configurationId);
    f.env[field] = previous;
    assert.equal((await f.client.configurationSnapshot()).configurationId, original.configurationId);
  }
  const copiedFile = join(f.directory, 'copied.base64');
  await fs.writeFile(copiedFile, firstCertificate);
  const priorReads = f.counts.reads;
  f.env.NVV_CLIENT_PFX_SECRET_FILE = copiedFile;
  assert.equal((await f.client.configurationSnapshot()).status.ready, true);
  assert.equal(f.counts.reads, priorReads + 1, 'new paths are read even when certificate bytes match');
  f.env.NVV_ENVIRONMENT = 'disabled';
  assert.equal((await f.client.status()).ready, false);
  assert.equal((await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} })).error.code, 'NVV_DISABLED');
  f.env.NVV_ENVIRONMENT = 'test';
  assert.equal((await f.client.status()).ready, true);
  assert.equal(f.calls.length, 0);
});

test('same-size timestamp-preserving replacement changes identity and invalidates OAuth reuse', async t => {
  const f = await fixture(t), before = await f.client.configurationSnapshot();
  await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} });
  const metadata = await fs.stat(f.file);
  const replacement = join(f.directory, 'replacement.base64');
  await fs.writeFile(replacement, secondCertificate);
  await fs.utimes(replacement, metadata.atime, metadata.mtime);
  await fs.rename(replacement, f.file);
  const after = await f.client.configurationSnapshot();
  assert.notEqual(after.configurationId, before.configurationId);
  assert.equal(after.status.ready, true);
  assert.equal(f.counts.validations, 2);
  await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} });
  assert.equal(f.calls.filter(value => value.url === NVV_TEST_TOKEN_URL).length, 2);
  assert.equal(f.calls.at(-1).pfx.toString(), Buffer.from(secondCertificate, 'base64').toString());
});

test('missing or invalid certificate fails closed and detects recovery without restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.status()).ready, true);
  await fs.unlink(f.file);
  assert.equal((await f.client.status()).ready, false);
  assert.equal((await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} })).outcome, 'rejected');
  await fs.writeFile(f.file, Buffer.from('invalid synthetic certificate').toString('base64'));
  assert.equal((await f.client.status()).ready, false);
  assert.equal((await f.client.check()).connected, false);
  await fs.writeFile(f.file, secondCertificate);
  assert.equal((await f.client.status()).ready, true);
  assert.equal(f.calls.length, 0);
});

test('forced network operation verifies bytes even when file metadata was preserved', async t => {
  const f = await fixture(t), metadata = await fs.stat(f.file, { bigint: true });
  await f.client.configurationSnapshot();
  t.mock.method(fs, 'stat', async () => metadata);
  syncBuiltinESMExports();
  await fs.writeFile(f.file, secondCertificate);
  await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} });
  assert.equal(f.counts.validations, 2);
  assert.equal(f.calls.at(-1).pfx.toString(), Buffer.from(secondCertificate, 'base64').toString());
});

test('coalesced real submissions still get separate operations and one certificate/OAuth load', async t => {
  const f = await fixture(t);
  const answers = await Promise.all(['cache-tracking-a', 'cache-tracking-b'].map(trackingId =>
    f.client.submit({ method: 'POST', path: '/insamlingar', payload: {}, trackingId })));
  assert.ok(answers.every(value => value.outcome === 'accepted'));
  assert.deepEqual(f.counts, { reads: 1, validations: 1 });
  assert.equal(f.calls.filter(value => value.url === NVV_TEST_TOKEN_URL).length, 1);
  assert.deepEqual(f.calls.filter(value => value.url.endsWith('/insamlingar')).map(value => value.headers['NV-Client-Tracking-ID']).sort(), ['cache-tracking-a', 'cache-tracking-b']);
});

test('a certificate changed during its read is reread before the snapshot is validated', async t => {
  const f = await fixture(t), readThrough = fs.readFile;
  let replaced = false;
  t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await readThrough(...args);
    if (!replaced) { replaced = true; await fs.writeFile(f.file, secondCertificate); }
    return bytes;
  });
  syncBuiltinESMExports();
  const snapshot = await f.client.configurationSnapshot();
  assert.equal(snapshot.status.ready, true);
  assert.deepEqual(f.counts, { reads: 2, validations: 1 });
  await f.client.submit({ method: 'POST', path: '/insamlingar', payload: {} });
  assert.equal(f.calls.at(-1).pfx.toString(), Buffer.from(secondCertificate, 'base64').toString());
  assert.equal((await f.client.configurationSnapshot()).configurationId, snapshot.configurationId);
});

test('an older pending configuration never overwrites the cache of a concurrent credential rotation', async t => {
  const f = await fixture(t), readThrough = fs.readFile;
  let release, started, reads = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { started = resolve; });
  t.mock.method(fs, 'readFile', async (...args) => {
    const bytes = await readThrough(...args);
    if (++reads === 1) { started(); await waiting; }
    return bytes;
  });
  syncBuiltinESMExports();
  const oldPending = f.client.configurationSnapshot();
  await reading;
  f.env.NVV_CLIENT_SECRET = 'private-concurrent-rotated-secret';
  const rotated = await f.client.configurationSnapshot();
  release();
  const original = await oldPending;
  assert.notEqual(original.configurationId, rotated.configurationId);
  const readCount = f.counts.reads;
  assert.equal((await f.client.configurationSnapshot()).configurationId, rotated.configurationId);
  assert.equal(f.counts.reads, readCount, 'late old completion must not replace the latest cache');
  assert.equal(f.calls.length, 0);
});
