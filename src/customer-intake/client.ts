import { z } from 'zod';
import { EmployeeError, employeeError, employeeRequest } from '../employee/EmployeeProvider';
import { draftSchema, storeSchema } from '../model';
import { customerIntakeSchema } from './types';

const intakeResultSchema = z.object({ intake: customerIntakeSchema });
const intakeStateSchema = z.object({
  intake: customerIntakeSchema.nullable(),
  terminals: z.array(z.object({ id: z.string().min(1), name: z.string(), siteId: z.string().min(1), available: z.boolean() })),
  smsConfigured: z.boolean(),
});
export const customerIntakeApplyResultSchema = z.object({
  intake: customerIntakeSchema,
  customer: storeSchema.shape.customers.element,
  draftPatch: draftSchema.pick({ id: true, customerId: true, reference: true, origin: true,
    originDetails: true, customerSelectionsSavedAt: true, updatedAt: true }).extend({ customerId: z.string().min(1) }),
  revision: z.number().int().nonnegative(),
});
export type CustomerIntakeState = z.infer<typeof intakeStateSchema>;
export type CustomerIntakeApplyResult = z.infer<typeof customerIntakeApplyResultSchema>;
export type CustomerIntakeScope = { companyId: string; personId: string };
export type CustomerIntakeCreate = {
  draftId: string; channel: 'terminal' | 'sms'; terminalId?: string; phone?: string;
  requestId: string; expectedCustomerId: string | null;
};
export const customerIntakeError = (error: unknown): string => error instanceof z.ZodError
  ? 'Serverns svar kunde inte läsas. Uppdatera status innan du försöker igen.'
  : employeeError(error);
export const customerIntakeSessionChanged = (error: unknown): boolean => error instanceof EmployeeError
  && (error.status === 401 || error.code === 'company_selection_changed');

/** Each command retains its initiating company and person even if another tab
 * changes the authenticated cookie while the request is in flight. */
export function customerIntakeClient(scope: CustomerIntakeScope) {
  const options = (signal?: AbortSignal) => ({ expectedCompanyId: scope.companyId, expectedPersonId: scope.personId, signal });
  async function request(path: string, body?: unknown, signal?: AbortSignal) {
    try { return await employeeRequest(path, body, options(signal)); }
    catch (error) {
      if (!signal?.aborted && customerIntakeSessionChanged(error)) window.dispatchEvent(new Event('jeroc:employee-session-check'));
      throw error;
    }
  }
  return {
    async load(draftId: string, signal?: AbortSignal): Promise<CustomerIntakeState> {
      const value = await request(`/customer-intake?${new URLSearchParams({ draftId })}`, undefined, signal);
      return intakeStateSchema.parse(value);
    },
    async create(command: CustomerIntakeCreate, signal?: AbortSignal) {
      return intakeResultSchema.parse(await request('/customer-intake', command, signal));
    },
    async cancel(id: string, requestId: string, signal?: AbortSignal) {
      return intakeResultSchema.parse(await request('/customer-intake/cancel', { id, requestId }, signal));
    },
    async apply(id: string, requestId: string, signal?: AbortSignal): Promise<CustomerIntakeApplyResult> {
      return customerIntakeApplyResultSchema.parse(await request('/customer-intake/apply', { id, requestId }, signal));
    },
  };
}

export function customerIntakeRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
