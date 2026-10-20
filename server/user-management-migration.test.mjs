import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateUserManagementDelegation } from './user-management-migration.mjs';

test('historically inert users bits cannot become delegation during an upgrade', () => {
  const users = [
    { id: 'employee', level: 'Medarbetare', permissions: ['view', 'users', 'personnelWrite'] },
    { id: 'owner', level: 'VD', permissions: ['users'] },
    { id: 'admin', level: 'Systemadmin', permissions: ['users'] },
  ];
  const state = { metadata: {}, pricing: { users: structuredClone(users) }, office: { users: structuredClone(users) } };
  assert.equal(migrateUserManagementDelegation(state), true);
  assert.deepEqual(state.pricing.users[0].permissions, ['view', 'personnelWrite']);
  assert.deepEqual(state.office.users[0].permissions, ['view', 'personnelWrite']);
  assert.deepEqual(state.pricing.users.slice(1), users.slice(1));
  assert.equal(state.metadata.userManagementDelegationVersion, 1);
  assert.equal(state.metadata.userManagementDelegationMigration.removedLegacyGrants, 1);
  // An explicit grant after migration remains an active grant after restart.
  state.pricing.users[0].permissions.push('users');
  const persisted = structuredClone(state);
  assert.equal(migrateUserManagementDelegation(state), false);
  assert.deepEqual(state, persisted);
});
