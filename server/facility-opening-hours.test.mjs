import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facilityOpeningHoursSchema, FACILITY_TIME_ZONE, FACILITY_WEEKDAYS } from './facility-opening-hours.mjs';

const week = () => Object.fromEntries(FACILITY_WEEKDAYS.map(day => [day, null]));
const hours = changes => ({ week: week(), exceptions: [], ...changes });

test('facility hours distinguish unconfigured days, closed days and separate open intervals', () => {
  const value = hours({ week: { ...week(), mon: [], tue: [{ open: '13:00', close: '16:00' }, { open: '07:00', close: '12:00' }] } });
  const parsed = facilityOpeningHoursSchema.parse(value);
  assert.equal(FACILITY_TIME_ZONE, 'Europe/Stockholm');
  assert.equal(parsed.week.wed, null); assert.deepEqual(parsed.week.mon, []);
  assert.deepEqual(parsed.week.tue, [{ open: '07:00', close: '12:00' }, { open: '13:00', close: '16:00' }]);
  assert.equal(value.week.tue[0].open, '13:00', 'input is not mutated');
});

test('invalid, overnight and overlapping hours cannot be stored', () => {
  for (const entries of [[{ open: '07:00', close: '07:00' }], [{ open: '23:00', close: '02:00' }],
    [{ open: '24:00', close: '25:00' }], [{ open: '7:00', close: '16:00' }],
    [{ open: '07:00', close: '12:00' }, { open: '11:00', close: '16:00' }]]) {
    assert.equal(facilityOpeningHoursSchema.safeParse(hours({ week: { ...week(), mon: entries } })).success, false);
  }
  assert.equal(facilityOpeningHoursSchema.safeParse(hours({ week: { ...week(), mon: [{ open: '07:00', close: '12:00' }, { open: '12:00', close: '16:00' }] } })).success, true);
});

test('date exceptions require real unique dates and a consistent closed/open state', () => {
  const closed = { date: '2026-12-24', label: 'Julafton', closed: true, intervals: [] };
  assert.deepEqual(facilityOpeningHoursSchema.parse(hours({ exceptions: [closed] })).exceptions, [closed]);
  for (const exceptions of [[{ ...closed, date: '2026-02-29' }], [closed, closed],
    [{ ...closed, intervals: [{ open: '07:00', close: '12:00' }] }], [{ ...closed, closed: false }]]) {
    assert.equal(facilityOpeningHoursSchema.safeParse(hours({ exceptions })).success, false);
  }
  assert.equal(facilityOpeningHoursSchema.safeParse(hours({ exceptions: [{ ...closed, date: '2028-02-29' }] })).success, true);
  assert.equal(facilityOpeningHoursSchema.safeParse({ ...hours(), timeZone: 'UTC' }).success, false);
});
