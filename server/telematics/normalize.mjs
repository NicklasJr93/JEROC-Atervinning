import { createHash } from 'node:crypto';

// FTC134's own AVL table, not an assumed FMB/FMC mapping. 16 is a virtual
// odometer, in metres; this does not claim to be a vehicle ECU reading.
export const FTC134_IO = Object.freeze({ ignition: 239, movement: 240, odometerMeters: 16 });

function unsigned(io, id, bytes) {
  const hex = io[id];
  if (hex === undefined) return undefined;
  if (typeof hex !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(hex))
    throw new Error('telematics_signal_invalid');
  return Number.parseInt(hex, 16);
}
function flag(io, id) {
  const value = unsigned(io, id, 1);
  if (value === undefined) return undefined;
  if (value !== 0 && value !== 1) throw new Error('telematics_signal_invalid');
  return value === 1;
}

/** Privacy boundary. Never persist GPS, raw packets, unrecognised I/O or
 * a latched iButton/private-mode value as a fresh user action. Panel/app
 * events require a later, separately authenticated adapter. */
export function normalizeFtc134Records(records) {
  return records.map(record => {
    const at = new Date(record.at);
    if (!Number.isFinite(at.getTime())) throw new Error('telematics_timestamp_invalid');
    const io = record.io ?? {};
    const canonical = { at: at.toISOString(), priority: record.priority, gps: record.gps,
      eventIoId: record.eventIoId, io: Object.fromEntries(Object.entries(io).sort(([a], [b]) => Number(a) - Number(b))) };
    const id = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const result = { id, at: at.toISOString(), source: 'tracker' };
    const ignition = flag(io, FTC134_IO.ignition), movement = flag(io, FTC134_IO.movement);
    const odometerMeters = unsigned(io, FTC134_IO.odometerMeters, 4);
    if (ignition !== undefined) result.ignition = ignition;
    if (movement !== undefined) result.movement = movement;
    if (odometerMeters !== undefined) result.odometerMeters = odometerMeters;
    return result;
  });
}
