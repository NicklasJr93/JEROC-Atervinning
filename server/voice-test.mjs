import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildAiSupportContext } from './ai-support.mjs';
import { createVoiceTestProvider, voiceTestProviderConfig } from './voice-test-provider.mjs';

export const VOICE_TEST_LIMITS = Object.freeze({ maxDurationSeconds: 180, maxStartsPerHour: 6, maxStartsPerDay: 30, maxStoredCalls: 300, maxBodyBytes: 256 * 1024 });
const ACTIVE = new Set(['connecting', 'active']);
const DOMAINS = ['voiceTest', 'metadata', 'pricing', 'personnel', 'personnelAuth'];
const CALLER = '+46700000000';
const clone = value => structuredClone(value);
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const dateInStockholm = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });
const fail = (message, status = 422, code = 'voice_test_invalid') => { throw Object.assign(new Error(message), { status, code, publicVoiceError: true }); };
const requestId = z.string().trim().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const createInput = z.object({ requestId, sdp: z.string().min(20).max(240 * 1024).refine(value => /^v=0\r?\n/.test(value) && /(?:^|\n)m=audio\s/.test(value), 'En giltig WebRTC-ljudförfrågan krävs.') }).strict();
const emptyInput = z.object({}).strict();
const statusInput = z.object({ status: z.enum(['new', 'in_progress', 'done']) }).strict();
const liveFragment = z.object({ eventId: z.string().min(1).max(250), startMs: z.number().finite().min(0).max(86_400_000), endMs: z.number().finite().min(0).max(86_400_000), text: z.string().max(20_000), deliveryIndex: z.number().int().min(0).max(9999).optional() }).strict().refine(item => item.endMs >= item.startMs);
const transcriptInput = z.object({ id: z.string().min(1).max(200), role: z.enum(['user', 'assistant']), text: z.string().max(24_000), at: z.string().datetime({ offset: true }).optional(), sequence: z.number().int().nonnegative().max(172_800_000).optional(), interrupted: z.boolean().optional(), liveFragments: z.array(liveFragment).max(500).optional(), startMs: z.number().finite().min(0).max(86_400_000).optional(), endMs: z.number().finite().min(0).max(86_400_000).optional() }).strict();
const parse = (schema, value) => { const parsed = schema.safeParse(value); if (!parsed.success) fail('Testanropet innehåller ogiltiga eller okända uppgifter.'); return parsed.data; };
const authorizedUser = user => Boolean(user?.id) && user.active !== false && ['Systemadmin', 'VD'].includes(user.level);
export const voiceTestCapabilities = principal => ({ read: authorizedUser(principal?.actor) && authorizedUser(principal?.user), write: authorizedUser(principal?.actor) && authorizedUser(principal?.user) });
const scopeAllows = (principal, siteId) => [principal.actor, principal.user].every(user => !Array.isArray(user.siteIds) || user.siteIds.includes(siteId));
const publicSite = site => Object.fromEntries(['id', 'name', 'address', 'postalCode', 'city', 'phone'].filter(key => typeof site?.[key] === 'string').map(key => [key, site[key].slice(0, 300)]));
const summaryOf = call => call.transcript.filter(turn => turn.role === 'user' && turn.text.trim()).map(turn => turn.text.trim()).join(' ').slice(0, 1000);

export function ensureVoiceTest(state, organisationId) {
  state.voiceTest ??= { version: 1, organisationId, revision: 0, calls: [], audit: [] };
  if (state.voiceTest.organisationId !== organisationId) fail('Rösttestets journal tillhör ett annat bolag.', 403, 'voice_test_tenant_mismatch');
  return state.voiceTest;
}

function callView(call, now) {
  return clone({ id: call.id, requestId: call.requestId, revision: call.revision, status: call.status, ...(call.protocol ? { protocol: call.protocol } : {}), callerNumber: CALLER, callerLabel: 'TEST',
    createdAt: call.createdAt, ...(call.startedAt ? { startedAt: call.startedAt } : {}), ...(call.endedAt ? { endedAt: call.endedAt } : {}),
    durationSeconds: Math.max(0, Math.min(VOICE_TEST_LIMITS.maxDurationSeconds, Math.floor(((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.startedAt ?? call.createdAt)) / 1000))),
    createdBy: call.createdBy, siteId: call.site.id, siteName: call.site.name, site: call.site, transcript: call.transcript, transcriptComplete: call.transcriptComplete === true, summary: call.summary ?? '',
    followupStatus: call.followupStatus, summaryStatus: call.summaryStatus ?? 'pending', topic: call.topic ?? null, callbackRequested: call.callbackRequested ?? null,
    ...(Number.isFinite(call.providerUsageSeconds) ? { providerUsageSeconds: call.providerUsageSeconds } : {}), ...(call.aiSupportSnapshot ? { aiSupportSnapshot: call.aiSupportSnapshot } : {}), ...(call.summaryModel ? { summaryModel: call.summaryModel } : {}), ...(typeof call.providerConfirmed === 'boolean' ? { providerConfirmed: call.providerConfirmed } : {}), ...(call.endReason ? { endReason: call.endReason } : {}), ...(call.error ? { error: call.error } : {}) });
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Rösttestet måste användas från samma webbplats.', 403, 'voice_test_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin), protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Rösttestet måste användas från samma webbplats.', 403, 'voice_test_origin_forbidden'); }
}
function sendJson(res, status, value, head = false) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
}
async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > VOICE_TEST_LIMITS.maxBodyBytes) fail('Röstförfrågan är för stor.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > VOICE_TEST_LIMITS.maxBodyBytes) fail('Röstförfrågan är för stor.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Röstförfrågan ska innehålla giltig JSON.'); }
}
const instructionsFor = (site, companyName) => `Du är ${companyName}s svenska kundmottagare i ett avskilt rösttest. Tala naturlig svenska och ställ en fråga i taget. Använd den godkända hälsningen. Den kända anläggningen är ${site.name}. Hjälp kunden beskriva sitt ärende, material, önskad hämtning eller kontaktbehov. Be vid behov om namn, material och önskemål. Numret är redan känt i testet; be inte användaren uppge eller bekräfta telefonnumret. Testets fasta nummer ${CALLER} är ett testnummer, inte en verifierad kundidentitet. Hitta inte på priser, öppettider, tillstånd eller tillgänglighet. Bekräfta aldrig en verklig bokning, betalning eller arbetsorder. Säg att en kollega behöver följa upp sådant. Samtalet och dess transkription sparas som testunderlag. Avsluta vänligt med en kort återgivning av ärendet. Du har inga verktyg för att ändra verksamhetsdata.`;

/** The selected tenant's repository owns quotas and the journal. Only the
 * provider's authenticated sideband can append transcript turns. */
export function createVoiceTestApi({ getRepository, officePrincipal, siteProvider = async () => [], env = {}, provider: suppliedProvider, companyName: suppliedCompanyName,
  reauthorizeCall, now = () => new Date(), schedule = setTimeout, cancel = clearTimeout, runtimeId = randomUUID() } = {}) {
  if (typeof getRepository !== 'function' || typeof officePrincipal !== 'function') throw new TypeError('Rösttestet behöver bolagets databas och verifierad kontorssession.');
  const organisationId = env.SCRAPPILOT_ORGANISATION_ID ?? env.JEROC_TENANT_ID ?? 'jeroc-demo';
  const companyName = String(suppliedCompanyName ?? (organisationId === 'jeroc-demo' ? 'JEROC' : 'företaget')).trim().slice(0, 200) || 'företaget';
  const providerConfig = voiceTestProviderConfig(env);
  const providerPromise = suppliedProvider ? Promise.resolve(suppliedProvider) : createVoiceTestProvider({ env });
  const sessions = new Map(), pending = new Set(), summaryControllers = new Set(); let closing = false, heartbeat, shutdownPromise;
  const timestamp = () => { const value = new Date(now()); if (!Number.isFinite(value.getTime())) throw new TypeError('Rösttestets klocka är ogiltig.'); return value.toISOString(); };
  const track = promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; };
  const bounded = (promise, milliseconds) => new Promise((resolve, reject) => {
    const timer = schedule(() => reject(new Error('Voice operation timeout')), milliseconds); timer?.unref?.();
    Promise.resolve(promise).then(value => { cancel(timer); resolve(value); }, error => { cancel(timer); reject(error); });
  });
  const read = async operation => (await getRepository()).read(operation, { domains: DOMAINS });
  const write = async operation => (await getRepository()).transact(operation);
  const domain = state => state.voiceTest ? ensureVoiceTest(state, organisationId) : null;
  const touch = (value, call) => { value.revision += 1; call.revision += 1; };
  const audit = (value, call, action, extra = {}, transactionAudit = []) => {
    const row = { id: randomUUID(), domain: 'voiceTest', at: timestamp(), action, callId: call.id, actualUserId: call.createdBy.actualUserId, effectiveUserId: call.createdBy.effectiveUserId, ...extra };
    value.audit.push(row); transactionAudit.push(clone(row));
  };
  async function principalFor(state, req) {
    let principal;
    try { principal = await officePrincipal(state, req); }
    catch (error) { if ([401, 403].includes(error?.status)) fail('Ditt konto saknar aktuell behörighet till rösttestet.', error.status, 'voice_test_forbidden'); throw error; }
    if (!principal?.actor?.id || !principal?.user?.id) fail('Logga in för att öppna rösttestet.', 401, 'voice_test_auth_required');
    if (!voiceTestCapabilities(principal).read) fail('Rösttestet kräver Systemadmin eller VD för både ditt verkliga och valda konto.', 403, 'voice_test_forbidden');
    return principal;
  }
  function visibleCall(state, principal, id) {
    const call = domain(state)?.calls.find(item => item.id === id);
    if (!call || !scopeAllows(principal, call.site.id)) fail('Testsamtalet finns inte inom din åtkomst.', 404, 'voice_test_call_missing');
    return call;
  }
  async function terminal(id, status, reason, error) {
    return write((state, _revision, changes = []) => {
      const value = domain(state), call = value?.calls.find(item => item.id === id); if (!call) return;
      if (ACTIVE.has(call.status)) {
        call.status = status; call.endedAt = timestamp(); call.endReason = reason; call.summary = summaryOf(call); if (error) call.error = error;
        delete call.leaseUntil; touch(value, call); audit(value, call, `voice_test.${status}`, { reason }, changes);
      }
      return callView(call, Date.parse(timestamp()));
    });
  }
  async function appendTranscript(id, input) {
    const turn = parse(transcriptInput, input);
    if (!turn.text.trim() && !turn.liveFragments?.length) return;
    return write((state, _revision, changes = []) => {
      const value = domain(state), call = value?.calls.find(item => item.id === id);
      if (!call || call.runtimeId !== runtimeId || call.transcriptFinalizedAt) return;
      const previous = call.transcript.find(item => item.id === turn.id && item.role === turn.role);
      const next = { ...turn, text: turn.liveFragments ? turn.text : turn.text.trim(), at: previous?.at ?? turn.at ?? timestamp() };
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      const total = call.transcript.reduce((sum, item) => sum + item.text.length, 0) - (previous?.text.length ?? 0) + next.text.length;
      if (call.transcript.length >= 600 && !previous || total > 200_000) fail('Transkriptionen överskrider testets gräns.', 413, 'voice_test_transcript_limit');
      if (previous) call.transcript[call.transcript.indexOf(previous)] = next; else call.transcript.push(next);
      call.transcript.sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || Date.parse(a.at) - Date.parse(b.at));
      if (!ACTIVE.has(call.status)) call.summary = summaryOf(call);
      touch(value, call); audit(value, call, 'voice_test.transcript_saved', { role: turn.role, turnId: turn.id }, changes);
    });
  }
  function closeResource(session, handle, reason) {
    if (!handle) return;
    session.closePromise ??= Promise.resolve().then(() => handle.close?.(reason));
    return session.closePromise;
  }
  async function stopLocal(id, reason) {
    const session = sessions.get(id); if (!session) return;
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      cancel(session.timer);
      if (!session.handle) { session.controller.abort(); try { await bounded(session.resourcePromise, 3000); } catch {} }
      let complete = Boolean(session.handle), providerConfirmed = session.handle ? undefined : false, providerUsageSeconds;
      try { const result = await bounded(closeResource(session, session.handle, reason), reason === 'server_shutdown' ? 5000 : session.protocol === 'live' ? 18_000 : 7000); if (result?.transcriptComplete === false) complete = false; if (typeof result?.providerConfirmed === 'boolean') providerConfirmed = result.providerConfirmed;
        if (result?.providerConfirmed === true && Number.isFinite(result.usage?.seconds) && result.usage.seconds >= 0 && result.usage.seconds <= 86_400) providerUsageSeconds = result.usage.seconds;
      } catch { complete = false; providerConfirmed = false; }
      session.controller.abort();
      await write(state => { const value = domain(state), call = value?.calls.find(item => item.id === id); if (call && !call.transcriptFinalizedAt) { call.transcriptFinalizedAt = timestamp(); delete call.transcriptGraceUntil; call.transcriptComplete = complete && call.transcriptComplete !== false; if (typeof providerConfirmed === 'boolean') call.providerConfirmed = providerConfirmed;
        if (providerUsageSeconds !== undefined) call.providerUsageSeconds = providerUsageSeconds;
        call.summary = summaryOf(call); touch(value, call); } });
      await summarize(id);
      sessions.delete(id);
    })();
    return session.stopping;
  }
  function stopSoon(id, reason) { queueMicrotask(() => { track(stopLocal(id, reason)).catch(() => {}); }); }
  async function summarize(id) {
    const attemptId = randomUUID(), selected = await write(state => {
      const value = domain(state), call = value?.calls.find(item => item.id === id);
      if (!call || ACTIVE.has(call.status) || !call.transcriptFinalizedAt || call.summaryAttemptId) return null;
      call.summaryAttemptId = attemptId; call.summaryStatus = 'pending'; call.summaryDeadlineAt = new Date(Date.parse(timestamp()) + 10_000).toISOString(); touch(value, call);
      return { transcript: clone(call.transcript), callerNumber: CALLER };
    });
    if (!selected) return;
    let result;
    if (!closing) {
      const controller = new AbortController(); summaryControllers.add(controller);
      try { result = await bounded((await providerPromise).summarize?.({ ...selected, signal: controller.signal }), 8000); } catch {}
      finally { controller.abort(); summaryControllers.delete(controller); }
    }
    await write((state, _revision, changes = []) => {
      const value = domain(state), call = value?.calls.find(item => item.id === id); if (!call || call.summaryAttemptId !== attemptId) return;
      call.summaryStatus = result?.status === 'generated' && typeof result.summary === 'string' ? 'generated' : 'fallback';
      if (typeof result?.summary === 'string' && result.summary.trim()) call.summary = result.summary.trim().slice(0, 4000);
      else call.summary = summaryOf(call) || 'Ingen fullständig transkription finns. Läs samtalets status före uppföljning.';
      call.topic = typeof result?.topic === 'string' ? result.topic.slice(0, 200) : null;
      call.callbackRequested = typeof result?.callbackRequested === 'boolean' ? result.callbackRequested : null;
      if (typeof result?.model === 'string') call.summaryModel = result.model.slice(0, 100);
      delete call.summaryDeadlineAt;
      touch(value, call); audit(value, call, 'voice_test.summary_saved', { status: call.summaryStatus }, changes);
    });
  }
  async function expireAndCheck() {
    const current = timestamp(), numericNow = Date.parse(current), stop = [];
    const authorization = new Map();
    if (sessions.size) {
      const snapshot = await read(state => state);
      await Promise.all([...sessions].map(async ([id, session]) => {
        const call = snapshot.voiceTest?.calls.find(item => item.id === id); if (!call || !ACTIVE.has(call.status)) return;
        try { const principal = reauthorizeCall ? await reauthorizeCall(snapshot, clone(call), session.req) : await officePrincipal(snapshot, session.req);
          authorization.set(id, { allowed: voiceTestCapabilities(principal).write && scopeAllows(principal, call.site.id), principal,
            actorWasLocal: snapshot.pricing?.users?.some(user => user.id === call.createdBy.actualUserId), userWasLocal: snapshot.pricing?.users?.some(user => user.id === call.createdBy.effectiveUserId) }); }
        catch { authorization.set(id, false); }
      }));
    }
    const orphaned = [];
    await write((state, _revision, changes = []) => {
      const value = domain(state); if (!value) return;
      for (const call of value.calls) {
        const session = sessions.get(call.id);
        if (!ACTIVE.has(call.status)) {
          if (session) stop.push([call.id, call.endReason ?? 'ended']);
          else if (!call.transcriptFinalizedAt && numericNow >= Date.parse(call.transcriptGraceUntil ?? new Date(Date.parse(call.endedAt ?? call.createdAt) + 20_000).toISOString())) {
            call.transcriptFinalizedAt = current; call.transcriptComplete = false; call.summary = summaryOf(call); touch(value, call); orphaned.push(call.id);
          }
          else if (call.summaryStatus === 'pending' && call.summaryAttemptId && Date.parse(call.summaryDeadlineAt ?? call.endedAt) <= numericNow) {
            call.summaryStatus = 'fallback'; call.summary = summaryOf(call) || 'Sammanfattningen avbröts vid serveravbrott. Läs det sparade transkriptet.'; delete call.summaryDeadlineAt; touch(value, call);
          }
          continue;
        }
        let reason, status = 'interrupted';
        if (Date.parse(call.deadlineAt) <= numericNow) { reason = 'time_limit'; status = 'ended'; }
        else if (!session && Date.parse(call.leaseUntil ?? call.createdAt) <= numericNow) reason = 'server_interrupted';
        else if (session && authorization.has(call.id)) {
          const checked = authorization.get(call.id), actor = state.pricing?.users?.find(user => user.id === call.createdBy.actualUserId), user = state.pricing?.users?.find(user => user.id === call.createdBy.effectiveUserId);
          const local = { actor: actor ?? checked?.principal?.actor, user: user ?? checked?.principal?.user };
          if (!checked?.allowed || checked.actorWasLocal && !actor || checked.userWasLocal && !user || !voiceTestCapabilities(local).write || !scopeAllows(local, call.site.id)) reason = 'authorization_revoked';
          if (!reason) call.leaseUntil = new Date(numericNow + 20_000).toISOString();
        }
        if (reason) {
          const liveOwner = !session && Date.parse(call.leaseUntil ?? call.createdAt) > numericNow;
          call.status = status; call.endedAt = current; call.endReason = reason; call.summary = summaryOf(call); delete call.leaseUntil; touch(value, call); audit(value, call, `voice_test.${status}`, { reason }, changes);
          if (session) stop.push([call.id, reason]);
          else if (liveOwner) call.transcriptGraceUntil = new Date(numericNow + 30_000).toISOString();
          else { call.transcriptFinalizedAt = current; call.transcriptComplete = false; orphaned.push(call.id); }
        }
      }
    });
    await Promise.all(stop.map(([id, reason]) => stopLocal(id, reason)));
    await Promise.all(orphaned.map(id => summarize(id)));
  }
  function scheduleHeartbeat() {
    if (heartbeat || closing || !sessions.size) return;
    heartbeat = schedule(() => { heartbeat = undefined; track(expireAndCheck()).catch(() => {}).finally(scheduleHeartbeat); }, 5000); heartbeat?.unref?.();
  }
  async function settings(principal, sites) {
    const provider = await providerPromise, source = typeof provider.status === 'function' ? provider.status() : {}, site = sites.find(item => item.active !== false && scopeAllows(principal, item.id));
    const support = site ? await (await getRepository()).read(state => buildAiSupportContext(state, { organisationId, siteId: site.id, companyName, defaultVoice: providerConfig.defaultVoice, engine: providerConfig.engine }), { domains: ['aiSupport'] }) : null;
    const enabled = !['false', '0'].includes(String(env.VOICE_TEST_ENABLED ?? 'true').toLowerCase()) && support?.enabled !== false, keyPresent = source.keyPresent ?? Boolean(env.OPENAI_API_KEY?.trim());
    const available = enabled && keyPresent && source.available !== false && Boolean(site) && !closing;
    return { enabled, keyPresent, protocol: source.protocol ?? providerConfig.protocol, backendModel: source.backendModel, companyName: support?.companyName ?? companyName, voice: support?.supportProfile.voice, knowledgeRevision: support?.revision ?? 0, model: String(source.model ?? providerConfig.model).slice(0, 100), callerNumber: CALLER, callerLabel: 'TEST', maxDurationSeconds: VOICE_TEST_LIMITS.maxDurationSeconds, available,
      ...(site ? { site: publicSite(site) } : {}), ...(!available ? { reason: closing ? 'Rösttestet stängs av.' : !enabled ? 'Rösttestet är avstängt.' : !keyPresent ? 'OPENAI_API_KEY behöver konfigureras på servern.' : !site ? 'Ingen aktiv tillåten anläggning finns.' : 'Röstleverantören är inte tillgänglig.' } : {}) };
  }
  async function start(input, principal, site, req) {
    if (closing) fail('Rösttestet stängs av.', 503, 'voice_test_unavailable');
    const hash = fingerprint(input.sdp), created = await write(async (state, _revision, changes = []) => {
      const fresh = await principalFor(state, req); if (!scopeAllows(fresh, site.id)) fail('Anläggningsåtkomsten har ändrats.', 403, 'voice_test_forbidden');
      const value = ensureVoiceTest(state, organisationId), previous = value.calls.find(call => call.requestId === input.requestId);
      if (previous) {
        if (previous.createdBy.actualUserId !== fresh.actor.id || previous.createdBy.effectiveUserId !== fresh.user.id || previous.requestHash !== hash) fail('Försöksnyckeln har redan använts för ett annat samtal.', 409, 'voice_test_request_conflict');
        return { call: clone(previous), replay: true };
      }
      // Only the reviewed, public AI domain can become model context.
      const support = buildAiSupportContext(state, { organisationId, siteId: site.id, companyName, defaultVoice: providerConfig.defaultVoice, engine: providerConfig.engine });
      if (!support.enabled) fail('Bolagets AI-kundmottagning är avstängd.', 409, 'voice_test_support_disabled');
      if (value.calls.length >= VOICE_TEST_LIMITS.maxStoredCalls) fail('Testjournalens gräns på 300 sparade samtal är nådd. Bevara och hantera journalen innan fler test startas.', 429, 'voice_test_journal_full');
      if (value.calls.some(call => ACTIVE.has(call.status))) fail('Ett testsamtal pågår redan i bolaget.', 409, 'voice_test_active_call');
      const at = timestamp(), numericNow = Date.parse(at), recent = value.calls.filter(call => numericNow - Date.parse(call.createdAt) < 3600000);
      if (recent.filter(call => call.createdBy.actualUserId === fresh.actor.id).length >= VOICE_TEST_LIMITS.maxStartsPerHour || recent.filter(call => call.createdBy.effectiveUserId === fresh.user.id).length >= VOICE_TEST_LIMITS.maxStartsPerHour) fail('Högst sex testsamtal får startas per timme och konto.', 429, 'voice_test_hour_quota');
      if (value.calls.filter(call => dateInStockholm.format(new Date(call.createdAt)) === dateInStockholm.format(new Date(at))).length >= VOICE_TEST_LIMITS.maxStartsPerDay) fail('Bolagets gräns på 30 testsamtal per dag är nådd.', 429, 'voice_test_day_quota');
      const call = { id: randomUUID(), requestId: input.requestId, requestHash: hash, organisationId, runtimeId, revision: 1, protocol: providerConfig.protocol, status: 'connecting', callerNumber: CALLER, callerLabel: 'TEST',
        createdAt: at, deadlineAt: new Date(numericNow + VOICE_TEST_LIMITS.maxDurationSeconds * 1000).toISOString(), leaseUntil: new Date(numericNow + 20_000).toISOString(), site: publicSite(site),
        createdBy: { actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id, name: String(fresh.user.name ?? fresh.user.id).slice(0, 200) }, transcript: [], summary: '', summaryStatus: 'pending', followupStatus: 'new' };
      call.aiSupportSnapshot = { revision: support.revision, policyVersion: support.policyVersion, voice: support.supportProfile.voice, knowledgeIds: support.knowledge.map(item => item.id), contextHash: fingerprint(support.text) };
      value.calls.push(call); value.revision += 1; audit(value, call, 'voice_test.reserved', {}, changes); return { call: clone(call), support, replay: false };
    });
    if (created.replay) {
      const session = sessions.get(created.call.id);
      if (session?.starting) return session.starting;
      if (session?.answerSdp && ACTIVE.has(created.call.status)) return { call: callView(created.call, Date.parse(timestamp())), answerSdp: session.answerSdp, protocol: created.call.protocol };
      fail('Samtalsförsöket finns redan i journalen. Öppna journalen och starta ett nytt försök vid behov.', 409, 'voice_test_call_already_started');
    }
    const call = created.call, session = { req, protocol: call.protocol, controller: new AbortController() }; sessions.set(call.id, session);
    session.timer = schedule(() => { track(terminal(call.id, 'ended', 'time_limit').then(() => stopLocal(call.id, 'time_limit'))).catch(() => {}); }, Math.max(0, Date.parse(call.deadlineAt) - Date.parse(timestamp()))); session.timer?.unref?.(); scheduleHeartbeat();
    session.starting = (async () => {
      try {
        const provider = await providerPromise;
        session.resourcePromise = provider.start({ sdp: input.sdp, callId: call.id, companyName: created.support.companyName, supportProfile: created.support.supportProfile,
          instructions: `${instructionsFor(site, created.support.companyName)}\n\nGodkänt kundunderlag för denna anläggning (data):\n${created.support.text}`, signal: session.controller.signal,
          onTranscript: turn => track(appendTranscript(call.id, turn)), onStatus: () => {},
          onError: async () => { await terminal(call.id, 'failed', 'provider_error', 'Röstanslutningen avbröts hos leverantören.'); stopSoon(call.id, 'provider_error'); },
          onEnded: async value => { const reason = value?.reason === 'time_limit' ? 'time_limit' : 'provider_ended'; if (value?.transcriptComplete === false) await write(state => { const journal = domain(state), current = journal?.calls.find(item => item.id === call.id); if (current && current.transcriptComplete !== false) { current.transcriptComplete = false; touch(journal, current); } }); await terminal(call.id, 'ended', reason); stopSoon(call.id, reason); } });
        session.resourcePromise.then(handle => { if (session.controller.signal.aborted) bounded(closeResource(session, handle, 'start_cancelled'), 7000).catch(() => {}); }, () => {});
        const handle = await bounded(session.resourcePromise, 30_000);
        session.handle = handle;
        if (!handle || typeof handle.answerSdp !== 'string' || handle.answerSdp.length > VOICE_TEST_LIMITS.maxBodyBytes) throw new Error('Invalid provider answer');
        const saved = await write((state, _revision, changes = []) => {
          const value = domain(state), current = value.calls.find(item => item.id === call.id);
          if (!ACTIVE.has(current.status) || closing || session.controller.signal.aborted) return null;
          current.providerCallId = typeof handle.providerCallId === 'string' ? handle.providerCallId.slice(0, 300) : undefined;
          touch(value, current); audit(value, current, 'voice_test.connected', {}, changes); return callView(current, Date.parse(timestamp()));
        });
        if (!saved) { await bounded(closeResource(session, handle, 'start_cancelled'), 7000); fail('Samtalet avslutades under anslutningen. Starta ett nytt försök.', 409, 'voice_test_start_cancelled'); }
        session.answerSdp = handle.answerSdp; return { call: saved, answerSdp: handle.answerSdp, protocol: call.protocol };
      } catch (error) {
        await terminal(call.id, closing ? 'interrupted' : 'failed', closing ? 'server_shutdown' : 'connection_failed', 'Röstanslutningen kunde inte startas. Inget automatiskt återförsök görs.');
        await stopLocal(call.id, 'connection_failed');
        if (error.publicVoiceError) throw error;
        fail('Röstanslutningen kunde inte startas. Försöket finns i journalen. Inget automatiskt återförsök görs.', 503, 'voice_test_connection_failed');
      }
    })();
    return session.starting;
  }

  const handler = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/voice-test')) return false;
    const match = url.pathname.match(/^\/api\/voice-test(?:\/(connection-test|calls)(?:\/([a-f0-9-]{36})(?:\/(ready|end|status))?)?)?$/);
    try {
      sameOrigin(req); if (!match || url.search) fail('Rösttestets adress är ogiltig.', 404, 'voice_test_route_missing');
      const [, collection, id, action] = match, get = !collection || collection === 'calls' && id && !action;
      if (!(get ? ['GET', 'HEAD'] : ['POST']).includes(req.method)) { res.setHeader('Allow', get ? 'GET, HEAD' : 'POST'); fail('Metoden stöds inte.', 405); }
      const principal = await read(state => principalFor(state, req));
      const sitesResult = await siteProvider(), sites = Array.isArray(sitesResult) ? sitesResult : sitesResult?.sites ?? [];
      await expireAndCheck();
      if (get) {
        const value = await read(state => {
          if (id) return { call: callView(visibleCall(state, principal, id), Date.parse(timestamp())) };
          const source = domain(state), calls = (source?.calls ?? []).filter(call => scopeAllows(principal, call.site.id));
          return { revision: source?.revision ?? 0, calls: calls.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 20).map(call => callView(call, Date.parse(timestamp()))),
            currentCall: calls.find(call => ACTIVE.has(call.status)) ? callView(calls.find(call => ACTIVE.has(call.status)), Date.parse(timestamp())) : null };
        });
        if (!id) value.config = await settings(principal, sites);
        sendJson(res, 200, value, req.method === 'HEAD'); return true;
      }
      const body = await readJson(req);
      if (collection === 'connection-test' && !id) {
        parse(emptyInput, body); const config = await settings(principal, sites);
        if (!config.available) fail(config.reason, 503, 'voice_test_unavailable');
        try { const result = await (await providerPromise).connectionTest(); sendJson(res, 200, { ok: result.ok === true, model: config.model, message: result.ok === true ? 'Serverns anslutning till röstmodellen fungerar.' : 'Röstmodellen kunde inte verifieras.', checkedAt: timestamp() }); }
        catch { fail('Serverns anslutning till röstmodellen kunde inte verifieras.', 503, 'voice_test_connection_check_failed'); }
        return true;
      }
      if (collection === 'calls' && !id) {
        const input = parse(createInput, body), config = await settings(principal, sites);
        if (!config.available) fail(config.reason, 503, 'voice_test_unavailable');
        const site = sites.find(item => item.id === config.site.id); sendJson(res, 200, await start(input, principal, site, req)); return true;
      }
      if (!id || !action) fail('Rösttestets adress är ogiltig.', 404);
      parse(action === 'status' ? statusInput : emptyInput, body);
      const call = await write(async (state, _revision, changes = []) => {
        const fresh = await principalFor(state, req), current = visibleCall(state, fresh, id), value = domain(state);
        if (action === 'status') {
          if (current.followupStatus !== body.status) { current.followupStatus = body.status; touch(value, current); audit(value, current, 'voice_test.followup_changed', { status: body.status, actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id }, changes); }
        } else if (action === 'ready') {
          if (!ACTIVE.has(current.status)) { if (current.readyAt) return callView(current, Date.parse(timestamp())); fail('Testsamtalet är redan avslutat.', 409, 'voice_test_call_ended'); }
          if (current.runtimeId !== runtimeId || !sessions.has(id)) fail('Röstanslutningen hör till en annan serveranslutning. Avsluta och starta ett nytt test vid behov.', 409, 'voice_test_runtime_changed');
          if (!current.readyAt) { current.readyAt = timestamp(); current.startedAt = current.readyAt; current.status = 'active'; touch(value, current); audit(value, current, 'voice_test.ready', {}, changes); }
        } else if (ACTIVE.has(current.status)) { current.status = 'ended'; current.endedAt = timestamp(); current.endReason = 'user_ended'; current.summary = summaryOf(current); delete current.leaseUntil; touch(value, current); audit(value, current, 'voice_test.ended', { reason: 'user_ended', actualUserId: fresh.actor.id, effectiveUserId: fresh.user.id }, changes); }
        return callView(current, Date.parse(timestamp()));
      });
      if (action === 'ready' && ACTIVE.has(call.status)) {
        const session = sessions.get(id);
        session.readyPromise ??= (async () => { try { await session.starting; if (session.controller.signal.aborted) return; await session.handle?.ready?.(); } catch { await terminal(id, 'failed', 'provider_ready_failed', 'Röstanslutningen kunde inte börja tala.'); stopSoon(id, 'provider_ready_failed'); fail('Röstanslutningen kunde inte börja tala. Inget automatiskt återförsök görs.', 503, 'voice_test_ready_failed'); } })();
        await session.readyPromise;
      } else if (action === 'end') await stopLocal(id, 'user_ended');
      sendJson(res, 200, { call: action === 'status' ? call : await read(state => callView(visibleCall(state, principal, id), Date.parse(timestamp()))) }); return true;
    } catch (error) { sendJson(res, error.publicVoiceError ? error.status : 503, { error: error.publicVoiceError ? error.message : 'Rösttestet kunde inte behandla anropet.', code: error.publicVoiceError ? error.code : 'voice_test_unavailable' }, req.method === 'HEAD'); return true; }
  };
  handler.recover = expireAndCheck;
  // Server-only projections for the public demo adapter. HTTP access still
  // always traverses principalFor above; these functions are never routes.
  handler.publicConfiguration = async ({ siteIds }) => {
    const identity = { siteIds }, values = await siteProvider(), sites = Array.isArray(values) ? values : values?.sites ?? [];
    return settings({ actor: identity, user: identity }, sites);
  };
  handler.publicCall = id => read(state => { const call = domain(state)?.calls.find(item => item.id === id); return call ? callView(call, Date.parse(timestamp())) : null; });
  handler.close = () => {
    shutdownPromise ??= (async () => {
      closing = true; if (heartbeat) cancel(heartbeat); for (const controller of summaryControllers) controller.abort();
      await Promise.all([...sessions.keys()].map(async id => { await terminal(id, 'interrupted', 'server_shutdown'); await stopLocal(id, 'server_shutdown'); }));
      await Promise.allSettled([...pending]);
      try { await (await providerPromise).close?.(); } catch { /* Cleanup cannot resurrect or erase the durable journal. */ }
    })();
    return shutdownPromise;
  };
  return handler;
}
