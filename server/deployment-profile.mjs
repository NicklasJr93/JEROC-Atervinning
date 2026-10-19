/** Explicit deployment selection. Production environment alone must not change
 * the existing demo; the separate pilot Blueprint opts into this profile. */
export function readDeploymentProfile(env = process.env) {
  const mode = env.SCRAPPLANNER_DEPLOYMENT_MODE ?? 'demo';
  if (!['demo', 'pilot'].includes(mode)) throw new Error('SCRAPPLANNER_DEPLOYMENT_MODE måste vara demo eller pilot.');
  const pilot = mode === 'pilot';
  const origin = (value, name, fallback) => {
    if (!pilot) return fallback;
    let url;
    try { url = new URL(value || fallback); } catch { throw new Error(`${name} behöver en giltig HTTPS-adress.`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error(`${name} behöver en HTTPS-adress utan sökväg, frågeparametrar eller inloggningsuppgifter.`);
    return url.origin;
  };
  const appOrigin = origin(env.APP_URL, 'APP_URL', 'https://app.scrapplanner.com');
  const mobileOrigin = origin(env.MOBILE_URL, 'MOBILE_URL', 'https://mobile.scrapplanner.com');
  if (pilot) {
    let database;
    try { database = new URL(env.DATABASE_URL); } catch { throw new Error('Pilotprofilen behöver en separat PostgreSQL-databas i DATABASE_URL.'); }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Pilotprofilen kräver PostgreSQL. Lokal reservlagring används inte.');
    const password = env.SCRAPPILOT_PLATFORM_ADMIN_PASSWORD;
    if (typeof password !== 'string' || password.length < 16 || password.length > 200)
      throw new Error('Pilotprofilen behöver SCRAPPILOT_PLATFORM_ADMIN_PASSWORD med 16–200 tecken.');
    if (appOrigin === mobileOrigin) throw new Error('APP_URL och MOBILE_URL behöver olika värdnamn för kontor och mobil.');
  }
  return Object.freeze({ mode, pilot, appOrigin, mobileOrigin });
}
