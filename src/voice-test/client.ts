import { z } from 'zod';
import { currentPlatformSession, platformRequestHeaders } from '../platform/session';
import type { PlatformSession } from '../platform/types';
import type { VoiceCall, VoiceCheck, VoiceState } from './types';

export interface VoiceScope { key: string; headers: Readonly<Record<string, string>>; allowed: boolean }
export function voiceScopeKey(session = currentPlatformSession()) {
  const identity = (user: { id: string; level: string; active?: boolean; siteIds?: string[] }) => [user.id, user.level, user.active !== false, user.siteIds ? [...user.siteIds].sort() : 'all'];
  return JSON.stringify(session?.authenticated ? [session.organisationId, session.generation, session.mustChangePassword, session.actor.id, identity(session.actualUser), identity(session.user)] : 'signed-out');
}
export function voiceScope(session?: PlatformSession): VoiceScope {
  const actual = session ?? currentPlatformSession();
  const headers = actual?.authenticated ? { 'X-Platform-CSRF': actual.csrfToken, 'X-Platform-Generation': String(actual.generation), ...(actual.organisationId ? { 'X-Platform-Organisation-Id': actual.organisationId } : {}) } : platformRequestHeaders();
  return { key: voiceScopeKey(actual), headers: Object.freeze(headers), allowed: !!actual?.authenticated && !!actual.organisationId
    && !actual.mustChangePassword && [actual.actualUser, actual.user].every(user => user.active !== false && ['Systemadmin', 'VD'].includes(user.level)) };
}
export class VoiceApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }
export const voiceDenied = (failure: unknown) => failure instanceof VoiceApiError && ([401, 403].includes(failure.status) || ['platform_context_changed', 'PRINCIPAL_CHANGED'].includes(failure.code ?? ''));
const stamp = z.string().refine(value => Number.isFinite(Date.parse(value))), nonnegative = z.number().finite().nonnegative();
export const callSchema = z.object({ id: z.string(), requestId: z.string(), revision: nonnegative.int(), status: z.enum(['connecting', 'active', 'ended', 'failed', 'interrupted']),
  createdAt: stamp, startedAt: stamp.optional(), endedAt: stamp.optional(), durationSeconds: nonnegative, siteName: z.string().optional(),
  callerNumber: z.string(), callerLabel: z.string(), createdBy: z.object({ actualUserId: z.string(), effectiveUserId: z.string(), name: z.string() }),
  transcript: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), at: stamp, interrupted: z.boolean().optional() })), transcriptComplete: z.boolean().optional(), providerConfirmed: z.boolean().optional(),
  followupStatus: z.enum(['new', 'in_progress', 'done']), summary: z.string().optional(), summaryStatus: z.enum(['pending', 'generated', 'fallback']).optional(),
  aiSupportSnapshot: z.object({ revision: nonnegative.int(), policyVersion: nonnegative.int(), voice: z.string(), knowledgeIds: z.array(z.string()), contextHash: z.string() }).optional(),
  topic: z.string().nullable().optional(), callbackRequested: z.boolean().nullable().optional(), summaryModel: z.string().optional(), endReason: z.string().optional(), error: z.string().optional(),
});
const stateSchema = z.object({ revision: nonnegative.int(), config: z.object({ enabled: z.boolean(), keyPresent: z.boolean(), model: z.string(), companyName: z.string().optional(), voice: z.string().optional(), knowledgeRevision: nonnegative.int().optional(), callerNumber: z.string(), callerLabel: z.string(), maxDurationSeconds: nonnegative, available: z.boolean(), reason: z.string().optional(), site: z.object({ id: z.string(), name: z.string() }).optional() }), calls: z.array(callSchema), currentCall: callSchema.nullable() });
const createSchema = z.object({ call: callSchema, answerSdp: z.string().min(1) });
const checkSchema = z.object({ ok: z.boolean(), model: z.string(), message: z.string(), checkedAt: stamp });
async function request<T>(scope: VoiceScope, path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal, timeoutMs = 20_000): Promise<T> {
  if (!scope.allowed) throw new VoiceApiError('Du saknar behörighet att använda rösttestet.', 403);
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(new DOMException('Servern svarade inte i tid. Kontrollera samtalsstatusen.', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetch(`/api/voice-test${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => null);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (voiceScopeKey() !== scope.key) throw new VoiceApiError('Bolaget eller inloggningen har ändrats. Samtalet har stängts på den här enheten.', 409, 'PRINCIPAL_CHANGED');
    if (!response.ok) throw new VoiceApiError(typeof result?.error === 'string' ? result.error : result?.error?.message || result?.message || 'Rösttestet kunde inte nås. Försök igen.', response.status, result?.code);
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new VoiceApiError('Rösttestet gav ett ofullständigt svar. Hämta aktuell samtalsstatus.', 502, 'invalid_response');
    return parsed.data;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const readVoice = (scope: VoiceScope, signal?: AbortSignal): Promise<VoiceState> => request(scope, '', stateSchema, undefined, signal);
export const readVoiceCall = async (scope: VoiceScope, id: string, signal?: AbortSignal): Promise<VoiceCall> => (await request(scope, `/calls/${encodeURIComponent(id)}`, z.object({ call: callSchema }), undefined, signal)).call;
export const createVoiceCall = (scope: VoiceScope, requestId: string, sdp: string, signal?: AbortSignal) => request(scope, '/calls', createSchema, { requestId, sdp }, signal, 45_000);
export const readyVoiceCall = async (scope: VoiceScope, id: string, signal?: AbortSignal) => (await request(scope, `/calls/${encodeURIComponent(id)}/ready`, z.object({ call: callSchema }), {}, signal)).call;
export const endVoiceCall = async (scope: VoiceScope, id: string, signal?: AbortSignal) => (await request(scope, `/calls/${encodeURIComponent(id)}/end`, z.object({ call: callSchema }), {}, signal)).call;
export const updateVoiceFollowup = async (scope: VoiceScope, id: string, status: VoiceCall['followupStatus'], signal?: AbortSignal) => (await request(scope, `/calls/${encodeURIComponent(id)}/status`, z.object({ call: callSchema }), { status }, signal)).call;
export const checkVoiceConnection = (scope: VoiceScope, signal?: AbortSignal): Promise<VoiceCheck> => request(scope, '/connection-test', checkSchema, {}, signal, 30_000);

/** A page close only sends a best-effort, idempotent end with the OLD scope.
 * It can never follow a changed cookie into a different company's call. */
export function endVoiceOnLeave(scope: VoiceScope, id: string) {
  void fetch(`/api/voice-test/calls/${encodeURIComponent(id)}/end`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
    headers: { ...scope.headers, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
}
