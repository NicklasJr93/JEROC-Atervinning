import { createHash } from 'node:crypto';

const PREFIX = '/api/public/customer-approval';
const hash = value => createHash('sha256').update(value).digest('hex');
const unavailable = () => Object.assign(new Error('Godkännandelänken är ogiltig eller har gått ut. Be personalen skicka en ny länk.'),
  { status: 410, code: 'customer_approval_link_unavailable' });
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code, publicApprovalError: true }); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
};
export const PUBLIC_APPROVAL_LIMITS = Object.freeze({ bodyBytes: 4096, requestsPerIpMinute: 240,
  requestsPerMinute: 6000, maxIpBuckets: 2000, maxActiveLinks: 20000 });

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'customer_approval_origin', 'Öppna länken från samma webbplats.');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail(403, 'customer_approval_origin', 'Öppna länken från samma webbplats.'); }
}
async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'customer_approval_content_type', 'Använd application/json.');
  if (Number(req.headers['content-length']) > PUBLIC_APPROVAL_LIMITS.bodyBytes)
    fail(413, 'customer_approval_body_size', 'Förfrågan är för stor.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > PUBLIC_APPROVAL_LIMITS.bodyBytes) fail(413, 'customer_approval_body_size', 'Förfrågan är för stor.');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(422, 'customer_approval_invalid_json', 'Förfrågan innehåller ogiltig JSON.'); }
}

/** Public bearer capabilities select their tenant through a server-owned hash
 * index. Ambient staff, partner or terminal cookies never select the company.
 * This index cannot approve a review; the scoped business store revalidates its
 * hash, current version, status and expiry for every read and customer action.
 */
export function createPublicCustomerApproval({ repository, openCompany, env = {}, now = () => Date.now() }) {
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
    if (total >= PUBLIC_APPROVAL_LIMITS.requestsPerMinute || count >= PUBLIC_APPROVAL_LIMITS.requestsPerIpMinute
      || !buckets.has(key) && buckets.size >= PUBLIC_APPROVAL_LIMITS.maxIpBuckets) {
      res.setHeader('Retry-After', '60');
      fail(429, 'customer_approval_request_limit', 'Många förfrågningar har gjorts. Vänta en minut och försök igen.');
    }
    total++; buckets.set(key, count + 1);
  }
  async function register(companyId, input) {
    if (!input || Object.keys(input).some(key => !['tokenHash', 'approvalId', 'expiresAt'].includes(key))
      || !/^[a-f0-9]{64}$/.test(input.tokenHash ?? '') || !/^[a-f0-9-]{36}$/.test(input.approvalId ?? '')
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= milliseconds())
      fail(422, 'customer_approval_link_invalid', 'Kundlänken kunde inte registreras.');
    return repository.transact(state => {
      const company = state.companies.find(value => value.id === companyId && value.status === 'active');
      if (!company) throw unavailable();
      const links = (state.customerApprovalLinks ?? []).filter(value => Date.parse(value.expiresAt) > milliseconds());
      const old = links.find(value => value.tokenHash === input.tokenHash);
      if (old) {
        if (old.companyId !== companyId || old.approvalId !== input.approvalId || old.expiresAt !== input.expiresAt)
          fail(409, 'customer_approval_link_conflict', 'Kundlänken kunde inte registreras.');
        return;
      }
      if (links.length >= PUBLIC_APPROVAL_LIMITS.maxActiveLinks)
        fail(503, 'customer_approval_link_capacity', 'Kundlänkar kan inte skapas just nu. Försök igen senare.');
      state.customerApprovalLinks = [...links, { tokenHash: input.tokenHash, companyId,
        approvalId: input.approvalId, expiresAt: input.expiresAt }];
    });
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    try {
      limit(req, res); sameOrigin(req);
      const read = req.method === 'GET' && url.pathname === PREFIX;
      const respond = req.method === 'POST' && url.pathname === `${PREFIX}/respond`;
      if (!read && !respond) fail(404, 'not_found', 'Godkännandevyn finns inte.');
      // Tokens only travel in the authorization header, never query strings,
      // URLs, cookies or a staff-controlled company selector.
      if (url.search) throw unavailable();
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw unavailable();
      const digest = hash(token), at = milliseconds();
      const selected = await repository.read(state => {
        const link = state.customerApprovalLinks?.find(value => value.tokenHash === digest && Date.parse(value.expiresAt) > at);
        const company = link && state.companies.find(value => value.id === link.companyId && value.status === 'active');
        return company && link ? { company: structuredClone(company), approvalId: link.approvalId } : undefined;
      });
      if (!selected) throw unavailable();
      const body = respond ? await readBody(req) : undefined;
      const service = await openCompany(selected.company);
      const value = read ? await service.terminalDemoApi.remoteRead(token)
        : await service.terminalDemoApi.remoteRespond(token, body);
      if (!value?.approval || value.approval.id !== selected.approvalId) throw unavailable();
      json(res, 200, value);
    } catch (error) {
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      json(res, known ? error.status : 503, { error: known ? error.message : 'Kundgodkännandet kunde inte nås. Försök igen om en stund.',
        code: known ? error.code ?? 'customer_approval_unavailable' : 'customer_approval_unavailable' });
    }
    return true;
  }
  return Object.freeze({ register, handle });
}
