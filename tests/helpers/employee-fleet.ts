import type { EmployeeFleetSnapshot } from '../../src/employee/employee-fleet-types';

/** Explicit authenticated own-person fixture: no vehicles or unfinished trips.
 * Production must still obtain and validate its real fleet snapshot. */
export function emptyEmployeeFleet(personId: string): EmployeeFleetSnapshot {
  return { revision: 0, personId, vehicles: [], profiles: {}, services: [], issues: [], inspections: [], trips: [], pendingTrips: [],
    gate: { blocked: false, count: 0, pendingTrips: [], safeToInteract: true },
    workOrders: [], capabilities: { read: true, write: true, vehicleWrite: false, export: false } };
}
