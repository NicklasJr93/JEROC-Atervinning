import { z } from 'zod';
import { currentPlatformSession, platformRequestHeaders } from '../platform/session';
import type { PlatformSession } from '../platform/types';
import { aiSupportSchema, previewSchema } from './types';
export function aiSupportScopeKey(session = currentPlatformSession()) {
  const identity = (user: { id: string; level: string; active?: boolean; siteIds?: string[] }) => [user.id, user.level, user.active !== false, user.siteIds ? [...user.siteIds].sort() : 'all'];
  return JSON.stringify(session?.authenticated ? [session.organisationId, session.generation, session.mustChangePassword, identity(session.actualUser), identity(session.user)] : 'signed-out');
}
export function aiSupportScope(session?: PlatformSession) {
  const actual = session ?? currentPlatformSession();
  return { key: aiSupportScopeKey(actual), allowed: !!actual?.authenticated && !!actual.organisationId && !actual.mustChangePassword && [actual.actualUser, actual.user].every(user => user.active !== false && ['Systemadmin', 'VD'].includes(user.level)), headers: Object.freeze(actual?.authenticated ? { 'X-Platform-CSRF': actual.csrfToken, 'X-Platform-Generation': String(actual.generation), ...(actual.organisationId ? { 'X-Platform-Organisation-Id': actual.organisationId } : {}) } : platformRequestHeaders()) };
}
export type AiSupportScope = ReturnType<typeof aiSupportScope>;
export class AiSupportError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export const aiSupportDenied = (error: unknown) => error instanceof AiSupportError && ([401, 403].includes(error.status) || ['platform_context_changed', 'PRINCIPAL_CHANGED'].includes(error.code ?? ''));
async function request<T>(scope: AiSupportScope, path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal, timeout = 20_000): Promise<T> {
  if (!scope.allowed) throw new AiSupportError('Du saknar behörighet att hantera AI-supporten.', 403);
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException('Servern svarade inte i tid. Hämta aktuell version innan du försöker spara igen.', 'TimeoutError')), timeout);
  try {
    const response = await fetch(`/api/ai-support${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', ...scope.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (aiSupportScopeKey() !== scope.key) throw new AiSupportError('Bolaget eller din behörighet har ändrats. Hämta sidan på nytt.', 409, 'PRINCIPAL_CHANGED');
    if (!response.ok) throw new AiSupportError(typeof value?.error === 'string' ? value.error : value?.error?.message || value?.message || 'Ändringen kunde inte sparas. Försök igen.', response.status, value?.code);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AiSupportError('Servern gav ett ofullständigt svar. Hämta aktuell version.', 502, 'invalid_response');
    return parsed.data;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const readAiSupport = (scope: AiSupportScope, signal?: AbortSignal) => request(scope, '', aiSupportSchema, undefined, signal);
export const saveAiSupport = (scope: AiSupportScope, path: string, body: unknown, signal?: AbortSignal) => request(scope, path, aiSupportSchema, body, signal);
export const previewAiVoice = (scope: AiSupportScope, body: unknown, signal?: AbortSignal) => request(scope, '/preview', previewSchema, body, signal, 35_000);
