import { createDocumentRepository, DocumentError } from './storage.mjs';
import { createDocumentService } from './model.mjs';

const MAX_BODY = 512 * 1024;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(value)); };
async function body(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new DocumentError('Använd application/json.', 415, 'content_type');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new DocumentError('Anropet är för stort.', 413, 'body_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new DocumentError('Anropet är för stort.', 413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DocumentError('Ogiltig JSON.', 422, 'invalid_input'); }
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try { if (new URL(origin).host === req.headers.host) return; } catch {}
  throw new DocumentError('Anropet kommer från en annan webbplats.', 403, 'origin_forbidden');
}

/** All source/principal callbacks must release application/terminal locks before
 * returning. The document repository acquires only its own independent locks. */
export function createDocumentsApi({ env = process.env, repository, sourceProvider, resolvePrincipal, renderPdf, now, templateVersion } = {}) {
  if (typeof sourceProvider !== 'function' || typeof resolvePrincipal !== 'function' || typeof renderPdf !== 'function') throw new TypeError('Dokument-API behöver källadapter, behörighetsadapter och PDF-renderare.');
  let repositoryPromise, servicePromise;
  const service = () => {
    if (!servicePromise) {
      repositoryPromise = repository ? Promise.resolve(repository) : createDocumentRepository({ env });
      servicePromise = repositoryPromise.then(repository => createDocumentService({ repository, sourceProvider, renderPdf, now, templateVersion }));
      const pending = servicePromise;
      pending.catch(() => { if (servicePromise === pending) { servicePromise = undefined; repositoryPromise = undefined; } });
    }
    return servicePromise;
  };
  const api = async (req, res, url) => {
    if (url.pathname !== '/api/documents' && !url.pathname.startsWith('/api/documents/')) return false;
    try {
      checkOrigin(req);
      const principal = await resolvePrincipal(req), store = await service(), route = url.pathname.slice('/api/documents'.length);
      if (req.method === 'GET' && !route) json(res, 200, await store.list({ kind: url.searchParams.get('kind'), sourceId: url.searchParams.get('sourceId') }, principal));
      else if ((req.method === 'GET' || req.method === 'HEAD') && /^\/[^/]+\/download$/.test(route)) {
        const id = decodeURIComponent(route.split('/')[1]), record = await store.download(id, principal);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': record.pdf.length, 'Content-Disposition': `inline; filename="JEROC-${record.kind}-${record.id}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Document-Hash': record.pdfHash });
        res.end(req.method === 'HEAD' ? undefined : record.pdf);
      } else {
        const settlement = route.match(/^\/settlements\/([^/]+)\/generate$/), receipt = route.match(/^\/receipts\/([^/]+)\/generate$/), transport = route.match(/^\/transport\/([^/]+)(?:\/(generate))?$/);
        if (settlement && req.method === 'POST') json(res, 201, await store.generateSettlement(decodeURIComponent(settlement[1]), await body(req), principal));
        else if (receipt && req.method === 'POST') { await body(req); json(res, 201, await store.generateReceipt(decodeURIComponent(receipt[1]), principal)); }
        else if (transport && req.method === 'GET' && !transport[2]) json(res, 200, await store.transport(decodeURIComponent(transport[1]), principal));
        else if (transport && req.method === 'PUT' && !transport[2]) json(res, 200, await store.saveTransport(decodeURIComponent(transport[1]), await body(req), principal));
        else if (transport && req.method === 'POST' && transport[2] === 'generate') { await body(req); json(res, 201, await store.generateTransport(decodeURIComponent(transport[1]), principal)); }
        else throw new DocumentError('Dokumentvyn finns inte eller metoden stöds inte.', 404, 'not_found');
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      const known = error instanceof DocumentError || Number.isInteger(error.status) && error.status >= 400 && error.status <= 499;
      json(res, known ? error.status : 503, { error: known ? error.message : 'Dokumentet kunde inte sparas eller läsas. Försök igen; redan sparade original finns kvar.', code: known ? error.code ?? 'forbidden' : 'document_storage_unavailable', demo: true });
    }
    return true;
  };
  api.ensureApproval = async approval => (await service()).ensureApproval(approval);
  api.close = async () => { if (repositoryPromise) await repositoryPromise.then(repository => repository.close()).catch(() => {}); };
  return api;
}
