import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';
import { parseNvvSandboxInput } from './nvv-sandbox.mjs';

const copy = value => structuredClone(value);
const fail = (message, status = 422, code = 'diagnostic_invalid') => { throw new EnvironmentError(message, status, code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outcomes = ['accepted', 'rejected', 'unknown'];
const operations = ['check', 'read', 'submit'];
const inputSchema = z.object({
  requestId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(100),
  operation: z.enum(operations), sourceRunId: z.string().uuid().optional(), payload: z.unknown().optional(),
  profile: z.object({ tls: z.enum(['auto', 'tls12']).optional(), certificate: z.object({
    p12Base64: z.string().min(4).max(24000).regex(/^[A-Za-z0-9+/]+={0,2}$/), password: z.string().max(300),
  }).strict().optional() }).strict().optional(),
}).strict();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function parseInput(value) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(value)); } catch { fail('Diagnostikförsöket måste vara JSON.'); }
  if (size > 32 * 1024) fail('Diagnostikförsöket är för stort.', 413, 'payload_too_large');
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) fail('Diagnostikförsöket innehåller okända fält eller fel datatyp.');
  const request = parsed.data;
  if (request.operation !== 'submit' && Object.hasOwn(value, 'payload')) fail('Endast ett utskick får innehålla ett rapportunderlag.');
  if (request.operation !== 'read' && request.sourceRunId !== undefined) fail('Ett tidigare testförsök får endast väljas vid läsning.');
  if (request.profile?.certificate) {
    const encoded = request.profile.certificate.p12Base64;
    if (encoded.length % 4 || Buffer.from(encoded, 'base64').toString('base64') !== encoded) fail('Diagnostikprofilen är inte giltig för NVV TEST.');
  }
  if (request.operation === 'submit') {
    // The existing strict OpenAPI schema is checked before opening a PFX or
    // fetching credentials. Business values are deliberately tested by NVV.
    request.payload = parseNvvSandboxInput({ requestId: request.requestId, idempotencyKey: request.idempotencyKey, payload: request.payload }).payload;
  }
  request.profile = { ...request.profile, tls: request.profile?.tls ?? 'auto' };
  return request;
}

function admin(principal) {
  if (principal.actor.level !== 'Systemadmin' || principal.user.level !== 'Systemadmin')
    fail('Testverktyget kräver att systemadmin arbetar som systemadmin.', 403, 'integration_admin_required');
  if (Array.isArray(principal.actor.siteIds) || Array.isArray(principal.user.siteIds))
    fail('Testverktyget kräver åtkomst till alla anläggningar.', 403, 'site_forbidden');
}
function requireTest(config) {
  if (config?.mode !== 'test') fail('Diagnostik tillåts endast i NVV TEST.', 409, 'diagnostic_test_only');
  if (!config.ready) fail('NVV TEST är inte färdigkonfigurerat.', 409, 'diagnostic_not_ready');
}
const unknownError = () => ({ code: 'NVV_UNKNOWN_OUTCOME', message: 'Testets svar saknas eller kan inte verifieras. Försöket skickas inte automatiskt igen.' });
function publicRun(run, time) {
  const result = Object.fromEntries(['id', 'status', 'diagnosticOperation', 'method', 'path', 'payload', 'startedAt', 'finishedAt', 'outcome',
    'httpStatus', 'response', 'error', 'trackingId', 'profile', 'clientCertificate', 'transport', 'avfallId', 'sourceRunId']
    .filter(key => run[key] !== undefined).map(key => [key, copy(run[key])]));
  const expires = run.leaseUntil ? Date.parse(run.leaseUntil) : Date.parse(run.startedAt) + 120000;
  if (run.status === 'in_flight' && (!Number.isFinite(expires) || time.getTime() >= expires))
    Object.assign(result, { status: 'unknown', outcome: 'unknown', error: unknownError() });
  return result;
}
function audit(state, time, principal, action, run) {
  state.revision += 1;
  state.audit.push({ id: randomUUID(), at: time.toISOString(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
    actor: principal.user.name, action, runId: run.id, trackingId: run.trackingId, mode: 'test', status: run.status });
}

// Only the locally supplied public test PFX/password need additional redaction;
// the client already removes its configured OAuth credentials and tokens.
function sanitizer(profile) {
  const secrets = [profile.certificate?.p12Base64, profile.certificate?.password].filter(value => typeof value === 'string' && value.length > 0);
  const redactText = value => {
    let output = value;
    for (const secret of secrets) output = output.split(secret).join('[redacted]');
    return output;
  };
  const clean = (value, depth = 0) => {
    if (depth > 8) return '[summarized]';
    if (typeof value === 'string') return redactText(value).slice(0, 16000);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (Array.isArray(value)) return value.slice(0, 50).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [redactText(key),
      /authorization|cookie|password|passphrase|secret|token|p12|pfx|private.?key|certificate.?bytes/i.test(key) ? '[redacted]' : clean(item, depth + 1)]));
    return null;
  };
  return { clean, redactText };
}
function transport(value, clean) {
  if (!value || typeof value !== 'object') return undefined;
  return { protocol: typeof value.protocol === 'string' ? clean(value.protocol).slice(0, 30) : null,
    cipher: typeof value.cipher === 'string' ? clean(value.cipher).slice(0, 100) : null };
}
function certificate(value, clean) {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(['organisationName', 'organisationNumber', 'issuer', 'validFrom', 'validTo', 'fingerprint256']
    .filter(key => typeof value[key] === 'string' || value[key] === null).map(key => [key, clean(value[key])]));
}
function safeError(value, outcome, clean, operation) {
  if (outcome === 'accepted') return undefined;
  if (!value || typeof value !== 'object') return outcome === 'unknown' ? unknownError() : { code: 'NVV_REJECTED', message: 'Naturvårdsverket avvisade testförsöket.' };
  const code = typeof value.code === 'string' ? clean(value.code).slice(0, 100) : 'NVV_REJECTED';
  return { code, message: operation === 'submit' && typeof value.message === 'string' ? clean(value.message).slice(0, 1000)
    : outcome === 'unknown' ? 'Naturvårdsverkets svar kunde inte verifieras.' : 'Naturvårdsverket avvisade kontrollen eller läsningen.' };
}
const http = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function checkSummary(result, clean) {
  const diagnostics = (Array.isArray(result?.diagnostics) ? result.diagnostics : []).slice(0, 8)
    .filter(item => item && [['GET', '/avfallstyper'], ['GET', '/transportsatt'], ['POST', '/oauth2/token']].some(([method, path]) => item.method === method && item.path === path))
    .map(item => ({ method: item.method, path: item.path, httpStatus: http(item.httpStatus), outcome: outcomes.includes(item.outcome) ? item.outcome : 'unknown',
      ...(typeof item.trackingId === 'string' && { trackingId: clean(item.trackingId).slice(0, 200) }),
      response: Object.fromEntries(['count', 'sixDigitCodes'].filter(key => Number.isInteger(item.response?.[key]) && item.response[key] >= 0).map(key => [key, item.response[key]])),
      ...(transport(item.transport, clean) && { transport: transport(item.transport, clean) }) }));
  return { connected: result?.connected === true, wasteCodeCount: Array.isArray(result?.wasteCodes) ? result.wasteCodes.length : 0,
    transportModeCount: Array.isArray(result?.transportModes) ? result.transportModes.length : 0, diagnostics };
}
function companyNumber(value) {
  if (typeof value !== 'string') return null;
  let number = value.trim().replace(/[\s-]/g, '');
  if (/^NTRSE\d{10}$/i.test(number)) number = number.slice(5);
  else if (/^SE\d{10}(?:01)?$/i.test(number)) number = number.slice(2, 12);
  else if (/^16\d{10}$/.test(number)) number = number.slice(2);
  return /^\d{2}[2-9]\d{7}$/.test(number) ? number : null;
}
function readSummary(response, avfallId) {
  const body = response?.ResponseObject ?? response;
  const records = Array.isArray(body) ? body : body && typeof body === 'object' && Object.hasOwn(body, 'anteckningar')
    ? Array.isArray(body.anteckningar) ? body.anteckningar : []
    : body && typeof body === 'object' && ['verksamhetsutovare', 'ombud', 'avfall'].some(key => Object.hasOwn(body, key)) ? [body] : [];
  // The request is limited to one record; do not retain provider contacts or
  // reporters' identities even if an unexpected oversized response arrives.
  const selected = records.slice(0, 1);
  const count = records.length;
  const summary = { count, uniqueVerksamhetsutovare: [...new Set(selected.map(item => companyNumber(item?.verksamhetsutovare)).filter(Boolean))],
    uniqueOmbud: [...new Set(selected.map(item => companyNumber(item?.ombud)).filter(Boolean))] };
  if (avfallId) {
    const item = selected[0], found = item?.avfall?.avfallId ?? item?.avfallId ?? item?.AvfallsId;
    if (typeof found === 'string' && uuid.test(found) && found.toLowerCase() === avfallId.toLowerCase()) summary.verifieradAvfallsId = found;
    if (typeof item?.avfall?.kod === 'string' && /^\d{6}$/.test(item.avfall.kod)) summary.avfallkod = item.avfall.kod;
    if (typeof item?.avfall?.mangd === 'number' && Number.isFinite(item.avfall.mangd)) summary.mangd = item.avfall.mangd;
  }
  return summary;
}

/** Restricted adaptive diagnostics. Persist only reservations and safe results;
 * credential profiles live exclusively in memory and network calls never run
 * under a database lock. A read-only request never dispatches any NVV request. */
export function createNvvDiagnostics({ transaction, read, principalFor, client }) {
  const authorize = (state, time, token) => { const { principal } = principalFor(state, token, time); admin(principal); return principal; };
  const isDiagnostic = run => operations.includes(run.diagnosticOperation);
  const existing = (state, request, principal, payloadHash) => {
    const keyHash = hash(['diagnostic', principal.actor.id, principal.user.id, request.idempotencyKey]);
    const prior = state.nvvSandboxRuns.find(run => run.id === request.requestId || isDiagnostic(run) && run.keyHash === keyHash);
    if (!prior) return { keyHash };
    if (!isDiagnostic(prior) || prior.id !== request.requestId || prior.keyHash !== keyHash || prior.payloadHash !== payloadHash)
      fail('Samma diagnostikförsök innehåller andra uppgifter. Skapa ett nytt testförsök.', 409, 'idempotency_conflict');
    return { prior, keyHash };
  };
  return {
    async status(token) {
      const runs = await read((state, time) => { authorize(state, time, token); return state.nvvSandboxRuns.filter(isDiagnostic)
        .slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50).map(run => publicRun(run, time)); });
      const config = await client.status();
      return { mode: config.mode, ready: config.mode === 'test' && config.ready === true,
        missing: [...new Set([...(config.missing ?? []), ...(config.issues ?? []), ...(config.mode === 'test' ? [] : ['Diagnostik kräver NVV TEST.'])])], runs };
    },
    run(id, token) { return read((state, time) => { authorize(state, time, token);
      const run = state.nvvSandboxRuns.find(item => item.id === id && isDiagnostic(item));
      if (!run) fail('Diagnostikförsöket finns inte.', 404, 'not_found'); return publicRun(run, time); }); },
    async send(input, token) {
      const request = parseInput(input);
      await read((state, time) => { authorize(state, time, token); });
      // Required for every call, including returning an existing reservation.
      requireTest(await client.status());
      let diagnosticClient, config;
      try { diagnosticClient = await client.diagnosticSession(request.profile); config = await diagnosticClient.status(); }
      catch { fail('Diagnostikprofilen är inte giltig för NVV TEST.'); }
      requireTest(config);
      const certificateFP = config.certificate?.fingerprint256;
      if (typeof certificateFP !== 'string' || !certificateFP.trim() || certificateFP.length > 200) fail('Diagnostikprofilens certifikat kan inte identifieras.');
      const profile = { tls: request.profile.tls, certificateFP, certificateName: typeof config.certificate?.organisationName === 'string' ? config.certificate.organisationName.slice(0, 300) : null };
      const { clean } = sanitizer(request.profile);
      // Prevent documented business fields from being used to archive a
      // supplied credential accidentally; hashes never include passwords.
      if (request.payload && JSON.stringify(clean(request.payload)) !== JSON.stringify(request.payload)) fail('Testunderlaget får inte innehålla profilens certifikat eller lösenord.');
      const payloadHash = hash({ operation: request.operation, tls: profile.tls, certificateFP, payload: request.payload ?? null, sourceRunId: request.sourceRunId ?? null });
      const reservation = await transaction((state, time) => {
        const principal = authorize(state, time, token), match = existing(state, request, principal, payloadHash);
        if (match.prior) return { prior: publicRun(match.prior, time) };
        let sourceAvfallId;
        if (request.sourceRunId) {
          const source = state.nvvSandboxRuns.find(run => run.id === request.sourceRunId && run.diagnosticOperation === 'submit');
          if (!source || source.status !== 'accepted' || !uuid.test(source.avfallId ?? '') || source.profile?.certificateFP !== certificateFP)
            fail('Läsningen kräver en godkänd TEST-kvittens med samma klientcertifikat.', 409, 'diagnostic_source_invalid');
          sourceAvfallId = source.avfallId;
        }
        const run = { id: request.requestId, keyHash: match.keyHash, payloadHash, diagnosticOperation: request.operation, profile,
          status: 'in_flight', method: request.operation === 'submit' ? 'POST' : 'GET',
          path: request.operation === 'submit' ? '/insamlingar' : request.operation === 'check' ? '/avfallstyper + /transportsatt' : sourceAvfallId ? `/anteckningar/${sourceAvfallId}` : '/anteckningar',
          payload: copy(request.payload ?? null), startedAt: time.toISOString(), leaseUntil: new Date(time.getTime() + 120000).toISOString(),
          trackingId: randomUUID(), httpStatus: null, response: null, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
          ...(request.sourceRunId && { sourceRunId: request.sourceRunId }), ...(sourceAvfallId && { sourceAvfallId }),
          ...(request.operation === 'read' && !sourceAvfallId && { readWindow: { from: new Date(time.getTime() - 600000).toISOString(), to: new Date(time.getTime() + 60000).toISOString(), maxCount: 1 } }) };
        state.nvvSandboxRuns.push(run); audit(state, time, principal, 'nvv.diagnostic_reserved', run);
        return { run: copy(run), principal: copy(principal) };
      });
      if (reservation.prior) return reservation.prior;
      const run = reservation.run;
      let result;
      try {
        if (run.diagnosticOperation === 'check') result = await diagnosticClient.check();
        else if (run.diagnosticOperation === 'read') result = await diagnosticClient.read(run.sourceAvfallId ? { avfallId: run.sourceAvfallId } : copy(run.readWindow));
        else result = await diagnosticClient.submit({ method: 'POST', path: '/insamlingar', payload: copy(run.payload), trackingId: run.trackingId });
      } catch { result = { outcome: 'unknown', httpStatus: null, response: null, error: unknownError() }; }
      let outcome = outcomes.includes(result?.outcome) ? result.outcome : 'unknown';
      let response, httpStatus = http(result?.httpStatus);
      if (run.diagnosticOperation === 'check') {
        response = checkSummary(result, clean);
        outcome = result?.connected === true ? 'accepted' : result?.outcome === 'unknown' || response.diagnostics.some(item => item.outcome === 'unknown') ? 'unknown'
          : response.diagnostics.some(item => item.outcome === 'rejected') || result?.error ? 'rejected' : 'unknown';
        httpStatus = response.diagnostics.at(-1)?.httpStatus ?? null;
      } else if (run.diagnosticOperation === 'read') response = readSummary(result?.response, run.sourceAvfallId);
      else response = clean(result?.response ?? null);
      if (result?.mode && result.mode !== 'test') outcome = 'unknown';
      if (run.diagnosticOperation === 'submit' && outcome === 'accepted'
        && (result?.mode !== 'test' || ![200, 201].includes(httpStatus) || !uuid.test(result?.avfallId ?? ''))) outcome = 'unknown';
      const resultError = safeError(result?.error, outcome, clean, run.diagnosticOperation);
      const transportInfo = transport(result?.transport, clean) ?? response?.diagnostics?.findLast(item => item.transport)?.transport;
      const certificateInfo = certificate(result?.clientCertificate, clean);
      return transaction((state, time) => {
        const current = state.nvvSandboxRuns.find(item => item.id === run.id && isDiagnostic(item));
        if (!current || current.payloadHash !== run.payloadHash) fail('Diagnostikförsökets beständiga reservation saknas.', 409, 'reservation_missing');
        if (current.status !== 'in_flight') return publicRun(current, time);
        Object.assign(current, { status: outcome, outcome, finishedAt: time.toISOString(), httpStatus, response });
        if (resultError) current.error = resultError;
        if (transportInfo) current.transport = transportInfo;
        if (certificateInfo) current.clientCertificate = certificateInfo;
        const trackingId = typeof result?.trackingId === 'string' ? clean(result.trackingId).slice(0, 200) : undefined;
        if (trackingId && /^[\x20-\x7e]{1,200}$/.test(trackingId)) current.trackingId = trackingId;
        if (run.diagnosticOperation === 'submit' && outcome === 'accepted') current.avfallId = result.avfallId;
        audit(state, time, reservation.principal, `nvv.diagnostic_${outcome}`, current);
        return publicRun(current, time);
      });
    },
  };
}
