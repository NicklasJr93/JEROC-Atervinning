import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export const initialPlatformState = () => ({ version: 1, companies: [], users: [], memberships: [], sessions: [], selections: [], attempts: [], creations: [], initialPasswordResets: [], passwordRecovery: { requests: [], attempts: [] }, audit: [] });
const clone = value => structuredClone(value);
const unpack = value => {
  const result = typeof value === 'string' ? JSON.parse(value) : value;
  if (!result || result.version !== 1) throw new Error('Plattformsregistrets version stöds inte.');
  return result;
};

/** Control-plane storage uses the original deployment database/search_path.
 * Tenant runtime pools must never be passed here. Only hashes, not session or
 * temporary-password plaintext, are durable. All reservations are atomic. */
export async function createPlatformStorage({ env = process.env, filename } = {}) {
  if (env.RENDER && !env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL krävs för plattformsregistret.'), { status: 503 });
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(1803299869)');
        await client.query('CREATE TABLE IF NOT EXISTS jeroc_platform_registry (id INTEGER PRIMARY KEY CHECK(id=1), document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        await client.query('INSERT INTO jeroc_platform_registry(id,document) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(initialPlatformState())]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) { await pool.end(); throw error; }
    return {
      kind: 'postgresql',
      async read(operation) {
        const { rows } = await pool.query('SELECT document FROM jeroc_platform_registry WHERE id=1');
        return operation(clone(unpack(rows[0]?.document)));
      },
      async transact(operation) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT document FROM jeroc_platform_registry WHERE id=1 FOR UPDATE');
          const state = clone(unpack(rows[0]?.document));
          const result = await operation(state);
          await client.query('UPDATE jeroc_platform_registry SET document=$1,updated_at=NOW() WHERE id=1', [JSON.stringify(state)]);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  const path = resolve(filename ?? env.JEROC_PLATFORM_DB_PATH ?? (env.JEROC_APPLICATION_DB_PATH ? `${dirname(env.JEROC_APPLICATION_DB_PATH)}/platform.sqlite` : fileURLToPath(new URL('../.data/platform.sqlite', import.meta.url))));
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; CREATE TABLE IF NOT EXISTS jeroc_platform_registry(id INTEGER PRIMARY KEY CHECK(id=1),document TEXT NOT NULL)');
  database.prepare('INSERT OR IGNORE INTO jeroc_platform_registry(id,document) VALUES(1,?)').run(JSON.stringify(initialPlatformState()));
  let tail = Promise.resolve();
  return {
    kind: 'sqlite',
    async read(operation) { await tail; return operation(clone(unpack(database.prepare('SELECT document FROM jeroc_platform_registry WHERE id=1').get()?.document))); },
    transact(operation) {
      const pending = tail.then(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const state = clone(unpack(database.prepare('SELECT document FROM jeroc_platform_registry WHERE id=1').get()?.document));
          const result = await operation(state);
          database.prepare('UPDATE jeroc_platform_registry SET document=? WHERE id=1').run(JSON.stringify(state));
          database.exec('COMMIT'); return result;
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      });
      tail = pending.catch(() => undefined); return pending;
    },
    async close() { await tail; database.close(); },
  };
}
