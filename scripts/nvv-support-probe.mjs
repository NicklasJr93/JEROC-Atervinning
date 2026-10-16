import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNvvClient, requestHttps, NVV_TEST_API_URL, NVV_TEST_TOKEN_URL } from '../server/nvv-client.mjs';

const testCertificate = '71:0F:90:58:33:AA:17:60:90:89:48:AC:2A:DD:87:F3:B0:12:64:4E:88:6C:84:B5:FB:AB:13:A7:E5:5D:72:27';

export function supportPayload(time, id) {
  return {
    tidpunkt: time.toISOString(), verksamhetsutovare: '5593593626', verksamhetensNamn: 'JEROC Återvinning AB',
    verksamhetensKontaktpersonNamn: 'Testkontakt JEROC', verksamhetensKontaktpersonEpost: 'nvv-test@example.invalid',
    verksamhetensKontaktpersonTelefonnummer: '0700000000',
    ombud: '5560000167', ombudetsNamn: 'Testbolag 1', ombudetsKontaktpersonNamn: 'Testkontakt Ombud',
    ombudetsKontaktpersonEpost: 'nvv-ombud@example.invalid', ombudetsKontaktpersonTelefonnummer: '0700000000',
    referens: `JEROC-SUPPORT-${id.replaceAll('-', '').slice(0, 24)}`, avfall: { kod: '160601', mangd: 10 },
    mottagningsDatum: time.toISOString(), tidigareInnehavare: '5560000167', transportsatt: 'R',
    senasteHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Testgatan 12, Norrtälje', postnummer: '76141' } },
    kommandeHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Ängsvägen 19, Norrtälje', postnummer: '76141' } },
  };
}

// The shared client normally refreshes/replays after 401. This diagnostic
// deliberately forbids a second token request or report POST, even after 401.
export function singleAttemptTransport(request = requestHttps) {
  let tokenAttempts = 0, reportAttempts = 0;
  const exchange = { reportHttpStatus: null, traceId: null };
  const transport = async options => {
    if (options.method === 'POST' && options.url === NVV_TEST_TOKEN_URL && ++tokenAttempts === 1) return request(options);
    if (options.method === 'POST' && options.url === `${NVV_TEST_API_URL}/insamlingar` && ++reportAttempts === 1) {
      const response = await request(options);
      const status = Number(response.statusCode ?? response.status);
      if (Number.isInteger(status) && status >= 100 && status <= 599) exchange.reportHttpStatus = status;
      // Keep only a validated trace, never raw headers/body. A blocked refresh
      // after 401 can otherwise hide the first reply in client normalization.
      try {
        const body = typeof response.body === 'string' || Buffer.isBuffer(response.body) ? JSON.parse(String(response.body)) : response.body;
        const trace = body?.TraceId ?? body?.traceId;
        if (typeof trace === 'string' && /^[a-f0-9-]{1,100}$/i.test(trace)) exchange.traceId = trace;
      } catch { /* A malformed reply is retained by the shared safe client. */ }
      return response;
    }
    throw new Error('NVV_SUPPORT_PROBE_SECOND_OR_UNEXPECTED_REQUEST_BLOCKED');
  };
  transport.summary = () => ({ ...exchange, tokenAttempts, reportAttempts });
  return transport;
}

export async function runSupportProbe({ env = process.env, send = false } = {}) {
  const id = randomUUID(), startedAt = new Date(), payload = supportPayload(startedAt, id);
  const record = { id, trackingId: id, startedAt: startedAt.toISOString(), status: 'not_sent',
    request: { method: 'POST', url: `${NVV_TEST_API_URL}/insamlingar`, payload } };
  if (!send) return { ...record, message: 'Förhandsvisning. Inget anrop skickat. Kör med --send i Render för ett nytt TEST-försök.' };
  // Never turn disabled/mock/production into test implicitly or change settings.
  if (env.NVV_ENVIRONMENT !== 'test') return { ...record, status: 'blocked', error: 'NVV_ENVIRONMENT måste redan vara test.' };
  const transport = singleAttemptTransport();
  const client = createNvvClient({ env: { ...env }, request: transport });
  const config = await client.status();
  if (!config.ready) return { ...record, status: 'blocked', missing: config.missing, issues: config.issues };
  const diagnostic = await client.diagnosticSession({ tls: 'tls12' });
  const checked = await diagnostic.status();
  if (checked.certificate.organisationNumber !== '5560000167' || checked.certificate.fingerprint256 !== testCertificate)
    return { ...record, status: 'blocked', error: 'Provet kräver det verifierade Testbolag 1-certifikatet.' };
  record.certificate = checked.certificate;
  record.payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const directory = resolve('.data/nvv-support-probes');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const outputFile = resolve(directory, `${id}.json`);
  // Persist the reservation before network I/O; interrupted attempts stay unknown.
  await writeFile(outputFile, JSON.stringify({ ...record, status: 'in_flight' }, null, 2), { flag: 'wx', mode: 0o600 });
  let result;
  try { result = await diagnostic.submit({ method: 'POST', path: '/insamlingar', payload, trackingId: id }); }
  catch { result = { outcome: 'unknown', httpStatus: null, response: null, error: { code: 'NVV_UNKNOWN_OUTCOME', message: 'Svar saknas; skicka inte igen innan försöket är utrett.' } }; }
  const completed = { ...record, status: result.outcome, finishedAt: new Date().toISOString(), httpExchange: transport.summary(), result };
  await writeFile(outputFile, JSON.stringify(completed, null, 2), { mode: 0o600 });
  return { ...completed, outputFile };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(value => value !== '--send') || process.argv.slice(2).length > 1) {
    console.error('Använd: node scripts/nvv-support-probe.mjs [--send]');
    process.exitCode = 1;
  } else {
    try {
      const result = await runSupportProbe({ send: process.argv.includes('--send') });
      console.log(JSON.stringify(result, null, 2));
      if (['blocked', 'unknown', 'rejected'].includes(result.status)) process.exitCode = 1;
    } catch {
      console.error('NVV-provet avbröts. Ingen automatisk omsändning görs. Kontrollera konfigurationen eller eventuell sparad reservation.');
      process.exitCode = 1;
    }
  }
}
