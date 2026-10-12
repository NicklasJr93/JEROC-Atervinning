import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const bundle = await build({ stdin: { contents: `
 export { sharedBusinessCacheKey } from './src/shared-data.ts';
 export { sharedOfficeRead, invalidateOfficeReads } from './src/office/shared-read.ts';
 export { setCurrentPlatformSession } from './src/platform/session.ts';
 export { mayManageSpiris } from './src/office/integration-permissions.ts';
 export { integrationReadScope } from './src/office/integration-read-cache.ts';
`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
const { sharedBusinessCacheKey, sharedOfficeRead, setCurrentPlatformSession, invalidateOfficeReads, mayManageSpiris, integrationReadScope } =
 await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const session = (organisationId, generation = 1) => ({
 enabled: true, authenticated: true, organisationId, generation,
 actor: { id: 'same-admin', platformAdmin: true }, actualUser: { id: 'admin' }, user: { id: 'vd' }, csrfToken: 'test',
});

test('office recovery keys separate companies, effective accounts and session generations', () => {
 const principal = { actor: 'admin', user: 'vd' };
 try {
  setCurrentPlatformSession(session('company-a'));
  const first = sharedBusinessCacheKey('office', principal);
  assert.notEqual(first, 'office');
  assert.notEqual(first, sharedBusinessCacheKey('office', { actor: 'admin', user: 'other' }));
  setCurrentPlatformSession(session('company-b'));
  assert.notEqual(first, sharedBusinessCacheKey('office', principal));
  setCurrentPlatformSession(session('company-a', 2));
  assert.notEqual(first, sharedBusinessCacheKey('office', principal));
  setCurrentPlatformSession(undefined);
  assert.equal(sharedBusinessCacheKey('office', principal), 'office');
 } finally { setCurrentPlatformSession(undefined); }
});

test('mobile employee recovery keys distinguish the same person ID in two companies', () => {
 const first = sharedBusinessCacheKey('mobile', { employee: 'niklas', companyId: 'company-a' });
 assert.notEqual(first, sharedBusinessCacheKey('mobile', { employee: 'niklas', companyId: 'company-b' }));
 assert.notEqual(first, sharedBusinessCacheKey('mobile', { employee: 'other', companyId: 'company-a' }));
 assert.equal(sharedBusinessCacheKey('mobile', { mobile: true }), 'mobile');
});

test('Spiris VD access requires explicit read and manage rights on both principals and all sites', () => {
 const admin = { id: 'admin', level: 'Systemadmin', permissions: [] };
 const vd = { id: 'vd', level: 'VD', permissions: ['integrationsRead', 'integrationsManage'] };
 assert.equal(mayManageSpiris(vd, vd), true);
 assert.equal(mayManageSpiris(vd, admin), true);
 assert.equal(mayManageSpiris({ ...vd, permissions: ['integrationsRead'] }, admin), false);
 assert.equal(mayManageSpiris(vd, { ...vd, permissions: [] }), false);
 assert.equal(mayManageSpiris({ ...vd, level: 'Medarbetare' }, admin), false);
 assert.equal(mayManageSpiris({ ...vd, siteIds: [] }, admin), false);
 assert.equal(mayManageSpiris(vd, { ...admin, siteIds: ['site-a'] }), false);
 assert.equal(mayManageSpiris(undefined, admin), false);
});

test('integration projection cache scope includes company and generation even with identical user IDs and module tokens', () => {
 const user = { id: 'vd', level: 'VD', permissions: ['integrationsRead', 'integrationsManage'] };
 const moduleSession = { actualUserId: 'vd', effectiveUserId: 'vd', csrfToken: 'same-fixture-token', expiresAt: '2026-10-12T12:00:00.000Z' };
 try {
  setCurrentPlatformSession(session('company-a'));
  const first = integrationReadScope(user, user, moduleSession);
  setCurrentPlatformSession(session('company-b'));
  assert.notEqual(first, integrationReadScope(user, user, moduleSession));
  setCurrentPlatformSession(session('company-a', 2));
  assert.notEqual(first, integrationReadScope(user, user, moduleSession));
 } finally { setCurrentPlatformSession(undefined); }
});

test('in-flight office reads never coalesce across company switches and invalidation uses the active scope', async () => {
 const oldWindow = globalThis.window;
 globalThis.window = { setTimeout, clearTimeout };
 try {
  let releaseA, releaseB, aLoads = 0, bLoads = 0;
  setCurrentPlatformSession(session('company-a'));
  const a = sharedOfficeRead('pricing:admin/vd:state', () => { aLoads++; return new Promise(resolve => { releaseA = resolve; }); });
  const aAgain = sharedOfficeRead('pricing:admin/vd:state', () => { throw new Error('read should coalesce inside one scope'); });
  await Promise.resolve();
  setCurrentPlatformSession(session('company-b'));
  const b = sharedOfficeRead('pricing:admin/vd:state', () => { bLoads++; return new Promise(resolve => { releaseB = resolve; }); });
  await Promise.resolve();
  assert.equal(aLoads, 1); assert.equal(bLoads, 1);
  invalidateOfficeReads('pricing:admin/vd:');
  const freshB = sharedOfficeRead('pricing:admin/vd:state', async () => ({ company: 'company-b', fresh: true }));
  releaseA({ company: 'company-a' }); releaseB({ company: 'company-b' });
  const results = await Promise.all([a, aAgain, b, freshB]);
  assert.deepEqual(results, [{ company: 'company-a' }, { company: 'company-a' }, { company: 'company-b' }, { company: 'company-b', fresh: true }]);
  assert.notEqual(results[0], results[1]);
 } finally {
  setCurrentPlatformSession(undefined);
  if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
 }
});
