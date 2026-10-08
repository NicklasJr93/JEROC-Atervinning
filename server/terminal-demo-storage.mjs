import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class TerminalDemoError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}

export const initialTerminalState = () => ({
  schemaVersion: 1, revision: 0, terminals: [], terminalSessions: [], staffSessions: [],
  defaults: [], approvals: [], requests: [], audit: [], loginAttempts: [],
});

/**
 * PostgreSQL is required on Render: its ordinary filesystem is ephemeral.
 * SQLite is a durable local development option, never a silent cloud fallback.
 * Every callback runs under a database write lock, including reservation checks.
 */
export async function createTerminalDemoRepository({ env = process.env, filename } = {}) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl && env.RENDER) throw new TerminalDemoError(
    'Kundterminaler behöver en PostgreSQL-databas. Lägg till DATABASE_URL i Render; övriga demovyer fungerar som tidigare.',
    503, 'setup_required',
  );
  if (databaseUrl) {
    const { Pool } = await import('pg');
    // pg follows libpq connection settings in DATABASE_URL. TLS is never disabled
    // here; use the provider's documented internal/external connection string.
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 8000 });
    try {
      const sql = await readFile(fileURLToPath(new URL('./migrations/terminal-demo-001.sql', import.meta.url)), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO jeroc_terminal_demo (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [JSON.stringify(initialTerminalState())]);
    } catch (error) { await pool.end(); throw error; }
    return {
      kind: 'postgresql',
      async transact(callback) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query('SELECT state FROM jeroc_terminal_demo WHERE id = 1 FOR UPDATE');
          const state = rows[0].state;
          const pending = callback(state);
          const result = pending && typeof pending.then === 'function' ? await pending : pending;
          await client.query('UPDATE jeroc_terminal_demo SET state = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [JSON.stringify(state)]);
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  const file = filename ?? env.JEROC_TERMINAL_DB_PATH ?? resolve(process.cwd(), '.data', 'terminal-demo.sqlite');
  if (file !== ':memory:') await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS jeroc_terminal_demo (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)');
  database.prepare('INSERT OR IGNORE INTO jeroc_terminal_demo (id, state) VALUES (1, ?)').run(JSON.stringify(initialTerminalState()));
  if (file !== ':memory:') await chmod(file, 0o600);
  let tail = Promise.resolve();
  return {
    kind: 'sqlite',
    transact(callback) {
      const job = tail.then(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const state = JSON.parse(database.prepare('SELECT state FROM jeroc_terminal_demo WHERE id = 1').get().state);
          const pending = callback(state);
          const result = pending && typeof pending.then === 'function' ? await pending : pending;
          database.prepare('UPDATE jeroc_terminal_demo SET state = ? WHERE id = 1').run(JSON.stringify(state));
          database.exec('COMMIT'); return result;
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      });
      tail = job.catch(() => {});
      return job;
    },
    async close() { await tail; database.close(); },
  };
}
