import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createVoiceTestProvider, voiceTestProviderConfig, VOICE_TEST_LIVE_VOICES, VOICE_TEST_REALTIME_VOICES } from './voice-test-provider.mjs';
import { getJerocKnowledgePack } from './ai-support-jeroc-knowledge.mjs';

export const AI_SUPPORT_POLICY_VERSION = 1;
// Validate stored profiles against the union so a rollback never destroys a
// valid voice preference from another engine. Writes use the current catalog.
export const AI_SUPPORT_VOICES = Object.freeze([...new Set([...VOICE_TEST_REALTIME_VOICES, ...VOICE_TEST_LIVE_VOICES])]);
export const AI_SUPPORT_LIMITS = Object.freeze({ maxTotal: 100, maxPublished: 20, maxPublishedCharacters: 10_000, maxBodyBytes: 32 * 1024, maxPreviewPerHour: 10, maxPreviewPerDay: 50 });
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 422, code = 'ai_support_invalid') => { throw Object.assign(new Error(message), { status, code, publicAiSupportError: true }); };
const id = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const revision = z.number().int().nonnegative().safe();
const voice = z.enum(AI_SUPPORT_VOICES), tone = z.enum(['friendly', 'professional', 'calm']), pace = z.enum(['slow', 'normal', 'brisk']);
const category = z.enum(['general', 'materials', 'opening_hours', 'visits', 'pickups', 'payments']);
const siteIds = z.array(id).max(100).refine(value => new Set(value).size === value.length);
const profileFields = { enabled: z.boolean(), companyName: z.string().trim().min(1).max(160), greeting: z.string().trim().min(1).max(500), voice, tone, pace, pronunciationText: z.string().trim().max(2000) };
const profileSchema = z.object(profileFields).strict();
const settingsInput = z.object({ expectedRevision: revision, ...profileFields }).strict();
const knowledgeInput = z.object({ requestId: id.min(8), expectedRevision: revision, id: id.optional(), title: z.string().trim().min(1).max(160), answer: z.string().trim().min(1).max(3000), category, siteIds, status: z.enum(['draft', 'published']), publicApproved: z.boolean() }).strict();
const archiveInput = z.object({ requestId: id.min(8), expectedRevision: revision }).strict();
const articleInput = z.object({ requestId: id.min(8), expectedRevision: revision, articleId: id, siteIds }).strict();
const starterPackInput = z.object({ requestId: id.min(8), expectedRevision: revision, packId: id, packVersion: z.number().int().positive().safe(), itemIds: z.array(id).min(1).max(100).refine(value => new Set(value).size === value.length), status: z.enum(['draft', 'published']), publicApproved: z.boolean() }).strict();
const previewInput = z.object({ voice, profile: z.object({ greeting: profileFields.greeting.optional(), tone: tone.optional(), pace: pace.optional(), pronunciationText: profileFields.pronunciationText.optional() }).strict().optional() }).strict();
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail('AI-supportuppgifterna innehåller ogiltiga eller okända fält.'); return result.data; };
const privileged = user => Boolean(user?.id) && user.active !== false && ['Systemadmin', 'VD'].includes(user.level);
const globalWrite = principal => [principal.actor, principal.user].every(user => !Array.isArray(user.siteIds));
const allows = (principal, siteId) => [principal.actor, principal.user].every(user => !Array.isArray(user.siteIds) || user.siteIds.includes(siteId));
const contentOf = entry => ({ title: entry.title, answer: entry.answer, category: entry.category, siteIds: [...entry.siteIds].sort() });
const approved = entry => entry.status === 'published' && entry.publicApproved === true && entry.approvedVersion === entry.version && entry.approvedHash === hash(contentOf(entry));
const charactersOf = entry => entry.title.length + entry.answer.length;
const stockholmDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });

function voiceConfig({ engine = 'live', defaultVoice } = {}) {
  return voiceTestProviderConfig({ VOICE_TEST_ENGINE: engine, ...(defaultVoice ? { VOICE_TEST_VOICE: defaultVoice } : {}) });
}
function defaults({ organisationId, companyName, defaultVoice, engine = 'live' } = {}) {
  const name = String(companyName ?? (organisationId === 'jeroc-demo' ? 'JEROC' : 'Företaget')).trim().slice(0, 160) || 'Företaget';
  return { enabled: true, companyName: name, greeting: `Hej och välkommen till ${name}! Vad kan jag hjälpa dig med?`, voice: voiceConfig({ engine, defaultVoice }).defaultVoice, tone: 'friendly', pace: 'normal', pronunciationText: '' };
}
function effectiveProfile(value, options) {
  const stored = parse(profileSchema, value.settings), config = voiceConfig(options);
  const selected = value.voiceSelections?.[config.engine] ?? stored.voice;
  const compatible = config.voices.includes(selected);
  return { settings: { ...stored, voice: compatible ? selected : config.defaultVoice }, ...(compatible ? {} : { notice: 'Den sparade rösten hör till en annan röstmotor. En kompatibel röst används här; det tidigare valet finns kvar.' }) };
}
function rememberVoice(value, selected, engine) {
  value.voiceSelections ??= {};
  // The pre-migration voice is usable on every engine whose catalog contains it.
  for (const [key, voices] of [['live', VOICE_TEST_LIVE_VOICES], ['realtime', VOICE_TEST_REALTIME_VOICES]]) {
    if (value.voiceSelections[key] === undefined && voices.includes(value.settings.voice)) value.voiceSelections[key] = value.settings.voice;
  }
  value.voiceSelections[engine] = selected;
}
function sensitive(text) {
  if (/\bsk-(?:proj-)?[a-zA-Z0-9_-]{12,}|\bAKIA[A-Z0-9]{16}\b|-----BEGIN[ A-Z]*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._~+/-]{12,}/i.test(text) || /\b(?:password|lösenord|api[_ -]?key|api[- ]?nyckel|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S{6,}/i.test(text))
    return 'Texten ser ut att innehålla en hemlig nyckel eller inloggningsuppgift.';
  if (/\b(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-+]?\d{4}\b|\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[-+]\d{4}\b/.test(text) || /\b(?:lönebesked|månadslön|timlön|internpris|personallista|clearingnummer|bankkontonummer)\b/i.test(text))
    return 'Texten ser ut att innehålla person-, löne-, bank- eller internprisuppgifter.';
  if (/ignorera\s+(?:alla\s+)?(?:tidigare|system)|(?:visa|avslöja)\s+(?:systemprompt|hemliga|api[- ]?nyckel)/i.test(text)) return 'Kunskapstext får inte ändra agentens säkerhetsinstruktioner.';
  return null;
}
const demandSafe = text => { const reason = sensitive(text); if (reason) fail(`${reason} Ta bort uppgifterna innan texten sparas.`, 422, 'ai_support_sensitive_content'); };
export function ensureAiSupport(state, options = {}) {
  if (!options.organisationId) throw new TypeError('AI-support behöver ett betrott bolags-ID.');
  state.aiSupport ??= { version: 1, organisationId: options.organisationId, revision: 0, settings: defaults(options), knowledge: [], requests: [], audit: [], previewAttempts: [] };
  if (state.aiSupport.organisationId !== options.organisationId) fail('Kunskapsbanken tillhör ett annat bolag.', 403, 'ai_support_tenant_mismatch');
  state.aiSupport.previewAttempts ??= [];
  return state.aiSupport;
}
function readDomain(state, options) {
  if (!state.aiSupport) return { version: 1, organisationId: options.organisationId, revision: 0, settings: defaults(options), knowledge: [], requests: [], audit: [] };
  if (state.aiSupport.organisationId !== options.organisationId) fail('Kunskapsbanken tillhör ett annat bolag.', 403, 'ai_support_tenant_mismatch');
  return state.aiSupport;
}
const publishedEntries = value => value.knowledge.filter(approved);
function demandBudget(value) {
  const published = publishedEntries(value), characters = published.reduce((sum, entry) => sum + charactersOf(entry), 0);
  if (value.knowledge.length > AI_SUPPORT_LIMITS.maxTotal) fail('Kunskapsbanken får innehålla högst 100 sparade poster. Ingen historik raderas automatiskt.', 409, 'ai_support_total_limit');
  if (published.length > AI_SUPPORT_LIMITS.maxPublished || characters > AI_SUPPORT_LIMITS.maxPublishedCharacters)
    fail('Publiceringen överskrider gränsen på 20 kundgodkända svar eller 10 000 tecken. Korta eller arkivera andra svar först.', 409, 'ai_support_publication_limit');
}

/** Pure allowlist: no live pricing, article metadata, HR, customer or bank
 * lookup. Article excerpts enter only through a frozen, reviewed wiki version. */
export function buildAiSupportContext(state, { organisationId, siteId, companyName, defaultVoice, engine = 'live' } = {}) {
  if (!organisationId || !siteId) throw new TypeError('AI-kontext behöver betrott bolag och anläggning.');
  const value = readDomain(state, { organisationId, companyName, defaultVoice, engine }); demandBudget(value);
  const { settings } = effectiveProfile(value, { engine, defaultVoice }); demandSafe(`${settings.companyName}\n${settings.greeting}\n${settings.pronunciationText}`);
  const knowledge = publishedEntries(value).filter(entry => !entry.siteIds.length || entry.siteIds.includes(siteId)).map(entry => {
    demandSafe(`${entry.title}\n${entry.answer}`);
    return { id: entry.id, version: entry.version, title: entry.title, answer: entry.answer, category: entry.category, siteIds: [...entry.siteIds] };
  });
  const text = knowledge.length ? `Kundgodkända fakta för det valda bolaget och den valda anläggningen. Använd bara relevanta fakta; saknad information ska följas upp av en kollega.\n\n${knowledge.map(entry => `${entry.title}\n${entry.answer}`).join('\n\n')}` : '';
  return { policyVersion: AI_SUPPORT_POLICY_VERSION, revision: value.revision, enabled: settings.enabled, companyName: settings.companyName,
    supportProfile: { voice: settings.voice, greeting: settings.greeting, tone: settings.tone, pace: settings.pace, pronunciationText: settings.pronunciationText }, knowledge, text };
}

const suggestions = Object.freeze([
  { id: 'material-question', title: 'Vilket material gäller ärendet?', answer: 'Beskriv gärna vilket material du har och ungefärlig mängd. En kollega behöver bekräfta mottagning och aktuella villkor.', category: 'materials', reason: 'Samlar materialuppgifter utan påhittade priser eller mottagningslöften.' },
  { id: 'pickup-question', title: 'Önskemål om hämtning', answer: 'Berätta vilket material som ska hämtas, ungefärlig mängd och önskad plats. En kollega behöver bekräfta om och när hämtningen kan genomföras.', category: 'pickups', reason: 'Samlar önskemål utan att lova en bokning.' },
  { id: 'hours-question', title: 'Öppettider och besök', answer: 'En kollega behöver bekräfta aktuella öppettider och förutsättningarna för ditt besök.', category: 'opening_hours', reason: 'Komplettera med verifierade bolagsuppgifter innan mer precisa besked ges.' },
  { id: 'cable-question', title: 'Kopparkabel och materialklassning', answer: 'Beskriv kabelns typ och om hölje, kontakter eller andra material finns kvar. En kollega behöver bekräfta materialklassning, mottagning och ersättning för just din kabel.', category: 'materials', reason: 'Förslag att granska mot bolagets verkliga kabelsortiment; inget automatiskt löfte om köp eller pris.' },
  { id: 'weighing-question', title: 'Invägning, pris och avräkning', answer: 'Beskriv material och ungefärlig mängd inför inlämningen. En kollega behöver kontrollera klassning, aktuellt pris och avräkningsunderlag innan ersättning kan bekräftas.', category: 'payments', reason: 'Kopplar inlämningsfrågan till verkligt underlag utan påhittade priser, avdrag eller utbetalningslöften.' },
  { id: 'payment-question', title: 'Identifiering och betalning', answer: 'En kollega behöver bekräfta vilken identifiering och vilket betalningssätt som gäller för ditt ärende. Lämna inte personnummer, bankuppgifter, kortuppgifter eller inloggningsuppgifter i detta testsamtal.', category: 'payments', reason: 'Hittar inte på identitetskrav, ger inga betalningslöften och efterfrågar inga känsliga uppgifter.' },
  { id: 'origin-question', title: 'Materialets ursprung', answer: 'Beskriv var materialet kommer ifrån och vilken adress ärendet gäller. En kollega behöver bekräfta vilka ursprungsuppgifter som krävs för just detta material.', category: 'materials', reason: 'Samlar sakuppgifter utan att hitta på myndighetskrav.' },
  { id: 'office-question', title: 'När kontoret behöver följa upp', answer: 'Jag kan hjälpa till att beskriva ärendet, men en kollega behöver bekräfta priser, villkor och eventuella bokningar. Berätta ditt namn och vad du önskar hjälp med.', category: 'general', reason: 'Tydlig kontorshänvisning utan kontaktlöften eller påhittade kontaktuppgifter.' },
]);
function articleCandidates(state) {
  const selected = new Map();
  for (const article of state.pricing?.articleHistory ?? []) if (!selected.has(article.id) || (article.sequence ?? 0) > (selected.get(article.id).sequence ?? 0)) selected.set(article.id, article);
  return [...selected.values()].filter(article => article.active !== false).map(article => ({ id: article.id, name: String(article.name ?? ''), description: String(article.description ?? ''), includes: Array.isArray(article.includes) ? article.includes.filter(item => typeof item === 'string') : [], excludes: Array.isArray(article.excludes) ? article.excludes.filter(item => typeof item === 'string') : [] }));
}
const knowledgeView = entry => clone(Object.fromEntries(['id', 'version', 'title', 'answer', 'category', 'siteIds', 'status', 'publicApproved', 'source', 'createdAt', 'updatedAt'].filter(key => entry[key] !== undefined).map(key => [key, entry[key]])));
const entryVisible = (entry, principal) => !entry.siteIds.length ? globalWrite(principal) || approved(entry) : entry.siteIds.every(siteId => allows(principal, siteId));
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('AI-support måste användas från samma webbplats.', 403, 'ai_support_origin_forbidden');
  if (!req.headers.origin) return;
  try { const origin = new URL(req.headers.origin), protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:'; if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error(); }
  catch { fail('AI-support måste användas från samma webbplats.', 403, 'ai_support_origin_forbidden'); }
}
function sendJson(res, status, value, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(head ? undefined : JSON.stringify(value));
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > AI_SUPPORT_LIMITS.maxBodyBytes) fail('AI-supportuppgifterna är för stora.', 413);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > AI_SUPPORT_LIMITS.maxBodyBytes) fail('AI-supportuppgifterna är för stora.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Anropet ska innehålla giltig JSON.'); }
}

export function createAiSupportApi({ env = {}, getRepository, officePrincipal, siteProvider = async () => [], companyName, provider: suppliedProvider, reauthorizePreview, now = () => new Date() } = {}) {
  if (typeof getRepository !== 'function' || typeof officePrincipal !== 'function') throw new TypeError('AI-support behöver bolagets databas och verifierad kontorssession.');
  const runtimeConfig = voiceTestProviderConfig(env);
  const options = { organisationId: env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo', companyName, defaultVoice: runtimeConfig.defaultVoice, engine: runtimeConfig.engine };
  // The legacy profile fallback is not proof of tenant identity for a branded
  // knowledge pack. Require an explicitly configured, trusted organisation ID.
  const packOptions = { organisationId: env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID };
  let providerPromise, closed = false, closePromise; const previewing = new Set(), previewTasks = new Set();
  const getProvider = () => providerPromise ??= suppliedProvider ? Promise.resolve(suppliedProvider) : createVoiceTestProvider({ env });
  const timestamp = () => new Date(now()).toISOString();
  const read = async operation => (await getRepository()).read(operation, { domains: ['aiSupport', 'pricing'] });
  async function principalFor(state, req) {
    let principal;
    try { principal = await officePrincipal(state, req); } catch (error) { if ([401, 403].includes(error?.status)) fail('Ditt konto saknar aktuell behörighet till AI-support.', error.status, 'ai_support_forbidden'); throw error; }
    if (!principal?.actor?.id || !principal?.user?.id) fail('Logga in för att öppna AI-support.', 401, 'ai_support_auth_required');
    if (![principal.actor, principal.user].every(privileged)) fail('AI-support kräver Systemadmin eller VD för både ditt verkliga och valda konto.', 403, 'ai_support_forbidden');
    return principal;
  }
  function demandSites(principal, selected, sites) {
    if (!selected.length) { if (!globalWrite(principal)) fail('Bolagsgemensam kunskap kräver obegränsad anläggningsåtkomst för båda kontona.', 403, 'ai_support_site_forbidden'); return; }
    if (selected.some(siteId => !allows(principal, siteId))) fail('Kunskapen omfattar en anläggning utanför din åtkomst.', 403, 'ai_support_site_forbidden');
    if (selected.some(siteId => !sites.some(site => site.id === siteId && site.active !== false))) fail('Välj en registrerad aktiv anläggning.', 422, 'ai_support_site_invalid');
  }
  function demandEntryAccess(principal, entry) {
    if (!entry.siteIds.length ? !globalWrite(principal) : entry.siteIds.some(siteId => !allows(principal, siteId))) fail('Kunskapsposten omfattar anläggningar utanför din åtkomst.', 403, 'ai_support_site_forbidden');
  }
  function view(state, principal, sites) {
    const value = readDomain(state, options), visible = value.knowledge.filter(entry => entryVisible(entry, principal)), published = visible.filter(approved), site = sites.find(site => site.active !== false && allows(principal, site.id));
    const context = site ? buildAiSupportContext(state, { ...options, siteId: site.id }) : null;
    const effective = effectiveProfile(value, options);
    const starterPack = globalWrite(principal) ? getJerocKnowledgePack(packOptions) : null;
    return { revision: value.revision, policyVersion: AI_SUPPORT_POLICY_VERSION, settings: effective.settings, knowledge: visible.map(knowledgeView), suggestions: clone(suggestions), voices: runtimeConfig.voices.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1) })), sites: sites.filter(site => site.active !== false && allows(principal, site.id)).map(site => ({ id: site.id, name: site.name })), articleCandidates: articleCandidates(state),
      ...(starterPack ? { starterPack: { id: starterPack.id, version: starterPack.version, title: starterPack.title, items: starterPack.items.map(({ id, title, answer, category, sources }) => ({ id, title, answer, category, sources })), importedItemIds: [...new Set(value.knowledge.filter(entry => entry.source?.type === 'starter_pack' && entry.source.packId === starterPack.id).map(entry => entry.source.itemId))] } } : {}),
      runtime: { engine: runtimeConfig.engine, model: runtimeConfig.model, voice: effective.settings.voice, previewAvailable: runtimeConfig.previewAvailable, ...(effective.notice ? { notice: effective.notice } : {}) },
      stats: { total: visible.length, published: published.length, publishedCharacters: published.reduce((sum, item) => sum + charactersOf(item), 0), ...AI_SUPPORT_LIMITS }, capabilities: { read: true, write: true, settingsWrite: globalWrite(principal), globalWrite: globalWrite(principal), previewAvailable: runtimeConfig.previewAvailable },
      runtimePreview: context ? { siteId: site.id, siteName: site.name, items: context.knowledge.map(({ id, version, title, answer }) => ({ id, version, title, answer })), characters: context.text.length, revision: context.revision, policyVersion: context.policyVersion } : null };
  }
  function audit(value, principal, action, details, changes) {
    const row = { id: randomUUID(), domain: 'aiSupport', at: timestamp(), action, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, ...details }; value.audit.push(row); changes.push(clone(row));
  }
  async function runPreview(req, input) {
    if (closed) fail('Röstförhandslyssningen stängs av.', 503, 'ai_support_preview_unavailable');
    if (!runtimeConfig.voices.includes(input.voice)) fail('Välj en röst som stöds av den aktuella röstmotorn.', 422, 'ai_support_voice_unavailable');
    if (!runtimeConfig.previewAvailable) fail('GPT-Live stöder inte denna provlyssning. Använd rösttestet för att höra den valda Live-rösten.', 503, 'ai_support_preview_unavailable');
    const provider = await getProvider();
    if (typeof provider.status === 'function' && provider.status().available === false) fail('Röstleverantören är inte tillgänglig. Kontrollera serverns OpenAI-inställningar.', 503, 'ai_support_preview_unavailable');
    const reserved = await (await getRepository()).transact(async (state, _revision, changes = []) => {
      const principal = await principalFor(state, req), value = ensureAiSupport(state, options), at = timestamp(), current = Date.parse(at), { settings: profile } = effectiveProfile(value, options);
      const selected = { greeting: profile.greeting, tone: profile.tone, pace: profile.pace, pronunciationText: profile.pronunciationText, ...input.profile }; demandSafe(`${profile.companyName}\n${selected.greeting}\n${selected.pronunciationText}`);
      if (value.previewAttempts.some(attempt => attempt.status === 'pending' && Date.parse(attempt.leaseUntil) > current)) fail('En röstförhandslyssning pågår redan i bolaget.', 429, 'ai_support_preview_busy');
      const recent = value.previewAttempts.filter(attempt => current - Date.parse(attempt.createdAt) < 3_600_000);
      if (recent.filter(attempt => attempt.actualUserId === principal.actor.id).length >= 10 || recent.filter(attempt => attempt.effectiveUserId === principal.user.id).length >= 10) fail('Högst tio röstprov får startas per timme och konto.', 429, 'ai_support_preview_hour_quota');
      if (value.previewAttempts.filter(attempt => stockholmDay.format(new Date(attempt.createdAt)) === stockholmDay.format(new Date(at))).length >= 50) fail('Bolagets gräns på 50 röstprov per dag är nådd.', 429, 'ai_support_preview_day_quota');
      const attempt = { id: randomUUID(), createdAt: at, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, voice: input.voice, status: 'pending', leaseUntil: new Date(current + 10_000).toISOString() };
      value.previewAttempts.push(attempt); audit(value, principal, 'ai_support.preview_reserved', { previewId: attempt.id, voice: input.voice }, changes);
      return { attemptId: attempt.id, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, companyName: profile.companyName, profile: selected };
    });
    const controller = new AbortController(); previewing.add(controller); let timer, succeeded = false;
    try {
      const result = await Promise.race([provider.preview({ voice: input.voice, profile: reserved.profile, companyName: reserved.companyName, signal: controller.signal }), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Preview timeout')); }, 9000); timer.unref?.(); })]);
      if (result?.mimeType !== 'audio/mpeg' || typeof result.audioBase64 !== 'string' || result.audioBase64.length > 700_000 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(result.audioBase64) || Buffer.from(result.audioBase64, 'base64').length < 1 || Buffer.from(result.audioBase64, 'base64').length > 512 * 1024) throw new Error('Invalid audio');
      if (reauthorizePreview) {
        const snapshot = await read(state => state); let live;
        try { live = await reauthorizePreview(snapshot, { id: reserved.attemptId, createdBy: { actualUserId: reserved.actualUserId, effectiveUserId: reserved.effectiveUserId } }, req); }
        catch { fail('Sessionen eller bolagsåtkomsten ändrades under röstprovet. Öppna AI-support igen.', 403, 'ai_support_preview_authorization_changed'); }
        if (!live || ![live.actor, live.user].every(privileged) || live.actor.id !== reserved.actualUserId || live.user.id !== reserved.effectiveUserId) fail('Sessionen eller bolagsåtkomsten ändrades under röstprovet. Öppna AI-support igen.', 403, 'ai_support_preview_authorization_changed');
      }
      const fresh = await read(state => principalFor(state, req));
      if (fresh.actor.id !== reserved.actualUserId || fresh.user.id !== reserved.effectiveUserId) fail('Det verkliga eller valda kontot ändrades under röstprovet.', 403, 'ai_support_preview_authorization_changed');
      succeeded = true; return { audioBase64: result.audioBase64, mimeType: 'audio/mpeg', voice: input.voice };
    } catch (error) { if (error.publicAiSupportError) throw error; fail('Rösten kunde inte förhandslyssnas. Inget automatiskt återförsök görs.', 503, 'ai_support_preview_failed'); }
    finally {
      clearTimeout(timer); controller.abort(); previewing.delete(controller);
      await (await getRepository()).transact(state => { const attempt = ensureAiSupport(state, options).previewAttempts.find(item => item.id === reserved.attemptId); if (attempt) { attempt.status = succeeded ? 'completed' : 'failed'; attempt.endedAt = timestamp(); delete attempt.leaseUntil; } });
    }
  }
  const handler = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/ai-support')) return false;
    try {
      sameOrigin(req); const route = url.pathname.match(/^\/api\/ai-support(?:\/(settings|knowledge|preview)(?:\/(from-article|[a-zA-Z0-9_-]{1,120})(?:\/(archive))?)?)?$/);
      if (!route || url.search) fail('AI-supportadressen är ogiltig.', 404, 'ai_support_route_missing');
      const [, section, target, action] = route, get = !section;
      if (!(get ? ['GET', 'HEAD'] : ['POST']).includes(req.method)) { res.setHeader('Allow', get ? 'GET, HEAD' : 'POST'); fail('Metoden stöds inte.', 405); }
      const principal = await read(state => principalFor(state, req)), catalog = await siteProvider(), sites = Array.isArray(catalog) ? catalog : catalog?.sites ?? [];
      if (get) { sendJson(res, 200, await read(state => view(state, principal, sites)), req.method === 'HEAD'); return true; }
      const body = await readJson(req);
      if (section === 'preview' && !target && !action) { const work = runPreview(req, parse(previewInput, body)); previewTasks.add(work); try { sendJson(res, 200, await work); } finally { previewTasks.delete(work); } return true; }
      const kind = section === 'settings' && !target && !action ? 'settings' : section === 'knowledge' && target === 'from-article' && !action ? 'article' : section === 'knowledge' && target === 'from-starter-pack' && !action ? 'starter_pack' : section === 'knowledge' && target && action === 'archive' ? 'archive' : section === 'knowledge' && !target && !action ? 'knowledge' : null;
      if (!kind) fail('AI-supportadressen är ogiltig.', 404, 'ai_support_route_missing');
      const input = parse(kind === 'settings' ? settingsInput : kind === 'article' ? articleInput : kind === 'starter_pack' ? starterPackInput : kind === 'archive' ? archiveInput : knowledgeInput, body);
      const response = await (await getRepository()).transact(async (state, _revision, changes = []) => {
        const fresh = await principalFor(state, req);
        if (kind === 'starter_pack') {
          if (!getJerocKnowledgePack(packOptions)) fail('Det finns inget tillgängligt kunskapspaket för bolaget.', 404, 'ai_support_starter_pack_missing');
          if (!globalWrite(fresh)) fail('Bolagsgemensam kunskap kräver obegränsad anläggningsåtkomst för båda kontona.', 403, 'ai_support_site_forbidden');
        }
        const value = ensureAiSupport(state, options), requestHash = hash({ kind, target: kind === 'archive' ? target : undefined, input });
        const previous = input.requestId && value.requests.find(item => item.requestId === input.requestId);
        if (previous) {
          if (previous.actualUserId !== fresh.actor.id || previous.effectiveUserId !== fresh.user.id || previous.hash !== requestHash) fail('Försöksnyckeln har redan använts för andra uppgifter.', 409, 'ai_support_request_conflict');
          const entries = value.knowledge.filter(item => item.id === previous.knowledgeId || previous.knowledgeIds?.includes(item.id)); for (const entry of entries) demandEntryAccess(fresh, entry);
          return { ...view(state, fresh, sites), saved: { ...(previous.knowledgeId ? { knowledgeId: previous.knowledgeId } : {}), ...(previous.knowledgeIds ? { knowledgeIds: [...previous.knowledgeIds] } : {}) }, replayed: true };
        }
        if (value.revision !== input.expectedRevision) fail('AI-supportuppgifterna har ändrats. Läs in senaste versionen före sparande.', 409, 'ai_support_revision_conflict');
        let saved;
        if (kind === 'settings') {
          if (!globalWrite(fresh)) fail('Bolagets AI-profil kräver obegränsad anläggningsåtkomst för båda kontona.', 403, 'ai_support_site_forbidden');
          if (!runtimeConfig.voices.includes(input.voice)) fail('Välj en röst som stöds av den aktuella röstmotorn.', 422, 'ai_support_voice_unavailable');
          const { expectedRevision, ...profile } = input; demandSafe(`${profile.companyName}\n${profile.greeting}\n${profile.pronunciationText}`); rememberVoice(value, profile.voice, runtimeConfig.engine); value.settings = profile; value.revision++; audit(value, fresh, 'ai_support.settings_saved', { revision: value.revision }, changes); saved = { settings: true };
        } else if (kind === 'starter_pack') {
          const pack = getJerocKnowledgePack(packOptions);
          if (input.packId !== pack.id) fail('Välj bolagets tillgängliga kunskapspaket.', 422, 'ai_support_starter_pack_invalid');
          if (input.packVersion !== pack.version) fail('Kunskapspaketet har ändrats. Läs in och granska den senaste versionen före import.', 409, 'ai_support_starter_pack_version_conflict');
          const selected = input.itemIds.map(itemId => pack.items.find(item => item.id === itemId));
          if (selected.some(item => !item)) fail('Urvalet innehåller en okänd fråga från kunskapspaketet.', 422, 'ai_support_starter_pack_invalid');
          if (input.status === 'published' && !input.publicApproved) fail('Godkänn uttryckligen att de valda svaren får användas i kundsamtal före publicering.', 422, 'ai_support_public_approval_required');
          // Provenance survives edits and archiving. Re-importing must never
          // overwrite an office decision or restore an intentionally retired FAQ.
          const imported = new Set(value.knowledge.filter(entry => entry.source?.type === 'starter_pack' && entry.source.packId === pack.id).map(entry => entry.source.itemId));
          const candidates = selected.filter(item => !imported.has(item.id));
          if (!candidates.length) fail('Alla valda frågor har redan importerats. Redigera de sparade posterna i kunskapsbanken.', 409, 'ai_support_starter_pack_already_imported');
          const at = timestamp(), knowledgeIds = [];
          for (const candidate of candidates) {
            demandSafe(`${candidate.title}\n${candidate.answer}`);
            const entry = { id: randomUUID(), version: 1, title: candidate.title, answer: candidate.answer, category: candidate.category, siteIds: [], status: input.status, publicApproved: input.status === 'published' && input.publicApproved,
              source: { type: 'starter_pack', packId: pack.id, packVersion: pack.version, itemId: candidate.id, sources: clone(candidate.sources) }, createdAt: at, updatedAt: at, history: [] };
            if (entry.publicApproved) { entry.approvedVersion = entry.version; entry.approvedHash = hash(contentOf(entry)); entry.approvedAt = at; entry.approvedBy = { actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id }; }
            value.knowledge.push(entry); knowledgeIds.push(entry.id);
          }
          // One transaction/revision/audit covers the whole batch. A budget
          // failure rolls back the entries and idempotency reservation together.
          demandBudget(value); value.revision++;
          audit(value, fresh, 'ai_support.starter_pack_imported', { packId: pack.id, packVersion: pack.version, knowledgeIds: [...knowledgeIds], itemIds: candidates.map(item => item.id), status: input.status, revision: value.revision }, changes);
          value.requests.push({ requestId: input.requestId, actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id, hash: requestHash, knowledgeIds: [...knowledgeIds], at });
          saved = { knowledgeIds };
        } else {
          let entry = kind === 'archive' ? value.knowledge.find(item => item.id === target) : kind === 'knowledge' && input.id ? value.knowledge.find(item => item.id === input.id) : null;
          if ((kind === 'archive' || kind === 'knowledge' && input.id) && !entry) fail('Kunskapsposten finns inte.', 404, 'ai_support_knowledge_missing');
          if (entry) demandEntryAccess(fresh, entry);
          if (kind === 'archive') {
            if (entry.status !== 'archived') { entry.history.push(knowledgeView(entry)); entry.version++; entry.status = 'archived'; entry.publicApproved = false; delete entry.approvedVersion; delete entry.approvedHash; entry.updatedAt = timestamp(); value.revision++; audit(value, fresh, 'ai_support.knowledge_archived', { knowledgeId: entry.id, version: entry.version }, changes); }
          } else {
            demandSites(fresh, input.siteIds, sites); let values;
            if (kind === 'article') {
              const article = articleCandidates(state).find(item => item.id === input.articleId); if (!article) fail('Välj en aktiv artikel från bolagets artikelregister.', 422, 'ai_support_article_missing');
              const answer = [article.description, article.includes.length ? `Ingår: ${article.includes.join('; ')}` : '', article.excludes.length ? `Ingår inte: ${article.excludes.join('; ')}` : ''].filter(Boolean).join('\n') || article.name;
              if (answer.length > 3000 || article.name.length > 160) fail('Artikelutdraget är för långt för ett kunskapssvar. Skapa ett avgränsat manuellt utkast.', 422, 'ai_support_article_too_long');
              values = { title: article.name, answer, category: 'materials', siteIds: [...input.siteIds].sort(), status: 'draft', publicApproved: false, source: { type: 'article', articleId: article.id } };
            } else {
              if (input.status === 'published' && !input.publicApproved) fail('Godkänn uttryckligen att svaret får användas i kundsamtal före publicering.', 422, 'ai_support_public_approval_required');
              values = { title: input.title, answer: input.answer, category: input.category, siteIds: [...input.siteIds].sort(), status: input.status, publicApproved: input.status === 'published' && input.publicApproved, source: entry?.source ?? { type: 'manual' } };
            }
            demandSafe(`${values.title}\n${values.answer}`);
            if (!entry && value.knowledge.length >= AI_SUPPORT_LIMITS.maxTotal) fail('Kunskapsbanken har nått 100 sparade poster. Ingen historik raderas automatiskt.', 409, 'ai_support_total_limit');
            const at = timestamp();
            if (entry) { entry.history.push(knowledgeView(entry)); Object.assign(entry, values, { version: entry.version + 1, updatedAt: at }); }
            else { entry = { id: randomUUID(), version: 1, ...values, createdAt: at, updatedAt: at, history: [] }; value.knowledge.push(entry); }
            delete entry.approvedVersion; delete entry.approvedHash;
            if (entry.publicApproved) { entry.approvedVersion = entry.version; entry.approvedHash = hash(contentOf(entry)); entry.approvedAt = at; entry.approvedBy = { actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id }; }
            demandBudget(value); value.revision++; audit(value, fresh, kind === 'article' ? 'ai_support.article_draft_created' : entry.publicApproved ? 'ai_support.knowledge_published' : 'ai_support.knowledge_draft_saved', { knowledgeId: entry.id, version: entry.version, revision: value.revision }, changes);
          }
          saved = { knowledgeId: entry.id }; value.requests.push({ requestId: input.requestId, actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id, hash: requestHash, knowledgeId: entry.id, at: timestamp() });
        }
        return { ...view(state, fresh, sites), saved };
      }); sendJson(res, 200, response); return true;
    } catch (error) { sendJson(res, error.publicAiSupportError ? error.status : 503, { error: error.publicAiSupportError ? error.message : 'AI-support kunde inte behandla anropet.', code: error.publicAiSupportError ? error.code : 'ai_support_unavailable' }, req.method === 'HEAD'); return true; }
  };
  handler.close = () => { closePromise ??= (async () => { closed = true; for (const controller of previewing) controller.abort(); await Promise.allSettled([...previewTasks]); if (providerPromise) { try { await (await providerPromise).close?.(); } catch {} } })(); return closePromise; };
  return handler;
}
