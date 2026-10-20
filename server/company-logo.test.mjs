import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyLogoService, prepareCompanyLogo, MAX_COMPANY_LOGO_BYTES } from './company-logo.mjs';
import { createCompanyLogoRepository } from './company-logo-storage.mjs';

const principal = (companyId = 'company-a') => ({ companyId, actorId: 'actor-a', userId: 'owner-a', canManage: true, scopeKey: `${companyId}/session-1` });
const error = (status, code) => failure => failure.status === status && (!code || failure.code === code);
const picture = (color = '#228866') => sharp({ create: { width: 160, height: 60, channels: 4, background: color } }).png().toBuffer();
const input = bytes => ({ contentType: 'image/png', base64: bytes.toString('base64') });
async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'scrapplanner-logo-'));
  const services = [];
  try {
    const create = (companyId = 'company-a') => {
      const service = createCompanyLogoService({ organisationId: companyId, env: { JEROC_COMPANY_LOGO_DB_PATH: join(directory, 'logos.sqlite') } });
      services.push(service); return service;
    };
    await operation(create);
  } finally {
    await Promise.all(services.map(service => service.close()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('company logo decodes pixels, preserves transparency, bounds size and strips metadata', async () => {
  const bytes = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 80, b: 40, alpha: 0.6 } } })
    .withMetadata({ orientation: 6 }).png().toBuffer();
  const prepared = await prepareCompanyLogo(input(bytes));
  const metadata = await sharp(prepared.bytes).metadata();
  assert.equal(metadata.format, 'png'); assert.ok(metadata.hasAlpha);
  assert.ok(prepared.width <= 1200 && prepared.height <= 400);
  assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined);
});

test('PNG, JPEG and WebP company marks all become safe PNG assets', async () => {
  const image = sharp({ create: { width: 100, height: 40, channels: 3, background: '#112233' } });
  for (const [contentType, bytes] of [
    ['image/png', await image.clone().png().toBuffer()], ['image/jpeg', await image.clone().jpeg().toBuffer()],
    ['image/webp', await image.clone().webp().toBuffer()],
  ]) {
    const result = await prepareCompanyLogo({ contentType, base64: bytes.toString('base64') });
    assert.equal((await sharp(result.bytes).metadata()).format, 'png');
  }
});

test('vectors, remote paths, mismatched MIME, corrupt base64 and excess bytes/pixels never become logos', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://private.example.test/secret" /></svg>');
  await assert.rejects(prepareCompanyLogo({ contentType: 'image/svg+xml', base64: svg.toString('base64') }), error(415));
  await assert.rejects(prepareCompanyLogo(input(svg)), error(415));
  await assert.rejects(prepareCompanyLogo({ contentType: 'image/png', base64: 'https://example.test/logo.png' }), error(422));
  await assert.rejects(prepareCompanyLogo({ ...input(await picture()), url: 'https://private.example.test' }), error(415));
  await assert.rejects(prepareCompanyLogo({ contentType: 'image/jpeg', base64: (await picture()).toString('base64') }), error(415));
  await assert.rejects(prepareCompanyLogo(input(Buffer.alloc(MAX_COMPANY_LOGO_BYTES + 1))), error(413));
  await assert.rejects(prepareCompanyLogo(input(await picture()), { maxPixels: 100 }), error(413));
});

test('logo assets are immutable and deduplicated inside one company, with retained old versions after restart', () => fixture(async create => {
  const service = create(), actor = principal();
  const upload = value => service.upload(value, actor, { reauthorize: async () => actor });
  const logoA = await upload(input(await picture())), first = await service.read(logoA.logoId);
  const again = await upload(input(await picture()));
  assert.equal(again.logoId, logoA.logoId);
  const logoB = await upload(input(await picture('#992233')));
  assert.notEqual(logoA.logoId, logoB.logoId);
  assert.deepEqual((await service.read(logoA.logoId)).bytes, first.bytes);
  assert.equal(first.record.companyId, actor.companyId);
  await service.close();
  // close() is idempotent because test cleanup also closes retained services.
  const reopened = create();
  assert.deepEqual((await reopened.read(logoA.logoId)).bytes, first.bytes);
  assert.equal(await reopened.hasLogo(logoB.logoId), true);
}));

test('same database and guessed IDs never expose another company logo', () => fixture(async create => {
  const a = create('company-a'), b = create('company-b'), actor = principal('company-a');
  const logo = await a.upload(input(await picture()), actor, { reauthorize: async () => actor });
  assert.equal(await b.read(logo.logoId), undefined); assert.equal(await b.hasLogo(logo.logoId), false);
  const bActor = principal('company-b');
  const own = await b.upload(input(await picture()), bActor, { reauthorize: async () => bActor });
  assert.notEqual(own.logoId, logo.logoId, 'deduplication is per company, never a shared ownership grant');
}));

test('uploads require manage permission and fresh unchanged company/session before durable storage', () => fixture(async create => {
  const service = create(), actor = principal(), payload = input(await picture());
  await assert.rejects(service.upload(payload, { ...actor, canManage: false }, { reauthorize: async () => actor }), error(403));
  await assert.rejects(service.upload(payload, principal('company-b'), { reauthorize: async () => actor }), error(403));
  await assert.rejects(service.upload(payload, actor, { reauthorize: async () => ({ ...actor, scopeKey: 'different-session' }) }), error(409));
  await assert.rejects(service.upload(payload, actor, { reauthorize: async () => ({ ...actor, canManage: false }) }), error(403));
  const logo = await service.upload(payload, actor, { reauthorize: async () => actor });
  assert.equal(await service.hasLogo(logo.logoId), true);
  assert.equal(await service.read('../../other'), undefined);
}));

test('Render logo repository requires durable PostgreSQL storage', async () => {
  await assert.rejects(createCompanyLogoRepository({ organisationId: 'company-a', env: { RENDER: 'true' } }), /DATABASE_URL/);
});
