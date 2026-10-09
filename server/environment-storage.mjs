import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class EnvironmentError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

export const ENVIRONMENT_DEMO_GENERATION = 'demo-weighings-2026-10-09-v2';
export const initialEnvironmentState = () => ({
  schemaVersion: 1, revision: 0, demoGeneration: ENVIRONMENT_DEMO_GENERATION,
  credentials: [], sessions: [], classifications: [], drafts: [], receipts: [], corrections: [], inventory: [],
  reports: [], requests: [], audit: [], loginAttempts: [],
});
const entities = ['credentials', 'sessions', 'classifications', 'drafts', 'receipts', 'corrections', 'inventory', 'reports', 'requests', 'audit'];
const table = (name) => `jeroc_environment_${name}`;
const metadata = (state) => Object.fromEntries(Object.entries(state).filter(([key]) => !entities.includes(key)));
const entityKey = (name, value) => name === 'credentials' ? value.userId
  : name === 'sessions' ? value.tokenHash
    : name === 'classifications' ? `${value.articleId}:${value.version}` : value.id;
const immutableEntities = ['classifications', 'receipts', 'corrections', 'inventory', 'audit'];
function demandImmutable(state, previous, allowRewrite) {
  if (allowRewrite) return;
  for (const name of immutableEntities) {
    const current = new Map(state[name].map((record) => [entityKey(name, record), JSON.stringify(record)]));
    for (const [key, original] of previous[name]) if (current.get(key) !== original)
      throw new EnvironmentError('Ett sparat miljöoriginal kan inte skrivas över eller raderas.', 409, 'immutable_record');
  }
}

function migrateState(state) {
  if (state.schemaVersion !== 1) throw new EnvironmentError('Miljödatabasens version stöds inte.', 503, 'schema_version');
  for (const key of entities) if (!Array.isArray(state[key])) state[key] = [];
  state.loginAttempts ??= [];
  // Explicitly authorized weighing-demo reset. Master classifications and
  // personal credentials/session records survive, and the reset runs once.
  if (state.demoGeneration !== ENVIRONMENT_DEMO_GENERATION) {
    state.drafts = []; state.receipts = []; state.corrections = []; state.inventory = []; state.reports = [];
    state.requests = []; state.audit = [];
    state.demoGeneration = ENVIRONMENT_DEMO_GENERATION;
    state.revision += 1;
  }
  return state;
}

function decodeBackup(value) {
  let state;
  try { state = JSON.parse(value); } catch { throw new EnvironmentError('Säkerhetskopian är ogiltig.'); }
  // Older Etapp 1 backups legitimately have no drafts/corrections yet.
  if (state && state.schemaVersion === 1) { state.drafts ??= []; state.corrections ??= []; }
  if (!state || state.schemaVersion !== 1 || entities.some((name) => !Array.isArray(state[name])))
    throw new EnvironmentError('Säkerhetskopians struktur eller version är ogiltig.');
  if (new Set(state.receipts.map((receipt) => receipt.sourceId)).size !== state.receipts.length)
    throw new EnvironmentError('Säkerhetskopian innehåller dubbla mottagningar.');
  const receipts = new Set(state.receipts.map((receipt) => receipt.id));
  if ([...state.inventory, ...state.reports].some((record) => !receipts.has(record.receiptId)))
    throw new EnvironmentError('Säkerhetskopian saknar en mottagning.');
  if (state.corrections.some((record) => !receipts.has(record.receiptId)) || new Set(state.corrections.map((record) => `${record.receiptId}:${record.version}`)).size !== state.corrections.length)
    throw new EnvironmentError('Säkerhetskopians miljörättelser är ogiltiga.');
  return migrateState(state);
}

/** Only persistent databases are supported. SQLite is local development only;
 * Render must use PostgreSQL. New data never falls back to server memory. */
export async function createEnvironmentRepository({ env = process.env, filename } = {}) {
  if (!env.DATABASE_URL && env.RENDER) throw new EnvironmentError(
    'Miljöunderlag behöver PostgreSQL. Lägg till DATABASE_URL i Render.', 503, 'setup_required',
  );
  const migration = await readFile(fileURLToPath(new URL('./migrations/environment-001.sql', import.meta.url)), 'utf8');
  const followupMigration = await readFile(fileURLToPath(new URL('./migrations/environment-002.sql', import.meta.url)), 'utf8');
  let repository;
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5, connectionTimeoutMillis: 8000 });
    let migrationClient;
    try {
      migrationClient = await pool.connect();
      await migrationClient.query('BEGIN');
      // Serialize first deployment migrations across multiple server instances.
      await migrationClient.query('SELECT pg_advisory_xact_lock(1803299841)');
      await migrationClient.query(migration);
      await migrationClient.query(followupMigration);
      await migrationClient.query('INSERT INTO jeroc_environment_meta (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(metadata(initialEnvironmentState()))]);
      await migrationClient.query('COMMIT');
    } catch (error) {
      if (migrationClient) { await migrationClient.query('ROLLBACK').catch(() => {}); migrationClient.release(); }
      await pool.end(); throw error;
    }
    migrationClient.release();
    repository = {
      kind: 'postgresql',
      async transact(callback, { allowImmutableRewrite = false } = {}) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT data FROM jeroc_environment_meta WHERE id = 1 FOR UPDATE');
          const state = rows[0].data;
          const previous = {};
          for (const name of entities) {
            const records = (await client.query(`SELECT id, data FROM ${table(name)}`)).rows;
            state[name] = records.map((row) => row.data);
            previous[name] = new Map(records.map((row) => [row.id, JSON.stringify(row.data)]));
          }
          const generationReset = state.demoGeneration !== ENVIRONMENT_DEMO_GENERATION;
          migrateState(state);
          const result = await callback(state);
          demandImmutable(state, previous, allowImmutableRewrite || generationReset);
          // Remove dependent rows before parents during an explicit reset/restore.
          for (const name of [...entities].reverse()) {
            const keys = new Set(state[name].map((record) => entityKey(name, record)));
            for (const key of previous[name].keys()) if (!keys.has(key)) await client.query(`DELETE FROM ${table(name)} WHERE id = $1`, [key]);
          }
          for (const name of entities) for (const record of state[name]) {
            const key = entityKey(name, record), serialized = JSON.stringify(record);
            if (previous[name].get(key) === serialized) continue;
            if (name === 'receipts') await client.query(`INSERT INTO ${table(name)} (id, source_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET source_id = EXCLUDED.source_id, data = EXCLUDED.data`, [key, record.sourceId, serialized]);
            else if (name === 'corrections') await client.query(`INSERT INTO ${table(name)} (id, receipt_id, version, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [key, record.receiptId, record.version, serialized]);
            else if (name === 'inventory' || name === 'reports') await client.query(`INSERT INTO ${table(name)} (id, receipt_id, article_id, data) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [key, record.receiptId, record.articleId, serialized]);
            else await client.query(`INSERT INTO ${table(name)} (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [key, serialized]);
          }
          await client.query('UPDATE jeroc_environment_meta SET data = $1::jsonb WHERE id = 1', [JSON.stringify(metadata(state))]);
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const file = filename ?? env.JEROC_ENVIRONMENT_DB_PATH ?? resolve(process.cwd(), '.data', 'environment.sqlite');
    if (file === ':memory:') throw new EnvironmentError('Miljödata behöver en beständig lokal databas.', 503, 'persistent_database_required');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(file);
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    database.exec(migration.replaceAll('JSONB', 'TEXT'));
    database.exec(followupMigration.replaceAll('JSONB', 'TEXT'));
    database.prepare('INSERT OR IGNORE INTO jeroc_environment_meta (id, data) VALUES (1, ?)').run(JSON.stringify(metadata(initialEnvironmentState())));
    await chmod(file, 0o600);
    let tail = Promise.resolve();
    repository = {
      kind: 'sqlite',
      transact(callback, { allowImmutableRewrite = false } = {}) {
        const job = tail.then(async () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const state = JSON.parse(database.prepare('SELECT data FROM jeroc_environment_meta WHERE id = 1').get().data);
            const previous = {};
            for (const name of entities) {
              const records = database.prepare(`SELECT id, data FROM ${table(name)}`).all();
              state[name] = records.map((record) => JSON.parse(record.data));
              previous[name] = new Map(records.map((record) => [record.id, record.data]));
            }
            const generationReset = state.demoGeneration !== ENVIRONMENT_DEMO_GENERATION;
            migrateState(state);
            const pending = callback(state);
            const result = pending && typeof pending.then === 'function' ? await pending : pending;
            demandImmutable(state, previous, allowImmutableRewrite || generationReset);
            for (const name of [...entities].reverse()) {
              const keys = new Set(state[name].map((record) => entityKey(name, record)));
              for (const key of previous[name].keys()) if (!keys.has(key)) database.prepare(`DELETE FROM ${table(name)} WHERE id = ?`).run(key);
            }
            for (const name of entities) for (const record of state[name]) {
              const key = entityKey(name, record), serialized = JSON.stringify(record);
              if (previous[name].get(key) === serialized) continue;
              if (name === 'receipts') database.prepare(`INSERT INTO ${table(name)} (id, source_id, data) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET source_id = excluded.source_id, data = excluded.data`).run(key, record.sourceId, serialized);
              else if (name === 'corrections') database.prepare(`INSERT INTO ${table(name)} (id, receipt_id, version, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(key, record.receiptId, record.version, serialized);
              else if (name === 'inventory' || name === 'reports') database.prepare(`INSERT INTO ${table(name)} (id, receipt_id, article_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(key, record.receiptId, record.articleId, serialized);
              else database.prepare(`INSERT INTO ${table(name)} (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data`).run(key, serialized);
            }
            database.prepare('UPDATE jeroc_environment_meta SET data = ? WHERE id = 1').run(JSON.stringify(metadata(state)));
            database.exec('COMMIT'); return result;
          } catch (error) { database.exec('ROLLBACK'); throw error; }
        });
        tail = job.catch(() => {}); return job;
      },
      async close() { await tail; database.close(); },
    };
  }
  repository.backup = () => repository.transact((state) => JSON.stringify(state));
  repository.restore = (value) => {
    const restored = decodeBackup(value);
    return repository.transact((state) => { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, restored); }, { allowImmutableRewrite: true });
  };
  return repository;
}
