// Public laboratory pages are useful in the existing demo, but do not belong
// on the separately deployed pilot. Keep the check before any API dispatch.
const laboratoryPage = /^\/(?:testbil1|rosttest)(?:\/|$)|^\/kontor\/rosttest(?:\/|$)|^\/kontor\/integration\/systemadmin(?:integration|visma|swish|bank)test\.html(?:\/|$)/;
const laboratoryApi = /^\/api\/(?:testcar|public\/voice-test)(?:\/|$)/;
const expoPage = /^\/expo(?:[/-]|$)|^\/(?:manifest|index\.exp|index(?:\.ts)?\.bundle)(?:\/|$)/;

function requestPath(url) {
  try { return decodeURIComponent(url.pathname); }
  catch { return null; }
}

/** Destinations are relative constants. No incoming host or query value can
 * become a redirect origin; only the configured mobile host selects mobile. */
export function pilotRequestPolicy(req, url, profile) {
  if (!profile.pilot) return null;
  const pathname = requestPath(url);
  if (pathname === null) return { status: 400 };
  const nativeManifest = pathname === '/' && (req.headers['expo-platform']
    || req.headers['exponent-platform'] || req.headers.accept?.includes('application/expo+json'));
  if (nativeManifest || laboratoryPage.test(pathname) || laboratoryApi.test(pathname) || expoPage.test(pathname))
    return { status: 404 };
  if (pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
    const mobileHost = new URL(profile.mobileOrigin).host.toLowerCase();
    const mobile = req.headers.host?.toLowerCase() === mobileHost;
    return { status: 303, location: `${mobile ? '/mobil/' : '/kontor/'}${url.search}` };
  }
  return null;
}

export function applyPilotSecurityHeaders(req, res, profile) {
  if (!profile.pilot) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.socket?.encrypted || req.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
