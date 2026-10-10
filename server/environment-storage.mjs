import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInDatabaseTransaction, runDatabaseRead } from './database-runtime.mjs';

export class EnvironmentError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

export const ENVIRONMENT_DEMO_GENERATION = 'demo-weighings-2026-10-09-v2';
export const initialEnvironmentState = () => ({
  schemaVersion: 1, revision: 0, demoGeneration: ENVIRONMENT_DEMO_GENERATION,
  credentials: [], sessions: [], classifications: [], storagePolicies: [], siteRecords: [], drafts: [], receipts: [], corrections: [], inventory: [],
  reports: [], requests: [], audit: [], loginAttempts: [],
  nvvSettings: [], nvvChecks: [], nvvReports: [], nvvAttempts: [], nvvJobs: [],
});
// SQLite callbacks may await another local repository. Share the in-process
// queue by file so a second synchronous connection never blocks its lock owner.
const sqliteQueues = new Map();
const nvvEntities = ['nvvSettings', 'nvvChecks', 'nvvReports', 'nvvAttempts', 'nvvJobs'];
const entities = ['credentials', 'sessions', 'classifications', 'storagePolicies', 'siteRecords', 'drafts', 'receipts', 'corrections', 'inventory', 'reports', 'requests', 'audit', ...nvvEntities];
const table = (name) => `jeroc_environment_${name}`;
const metadata = (state) => Object.fromEntries(Object.entries(state).filter(([key]) => !entities.includes(key)));
const entityKey = (name, value) => name === 'credentials' ? value.userId
  : name === 'sessions' ? value.tokenHash
    : name === 'classifications' ? `${value.articleId}:${value.version}`
      : name === 'siteRecords' ? `${value.id}:${value.version}` : value.id;
const immutableEntities = ['classifications', 'storagePolicies', 'siteRecords', 'receipts', 'corrections', 'inventory', 'audit', 'nvvSettings', 'nvvChecks', 'nvvReports', 'nvvAttempts'];
const sourceEntities = new Set(['drafts', 'receipts', 'corrections', 'inventory', 'reports', 'nvvReports']);
function selectedEntities(options = {}) {
  const selected = options.entities ?? entities;
  if (!Array.isArray(selected) || selected.some(name => !entities.includes(name))) throw new TypeError('Unknown environmental read entity.');
  return [...new Set(selected)];
}
function scopeSql(name, options, values, postgres = true) {
  const conditions = [];
  const parameter = value => { values.push(value); return postgres ? `$${values.length}` : '?'; };
  const field = key => postgres ? `data->>'${key}'` : `json_extract(data, '$.${key}')`;
  if (name === 'sessions' && options.tokenHash !== undefined) conditions.push(`id = ${parameter(options.tokenHash)}`);
  if (sourceEntities.has(name) && options.sourceId !== undefined) conditions.push(`${field('sourceId')} = ${parameter(options.sourceId)}`);
  if (options.sourceId !== undefined && ['nvvAttempts', 'nvvJobs'].includes(name)) {
    const source = parameter(options.sourceId);
    conditions.push(`${field('versionId')} IN (SELECT ${postgres ? "data->>'id'" : "json_extract(data, '$.id')"} FROM ${table('nvvReports')} WHERE ${postgres ? "data->>'sourceId'" : "json_extract(data, '$.sourceId')"} = ${source})`);
  }
  if (options.reportId !== undefined && ['receipts', 'corrections', 'reports', 'nvvReports', 'nvvAttempts', 'nvvJobs'].includes(name)) {
    const report = parameter(options.reportId), receipt = parameter(options.reportId.split(':')[0]);
    const related = `(SELECT receipt_id FROM ${table('reports')} WHERE id = ${report} UNION SELECT ${receipt})`;
    if (['nvvAttempts', 'nvvJobs'].includes(name)) conditions.push(`${field('versionId')} IN (SELECT ${postgres ? "data->>'id'" : "json_extract(data, '$.id')"} FROM ${table('nvvReports')} WHERE ${postgres ? "data->>'receiptId'" : "json_extract(data, '$.receiptId')"} IN ${related})`);
    else conditions.push(`${name === 'receipts' ? 'id' : field('receiptId')} IN ${related}`);
  }
  if (options.receiptId !== undefined && ['receipts', 'corrections'].includes(name)) conditions.push(`${name === 'receipts' ? 'id' : field('receiptId')} = ${parameter(options.receiptId)}`);
  if (name === 'classifications' && options.articleIds !== undefined) {
    if (postgres) conditions.push(`${field('articleId')} = ANY(${parameter(options.articleIds)}::text[])`);
    else conditions.push(`${field('articleId')} IN (SELECT value FROM json_each(${parameter(JSON.stringify(options.articleIds))}))`);
  }
  if (options.siteId && options.siteId !== 'all') {
    if (name === 'siteRecords') conditions.push(`${field('id')} = ${parameter(options.siteId)}`);
    else if (['storagePolicies', 'drafts', 'receipts', 'corrections', 'inventory', 'reports', 'nvvReports'].includes(name)) conditions.push(`${field('siteId')} = ${parameter(options.siteId)}`);
  }
  return conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
}
// A single SQL statement supplies a consistent snapshot; callers never save a
// partial projection back through the aggregate write path.
function readSql(options = {}) {
  const values = [], names = selectedEntities(options);
  const fields = names.map(name => {
    if (name === 'inventory' && options.stock) {
      if (!options.siteId || options.siteId === 'all') throw new TypeError('A stock projection needs one facility.');
      values.push(options.siteId); const site = `$${values.length}`;
      // Signed correction movements are included once. Grouped decimal SUMs
      // avoid loading every receipt/ledger record for a capacity preview.
      return `'inventory', COALESCE((SELECT jsonb_agg(jsonb_build_object('siteId', ${site}, 'articleId', article_id, 'wasteCode', waste_code, 'weight', amount)) FROM (
        SELECT entry->>'articleId' AS article_id, entry->>'wasteCode' AS waste_code, SUM((entry->>'weight')::numeric) AS amount FROM (
          SELECT data AS entry FROM ${table('inventory')} WHERE data->>'siteId' = ${site}
          UNION ALL SELECT movement AS entry FROM ${table('corrections')} CROSS JOIN LATERAL jsonb_array_elements(data->'inventoryMovements') AS movements(movement) WHERE data->>'siteId' = ${site}
        ) AS ledger GROUP BY entry->>'articleId', entry->>'wasteCode'
      ) AS stock), '[]'::jsonb)`;
    }
    return `'${name}', COALESCE((SELECT jsonb_agg(data) FROM ${table(name)}${scopeSql(name, options, values)}), '[]'::jsonb)`;
  });
  return { sql: `SELECT data${fields.length ? ` || jsonb_build_object(${fields.join(', ')})` : ''} AS state FROM jeroc_environment_meta WHERE id = 1`, values, names };
}
function completeReadState(value) { return Object.assign(initialEnvironmentState(), value); }
function previousRecords(state) { return Object.fromEntries(entities.map(name => [name, new Map(state[name].map(record => [entityKey(name, record), JSON.stringify(record)]))])); }
function pendingWrites(state, previous, previousMetadata) {
  const changes = [];
  for (const name of [...entities].reverse()) {
    const current = new Set(state[name].map(record => entityKey(name, record)));
    const removed = [...previous[name].keys()].filter(key => !current.has(key));
    if (removed.length) changes.push({ name, removed });
  }
  for (const name of entities) {
    const records = state[name].filter(record => previous[name].get(entityKey(name, record)) !== JSON.stringify(record));
    if (records.length) changes.push({ name, records });
  }
  const nextMetadata = JSON.stringify(metadata(state));
  return { changes, nextMetadata, metadataChanged: nextMetadata !== previousMetadata };
}
function postgresWriteSql(state, previous, previousMetadata) {
  const pending = pendingWrites(state, previous, previousMetadata), values = [], clauses = [];
  let dependency;
  const parameter = value => { values.push(JSON.stringify(value)); return `$${values.length}::jsonb`; };
  for (const change of pending.changes) {
    const alias = `environment_change_${clauses.length}`;
    const barrier = dependency ? ` CROSS JOIN (SELECT count(*) FROM ${dependency}) AS dependency` : '';
    let statement;
    if (change.removed) statement = `DELETE FROM ${table(change.name)} WHERE id IN (SELECT value FROM jsonb_array_elements_text(${parameter(change.removed)})${barrier}) RETURNING id`;
    else {
      const input = parameter(change.records), key = change.name === 'credentials' ? "record->>'userId'" : change.name === 'sessions' ? "record->>'tokenHash'"
        : change.name === 'classifications' ? "(record->>'articleId') || ':' || (record->>'version')"
          : change.name === 'siteRecords' ? "(record->>'id') || ':' || (record->>'version')" : "record->>'id'";
      const extra = change.name === 'receipts' ? { columns: ',source_id', values: ",record->>'sourceId'", update: ',source_id=EXCLUDED.source_id' }
        : change.name === 'corrections' ? { columns: ',receipt_id,version', values: ",record->>'receiptId',(record->>'version')::int", update: '' }
          : ['inventory', 'reports'].includes(change.name) ? { columns: ',receipt_id,article_id', values: ",record->>'receiptId',record->>'articleId'", update: '' }
            : { columns: '', values: '', update: '' };
      statement = `INSERT INTO ${table(change.name)} (id${extra.columns},data) SELECT ${key}${extra.values},record FROM jsonb_array_elements(${input}) AS records(record)${barrier} ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data${extra.update} RETURNING id`;
    }
    clauses.push(`${alias} AS (${statement})`); dependency = alias;
  }
  if (pending.metadataChanged) {
    values.push(pending.nextMetadata);
    const barrier = dependency ? ` FROM (SELECT count(*) FROM ${dependency}) AS dependency` : '';
    clauses.push(`environment_metadata AS (UPDATE jeroc_environment_meta SET data=$${values.length}::jsonb${barrier} WHERE id=1 RETURNING id)`); dependency = 'environment_metadata';
  }
  return clauses.length ? { sql: `WITH ${clauses.join(', ')} SELECT count(*) FROM ${dependency}`, values } : undefined;
}
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
  if (state && state.schemaVersion === 1) { state.drafts ??= []; state.corrections ??= []; state.storagePolicies ??= []; state.siteRecords ??= []; }
  if (state && state.schemaVersion === 1) for (const name of nvvEntities) state[name] ??= [];
  if (!state || state.schemaVersion !== 1 || entities.some((name) => !Array.isArray(state[name])))
    throw new EnvironmentError('Säkerhetskopians struktur eller version är ogiltig.');
  if (new Set(state.receipts.map((receipt) => receipt.sourceId)).size !== state.receipts.length)
    throw new EnvironmentError('Säkerhetskopian innehåller dubbla mottagningar.');
  const receipts = new Set(state.receipts.map((receipt) => receipt.id));
  if ([...state.inventory, ...state.reports].some((record) => !receipts.has(record.receiptId)))
    throw new EnvironmentError('Säkerhetskopian saknar en mottagning.');
  if (state.corrections.some((record) => !receipts.has(record.receiptId)) || new Set(state.corrections.map((record) => `${record.receiptId}:${record.version}`)).size !== state.corrections.length)
    throw new EnvironmentError('Säkerhetskopians miljörättelser är ogiltiga.');
  const nvvVersions = new Set(state.nvvReports.map(record => record.id));
  if (state.nvvReports.some(record => !receipts.has(record.receiptId)) || state.nvvAttempts.some(record => !nvvVersions.has(record.versionId)) || state.nvvJobs.some(record => !nvvVersions.has(record.versionId)))
    throw new EnvironmentError('Säkerhetskopians NVV-versioner eller kvittenser saknar underlag.');
  if (new Set(state.storagePolicies.map((record) => record.id)).size !== state.storagePolicies.length
    || new Set(state.storagePolicies.map((record) => `${record.siteId}:${record.version}`)).size !== state.storagePolicies.length
    || new Set(state.siteRecords.map((record) => `${record.id}:${record.version}`)).size !== state.siteRecords.length)
    throw new EnvironmentError('Säkerhetskopians anläggnings- eller lagringsversioner är ogiltiga.');
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
  const storageMigration = await readFile(fileURLToPath(new URL('./migrations/environment-003.sql', import.meta.url)), 'utf8');
  const nvvMigration = await readFile(fileURLToPath(new URL('./migrations/environment-004.sql', import.meta.url)), 'utf8');
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
      await migrationClient.query(storageMigration);
      await migrationClient.query(nvvMigration);
      await migrationClient.query('INSERT INTO jeroc_environment_meta (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(metadata(initialEnvironmentState()))]);
      await migrationClient.query('COMMIT');
    } catch (error) {
      if (migrationClient) { await migrationClient.query('ROLLBACK').catch(() => {}); migrationClient.release(); }
      await pool.end(); throw error;
    }
    migrationClient.release();
    repository = {
      kind: 'postgresql',
      async read(callback, options = {}) {
        const query = readSql(options);
        return runDatabaseRead(pool, async client => {
          const { rows } = await client.query(query.sql, query.values);
          const state = completeReadState(rows[0].state);
          if (options.stock) Object.defineProperty(state, 'environmentStockProjection', { value: true });
          return callback(state);
        });
      },
      async transact(callback, { allowImmutableRewrite = false } = {}) {
        return runInDatabaseTransaction(pool, async client => {
          // Read in a NEW statement after a contended lock: the decision's MVCC
          // snapshot must include the preceding writer's committed stock.
          await client.query('SELECT id FROM jeroc_environment_meta WHERE id = 1 FOR UPDATE');
          const query = readSql();
          const { rows } = await client.query(query.sql, query.values);
          const state = rows[0].state;
          const previousMetadata = JSON.stringify(metadata(state)), previous = previousRecords(state);
          const generationReset = state.demoGeneration !== ENVIRONMENT_DEMO_GENERATION;
          migrateState(state);
          const result = await callback(state);
          demandImmutable(state, previous, allowImmutableRewrite || generationReset);
          const write = postgresWriteSql(state, previous, previousMetadata);
          if (write) await client.query(write.sql, write.values);
          return result;
        });
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
    database.exec(storageMigration.replaceAll('JSONB', 'TEXT'));
    database.exec(nvvMigration.replaceAll('JSONB', 'TEXT'));
    database.prepare('INSERT OR IGNORE INTO jeroc_environment_meta (id, data) VALUES (1, ?)').run(JSON.stringify(metadata(initialEnvironmentState())));
    await chmod(file, 0o600);
    const queueKey = resolve(file);
    let queue = sqliteQueues.get(queueKey);
    if (!queue) { queue = { tail: Promise.resolve(), references: 0 }; sqliteQueues.set(queueKey, queue); }
    queue.references++;
    repository = {
      kind: 'sqlite',
      read(callback, options = {}) {
        const job = queue.tail.then(async () => {
          database.exec('BEGIN');
          try {
            const state = completeReadState(JSON.parse(database.prepare('SELECT data FROM jeroc_environment_meta WHERE id = 1').get().data));
            for (const name of selectedEntities(options)) {
              const values = [], where = scopeSql(name, options, values, false);
              state[name] = database.prepare(`SELECT data FROM ${table(name)}${where}`).all(...values).map(row => JSON.parse(row.data));
            }
            if (options.stock) {
              if (!options.siteId || options.siteId === 'all') throw new TypeError('A stock projection needs one facility.');
              const stock = new Map(), add = entry => {
                const key = JSON.stringify([entry.articleId, entry.wasteCode]);
                const previous = stock.get(key);
                stock.set(key, { siteId: options.siteId, articleId: entry.articleId, wasteCode: entry.wasteCode,
                  weight: Math.round(((previous?.weight ?? 0) + entry.weight) * 1000) / 1000 });
              };
              for (const row of database.prepare(`SELECT data FROM ${table('inventory')} WHERE json_extract(data, '$.siteId') = ?`).all(options.siteId)) add(JSON.parse(row.data));
              for (const row of database.prepare(`SELECT data FROM ${table('corrections')} WHERE json_extract(data, '$.siteId') = ?`).all(options.siteId)) for (const movement of JSON.parse(row.data).inventoryMovements) add(movement);
              state.inventory = [...stock.values()];
              Object.defineProperty(state, 'environmentStockProjection', { value: true });
            }
            const result = await callback(state);
            database.exec('COMMIT'); return result;
          } catch (error) { database.exec('ROLLBACK'); throw error; }
        });
        queue.tail = job.catch(() => {}); return job;
      },
      transact(callback, { allowImmutableRewrite = false } = {}) {
        const job = queue.tail.then(async () => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const state = JSON.parse(database.prepare('SELECT data FROM jeroc_environment_meta WHERE id = 1').get().data);
            const previousMetadata = JSON.stringify(metadata(state)), previous = {};
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
            const nextMetadata = JSON.stringify(metadata(state));
            if (nextMetadata !== previousMetadata) database.prepare('UPDATE jeroc_environment_meta SET data = ? WHERE id = 1').run(nextMetadata);
            database.exec('COMMIT'); return result;
          } catch (error) { database.exec('ROLLBACK'); throw error; }
        });
        queue.tail = job.catch(() => {}); return job;
      },
      async close() { await queue.tail; database.close(); if (--queue.references === 0) sqliteQueues.delete(queueKey); },
    };
  }
  repository.backup = () => repository.read((state) => JSON.stringify(state));
  repository.restore = (value) => {
    const restored = decodeBackup(value);
    return repository.transact((state) => { for (const key of Object.keys(state)) delete state[key]; Object.assign(state, restored); }, { allowImmutableRewrite: true });
  };
  return repository;
}
