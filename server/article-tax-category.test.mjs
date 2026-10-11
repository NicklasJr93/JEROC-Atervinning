import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPricingStore, PricingError } from './pricing.mjs';

const now = () => new Date('2026-10-07T12:00:00Z');
const setup = () => {
  const store = createPricingStore({ now });
  return { store, admin: store.principal('admin') };
};

test('known demo scrap articles have an independent financial tax category', () => {
  const { store, admin } = setup();
  const state = store.read(admin);
  assert.equal(state.articles.length, 14);
  assert.ok(state.articles.every(article => article.taxCategory === 'scrap_reverse'));
  assert.equal(state.articles.find(article => article.id === 'lead-battery').taxCategory, 'scrap_reverse');
});

test('new unclassified articles require review even in a scrap or battery material category', () => {
  const { store, admin } = setup();
  const { taxCategory, ...template } = store.read(admin).articles[0];
  for (const category of ['koppar', 'batterier']) {
    const id = `custom-${category}`;
    const result = store.saveArticle({ ...template, id, category, name: 'Ny artikel' }, admin);
    assert.equal(result.articles.find(article => article.id === id).taxCategory, 'review');
  }
  const allowed = ['scrap_reverse', 'standard_25', 'no_vat', 'review'];
  for (const category of allowed) {
    const result = store.saveArticle({ ...template, id: `custom-${category}`, taxCategory: category }, admin);
    assert.equal(result.articles.find(article => article.id === `custom-${category}`).taxCategory, category);
  }
  const before = store.exportState();
  assert.throws(() => store.saveArticle({ ...template, taxCategory: 'hazardous' }, admin), error => error instanceof PricingError && error.status === 400);
  assert.deepEqual(store.exportState(), before);
});

test('tax-category changes follow article effective dates and audit revisions without changing snapshots', () => {
  const { store, admin } = setup();
  const original = store.read(admin).articles.find(article => article.id === 'copper-1');
  store.snapshot({
    cardId: 'tax-history', customerId: 'customer-andersson', deliveredAt: '2026-10-07',
    rows: [{ articleId: original.id, weight: 100 }],
  }, admin);
  const snapshots = store.exportState().snapshots;
  const updated = store.saveArticle({ ...original, taxCategory: 'standard_25', effectiveFrom: '2026-10-08' }, admin);
  assert.equal(updated.articles.find(article => article.id === original.id).taxCategory, 'scrap_reverse');
  const current = store.read(admin, '2026-10-08').articles.find(article => article.id === original.id);
  assert.equal(current.taxCategory, 'standard_25');
  assert.notEqual(current.revisionId, original.revisionId);
  const audit = updated.audit.at(-1);
  assert.equal(audit.previousTaxCategory, 'scrap_reverse');
  assert.equal(audit.taxCategory, 'standard_25');
  assert.equal(audit.revisionId, current.revisionId);
  assert.equal(audit.actor, 'admin');
  assert.equal(audit.actingUser, 'admin');
  const { taxCategory, ...oldClientInput } = current;
  store.saveArticle({ ...oldClientInput, name: 'Koppar med nytt namn' }, admin);
  assert.equal(store.read(admin, '2026-10-08').articles.find(article => article.id === original.id).taxCategory, 'standard_25');
  assert.equal(store.read(admin, '2026-10-07').articles.find(article => article.id === original.id).revisionId, original.revisionId);
  assert.deepEqual(store.exportState().snapshots, snapshots);
});

test('legacy hydration classifies only fixed demo IDs and preserves explicit categories and snapshot content', () => {
  const { store } = setup();
  const input = store.exportState();
  const base = input.articleHistory[0];
  for (const article of input.articleHistory) delete article.taxCategory;
  input.articleHistory.find(article => article.id === 'lead-battery').taxCategory = 'no_vat';
  input.articleHistory.push({ ...base, id: 'unknown-battery', category: 'batterier', name: 'Okänt batteri' });
  input.snapshots.push({ id: 'legacy-snapshot', rows: [{ articleId: 'lead-battery', price: 4.5 }], total: 45 });
  const unchangedInput = structuredClone(input);
  const restored = createPricingStore({ now, initialState: input });
  const state = restored.exportState();
  assert.equal(state.articleHistory.find(article => article.id === 'copper-1').taxCategory, 'scrap_reverse');
  assert.equal(state.articleHistory.find(article => article.id === 'lead-battery').taxCategory, 'no_vat');
  assert.equal(state.articleHistory.find(article => article.id === 'unknown-battery').taxCategory, 'review');
  assert.deepEqual(state.snapshots, input.snapshots);
  assert.deepEqual(input, unchangedInput);
});
