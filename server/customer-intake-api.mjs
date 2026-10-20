const STAFF = '/api/employee/customer-intake';
const TERMINAL = '/api/terminal-demo/customer-intake';
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
};
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'customer_intake_origin', 'Öppna formuläret från samma webbplats.');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail(403, 'customer_intake_origin', 'Öppna formuläret från samma webbplats.'); }
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    fail(415, 'customer_intake_content_type', 'Använd application/json.');
  if (Number(req.headers['content-length']) > 16384) fail(413, 'customer_intake_body_size', 'Förfrågan är för stor.');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 16384) fail(413, 'customer_intake_body_size', 'Förfrågan är för stor.');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(422, 'customer_intake_invalid_json', 'Förfrågan innehåller ogiltig JSON.'); }
}

/** The gateway selects an immutable tenant before staff/device routes arrive.
 * The service rechecks its real principal and draft inside each transaction.
 * Public bearer routing is deliberately separate from this cookie adapter. */
export function createCustomerIntakeApi({ service, terminalAccess }) {
  return async (req, res, url) => {
    const staffRoute = url.pathname === STAFF || url.pathname.startsWith(`${STAFF}/`);
    const deviceRoute = url.pathname === TERMINAL || url.pathname.startsWith(`${TERMINAL}/`);
    if (!staffRoute && !deviceRoute) return false;
    try {
      sameOrigin(req);
      let result;
      if (staffRoute) {
        if (req.method === 'GET' && url.pathname === STAFF) {
          if ([...url.searchParams.keys()].some(key => key !== 'draftId') || url.searchParams.getAll('draftId').length !== 1)
            fail(422, 'customer_intake_invalid', 'Välj en pågående vägning.');
          result = await service.read({ draftId: url.searchParams.get('draftId') }, req);
        } else if (req.method === 'POST' && !url.search) {
          if (![STAFF, `${STAFF}/cancel`, `${STAFF}/apply`].includes(url.pathname))
            fail(404, 'not_found', 'Åtgärden finns inte.');
          const input = await body(req);
          result = url.pathname === STAFF ? await service.create(input, req)
            : url.pathname.endsWith('/cancel') ? await service.cancel(input, req) : await service.apply(input, req);
        } else fail(405, 'method_not_allowed', 'Metoden stöds inte.');
      } else {
        if (url.search) fail(422, 'customer_intake_invalid', 'Terminalen visar sitt eget kundformulär.');
        if (req.method === 'GET' && url.pathname === TERMINAL) {
          const device = await terminalAccess.authorizeIntakeDevice(req);
          result = await service.terminalRead(device);
        } else if (req.method === 'POST' && url.pathname === `${TERMINAL}/submit`) {
          const input = await body(req);
          const device = await terminalAccess.authorizeIntakeDevice(req);
          result = await service.terminalSubmit(device, input);
        } else fail(405, 'method_not_allowed', 'Metoden stöds inte.');
      }
      json(res, 200, result);
    } catch (error) {
      const known = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      json(res, known ? error.status : 503, { error: known ? error.message : 'Kundformuläret kunde inte nås. Försök igen om en stund.',
        code: known ? error.code ?? 'customer_intake_unavailable' : 'customer_intake_unavailable' });
    }
    return true;
  };
}
