import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createApplicationRepository } from './application-storage.mjs';
import { createTerminalDemoStore } from './terminal-demo.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'customer-remote-'));
  let time = new Date('2026-10-20T08:00:00.000Z'), outcome = { status: 'sent' }, beforeProvider;
  const repository = await createApplicationRepository({ env: { JEROC_APPLICATION_DB_PATH: join(dir, 'application.sqlite') }, seed: initialApplicationState });
  const terminalRepository = await createTerminalDemoRepository({ env: {}, filename: join(dir, 'terminal.sqlite') });
  let store, staff;
  const sends = [];
  const app = createApplicationService({ repository, projections: id => store.projections(id),
    sendCustomerReview: (payload, principal) => store.send(payload, undefined, principal),
    finishCustomerReview: id => store.deliverRemote(id, staff),
  });
  const createStore = () => createTerminalDemoStore({ repository: terminalRepository, principalStore: app.principalStore,
    now: () => time, companyProfileProvider: () => ({ id: 'company-a', name: 'Teståtervinning AB' }),
    remoteConfigured: () => true,
    remoteDelivery: async job => {
      // This would deadlock if provider I/O ran while application state was
      // still held in its uncommitted SQLite transaction.
      const cards = await repository.read(state => state.office.cards);
      assert.ok(cards.some(card => card.customerApproval?.id === job.approvalId));
      sends.push(structuredClone(job));
      await beforeProvider?.(job);
      return outcome;
    },
  });
  store = createStore(); staff = (await store.staffSession({ actualUserId: 'admin', effectiveUserId: 'admin' })).token;
  const server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = async (path, input) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Demo-Actor': 'admin', 'X-Demo-User': 'admin' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, ...await response.json() };
  };
  async function card(id = 2053) {
    await repository.transact(state => {
      const customer = state.office.customers.find(value => value.id === 'customer-build');
      customer.number = '5591237895'; customer.phone = '+46701234567'; customer.email = 'seller@example.test';
      customer.paymentProfile = { method: 'bank', bank: 'Testbank', clearing: '8327', account: '1234567890', holder: customer.name };
      const value = state.office.cards.find(value => value.id === id);
      value.customerId = customer.id; value.status = 'complement'; value.origin = 'Ängsvägen 19, Rimbo'; value.siteId = 'norrtalje'; value.yard = 'Norrtälje';
      value.rows = [{ articleId: 'copper-1', weight: 10, price: 1, tier: 'C' }];
      value.paymentDetails = structuredClone(customer.paymentProfile);
      delete value.customerApproval; delete value.pricingSnapshotId; delete value.accounting;
    });
    return (await api('/api/application/office')).data.cards.find(value => value.id === id);
  }
  const command = (value, channel = 'email', key = randomUUID()) => ({ cardId: value.id, siteId: 'norrtalje', expectedCard: value,
    channel, recipient: channel === 'sms' ? '0701234567' : 'seller@example.test', idempotencyKey: key });
  try { await run({ get store() { return store; }, repository, terminalRepository, api, card, command, sends, staff,
    setOutcome: value => { outcome = value; }, advance: milliseconds => { time = new Date(Number(time) + milliseconds); },
    beforeProvider: callback => { beforeProvider = callback; }, restart: () => { store.close(); store = createStore(); } }); }
  finally { store.close(); await new Promise(resolve => server.close(resolve)); await repository.close(); await terminalRepository.close(); await rm(dir, { recursive: true, force: true }); }
}
const expired = error => error.status === 410 && error.code === 'customer_approval_expired';

test('remote review works with no terminal, commits before sending, freezes prices and only discloses the minimal public snapshot', () => fixture(async f => {
  const input = f.command(await f.card()), first = await f.api('/api/application/customer-review', input);
  assert.equal(first.status, 200, first.error); assert.equal(first.approval.delivery.status, 'sent'); assert.equal(first.approval.channel, 'email');
  assert.equal(first.approval.terminalId, undefined); assert.equal(f.sends.length, 1);
  const sent = f.sends[0], persisted = await f.terminalRepository.read(state => state);
  assert.equal(persisted.terminals.length, 0); assert.equal(Date.parse(sent.expiresAt) - Date.parse(sent.createdAt), 86400000);
  assert.ok(!JSON.stringify(persisted).includes(sent.token)); assert.ok(!JSON.stringify(first).includes('tokenHash')); assert.ok(!JSON.stringify(first).includes(sent.token));
  const publicView = await f.store.remoteRead(sent.token);
  assert.equal(Date.parse(publicView.expiresAt) - Date.parse(sent.createdAt), 86400000);
  assert.equal(publicView.companyName, 'Teståtervinning AB'); assert.equal(publicView.approval.snapshot.customerName, first.approval.snapshot.customer.name);
  for (const privateValue of ['seller@example.test', '+46701234567', '1234567890', '8327', 'paymentProfile', 'approvedHash', 'tokenHash']) assert.ok(!JSON.stringify(publicView).includes(privateValue));
  assert.equal(publicView.approval.snapshot.rows[0].price, first.approval.snapshot.rows[0].price);
  const retried = await f.api('/api/application/customer-review', input);
  assert.equal(retried.status, 200, retried.error); assert.equal(retried.approval.id, first.approval.id); assert.equal(f.sends.length, 1);
}));

test('public acceptance requires terms and physical ID remains a separate explicit staff action before internal attest', () => fixture(async f => {
  const first = await f.api('/api/application/customer-review', f.command(await f.card()));
  const token = f.sends[0].token;
  await assert.rejects(f.store.remoteRespond(token, { action: 'id_requested', termsAccepted: false }), error => error.code === 'terms_required');
  const request = await f.store.remoteRespond(token, { action: 'id_requested', termsAccepted: true });
  assert.equal(request.approval.status, 'id_requested');
  assert.equal((await f.store.remoteRespond(token, { action: 'id_requested', termsAccepted: true })).approval.status, 'id_requested');
  await assert.rejects(f.store.attest(first.approval.id, f.staff), error => error.code === 'customer_approval_required');
  await assert.rejects(f.store.confirmId(first.approval.id, f.staff), error => error.code === 'id_check_required');
  await assert.rejects(f.store.confirmId(first.approval.id, f.staff, { idChecked: false }), error => error.code === 'id_check_required');
  const confirmed = await f.store.confirmId(first.approval.id, f.staff, { idChecked: true });
  assert.equal(confirmed.status, 'approved');
  assert.equal((await f.store.remoteRead(token)).approval.status, 'approved');
  const frozen = await f.terminalRepository.read(state => state.approvals.find(value => value.id === confirmed.id));
  assert.equal(frozen.approvedMethod, 'staff_checked_physical_id'); assert.equal(frozen.approvedHash, frozen.snapshot.hash);
  assert.throws(() => f.store.remoteRespond(token, { action: 'attest', termsAccepted: true }));
}));

test('cancel, supersession, requested change and expiry invalidate old links without returning customer data', () => fixture(async f => {
  const input = f.command(await f.card()), first = await f.api('/api/application/customer-review', input), token = f.sends[0].token;
  await f.store.cancel(first.approval.id, f.staff);
  await assert.rejects(f.store.remoteRead(token), expired);
  const current = (await f.api('/api/application/office')).data.cards.find(value => value.id === input.cardId);
  const renewed = await f.api('/api/application/customer-review', f.command(current));
  assert.equal(renewed.status, 200, renewed.error); assert.equal(renewed.approval.version, first.approval.version + 1);
  const second = f.sends[1].token;
  await assert.rejects(f.store.remoteRespond(token, { action: 'id_requested', termsAccepted: true }), expired);
  await assert.rejects(f.store.remoteRespond(second, { action: 'change_requested', termsAccepted: false }), error => error.code === 'comment_required');
  assert.equal((await f.store.remoteRespond(second, { action: 'change_requested', termsAccepted: false, comment: 'Vikten behöver ses över.' })).approval.status, 'change_requested');
  assert.equal((await f.store.remoteRead(second)).approval.status, 'change_requested');
  await assert.rejects(f.store.remoteRespond(second, { action: 'id_requested', termsAccepted: true }), error => error.code === 'stale_approval');
  const thirdCard = (await f.api('/api/application/office')).data.cards.find(value => value.id === input.cardId);
  assert.equal((await f.api('/api/application/customer-review', f.command(thirdCard))).status, 200);
  const third = f.sends[2].token;
  f.advance(86400001); await assert.rejects(f.store.remoteRead(third), expired);
}));

test('known failed and uncertain SMS sends remain truthful and never repeat provider calls on command retries', () => fixture(async f => {
  f.setOutcome({ status: 'unknown' });
  const input = f.command(await f.card(), 'sms'), first = await f.api('/api/application/customer-review', input);
  assert.equal(first.status, 200, first.error); assert.equal(first.approval.delivery.status, 'unknown'); assert.equal(first.approval.recipient, '+46701234567');
  const token = f.sends[0].token;
  assert.equal((await f.store.remoteRead(token)).approval.status, 'waiting');
  assert.equal((await f.api('/api/application/customer-review', input)).approval.delivery.status, 'unknown'); assert.equal(f.sends.length, 1);
  await f.store.cancel(first.approval.id, f.staff); f.setOutcome({ status: 'failed' });
  const current = (await f.api('/api/application/office')).data.cards.find(value => value.id === input.cardId);
  const secondInput = f.command(current, 'sms'), second = await f.api('/api/application/customer-review', secondInput);
  assert.equal(second.status, 200, second.error); assert.equal(second.approval.delivery.status, 'failed');
  assert.equal((await f.api('/api/application/customer-review', secondInput)).approval.delivery.status, 'failed'); assert.equal(f.sends.length, 2);
  await assert.rejects(f.store.remoteRead(f.sends[1].token), expired);
}));

test('recipient validation and request-key conflicts cannot send a different link through a previous command', () => fixture(async f => {
  const card = await f.card(), input = f.command(card);
  const invalid = await f.api('/api/application/customer-review', { ...input, recipient: 'email@example.test\nBcc:other@example.test' });
  assert.equal(invalid.status, 422); assert.equal(f.sends.length, 0);
  assert.equal((await f.api('/api/application/customer-review', input)).status, 200);
  const changed = await f.api('/api/application/customer-review', { ...input, recipient: 'other@example.test' });
  assert.equal(changed.status, 409); assert.equal(f.sends.length, 1);
  await assert.rejects(f.store.remoteRead('A'.repeat(43)), expired);
}));

test('concurrent command retries cannot duplicate a provider attempt and late delivery cannot revive a cancelled link', () => fixture(async f => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  f.beforeProvider(() => { started(); return gate; });
  const input = f.command(await f.card()), first = f.api('/api/application/customer-review', input);
  await entered;
  try {
    const repeated = await f.api('/api/application/customer-review', input);
    assert.equal(repeated.status, 200, repeated.error); assert.equal(repeated.approval.delivery.status, 'sending'); assert.equal(f.sends.length, 1);
    await f.store.cancel(f.sends[0].approvalId, f.staff);
  } finally { release(); }
  const completed = await first;
  assert.equal(completed.status, 200, completed.error); assert.equal(completed.approval.status, 'cancelled');
  assert.equal(completed.approval.delivery.status, 'sent'); assert.equal(f.sends.length, 1);
  await assert.rejects(f.store.remoteRead(f.sends[0].token), expired);
}));
