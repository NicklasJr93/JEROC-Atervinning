import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { companyLookupScope, type CompanyLookupScope } from './company-register/client';

export interface CompanyDefaults { paymentTermsDays: number | null }
export interface CompanyDefaultsSnapshot {
  companyId: string;
  version: number;
  defaults: CompanyDefaults;
  profile: { name: string };
  logoUrl?: string;
}
const defaultsSchema = z.object({
  companyId: z.string().min(1).max(200), version: z.number().int().nonnegative(),
  defaults: z.object({ paymentTermsDays: z.number().int().min(0).max(365).nullable() }),
  profile: z.object({ name: z.string().max(4000) }),
  logoUrl: z.string().regex(/^\/api\/company-settings\/logos\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i).optional(),
});
export class CompanyDefaultsError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); }
}

/** Notify open branding views only after a scoped settings save has succeeded. */
export function notifyCompanySettingsSaved(companyId: string): void {
  window.dispatchEvent(new CustomEvent('scrappilot:company-settings-saved', { detail: { companyId } }));
}

/** Minimal scoped defaults only; new-customer forms never fetch administrator preferences. */
export async function loadCompanyDefaults(options: { scope?: CompanyLookupScope; signal?: AbortSignal } = {}): Promise<CompanyDefaultsSnapshot> {
  const scope = options.scope ?? companyLookupScope();
  const headers = new Headers(scope.headers);
  const expectedCompany = headers.get('X-Employee-Company') || headers.get('X-Platform-Organisation-Id');
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);
  try {
    const response = await fetch('/api/company-settings/defaults', {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (scope.platformKey !== companyLookupScope().platformKey)
      throw new CompanyDefaultsError('Bolaget eller kontot har ändrats.', 'company_settings_scope_changed', 409);
    if (!response.ok) throw new CompanyDefaultsError('Bolagets standardvärden kunde inte hämtas.', 'company_settings_unavailable', response.status);
    const parsed = defaultsSchema.safeParse(body);
    if (!parsed.success) throw new CompanyDefaultsError('Bolagets standardvärden gav ett ofullständigt svar.', 'company_settings_invalid_response', 502);
    if (expectedCompany && parsed.data.companyId !== expectedCompany)
      throw new CompanyDefaultsError('Standardvärdena tillhör ett annat bolag.', 'company_settings_scope_changed', 409);
    return parsed.data;
  } catch (failure) {
    if (timedOut) throw new CompanyDefaultsError('Bolagets standardvärden svarade inte i tid.', 'company_settings_unavailable');
    if (controller.signal.aborted || failure instanceof CompanyDefaultsError) throw failure;
    throw new CompanyDefaultsError('Bolagets standardvärden kunde inte hämtas.', 'company_settings_unavailable');
  } finally { globalThis.clearTimeout(timeout); options.signal?.removeEventListener('abort', abort); }
}

/** One read per opened new form and principal. Failures leave manual entry and integration defaults available. */
export function useCompanyDefaults({ enabled, scopeKey, requestHeaders, refreshOnSave = false }: {
  enabled: boolean; scopeKey: string; requestHeaders?: Readonly<Record<string, string>>; refreshOnSave?: boolean;
}): CompanyDefaultsSnapshot | undefined {
  const scope = companyLookupScope(requestHeaders);
  const key = JSON.stringify([scope.key, scopeKey]);
  const [snapshot, setSnapshot] = useState<{ key: string; value: CompanyDefaultsSnapshot }>();
  const [revision, setRevision] = useState(0);
  const latest = useRef({ key, enabled }); latest.current = { key, enabled };
  useEffect(() => {
    if (!enabled || !refreshOnSave) return;
    const headers = new Headers(scope.headers);
    const companyId = headers.get('X-Employee-Company') || headers.get('X-Platform-Organisation-Id');
    const saved = (event: Event) => {
      if ((event as CustomEvent<{ companyId?: string }>).detail?.companyId === companyId
        && latest.current.enabled && latest.current.key === key) setRevision(value => value + 1);
    };
    window.addEventListener('scrappilot:company-settings-saved', saved);
    return () => window.removeEventListener('scrappilot:company-settings-saved', saved);
    // The key captures the initiating headers and platform generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshOnSave, key]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadCompanyDefaults({ scope, signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && latest.current.enabled && latest.current.key === key) setSnapshot({ key, value });
    }).catch(() => undefined);
    return () => controller.abort();
    // Scope includes the initiating headers, company and platform generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, revision]);
  return enabled && snapshot?.key === key ? snapshot.value : undefined;
}

export interface InitialPaymentTermsGuard {
  fresh: boolean;
  transferred?: boolean;
  dirty?: boolean;
  initialValue?: number;
}
/** Late defaults cannot replace a prior or explicit choice, including choosing integration standard again. */
export function applyInitialPaymentTerms<T extends { paymentTermDays?: number }>(
  draft: T, defaults: CompanyDefaults | undefined, guard: InitialPaymentTermsGuard,
): T {
  const days = defaults?.paymentTermsDays;
  if (!guard.fresh || guard.transferred || guard.dirty || guard.initialValue !== undefined || draft.paymentTermDays !== undefined
    || days === null || days === undefined || !Number.isInteger(days) || days < 0 || days > 365) return draft;
  return { ...draft, paymentTermDays: days };
}
