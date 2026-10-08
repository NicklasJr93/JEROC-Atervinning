import { z } from 'zod';
import type {
  TransportActor, TransportAudit, TransportChange, TransportData, TransportDraft,
  TransportOrder, TransportPlan, TransportVehicle, TransportEventType, TransportIntegrationEvent,
} from './types';

export const transportKey = 'jeroc.transport.demo.v1';
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
function validDay(value: string): boolean {
  return dayPattern.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(day: string, amount: number): string {
  if (!validDay(day) || !Number.isInteger(amount)) throw new Error('Ogiltigt datum.');
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function monday(day = today()): string {
  if (!validDay(day)) throw new Error('Ogiltigt datum.');
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
}
export function timeLabel(minutes: number): string {
  return `${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`;
}
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return [hours ? `${hours} tim` : '', rest ? `${rest} min` : ''].filter(Boolean).join(' ') || '0 min';
}

const daySchema = z.string().refine(validDay, 'Ange ett giltigt datum.');
const textSchema = z.string().max(2000);
const requiredText = z.string().trim().min(1).max(200, 'Texten är för lång.');
const durationSchema = z.number().int().min(15).max(480).multipleOf(15);
const startSchema = z.number().int().min(0).max(1425).multipleOf(15);
const vesselSchema = z.enum(['container', 'battery', 'bin', 'cage']);
const auditSchema = z.object({
  at: z.string().datetime(), actor: requiredText, actualUserId: requiredText,
  effectiveUserId: requiredText, text: textSchema,
});
const vehicleSchema = z.object({
  id: requiredText, registration: requiredText, name: requiredText,
  types: z.array(vesselSchema).min(1),
});
const driverSchema = z.object({ id: requiredText, name: requiredText, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), vehicleId: requiredText });
const planSchema = z.object({ date: daySchema, startMinute: startSchema, durationMinutes: durationSchema, driverId: requiredText, vehicleId: requiredText });
const confirmationSchema = z.object({
  id: requiredText, bookingVersion: z.number().int().nonnegative(),
  status: z.enum(['requested', 'accepted', 'declined', 'expired']),
  requestedAt: z.string().datetime(), expiresAt: z.string().datetime(), respondedAt: z.string().datetime().optional(),
});
const eventSchema = z.object({
  id: requiredText, type: z.enum(['work_order.created', 'work_order.updated', 'work_order.booked', 'work_order.rescheduled',
    'work_order.booking_cancelled', 'work_order.cancelled', 'work_order.en_route', 'work_order.completed',
    'work_order.confirmation_requested', 'work_order.confirmation_accepted', 'work_order.confirmation_declined', 'work_order.confirmation_expired']),
  orderId: requiredText, at: z.string().datetime(), bookingVersion: z.number().int().nonnegative(),
  customer: z.object({ id: requiredText.optional(), name: requiredText }),
  driver: z.object({ id: requiredText, name: requiredText }).optional(),
  beforePlan: planSchema.optional(), afterPlan: planSchema.optional(), reason: textSchema.optional(),
  actor: requiredText, actualUserId: requiredText, effectiveUserId: requiredText,
  confirmationId: requiredText.optional(),
});
const orderSchema = z.object({
  id: requiredText, customerId: requiredText.optional(), customerName: requiredText,
  address: requiredText, city: requiredText, contact: textSchema, phone: textSchema,
  action: z.enum(['pickup', 'exchange', 'placement']), vesselType: vesselSchema,
  material: textSchema, vesselSize: textSchema, pickupVessel: textSchema,
  replacementVessel: textSchema, notes: textSchema,
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
  durationMinutes: durationSchema.default(60),
  status: z.enum(['unbooked', 'booked', 'on_way', 'done', 'cancelled']),
  date: daySchema.optional(), startMinute: startSchema.optional(),
  driverId: requiredText.optional(), vehicleId: requiredText.optional(),
  requestedDate: daySchema.optional(), seriesId: requiredText.optional(),
  audit: z.array(auditSchema), updatedAt: z.string().datetime(),
  bookingVersion: z.number().int().nonnegative().default(0), confirmation: confirmationSchema.optional(),
});
const baseDataSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  orders: z.array(orderSchema), drivers: z.array(driverSchema), vehicles: z.array(vehicleSchema),
  preliminary: z.record(planSchema).default({}), events: z.array(eventSchema).default([]),
});

/** One projection for map, calendar and collision checks; staged bookings are reservations. */
export function effectiveTransportOrders(data: TransportData): TransportOrder[] {
  return data.orders.map((order) => data.preliminary?.[order.id]
    ? { ...order, ...data.preliminary[order.id], status: 'booked', preliminary: true }
    : { ...order, preliminary: false });
}

/** All scheduling validation uses the same rules as persisted data and drag previews. */
export function validateTransportPlan(data: TransportData, id: string, plan: TransportPlan): string | null {
  const order = data.orders.find((entry) => entry.id === id);
  if (!order) return 'Arbetsordern finns inte längre.';
  if (!validDay(plan.date)) return 'Ange ett giltigt datum.';
  if (!durationSchema.safeParse(plan.durationMinutes).success) return 'Tidsåtgången måste vara 15 minuter till 8 timmar i 15-minuterssteg.';
  if (!startSchema.safeParse(plan.startMinute).success || plan.startMinute + plan.durationMinutes > 1440) {
    return 'Uppdraget måste rymmas inom samma dag i 15-minuterssteg.';
  }
  const driver = data.drivers.find((entry) => entry.id === plan.driverId);
  if (!driver) return 'Välj en befintlig förare.';
  const vehicle = data.vehicles.find((entry) => entry.id === plan.vehicleId);
  if (!vehicle) return 'Välj ett befintligt fordon.';
  if (!vehicle.types.includes(order.vesselType)) return 'Fordonet kan inte hantera denna kärltyp.';
  const end = plan.startMinute + plan.durationMinutes;
  const clash = effectiveTransportOrders(data).find((entry) => entry.id !== id && !['unbooked', 'cancelled'].includes(entry.status) &&
    entry.date === plan.date && entry.startMinute !== undefined &&
    (entry.driverId === plan.driverId || entry.vehicleId === plan.vehicleId) &&
    entry.startMinute < end && entry.startMinute + entry.durationMinutes > plan.startMinute);
  if (clash) {
    const resource = clash.driverId === plan.driverId ? driver.name : vehicle.registration;
    return `${resource} är redan bokad ${timeLabel(clash.startMinute!)}–${timeLabel(clash.startMinute! + clash.durationMinutes)} (${clash.id}).`;
  }
  return null;
}

export const transportSchema = baseDataSchema.superRefine((data, context) => {
  const checkIds = (entries: { id: string }[], field: string) => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Dubblett av identitet.' });
      ids.add(entry.id);
    }
  };
  checkIds(data.orders, 'orders'); checkIds(data.drivers, 'drivers'); checkIds(data.vehicles, 'vehicles');
  checkIds(data.events, 'events');
  data.drivers.forEach((driver, index) => {
    if (!data.vehicles.some((vehicle) => vehicle.id === driver.vehicleId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['drivers', index, 'vehicleId'], message: 'Förarens fordon saknas.' });
    }
  });
  data.orders.forEach((order, index) => {
    let problem: string | null = null;
    if (order.status === 'unbooked') {
      if (order.date !== undefined || order.startMinute !== undefined || order.driverId !== undefined || order.vehicleId !== undefined) {
        problem = 'Obokade arbeten får inte ha en kalenderbokning.';
      }
    } else if (order.status === 'cancelled' && order.date === undefined && order.startMinute === undefined && order.driverId === undefined && order.vehicleId === undefined) {
      // An unbooked order may also be cancelled. Scheduled cancellations retain their old plan.
    } else if (!order.date || order.startMinute === undefined || !order.driverId || !order.vehicleId) {
      problem = 'Bokade arbeten måste ha datum, tid, förare och fordon.';
    } else {
      problem = validateTransportPlan(order.status === 'cancelled' ? { ...data, orders: [order], preliminary: {} } : data, order.id, {
        date: order.date, startMinute: order.startMinute, durationMinutes: order.durationMinutes,
        driverId: order.driverId, vehicleId: order.vehicleId,
      });
    }
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ['orders', index], message: problem });
    if (order.confirmation && order.confirmation.status !== 'expired' && order.confirmation.bookingVersion !== order.bookingVersion) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['orders', index, 'confirmation'], message: 'Kundsvaret hör till en tidigare bokningsversion.' });
    }
  });
  Object.entries(data.preliminary).forEach(([id, plan]) => {
    const order = data.orders.find((entry) => entry.id === id);
    const problem = !order || order.status !== 'unbooked' ? 'En preliminär bokning måste höra till en obokad arbetsorder.' : validateTransportPlan(data, id, plan);
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, path: ['preliminary', id], message: problem });
  });
});

function audit(actor: TransportActor, text: string): TransportAudit {
  return { at: new Date().toISOString(), actor: actor.actor, actualUserId: actor.actualUserId, effectiveUserId: actor.effectiveUserId, text };
}
function assertActor(actor: TransportActor): void {
  if (!actor.canPlan) throw new Error('Du saknar behörighet att planera transporter.');
  if (![actor.actor, actor.actualUserId, actor.effectiveUserId].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Användaren kunde inte identifieras. Logga in igen.');
  }
}
function record(order: TransportOrder, actor: TransportActor, text: string): TransportOrder {
  const entry = audit(actor, text);
  return { ...order, audit: [...order.audit, entry], updatedAt: entry.at };
}
function clearBooking(order: TransportOrder): TransportOrder {
  const copy = { ...order, status: 'unbooked' as const };
  delete copy.date; delete copy.startMinute; delete copy.driverId; delete copy.vehicleId;
  return copy;
}
function assertValid(data: TransportData): TransportData {
  const parsed = transportSchema.safeParse(data);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'Ogiltiga transportuppgifter.');
  return parsed.data;
}
function writableOrder(data: TransportData, id: string, allowActive = false): TransportOrder {
  const order = data.orders.find((entry) => entry.id === id);
  if (!order) throw new Error('Arbetsordern finns inte längre.');
  if (order.status === 'cancelled') throw new Error('En avbruten arbetsorder kan inte ändras.');
  if (order.status === 'done') throw new Error('Ett slutfört uppdrag kan inte ändras.');
  if (order.status === 'on_way' && !allowActive) throw new Error('Ett påbörjat uppdrag kan inte bokas om.');
  return order;
}
function nextOrderNumber(data: TransportData): number {
  return Math.max(1000, ...data.orders.map((order) => Number(order.id.match(/^AO-(\d+)$/)?.[1]) || 0)) + 1;
}
const fieldLabels: Partial<Record<keyof TransportDraft, string>> = {
  customerName: 'kund', customerId: 'kundkoppling', address: 'adress', city: 'ort',
  contact: 'kontaktperson', phone: 'telefon', action: 'uppdragstyp', vesselType: 'kärltyp',
  material: 'material', vesselSize: 'kärlstorlek', pickupVessel: 'kärl att hämta',
  replacementVessel: 'ersättningskärl', notes: 'instruktioner', lat: 'kartposition', lng: 'kartposition',
  durationMinutes: 'tidsåtgång', status: 'status', date: 'datum', startMinute: 'starttid',
  driverId: 'förare', vehicleId: 'fordon', requestedDate: 'önskat datum',
};
function dayOffset(from: string, to: string): number {
  if (!validDay(from) || !validDay(to)) throw new Error('Ange ett giltigt datum.');
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

const immutableOrderFields = ['id', 'audit', 'updatedAt', 'seriesId', 'bookingVersion', 'confirmation', 'preliminary'];
export function transportPlanOf(order: TransportOrder | undefined): TransportPlan | undefined {
  if (!order || ['unbooked', 'cancelled'].includes(order.status) || !order.date || order.startMinute === undefined || !order.driverId || !order.vehicleId) return undefined;
  return { date: order.date, startMinute: order.startMinute, durationMinutes: order.durationMinutes, driverId: order.driverId, vehicleId: order.vehicleId };
}
const same = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);
function addEvent(data: TransportData, type: TransportEventType, order: TransportOrder, actor: TransportActor, options: Partial<Pick<TransportIntegrationEvent, 'beforePlan' | 'afterPlan' | 'reason' | 'confirmationId'>> = {}): void {
  const driverId = options.afterPlan?.driverId ?? options.beforePlan?.driverId ?? order.driverId;
  const driver = data.drivers.find((entry) => entry.id === driverId);
  data.events.push({
    id: `transport-${crypto.randomUUID()}`, type, orderId: order.id, at: new Date().toISOString(), bookingVersion: order.bookingVersion,
    customer: { id: order.customerId, name: order.customerName }, driver: driver ? { id: driver.id, name: driver.name } : undefined,
    actor: actor.actor, actualUserId: actor.actualUserId, effectiveUserId: actor.effectiveUserId, ...options,
  });
}
/** Build events from the final atomic state, never from intermediate editor or staged mutations. */
function prepareEvents(before: TransportData, next: TransportData, actor: TransportActor, reason?: string): TransportData {
  const previousById = new Map(before.orders.map((entry) => [entry.id, entry]));
  const comparable = (order: TransportOrder) => Object.fromEntries(Object.entries(order).filter(([key]) => !['audit', 'updatedAt', 'bookingVersion', 'confirmation', 'preliminary'].includes(key)));
  next.orders = next.orders.map((order) => {
    const previous = previousById.get(order.id);
    if (previous && same(comparable(previous), comparable(order))) return order;
    if (previous?.status === 'unbooked' && order.status === 'unbooked' && (before.preliminary[order.id] || next.preliminary[order.id])) return order;
    const beforePlan = transportPlanOf(previous), afterPlan = transportPlanOf(order);
    const confirmationFields: (keyof TransportOrder)[] = ['customerId', 'customerName', 'address', 'city', 'contact', 'phone', 'action', 'vesselType', 'material', 'vesselSize', 'pickupVessel', 'replacementVessel', 'notes'];
    const changedBookingDetails = previous && Boolean(beforePlan || afterPlan) && confirmationFields.some((field) => !same(previous[field], order[field]));
    const bookingChanged = !same(beforePlan, afterPlan) || changedBookingDetails || (!previous || previous.status !== 'cancelled') && order.status === 'cancelled';
    const updated = { ...order, bookingVersion: (previous?.bookingVersion ?? 0) + (bookingChanged ? 1 : 0) };
    if (updated.confirmation && updated.confirmation.bookingVersion !== updated.bookingVersion && updated.confirmation.status !== 'expired') {
      updated.confirmation = { ...updated.confirmation, status: 'expired', respondedAt: new Date().toISOString() };
      if (previous?.confirmation?.status === 'requested') {
        addEvent(next, 'work_order.confirmation_expired', updated, actor, { beforePlan, afterPlan, confirmationId: updated.confirmation.id, reason: 'Bokningen ändrades. Den tidigare svarsförfrågan gäller inte längre.' });
      }
    }
    const options = { beforePlan, afterPlan, reason };
    if (!previous) {
      addEvent(next, 'work_order.created', updated, actor, options);
      if (afterPlan) addEvent(next, 'work_order.booked', updated, actor, options);
    } else if (order.status === 'cancelled' && previous.status !== 'cancelled') {
      addEvent(next, 'work_order.cancelled', updated, actor, options);
    } else if (afterPlan && !beforePlan) {
      addEvent(next, 'work_order.booked', updated, actor, options);
    } else if (beforePlan && !afterPlan) {
      addEvent(next, 'work_order.booking_cancelled', updated, actor, options);
    } else if (order.status === 'on_way' && previous.status !== 'on_way') {
      addEvent(next, 'work_order.en_route', updated, actor, options);
    } else if (order.status === 'done' && previous.status !== 'done') {
      addEvent(next, 'work_order.completed', updated, actor, options);
    } else if (!same(beforePlan, afterPlan)) {
      addEvent(next, 'work_order.rescheduled', updated, actor, options);
    } else {
      addEvent(next, 'work_order.updated', updated, actor, options);
    }
    return updated;
  });
  // Undo may remove a newly created order. Keep its cancellation trace in the append-only ledger.
  before.orders.filter((order) => !next.orders.some((entry) => entry.id === order.id)).forEach((order) => {
    addEvent(next, 'work_order.cancelled', { ...order, bookingVersion: order.bookingVersion + 1 }, actor, { beforePlan: transportPlanOf(order), reason: reason ?? 'Arbetsorderns skapande ångrades.' });
  });
  return next;
}

function applyChangeCore(data: TransportData, change: TransportChange, actor: TransportActor, emitEvents: boolean): TransportData {
  assertActor(actor);
  // Parse before cloning so malformed local storage cannot bypass rules during a mutation.
  const next = structuredClone(assertValid(data));
  const now = new Date().toISOString();
  if (change.type === 'create') {
    if (!['unbooked', 'booked'].includes(change.draft.status)) throw new Error('Nya arbetsordrar ska vara obokade eller bokade.');
    const interval = change.repeat === 'weekly' ? 7 : change.repeat === 'biweekly' ? 14 : 0;
    const count = interval ? 4 : 1;
    const firstNumber = nextOrderNumber(next);
    const seriesId = interval ? `series-${firstNumber}-${now}` : undefined;
    const anchor = change.draft.date ?? change.draft.requestedDate ?? today();
    for (let index = 0; index < count; index += 1) {
      const draft = { ...change.draft, durationMinutes: change.draft.durationMinutes ?? 60 };
      if (draft.date) draft.date = addDays(draft.date, index * interval);
      if (interval || draft.requestedDate) draft.requestedDate = addDays(draft.requestedDate ?? anchor, index * interval);
      const order: TransportOrder = {
        ...draft, id: `AO-${firstNumber + index}`, seriesId,
        audit: [], updatedAt: now, bookingVersion: 0,
      };
      next.orders.push(record(order, actor, interval ? 'Arbetsorder skapad som del av återkommande serie.' : 'Arbetsorder skapad.'));
    }
  } else {
    const original = writableOrder(next, change.id, change.type === 'status' || change.type === 'cancel');
    if (change.type === 'book' || change.type === 'reschedule') {
      if (change.type === 'book' && original.status !== 'unbooked') throw new Error('Arbetsordern är redan bokad.');
      if (change.type === 'reschedule' && original.status === 'unbooked') throw new Error('Boka arbetsordern innan den flyttas.');
      if (change.type === 'reschedule' && same(transportPlanOf(original), change.plan)) return data;
      const problem = validateTransportPlan(next, original.id, change.plan);
      if (problem) throw new Error(problem);
      const order = { ...original, ...change.plan, status: original.status === 'on_way' ? 'on_way' as const : 'booked' as const };
      const driver = next.drivers.find((entry) => entry.id === order.driverId)!;
      const vehicle = next.vehicles.find((entry) => entry.id === order.vehicleId)!;
      const text = `${change.type === 'book' ? 'Bokad' : 'Bokning ändrad'}: ${order.date} ${timeLabel(order.startMinute!)}–${timeLabel(order.startMinute! + order.durationMinutes)}, ${driver.name}, ${vehicle.registration}.`;
      next.orders = next.orders.map((entry) => entry.id === order.id ? record(order, actor, text) : entry);
      delete next.preliminary[order.id];
    } else if (change.type === 'unbook') {
      if (original.status === 'unbooked') throw new Error('Arbetsordern är redan obokad.');
      next.orders = next.orders.map((entry) => entry.id === original.id ? record(clearBooking(entry), actor, `Bokning avbokad: ${entry.date} ${timeLabel(entry.startMinute!)}. Arbetsordern finns kvar som obokad.`) : entry);
    } else if (change.type === 'cancel') {
      const reason = change.reason.trim();
      if (!reason || reason.length > 2000) throw new Error('Ange en orsak till att arbetsordern avbryts.');
      next.orders = next.orders.map((entry) => entry.id === original.id ? record({ ...entry, status: 'cancelled' }, actor, `Arbetsorder avbruten: ${reason}`) : entry);
      delete next.preliminary[original.id];
    } else if (change.type === 'status') {
      if (original.status === 'unbooked') throw new Error('Boka uppdraget innan det kan påbörjas eller slutföras.');
      if (original.status === change.status) throw new Error('Uppdraget har redan denna status.');
      next.orders = next.orders.map((entry) => entry.id === original.id ? record({ ...entry, status: change.status }, actor, change.status === 'done' ? 'Uppdraget slutfört.' : 'Föraren är på väg.') : entry);
    } else if (change.type === 'edit') {
      const series = change.scope === 'series' && original.seriesId;
      const anchor = original.date ?? original.requestedDate ?? today();
      const dateDelta = change.patch.date && original.date ? dayOffset(original.date, change.patch.date) : undefined;
      const requestedDelta = change.patch.requestedDate && original.requestedDate ? dayOffset(original.requestedDate, change.patch.requestedDate) : undefined;
      const changedIds = new Set<string>();
      next.orders = next.orders.map((entry) => {
        const entryDay = entry.date ?? entry.requestedDate ?? anchor;
        const targeted = entry.id === original.id || (series && entry.seriesId === series && !['done', 'on_way', 'cancelled'].includes(entry.status) && entryDay >= anchor);
        if (!targeted) return entry;
        const patch = { ...change.patch };
        if (series && entry.id !== original.id) {
          if (dateDelta !== undefined && entry.date) patch.date = addDays(entry.date, dateDelta);
          if (requestedDelta !== undefined && entry.requestedDate) patch.requestedDate = addDays(entry.requestedDate, requestedDelta);
        }
        // Runtime callers are restricted to draft fields; identity and history remain immutable.
        const editableKeys = Object.keys(orderSchema.shape).filter((key) => !immutableOrderFields.includes(key));
        const safePatch = Object.fromEntries(Object.entries(patch).filter(([key]) => editableKeys.includes(key))) as Partial<TransportDraft>;
        if (safePatch.status !== undefined && safePatch.status !== entry.status) throw new Error('Använd boka, avboka eller ändra status för att ändra uppdragets läge.');
        let edited = { ...entry, ...safePatch };
        if (edited.status === 'unbooked') edited = clearBooking(edited);
        const fields = Object.keys(safePatch).filter((key) => JSON.stringify(entry[key as keyof TransportDraft]) !== JSON.stringify(edited[key as keyof TransportDraft]));
        if (!fields.length) return entry;
        changedIds.add(entry.id);
        const duration = entry.durationMinutes !== edited.durationMinutes ? ` Tidsåtgång ${durationLabel(entry.durationMinutes)} → ${durationLabel(edited.durationMinutes)}.` : '';
        const labels = [...new Set(fields.map((field) => fieldLabels[field as keyof TransportDraft] ?? field))];
        return record(edited, actor, `${series ? 'Återkommande arbetsorder' : 'Arbetsorder'} ändrad (${labels.join(', ')}).${duration}`);
      });
      if (!changedIds.size) return data;
    }
  }
  next.revision += 1;
  // Validate the final state, including all series occurrences, before returning any change.
  return assertValid(emitEvents ? prepareEvents(data, next, actor, change.type === 'cancel' ? change.reason.trim() : undefined) : next);
}

export function applyTransportChange(data: TransportData, change: TransportChange, actor: TransportActor): TransportData {
  return applyChangeCore(data, change, actor, true);
}

/** Save a complete editor draft as one atomic user action, preserving untouched series bookings. */
export function saveTransportOrder(
  data: TransportData, id: string, draft: TransportDraft, actor: TransportActor, scope: 'one' | 'series' = 'one',
): TransportData {
  assertActor(actor);
  const original = writableOrder(assertValid(data), id);
  if (!['unbooked', 'booked'].includes(draft.status)) throw new Error('Ändra uppdragets status med på väg eller slutför.');
  const schedulingFields = new Set<keyof TransportDraft>(['date', 'startMinute', 'driverId', 'vehicleId']);
  const allowedFields = Object.keys(orderSchema.shape).filter((key) => !immutableOrderFields.includes(key));
  const transition = draft.status !== original.status;
  const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
    allowedFields.includes(key) && key !== 'status' &&
    !(transition && schedulingFields.has(key as keyof TransportDraft)) &&
    JSON.stringify(original[key as keyof TransportDraft]) !== JSON.stringify(value),
  )) as Partial<TransportDraft>;
  let next = data;
  // Clearing the selected booking first allows metadata (e.g. a new kärl type) to change safely.
  if (transition && draft.status === 'unbooked') {
    next = applyChangeCore(next, { type: 'unbook', id }, actor, false);
  }
  if (Object.keys(patch).length) {
    next = applyChangeCore(next, { type: 'edit', id, patch, scope }, actor, false);
  }
  if (transition && draft.status === 'booked') {
    if (!draft.date || draft.startMinute === undefined || !draft.driverId || !draft.vehicleId) {
      throw new Error('Välj datum, starttid, förare och fordon för bokningen.');
    }
    next = applyChangeCore(next, { type: 'book', id, plan: {
      date: draft.date, startMinute: draft.startMinute, durationMinutes: draft.durationMinutes,
      driverId: draft.driverId, vehicleId: draft.vehicleId,
    } }, actor, false);
  }
  if (next === data) return data;
  // One Save press is one revision, including a metadata change followed by a booking transition.
  return assertValid(prepareEvents(data, { ...next, revision: data.revision + 1 }, actor));
}

/** Reserve a slot locally without committing a booking or emitting customer integration events. */
export function stageTransportPlan(data: TransportData, id: string, plan: TransportPlan, actor: TransportActor): TransportData {
  assertActor(actor);
  const parsed = assertValid(data), original = writableOrder(parsed, id);
  if (original.status !== 'unbooked') throw new Error('Endast obokade arbeten kan bokas preliminärt.');
  if (same(parsed.preliminary[id], plan)) return data;
  const problem = validateTransportPlan(parsed, id, plan);
  if (problem) throw new Error(problem);
  const next = structuredClone(parsed);
  next.preliminary[id] = { ...plan };
  next.orders = next.orders.map((entry) => entry.id === id
    ? record(entry, actor, `Preliminär bokning: ${plan.date} ${timeLabel(plan.startMinute)}–${timeLabel(plan.startMinute + plan.durationMinutes)}. Bokningen är inte verkställd.`)
    : entry);
  next.revision += 1;
  return assertValid(next);
}

export function removePreliminary(data: TransportData, id: string, actor: TransportActor): TransportData {
  assertActor(actor);
  const parsed = assertValid(data);
  if (!parsed.preliminary[id]) return data;
  writableOrder(parsed, id);
  const next = structuredClone(parsed);
  delete next.preliminary[id];
  next.orders = next.orders.map((entry) => entry.id === id ? record(entry, actor, 'Preliminär bokning borttagen. Arbetsordern är åter obokad.') : entry);
  next.revision += 1;
  return assertValid(next);
}

export function commitPreliminaryBookings(data: TransportData, actor: TransportActor): TransportData {
  assertActor(actor);
  const parsed = assertValid(data);
  const ids = Object.keys(parsed.preliminary);
  if (!ids.length) return data;
  // Validate the complete set together before changing any order or writing any event.
  for (const id of ids) {
    const original = writableOrder(parsed, id);
    if (original.status !== 'unbooked') throw new Error('En preliminär bokning gäller inte längre.');
    const problem = validateTransportPlan(parsed, id, parsed.preliminary[id]);
    if (problem) throw new Error(problem);
  }
  const next = structuredClone(parsed);
  next.orders = next.orders.map((entry) => {
    const plan = next.preliminary[entry.id];
    if (!plan) return entry;
    const driver = next.drivers.find((candidate) => candidate.id === plan.driverId)!;
    const vehicle = next.vehicles.find((candidate) => candidate.id === plan.vehicleId)!;
    return record({ ...entry, ...plan, status: 'booked' }, actor,
      `Bokning verkställd: ${plan.date} ${timeLabel(plan.startMinute)}–${timeLabel(plan.startMinute + plan.durationMinutes)}, ${driver.name}, ${vehicle.registration}.`);
  });
  next.preliminary = {};
  next.revision += 1;
  return assertValid(prepareEvents(parsed, next, actor));
}

/** The editor may change a staged order and its reservation as one reversible action. */
export function savePreliminaryOrder(data: TransportData, id: string, draft: TransportDraft, actor: TransportActor, scope: 'one' | 'series' = 'one'): TransportData {
  assertActor(actor);
  const parsed = assertValid(data), original = writableOrder(parsed, id);
  if (!parsed.preliminary[id] || original.status !== 'unbooked') throw new Error('Den preliminära bokningen finns inte längre.');
  if (!['booked', 'unbooked'].includes(draft.status)) throw new Error('En preliminär bokning kan inte påbörjas eller slutföras.');
  if (draft.status === 'booked' && (!draft.date || draft.startMinute === undefined || !draft.driverId || !draft.vehicleId)) {
    throw new Error('Välj datum, starttid, förare och fordon för den preliminära bokningen.');
  }
  const next = structuredClone(parsed);
  delete next.preliminary[id];
  const schedulingFields = ['status', 'date', 'startMinute', 'driverId', 'vehicleId'];
  const allowed = Object.keys(orderSchema.shape).filter((key) => !immutableOrderFields.includes(key) && !schedulingFields.includes(key));
  const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => allowed.includes(key) && !same(original[key as keyof TransportDraft], value))) as Partial<TransportDraft>;
  let edited = Object.keys(patch).length ? applyChangeCore(next, { type: 'edit', id, patch, scope }, actor, false) : next;
  if (draft.status === 'booked') {
    const plan: TransportPlan = { date: draft.date!, startMinute: draft.startMinute!, durationMinutes: draft.durationMinutes, driverId: draft.driverId!, vehicleId: draft.vehicleId! };
    edited = stageTransportPlan(edited, id, plan, actor);
  } else {
    edited.orders = edited.orders.map((entry) => entry.id === id ? record(entry, actor, 'Preliminär bokning borttagen. Arbetsordern är åter obokad.') : entry);
  }
  if (same(parsed.preliminary[id], edited.preliminary[id]) && !Object.keys(patch).length) return data;
  return assertValid(prepareEvents(parsed, { ...edited, revision: data.revision + 1 }, actor));
}

/** Only prepares a request record; secure response links and delivery belong on the future server. */
export function requestTransportConfirmation(data: TransportData, id: string, expiresAt: string, actor: TransportActor): TransportData {
  assertActor(actor);
  const parsed = assertValid(data), original = writableOrder(parsed, id);
  if (original.status !== 'booked') throw new Error('Verkställ bokningen innan kunden tillfrågas.');
  if (!z.string().datetime().safeParse(expiresAt).success || Date.parse(expiresAt) <= Date.now()) throw new Error('Svarstiden måste ligga i framtiden.');
  if (original.confirmation?.status === 'requested' && original.confirmation.bookingVersion === original.bookingVersion && Date.parse(original.confirmation.expiresAt) > Date.now()) return data;
  const next = structuredClone(parsed);
  let history = original;
  if (original.confirmation?.status === 'requested' && Date.parse(original.confirmation.expiresAt) <= Date.now()) {
    history = record(original, actor, 'Den tidigare bokningsförfrågans svarstid har gått ut.');
    addEvent(next, 'work_order.confirmation_expired', original, actor, { afterPlan: transportPlanOf(original), confirmationId: original.confirmation.id, reason: 'Svarstiden har gått ut.' });
  }
  const confirmation = { id: `confirmation-${crypto.randomUUID()}`, bookingVersion: original.bookingVersion, status: 'requested' as const, requestedAt: new Date().toISOString(), expiresAt };
  const order = record({ ...history, confirmation }, actor, 'Bokningsförfrågan förberedd för kundens godkännande. Inget meddelande skickat i demon.');
  next.orders = next.orders.map((entry) => entry.id === id ? order : entry);
  addEvent(next, 'work_order.confirmation_requested', order, actor, { afterPlan: transportPlanOf(order), confirmationId: confirmation.id });
  next.revision += 1;
  return assertValid(next);
}

/** Demo/admin response helper. A future public endpoint must validate a signed, expiring token. */
export function respondTransportConfirmation(data: TransportData, id: string, confirmationId: string, bookingVersion: number, accepted: boolean, actor: TransportActor): TransportData {
  assertActor(actor);
  const parsed = assertValid(data), original = writableOrder(parsed, id);
  const confirmation = original.confirmation;
  if (!confirmation || confirmation.id !== confirmationId || bookingVersion !== original.bookingVersion || confirmation.bookingVersion !== bookingVersion || confirmation.status !== 'requested') {
    throw new Error('Den här bokningsförfrågan gäller inte längre.');
  }
  if (Date.parse(confirmation.expiresAt) <= Date.now()) throw new Error('Svarstiden har gått ut.');
  const next = structuredClone(parsed);
  const order = record({ ...original, confirmation: { ...confirmation, status: accepted ? 'accepted' : 'declined', respondedAt: new Date().toISOString() } }, actor, accepted ? 'Kundens godkännande registrerat.' : 'Kunden har nekat den föreslagna tiden.');
  next.orders = next.orders.map((entry) => entry.id === id ? order : entry);
  addEvent(next, accepted ? 'work_order.confirmation_accepted' : 'work_order.confirmation_declined', order, actor, { afterPlan: transportPlanOf(order), confirmationId });
  next.revision += 1;
  return assertValid(next);
}

export function expireTransportConfirmations(data: TransportData, actor: TransportActor, now = new Date().toISOString()): TransportData {
  assertActor(actor);
  if (!z.string().datetime().safeParse(now).success) throw new Error('Ogiltig tidpunkt.');
  const next = structuredClone(assertValid(data));
  let changed = false;
  next.orders = next.orders.map((entry) => {
    const confirmation = entry.confirmation;
    if (!confirmation || confirmation.status !== 'requested' || Date.parse(confirmation.expiresAt) > Date.parse(now)) return entry;
    changed = true;
    const order = record({ ...entry, confirmation: { ...confirmation, status: 'expired', respondedAt: now } }, actor, 'Svarstiden för bokningsförfrågan har gått ut.');
    addEvent(next, 'work_order.confirmation_expired', order, actor, { afterPlan: transportPlanOf(order), confirmationId: confirmation.id, reason: 'Svarstiden har gått ut.' });
    return order;
  });
  if (!changed) return data;
  next.revision += 1;
  return assertValid(next);
}

export function undoTransportChange(data: TransportData, previous: TransportData, actor: TransportActor): TransportData {
  assertActor(actor);
  assertValid(data); assertValid(previous);
  if (previous.revision !== data.revision - 1) throw new Error('Det finns en nyare ändring. Den här ändringen kan inte ångras.');
  const currentById = new Map(data.orders.map((entry) => [entry.id, entry]));
  const comparable = (order: TransportOrder) => JSON.stringify({ ...order, audit: undefined, updatedAt: undefined });
  const restored: TransportData = {
    ...structuredClone(previous), revision: data.revision + 1, events: structuredClone(data.events),
    orders: previous.orders.map((entry) => {
      const current = currentById.get(entry.id);
      if (!current || comparable(entry) === comparable(current) && same(previous.preliminary[entry.id], data.preliminary[entry.id])) return structuredClone(entry);
      return record({ ...structuredClone(entry), audit: [...current.audit] }, actor, 'Senaste planeringsändringen ångrad. Tidigare uppgifter återställda.');
    }),
  };
  return assertValid(prepareEvents(data, restored, actor, 'Senaste planeringsändringen ångrades.'));
}

export function seedTransport(day = today()): TransportData {
  if (!validDay(day)) throw new Error('Ogiltigt datum.');
  const vehicles: TransportVehicle[] = [
    { id: 'vehicle-oskar', registration: 'JKL 234', name: 'Lastväxlare', types: ['container', 'battery', 'bin', 'cage'] },
    { id: 'vehicle-kalle', registration: 'ABC 123', name: 'Lastväxlare', types: ['container', 'battery', 'bin', 'cage'] },
    { id: 'vehicle-maria', registration: 'DEF 456', name: 'Kranbil', types: ['battery', 'bin', 'cage', 'container'] },
    { id: 'vehicle-service', registration: 'XYZ 567', name: 'Servicebil', types: ['battery', 'bin', 'cage'] },
  ];
  const timestamp = new Date().toISOString();
  const system: TransportActor = { canPlan: true, actor: 'JEROC demo', actualUserId: 'demo', effectiveUserId: 'demo' };
  const base: Omit<TransportOrder, 'id' | 'customerName' | 'address' | 'vesselType'> = {
    city: 'Norrtälje', contact: 'Kontakt på plats', phone: '070-123 45 67', action: 'pickup',
    material: 'Skrot', vesselSize: '', pickupVessel: '', replacementVessel: '',
    notes: '', lat: 59.7578, lng: 18.7105, durationMinutes: 60,
    status: 'unbooked', requestedDate: day, audit: [], updatedAt: timestamp, bookingVersion: 0,
  };
  const make = (details: Pick<TransportOrder, 'id' | 'customerName' | 'address' | 'vesselType'> & Partial<TransportOrder>): TransportOrder =>
    record({ ...base, ...details }, system, 'Exempelarbetsorder skapad.');
  const booking = (driver: string, start: number): Partial<TransportOrder> => ({
    status: 'booked', date: day, startMinute: start, driverId: driver, vehicleId: `vehicle-${driver}`,
  });
  return assertValid({
    version: 1, revision: 0, vehicles, preliminary: {}, events: [],
    drivers: [
      { id: 'oskar', name: 'Oskar', color: '#ec4354', vehicleId: 'vehicle-oskar' },
      { id: 'kalle', name: 'Kalle', color: '#8656db', vehicleId: 'vehicle-kalle' },
      { id: 'maria', name: 'Maria', color: '#009c92', vehicleId: 'vehicle-maria' },
    ],
    orders: [
      make({ id: 'AO-1100', customerName: 'Rimbo Bygg', address: 'Estunavägen 6', city: 'Norrtälje', vesselType: 'cage', pickupVessel: 'BU-012', lat: 59.7531, lng: 18.6980, ...booking('oskar', 540) }),
      make({ id: 'AO-1101', customerName: 'Roslagens Metallservice', address: 'Verkstadsvägen 4', vesselType: 'container', action: 'exchange', pickupVessel: 'C-031', replacementVessel: 'C-042', vesselSize: '20 m³', lat: 59.7578, lng: 18.7105, ...booking('oskar', 600) }),
      make({ id: 'AO-1102', customerName: 'BRF Solbacken', customerId: 'customer-brf', address: 'Solbacksvägen 12', vesselType: 'bin', pickupVessel: 'K-018', lat: 59.7666, lng: 18.7230, ...booking('oskar', 840) }),
      make({ id: 'AO-1042', customerName: 'Roslagens Däck & Service', address: 'Industrivägen 8', vesselType: 'container', action: 'exchange', material: 'Däck', vesselSize: '20 m³', pickupVessel: 'C-014', replacementVessel: 'C-027', notes: 'Extra byte. Nästa ordinarie byte kvarstår enligt avtal. Ring vid ankomst; grindkod 2468.', lat: 59.7595, lng: 18.6993, ...booking('kalle', 600) }),
      make({ id: 'AO-1041', customerName: 'Bygg & Riv AB', customerId: 'customer-build', address: 'Storgatan 12', vesselType: 'battery', material: 'Batterier', pickupVessel: 'B-008', lat: 59.7552, lng: 18.7025, ...booking('kalle', 780) }),
      make({ id: 'AO-1050', customerName: 'Norrtälje kommun', address: 'Estunavägen 14', vesselType: 'container', action: 'placement', replacementVessel: 'C-006', vesselSize: '10 m³', lat: 59.7643, lng: 18.6898, ...booking('maria', 480) }),
      make({ id: 'AO-1051', customerName: 'Bygg & Riv AB', customerId: 'customer-build', address: 'Baldersgatan 8', vesselType: 'bin', material: 'Järnskrot', lat: 59.7670, lng: 18.7150, ...booking('maria', 780), durationMinutes: 90 }),
      make({ id: 'AO-1043', customerName: 'Anderssons Verkstad', customerId: 'customer-andersson', address: 'Verkstadsvägen 12', vesselType: 'battery', material: 'Batterier', pickupVessel: 'B-016', vesselSize: '600 liter', lat: 59.7586, lng: 18.7142, notes: 'Batterilådan står bakom verkstaden. Kan hämtas efter kl. 10.' }),
      make({ id: 'AO-1044', customerName: 'Nilssons El', address: 'Görlavägen 6', vesselType: 'container', material: 'Blandat skrot', vesselSize: '10 m³', lat: 59.7502, lng: 18.7225 }),
      make({ id: 'AO-1045', customerName: 'BRF Solbacken', customerId: 'customer-brf', address: 'Solbacksvägen 18', vesselType: 'bin', material: 'Metall', lat: 59.7671, lng: 18.7241 }),
    ],
  });
}

export function distanceKm(first: Pick<TransportOrder, 'lat' | 'lng'>, second: Pick<TransportOrder, 'lat' | 'lng'>): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latDelta = radians(second.lat - first.lat), lngDelta = radians(second.lng - first.lng);
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
