import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EnvironmentError } from './environment-storage.mjs';

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
const receiptSchema = z.object({
  sourceId: z.string().uuid(), cardId: z.number().int().nonnegative(), siteId: z.enum(['norrtalje', 'rimbo']),
  receivedAt: z.string().max(40).datetime({ offset: true }), rows: z.array(z.object({ articleId: id, weight }).strict()).min(1).max(100),
  previousHolder: holderSchema, lastPlace: placeSchema, nextPlace: placeSchema,
  transportMode: z.enum(['road', 'rail', 'sea', 'air']),
  incomingDocument: z.object({ reference: z.string().trim().max(300).optional(), missingReason: z.string().trim().max(2000).optional() }).strict()
    .refine((value) => Boolean(value.reference?.length || value.missingReason?.length), 'Ange dokumentreferens eller avvikelse för saknat dokument.'),
  idempotencyKey: z.string().trim().min(1).max(100),
}).strict();
const copy = (value) => structuredClone(value);
export const environmentHash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
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

export function createEnvironmentStore({ repository, principalStore, now = () => new Date() }) {
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
  return {
    repository,
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
      return { demo: true, mode: 'prepared-only', revision: state.revision, sites: copy(sites),
        classifications: [...articleIds].map((articleId) => copy(currentClassification(state, articleId))),
        receipts: copy(state.receipts.filter((record) => visible.has(record.siteId))), inventory: copy(state.inventory.filter((record) => visible.has(record.siteId))),
        reports: copy(state.reports.filter((record) => visible.has(record.siteId))),
      };
    }); },
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
      return transaction((state, time) => {
        const { principal } = principalFor(state, token, time); demand(principal, 'environmentWrite'); demandSite(principal, request.siteId);
        if (Date.parse(request.receivedAt) > time.getTime() + 5 * 60 * 1000) throw new EnvironmentError('Faktisk mottagning kan inte ligga i framtiden.', 422, 'future_receipt');
        const { idempotencyKey, ...input } = request;
        const inputHash = environmentHash(input), key = environmentHash(`${principal.actor.id}:${idempotencyKey}`);
        const previousRequest = state.requests.find((record) => record.id === key);
        if (previousRequest && previousRequest.inputHash !== inputHash) throw new EnvironmentError('Samma spara-försök innehåller andra uppgifter.', 409, 'idempotency_conflict');
        const existing = state.receipts.find((record) => record.sourceId === request.sourceId);
        if (existing) {
          if (existing.siteId !== request.siteId) throw new EnvironmentError('Mottagningen tillhör en annan anläggning.', 403, 'site_forbidden');
          if (existing.inputHash !== inputHash) throw new EnvironmentError('Mottagningen är redan registrerad och låst. En fysisk ändring kräver ett separat rättelseflöde.', 409, 'source_conflict');
          if (!previousRequest) state.requests.push({ id: key, inputHash, receiptId: existing.id, createdAt: time.toISOString() });
          return copy(existing);
        }
        const weights = new Map();
        for (const row of request.rows) { resolveArticle(row.articleId); weights.set(row.articleId, (weights.get(row.articleId) ?? 0) + row.weight); }
        const rows = [...weights].map(([articleId, value]) => ({ articleId, weight: parse(weight, Math.round(value * 1000) / 1000), classification: copy(currentClassification(state, articleId)) }));
        const operator = { name: 'JEROC Återvinning AB', number: '5591234567', contactName: 'Miljöansvarig – DEMO', email: 'miljo@example.invalid', phone: '0100000000', demo: true, verified: false };
        const snapshot = { version: 1, ...input, rows, operator };
        const receiptId = randomUUID();
        const receipt = { id: receiptId, sourceId: request.sourceId, cardId: request.cardId, siteId: request.siteId, receivedAt: request.receivedAt,
          createdAt: time.toISOString(), createdBy: principal.user.name, actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
          version: 1, hash: environmentHash(snapshot), inputHash, status: 'recorded', snapshot,
          deviations: request.incomingDocument.reference ? [] : [{ code: 'missing_document', message: request.incomingDocument.missingReason }], reportIds: [], inventoryIds: [],
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
        audit(state, time, principal, 'environment.received', { receiptId, cardId: request.cardId, siteId: request.siteId, sourceId: request.sourceId, hash: receipt.hash });
        return copy(receipt);
      });
    },
  };
}
