export interface TenantPublicContext { companyId: string; companyName: string }

let contextPromise: Promise<TenantPublicContext> | undefined;

/** Capture the server-selected company once per page before a portal logs in.
 * This public selection grants no record access: each realm still authenticates
 * its own cookie. The captured value fences stale tabs after another tab changes
 * the selection cookie. Switching companies deliberately requires a new page.
 */
export function tenantPublicContext(): Promise<TenantPublicContext> {
  if (!contextPromise) {
    const pending = (async () => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
      let response: Response;
      try { response = await fetch('/api/platform/tenant-context', { credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: controller.signal }); }
      finally { clearTimeout(timeout); }
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.companyId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(result.companyId)
        || typeof result.companyName !== 'string' || result.companyName.length > 300)
        throw new Error(result?.error ?? 'Det valda företaget kunde inte verifieras. Öppna företagets inloggningslänk igen.');
      return Object.freeze({ companyId: result.companyId, companyName: result.companyName });
    })();
    contextPromise = pending;
    void pending.catch(() => { if (contextPromise === pending) contextPromise = undefined; });
  }
  return contextPromise;
}

export async function tenantPublicHeaders(): Promise<Record<string, string>> {
  const context = await tenantPublicContext();
  return { 'X-Client-Company': context.companyId };
}

export async function tenantPublicEventUrl(path: string): Promise<string> {
  const context = await tenantPublicContext();
  const query = new URLSearchParams({ expectedCompany: context.companyId });
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}
