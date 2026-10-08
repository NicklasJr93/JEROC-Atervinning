import { expect, test } from '@playwright/test';
import {
  addDays, applyTransportChange, distanceKm, durationLabel, monday, saveTransportOrder, seedTransport,
  timeLabel, transportSchema, undoTransportChange, validateTransportPlan,
} from '../src/office/transport/model';
import type { TransportActor, TransportData, TransportDraft, TransportPlan } from '../src/office/transport/types';
import { can, seedOffice } from '../src/office/model';
import { migrateOffice } from '../src/office/customer-model';

const day = '2026-10-08';
const actor: TransportActor = {
  canPlan: true, actor: 'Kajsa · jobbar som Oskar', actualUserId: 'systemadmin', effectiveUserId: 'oskar',
};
const fixture = () => seedTransport(day);
const order = (data: TransportData, id: string) => data.orders.find((entry) => entry.id === id)!;
const plan = (extra: Partial<TransportPlan> = {}): TransportPlan => ({
  date: day, startMinute: 660, durationMinutes: 60, driverId: 'oskar', vehicleId: 'vehicle-oskar', ...extra,
});
function draft(data = fixture()): TransportDraft {
  const { id: _id, audit: _audit, updatedAt: _updated, seriesId: _series, ...entry } = order(data, 'AO-1043');
  return { ...entry, customerName: 'Ny kund', address: 'Testgatan 12' };
}

test('bokning flyttar obokat arbete till kalendern och sparar effektiv och faktisk användare', () => {
  const data = fixture(), before = structuredClone(data);
  const next = applyTransportChange(data, { type: 'book', id: 'AO-1043', plan: plan() }, actor);
  expect(data).toEqual(before);
  expect(next.revision).toBe(data.revision + 1);
  expect(order(next, 'AO-1043')).toMatchObject({ status: 'booked', date: day, startMinute: 660, driverId: 'oskar', vehicleId: 'vehicle-oskar', durationMinutes: 60 });
  expect(order(next, 'AO-1043').audit.at(-1)).toMatchObject({ actor: actor.actor, actualUserId: 'systemadmin', effectiveUserId: 'oskar' });
  expect(order(next, 'AO-1043').audit.at(-1)?.text).toContain('11:00–12:00');
});

test('angränsande stopp tillåts men både förar- och fordonskrockar avvisas utan sidoeffekter', () => {
  const data = fixture(), before = structuredClone(data);
  expect(validateTransportPlan(data, 'AO-1043', plan())).toBeNull();
  expect(validateTransportPlan(data, 'AO-1043', plan({ startMinute: 645 }))).toContain('Oskar');
  expect(validateTransportPlan(data, 'AO-1043', plan({ driverId: 'maria', startMinute: 600 }))).toContain('JKL 234');
  expect(() => applyTransportChange(data, { type: 'book', id: 'AO-1043', plan: plan({ startMinute: 645 }) }, actor)).toThrow(/redan bokad/);
  expect(data).toEqual(before);
});

test('flytt och tidsändring delar planvalidering och en flytt bevarar manuellt vald längd', () => {
  const data = fixture();
  const longer = applyTransportChange(data, { type: 'edit', id: 'AO-1101', patch: { durationMinutes: 90 } }, actor);
  expect(order(longer, 'AO-1101')).toMatchObject({ startMinute: 600, durationMinutes: 90 });
  expect(order(longer, 'AO-1101').audit.at(-1)?.text).toContain('1 tim → 1 tim 30 min');
  const moved = applyTransportChange(longer, { type: 'reschedule', id: 'AO-1101', plan: plan({ startMinute: 960, durationMinutes: 90 }) }, actor);
  expect(order(moved, 'AO-1101')).toMatchObject({ startMinute: 960, durationMinutes: 90 });
  expect(() => applyTransportChange(data, { type: 'edit', id: 'AO-1100', patch: { durationMinutes: 75 } }, actor)).toThrow(/redan bokad/);
});

test('avbokning behåller arbetsorder, kärl, instruktioner och tidsåtgång men frigör alla bokningsfält', () => {
  const data = fixture(), previous = order(data, 'AO-1042');
  const next = applyTransportChange(data, { type: 'unbook', id: previous.id }, actor);
  const result = order(next, previous.id);
  expect(result).toMatchObject({ status: 'unbooked', pickupVessel: 'C-014', replacementVessel: 'C-027', durationMinutes: 60, notes: previous.notes });
  expect(result.date).toBeUndefined(); expect(result.startMinute).toBeUndefined();
  expect(result.driverId).toBeUndefined(); expect(result.vehicleId).toBeUndefined();
  expect(validateTransportPlan(next, 'AO-1043', plan({ driverId: 'kalle', vehicleId: 'vehicle-kalle', startMinute: 600 }))).toBeNull();
});

test('datum, kvartsteg, dygnsgräns, förare och fordon kontrolleras centralt', () => {
  const data = fixture();
  for (const invalid of [
    { date: '2026-02-30' }, { date: '2026-13-01' }, { startMinute: 661 },
    { durationMinutes: 0 }, { durationMinutes: 61 }, { durationMinutes: 495 },
    { startMinute: 1410, durationMinutes: 60 }, { driverId: 'saknas' }, { vehicleId: 'saknas' },
  ]) expect(validateTransportPlan(data, 'AO-1043', plan(invalid))).toBeTruthy();
  expect(validateTransportPlan(data, 'AO-1043', plan({ startMinute: 1380 }))).toBeNull();
});

test('ett fordon måste kunna hantera kärltypen även om föraren är ledig', () => {
  const data = fixture();
  data.vehicles.push({ id: 'small-van', registration: 'XYZ 999', name: 'Liten skåpbil', types: ['bin'] });
  expect(validateTransportPlan(data, 'AO-1043', plan({ vehicleId: 'small-van' }))).toContain('kärltyp');
  expect(() => applyTransportChange(data, { type: 'book', id: 'AO-1043', plan: plan({ vehicleId: 'small-van' }) }, actor)).toThrow(/kärltyp/);
});

test('planeringsbehörigheten gäller även redigering, statusändring och ångra', () => {
  const data = fixture(), denied = { ...actor, canPlan: false };
  for (const change of [
    { type: 'create' as const, draft: draft() },
    { type: 'edit' as const, id: 'AO-1043', patch: { notes: 'Test' } },
    { type: 'unbook' as const, id: 'AO-1042' },
    { type: 'status' as const, id: 'AO-1042', status: 'on_way' as const },
  ]) expect(() => applyTransportChange(data, change, denied)).toThrow(/behörighet/);
  const booked = applyTransportChange(data, { type: 'book', id: 'AO-1043', plan: plan() }, actor);
  expect(() => undoTransportChange(booked, data, denied)).toThrow(/behörighet/);
});

test('påbörjade uppdrag är låsta för bokningsändringar men kan slutföras', () => {
  const active = applyTransportChange(fixture(), { type: 'status', id: 'AO-1042', status: 'on_way' }, actor);
  expect(() => applyTransportChange(active, { type: 'unbook', id: 'AO-1042' }, actor)).toThrow(/påbörjat/);
  expect(() => applyTransportChange(active, { type: 'edit', id: 'AO-1042', patch: { durationMinutes: 90 } }, actor)).toThrow(/påbörjat/);
  const done = applyTransportChange(active, { type: 'status', id: 'AO-1042', status: 'done' }, actor);
  expect(order(done, 'AO-1042').status).toBe('done');
  expect(() => applyTransportChange(done, { type: 'unbook', id: 'AO-1042' }, actor)).toThrow(/slutfört/);
  expect(() => applyTransportChange(fixture(), { type: 'status', id: 'AO-1043', status: 'done' }, actor)).toThrow(/Boka/);
  expect(() => applyTransportChange(fixture(), { type: 'edit', id: 'AO-1042', patch: { status: 'done' } }, actor)).toThrow(/ändra status/);
});

test('ny arbetsorder kräver kund och adress, får unik identitet och en timme som standard', () => {
  const data = fixture();
  const created = applyTransportChange(data, { type: 'create', draft: { ...draft(), durationMinutes: undefined! } }, actor);
  const added = created.orders.find((entry) => !data.orders.some((old) => old.id === entry.id))!;
  expect(added.durationMinutes).toBe(60);
  expect(created.orders.map((entry) => entry.id)).toHaveLength(new Set(created.orders.map((entry) => entry.id)).size);
  expect(() => applyTransportChange(data, { type: 'create', draft: { ...draft(), customerName: '  ' } }, actor)).toThrow();
  expect(() => applyTransportChange(data, { type: 'create', draft: { ...draft(), address: '  ' } }, actor)).toThrow();
});

test('persistens accepterar giltig historik och avvisar ofullständig bokning, dubbletter och tidskrockar', () => {
  const data = fixture();
  expect(transportSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data);
  const missing = structuredClone(data); delete order(missing, 'AO-1042').vehicleId;
  expect(transportSchema.safeParse(missing).success).toBe(false);
  const duplicates = structuredClone(data); duplicates.orders.push(duplicates.orders[0]);
  expect(transportSchema.safeParse(duplicates).success).toBe(false);
  const clash = structuredClone(data); order(clash, 'AO-1101').startMinute = 555;
  expect(transportSchema.safeParse(clash).success).toBe(false);
  const inconsistent = structuredClone(data); order(inconsistent, 'AO-1043').date = day;
  expect(transportSchema.safeParse(inconsistent).success).toBe(false);
});

test('återkommande arbete skapar fyra självständiga förekomster med samma serieidentitet', () => {
  const data = fixture();
  const weekly = applyTransportChange(data, { type: 'create', repeat: 'weekly', draft: draft() }, actor);
  const created = weekly.orders.filter((entry) => entry.seriesId);
  expect(created).toHaveLength(4);
  expect(new Set(created.map((entry) => entry.seriesId)).size).toBe(1);
  expect(created.map((entry) => entry.requestedDate)).toEqual([day, addDays(day, 7), addDays(day, 14), addDays(day, 21)]);
  expect(created.every((entry) => entry.status === 'unbooked' && entry.durationMinutes === 60)).toBe(true);
});

test('hela serieändringen avvisas atomärt om någon framtida förekomst krockar', () => {
  let data = fixture();
  data = applyTransportChange(data, {
    type: 'create', repeat: 'weekly',
    draft: { ...draft(), ...plan({ startMinute: 960 }), status: 'booked' },
  }, actor);
  const series = data.orders.filter((entry) => entry.seriesId);
  data = applyTransportChange(data, { type: 'book', id: 'AO-1044', plan: plan({ date: addDays(day, 14), startMinute: 1080 }) }, actor);
  const before = structuredClone(data);
  expect(() => applyTransportChange(data, { type: 'edit', id: series[0].id, scope: 'series', patch: { startMinute: 1080 } }, actor)).toThrow(/redan bokad/);
  expect(data).toEqual(before);
  expect(series.map((entry) => entry.startMinute)).toEqual([960, 960, 960, 960]);
});

test('serieredigering flyttar framtida datum relativt men lämnar slutförda förekomster orörda', () => {
  let data = applyTransportChange(fixture(), {
    type: 'create', repeat: 'biweekly', draft: { ...draft(), ...plan({ startMinute: 960 }), status: 'booked' },
  }, actor);
  const series = data.orders.filter((entry) => entry.seriesId);
  data = applyTransportChange(data, { type: 'status', id: series[0].id, status: 'done' }, actor);
  const completed = structuredClone(order(data, series[0].id));
  const next = applyTransportChange(data, { type: 'edit', id: series[1].id, scope: 'series', patch: { date: addDays(series[1].date!, 1), durationMinutes: 90 } }, actor);
  expect(order(next, series[0].id)).toEqual(completed);
  expect(next.orders.filter((entry) => entry.seriesId && entry.status !== 'done').map((entry) => entry.date)).toEqual([addDays(day, 15), addDays(day, 29), addDays(day, 43)]);
  expect(next.orders.filter((entry) => entry.seriesId && entry.status !== 'done').every((entry) => entry.durationMinutes === 90)).toBe(true);
});

test('att skapa en återkommande bokad serie är atomärt när en senare förekomst krockar', () => {
  let data = fixture();
  data = applyTransportChange(data, { type: 'book', id: 'AO-1044', plan: plan({ date: addDays(day, 7), startMinute: 960 }) }, actor);
  const before = structuredClone(data);
  expect(() => applyTransportChange(data, { type: 'create', repeat: 'weekly', draft: { ...draft(), ...plan({ startMinute: 960 }), status: 'booked' } }, actor)).toThrow(/redan bokad/);
  expect(data).toEqual(before);
});

test('ångra återställer bokningen men behåller ändringshistorik och accepterar inte en gammal ögonblicksbild', () => {
  const data = fixture();
  const booked = applyTransportChange(data, { type: 'book', id: 'AO-1043', plan: plan() }, actor);
  const restored = undoTransportChange(booked, data, actor);
  expect(order(restored, 'AO-1043').status).toBe('unbooked');
  expect(order(restored, 'AO-1043').date).toBeUndefined();
  expect(order(restored, 'AO-1043').audit.map((entry) => entry.text)).toEqual([
    ...order(booked, 'AO-1043').audit.map((entry) => entry.text),
    'Senaste planeringsändringen ångrad. Tidigare uppgifter återställda.',
  ]);
  expect(restored.revision).toBe(booked.revision + 1);
  expect(() => undoTransportChange(restored, data, actor)).toThrow(/nyare ändring/);
});

test('kalenderdatum beräknas utan sommartidsfel och kartavståndet markerar närliggande arbeten', () => {
  expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
  expect(monday('2026-10-11')).toBe('2026-10-05');
  expect(monday('2026-10-05')).toBe('2026-10-05');
  expect(timeLabel(1440)).toBe('24:00');
  expect(durationLabel(90)).toBe('1 tim 30 min');
  const data = fixture();
  expect(distanceKm(order(data, 'AO-1101'), order(data, 'AO-1043'))).toBeLessThan(0.3);
});

function editorDraft(data: TransportData, id: string): TransportDraft {
  const { id: _id, audit: _audit, updatedAt: _updated, seriesId: _series, ...entry } = order(data, id);
  return entry;
}

test('editorns spara bokar och kompletterar atomärt med en revision och kan ångras', () => {
  const data = fixture(), before = structuredClone(data);
  const saved = saveTransportOrder(data, 'AO-1043', {
    ...editorDraft(data, 'AO-1043'), ...plan(), status: 'booked', contact: 'Elin Andersson', durationMinutes: 90,
  }, actor);
  expect(saved.revision).toBe(data.revision + 1);
  expect(order(saved, 'AO-1043')).toMatchObject({ status: 'booked', contact: 'Elin Andersson', durationMinutes: 90, startMinute: 660 });
  expect(order(saved, 'AO-1043').audit.at(-2)?.text).toContain('kontaktperson');
  expect(order(saved, 'AO-1043').audit.at(-1)?.text).toContain('11:00–12:30');
  const undone = undoTransportChange(saved, data, actor);
  expect(order(undone, 'AO-1043')).toMatchObject({ status: 'unbooked', contact: 'Kontakt på plats', durationMinutes: 60 });
  expect(order(undone, 'AO-1043').audit).toHaveLength(order(saved, 'AO-1043').audit.length + 1);
  expect(data).toEqual(before);
});

test('editorns sparning uppdaterar tidsåtgång och fordon tillsammans och avvisar konflikt atomärt', () => {
  const data = fixture(), before = structuredClone(data);
  const saved = saveTransportOrder(data, 'AO-1042', {
    ...editorDraft(data, 'AO-1042'), durationMinutes: 90, vehicleId: 'vehicle-oskar', startMinute: 690,
  }, actor);
  expect(order(saved, 'AO-1042')).toMatchObject({ durationMinutes: 90, vehicleId: 'vehicle-oskar', startMinute: 690 });
  expect(saved.revision).toBe(data.revision + 1);
  expect(() => saveTransportOrder(data, 'AO-1043', {
    ...editorDraft(data, 'AO-1043'), ...plan({ startMinute: 600 }), status: 'booked', contact: 'Nytt namn',
  }, actor)).toThrow(/redan bokad/);
  expect(data).toEqual(before);
});

test('hela editordraften ändrar seriens metadata utan att flytta eller boka andra förekomster', () => {
  let data = applyTransportChange(fixture(), { type: 'create', repeat: 'weekly', draft: draft() }, actor);
  const series = data.orders.filter((entry) => entry.seriesId);
  data = applyTransportChange(data, { type: 'book', id: series[0].id, plan: plan() }, actor);
  data = applyTransportChange(data, { type: 'book', id: series[1].id, plan: plan({ date: addDays(day, 7), startMinute: 900, driverId: 'maria', vehicleId: 'vehicle-maria' }) }, actor);
  const saved = saveTransportOrder(data, series[0].id, { ...editorDraft(data, series[0].id), contact: 'Ny kontakt' }, actor, 'series');
  expect(order(saved, series[1].id)).toMatchObject({ status: 'booked', date: addDays(day, 7), startMinute: 900, driverId: 'maria', vehicleId: 'vehicle-maria', contact: 'Ny kontakt' });
  expect(order(saved, series[2].id)).toMatchObject({ status: 'unbooked', contact: 'Ny kontakt' });
  expect(order(saved, series[2].id).date).toBeUndefined();
  expect(saved.revision).toBe(data.revision + 1);
  const unbooked = saveTransportOrder(saved, series[0].id, { ...editorDraft(saved, series[0].id), status: 'unbooked', contact: 'Anna' }, actor, 'series');
  expect(order(unbooked, series[0].id).status).toBe('unbooked');
  expect(order(unbooked, series[1].id)).toMatchObject({ status: 'booked', date: addDays(day, 7), startMinute: 900, contact: 'Anna' });
});

test('transportbehörigheter migreras en gång för demokonton och återställs inte efter manuell indragning', () => {
  const legacy = { ...seedOffice(), transportPermissionsVersion: undefined };
  legacy.users = legacy.users.map((user) => ({ ...user, permissions: user.permissions.filter((right) => !['transportRead', 'transportPlan'].includes(right)) }));
  const custom = { ...legacy.users.find((user) => user.id === 'kajsa')!, id: 'custom-office', name: 'Egen kontorist' };
  legacy.users.push(custom);
  const migrated = migrateOffice(legacy);
  const kajsa = migrated.users.find((user) => user.id === 'kajsa')!;
  const anna = migrated.users.find((user) => user.id === 'anna')!;
  expect(migrated.transportPermissionsVersion).toBe(1);
  expect(can(kajsa, 'transportRead')).toBe(true);
  expect(can(kajsa, 'transportPlan')).toBe(true);
  expect(can(anna, 'transportRead')).toBe(true);
  expect(can(anna, 'transportPlan')).toBe(false);
  expect(can(migrated.users.find((user) => user.id === custom.id)!, 'transportRead')).toBe(false);
  kajsa.permissions = kajsa.permissions.filter((right) => !['transportRead', 'transportPlan'].includes(right));
  anna.permissions = anna.permissions.filter((right) => right !== 'transportRead');
  const reloaded = migrateOffice(JSON.parse(JSON.stringify(migrated)));
  expect(can(reloaded.users.find((user) => user.id === 'kajsa')!, 'transportPlan')).toBe(false);
  expect(can(reloaded.users.find((user) => user.id === 'kajsa')!, 'transportRead')).toBe(false);
  expect(can(reloaded.users.find((user) => user.id === 'anna')!, 'transportRead')).toBe(false);
});
