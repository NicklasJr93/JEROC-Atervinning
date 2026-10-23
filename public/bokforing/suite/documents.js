// Local demo document inbox. Original bytes are immutable and kept separately
// from the accounting state; this is not a server archive or an email receiver.
export const DOCUMENT_DB_NAME = 'scrapplanner-bokforing-documents-v1';
export const DOCUMENT_LIMITS = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxBatchFiles: 10,
});

const STORE = 'documents';
const fields = ['id', 'name', 'type', 'size', 'sha256', 'createdAt', 'source'];
const formats = new Map([
  ['pdf', 'application/pdf'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['png', 'image/png'], ['webp', 'image/webp'],
]);
const types = new Set(formats.values());
const shaPattern = /^[a-f0-9]{64}$/;
const idPattern = /^doc-[a-f0-9]{64}$/;

function failure(message, code = 'DOCUMENT_INVALID', cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
function requireValue(condition, message, code) {
  if (!condition) throw failure(message, code);
}
function storageFailure(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('DOCUMENT_')) return error;
  if (error?.name === 'QuotaExceededError') return failure('Webbläsarens lagringsutrymme är fullt. Inga nya underlag sparades.', 'DOCUMENT_QUOTA_EXCEEDED', error);
  return failure('Underlagen kunde inte sparas eller läsas i webbläsaren. Försök igen och kontrollera att lokal lagring är tillåten.', 'DOCUMENT_STORAGE_ERROR', error);
}
function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(name);
}
function checkId(id) {
  requireValue(typeof id === 'string' && idPattern.test(id), 'Underlagets identifierare är ogiltig.');
}
function checkMetadata(record) {
  requireValue(record && typeof record === 'object', 'Underlagets uppgifter saknas.', 'DOCUMENT_CORRUPT');
  checkId(record.id);
  requireValue(shaPattern.test(record.sha256) && record.id === `doc-${record.sha256}`, 'Underlagets kontrollsumma är ogiltig.', 'DOCUMENT_CORRUPT');
  requireValue(validName(record.name) && types.has(record.type), 'Underlagets namn eller filtyp är ogiltig.', 'DOCUMENT_CORRUPT');
  requireValue(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= DOCUMENT_LIMITS.maxFileBytes,
    'Underlagets filstorlek är ogiltig.', 'DOCUMENT_CORRUPT');
  requireValue(typeof record.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.createdAt) && Number.isFinite(Date.parse(record.createdAt)),
    'Underlagets ankomstdatum är ogiltigt.', 'DOCUMENT_CORRUPT');
  requireValue(record.source === 'file' || record.source === 'camera', 'Underlagets källa är ogiltig.', 'DOCUMENT_CORRUPT');
}

export function documentMetadata(record) {
  checkMetadata(record);
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}

function checkRecord(record) {
  checkMetadata(record);
  requireValue(record.blob && typeof record.blob.arrayBuffer === 'function' && record.blob.size === record.size && record.blob.type === record.type,
    'Originalfilen saknas eller stämmer inte med underlagets uppgifter.', 'DOCUMENT_CORRUPT');
  return record;
}

function signatureMatches(bytes, type) {
  const starts = signature => signature.every((byte, index) => bytes[index] === byte);
  if (type === 'application/pdf') return starts([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  if (type === 'image/jpeg') return starts([0xff, 0xd8, 0xff]);
  if (type === 'image/png') return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return type === 'image/webp' && bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) &&
    [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte);
}

export function createDocumentStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, dbName = DOCUMENT_DB_NAME } = {}) {
  let connection;
  async function database() {
    requireValue(indexedDB && typeof indexedDB.open === 'function',
      'Den här webbläsaren saknar stöd för lokal underlagslagring. Prova en vanlig webbläsarflik med lokal lagring tillåten.', 'DOCUMENT_STORAGE_UNAVAILABLE');
    if (!connection) {
      connection = new Promise((resolve, reject) => {
        let request;
        try { request = indexedDB.open(dbName, 1); } catch (error) { reject(storageFailure(error)); return; }
        let settled = false;
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        request.onsuccess = () => {
          if (settled) { request.result.close(); return; }
          settled = true;
          request.result.onversionchange = () => { request.result.close(); connection = null; };
          resolve(request.result);
        };
        request.onerror = () => { settled = true; reject(storageFailure(request.error)); };
        request.onblocked = () => {
          settled = true;
          reject(failure('Underlagslagringen väntar på en annan flik. Stäng äldre demoflikar och försök igen.', 'DOCUMENT_STORAGE_BLOCKED'));
        };
      }).catch(error => { connection = null; throw error; });
    }
    return connection;
  }
  async function transaction(mode, work) {
    const db = await database();
    return new Promise((resolve, reject) => {
      let tx, result, workError;
      const abort = error => { workError = error; try { tx.abort(); } catch { reject(storageFailure(error)); } };
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(storageFailure(workError || tx.error));
        tx.onerror = () => { /* onabort reports the failed transaction, never a success. */ };
        work(tx.objectStore(STORE), value => { result = value; }, abort);
      } catch (error) { if (tx) abort(error); else reject(storageFailure(error)); }
    });
  }
  async function hash(bytes) {
    requireValue(crypto?.subtle && typeof crypto.subtle.digest === 'function',
      'Säker filkontroll kräver HTTPS eller localhost i en modern webbläsare.', 'DOCUMENT_STORAGE_UNAVAILABLE');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function prepare(file, source) {
    requireValue(file && typeof file.arrayBuffer === 'function' && validName(file.name), 'Välj en fil med ett giltigt filnamn.');
    requireValue(Number.isSafeInteger(file.size) && file.size > 0, `Filen ${file.name} är tom eller har ogiltig storlek.`);
    requireValue(file.size <= DOCUMENT_LIMITS.maxFileBytes, `Filen ${file.name} är för stor. Högst 15 MB per underlag tillåts i demon.`, 'DOCUMENT_FILE_TOO_LARGE');
    const extension = file.name.toLowerCase().split('.').at(-1), type = formats.get(extension);
    const declaredType = (file.type || '').toLowerCase();
    requireValue(type && (!declaredType || declaredType === type || (type === 'image/jpeg' && declaredType === 'image/jpg')),
      `Filen ${file.name} behöver vara PDF, JPG, PNG eller WebP och ha rätt filändelse.`, 'DOCUMENT_FILE_TYPE');
    let buffer;
    try { buffer = await file.arrayBuffer(); } catch (error) { throw failure(`Filen ${file.name} kunde inte läsas.`, 'DOCUMENT_FILE_READ', error); }
    const bytes = new Uint8Array(buffer);
    requireValue(bytes.length === file.size && signatureMatches(bytes, type),
      `Innehållet i ${file.name} stämmer inte med filtypen. Välj originalfilen som PDF eller bild.`, 'DOCUMENT_FILE_TYPE');
    const sha256 = await hash(buffer);
    return { id: `doc-${sha256}`, name: file.name, type, size: bytes.length, sha256,
      createdAt: new Date().toISOString(), source, blob: new Blob([buffer], { type }) };
  }
  const api = {
    async importFiles(files, { source = 'file' } = {}) {
      requireValue(source === 'file' || source === 'camera', 'Välj filuppladdning eller kamera som underlagets källa.');
      const input = Array.from(files ?? []);
      requireValue(input.length > 0, 'Välj minst en PDF eller bild att ladda upp.');
      requireValue(input.length <= DOCUMENT_LIMITS.maxBatchFiles, 'Ladda upp högst 10 underlag åt gången.');
      // Read and validate the whole batch before opening a write transaction.
      const unique = new Map();
      for (const file of input) { const record = await prepare(file, source); if (!unique.has(record.id)) unique.set(record.id, record); }
      return transaction('readwrite', (store, done, abort) => {
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const existing = new Map(request.result.map(record => [checkRecord(record).id, record]));
            const additions = [...unique.values()].filter(record => !existing.has(record.id));
            const total = [...existing.values(), ...additions].reduce((sum, record) => sum + record.size, 0);
            requireValue(total <= DOCUMENT_LIMITS.maxTotalBytes,
              'Demons underlagslagring rymmer högst 100 MB. Ta bort olänkade underlag eller använd färre filer.', 'DOCUMENT_TOTAL_TOO_LARGE');
            additions.forEach(record => store.add(record));
            done([...unique.values()].map(record => documentMetadata(existing.get(record.id) || record)));
          } catch (error) { abort(error); }
        };
      });
    },
    async list() {
      return transaction('readonly', (store, done, abort) => {
        const request = store.getAll();
        request.onsuccess = () => { try { done(request.result.map(checkRecord).map(documentMetadata).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))); } catch (error) { abort(error); } };
      });
    },
    async get(id) {
      checkId(id);
      return transaction('readonly', (store, done, abort) => {
        const request = store.get(id);
        request.onsuccess = () => { try { done(request.result ? checkRecord(request.result) : null); } catch (error) { abort(error); } };
      });
    },
    async remove(id) {
      checkId(id);
      return transaction('readwrite', (store, done) => { store.delete(id); done(); });
    },
    async verifyDocuments(metadata) {
      requireValue(Array.isArray(metadata), 'Listan över kopplade underlag är ogiltig.');
      const ids = new Set(), verified = [];
      for (const expected of metadata) {
        checkMetadata(expected);
        requireValue(!ids.has(expected.id), 'Samma underlag får inte kopplas två gånger.'); ids.add(expected.id);
        const record = await api.get(expected.id);
        requireValue(record, `Originalfilen ${expected.name} saknas i den här webbläsaren. Underlaget behöver återställas innan du fortsätter.`, 'DOCUMENT_MISSING');
        requireValue(fields.every(field => record[field] === expected[field]),
          `Uppgifterna om ${expected.name} stämmer inte med den sparade originalfilen.`, 'DOCUMENT_CORRUPT');
        const buffer = await record.blob.arrayBuffer(), bytes = new Uint8Array(buffer);
        requireValue(bytes.length === record.size && signatureMatches(bytes, record.type) && await hash(buffer) === record.sha256,
          `Originalfilen ${record.name} klarade inte filkontrollen.`, 'DOCUMENT_CORRUPT');
        verified.push(documentMetadata(record));
      }
      return verified;
    },
    async close() { const pending = connection; connection = null; if (pending) (await pending).close(); },
  };
  return api;
}
