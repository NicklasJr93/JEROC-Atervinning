import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createStaffInvitations, validateStaffInvitationTarget } from './staff-invitations.mjs';
import { createSystemEmail } from './system-email.mjs';

const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PRIVATE = 'Private-Temporary-Password-2026!';
function memory(initial) {
  let value = clone(initial), tail = Promise.resolve();
  return {
    async read(operation) { await tail; return operation(clone(value)); },
    transact(operation) { const run = tail.then(async () => { const next = clone(value), result = await operation(next); value = next; return result; }); tail = run.catch(() => {}); return run; },
  };
}
function fixture() {
  let time = Date.now(), rejected = false;
  const admin = { id: 'admin', name: 'Manager', level: 'VD', permissions: [], active: true, siteIds: ['main'] };
  const context = { actorId: 'admin-platform', effectiveUserId: 'admin', generation: 'one', organisationId: 'company-a',
    company: { id: 'company-a', name: 'Återvinning AB' }, actualUser: admin, user: admin };
  const repository = memory({ users: [], memberships: [], sessions: [], audit: [], passwordRecovery: { requests: [], attempts: [] } });
  const business = memory({ pricing: { users: [admin, { id: 'staff-user', name: 'Alma', active: true, level: 'Medarbetare', permissions: ['view'], siteIds: ['main'] }] },
    personnel: { people: [{ id: 'person-alma', name: 'Alma', kind: 'employee', userId: 'staff-user', active: true, email: 'Alma@example.test', siteIds: ['main'] }], externalAccounts: [] },
    personnelAuth: { accounts: [], sessions: [] } });
  const requests = [];
  const email = createSystemEmail({ env: { RESEND_API_KEY: 'private-fixture-key', APP_URL: 'https://app.scrapplanner.com' },
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify(rejected ? { message: 'PRIVATE-PROVIDER-DETAIL' } : { id: randomUUID() }), { status: rejected ? 403 : 200 }); } });
  const auth = { repository, initialize: async () => {}, resolveContext: async () => clone(context),
    assertCompanyContext: () => {},
    passwordRecoveryCandidate: (state, address) => {
      const user = state.users.find(value => value.email === address && value.active);
      return user && { userId: user.id, fingerprint: digest({ id: user.id, email: user.email, password: user.password }), recipient: user.email };
    },
  };
  const service = createStaffInvitations({ auth, repository, email, companyRepository: async () => business,
    env: { APP_URL: 'https://app.scrapplanner.com' }, now: () => new Date(time++) });
  return { service, repository, business, requests, context, req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    rejectProvider: value => { rejected = value; }, advance: value => { time += value; } };
}

test('service produces a real adapter-valid invitation, exact24h expiry, trusted hash link and one provider call per request', async () => {
  const f = fixture(), requestId = randomUUID();
  const result = await f.service.send({ personId: 'person-alma', requestId }, f.req);
  assert.equal(result.ok, true); assert.equal(result.email, 'alma@example.test'); assert.equal(result.personId, 'person-alma');
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].to, ['alma@example.test']);
  assert.equal(f.requests[0].from, 'ScrapPlanner <noreply@scrapplanner.com>');
  assert.match(f.requests[0].text, /https:\/\/app\.scrapplanner\.com\/kontor\/#\/activate-account\?token=[A-Za-z0-9_-]{43}/);
  const state = await f.repository.read(value => value), record = state.passwordRecovery.requests[0];
  assert.equal(Date.parse(record.expiresAt) - Date.parse(record.createdAt), 86_400_000);
  assert.ok(!JSON.stringify(state).includes(f.requests[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1]));
  assert.deepEqual(await f.service.send({ personId: 'person-alma', requestId }, f.req), result); assert.equal(f.requests.length, 1);
  const tenant = await f.business.read(value => value);
  assert.equal(tenant.personnelAuth.accounts[0].active, false);
  assert.equal((await f.service.read('person-alma', f.req)).status, 'sent');
  validateStaffInvitationTarget(tenant, record.staffInvitationTarget);
});

test('manual password retry is idempotent only for the same password and never sends mail', async () => {
  const f = fixture(), requestId = randomUUID(), command = { personId: 'person-alma', requestId, password: PRIVATE };
  const result = await f.service.temporaryPassword(command, f.req);
  assert.equal(result.status, 'temporary_password'); assert.equal(result.username, 'alma@example.test');
  const original = await f.repository.read(value => value.users[0].password);
  assert.deepEqual(await f.service.temporaryPassword(command, f.req), result);
  assert.deepEqual(await f.repository.read(value => value.users[0].password), original);
  await assert.rejects(f.service.temporaryPassword({ ...command, password: `${PRIVATE}different` }, f.req), value => value.code === 'staff_invitation_in_progress');
  assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify(await f.repository.read(value => value)).includes(PRIVATE));
  assert.ok(!JSON.stringify(await f.business.read(value => value)).includes(PRIVATE));
});

test('provider rejection remains failed and a fresh attempt can send without granting early employee access', async () => {
  const f = fixture(); f.rejectProvider(true);
  await assert.rejects(f.service.send({ personId: 'person-alma', requestId: randomUUID() }, f.req), value => value.code === 'staff_invitation_send_failed');
  assert.equal((await f.service.read('person-alma', f.req)).status, 'failed');
  assert.equal(await f.business.read(value => value.personnelAuth.accounts[0].active), false);
  f.rejectProvider(false);
  assert.equal((await f.service.send({ personId: 'person-alma', requestId: randomUUID() }, f.req)).status, 'sent');
  const records = await f.repository.read(value => value.passwordRecovery.requests);
  assert.equal(records[0].status, 'superseded'); assert.equal(records[1].status, 'sent');
});

test('email, scope, identity and credential changes invalidate pending proof while live permissions remain separate', async () => {
  const f = fixture(); await f.service.send({ personId: 'person-alma', requestId: randomUUID() }, f.req);
  const target = await f.repository.read(value => value.passwordRecovery.requests[0].staffInvitationTarget);
  const original = await f.business.read(value => value);
  const changes = [value => { value.personnel.people[0].email = 'changed@example.test'; }, value => { value.personnel.people[0].active = false; },
    value => { value.pricing.users[1].siteIds = ['other']; }, value => { value.personnel.people[0].userId = 'another'; },
    value => { value.personnelAuth.accounts[0].active = true; }, value => { value.personnelAuth.accounts[0].updatedAt = 'changed'; }];
  for (const change of changes) { const next = clone(original); change(next); assert.throws(() => validateStaffInvitationTarget(next, target), value => value.code === 'staff_invitation_changed'); }
  const permissions = clone(original); permissions.pricing.users[1].permissions.push('personnelRead');
  assert.doesNotThrow(() => validateStaffInvitationTarget(permissions, target));
  await f.business.transact(value => { value.personnel.people[0].email = 'changed@example.test'; });
  assert.equal((await f.service.read('person-alma', f.req)).status, 'failed');
});

test('resend supersedes the previous proof, status expires, and conflicts never overwrite another identity', async () => {
  const f = fixture(); const first = await f.service.send({ personId: 'person-alma', requestId: randomUUID() }, f.req);
  await f.service.send({ personId: 'person-alma', requestId: randomUUID() }, f.req);
  const records = await f.repository.read(value => value.passwordRecovery.requests);
  assert.equal(records[0].status, 'superseded'); assert.equal(records[1].status, 'sent');
  assert.notEqual(records[0].tokenHash, records[1].tokenHash);
  f.advance(86_400_001); assert.equal((await f.service.read('person-alma', f.req)).status, 'expired');
  const other = fixture(); await other.repository.transact(value => value.users.push({ id: 'existing', email: first.email, username: 'different', active: false }));
  await assert.rejects(other.service.send({ personId: 'person-alma', requestId: randomUUID() }, other.req), value => value.code === 'staff_invitation_email_conflict');
  assert.equal(await other.business.read(value => value.personnelAuth.accounts.length), 0);
});

async function delegatedFixture() {
  const f=fixture(), manager={...f.context.actualUser,level:'Medarbetare',permissions:['view','personnelRead','personnelWrite','users'],maxAttest:100,ownAttest:false};
  f.context.actualUser=clone(manager);f.context.user=clone(manager);
  await f.business.transact(state=>{state.pricing.users[0]=clone(manager);});
  return f;
}
test('explicitly delegated staff can invite an ordinary in-scope account without granting it delegation',async()=>{
  const f=await delegatedFixture();
  const result=await f.service.send({personId:'person-alma',requestId:randomUUID()},f.req);
  assert.equal(result.status,'sent');assert.equal(f.requests.length,1);
  assert.deepEqual(await f.business.read(state=>state.pricing.users[1].permissions),['view']);
  assert.equal((await f.service.read('person-alma',f.req)).status,'sent');
});
test('delegated invitations enforce both live identities and reject privileged, self and stronger targets before sending',async()=>{
  const changes=[
    state=>{state.pricing.users[1].level='VD';},
    state=>{state.pricing.users[1].level='Systemadmin';},
    state=>{state.pricing.users[1].permissions.push('users');},
    state=>{state.pricing.users[1].permissions.push('salaryRead');},
    state=>{state.pricing.users[1].maxAttest=101;},
    state=>{state.pricing.users[1].ownAttest=true;},
    state=>{state.pricing.users[1].siteIds=['other'];},
    state=>{state.personnel.people[0].userId='admin';},
    state=>{state.pricing.users[0].permissions=state.pricing.users[0].permissions.filter(right=>right!=='users');},
  ];
  for(const change of changes){const f=await delegatedFixture();await f.business.transact(change);
    await assert.rejects(f.service.send({personId:'person-alma',requestId:randomUUID()},f.req),error=>error.status===403);
    assert.equal(f.requests.length,0);assert.equal(await f.business.read(state=>state.personnelAuth.accounts.length),0);
  }
  const f=await delegatedFixture();f.context.user={id:'weaker',level:'Medarbetare',permissions:['view','personnelRead'],active:true,siteIds:['main']};
  await f.business.transact(state=>state.pricing.users.push(clone(f.context.user)));
  await assert.rejects(f.service.temporaryPassword({personId:'person-alma',requestId:randomUUID(),password:PRIVATE},f.req),error=>error.status===403);
  assert.equal(f.requests.length,0);
});
