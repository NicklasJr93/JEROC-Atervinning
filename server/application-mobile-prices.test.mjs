import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplicationService } from './application.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-mobile-prices-'));
  const env = { JEROC_APPLICATION_DB_PATH: join(directory, 'application.sqlite') };
  let postgres, schema;
  const connectionString = process.env.JEROC_TEST_DATABASE_URL ?? process.env.JEROC_TEST_POSTGRES_URL;
  if (connectionString) {
    const { Pool } = await import('pg'); postgres = new Pool({ connectionString }); schema = `jeroc_mobile_prices_${randomUUID().replaceAll('-', '')}`;
    await postgres.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(connectionString); connection.searchParams.set('options', `-c search_path=${schema}`); env.DATABASE_URL = connection.toString();
  }
  const app = createApplicationService({ env }), server = createServer((req, res) => void app(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  async function api(path, input) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-demo-actor': 'admin', 'x-demo-user': 'admin' }, body: input === undefined ? undefined : JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
  }
  try { await run({ app, api }); }
  finally { await new Promise(resolve => server.close(resolve)); await app.close(); if (postgres) { await postgres.query(`DROP SCHEMA "${schema}" CASCADE`); await postgres.end(); } await rm(directory, { recursive: true, force: true }); }
}

test('mobile catalog and customer prices select the same Swedish effective date after UTC midnight difference', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T22:30:00Z') });
  await fixture(async ({ api }) => {
    const state = await api('/api/pricing/state'), article = { ...state.articleHistory[0], id: 'midnight-effective', name: 'Ny artikel efter midnatt', active: true,
      base: { type: 'manual', price: 90 }, effectiveFrom: '2026-10-10' };
    assert.equal((await api('/api/pricing/articles', article)).status, 200);
    const expected = await api('/api/pricing/quote', { customerId: 'customer-build', deliveredAt: '2026-10-10', rows: [{ articleId: article.id, weight: 1 }] });
    assert.equal(expected.status, 200);
    const response = await api('/api/application/mobile'); assert.equal(response.status, 200, response.error);
    assert.ok(response.catalog.some(item => item.id === article.id));
    assert.equal(response.customerPrices['customer-build'][article.id].price, expected.rows[0].price);
    assert.equal(response.customerPrices['customer-build']['copper-1'].price, 84);
  });
});

test('a missing LME reference leaves only that article unpriced while mobile drafts and other customer quotes remain usable', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T22:30:00Z') });
  await fixture(async ({ app, api }) => {
    const state = await api('/api/pricing/state'), article = { ...state.articleHistory[0], id: 'unconfigured-reference', name: 'Artikel utan referenspris', active: true,
      base: { type: 'lme', metal: 'tin' }, effectiveFrom: '2026-10-10' };
    assert.equal((await api('/api/pricing/articles', article)).status, 200);
    await (await app.getRepository()).transact(state => { state.pricing.lme = state.pricing.lme.filter(rate => rate.metal !== 'tin'); });
    const direct = await api('/api/pricing/quote', { customerId: 'customer-build', deliveredAt: '2026-10-10', rows: [{ articleId: article.id, weight: 1 }] });
    assert.equal(direct.status, 422); assert.match(direct.error, /LME-pris saknas/);
    const response = await api('/api/application/mobile'); assert.equal(response.status, 200, response.error);
    assert.deepEqual(response.catalog.find(item => item.id === article.id).prices, [null, null, null]);
    assert.equal(response.customerPrices['customer-build'][article.id], undefined);
    assert.equal(response.customerPrices['customer-build']['copper-1'].price, 84);
    const next = structuredClone(response.data), id = randomUUID(); next.drafts.push({ id, number: 999, mode: 'direct', status: 'draft',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reference: 'Tillgänglig mobil', origin: '', rows: [{ id: randomUUID(), articleId: 'copper-1', method: 'direct', weight: 12 }] });
    const saved = await api('/api/application/mobile', { base: response.data, next }); assert.equal(saved.status, 200, saved.error);
    assert.ok(saved.data.drafts.some(draft => draft.id === id));
  });
});
