import type { PlatformSession } from './types';

let session: PlatformSession | undefined;
export function currentPlatformSession(): PlatformSession | undefined { return session; }
export function setCurrentPlatformSession(value: PlatformSession | undefined): void { session = value; }

export function platformRequestHeaders(): Record<string, string> {
  return session?.authenticated ? {
    'X-Platform-CSRF': session.csrfToken,
    'X-Platform-Generation': String(session.generation),
    ...(session.organisationId ? { 'X-Platform-Organisation-Id': session.organisationId } : {}),
  } : {};
}

/** Cookie identity stays server-owned. Tokens only go to this origin's API. */
export function installPlatformFetchGuard(): () => void {
  const previous = window.fetch;
  const guarded: typeof window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return previous.call(window, input, init);
    if (['/api/platform/session', '/api/platform/login'].includes(url.pathname)) return previous.call(window, input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    // Explicit tokens belong to the initiating scope. Do not replace them after
    // a switch; the server rejects a stale generation instead of changing tenant.
    for (const [name, value] of Object.entries(platformRequestHeaders())) if (!headers.has(name)) headers.set(name, value);
    return previous.call(window, input, { ...init, headers }).then(response => {
      if (response.status === 401 && !url.pathname.startsWith('/api/platform/'))
        window.dispatchEvent(new Event('scrappilot:check-platform-session'));
      return response;
    });
  };
  window.fetch = guarded;
  return () => { if (window.fetch === guarded) window.fetch = previous; };
}
