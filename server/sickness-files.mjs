import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PricingError } from './pricing.mjs';
import { runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';

export const MAX_CERTIFICATE_BYTES = 5 * 1024 * 1024;
const fail = (message, status = 422) => { throw new PricingError(message, status); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const filename = value => String(value ?? 'läkarintyg').split(/[/\\]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || 'läkarintyg';
const safe = ({ createdBy: _actor, effectiveUserId: _effective, hash: _hash, personId: _person, ...record }) => record;
const permitted = (user, right) => user?.active !== false && (user?.level === 'Systemadmin' || user?.permissions?.includes(right));
const scope = (user, person) => !Array.isArray(user.siteIds) || person.siteIds?.length > 0 && person.siteIds.every(id => user.siteIds.includes(id));

export async function prepareSicknessFile(bytes, contentType, originalName) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('Intyget är tomt.');
  if (bytes.length > MAX_CERTIFICATE_BYTES) fail('Intyget får vara högst 5 MB.', 413);
  if (contentType === 'application/pdf') {
    if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !bytes.subarray(-2048).toString('ascii').includes('%%EOF'))
      fail('Filen är inte en giltig PDF.', 415);
    return { bytes, contentType, name: filename(originalName) };
  }
  if (!['image/jpeg', 'image/png'].includes(contentType)) fail('Välj PDF, JPEG eller PNG.', 415);
  try {
    const source = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' });
    const info = await source.metadata();
    if (info.format !== (contentType === 'image/jpeg' ? 'jpeg' : 'png') || (info.pages ?? 1) !== 1) fail('Filens innehåll matchar inte bildtypen.', 415);
    const output = await source.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    return { bytes: output, contentType: 'image/jpeg', name: filename(originalName).replace(/\.[^.]+$/, '') + '.jpg' };
  } catch (error) { if (error instanceof PricingError) throw error; fail('Intygsbilden kunde inte läsas.', 415); }
}

/** A separate private binary store avoids placing medical attachments in public
 * article assets, business PDFs, bootstrap responses or application aggregates.
 * The server-selected tenant DB schema/path is the only storage scope. */
export async function createSicknessFileRepository({ env = process.env, filename: suppliedFilename } = {}) {
  if (env.RENDER && !env.DATABASE_URL) fail('Intygsarkivet behöver bolagets databas.', 503);
  const sql = await readFile(new URL('./migrations/sickness-files-001.sql', import.meta.url), 'utf8');
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 });
    try { await runInDatabaseTransaction(pool, async client => { await client.query('SELECT pg_advisory_xact_lock(1803299861)'); await client.query(sql); }); }
    catch (error) { await pool.end(); throw error; }
    return {
      async insert(record, bytes) { return runInDatabaseTransaction(pool, async client => {
        await client.query('INSERT INTO jeroc_sickness_files(id,case_id,person_id,record,bytes,created_at) VALUES($1,$2,$3,$4,$5,$6)', [record.id, record.caseId, record.personId, JSON.stringify(record), bytes, record.uploadedAt]);
        return record;
      }); },
      async list(caseId, personId) { return runDatabaseRead(pool, async client => (await client.query('SELECT record FROM jeroc_sickness_files WHERE case_id=$1 AND person_id=$2 ORDER BY created_at', [caseId, personId])).rows.map(row => row.record)); },
      async file(id) { return runDatabaseRead(pool, async client => { const row = (await client.query('SELECT record,bytes FROM jeroc_sickness_files WHERE id=$1', [id])).rows[0]; return row && { record: row.record, bytes: row.bytes }; }); },
      async discardUnacknowledged(id) { return runInDatabaseTransaction(pool, client => client.query('DELETE FROM jeroc_sickness_files WHERE id=$1', [id])); },
      close: () => pool.end(),
    };
  }
  const path = suppliedFilename ?? env.JEROC_SICKNESS_FILES_DB_PATH ?? fileURLToPath(new URL('../.data/sickness-files.sqlite', import.meta.url));
  if (path !== ':memory:') await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL;');
  database.exec(sql.replaceAll('JSONB', 'TEXT').replaceAll('BYTEA', 'BLOB').replaceAll('TIMESTAMPTZ', 'TEXT'));
  if (path !== ':memory:') await chmod(path, 0o600);
  return {
    async insert(record, bytes) { database.prepare('INSERT INTO jeroc_sickness_files(id,case_id,person_id,record,bytes,created_at) VALUES(?,?,?,?,?,?)').run(record.id, record.caseId, record.personId, JSON.stringify(record), bytes, record.uploadedAt); return record; },
    async list(caseId, personId) { return database.prepare('SELECT record FROM jeroc_sickness_files WHERE case_id=? AND person_id=? ORDER BY created_at').all(caseId, personId).map(row => JSON.parse(row.record)); },
    async file(id) { const row = database.prepare('SELECT record,bytes FROM jeroc_sickness_files WHERE id=?').get(id); return row && { record: JSON.parse(row.record), bytes: Buffer.from(row.bytes) }; },
    async discardUnacknowledged(id) { database.prepare('DELETE FROM jeroc_sickness_files WHERE id=?').run(id); },
    async close() { database.close(); },
  };
}

export function createSicknessFilesApi({ env, getRepository, ownPrincipal, officePrincipal, json, fileRepository } = {}) {
  let filePromise;
  const ready = () => filePromise ??= fileRepository ? Promise.resolve(fileRepository) : createSicknessFileRepository({ env }).catch(error => { filePromise = undefined; throw error; });
  const api = async (req, res, url) => {
    const own = url.pathname.startsWith('/api/employee/sickness/files');
    const base = own ? '/api/employee/sickness/files' : '/api/personnel/sickness/files';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    try {
      if (!['GET', 'POST', 'HEAD'].includes(req.method)) fail('Metoden stöds inte.', 405);
      const read = req.method !== 'POST', suffix = url.pathname.slice(base.length);
      if (suffix && (!read || !/^\/[a-f0-9-]+$/i.test(suffix) || !uuid.test(suffix.slice(1)))) fail('Intyget finns inte.', 404);
      if ([...url.searchParams.keys()].some(key => !(own ? ['caseId'] : ['caseId', 'personId']).includes(key))) fail('Ogiltigt intygsfilter.');
      if (!read && req.headers['sec-fetch-site'] === 'cross-site') fail('Anropet måste komma från samma webbplats.', 403);
      if (!read && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) fail('Anropet måste komma från samma webbplats.', 403);
      const repository = await getRepository();
      const archive = await ready();
      const stored = suffix ? await archive.file(suffix.slice(1)) : undefined;
      if (suffix && !stored) fail('Intyget finns inte.', 404);
      const caseId = stored?.record.caseId ?? url.searchParams.get('caseId');
      if (!caseId || caseId.length > 120) fail('Välj ett sjukärende.');
      const authorize = state => {
        const principal = own ? ownPrincipal(state, req) : officePrincipal(state, req);
        if (!principal) fail('Logga in för att öppna intyget.', 401);
        const illness = state.employeeSickness?.cases?.find(item => item.id === caseId);
        const person = state.personnel?.people?.find(item => item.id === illness?.personId);
        if (!person || person.kind !== 'employee') fail('Sjukärendet finns inte.', 404);
        if (own) {
          if (person.userId !== principal.user.id && person.id !== principal.user.id) fail('Du kan bara öppna dina egna intyg.', 403);
          if (req.headers['x-employee-person'] !== undefined && req.headers['x-employee-person'] !== person.id) fail('Personalkontot har bytts. Öppna sjukärendet igen.', 409);
        } else {
          if (![principal.actor, principal.user].every(user => permitted(user, 'personnelRead') && permitted(user, read ? 'absenceRead' : 'absenceWrite') && scope(user, person))) fail('Du saknar behörighet till personens intyg.', 403);
          const requestedPerson = url.searchParams.get('personId');
          if (requestedPerson && requestedPerson !== person.id) fail('Personvalet har ändrats.', 409);
        }
        if (stored && stored.record.personId !== person.id) fail('Intyget hör inte till sjukärendet.', 409);
        if (stored && !state.employeeSickness.events.some(event => event.action === 'certificate.upload' && event.fileId === stored.record.id && event.caseId === caseId)) fail('Intygets registrering har inte bekräftats.', 404);
        return { principal, person, illness };
      };
      await repository.read(authorize, { domains: ['pricing', 'personnel', 'personnelAuth', 'employeeSickness'] });
      if (!read) {
        const declared = Number(req.headers['content-length']);
        if (declared > MAX_CERTIFICATE_BYTES) fail('Intyget får vara högst 5 MB.', 413);
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > MAX_CERTIFICATE_BYTES) fail('Intyget får vara högst 5 MB.', 413); chunks.push(chunk); }
        let name; try { name = decodeURIComponent(req.headers['x-file-name'] ?? 'läkarintyg'); } catch { name = 'läkarintyg'; }
        const prepared = await prepareSicknessFile(Buffer.concat(chunks), req.headers['content-type']?.split(';')[0].trim().toLowerCase(), name);
        let insertedId;
        let record;
        try { record = await repository.transact(async (state, _, audit) => {
          const { principal, person, illness } = authorize(state), at = new Date().toISOString();
          const record = { id: randomUUID(), caseId, personId: person.id, name: prepared.name, contentType: prepared.contentType, size: prepared.bytes.length,
            uploadedAt: at, createdBy: principal.actor.id, effectiveUserId: principal.user.id, hash: createHash('sha256').update(prepared.bytes).digest('hex') };
          await archive.insert(record, prepared.bytes);
          insertedId = record.id;
          state.employeeSickness.events.push({ id: randomUUID(), fileId: record.id, caseId, personId: person.id, action: 'certificate.upload', at, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, text: 'Läkarintyg uppladdat. Giltighetsperioden behöver kontrolleras.' });
          state.employeeSickness.revision += 1;
          audit.push({ action: 'sickness.certificate.upload', fileId: record.id, caseId: illness.id, personId: person.id, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, at });
          return record;
        }); } catch (error) {
          // PostgreSQL shares the transaction. SQLite's two local files need a
          // compensation, but only after a fresh read proves no acknowledgement.
          if (insertedId) {
            try {
              const linked = await repository.read(state => state.employeeSickness?.events?.some(event => event.fileId === insertedId && event.action === 'certificate.upload'), { domains: ['employeeSickness'] });
              if (!linked) await archive.discardUnacknowledged(insertedId);
            } catch { /* An uncertain commit is left private and re-read later. */ }
          }
          throw error;
        }
        json(res, 201, { file: safe(record) });
      } else if (stored) {
        // Reauthorize and audit every download, with no medical bytes in audit.
        await repository.transact((state, _, audit) => { const { principal, person } = authorize(state); audit.push({ action: 'sickness.certificate.download', fileId: stored.record.id, caseId, personId: person.id, actualUserId: principal.actor.id, effectiveUserId: principal.user.id, at: new Date().toISOString() }); });
        res.writeHead(200, { 'Content-Type': stored.record.contentType, 'Content-Length': stored.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'", 'Content-Disposition': `attachment; filename="intyg.${stored.record.contentType === 'application/pdf' ? 'pdf' : 'jpg'}"; filename*=UTF-8''${encodeURIComponent(stored.record.name)}` });
        res.end(req.method === 'HEAD' ? undefined : stored.bytes);
      } else {
        const { person, ids } = await repository.read(state => ({ ...authorize(state), ids: state.employeeSickness.events.filter(event => event.action === 'certificate.upload' && event.caseId === caseId).map(event => event.fileId) }), { domains: ['pricing', 'personnel', 'personnelAuth', 'employeeSickness'] });
        json(res, 200, { files: (await archive.list(caseId, person.id)).filter(file => ids.includes(file.id)).map(safe) });
      }
    } catch (error) { json(res, error instanceof PricingError ? error.status : 503, { error: error instanceof PricingError ? error.message : 'Intygsarkivet kunde inte nås. Försök igen.' }); }
    return true;
  };
  api.close = async () => { if (filePromise) await (await filePromise).close(); };
  return api;
}
