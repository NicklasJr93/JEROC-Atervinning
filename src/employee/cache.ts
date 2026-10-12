import { STORE_KEY } from '../model';

/** Company comes from the authenticated employee response, not a query string.
 * Legacy server fixtures omitted it; only those fixtures use the JEROC default.
 */
export const employeeCompanyId = (companyId?: string) => companyId || 'jeroc-demo';
export function employeeIdentity(companyId: string, personId?: string) {
  return `${employeeCompanyId(companyId)}:employee:${personId || 'signed-out'}`;
}
export function employeeRecoveryKey(companyId: string, personId?: string) {
  return `${STORE_KEY}.company.${encodeURIComponent(employeeCompanyId(companyId))}.employee.${encodeURIComponent(personId || 'signed-out')}`;
}
export function legacyEmployeeRecoveryKey(companyId: string, personId?: string) {
  return employeeCompanyId(companyId) === 'jeroc-demo' && personId ? `${STORE_KEY}.employee.${personId}` : undefined;
}
