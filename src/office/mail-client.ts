import { useCallback, useEffect, useRef, useState } from 'react';
import { currentPlatformSession, platformRequestHeaders } from '../platform/session';
import { can, type OfficeUser } from './model';
import { useEnvironmentSession } from './EnvironmentSession';
import { cacheIntegrationRead, cachedIntegrationRead, clearIntegrationReadCache, integrationReadScope } from './integration-read-cache';
import { sharedOfficeRead } from './shared-read';

export type MailIssue = string | { code: string; message: string };
export interface MailConnection {
  id: string; provider: 'microsoft'; address: string; displayName: string;
  status: string; lastError?: MailIssue | null; updatedAt?: string | null;
}
export interface MailMailbox {
  id: string; connectionId: string; address: string; displayName: string;
  type: 'primary' | 'shared'; enabled: boolean; allowedUserIds: string[];
  lastSyncedAt?: string | null; lastError?: MailIssue | null; unreadCount: number;
  countsPartial?: boolean;
}
export interface MailState {
  organisationId: string;
  configuration: { ready: boolean; missing: string[]; issues: MailIssue[]; redirectUri?: string | null };
  connections: MailConnection[]; mailboxes: MailMailbox[]; totalUnread: number;
  capabilities: { canManage: boolean; canRead: boolean }; mode: 'live';
}
export interface MailAddress { name?: string | null; address: string }
export interface MailMessage {
  id: string; mailboxId: string; subject: string; from: MailAddress;
  receivedAt: string; isRead: boolean; bodyPreview: string; hasAttachments: boolean;
}
export interface MailMessages {
  messages: MailMessage[]; hasMore: boolean; nextCursor?: string | null; totalUnread: number;
  countsPartial?: boolean;
}
export interface MailAttachment { id: string; name: string; size: number; contentType: string }
export interface MailCustomerMatch {
  id: string; name: string; type: string; customerNumber?: string | null;
  email?: string | null; phone?: string | null; address?: string | null; postalCode?: string | null; city?: string | null;
}
export interface MailMessageDetail {
  message: MailMessage & { bodyText: string; to: MailAddress[]; attachments: MailAttachment[]; webLink?: string | null };
  matches: MailCustomerMatch[]; matchStatus: 'matched' | 'multiple' | 'none' | 'not-authorized';
}
export interface MailMailboxInput { connectionId: string; address: string; displayName?: string; allowedUserIds?: string[] }
export interface MailMailboxChanges { displayName?: string; enabled?: boolean; allowedUserIds?: string[] }
export class MailApiError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export const mailIssueText = (issue: MailIssue | null | undefined) => typeof issue === 'string' ? issue : issue?.message ?? '';
export const mayReadMail = (user: OfficeUser, actualUser: OfficeUser) => can(user, 'mailRead') && can(actualUser, 'mailRead');
export const mayManageMail = (user: OfficeUser, actualUser: OfficeUser) =>
  [user, actualUser].every(person => ['Systemadmin', 'VD'].includes(person.level) && !person.siteIds && can(person, 'integrationsRead') && can(person, 'integrationsManage'));

export interface MailChanged { organisationId: string; generation?: string | number; state?: MailState }
export const mailChangedEvent = 'scrappilot:mail-updated';
export function isCurrentMailChange(event: Event) {
  const detail = (event as CustomEvent<MailChanged>).detail, platform = currentPlatformSession();
  return Boolean(detail && platform?.authenticated && platform.organisationId === detail.organisationId &&
    (detail.generation === undefined || String(platform.generation) === String(detail.generation)));
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  // Freeze the initiating platform scope. The fetch guard must never replace
  // these headers with another company's session after an account switch.
  const platform = currentPlatformSession();
  const scope = platform?.authenticated ? { organisationId: platform.organisationId, generation: platform.generation } : undefined;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, path === '/sync' ? 90_000 : 35_000);
  try {
  const response = await fetch(`/api/mail${path}`, {
    method, credentials: 'same-origin', signal: controller.signal,
    headers: { Accept: 'application/json', ...platformRequestHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string; message?: string; code?: string };
  if (controller.signal.aborted) throw new DOMException('Hämtningen avbröts.', 'AbortError');
  const current = currentPlatformSession();
  if (scope && (!current?.authenticated || current.organisationId !== scope.organisationId || String(current.generation) !== String(scope.generation)))
    throw new MailApiError('Bolagssessionen har ändrats. Öppna inkorgen igen.', 'mail_scope_changed', 409);
  if (!response.ok) throw new MailApiError(result.message ?? result.error ?? 'Mejlen kunde inte hämtas.', result.code ?? 'mail_request_failed', response.status);
  if (method !== 'GET') {
    clearIntegrationReadCache('mail-state');
    const next = result as unknown as Partial<MailState>;
    if (typeof window !== 'undefined' && next.organisationId && next.capabilities && Array.isArray(next.mailboxes)) {
      window.dispatchEvent(new CustomEvent<MailChanged>(mailChangedEvent, { detail: { organisationId: next.organisationId, generation: scope?.generation, state: next as MailState } }));
    }
  }
  return result;
  } catch (failure) {
    if (timedOut && !signal?.aborted) throw new MailApiError(path === '/sync'
      ? 'Uppdateringen tar längre tid. Kontrollera inkorgens senaste uppdatering innan du försöker igen.'
      : 'Mejlhämtningen tog för lång tid. Försök igen.', 'mail_timeout', 408);
    throw failure;
  } finally { window.clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export const mailApi = {
  state: (signal?: AbortSignal) => request<MailState>('/state', 'GET', undefined, signal),
  messages: (options: { mailboxId?: string; unreadOnly?: boolean; search?: string; cursor?: string } = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (options.mailboxId) params.set('mailboxId', options.mailboxId);
    if (options.unreadOnly) params.set('unreadOnly', 'true');
    if (options.search) params.set('search', options.search);
    if (options.cursor) params.set('cursor', options.cursor);
    return request<MailMessages>(`/messages${params.size ? `?${params}` : ''}`, 'GET', undefined, signal);
  },
  message: (mailboxId: string, messageId: string, signal?: AbortSignal) => request<MailMessageDetail>(`/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`, 'GET', undefined, signal),
  sync: (options: { mailboxId?: string } = {}, signal?: AbortSignal) => request<MailState>('/sync', 'POST', options, signal),
  connectMicrosoft: (signal?: AbortSignal) => request<{ authorizationUrl: string }>('/microsoft/connect', 'POST', {}, signal),
  disconnect: (connectionId: string, signal?: AbortSignal) => request<MailState>(`/connections/${encodeURIComponent(connectionId)}/disconnect`, 'POST', {}, signal),
  addMailbox: (input: MailMailboxInput, signal?: AbortSignal) => request<MailState>('/mailboxes', 'POST', input, signal),
  updateMailbox: (mailboxId: string, input: MailMailboxChanges, signal?: AbortSignal) => request<MailState>(`/mailboxes/${encodeURIComponent(mailboxId)}`, 'PUT', input, signal),
};

/** The sidebar reads only the small cached server projection. These reads never
 * contact Microsoft Graph, including navigation and the recovery interval. */
export function useMailState(user: OfficeUser, actualUser: OfficeUser, enabled = true) {
  const { session } = useEnvironmentSession();
  const scope = integrationReadScope(actualUser, user, session);
  const permitted = enabled && mayReadMail(user, actualUser) && Boolean(scope);
  const currentScope = useRef(scope); currentScope.current = scope;
  const mounted = useRef(true), sequence = useRef(0);
  const flight = useRef<{ scope: string; promise: Promise<void>; controller: AbortController } | undefined>(undefined);
  const stateScope = useRef('');
  const [state, setState] = useState<MailState>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const refresh = useCallback((force = false): Promise<void> => {
    if (!permitted) return Promise.resolve();
    if (flight.current?.scope === scope) return flight.current.promise;
    const controller = new AbortController(), requestSequence = ++sequence.current;
    const valid = () => mounted.current && !controller.signal.aborted && currentScope.current === scope && sequence.current === requestSequence;
    const promise = (async () => {
      await Promise.resolve();
      const cached = !force && cachedIntegrationRead<MailState>('mail-state', scope);
      if (cached && valid()) { stateScope.current = scope; setState(cached.value); if (cached.fresh) { setLoading(false); setError(''); return; } }
      if (valid()) setLoading(true);
      try {
        const next = await sharedOfficeRead<MailState>(`mail-state:${scope}`, signal => mailApi.state(signal), controller.signal);
        const platform = currentPlatformSession();
        if (valid() && (!platform?.authenticated || platform.organisationId === next.organisationId)) {
          cacheIntegrationRead('mail-state', scope, next); stateScope.current = scope; setState(next); setError('');
        }
      } catch (failure) {
        if (valid()) {
          if (failure instanceof MailApiError && [401, 403].includes(failure.status)) { clearIntegrationReadCache('mail-state'); setState(undefined); }
          setError(failure instanceof Error ? failure.message : 'Inkorgarna kunde inte hämtas.');
        }
      } finally { if (valid()) setLoading(false); if (flight.current?.controller === controller) flight.current = undefined; }
    })();
    flight.current = { scope, promise, controller }; return promise;
  }, [scope, permitted]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++sequence.current; flight.current?.controller.abort(); };
  }, []);
  useEffect(() => {
    ++sequence.current; flight.current?.controller.abort(); flight.current = undefined; stateScope.current = '';
    setState(undefined); setError(''); setLoading(false);
    if (permitted) void refresh();
  }, [scope, permitted, refresh]);
  useEffect(() => {
    if (!permitted) return;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<MailChanged>).detail;
      if (!isCurrentMailChange(event)) return;
      ++sequence.current; flight.current?.controller.abort(); flight.current = undefined;
      if (detail.state) { cacheIntegrationRead('mail-state', scope, detail.state); stateScope.current = scope; setState(detail.state); setLoading(false); setError(''); }
      else void refresh(true);
    };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(true); }, 60_000);
    window.addEventListener(mailChangedEvent, changed);
    return () => { window.clearInterval(timer); window.removeEventListener(mailChangedEvent, changed); };
  }, [scope, permitted, refresh]);
  return { state: permitted && stateScope.current === scope ? state : undefined, loading: permitted && loading, error: permitted ? error : '', refresh };
}
