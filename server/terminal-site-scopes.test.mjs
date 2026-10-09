import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPricingStore, PricingError } from './pricing.mjs';

test('an unrestricted VD can grant access to new registered facility IDs', () => {
  const store = createPricingStore();
  const vd = store.principal('lars');
  const users = store.read(vd).users.map(user => user.id === 'kajsa' ? { ...user, siteIds: ['uppsala_nord'] } : user);
  const saved = store.saveUsers({ users }, vd);
  assert.deepEqual(saved.users.find(user => user.id === 'kajsa').siteIds, ['uppsala_nord']);
});

test('a facility-scoped VD cannot widen staff beyond their own sites', () => {
  const store = createPricingStore();
  const admin = store.principal('admin');
  store.saveUsers({ users: store.read(admin).users.map(user => user.id === 'lars' ? { ...user, siteIds: ['norrtalje'] } : user) }, admin);
  const vd = store.principal('lars');
  const users = store.read(vd).users;
  assert.throws(() => store.saveUsers({ users: users.map(user => user.id === 'kajsa' ? { ...user, siteIds: ['uppsala_nord'] } : user) }, vd), error => error instanceof PricingError && error.status === 403);
  assert.throws(() => store.saveUsers({ users: [...users, { id: 'new_worker', name: 'Ny medarbetare', level: 'Medarbetare', permissions: ['view'], maxAttest: 0, ownAttest: false }] }, vd), error => error instanceof PricingError && error.status === 403);
  const saved = store.saveUsers({ users: users.map(user => user.id === 'kajsa' ? { ...user, siteIds: ['norrtalje'] } : user) }, vd);
  assert.deepEqual(saved.users.find(user => user.id === 'kajsa').siteIds, ['norrtalje']);
});

test('facility management requires read access and rejects malformed facility IDs', () => {
  const store = createPricingStore();
  const admin = store.principal('admin');
  const users = store.read(admin).users;
  assert.throws(() => store.saveUsers({ users: users.map(user => user.id === 'anna' ? { ...user, permissions: ['environmentStorage'] } : user) }, admin), error => error instanceof PricingError && error.status === 400);
  assert.throws(() => store.saveUsers({ users: users.map(user => user.id === 'anna' ? { ...user, siteIds: ['../facility'] } : user) }, admin), error => error instanceof PricingError && error.status === 400);
  const saved = store.saveUsers({ users: users.map(user => user.id === 'anna' ? { ...user, siteIds: ['uppsala_nord'], permissions: ['environmentRead', 'environmentStorage'] } : user) }, admin);
  assert.deepEqual(saved.users.find(user => user.id === 'anna').permissions, ['environmentRead', 'environmentStorage']);
});
