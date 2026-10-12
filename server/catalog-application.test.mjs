import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createApplicationService } from './application.mjs';
import { createArticleMediaApi } from './article-media.mjs';
import { getArticleMediaReferences, PricingError } from './pricing.mjs';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'jeroc-catalog-'));
  let env = { JEROC_APPLICATION_DB_PATH: join(dir, 'app.sqlite'), JEROC_ARTICLE_MEDIA_DB_PATH: join(dir, 'images.sqlite') }, pool, schema;
  if (process.env.JEROC_TEST_DATABASE_URL) {
    const { Pool } = await import('pg'); pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
    schema = 'jeroc_catalog_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(process.env.JEROC_TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`);
    env = { DATABASE_URL: url.toString() };
  }
  const services = [], servers = [];
  async function instance() {
    let media;
    const app = createApplicationService({ env, validateArticleMedia: async (route, input) => {
      if (!await media.hasImages(getArticleMediaReferences(route, input))) throw new PricingError('Bilden saknas.', 422);
    } });
    media = createArticleMediaApi({ env, authorize: req => app.withPrincipal(() => app.principalStore.principal(req.headers['x-demo-actor'], req.headers['x-demo-user'])) });
    await app.getRepository(); await media.ready(); services.push(app, media);
    const server = createServer((req, res) => { const url = new URL(req.url, 'http://localhost'); void media(req, res, url).then(handled => handled || app(req, res, url)); });
    servers.push(server); await new Promise(done => server.listen(0, '127.0.0.1', done));
    return async (path, input, extra = {}) => {
      const raw = Buffer.isBuffer(input);
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: input === undefined ? 'GET' : 'POST', headers: { 'x-demo-actor': 'admin', 'x-demo-user': 'admin', 'x-demo-mobile': 'niklas', ...(input === undefined ? {} : { 'content-type': raw ? 'image/png' : 'application/json' }), ...extra },
        body: input === undefined ? undefined : raw ? input : JSON.stringify(input),
      });
      return { status: response.status, value: response.headers.get('content-type').startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
    };
  }
  try { await run(await instance(), instance); }
  finally { for (const server of servers) await new Promise(done => server.close(done)); for (const service of services) await service.close(); if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); } await rm(dir, { recursive: true, force: true }); }
}

test('office group, subgroup and mixed images reach mobile and survive independent service restart', async () => fixture(async (request, instance) => {
  const original = (await request('/api/pricing/state')).value;
  const article = original.articles.find(item => item.id === 'copper-1');
  const pricingBefore = (await request('/api/pricing/quote', { deliveredAt: '2026-10-12', rows: [{ articleId: article.id, weight: 10 }] })).value;
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#2075bb' } }).png().toBuffer();
  const uploaded = await request('/api/article-media', png, { 'x-file-name': encodeURIComponent('Koppar exempel.png') });
  assert.equal(uploaded.status, 201);
  const photo = uploaded.value.image.id;
  const groups = await request('/api/pricing/article-groups', { group: { name: 'Ren koppar', description: 'Blank tråd och rör', parentId: 'koppar', photo, sortOrder: 5, active: true } });
  assert.equal(groups.status, 200, groups.value.error);
  const subgroup = groups.value.groups.find(group => group.name === 'Ren koppar');
  const changed = await request('/api/pricing/articles', { ...article, category: subgroup.id, photos: [photo, 0], description: 'Eget bildexempel från kontoret' });
  assert.equal(changed.status, 200, changed.value.error);
  const next = await instance();
  const mobile = (await next('/api/application/mobile')).value;
  assert.deepEqual(mobile.groups.find(group => group.id === subgroup.id), subgroup);
  assert.equal(mobile.catalog.find(item => item.id === article.id).category, subgroup.id);
  assert.deepEqual(mobile.catalog.find(item => item.id === article.id).photos, [photo, 0]);
  assert.equal(mobile.catalog.find(item => item.id === article.id).description, 'Eget bildexempel från kontoret');
  assert.equal((await next('/api/article-media/' + photo + '?variant=thumb')).status, 200);
  assert.equal((await next('/api/pricing/quote', { deliveredAt: '2026-10-12', rows: [{ articleId: article.id, weight: 10 }] })).value.total, pricingBefore.total);
  const ungrouped = await next('/api/pricing/articles', { ...changed.value.articles.find(item => item.id === article.id), category: '' });
  assert.equal(ungrouped.status, 200, ungrouped.value.error);
  assert.equal((await next('/api/application/mobile')).value.catalog.find(item => item.id === article.id).category, '');
}));

test('missing uploaded image blocks the command before any article or group change is committed', async () => fixture(async request => {
  const before = (await request('/api/pricing/state')).value;
  const missing = 'c9b2b4fc-a9bd-4cff-b6a6-cd2d5981fa7b';
  const result = await request('/api/pricing/article-groups', { group: { name: 'Saknad bild', description: '', photo: missing, sortOrder: 0, active: true } });
  assert.equal(result.status, 422);
  const result2 = await request('/api/pricing/articles', { ...before.articles[0], photos: [missing] });
  assert.equal(result2.status, 422);
  const after = (await request('/api/pricing/state')).value;
  assert.deepEqual(after.groups, before.groups); assert.deepEqual(after.articleHistory, before.articleHistory);
}));
