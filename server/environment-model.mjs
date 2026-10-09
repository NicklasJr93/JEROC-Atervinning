import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';
import { ENVIRONMENT_MUNICIPALITIES, parseOriginAddress } from './environment-address.mjs';

export const ENVIRONMENT_DEMO_PASSWORD = 'JerocDemo2026!';
export const ENVIRONMENT_SITES = [
  { id: 'norrtalje', name: 'Norrtälje', address: 'Ängsvägen 19', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' },
  { id: 'rimbo', name: 'Rimbo', address: '', postalCode: '', city: 'Rimbo', municipalityCode: '0188' },
];
const STAFF_AGE = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW = 10 * 60 * 1000;
const id = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const short = z.string().trim().min(1).max(300);
const optionalText = z.string().trim().max(500).default('');
const placeSchema = z.object({
  address: short, postalCode: z.string().trim().transform((value) => value.replaceAll(' ', '')).pipe(z.string().regex(/^\d{5}$/)),
  city: short, municipalityCode: z.string().trim().regex(/^\d{4}$/),
}).strict();
const holderSchema = z.object({
  name: short, number: z.string().trim().transform((value) => value.replaceAll(/[\s-]/g, '')).pipe(z.string().regex(/^(?:\d{10}|\d{12}|[A-Z]{2}[A-Z0-9]{2,30})$/)),
  contactName: optionalText, email: z.union([z.string().trim().email().max(200), z.literal('')]).default(''), phone: z.string().trim().max(50).default(''),
}).strict();
const classificationSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), hazardous: z.boolean(),
  wasteCode: z.string().trim().max(6), wasteDescription: z.string().trim().max(1000),
  handlingInstructions: z.string().trim().max(5000), adrRequired: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.hazardous && !/^\d{6}$/.test(value.wasteCode)) context.addIssue({ code: 'custom', path: ['wasteCode'], message: 'Ange sexsiffrig avfallskod.' });
  if (value.hazardous && !value.wasteDescription) context.addIssue({ code: 'custom', path: ['wasteDescription'], message: 'Ange avfallsbeskrivning.' });
  if (!value.hazardous && value.wasteCode && !/^\d{6}$/.test(value.wasteCode)) context.addIssue({ code: 'custom', path: ['wasteCode'], message: 'Ange sexsiffrig avfallskod eller lämna tomt.' });
});
const weight = z.number().finite().positive().max(1e9).refine((value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.00001, 'Vikten får ha högst tre decimaler.');
const sourceIdSchema = z.string().uuid();
const addressResolutionSchema = z.object({
  originAddress: z.string().trim().max(1000), status: z.enum(['resolved', 'needs_address', 'needs_municipality']),
  provider: z.string().trim().min(1).max(100), resolvedAt: z.string().datetime({ offset: true }).optional(), municipalityConfirmed: z.boolean().optional(),
}).strict();
const newDocumentSchema = z.object({
  status: z.enum(['provided', 'not_required', 'missing', 'unknown']), reference: z.string().trim().max(300).optional(),
  missingReason: z.string().trim().max(2000).optional(), exemptionReason: z.string().trim().max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'missing' && !value.missingReason) context.addIssue({ code: 'custom', path: ['missingReason'], message: 'Beskriv det saknade dokumentet.' });
  if (value.status === 'not_required' && !value.exemptionReason) context.addIssue({ code: 'custom', path: ['exemptionReason'], message: 'Ange varför transportdokument inte krävs i detta fall.' });
});
// Existing saved receipts and Etapp 1 clients stay readable. A missing number
// never means a missing transport document: the explicit status governs that.
const legacyDocumentSchema = z.object({ reference: z.string().trim().max(300).optional(), missingReason: z.string().trim().max(2000).optional() }).strict()
  .refine((value) => Boolean(value.reference?.length || value.missingReason?.length), 'Ange dokumentreferens eller avvikelse för saknat dokument.');
const documentSchema = z.union([newDocumentSchema, legacyDocumentSchema]);
const receiptFields = {
  receivedAt: z.string().max(40).datetime({ offset: true }), rows: z.array(z.object({ articleId: id, weight }).strict()).min(1).max(100),
  previousHolder: holderSchema, lastPlace: placeSchema, nextPlace: placeSchema, transportMode: z.enum(['road', 'rail', 'sea', 'air']),
  incomingDocument: documentSchema, originAddress: z.string().trim().min(1).max(1000).optional(), addressResolution: addressResolutionSchema.optional(),
};
const receiptSchema = z.object({
  sourceId: z.string().uuid(), cardId: z.number().int().nonnegative(), siteId: z.enum(['norrtalje', 'rimbo']),
  ...receiptFields,
  idempotencyKey: z.string().trim().min(1).max(100),
}).strict();
const correctionSchema = z.object({
  ...receiptFields, rows: z.array(z.object({ articleId: id, weight }).strict()).max(100),
  sourceId: sourceIdSchema.optional(), cardId: z.number().int().nonnegative().optional(), siteId: z.enum(['norrtalje', 'rimbo']).optional(),
  expectedVersion: z.number().int().positive(), reason: z.string().trim().min(1).max(2000), idempotencyKey: z.string().trim().min(1).max(100),
}).strict();
const draftPlaceSchema = z.object({ address: z.string().trim().max(300), postalCode: z.string().trim().max(20), city: z.string().trim().max(300), municipalityCode: z.string().trim().max(10) }).strict();
const draftSchema = z.object({
  expectedVersion: z.number().int().nonnegative(), sourceId: sourceIdSchema, cardId: z.number().int().nonnegative(), siteId: z.enum(['norrtalje', 'rimbo']),
  originAddress: z.string().trim().max(1000).default(''), receivedAt: z.string().trim().max(40).default(''),
  rows: z.array(z.object({ articleId: id, weight }).strict()).max(100).default([]),
  previousHolder: z.object({ name: z.string().trim().max(300).default(''), number: z.string().trim().max(100).default(''), contactName: optionalText, email: z.string().trim().max(200).default(''), phone: z.string().trim().max(50).default('') }).strict().optional(),
  lastPlace: draftPlaceSchema.optional(), nextPlace: draftPlaceSchema.optional(), transportMode: z.enum(['road', 'rail', 'sea', 'air']).default('road'),
  incomingDocument: z.object({ status: z.enum(['provided', 'not_required', 'missing', 'unknown']), reference: z.string().trim().max(300).optional(), missingReason: z.string().trim().max(2000).optional(), exemptionReason: z.string().trim().max(2000).optional() }).strict().default({ status: 'unknown' }),
  addressResolution: addressResolutionSchema.optional(),
}).strict();
const copy = (value) => structuredClone(value);
const canonicalJsonValue = (value) => Array.isArray(value) ? value.map(canonicalJsonValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])])) : value;
// JSONB changes object-key ordering. Hash semantic JSON with sorted keys, so a
// reopened PostgreSQL snapshot has exactly the same checksum as its original.
export const environmentHash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonicalJsonValue(value))).digest('hex');
const HASH_FORMAT = 'sha256-canonical-json-v1';
const secret = () => randomBytes(32).toString('base64url');
const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EnvironmentError('Kontrollera miljöuppgifterna: ' + parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), 422);
  return parsed.data;
};
const passwordHash = (value) => {
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: scryptSync(value, salt, 64).toString('hex') };
};
const passwordMatches = (value, record) => {
  const actual = scryptSync(value, record.salt, 64), expected = Buffer.from(record.digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
export const environmentCan = (principal, right) => principal.user.level !== 'Medarbetare' || principal.user.permissions.includes(right);
const demand = (principal, right) => { if (!environmentCan(principal, right)) throw new EnvironmentError('Du saknar miljöbehörighet för detta moment.', 403, 'forbidden'); };
const sitesFor = (principal) => ENVIRONMENT_SITES.filter((site) => !Array.isArray(principal.user.siteIds) || principal.user.siteIds.includes(site.id));
const demandSite = (principal, siteId) => { if (!sitesFor(principal).some((site) => site.id === siteId)) throw new EnvironmentError('Du saknar åtkomst till denna anläggning.', 403, 'site_forbidden'); };
const defaultClassification = (articleId) => ({ articleId, version: 0, hazardous: false, wasteCode: '', wasteDescription: '', handlingInstructions: '', adrRequired: false });
const currentClassification = (state, articleId) => state.classifications.filter((record) => record.articleId === articleId).sort((a, b) => b.version - a.version)[0] ?? defaultClassification(articleId);
const audit = (state, now, principal, action, details = {}) => {
  state.revision += 1;
  state.audit.push({ id: randomUUID(), at: now.toISOString(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id, actor: principal.user.name, action, ...details });
};
const documentDeviations = (document) => {
  const status = document.status ?? (document.reference ? 'provided' : 'missing');
  if (status === 'missing') return [{ code: 'missing_document', message: document.missingReason }];
  if (status === 'unknown') return [{ code: 'document_status_pending', message: 'Kontrollera om transportdokument finns eller krävs i detta fall.' }];
  return [];
};
const inputIdentityHash = (input) => {
  const value = copy(input);
  // Lookup timestamps are provenance, not a change to the physical receipt.
  // Two desks resolving the same origin moments apart still share one source.
  if (value.addressResolution) delete value.addressResolution.resolvedAt;
  return environmentHash(value);
};
const normalizedPhysicalInput = (input) => {
  const value = copy(input), weights = new Map();
  for (const row of value.rows) weights.set(row.articleId, (weights.get(row.articleId) ?? 0) + row.weight);
  value.rows = [...weights].sort(([a], [b]) => a.localeCompare(b)).map(([articleId, weight]) => ({ articleId, weight: Math.round(weight * 1000) / 1000 }));
  if (value.incomingDocument && !value.incomingDocument.status) value.incomingDocument.status = value.incomingDocument.reference ? 'provided' : 'missing';
  return inputIdentityHash(value);
};
const matchesLegacyPhysicalInput = (receipt, input) => {
  if (receipt.hashFormat) return false;
  const { version, operator, previousHash, correctionReason, ...originalInput } = receipt.snapshot;
  return normalizedPhysicalInput(originalInput) === normalizedPhysicalInput(input);
};
const validateOrigin = (input, confirmed) => {
  if (confirmed && input.originAddress) {
    const parsed = parseOriginAddress(input.originAddress), sameText = (left, right) => left.trim().normalize('NFKC').toLocaleLowerCase('sv-SE') === right.trim().normalize('NFKC').toLocaleLowerCase('sv-SE');
    if (!sameText(parsed.address, input.lastPlace.address) || (parsed.postalCode && parsed.postalCode !== input.lastPlace.postalCode)
      || (parsed.city && !sameText(parsed.city, input.lastPlace.city)))
      throw new EnvironmentError('Miljöplatsen måste följa kortets ursprungsadress. Kontrollera adressen igen.', 422, 'address_origin_mismatch');
    if (!ENVIRONMENT_MUNICIPALITIES.some((municipality) => municipality.code === input.lastPlace.municipalityCode))
      throw new EnvironmentError('Välj en giltig svensk kommun för ursprungsplatsen.', 422, 'municipality_invalid');
  }
  if (!input.addressResolution) return; // Backward-compatible Etapp 1 original.
  if (!input.originAddress || input.addressResolution.originAddress !== input.originAddress)
    throw new EnvironmentError('Adressuppslaget gäller inte kortets aktuella ursprungsadress. Kontrollera adressen igen.', 422, 'address_origin_mismatch');
  if (confirmed && input.addressResolution.status !== 'resolved')
    throw new EnvironmentError('Komplettera ursprungsadressen eller kommunen före mottagningsbekräftelse.', 422, 'address_incomplete');
};
const receiptCorrections = (state, receipt) => state.corrections.filter((record) => record.receiptId === receipt.id).sort((a, b) => a.version - b.version);
const effectiveReceipt = (state, original) => {
  const history = receiptCorrections(state, original), current = history.at(-1);
  return copy({ ...original, ...(current ? { version: current.version, snapshot: current.snapshot, hash: current.hash, deviations: current.deviations, receivedAt: current.snapshot.receivedAt,
    correctedAt: current.createdAt, correctedBy: current.createdBy } : {}), originalSnapshot: original.snapshot, originalHash: original.hash,
    hashFormat: current?.hashFormat ?? original.hashFormat ?? 'legacy-sha256-json', originalHashFormat: original.hashFormat ?? 'legacy-sha256-json',
    correctionHistory: history, inventoryIds: [...original.inventoryIds, ...history.flatMap((record) => record.inventoryMovements.map((movement) => movement.id))],
    reportIds: reportVersions(state, original).at(-1).map((record) => record.id),
  });
};
const reportVersions = (state, receipt) => {
  const originals = state.reports.filter((record) => record.receiptId === receipt.id);
  const versions = [{ snapshot: receipt.snapshot, createdAt: receipt.createdAt, hash: receipt.hash }, ...receiptCorrections(state, receipt).map((record) => ({ snapshot: record.snapshot, createdAt: record.createdAt, hash: record.hash }))];
  let noteDueDate = addSwedishWorkingDays(receipt.receivedAt, 2), reportDueDate = addSwedishWorkingDays(noteDueDate, 2);
  return versions.map(({ snapshot, createdAt, hash }) => {
    // A correction may shorten an erroneously late receipt date, but can never
    // extend the pre-existing environmental clock.
    const correctedNote = addSwedishWorkingDays(snapshot.receivedAt, 2);
    noteDueDate = correctedNote < noteDueDate ? correctedNote : noteDueDate;
    const correctedReport = addSwedishWorkingDays(noteDueDate, 2);
    reportDueDate = correctedReport < reportDueDate ? correctedReport : reportDueDate;
    return snapshot.rows.filter((row) => row.classification.hazardous).map((row) => {
      const original = originals.find((record) => record.articleId === row.articleId);
      return { ...original, id: original?.id ?? `${receipt.id}:${row.articleId}`, receiptId: receipt.id, sourceId: receipt.sourceId, cardId: receipt.cardId, siteId: receipt.siteId,
        articleId: row.articleId, wasteCode: row.classification.wasteCode, wasteDescription: row.classification.wasteDescription, weight: row.weight,
        status: 'incomplete', missingFields: ['Verifierade verksamhetsutövaruppgifter krävs före myndighetsrapportering.'], noteDueDate, reportDueDate,
        createdAt, version: snapshot.version, receiptVersion: snapshot.version, mode: 'prepared-only', snapshotHash: hash,
      };
    });
  });
};

/** Calendar days in Sweden, including public holidays. Dates are deliberately
 * date-only local deadlines, never midnight-UTC instants that move with DST. */
const localDate = (value) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dayNumber = (date) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86400000);
const dateNumber = (value) => new Date(value * 86400000).toISOString().slice(0, 10);
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), date = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}
function isWorkingDay(value) {
  const date = dateNumber(value), year = Number(date.slice(0, 4)), weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const fixed = ['01-01', '01-06', '05-01', '06-06', '12-25', '12-26'];
  if (fixed.includes(date.slice(5))) return false;
  const easter = dayNumber(easterSunday(year));
  return ![easter - 2, easter + 1, easter + 39].includes(value);
}
export function addSwedishWorkingDays(receivedAt, count) {
  let day = dayNumber(/^\d{4}-\d{2}-\d{2}$/.test(receivedAt) ? receivedAt : localDate(receivedAt));
  while (count > 0) { day += 1; if (isWorkingDay(day)) count -= 1; }
  return dateNumber(day);
}

export function createEnvironmentStore({ repository, principalStore, now = () => new Date(), demoMode = true }) {
  if (!repository || !principalStore) throw new Error('Environment requires durable repository and principal store.');
  const transaction = (operation) => repository.transact((state) => {
    const time = now();
    for (const userId of ['admin', 'lars', 'kajsa', 'anna']) if (!state.credentials.some((record) => record.userId === userId)) {
      state.credentials.push({ userId, ...passwordHash(ENVIRONMENT_DEMO_PASSWORD), demo: true });
    }
    if (!state.classifications.some((record) => record.articleId === 'lead-battery')) state.classifications.push({
      articleId: 'lead-battery', version: 1, hazardous: true, wasteCode: '160601', wasteDescription: 'Blybatterier',
      handlingInstructions: 'Förvara upprätt i tätt, märkt batterikärl. Skydda mot läckage och kortslutning.', adrRequired: false,
      updatedAt: time.toISOString(), updatedBy: 'Demosådd',
    });
    state.sessions = state.sessions.filter((session) => Date.parse(session.expiresAt) > time.getTime());
    state.loginAttempts = state.loginAttempts.filter((attempt) => Date.parse(attempt.at) > time.getTime() - LOGIN_WINDOW);
    return operation(state, time);
  });
  const principalFor = (state, token, time) => {
    const session = token && state.sessions.find((record) => record.tokenHash === environmentHash(token) && Date.parse(record.expiresAt) > time.getTime());
    if (!session) throw new EnvironmentError('Logga in för att öppna de gemensamma miljöuppgifterna.', 401, 'session_required');
    let principal;
    try { principal = principalStore.principal(session.actualUserId, session.effectiveUserId); }
    catch (error) { throw new EnvironmentError('Kontot eller den valda behörigheten finns inte längre.', error.status ?? 401, 'session_revoked'); }
    return { session, principal };
  };
  const sessionResult = (session, principal) => ({ demo: true, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, user: copy(principal.user), csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  const resolveArticle = (articleId) => {
    if (typeof principalStore.getArticleForEnvironment !== 'function') throw new EnvironmentError('Artikelregistrets serverkoppling saknas.', 503, 'article_registry_required');
    const article = principalStore.getArticleForEnvironment(articleId);
    if (!article) throw new EnvironmentError('Artikeln finns inte i artikelregistret.', 422, 'article_not_found');
    return article;
  };
  const snapshotRows = (rows, previousRows = []) => {
    const weights = new Map();
    for (const row of rows) { resolveArticle(row.articleId); weights.set(row.articleId, (weights.get(row.articleId) ?? 0) + row.weight); }
    return [...weights].map(([articleId, value]) => ({ articleId, weight: parse(weight, Math.round(value * 1000) / 1000), classification: copy(previousRows.find((row) => row.articleId === articleId)?.classification ?? defaultClassification(articleId)) }));
  };
  const classifyRows = (state, rows, previousRows = []) => snapshotRows(rows, rows.map((row) => previousRows.find((previous) => previous.articleId === row.articleId)
    ?? { articleId: row.articleId, classification: currentClassification(state, row.articleId) }));
  return {
    repository,
    demoSession(payload, previousToken) {
      if (!demoMode) throw new EnvironmentError('Automatisk demoinloggning är avstängd.', 503, 'demo_disabled');
      const request = parse(z.object({ userId: id, effectiveUserId: id.optional() }).strict(), payload), token = secret();
      return transaction((state, time) => {
        let principal;
        try { principal = principalStore.principal(request.userId, request.effectiveUserId ?? request.userId); }
        catch { throw new EnvironmentError('Demokontot eller Jobba som-behörigheten är ogiltig.', 401, 'invalid_credentials'); }
        if (!['environmentRead', 'environmentWrite', 'environmentClassify'].some((right) => environmentCan(principal, right)))
          throw new EnvironmentError('Demokontot saknar miljöbehörighet.', 403, 'forbidden');
        const previous = previousToken && state.sessions.find((record) => record.tokenHash === environmentHash(previousToken));
        if (previous?.actualUserId === principal.actor.id && previous?.effectiveUserId === principal.user.id)
          return { token: previousToken, result: sessionResult(previous, principal) };
        if (previousToken) state.sessions = state.sessions.filter((record) => record.tokenHash !== environmentHash(previousToken));
        const session = { tokenHash: environmentHash(token), csrfToken: secret(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
          createdAt: time.toISOString(), expiresAt: new Date(time.getTime() + STAFF_AGE).toISOString() };
        state.sessions.push(session); audit(state, time, principal, 'environment.demo_session');
        return { token, result: sessionResult(session, principal) };
      });
    },
    authorize(token, right, siteId) { return transaction((state, time) => {
      const { principal } = principalFor(state, token, time); demand(principal, right); if (siteId) demandSite(principal, siteId);
    }); },
    assertIdentity(token, actualUserId, effectiveUserId) { return transaction((state, time) => {
      const { principal } = principalFor(state, token, time);
      // These are an expected identity check only. A valid server cookie and
      // live permissions remain mandatory; headers never authenticate anyone.
      if ((actualUserId !== undefined && actualUserId !== principal.actor.id) || (effectiveUserId !== undefined && effectiveUserId !== principal.user.id))
        throw new EnvironmentError('Demokontot ändrades i en annan flik. Läs in ditt aktuella konto innan du sparar.', 403, 'session_identity_mismatch');
    }); },
    async login(payload, previousToken, remoteAddress = '') {
      const request = parse(z.object({ userId: id, password: z.string().min(1).max(128), effectiveUserId: id.optional() }).strict(), payload);
      const token = secret();
      const outcome = await transaction((state, time) => {
        const bucket = environmentHash(`${remoteAddress}:${request.userId}`);
        if (state.loginAttempts.filter((attempt) => attempt.bucket === bucket).length >= 8) return { failure: new EnvironmentError('För många inloggningsförsök. Vänta och försök igen.', 429, 'rate_limited') };
        const failure = (message) => {
          state.loginAttempts.push({ bucket, at: time.toISOString() });
          return { failure: new EnvironmentError(message, 401, 'invalid_credentials') };
        };
        const credential = state.credentials.find((record) => record.userId === request.userId);
        let principal;
        try { principal = principalStore.principal(request.userId, request.effectiveUserId ?? request.userId); }
        catch { return failure('Fel testkonto, lösenord eller Jobba som-behörighet.'); }
        if (!credential || !passwordMatches(request.password, credential)) return failure('Fel testkonto eller lösenord.');
        state.loginAttempts = state.loginAttempts.filter((attempt) => attempt.bucket !== bucket);
        if (previousToken) state.sessions = state.sessions.filter((record) => record.tokenHash !== environmentHash(previousToken));
        const session = { tokenHash: environmentHash(token), csrfToken: secret(), actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
          createdAt: time.toISOString(), expiresAt: new Date(time.getTime() + STAFF_AGE).toISOString() };
        state.sessions.push(session); audit(state, time, principal, 'environment.login');
        return { token, result: sessionResult(session, principal) };
      });
      if (outcome.failure) throw outcome.failure;
      return outcome;
    },
    session(token) { return transaction((state, time) => { const { session, principal } = principalFor(state, token, time); return sessionResult(session, principal); }); },
    csrf(token, value) { return transaction((state, time) => {
      const { session } = principalFor(state, token, time);
      if (!value || value !== session.csrfToken) throw new EnvironmentError('Sessionsskyddet saknas. Logga in igen.', 403, 'csrf_required');
    }); },
    logout(token) { return transaction((state) => { if (token) state.sessions = state.sessions.filter((record) => record.tokenHash !== environmentHash(token)); return { demo: true }; }); },
    state(token, filterSite = 'all') { return transaction((state, time) => {
      const { principal } = principalFor(state, token, time); demand(principal, 'environmentRead');
      if (filterSite && filterSite !== 'all') demandSite(principal, filterSite);
      const sites = sitesFor(principal).filter((site) => !filterSite || filterSite === 'all' || site.id === filterSite);
      const visible = new Set(sites.map((site) => site.id));
      const articleIds = new Set(state.classifications.map((record) => record.articleId));
      const originals = state.receipts.filter((record) => visible.has(record.siteId));
      const reportHistory = [], reports = [];
      for (const receipt of originals) { const versions = reportVersions(state, receipt); reports.push(...versions.at(-1)); reportHistory.push(...versions.slice(0, -1).flat().map((record) => ({ ...record, status: 'superseded' }))); }
      return { demo: true, mode: 'prepared-only', revision: state.revision, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, sites: copy(sites),
        classifications: [...articleIds].map((articleId) => copy(currentClassification(state, articleId))),
        drafts: copy(state.drafts.filter((record) => visible.has(record.siteId))), corrections: copy(state.corrections.filter((record) => visible.has(record.siteId))),
        receipts: originals.map((record) => effectiveReceipt(state, record)), inventory: copy([
          ...state.inventory.filter((record) => visible.has(record.siteId)).map((record) => ({ ...record, classification: state.receipts.find((receipt) => receipt.id === record.receiptId)?.snapshot.rows.find((row) => row.articleId === record.articleId)?.classification })),
          ...state.corrections.filter((record) => visible.has(record.siteId)).flatMap((record) => record.inventoryMovements),
        ]), reports: copy(reports), reportHistory: copy(reportHistory),
      };
    }); },
    draft(sourceId, token) { parse(sourceIdSchema, sourceId); return transaction((state, time) => {
      const { principal } = principalFor(state, token, time); demand(principal, 'environmentRead');
      const existing = state.drafts.find((record) => record.sourceId === sourceId);
      if (!existing) return null; demandSite(principal, existing.siteId); return copy(existing);
    }); },
    saveDraft(sourceId, payload, token) {
      parse(sourceIdSchema, sourceId);
      const values = payload?.input !== undefined ? parse(z.object({ expectedVersion: z.number().int().nonnegative(), input: z.record(z.unknown()) }).strict(), payload) : undefined;
      const request = parse(draftSchema, values ? { ...values.input, expectedVersion: values.expectedVersion } : payload);
      if (request.sourceId !== sourceId) throw new EnvironmentError('Utkastets identitet stämmer inte med kortet.', 422, 'source_conflict');
      validateOrigin(request, false);
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); demand(principal, 'environmentWrite'); demandSite(principal, request.siteId);
        const receipt = state.receipts.find((record) => record.sourceId === sourceId);
        if (receipt) { demandSite(principal, receipt.siteId); throw new EnvironmentError('Mottagningen är bekräftad. Gör en spårbar miljörättelse.', 409, 'receipt_already_recorded'); }
        const current = state.drafts.find((record) => record.sourceId === sourceId);
        if (current) { demandSite(principal, current.siteId); if (current.cardId !== request.cardId) throw new EnvironmentError('Utkastet tillhör ett annat kort.', 409, 'source_conflict'); }
        if ((current?.version ?? 0) !== request.expectedVersion) throw new EnvironmentError('Utkastet har ändrats av någon annan. Läs in senaste versionen.', 409, 'version_conflict');
        for (const row of request.rows) resolveArticle(row.articleId);
        const { expectedVersion, ...input } = request;
        // A changed canonical origin invalidates old derived municipality data;
        // a newly matched provenance can safely keep the fresh resolved place.
        if (current?.input.originAddress !== input.originAddress && !input.addressResolution && input.originAddress) {
          input.lastPlace = parseOriginAddress(input.originAddress);
          input.addressResolution = { originAddress: input.originAddress, status: ['address', 'postalCode', 'city'].some((key) => !input.lastPlace[key]) ? 'needs_address' : 'needs_municipality', provider: 'address' };
        }
        const draft = { id: sourceId, sourceId, cardId: request.cardId, siteId: request.siteId, version: expectedVersion + 1, input,
          updatedAt: time.toISOString(), updatedBy: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
        state.drafts = state.drafts.filter((record) => record.sourceId !== sourceId); state.drafts.push(draft);
        audit(state, time, principal, 'environment.draft_saved', { sourceId, cardId: request.cardId, siteId: request.siteId, version: draft.version });
        return copy(draft);
      });
    },
    classification(articleId, token) { return transaction((state, time) => {
      const { principal } = principalFor(state, token, time); demand(principal, 'environmentRead'); parse(id, articleId); resolveArticle(articleId);
      return copy(currentClassification(state, articleId));
    }); },
    classify(articleId, payload, token) {
      const request = parse(classificationSchema, payload); parse(id, articleId);
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); demand(principal, 'environmentClassify'); resolveArticle(articleId);
        const current = currentClassification(state, articleId);
        if (current.version !== request.expectedVersion) throw new EnvironmentError('Artikeln har ändrats av någon annan. Läs in senaste versionen.', 409, 'version_conflict');
        const { expectedVersion, ...values } = request;
        const classification = { articleId, ...values, version: expectedVersion + 1, updatedAt: time.toISOString(), updatedBy: principal.user.name };
        state.classifications.push(classification); audit(state, time, principal, 'environment.classified', { articleId, version: classification.version });
        return copy(classification);
      });
    },
    receive(payload, token) {
      const request = parse(receiptSchema, payload);
      validateOrigin(request, true);
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); demand(principal, 'environmentWrite'); demandSite(principal, request.siteId);
        if (Date.parse(request.receivedAt) > time.getTime() + 5 * 60 * 1000) throw new EnvironmentError('Faktisk mottagning kan inte ligga i framtiden.', 422, 'future_receipt');
        const { idempotencyKey, ...input } = request;
        const inputHash = inputIdentityHash(input), key = environmentHash(`${principal.actor.id}:${idempotencyKey}`);
        const existing = state.receipts.find((record) => record.sourceId === request.sourceId);
        const previousRequest = state.requests.find((record) => record.id === key), legacyMatch = existing && matchesLegacyPhysicalInput(existing, input);
        if (previousRequest && previousRequest.inputHash !== inputHash && !(legacyMatch && previousRequest.receiptId === existing.id)) throw new EnvironmentError('Samma spara-försök innehåller andra uppgifter.', 409, 'idempotency_conflict');
        if (existing) {
          if (existing.siteId !== request.siteId) throw new EnvironmentError('Mottagningen tillhör en annan anläggning.', 403, 'site_forbidden');
          if (existing.inputHash !== inputHash && !legacyMatch) throw new EnvironmentError('Mottagningen är redan registrerad och låst. En fysisk ändring kräver ett separat rättelseflöde.', 409, 'source_conflict');
          if (!previousRequest) state.requests.push({ id: key, inputHash, receiptId: existing.id, createdAt: time.toISOString() });
          return effectiveReceipt(state, existing);
        }
        const draft = state.drafts.find((record) => record.sourceId === request.sourceId);
        if (draft) { demandSite(principal, draft.siteId); if (draft.cardId !== request.cardId || draft.siteId !== request.siteId) throw new EnvironmentError('Mottagningen stämmer inte med det sparade utkastets kort eller anläggning.', 409, 'source_conflict'); }
        const rows = classifyRows(state, request.rows);
        const operator = { name: 'JEROC Återvinning AB', number: '5591234567', contactName: 'Miljöansvarig – DEMO', email: 'miljo@example.invalid', phone: '0100000000', demo: true, verified: false };
        const snapshot = { version: 1, ...input, rows, operator };
        const receiptId = randomUUID();
        const receipt = { id: receiptId, sourceId: request.sourceId, cardId: request.cardId, siteId: request.siteId, receivedAt: request.receivedAt,
          createdAt: time.toISOString(), createdBy: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
          version: 1, hash: environmentHash(snapshot), hashFormat: HASH_FORMAT, inputHash, status: 'recorded', snapshot,
          deviations: documentDeviations(request.incomingDocument), reportIds: [], inventoryIds: [],
        };
        state.receipts.push(receipt);
        for (const row of rows) {
          const inventory = { id: randomUUID(), receiptId, sourceId: request.sourceId, cardId: request.cardId, siteId: request.siteId,
            articleId: row.articleId, wasteCode: row.classification.wasteCode, weight: row.weight, receivedAt: request.receivedAt, kind: 'receipt' };
          state.inventory.push(inventory); receipt.inventoryIds.push(inventory.id);
          if (!row.classification.hazardous) continue;
          const noteDueDate = addSwedishWorkingDays(request.receivedAt, 2);
          const report = { id: randomUUID(), receiptId, sourceId: request.sourceId, cardId: request.cardId, siteId: request.siteId, articleId: row.articleId,
            wasteCode: row.classification.wasteCode, wasteDescription: row.classification.wasteDescription, weight: row.weight,
            status: 'incomplete', missingFields: ['Verifierade verksamhetsutövaruppgifter krävs före myndighetsrapportering.'],
            noteDueDate, reportDueDate: addSwedishWorkingDays(noteDueDate, 2), createdAt: time.toISOString(), mode: 'prepared-only' };
          state.reports.push(report); receipt.reportIds.push(report.id);
        }
        state.requests.push({ id: key, inputHash, receiptId, createdAt: time.toISOString() });
        state.drafts = state.drafts.filter((record) => record.sourceId !== request.sourceId);
        audit(state, time, principal, 'environment.received', { receiptId, cardId: request.cardId, siteId: request.siteId, sourceId: request.sourceId, hash: receipt.hash });
        return effectiveReceipt(state, receipt);
      });
    },
    correct(receiptId, payload, token) {
      parse(sourceIdSchema, receiptId);
      const request = parse(correctionSchema, payload); validateOrigin(request, true);
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); demand(principal, 'environmentWrite');
        const original = state.receipts.find((record) => record.id === receiptId);
        if (!original) throw new EnvironmentError('Mottagningen finns inte.', 404, 'not_found');
        demandSite(principal, original.siteId);
        if ((request.sourceId && request.sourceId !== original.sourceId) || (request.siteId && request.siteId !== original.siteId) || (request.cardId !== undefined && request.cardId !== original.cardId))
          throw new EnvironmentError('En miljörättelse måste avse samma kort och anläggning som originalet.', 409, 'source_conflict');
        if (Date.parse(request.receivedAt) > time.getTime() + 5 * 60 * 1000) throw new EnvironmentError('Faktisk mottagning kan inte ligga i framtiden.', 422, 'future_receipt');
        const { idempotencyKey, ...input } = request;
        const { sourceId: sourceIdentity, cardId: cardIdentity, siteId: siteIdentity, ...correctionIdentity } = input;
        const inputHash = inputIdentityHash({ operation: 'correction', receiptId, ...correctionIdentity });
        const key = environmentHash(`${principal.actor.id}:${idempotencyKey}`), previousRequest = state.requests.find((record) => record.id === key);
        if (previousRequest && previousRequest.inputHash !== inputHash) throw new EnvironmentError('Samma rättelseförsök innehåller andra uppgifter.', 409, 'idempotency_conflict');
        const priorCorrection = state.corrections.find((record) => record.receiptId === receiptId && record.inputHash === inputHash);
        if (priorCorrection) {
          if (!previousRequest) state.requests.push({ id: key, inputHash, receiptId, correctionId: priorCorrection.id, createdAt: time.toISOString() });
          return effectiveReceipt(state, original);
        }
        const current = effectiveReceipt(state, original);
        if (current.version !== request.expectedVersion) throw new EnvironmentError('Mottagningen har redan rättats. Läs in senaste versionen.', 409, 'version_conflict');
        const rows = classifyRows(state, request.rows, current.snapshot.rows);
        const { expectedVersion, reason, sourceId, cardId, siteId, ...correctedValues } = input;
        const snapshot = { ...current.snapshot, ...correctedValues, rows, version: expectedVersion + 1, previousHash: current.hash, correctionReason: reason };
        const correctionId = randomUUID(), hash = environmentHash(snapshot), movements = [];
        const priorGroups = new Map(current.snapshot.rows.map((row) => [row.articleId, row]));
        const nextGroups = new Map(rows.map((row) => [row.articleId, row]));
        for (const articleId of new Set([...priorGroups.keys(), ...nextGroups.keys()])) {
          const before = priorGroups.get(articleId), after = nextGroups.get(articleId), delta = Math.round(((after?.weight ?? 0) - (before?.weight ?? 0)) * 1000) / 1000;
          if (!delta) continue;
          const classification = after?.classification ?? before.classification;
          movements.push({ id: randomUUID(), receiptId, correctionId, sourceId: original.sourceId, cardId: original.cardId, siteId: original.siteId,
            articleId, wasteCode: classification.wasteCode, classification: copy(classification), weight: delta, receivedAt: request.receivedAt, createdAt: time.toISOString(), kind: 'correction' });
        }
        const correction = { id: correctionId, receiptId, sourceId: original.sourceId, cardId: original.cardId, siteId: original.siteId,
          version: snapshot.version, reason, previousHash: current.hash, hash, hashFormat: HASH_FORMAT, inputHash, snapshot, inventoryMovements: movements, deviations: documentDeviations(snapshot.incomingDocument),
          createdAt: time.toISOString(), createdBy: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id };
        state.corrections.push(correction); state.requests.push({ id: key, inputHash, receiptId, correctionId, createdAt: time.toISOString() });
        audit(state, time, principal, 'environment.corrected', { receiptId, correctionId, sourceId: original.sourceId, cardId: original.cardId, siteId: original.siteId,
          version: correction.version, hash, previousHash: current.hash, reason });
        return effectiveReceipt(state, original);
      });
    },
  };
}
