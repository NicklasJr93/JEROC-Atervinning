/** Mail routes are private platform APIs. The tenant gateway supplies the
 * immutable company and authenticated principal; client IDs cannot select it. */
const error = (message, status = 400, code = 'mail_invalid') => Object.assign(new Error(message), { status, code });
const json = (res, status, value, head = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(head ? '' : JSON.stringify(value));
};
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw error('Mejlanropet måste komma från samma webbplats.', 403, 'mail_origin_forbidden');
  if (!req.headers.origin) return;
  try {
    const origin = new URL(req.headers.origin), scheme = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== scheme) throw new Error();
  } catch { throw error('Mejlanropet måste komma från samma webbplats.', 403, 'mail_origin_forbidden'); }
}
async function body(req) {
  let bytes = 0, text = '';
  for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > 16_384) throw error('Mejlåtgärdens uppgifter är för stora.', 413); text += chunk; }
  try {
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw error('Mejlåtgärdens uppgifter ska vara ett JSON-objekt.', 422); }
}
function fields(value, allowed) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw error('Mejlåtgärden innehåller okända uppgifter.', 422);
  return value;
}
function id(value) {
  let decoded; try { decoded = decodeURIComponent(value); } catch { throw error('Ogiltigt mejl-ID.', 400); }
  if (!decoded || decoded.length > 2048 || /[\u0000-\u001f\u007f]/.test(decoded)) throw error('Ogiltigt mejl-ID.', 400);
  return decoded;
}
export function createMailApi({ service, organisationId, resolveContext } = {}) {
  if (!service || !organisationId || typeof resolveContext !== 'function') throw new TypeError('Mejl-API behöver en servervald bolagssession.');
  return async (req, res, url) => {
    if (url.pathname !== '/api/mail' && !url.pathname.startsWith('/api/mail/')) return false;
    try {
      sameOrigin(req);
      const context = await resolveContext(req);
      if (!context || context.organisationId !== organisationId || !context.actorId || !context.effectiveUserId || !context.sessionKey)
        throw error('Logga in i bolaget för att öppna mejlen.', 401, 'mail_session_required');
      const read = ['GET', 'HEAD'].includes(req.method);
      if (!read && (!context.csrfToken || req.headers['x-platform-csrf'] !== context.csrfToken))
        throw error('Mejlsessionen behöver verifieras igen.', 403, 'mail_csrf_invalid');
      const path = url.pathname.slice('/api/mail'.length);
      const connection = path.match(/^\/connections\/([^/]+)\/disconnect$/);
      const mailbox = path.match(/^\/mailboxes\/([^/]+)$/);
      const message = path.match(/^\/mailboxes\/([^/]+)\/messages\/([^/]+)$/);
      let result;
      if (read && path === '/state') result = await service.state(context);
      else if (read && path === '/messages') {
        if ([...url.searchParams.keys()].some(key => !['mailboxId', 'unreadOnly', 'search', 'cursor'].includes(key))) throw error('Ogiltigt mejlfilter.', 422);
        const unread = url.searchParams.get('unreadOnly'); if (unread !== null && !['true', 'false', '1', '0'].includes(unread)) throw error('Ogiltigt olästfilter.', 422);
        const search = url.searchParams.get('search') ?? '', cursor = url.searchParams.get('cursor') ?? undefined;
        if (search.length > 200 || cursor && cursor.length > 2000) throw error('Mejlfiltret är för långt.', 422);
        result = await service.listMessages({ mailboxId: url.searchParams.get('mailboxId') || undefined, unreadOnly: unread === 'true' || unread === '1', search, cursor }, context);
      } else if (read && message) result = await service.message(id(message[1]), id(message[2]), context);
      else if (req.method === 'POST' && path === '/microsoft/connect') { fields(await body(req), []); result = await service.connectMicrosoft(context); }
      else if (req.method === 'POST' && path === '/sync') result = await service.sync(fields(await body(req), ['mailboxId']), context);
      else if (req.method === 'POST' && connection) { fields(await body(req), []); result = await service.disconnect(id(connection[1]), context); }
      else if (req.method === 'POST' && path === '/mailboxes') result = await service.addMailbox(fields(await body(req), ['connectionId', 'address', 'displayName', 'allowedUserIds']), context);
      else if (req.method === 'PUT' && mailbox) result = await service.updateMailbox(id(mailbox[1]), fields(await body(req), ['displayName', 'allowedUserIds', 'enabled']), context);
      else throw error('Mejlåtgärden finns inte.', 404, 'mail_route_missing');
      json(res, 200, result, req.method === 'HEAD');
    } catch (failure) {
      const known = Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599;
      json(res, known ? failure.status : 503, { code: known ? failure.code ?? 'mail_invalid' : 'mail_unavailable', message: known ? failure.message : 'Mejltjänsten kunde inte nås. Försök igen.' });
    }
    return true;
  };
}
