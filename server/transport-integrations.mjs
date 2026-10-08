import { z } from 'zod';
import { createPricingStore, PricingError } from './pricing.mjs';

// Preparation only: the API never invokes a delivery adapter. Replace this
// memory repository with durable storage before connecting a message provider.
export const transportEventTypes = [
  'work_order.created', 'work_order.updated', 'work_order.booked',
  'work_order.rescheduled', 'work_order.booking_cancelled', 'work_order.cancelled',
  'work_order.en_route', 'work_order.completed', 'work_order.confirmation_requested',
  'work_order.confirmation_accepted', 'work_order.confirmation_declined', 'work_order.confirmation_expired',
];
const text = z.string().trim().min(1).max(200);
const plan = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const timestamp = Date.parse(value + 'T12:00:00Z');
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  }),
  startMinute: z.number().int().min(0).max(1425).multipleOf(15),
  durationMinutes: z.number().int().min(15).max(480).multipleOf(15),
  driverId: text, vehicleId: text,
}).strict().refine((value) => value.startMinute + value.durationMinutes <= 1440);
export const transportIntegrationEventSchema = z.object({
  id: text, type: z.enum(transportEventTypes), orderId: text,
  at: z.string().datetime(), bookingVersion: z.number().int().nonnegative(),
  customer: z.object({ id: text.optional(), name: text }).strict(),
  driver: z.object({ id: text, name: text }).strict().optional(),
  beforePlan: plan.optional(), afterPlan: plan.optional(), reason: z.string().max(2000).optional(),
  actor: text, actualUserId: text, effectiveUserId: text, confirmationId: text.optional(),
}).strict();
const batchSchema = z.object({ events: z.array(transportIntegrationEventSchema).max(100) }).strict();
const can = (principal, right) => principal.user.level !== 'Medarbetare' || principal.user.permissions.includes(right);
const demand = (principal, right) => {
  if (!can(principal, right)) throw new PricingError('Du saknar transportbehörighet för detta moment.', 403);
};
const copy = (value) => structuredClone(value);

export function createTransportOutbox({ now = () => new Date(), maxEvents = 10000 } = {}) {
  const entries = new Map();
  const running = new Set();
  function prepare(payload, principal) {
    demand(principal, 'transportPlan');
    demand(principal, 'transportRead');
    const parsed = batchSchema.safeParse(payload);
    if (!parsed.success) throw new PricingError('Ogiltigt integrationsunderlag.');
    const staged = new Map();
    let duplicates = 0;
    for (const event of parsed.data.events) {
      if (event.actualUserId !== principal.actor.id || event.effectiveUserId !== principal.user.id) {
        throw new PricingError('Händelsens användare stämmer inte med det valda demokontot.', 403);
      }
      const previous = staged.get(event.id) ?? entries.get(event.id)?.event;
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(event)) throw new PricingError('Händelse-ID:t används redan för ett annat underlag.', 409);
        duplicates += 1;
      } else staged.set(event.id, event);
    }
    if (entries.size + staged.size > maxEvents) throw new PricingError('Demons utkorg är full. Händelserna finns kvar i webbläsaren.', 503);
    // The entire batch is validated before anything is added to the queue.
    for (const event of staged.values()) entries.set(event.id, {
      event: copy(event), state: 'prepared', attempts: 0, preparedAt: now().toISOString(),
    });
    return { acceptedIds: [...new Set(parsed.data.events.map((event) => event.id))], prepared: staged.size, duplicates, deliveryEnabled: false, memoryOnly: true };
  }
  function read(principal) {
    demand(principal, 'transportRead');
    return { entries: [...entries.values()].map(copy), deliveryEnabled: false, memoryOnly: true };
  }
  /** Future adapter boundary. No adapter is configured or invoked by the demo API. */
  async function deliver({ adapter, limit = 100 } = {}) {
    if (typeof adapter !== 'function') return { enabled: false, delivered: 0, failed: 0 };
    let delivered = 0, failed = 0;
    const candidates = [...entries.values()].filter((entry) => entry.state !== 'delivered' && !running.has(entry.event.id)
      && (!entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now().getTime())).slice(0, limit);
    for (const entry of candidates) {
      const id = entry.event.id;
      // Multiple workers in the same process cannot deliver the same entry at once.
      if (running.has(id) || entry.state === 'delivered') continue;
      running.add(id); entry.attempts += 1; entry.lastAttemptAt = now().toISOString();
      try {
        const receipt = await adapter(copy(entry.event), { idempotencyKey: id });
        entry.state = 'delivered'; entry.deliveredAt = now().toISOString();
        if (typeof receipt?.receiptId === 'string') entry.receiptId = receipt.receiptId;
        delete entry.nextAttemptAt; delete entry.lastError; delivered += 1;
      } catch {
        entry.state = 'failed'; entry.lastError = 'Leveransen misslyckades.';
        const delay = Math.min(3600000, 30000 * 2 ** Math.min(entry.attempts - 1, 7));
        entry.nextAttemptAt = new Date(now().getTime() + delay).toISOString(); failed += 1;
      } finally { running.delete(id); }
    }
    return { enabled: true, delivered, failed };
  }
  return { prepare, read, deliver };
}

const MAX_BODY = 128 * 1024;
const json = (res, status, value, head = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : JSON.stringify(value));
};
async function readBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new PricingError('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY) throw new PricingError('Anropet är för stort.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PricingError('Anropet är för stort.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PricingError('Ogiltig JSON.'); }
}
export function createTransportIntegrationsApi({ principalStore = createPricingStore(), outbox = createTransportOutbox() } = {}) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/api/transport/')) return false;
    try {
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new PricingError('Ogiltigt ursprung.', 403); }
        if (origin.host !== req.headers.host) throw new PricingError('Anropet måste komma från samma webbplats.', 403);
      }
      const actorId = req.headers['x-demo-actor'], userId = req.headers['x-demo-user'] ?? actorId;
      if (typeof actorId !== 'string' || typeof userId !== 'string') throw new PricingError('Välj ett demokonto.', 401);
      const principal = principalStore.principal(actorId, userId);
      if (url.pathname !== '/api/transport/outbox') throw new PricingError('API-vyn finns inte.', 404);
      if (req.method === 'GET' || req.method === 'HEAD') json(res, 200, outbox.read(principal), req.method === 'HEAD');
      else if (req.method === 'POST') json(res, 200, outbox.prepare(await readBody(req), principal));
      else { res.setHeader('Allow', 'GET, HEAD, POST'); throw new PricingError('Metoden stöds inte.', 405); }
    } catch (error) {
      json(res, error instanceof PricingError ? error.status : 500, {
        error: error instanceof PricingError ? error.message : 'Utkorgen kunde inte uppdateras.', deliveryEnabled: false, memoryOnly: true,
      });
    }
    return true;
  };
}
