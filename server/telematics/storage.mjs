import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime(),
  source: z.literal('tracker'), ignition: z.boolean().optional(), movement: z.boolean().optional(),
  odometerMeters: z.number().int().nonnegative().max(0xffffffff).optional(),
}).strict();
const provisionSchema = z.object({
  imei: z.string().regex(/^\d{15}$/), tenantId: identifier, vehicleId: identifier,
  // Optional capacity metadata only. There is no RFID/button hardware adapter yet.
  driverPanel: z.boolean().default(false),
  certificateFingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
}).strict();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const parse = (schema, value) => {
  const result = schema.safeParse(value);
  if (!result.success) fail('telematics_input_invalid');
  return result.data;
};

/** Isolated SQLite pilot, deliberately not wired into the web server.
 * Trusted code supplies a resolver for the existing company/vehicle registry.
 * These methods must never be exposed as an unauthenticated HTTP API.
 * Every query carries a tenant boundary; a device binding cannot be moved.
 * High-rate production storage/retention needs its own PostgreSQL adapter. */
export async function createTelematicsStore({ filename, resolveVehicle, now = () => new Date(), maxRecordsPerDevice = 50000 } = {}) {
  if (!filename || typeof resolveVehicle !== 'function') fail('telematics_trusted_registry_required');
  if (!Number.isInteger(maxRecordsPerDevice) || maxRecordsPerDevice < 1) fail('telematics_limit_invalid');
  const path = resolve(filename);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS telematics_devices (
        id TEXT PRIMARY KEY, imei TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
        driver_panel INTEGER NOT NULL CHECK(driver_panel IN (0,1)), certificate_fingerprint TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(id,tenant_id,vehicle_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS telematics_records (
        device_id TEXT NOT NULL, record_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL, at TEXT NOT NULL, document TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY(device_id,record_id),
        FOREIGN KEY(device_id,tenant_id,vehicle_id) REFERENCES telematics_devices(id,tenant_id,vehicle_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS telematics_device_scope ON telematics_devices(tenant_id,vehicle_id);
      CREATE INDEX IF NOT EXISTS telematics_record_scope ON telematics_records(tenant_id,device_id,at,record_id);`);
  } catch (error) { db.close(); throw error; }
  let closed = false;
  const ready = () => { if (closed) fail('telematics_store_closed'); };
  const project = row => row && ({ id: row.id, imei: row.imei, tenantId: row.tenant_id, vehicleId: row.vehicle_id,
    active: row.active === 1, driverPanel: row.driver_panel === 1, generation: row.generation,
    ...(row.certificate_fingerprint && { certificateFingerprint: row.certificate_fingerprint }) });
  const byId = id => db.prepare('SELECT * FROM telematics_devices WHERE id=?').get(id);
  function scope(tenantId, deviceId) {
    identifier.parse(tenantId); identifier.parse(deviceId);
    const row = db.prepare('SELECT * FROM telematics_devices WHERE tenant_id=? AND id=?').get(tenantId, deviceId);
    if (!row) fail('telematics_device_not_found');
    return row;
  }
  async function verifyReference(tenantId, vehicleId) {
    const reference = await resolveVehicle({ tenantId, vehicleId });
    ready();
    if (!reference || reference.tenantId !== tenantId || reference.vehicleId !== vehicleId || reference.active !== true)
      fail('telematics_vehicle_not_verified');
    // Only the trusted company registry may supply a default person. A tracker
    // never supplies or modifies this association. Inactive people give no default.
    if (reference.defaultDriver) {
      if (reference.defaultDriver.tenantId !== tenantId) fail('telematics_driver_not_verified');
      parse(identifier, reference.defaultDriver.id);
    }
    return reference.defaultDriver?.active === true ? reference.defaultDriver.id : undefined;
  }
  return {
    async registerDevice(value) {
      ready(); const input = parse(provisionSchema, value);
      // Resolve against canonical registry, not against information supplied by a tracker.
      await verifyReference(input.tenantId, input.vehicleId);
      const prior = db.prepare('SELECT * FROM telematics_devices WHERE imei=?').get(input.imei);
      if (prior) {
        const existing = project(prior);
        if (existing.tenantId !== input.tenantId || existing.vehicleId !== input.vehicleId
          || existing.driverPanel !== input.driverPanel || existing.certificateFingerprint !== input.certificateFingerprint?.toLowerCase())
          fail('telematics_device_already_bound');
        return existing;
      }
      const id = `tracker-${randomUUID()}`;
      db.prepare(`INSERT INTO telematics_devices(id,imei,tenant_id,vehicle_id,active,driver_panel,certificate_fingerprint,created_at)
        VALUES(?,?,?,?,1,?,?,?)`).run(id, input.imei, input.tenantId, input.vehicleId, Number(input.driverPanel),
          input.certificateFingerprint?.toLowerCase() ?? null, now().toISOString());
      return project(byId(id));
    },
    // Server-internal lookup only: an IMEI is an identifier, not proof of identity.
    async lookupDevice(imei) {
      ready(); if (!/^\d{15}$/.test(imei)) return undefined;
      const row = db.prepare('SELECT * FROM telematics_devices WHERE imei=? AND active=1').get(imei);
      if (!row) return undefined;
      await verifyReference(row.tenant_id, row.vehicle_id);
      const current = project(byId(row.id));
      return current?.active ? current : undefined;
    },
    async setDeviceActive({ tenantId, deviceId, active }) {
      ready(); scope(tenantId, deviceId);
      if (typeof active !== 'boolean') fail('telematics_input_invalid');
      db.prepare('UPDATE telematics_devices SET active=?,generation=generation+1 WHERE tenant_id=? AND id=?').run(Number(active), tenantId, deviceId);
    },
    async ingest(binding, records) {
      ready();
      if (!Array.isArray(records) || records.length < 1 || records.length > 255) fail('telematics_batch_invalid');
      const normalized = records.map(record => parse(recordSchema, record));
      // Recheck the live canonical registry, not merely the original enrollment.
      const bound = project(byId(binding?.id));
      if (!bound) fail('telematics_binding_changed');
      const defaultDriverId = await verifyReference(bound.tenantId, bound.vehicleId);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = project(byId(binding?.id));
        if (!current?.active || current.tenantId !== binding.tenantId || current.vehicleId !== binding.vehicleId
          || current.imei !== binding.imei || current.generation !== binding.generation
          || current.certificateFingerprint !== binding.certificateFingerprint)
          fail('telematics_binding_changed');
        const count = Number(db.prepare('SELECT COUNT(*) AS count FROM telematics_records WHERE device_id=?').get(current.id).count);
        const insert = db.prepare(`INSERT INTO telematics_records(device_id,record_id,tenant_id,vehicle_id,at,document,received_at)
          VALUES(?,?,?,?,?,?,?)`);
        let inserted = 0;
        for (const record of normalized) {
          const baseDocument = JSON.stringify(record);
          const old = db.prepare('SELECT document FROM telematics_records WHERE device_id=? AND record_id=?').get(current.id, record.id);
          if (old) {
            // A later default-driver edit must not rewrite history or stop ACKs
            // for a previously committed tracker record.
            const { defaultDriverId: _snapshot, ...previousSignals } = JSON.parse(old.document);
            if (JSON.stringify(previousSignals) !== baseDocument) fail('telematics_record_conflict');
            continue;
          }
          if (count + inserted >= maxRecordsPerDevice) fail('telematics_pilot_capacity_reached');
          const document = JSON.stringify({ ...record, ...(defaultDriverId && { defaultDriverId }) });
          insert.run(current.id, record.id, current.tenantId, current.vehicleId, record.at, document, now().toISOString());
          inserted++;
        }
        db.exec('COMMIT');
        return { accepted: records.length, inserted };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async listRecords({ tenantId, deviceId, limit = 500, after } = {}) {
      ready(); scope(tenantId, deviceId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) fail('telematics_limit_invalid');
      if (after) parse(z.object({ at: z.string().datetime(), id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), after);
      const rows = db.prepare(`SELECT document,at,record_id FROM telematics_records
        WHERE tenant_id=? AND device_id=? AND (at>? OR (at=? AND record_id>?))
        ORDER BY at,record_id LIMIT ?`).all(tenantId, deviceId, after?.at ?? '', after?.at ?? '', after?.id ?? '', limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { records: page.map(row => JSON.parse(row.document)),
        next: rows.length > limit ? { at: last.at, id: last.record_id } : null };
    },
    close() { if (!closed) { closed = true; db.close(); } },
  };
}
