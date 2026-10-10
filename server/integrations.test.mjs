import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntegrationEngine, createNvvIntegrationAdapter, assertSamePreparedEvent, integrationProviders } from './integrations.mjs';

const context = (organisationId = 'jeroc-demo', manage = true) => ({ organisationId, allowedOrganisationIds: [organisationId], actorId: 'admin', effectiveUserId: 'admin', canRead: true, canManage: manage });
const error = (status) => failure => failure.status === status;

test('catalog exposes stable planned cards and no fabricated connection, token or OAuth URL', async () => {
  const engine = createIntegrationEngine(), catalog = await engine.catalog(context());
  assert.deepEqual(catalog.providers.map(p => p.id), ['nvv', 'visma', 'fortnox', 'microsoft365', 'bankid', 'messaging', 'google-maps', 'lme']);
  assert.equal(new Set(integrationProviders.map(p => p.id)).size, 8);
  for (const provider of catalog.providers) { assert.equal(provider.status, 'planned'); assert.equal(provider.connected, false); assert.equal(provider.implemented, false); assert.equal(provider.capabilities.canConnect, false); assert.equal(provider.capabilities.canConfigure, false); assert.deepEqual(provider.links, {}); }
  assert.throws(() => engine.prepareEvent('visma', { type: 'settlement.attested' }, context()), error(501));
  await assert.rejects(engine.check('visma', context()), error(501));
});

test('catalog scopes every adapter call to the authenticated organisation and rejects untrusted membership or permissions', async () => {
  const seen = [], engine = createIntegrationEngine({ adapters: [{ providerId: 'nvv', status: scope => { seen.push(scope); return { mode: 'test', configured: true, connected: scope.organisationId === 'org-a', token: 'SECRET-A', reporter: { personalNumber: 'PRIVATE' } }; } }] });
  const [a, b] = await Promise.all([engine.catalog(context('org-a')), engine.catalog(context('org-b'))]);
  assert.equal(a.providers[0].connected, true);assert.equal(b.providers[0].connected, false);
  assert.deepEqual(seen.map(s => s.organisationId).sort(), ['org-a', 'org-b']);assert.ok(seen.every(s => Object.isFrozen(s) && Object.isFrozen(s.allowedOrganisationIds) && s.allowedOrganisationIds.length === 1));
  assert.ok(!JSON.stringify(a).includes('SECRET-A'));assert.ok(!JSON.stringify(a).includes('PRIVATE'));
  await assert.rejects(engine.catalog({ ...context('org-a'), organisationId: 'org-b' }), error(403));
  await assert.rejects(engine.catalog({ ...context(), canRead: false }), error(403));
  await assert.rejects(engine.catalog(undefined), error(401));
  await assert.rejects(engine.detail('unknown', context()), error(404));
});

test('NVV adapter delegates existing status/check and safely distinguishes test, simulation and production-disabled', async () => {
  let state = { mode: 'test', configured: true, connected: false, clientSecret: 'SECRET', lastCheck: null }, checks = 0;
  const adapter = createNvvIntegrationAdapter({ status: () => state, check: scope => { checks++; assert.equal(scope.organisationId, 'jeroc-demo'); state = { ...state, connected: true, lastCheck: { connected: true, checkedAt: '2026-10-10T11:00:00Z', response: 'TOKEN' } }; } });
  const engine = createIntegrationEngine({ adapters: [adapter] });
  assert.equal((await engine.detail('nvv', context())).status, 'not-verified');
  const result = await engine.check('nvv', context());assert.equal(result.status, 'connected');assert.equal(result.mode, 'test');assert.equal(result.lastCheckedAt, '2026-10-10T11:00:00Z');assert.equal(checks, 1);assert.ok(!JSON.stringify(result).includes('TOKEN'));assert.ok(!JSON.stringify(result).includes('SECRET'));
  state = { mode: 'mock', configured: true, connected: true };const mock = await engine.detail('nvv', context());assert.equal(mock.mode, 'mock');assert.equal(mock.connected, false);assert.equal(mock.status, 'not-verified');
  state = { mode: 'production', configured: true, connected: true };const production = await engine.detail('nvv', context());assert.equal(production.mode, 'disabled');assert.equal(production.connected, false);
  await assert.rejects(engine.check('nvv', context()), error(409));assert.equal(checks, 1);
});

test('read-only sessions can inspect catalog but cannot call checks or prepare events; adapter failures do not leak details', async () => {
  let checked = false;
  const engine = createIntegrationEngine({ adapters: [{ providerId: 'nvv', status: () => { throw Error('password=SECRET'); }, check: () => { checked = true; throw Error('token=SECRET'); }, supportedEvents: ['report.ready'] }] });
  const catalog = await engine.catalog(context('jeroc-demo', false));assert.equal(catalog.providers[0].status, 'error');assert.equal(catalog.providers[0].capabilities.canConfigure, false);assert.equal(catalog.providers[0].capabilities.canCheck, false);assert.ok(!JSON.stringify(catalog).includes('SECRET'));
  await assert.rejects(engine.check('nvv', context('jeroc-demo', false)), error(403));assert.equal(checked, false);
  assert.throws(() => engine.prepareEvent('nvv', { type: 'report.ready' }, context('jeroc-demo', false)), error(403));
  await assert.rejects(engine.check('nvv', context()), failure => failure.status === 502 && !failure.message.includes('SECRET'));
});

test('existing single-organisation NVV adapter cannot expose its connection to a different future tenant', async () => {
  let statuses = 0, checks = 0;
  const adapter = createNvvIntegrationAdapter({ organisationId: 'jeroc-demo', status: () => { statuses++; return { mode: 'test', configured: true, connected: true }; }, check: () => { checks++; } });
  const engine = createIntegrationEngine({ adapters: [adapter] });
  const other = await engine.catalog(context('future-tenant'));assert.equal(other.providers[0].status, 'disabled');assert.equal(other.providers[0].configured, false);assert.equal(other.providers[0].connected, false);assert.equal(other.providers[0].capabilities.canConfigure, false);assert.deepEqual(other.providers[0].links, {});assert.equal(statuses, 0);
  await assert.rejects(engine.check('nvv', context('future-tenant')), error(403));assert.equal(checks, 0);
  const own = await engine.detail('nvv', context());assert.equal(own.status, 'connected');assert.equal(statuses, 1);
});

test('prepared events are stable across JSON order, isolated by organisation, and never dispatch', () => {
  let called = false;
  const engine = createIntegrationEngine({ adapters: [{ providerId: 'nvv', status: () => ({}), supportedEvents: ['report.ready'], dispatch: () => { called = true; } }], now: () => new Date('2026-10-10T11:00:00Z') });
  const event = { id: 'event-1', aggregateId: 'receipt-1', type: 'report.ready', version: 1, payload: { weight: 10, article: { name: 'Blybatterier', code: '160601' } } };
  const first = engine.prepareEvent('nvv', event, context('org-a'));
  const retry = engine.prepareEvent('nvv', { ...event, payload: { article: { code: '160601', name: 'Blybatterier' }, weight: 10 } }, context('org-a'));
  assert.equal(first.idempotencyKey, retry.idempotencyKey);assert.equal(first.payloadHash, retry.payloadHash);assert.equal(assertSamePreparedEvent(first, retry), first);
  const other = engine.prepareEvent('nvv', event, context('org-b'));assert.notEqual(first.idempotencyKey, other.idempotencyKey);
  const nextVersion = engine.prepareEvent('nvv', { ...event, version: 2 }, context('org-a'));assert.notEqual(first.idempotencyKey, nextVersion.idempotencyKey);
  const changed = engine.prepareEvent('nvv', { ...event, payload: { weight: 12 } }, context('org-a'));assert.equal(first.idempotencyKey, changed.idempotencyKey);assert.throws(() => assertSamePreparedEvent(first, changed), error(409));
  assert.equal(first.status, 'prepared');assert.equal(first.dispatchEnabled, false);assert.equal(called, false);assert.ok(!('payload' in first));
  assert.throws(() => engine.prepareEvent('nvv', { ...event, organisationId: 'org-b' }, context('org-a')), error(403));
});

test('registration and event validation reject duplicate adapters, malformed data and oversized payloads', () => {
  assert.throws(() => createIntegrationEngine({ adapters: [{ providerId: 'unknown', status: () => ({}) }] }), error(404));
  assert.throws(() => createIntegrationEngine({ adapters: [{ providerId: 'nvv', status: () => ({}) }, { providerId: 'nvv', status: () => ({}) }] }), error(422));
  const engine = createIntegrationEngine({ adapters: [{ providerId: 'nvv', status: () => ({}), supportedEvents: ['report.ready'] }] });
  const base = { id: 'event-1', aggregateId: 'receipt-1', type: 'report.ready', version: 1, payload: {} };
  for (const bad of [{ version: 0 }, { payload: { amount: NaN } }, { payload: undefined }, { payload: new Date() }]) assert.throws(() => engine.prepareEvent('nvv', { ...base, ...bad }, context()), error(422));
  const cyclic = {};cyclic.self = cyclic;assert.throws(() => engine.prepareEvent('nvv', { ...base, payload: cyclic }, context()), error(422));
  assert.throws(() => engine.prepareEvent('nvv', { ...base, payload: { text: 'a'.repeat(65536) } }, context()), error(413));
});
