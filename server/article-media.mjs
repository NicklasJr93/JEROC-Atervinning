import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ArticleMediaError, createArticleMediaRepository } from './article-media-storage.mjs';

export { ArticleMediaError } from './article-media-storage.mjs';
export const MAX_ARTICLE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ARTICLE_IMAGE_PIXELS = 40_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const types = new Map([['image/jpeg', 'jpeg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/avif', 'heif']]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nameOf = value => String(value ?? 'artikelbild').split(/[/\\]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180) || 'artikelbild';

/** Decode before storing: reject vector/animated files, rotate the pixels,
 * remove metadata and cap both durable variants for the mobile client. */
export async function prepareArticleImage({ bytes, contentType, originalName }, { maxBytes = MAX_ARTICLE_IMAGE_BYTES, maxPixels = MAX_ARTICLE_IMAGE_PIXELS } = {}) {
  if (!types.has(contentType)) throw new ArticleMediaError('Välj en JPEG-, PNG-, WebP- eller AVIF-bild.', 415, 'image_type');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new ArticleMediaError('Bilden är tom.', 422, 'invalid_image');
  if (bytes.length > maxBytes) throw new ArticleMediaError('Bilden får vara högst 10 MB.', 413, 'image_too_large');
  try {
    const image = sharp(bytes, { limitInputPixels: maxPixels, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== types.get(contentType) || metadata.format === 'heif' && !/avif|avis/.test(bytes.subarray(8, 32).toString('ascii')))
      throw new ArticleMediaError('Filens innehåll matchar inte bildtypen.', 415, 'image_type');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > maxPixels)
      throw new ArticleMediaError('Bilden har för hög upplösning.', 413, 'image_pixels');
    if ((metadata.pages ?? 1) !== 1) throw new ArticleMediaError('Animerade bilder stöds inte som artikelbild.', 422, 'animated_image');
    // Sharp strips EXIF, GPS, XMP and other metadata unless explicitly retained.
    const fullResult = await image.clone().rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
    const thumbResult = await image.clone().rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 }).toBuffer({ resolveWithObject: true });
    return {
      full: fullResult.data, thumbnail: thumbResult.data,
      width: fullResult.info.width, height: fullResult.info.height,
      bytes: fullResult.data.length, thumbnailBytes: thumbResult.data.length,
      thumbnailWidth: thumbResult.info.width, thumbnailHeight: thumbResult.info.height,
      contentHash: hash(Buffer.concat([Buffer.from('jeroc-article-webp-v1\0'), fullResult.data, thumbResult.data])),
      fullHash: hash(fullResult.data), thumbnailHash: hash(thumbResult.data), originalName: nameOf(originalName),
    };
  } catch (error) {
    if (error instanceof ArticleMediaError) throw error;
    if (/pixel limit|exceeds.*limit|image.*too large/i.test(error.message))
      throw new ArticleMediaError('Bilden har för hög upplösning.', 413, 'image_pixels');
    throw new ArticleMediaError('Bilden kunde inte läsas. Välj en giltig JPEG-, PNG-, WebP- eller AVIF-bild.', 422, 'invalid_image');
  }
}

const publicRecord = record => ({
  id: record.id, width: record.width, height: record.height, bytes: record.bytes,
  thumbnailUrl: `/api/article-media/${record.id}?variant=thumb`,
  url: `/api/article-media/${record.id}?variant=full`, originalName: record.originalName,
});
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
function demandUpload(principal) {
  if (!principal?.actor?.id || !principal?.user?.id || principal.actor.active === false || principal.user.active === false)
    throw new ArticleMediaError('Välj ett giltigt demokonto.', 401, 'unauthenticated');
  const permitted = user => ['Systemadmin', 'VD'].includes(user.level) || user.level === 'Medarbetare' && user.permissions?.includes('articlesEdit');
  if (!permitted(principal.actor) || !permitted(principal.user))
    throw new ArticleMediaError('Du saknar behörighet att ändra artiklar och ladda upp bilder.', 403, 'forbidden');
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ArticleMediaError('Anropet kommer från en annan webbplats.', 403, 'origin_forbidden');
  const origin = req.headers.origin;
  if (!origin) return;
  try { if (new URL(origin).host === req.headers.host) return; } catch {}
  throw new ArticleMediaError('Anropet kommer från en annan webbplats.', 403, 'origin_forbidden');
}
async function body(req) {
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_ARTICLE_IMAGE_BYTES) throw new ArticleMediaError('Bilden får vara högst 10 MB.', 413, 'image_too_large');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_ARTICLE_IMAGE_BYTES) throw new ArticleMediaError('Bilden får vara högst 10 MB.', 413, 'image_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
function originalName(req) {
  const supplied = req.headers['x-file-name'];
  if (typeof supplied !== 'string') return 'artikelbild';
  try { return decodeURIComponent(supplied); } catch { return supplied; }
}

/** authorize(req) must resolve a freshly authorized principal; no browser
 * identity or permission flag is accepted as proof by this handler. */
export function createArticleMediaApi({ env = process.env, repository, authorize, now = () => new Date() } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('Bild-API behöver en behörighetsadapter.');
  let repositoryPromise;
  const ready = () => {
    if (!repositoryPromise) {
      const pending = repository ? Promise.resolve(repository) : createArticleMediaRepository({ env });
      repositoryPromise = pending;
      pending.catch(() => { if (repositoryPromise === pending) repositoryPromise = undefined; });
    }
    return repositoryPromise;
  };
  const api = async (req, res, url) => {
    if (url.pathname !== '/api/article-media' && !url.pathname.startsWith('/api/article-media/')) return false;
    try {
      const route = url.pathname.slice('/api/article-media'.length);
      if (req.method === 'POST' && !route) {
        sameOrigin(req);
        demandUpload(await authorize(req));
        const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (!types.has(contentType)) throw new ArticleMediaError('Välj en JPEG-, PNG-, WebP- eller AVIF-bild.', 415, 'image_type');
        const prepared = await prepareArticleImage({ bytes: await body(req), contentType, originalName: originalName(req) });
        // Decode can take time: refresh authorization before durable insert too.
        const principal = await authorize(req); demandUpload(principal);
        const { full, thumbnail, ...metadata } = prepared;
        const record = { id: randomUUID(), ...metadata, createdAt: now().toISOString(), createdBy: principal.actor.id, effectiveUserId: principal.user.id };
        json(res, 201, { image: publicRecord(await (await ready()).insert(record, full, thumbnail)) });
      } else if ((req.method === 'GET' || req.method === 'HEAD') && /^\/[^/]+$/.test(route)) {
        const id = route.slice(1), variant = url.searchParams.get('variant') ?? 'full';
        if (!uuid.test(id)) throw new ArticleMediaError('Bilden finns inte.', 404, 'not_found');
        if (!['full', 'thumb'].includes(variant)) throw new ArticleMediaError('Ogiltig bildvariant.', 422, 'invalid_variant');
        const image = await (await ready()).image(id, variant);
        if (!image) throw new ArticleMediaError('Bilden finns inte.', 404, 'not_found');
        const etag = `"${variant === 'thumb' ? image.record.thumbnailHash : image.record.fullHash}"`;
        const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', ETag: etag };
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); }
        else { res.writeHead(200, { ...headers, 'Content-Length': image.bytes.length }); res.end(req.method === 'HEAD' ? undefined : image.bytes); }
      } else throw new ArticleMediaError('Bildvyn finns inte eller metoden stöds inte.', 404, 'not_found');
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      const known = error instanceof ArticleMediaError || Number.isInteger(error.status) && error.status >= 400 && error.status <= 499;
      json(res, known ? error.status : 503, {
        error: known ? error.message : 'Bilden kunde inte sparas eller läsas. Försök igen.',
        code: known ? error.code ?? 'forbidden' : 'image_storage_unavailable',
      });
    }
    return true;
  };
  api.ready = ready;
  api.hasImages = async ids => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !uuid.test(id))) return false;
    return (await ready()).hasImages(ids);
  };
  api.close = async () => { if (repositoryPromise) await repositoryPromise.then(repository => repository.close()).catch(() => {}); };
  return api;
}
