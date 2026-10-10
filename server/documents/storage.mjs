import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class DocumentError extends Error {
  constructor(message, status = 409, code = 'invalid_document') {
    super(message); this.status = status; this.code = code;
  }
}

const keyOf = record => [record.kind, record.sourceId, record.sourceVersion, record.stage, record.sourceHash, record.templateVersion];
const metadata = row => row ? { ...row.record } : undefined;

/** Only immutable INSERT operations are exposed. No PDF can overwrite an original. */
export async function createDocumentRepository({ env = process.env, filename } = {}) {
  if (env.RENDER && !env.DATABASE_URL) throw new DocumentError('PDF-arkivet behöver DATABASE_URL i Render.', 503, 'setup_required');
  const sql = await readFile(new URL('../migrations/documents-001.sql', import.meta.url), 'utf8');
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4, connectionTimeoutMillis: 8000 });
    const client = await pool.connect();
    let migrationFailure;
    try { await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(1803299853)'); await client.query(sql); await client.query('COMMIT'); }
    catch (error) { try { await client.query('ROLLBACK'); } catch {} migrationFailure = error; }
    finally { client.release(); }
    if (migrationFailure) { await pool.end(); throw migrationFailure; }
    return {
      kind: 'postgresql',
      async transact(callback) {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          const adapter = {
            async document(id, includeBytes = false) {
              const { rows } = await connection.query(`SELECT record${includeBytes ? ', pdf' : ''} FROM jeroc_document_archive WHERE id=$1`, [id]);
              return rows[0] ? { ...metadata(rows[0]), ...(includeBytes ? { pdf: rows[0].pdf } : {}) } : undefined;
            },
            async documents(kind, sourceId) {
              const { rows } = await connection.query('SELECT record FROM jeroc_document_archive WHERE kind=$1 AND source_id=$2 ORDER BY created_at, id', [kind, String(sourceId)]);
              return rows.map(metadata);
            },
            async sameDocument(record) {
              const { rows } = await connection.query('SELECT record FROM jeroc_document_archive WHERE kind=$1 AND source_id=$2 AND source_version=$3 AND stage=$4 AND source_hash=$5 AND template_version=$6', keyOf(record));
              return metadata(rows[0]);
            },
            async insertDocument(record, pdf) {
              const result = await connection.query('INSERT INTO jeroc_document_archive(id,kind,source_id,source_version,stage,source_hash,template_version,record,pdf,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(kind,source_id,source_version,stage,source_hash,template_version) DO NOTHING RETURNING id', [record.id, ...keyOf(record), JSON.stringify(record), pdf, record.createdAt]);
              return { inserted: result.rowCount === 1, record: await adapter.sameDocument(record) };
            },
            async transportDraft(orderId) {
              const { rows } = await connection.query('SELECT record FROM jeroc_transport_document_drafts WHERE order_id=$1 ORDER BY version DESC LIMIT 1', [orderId]);
              return metadata(rows[0]);
            },
            async lockTransport(orderId) { await connection.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`jeroc-transport-document:${orderId}`]); },
            async insertTransportDraft(record) { await connection.query('INSERT INTO jeroc_transport_document_drafts(order_id,version,record,created_at) VALUES($1,$2,$3,$4)', [record.orderId, record.version, JSON.stringify(record), record.updatedAt]); },
            async audit(record) { await connection.query('INSERT INTO jeroc_document_audit(id,record,created_at) VALUES($1,$2,$3)', [record.id, JSON.stringify(record), record.at]); },
          };
          const result = await callback(adapter); await connection.query('COMMIT'); return result;
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
        finally { connection.release(); }
      },
      close: () => pool.end(),
    };
  }
  const path = filename ?? env.JEROC_DOCUMENT_DB_PATH ?? fileURLToPath(new URL('../../.data/documents.sqlite', import.meta.url));
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL;');
  database.exec(sql.replaceAll('JSONB', 'TEXT').replaceAll('BYTEA', 'BLOB').replaceAll('TIMESTAMPTZ', 'TEXT'));
  if (path !== ':memory:') await chmod(path, 0o600);
  const decode = row => row ? JSON.parse(row.record) : undefined;
  let tail = Promise.resolve();
  return {
    kind: 'sqlite-development',
    transact(callback) {
      const operation = tail.then(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const adapter = {
            async document(id, includeBytes = false) { const row = database.prepare(`SELECT record${includeBytes ? ',pdf' : ''} FROM jeroc_document_archive WHERE id=?`).get(id); return row ? { ...decode(row), ...(includeBytes ? { pdf: Buffer.from(row.pdf) } : {}) } : undefined; },
            async documents(kind, sourceId) { return database.prepare('SELECT record FROM jeroc_document_archive WHERE kind=? AND source_id=? ORDER BY created_at,id').all(kind, String(sourceId)).map(decode); },
            async sameDocument(record) { return decode(database.prepare('SELECT record FROM jeroc_document_archive WHERE kind=? AND source_id=? AND source_version=? AND stage=? AND source_hash=? AND template_version=?').get(...keyOf(record))); },
            async insertDocument(record, pdf) { const result = database.prepare('INSERT OR IGNORE INTO jeroc_document_archive(id,kind,source_id,source_version,stage,source_hash,template_version,record,pdf,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(record.id, ...keyOf(record), JSON.stringify(record), pdf, record.createdAt); return { inserted: result.changes === 1, record: await adapter.sameDocument(record) }; },
            async transportDraft(orderId) { return decode(database.prepare('SELECT record FROM jeroc_transport_document_drafts WHERE order_id=? ORDER BY version DESC LIMIT 1').get(orderId)); },
            async lockTransport() {},
            async insertTransportDraft(record) { database.prepare('INSERT INTO jeroc_transport_document_drafts(order_id,version,record,created_at) VALUES(?,?,?,?)').run(record.orderId, record.version, JSON.stringify(record), record.updatedAt); },
            async audit(record) { database.prepare('INSERT INTO jeroc_document_audit(id,record,created_at) VALUES(?,?,?)').run(record.id, JSON.stringify(record), record.at); },
          };
          const result = await callback(adapter); database.exec('COMMIT'); return result;
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      });
      tail = operation.catch(() => {}); return operation;
    },
    async close() { await tail; database.close(); },
  };
}
