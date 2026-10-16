import { randomUUID, createHash } from 'node:crypto';
import { mkdir, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';
import { PricingError } from './pricing.mjs';
import { runDatabaseRead, runInDatabaseTransaction } from './database-runtime.mjs';
import { ensureFleet, fleetProjection, employeeFleetProjection } from './fleet.mjs';
import { getPlatformContext } from './platform-auth.mjs';

export const MAX_FLEET_FILE_BYTES = 8 * 1024 * 1024;
const limit = MAX_FLEET_FILE_BYTES;
const maxVehicleBytes = 128 * 1024 * 1024, maxVehicleFiles = 1000;
const fail = (message, status = 422) => { throw new PricingError(message, status); };
const cleanName = value => String(value || 'fordonsbilaga').split(/[/\\]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 150) || 'fordonsbilaga';
const dispositionName = value => encodeURIComponent(value).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const fileReceipts = state => state.fleet?.fileReceipts ?? [];
const acknowledged = (state, record) => fileReceipts(state).some(receipt => receipt.fileId === record.id && receipt.vehicleId === record.vehicleId);
const sql = `CREATE TABLE IF NOT EXISTS jeroc_fleet_files (id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, record JSONB NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS jeroc_fleet_files_vehicle_created ON jeroc_fleet_files(vehicle_id,created_at);`;

/** Call inside the profile/report transaction, after vehicle authorization.
 * A protected URL is a reference to an acknowledged file, not an authority to
 * relabel another vehicle's evidence. Document numbers remain ordinary text. */
export function assertFleetFileReferences(state, vehicleId, references, { kind = 'photo' } = {}) {
  if (!Array.isArray(references)) fail('Bilagereferenserna är ogiltiga.');
  for (const value of references) {
    if (typeof value !== 'string' || value.length > 1000) fail('Bilagereferensen är ogiltig.');
    const reference = value.trim(); if (!reference) continue;
    const local = reference.match(/^\/api\/fleet\/files\/([0-9a-f-]{36})$/i);
    if (local) {
      const receipt = fileReceipts(state).find(receipt => receipt.fileId === local[1] && receipt.vehicleId === vehicleId && receipt.kind === kind);
      if (!receipt) fail('Bilagan är inte en bekräftad fil av rätt slag för det här fordonet.', 404);
      continue;
    }
    if (reference.startsWith('https://')) {
      let parsed; try { parsed = new URL(reference); } catch { fail('Bilagans adress är ogiltig.'); }
      if (!parsed.hostname || parsed.username || parsed.password) fail('Bilagans adress är ogiltig.');
      continue;
    }
    if (kind !== 'document' || reference.startsWith('/') || /^[a-z][a-z\d+.-]*:\/\//i.test(reference) || /^(?:javascript|vbscript|data|file|https?):/i.test(reference)) fail('Använd en sparad bilaga, en HTTPS-adress eller ett vanligt dokumentnummer.');
  }
}

export async function prepareFleetFile(bytes, contentType, name, kind) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) fail('Välj en fil på högst 8 MB.', 413);
  if (!['photo', 'document'].includes(kind)) fail('Välj bild eller dokument.');
  contentType = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (kind === 'document' && contentType === 'application/pdf') {
    const header = bytes.subarray(0, 16).toString('latin1'), tail = bytes.subarray(-4096).toString('latin1');
    const xref = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/), offset = Number(xref?.[1]);
    const crossReference = Number.isSafeInteger(offset) && offset > 0 && offset < bytes.length ? bytes.subarray(offset, offset + 200).toString('latin1') : '';
    // Recognize a real cross-reference table or stream, not an arbitrary file
    // with a pasted PDF header. PDFs are always served as sandboxed downloads.
    if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(header) || !xref || !/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(crossReference) || !/\/Root\s+\d+\s+\d+\s+R\b/.test(bytes.toString('latin1')))
      fail('Filen är inte en giltig PDF.', 415);
    return { bytes: Buffer.from(bytes), contentType, name: cleanName(name).replace(/\.pdf$/i, '') + '.pdf' };
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) fail('Välj JPEG, PNG eller WebP. Dokument kan även vara PDF.', 415);
  const signature = contentType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!signature) fail('Bildens innehåll stämmer inte med filtypen.', 415);
  try {
    const source = sharp(bytes, { limitInputPixels: 30_000_000, failOn: 'warning' });
    const info = await source.metadata();
    if (info.format !== ({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' })[contentType] || (info.pages ?? 1) !== 1) fail('Bildens innehåll stämmer inte med filtypen.', 415);
    return { bytes: await source.rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(), contentType: 'image/jpeg', name: cleanName(name).replace(/\.[^.]+$/, '') + '.jpg' };
  } catch (error) { if (error instanceof PricingError) throw error; fail('Bilden kunde inte läsas.', 415); }
}

export async function createFleetFileRepository({ env = process.env, vehicleByteLimit = maxVehicleBytes, vehicleFileLimit = maxVehicleFiles } = {}) {
  if (![vehicleByteLimit, vehicleFileLimit].every(value => Number.isSafeInteger(value) && value > 0)) fail('Bilagearkivets gränser är ogiltiga.', 503);
  if (env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, connectionTimeoutMillis: 8000 });
    try { await runInDatabaseTransaction(pool, async client => { await client.query('SELECT pg_advisory_xact_lock(1803299871)'); await client.query(sql); }); }
    catch (error) { await pool.end(); throw error; }
    return {
      insert: (record, bytes) => runInDatabaseTransaction(pool, async client => {
        await client.query('SELECT pg_advisory_xact_lock(1803299872,hashtext($1))', [record.vehicleId]);
        const totals = (await client.query('SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(bytes)),0) AS size FROM jeroc_fleet_files WHERE vehicle_id=$1', [record.vehicleId])).rows[0];
        if (Number(totals.count) >= vehicleFileLimit || Number(totals.size) + bytes.length > vehicleByteLimit) fail('Fordonets bilagearkiv har nått sin lagringsgräns.', 413);
        await client.query('INSERT INTO jeroc_fleet_files(id,vehicle_id,record,bytes,created_at) VALUES($1,$2,$3,$4,$5)', [record.id, record.vehicleId, JSON.stringify(record), bytes, record.uploadedAt]); return record;
      }),
      list: vehicleId => runDatabaseRead(pool, async client => (await client.query('SELECT record FROM jeroc_fleet_files WHERE vehicle_id=$1 ORDER BY created_at DESC LIMIT 100', [vehicleId])).rows.map(row => row.record)),
      file: id => runDatabaseRead(pool, async client => { const row = (await client.query('SELECT record,bytes FROM jeroc_fleet_files WHERE id=$1', [id])).rows[0]; return row && { record: row.record, bytes: row.bytes }; }),
      remove: id => runInDatabaseTransaction(pool, client => client.query('DELETE FROM jeroc_fleet_files WHERE id=$1', [id])), close: () => pool.end(),
    };
  }
  if (env.RENDER) fail('Fordonsarkivet behöver bolagets databas för beständig lagring.', 503);
  const filename = env.JEROC_FLEET_FILES_DB_PATH ?? resolve('.data/fleet-files.sqlite');
  if (filename !== ':memory:') await mkdir(dirname(resolve(filename)), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=8000; PRAGMA journal_mode=WAL;');
  db.exec(sql.replaceAll('JSONB', 'TEXT').replaceAll('BYTEA', 'BLOB').replaceAll('TIMESTAMPTZ', 'TEXT'));
  if (filename !== ':memory:') await chmod(filename, 0o600);
  return {
    async insert(record, bytes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const totals = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(bytes)),0) AS size FROM jeroc_fleet_files WHERE vehicle_id=?').get(record.vehicleId);
        if (totals.count >= vehicleFileLimit || totals.size + bytes.length > vehicleByteLimit) fail('Fordonets bilagearkiv har nått sin lagringsgräns.', 413);
        db.prepare('INSERT INTO jeroc_fleet_files(id,vehicle_id,record,bytes,created_at) VALUES(?,?,?,?,?)').run(record.id, record.vehicleId, JSON.stringify(record), bytes, record.uploadedAt);
        db.exec('COMMIT'); return record;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async list(vehicleId) { return db.prepare('SELECT record FROM jeroc_fleet_files WHERE vehicle_id=? ORDER BY created_at DESC LIMIT 100').all(vehicleId).map(row => JSON.parse(row.record)); },
    async file(id) { const row = db.prepare('SELECT record,bytes FROM jeroc_fleet_files WHERE id=?').get(id); return row && { record: JSON.parse(row.record), bytes: Buffer.from(row.bytes) }; },
    async remove(id) { db.prepare('DELETE FROM jeroc_fleet_files WHERE id=?').run(id); }, async close() { db.close(); },
  };
}

export function createFleetFilesApi({ env = process.env, getRepository, ownPrincipal, officePrincipal, json, fileRepository, uploadTimeoutMs = 30_000, concurrentUploadLimit = 4 } = {}) {
  let archive, activeUploads = 0;
  const ready = () => archive ??= (fileRepository ? Promise.resolve(fileRepository) : createFleetFileRepository({ env })).catch(error => { archive = undefined; throw error; });
  const api = async (req, res, url) => {
    const employeeRoute = url.pathname.startsWith('/api/employee/fleet/files');
    const base = employeeRoute ? '/api/employee/fleet/files' : '/api/fleet/files';
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) return false;
    let reservedUpload = false;
    try {
      const read = ['GET', 'HEAD'].includes(req.method), suffix = url.pathname.slice(base.length), requestedVehicle = url.searchParams.get('vehicleId'), kind = url.searchParams.get('kind');
      if (!read && req.method !== 'POST') fail('Metoden stöds inte.', 405);
      if (suffix && (!read || !/^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix))) fail('Bilagan finns inte.', 404);
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !['vehicleId', 'kind'].includes(key)) || new Set(keys).size !== keys.length) fail('Ogiltigt bilagefilter.');
      if (kind !== null && !['photo', 'document'].includes(kind) || !read && !kind) fail('Välj bild eller dokument.');
      let origin;
      if (req.headers.origin) { try { origin = new URL(req.headers.origin); } catch { fail('Ogiltigt ursprung.', 403); } }
      if (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin.host !== req.headers.host) fail('Öppna bilagan på samma webbplats.', 403);
      const repository = await getRepository();
      const identity = state => {
        // A genuine employee cookie wins over all office headers and cannot
        // fall back when stale. The route itself never selects another person.
        const own = ownPrincipal?.(state, req);
        if (own) {
          const people = (state.personnel?.people ?? []).filter(person => person.userId === own.user?.id || !person.userId && person.id === own.user?.id);
          if (people.length !== 1) fail('Ditt konto saknar en entydig personkoppling.', 403);
          const person = people[0];
          if (req.headers['x-employee-person'] !== undefined && req.headers['x-employee-person'] !== person.id) fail('Personalkontot har ändrats. Logga in igen.', 409);
          return { principal: own, person, own: true };
        }
        if (employeeRoute) fail('Logga in i personalappen för att öppna fordonsbilagor.', 401);
        const context = getPlatformContext(req);
        let principal;
        if (context) {
          const organisationId = env.JEROC_TENANT_ID ?? env.SCRAPPILOT_ORGANISATION_ID ?? 'jeroc-demo';
          if (context.organisationId !== organisationId) fail('Bilagan hör till ett annat bolag.', 403);
          const liveUser = snapshot => {
            const current = state.pricing?.users?.find(user => user.id === snapshot?.id);
            if (current) { if (current.active === false) fail('Kontot är inte längre aktivt.', 401); return current; }
            // This reserved principal is supplied only by the authenticated
            // platform gateway, never by tenant JSON or an arbitrary header.
            if (context.platformAdmin === true && snapshot?.id === '__platform-admin' && snapshot.active !== false && snapshot.level === 'Systemadmin') return snapshot;
            fail('Kontot finns inte längre i bolaget.', 401);
          };
          principal = { actor: liveUser(context.actualUser), user: liveUser(context.user) };
          if (principal.actor.id !== principal.user.id && principal.actor.level !== 'Systemadmin') fail('Kontots valda arbetsidentitet saknar behörighet.', 403);
        } else principal = officePrincipal?.(state, req);
        if (!principal) fail('Logga in för att öppna fordonsbilagor.', 401);
        return { principal, own: false };
      };
      await repository.read(identity, { domains: ['pricing', 'personnel', 'personnelAuth'] });
      const files = await ready(), stored = suffix ? await files.file(suffix.slice(1)) : undefined;
      if (suffix && !stored) fail('Bilagan finns inte.', 404);
      const vehicleId = stored?.record.vehicleId ?? requestedVehicle;
      if (!vehicleId || vehicleId.length > 120) fail('Välj ett fordon.');
      if (stored && (requestedVehicle && requestedVehicle !== vehicleId || kind && stored.record.kind !== kind)) fail('Bilagan hör inte till det valda fordonet eller filslaget.', 404);
      const authorize = state => {
        const auth = identity(state), projection = auth.own ? employeeFleetProjection(state, { personId: auth.person.id, principal: auth.principal }) : fleetProjection(state, auth.principal);
        if (!projection.vehicles.some(vehicle => vehicle.id === vehicleId)) fail('Fordonet finns inte i din vy.', 404);
        if (!read && !auth.own && !projection.capabilities.write) fail('Du saknar behörighet att ladda upp fordonsbilagor.', 403);
        if (!read && auth.own && (!state.fleet?.profiles?.[vehicleId]?.siteId || kind === 'document')) fail('Fordonsdokument hanteras av kontoret. Bilder kräver ett tillgängligt fordon med registrerad anläggning.', 403);
        if (stored && !acknowledged(state, stored.record)) fail('Bilagans registrering har inte bekräftats.', 404);
        return auth;
      };
      const initialAuth = await repository.read(authorize, { domains: ['pricing', 'personnel', 'personnelAuth', 'transport', 'fleet'] });
      if (stored) {
        await repository.transact((state, _, audit = []) => { const auth = authorize(state); audit.push({ action: 'fleet.file.downloaded', vehicleId, fileId: stored.record.id, actualUserId: auth.principal.actor.id, effectiveUserId: auth.principal.user.id, at: new Date().toISOString() }); });
        res.writeHead(200, { 'Content-Type': stored.record.contentType, 'Content-Length': stored.bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `${stored.record.kind === 'photo' ? 'inline' : 'attachment'}; filename*=UTF-8''${dispositionName(stored.record.name)}` });
        res.end(req.method === 'HEAD' ? undefined : stored.bytes); return true;
      }
      if (read) {
        const records = await files.list(vehicleId), receipts = await repository.read(state => { authorize(state); return new Set(fileReceipts(state).filter(receipt => receipt.vehicleId === vehicleId).map(receipt => receipt.fileId)); });
        json(res, 200, { files: records.filter(record => receipts.has(record.id) && (!kind || record.kind === kind)) }); return true;
      }
      if (activeUploads >= concurrentUploadLimit) { req.resume(); fail('Flera bilagor behandlas. Försök igen om en liten stund.', 429); }
      activeUploads++; reservedUpload = true;
      if (req.headers['content-length'] !== undefined && !/^\d+$/.test(req.headers['content-length'])) fail('Filens storleksuppgift är ogiltig.', 400);
      if (Number(req.headers['content-length']) > limit) { req.resume(); fail('Filen får vara högst 8 MB.', 413); }
      let timedOut = false, timer;
      const consume = async () => { let size = 0; const chunks = []; for await (const chunk of req) { if (timedOut) return Buffer.alloc(0); size += chunk.length; if (size > limit) fail('Filen får vara högst 8 MB.', 413); chunks.push(chunk); } return Buffer.concat(chunks); };
      let bytes;
      try { bytes = await Promise.race([consume(), new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; req.resume(); reject(new PricingError('Uppladdningen tog för lång tid. Försök igen.', 408)); }, uploadTimeoutMs); timer.unref?.(); })]); }
      finally { clearTimeout(timer); }
      let name; try { name = decodeURIComponent(req.headers['x-file-name'] ?? 'fordonsbilaga'); } catch { fail('Filnamnet kunde inte läsas.'); }
      const prepared = await prepareFleetFile(bytes, req.headers['content-type'], name, kind);
      const id = randomUUID(), record = { id, vehicleId, kind, name: prepared.name, contentType: prepared.contentType, size: prepared.bytes.length, uploadedAt: new Date().toISOString(), url: `/api/fleet/files/${id}` };
      let inserted = false;
      try {
        await repository.transact(async (state, _, audit = []) => {
          const auth = authorize(state);
          if (auth.principal.actor.id !== initialAuth.principal.actor.id || auth.principal.user.id !== initialAuth.principal.user.id || auth.person?.id !== initialAuth.person?.id) fail('Kontot har ändrats under uppladdningen. Försök igen.', 409);
          await files.insert(record, prepared.bytes); inserted = true;
          const fleet = ensureFleet(state); fleet.fileReceipts ??= [];
          const receipt = { fileId: id, vehicleId, kind, at: record.uploadedAt, actualUserId: auth.principal.actor.id, effectiveUserId: auth.principal.user.id, hash: createHash('sha256').update(prepared.bytes).digest('hex') };
          fleet.fileReceipts.push(receipt); audit.push({ action: 'fleet.file.uploaded', ...receipt });
        });
      } catch (error) {
        // A local SQLite file cannot join the aggregate transaction. Delete an
        // insert only after a fresh read proves that no durable receipt exists;
        // an uncertain committed result must never destroy acknowledged bytes.
        if (inserted) { try { if (!await repository.read(state => acknowledged(state, record), { domains: ['fleet'] })) await files.remove(id); } catch { /* Leave uncertain data private pending a later confirmed read. */ } }
        throw error;
      }
      json(res, 200, { file: record });
    } catch (error) { json(res, error instanceof PricingError ? error.status : 503, { error: error instanceof PricingError ? error.message : 'Fordonsbilagan kunde inte sparas eller öppnas.' }); }
    finally { if (reservedUpload) activeUploads--; }
    return true;
  };
  return Object.assign(api, { close: async () => { if (archive) await (await archive).close(); } });
}
