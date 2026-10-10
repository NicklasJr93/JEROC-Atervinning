import { parseTerminalApproval, parseTerminalDemoState, parseTerminalSession, type ApprovalSend, type CustomerReviewCommand, type CustomerReviewResult, type DemoTerminal, type TerminalApproval, type TerminalDemoState, type TerminalSessionState } from './terminal-demo-types';

export class TerminalDemoError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export type TerminalStaffIdentity = { actualUserId: string; effectiveUserId: string };
let staffIdentity: TerminalStaffIdentity | undefined;
const staffHeaders = (identity = staffIdentity): Record<string, string> => identity ? {
  'X-Terminal-Actual-User': identity.actualUserId,
  'X-Terminal-Effective-User': identity.effectiveUserId,
} : {};
export async function terminalRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, expectedStaff?: TerminalStaffIdentity): Promise<T> {
  const deviceRequest = /^\/(?:login|session|heartbeat|logout)(?:$|\/)|^\/approvals\/[^/]+\/(?:respond|displayed)$/.test(path);
  const response = await fetch(`/api/terminal-demo${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(path === '/staff-session' || deviceRequest ? {} : staffHeaders(expectedStaff)), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string };
  if (!response.ok) throw new TerminalDemoError(result.message ?? result.error ?? 'Terminaltjänsten kunde inte nås.', result.code ?? 'request_failed', response.status);
  return result as T;
}
export const terminalDemoApi = {
  staffSession: async (actualUserId: string, effectiveUserId: string) => {
    const result = await terminalRequest('/staff-session', 'POST', { actualUserId, effectiveUserId });
    staffIdentity = { actualUserId, effectiveUserId };
    return result;
  },
  state: async (signal?: AbortSignal) => parseTerminalDemoState(await terminalRequest<TerminalDemoState>('/state', 'GET', undefined, signal)),
  create: (value: {name: string; username: string; password: string; siteId: string}) => terminalRequest<DemoTerminal>('/terminals', 'POST', value),
  update: (id: string, value: {name?: string; active?: boolean; password?: string}) => terminalRequest<DemoTerminal>(`/terminals/${encodeURIComponent(id)}`, 'PATCH', value),
  release: (id: string) => terminalRequest(`/terminals/${encodeURIComponent(id)}/release`, 'POST', {}),
  defaultTerminal: (siteId: string, terminalId: string | null) => terminalRequest('/defaults', 'PUT', { siteId, terminalId }),
  send: (value: ApprovalSend) => terminalRequest<TerminalApproval>('/approvals', 'POST', value),
  cancel: (id: string, expectedStaff?: TerminalStaffIdentity) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/cancel`, 'POST', {}, undefined, expectedStaff),
  confirmId: (id: string, expectedStaff?: TerminalStaffIdentity) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/confirm-id`, 'POST', {}, undefined, expectedStaff),
  attest: (id: string, expectedStaff?: TerminalStaffIdentity) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/attest`, 'POST', {}, undefined, expectedStaff),
  login: async (username: string, password: string) => parseTerminalSession(await terminalRequest<TerminalSessionState>('/login', 'POST', { username, password })),
  session: async (signal?: AbortSignal) => parseTerminalSession(await terminalRequest<TerminalSessionState>('/session', 'GET', undefined, signal)),
  heartbeat: () => terminalRequest<{ alive: boolean; revision: number }>('/heartbeat', 'POST', {}),
  displayed: (id: string, version: number, snapshotHash: string) => terminalRequest(`/approvals/${encodeURIComponent(id)}/displayed`, 'POST', { version, snapshotHash }),
  logout: () => terminalRequest('/logout', 'POST', {}),
  respond: (id: string, value: {action: 'id_requested' | 'change_requested'; comment?: string; termsAccepted: boolean}) => terminalRequest(`/approvals/${encodeURIComponent(id)}/respond`, 'POST', value),
  customerReview: async (value: CustomerReviewCommand, actualUserId: string, effectiveUserId: string): Promise<CustomerReviewResult> => {
    const response = await fetch('/api/application/customer-review', {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Demo-Actor': actualUserId, 'X-Demo-User': effectiveUserId,
        ...staffHeaders({ actualUserId, effectiveUserId }) },
      body: JSON.stringify(value),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new TerminalDemoError(result.message ?? result.error ?? 'Kundvisningen kunde inte startas.', result.code ?? 'review_failed', response.status);
    if (!result.cardProjection || !Number.isSafeInteger(result.revision) || result.revision < 0)
      throw new TerminalDemoError('Serverns bekräftelse kunde inte läsas. Läs in kortet igen.', 'invalid_response', 502);
    return { approval: parseTerminalApproval(result.approval), cardProjection: result.cardProjection, revision: result.revision };
  },
};
