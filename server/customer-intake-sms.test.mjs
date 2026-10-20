import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSystemSmsProvider } from './system-sms-provider.mjs';

const input = { to: '0722002220', requestId: '2181c90e-90fb-4bcb-a2ed-9e3fef20f135',
  companyName: 'Återvinning AB', intakeUrl: `https://app.scrapplanner.com/kunduppgifter/#token=${'A'.repeat(43)}`,
  createdAt: '2026-10-20T10:00:00.000Z', expiresAt: '2026-10-20T10:30:00.000Z' };
const env = { ELKS_API_USERNAME: 'synthetic-user', ELKS_API_PASSWORD: 'synthetic-private-password' };

test('intake SMS uses a fixed customer-form link without bank or identity data', async () => {
  let calls = 0;
  const provider = createSystemSmsProvider({ env, fetchImpl: async (_url, options) => {
    calls++;
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('to'), '+46722002220');
    assert.equal(body.get('dontlog'), 'message');
    assert.equal(body.get('message'), `Atervinning AB: Fyll i dina kunduppgifter: ${input.intakeUrl} /ScrapPlanner`);
    return new Response(JSON.stringify({ id: `s${'a'.repeat(32)}`, status: 'created' }), { status: 201 });
  } });
  await provider.sendCustomerIntake(input);
  assert.equal(calls, 1);
});

test('intake SMS rejects arbitrary hosts, approval tokens, altered payloads and unavailable Swish-like commands', async () => {
  const provider = createSystemSmsProvider({ env, fetchImpl: () => assert.fail('invalid payload must not send') });
  for (const changed of [
    { intakeUrl: input.intakeUrl.replace('app.scrapplanner.com', 'other.example') },
    { intakeUrl: input.intakeUrl.replace('/kunduppgifter/', '/godkann/') },
    { intakeUrl: input.intakeUrl.replace('#token=', '?token=') },
    { intakeUrl: input.intakeUrl.replace('#token=', '?company=evil#token=') },
    { to: '123' }, { message: 'arbitrary' }, { from: 'Other' }, { paymentProfile: { method: 'swish' } },
  ]) await assert.rejects(provider.sendCustomerIntake({ ...input, ...changed }), error => error.code === 'system_sms_invalid');
});

test('uncertain intake SMS outcomes are surfaced without automatic retries', async () => {
  let calls = 0;
  const provider = createSystemSmsProvider({ env, fetchImpl: async () => { calls++; throw new Error('synthetic network failure'); } });
  await assert.rejects(provider.sendCustomerIntake(input), error => error.code === 'system_sms_outcome_unknown'
    && error.outcome === 'unknown' && /kundformuläret/.test(error.message));
  assert.equal(calls, 1);
});
