import { vehicleIdentifier, type TransportVehicle } from '../transport/types';
import type { FleetProfile, FleetService, FleetState, FleetTrip } from './types';

export const day = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
export const number = (value?: number | null, maximumFractionDigits = 1) => value !== undefined && value !== null && Number.isFinite(value) ? value.toLocaleString('sv-SE', { maximumFractionDigits }) : '—';
export const date = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value).toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
export const time = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }) : '—';
export const timestamp = (value?: string | null) => value ? `${date(value)} ${time(value)}` : '—';
export const vehicleLabel = (vehicle?: TransportVehicle) => vehicle ? vehicleIdentifier(vehicle) : 'Fordon';
export const categoryLabels: Record<string, string> = { truck: 'Lastbil', van: 'Transportbil', car: 'Personbil', trailer: 'Släp', machine: 'Maskin', other: 'Annat fordon' };
export const severityLabels = { low: 'Låg', medium: 'Medel', high: 'Hög', critical: 'Kritisk' };
export const issueStatusLabels = { open: 'Öppet', in_progress: 'Pågår', resolved: 'Åtgärdat' };
export const driverSourceLabels = { default: 'Standardförare', app: 'Appval', panel: 'Förarpanel', office: 'Kontorsval', unknown: 'Förare saknas' };
export const sourceLabels = { manual: 'Manuell avläsning', oem: 'Fordonsmätare', virtual: 'Virtuell GPS-mätare', unknown: 'Källa saknas' };
export function tripComplete(trip: FleetTrip) { return Boolean(trip.endAt && trip.personId && (trip.classification === 'private' || trip.classification === 'business' && (trip.purpose && trip.purpose.trim().length >= 5 && !/^(tjänst|arbete|jobb|business|work)$/i.test(trip.purpose.trim()) || trip.workOrderId))); }
export function vehicleStatus(state: FleetState, vehicle: TransportVehicle) {
  const profile = state.profiles[vehicle.id];
  if (vehicle.active === false) return { label: 'Inaktiverat', tone: 'grey' as const, key: 'inactive' };
  if (profile?.blocked) return { label: 'Driftspärrat', tone: 'red' as const, key: 'blocked' };
  const now = Date.now();
  if (state.services.some(service => service.vehicleId === vehicle.id && service.status === 'planned' && service.startAt && service.endAt && Date.parse(service.startAt) <= now && Date.parse(service.endAt) > now))
    return { label: 'På verkstad', tone: 'orange' as const, key: 'workshop' };
  return { label: 'I drift', tone: 'green' as const, key: 'available' };
}
export function serviceDue(service: FleetService, profile?: FleetProfile) {
  return service.status === 'planned' && Boolean(service.dueDate && service.dueDate <= day() || service.dueKm !== undefined && profile?.odometerKm !== undefined && profile.odometerKm >= service.dueKm || service.dueHours !== undefined && profile?.operatingHours !== undefined && profile.operatingHours >= service.dueHours);
}
export function serviceHint(service: FleetService, profile?: FleetProfile) {
  return [service.dueDate && `Senast ${date(service.dueDate)}`, service.dueKm !== undefined && `${number(service.dueKm)} km${profile?.odometerKm !== undefined ? ` · ${number(Math.max(0, service.dueKm - profile.odometerKm))} km kvar` : ''}`, service.dueHours !== undefined && `${number(service.dueHours)} h${profile?.operatingHours !== undefined ? ` · ${number(Math.max(0, service.dueHours - profile.operatingHours))} h kvar` : ''}`].filter(Boolean).join(' · ') || 'Tid eller mätargräns saknas';
}
export const nextService = (state: FleetState, vehicleId: string) => state.services.filter(service => service.vehicleId === vehicleId && service.status === 'planned').sort((a, b) => Number(serviceDue(b, state.profiles[vehicleId])) - Number(serviceDue(a, state.profiles[vehicleId])) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999'))[0];
export function stockholmInstant(value: string, original?: string) {
  if (!value) return undefined;
  const local = (instant: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant)).replace(' ', 'T');
  if (original && local(Date.parse(original)) === value) return original;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) throw new Error('Ange ett giltigt datum och klockslag.');
  const target = Date.UTC(+parts[1], +parts[2] - 1, +parts[3], +parts[4], +parts[5]); let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) { const observed = local(instant).match(/\d+/g)!.map(Number); const delta = target - Date.UTC(observed[0], observed[1] - 1, observed[2], observed[3], observed[4]); instant += delta; if (!delta) break; }
  if (local(instant) !== value) throw new Error('Tiden finns inte vid övergången till sommartid. Välj ett annat klockslag.');
  return new Date(instant).toISOString();
}
