import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSIONS, createAgencyState, validateAgencyState, normalizePersonalNumber,
  formatPersonalNumber, maskPersonalNumber, inviteMember, acceptInvitation,
  declineInvitation, revokeInvitation, updatePermissions, registerAgencyUser,
  setAgencyUserActive, hasPermission, getCompanyAccess,
} from '../public/bokforing/suite/agency.js';

const firstTime = { now: '2026-10-24T10:00:00.000Z' };
const later = { now: '2026-10-24T11:00:00.000Z' };
const options = (overrides = {}) => ({ actorId: 'user-ake', companyId: 'company-ake', personalNumber: '20900303-0039', permissions: ['read'], ...overrides });
const pending = (permissions = ['read']) => inviteMember(createAgencyState(), options({ permissions }), firstTime);
function accepted(permissions = ['read']) {
  const state = pending(permissions);
  return acceptInvitation(state, { actorId: 'user-jenny', invitationId: state.invitations[0].id }, later);
}
const firstId = state => state.invitations[0].id;

test('agency demo seed is valid, fictional and grants each owner only their own company', () => {
  const state = createAgencyState();
  assert.equal(validateAgencyState(state), state);
  assert.equal(state.invitations.length, 0);
  assert.equal(state.activity.length, 0);
  assert.deepEqual(getCompanyAccess(state, 'user-ake').map(item => item.id), ['company-ake']);
  assert.deepEqual(getCompanyAccess(state, 'user-bjork').map(item => item.id), ['company-bjork']);
  assert.deepEqual(getCompanyAccess(state, 'user-jenny'), []);
  assert.deepEqual(getCompanyAccess(state, 'user-anki'), []);
  assert.ok(state.users.every(user => user.personalNumber.startsWith('2090')));
  for (const permission of [...PERMISSIONS.map(item => item.id), 'manage']) {
    assert.equal(hasPermission(state, 'user-ake', 'company-ake', permission), true);
    assert.equal(hasPermission(state, 'user-ake', 'company-bjork', permission), false);
  }
});

test('personal number accepts only the two full-century canonical formats', () => {
  assert.equal(normalizePersonalNumber('209003030039'), '209003030039');
  assert.equal(normalizePersonalNumber(' 20900303-0039 '), '209003030039');
  assert.equal(formatPersonalNumber('209003030039'), '20900303-0039');
  assert.equal(maskPersonalNumber('20900303-0039'), '20900303-••••');
  for (const invalid of [null, 209003030039, '', '900303-0039', '9003030039', '20900303+0039', '2090 0303-0039', '20900303-0038', '20901303-0039', '20900230-0039', '2090030300390', 'abcd03030039']) {
    assert.throws(() => normalizePersonalNumber(invalid), { name: 'Error' });
  }
});

test('invitation matches a registered account but does not grant access before acceptance', () => {
  const state = pending(['bookkeeping', 'payroll']);
  assert.equal(state.invitations[0].recipientId, 'user-jenny');
  assert.equal(state.invitations[0].agencyId, 'lexratio');
  assert.deepEqual(state.invitations[0].permissions, ['read', 'bookkeeping', 'payroll']);
  assert.equal(state.invitations[0].status, 'pending');
  assert.equal(state.invitations[0].decidedAt, null);
  assert.deepEqual(getCompanyAccess(state, 'user-jenny'), []);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'bookkeeping'), false);
});

test('empty selection means read only; management is never delegated', () => {
  let state = pending([]);
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: firstId(state) }, later);
  assert.deepEqual(state.invitations[0].permissions, ['read']);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'read'), true);
  for (const permission of ['bookkeeping', 'payroll', 'closing', 'payments', 'export', 'manage', 'unknown']) {
    assert.equal(hasPermission(state, 'user-jenny', 'company-ake', permission), false);
  }
});

for (const permission of PERMISSIONS.map(item => item.id)) {
  test(`accepted grant permits ${permission} without silently granting other capabilities`, () => {
    const state = accepted([permission]);
    assert.equal(hasPermission(state, 'user-jenny', 'company-ake', permission), true);
    for (const other of PERMISSIONS.map(item => item.id).filter(item => !['read', permission].includes(item))) {
      assert.equal(hasPermission(state, 'user-jenny', 'company-ake', other), false);
    }
    assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'manage'), false);
  });
}

test('only the named active recipient can accept or decline an invitation', () => {
  const state = pending(['bookkeeping']);
  for (const actorId of ['user-anki', 'user-ake', 'user-bjork', 'missing']) {
    assert.throws(() => acceptInvitation(state, { actorId, invitationId: firstId(state) }, later));
    assert.throws(() => declineInvitation(state, { actorId, invitationId: firstId(state) }, later));
  }
  assert.equal(state.invitations[0].status, 'pending');
  assert.equal(acceptInvitation(state, { actorId: 'user-jenny', invitationId: firstId(state) }, later).invitations[0].status, 'accepted');
});

test('owners cannot invite into another company and staff cannot delegate their access', () => {
  const state = accepted(['bookkeeping', 'payroll', 'closing', 'payments', 'export']);
  assert.throws(() => inviteMember(state, options({ actorId: 'user-bjork' }), later), /ägare/);
  assert.throws(() => inviteMember(state, options({ actorId: 'user-jenny', personalNumber: '20900404-0045' }), later), /ägare/);
  assert.throws(() => updatePermissions(state, { actorId: 'user-jenny', invitationId: firstId(state), permissions: ['read'] }, later), /ägare/);
  assert.throws(() => revokeInvitation(state, { actorId: 'user-anki', invitationId: firstId(state) }, later), /ägare/);
  assert.equal(hasPermission(state, 'user-anki', 'company-ake', 'read'), false);
});

test('unknown and non-agency personal numbers do not create invitations', () => {
  const state = createAgencyState();
  for (const personalNumber of ['20900505-0050', '20900101-0017', '20900202-0023']) {
    assert.throws(() => inviteMember(state, options({ personalNumber }), firstTime), /Ingen aktiv byråmedarbetare/);
  }
  assert.equal(state.invitations.length, 0);
});

test('duplicate pending and accepted invitations are rejected after number normalization', () => {
  for (const state of [pending(), accepted()]) {
    assert.throws(() => inviteMember(state, options({ personalNumber: '209003030039' }), later), /redan/);
    assert.equal(state.invitations.length, 1);
  }
});

test('unknown or repeated permissions cannot be stored', () => {
  for (const permissions of [undefined, null, 'read', ['manage'], ['read', 'read'], ['bookkeeping', 'admin'], ['READ']]) {
    assert.throws(() => inviteMember(createAgencyState(), options({ permissions }), firstTime));
  }
});

test('declining leaves no access; a fresh invitation does not revive the old decision', () => {
  let state = pending(['payroll']);
  const declinedId = firstId(state);
  state = declineInvitation(state, { actorId: 'user-jenny', invitationId: declinedId }, later);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'read'), false);
  assert.throws(() => acceptInvitation(state, { actorId: 'user-jenny', invitationId: declinedId }, later), /väntande/);
  state = inviteMember(state, options({ permissions: ['bookkeeping'] }), later);
  const replacement = state.invitations.at(-1).id;
  assert.notEqual(replacement, declinedId);
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: replacement }, later);
  assert.equal(state.invitations[0].status, 'declined');
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'bookkeeping'), true);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'payroll'), false);
});

test('cancelling a pending invitation prevents later acceptance', () => {
  let state = pending();
  const id = firstId(state);
  state = revokeInvitation(state, { actorId: 'user-ake', invitationId: id }, later);
  assert.equal(state.invitations[0].status, 'revoked');
  assert.throws(() => acceptInvitation(state, { actorId: 'user-jenny', invitationId: id }, later), /väntande/);
  assert.deepEqual(getCompanyAccess(state, 'user-jenny'), []);
});

test('revoking accepted access takes effect while preserving all historical decisions', () => {
  const before = accepted(['bookkeeping', 'export']);
  const history = structuredClone(before.activity);
  const state = revokeInvitation(before, { actorId: 'user-ake', invitationId: firstId(before) }, later);
  assert.deepEqual(state.activity.slice(0, history.length), history);
  assert.equal(state.invitations[0].status, 'revoked');
  assert.equal(state.activity.at(-1).type, 'invitation-revoked');
  assert.equal(state.activity.at(-1).actorId, 'user-ake');
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'read'), false);
  assert.equal(before.invitations[0].status, 'accepted');
  assert.throws(() => updatePermissions(state, { actorId: 'user-ake', invitationId: firstId(state), permissions: ['export'] }, later), /återkallad|Återkallad/);
});

test('owner can revise pending permissions and the recipient accepts only the revised scope', () => {
  let state = pending(['payroll', 'payments']);
  state = updatePermissions(state, { actorId: 'user-ake', invitationId: firstId(state), permissions: ['export'] }, later);
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: firstId(state) }, later);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'export'), true);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'payroll'), false);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'payments'), false);
  assert.deepEqual(state.activity[0].permissions, ['read', 'payroll', 'payments']);
});

test('owner can reduce accepted permissions immediately without another acceptance', () => {
  const before = accepted(['bookkeeping', 'export']);
  const state = updatePermissions(before, { actorId: 'user-ake', invitationId: firstId(before), permissions: [] }, later);
  assert.equal(state.invitations[0].status, 'accepted');
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'read'), true);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'bookkeeping'), false);
  assert.equal(hasPermission(before, 'user-jenny', 'company-ake', 'bookkeeping'), true);
});

test('one employee can work in two companies with independent grants and revocation', () => {
  let state = accepted(['bookkeeping']);
  state = inviteMember(state, options({ actorId: 'user-bjork', companyId: 'company-bjork', permissions: ['payroll'] }), later);
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: state.invitations.at(-1).id }, later);
  assert.deepEqual(getCompanyAccess(state, 'user-jenny').map(item => item.id), ['company-ake', 'company-bjork']);
  assert.equal(hasPermission(state, 'user-jenny', 'company-bjork', 'bookkeeping'), false);
  assert.equal(hasPermission(state, 'user-jenny', 'company-ake', 'payroll'), false);
  state = revokeInvitation(state, { actorId: 'user-ake', invitationId: firstId(state) }, later);
  assert.deepEqual(getCompanyAccess(state, 'user-jenny').map(item => item.id), ['company-bjork']);
});

test('disabling staff revokes pending and accepted assignments across all clients permanently', () => {
  let state = accepted(['bookkeeping']);
  state = inviteMember(state, options({ actorId: 'user-bjork', companyId: 'company-bjork' }), later);
  // The admin may disable another worker, so exercise Anki in both clients.
  state = inviteMember(state, options({ personalNumber: '20900404-0045', permissions: ['payroll'] }), later);
  state = acceptInvitation(state, { actorId: 'user-anki', invitationId: state.invitations.at(-1).id }, later);
  state = inviteMember(state, options({ actorId: 'user-bjork', companyId: 'company-bjork', personalNumber: '20900404-0045' }), later);
  const disabled = setAgencyUserActive(state, { actorId: 'user-jenny', userId: 'user-anki', active: false }, later);
  assert.deepEqual(getCompanyAccess(disabled, 'user-anki'), []);
  assert.ok(disabled.invitations.filter(item => item.recipientId === 'user-anki').every(item => item.status === 'revoked'));
  assert.throws(() => inviteMember(disabled, options({ personalNumber: '20900404-0045' }), later), /Ingen aktiv/);
  const restored = setAgencyUserActive(disabled, { actorId: 'user-jenny', userId: 'user-anki', active: true }, later);
  assert.deepEqual(getCompanyAccess(restored, 'user-anki'), []);
  assert.equal(hasPermission(restored, 'user-jenny', 'company-ake', 'bookkeeping'), true);
});

test('only a byra administrator can register staff; registration grants no client access', () => {
  const state = createAgencyState(), input = { actorId: 'user-jenny', name: 'Ny demomedarbetare', personalNumber: '20900505-0050' };
  for (const actorId of ['user-ake', 'user-anki', 'missing']) assert.throws(() => registerAgencyUser(state, { ...input, actorId }, firstTime));
  const registered = registerAgencyUser(state, input, firstTime);
  const user = registered.users.at(-1);
  assert.equal(user.agencyId, 'lexratio');
  assert.equal(user.personalNumber, '209005050050');
  assert.equal(registered.agencies[0].adminIds.includes(user.id), false);
  assert.deepEqual(getCompanyAccess(registered, user.id), []);
  assert.throws(() => registerAgencyUser(registered, input, later), /redan/);
  const invited = inviteMember(registered, options({ personalNumber: input.personalNumber }), later);
  assert.equal(invited.invitations.at(-1).recipientId, user.id);
});

test('staff administration cannot disable owners, self, or colleagues from a different agency', () => {
  const state = createAgencyState();
  assert.throws(() => setAgencyUserActive(state, { actorId: 'user-jenny', userId: 'user-ake', active: false }, firstTime), /tillhör/);
  assert.throws(() => setAgencyUserActive(state, { actorId: 'user-jenny', userId: 'user-jenny', active: false }, firstTime), /eget/);
  assert.throws(() => setAgencyUserActive(state, { actorId: 'user-anki', userId: 'user-jenny', active: false }, firstTime), /administratör/);
  assert.throws(() => setAgencyUserActive(state, { actorId: 'user-jenny', userId: 'user-anki', active: 'false' }, firstTime), /giltig/);
});

test('invalid time and backward invitation history are rejected atomically', () => {
  const before = pending(['read']);
  assert.throws(() => acceptInvitation(before, { actorId: 'user-jenny', invitationId: firstId(before) }, { now: '2026-10-23T10:00:00.000Z' }));
  for (const now of ['', 'tomorrow', '2026-02-30T10:00:00.000Z', '2026-10-24']) {
    assert.throws(() => inviteMember(createAgencyState(), options(), { now }));
  }
  assert.equal(before.activity.length, 1);
  assert.equal(before.invitations[0].status, 'pending');
});

test('all mutations preserve originals and serialized audit evidence contains no personal numbers', () => {
  const original = createAgencyState(), before = JSON.stringify(original);
  let state = inviteMember(original, options({ permissions: ['bookkeeping'] }), firstTime);
  state = acceptInvitation(state, { actorId: 'user-jenny', invitationId: firstId(state) }, later);
  state = updatePermissions(state, { actorId: 'user-ake', invitationId: firstId(state), permissions: ['read'] }, later);
  assert.equal(JSON.stringify(original), before);
  assert.equal(validateAgencyState(JSON.parse(JSON.stringify(state))).invitations[0].status, 'accepted');
  for (const user of state.users) assert.equal(JSON.stringify(state.activity).includes(user.personalNumber), false);
  assert.deepEqual(state.activity.map(item => item.actorId), ['user-ake', 'user-jenny', 'user-ake']);
  const companies = getCompanyAccess(state, 'user-jenny');
  companies[0].name = 'Changed outside model';
  assert.equal(state.companies[0].name, 'Åkes Hantverk AB');
});

test('restore rejects forged grants, removed decisions, changed scopes, duplicate accounts and invalid references', () => {
  const source = accepted(['read']);
  const mutations = [
    state => { state.invitations[0].permissions.push('bookkeeping'); },
    state => { state.invitations[0].status = 'revoked'; },
    state => { state.activity.pop(); },
    state => { state.invitations[0].createdBy = 'user-bjork'; },
    state => { state.invitations[0].recipientId = 'user-anki'; },
    state => { state.invitations[0].agencyId = 'missing'; },
    state => { state.invitations[0].permissions.push('manage'); },
    state => { state.activity[1].actorId = 'user-anki'; },
    state => { state.users[3].personalNumber = state.users[2].personalNumber; },
    state => { state.users[3].id = state.users[2].id; },
    state => { state.users[3].active = false; },
    state => { state.agencies[0].adminIds = []; },
    state => { state.companies[0].ownerId = 'missing'; },
    state => { state.sequence = 0; },
    state => { state.activity[0].personalNumber = state.users[2].personalNumber; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(source); mutate(invalid);
    assert.throws(() => validateAgencyState(invalid));
  }
});

test('access queries deny unknown actors, companies and permissions without creating fallback rights', () => {
  const state = accepted(['read']);
  assert.equal(hasPermission(state, 'missing', 'company-ake', 'read'), false);
  assert.equal(hasPermission(state, 'user-jenny', 'missing', 'read'), false);
  assert.equal(hasPermission(state, 'user-ake', 'company-ake', 'root'), false);
  assert.deepEqual(getCompanyAccess(state, 'missing'), []);
  assert.throws(() => acceptInvitation(state, { actorId: 'user-jenny', invitationId: 'missing' }, later), /finns inte/);
  assert.throws(() => acceptInvitation(state, { actorId: 'user-jenny', invitationId: firstId(state) }, later), /väntande/);
});
