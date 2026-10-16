import type { TransportVehicle } from '../transport/types';

export type FleetSite = { id: string; name: string; active?: boolean };
export interface FleetPerson { id: string; name: string; userId?: string; driverId?: string; vehicleId?: string }
export interface FleetProfile {
  vehicleId?: string; revision?: number;
  siteId?: string; defaultDriverId?: string | null; odometerKm?: number; odometerSource?: 'manual' | 'oem' | 'virtual' | 'unknown';
  photoUrl?: string; notes?: string; operatingHours?: number;
  maintenance?: { intervalKm?: number; intervalHours?: number; intervalMonths?: number; lastServiceKm?: number; lastServiceHours?: number; lastServiceDate?: string };
  blocked?: boolean; blockReason?: string; blockedAt?: string; unblockedAt?: string; updatedAt?: string;
  nextDriver?: { personId: string; source: 'app' | 'panel' | 'office'; selectedAt: string };
}
export interface FleetService {
  id: string; vehicleId: string; title: string; dueDate?: string; dueKm?: number; dueHours?: number;
  status: 'planned' | 'completed'; workshop?: string; startAt?: string; endAt?: string; cost?: number; documentRefs?: string[];
  createdAt?: string; updatedAt?: string; revision?: number;
}
export interface FleetIssue {
  id: string; vehicleId: string; title: string; description?: string; severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'resolved'; photoUrls?: string[]; createdAt?: string; updatedAt?: string; revision?: number;
}
export interface FleetInspection {
  id: string; vehicleId: string; checks: { key: string; label?: string; ok: boolean }[]; comment?: string; photoUrls?: string[]; personId?: string; at?: string; revision?: number;
}
export interface FleetTrip {
  id: string; vehicleId: string; personId?: string; driverSource: 'default' | 'app' | 'panel' | 'office' | 'unknown';
  startAt: string; endAt?: string; distanceKm?: number; startOdometerKm?: number; endOdometerKm?: number;
  fromLabel?: string; toLabel?: string; classification?: 'private' | 'business'; purpose?: string; workOrderId?: string;
  revision: number; quality?: 'good' | 'sensor_gap' | 'review'; source: 'simulator' | 'device';
  driverConflict?: boolean;
  manualDriverAssignment?: { personId: string; reason: string; at: string; actualUserId: string; effectiveUserId: string; observedDriverSource: FleetTrip['driverSource']; previousPersonId?: string };
}
export interface FleetEvent { id?: string; vehicleId?: string; action: string; at: string; text?: string; personId?: string; actualUserId?: string; effectiveUserId?: string }
export interface FleetDevice {
  id: string; name: string; source: 'simulator' | 'device'; status: 'available' | 'linked' | 'transferring' | 'inactive';
  revision: number; vehicleId: string | null; transferId: string | null; assignedAt: string; lastContactAt: string | null;
  ignition: 'off' | 'on' | 'unknown'; tripState: 'idle' | 'active' | 'unknown'; contactStatus: 'never' | 'recent' | 'stale';
  canLink: boolean; canTransfer: boolean; blockedReasons: string[];
  reviewCount?: number; latestPosition?: { at: string; lat: number; lng: number };
  sensors?: { speedKmh?: number; rpm?: number; fuelPercent?: number; coolantC?: number; batteryVolts?: number };
}
export interface FleetBinding { id: string; deviceId: string; vehicleId: string; startAt: string; endAt: string | null; source: string; baseline: { source: 'unknown' | 'virtual_delta'; odometerKm: null }; createdBy?: string; closedBy?: string }
export interface FleetTransfer { id: string; deviceId: string; fromVehicleId: string; toVehicleId: string; startedAt: string; status: 'pending' | 'confirmed' | 'restored'; completedAt: string | null; revision: number }
export interface FleetTelematics { revision: number; devices: FleetDevice[]; bindings: FleetBinding[]; transfers: FleetTransfer[]; capabilities: { read: boolean; manage: boolean } }
export interface FleetState {
  revision: number; vehicles: TransportVehicle[]; profiles: Record<string, FleetProfile>; services: FleetService[]; issues: FleetIssue[];
  inspections: FleetInspection[]; trips: FleetTrip[]; events: FleetEvent[]; people: FleetPerson[];
  capabilities: { read: boolean; write: boolean; vehicleWrite: boolean; export: boolean; unblock?: boolean };
  workOrders?: { id: string; customerName: string; siteId?: string; driverId?: string; vehicleId?: string }[];
  telematics?: FleetTelematics;
  sites?: FleetSite[];
  positions?: { vehicleId: string; at: string; lat: number; lng: number; source: 'simulator' | 'device'; stale: boolean }[];
  tripCount?: number; truncated?: boolean; pagination?: { offset: number; limit: number; total: number };
  saved?: { trip?: FleetTrip; vehicleId?: string };
}
export type FleetActionInput =
  | { action: 'profile.save'; vehicleId: string; profile: Pick<FleetProfile, 'siteId' | 'defaultDriverId' | 'odometerKm' | 'odometerSource' | 'photoUrl' | 'notes' | 'operatingHours' | 'maintenance'> }
  | { action: 'service.save'; service: Omit<FleetService, 'id' | 'createdAt' | 'updatedAt' | 'revision'> & { id?: string } }
  | { action: 'issue.save'; issue: Omit<FleetIssue, 'id' | 'createdAt' | 'updatedAt' | 'revision'> & { id?: string } }
  | { action: 'vehicle.block'; vehicleId: string; blocked: boolean; reason: string }
  | { action: 'inspection.save'; vehicleId: string; checks: FleetInspection['checks']; comment?: string; photoUrls?: string[] }
  | { action: 'driver.select'; vehicleId: string; personId: string }
  | { action: 'trip.assign'; tripId: string; expectedTripRevision: number; personId: string; reason: string }
  | { action: 'device.link'; deviceId: string; vehicleId: string }
  | { action: 'device.transfer.start'; deviceId: string; toVehicleId: string }
  | { action: 'device.transfer.confirm' | 'device.transfer.restore'; transferId: string };
export type FleetAction = FleetActionInput & { expectedRevision: number; requestId: string };
export interface FleetExportFilters { from?: string; to?: string; vehicleId?: string; personId?: string; status?: string; classification?: string; search?: string }
export interface FleetReadFilters extends FleetExportFilters { offset?: number; limit?: number }
export interface FleetFile { id: string; name: string; contentType: string; url: string; vehicleId: string; kind: 'photo' | 'document'; uploadedAt: string }
