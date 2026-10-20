import { z } from 'zod';
import { publicApprovalSchema } from '../office/terminal-demo-types';

const stateSchema = z.object({
  companyName: z.string().min(1).max(300),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  approval: publicApprovalSchema,
});
export type CustomerApprovalState = z.infer<typeof stateSchema>;
export type CustomerApprovalResponse = { action: 'id_requested' | 'change_requested'; termsAccepted: boolean; comment?: string };

export class CustomerApprovalError extends Error {
  constructor(public status: number) { super('Kundgranskningen kunde inte hämtas.'); this.name = 'CustomerApprovalError'; }
}

/** The bearer never enters URLs, cookies or browser storage. A public review
 * also must not inherit the office's session or its tenant selector. */
async function request(token: string, signal: AbortSignal, command?: CustomerApprovalResponse): Promise<CustomerApprovalState> {
  const timeout = AbortSignal.timeout(12000);
  const response = await fetch(command ? '/api/public/customer-approval/respond' : '/api/public/customer-approval', {
    method: command ? 'POST' : 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    signal: AbortSignal.any([signal, timeout]),
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(command ? { 'Content-Type': 'application/json' } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  });
  if (!response.ok) throw new CustomerApprovalError(response.status);
  const parsed = stateSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.approval.version !== parsed.data.approval.snapshot.version
    || !Number.isFinite(Date.parse(parsed.data.approval.updatedAt))) throw new CustomerApprovalError(502);
  if (command && (command.action === 'id_requested' ? !['id_requested', 'approved', 'attested'].includes(parsed.data.approval.status)
    : parsed.data.approval.status !== 'change_requested')) throw new CustomerApprovalError(502);
  return parsed.data;
}

export const readCustomerApproval = (token: string, signal: AbortSignal) => request(token, signal);
export const respondToCustomerApproval = (token: string, command: CustomerApprovalResponse, signal: AbortSignal) => request(token, signal, command);
