import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPricingStore } from './pricing.mjs';
import { createMobilePricingProjection } from './mobile-pricing-projection.mjs';
import { mobileRecordPayload } from './mobile-records.mjs';

test('mobile catalog reads skip customer quotes and reuse an immutable bounded projection', () => {
  let stores = 0, quotes = 0;
  const read = createMobilePricingProjection({ createStore(options) {
    stores += 1;
    const store = createPricingStore(options), quote = store.quote;
    store.quote = (...args) => { quotes += 1; return quote(...args); };
    return store;
  } });
  const pricing = createPricingStore().exportState(), at = new Date('2026-10-12T08:00:00Z');
  const first = read(pricing, { at, prices: false });
  assert.equal(quotes, 0); assert.equal(stores, 1); assert.equal(first.customerPrices, undefined);
  first.catalog[0].name = 'Changed by caller';
  assert.notEqual(read(pricing, { at, prices: false }).catalog[0].name, first.catalog[0].name);
  assert.equal(stores, 1);
  const selected = read(pricing, { at, catalog: false, customerIds: ['customer-erik'] });
  assert.deepEqual(Object.keys(selected.customerPrices), ['customer-erik']);
  assert.equal(selected.catalog, undefined);
  assert.equal(quotes, first.catalog.filter(article => article.active !== false).length);
});

test('price edits, volume ledger updates, new customers and Swedish midnight invalidate mobile quote projections', () => {
  const engine = createPricingStore(), principal = engine.principal('admin'), read = createMobilePricingProjection();
  const at = new Date('2026-10-12T10:00:00Z'), options = { at, catalog: false, customerIds: ['customer-erik'] };
  const before = read(engine.exportState(), options);
  engine.saveSpecial({ customerId: 'customer-erik', articleId: 'iron', kind: 'fixed', price: 77, active: true, effectiveFrom: '2026-10-01', note: 'Test' }, principal);
  const edited = read(engine.exportState(), options);
  assert.equal(edited.customerPrices['customer-erik'].iron.price, 77);
  assert.notEqual(edited.mobilePricingRevision, before.mobilePricingRevision);
  engine.snapshot({ cardId: '881', customerId: 'customer-erik', deliveredAt: '2026-10-12T09:00:00Z', rows: [{ articleId: 'copper-1', weight: 101 }] }, principal);
  const delivered = read(engine.exportState(), options);
  assert.equal(delivered.customerPrices['customer-erik']['copper-1'].source, 'A');
  assert.notEqual(delivered.mobilePricingRevision, edited.mobilePricingRevision);
  const withNewCustomer = engine.exportState(); withNewCustomer.customers.push({ id: 'new-mobile-client', name: 'New client' });
  assert.notEqual(read(withNewCustomer, options).mobilePricingRevision, delivered.mobilePricingRevision);
  const beforeMidnight = read(withNewCustomer, { ...options, at: new Date('2026-10-12T21:59:59Z') });
  const afterMidnight = read(withNewCustomer, { ...options, at: new Date('2026-10-12T22:00:01Z') });
  assert.equal(beforeMidnight.businessDate, '2026-10-12'); assert.equal(afterMidnight.businessDate, '2026-10-13');
  assert.notEqual(beforeMidnight.mobilePricingRevision, afterMidnight.mobilePricingRevision);
});

test('compact record commands keep before/after baselines and reject duplicate or forged identities', () => {
  const draft = { id: 'draft-one', number: 1, mode: 'direct', status: 'draft', createdAt: '2026-10-12T10:00:00Z', updatedAt: '2026-10-12T10:00:00Z', rows: [], reference: '', origin: '' };
  const command = { kind: 'records', version: 1, drafts: [{ id: draft.id, base: draft, next: { ...draft, origin: 'Testgatan 1' } }], customers: [] };
  const decoded = mobileRecordPayload(command);
  assert.deepEqual(decoded.base.drafts, [draft]); assert.equal(decoded.next.drafts[0].origin, 'Testgatan 1');
  assert.throws(() => mobileRecordPayload({ ...command, drafts: [...command.drafts, ...command.drafts] }));
  assert.throws(() => mobileRecordPayload({ ...command, drafts: [{ ...command.drafts[0], id: 'another-draft' }] }));
});
