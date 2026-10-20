import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCustomerIntakeService } from './customer-intake.mjs';

function fixture({ unknownDelivery = false } = {}) {
  const draftId = randomUUID(), now = '2026-10-20T10:00:00.000Z', sent = [];
  let state = { metadata: { organisation: { id: 'intake-review-tenant', name: 'Granskning AB' } },
    office: { customers: [] }, pricing: { customers: [] }, mobile: { customers: [], drafts: [
      { id: draftId, number: 101, siteId: 'yard', createdAt: now, updatedAt: now, status: 'draft', rows: [] },
    ] } };
  const repository = {
    read: async operation => operation(structuredClone(state), 0),
    transact: async operation => {
      const next = structuredClone(state), result = await operation(next, 0);
      state = next; return result;
    },
  };
  const principal = { actor: { id: 'actual-review', level: 'Systemadmin' }, user: { id: 'effective-review', level: 'Systemadmin' } };
  const service = createCustomerIntakeService({ repository, authorizeStaff: async () => principal, now: () => new Date(now),
    registerLink: async () => {}, companyProfileProvider: async () => ({ name: 'Granskning AB' }),
    deliverSms: Object.assign(async input => {
      sent.push(input);
      if (unknownDelivery) throw Object.assign(new Error('Synthetic uncertain acceptance'), { status: 503, code: 'system_sms_outcome_unknown' });
      return { providerId: 'synthetic-receipt' };
    }, { configured: true }),
  });
  return { service, repository, sent, create: () => service.create({ draftId, requestId: randomUUID(),
    expectedCustomerId: null, channel: 'sms', phone: '0722002220' }, {}) };
}
const customer = () => ({ type: 'Företag', name: 'Kundbolaget AB', number: '559359-3626', phone: '', email: '',
  address: '', postalCode: '', city: '', countryCode: 'SE' });

test('a delivered bearer remains usable when SMS provider acceptance is unknown, while staff retain the uncertain delivery state', async () => {
  const f = fixture({ unknownDelivery: true }), created = await f.create();
  assert.equal(created.intake.status, 'unknown');
  const token = f.sent[0].token, view = await f.service.publicRead(token);
  assert.equal(view.intake.status, 'waiting');
  assert.deepEqual(Object.keys(view.intake).sort(), ['expiresAt', 'id', 'status']);
  const receipt = await f.service.submit(token, { requestId: randomUUID(), customer: customer() });
  assert.equal(receipt.intake.status, 'submitted'); assert.equal(f.sent.length, 1);
  assert.equal((await f.repository.read(state => state.customerIntake.sessions[0])).proposal.name, 'Kundbolaget AB');
});

test('bank-only self-entry rejects unrelated Swish recipient fields without storing the supplied proposal', async () => {
  for (const extra of [{ phone: '+46722002220' }, { recipient: 'Unrelated Swish recipient' }]) {
    const f = fixture(); await f.create();
    await assert.rejects(f.service.submit(f.sent[0].token, { requestId: randomUUID(), customer: {
      ...customer(), paymentProfile: { method: 'bank', bankType: 'account', clearing: '8327', account: '1234567890', holder: 'Kundbolaget AB', ...extra },
    } }), error => error.status === 422);
    assert.equal((await f.repository.read(state => state.customerIntake.sessions[0])).proposal, undefined);
  }
});

test('Unicode normalization cannot accept a name that later fails intake revalidation on staff apply', async () => {
  const f = fixture(); await f.create();
  const name = 'ﬀ'.repeat(101); assert.ok(name.length < 200); assert.ok(name.normalize('NFKC').length > 200);
  await assert.rejects(f.service.submit(f.sent[0].token, { requestId: randomUUID(), customer: { ...customer(), name } }), error => error.status === 422);
  assert.equal((await f.repository.read(state => state.customerIntake.sessions[0])).proposal, undefined);
});
