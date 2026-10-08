import type { ApprovalSend, DemoTerminal, TerminalApproval, TerminalDemoState, TerminalSessionState } from './terminal-demo-types';

export class TerminalDemoError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function terminalRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/terminal-demo${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string };
  if (!response.ok) throw new TerminalDemoError(result.message ?? result.error ?? 'Terminaltjänsten kunde inte nås.', result.code ?? 'request_failed', response.status);
  return result as T;
}
export const terminalDemoApi = {
  staffSession: (actualUserId: string, effectiveUserId: string) => terminalRequest('/staff-session', 'POST', { actualUserId, effectiveUserId }),
  state: (signal?: AbortSignal) => terminalRequest<TerminalDemoState>('/state', 'GET', undefined, signal),
  create: (value: {name: string; username: string; password: string; siteId: string}) => terminalRequest<DemoTerminal>('/terminals', 'POST', value),
  update: (id: string, value: {name?: string; active?: boolean; password?: string}) => terminalRequest<DemoTerminal>(`/terminals/${encodeURIComponent(id)}`, 'PATCH', value),
  release: (id: string) => terminalRequest(`/terminals/${encodeURIComponent(id)}/release`, 'POST', {}),
  defaultTerminal: (siteId: string, terminalId: string | null) => terminalRequest('/defaults', 'PUT', { siteId, terminalId }),
  send: (value: ApprovalSend) => terminalRequest<TerminalApproval>('/approvals', 'POST', value),
  cancel: (id: string) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  confirmId: (id: string) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/confirm-id`, 'POST', {}),
  attest: (id: string) => terminalRequest<TerminalApproval>(`/approvals/${encodeURIComponent(id)}/attest`, 'POST', {}),
  login: (username: string, password: string) => terminalRequest<TerminalSessionState>('/login', 'POST', { username, password }),
  session: (signal?: AbortSignal) => terminalRequest<TerminalSessionState>('/session', 'GET', undefined, signal),
  logout: () => terminalRequest('/logout', 'POST', {}),
  respond: (id: string, value: {action: 'id_requested' | 'change_requested'; comment?: string; termsAccepted: boolean}) => terminalRequest(`/approvals/${encodeURIComponent(id)}/respond`, 'POST', value),
};
