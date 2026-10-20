import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const clone = value => structuredClone(value);
const unpack = value => typeof value === 'string' ? JSON.parse(value) : clone(value);
const terminal = new Set(['success', 'not_found', 'rejected', 'failed', 'unknown']);
const conflict = () => { throw Object.assign(new Error('Användningsoperationens tillstånd har ändrats.'), { code: 'platform_usage_state_conflict' }); };
function dispatch(record, { claimId, at, month, leaseUntil }) {
  if (record.claimId !== claimId || record.status !== 'reserved') return false;
  record.status = 'dispatched'; record.dispatchedAt = at; record.month = month; record.leaseUntil = leaseUntil;
  record.history.push({ status: 'dispatched', at }); return true;
}
function finish(record, { claimId, status, billableConfirmed, at }) {
  if (record.claimId !== claimId || !terminal.has(status)) conflict();
  if (record.status === status && record.completedAt) return false;
  if (record.status === 'reserved' && status !== 'rejected') conflict();
  if (!['reserved', 'dispatched', 'unknown'].includes(record.status)) conflict();
  record.status = status; record.billableConfirmed = Boolean(record.dispatchedAt && billableConfirmed);
  record.completedAt = at; delete record.leaseUntil;
  record.history.push({ status, at }); return true;
}

/** Separate relational ledger in the original control-plane database. No
 * tenant runtime/search_path may be passed here. SQL uniqueness is the dispatch
 * authority across processes; no network callback runs inside a transaction. */
export async function createPlatformUsageStorage({ env = process.env, filename } = {}) {
  if (env.RENDER && !env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL krävs för användningsjournalen.'), { status: 503 });
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, connectionTimeoutMillis: 8000 });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(1803299870)');
        await client.query('CREATE TABLE IF NOT EXISTS jeroc_platform_usage (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, operation_id TEXT NOT NULL, service TEXT NOT NULL, month TEXT NOT NULL, document JSONB NOT NULL, UNIQUE(company_id,operation_id,service))');
        await client.query('CREATE INDEX IF NOT EXISTS jeroc_platform_usage_month_company ON jeroc_platform_usage(month,company_id)');
        await client.query('CREATE TABLE IF NOT EXISTS jeroc_platform_usage_private (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint_key TEXT NOT NULL)');
        await client.query('INSERT INTO jeroc_platform_usage_private(id,fingerprint_key) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [randomBytes(32).toString('hex')]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) { await pool.end(); throw error; }
    async function mutate(key, input, change) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT document FROM jeroc_platform_usage WHERE company_id=$1 AND operation_id=$2 AND service=$3 FOR UPDATE', [key.organisationId, key.operationId, key.service]);
        if (!rows.length) conflict();
        const record = unpack(rows[0].document), changed = change(record, input);
        if (changed) await client.query('UPDATE jeroc_platform_usage SET month=$1,document=$2 WHERE id=$3', [record.month, JSON.stringify(record), record.id]);
        await client.query('COMMIT'); return { changed, record };
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    return {
      kind: 'postgresql',
      async fingerprintKey() { return (await pool.query('SELECT fingerprint_key FROM jeroc_platform_usage_private WHERE id=1')).rows[0].fingerprint_key; },
      async reserve(record) {
        const values = [record.id, record.organisationId, record.operationId, record.service, record.month, JSON.stringify(record)];
        const inserted = await pool.query('INSERT INTO jeroc_platform_usage(id,company_id,operation_id,service,month,document) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(company_id,operation_id,service) DO NOTHING RETURNING document', values);
        if (inserted.rows.length) return { created: true, record: unpack(inserted.rows[0].document) };
        const existing = await pool.query('SELECT document FROM jeroc_platform_usage WHERE company_id=$1 AND operation_id=$2 AND service=$3', [record.organisationId, record.operationId, record.service]);
        return { created: false, record: unpack(existing.rows[0].document) };
      },
      markDispatched: (key, input) => mutate(key, input, dispatch),
      finish: (key, input) => mutate(key, input, finish),
      async list({ month, organisationId } = {}) {
        const values = [month], company = organisationId ? ' AND company_id=$2' : ''; if (organisationId) values.push(organisationId);
        return (await pool.query(`SELECT document FROM jeroc_platform_usage WHERE month=$1${company} ORDER BY company_id,service,operation_id`, values)).rows.map(row => unpack(row.document));
      },
      close: () => pool.end(),
    };
  }
  const path = resolve(filename ?? env.JEROC_PLATFORM_DB_PATH ?? (env.JEROC_APPLICATION_DB_PATH ? `${dirname(env.JEROC_APPLICATION_DB_PATH)}/platform.sqlite` : fileURLToPath(new URL('../.data/platform.sqlite', import.meta.url))));
  await mkdir(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; CREATE TABLE IF NOT EXISTS jeroc_platform_usage(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,operation_id TEXT NOT NULL,service TEXT NOT NULL,month TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(company_id,operation_id,service)); CREATE INDEX IF NOT EXISTS jeroc_platform_usage_month_company ON jeroc_platform_usage(month,company_id); CREATE TABLE IF NOT EXISTS jeroc_platform_usage_private(id INTEGER PRIMARY KEY CHECK(id=1),fingerprint_key TEXT NOT NULL)');
  database.prepare('INSERT OR IGNORE INTO jeroc_platform_usage_private(id,fingerprint_key) VALUES(1,?)').run(randomBytes(32).toString('hex'));
  const select = database.prepare('SELECT document FROM jeroc_platform_usage WHERE company_id=? AND operation_id=? AND service=?');
  function transaction(operation) {
    // Deliberately synchronous: yielding while holding SQLite's write lock can
    // deadlock a second DatabaseSync connection in the same Node process.
    database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }
  function mutate(key, input, change) {
    return transaction(() => {
      const row = select.get(key.organisationId, key.operationId, key.service); if (!row) conflict();
      const record = unpack(row.document), changed = change(record, input);
      if (changed) database.prepare('UPDATE jeroc_platform_usage SET month=?,document=? WHERE id=?').run(record.month, JSON.stringify(record), record.id);
      return { changed, record };
    });
  }
  return {
    kind: 'sqlite',
    async fingerprintKey() { return database.prepare('SELECT fingerprint_key FROM jeroc_platform_usage_private WHERE id=1').get().fingerprint_key; },
    async reserve(record) {
      return transaction(() => {
        const inserted = database.prepare('INSERT OR IGNORE INTO jeroc_platform_usage(id,company_id,operation_id,service,month,document) VALUES(?,?,?,?,?,?)').run(record.id, record.organisationId, record.operationId, record.service, record.month, JSON.stringify(record));
        return { created: inserted.changes === 1, record: unpack(select.get(record.organisationId, record.operationId, record.service).document) };
      });
    },
    async markDispatched(key, input) { return mutate(key, input, dispatch); },
    async finish(key, input) { return mutate(key, input, finish); },
    async list({ month, organisationId } = {}) {
      const rows = organisationId ? database.prepare('SELECT document FROM jeroc_platform_usage WHERE month=? AND company_id=? ORDER BY company_id,service,operation_id').all(month, organisationId) : database.prepare('SELECT document FROM jeroc_platform_usage WHERE month=? ORDER BY company_id,service,operation_id').all(month);
      return rows.map(row => unpack(row.document));
    },
    async close() { database.close(); },
  };
}
