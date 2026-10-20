import { requestPersonLookup } from '../person-register/client';
import type { PersonRegisterLookupResult } from '../person-register/client';
import { tenantPublicHeaders } from '../tenant-public-context';

export type CustomerIntakePersonLookup = (personalNumber: string, requestId: string, signal: AbortSignal) => Promise<PersonRegisterLookupResult>;

export function lookupPublicIntakePerson(token: string, personalNumber: string, requestId: string, signal: AbortSignal) {
  return requestPersonLookup('/api/public/customer-intake/person-lookup', personalNumber,
    { requestId, signal, credentials: 'omit', headers: { Authorization: `Bearer ${token}` } });
}
export async function lookupTerminalIntakePerson(intakeId: string, personalNumber: string, requestId: string, signal: AbortSignal) {
  const headers = await tenantPublicHeaders();
  if (signal.aborted) throw signal.reason;
  return requestPersonLookup('/api/terminal-demo/customer-intake/person-lookup', personalNumber,
    { requestId, signal, credentials: 'same-origin', headers, intakeId });
}
