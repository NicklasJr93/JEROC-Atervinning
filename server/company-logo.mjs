import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createCompanyLogoRepository } from './company-logo-storage.mjs';

export const MAX_COMPANY_LOGO_BYTES = 1024 * 1024;
export const MAX_COMPANY_LOGO_PIXELS = 20_000_000;
export const companyLogoIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const types = new Map([['image/png', 'png'], ['image/jpeg', 'jpeg'], ['image/webp', 'webp']]);
export class CompanyLogoError extends Error {
  constructor(message, status = 422, code = 'company_logo_invalid') { super(message); this.status = status; this.code = code; }
}
const fail = (message, status, code) => { throw new CompanyLogoError(message, status, code); };
const publicLogo = record => ({ logoId: record.id, url: `/api/company-settings/logos/${record.id}` });

/** Only decoded pixels survive. SVG, animation, metadata and remote URLs never
 * enter the archive or PDF renderer. PNG keeps transparent company marks. */
export async function prepareCompanyLogo(input, { maxPixels = MAX_COMPANY_LOGO_PIXELS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['contentType', 'base64'].includes(key))
    || !types.has(input.contentType) || typeof input.base64 !== 'string')
    fail('Välj en PNG-, JPEG- eller WebP-logga.', 415, 'company_logo_type');
  const encoded = input.base64;
  if (!encoded) fail('Loggan är tom. Välj en bildfil.', 422, 'company_logo_invalid');
  if (encoded.length > Math.ceil(MAX_COMPANY_LOGO_BYTES / 3) * 4)
    fail('Loggan får vara högst 1 MB.', 413, 'company_logo_too_large');
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    fail('Loggan kunde inte läsas. Välj en giltig bildfil.', 422, 'company_logo_invalid');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_COMPANY_LOGO_BYTES)
    fail('Loggan får vara högst 1 MB.', 413, 'company_logo_too_large');
  const magic = input.contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : input.contentType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!magic) fail('Filens innehåll matchar inte bildtypen.', 415, 'company_logo_type');
  try {
    const image = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== types.get(input.contentType)) fail('Filens innehåll matchar inte bildtypen.', 415, 'company_logo_type');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxPixels)
      fail('Loggan har för hög upplösning.', 413, 'company_logo_pixels');
    if ((metadata.pages ?? 1) !== 1) fail('Animerade loggor stöds inte.', 422, 'company_logo_animated');
    const result = await image.rotate().resize({ width: 1200, height: 400, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
    return { bytes: result.data, width: result.info.width, height: result.info.height,
      contentHash: createHash('sha256').update('scrapplanner-company-logo-v1\0').update(result.data).digest('hex') };
  } catch (error) {
    if (error instanceof CompanyLogoError) throw error;
    if (/pixel limit|exceeds.*limit|image.*too large/i.test(error.message)) fail('Loggan har för hög upplösning.', 413, 'company_logo_pixels');
    fail('Loggan kunde inte läsas. Välj en giltig PNG-, JPEG- eller WebP-bild.', 422, 'company_logo_invalid');
  }
}

/** A service instance belongs to one server-selected company for its lifetime. */
export function createCompanyLogoService({ env = process.env, organisationId, repository, now = () => new Date() } = {}) {
  if (typeof organisationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(organisationId)) throw new TypeError('Bolagets servervalda identitet krävs.');
  let storage, closed = false;
  const ready = () => closed ? Promise.reject(new CompanyLogoError('Loggarkivet är stängt.', 503, 'company_logo_unavailable'))
    : storage ??= Promise.resolve(repository ?? createCompanyLogoRepository({ env, organisationId }));
  function demand(principal) {
    if (!principal?.actorId || !principal?.userId || principal.companyId !== organisationId || !principal.scopeKey)
      fail('En aktiv session i rätt bolag krävs.', 403, 'company_logo_forbidden');
    if (principal.canManage !== true) fail('Du saknar behörighet att ändra företagets logga.', 403, 'company_logo_forbidden');
  }
  async function upload(input, principal, { reauthorize } = {}) {
    demand(principal);
    if (typeof reauthorize !== 'function') fail('Sessionen måste kontrolleras på nytt.', 403, 'company_logo_forbidden');
    const prepared = await prepareCompanyLogo(input);
    const fresh = async () => {
      const current = await reauthorize(); demand(current);
      if (current.scopeKey !== principal.scopeKey) fail('Bolaget eller kontot har ändrats. Ladda upp loggan igen.', 409, 'company_logo_scope_changed');
    };
    const db = await ready();
    const record = { id: randomUUID(), companyId: organisationId, contentHash: prepared.contentHash,
      width: prepared.width, height: prepared.height, bytes: prepared.bytes.length, contentType: 'image/png',
      createdAt: now().toISOString(), actualUserId: principal.actorId, effectiveUserId: principal.userId };
    const saved = await db.insert(record, prepared.bytes, fresh);
    await fresh();
    return publicLogo(saved);
  }
  async function read(id) {
    if (!companyLogoIdPattern.test(id ?? '')) return undefined;
    const image = await (await ready()).image(id);
    return image?.record.companyId === organisationId ? image : undefined;
  }
  return { organisationId, ready, upload, read, hasLogo: async id => Boolean(await read(id)), async close() {
    if (closed) return; closed = true;
    if (storage) await (await storage).close();
  } };
}
