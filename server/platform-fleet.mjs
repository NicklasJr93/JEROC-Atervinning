import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { PlatformError } from './platform-auth.mjs';

const fail = (message, status = 422, code = 'platform_fleet_invalid') => { throw new PlatformError(message, status, code); };
const clone = value => structuredClone(value);
const field = max => z.string().trim().min(1).max(max).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Fältet innehåller ogiltiga tecken.');
const id = field(160).refine(value => /^[a-zA-Z0-9_:-]+$/.test(value), 'Ogiltigt enhets-ID.');
const base = { requestId: z.string().uuid(), revision: z.number().int().nonnegative() };
const register = z.object({ ...base, action: z.literal('device.register'), name: field(120), model: field(80),
  source: z.enum(['device', 'simulator']).default('device'), imei: z.string().regex(/^\d{15}$/).optional(),
  profile: z.enum(['teltonika-codec8', 'teltonika-codec8e', 'simulator']),
  sim: z.object({ iccid: z.string().trim().regex(/^\d{18,22}$/).optional(), operator: field(80).optional(), apn: field(100).optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.source === 'device' && !value.imei) context.addIssue({ code: 'custom', message: 'En fysisk tracker behöver ett IMEI med 15 siffror.' });
  if (value.source === 'device' && value.profile === 'simulator' || value.source === 'simulator' && value.profile !== 'simulator') context.addIssue({ code: 'custom', message: 'Välj en profil som motsvarar enhetens källa.' });
  if (value.source === 'simulator' && (value.imei || value.sim)) context.addIssue({ code: 'custom', message: 'Testsändare får inte registreras som fysisk IMEI/SIM-utrustning.' });
});
const assign = z.object({ ...base, action: z.literal('device.assign'), deviceId: id, organisationId: field(100) }).strict();
const retire = z.object({ ...base, action: z.literal('device.retire'), deviceId: id }).strict();
const schema = z.union([register, assign, retire]);
const registry = state => state.telematics ?? { version: 1, revision: 0, devices: [], events: [], requests: [] };
function imeiValid(value) {
  let sum = 0;
  for (let i = 0; i < value.length; i++) { let digit = Number(value[i]); if (i % 2) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; }
  return sum % 10 === 0;
}
function view(state) {
  const data = registry(state);
  return { version: 1, revision: data.revision, devices: clone(data.devices), events: clone(data.events.slice(-200).reverse()),
    requests: data.requests.filter(value => value.status === 'pending').map(({ requestId, deviceId, action, status, organisationId, lastError, createdAt, command }) => ({ requestId, deviceId, action, status, organisationId, lastError, createdAt, command: clone(command) })) };
}
function event(data, actor, action, device, requestId) {
  data.events.push({ id: randomUUID(), at: actor.at, actorId: actor.actorId, actorName: actor.actorName, action, deviceId: device.id,
    ...(device.organisationId && { organisationId: device.organisationId }), requestId });
}

/** The platform owns identity/assignment; tenants receive an idempotent copy.
 * A durable pending intent reserves the device until the other database commits. */
export function createPlatformFleet({ auth, repository = auth?.repository, applyAssignment, now = () => new Date() } = {}) {
  if (!auth?.withPlatformAdminTransaction || !repository || typeof applyAssignment !== 'function') throw new TypeError('Trackerregistret behöver autentisering och betrodd bolagskoppling.');
  const flights = new Map(); let closed = false;
  const at = () => new Date(now()).toISOString();
  async function settle(requestId) {
    if (closed) return;
    if (flights.has(requestId)) return flights.get(requestId);
    const run = (async () => {
      const intent = await repository.read(state => {
        const data = registry(state), request = data.requests.find(value => value.requestId === requestId);
        if (!request || request.status !== 'pending') return null;
        const device = data.devices.find(value => value.id === request.deviceId);
        const company = state.companies.find(value => value.id === request.organisationId && value.status === 'active');
        const actor = state.users.find(value => value.id === request.actorId && value.active && value.platformAdmin);
        if (!device || device.pendingRequestId !== requestId || !company || !actor) return null;
        return { request: clone(request), device: clone(device), company: clone(company) };
      });
      if (!intent || closed) return;
      try {
        await applyAssignment(intent.company, { id: intent.device.id, name: intent.device.name, organisationId: intent.company.id,
          source: intent.device.source, active: intent.request.action !== 'device.retire' });
      } catch {
        await repository.transact(state => {
          const data = registry(state), record = data.requests.find(value => value.requestId === requestId);
          if (record?.status === 'pending') { record.lastError = 'platform_fleet_copy_pending'; record.lastAttemptAt = at(); }
        });
        throw new PlatformError('Bolagskopplingen väntar på synkronisering. Försök igen med samma åtgärd.', 503, 'platform_fleet_copy_pending');
      }
      await repository.transact(state => {
        const data = registry(state), record = data.requests.find(value => value.requestId === requestId);
        if (record?.status === 'completed') return;
        const device = data.devices.find(value => value.id === record?.deviceId);
        if (!record || !device || device.pendingRequestId !== requestId) fail('Trackeråtgärden har ändrats under synkroniseringen.', 409);
        device.organisationId = record.organisationId; device.updatedAt = at(); device.active = record.action !== 'device.retire';
        device.provisioningStatus = device.active ? 'active' : 'retired'; delete device.pendingRequestId; delete device.pendingOrganisationId;
        record.status = 'completed'; record.completedAt = at(); delete record.lastError; data.revision++;
        event(data, { actorId: record.actorId, actorName: record.actorName, at: at() }, record.action === 'device.retire' ? 'device.retired' : 'device.assigned', device, requestId);
      });
    })();
    flights.set(requestId, run);
    try { return await run; } finally { if (flights.get(requestId) === run) flights.delete(requestId); }
  }
  async function mutate(input, req) {
    await auth.withPlatformAdminTransaction(req, () => true, { write: true });
    const parsed = schema.safeParse(input);
    if (!parsed.success) fail('Kontrollera trackeruppgifterna och välj en giltig åtgärd.');
    const command = parsed.data;
    if (command.action === 'device.register' && command.imei && !imeiValid(command.imei)) fail('IMEI:s kontrollsiffra stämmer inte.');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const reservation = await auth.withPlatformAdminTransaction(req, (state, actor) => {
      state.telematics ??= registry(state); const data = state.telematics;
      const prior = data.requests.find(value => value.requestId === command.requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.actorId !== actor.actorId) fail('Anropsnumret används redan av en annan trackeråtgärd.', 409, 'platform_fleet_request_conflict');
        return clone(prior);
      }
      if (command.revision !== data.revision) fail('Trackerregistret har uppdaterats. Hämta den senaste listan och försök igen.', 409, 'platform_fleet_revision_conflict');
      let device;
      if (command.action === 'device.register') {
        if (command.imei && data.devices.some(value => value.imei === command.imei)) fail('Detta IMEI finns redan i trackerregistret.', 409, 'platform_fleet_imei_exists');
        device = { id: `tracker-${randomUUID()}`, name: command.name, model: command.model, source: command.source,
          ...(command.imei && { imei: command.imei }), ...(command.sim && { sim: clone(command.sim) }), profile: command.profile,
          active: true, provisioningStatus: 'prepared', connectionStatus: 'never_connected', createdAt: actor.at, updatedAt: actor.at };
        data.devices.push(device);
      } else {
        device = data.devices.find(value => value.id === command.deviceId);
        if (!device) fail('Trackern finns inte.', 404, 'platform_fleet_not_found');
        if (device.pendingRequestId) fail('Trackern har redan en väntande åtgärd. Slutför den först.', 409, 'platform_fleet_pending');
        if (device.provisioningStatus === 'retired') fail('Trackern har avregistrerats och kan inte tilldelas igen.', 409, 'platform_fleet_retired');
        if (command.action === 'device.assign') {
          if (device.organisationId && device.organisationId !== command.organisationId) fail('En tilldelad tracker kan inte flyttas till ett annat bolag.', 409, 'platform_fleet_company_locked');
          if (!state.companies.some(value => value.id === command.organisationId && value.status === 'active')) fail('Välj ett aktivt registrerat bolag.', 404, 'platform_fleet_company_unavailable');
        }
      }
      const pending = command.action === 'device.assign' || command.action === 'device.retire' && Boolean(device.organisationId);
      const record = { requestId: command.requestId, fingerprint, command: clone(command), actorId: actor.actorId, actorName: actor.actorName, action: command.action,
        deviceId: device.id, status: pending ? 'pending' : 'completed', createdAt: actor.at,
        ...(pending && { organisationId: command.action === 'device.assign' ? command.organisationId : device.organisationId }) };
      data.requests.push(record); data.revision++;
      if (pending) { device.pendingRequestId = command.requestId; device.pendingOrganisationId = record.organisationId; }
      else if (command.action === 'device.retire') { device.active = false; device.provisioningStatus = 'retired'; device.updatedAt = actor.at; }
      event(data, actor, pending ? 'device.sync_pending' : command.action === 'device.register' ? 'device.registered' : 'device.retired', device, command.requestId);
      return clone(record);
    }, { write: true });
    if (reservation.status === 'pending') await settle(reservation.requestId);
    return auth.withPlatformAdminTransaction(req, state => {
      const data = registry(state), result = data.requests.find(value => value.requestId === reservation.requestId);
      if (result?.status !== 'completed') fail('Trackeråtgärden väntar på synkronisering.', 503, 'platform_fleet_copy_pending');
      return { ...view(state), result: { requestId: result.requestId, deviceId: result.deviceId, status: result.status } };
    }, { write: true });
  }
  return { read: req => auth.withPlatformAdminTransaction(req, state => view(state)), mutate,
    reconcile: async () => {
      if (closed) return [];
      const pending = await repository.read(state => registry(state).requests.filter(value => value.status === 'pending').slice(0, 25).map(value => value.requestId));
      return Promise.allSettled(pending.map(settle));
    }, close: () => { closed = true; return Promise.allSettled([...flights.values()]); } };
}
