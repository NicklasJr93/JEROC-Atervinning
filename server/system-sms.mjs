import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizePhoneNumber, phoneNumberError } from '../dist-server/domain-models.mjs';

/** Preparation only. Existing business outboxes remain the owners of events;
 * this module neither creates a queue nor performs a provider/network request.
 */
export const SYSTEM_SMS_USE_CASES = Object.freeze([
  Object.freeze({ id: 'customer_approval', label: 'Kundgodkännande', state: 'prepared' }),
  Object.freeze({ id: 'transport_notification', label: 'Transportaviseringar', state: 'prepared' }),
]);

const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
const purpose = z.enum(['customer_approval', 'transport_notification']);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const recipient = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value))
  .refine(value => phoneNumberError(value, { required: true }) === null)
  .transform(value => normalizePhoneNumber(value));
const base = { purpose, eventId: identifier, version, recipient };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const commandSchema = z.union([
  z.object({ ...base, purpose: z.literal('customer_approval') }).strict(),
  z.object({ ...base, purpose: z.literal('transport_notification'), kind: z.enum(['booked', 'time_changed']), date: day, time: clock }).strict(),
  z.object({ ...base, purpose: z.literal('transport_notification'), kind: z.literal('on_the_way') }).strict(),
]);
const cleanUrl = z.string().min(1).max(2048).refine(value => !/[\s\u0000-\u001f\u007f]/.test(value));
const scopeSchema = z.object({
  organisationId: identifier,
  portalBaseUrl: cleanUrl,
  authorisedLink: z.object({
    organisationId: identifier, purpose, eventId: identifier, version, recipient,
    url: cleanUrl, expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
}).strict();

export class SystemSmsPreparationError extends Error {
  constructor(code, message) { super(message); this.name = 'SystemSmsPreparationError'; this.code = code; this.status = 422; }
}
const fail = (code, message) => { throw new SystemSmsPreparationError(code, message); };

function portalLink(scope) {
  let baseUrl, url;
  try { baseUrl = new URL(scope.portalBaseUrl); url = new URL(scope.authorisedLink.url); }
  catch { fail('system_sms_link_invalid', 'En giltig, redan utfärdad kundportallänk krävs.'); }
  // Require the caller's trusted customer-portal base, never an arbitrary URL
  // supplied in an event. No redirect, fragment or embedded credentials.
  if (baseUrl.protocol !== 'https:' || url.protocol !== 'https:' || baseUrl.username || baseUrl.password
    || url.username || url.password || baseUrl.hash || baseUrl.search || url.hash || url.origin !== baseUrl.origin
    || !/^\/kund(?:\/|$)/.test(baseUrl.pathname)
    || !(url.pathname === baseUrl.pathname.replace(/\/$/, '') || url.pathname.startsWith(`${baseUrl.pathname.replace(/\/$/, '')}/`))
    || [...url.searchParams.keys()].some(key => /^(?:url|redirect|redirect_uri|returnto|returnurl|next)$/i.test(key)))
    fail('system_sms_link_invalid', 'Länken måste tillhöra den betrodda kundportalen.');
  return url.href;
}

/** Server-only draft contract for a future SMS adapter. The caller must first
 * authorize the tenant, recipient, current object/version and issue/validate an
 * expiring link. authorisedLink is that server context, not a client payload.
 * This helper validates its binding but cannot authenticate a bearer token.
 * There are no public endpoints or send hooks for these drafts yet.
 */
export function prepareSystemSms(input, trustedScope, { now = Date.now } = {}) {
  const parsed = commandSchema.safeParse(input), parsedScope = scopeSchema.safeParse(trustedScope);
  if (!parsed.success || !parsedScope.success)
    fail('system_sms_invalid', 'Kontrollera SMS-underlaget, mottagaren och den betrodda bolagskopplingen.');
  const command = parsed.data, scope = parsedScope.data, link = scope.authorisedLink;
  if (link.organisationId !== scope.organisationId || link.purpose !== command.purpose
    || link.eventId !== command.eventId || link.version !== command.version || link.recipient !== command.recipient)
    fail('system_sms_scope_mismatch', 'Kundlänken omfattar inte detta bolag, underlag eller denna mottagare.');
  const at = Number(now());
  if (!Number.isFinite(at) || Date.parse(link.expiresAt) <= at)
    fail('system_sms_link_expired', 'Kundlänken har gått ut. Utfärda en ny länk före avisering.');
  const url = portalLink(scope);
  const text = command.purpose === 'customer_approval'
    ? `Du har ett viktunderlag att granska och godkänna i kundportalen: ${url}`
    : command.kind === 'booked'
      ? `Din transport är bokad ${command.date} kl. ${command.time}. Se bokningen i kundportalen: ${url}`
      : command.kind === 'time_changed'
        ? `Tiden för din transport har ändrats till ${command.date} kl. ${command.time}. Se bokningen i kundportalen: ${url}`
        : `Chauffören är på väg för din transport. Se bokningen i kundportalen: ${url}`;
  // The identity is stable across retries and isolates tenants, recipients,
  // event versions and notification kinds. No phone number is in the key.
  const identity = JSON.stringify([scope.organisationId, command.purpose, command.eventId, command.version,
    command.kind ?? 'approval', command.recipient]);
  return Object.freeze({
    channel: 'sms', deliveryEnabled: false, deliveryStatus: 'not_configured', organisationId: scope.organisationId,
    purpose: command.purpose, eventId: command.eventId, version: command.version,
    ...(command.purpose === 'transport_notification' && { kind: command.kind }),
    recipient: command.recipient, text, portalUrl: url, linkExpiresAt: new Date(link.expiresAt).toISOString(),
    idempotencyKey: `sms:${createHash('sha256').update(identity).digest('hex')}`,
  });
}
