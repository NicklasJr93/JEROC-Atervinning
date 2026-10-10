import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';

const copy = value => structuredClone(value);
const fail = (message, status = 422, code = 'sandbox_invalid') => { throw new EnvironmentError(message, status, code); };
const text = z.string().max(16000), numeric = z.number().finite();
const nullableText = text.nullable().optional();
const address = z.object({ adressrad: nullableText, postnummer: nullableText }).strict();
const coordinate = z.object({ nposition: numeric.int().optional(), eposition: numeric.int().optional(), beskrivning: nullableText }).strict();
const place = z.object({ kommunkod: text.optional(), adress: address.optional(), koordinat: coordinate.optional(), cfarNR: nullableText, land: nullableText }).strict();
// All documented fields are allowed, including ombud. Business validation is
// intentionally left to NVV in this diagnostic TEST page. Unknown keys cannot
// become URLs, request headers, credentials, private material or prototypes.
const payloadSchema = z.object({ tidpunkt: text.optional(), ombud: nullableText, ombudetsNamn: nullableText,
  ombudetsKontaktpersonNamn: nullableText, ombudetsKontaktpersonEpost: nullableText, ombudetsKontaktpersonTelefonnummer: nullableText,
  verksamhetsutovare: text.optional(), verksamhetensNamn: text.optional(), verksamhetensKontaktpersonNamn: text.optional(),
  verksamhetensKontaktpersonEpost: text.optional(), verksamhetensKontaktpersonTelefonnummer: text.optional(), referens: nullableText,
  avfall: z.object({ kod: text.optional(), mangd: numeric.optional(), foregaendeAvfallId: nullableText }).strict().optional(),
  mottagningsDatum: text.optional(), tidigareInnehavare: text.optional(), kommandeHanteringsPlats: place.optional(),
  senasteHanteringsPlats: place.optional(), transportsatt: text.optional(),
}).strict();
const inputSchema = z.object({ requestId: z.string().uuid(), idempotencyKey: z.string().trim().min(1).max(100), payload: payloadSchema }).strict();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function parseNvvSandboxInput(value) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(value)); } catch { fail('Testunderlaget måste vara JSON.'); }
  if (size > 128 * 1024) fail('Testunderlaget är för stort.', 413, 'payload_too_large');
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) fail('Testunderlaget innehåller okända fält eller fel datatyp. Använd endast dokumenterade NVV-fält.');
  return parsed.data;
}

function admin(principal) {
  // Systemadmin has this right in the existing environment permission model.
  if (principal.user.level !== 'Systemadmin' && !principal.user.permissions?.includes('environmentIntegration'))
    fail('Du saknar behörighet att administrera miljöintegrationer.', 403, 'forbidden');
  if (principal.actor.level !== 'Systemadmin' || principal.user.level !== 'Systemadmin')
    fail('Testverktyget kräver att systemadmin arbetar som systemadmin.', 403, 'integration_admin_required');
  if (Array.isArray(principal.actor.siteIds) || Array.isArray(principal.user.siteIds))
    fail('Testverktyget kräver åtkomst till alla anläggningar.', 403, 'site_forbidden');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicRun = (run, time) => {
  const result = Object.fromEntries(['id', 'status', 'method', 'path', 'payload', 'startedAt', 'finishedAt', 'outcome', 'httpStatus',
    'response', 'error', 'trackingId', 'clientCertificate', 'avfallId'].filter(key => run[key] !== undefined).map(key => [key, copy(run[key])]));
  // A crash does not prove that NVV rejected the request. Project a stale
  // reservation as unknown, retaining its ID and never dispatching it again.
  // A late response may still complete the stored in-flight reservation.
  const expires = run.leaseUntil ? Date.parse(run.leaseUntil) : Date.parse(run.startedAt) + 120000;
  if (run.status === 'in_flight' && (!Number.isFinite(expires) || time.getTime() >= expires))
    Object.assign(result, { status: 'unknown', outcome: 'unknown', error: { code: 'NVV_UNKNOWN_OUTCOME',
      message: 'Testets svar saknas efter avbrott eller timeout. Det kan ha nått NVV och skickas inte automatiskt igen.' } });
  return result;
};
function audit(state, time, principal, action, run) {
  state.revision += 1;
  state.audit.push({ id: randomUUID(), at: time.toISOString(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
    actor: principal.user.name, action, runId: run.id, trackingId: run.trackingId, mode: 'test', status: run.status });
}
function template(config, reporter, time) {
  return { tidpunkt: time.toISOString(), verksamhetsutovare: config.certificate?.organisationNumber ?? reporter?.number ?? '',
    verksamhetensNamn: config.certificate?.organisationName ?? reporter?.name ?? '', verksamhetensKontaktpersonNamn: reporter?.contactName ?? 'Testkontakt',
    verksamhetensKontaktpersonEpost: reporter?.email ?? 'test@example.invalid', verksamhetensKontaktpersonTelefonnummer: reporter?.phone ?? '0100000000',
    referens: `JEROC-SANDBOX-${randomUUID().slice(0, 24)}`, avfall: { kod: '160601', mangd: 10 }, transportsatt: 'R',
    mottagningsDatum: time.toISOString(), tidigareInnehavare: '5560000167',
    senasteHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Testgatan 12, Norrtälje', postnummer: '76141' } },
    kommandeHanteringsPlats: { kommunkod: '0188', adress: { adressrad: 'Ängsvägen 19, Norrtälje', postnummer: '76141' } } };
}

/** A durable sandbox reservation never touches receipts, reports, cards, stock
 * or money. No network call runs inside a database lock or a GET request. */
export function createNvvSandbox({ transaction, read, principalFor, client }) {
  const authorize = (state, time, token) => { const { principal } = principalFor(state, token, time); admin(principal); return principal; };
  const existing = (state, request, principal) => {
    const keyHash = hash([principal.actor.id, principal.user.id, request.idempotencyKey]);
    const prior = state.nvvSandboxRuns.find(run => run.id === request.requestId || run.keyHash === keyHash);
    if (!prior) return { keyHash };
    if (prior.diagnosticOperation || prior.id !== request.requestId || prior.keyHash !== keyHash || prior.payloadHash !== hash(request.payload))
      fail('Samma testförsök innehåller andra uppgifter. Skapa ett nytt testförsök.', 409, 'idempotency_conflict');
    return { prior, keyHash };
  };
  return {
    async status(token) {
      const context = await read((state, time) => { authorize(state, time, token); return { reporter: copy(state.nvvSettings.at(-1) ?? null), time,
        runs: state.nvvSandboxRuns.filter(run => !run.diagnosticOperation).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50).map(run => publicRun(run, time)) }; });
      const config = await client.status();
      return { mode: config.mode, ready: config.mode === 'test' && config.ready, missing: [...new Set([...(config.missing ?? []), ...(config.issues ?? []), ...(config.mode === 'test' ? [] : ['Fristående testutskick kräver NVV TEST.'])])],
        certificate: copy(config.certificate ?? null), template: template(config, context.reporter, context.time), runs: context.runs };
    },
    run(id, token) { return read((state, time) => { authorize(state, time, token); const run = state.nvvSandboxRuns.find(item => item.id === id && !item.diagnosticOperation);
      if (!run) fail('Testförsöket finns inte.', 404, 'not_found'); return publicRun(run, time); }); },
    async send(payload, token) {
      const request = parseNvvSandboxInput(payload);
      const prior = await read((state, time) => { const match = existing(state, request, authorize(state, time, token)); return match.prior && publicRun(match.prior, time); });
      if (prior) return prior;
      const config = await client.status();
      const reservation = await transaction((state, time) => {
        const principal = authorize(state, time, token), match = existing(state, request, principal);
        if (match.prior) return { prior: publicRun(match.prior, time) };
        if (config.mode !== 'test') fail('Fristående testutskick tillåts endast i NVV TEST.', 409, 'sandbox_test_only');
        if (!config.ready) fail('NVV TEST är inte färdigkonfigurerat.', 409, 'sandbox_not_ready');
        const run = { id: request.requestId, keyHash: match.keyHash, payloadHash: hash(request.payload), status: 'in_flight', method: 'POST', path: '/insamlingar',
          payload: copy(request.payload), startedAt: time.toISOString(), leaseUntil: new Date(time.getTime() + 120000).toISOString(), trackingId: randomUUID(), httpStatus: null, response: null,
          actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
        state.nvvSandboxRuns.push(run); audit(state, time, principal, 'nvv.sandbox_reserved', run);
        return { run: copy(run), principal: copy(principal) };
      });
      if (reservation.prior) return reservation.prior;
      let result;
      try { result = await client.submit({ method: 'POST', path: '/insamlingar', payload: copy(reservation.run.payload), trackingId: reservation.run.trackingId }); }
      catch { result = { outcome: 'unknown', httpStatus: null, response: null, error: { code: 'NVV_UNKNOWN_OUTCOME', message: 'Svar saknas. Testet kan ha nått NVV och skickas inte automatiskt igen.' } }; }
      if (result?.outcome === 'accepted' && (!uuid.test(result.avfallId ?? '') || result.mode && result.mode !== 'test')) {
        result = { ...result, outcome: 'unknown', error: { code: 'NVV_UNKNOWN_OUTCOME', message: 'Svaret innehåller ingen verifierbar TEST-kvittens. Testet skickas inte automatiskt igen.' } };
        delete result.avfallId;
      }
      return transaction((state, time) => {
        const run = state.nvvSandboxRuns.find(item => item.id === reservation.run.id);
        if (!run || run.payloadHash !== reservation.run.payloadHash) fail('Testförsökets beständiga reservation saknas.', 409, 'reservation_missing');
        if (run.status !== 'in_flight') return publicRun(run, time);
        const status = ['accepted', 'rejected', 'unknown'].includes(result?.outcome) ? result.outcome : 'unknown';
        Object.assign(run, { status, outcome: status, finishedAt: time.toISOString(), httpStatus: result?.httpStatus ?? null, response: copy(result?.response ?? null) });
        for (const key of ['error', 'avfallId', 'clientCertificate']) if (result?.[key] !== undefined) run[key] = copy(result[key]);
        audit(state, time, reservation.principal, `nvv.sandbox_${status}`, run);
        return publicRun(run, time);
      });
    },
  };
}
