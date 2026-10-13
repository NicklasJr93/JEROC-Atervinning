import { PricingError } from './pricing.mjs';

/** This small guard deliberately has no dependency on the sickness calculation
 * engine, so every clock/work-order entry point can enforce it atomically. */
export function assertSicknessWorkAllowed(state, personOrId, context = {}) {
  const personId = typeof personOrId === 'string' ? personOrId : personOrId.id;
  const now = new Date(typeof context.now === 'function' ? context.now() : context.now ?? Date.now());
  const fields = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const today = `${fields.year}-${fields.month}-${fields.day}`, minute = Number(fields.hour) * 60 + Number(fields.minute);
  const active = state.employeeSickness?.cases?.find(item => item.personId === personId && item.status === 'open' && item.fromDate <= today &&
    (!item.recoveryPlan || item.recoveryPlan.healthyFromDate > today));
  const extent = active?.dayChanges?.filter(item => item.date <= today).sort((a, b) => b.date.localeCompare(a.date) || b.revision - a.revision)[0]?.extent ?? active?.extent;
  if (extent === 100 && (active.fromDate < today || (active.startMinute ?? 0) <= minute))
    throw Object.assign(new PricingError('Du är sjukanmäld på heltid. Friskanmäl dig innan du påbörjar arbete.', 409), { code: 'SICKNESS_ACTIVE' });
  // Partial sick leave permits work. Its actual loss and remaining work hours
  // are reconciled in the underlay, rather than falsely demanding full recovery.
}
