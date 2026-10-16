import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createTestCar } from './testcar-model.mjs';

const COOKIE = 'scrappilot_testcar';
const bodyLimit = 2048;
const minute = 60000;
const error = (message, status, code) => Object.assign(new Error(message), { status, code });
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(data));
};
function originGuard(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw error('Öppna testbilen på samma webbplats.', 403, 'testcar_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const scheme = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== scheme) throw new Error();
  } catch { throw error('Öppna testbilen på samma webbplats.', 403, 'testcar_origin_forbidden'); }
}
function cookieToken(req) {
  const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
  const value = cookie?.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value ?? '') ? value : undefined;
}
function equalToken(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    req.resume(); throw error('Skicka kommandot som JSON.', 415, 'testcar_json_required');
  }
  if (Number(req.headers['content-length'] ?? 0) > bodyLimit) {
    req.resume(); throw error('Kommandot är för stort.', 413, 'testcar_body_too_large');
  }
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const timer = setTimeout(() => finish(error('Kommandot tog för lång tid.', 408, 'testcar_body_timeout')), 10000);
    timer.unref();
    function finish(failure, value) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (failure) { req.resume(); reject(failure); } else resolve(value);
    }
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > bodyLimit) finish(error('Kommandot är för stort.', 413, 'testcar_body_too_large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(error('Kommandot kunde inte läsas.', 400, 'testcar_json_invalid')); }
    });
    req.on('error', () => finish(error('Anslutningen avbröts.', 400, 'testcar_request_aborted')));
    req.on('aborted', () => finish(error('Anslutningen avbröts.', 400, 'testcar_request_aborted')));
  });
}

function bucket(capacity, periodMs, now) {
  let tokens = capacity, last = now();
  return () => {
    const time = now(); tokens = Math.min(capacity, tokens + Math.max(0, time - last) * capacity / periodMs); last = time;
    if (tokens < 1) throw error('För många anrop. Vänta ett ögonblick och försök igen.', 429, 'testcar_rate_limited');
    tokens -= 1;
  };
}

/** Public, fictional laboratory. Its only capability is an ephemeral synthetic
 * car belonging to a random browser session. No tenant service, database,
 * vehicle registry, real device credentials or external integration is imported.
 * Memory and CPU budgets are fixed; production telemetry remains a separate task.
 */
export function createTestCarApi({ env = process.env, now = Date.now, factory = createTestCar,
  maxSessions = 32, idleMs = 30 * minute, lifetimeMs = 120 * minute, maxRunMs = 20 * minute,
  intervalMs = 1000, autoTick = true } = {}) {
  const sessions = new Map();
  const creationBudget = bucket(32, 5 * minute, now), trafficBudget = bucket(200, 2000, now);
  let stopped = false;
  function prune() {
    const time = now();
    for (const [token, session] of sessions) if (time - session.touched >= idleMs || time - session.created >= lifetimeMs)
      sessions.delete(token);
  }
  function cookie(req, token) {
    const secure = env.RENDER || req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
    return `${COOKIE}=${token}; Path=/api/testcar; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetimeMs / 1000)}${secure ? '; Secure' : ''}`;
  }
  function tick() {
    if (stopped) return;
    prune(); const time = now();
    for (const session of sessions.values()) {
      const elapsed = Math.min(2, Math.max(0, time - session.lastTick) / 1000); session.lastTick = time;
      try {
        const state = session.car.snapshot();
        if (!state.engineOn) continue;
        if (time - session.runningSince >= maxRunMs) {
          session.car.command({ action: 'stop' }); session.runningSince = null;
        } else if (elapsed > 0) session.car.tick(elapsed);
      } catch {
        // A broken synthetic session must not interrupt the main HTTP server.
        sessions.delete(session.token);
      }
    }
  }
  const timer = autoTick ? setInterval(tick, intervalMs) : undefined;
  timer?.unref();
  const api = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/testcar/')) return false;
    try {
      if (stopped) throw error('Testbilen startas om. Försök snart igen.', 503, 'testcar_stopped');
      originGuard(req); trafficBudget(); prune();
      const routes = { '/api/testcar/session': 'GET', '/api/testcar/state': 'GET', '/api/testcar/command': 'POST' };
      const method = routes[url.pathname];
      if (!method) throw error('Testsidan finns inte.', 404, 'testcar_not_found');
      if (req.method !== method) { res.setHeader('Allow', method); throw error('Metoden stöds inte.', 405, 'testcar_method_not_allowed'); }
      let token = cookieToken(req), session = token && sessions.get(token);
      if (url.pathname === '/api/testcar/session') {
        if (!session) {
          creationBudget();
          if (sessions.size >= maxSessions) throw error('Alla testbilar används just nu. Försök igen om en stund.', 429, 'testcar_capacity');
          token = randomBytes(32).toString('hex'); const time = now();
          session = { token, csrfToken: randomBytes(32).toString('hex'), car: factory(),
            created: time, touched: time, lastTick: time, runningSince: null,
            commandBudget: bucket(12, 6000, now), readBudget: bucket(12, 3000, now) };
          sessions.set(token, session);
        }
        session.readBudget(); session.touched = now(); res.setHeader('Set-Cookie', cookie(req, token));
        json(res, 200, { csrfToken: session.csrfToken, car: session.car.snapshot() }); return true;
      }
      if (!session) throw error('Testsessionen har avslutats. Öppna en ny testbil.', 401, 'testcar_session_expired');
      if (url.pathname === '/api/testcar/command') {
        if (!equalToken(req.headers['x-testcar-csrf'], session.csrfToken))
          throw error('Testsessionen kunde inte verifieras. Ladda om sidan.', 403, 'testcar_csrf_invalid');
        session.commandBudget();
        const value = await readBody(req);
        // A slow body must not revive an expired/evicted session.
        if (sessions.get(token) !== session || now() - session.touched >= idleMs || now() - session.created >= lifetimeMs)
          throw error('Testsessionen har avslutats. Öppna en ny testbil.', 401, 'testcar_session_expired');
        const previouslyOn = session.car.snapshot().engineOn;
        session.car.command(value);
        const on = session.car.snapshot().engineOn;
        if (on && !previouslyOn) { session.runningSince = now(); session.lastTick = now(); }
        else if (!on) session.runningSince = null;
      } else session.readBudget();
      session.touched = now(); json(res, 200, { car: session.car.snapshot() });
    } catch (failure) {
      const status = [400, 401, 403, 404, 405, 408, 409, 413, 415, 422, 429, 503].includes(failure.status) ? failure.status : 500;
      if (status === 429) res.setHeader('Retry-After', '10');
      req.resume();
      json(res, status, { error: status === 500 ? 'Testbilen kunde inte uppdateras. Försök igen.' : failure.message,
        code: status === 500 ? 'testcar_internal_error' : failure.code });
    }
    return true;
  };
  api.tick = tick;
  api.close = () => { stopped = true; clearInterval(timer); sessions.clear(); };
  return api;
}
