import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPricingStore, PricingError } from './pricing.mjs';

test('catalog accepts the appended material images and uploads while rejecting unavailable built-in IDs', () => {
  const store = createPricingStore({ now: () => new Date('2026-10-20T12:00:00Z') });
  const admin = store.principal('admin');
  const article = store.read(admin).articles.find(value => value.id === 'iron');
  const uploaded = randomUUID();
  const saved = store.saveArticle({ ...article, photos: [40, 71, uploaded], effectiveFrom: '2026-10-20' }, admin);
  assert.deepEqual(saved.articles.find(value => value.id === article.id).photos, [40, 71, uploaded]);
  const grouped = store.saveArticleGroup({ group: { name: 'Nya materialexempel', photo: 71 } }, admin);
  assert.equal(grouped.groups.find(value => value.name === 'Nya materialexempel').photo, 71);
  for (const image of [-1, 72, 999]) {
    assert.throws(() => store.saveArticle({ ...article, photos: [image], effectiveFrom: '2026-10-20' }, admin), error => error instanceof PricingError);
    assert.throws(() => store.saveArticleGroup({ group: { name: 'Ogiltig bild', photo: image } }, admin), error => error instanceof PricingError);
  }
});
