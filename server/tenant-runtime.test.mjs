import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { tenantRuntimeEnvironment, tenantInitialSites, createTenantApplicationState } from './tenant-runtime.mjs';
import { createApplicationService, initialApplicationState } from './application.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore, environmentHash } from './environment-model.mjs';
import { createTerminalDemoRepository } from './terminal-demo-storage.mjs';
import { createMobilePricingProjection } from './mobile-pricing-projection.mjs';
import { officeSchema, migrateOffice, transportSchema } from '../dist-server/domain-models.mjs';

const tenant = { id: 'company-test-a', name: 'Bolag A', storageSchema: 'jeroc_t_0123456789abcdef0123456789abcdef' };
const salt = '0123456789abcdef'.repeat(3);
const owner = { id: 'owner-test-a', personId: 'person-owner-test-a', name: 'Ny VD', username: 'new.owner',
  passwordHash: { salt, digest: scryptSync('Unique fixture secret!', salt, 64).toString('hex') }, mustChangePassword: true };
const seed = () => createTenantApplicationState({ tenant, owner, now: '2026-10-12T10:00:00Z' });
const postgresUrl = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;

test('tenant schema selection is fail-closed and preserves legacy JEROC storage', () => {
  const base = { DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/jeroc?options=-c%20search_path%3Dpublic',
    JEROC_APPLICATION_DB_PATH: '/legacy/business.sqlite', JEROC_ENVIRONMENT_DB_PATH: '/legacy/environment.sqlite',
    VISMA_CLIENT_ID: 'shared-client', VISMA_CLIENT_SECRET: 'shared-secret', VISMA_TOKEN_ENCRYPTION_KEY: 'shared-key',
    VISMA_SANDBOX_COMPANY_ID: 'jeroc-company', VISMA_TENANT_COMPANY_ID: 'other-company', NVV_CLIENT_SECRET: 'jeroc-secret',
    NVV_CLIENT_PFX_SECRET_FILE: '/jeroc/certificate', JEROC_DEMO_AUTO_SESSION: 'true' };
  const scoped = tenantRuntimeEnvironment(base, tenant);
  assert.equal(new URL(scoped.DATABASE_URL).searchParams.get('options'), `-c search_path=${tenant.storageSchema}`);
  assert.equal(scoped.VISMA_CLIENT_ID, base.VISMA_CLIENT_ID);
  assert.equal(scoped.VISMA_CLIENT_SECRET, base.VISMA_CLIENT_SECRET);
  assert.equal(scoped.VISMA_TOKEN_ENCRYPTION_KEY, base.VISMA_TOKEN_ENCRYPTION_KEY);
  for (const key of ['VISMA_SANDBOX_COMPANY_ID', 'VISMA_TENANT_COMPANY_ID', 'NVV_CLIENT_SECRET', 'NVV_CLIENT_PFX_SECRET_FILE']) assert.equal(scoped[key], undefined);
  assert.equal(scoped.JEROC_DEMO_AUTO_SESSION, 'false');
  assert.equal(scoped.SCRAPPILOT_ORGANISATION_ID, tenant.id);
  assert.equal(base.NVV_CLIENT_SECRET, 'jeroc-secret');
  const legacy = tenantRuntimeEnvironment(base, { id: 'jeroc-demo' });
  for (const [key, value] of Object.entries(base)) assert.equal(legacy[key], value);
  for (const storageSchema of [undefined, 'public', `${tenant.storageSchema},public`, `${tenant.storageSchema} -c role=admin`])
    assert.throws(() => tenantRuntimeEnvironment(base, { ...tenant, storageSchema }), /databasschema/);
  assert.throws(() => tenantRuntimeEnvironment({}, { id: '../outside' }), /servervalt ID/);
});

test('all local databases use tenant-specific files and never inherit JEROC paths', () => {
  const base = { JEROC_TENANT_DATA_DIR: '/tmp/tenant-test-data', JEROC_APPLICATION_DB_PATH: '/legacy/application.sqlite' };
  const a = tenantRuntimeEnvironment(base, tenant), b = tenantRuntimeEnvironment(base, { ...tenant, id: 'company-test-b' });
  for (const key of ['JEROC_APPLICATION_DB_PATH', 'JEROC_ENVIRONMENT_DB_PATH', 'JEROC_TERMINAL_DB_PATH', 'JEROC_DOCUMENT_DB_PATH', 'JEROC_ARTICLE_MEDIA_DB_PATH']) {
    assert.ok(a[key].startsWith('/tmp/tenant-test-data/tenants/company-test-a/'));
    assert.ok(b[key].startsWith('/tmp/tenant-test-data/tenants/company-test-b/'));
    assert.notEqual(a[key], b[key]);
  }
});

test('a blank company retains only its own VD and no business or demo fixture', () => {
  const state = seed();
  assert.deepEqual(state.office.users.map(value => value.id), [owner.id]);
  assert.deepEqual(state.pricing.users.map(value => value.id), [owner.id]);
  assert.equal(state.office.users[0].level, 'VD');
  assert.deepEqual(state.personnel.people.map(value => value.id), [owner.personId]);
  assert.equal(state.personnelAuth.accounts[0].active, false);
  assert.deepEqual(state.personnelAuth.accounts[0].password, owner.passwordHash);
  assert.equal(state.personnel.externalAccounts[0].password, undefined);
  assert.equal(state.metadata.mobileEmployeeSeedVersion, 2);
  assert.equal(state.metadata.organisation.id, tenant.id);
  for (const collection of ['cards', 'customers', 'payments', 'corrections']) assert.deepEqual(state.office[collection], []);
  for (const collection of ['lme', 'articleHistory', 'groups', 'customerPrices', 'customers', 'snapshots', 'ledger', 'audit']) assert.deepEqual(state.pricing[collection], []);
  for (const collection of ['orders', 'drivers', 'vehicles', 'events']) assert.deepEqual(state.transport[collection], []);
  for (const collection of ['companies', 'employment', 'salaries', 'schedules', 'absences', 'competencies', 'staffingTasks', 'audit']) assert.deepEqual(state.personnel[collection], []);
  assert.deepEqual(state.employeeTime.entries, []);
  assert.deepEqual(state.logistics.vessels, []);
  assert.deepEqual(state.logistics.agreements, []);
  assert.deepEqual(state.logistics.deliveryOutbox, []);
  assert.deepEqual(state.outbox, []);
  assert.deepEqual(state.imports, []);
  assert.deepEqual(state.mobile, { version: 1, drafts: [], customers: [] });
  assert.deepEqual(migrateOffice(state.office).cards, []);
  assert.deepEqual(officeSchema.parse(state.office).customers, []);
  assert.deepEqual(transportSchema.parse(state.transport).orders, []);
  const catalog = createMobilePricingProjection()(state.pricing);
  assert.deepEqual(catalog.catalog, []); assert.deepEqual(catalog.groups, []); assert.deepEqual(catalog.customerPrices, {});
  const different = seed(); state.office.users[0].name = 'Changed';
  assert.equal(different.office.users[0].name, owner.name);
  assert.throws(() => createTenantApplicationState({ tenant: { id: 'jeroc-demo' }, owner }), /befintliga/);
  assert.equal(createTenantApplicationState({ tenant, owner: { ...owner, username: 'vd+company@example.test' } }).personnelAuth.accounts[0].username, 'vd+company@example.test');
});

test('first application/environment/terminal startup does not inject known demo accounts or business rows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-tenant-start-'));
  const env = tenantRuntimeEnvironment({ JEROC_TENANT_DATA_DIR: directory }, tenant);
  const app = createApplicationService({ env, seed });
  let environment, terminals;
  t.after(async () => { await app.close(); await environment?.close(); await terminals?.close(); await rm(directory, { recursive: true, force: true }); });
  const business = await app.getRepository();
  const saved = await business.read(state => state);
  assert.deepEqual(saved.office.cards, []);
  assert.deepEqual(saved.office.customers, []);
  assert.deepEqual(saved.pricing.articleHistory, []);
  assert.deepEqual(saved.pricing.groups, []);
  assert.deepEqual(saved.transport.orders, []);
  assert.deepEqual(saved.personnel.people.map(value => value.id), [owner.personId]);
  assert.deepEqual(saved.personnelAuth.accounts.map(value => value.username), [owner.username]);
  assert.equal(saved.personnelAuth.accounts[0].active, false);
  environment = await createEnvironmentRepository({ env });
  const store = createEnvironmentStore({ repository: environment, principalStore: app.principalStore, demoMode: false,
    initialSites: tenantInitialSites(tenant), nvvClient: {} });
  await store.initialize();
  const environmental = await environment.read(state => state);
  assert.deepEqual(environmental.siteRecords.map(value => value.id), ['main']);
  assert.deepEqual(environmental.credentials, []);
  assert.deepEqual(environmental.classifications, []);
  for (const key of ['receipts', 'inventory', 'reports', 'requests', 'nvvJobs', 'nvvReports', 'nvvSettings']) assert.deepEqual(environmental[key], []);
  terminals = await createTerminalDemoRepository({ env });
  const terminalState = await terminals.read(state => state);
  for (const key of ['terminals', 'approvals', 'staffSessions', 'terminalSessions', 'requests', 'audit']) assert.deepEqual(terminalState[key], []);
  const existing = initialApplicationState();
  assert.ok(existing.office.cards.length > 0);
  assert.ok(existing.office.customers.length > 0);
  assert.ok(existing.pricing.articleHistory.length > 0);
});

test('a verified platform identity replaces demo cookies and still checks fresh rights, expected identity and CSRF', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-tenant-session-'));
  const env = tenantRuntimeEnvironment({ JEROC_TENANT_DATA_DIR: directory }, tenant);
  const app = createApplicationService({ env, seed });
  const repository = await createEnvironmentRepository({ env });
  t.after(async () => { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const store = createEnvironmentStore({ repository, principalStore: app.principalStore, demoMode: false,
    initialSites: tenantInitialSites(tenant), now: () => new Date('2026-10-12T10:00:00Z'),
    nvvClient: { status: async () => ({ mode: 'disabled', configured: false, connected: false }) } });
  const trusted = { actorId: owner.id, userId: owner.id, csrfToken: 'verified-platform-csrf', expiresAt: '2026-10-12T18:00:00Z' };
  const withIdentity = (expected, operation) => store.withRequest({ trustedPrincipal: trusted, ...expected }, operation);
  const current = await withIdentity({}, () => store.session());
  assert.equal(current.demo, false);
  assert.equal(current.actualUserId, owner.id);
  assert.equal(current.csrfToken, trusted.csrfToken);
  assert.deepEqual((await repository.read(state => state.sessions)), []);
  assert.deepEqual((await withIdentity({ requireCsrf: true, csrfToken: trusted.csrfToken }, () => store.state())).sites.map(value => value.id), ['main']);
  await assert.rejects(withIdentity({ actualUserId: 'admin' }, () => store.session()), error => error.status === 403 && error.code === 'session_identity_mismatch');
  await assert.rejects(withIdentity({ requireCsrf: true, csrfToken: 'wrong' }, () => store.session()), error => error.status === 403 && error.code === 'csrf_required');
  await assert.rejects(store.session(), error => error.status === 401);
  await repository.transact(state => state.sessions.push({ tokenHash: environmentHash('old-environment-cookie'),
    actualUserId: owner.id, effectiveUserId: owner.id, csrfToken: 'old-csrf', expiresAt: trusted.expiresAt }));
  await assert.rejects(store.withRequest({ token: 'old-environment-cookie', trustedPrincipal: { ...trusted, expiresAt: '2026-10-12T09:00:00Z' } },
    () => store.session('old-environment-cookie')), error => error.status === 401);
  const business = await app.getRepository();
  await business.transact(state => { state.pricing.users[0].active = false; });
  await assert.rejects(withIdentity({}, () => store.session()), error => error.status === 401 && error.code === 'session_revoked');
});

test('PostgreSQL tenant schema bundles isolate identical domain keys and absent schema never falls back', { skip: !postgresUrl }, async t => {
  const { Pool } = await import('pg');
  const provisioner = new Pool({ connectionString: postgresUrl });
  const companies = ['a', 'b'].map(suffix => ({ ...tenant, id: `isolated-${suffix}`, storageSchema: `jeroc_t_${randomUUID().replaceAll('-', '')}` }));
  const instances = [];
  t.after(async () => {
    for (const instance of instances) await instance.close();
    for (const company of companies) await provisioner.query(`DROP SCHEMA IF EXISTS "${company.storageSchema}" CASCADE`);
    await provisioner.end();
  });
  for (const company of companies) {
    await provisioner.query(`CREATE SCHEMA "${company.storageSchema}"`);
    const instance = createApplicationService({ env: tenantRuntimeEnvironment({ DATABASE_URL: postgresUrl }, company),
      seed: () => createTenantApplicationState({ tenant: company, owner }) });
    instances.push(instance);
    const repository = await instance.getRepository();
    await repository.transact(state => { state.metadata.savedByCompany = company.id; });
  }
  for (let index = 0; index < instances.length; index++) {
    const repository = await instances[index].getRepository();
    const state = await repository.read(state => state);
    assert.equal(state.metadata.savedByCompany, companies[index].id);
    assert.equal(state.metadata.organisation.id, companies[index].id);
    assert.deepEqual(state.office.cards, []);
    assert.deepEqual(state.personnelAuth.accounts.map(value => value.username), [owner.username]);
  }
  const absent = { ...tenant, id: 'absent-company', storageSchema: `jeroc_t_${randomUUID().replaceAll('-', '')}` };
  const missing = createApplicationService({ env: tenantRuntimeEnvironment({ DATABASE_URL: postgresUrl }, absent), seed });
  instances.push(missing);
  await assert.rejects(missing.getRepository(), error => error.code === '3F000');
});
