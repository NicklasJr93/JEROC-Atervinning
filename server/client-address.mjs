import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/** Render is the trusted edge only when the deployment explicitly identifies
 * itself as Render. It appends the client IP, so use the final bounded value.
 * Direct/local servers ignore forwarding headers; they cannot grant a caller
 * a new rate-limit identity. Keep raw network addresses out of durable state. */
export function clientAddressHash(req, env = process.env) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const candidate = env.RENDER === 'true' && typeof forwarded === 'string' && forwarded.length <= 2048
    ? forwarded.split(',').at(-1).trim() : undefined;
  const address = candidate && isIP(candidate) ? candidate.toLowerCase() : req.socket?.remoteAddress ?? 'unknown';
  return createHash('sha256').update(address).digest('hex');
}
