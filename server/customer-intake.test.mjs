import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplicationRepository } from './application-storage.mjs';
import { createCustomerIntakeService, guardCustomerIntakeDraftChange } from './customer-intake.mjs';

const customer = () => ({ type: 'Företag', name: 'Ny kund AB', number: '559359-3626', phone: '0722002220', email: 'kund@example.test',
  address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', countryCode: 'SE',
  paymentProfile: { method: 'bank', clearing: '8327', account: '1234567890', holder: 'Ny kund AB' } });
const failure = (status, code) => error => error.status === status && (!code || error.code === code);
async function fixture(run, { sendError } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'customer-intake-core-'));
  const draftId = randomUUID(), req = {}, principal = { actor: { id: 'actual', name: 'Faktisk användare', level: 'Medarbetare', active: true,
    permissions: ['view', 'prepare', 'customers', 'paymentDetails'], siteIds: ['north'] }, user: { id: 'effective', name: 'Vald användare', level: 'Medarbetare', active: true,
    permissions: ['view', 'prepare', 'customers', 'paymentDetails'], siteIds: ['north'] } };
  let current = new Date('2026-10-20T10:00:00.000Z');
  let repository = await createApplicationRepository({ env: {}, filename: join(directory, 'application.sqlite'), seed: () => ({
    metadata: { organisation: { id: 'tenant-a', name: 'Bolag A' } }, pricing: { users: [], customers: [] }, office: { customers: [], cards: [] },
    mobile: { version: 1, customers: [], drafts: [{ id: draftId, siteId: 'north', number: 2001, status: 'draft', createdAt: current.toISOString(), updatedAt: current.toISOString(),
      reference: '', origin: '', rows: [{ id: 'one', articleId: 'copper', method: 'direct', weight: 20 }] }] }, logistics: { sites: [{ id: 'north', active: true }] } }) });
  const sends = [], registrations = [], terminals = new Map();
  const deliverSms = Object.assign(async input => { sends.push(input); if (sendError) throw sendError; return { providerId: 'accepted' }; }, { configured: true });
  const terminalAccess = {
    listIntakeTerminals: async () => [{ id: 'terminal-one', name: 'Gården', siteId: 'north', online: true, busy: terminals.has('terminal-one') }],
    withIntakeTerminal: async (input, identity, callback) => {
      if (input.operation === 'claim') { if (terminals.has(input.terminalId)) throw Object.assign(new Error('Busy'), { status: 409 }); terminals.set(input.terminalId, { intakeId: input.intakeId, connectionId: 'epoch-one' }); }
      else if (terminals.get(input.terminalId)?.intakeId !== input.intakeId || input.connectionId !== 'epoch-one') throw Object.assign(new Error('Wrong reservation'), { status: 409 });
      const value = await callback({ id: input.terminalId, siteId: input.siteId, name: 'Gården', connectionId: 'epoch-one' });
      if (input.operation === 'release') terminals.delete(input.terminalId); return value;
    },
  };
  const openService = () => createCustomerIntakeService({ repository, authorizeStaff: async () => principal, terminalAccess, deliverSms,
    registerLink: async input => { assert.ok(await repository.read(state => state.customerIntake.sessions.some(row => row.id === input.intakeId))); registrations.push(input); },
    companyProfileProvider: async () => ({ id: 'tenant-a', name: 'Bolag A', logoUrl: '/api/protected-logo' }), now: () => current });
  let service = openService();
  const create = (patch = {}) => service.create({ draftId, channel: 'sms', phone: '0722002220', expectedCustomerId: null, requestId: randomUUID(), ...patch }, req);
  try { await run({ get service(){return service;}, get repository(){return repository;}, draftId, req, principal, sends, registrations, terminals, create,
    restart: async()=>{await repository.close();repository=await createApplicationRepository({env:{},filename:join(directory,'application.sqlite')});service=openService();},
    later: milliseconds => { current = new Date(current.getTime() + milliseconds); } }); }
  finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
}

test('SMS intake commits before delivery, exposes no old data, and applies once while preserving concurrent weighing', () => fixture(async f => {
  const requestId = randomUUID(), opened = await f.create({ requestId });
  assert.equal(f.sends.length, 1); assert.equal(f.registrations.length, 1);
  await f.create({ requestId }); assert.equal(f.sends.length, 1);
  const token = f.sends[0].token, raw = JSON.stringify(await f.repository.read(state => state)); assert.equal(raw.includes(token), false);
  assert.equal(f.sends[0].expiresAt, '2026-10-20T10:30:00.000Z');
  assert.deepEqual(await f.service.publicRead(token), { intake: { id: opened.intake.id, status: 'waiting', expiresAt: f.sends[0].expiresAt }, company: { name: 'Bolag A' } });
  const submission = { requestId: randomUUID(), customer: customer() };
  await f.service.submit(token, submission); await f.service.submit(token, submission);
  const read = await f.service.read({ draftId: f.draftId }, f.req);
  assert.equal(read.intake.hasPaymentProfile, true); assert.equal(read.intake.proposal.paymentProfile, undefined);
  await f.repository.transact(state => { const draft = state.mobile.drafts[0]; draft.rows[0].weight = 72; draft.reference = 'senaste referens'; draft.origin = 'senaste ursprung'; draft.updatedAt = '2026-10-20T10:02:00.000Z'; });
  const command = { id: opened.intake.id, requestId: randomUUID() }, applied = await f.service.apply(command, f.req);
  assert.equal(applied.draftPatch.updatedAt, '2026-10-20T10:02:00.000Z'); assert.equal(applied.draftPatch.reference, 'senaste referens'); assert.equal(applied.draftPatch.rows, undefined);
  assert.equal(applied.customer.paymentProfile, undefined); await f.service.apply(command, f.req);
  const state = await f.repository.read(state => state); assert.equal(state.office.customers.length, 1); assert.equal(state.mobile.drafts[0].rows[0].weight, 72);
  assert.equal(state.office.customers[0].paymentProfile.account, '1234567890'); assert.equal(state.customerIntake.sessions[0].proposal, undefined);
  assert.equal(state.customerIntake.audit.filter(row => row.action === 'customer-intake.applied').length, 1);
}));

test('cancel and a fresh SMS intent create independent durable links; stale cancellation and old retries never close or resend the new one',()=>fixture(async f=>{
  const originalRequestId=randomUUID(),first=await f.create({requestId:originalRequestId}),oldToken=f.sends[0].token;
  const cancellation={id:first.intake.id,requestId:randomUUID()};
  await f.service.cancel(cancellation,f.req);
  await assert.rejects(f.service.publicRead(oldToken),failure(410));
  await f.restart();
  const freshRequestId=randomUUID(),fresh=await f.create({requestId:freshRequestId}),newToken=f.sends[1].token;
  assert.notEqual(fresh.intake.id,first.intake.id);assert.notEqual(newToken,oldToken);assert.equal(fresh.intake.status,'waiting');
  assert.equal(f.sends.length,2);assert.equal(f.registrations.length,2);
  assert.notEqual(f.registrations[0].tokenHash,f.registrations[1].tokenHash);
  assert.equal((await f.service.publicRead(newToken)).intake.id,fresh.intake.id);
  assert.equal((await f.create({requestId:originalRequestId})).intake.status,'cancelled');
  assert.equal(f.sends.length,2,'replaying an old create cannot send or return a fresh capability');
  await f.service.cancel(cancellation,f.req);
  await f.service.cancel({id:first.intake.id,requestId:randomUUID()},f.req);
  await assert.rejects(f.service.cancel({id:fresh.intake.id,requestId:cancellation.requestId},f.req),failure(409,'customer_intake_request_conflict'));
  assert.equal((await f.service.read({draftId:f.draftId},f.req)).intake.id,fresh.intake.id);
  await f.restart();
  await assert.rejects(f.service.publicRead(oldToken),failure(410));
  await assert.rejects(f.service.submit(oldToken,{requestId:randomUUID(),customer:customer()}),failure(410));
  assert.equal((await f.service.publicRead(newToken)).intake.status,'waiting');
  assert.equal((await f.create({requestId:freshRequestId})).intake.id,fresh.intake.id);assert.equal(f.sends.length,2);
  const command={requestId:randomUUID(),customer:customer()};
  assert.equal((await f.service.submit(newToken,command)).intake.status,'submitted');
  await f.service.submit(newToken,command);
  assert.equal((await f.service.apply({id:fresh.intake.id,requestId:randomUUID()},f.req)).intake.status,'applied');
  assert.equal(await f.repository.read(state=>state.office.customers.length),1);
}));

test('cancelling an old terminal form again leaves the replacement reservation usable',()=>fixture(async f=>{
  const first=await f.create({channel:'terminal',terminalId:'terminal-one',phone:undefined}),cancellation={id:first.intake.id,requestId:randomUUID()};
  await f.service.cancel(cancellation,f.req);
  const fresh=await f.create({channel:'terminal',terminalId:'terminal-one',phone:undefined});
  await f.service.cancel(cancellation,f.req);await f.service.cancel({id:first.intake.id,requestId:randomUUID()},f.req);
  assert.equal(f.terminals.get('terminal-one').intakeId,fresh.intake.id);
  assert.equal((await f.service.terminalRead({id:'terminal-one',siteId:'north',connectionId:'epoch-one'})).intake.id,fresh.intake.id);
}));

test('customer selection changes invalidate a link even if changed back; readiness is fenced but weights are not', () => fixture(async f => {
  const opened = await f.create(), token = f.sends[0].token;
  const options = { now: () => new Date('2026-10-20T10:00:00.000Z') };
  await assert.rejects(f.repository.transact(state => { const before = state.mobile.drafts[0]; guardCustomerIntakeDraftChange(state, before, { ...before, status: 'ready' }, options); }), failure(409, 'customer_intake_pending'));
  await f.repository.transact(state => { const before = state.mobile.drafts[0], next = { ...before, customerId: 'another-customer' }; guardCustomerIntakeDraftChange(state, before, next, options); state.mobile.drafts[0] = next; });
  await f.repository.transact(state => { const before = state.mobile.drafts[0], next = { ...before }; delete next.customerId; guardCustomerIntakeDraftChange(state, before, next, options); state.mobile.drafts[0] = next; });
  await assert.rejects(f.service.publicRead(token), failure(410));
  assert.equal((await f.service.read({ draftId: f.draftId }, f.req)).intake.status, 'cancelled');
  await assert.rejects(f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req), failure(410));
}));

test('existing customer contact and bank stay unchanged while a missing bank needs explicit staff permission', () => fixture(async f => {
  const original = { ...customer(), id: 'existing', customerNumber: 'K-1', name: 'Befintlig kund', phone: '+46700001111', audit: [{ text: 'Original' }], references: [], origins: [], registrations: [] };
  await f.repository.transact(state => { state.office.customers.push(structuredClone(original)); });
  let opened = await f.create(); await f.service.submit(f.sends.at(-1).token, { requestId: randomUUID(), customer: customer() });
  await f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req);
  assert.deepEqual(await f.repository.read(state => state.office.customers[0]), original);
  await f.repository.transact(state => { delete state.office.customers[0].paymentProfile; const draft = state.mobile.drafts[0]; delete draft.customerId; delete draft.customerSelectionsSavedAt; });
  opened = await f.create(); await f.service.submit(f.sends.at(-1).token, { requestId: randomUUID(), customer: customer() });
  f.principal.user.permissions = f.principal.user.permissions.filter(value => value !== 'paymentDetails');
  await assert.rejects(f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req), failure(403, 'customer_intake_payment_forbidden'));
  f.principal.user.permissions.push('paymentDetails'); await f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req);
  const saved = await f.repository.read(state => state.office.customers[0]); assert.equal(saved.phone, original.phone); assert.equal(saved.name, original.name); assert.equal(saved.paymentProfile.account, '1234567890');
}));

test('expiry clears submitted personal/bank data, public input rejects protected fields and unknown SMS is never retried', () => fixture(async f => {
  const requestId = randomUUID(), opened = await f.create({ requestId }), token = f.sends[0].token;
  assert.equal(opened.intake.status, 'unknown'); await f.create({ requestId }); assert.equal(f.sends.length, 1);
  await assert.rejects(f.service.submit(token, { requestId: randomUUID(), customer: { ...customer(), vatRegistered: true } }), failure(422));
  await assert.rejects(f.service.submit(token, { requestId: randomUUID(), customer: { ...customer(), paymentProfile: { method: 'swish', phone: '0722002220' } } }), failure(422));
  await f.service.submit(token, { requestId: randomUUID(), customer: customer() }); f.later(31 * 60_000);
  await assert.rejects(f.service.publicRead(token), failure(410));
  const row = await f.repository.read(state => state.customerIntake.sessions[0]); assert.equal(row.proposal, undefined); assert.equal(row.status, 'expired');
}, { sendError: Object.assign(new Error('uncertain'), { status: 503, code: 'system_sms_outcome_unknown' }) }));

test('terminal intake uses its claimed connection, releases after staff apply, and read-only yard staff can check readiness', () => fixture(async f => {
  const opened = await f.create({ channel: 'terminal', terminalId: 'terminal-one', phone: undefined });
  assert.equal(f.sends.length, 0); const device = { id: 'terminal-one', siteId: 'north' };
  const view = await f.service.terminalRead(device); assert.equal(view.intake.id, opened.intake.id);
  await f.service.terminalSubmit(device, { id: opened.intake.id, requestId: randomUUID(), customer: customer() });
  f.principal.user.permissions = f.principal.user.permissions.filter(value => value !== 'customers');
  assert.equal((await f.service.read({ draftId: f.draftId }, f.req)).intake.status, 'submitted');
  await assert.rejects(f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req), failure(403));
  f.principal.user.permissions.push('customers'); await f.service.apply({ id: opened.intake.id, requestId: randomUUID() }, f.req);
  assert.equal(f.terminals.size, 0); assert.deepEqual(await f.service.terminalRead(device), { intake: null });
}));
