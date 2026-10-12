import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createArticleMediaRepository } from './article-media-storage.mjs';
import { ArticleMediaError, createArticleMediaApi, prepareArticleImage, MAX_ARTICLE_IMAGE_BYTES } from './article-media.mjs';

const admin = { actor: { id: 'admin', active: true, level: 'Systemadmin', permissions: [] }, user: { id: 'admin', active: true, level: 'Systemadmin', permissions: [] } };
const worker = (id, permissions = []) => ({ id, active: true, level: 'Medarbetare', permissions });
const jpeg = () => sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#ff6600' } })
  .withMetadata({ orientation: 6 }).jpeg().toBuffer();
const expectError = (status, code) => error => error instanceof ArticleMediaError && error.status === status && error.code === code;

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jeroc-media-tests-')), filename = join(directory, 'media.sqlite');
  const repository = await createArticleMediaRepository({ env: {}, filename });
  let current = structuredClone(admin), checks = 0;
  const api = createArticleMediaApi({ repository, authorize: async () => { checks++; return structuredClone(current); } });
  const server = createServer((req, res) => { api(req, res, new URL(req.url, `http://${req.headers.host}`)).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }).catch(error => { res.writeHead(500); res.end(error.message); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const upload = (bytes, contentType = 'image/jpeg', headers = {}) => fetch(`${origin}/api/article-media`, {
    method: 'POST', headers: { 'Content-Type': contentType, Origin: origin, 'X-File-Name': encodeURIComponent('Testbild å.jpg'), ...headers }, body: bytes,
  });
  try { await run({ repository, api, origin, upload, filename, setPrincipal: principal => { current = principal; }, checks: () => checks }); }
  finally { await new Promise(resolve => server.close(resolve)); await api.close(); await rm(directory, { recursive: true, force: true }); }
}

test('image upload rotates pixels, strips private metadata and returns immutable mobile variants', async () => fixture(async ({ upload, origin, checks }) => {
  const response = await upload(await jpeg());
  assert.equal(response.status, 201);
  const { image } = await response.json();
  assert.match(image.id, /^[0-9a-f-]{36}$/);
  assert.equal(image.width, 800); assert.equal(image.height, 1600);
  assert.equal(image.originalName, 'Testbild å.jpg');
  assert.equal(checks(), 2, 'authorization is refreshed after decoding');
  assert.equal('createdBy' in image, false);
  const fullResponse = await fetch(`${origin}${image.url}`);
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get('content-type'), 'image/webp');
  assert.equal(fullResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.match(fullResponse.headers.get('cache-control'), /immutable/);
  const full = Buffer.from(await fullResponse.arrayBuffer()), fullMetadata = await sharp(full).metadata();
  assert.equal(full.length, image.bytes);
  assert.equal(fullMetadata.width, 800); assert.equal(fullMetadata.height, 1600);
  assert.equal(fullMetadata.exif, undefined); assert.equal(fullMetadata.orientation, undefined);
  const thumb = await fetch(`${origin}${image.thumbnailUrl}`);
  const thumbMetadata = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(thumbMetadata.width, 200); assert.equal(thumbMetadata.height, 400);
  const head = await fetch(`${origin}${image.url}`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(Number(head.headers.get('content-length')), full.length);
  const cached = await fetch(`${origin}${image.url}`, { headers: { 'If-None-Match': fullResponse.headers.get('etag') } });
  assert.equal(cached.status, 304);
}));

test('content survives repository restart and duplicate upload cannot overwrite its immutable image', async () => fixture(async ({ upload, filename, repository, api }) => {
  const bytes = await jpeg(), first = await (await upload(bytes)).json(), repeated = await (await upload(bytes)).json();
  assert.equal(repeated.image.id, first.image.id);
  assert.equal(await api.hasImages([first.image.id, first.image.id]), true);
  assert.equal(await api.hasImages([randomUUID()]), false);
  assert.equal(await api.hasImages(['not-an-id']), false);
  const reopened = await createArticleMediaRepository({ env: {}, filename });
  try {
    const read = await reopened.image(first.image.id, 'thumb');
    const original = await repository.image(first.image.id, 'thumb');
    assert.deepEqual(read.bytes, original.bytes);
    assert.equal(read.record.contentHash, original.record.contentHash);
    assert.equal(await reopened.hasImages([first.image.id]), true);
  } finally { await reopened.close(); }
}));

test('upload requires article edit permission on both actual and effective active account', async () => fixture(async ({ upload, setPrincipal }) => {
  const bytes = await jpeg();
  setPrincipal({ actor: worker('worker'), user: worker('worker') });
  assert.equal((await upload(bytes)).status, 403);
  setPrincipal({ actor: admin.actor, user: worker('worker') });
  assert.equal((await upload(bytes)).status, 403);
  setPrincipal({ actor: worker('worker'), user: admin.user });
  assert.equal((await upload(bytes)).status, 403);
  setPrincipal({ actor: worker('worker', ['articlesEdit']), user: worker('worker', ['articlesEdit']) });
  assert.equal((await upload(bytes)).status, 201);
  setPrincipal({ actor: { ...admin.actor, active: false }, user: admin.user });
  assert.equal((await upload(bytes)).status, 401);
  setPrincipal(undefined);
  assert.equal((await upload(bytes)).status, 401);
}));

test('cross-site upload is rejected before authorization and image processing', async () => fixture(async ({ upload, checks }) => {
  const bytes = await jpeg();
  assert.equal((await upload(bytes, 'image/jpeg', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await upload(bytes, 'image/jpeg', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(checks(), 0);
}));

test('invalid, disguised SVG and mismatched content types cannot enter the image archive', async () => fixture(async ({ upload, origin }) => {
  assert.equal((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'), 'image/svg+xml')).status, 415);
  assert.equal((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'), 'image/png')).status, 415);
  assert.equal((await upload(Buffer.from('not an image'))).status, 422);
  assert.equal((await upload(await jpeg(), 'image/png')).status, 415);
  assert.equal((await upload(Buffer.alloc(0))).status, 422);
  assert.equal((await fetch(`${origin}/api/article-media/not-an-id`)).status, 404);
  assert.equal((await fetch(`${origin}/api/article-media/${randomUUID()}`)).status, 404);
  assert.equal((await fetch(`${origin}/api/article-media/${randomUUID()}?variant=original`)).status, 422);
}));

test('byte and decoded pixel limits reject expensive input before any persistent image', async () => {
  await assert.rejects(() => prepareArticleImage({ bytes: Buffer.alloc(MAX_ARTICLE_IMAGE_BYTES + 1), contentType: 'image/png' }), expectError(413, 'image_too_large'));
  await assert.rejects(async () => prepareArticleImage({ bytes: await jpeg(), contentType: 'image/jpeg' }, { maxPixels: 1000 }), expectError(413, 'image_pixels'));
});

test('PNG, WebP and AVIF are accepted and always delivered as metadata-free WebP', async () => {
  const source = sharp({ create: { width: 80, height: 60, channels: 4, background: { r: 120, g: 20, b: 0, alpha: 0.5 } } });
  for (const [type, bytes] of [
    ['image/png', await source.clone().png().toBuffer()],
    ['image/webp', await source.clone().webp().toBuffer()],
    ['image/avif', await source.clone().avif().toBuffer()],
  ]) {
    const result = await prepareArticleImage({ bytes, contentType: type, originalName: '../../test\u0000.png' });
    assert.equal((await sharp(result.full).metadata()).format, 'webp');
    assert.equal(result.width, 80); assert.equal(result.height, 60);
    assert.equal(result.originalName, 'test.png');
  }
});

test('Render requires PostgreSQL rather than silently keeping uploads on an ephemeral filesystem', async () => {
  await assert.rejects(() => createArticleMediaRepository({ env: { RENDER: 'true' } }), expectError(503, 'setup_required'));
});

test('PostgreSQL byte variants and deduplication work across independent repository instances', { skip: !process.env.JEROC_TEST_DATABASE_URL }, async () => {
  const { Pool } = await import('pg'), pool = new Pool({ connectionString: process.env.JEROC_TEST_DATABASE_URL });
  const schema = `jeroc_article_media_test_${randomUUID().replaceAll('-', '')}`, repositories = [];
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const connection = new URL(process.env.JEROC_TEST_DATABASE_URL); connection.searchParams.set('options', `-c search_path=${schema}`);
    const env = { DATABASE_URL: connection.toString(), RENDER: 'true' };
    repositories.push(...await Promise.all([createArticleMediaRepository({ env }), createArticleMediaRepository({ env })]));
    const { full, thumbnail, ...prepared } = await prepareArticleImage({ bytes: await jpeg(), contentType: 'image/jpeg' });
    const records = await Promise.all(repositories.map(repository => repository.insert({ id: randomUUID(), ...prepared, createdAt: new Date().toISOString() }, full, thumbnail)));
    assert.equal(records[0].id, records[1].id);
    assert.deepEqual((await repositories[1].image(records[0].id, 'full')).bytes, full);
    assert.deepEqual((await repositories[1].image(records[0].id, 'thumb')).bytes, thumbnail);
    assert.equal(await repositories[1].hasImages([records[0].id]), true);
  } finally {
    for (const repository of repositories) await repository.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
  }
});
