import { createHash } from 'node:crypto';
import { decodeCodec8EFrame } from './telematics/codec8e.mjs';
import { ingestFleetTelemetry } from './fleet-telematics.mjs';
import { fleetCapabilities } from './fleet.mjs';
import { resolvePricingPrincipal } from './pricing.mjs';

const fail = (message, status = 409, code = 'fleet_simulator_conflict') => {
  throw Object.assign(new Error(message), { status, code });
};
const hash = value => createHash('sha256').update(value).digest('hex');
const contextKey = context => JSON.stringify([context.sessionKey, context.generation, context.actualUser.id, context.user.id]);
const json = (res, value) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(value));
};
function principal(state, context) {
  const result = resolvePricingPrincipal(state.pricing.users, context.actualUser.id, context.user.id);
  const capabilities = fleetCapabilities(result);
  if (!capabilities.read || !capabilities.write || [result.actor, result.user].some(user => Array.isArray(user.siteIds)))
    fail('Företagskopplingen kräver läs- och skrivrätt för hela fordonsregistret.', 403, 'fleet_simulator_forbidden');
  return result;
}
function device(state, organisationId, id) {
  const row = state.fleet?.devices?.find(value => value.id === id && value.organisationId === organisationId);
  if (!row?.active || row.source !== 'simulator') fail('Välj en aktiv simulatorenhet som plattformen tilldelat bolaget.', 403, 'fleet_simulator_device_forbidden');
  if (state.metadata?.organisation?.id && state.metadata.organisation.id !== organisationId)
    fail('Bolaget har ändrats.', 403, 'fleet_simulator_company_changed');
  return row;
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) fail('Skicka JSON.', 415, 'fleet_simulator_json_required');
  if (Number(req.headers['content-length'] ?? 0) > 2048) { req.resume(); fail('Kommandot är för stort.', 413); }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const timer = setTimeout(() => finish(Object.assign(new Error('Kommandot tog för lång tid.'), { status: 408 })), 10000); timer.unref();
    function finish(error, value) {
      if (done) return; done = true; clearTimeout(timer);
      if (error) { req.resume(); reject(error); } else resolve(value);
    }
    req.on('data', chunk => { size += chunk.length; if (size > 2048) finish(Object.assign(new Error('Kommandot är för stort.'), { status: 413 })); else chunks.push(chunk); });
    req.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(Object.assign(new Error('Ogiltigt JSON.'), { status: 400 })); } });
    req.on('error', () => finish(Object.assign(new Error('Anropet avbröts.'), { status: 400 })));
    req.on('aborted', () => finish(Object.assign(new Error('Anropet avbröts.'), { status: 400 })));
  });
}
function number(io, id, width, signed = false) {
  if (io[id] === undefined) return undefined;
  if (!new RegExp(`^[a-f0-9]{${width * 2}}$`, 'i').test(io[id])) fail('Ogiltig FMC003-signal.', 422);
  const value = Buffer.from(io[id], 'hex');
  return signed ? value.readIntBE(0, width) : value.readUIntBE(0, width);
}
function flag(io, id) {
  const value = number(io, id, 1);
  if (value !== undefined && value !== 0 && value !== 1) fail('Ogiltig FMC003-signal.', 422);
  return value === undefined ? undefined : value === 1;
}

/** Only decoded, acknowledged server-generated FMC003 frames enter here.
 * The accelerated simulator clock is mapped onto ordered server receipt time;
 * the real-device ingest clock checks remain unchanged. Missing IO stays absent.
 */
export function normalizeSimulatorFrame(bytes, { ownerHash, mappedAt }) {
  return decodeCodec8EFrame(bytes, { maxRecords: 100 }).records.map((row, index) => {
    const record = { id: `sim:${ownerHash.slice(0, 16)}:${hash(bytes)}:${index}`, at: new Date(mappedAt + index).toISOString(),
      lat: row.gps.latitude, lng: row.gps.longitude, speedKmh: row.gps.speedKmh };
    const values = { ignition: flag(row.io, 239), movement: flag(row.io, 240), odometerMeters: number(row.io, 16, 4),
      rpm: number(row.io, 36, 2), fuelPercent: number(row.io, 48, 1), coolantC: number(row.io, 32, 1, true),
      batteryVolts: number(row.io, 66, 2) };
    if (values.batteryVolts !== undefined) values.batteryVolts /= 1000;
    for (const [key, value] of Object.entries(values)) if (value !== undefined) record[key] = value;
    return record;
  });
}

export function createFleetSimulatorBridge({ testCarApi, now = Date.now, leaseMs = 60000, heartbeatMs = 20000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!testCarApi) return async () => false;
  function claim(state, link, { reserve = false } = {}) {
    const row = device(state, link.organisationId, link.deviceId);
    const claims = state.fleet.simulatorClaims ??= {};
    const old = Object.hasOwn(claims, link.deviceId) ? claims[link.deviceId] : undefined, time = now();
    if ((!old || old.ownerHash !== link.ownerHash) && (row.ignition === true || row.tripState === 'active'
      || row.lastContactAt && (row.ignition !== false || row.tripState !== 'idle')))
      fail('Enhetens tidigare resa måste avslutas och motorstatus bekräftas före en ny testbil.', 409, 'fleet_simulator_claimed');
    if (old && old.ownerHash !== link.ownerHash) {
      if (!reserve || link.everClaimed) fail('Simulatorenheten har kopplats till en annan testbil.', 409, 'fleet_simulator_lease_lost');
      if (Date.parse(old.expiresAt) > time || row.ignition !== false || row.tripState !== 'idle')
        fail('Simulatorenheten används av en annan testbil eller har en oavslutad resa.', 409, 'fleet_simulator_claimed');
    } else if (!old && !reserve) fail('Företagskopplingen har avslutats.', 409, 'fleet_simulator_lease_lost');
    Object.defineProperty(claims, link.deviceId, { value: { ownerHash: link.ownerHash, expiresAt: new Date(time + leaseMs).toISOString() },
      enumerable: true, writable: true, configurable: true });
  }
  async function transact(link, operation, reserve = false) {
    if (!link.active) fail('Företagskopplingen har avslutats.', 409, 'fleet_simulator_disconnected');
    const current = await link.reauthorize();
    if (!link.active) fail('Företagskopplingen har avslutats.', 409, 'fleet_simulator_disconnected');
    return link.repository.transact((state, _, audit) => {
      if (!link.active) fail('Företagskopplingen har avslutats.', 409, 'fleet_simulator_disconnected');
      principal(state, current); claim(state, link, { reserve });
      return operation?.(state, audit);
    });
  }
  function makeLink(session, context, repository, reauthorize, deviceId) {
    const link = { deviceId, organisationId: context.company.id, ownerHash: hash(session.token), active: true,
      contextKey: contextKey(context),
      status: 'error', lastSentAt: null, error: 'Inväntar bekräftad motor-av-kontakt.', lastHeartbeat: 0,
      repository, reauthorize, maps: new Map(), lastMappedAt: 0 };
    link.receive = async bytes => {
      try {
        if (!link.active) fail('Företagskopplingen har avslutats.');
        const key = hash(bytes);
        let records = link.maps.get(key);
        if (!records) {
          if (link.maps.size >= 4096) fail('Testkopplingens gräns har nåtts. Koppla från med motorn av.', 503);
          const count = decodeCodec8EFrame(bytes, { maxRecords: 100 }).records.length;
          // An explicit reconnect can retry a previously committed frame.
          // Recover its original receipt-clock mapping from durable events.
          const firstId = `sim:${link.ownerHash.slice(0, 16)}:${key}:0`;
          const persistedAt = await repository.read(state => state.fleet?.telemetryEvents?.find(row => row.deviceId === deviceId && row.id === firstId)?.at);
          const mappedAt = persistedAt ? Date.parse(persistedAt) : Math.max(now() - count + 1, link.lastMappedAt + 1);
          records = normalizeSimulatorFrame(bytes, { ownerHash: link.ownerHash, mappedAt });
          link.lastMappedAt = Math.max(link.lastMappedAt, mappedAt + count - 1); link.maps.set(key, records);
        }
        // Keep strict ordering even if an offline buffer drains within one
        // millisecond. At most 100 ms per normal packet, never simulated future.
        const wait = Date.parse(records.at(-1).at) - now();
        if (wait > 1000) fail('Invänta mottagarens klocka.', 503);
        if (wait > 0) await sleep(wait);
        await transact(link, (state, audit) => ingestFleetTelemetry(state, { deviceId, source: 'simulator', records },
          { organisationId: link.organisationId, now, audit }));
        link.status = 'connected'; link.error = undefined; link.lastSentAt = new Date(now()).toISOString(); link.lastHeartbeat = now();
      } catch (error) {
        link.status = 'error'; link.error = 'Företagskopplingen kunde inte verifieras. Paketet väntar på nytt försök.';
        throw error;
      }
    };
    link.dispose = async () => {
      if (!link.active) return; link.active = false;
      await repository.transact(state => {
        const claims = state.fleet?.simulatorClaims;
        if (claims?.[deviceId]?.ownerHash === link.ownerHash) delete claims[deviceId];
      });
    };
    return link;
  }
  const publicLink = link => link && ({ deviceId: link.deviceId, status: link.status,
    lastSentAt: link.lastSentAt, ...(link.error && { error: link.error }) });
  async function projection(repository, context, session) {
    return repository.read(state => {
      principal(state, context);
      const devices = (state.fleet?.devices ?? []).filter(row => row.organisationId === context.company.id && row.active && row.source === 'simulator').map(row => {
        const binding = state.fleet.bindings?.find(value => value.deviceId === row.id && value.endAt === null);
        return { id: row.id, name: row.name, vehicleId: binding?.vehicleId ?? null, status: binding ? 'linked' : 'available' };
      });
      const link = session.fleetSink;
      return { companyName: context.company.name, devices,
        ...(link?.organisationId === context.company.id && { link: publicLink(link) }) };
    });
  }
  return async (req, res, url, { context, repository, reauthorize }) => {
    if (url.pathname !== '/api/testcar/fleet') return false;
    if (!['GET', 'POST'].includes(req.method)) fail('Metoden stöds inte.', 405);
    const session = testCarApi.fleetSession(req, { write: req.method === 'POST' });
    await repository.read(state => principal(state, context));
    if (req.method === 'POST') {
      const command = await body(req);
      if (!command || typeof command !== 'object' || Array.isArray(command) || !['connect', 'disconnect'].includes(command.action)
        || Object.keys(command).some(key => !['action', 'deviceId'].includes(key))
        || command.action === 'connect' && (typeof command.deviceId !== 'string' || !/^[a-zA-Z0-9_:-]{1,120}$/.test(command.deviceId))
        || command.action === 'disconnect' && command.deviceId !== undefined) fail('Välj anslutning eller frånkoppling.', 422, 'fleet_simulator_invalid');
      // Recheck after reading the body; another request can start or expire the
      // laboratory while this one is arriving.
      testCarApi.fleetSession(req, { write: true });
      if (session.car.snapshot().engineOn) fail('Stäng av motorn före anslutning eller frånkoppling.', 409, 'testcar_fleet_engine_on');
      if (session.fleetBusy) fail('En företagskoppling uppdateras redan.', 409);
      session.fleetBusy = true;
      try {
        const old = session.fleetSink;
        if (old && old.organisationId !== context.company.id) fail('Kopplingen hör till ett annat bolag. Återgå och koppla från först.', 409);
        if (command.action === 'disconnect') {
          if (old) {
            const snapshot = session.car.snapshot();
            if (snapshot.device.pendingRecords || snapshot.device.sending)
              fail('Invänta kvittensen för testbilens sista paket före frånkoppling.', 409, 'fleet_simulator_pending');
            const current = await reauthorize();
            await repository.transact(state => {
              principal(state, current);
              const row = device(state, old.organisationId, old.deviceId);
              if (row.ignition !== false || row.tripState !== 'idle' || !row.observationAt
                || now() - Date.parse(row.observationAt) > 5 * 60000 || Date.parse(row.observationAt) > now())
                fail('Invänta bekräftad färsk motor-av-kontakt i bolagets mottagare.', 409, 'fleet_simulator_motor_unknown');
              const claims = state.fleet.simulatorClaims;
              if (claims?.[old.deviceId]?.ownerHash === old.ownerHash) delete claims[old.deviceId];
            });
            old.active = false; testCarApi.setFleetSink(req, null);
          }
        } else {
          if (old && old.deviceId !== command.deviceId) fail('Koppla från den befintliga enheten först.', 409);
          const snapshot = session.car.snapshot();
          if (!snapshot.networkOnline || !old && (snapshot.device.pendingRecords || snapshot.device.sending))
            fail('Invänta testbilens paketkvittens och anslut dess nätverk först.', 409, 'fleet_simulator_pending');
          const link = old ?? makeLink(session, context, repository, reauthorize, command.deviceId);
          // Explicit connect may renew a revoked captured login for this same
          // browser/device. GET, ticks and ordinary packet retries never do so.
          if (old) link.reauthorize = reauthorize;
          await transact(link, undefined, true);
          link.everClaimed = true; link.contextKey = contextKey(context);
          if (!old) testCarApi.setFleetSink(req, link);
          if (snapshot.device.pendingRecords || snapshot.device.sending) session.car.command({ action: 'network', online: true });
          else try { await session.car.prime(); } catch { /* Expose uncertain link; never silently retry a connect POST. */ }
        }
      } finally { session.fleetBusy = false; }
    } else {
      const link = session.fleetSink;
      if (link && link.organisationId === context.company.id && link.contextKey !== contextKey(context)) {
        link.status = 'error'; link.error = 'Inloggningen eller bolagsvalet har ändrats. Återanslut uttryckligen med motorn av.';
      } else if (link && link.organisationId === context.company.id && now() - link.lastHeartbeat >= heartbeatMs && !session.fleetBusy) {
        session.fleetBusy = true;
        try {
          await transact(link); link.lastHeartbeat = now();
          const snapshot = session.car.snapshot();
          if (!snapshot.engineOn && !snapshot.device.pendingRecords && !snapshot.device.sending && snapshot.networkOnline) await session.car.prime();
        } catch { link.status = 'error'; link.error = 'Företagskopplingen behöver verifieras igen eller kopplas från med motorn av.'; }
        finally { session.fleetBusy = false; }
      }
    }
    json(res, await projection(repository, context, session));
    return true;
  };
}
