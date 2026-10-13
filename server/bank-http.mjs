import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/** Request identity is constructed only by authenticated tenant gateways. The
 * redirect must reproduce the original session binding without relying on the
 * environment API's Strict cookie being sent from an external bank page. */
export function bankRequestContext({ req, organisationId, principal, trustedPrincipal, token, reauthorize, env = {} }) {
  const forwarded = env.RENDER ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return { organisationId, actorId: principal.actor.id, effectiveUserId: principal.user.id,
    actor: principal.actor, user: principal.user,
    sessionKey: createHash('sha256').update(trustedPrincipal
      ? JSON.stringify([organisationId, trustedPrincipal.actorId, trustedPrincipal.userId, trustedPrincipal.sessionKey ?? trustedPrincipal.csrfToken])
      : token).digest('hex'),
    psuIp: isIP(forwarded) ? forwarded : isIP(remote) ? remote : '127.0.0.1',
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), reauthorize };
}
