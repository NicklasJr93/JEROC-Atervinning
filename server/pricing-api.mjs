import { createPricingStore, PricingError } from './pricing.mjs';

const MAX_BODY = 128 * 1024;
function json(res, status, value, head = false) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(head ? undefined : JSON.stringify(value));
}
async function body(req) {
  if (
    !req.headers['content-type']?.toLowerCase().startsWith('application/json')
  )
    throw new PricingError('Använd application/json.', 415);
  if (Number(req.headers['content-length']) > MAX_BODY)
    throw new PricingError('Anropet är för stort.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PricingError('Anropet är för stort.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PricingError('Ogiltig JSON.');
  }
}
function checkOrigin(req) {
  if (!req.headers.origin) return;
  let origin;
  try {
    origin = new URL(req.headers.origin);
  } catch {
    throw new PricingError('Ogiltigt ursprung.', 403);
  }
  // Vite forwards the browser's Host unchanged; Render terminates TLS upstream.
  // No cross-origin requests or permissive CORS are needed for either client.
  if (origin.host !== req.headers.host)
    throw new PricingError('Anropet måste komma från samma webbplats.', 403);
}
export function createPricingApi({ store = createPricingStore() } = {}) {
  return async function pricingApi(req, res, url) {
    if (!url.pathname.startsWith('/api/pricing/')) return false;
    try {
      checkOrigin(req);
      const actorId = req.headers['x-demo-actor'];
      const userId = req.headers['x-demo-user'] ?? actorId;
      if (typeof actorId !== 'string' || typeof userId !== 'string')
        throw new PricingError(
          'Välj ett demokonto innan du öppnar prismotorn.',
          401,
        );
      const principal = store.principal(actorId, userId);
      const route = url.pathname.slice('/api/pricing/'.length);
      if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        route === 'state'
      ) {
        json(
          res,
          200,
          store.read(principal, url.searchParams.get('at') ?? undefined),
          req.method === 'HEAD',
        );
      } else if (
        (req.method === 'GET' || req.method === 'HEAD') &&
        route === 'snapshots'
      ) {
        json(
          res,
          200,
          {
            snapshots: store.snapshots(
              principal,
              url.searchParams.get('cardId') ?? undefined,
            ),
            memoryOnly: true,
          },
          req.method === 'HEAD',
        );
      } else if (req.method === 'POST') {
        const actions = {
          lme: store.saveLme,
          articles: store.saveArticle,
          'customer-prices': store.saveSpecial,
          quote: store.quote,
          snapshots: store.snapshot,
          corrections: store.correct,
          users: store.saveUsers,
        };
        if (!Object.hasOwn(actions, route))
          throw new PricingError('API-vyn finns inte.', 404);
        const payload = await body(req);
        const result = actions[route](payload, principal);
        json(
          res,
          route === 'snapshots' || route === 'corrections' ? 201 : 200,
          result,
        );
      } else {
        res.setHeader(
          'Allow',
          route === 'state' || route === 'snapshots'
            ? 'GET, HEAD, POST'
            : 'POST',
        );
        throw new PricingError('Metoden stöds inte.', 405);
      }
    } catch (error) {
      if (error instanceof PricingError)
        json(res, error.status, { error: error.message, memoryOnly: true });
      else {
        console.error(
          'Prismotorns API kunde inte hantera anropet:',
          error.code ?? error.name ?? 'unknown',
        );
        json(res, 500, {
          error: 'Prismotorn kunde inte slutföra anropet.',
          memoryOnly: true,
        });
      }
    }
    return true;
  };
}
