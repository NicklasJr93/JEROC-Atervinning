import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAgencyCoordinator, AGENCY_STORAGE_KEY, companyStorageKey } from '../public/bokforing/suite/agency-storage.js';
import { inviteMember, acceptInvitation, revokeInvitation, updatePermissions, setAgencyUserActive } from '../public/bokforing/suite/agency.js';
import { createSuiteState } from '../public/bokforing/suite/seed.js';
import { createSuiteStorage } from '../public/bokforing/suite/storage.js';
import { validateSuiteState } from '../public/bokforing/suite/validate.js';
import { addActivity, transact } from '../public/bokforing/suite/core.js';
import { bookBill } from '../public/bokforing/suite/operations.js';

const ake = { userId: 'user-ake', companyId: 'company-ake' };
const jenny = { userId: 'user-jenny', companyId: 'company-ake' };
const bjork = { userId: 'user-bjork', companyId: 'company-bjork' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const addNote = (state, label = 'En fiktiv anteckning.') => transact(state, draft => addActivity(draft, label));

function harness() {
  const values = new Map(), pending = new Map(), reads = [], writes = [], lockNames = [];
  let sequence = 0;
  const locks = { request(name, _options, callback) {
    lockNames.push(name);
    const result = (pending.get(name) ?? Promise.resolve()).then(() => callback({ mode: 'exclusive', name }));
    pending.set(name, result.catch(() => {}));
    return result;
  } };
  const storage = {
    getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem(key, value) { writes.push(key); values.set(key, value); },
  };
  const options = { getStorage: () => storage, locks, makeRevision: () => `agency-storage-test-${++sequence}` };
  return { values, reads, writes, locks, lockNames, options, coordinator: createAgencyCoordinator(options) };
}

async function invite(coordinator, { userId = 'user-jenny', companyId = 'company-ake', permissions = ['bookkeeping'], accept = true } = {}) {
  let snapshot = coordinator.load();
  const company = snapshot.state.companies.find(item => item.id === companyId);
  const user = snapshot.state.users.find(item => item.id === userId);
  snapshot = await coordinator.commit(snapshot, state => inviteMember(state, {
    actorId: company.ownerId, companyId, personalNumber: user.personalNumber, permissions,
  }));
  const invitationId = snapshot.state.invitations.at(-1).id;
  if (accept) snapshot = await coordinator.commit(snapshot, state => acceptInvitation(state, { actorId: userId, invitationId }));
  return { snapshot, invitationId };
}

test('agency storage preserves the existing Åke ledger byte for byte and reads it at its original key', () => {
  const { values, coordinator } = harness();
  const original = JSON.stringify({ ...createSuiteState(), _demoStorageRevision: 'existing-ake-ledger' });
  values.set(companyStorageKey('company-ake'), original);
  const snapshot = coordinator.loadCompany(ake);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.revision, original);
  assert.equal(values.get(companyStorageKey('company-ake')), original);
  assert.equal(values.has(AGENCY_STORAGE_KEY), false);
  assert.equal(companyStorageKey('company-ake'), 'scrapplanner-bokforing-suite-v2');
});

test('two company ledgers use separate keys and independent empty or seeded books', async () => {
  const { coordinator, values } = harness();
  const first = coordinator.loadCompany(ake), second = coordinator.loadCompany(bjork);
  assert.equal(first.state.company.name, 'Åkes Hantverk AB');
  assert.equal(second.state.company.name, 'Björks El AB');
  assert.equal(second.state.entries.length, 0);
  assert.equal(second.state.invoices.length, 0);
  const saved = await coordinator.commitCompany({ ...bjork, snapshot: second, transition: state => addNote(state, 'Björks anteckning.') });
  assert.equal(saved.state.activity.at(-1).label, 'Björks anteckning.');
  assert.equal(values.has(companyStorageKey('company-ake')), false);
  assert.equal(coordinator.loadCompany(ake).state.activity.some(item => item.label === 'Björks anteckning.'), false);
  validateSuiteState(saved.state);
});

test('uninvited, pending and unrelated recipients cannot read or write client bookkeeping', async () => {
  const { coordinator, values } = harness();
  assert.throws(() => coordinator.loadCompany(jenny), error => error.code === 'ACCESS_DENIED');
  const snapshot = coordinator.loadCompany(ake);
  await invite(coordinator, { accept: false });
  assert.throws(() => coordinator.loadCompany(jenny), error => error.code === 'ACCESS_DENIED');
  assert.throws(() => coordinator.loadCompany({ ...jenny, userId: 'user-anki' }), error => error.code === 'ACCESS_DENIED');
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  assert.equal(values.has(companyStorageKey('company-ake')), false);
});

test('accepted read-only invitation permits reading but denies bookkeeping and payment writes', async () => {
  const { coordinator } = harness();
  await invite(coordinator, { permissions: ['read'] });
  const snapshot = coordinator.loadCompany(jenny);
  assert.equal(snapshot.state.company.name, 'Åkes Hantverk AB');
  for (const permissions of [['bookkeeping'], ['payments'], ['payroll'], ['closing'], ['export']]) {
    await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, permissions, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  }
});

test('a matching invitation in one client does not grant access to another client', async () => {
  const { coordinator, reads } = harness();
  await invite(coordinator);
  coordinator.loadCompany(jenny);
  reads.length = 0;
  assert.throws(() => coordinator.loadCompany({ ...jenny, companyId: 'company-bjork' }), error => error.code === 'ACCESS_DENIED');
  assert.equal(reads.includes(companyStorageKey('company-bjork')), false);
});

test('new bookkeeping events identify the actual user and agency while old history remains identical', async () => {
  const { coordinator } = harness();
  await coordinator.commitCompany({ ...ake, snapshot: coordinator.loadCompany(ake), transition: state => addNote(state, 'Åkes sparade historik.') });
  await invite(coordinator);
  const snapshot = coordinator.loadCompany(jenny), before = structuredClone(snapshot.state.activity);
  const bill = snapshot.state.bills.find(item => item.status === 'draft');
  const saved = await coordinator.commitCompany({ ...jenny, snapshot, transition: state => bookBill(state, bill.id) });
  assert.deepEqual(saved.state.activity.slice(0, before.length), before);
  const added = saved.state.activity.slice(before.length);
  assert.ok(added.length >= 1);
  for (const item of added) {
    assert.equal(item.actorId, 'user-jenny');
    assert.equal(item.actingCompanyId, 'company-ake');
    assert.equal(item.agencyId, 'lexratio');
    assert.match(item.actor, /Jenny.*via Lexratio/);
    assert.equal(JSON.stringify(item).includes('209003030039'), false);
  }
  assert.equal(saved.state.entries.length, snapshot.state.entries.length + 1);
  validateSuiteState(saved.state);
});

test('activity stamping also works for a transition mutating and returning its supplied draft', async () => {
  const { coordinator } = harness();
  await invite(coordinator);
  const saved = await coordinator.commitCompany({ ...jenny, snapshot: coordinator.loadCompany(jenny), transition: state => {
    addActivity(state, 'Fiktiv tilläggsanteckning.'); return state;
  } });
  assert.equal(saved.state.activity.at(-1).actorId, 'user-jenny');
});

test('owner actions are attributed without an agency', async () => {
  const { coordinator } = harness();
  const saved = await coordinator.commitCompany({ ...ake, snapshot: coordinator.loadCompany(ake), transition: addNote });
  assert.equal(saved.state.activity.at(-1).actorId, 'user-ake');
  assert.equal(saved.state.activity.at(-1).actingCompanyId, 'company-ake');
  assert.equal(saved.state.activity.at(-1).agencyId, null);
  assert.doesNotMatch(saved.state.activity.at(-1).actor, /via/);
});

test('revocation after a page loaded blocks the next write without changing ledger bytes', async () => {
  const { coordinator, values } = harness();
  const { invitationId } = await invite(coordinator);
  const snapshot = coordinator.loadCompany(jenny);
  await coordinator.commit(coordinator.load(), state => revokeInvitation(state, { actorId: 'user-ake', invitationId }));
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  assert.equal(values.has(companyStorageKey('company-ake')), false);
});

test('reduced permissions are applied to an already-open client page', async () => {
  const { coordinator } = harness();
  const { invitationId } = await invite(coordinator, { permissions: ['bookkeeping', 'payments'] });
  const snapshot = coordinator.loadCompany(jenny);
  await coordinator.commit(coordinator.load(), state => updatePermissions(state, { actorId: 'user-ake', invitationId, permissions: ['read'] }));
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  assert.equal(coordinator.loadCompany(jenny).error, null);
});

test('all requested permissions are required for a combined operation', async () => {
  const { coordinator } = harness();
  await invite(coordinator, { permissions: ['bookkeeping'] });
  const snapshot = coordinator.loadCompany(jenny);
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, permissions: ['bookkeeping', 'payments'], transition: addNote }), error => error.code === 'ACCESS_DENIED');
});

test('empty, unknown, duplicated and non-array permissions fail closed', async () => {
  const { coordinator } = harness();
  const snapshot = coordinator.loadCompany(ake);
  for (const permissions of [[], ['arbitrary'], ['read', 'read'], 'bookkeeping', null]) {
    await assert.rejects(coordinator.commitCompany({ ...ake, snapshot, permissions, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  }
});

test('unknown company IDs and users fail before any company data is read', () => {
  const { coordinator, reads } = harness();
  for (const request of [{ ...ake, userId: 'unknown-user' }, { ...ake, companyId: '../../private' }, { ...ake, companyId: 'company-bjork' }]) {
    reads.length = 0;
    assert.throws(() => coordinator.loadCompany(request), error => error.code === 'ACCESS_DENIED');
    assert.ok(reads.every(key => key === AGENCY_STORAGE_KEY));
  }
  assert.throws(() => companyStorageKey('__proto__'), error => error.code === 'ACCESS_DENIED');
});

test('a corrupt directory never falls back to seeded owner access', async () => {
  const { coordinator, values, reads } = harness();
  const original = '{invalid-directory';
  values.set(AGENCY_STORAGE_KEY, original);
  reads.length = 0;
  assert.throws(() => coordinator.loadCompany(ake), error => error.code === 'INVALID_DATA');
  await assert.rejects(coordinator.commitCompany({ ...ake, snapshot: { revision: null }, transition: addNote }), error => error.code === 'INVALID_DATA');
  assert.equal(values.get(AGENCY_STORAGE_KEY), original);
  assert.ok(reads.every(key => key === AGENCY_STORAGE_KEY));
});

test('inactive agency employees lose read and write access even with a previous accepted invitation', async () => {
  const { coordinator } = harness();
  await invite(coordinator, { userId: 'user-anki' });
  const identity = { ...jenny, userId: 'user-anki' }, snapshot = coordinator.loadCompany(identity);
  await coordinator.commit(coordinator.load(), state => setAgencyUserActive(state, { actorId: 'user-jenny', userId: 'user-anki', active: false }));
  assert.throws(() => coordinator.loadCompany(identity), error => error.code === 'ACCESS_DENIED');
  await assert.rejects(coordinator.commitCompany({ ...identity, snapshot, transition: addNote }), error => error.code === 'ACCESS_DENIED');
});

test('a queued revoke wins before a queued bookkeeping operation using the same directory lock', async () => {
  const { coordinator, lockNames } = harness();
  const { invitationId } = await invite(coordinator), snapshot = coordinator.loadCompany(jenny);
  const revoke = coordinator.commit(coordinator.load(), state => revokeInvitation(state, { actorId: 'user-ake', invitationId }));
  const write = coordinator.commitCompany({ ...jenny, snapshot, transition: addNote });
  await revoke;
  await assert.rejects(write, error => error.code === 'ACCESS_DENIED');
  assert.ok(lockNames.filter(name => name === `scrapplanner:bookkeeping-demo:${AGENCY_STORAGE_KEY}`).length >= 4);
});

test('a write already holding the directory lock finishes before a queued revoke; later writes are denied', async () => {
  const { coordinator, values } = harness();
  const { invitationId } = await invite(coordinator), snapshot = coordinator.loadCompany(jenny);
  const started = deferred(), release = deferred();
  const write = coordinator.commitCompany({ ...jenny, snapshot, transition: async state => {
    started.resolve(); await release.promise; return addNote(state, 'Sparad innan återkallelsen.');
  } });
  await started.promise;
  const revoke = coordinator.commit(coordinator.load(), state => revokeInvitation(state, { actorId: 'user-ake', invitationId }));
  release.resolve();
  const saved = await write;
  await revoke;
  assert.equal(saved.state.activity.at(-1).label, 'Sparad innan återkallelsen.');
  const bytes = values.get(companyStorageKey('company-ake'));
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot: saved, transition: addNote }), error => error.code === 'ACCESS_DENIED');
  assert.equal(values.get(companyStorageKey('company-ake')), bytes);
});

test('an uncoordinated directory edit while a transition yields aborts the ledger write', async () => {
  const { coordinator, values } = harness();
  const { invitationId } = await invite(coordinator), snapshot = coordinator.loadCompany(jenny);
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, transition: async state => {
    const directory = revokeInvitation(coordinator.load().state, { actorId: 'user-ake', invitationId });
    values.set(AGENCY_STORAGE_KEY, JSON.stringify({ ...directory, _demoStorageRevision: 'external-change' }));
    return addNote(state);
  } }), error => error.code === 'STALE_STATE');
  assert.equal(values.has(companyStorageKey('company-ake')), false);
});

test('simultaneous writes still use ledger revisions to prevent overwrite', async () => {
  const { coordinator } = harness();
  await invite(coordinator);
  const snapshot = coordinator.loadCompany(jenny), other = coordinator.loadCompany(ake);
  const results = await Promise.allSettled([
    coordinator.commitCompany({ ...jenny, snapshot, transition: state => addNote(state, 'Jennys anteckning.') }),
    coordinator.commitCompany({ ...ake, snapshot: other, transition: state => addNote(state, 'Åkes anteckning.') }),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected' && item.reason.code === 'STALE_STATE').length, 1);
});

test('only a company owner can reset its book, even when an employee has every assignable permission', async () => {
  const { coordinator, values } = harness();
  await invite(coordinator, { permissions: ['read', 'bookkeeping', 'payments', 'payroll', 'closing', 'export'] });
  let snapshot = coordinator.loadCompany(jenny);
  snapshot = await coordinator.commitCompany({ ...jenny, snapshot, transition: addNote });
  const bytes = values.get(companyStorageKey('company-ake'));
  await assert.rejects(coordinator.commitCompany({ ...jenny, snapshot, reset: true, permissions: ['read'] }), error => error.code === 'ACCESS_DENIED');
  assert.equal(values.get(companyStorageKey('company-ake')), bytes);
  const reset = await coordinator.commitCompany({ ...ake, snapshot, reset: true });
  assert.equal(reset.state.activity.some(item => item.label === 'En fiktiv anteckning.'), false);
  assert.equal(coordinator.load().state.invitations[0].status, 'accepted');
});

test('directory and company writes fail closed without Web Locks', async () => {
  const { options, values } = harness();
  const coordinator = createAgencyCoordinator({ ...options, locks: {} });
  assert.throws(() => coordinator.loadCompany(ake), error => error.code === 'COORDINATION_UNAVAILABLE');
  await assert.rejects(coordinator.commitCompany({ ...ake, snapshot: { revision: null }, transition: addNote }), error => error.code === 'COORDINATION_UNAVAILABLE');
  assert.equal(values.size, 0);
});

test('existing legacy storage can continue using the same coordinated Åke ledger', async () => {
  const { coordinator, options } = harness();
  const legacy = createSuiteStorage(options), initial = legacy.load();
  const saved = await legacy.commit(initial, state => addNote(state, 'Äldre demoflik.'));
  const loaded = coordinator.loadCompany(ake);
  assert.equal(loaded.revision, saved.revision);
  assert.equal(loaded.state.activity.at(-1).label, 'Äldre demoflik.');
  const updated = await coordinator.commitCompany({ ...ake, snapshot: loaded, transition: state => addNote(state, 'Nya byråfliken.') });
  assert.equal(legacy.load().revision, updated.revision);
});
