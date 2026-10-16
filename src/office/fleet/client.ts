import { currentPlatformSession } from '../../platform/session';
import { personnelClientScope, type PersonnelClientScope } from '../personnel/client';
import type { OfficeUser } from '../model';
import type { FleetAction, FleetExportFilters, FleetFile, FleetReadFilters, FleetState } from './types';

export { personnelClientScope as fleetScope };
export type FleetScope = PersonnelClientScope;
export const fleetAccessDeniedEvent = 'scrappilot:fleet-access-denied';
export const mayReadFleet = (user: OfficeUser, actualUser: OfficeUser) => [actualUser, user].every(person => person.active !== false &&
  (person.level !== 'Medarbetare' || person.permissions.includes('fleetRead')));
const platformKey = () => { const session = currentPlatformSession(); return JSON.stringify(session?.authenticated ? [session.organisationId, session.generation] : 'legacy'); };
export class FleetApiError extends Error { constructor(message: string, public status: number, public code?: string) { super(message); } }

async function request(scope: FleetScope, path = '', init?: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Fordonsvyn svarade inte i tid. Uppdatera för att kontrollera vad som sparats.', 'TimeoutError')), 45000);
  try {
    const response = await fetch(`/api/fleet${path}`, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...init?.headers } });
    // Consume the body before releasing the timeout/identity guard.
    const blob = await response.blob();
    if (controller.signal.aborted) throw controller.signal.reason;
    if (scope.platformKey !== platformKey()) throw new FleetApiError('Bolaget eller inloggningen har ändrats. Uppdatera vyn.', 409, 'PRINCIPAL_CHANGED');
    if (!response.ok) {
      const error = await blob.text().then(value => { try { return JSON.parse(value); } catch { return {}; } });
      if ([401, 403].includes(response.status)) window.dispatchEvent(new CustomEvent(fleetAccessDeniedEvent, { detail: { scopeKey: scope.key } }));
      throw new FleetApiError(error.message ?? (typeof error.error === 'string' ? error.error : error.error?.message) ?? 'Fordonsuppgifterna kunde inte hämtas.', response.status, error.code);
    }
    return new Response(blob, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
async function json<T>(scope: FleetScope, path?: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await request(scope, path, init, signal);
  try { return await response.json() as T; } catch { throw new FleetApiError('Fordonsvyn gav ett ofullständigt svar. Uppdatera innan du försöker igen.', 502); }
}
const state = (value: FleetState) => {
  if (!Number.isFinite(value?.revision) || !Array.isArray(value.vehicles) || !value.profiles || !Array.isArray(value.trips) || !Array.isArray(value.services) || !Array.isArray(value.issues) || !value.capabilities)
    throw new FleetApiError('Fordonsvyn gav ett ofullständigt svar. Uppdatera innan du försöker igen.', 502);
  return value;
};
export const readFleet = async (scope: FleetScope, signal?: AbortSignal, filters?: FleetReadFilters) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value));
  return state(await json<FleetState>(scope, query.size ? `?${query}` : '', undefined, signal));
};
export const changeFleet = async (scope: FleetScope, command: FleetAction, signal?: AbortSignal) => state(await json<FleetState>(scope, '/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }, signal));
export const readFleetFiles = (scope: FleetScope, vehicleId: string, signal?: AbortSignal) => json<{ files: FleetFile[] }>(scope, `/files?${new URLSearchParams({ vehicleId })}`, undefined, signal);
export async function uploadFleetFile(scope: FleetScope, vehicleId: string, kind: FleetFile['kind'], file: File, signal?: AbortSignal) {
  const allowed = kind === 'photo' ? ['image/jpeg', 'image/png', 'image/webp'] : ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) throw new FleetApiError(kind === 'photo' ? 'Välj JPG, PNG eller WebP på högst 8 MB.' : 'Välj en PDF eller bild på högst 8 MB.', 422);
  return json<{ file: FleetFile }>(scope, `/files?${new URLSearchParams({ vehicleId, kind })}`, { method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file }, signal);
}
export async function getFleetFile(scope: FleetScope, file: Pick<FleetFile, 'id'>, signal?: AbortSignal) {
  const response = await request(scope, `/files/${encodeURIComponent(file.id)}`, undefined, signal); return response.blob();
}
export async function exportFleet(scope: FleetScope, format: 'csv' | 'pdf', filters: FleetExportFilters, signal?: AbortSignal) {
  const query = new URLSearchParams({ format });
  for (const [key, value] of Object.entries(filters)) if (value && value !== 'all') query.set(key, value);
  const response = await request(scope, `/export?${query}`, { headers: { Accept: format === 'pdf' ? 'application/pdf' : 'text/csv' } }, signal);
  const type = response.headers.get('content-type') ?? '';
  if (format === 'pdf' ? !type.includes('application/pdf') : !type.includes('csv')) throw new FleetApiError('Exporten gav inte den förväntade filtypen. Försök igen.', 502);
  return response.blob();
}
export function downloadFleetBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** Images and documents stay behind the same authenticated fleet boundary. */
export function fleetFileId(url?: string) { return url?.match(/^\/api\/fleet\/files\/([A-Za-z0-9_-]+)$/)?.[1]; }
