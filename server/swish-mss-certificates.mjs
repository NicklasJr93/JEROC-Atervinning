import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

// This is the public test package linked by Swish's environments guide. It is
// not a customer certificate and cannot be used against Swish production.
export const SWISH_MSS_CERTIFICATES_URL = 'https://assets.ctfassets.net/4dca8u8ebqnn/4CgQJUfc6ncjKHooAkqvDx/d27012ce097a5b0f6b151a8ccdfe285d/MSS_test_3.0.zip';
export const SWISH_MSS_CERTIFICATES_SHA256 = '336be2bb02d2ec492b6e572abc8824375eefe912179ab05307b562e63a959f73';
export const SWISH_MSS_MERCHANT_ALIAS = '1234679304';
const filenames = Object.freeze({ tlsCert: 'Swish_Merchant_TestCertificate_1234679304.pem', tlsKey: 'Swish_Merchant_TestCertificate_1234679304.key',
  signingCert: 'Swish_Merchant_TestSigningCertificate_1234679304.pem', signingKey: 'Swish_Merchant_TestSigningCertificate_1234679304.key', ca: 'Swish_TLS_RootCA.pem' });
const fingerprints = Object.freeze({ tlsCert: 'BFA55491C33C9162A6715AECD48C7C091CD4F6C54C1156741AD118BAC06DADF2',
  signingCert: '3BB91B6B40D6C162801D2AA3B3A5603FE8EA978C5B240E68FD2923803AF1E424', ca: 'CB3CCBB76031E5E0138F8DD39A23F9DE47FFC35E43C1144CEA27D46A5AB1CB5F' });
const pending = new Map();

function fail() { throw new Error('SWISH_MSS_PUBLIC_CERTIFICATES_INVALID'); }

/** Certs and keys are kept on the server. Only serial/date metadata is public. */
export function validateSwishMssCredentials(credentials, now = Date.now()) {
  try {
    const certs = Object.fromEntries(['tlsCert', 'signingCert', 'ca'].map(name => [name, new X509Certificate(credentials[name])]));
    for (const [name, certificate] of Object.entries(certs)) {
      if (certificate.fingerprint256.replaceAll(':', '') !== fingerprints[name] ||
        now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) fail();
    }
    for (const [cert, key] of [['tlsCert', 'tlsKey'], ['signingCert', 'signingKey']]) {
      if (!certs[cert].checkPrivateKey(createPrivateKey(credentials[key])) || certs[cert].toLegacyObject().subject.CN !== SWISH_MSS_MERCHANT_ALIAS) fail();
    }
    if (certs.tlsCert.serialNumber === certs.signingCert.serialNumber) fail();
    return { signingSerial: certs.signingCert.serialNumber, validTo: new Date(certs.signingCert.validTo).toISOString(),
      tlsValidTo: new Date(certs.tlsCert.validTo).toISOString(), merchantAlias: SWISH_MSS_MERCHANT_ALIAS };
  } catch { fail(); }
}

/** Extract only the five known files, after checking the entire archive hash.
 * ZIP paths never become filesystem paths. No shell/unzip dependency on Render. */
export function extractSwishMssCredentials(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > 2 * 1024 * 1024 ||
    createHash('sha256').update(archive).digest('hex') !== SWISH_MSS_CERTIFICATES_SHA256) fail();
  let footer = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50 && offset + 22 + archive.readUInt16LE(offset + 20) === archive.length) { footer = offset; break; }
  }
  if (footer < 0 || archive.readUInt16LE(footer + 4) || archive.readUInt16LE(footer + 6)) fail();
  const count = archive.readUInt16LE(footer + 10), start = archive.readUInt32LE(footer + 16), size = archive.readUInt32LE(footer + 12);
  if (count > 50 || start + size !== footer) fail();
  const result = {}, wanted = new Map(Object.entries(filenames).map(([name, file]) => [`client_cert/${file}`, name]));
  let offset = start;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > footer || archive.readUInt32LE(offset) !== 0x02014b50) fail();
    const flags = archive.readUInt16LE(offset + 8), compression = archive.readUInt16LE(offset + 10), compressed = archive.readUInt32LE(offset + 20),
      expanded = archive.readUInt32LE(offset + 24), nameLength = archive.readUInt16LE(offset + 28), extraLength = archive.readUInt16LE(offset + 30),
      commentLength = archive.readUInt16LE(offset + 32), local = archive.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > footer || flags & 1 || ![0, 8].includes(compression)) fail();
    const filename = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!/^client_cert\/(?:[A-Za-z0-9_.]+)?$/.test(filename)) fail();
    const name = wanted.get(filename);
    if (name) {
      if (result[name] || expanded > 128 * 1024 || local + 30 > start || archive.readUInt32LE(local) !== 0x04034b50) fail();
      const localNameLength = archive.readUInt16LE(local + 26), localExtraLength = archive.readUInt16LE(local + 28), data = local + 30 + localNameLength + localExtraLength;
      if (data + compressed > start || archive.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== filename) fail();
      const source = archive.subarray(data, data + compressed), output = compression === 8 ? inflateRawSync(source, { maxOutputLength: 128 * 1024 }) : source;
      if (output.length !== expanded) fail();
      result[name] = output;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== footer || Object.keys(result).length !== wanted.size) fail();
  validateSwishMssCredentials(result);
  return result;
}

async function fetchArchive() {
  const response = await fetch(SWISH_MSS_CERTIFICATES_URL, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > 2 * 1024 * 1024) fail();
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { await response.body.cancel().catch(() => {}); fail(); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function readCredentials(directory) {
  const credentials = Object.fromEntries(await Promise.all(Object.entries(filenames).map(async ([name, filename]) => [name, await readFile(path.join(directory, filename))])));
  validateSwishMssCredentials(credentials);
  return credentials;
}

/** Opt-in public MSS provisioning; private files stay under ignored .data/. */
export async function ensureSwishMssCertificates({ directory = path.resolve('.data/swish-mss'), download = fetchArchive } = {}) {
  const target = path.resolve(directory);
  let promise = pending.get(target);
  if (promise) return promise;
  promise = (async () => {
    try { return await readCredentials(target); } catch { /* Restore an absent or invalid test-only cache from the pinned public archive. */ }
    const credentials = extractSwishMssCredentials(await download());
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const [name, filename] of Object.entries(filenames)) {
      const destination = path.join(target, filename), temporary = `${destination}.${process.pid}.tmp`;
      await writeFile(temporary, credentials[name], { mode: 0o600 });
      await rename(temporary, destination);
    }
    return readCredentials(target);
  })();
  pending.set(target, promise);
  try { return await promise; } finally { if (pending.get(target) === promise) pending.delete(target); }
}
