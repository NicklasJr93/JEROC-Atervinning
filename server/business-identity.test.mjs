import assert from 'node:assert/strict';
import { test } from 'node:test';
import { principalOwnsUser, withBusinessIdentity } from './business-identity.mjs';

const principal = (actor = '__platform-admin', user = actor) => ({ actor: { id: actor }, user: { id: user } });
const trusted = user => ({ organisationId: 'jeroc-demo', platformAdmin: true,
  actualUser: { id: '__platform-admin' }, user: { id: user }, credentialBusinessId: 'admin' });

test('human ownership survives impersonation but cannot follow another principal or grant client supplied aliases', async () => {
  await withBusinessIdentity(trusted('anna'), async () => {
    assert.equal(principalOwnsUser(principal('__platform-admin', 'anna'), 'admin'), true);
    assert.equal(principalOwnsUser(principal('__platform-admin', 'anna'), 'anna'), true);
    assert.equal(principalOwnsUser(principal('__platform-admin', 'anna'), '__platform-admin'), true);
    assert.equal(principalOwnsUser(principal('__platform-admin', 'kajsa'), 'admin'), false);
    assert.equal(principalOwnsUser(principal('someone-else', 'anna'), 'admin'), false);
    assert.equal(principalOwnsUser({ ...principal('__platform-admin', 'anna'), selfBusinessUserIds: ['kajsa'] }, 'kajsa'), false);
  });
  assert.equal(principalOwnsUser(principal(), 'admin'), false);
});

test('overlapping tenant requests and nested untrusted scopes do not inherit the JEROC human alias', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const active = new Promise(resolve => { entered = resolve; });
  const request = withBusinessIdentity(trusted('__platform-admin'), async () => {
    entered(); await gate;
    assert.equal(principalOwnsUser(principal(), 'admin'), true);
    await withBusinessIdentity({ ...trusted('__platform-admin'), organisationId: 'another-company' }, async () => {
      assert.equal(principalOwnsUser(principal(), 'admin'), false);
    });
    assert.equal(principalOwnsUser(principal(), 'admin'), true);
  });
  await active;
  await withBusinessIdentity(undefined, async () => {
    await Promise.resolve();
    assert.equal(principalOwnsUser(principal(), 'admin'), false);
  });
  release(); await request;
  assert.equal(principalOwnsUser(principal(), 'admin'), false);
});
