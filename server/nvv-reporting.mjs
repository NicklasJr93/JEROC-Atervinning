import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';
import { ENVIRONMENT_MUNICIPALITIES } from './environment-address.mjs';

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex');
const normalizeNumber = value => String(value ?? '').replace(/[\s-]/g, '');
const companyNumber = value => /^\d{2}[2-9]\d{7}$/.test(normalizeNumber(value));
const modes = { road: 'R', rail: 'T', sea: 'S', air: 'A' };
const LEASE_MS = 120000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validAvfallId = (value, mode) => typeof value === 'string' && (mode === 'mock' ? /^SIM-[0-9a-f-]{36}$/i.test(value) : uuid.test(value));
const addressText = /^[0-9A-Za-zÅÄÖÜÉåäöüé.,?:\-/()&+− ']{1,250}$/;
const reporterSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), name: z.string().trim().regex(addressText, 'Ange verksamhetens namn med högst 250 tecken.'), number: z.string().trim().transform(normalizeNumber).refine(companyNumber, 'Ange ett svenskt organisationsnummer.'),
  contactName: z.string().trim().regex(/^[A-Za-zÀ-ÖØ-öø-ž,.: '\-]{1,250}$/, 'Ange kontaktpersonens namn med högst 250 tecken.'), email: z.string().trim().email().max(250),
  phone: z.string().trim().transform(value => value.replace(/[()\s-]/g, '')).pipe(z.string().regex(/^(?:\+\d{2,3}[1-9]\d{2,11}|\d{2,12})$/, 'Ange kontaktpersonens telefonnummer.')),
  certificateOrganisationNumber: z.string().trim().max(30).transform(normalizeNumber).default(''), testIdentityConfirmed: z.boolean().default(false),
}).strict();
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) throw new EnvironmentError('Kontrollera NVV-uppgifterna: ' + result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), 422, 'nvv_invalid'); return result.data; };
const reporter = state => state.nvvSettings.at(-1) ?? null;
const fail = (message, status = 409, code = 'nvv_conflict') => { throw new EnvironmentError(message, status, code); };
const errorText = { code: 'transport_unknown', message: 'Anslutningen avbröts. NVV kan ha tagit emot anteckningen. Läs tillbaka innan ärendet hanteras vidare.' };
const audit = (state, time, principal, action, detail = {}) => {
  state.revision += 1;
  state.audit.push({ id: randomUUID(), at: time.toISOString(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id, actor: principal.user.name, action, ...detail });
};
const explicit = (principal, right) => principal.user.level === 'Systemadmin' || principal.user.permissions?.includes(right);
function demand(principal, right) { if (!explicit(principal, right)) fail('Du saknar behörighet för detta NVV-moment.', 403, 'forbidden'); }
function admin(principal) {
  demand(principal, 'environmentIntegration');
  if (principal.actor.level !== 'Systemadmin' || principal.user.level !== 'Systemadmin') fail('NVV-inställningar och anslutningsprov kräver att systemadmin arbetar som systemadmin.', 403, 'integration_admin_required');
  if (Array.isArray(principal.user.siteIds) || Array.isArray(principal.actor.siteIds)) fail('Globala NVV-inställningar kräver åtkomst till alla anläggningar.', 403, 'site_forbidden');
}
function reporterMissing(value, mode) {
  if (!value) return ['Komplettera verksamhetsutövaruppgifter: namn, organisationsnummer och kontaktperson.'];
  const missing = [];
  if (!companyNumber(value.number)) missing.push('Rapporterande verksamhet behöver ett svenskt organisationsnummer.');
  if (!reporterSchema.safeParse({ expectedVersion: value.version - 1, name: value.name, number: value.number, contactName: value.contactName, email: value.email, phone: value.phone,
    certificateOrganisationNumber: value.certificateOrganisationNumber, testIdentityConfirmed: value.testIdentityConfirmed }).success) missing.push('Komplettera rapporterande verksamhets kontaktuppgifter.');
  if (mode === 'test' && (!value.testIdentityConfirmed || value.certificateOrganisationNumber !== value.number)) missing.push('Bekräfta testförfarandet och att rapportörens organisationsnummer överensstämmer med klientcertifikatets organisation.');
  return missing;
}
function safeConfig(client) {
  const config = client.status();
  const mode = ['mock', 'test'].includes(config.mode) ? config.mode : 'disabled';
  return { mode, enabled: mode !== 'disabled', ready: mode !== 'disabled' && Boolean(config.ready), configurationId: config.configurationId,
    missing: [...(config.missing ?? []), ...(config.issues ?? [])], certificate: clone(config.certificate ?? { configured: false, validated: false, metadataAvailable: false }) };
}
const currentCheck = (state, config, value) => [...state.nvvChecks].reverse().find(item => item.mode === config.mode && item.reporterVersion === (value?.version ?? 0)
  && item.configurationId === config.configurationId);
const publicCheck = check => { if (!check) return null; const { configurationId, ...value } = clone(check); return value; };
function expireJobs(state, time) {
  for (const job of state.nvvJobs) {
    if (job.status === 'in_flight' && Date.parse(job.leaseUntil) <= time.getTime()) {
      if (!state.nvvAttempts.some(attempt => attempt.trackingId === job.trackingId)) state.nvvAttempts.push({ id: randomUUID(), versionId: job.versionId, trackingId: job.trackingId, kind: 'submit', startedAt: job.startedAt, finishedAt: time.toISOString(), outcome: 'unknown', httpStatus: null, response: null, mode: job.mode, error: { code: 'interrupted', message: 'Sändningen slutfördes inte lokalt. Läs tillbaka i TEST; skicka inte om automatiskt.' } });
      job.status = 'unknown'; job.updatedAt = time.toISOString(); job.lastError = { code: 'interrupted', message: 'Okänt resultat efter avbrott eller omstart.' }; delete job.leaseUntil;
      state.revision += 1;
    }
    if (job.readLeaseUntil && Date.parse(job.readLeaseUntil) <= time.getTime()) { delete job.readLeaseUntil; delete job.readTrackingId; }
  }
}
const relevant = (state, context, mode) => state.nvvReports.filter(version => version.receiptId === context.receipt.id && version.mode === mode && version.sourceReportIds.some(id => context.sourceReportIds.includes(id)));
const latestAccepted = (state, versions) => [...versions].reverse().map(version => ({ version, job: state.nvvJobs.find(job => job.versionId === version.id) })).find(item => item.job?.status === 'accepted' && item.job.avfallId);
const acceptedHeads = (state, versions) => {
  const accepted = versions.map(version => ({ version, job: state.nvvJobs.find(job => job.versionId === version.id) })).filter(item => item.job?.status === 'accepted' && item.job.avfallId);
  const replaced = new Set(accepted.map(item => item.version.previousAvfallId).filter(Boolean));
  return accepted.filter(item => !replaced.has(item.job.avfallId));
};

/** The server builds a fresh export payload around an immutable physical receipt.
 * Reporter settings never rewrite old receipt/operator snapshots or prices. */
export function buildNvvReceipt(context, value, mode, time, config, state) {
  const { receipt, row } = context, snapshot = receipt.snapshot;
  const missing = [...reporterMissing(value, mode)];
  if (mode === 'disabled') missing.unshift('NVV är avstängt. Aktivera mock eller TEST i serverns inställningar.');
  else if (!config.ready) missing.push(...config.missing);
  if (!companyNumber(snapshot.previousHolder?.number)) missing.push('Första TEST-etappen stöder företagsinlämning med svenskt organisationsnummer. Hushålls- och utlandsfallen verifieras separat.');
  if (!/^\d{6}$/.test(row.classification?.wasteCode ?? '')) missing.push('Komplettera artikelns sexsiffriga avfallskod.');
  if (mode === 'test') {
    const check = currentCheck(state, config, value);
    if (!check?.connected) missing.push('Genomför ett lyckat anslutningsprov i TEST före rapportering.');
    else {
      if (!check.wasteCodes?.some(item => item.code === row.classification.wasteCode && item.hazardous)) missing.push('Avfallskoden saknas som farlig kod i den hämtade NVV-kodlistan.');
      if (!check.transportModes?.some(item => item.code === modes[snapshot.transportMode])) missing.push('Transportsättet saknas i den hämtade NVV-kodlistan.');
    }
  }
  const rows = snapshot.rows.filter(item => item.classification.hazardous && item.classification.wasteCode === row.classification.wasteCode);
  if (rows.some(item => !Number.isFinite(item.weight) || item.weight <= 0 || Math.abs(item.weight * 1000 - Math.round(item.weight * 1000)) > .00001)) missing.push('Varje avfallsrad måste ha positiv kg med högst tre decimaler.');
  const total = Math.round(rows.reduce((sum, item) => sum + item.weight, 0) * 1000) / 1000;
  if (!Number.isFinite(total) || total <= 0 || total > 1e9 || Math.abs(total * 1000 - Math.round(total * 1000)) > .00001) missing.push('Avfallsmängden måste vara positiv kg med högst tre decimaler.');
  const mappedPlace = (place, label) => {
    if (!addressText.test(place?.address ?? '') || !/^\d{5}$/.test(place?.postalCode ?? '') || !ENVIRONMENT_MUNICIPALITIES.some(item => item.code === place?.municipalityCode)) missing.push(`Komplettera ${label}: adress (högst 250 tecken), postnummer och kommun.`);
    return { kommunkod: place?.municipalityCode ?? '', adress: { adressrad: place?.address ?? '', postnummer: place?.postalCode ?? '' } };
  };
  const last = mappedPlace(snapshot.lastPlace, 'senaste hanteringsplats'), next = mappedPlace(snapshot.nextPlace, 'kommande hanteringsplats');
  if (!modes[snapshot.transportMode]) missing.push('Komplettera transportsätt.');
  if (!Number.isFinite(Date.parse(snapshot.receivedAt)) || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.receivedAt ?? '')) missing.push('Komplettera faktiskt mottagningsdatum med entydig tidszon.');
  const previous = latestAccepted(state, relevant(state, context, mode));
  if (acceptedHeads(state, relevant(state, context, mode)).length > 1) missing.push('Rättelsen sammanför flera tidigare myndighetsanteckningar. Den kräver separat handläggning och kan inte skickas i denna TEST-etapp.');
  if (previous && previous.version.sourceReportIds.some(id => !context.sourceReportIds.includes(id))) missing.push('Rättelsen delar eller sammanför tidigare rapporterade avfallsslag. Den kräver separat handläggning och kan inte skickas i denna TEST-etapp.');
  const payload = value && {
    verksamhetsutovare: value.number, verksamhetensNamn: value.name, verksamhetensKontaktpersonNamn: value.contactName,
    verksamhetensKontaktpersonEpost: value.email, verksamhetensKontaktpersonTelefonnummer: value.phone,
    tidpunkt: new Date(time).toISOString(), avfall: { kod: row.classification.wasteCode, mangd: total }, transportsatt: modes[snapshot.transportMode],
    mottagningsDatum: snapshot.receivedAt, tidigareInnehavare: normalizeNumber(snapshot.previousHolder?.number), senasteHanteringsPlats: last, kommandeHanteringsPlats: next,
    referens: `JEROC-${hash({ receipt: receipt.id, version: receipt.version, code: row.classification.wasteCode }).slice(0, 32)}`,
  };
  return { missing: [...new Set(missing)], payload, weight: total, previous };
}

function projection(state, context, client, time) {
  const config = safeConfig(client), versions = relevant(state, context, config.mode);
  let current = [...versions].reverse().find(version => version.receiptVersion === context.receipt.version);
  const unsettled = [...versions].reverse().find(version => ['unknown', 'in_flight', 'queued'].includes(state.nvvJobs.find(job => job.versionId === version.id)?.status));
  if (unsettled) current = unsettled;
  const allVersions = state.nvvReports.filter(version => version.receiptId === context.receipt.id && version.sourceReportIds.some(id => context.sourceReportIds.includes(id)));
  const lastAccepted = latestAccepted(state, allVersions);
  if (config.mode === 'disabled' && lastAccepted?.version.receiptVersion === context.receipt.version) current = lastAccepted.version;
  const job = current && state.nvvJobs.find(job => job.versionId === current.id);
  const prior = latestAccepted(state, versions), prepared = buildNvvReceipt(context, reporter(state), config.mode, time, config, state);
  let status = prepared.missing.length ? 'incomplete' : 'ready';
  if (job) status = ({ queued: 'ready', in_flight: 'sending', accepted: current.mode === 'mock' ? 'simulated' : 'reported', rejected: 'error', unknown: 'unknown' })[job.status];
  else if (prior && prior.version.receiptVersion !== context.receipt.version) status = 'correction_required';
  return { status, mode: current?.mode ?? config.mode, configuredMode: config.mode, receiptVersion: context.receipt.version, missingFields: prepared.missing,
    ...(current && { versionId: current.id }), ...(job?.avfallId && { avfallId: job.avfallId }), ...(job?.lastError && { error: clone(job.lastError) }) };
}

/** Short durable reservations surround network I/O; no database lock spans HTTP. */
export function createNvvReporting({ transaction, read = transaction, principalFor, demandSite, resolveReport, client, now = () => new Date() }) {
  const adapter = client;
  let cached = { mode: 'disabled', ready: false, missing: ['NVV-konfigurationen är ännu inte inläst.'], issues: [], certificate: { configured: false, validated: false, metadataAvailable: false } };
  client = { ...adapter, status: () => cached };
  const prepare = async () => {
    // The identity binds a successful check to the exact key/certificate setup.
    // It stays internal and the PFX read completes before the database lock.
    const snapshot = adapter.configurationSnapshot ? await adapter.configurationSnapshot() : { status: await adapter.status() };
    cached = { ...snapshot.status, configurationId: snapshot.configurationId ?? hash({ injectedConfiguration: snapshot.status }) };
  };
  const authorize = (state, time, token, reportId, right = 'environmentRead') => {
    const { principal } = principalFor(state, token, time); demand(principal, right);
    const context = resolveReport(state, reportId); demandSite(state, principal, context.receipt.siteId); return { principal, context };
  };
  const statusValue = state => {
    const config = safeConfig(client), value = reporter(state), missing = [...config.missing, ...reporterMissing(value, config.mode)];
    const check = currentCheck(state, config, value);
    return { mode: config.mode, enabled: config.enabled, configured: config.ready && missing.length === 0, connected: Boolean(check?.connected), missing: [...new Set(missing)], reporter: value ? clone(value) : null,
      reporterVersion: value?.version ?? 0, lastCheck: publicCheck(check), certificate: config.certificate, productionEnabled: false };
  };
  const detail = (state, context, time) => {
    const current = projection(state, context, client, time), versions = state.nvvReports.filter(version => version.receiptId === context.receipt.id && version.sourceReportIds.some(id => context.sourceReportIds.includes(id))), ids = new Set(versions.map(item => item.id));
    return { reportId: context.reportId, ...current, versions: clone(versions), attempts: clone(state.nvvAttempts.filter(item => ids.has(item.versionId))),
      ...(current.versionId && { job: clone(state.nvvJobs.find(item => item.versionId === current.versionId)) }) };
  };
  const finish = async (reservation, result, kind) => transaction((state, time) => {
    expireJobs(state, time);
    const job = state.nvvJobs.find(item => item.versionId === reservation.version.id);
    if (!job) fail('NVV-försöket saknar sin beständiga reservation.', 409, 'reservation_missing');
    if (state.nvvAttempts.some(attempt => attempt.trackingId === reservation.trackingId && attempt.kind === kind && attempt.outcome === result.outcome && attempt.httpStatus === (result.httpStatus ?? null))) return;
    const record = { id: randomUUID(), versionId: reservation.version.id, trackingId: reservation.trackingId, kind, startedAt: reservation.startedAt,
      finishedAt: time.toISOString(), outcome: result.outcome, httpStatus: result.httpStatus ?? null, response: clone(result.response ?? null), mode: reservation.version.mode,
      ...(result.avfallId && { avfallId: result.avfallId }), ...(result.error && { error: clone(result.error) }) };
    state.nvvAttempts.push(record);
    if (kind === 'submit') {
      job.status = result.outcome; job.updatedAt = time.toISOString(); delete job.leaseUntil;
      if (result.outcome === 'accepted') { job.avfallId = result.avfallId; delete job.lastError; }
      else job.lastError = clone(result.error ?? errorText);
    } else {
      delete job.readLeaseUntil; delete job.readTrackingId;
      if (result.outcome === 'accepted' && result.avfallId) { job.status = 'accepted'; job.avfallId = result.avfallId; delete job.lastError; job.updatedAt = time.toISOString(); }
    }
    audit(state, time, reservation.principal, `nvv.${kind}_${result.outcome}`, { versionId: reservation.version.id, reportId: reservation.version.reportId, siteId: reservation.version.siteId, mode: reservation.version.mode, ...(result.avfallId && { avfallId: result.avfallId }) });
  });
  const runNetwork = async (operation, mode) => {
    try { return await operation(); } catch { return { outcome: 'unknown', httpStatus: null, response: null, mode, error: errorText }; }
  };
  return {
    prepare,
    projection: (state, context, time) => { expireJobs(state, time); return projection(state, context, client, time); },
    status(token) { return read((state, time) => { const { principal } = principalFor(state, token, time); demand(principal, 'environmentRead'); expireJobs(state, time); return statusValue(state); }, { settingsOnly: true }); },
    saveReporter(payload, token) {
      const request = parse(reporterSchema, payload);
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); admin(principal);
        if (request.expectedVersion !== (reporter(state)?.version ?? 0)) fail('NVV-inställningarna har ändrats. Läs in senaste versionen.', 409, 'version_conflict');
        const { expectedVersion, ...values } = request;
        const value = { id: randomUUID(), ...values, version: expectedVersion + 1, updatedAt: time.toISOString(), updatedBy: principal.user.name };
        state.nvvSettings.push(value); audit(state, time, principal, 'nvv.reporter_saved', { reporterVersion: value.version });
        return statusValue(state);
      });
    },
    async check(token) {
      const reservation = await read((state, time) => {
        const { principal } = principalFor(state, token, time); admin(principal);
        const value = statusValue(state);
        if (!value.configured) fail('Anslutningen kan inte provas ännu: ' + value.missing.join(' '), 422, 'nvv_setup_required');
        return { principal, reporterVersion: value.reporterVersion, configurationId: safeConfig(client).configurationId };
      }, { settingsOnly: true });
      let result, configurationId = reservation.configurationId;
      try {
        if (adapter.checkWithConfiguration) { const checked = await adapter.checkWithConfiguration(); result = checked.result; configurationId = checked.configurationId; }
        else result = await client.check();
      } catch { result = { mode: safeConfig(client).mode, connected: false, checkedAt: now().toISOString(), wasteCodes: [], transportModes: [], error: { code: 'connection_failed', message: 'Anslutningsprovet kunde inte slutföras.' } }; }
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); admin(principal);
        state.nvvChecks.push({ id: randomUUID(), ...clone(result), reporterVersion: reservation.reporterVersion, configurationId });
        audit(state, time, reservation.principal, 'nvv.connection_checked', { mode: result.mode, connected: result.connected }); return statusValue(state);
      });
    },
    detail(reportId, token) { return read((state, time) => { const { context } = authorize(state, time, token, reportId); expireJobs(state, time); return detail(state, context, time); }, { reportId }); },
    async send(reportId, payload, token) {
      const request = parse(z.object({ receiptVersion: z.number().int().positive(), idempotencyKey: z.string().trim().min(1).max(100) }).strict(), payload);
      const reservation = await transaction((state, time) => {
        const { principal, context } = authorize(state, time, token, reportId, 'environmentReport'); expireJobs(state, time);
        if (context.receipt.version !== request.receiptVersion) fail('Mottagningen har rättats. Läs in den aktuella versionen före utskick.', 409, 'version_conflict');
        const config = safeConfig(client), prepared = buildNvvReceipt(context, reporter(state), config.mode, time, config, state);
        const key = hash({ actor: principal.actor.id, idempotencyKey: request.idempotencyKey });
        const existingJob = state.nvvJobs.find(item => item.requestKey === key || item.requestKeys?.includes(key));
        if (existingJob) {
          const existing = state.nvvReports.find(item => item.id === existingJob.versionId);
          if (existing?.receiptId !== context.receipt.id || existing.receiptVersion !== request.receiptVersion || existing.mode !== config.mode || existing.wasteCode !== context.row.classification.wasteCode) fail('Samma utskicksförsök avser andra uppgifter.', 409, 'idempotency_conflict');
          return { skip: true };
        }
        const related = relevant(state, context, config.mode), jobs = state.nvvJobs.filter(item => related.some(version => version.id === item.versionId));
        const pending = jobs.find(item => ['queued', 'in_flight', 'unknown'].includes(item.status));
        if (pending) {
          if (state.nvvReports.find(item => item.id === pending.versionId)?.receiptVersion === request.receiptVersion) { pending.requestKeys ??= []; pending.requestKeys.push(key); }
          return { skip: true };
        }
        const accepted = prepared.previous;
        if (accepted && accepted.version.receiptVersion === context.receipt.version) { accepted.job.requestKeys ??= []; accepted.job.requestKeys.push(key); return { skip: true }; }
        if (prepared.missing.length) fail('Underlaget kan inte skickas: ' + prepared.missing.join(' '), 422, 'nvv_incomplete');
        if (accepted) demand(principal, 'environmentReportCorrect');
        const mode = config.mode, method = accepted ? 'PUT' : 'POST', previousAvfallId = accepted?.job.avfallId;
        const version = { id: randomUUID(), reportId: context.reportId, sourceReportIds: context.sourceReportIds, receiptId: context.receipt.id, receiptVersion: context.receipt.version,
          siteId: context.receipt.siteId, sourceId: context.receipt.sourceId, wasteCode: context.row.classification.wasteCode, weight: prepared.weight, mode, role: 'collector_receipt',
          method, path: method === 'POST' ? '/insamlingar' : `/insamlingar/${previousAvfallId}`, payload: prepared.payload, payloadHash: hash(prepared.payload), schemaVersion: 'BTFA.Anteckning-v1-1.2.8',
          reporterVersion: reporter(state).version, ...(previousAvfallId && { previousAvfallId }), createdAt: time.toISOString(), createdBy: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
        const trackingId = randomUUID(), startedAt = time.toISOString();
        state.nvvReports.push(version); state.nvvJobs.push({ id: randomUUID(), versionId: version.id, requestKey: key, status: 'in_flight', mode, trackingId, startedAt, leaseUntil: new Date(time.getTime() + LEASE_MS).toISOString(), updatedAt: startedAt });
        audit(state, time, principal, 'nvv.submit_reserved', { versionId: version.id, reportId, siteId: version.siteId, method, mode });
        return { principal, version, trackingId, startedAt };
      });
      if (!reservation.skip) {
        const result = await runNetwork(() => client.submit({ method: reservation.version.method, path: reservation.version.path, payload: reservation.version.payload, trackingId: reservation.trackingId }), reservation.version.mode);
        // A 2xx without a usable ID is never a safely accepted registration.
        if (result.outcome === 'accepted' && !validAvfallId(result.avfallId, reservation.version.mode)) { result.outcome = 'unknown'; result.error = { code: 'missing_avfall_id', message: 'Svaret saknar ett giltigt avfalls-ID. Läs tillbaka innan ytterligare åtgärder.' }; delete result.avfallId; }
        if (result.outcome === 'accepted' && reservation.version.previousAvfallId === result.avfallId) { result.outcome = 'unknown'; result.error = { code: 'unchanged_avfall_id', message: 'Rättelsen gav inte ett nytt avfalls-ID. Läs tillbaka och kontrollera myndighetens versionskedja.' }; delete result.avfallId; }
        await finish(reservation, result, 'submit');
      }
      return this.detail(reportId, token);
    },
    async reconcile(reportId, payload, token) {
      parse(z.object({}).strict(), payload);
      const reservation = await transaction((state, time) => {
        const { principal, context } = authorize(state, time, token, reportId, 'environmentReport'); expireJobs(state, time);
        const config = safeConfig(client), versions = relevant(state, context, config.mode), version = versions.at(-1), job = version && state.nvvJobs.find(item => item.versionId === version.id);
        if (!job || !['accepted', 'unknown'].includes(job.status)) fail('Det finns ingen kvittens eller osäker sändning att läsa tillbaka.', 409, 'readback_not_available');
        if (job.readLeaseUntil && Date.parse(job.readLeaseUntil) > time.getTime()) return { skip: true };
        const trackingId = randomUUID(), startedAt = time.toISOString();
        job.readLeaseUntil = new Date(time.getTime() + LEASE_MS).toISOString(); job.readTrackingId = trackingId;
        audit(state, time, principal, 'nvv.read_reserved', { versionId: version.id, mode: version.mode, siteId: version.siteId });
        return { principal, version: clone(version), job: clone(job), trackingId, startedAt };
      });
      if (!reservation.skip) {
        const from = new Date(Date.parse(reservation.job.startedAt) - 300000).toISOString();
        const raw = await runNetwork(() => client.read(reservation.job.avfallId ? { avfallId: reservation.job.avfallId } : { from, to: now().toISOString() }), reservation.version.mode);
        const result = matchReadback(raw, reservation.version, reservation.job);
        await finish(reservation, result, 'read');
      }
      return this.detail(reportId, token);
    },
  };
}

function matchReadback(result, version, job) {
  if (result.outcome !== 'accepted') return result;
  const body = result.response;
  const paginated = Number(body?.antalSidor ?? 1) > 1;
  const records = Array.isArray(body?.anteckningar) ? body.anteckningar : body && typeof body === 'object' ? [body] : [];
  const target = version.payload;
  const matches = records.filter(record => {
    const id = record.avfall?.avfallId ?? record.avfallId;
    return validAvfallId(id, version.mode) && (!job.avfallId || id === job.avfallId) && record.referens === target.referens
      && normalizeNumber(record.verksamhetsutovare) === target.verksamhetsutovare && String(record.avfall?.kod ?? '') === target.avfall.kod && Number(record.avfall?.mangd) === target.avfall.mangd
      && (job.avfallId || (Date.parse(record.mottagningsDatum) === Date.parse(target.mottagningsDatum)
        && hash(record.senasteHanteringsPlats) === hash(target.senasteHanteringsPlats) && hash(record.kommandeHanteringsPlats) === hash(target.kommandeHanteringsPlats)
        && normalizeNumber(record.tidigareInnehavare) === target.tidigareInnehavare));
  });
  if (!paginated && matches.length === 1) return { ...result, outcome: 'accepted', avfallId: matches[0].avfall?.avfallId ?? matches[0].avfallId };
  return { ...result, outcome: 'unknown', error: { code: 'readback_unconfirmed', message: 'TEST-läsningen gav ingen entydig matchning av den skickade versionen. Handlägg ärendet; skicka inte om automatiskt.' } };
}
