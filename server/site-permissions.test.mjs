import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPricingStore } from './pricing.mjs';
import { createEnvironmentRepository } from './environment-storage.mjs';
import { createEnvironmentStore, ENVIRONMENT_DEMO_PASSWORD } from './environment-model.mjs';

const pricing = () => createPricingStore({ now: () => new Date('2026-10-09T10:00:00Z') });
function changeUser(store, id, changes) {
  const admin = store.principal('admin');
  return store.saveUsers({ users: store.read(admin).users.map((user) => user.id === id ? { ...user, ...changes } : user) }, admin);
}

test('site restrictions survive account parsing and legacy permission updates; an empty selection stays empty', () => {
  const store = pricing();
  assert.equal(store.principal('kajsa').user.siteIds, undefined);
  changeUser(store, 'kajsa', { siteIds: ['rimbo'] });
  assert.deepEqual(store.principal('kajsa').user.siteIds, ['rimbo']);
  const admin = store.principal('admin');
  const legacyUsers = store.read(admin).users.map((user) => {
    const { siteIds, ...legacy } = user;
    return user.id === 'kajsa' ? { ...legacy, name: 'Kajsa med bevarad anläggning' } : user;
  });
  store.saveUsers({ users: legacyUsers }, admin);
  assert.deepEqual(store.principal('kajsa').user.siteIds, ['rimbo']);
  changeUser(store, 'kajsa', { siteIds: [] });
  assert.deepEqual(store.principal('kajsa').user.siteIds, []);
  assert.throws(() => changeUser(store, 'kajsa', { siteIds: ['unknown-site'] }), (error) => error.status === 400);
});

test('VD cannot grant sites outside the current personal scope or widen their own scope', () => {
  const store = pricing();
  changeUser(store, 'lars', { siteIds: ['norrtalje'] });
  changeUser(store, 'kajsa', { siteIds: ['norrtalje'] });
  const lars = store.principal('lars');
  const users = store.read(lars).users;
  for (const target of ['kajsa', 'lars']) {
    assert.throws(() => store.saveUsers({ users: users.map((user) => user.id === target ? { ...user, siteIds: ['norrtalje', 'rimbo'] } : user) }, lars), (error) => error.status === 403);
  }
  const saved = store.saveUsers({ users: users.map((user) => user.id === 'kajsa' ? { ...user, siteIds: [] } : user) }, lars);
  assert.deepEqual(saved.users.find((user) => user.id === 'kajsa').siteIds, []);
});

test('saved site permissions restrict a live environment session without an injected principal override, including Systemadmin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-site-permissions-'));
  const repository = await createEnvironmentRepository({ env: {}, filename: join(directory, 'environment.sqlite') });
  const principalStore = pricing();
  const environment = createEnvironmentStore({ repository, principalStore, now: () => new Date('2026-10-09T10:00:00Z') });
  try {
    const kajsa = await environment.login({ userId: 'kajsa', password: ENVIRONMENT_DEMO_PASSWORD });
    const admin = await environment.login({ userId: 'admin', password: ENVIRONMENT_DEMO_PASSWORD });
    assert.deepEqual((await environment.state(kajsa.token)).sites.map((site) => site.id), ['norrtalje', 'rimbo']);
    const place = { address: 'Testgatan 12', postalCode: '76141', city: 'Norrtälje', municipalityCode: '0188' };
    const receipt = {
      sourceId: randomUUID(), cardId: 2050, siteId: 'norrtalje', receivedAt: '2026-10-09T10:00:00+02:00',
      rows: [{ articleId: 'lead-battery', weight: 250 }],
      previousHolder: { name: 'Testverkstaden AB', number: '5560000167', contactName: 'Testpersonen', email: '', phone: '' },
      lastPlace: place, nextPlace: place, transportMode: 'road',
      incomingDocument: { reference: 'TD-TEST-2050' }, idempotencyKey: randomUUID(),
    };
    await environment.receive(receipt, kajsa.token);
    changeUser(principalStore, 'kajsa', { siteIds: ['rimbo'] });
    const restricted = await environment.state(kajsa.token);
    assert.deepEqual(restricted.sites.map((site) => site.id), ['rimbo']);
    assert.deepEqual(restricted.receipts, []);
    assert.deepEqual(restricted.inventory, []);
    assert.deepEqual(restricted.reports, []);
    await assert.rejects(() => environment.state(kajsa.token, 'norrtalje'), (error) => error.status === 403 && error.code === 'site_forbidden');
    await assert.rejects(() => environment.receive({ ...receipt, sourceId: randomUUID(), idempotencyKey: randomUUID() }, kajsa.token), (error) => error.status === 403 && error.code === 'site_forbidden');
    changeUser(principalStore, 'kajsa', { siteIds: [] });
    assert.deepEqual((await environment.state(kajsa.token)).sites, []);
    changeUser(principalStore, 'admin', { siteIds: ['rimbo'] });
    assert.deepEqual((await environment.state(admin.token)).sites.map((site) => site.id), ['rimbo']);
    await assert.rejects(() => environment.state(admin.token, 'norrtalje'), (error) => error.status === 403 && error.code === 'site_forbidden');
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});
