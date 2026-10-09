import { personnelDriverAvailability } from '../personnel/model';
import type { PersonnelData } from '../personnel/types';

export interface UnavailableSpan { startMinute: number; endMinute: number; label: string }

/** Only availability is displayed in the planner; absence reasons stay in HR. */
export function transportUnavailableSpans(data: PersonnelData, driverId: string, day: string): UnavailableSpan[] {
  const person = data.people.find(entry => entry.driverId === driverId);
  if (!person?.active || !person.canDrive) return [{ startMinute: 0, endMinute: 1440, label: 'Ej tillgänglig' }];
  const availability = personnelDriverAvailability(data, driverId, day);
  const shifts = availability.filter(span => span.kind === 'shift').sort((a, b) => a.fromMinute - b.fromMinute);
  const result: UnavailableSpan[] = [];
  let end = 0;
  for (const shift of shifts) {
    if (shift.fromMinute > end) result.push({ startMinute: end, endMinute: shift.fromMinute, label: 'Utanför arbetspass' });
    end = Math.max(end, shift.toMinute);
  }
  if (end < 1440) result.push({ startMinute: end, endMinute: 1440, label: 'Utanför arbetspass' });
  for (const span of availability.filter(span => span.kind !== 'shift')) result.push({
    startMinute: span.fromMinute, endMinute: span.toMinute,
    label: span.kind === 'lunch' ? 'Lunch' : 'Ej tillgänglig',
  });
  return result;
}
