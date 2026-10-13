import { currentPlatformSession } from '../../platform/session';
import { PersonnelApiError, type PersonnelClientScope } from './client';
import type { VehicleRegistryResponse, VehicleSaveCommand } from '../transport/types';

async function vehicleRequest(scope: PersonnelClientScope, command?: VehicleSaveCommand, signal?: AbortSignal): Promise<VehicleRegistryResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new DOMException('Fordonsregistret svarade inte i tid. Uppdatera för att kontrollera vad som sparats.', 'TimeoutError')), 35000);
  try {
    const response = await fetch('/api/personnel/vehicles', {
      method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...scope.headers, ...(command ? { 'Content-Type': 'application/json' } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const value = await response.json().catch(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new PersonnelApiError('Fordonsregistret gav ett ofullständigt svar. Uppdatera innan du försöker igen.', response.ok ? 502 : response.status);
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    const session = currentPlatformSession();
    const platformKey = JSON.stringify(session?.authenticated ? [session.organisationId, session.generation] : 'legacy');
    if (platformKey !== scope.platformKey) throw new PersonnelApiError('Inloggningen eller företaget har ändrats. Hämta aktuella uppgifter.', 409, 'PRINCIPAL_CHANGED');
    if (!response.ok) throw new PersonnelApiError(value.message ?? (typeof value.error === 'string' ? value.error : value.error?.message) ?? 'Fordonet kunde inte sparas.', response.status, value.code);
    if (!Array.isArray(value.vehicles) || typeof value.capabilities?.vehicleRead !== 'boolean' || typeof value.capabilities?.vehicleWrite !== 'boolean')
      throw new PersonnelApiError('Fordonsregistret gav ett ofullständigt svar. Försök uppdatera igen.', 502);
    return value;
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export const readVehicles = (scope: PersonnelClientScope, signal?: AbortSignal) => vehicleRequest(scope, undefined, signal);
export const saveVehicle = (scope: PersonnelClientScope, command: VehicleSaveCommand, signal?: AbortSignal) => vehicleRequest(scope, command, signal);
