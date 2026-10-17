import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createVoiceTestApi, ensureVoiceTest, VOICE_TEST_LIMITS } from './voice-test.mjs';

export const PUBLIC_VOICE_LIMITS = Object.freeze({ sessionSeconds: 900, startsPerSession: 2, startsPerIpHour: 2, startsPerIpDay: 4,
  startsPerHour: 10, startsPerDay: 30, sessionsPerIpHour: 6, sessionsPerHour: 100, maxSessions: 200,
  requestsPerMinute: 90, requestsPerMinuteGlobal: 300, maxIpBuckets: 1000 });
const PREFIX = '/api/public/voice-test', COOKIE = 'scrappilot_voice_demo', BINDINGS = new WeakMap();
const ACTIVE = new Set(['connecting', 'active']);
const hash = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);
const fail = (message, status = 422, code = 'voice_demo_invalid') => { throw Object.assign(new Error(message), { status, code, publicVoiceError: true }); };
const startSchema = z.object({ requestId: z.string().min(8).max(120).regex(/^[a-zA-Z0-9_-]+$/),
  sdp: z.string().min(20).max(240 * 1024).refine(value => /^v=0\r?\n/.test(value) && /(?:^|\n)m=audio\s/.test(value)) }).strict();
const emptySchema = z.object({}).strict();
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail('Förfrågan innehåller ogiltiga eller okända uppgifter.'); return result.data; };
const json = (res, status, value, head = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? undefined : JSON.stringify(value));
};
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Öppna rösttestet från samma webbplats.', 403, 'voice_demo_origin_forbidden');
  if (!req.headers.origin) return;
  try { const origin = new URL(req.headers.origin), protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Öppna rösttestet från samma webbplats.', 403, 'voice_demo_origin_forbidden'); }
}
async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fail('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > VOICE_TEST_LIMITS.maxBodyBytes) fail('Ljudförfrågan är för stor.', 413);
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > VOICE_TEST_LIMITS.maxBodyBytes) fail('Ljudförfrågan är för stor.', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Förfrågan innehåller ogiltig JSON.'); }
}
function publicCall(call) {
  if (!call) return null;
  const result = copy(Object.fromEntries(['id', 'requestId', 'revision', 'status', 'protocol', 'createdAt', 'startedAt', 'endedAt', 'durationSeconds', 'transcriptComplete', 'endReason']
    .filter(key => call[key] !== undefined).map(key => [key, call[key]])));
  result.transcript = (call.transcript ?? []).map(turn => ({ id: hash(String(turn.id)).slice(0, 24), role: turn.role, text: turn.text, at: turn.at, ...(turn.interrupted === true ? { interrupted: true } : {}) }));
  return result;
}
function captureResponse() {
  return { status: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.value = value ? JSON.parse(String(value)) : undefined; } };
}

/** A separate browser capability, never an ERP identity. Its only privilege is
 * the current anonymous test conversation on the server-selected JEROC demo. */
export function createPublicVoiceTestApi({ getRepository, siteProvider = async () => [], env = {}, provider, companyName = 'JEROC', now = () => new Date(), ...coreOptions } = {}) {
  const enabledTenant = env.SCRAPPILOT_ORGANISATION_ID === 'jeroc-demo';
  let closing = false, requestWindow = 0, requestCount = 0; const requestBuckets = new Map();
  const milliseconds = () => { const value = new Date(now()).getTime(); if (!Number.isFinite(value)) throw new Error('Invalid clock'); return value; };
  const mutate = async operation => (await getRepository()).transact(operation);
  const read = async operation => (await getRepository()).read(operation, { domains: ['voiceTest'] });
  const cookieHash = req => { const match = /(?:^|;\s*)scrappilot_voice_demo=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? ''); return match ? hash(match[1]) : null; };
  const ipOf = req => {
    // Render supplies a trusted final proxy hop. Earlier forwarded values are
    // client-controlled and must not be usable to rotate the IP quota.
    const direct = req.socket?.remoteAddress ?? 'unknown';
    if (env.RENDER === 'true' && typeof req.headers['x-forwarded-for'] === 'string') return req.headers['x-forwarded-for'].split(',').at(-1).trim().slice(0, 100) || direct;
    return String(direct).slice(0, 100);
  };
  const digestIp = (demo, req) => createHmac('sha256', demo.secret).update(ipOf(req)).digest('hex');
  function requestLimit(req, res) {
    const at = milliseconds();
    if (at - requestWindow >= 60_000 || at < requestWindow) { requestWindow = at; requestCount = 0; requestBuckets.clear(); }
    const ip = ipOf(req), count = requestBuckets.get(ip) ?? 0;
    if (requestCount >= PUBLIC_VOICE_LIMITS.requestsPerMinuteGlobal || count >= PUBLIC_VOICE_LIMITS.requestsPerMinute || !requestBuckets.has(ip) && requestBuckets.size >= PUBLIC_VOICE_LIMITS.maxIpBuckets) {
      res.setHeader('Retry-After', '60'); fail('Många förfrågningar har gjorts. Vänta en minut och försök igen.', 429, 'voice_demo_request_limit');
    }
    requestCount++; requestBuckets.set(ip, count + 1);
  }
  const csrfFor = (demo, session) => createHmac('sha256', demo.secret).update(`csrf:${session.hash}`).digest('base64url');
  function demoOf(state) {
    const journal = ensureVoiceTest(state, 'jeroc-demo');
    journal.publicDemo ??= { version: 1, secret: randomBytes(32).toString('base64url'), sessions: [], mints: [], starts: [] };
    return journal.publicDemo;
  }
  function clean(demo, numericNow) {
    demo.sessions = demo.sessions.filter(session => session.expiresAt > numericNow);
    demo.mints = demo.mints.filter(event => numericNow - event.at < 3600000);
    demo.starts = demo.starts.filter(event => numericNow - event.at < 86400000);
  }
  function currentSession(state, req) {
    const key = cookieHash(req), session = state.voiceTest?.publicDemo?.sessions.find(item => item.hash === key);
    if (!key || !session || session.expiresAt <= milliseconds() || closing) fail('Din testsession har löpt ut. Ladda om sidan för att prova igen.', 401, 'voice_demo_session_expired');
    return session;
  }
  const selectedSites = async () => {
    const values = await siteProvider(), sites = Array.isArray(values) ? values : values?.sites ?? [], site = sites.find(item => item.active !== false);
    return site ? [{ id: site.id, name: String(site.name).slice(0, 200), active: true }] : [];
  };
  const principalFor = async (state, req) => {
    const bound = BINDINGS.get(req), session = currentSession(state, req);
    if (!bound || bound.sessionHash !== session.hash) fail('Testsamtalet är inte tillgängligt.', 403, 'voice_demo_forbidden');
    const identity = { id: `voice-demo:${session.hash}`, name: 'Publikt testsamtal', level: 'VD', active: true, siteIds: bound.siteIds };
    return { actor: identity, user: identity };
  };
  const core = createVoiceTestApi({ ...coreOptions, env, getRepository, officePrincipal: principalFor, reauthorizeCall: (state, _call, req) => principalFor(state, req),
    siteProvider: selectedSites, provider, companyName, now });

  async function bootstrap(req, res) {
    const key = cookieHash(req);
    if (key) {
      const cached = await read(state => state.voiceTest?.publicDemo?.sessions.find(item => item.hash === key));
      if (cached?.expiresAt > milliseconds()) return copy(cached);
    }
    let raw;
    const session = await mutate(state => {
      const demo = demoOf(state), at = milliseconds(); clean(demo, at);
      const key = cookieHash(req), previous = demo.sessions.find(item => item.hash === key);
      if (previous) return copy(previous);
      const ip = digestIp(demo, req);
      if (demo.sessions.length >= PUBLIC_VOICE_LIMITS.maxSessions || demo.mints.length >= PUBLIC_VOICE_LIMITS.sessionsPerHour || demo.mints.filter(item => item.ip === ip).length >= PUBLIC_VOICE_LIMITS.sessionsPerIpHour)
        fail('Flera test har startats nyligen. Vänta en stund och försök igen.', 429, 'voice_demo_session_limit');
      raw = randomBytes(32).toString('base64url');
      const next = { hash: hash(raw), expiresAt: at + PUBLIC_VOICE_LIMITS.sessionSeconds * 1000, starts: 0 };
      demo.sessions.push(next); demo.mints.push({ ip, at }); return copy(next);
    });
    if (raw) res.setHeader('Set-Cookie', `${COOKIE}=${raw}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${PUBLIC_VOICE_LIMITS.sessionSeconds}${req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
    return session;
  }
  async function bind(req, session) {
    const sites = await selectedSites(); BINDINGS.set(req, { sessionHash: session.hash, siteIds: sites.map(site => site.id) });
    // Newly minted cookies are only on the response until the browser's next
    // request. Bootstrap invokes core with an already verified binding below.
    return sites;
  }
  async function ownedCall(req, id) {
    return read(state => { const session = currentSession(state, req), call = state.voiceTest?.calls.find(item => item.id === id);
      if (!call || call.createdBy?.actualUserId !== `voice-demo:${session.hash}` || call.requestId !== session.currentRequestId) fail('Testsamtalet finns inte i din session.', 404, 'voice_demo_call_missing');
      return copy(call);
    });
  }
  async function invoke(req, pathname, body) {
    const response = captureResponse();
    const forwarded = body === undefined ? req : Object.assign(Object.create(req), { headers: { ...req.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } });
    if (forwarded !== req) BINDINGS.set(forwarded, BINDINGS.get(req));
    await core(forwarded, response, new URL(`http://localhost/api/voice-test${pathname}`));
    if (response.status >= 400) {
      const safeCodes = new Set(['voice_test_active_call', 'voice_test_hour_quota', 'voice_test_day_quota', 'voice_test_journal_full', 'voice_test_request_conflict', 'voice_test_call_already_started', 'voice_test_call_ended', 'voice_test_start_cancelled']);
      const source = response.value ?? {};
      fail(safeCodes.has(source.code) ? source.error : response.status === 503 ? 'Rösttestet är inte tillgängligt just nu. Försök igen senare.' : 'Testsamtalet kunde inte behandlas. Ladda om sidan och försök igen.', response.status, source.code === 'voice_test_unavailable' ? 'voice_demo_unavailable' : source.code ?? 'voice_demo_unavailable');
    }
    return response.value;
  }
  async function reserve(req, input) {
    await mutate(state => {
      const demo = demoOf(state), at = milliseconds(); clean(demo, at); const session = currentSession(state, req), ip = digestIp(demo, req), signature = hash(input.sdp);
      if (session.currentRequestId === input.requestId) { if (session.requestHash !== signature) fail('Samma försök kan inte ändras.', 409, 'voice_demo_request_conflict'); return; }
      const existing = state.voiceTest.calls.find(call => call.requestId === session.currentRequestId && call.createdBy?.actualUserId === `voice-demo:${session.hash}`);
      if (session.startingUntil > at || existing && ACTIVE.has(existing.status)) fail('Ditt testsamtal pågår redan.', 409, 'voice_demo_active_call');
      if (state.voiceTest.calls.some(call => ACTIVE.has(call.status))) fail('Ett annat testsamtal pågår. Försök igen om en stund.', 409, 'voice_demo_busy');
      const recent = demo.starts.filter(event => at - event.at < 3600000);
      if (session.starts >= PUBLIC_VOICE_LIMITS.startsPerSession || recent.filter(event => event.ip === ip).length >= PUBLIC_VOICE_LIMITS.startsPerIpHour || demo.starts.filter(event => event.ip === ip).length >= PUBLIC_VOICE_LIMITS.startsPerIpDay || recent.length >= PUBLIC_VOICE_LIMITS.startsPerHour || demo.starts.length >= PUBLIC_VOICE_LIMITS.startsPerDay)
        fail('Gränsen för kostnadsfria testsamtal är nådd. Försök igen senare.', 429, 'voice_demo_start_limit');
      session.starts += 1; session.currentRequestId = input.requestId; session.requestHash = signature; session.startingUntil = at + 35_000;
      demo.starts.push({ at, ip, sessionHash: session.hash, requestId: input.requestId });
    });
  }
  const handler = async (req, res, url) => {
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      if (!enabledTenant || closing) fail('Rösttestet är inte tillgängligt.', 404, 'voice_demo_unavailable');
      sameOrigin(req);
      requestLimit(req, res);
      const match = url.pathname.match(/^\/api\/public\/voice-test(?:\/(calls)(?:\/([a-f0-9-]{36})(?:\/(ready|end))?)?)?$/);
      if (!match || url.search) fail('Sidan finns inte.', 404, 'voice_demo_route_missing');
      const [, collection, id, action] = match, get = !collection || collection === 'calls' && id && !action;
      if (!(get ? ['GET', 'HEAD'] : ['POST']).includes(req.method)) fail('Metoden stöds inte.', 405, 'voice_demo_method_invalid');
      const session = !collection ? await bootstrap(req, res) : await read(state => copy(currentSession(state, req)));
      // bootstrap does not expose the raw capability; root configuration uses
      // only current public state and does not enter the authenticated core.
      const sites = await bind(req, session);
      if (!collection) {
        const state = await read(state => state), demo = state.voiceTest.publicDemo, call = state.voiceTest.calls.find(item => item.requestId === session.currentRequestId && item.createdBy?.actualUserId === `voice-demo:${session.hash}`);
        const source = await core.publicConfiguration({ siteIds: sites.map(site => site.id) });
        // Live's upstream allowlist rejects arbitrary client commands. The
        // authenticated legacy transport remains available only in the office.
        const available = source.available && source.protocol === 'live';
        const config = { companyName: source.companyName, protocol: source.protocol, voice: source.voice, maxDurationSeconds: source.maxDurationSeconds, available,
          ...(!available ? { reason: 'Rösttestet är inte tillgängligt just nu. Försök igen senare.' } : {}) };
        const projected = call ? await core.publicCall(call.id) : null;
        const current = await read(state => state.voiceTest?.publicDemo?.sessions.find(item => item.hash === session.hash));
        if (!current || current.expiresAt <= milliseconds()) fail('Din testsession har löpt ut. Ladda om sidan för att prova igen.', 401, 'voice_demo_session_expired');
        json(res, 200, { config, csrfToken: csrfFor(demo, session), calls: [], currentCall: current.currentRequestId === session.currentRequestId ? publicCall(projected) : null }, req.method === 'HEAD'); return true;
      }
      if (id) await ownedCall(req, id);
      if (get) { const result = await invoke(req, `/calls/${id}`); await ownedCall(req, id); json(res, 200, { call: publicCall(result.call) }, req.method === 'HEAD'); return true; }
      const csrf = await read(state => csrfFor(state.voiceTest.publicDemo, currentSession(state, req)));
      const providedCsrf = req.headers['x-voice-demo-csrf'];
      if (typeof providedCsrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(providedCsrf) || !timingSafeEqual(Buffer.from(providedCsrf), Buffer.from(csrf))) fail('Testsidan behöver laddas om före samtalet.', 403, 'voice_demo_csrf_required');
      const body = await readBody(req);
      if (!id) {
        const input = parse(startSchema, body), config = await core.publicConfiguration({ siteIds: sites.map(site => site.id) });
        if (!config.available || config.protocol !== 'live') fail('Rösttestet är inte tillgängligt just nu. Försök igen senare.', 503, 'voice_demo_unavailable');
        await core.recover();
        await reserve(req, input);
        try { const result = await invoke(req, '/calls', input); await ownedCall(req, result.call.id); json(res, 200, { call: publicCall(result.call), answerSdp: result.answerSdp, protocol: result.protocol }); }
        finally { await mutate(state => { const current = state.voiceTest?.publicDemo?.sessions.find(item => item.hash === session.hash); if (current?.currentRequestId === input.requestId) delete current.startingUntil; }); }
      } else { parse(emptySchema, body); const result = await invoke(req, `/calls/${id}/${action}`, body); await ownedCall(req, id); json(res, 200, { call: publicCall(result.call) }); }
      return true;
    } catch (error) { json(res, error.publicVoiceError ? error.status : 503, { error: error.publicVoiceError ? error.message : 'Rösttestet är inte tillgängligt just nu.', code: error.publicVoiceError ? error.code : 'voice_demo_unavailable' }, req.method === 'HEAD'); return true; }
  };
  handler.close = () => { closing = true; return core.close(); };
  handler.recover = core.recover;
  return handler;
}
