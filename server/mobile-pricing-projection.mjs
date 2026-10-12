import { createPricingStore, PricingError } from './pricing.mjs';
import { createHash } from 'node:crypto';

export const mobileBusinessDate = at => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
const identity = values => [values?.length ?? 0, values?.at(-1)?.id ?? values?.at(-1)?.revisionId ?? ''];

export function createMobilePricingProjection({ createStore = createPricingStore } = {}) {
  const cache = new Map();
  return function project(pricing, { at = new Date(), customerIds, catalog = true, prices = true } = {}) {
    const day = mobileBusinessDate(at), selected = customerIds ?? pricing.customers.map(customer => customer.id);
    // Revisions cover rule edits and immutable ledger entries. The additional
    // identities protect imported registers and newly created canonical clients.
    const revision = createHash('sha256').update(JSON.stringify([pricing.revision, day, identity(pricing.articleHistory), identity(pricing.lme),
      identity(pricing.customerPrices), identity(pricing.ledger), pricing.groups?.map(group => [group.id, group.revision]),
      pricing.customers.map(customer => customer.id).sort()])).digest('hex');
    const key = `${revision}:${catalog}:${prices}:${JSON.stringify([...selected].sort())}`;
    const previous = cache.get(key);
    if (previous && previous.expiresAt > at.getTime()) return structuredClone(previous.value);
    const chosen = new Set(selected);
    const store = createStore({ initialState: { ...pricing, audit: [], snapshots: [],
      ledger: prices ? pricing.ledger.filter(entry => chosen.has(entry.customerId)) : [],
    } });
    const admin = pricing.users.find(user => user.level === 'Systemadmin' && user.active !== false);
    const principal = store.principal(admin.id);
    const register = store.read(principal, day);
    const articles = register.articles.map(article => ({ id: article.id, active: article.active, category: article.category,
      taxCategory: article.taxCategory, name: article.name, description: article.description,
      includes: article.includes.join('\n'), excludes: article.excludes.join('\n'), photos: article.photos,
      prices: ['A', 'B', 'C'].map(tier => article.prices[tier]),
    }));
    const customerPrices = {};
    if (prices) for (const customerId of selected) {
      customerPrices[customerId] = {};
      for (const article of articles.filter(article => article.active !== false)) {
        let quote;
        try { quote = store.quote({ customerId, deliveredAt: at.toISOString(), rows: [{ articleId: article.id, weight: 1 }] }, principal); }
        catch (error) {
          if (error instanceof PricingError && error.status === 422 &&
            (error.message === `Artikeln ${article.id} saknar inställningar på inlämningsdagen.` ||
              error.message.startsWith('LME-pris saknas för ') && error.message.endsWith(' på inlämningsdagen.'))) continue;
          throw error;
        }
        customerPrices[customerId][article.id] = { price: quote.rows[0].price, source: quote.rows[0].tier };
      }
    }
    const value = { ...(catalog ? { catalog: articles, groups: register.groups } : {}),
      ...(prices ? { customerPrices } : {}), mobilePricingRevision: revision, businessDate: day };
    cache.set(key, { expiresAt: at.getTime() + 30_000, value: structuredClone(value) });
    while (cache.size > 24) cache.delete(cache.keys().next().value);
    return value;
  };
}
