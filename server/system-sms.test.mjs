import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SYSTEM_SMS_USE_CASES, SystemSmsPreparationError, prepareSystemSms } from './system-sms.mjs';

const at = Date.parse('2026-10-20T08:00:00Z');
const input = () => ({ purpose: 'customer_approval', eventId: 'approval-3027', version: 1, recipient: '072-200 22 20' });
const scope = (command = input()) => ({ organisationId: 'company-a', portalBaseUrl: 'https://app.scrapplanner.com/kund',
  authorisedLink: { organisationId: 'company-a', purpose: command.purpose, eventId: command.eventId,
    version: command.version, recipient: command.recipient, url: 'https://app.scrapplanner.com/kund/approval?token=synthetic-token',
    expiresAt: '2026-10-20T09:00:00Z' } });
const prepare = (command = input(), context = scope(command)) => prepareSystemSms(command, context, { now: () => at });
const rejects = (command, context, code) => assert.throws(() => prepare(command, context), error => {
  assert.ok(error instanceof SystemSmsPreparationError); assert.equal(error.code, code); return true;
});

test('only the two selected SMS purposes are prepared and no delivery/provider exists', () => {
  assert.deepEqual(SYSTEM_SMS_USE_CASES.map(({ id, state }) => [id, state]), [
    ['customer_approval', 'prepared'], ['transport_notification', 'prepared'],
  ]);
  assert.ok(Object.isFrozen(SYSTEM_SMS_USE_CASES)); assert.ok(Object.isFrozen(SYSTEM_SMS_USE_CASES[0]));
  const draft = prepare();
  assert.equal(draft.channel, 'sms'); assert.equal(draft.deliveryEnabled, false);
  assert.equal(draft.deliveryStatus, 'not_configured'); assert.equal(draft.provider, undefined);
  assert.equal(draft.recipient, '+46722002220'); assert.equal(draft.organisationId, 'company-a');
  assert.match(draft.text, /viktunderlag att granska och godkänna/);
  assert.ok(!draft.text.includes('3027')); assert.ok(!draft.idempotencyKey.includes(draft.recipient));
  assert.ok(Object.isFrozen(draft));
});

test('transport templates cover booking, changed time and chauffeur on the way without private details', () => {
  for (const [kind, expected] of [['booked', /är bokad 2026-10-21 kl. 09:30/],
    ['time_changed', /ändrats till 2026-10-21 kl. 09:30/], ['on_the_way', /Chauffören är på väg/]]) {
    const command = { purpose: 'transport_notification', eventId: 'order-100', version: 2, recipient: '+46722002220', kind,
      ...(kind !== 'on_the_way' && { date: '2026-10-21', time: '09:30' }) };
    const draft = prepare(command);
    assert.match(draft.text, expected); assert.equal(draft.kind, kind);
    assert.equal(draft.deliveryEnabled, false); assert.ok(!draft.text.includes('order-100'));
  }
});

test('idempotency is stable after phone normalization and isolated by tenant, event, version, recipient and kind', () => {
  const original = prepare();
  assert.equal(original.idempotencyKey, prepare({ ...input(), recipient: '+46 72 200 22 20' }).idempotencyKey);
  for (const command of [{ ...input(), eventId: 'approval-3028' }, { ...input(), version: 2 },
    { ...input(), recipient: '+46722002221' }]) assert.notEqual(original.idempotencyKey, prepare(command).idempotencyKey);
  const other = scope(); other.organisationId = 'company-b'; other.authorisedLink.organisationId = 'company-b';
  assert.notEqual(original.idempotencyKey, prepare(input(), other).idempotencyKey);
  const booked = { purpose: 'transport_notification', eventId: 'order-100', version: 1, recipient: '+46722002220', kind: 'booked', date: '2026-10-21', time: '09:30' };
  assert.notEqual(prepare(booked).idempotencyKey, prepare({ ...booked, kind: 'time_changed' }).idempotencyKey);
});

test('tenant identity and link binding cannot be overridden through event fields', () => {
  rejects({ ...input(), organisationId: 'company-b' }, scope(), 'system_sms_invalid');
  for (const change of [{ organisationId: 'company-b' }, { eventId: 'approval-other' }, { version: 2 },
    { recipient: '+46722002221' }, { purpose: 'transport_notification' }]) {
    const context = scope(); Object.assign(context.authorisedLink, change);
    rejects(input(), context, 'system_sms_scope_mismatch');
  }
});

test('invalid purposes, phone numbers, sensitive/free text and impossible schedules are rejected', () => {
  for (const command of [null, {}, { ...input(), purpose: 'payroll' }, { ...input(), recipient: '' },
    { ...input(), recipient: '123456789' }, { ...input(), recipient: '+46722002220\r\nInjected' },
    { ...input(), personNumber: 'private' }, { ...input(), bankAccount: 'private' },
    { ...input(), text: 'CUSTOM TEXT' }, { ...input(), token: 'untrusted-token' }, { ...input(), version: 0 }])
    rejects(command, scope(), 'system_sms_invalid');
  const booked = { purpose: 'transport_notification', eventId: 'order-100', version: 1, recipient: '+46722002220', kind: 'booked', date: '2026-10-21', time: '09:30' };
  for (const change of [{ date: '2026-02-31' }, { time: '24:00' }, { kind: 'cancelled' }, { time: undefined }])
    rejects({ ...booked, ...change }, scope(booked), 'system_sms_invalid');
});

test('only current server-issued HTTPS customer-portal links on the trusted base are accepted', () => {
  for (const url of ['https://outside.example/kund/approval?token=x', 'http://app.scrapplanner.com/kund/approval',
    'javascript:alert(1)', 'https://user:password@app.scrapplanner.com/kund/approval',
    'https://app.scrapplanner.com/kontor/approval', 'https://app.scrapplanner.com/kund/../kontor',
    'https://app.scrapplanner.com/kund/approval#token=x', 'https://app.scrapplanner.com/kund/approval?redirect=https://outside.example',
    'https://app.scrapplanner.com/kund/approval?token=x\nInjected']) {
    const context = scope(); context.authorisedLink.url = url;
    assert.throws(() => prepare(input(), context), error => error instanceof SystemSmsPreparationError);
  }
  for (const base of ['https://app.scrapplanner.com', 'https://app.scrapplanner.com/kontor', 'https://app.scrapplanner.com/kund?redirect=x']) {
    const context = scope(); context.portalBaseUrl = base;
    rejects(input(), context, 'system_sms_link_invalid');
  }
  const expired = scope(); expired.authorisedLink.expiresAt = '2026-10-20T08:00:00Z';
  rejects(input(), expired, 'system_sms_link_expired');
  rejects(input(), {}, 'system_sms_invalid');
});
