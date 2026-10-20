import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';

const sql = `CREATE TABLE IF NOT EXISTS jeroc_company_logos (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  record JSONB NOT NULL, image BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(company_id, content_hash)
);`;

/** Immutable pixels, scoped both by the tenant connection and explicit company.
 * Old assets are retained because frozen documents can still reference them. */
export async function createCompanyLogoRepository({ env = process.env, organisationId, filename } = {}) {
  if (typeof organisationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(organisationId)) throw new TypeError('Bolagets servervalda identitet krävs.');
  if (env.RENDER && !env.DATABASE_URL) throw new Error('Loggarkivet behöver DATABASE_URL i Render.');
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 });
    try {
      await runInDatabaseTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(1803299874)');
        await client.query(sql);
      });
    } catch (error) { await pool.end(); throw error; }
    return {
      kind: 'postgresql',
      insert: (record, bytes, beforeInsert) => runInDatabaseTransaction(pool, async client => {
        await beforeInsert?.();
        await client.query('INSERT INTO jeroc_company_logos(id,company_id,content_hash,record,image,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,content_hash) DO NOTHING',
          [record.id, organisationId, record.contentHash, JSON.stringify(record), bytes, record.createdAt]);
        const { rows } = await client.query('SELECT record FROM jeroc_company_logos WHERE company_id=$1 AND content_hash=$2', [organisationId, record.contentHash]);
        return rows[0].record;
      }),
      image: id => runDatabaseRead(pool, async client => {
        const { rows } = await client.query('SELECT record,image FROM jeroc_company_logos WHERE company_id=$1 AND id=$2', [organisationId, id]);
        return rows[0] ? { record: rows[0].record, bytes: Buffer.from(rows[0].image) } : undefined;
      }),
      close: () => pool.end(),
    };
  }
  const path = filename ?? env.JEROC_COMPANY_LOGO_DB_PATH ?? (env.JEROC_APPLICATION_DB_PATH
    ? resolve(dirname(env.JEROC_APPLICATION_DB_PATH), 'company-logo.sqlite')
    : fileURLToPath(new URL('../.data/company-logo.sqlite', import.meta.url)));
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;');
  database.exec(sql.replaceAll('JSONB', 'TEXT').replaceAll('BYTEA', 'BLOB').replaceAll('TIMESTAMPTZ', 'TEXT'));
  let tail = Promise.resolve();
  const run = operation => {
    const pending = tail.then(operation);
    tail = pending.catch(() => {});
    return pending;
  };
  return {
    kind: 'sqlite-development',
    insert: (record, bytes, beforeInsert) => run(async () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        await beforeInsert?.();
        database.prepare('INSERT OR IGNORE INTO jeroc_company_logos(id,company_id,content_hash,record,image,created_at) VALUES(?,?,?,?,?,?)')
          .run(record.id, organisationId, record.contentHash, JSON.stringify(record), bytes, record.createdAt);
        const row = database.prepare('SELECT record FROM jeroc_company_logos WHERE company_id=? AND content_hash=?').get(organisationId, record.contentHash);
        database.exec('COMMIT');
        return JSON.parse(row.record);
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    }),
    image: id => run(() => {
      const row = database.prepare('SELECT record,image FROM jeroc_company_logos WHERE company_id=? AND id=?').get(organisationId, id);
      return row ? { record: JSON.parse(row.record), bytes: Buffer.from(row.image) } : undefined;
    }),
    async close() { await tail; database.close(); },
  };
}
