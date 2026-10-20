import { createHash } from 'node:crypto';
import { ScbCompanyRegisterError } from './scb-company-register.mjs';

const PREFIX = '/api/public/customer-intake';
const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => Object.assign(new Error('Länken till kunduppgifterna är ogiltig eller har gått ut. Be personalen skicka en ny länk.'),
  { status: 410, code: 'customer_intake_link_unavailable' });
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code, publicIntakeError: true }); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
};
export const PUBLIC_INTAKE_LIMITS = Object.freeze({ bodyBytes: 16384, requestsPerIpMinute: 240,
  requestsPerMinute: 6000, maxIpBuckets: 2000, maxActiveLinks: 20000 });

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'customer_intake_origin', 'Öppna länken från samma webbplats.');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail(403, 'customer_intake_origin', 'Öppna länken från samma webbplats.'); }
}
async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'customer_intake_content_type', 'Använd application/json.');
  if (Number(req.headers['content-length']) > PUBLIC_INTAKE_LIMITS.bodyBytes)
    fail(413, 'customer_intake_body_size', 'Förfrågan är för stor.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > PUBLIC_INTAKE_LIMITS.bodyBytes) fail(413, 'customer_intake_body_size', 'Förfrågan är för stor.');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(422, 'customer_intake_invalid_json', 'Förfrågan innehåller ogiltig JSON.'); }
}

/** Separate single-purpose capabilities route to the server-owned tenant.
 * Ambient cookies and supplied company headers cannot select a different store.
 * The tenant revalidates draft binding, expiry and state on every operation.
 */
export function createPublicCustomerIntake({ repository, openCompany, companyLookup, env = {}, now = () => Date.now() }) {
  let minute = -1, total = 0; const buckets = new Map();
  const milliseconds = () => {
    const value = Number(new Date(now())); if (!Number.isFinite(value)) throw new Error('Invalid approval clock'); return value;
  };
  function limit(req, res) {
    const current = Math.floor(milliseconds() / 60000);
    if (current !== minute) { minute = current; total = 0; buckets.clear(); }
    let address = String(req.socket?.remoteAddress ?? 'unknown');
    if (env.RENDER === 'true' && typeof req.headers['x-forwarded-for'] === 'string')
      address = req.headers['x-forwarded-for'].split(',').at(-1).trim() || address;
    const key = hash(address.slice(0, 100)), count = buckets.get(key) ?? 0;
    if (total >= PUBLIC_INTAKE_LIMITS.requestsPerMinute || count >= PUBLIC_INTAKE_LIMITS.requestsPerIpMinute
      || !buckets.has(key) && buckets.size >= PUBLIC_INTAKE_LIMITS.maxIpBuckets) {
      res.setHeader('Retry-After', '60');
      fail(429, 'customer_intake_request_limit', 'Många förfrågningar har gjorts. Vänta en minut och försök igen.');
    }
    total++; buckets.set(key, count + 1);
  }
  async function register(companyId, input) {
    if (!input || Object.keys(input).some(key => !['tokenHash', 'intakeId', 'expiresAt'].includes(key))
      || !/^[a-f0-9]{64}$/.test(input.tokenHash ?? '') || !/^[a-f0-9-]{36}$/.test(input.intakeId ?? '')
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= milliseconds())
      fail(422, 'customer_intake_link_invalid', 'Kundlänken kunde inte registreras.');
    return repository.transact(state => {
      const company = state.companies.find(value => value.id === companyId && value.status === 'active');
      if (!company) throw unavailable();
      const links = (state.customerIntakeLinks ?? []).filter(value => Date.parse(value.expiresAt) > milliseconds());
      const old = links.find(value => value.tokenHash === input.tokenHash);
      if (old) {
        if (old.companyId !== companyId || old.intakeId !== input.intakeId || old.expiresAt !== input.expiresAt)
          fail(409, 'customer_intake_link_conflict', 'Kundlänken kunde inte registreras.');
        return;
      }
      if (links.length >= PUBLIC_INTAKE_LIMITS.maxActiveLinks)
        fail(503, 'customer_intake_link_capacity', 'Kundlänkar kan inte skapas just nu. Försök igen senare.');
      state.customerIntakeLinks = [...links, { tokenHash: input.tokenHash, companyId,
        intakeId: input.intakeId, expiresAt: input.expiresAt }];
    });
  }
  async function handle(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      limit(req, res); sameOrigin(req);
      const read = req.method === 'GET' && url.pathname === PREFIX;
      const respond = req.method === 'POST' && url.pathname === `${PREFIX}/submit`;
      const lookup = req.method === 'POST' && url.pathname === `${PREFIX}/company-lookup`;
      if (!read && !respond && !lookup) fail(404, 'not_found', 'Kundformuläret finns inte.');
      // Tokens only travel in the authorization header, never query strings,
      // URLs, cookies or a staff-controlled company selector.
      if (url.search) throw unavailable();
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw unavailable();
      const body = respond || lookup ? await readBody(req) : undefined;
      const digest = hash(token);
      const resolveLink = () => repository.read(state => {
        const link = state.customerIntakeLinks?.find(value => value.tokenHash === digest && Date.parse(value.expiresAt) > milliseconds());
        const company = link && state.companies.find(value => value.id === link.companyId && value.status === 'active');
        return company && link ? { company: structuredClone(company), intakeId: link.intakeId } : undefined;
      });
      const selected = await resolveLink();
      if (!selected) throw unavailable();
      const service = await openCompany(selected.company);
      if (lookup) {
        if (typeof companyLookup !== 'function') fail(503, 'company_lookup_unavailable', 'Företagsuppslaget är inte tillgängligt. Fyll i uppgifterna manuellt.');
        const validateIntake = value => {
          if (value?.intake?.id !== selected.intakeId || value.intake.status !== 'waiting'
            || !Number.isFinite(Date.parse(value.intake.expiresAt)) || Date.parse(value.intake.expiresAt) <= milliseconds()) throw unavailable();
        };
        validateIntake(await service.customerIntakeService.publicRead(token));
        // No application or platform transaction is held during network work.
        const company = await companyLookup(body, { rateKey: `intake:${selected.company.id}:${selected.intakeId}`, signal: controller.signal });
        const current = await resolveLink();
        if (!current || current.company.id !== selected.company.id || current.intakeId !== selected.intakeId) throw unavailable();
        validateIntake(await service.customerIntakeService.publicRead(token));
        if (!controller.signal.aborted) json(res, 200, { company });
        return true;
      }
      const value = read ? await service.customerIntakeService.publicRead(token)
        : await service.customerIntakeService.submit(token, body);
      if (!value?.intake || value.intake.id !== selected.intakeId) throw unavailable();
      json(res, 200, value);
    } catch (error) {
      const known = error instanceof ScbCompanyRegisterError || Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      if (!controller.signal.aborted) json(res, known ? error.status : 503, { error: known ? error.message : 'Kundformuläret kunde inte nås. Försök igen om en stund.',
        code: known ? error.code ?? 'customer_intake_unavailable' : 'customer_intake_unavailable' });
    } finally { req.off('aborted', abort); res.off('close', abort); }
    return true;
  }
  return Object.freeze({ register, handle });
}
