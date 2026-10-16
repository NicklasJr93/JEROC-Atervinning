import type { TransportVehicle } from '../office/transport/types';

export interface EmployeeFleetProfile {
  vehicleId: string; siteId?: string; defaultDriverId?: string | null;
  odometerKm?: number; odometerSource?: 'manual' | 'oem' | 'virtual' | 'unknown';
  photoUrl?: string; notes?: string; operatingHours?: number; blocked?: boolean; blockReason?: string;
  nextDriver?: { personId: string; source: 'app' | 'panel' | 'office'; selectedAt: string };
  lastContactAt?: string; status?: string;
}
export interface EmployeeFleetTrip {
  id: string; vehicleId: string; personId?: string; driverSource: 'default' | 'app' | 'panel' | 'office' | 'unknown';
  startAt: string; endAt?: string; distanceKm?: number; startOdometerKm?: number; endOdometerKm?: number;
  fromLabel?: string; toLabel?: string; classification?: 'private' | 'business'; purpose?: string; workOrderId?: string;
  revision: number; quality?: 'good' | 'sensor_gap' | 'review'; source: 'simulator' | 'device';
}
export interface EmployeeFleetService {
  id: string; vehicleId: string; title: string; dueDate?: string; dueKm?: number; dueHours?: number;
  status: 'planned' | 'completed'; workshop?: string; startAt?: string; endAt?: string; revision: number;
}
export interface EmployeeFleetIssue {
  id: string; vehicleId: string; title: string; description?: string;
  severity: 'low' | 'medium' | 'high' | 'critical'; status: 'open' | 'in_progress' | 'resolved'; photoUrls?: string[]; revision: number;
}
export interface EmployeeFleetInspection {
  id: string; vehicleId: string; checks: { key: string; label?: string; ok: boolean }[];
  comment?: string; photoUrls?: string[]; personId?: string; at: string;
}
export interface EmployeeFleetSnapshot {
  revision: number; personId: string; vehicles: TransportVehicle[]; profiles: Record<string, EmployeeFleetProfile>;
  services: EmployeeFleetService[]; issues: EmployeeFleetIssue[]; inspections: EmployeeFleetInspection[];
  trips: EmployeeFleetTrip[]; pendingTrips: EmployeeFleetTrip[];
  gate: { blocked: boolean; count: number; pendingTrips: EmployeeFleetTrip[]; safeToInteract?: boolean };
  capabilities: { read: boolean; write: boolean; vehicleWrite: boolean; export: boolean };
  workOrders: { id: string; customerName: string; siteId?: string; driverId?: string; vehicleId?: string }[];
  telematics?: { devices: { id: string; name: string; source: 'simulator' | 'device'; status: 'linked' | 'inactive'; vehicleId: string;
    lastContactAt: string | null; contactStatus: 'never' | 'recent' | 'stale'; ignition: 'off' | 'on' | 'unknown'; tripState: 'idle' | 'active' | 'unknown';
    sensors?: { speedKmh?: number; rpm?: number; fuelPercent?: number; coolantC?: number; batteryVolts?: number } }[] };
}
export type EmployeeFleetCommand =
  | { action: 'trip.complete'; tripId: string; expectedTripRevision: number; classification: 'private' | 'business'; purpose?: string; workOrderId?: string }
  | { action: 'inspection.save'; vehicleId: string; checks: EmployeeFleetInspection['checks']; comment?: string; photoUrls?: string[] }
  | { action: 'issue.save'; issue: Omit<EmployeeFleetIssue, 'id' | 'revision'> }
  | { action: 'driver.select'; vehicleId: string; personId: string };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const trip = (value: unknown): value is EmployeeFleetTrip => record(value) && typeof value.id === 'string' && typeof value.vehicleId === 'string'
  && Number.isInteger(value.revision) && date(value.startAt) && (value.endAt === undefined || date(value.endAt));
/** A malformed or differently scoped response must never release the trip gate. */
export function parseEmployeeFleet(value: unknown, personId: string): EmployeeFleetSnapshot {
  if (!record(value) || value.personId !== personId || !Number.isInteger(value.revision)
    || !Array.isArray(value.vehicles) || !value.vehicles.every(item => record(item) && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.registration === 'string')
    || !record(value.profiles) || !['services', 'issues', 'inspections', 'workOrders'].every(key => Array.isArray(value[key]))
    || !Array.isArray(value.trips) || !value.trips.every(trip) || !Array.isArray(value.pendingTrips) || !value.pendingTrips.every(trip)
    || !record(value.gate) || typeof value.gate.blocked !== 'boolean' || !Number.isInteger(value.gate.count)
    || !Array.isArray(value.gate.pendingTrips) || !value.gate.pendingTrips.every(trip)
    || (value.gate.safeToInteract !== undefined && typeof value.gate.safeToInteract !== 'boolean')
    || !record(value.capabilities) || value.capabilities.read !== true || typeof value.capabilities.write !== 'boolean')
    throw new Error('Fordonsuppgifterna kunde inte verifieras. Hämta dem igen.');
  const result = value as unknown as EmployeeFleetSnapshot;
  if ([...result.pendingTrips, ...result.gate.pendingTrips].some(item => item.personId !== personId || !item.endAt)
    || result.gate.count !== result.gate.pendingTrips.length || result.gate.blocked !== (result.gate.count > 0))
    throw new Error('Resornas aktuella status behöver hämtas igen.');
  if (!Object.values(result.profiles).every(record)
    || !result.services.every(item => record(item) && typeof item.id === 'string' && typeof item.vehicleId === 'string' && typeof item.title === 'string' && ['planned', 'completed'].includes(item.status))
    || !result.issues.every(item => record(item) && typeof item.id === 'string' && typeof item.vehicleId === 'string' && typeof item.title === 'string' && ['open', 'in_progress', 'resolved'].includes(item.status) && ['low', 'medium', 'high', 'critical'].includes(item.severity))
    || !result.inspections.every(item => record(item) && typeof item.id === 'string' && typeof item.vehicleId === 'string' && date(item.at) && Array.isArray(item.checks) && item.checks.every(check => record(check) && typeof check.ok === 'boolean'))
    || !result.workOrders.every(item => record(item) && typeof item.id === 'string' && typeof item.customerName === 'string')
    || result.telematics && (!Array.isArray(result.telematics.devices) || !result.telematics.devices.every(item => record(item) && typeof item.id === 'string' && typeof item.vehicleId === 'string' && (item.lastContactAt === null || date(item.lastContactAt)))))
    throw new Error('Fordonsuppgifterna är ofullständiga. Hämta dem igen.');
  return result;
}
