import { ScbCompanyRegisterError } from './scb-company-register.mjs';

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
export function createCustomerIntakeApi({ service, terminalAccess, companyLookup, organisationId = 'terminal', authorizeCompany }) {
  return async (req, res, url) => {
    const staffRoute = url.pathname === STAFF || url.pathname.startsWith(`${STAFF}/`);
    const deviceRoute = url.pathname === TERMINAL || url.pathname.startsWith(`${TERMINAL}/`);
    if (!staffRoute && !deviceRoute) return false;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
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
        } else if (req.method === 'POST' && url.pathname === `${TERMINAL}/company-lookup`) {
          const input = await body(req);
          if (!input || Array.isArray(input) || typeof input !== 'object'
            || Object.keys(input).length !== 2 || Object.keys(input).some(key => !['id', 'organisationNumber'].includes(key))
            || typeof input.id !== 'string' || !input.id || input.id.length > 100)
            fail(422, 'company_lookup_invalid', 'Ange organisationsnummer för det aktuella kundformuläret.');
          const device = await terminalAccess.authorizeIntakeDevice(req);
          await authorizeCompany?.(req);
          const verify = value => {
            if (value?.intake?.id !== input.id || value.intake.status !== 'waiting'
              || !Number.isFinite(Date.parse(value.intake.expiresAt)) || Date.parse(value.intake.expiresAt) <= Date.now())
              fail(410, 'customer_intake_unavailable', 'Kundformuläret är inte tillgängligt längre. Be personalen öppna ett nytt.');
          };
          verify(await service.terminalRead(device));
          if (typeof companyLookup !== 'function') fail(503, 'company_lookup_unavailable', 'Fyll i företagsuppgifterna manuellt.');
          // The provider is awaited only after the intake transaction released
          // its locks. A fresh cookie/connection and intake are checked again.
          const company = await companyLookup({ organisationNumber: input.organisationNumber },
            { rateKey: `intake:${organisationId}:${input.id}`, signal: controller.signal });
          await authorizeCompany?.(req);
          const current = await terminalAccess.authorizeIntakeDevice(req);
          if (current.id !== device.id || current.siteId !== device.siteId || current.connectionId !== device.connectionId)
            fail(409, 'terminal_session_changed', 'Terminalsessionen har ändrats. Be personalen öppna formuläret på nytt.');
          verify(await service.terminalRead(current));
          result = { company };
        } else fail(405, 'method_not_allowed', 'Metoden stöds inte.');
      }
      if (!controller.signal.aborted) json(res, 200, result);
    } catch (error) {
      const known = error instanceof ScbCompanyRegisterError || Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      if (!controller.signal.aborted) json(res, known ? error.status : 503, { error: known ? error.message : 'Kundformuläret kunde inte nås. Försök igen om en stund.',
        code: known ? error.code ?? 'customer_intake_unavailable' : 'customer_intake_unavailable' });
    } finally { req.off('aborted', abort); res.off('close', abort); }
    return true;
  };
}
