import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PricingError, resolvePricingPrincipal } from './pricing.mjs';

const identifier = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/);
const category = z.enum(['truck', 'van', 'car', 'trailer', 'machine', 'other']);
const vehicleInput = z.object({
  id: identifier.optional(), revision: z.number().int().nonnegative().optional(),
  registration: z.string().trim().max(30),
  assetTag: z.string().trim().min(1).max(120).optional(), identifier: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(200), active: z.boolean(),
  types: z.array(z.enum(['container', 'battery', 'bin', 'cage'])).max(4),
  category: category.optional(), capacityKg: z.number().finite().positive().max(1e7).optional(),
}).strict().superRefine((vehicle, context) => {
  if (!vehicle.registration && (!['machine', 'other'].includes(vehicle.category ?? '') || !vehicle.assetTag && !vehicle.identifier))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['registration'], message: 'Ange registreringsnummer eller intern identifiering för maskinen.' });
  if (!vehicle.types.length && !['car', 'machine', 'other'].includes(vehicle.category ?? ''))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['types'], message: 'Ange minst en kärltyp för transportfordonet.' });
});
const commandSchema = z.object({ action: z.literal('vehicle.save'), vehicle: vehicleInput, requestId: identifier.optional() }).strict();
const fail = (message, status = 409) => { throw new PricingError(message, status); };
const copy = value => structuredClone(value);
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '), 422);
  return result.data;
};
const identities = p => [p?.actor, p?.user];
const can = (user, permission) => Boolean(user?.id) && user.active !== false &&
  (['VD', 'Systemadmin'].includes(user.level) || user.level === 'Medarbetare' && user.permissions?.includes(permission));
const canonicalRegistration = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[\s-]+/g, '') : '';
const canonicalAsset = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, ' ') : '';

/** One shared tenant fleet. Site-limited administrators may select vehicles,
 * but cannot retire or alter resources used by an unseen part of the company. */
export function vehicleRegistryCapabilities(principal) {
  const vehicleRead = identities(principal).every(user => can(user, 'fleetRead') || can(user, 'fleetWrite') || can(user, 'personnelRead') || can(user, 'transportRead'));
  const vehicleWrite = vehicleRead && identities(principal).every(user => !Array.isArray(user.siteIds) &&
    (can(user, 'fleetWrite') || can(user, 'personnelRead') && can(user, 'personnelWrite') || can(user, 'transportRead') && can(user, 'transportPlan')));
  return { vehicleRead, vehicleWrite };
}

/** Store an unambiguous reference; whitespace/hyphen variants of one plate
 * must never create two registry entries. Personalised/foreign plates work too. */
export function normalizeVehicleRegistration(value) {
  if (typeof value !== 'string') fail('Ange ett registreringsnummer.', 422);
  const registration = canonicalRegistration(value);
  if (!/^[A-Z0-9]{2,16}$/.test(registration))
    fail('Ange ett registreringsnummer med bokstäver och siffror, utan andra tecken.', 422);
  return registration;
}

export function vehicleRegistryProjection(state, principal) {
  const capabilities = vehicleRegistryCapabilities(principal);
  if (!capabilities.vehicleRead) fail('Du saknar behörighet att läsa fordon.', 403);
  return { vehicles: copy(state.transport?.vehicles ?? []), revision: state.transport?.revision ?? 0, capabilities };
}

/** The legacy transport editor submits a complete aggregate. Fleet edits must
 * still pass this dedicated registry API; its snapshots are not a write bypass.
 * Only new/changed plans use present-day vehicle eligibility. */
export function assertVehiclePlanningChange(previous, next, { vehicleEligible } = {}) {
  if (!isDeepStrictEqual(previous.vehicles, next.vehicles))
    fail('Använd fordonsregistret för att skapa eller ändra ett fordon.', 403);
  const planKey = order => order && ['date', 'startMinute', 'durationMinutes', 'driverId', 'vehicleId', 'vesselType']
    .map(key => order[key] ?? '').join('|');
  const eligible = (order, plan) => {
    const vehicle = next.vehicles.find(value => value.id === plan.vehicleId);
    if (!vehicle) fail('Välj ett befintligt fordon.', 422);
    if (vehicle.active === false) fail('Fordonet är inaktiverat. Välj ett aktivt fordon för den nya bokningen.', 422);
    if (!vehicle.types.includes(order.vesselType)) fail('Fordonet kan inte hantera denna kärltyp.', 422);
    const availability = vehicleEligible?.(vehicle.id, { plan });
    if (availability && !availability.eligible) fail(availability.issues.map(issue => issue.message).join(' '), 422);
  };
  for (const order of next.orders) {
    if (!['booked', 'on_way'].includes(order.status)) continue;
    const old = previous.orders.find(value => value.id === order.id);
    if (old && ['booked', 'on_way'].includes(old.status) && planKey(old) === planKey(order)) {
      if (order.status === 'on_way' && old.status !== 'on_way' && vehicleEligible) eligible(order, order);
      continue;
    }
    eligible(order, order);
  }
  for (const [id, plan] of Object.entries(next.preliminary ?? {})) {
    if (isDeepStrictEqual(previous.preliminary?.[id], plan)) continue;
    const order = next.orders.find(value => value.id === id);
    if (!order) fail('Den preliminära arbetsordern finns inte längre.', 422);
    eligible(order, plan);
  }
}

const commandHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Execute under the same aggregate transaction as personnel and bookings.
 * Revision checks stop competing edits; requestId makes an uncertain retry safe. */
export function vehicleRegistryCommand(state, principal, value, transactionAudit = []) {
  if (!vehicleRegistryCapabilities(principal).vehicleWrite)
    fail('Behörighet att hantera personal eller transporter med åtkomst till alla anläggningar krävs för fordonsregistret.', 403);
  const command = parse(commandSchema, value);
  command.vehicle.registration = command.vehicle.registration ? normalizeVehicleRegistration(command.vehicle.registration) : '';
  command.vehicle.types = [...new Set(command.vehicle.types)].sort();
  const hash = commandHash(command), events = state.metadata?.vehicleEvents ?? [];
  if (command.requestId) {
    const previous = events.find(event => event.requestId === command.requestId);
    if (previous) {
      if (previous.commandHash !== hash || previous.actualUserId !== principal.actor.id || previous.effectiveUserId !== principal.user.id)
        fail('Begäran har redan använts för en annan fordonsändring.');
      return { ...vehicleRegistryProjection(state, principal), savedVehicleId: previous.vehicleId };
    }
  }
  const fleet = state.transport?.vehicles;
  if (!Array.isArray(fleet)) fail('Fordonsregistret kunde inte öppnas.', 503);
  const input = command.vehicle, old = input.id ? fleet.find(vehicle => vehicle.id === input.id) : undefined;
  if (input.id && !old) fail('Fordonet finns inte längre.', 404);
  if (old && input.revision !== (old.revision ?? 0)) fail('Fordonet har ändrats. Uppdatera sidan innan du sparar.');
  if (!old && input.revision !== undefined && input.revision !== 0) fail('Ett nytt fordon kan inte ha en tidigare revision.', 422);
  if (input.registration && fleet.some(vehicle => vehicle.id !== old?.id && canonicalRegistration(vehicle.registration) === input.registration))
    fail('Registreringsnumret används redan av ett fordon. Välj det befintliga fordonet.');
  for (const field of ['assetTag', 'identifier']) if (input[field] && fleet.some(vehicle => vehicle.id !== old?.id && canonicalAsset(vehicle[field]) === canonicalAsset(input[field])))
    fail('Den interna identifieringen används redan av ett fordon eller en maskin. Välj den befintliga posten.');
  const now = new Date().toISOString();
  const saved = { ...old, id: old?.id ?? `vehicle-${randomUUID()}`, registration: input.registration, name: input.name,
    types: input.types, active: input.active, revision: (old?.revision ?? 0) + 1,
    createdAt: old?.createdAt ?? now, updatedAt: now };
  if (input.category !== undefined) saved.category = input.category; else delete saved.category;
  if (input.capacityKg !== undefined) saved.capacityKg = input.capacityKg; else delete saved.capacityKg;
  for (const field of ['assetTag', 'identifier']) if (input[field] !== undefined) saved[field] = input[field]; else delete saved[field];
  const editable = vehicle => ({ registration: canonicalRegistration(vehicle.registration), name: vehicle.name,
    types: [...vehicle.types].sort(), active: vehicle.active !== false, category: vehicle.category, capacityKg: vehicle.capacityKg,
    assetTag: vehicle.assetTag, identifier: vehicle.identifier });
  if (old && isDeepStrictEqual(editable(old), editable(saved)))
    return { ...vehicleRegistryProjection(state, principal), savedVehicleId: old.id };
  // Ordinary vehicle links and every existing order keep their IDs and booking
  // history. Neither this command nor deactivation books/unbooks any work.
  if (old) fleet[fleet.indexOf(old)] = saved; else fleet.push(saved);
  state.transport.revision++;
  state.metadata ??= {};
  state.metadata.vehicleEvents ??= [];
  const action = !old ? 'vehicle.created' : old.active !== false && saved.active === false ? 'vehicle.deactivated'
    : old.active === false && saved.active ? 'vehicle.activated' : 'vehicle.updated';
  const event = { id: `vehicle-event-${randomUUID()}`, action, vehicleId: saved.id, at: now,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id,
    ...(command.requestId ? { requestId: command.requestId, commandHash: hash } : {}),
    before: old ? copy(editable(old)) : null, after: copy(editable(saved)) };
  state.metadata.vehicleEvents.push(event);
  transactionAudit.push({ id: event.id, domain: 'transport', action, vehicleId: saved.id, at: now,
    actualUserId: principal.actor.id, effectiveUserId: principal.user.id });
  return { ...vehicleRegistryProjection(state, principal), savedVehicleId: saved.id };
}

const maxBody = 32 * 1024;
async function defaultReadBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) fail('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > maxBody) fail('Anropet är för stort.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > maxBody) fail('Anropet är för stort.', 413); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('Ogiltig JSON.', 422); }
}
const defaultJson = (res, status, value, head = false) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(head ? undefined : JSON.stringify(value));
};

/** The tenant gateway selects the immutable repository and protects platform
 * cookies/CSRF. Reload both selected identities inside the transaction as well. */
export async function handlePersonnelVehiclesApi(req, res, url, repository, { principalResolver, resolvePrincipal, readBody = defaultReadBody, json = defaultJson } = {}) {
  if (url.pathname !== '/api/personnel/vehicles') return false;
  try {
    if (req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { fail('Ogiltigt ursprung.', 403); }
      if (origin.host !== req.headers.host) fail('Anropet måste komma från samma webbplats.', 403);
    }
    if (url.searchParams.size) fail('Fordonsregistret accepterar inga val av bolag eller person i frågesträngen.', 422);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD, POST'); fail('Metoden stöds inte.', 405); }
    const supplied = resolvePrincipal ? await resolvePrincipal(req) : null;
    const actorId = supplied?.actor?.id ?? req.headers['x-demo-actor'];
    const userId = supplied?.user?.id ?? req.headers['x-demo-user'] ?? actorId;
    if (!principalResolver && (typeof actorId !== 'string' || typeof userId !== 'string')) fail('Logga in för att öppna fordonsregistret.', 401);
    const payload = req.method === 'POST' ? await readBody(req) : undefined;
    const operate = (state, _unused, audit = []) => {
      const principal = principalResolver ? principalResolver(state, req) : resolvePricingPrincipal(state.pricing?.users ?? [], actorId, userId);
      return req.method === 'POST' ? vehicleRegistryCommand(state, principal, payload, audit) : vehicleRegistryProjection(state, principal);
    };
    const result = req.method === 'POST' ? await repository.transact(operate)
      : await repository.read(operate, { domains: ['pricing', 'transport'] });
    json(res, 200, result, req.method === 'HEAD');
  } catch (error) {
    json(res, error instanceof PricingError ? error.status : 503, { error: error instanceof PricingError ? error.message : 'Fordonsregistret kunde inte nås.' }, req.method === 'HEAD');
  }
  return true;
}
