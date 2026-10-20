function localHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname.endsWith('.local')) return true;
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && (octets[0] === 10 || octets[0] === 127 || octets[0] === 192 && octets[1] === 168
      || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254);
}

/** Hosted builds use a fixed HTTPS entry. Pilot configuration enforces /mobil/
 * on the server; the existing hosted demo also supports its origin root.
 * LAN fallback is only available without a compiled public address. */
export function validWebAppAddress(value: string, configured: boolean): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || !configured && url.protocol === 'http:' && localHost(url.hostname))
      && (!configured || url.pathname === '/mobil/' || url.pathname === '/')
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export function localWebAppAddress(hostUri?: string): string {
  if (!hostUri) return '';
  try {
    const url = new URL(hostUri.includes('://') ? hostUri : `http://${hostUri}`);
    return !url.username && !url.password && localHost(url.hostname) ? `http://${url.hostname}:4173/` : '';
  } catch { return ''; }
}

export function webAppNavigationAllowed(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.origin === origin && !url.username && !url.password;
  } catch { return false; }
}

export function documentAddress(value: string): string {
  try { const url = new URL(value); url.hash = ''; return url.toString(); }
  catch { return ''; }
}
