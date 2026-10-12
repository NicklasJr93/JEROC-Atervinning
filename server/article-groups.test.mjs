import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPricingStore, defaultArticleGroups, getArticleMediaReferences, PricingError } from './pricing.mjs';
import { createPricingApi } from './pricing-api.mjs';

const now = () => new Date('2026-10-12T12:00:00Z');
const setup = initialState => {
  const store = createPricingStore({ now, initialState });
  const admin = store.principal('admin');
  return { store, admin, article: store.read(admin).articles.find(article => article.id === 'copper-1') };
};
const group = (extra = {}) => ({ name: 'Ren koppar', description: 'Rör och blank tråd', photo: 1, sortOrder: 20, active: true, ...extra });
const fails = (action, status = 422) => assert.throws(action, error => error instanceof PricingError && error.status === status);

test('legacy migration adds stable existing app groups without modifying article or locked financial history', () => {
  const original = setup();
  original.store.snapshot({ cardId: 4010, customerId: 'customer-build', deliveredAt: '2026-10-12', rows: [{ articleId: 'copper-1', weight: 10 }] }, original.admin);
  const legacy = original.store.exportState();
  delete legacy.groups;
  const saved = structuredClone(legacy);
  const migrated = setup(legacy).store.exportState();
  assert.deepEqual(migrated.groups, defaultArticleGroups);
  assert.deepEqual(migrated.articleHistory, saved.articleHistory);
  assert.deepEqual(migrated.snapshots, saved.snapshots);
  assert.deepEqual(migrated.ledger, saved.ledger);
  assert.equal(migrated.revision, saved.revision);
  assert.equal(new Set(migrated.groups.map(group => group.id)).size, 8);
});

test('group CRUD keeps versions, actor identities, persisted hierarchy and ordering with stale edits rejected', () => {
  const { store, admin } = setup();
  const result = store.saveArticleGroup({ group: group({ parentId: 'koppar', sortOrder: 1 }) }, admin);
  const child = result.groups.find(item => item.name === 'Ren koppar');
  assert.match(child.id, /^group-/);
  assert.equal(child.revision, 1);
  const edited = store.saveArticleGroup({ group: { ...child, name: 'Blank koppar' }, expectedRevision: 1 }, admin);
  assert.equal(edited.groups.find(item => item.id === child.id).revision, 2);
  const before = store.exportState();
  fails(() => store.saveArticleGroup({ group: child, expectedRevision: 1 }, admin), 409);
  assert.deepEqual(store.exportState(), before);
  const restored = setup(store.exportState());
  assert.deepEqual(restored.store.read(restored.admin).groups, edited.groups);
  const entry = edited.audit.at(-1);
  assert.equal(entry.actor, 'admin');
  assert.equal(entry.actingUser, 'admin');
  assert.equal(entry.groupId, child.id);
  assert.equal(entry.groupRevision, 2);
});

test('group hierarchy rejects missing parents, cycles, depth three and demoting a parent atomically', () => {
  const { store, admin } = setup();
  const result = store.saveArticleGroup({ group: group({ id: 'pure-copper', parentId: 'koppar' }) }, admin);
  const before = store.exportState();
  for (const payload of [
    { group: group({ parentId: 'missing' }) },
    { group: group({ id: 'cycle', parentId: 'cycle' }) },
    { group: group({ parentId: 'pure-copper' }) },
    { group: { ...result.groups.find(item => item.id === 'koppar'), parentId: 'jarn' }, expectedRevision: 1 },
    { group: group({ id: '__ungrouped__' }) },
  ]) {
    fails(() => store.saveArticleGroup(payload, admin));
    assert.deepEqual(store.exportState(), before);
  }
});

test('only both actual and effective article editors can change groups; existing site restrictions are retained', () => {
  const { store, admin } = setup();
  fails(() => store.saveArticleGroup({ group: group() }, store.principal('kajsa')), 403);
  fails(() => store.saveArticleGroup({ group: group() }, store.principal('admin', 'anna')), 403);
  fails(() => store.saveArticleGroup({ group: group() }, { actor: store.principal('kajsa').actor, user: admin.user }), 403);
  const state = store.exportState();
  state.users.find(user => user.id === 'kajsa').permissions.push('articlesEdit');
  state.users.find(user => user.id === 'kajsa').siteIds = ['norrtalje'];
  const scoped = setup(state).store;
  const result = scoped.saveArticleGroup({ group: group() }, scoped.principal('kajsa'));
  assert.ok(result.groups.some(item => item.name === 'Ren koppar'));
  assert.deepEqual(scoped.exportState().users.find(user => user.id === 'kajsa').siteIds, ['norrtalje']);
});

test('article selection supports subgroup or Ingen, rejects unknown/new inactive choices, retains existing assignments', () => {
  const { store, admin, article } = setup();
  store.saveArticleGroup({ group: group({ id: 'pure-copper', parentId: 'koppar' }) }, admin);
  assert.equal(store.saveArticle({ ...article, category: 'pure-copper', effectiveFrom: '2026-10-12' }, admin).articles.find(item => item.id === article.id).category, 'pure-copper');
  const parent = store.read(admin).groups.find(item => item.id === 'koppar');
  store.saveArticleGroup({ group: { ...parent, active: false }, expectedRevision: parent.revision }, admin);
  assert.equal(store.saveArticle({ ...article, category: 'pure-copper', name: 'Ny beskrivning', effectiveFrom: '2026-10-12' }, admin).articles.find(item => item.id === article.id).name, 'Ny beskrivning');
  fails(() => store.saveArticle({ ...article, id: 'new-copper', category: 'pure-copper' }, admin));
  fails(() => store.saveArticle({ ...article, category: 'missing' }, admin));
  assert.equal(store.saveArticle({ ...article, category: '', effectiveFrom: '2026-10-12' }, admin).articles.find(item => item.id === article.id).category, '');
});

test('current app group/photos/text change immediately while date-selected price/tax and old snapshots remain frozen', () => {
  const { store, admin, article } = setup();
  store.snapshot({ cardId: 4011, customerId: 'customer-build', deliveredAt: '2026-10-12', rows: [{ articleId: article.id, weight: 10 }] }, admin);
  const snapshot = store.exportState().snapshots;
  const uploaded = '91b4c76b-68ea-4328-9ebf-6b4f1fa9a6da';
  store.saveArticle({ ...article, category: '', photos: [uploaded, 2], name: 'Ren koppar uppdaterad', taxCategory: 'standard_25', effectiveFrom: '2026-11-01', base: { type: 'manual', price: 500 } }, admin);
  const current = store.read(admin, '2026-10-12').articles.find(item => item.id === article.id);
  assert.equal(current.category, '');
  assert.equal(current.name, 'Ren koppar uppdaterad');
  assert.deepEqual(current.photos, [uploaded, 2]);
  assert.equal(current.taxCategory, article.taxCategory);
  assert.deepEqual(current.prices, article.prices);
  assert.equal(store.quote({ deliveredAt: '2026-10-12', rows: [{ articleId: article.id, weight: 10 }] }, admin).rows[0].price, 65.6);
  assert.deepEqual(store.exportState().snapshots, snapshot);
  assert.equal(store.read(admin, '2026-11-01').articles.find(item => item.id === article.id).taxCategory, 'standard_25');
});

test('media references accept demo indices and immutable UUIDs but not arbitrary URLs or duplicate photos', () => {
  const { store, admin, article } = setup();
  const uploaded = '91b4c76b-68ea-4328-9ebf-6b4f1fa9a6da';
  store.saveArticleGroup({ group: group({ photo: uploaded }) }, admin);
  store.saveArticle({ ...article, photos: [0, uploaded] }, admin);
  assert.deepEqual(getArticleMediaReferences('articles', { photos: [0, uploaded, uploaded] }), [uploaded]);
  assert.deepEqual(getArticleMediaReferences('article-groups', { group: { photo: uploaded } }), [uploaded]);
  assert.deepEqual(getArticleMediaReferences('lme', { photo: uploaded }), []);
  for (const photos of [[40], [-1], ['https://example.org/image.jpg'], [uploaded, uploaded]])
    fails(() => store.saveArticle({ ...article, photos }, admin), 400);
  fails(() => store.saveArticleGroup({ group: group({ photo: 'javascript:alert(1)' }) }, admin), 400);
});

test('future activation keeps catalog and quote availability on the delivery date while renamed app text is current', () => {
  const seed = setup().store.exportState();
  seed.articleHistory.find(article => article.id === 'copper-1').active = false;
  const { store, admin, article } = setup(seed);
  store.saveArticle({ ...article, name: 'Koppar uppdaterad', category: '', active: true, effectiveFrom: '2026-11-01' }, admin);
  const current = store.read(admin, '2026-10-12').articles.find(item => item.id === article.id);
  assert.equal(current.name, 'Koppar uppdaterad');
  assert.equal(current.category, '');
  assert.equal(current.active, false);
  assert.equal(store.getArticleForEnvironment(article.id).active, false);
  fails(() => store.quote({ deliveredAt: '2026-10-12', rows: [{ articleId: article.id, weight: 10 }] }, admin));
  assert.equal(store.read(admin, '2026-11-01').articles.find(item => item.id === article.id).active, true);
  assert.equal(store.quote({ deliveredAt: '2026-11-01', rows: [{ articleId: article.id, weight: 10 }] }, admin).rows[0].price, 65.6);
});

test('register import validates group hierarchy and legacy imports receive default groups', () => {
  const { store, admin } = setup();
  const legacy = store.exportState();
  delete legacy.groups;
  assert.deepEqual(store.validateMigration(legacy, admin).groups, defaultArticleGroups);
  const malformed = store.exportState();
  malformed.groups[0].parentId = malformed.groups[0].id;
  fails(() => store.validateMigration(malformed, admin));
  const duplicate = store.exportState();
  duplicate.groups.push(duplicate.groups[0]);
  fails(() => store.validateMigration(duplicate, admin));
});

test('pricing HTTP group action authenticates, checks origin, returns state and preserves conflict status', async t => {
  const { store } = setup();
  let validations = 0;
  const api = createPricingApi({ store, validateMediaReferences(route, payload, principal) {
    validations++;
    assert.equal(principal.actor.id, 'admin');
    assert.equal(principal.user.id, 'admin');
    if (getArticleMediaReferences(route, payload).length)
      throw new PricingError('Den uppladdade bilden finns inte.', 422);
  } });
  const server = createServer((req, res) => api(req, res, new URL(req.url, 'http://localhost')));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/pricing/article-groups`;
  const send = (payload, extra = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-actor': 'admin', 'x-demo-user': 'admin', ...extra }, body: JSON.stringify(payload) });
  assert.equal((await send({ group: group() }, { 'x-demo-user': 'anna' })).status, 403);
  assert.equal((await send({ group: group() }, { origin: 'https://elsewhere.example' })).status, 403);
  assert.equal(validations, 0);
  const response = await send({ group: group({ id: 'pure-copper' }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.groups.some(item => item.id === 'pure-copper'));
  assert.equal((await send({ group: group({ id: 'pure-copper' }), expectedRevision: 0 })).status, 409);
  const before = store.exportState();
  assert.equal((await send({ group: group({ photo: '91b4c76b-68ea-4328-9ebf-6b4f1fa9a6da' }) })).status, 422);
  assert.deepEqual(store.exportState(), before);
});
