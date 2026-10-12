import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';

export class ArticleMediaError extends Error {
  constructor(message, status = 422, code = 'invalid_image') {
    super(message); this.status = status; this.code = code;
  }
}

/** The stored variants are immutable. Images live in PostgreSQL, including on
 * Render; the SQLite fallback is restricted to local development. */
export async function createArticleMediaRepository({ env = process.env, filename } = {}) {
  if (env.RENDER && !env.DATABASE_URL)
    throw new ArticleMediaError('Bildarkivet behöver DATABASE_URL i Render.', 503, 'setup_required');
  const sql = await readFile(new URL('./migrations/article-media-001.sql', import.meta.url), 'utf8');
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 4, connectionTimeoutMillis: 8000 });
    try {
      await runInDatabaseTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(1803299854)');
        await client.query(sql);
      });
    } catch (error) { await pool.end(); throw error; }
    return {
      kind: 'postgresql',
      async insert(record, full, thumbnail) {
        return runInDatabaseTransaction(pool, async client => {
          await client.query('INSERT INTO jeroc_article_media(id,content_hash,record,full_image,thumbnail,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(content_hash) DO NOTHING',
            [record.id, record.contentHash, JSON.stringify(record), full, thumbnail, record.createdAt]);
          const { rows } = await client.query('SELECT record FROM jeroc_article_media WHERE content_hash=$1', [record.contentHash]);
          return rows[0].record;
        });
      },
      async image(id, variant = 'full') {
        return runDatabaseRead(pool, async client => {
          const column = variant === 'thumb' ? 'thumbnail' : 'full_image';
          const { rows } = await client.query(`SELECT record, ${column} AS bytes FROM jeroc_article_media WHERE id=$1`, [id]);
          return rows[0] ? { record: rows[0].record, bytes: rows[0].bytes } : undefined;
        });
      },
      async hasImages(ids) {
        if (!ids.length) return true;
        return runDatabaseRead(pool, async client => {
          const { rows } = await client.query('SELECT id FROM jeroc_article_media WHERE id=ANY($1::text[])', [[...new Set(ids)]]);
          return rows.length === new Set(ids).size;
        });
      },
      close: () => pool.end(),
    };
  }
  const path = filename ?? env.JEROC_ARTICLE_MEDIA_DB_PATH ?? fileURLToPath(new URL('../.data/article-media.sqlite', import.meta.url));
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL;');
  database.exec(sql.replaceAll('JSONB', 'TEXT').replaceAll('BYTEA', 'BLOB').replaceAll('TIMESTAMPTZ', 'TEXT'));
  if (path !== ':memory:') await chmod(path, 0o600);
  const decode = row => row ? JSON.parse(row.record) : undefined;
  let tail = Promise.resolve();
  const run = callback => {
    const operation = tail.then(callback);
    tail = operation.catch(() => {});
    return operation;
  };
  return {
    kind: 'sqlite-development',
    insert(record, full, thumbnail) {
      return run(() => {
        database.exec('BEGIN IMMEDIATE');
        try {
          database.prepare('INSERT OR IGNORE INTO jeroc_article_media(id,content_hash,record,full_image,thumbnail,created_at) VALUES(?,?,?,?,?,?)')
            .run(record.id, record.contentHash, JSON.stringify(record), full, thumbnail, record.createdAt);
          const result = decode(database.prepare('SELECT record FROM jeroc_article_media WHERE content_hash=?').get(record.contentHash));
          database.exec('COMMIT'); return result;
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      });
    },
    image(id, variant = 'full') {
      return run(() => {
        const column = variant === 'thumb' ? 'thumbnail' : 'full_image';
        const row = database.prepare(`SELECT record, ${column} AS bytes FROM jeroc_article_media WHERE id=?`).get(id);
        return row ? { record: decode(row), bytes: Buffer.from(row.bytes) } : undefined;
      });
    },
    hasImages(ids) {
      return run(() => [...new Set(ids)].every(id => !!database.prepare('SELECT id FROM jeroc_article_media WHERE id=?').get(id)));
    },
    async close() { await tail; database.close(); },
  };
}
