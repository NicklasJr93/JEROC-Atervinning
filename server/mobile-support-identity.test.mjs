import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachPlatformContext } from './platform-auth.mjs';
import { attachMobileSupport, mobileSupportIdentity, mobileSupportPrincipal } from './mobile-support-identity.mjs';

test('headers cannot create mobile support and a mismatched trusted context cannot reuse it', () => {
  const req = { headers: { 'x-platform-admin': 'true', 'x-demo-user': '__platform-admin' } };
  assert.equal(mobileSupportIdentity(req), undefined);
  const context = { platformAdmin: true, organisationId: 'alpha', user: { id: '__platform-admin' }, actualUser: { id: '__platform-admin' } };
  const session = { actor: { platformAdmin: true }, organisationId: 'alpha', mustChangePassword: false };
  attachPlatformContext(req, context); assert.equal(attachMobileSupport(req, context, session), true);
  assert.ok(mobileSupportIdentity(req));
  attachPlatformContext(req, { ...context, organisationId: 'beta' }); assert.equal(mobileSupportIdentity(req), undefined);
});

test('support principal uses current registered rights and never writes a personnel profile', () => {
  const req = { headers: {} }, principal = { id: '__platform-admin', name: 'Systemadmin', level: 'Systemadmin', active: true, permissions: ['view', 'prepare'], siteIds: ['alpha-site'] };
  const context = { platformAdmin: true, organisationId: 'alpha', user: principal, actualUser: principal, sessionKey: 'private-hash', expiresAt: '2026-10-21T12:00:00.000Z' };
  const session = { actor: { platformAdmin: true, username: 'admin', name: 'Actual administrator' }, organisationId: 'alpha', mustChangePassword: false };
  attachPlatformContext(req, context); attachMobileSupport(req, context, session);
  const state = { pricing: { users: [principal] }, personnel: { people: [], employment: [], salaries: [], schedules: [] }, personnelAuth: { accounts: [], sessions: [] },
    logistics: { sites: [{ id: 'alpha-site', active: true }, { id: 'beta-site', active: true }] } };
  const before = structuredClone(state), result = mobileSupportPrincipal(state, req);
  assert.deepEqual(result.person.siteIds, ['alpha-site']); assert.equal(result.person.name, 'Actual administrator');
  assert.deepEqual(result.principal.user.permissions, ['view', 'prepare']); assert.deepEqual(state, before);
  principal.active = false; assert.equal(mobileSupportPrincipal(state, req), undefined);
});
