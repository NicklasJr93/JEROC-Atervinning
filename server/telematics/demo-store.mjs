import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';

const streamSchema = z.string().uuid();
// DatabaseSync must not wait for a different handle whose async transaction
// needs this same event loop to continue. Coordinate handles for the real file.
const sqliteCoordinators = new Map();
const recordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), at: z.string().datetime(),
  lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180),
  speedKmh: z.number().finite().min(0).max(65535),
  rpm: z.number().finite().min(0).max(65535),
  fuelPercent: z.number().finite().min(0).max(100),
  coolantC: z.number().finite().min(-128).max(127),
  batteryVolts: z.number().finite().min(0).max(65.535),
  odometerMeters: z.number().int().min(0).max(0xffffffff),
  ignition: z.boolean(), movement: z.boolean(), tripActive: z.boolean(),
}).strict();

function failure(code, status = 503) {
  return Object.assign(new Error(code), { status, code });
}
function input(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw failure('demo_input_invalid', 422);
  return parsed.data;
}
function publicRecord(document) {
  const { id: _id, tripActive: _trip, ...record } = JSON.parse(document);
  return record;
}
const postgresSql = sql => { let index = 0; return sql.replaceAll('?', () => `$${++index}`); };

/** Dedicated synthetic demo storage. Never reads DATABASE_URL or tenant state.
 * Retention deletes whole inactive streams using server activity time. Keep
 * every ID while its stream is active so even old retries remain idempotent.
 * Counters describe committed unique records in FIFO receipt order.
 */
export async function createDemoTelematicsStore({ filename, databaseUrl,
  now = () => new Date(), maxStreams = 128, maxRecordsPerStream = 20000,
  maxTotalRecords = 200000, retentionMs = 24 * 60 * 60 * 1000 } = {}) {
  if (typeof now !== 'function' || [maxStreams, maxRecordsPerStream, maxTotalRecords, retentionMs]
    .some(value => !Number.isSafeInteger(value) || value < 1)
    || databaseUrl !== undefined && typeof databaseUrl !== 'string')
    throw failure('demo_input_invalid', 422);
  const kind = databaseUrl ? 'postgres' : 'sqlite';
  if (kind === 'postgres' && !/^postgres(?:ql)?:\/\//.test(databaseUrl)
    || kind === 'sqlite' && (typeof filename !== 'string' || !filename.trim()))
    throw failure('demo_input_invalid', 422);
  let db, pool, coordinator, databaseKey, closed = false, tail = Promise.resolve();
  const databaseOperation = operation => {
    if (!coordinator) return operation();
    const task = coordinator.tail.then(operation);
    coordinator.tail = task.catch(() => {});
    return task;
  };
  const releaseCoordinator = () => {
    if (coordinator && --coordinator.users === 0) sqliteCoordinators.delete(databaseKey);
  };
  const instant = () => {
    const value = new Date(now()).getTime();
    if (!Number.isSafeInteger(value)) throw failure('demo_input_invalid', 422);
    return value;
  };
  const serial = operation => {
    const task = tail.then(() => {
      if (closed) throw failure('demo_storage_unavailable');
      return operation();
    });
    tail = task.catch(() => {});
    return task;
  };
  function transaction(operation) { return databaseOperation(async () => {
    let client, begun = false;
    try {
      if (kind === 'postgres') client = await pool.connect();
      const query = async (sql, parameters = []) => {
        if (client) return (await client.query(postgresSql(sql), parameters)).rows;
        const statement = db.prepare(sql);
        return /^\s*SELECT\b/i.test(sql) ? statement.all(...parameters) : statement.run(...parameters);
      };
      if (client) await client.query('BEGIN'); else db.exec('BEGIN IMMEDIATE');
      begun = true;
      // All adapters serialize capacity checks with inserts. This advisory lock
      // also coordinates independent demo-service processes using the same DB.
      if (client) await client.query('SELECT pg_advisory_xact_lock(1731702284)');
      const result = await operation(query);
      if (client) await client.query('COMMIT'); else db.exec('COMMIT');
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { if (client) await client.query('ROLLBACK'); else db.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      }
      if (error.status && error.code?.startsWith('demo_')) throw error;
      throw failure('demo_storage_unavailable');
    } finally { client?.release(); }
  }); }
  try {
    if (kind === 'postgres') {
      pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000,
        statement_timeout: 5000, lock_timeout: 3000, query_timeout: 7000,
        application_name: 'scrappilot-demo-telematics' });
      pool.on('error', () => {}); // Calls surface availability without leaking connection details.
    } else {
      const path = resolve(filename);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path);
      await chmod(path, 0o600);
      databaseKey = await realpath(path);
      coordinator = sqliteCoordinators.get(databaseKey);
      if (!coordinator) {
        coordinator = { users: 0, tail: Promise.resolve() };
        sqliteCoordinators.set(databaseKey, coordinator);
      }
      coordinator.users += 1;
      await databaseOperation(() => db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;'));
    }
    await transaction(async query => {
      const integer = kind === 'postgres' ? 'BIGINT' : 'INTEGER';
      const real = kind === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
      const strict = kind === 'sqlite' ? ' STRICT' : '';
      await query(`CREATE TABLE IF NOT EXISTS demo_telematics_streams (
        stream_id TEXT PRIMARY KEY, created_at ${integer} NOT NULL, last_activity ${integer} NOT NULL,
        packets_received ${integer} NOT NULL DEFAULT 0, records_created ${integer} NOT NULL DEFAULT 0, last_received_at ${integer},
        first_odometer ${real}, max_odometer ${real}, last_trip_active INTEGER,
        trips ${integer} NOT NULL DEFAULT 0)${strict}`);
      await query(`CREATE TABLE IF NOT EXISTS demo_telematics_records (
        stream_id TEXT NOT NULL REFERENCES demo_telematics_streams(stream_id) ON DELETE CASCADE,
        record_id TEXT NOT NULL, record_no ${integer} NOT NULL, document TEXT NOT NULL, received_at ${integer} NOT NULL,
        PRIMARY KEY(stream_id,record_id), UNIQUE(stream_id,record_no))${strict}`);
      await query('CREATE INDEX IF NOT EXISTS demo_telematics_record_receipt ON demo_telematics_records(received_at)');
      await query('CREATE INDEX IF NOT EXISTS demo_telematics_stream_receipt ON demo_telematics_records(stream_id,record_no)');
      await query('CREATE INDEX IF NOT EXISTS demo_telematics_stream_activity ON demo_telematics_streams(last_activity)');
    });
  } catch (error) {
    db?.close(); releaseCoordinator(); if (pool) await pool.end();
    if (error.status) throw error;
    throw failure('demo_storage_unavailable');
  }
  async function cleanup(query, stamp) {
    await query('DELETE FROM demo_telematics_streams WHERE last_activity<=?', [stamp - retentionMs]);
  }
  const findStream = async (query, streamId) => {
    const [row] = await query('SELECT * FROM demo_telematics_streams WHERE stream_id=?', [streamId]);
    if (!row) throw failure('demo_stream_not_found', 404);
    return row;
  };
  return {
    kind,
    registerStream(streamId) {
      return serial(async () => {
        streamId = input(streamSchema, streamId);
        return transaction(async query => {
          const stamp = instant(); await cleanup(query, stamp);
          const [old] = await query('SELECT stream_id FROM demo_telematics_streams WHERE stream_id=?', [streamId]);
          if (!old) {
            const [count] = await query('SELECT COUNT(*) AS count FROM demo_telematics_streams');
            if (Number(count.count) >= maxStreams) throw failure('demo_capacity_reached', 429);
            await query('INSERT INTO demo_telematics_streams(stream_id,created_at,last_activity) VALUES(?,?,?)', [streamId, stamp, stamp]);
          }
          return { streamId };
        });
      });
    },
    ingest(streamId, records) {
      return serial(async () => {
        streamId = input(streamSchema, streamId);
        if (!Array.isArray(records) || records.length < 1 || records.length > 255) throw failure('demo_input_invalid', 422);
        const normalized = records.map(record => input(recordSchema, record));
        return transaction(async query => {
          const stamp = instant(); await cleanup(query, stamp);
          const stream = await findStream(query, streamId);
          const [scopeCount] = await query('SELECT COUNT(*) AS count FROM demo_telematics_records WHERE stream_id=?', [streamId]);
          const [totalCount] = await query('SELECT COUNT(*) AS count FROM demo_telematics_records');
          let inserted = 0, firstOdometer = stream.first_odometer === null ? null : Number(stream.first_odometer);
          let maxOdometer = stream.max_odometer === null ? null : Number(stream.max_odometer);
          let tripActive = stream.last_trip_active === null ? null : Number(stream.last_trip_active);
          let trips = Number(stream.trips);
          for (const record of normalized) {
            const document = JSON.stringify(record);
            const [old] = await query('SELECT document FROM demo_telematics_records WHERE stream_id=? AND record_id=?', [streamId, record.id]);
            if (old) {
              if (old.document !== document) throw failure('demo_record_conflict', 409);
              continue;
            }
            if (Number(scopeCount.count) + inserted >= maxRecordsPerStream || Number(totalCount.count) + inserted >= maxTotalRecords)
              throw failure('demo_capacity_reached', 429);
            await query('INSERT INTO demo_telematics_records(stream_id,record_id,record_no,document,received_at) VALUES(?,?,?,?,?)',
              [streamId, record.id, Number(stream.records_created) + inserted + 1, document, stamp]);
            inserted += 1;
            firstOdometer ??= record.odometerMeters;
            maxOdometer = Math.max(maxOdometer ?? record.odometerMeters, record.odometerMeters);
            if (tripActive === 1 && !record.tripActive) trips += 1;
            tripActive = Number(record.tripActive);
          }
          await query(`UPDATE demo_telematics_streams SET last_activity=?, packets_received=packets_received+1, records_created=records_created+?,
            last_received_at=?, first_odometer=?, max_odometer=?, last_trip_active=?, trips=? WHERE stream_id=?`,
          [stamp, inserted, stamp, firstOdometer, maxOdometer, tripActive, trips, streamId]);
          return { accepted: records.length, inserted };
        });
      });
    },
    summary(streamId) {
      return serial(async () => {
        streamId = input(streamSchema, streamId);
        return transaction(async query => {
          await cleanup(query, instant());
          const stream = await findStream(query, streamId);
          const [count] = await query('SELECT COUNT(*) AS count FROM demo_telematics_records WHERE stream_id=?', [streamId]);
          const rows = await query('SELECT document FROM demo_telematics_records WHERE stream_id=? ORDER BY record_no DESC LIMIT 10', [streamId]);
          const recentRecords = rows.reverse().map(row => publicRecord(row.document));
          return { simulated: true, streamId, storage: kind, recordsStored: Number(count.count),
            packetsReceived: Number(stream.packets_received),
            lastReceivedAt: stream.last_received_at === null ? null : new Date(Number(stream.last_received_at)).toISOString(),
            distanceKm: stream.first_odometer === null ? 0 : (Number(stream.max_odometer) - Number(stream.first_odometer)) / 1000,
            trips: Number(stream.trips), lastRecord: recentRecords.at(-1) ?? null, recentRecords };
        });
      });
    },
    ready() { return serial(() => transaction(async query => {
      await cleanup(query, instant());
      await query('SELECT 1');
      return true;
    })); },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      db?.close(); releaseCoordinator(); if (pool) await pool.end();
    },
  };
}
