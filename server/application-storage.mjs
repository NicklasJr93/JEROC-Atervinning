import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';

export async function createApplicationRepository({ env = process.env, filename, seed, initial } = {}) {
  seed ??= initial;
  if (env.RENDER && !env.DATABASE_URL) throw Object.assign(new Error('DATABASE_URL krävs för gemensam verksamhetsdata.'), { status: 503 });
  const migration = await readFile(new URL('./migrations/application-001.sql', import.meta.url), 'utf8');
  if (env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, connectionTimeoutMillis: 8000 });
    const c = await pool.connect(); let failed;
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(1803299851)');
      await c.query(migration); await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); failed = error; }
    finally { c.release(); }
    if (failed) { await pool.end(); throw failed; }
    return {
      kind: 'postgresql',
      async transact(operation) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const meta = (await c.query('SELECT revision FROM jeroc_application_meta WHERE id=1 FOR UPDATE')).rows[0];
          const rows = (await c.query('SELECT domain, document FROM jeroc_application_documents')).rows;
          const state = rows.length ? Object.fromEntries(rows.map(row => [row.domain, row.document])) : seed();
          const previous = new Map(rows.map(row => [row.domain, JSON.stringify(row.document)]));
          const changes = [];
          const result = await operation(state, Number(meta.revision), changes);
          let changed = false;
          for (const [domain, document] of Object.entries(state)) if (previous.get(domain) !== JSON.stringify(document)) {
            changed = true;
            await c.query('INSERT INTO jeroc_application_documents(domain,document) VALUES($1,$2) ON CONFLICT(domain) DO UPDATE SET document=EXCLUDED.document,updated_at=NOW()', [domain, JSON.stringify(document)]);
          }
          if (changed) await c.query('UPDATE jeroc_application_meta SET revision=revision+1 WHERE id=1');
          for (const record of state.imports ?? []) await c.query('INSERT INTO jeroc_application_imports(id,data) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [record.domain + ':' + record.hash, JSON.stringify(record)]);
          for (const details of changes) await c.query('INSERT INTO jeroc_application_audit(details) VALUES($1)', [JSON.stringify(details)]);
          await c.query('COMMIT'); return result;
        } catch (error) { await c.query('ROLLBACK'); throw error; }
        finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  const path = filename ?? env.JEROC_APPLICATION_DB_PATH ?? fileURLToPath(new URL('../.data/application.sqlite', import.meta.url));
  await mkdir(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000; CREATE TABLE IF NOT EXISTS application(id INTEGER PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS application_audit(id INTEGER PRIMARY KEY, details TEXT NOT NULL);');
  let queue = Promise.resolve();
  return {
    kind: 'sqlite-development',
    transact(operation) {
      const run = queue.then(async () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const row = db.prepare('SELECT document,revision FROM application WHERE id=1').get();
          const state = row ? JSON.parse(row.document) : seed(); const previous = row?.document;
          const changes = []; const result = await operation(state, row?.revision ?? 0, changes);
          const document = JSON.stringify(state);
          db.prepare('INSERT INTO application VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,revision=excluded.revision').run(document, (row?.revision ?? 0) + Number(document !== previous));
          for (const details of changes) db.prepare('INSERT INTO application_audit(details) VALUES(?)').run(JSON.stringify(details));
          db.exec('COMMIT'); return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      queue = run.catch(() => {}); return run;
    },
    async close() { await queue; db.close(); },
  };
}
