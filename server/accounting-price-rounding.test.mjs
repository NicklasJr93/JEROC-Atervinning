import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPricingStore, money } from './pricing.mjs';
import { buildAccountingDraft, calculateMaterialBaseCents, freezePurchaseAccounting, moneyToCents } from './visma-accounting.mjs';

test('half-cent material quotes, price snapshots and accounting drafts share the same rounded row amounts', () => {
  const store = createPricingStore({ now: () => new Date('2026-10-11T12:00:00Z') });
  const admin = store.principal('admin');
  const article = store.read(admin).articles.find(item => item.id === 'iron');
  store.saveArticle({ ...article, taxCategory: 'standard_25', effectiveFrom: '2026-10-11' }, admin);
  const classified = store.read(admin).articles.find(item => item.id === article.id);
  const settings = { revision: 1, enabled: true, exportMode: 'manual', companyId: 'test-sandbox', sandbox: true,
    paymentTermDays: 0, paymentTermsId: randomUUID(), accounts: { standardPurchase: 4010, supplierLiability: 2440, inputVat: 2641 },
    vatCodes: { standard25: randomUUID() }, sites: [] };
  for (const count of [1, 2, 3]) {
    const snapshot = store.snapshot({ cardId: `half-cent-${count}`, customerId: 'customer-andersson', deliveredAt: '2026-10-11',
      rows: Array.from({ length: count }, () => ({ articleId: article.id, weight: 0.3,
        override: { price: 3.35, tier: 'Eget', reason: 'Kontroll av avrundning' } })) }, admin);
    const rows = snapshot.rows.map(row => ({ ...row, name: classified.name, taxCategory: classified.taxCategory, amount: money(row.weight * row.price) }));
    assert.deepEqual(rows.map(row => row.amount), Array(count).fill(1.01));
    assert.deepEqual(rows.map(calculateMaterialBaseCents), Array(count).fill(101));
    assert.equal(moneyToCents(snapshot.total), count * 101);
    const accounting = freezePurchaseAccounting({ settings, customer: { type: 'Företag', vatRegistered: true }, rows });
    assert.equal(accounting.baseTotalCents, moneyToCents(snapshot.total));
    assert.equal(accounting.sellerVatCents, count * 25);
    const draft = buildAccountingDraft({ accounting, attestedAt: '2026-10-11T12:00:00Z', invoiceNumber: `TEST-${count}` });
    assert.equal(moneyToCents(draft.TotalAmount), count * 126);
    assert.equal(draft.Rows.reduce((sum, row) => sum + moneyToCents(row.DebitAmount) - moneyToCents(row.CreditAmount), 0), 0);
  }
});
