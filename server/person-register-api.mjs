import { PersonRegisterError } from './roaring-person-register.mjs';

const PATH = '/api/person-register/lookup';
const fail = (message, status, code) => { throw new PersonRegisterError(message, status, code, 'rejected'); };
const reply = (res, status, body) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(status === 405 ? { Allow: 'POST' } : {}) });
  res.end(JSON.stringify(body));
};
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') fail('Anropet måste komma från samma webbplats.', 403, 'person_lookup_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin), protocol = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== protocol) throw new Error();
  } catch { fail('Anropet måste komma från samma webbplats.', 403, 'person_lookup_origin_forbidden'); }
}
async function readInput(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('Använd application/json.', 415, 'person_lookup_content_type');
  if (Number(req.headers['content-length']) > 1024) fail('Anropet är för stort.', 413, 'person_lookup_payload_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024) fail('Anropet är för stort.', 413, 'person_lookup_payload_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Ogiltig JSON.', 400, 'person_lookup_invalid_json'); }
}

/** Same privileged customer-registration guard for all three signed-in forms.
 * Anonymous intake routes deliberately use their own single-intake capability. */
export function createPersonRegisterApi({ lookup, authorize } = {}) {
  if (typeof lookup !== 'function' || typeof authorize !== 'function') throw new TypeError('A person lookup and authenticated authorization are required.');
  return async (req, res, url) => {
    if (url.pathname !== PATH) return false;
    const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      if (req.method !== 'POST') fail('Metoden stöds inte.', 405, 'person_lookup_method');
      sameOrigin(req);
      if (url.search) fail('Ange personnumret i anropets innehåll.', 422, 'person_lookup_invalid');
      const captured = await authorize(req);
      if (!captured?.organisationId || !captured.scopeKey) fail('Välj bolag och logga in för att göra uppslaget.', 403, 'person_lookup_forbidden');
      const revalidate = async () => {
        const current = await authorize(req);
        if (current?.organisationId !== captured.organisationId || current.scopeKey !== captured.scopeKey)
          fail('Bolaget eller kontot har ändrats. Sök igen i den aktuella arbetsytan.', 409, 'person_lookup_scope_changed');
      };
      const result = await lookup(await readInput(req), { organisationId: captured.organisationId,
        actorId: captured.actorId, rateKey: `staff:${captured.actorId ?? captured.scopeKey}`,
        channel: 'customer_registration', signal: controller.signal, revalidate });
      await revalidate();
      if (!controller.signal.aborted) reply(res, 200, result);
    } catch (error) {
      const known = error instanceof PersonRegisterError || Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
      if (!controller.signal.aborted) reply(res, known ? error.status : 503, { error: known ? error.message : 'Personuppslaget kunde inte genomföras. Fyll i uppgifterna manuellt.',
        code: known ? error.code ?? 'person_lookup_forbidden' : 'person_lookup_unavailable' });
    } finally { req.off('aborted', abort); res.off('close', abort); }
    return true;
  };
}
