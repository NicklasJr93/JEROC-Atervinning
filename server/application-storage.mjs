import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterDatabaseCommit, runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';
import { getChangeEvents } from './change-events.mjs';

// New domains are stored in full alongside the old aggregate. Older deployments
// gain an empty prepared-weighing registry without resetting any business data.
function normalizeDomains(state, domains) {
  if (!domains || domains.includes('workOrderWeighing')) {
    state.workOrderWeighing ??= { version: 1, drafts: {} }; state.workOrderWeighing.drafts ??= {};
  }
  return state;
}
function selectedDomains(domains) {
  if (domains === undefined) return undefined;
  if (!Array.isArray(domains) || domains.some(domain => typeof domain !== 'string' || !domain.length)) throw new TypeError('Välj giltiga databasdomäner.');
  return [...new Set(domains)];
}
const selectState = (state, domains) => normalizeDomains(domains ? Object.fromEntries(domains.filter(domain => Object.hasOwn(state, domain)).map(domain => [domain, state[domain]])) : state, domains);
const importKey = record => `${record.domain}:${record.hash}`;
async function saveDomains(client, entries) {
  if (!entries.length) return;
  await client.query('INSERT INTO jeroc_application_documents(domain,document) SELECT value->>\'domain\',value->\'document\' FROM jsonb_array_elements($1::jsonb) AS value WHERE true ON CONFLICT(domain) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()',
    [JSON.stringify(entries.map(([domain, document]) => ({ domain, document })))]);
}

export async function createApplicationRepository({ env = process.env, filename, seed, initial } = {}) {
  seed ??= initial;
  if (env.RENDER && !env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL krävs för gemensam verksamhetsdata.'), { status: 503 });
  const migration = await readFile(new URL('./migrations/application-001.sql', import.meta.url), 'utf8');
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, connectionTimeoutMillis: 8000 });
    let failed;
    try {
      await runInDatabaseTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(1803299851)');
        await client.query(migration);
        // Persist a fresh seed once. Ordinary reads never create random seed IDs
        // or normalize old snapshots back into the database.
        if (!(await client.query('SELECT domain FROM jeroc_application_documents LIMIT 1')).rows.length)
          await saveDomains(client, Object.entries(normalizeDomains(seed())));
      });
    } catch (error) { failed = error; }
    if (failed) { await pool.end(); throw failed; }
    const changeEvents = getChangeEvents(env);
    return {
      kind: 'postgresql',
      runInTransaction: callback => runInDatabaseTransaction(pool, callback),
      async read(operation, { domains } = {}) {
        domains = selectedDomains(domains);
        return runDatabaseRead(pool, async client => {
          const { rows } = await client.query('SELECT meta.revision, documents.domain, documents.document FROM jeroc_application_meta AS meta LEFT JOIN jeroc_application_documents AS documents ON ($1::text[] IS NULL OR documents.domain=ANY($1::text[])) WHERE meta.id=1', [domains ?? null]);
          const state = normalizeDomains(Object.fromEntries(rows.filter(row => row.domain !== null).map(row => [row.domain, row.document])), domains);
          return operation(state, Number(rows[0]?.revision ?? 0));
        });
      },
      async transact(operation, { committedRevision = false } = {}) {
        return runInDatabaseTransaction(pool, async c => {
          const meta = (await c.query('SELECT revision FROM jeroc_application_meta WHERE id=1 FOR UPDATE')).rows[0];
          const rows = (await c.query('SELECT domain, document FROM jeroc_application_documents')).rows;
          const state = normalizeDomains(rows.length ? Object.fromEntries(rows.map(row => [row.domain, row.document])) : seed());
          const previous = new Map(rows.map(row => [row.domain, JSON.stringify(row.document)]));
          const previousImports = new Set((state.imports ?? []).map(importKey));
          const changes = [];
          const result = await operation(state, Number(meta.revision), changes);
          const modified = Object.entries(state).filter(([domain, document]) => previous.get(domain) !== JSON.stringify(document));
          await saveDomains(c, modified);
          if (modified.length) {
            const event = { domain: 'application', eventId: randomUUID(), revision: Number(meta.revision) + 1 };
            // PostgreSQL delivers NOTIFY only at the outer commit. Reuse the
            // revision write's round trip; local listeners run after that commit.
            await c.query("WITH updated AS (UPDATE jeroc_application_meta SET revision=revision+1 WHERE id=1 RETURNING revision) SELECT revision,pg_notify('jeroc_changes',json_build_object('domain','application','revision',revision,'eventId',$1::text)::text) FROM updated", [event.eventId]);
            afterDatabaseCommit(() => changeEvents.publishLocal(event));
          }
          const addedImports = (state.imports ?? []).filter(record => !previousImports.has(importKey(record)));
          if (addedImports.length) await c.query('INSERT INTO jeroc_application_imports(id,data) SELECT value->>\'id\',value->\'data\' FROM jsonb_array_elements($1::jsonb) AS value WHERE true ON CONFLICT(id) DO NOTHING', [JSON.stringify(addedImports.map(record => ({ id: importKey(record), data: record })))]);
          if (changes.length) await c.query('INSERT INTO jeroc_application_audit(details) SELECT value FROM jsonb_array_elements($1::jsonb) AS value', [JSON.stringify(changes)]);
          if (committedRevision && result && typeof result === 'object') result.revision = Number(meta.revision) + Number(modified.length > 0);
          return result;
        });
      },
      close: async () => { await Promise.all([pool.end(), changeEvents.close()]); },
    };
  }
  const path = filename ?? env.JEROC_APPLICATION_DB_PATH ?? fileURLToPath(new URL('../.data/application.sqlite', import.meta.url));
  await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; CREATE TABLE IF NOT EXISTS application(id INTEGER PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS application_audit(id INTEGER PRIMARY KEY, details TEXT NOT NULL);');
  if (!db.prepare('SELECT id FROM application WHERE id=1').get()) db.prepare('INSERT OR IGNORE INTO application VALUES(1,?,0)').run(JSON.stringify(normalizeDomains(seed())));
  const changeEvents = getChangeEvents({ ...env, JEROC_APPLICATION_DB_PATH: path });
  let queue = Promise.resolve();
  return {
    kind: 'sqlite-development',
    // Separate local SQLite files cannot share a PostgreSQL commit boundary.
    runInTransaction: callback => callback(),
    read(operation, { domains } = {}) {
      domains = selectedDomains(domains);
      const run = queue.then(() => {
        const row = db.prepare('SELECT document,revision FROM application WHERE id=1').get();
        return operation(selectState(JSON.parse(row.document), domains), row.revision);
      });
      queue = run.catch(() => {}); return run;
    },
    transact(operation, { committedRevision = false } = {}) {
      const run = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('SELECT document,revision FROM application WHERE id=1').get();
          const state = normalizeDomains(row ? JSON.parse(row.document) : seed()); const previous = row?.document;
          const changes = []; const result = await operation(state, row?.revision ?? 0, changes);
          const document = JSON.stringify(state);
          const modified = document !== previous, revision = (row?.revision ?? 0) + Number(modified);
          db.prepare('INSERT INTO application VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,revision=excluded.revision').run(document, revision);
          for (const details of changes) db.prepare('INSERT INTO application_audit(details) VALUES(?)').run(JSON.stringify(details));
          db.exec('COMMIT');
          if (modified) await afterDatabaseCommit(() => changeEvents.publishLocal({ domain: 'application', revision }));
          if (committedRevision && result && typeof result === 'object') result.revision = revision;
          return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      queue = run.catch(() => {}); return run;
    },
    async close() { await queue; db.close(); await changeEvents.close(); },
  };
}
